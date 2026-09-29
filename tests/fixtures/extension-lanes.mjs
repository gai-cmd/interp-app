// New implementation of docs/extension.md §11.3 (shared helper of group B); no legacy code is ported.
//
// Builds the offscreen host, or a single lane, over the shared fakes: the fake browser (message bus, ports, virtual
// clock), fake audio (contexts, streams, worklets, permission and autoplay modes) and the Live socket fixture of the
// existing suite. Nothing here can make a sound or open a device or a network connection; every socket is a fake
// and every key is assembled at runtime (the privacy scan forbids key-shaped literals).
import { createFakeAudioEnv } from './fake-audio.mjs';
import { createFakeBrowser } from './fake-chrome.mjs';
import { createSocketFixture, tick } from './live.mjs';
import { createLaneHost } from '../../extension/engine/lane-host.js';
import { PORT_NAMES, makeMessage } from '../../extension/lib/protocol.js';

export { tick };

/** Printable ASCII, valid for the key store, never a key-shaped literal. `tag` tells two lanes' keys apart. */
export const fakeKey = (tag = 'lane') => `synthetic-${tag}-${'x'.repeat(24)}`;

export const STYLE = Object.freeze({ size: 1.5, position: 'bottom', display: 'dark', showSource: false, maxLines: 3,
  autoHideSeconds: 8 });

/**
 * One rig = one fake browser + one fake audio environment + one socket fixture. `sockets.sockets[n]` are the Live
 * sockets in the order the engines opened them, `audio.worklets[n]` the capture worklets in creation order.
 */
export function createRig({ autoplay, micPermission, autoClose = true } = {}) {
  const browser = createFakeBrowser();
  // A live SW context: it mints stream ids, sends host/* messages, and records what the host sends it (sw/host-idle).
  // Like the real router it answers only messages addressed to it; `swReply.mode` is 'ok', 'silent' (no answer: the
  // sender's promise rejects) or a function of the 1-based message count.
  const swInbox = [];
  const swReply = { mode: 'ok' };
  browser.sw.register((chrome) => {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.target !== 'sw') return false;
      swInbox.push({ message, sender });
      const mode = typeof swReply.mode === 'function' ? swReply.mode(swInbox.length) : swReply.mode;
      if (mode === 'silent') return false;
      sendResponse({ ok: true, closed: false });
      return true;
    });
  });
  browser.sw.idleTimeoutMs = 1e12;                  // tests advance the virtual clock freely; the SW must not idle out
  const sockets = createSocketFixture({ autoClose });
  const audio = createFakeAudioEnv({ browser, sockets, autoplay, micPermission });
  const swChrome = () => browser.sw.context.chrome;

  /** A tab with a content script, invoked (activeTab grant) and a fresh single-use stream id. */
  async function tabStreamId(tabId = 5, url = 'https://example.test/watch') {
    if (!browser.tabs.has(tabId)) browser.addTab({ id: tabId, url, active: true });
    await browser.clickAction(tabId);
    return swChrome().tabCapture.getMediaStreamId({ targetTabId: tabId });
  }

  /** The params of a lane start as the lane sees them (the validated host/lane-start message + epoch). */
  async function laneParams(lane, { tabId = 5, epoch = 1, muted = true, captions = true, targetLanguage = 'ko',
    model = 'gemini-3.5-live-translate-preview', key = fakeKey(lane), originalVolume = 65, streamId, style = STYLE,
    voiceGender = 'female', languages } = {}) {
    // `languages` (a two-way pair) is part of the request only when given, exactly like the SW builds it.
    const params = { v: 1, target: 'offscreen', type: 'host/lane-start', lane, key,
      request: { targetLanguage, model, ...(languages === undefined ? {} : { languages }) },
      voiceGender, muted, captions, style: { ...style }, epoch };
    if (lane === 'tab') params.tab = { tabId, streamId: streamId ?? await tabStreamId(tabId), originalVolume };
    return params;
  }

  /**
   * After a lane's start() resolved: feed one capture block, open its Live socket and complete the setup, exactly
   * like tests/fixtures/sim.mjs does. `worklet`/`socket` are the next unclaimed ones (lanes are brought up one at a time).
   */
  async function connect({ worklet: workletIndex, socket: socketIndex }) {
    await tick();
    const worklet = audio.worklets[workletIndex];
    // A 48 kHz fake context resamples to 16 kHz: three 1024-sample blocks make the first complete 512-sample frame.
    for (let block = 0; block < 3; block += 1) worklet.emitFrames(0.25);
    await tick();
    const socket = sockets.sockets[socketIndex];
    socket.open();
    socket.json({ setupComplete: {} });
    await tick();
    return { worklet, socket };
  }
  const counts = () => ({ worklet: audio.worklets.length, socket: sockets.sockets.length });

  return { browser, sockets, audio, env: audio.env, clock: browser.clock, swChrome, swInbox, swReply, tabStreamId, laneParams,
    connect, counts };
}

/**
 * The real createLaneHost inside a fake offscreen document. `adapter` is `{ runtime }` of that context: the fake gives it
 * EXACTLY the six members of the offscreen document, so a host that touches any other member fails here.
 */
export async function createHostRig(options = {}) {
  const rig = createRig(options);
  const { browser } = rig;
  let host = null;
  const contextOf = { value: null };
  browser.onCreateOffscreen = async (context) => {
    contextOf.value = context;
    if (options.boot) { await options.boot(context, rig); return; }   // e.g. import the real entry file host.js
    const runtime = options.wrapRuntime ? options.wrapRuntime(context.chrome.runtime) : context.chrome.runtime;
    host = createLaneHost({ adapter: { runtime }, env: rig.env, timers: browser.clock,
      hostId: 'h-test', ...(options.host ?? {}) });
    host.start();
  };
  await rig.swChrome().offscreen.createDocument({ url: 'extension/engine/host.html', reasons: ['USER_MEDIA'],
    justification: 'tests' });
  const send = (message) => rig.swChrome().runtime.sendMessage(message);
  const message = (type, payload) => makeMessage(type, payload);

  const panels = [];
  /** A side panel: a fake page context whose port to the host records every frame it receives (and when, in fake ms). */
  function openPanel({ hello = true, kind = 'panel', name = PORT_NAMES.panel } = {}) {
    const context = browser.createContext(kind);
    const port = context.chrome.runtime.connect({ name });
    const panel = { context, port, frames: [], times: [], disconnected: false };
    port.onMessage.addListener((frame) => { panel.frames.push(frame); panel.times.push(browser.clock.now()); });
    port.onDisconnect.addListener(() => { panel.disconnected = true; });
    panel.close = () => { context.close(); };
    panel.last = (type, lane) => [...panel.frames].reverse().find((frame) => frame.type === type && (lane === undefined || frame.lane === lane));
    panels.push(panel);
    if (hello) port.postMessage({ v: 1, type: 'hello' });
    return panel;
  }

  const overlays = [];
  /** A caption overlay for a tab: a content context that connects like the real overlay after content/overlay-attach. */
  function openOverlay(tabId, { hello = true, frameId = 0, fresh = false } = {}) {
    const context = (!fresh && frameId === 0 ? browser.contentContext(tabId) : null) ?? browser.createContext('content', { tabId, frameId });
    const port = context.chrome.runtime.connect({ name: PORT_NAMES.overlay });
    const overlay = { context, port, frames: [], disconnected: false, tabId };
    port.onMessage.addListener((frame) => { overlay.frames.push(frame); });
    port.onDisconnect.addListener(() => { overlay.disconnected = true; });
    overlay.last = (type, lane) => [...overlay.frames].reverse().find((frame) => frame.type === type && (lane === undefined || frame.lane === lane));
    overlays.push(overlay);
    if (hello) port.postMessage({ v: 1, type: 'hello' });
    return overlay;
  }

  /** host/lane-start as the SW builds it (validated by makeMessage); async because minting a stream id is. */
  async function laneStartMessage(lane, overrides = {}) {
    const params = await rig.laneParams(lane, overrides);
    const { epoch: _epoch, v: _v, target: _target, type: _type, ...payload } = params;
    return makeMessage('host/lane-start', payload);
  }
  const startLane = async (lane, overrides = {}) => send(await laneStartMessage(lane, overrides));
  /** Keeps the lanes' capture alive (the engine stops a capture that hears nothing for 2 s) while fake time passes. */
  async function keepAlive(links, totalMs, stepMs = 250) {
    for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
      for (const link of links) link.worklet.emitFrames(0.1);
      await browser.clock.advance(stepMs);
    }
  }
  async function settle() { await browser.settle(); await tick(); }

  return { ...rig, host: () => host, offscreen: () => contextOf.value, send, message, openPanel, openOverlay, laneStartMessage,
    startLane, keepAlive, settle, panels, overlays };
}
