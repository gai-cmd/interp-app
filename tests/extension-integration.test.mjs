// New implementation of docs/extension.md §11.1 (extension-integration); no legacy code is ported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSimEngine } from '../app/engine/sim.js';
import { createServiceWorker } from '../extension/background/sw-core.js';
import { createLaneHost } from '../extension/engine/lane-host.js';
import { createChromeAdapter } from '../extension/lib/chrome-adapter.js';
import { loadExtensionI18n } from '../extension/lib/i18n.js';
import { LIMITS, PORT_NAMES, STORAGE_KEYS, makeFrame } from '../extension/lib/protocol.js';
import { createPanelController } from '../extension/panel/controller.js';
import { FakeEvent, parseHtml } from './fixtures/extension-dom.mjs';
import { createFakeAudioEnv } from './fixtures/fake-audio.mjs';
import { createFakeBrowser } from './fixtures/fake-chrome.mjs';
import { createSocketFixture, tick } from './fixtures/live.mjs';
import { content } from './fixtures/sim.mjs';

// The whole extension, silently: the REAL service worker core, the REAL lane host, the REAL side-panel controller
// (parsed panel.html), fake audio, fake Live sockets and a stand-in for the caption overlay's port, all over the fake
// browser and its virtual clock. Nothing here opens a device, a network connection or a browser.

const KEY = `synthetic-${'x'.repeat(24)}`;
const readSource = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const PANEL_HTML = readSource('extension/panel/panel.html');
// The dictionaries are fetched by file: URL. The checkout root comes from this file's own URL, never from a folder name:
// a clone or a worktree may live in a folder called anything.
const ROOT = new URL('../', import.meta.url).href;
const fileFetch = async (url) => {
  const href = String(url);
  assert.ok(href.startsWith(ROOT), `${href} is under the checkout root ${ROOT}`);
  return { ok: true, json: async () => JSON.parse(readSource(href.slice(ROOT.length))) };
};

async function makeWorld({ tabs = [{ id: 5, url: 'https://claude.ai/doc' }], settings, key = KEY, micPermission = 'granted' } = {}) {
  const browser = createFakeBrowser({ messages: { menuOpen: 'Interpret this tab' } });
  const sockets = createSocketFixture();
  const audio = createFakeAudioEnv({ browser, sockets, micPermission });
  const world = { browser, sockets, audio, clock: browser.clock, hosts: [], overlays: [], attaches: [], swCores: [], engineStarts: [],
    labels: new Map() };   // §19: tab id -> the capture label its page was last given
  browser.sw.idleTimeoutMs = 1e12;   // the tests kill the worker explicitly

  // The REAL sim engine, watched at its one entry point: every request the host hands to `engine.start` is recorded (a
  // copy; the session context has no key in it). The two-way tests read it to see what the engine was really given.
  const watchedEngine = (options) => {
    const engine = createSimEngine(options);
    // A frozen engine cannot sit behind a Proxy that rewrites members, so this is a plain object with the same surface.
    const watched = Object.create(null);
    for (const name of Object.keys(engine).filter((key) => key !== 'start')) {
      const member = Object.getOwnPropertyDescriptor(engine, name);
      Object.defineProperty(watched, name, member.get ? { get: () => engine[name], enumerable: true }
        : { value: typeof member.value === 'function' ? member.value.bind(engine) : member.value, enumerable: true });
    }
    watched.start = (request, context) => { world.engineStarts.push(JSON.parse(JSON.stringify(request))); return engine.start(request, context); };
    return Object.freeze(watched);
  };
  browser.onCreateOffscreen = (context) => {
    const host = createLaneHost({ adapter: { runtime: context.chrome.runtime }, env: audio.env, timers: browser.clock, hostId: `h-int-${world.hosts.length + 1}`,
      deps: { createSimEngine: watchedEngine } });
    host.start();
    world.hosts.push(host);
  };
  // The overlay stand-in: it answers content/overlay-attach and then opens the port like the real script does, and it
  // keeps the capture label the worker gives the page before a share-picker start (§19).
  browser.onContentCreated = (context) => {
    context.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === 'content/capture-label') { world.labels.set(context.tabId, message.label); sendResponse({ ok: true }); return true; }
      if (message?.type !== 'content/overlay-attach') return false;
      world.attaches.push(context.tabId);
      if (!world.overlays.some((overlay) => overlay.context === context && !overlay.disconnected)) {
        const port = context.chrome.runtime.connect({ name: PORT_NAMES.overlay });
        const overlay = { context, port, tabId: context.tabId, frames: [], disconnected: false };
        port.onMessage.addListener((frame) => overlay.frames.push(frame));
        port.onDisconnect.addListener(() => { overlay.disconnected = true; });
        port.postMessage(makeFrame('hello'));
        world.overlays.push(overlay);
      }
      sendResponse({ ok: true });
      return true;
    });
  };
  for (const tab of tabs) browser.addTab({ active: tab === tabs[0], ...tab });
  browser.sw.register((chromeApi) => {
    const core = createServiceWorker({ adapter: createChromeAdapter(chromeApi), now: browser.clock.now, setTimeout: browser.clock.setTimeout });
    core.register();
    world.swCores.push(core);
  });

  world.settle = async () => { await browser.settle(); await tick(); await browser.settle(); };
  const seed = browser.createContext('options');
  if (key) await seed.chrome.storage.local.set({ [STORAGE_KEYS.key]: { v: 1, value: key } });
  if (settings) await seed.chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  seed.close();

  // A side panel: a fake page context, the parsed real markup and the real controller.
  world.openPanel = async () => {
    const context = browser.createContext('panel', { windowId: 1 });
    const document = parseHtml(PANEL_HTML);
    const controller = createPanelController({
      document, adapter: createChromeAdapter(context.chrome), i18n: { current: null },
      loadI18n: (options) => loadExtensionI18n({ fetch: fileFetch, ...options }),
      timers: { setTimeout: browser.clock.setTimeout, clearTimeout: browser.clock.clearTimeout, now: browser.clock.now },
      navigator: audio.env.navigator,
    });
    await controller.start();
    await world.settle();
    const panel = { context, document, controller,
      el: (id) => document.getElementById(id),
      text: (id) => document.getElementById(id).textContent,
      async click(id) { document.getElementById(id).click(); await world.settle(); },
      async change(id, value) {
        const el = document.getElementById(id);
        if (typeof value === 'boolean') el.checked = value; else el.value = String(value);
        el.dispatchEvent(new FakeEvent('change', { bubbles: true }));
        await world.settle();
      },
      close() { controller.dispose(); context.close(); } };
    return panel;
  };

  // Brings a started lane up like the shared rig does: one capture block, the socket opens, setup completes.
  world.connect = async ({ worklet, socket }) => {
    await tick();
    for (let block = 0; block < 3; block += 1) audio.worklets[worklet].emitFrames(0.25);
    await tick();
    sockets.sockets[socket].open();
    sockets.sockets[socket].json({ setupComplete: {} });
    await world.settle();
    return { worklet: audio.worklets[worklet], socket: sockets.sockets[socket] };
  };
  world.armTab = async (tabId) => { await browser.clickAction(tabId); await world.settle(); };
  world.session = () => browser.storageData('session');
  world.hostFrames = (kind = 'state') => browser.deliveries.filter((entry) => entry.kind === 'port-frame' && entry.to === 'panel' && JSON.parse(entry.json).type === kind)
    .map((entry) => JSON.parse(entry.json));
  world.lastState = () => world.hostFrames('state').at(-1)?.state;
  return world;
}

const running = (state, lane) => state.lanes[lane].phase === 'running';

// ---------------------------------------------------------------------------------------------
test('icon click arms and opens the panel; Start runs the tab lane; the key and the stream id cross in ONE message; captions reach the panel and the overlay', async () => {
  const world = await makeWorld();
  const { browser } = world;
  const panel = await world.openPanel();

  await world.armTab(5);
  assert.deepEqual(browser.panelOpens, [{ windowId: 1, tabId: null }], 'the icon click opened the panel');
  assert.match(panel.text('tab-arm-note'), /ready/i, 'and armed the tab: the panel says it is ready');

  await panel.click('btn-start');
  const tab = await world.connect({ worklet: 0, socket: 0 });
  assert.equal(panel.el('status-pill').getAttribute('data-state'), 'running');
  assert.equal(world.lastState().lanes.tab.phase, 'running');
  assert.equal(world.lastState().lanes.tab.tabId, 5);
  assert.equal(browser.captures.has(5), true);
  assert.equal(world.lastState().speechMuted, true, 'the interpreted voice is muted by default');
  assert.equal(panel.el('btn-mute').getAttribute('data-muted'), 'true');

  content(tab.socket, { outputTranscription: { text: 'hello from the tab' } });
  await tick();
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  assert.ok(panel.el('tab-preview').textContent.includes('hello from the tab'), 'the caption preview in the panel');
  assert.equal(panel.el('tab-preview').hidden, false);
  const overlay = world.overlays.find((entry) => entry.tabId === 5);
  assert.ok(overlay, 'the overlay attached to the captured tab after the start');
  assert.equal(overlay.frames.some((frame) => frame.type === 'style'), true);
  assert.equal(overlay.frames.some((frame) => frame.type === 'captions' && frame.lane === 'tab'
    && frame.rows.some((row) => row.text.includes('hello from the tab'))), true, 'the caption frame on the overlay port');

  // Delivery scan: the key and the stream id are in exactly one delivery, a host/lane-start message, and nowhere else.
  const streamId = browser.deliveries.map((entry) => JSON.parse(entry.json || 'null')).find((json) => json?.type === 'host/lane-start').tab.streamId;
  for (const [name, needle] of [['key', KEY], ['stream id', streamId]]) {
    const carrying = browser.deliveries.filter((entry) => entry.json.includes(needle));
    assert.equal(carrying.length, 1, `${name} appears in exactly one delivery`);
    assert.equal(carrying[0].kind, 'message');
    assert.equal(carrying[0].to, 'offscreen');
    assert.equal(JSON.parse(carrying[0].json).type, 'host/lane-start');
  }
  assert.equal(browser.deliveries.some((entry) => entry.to === 'content' && (entry.json.includes(KEY) || entry.json.includes(streamId))), false);
  assert.equal(JSON.stringify(browser.storageData('session')).includes(KEY), false);
  assert.equal(JSON.stringify(browser.storageData('local')[STORAGE_KEYS.settings] ?? {}).includes(KEY), false);
  // and the panel only ever talked to the worker
  for (const entry of browser.deliveries.filter((delivery) => delivery.from === 'panel' && delivery.kind === 'message')) {
    assert.ok(JSON.parse(entry.json).type.startsWith('sw/'), entry.json);
  }
  panel.close();
});

test('microphone and tab audio run at once; the usage note appears; the voice stays muted', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await world.armTab(5);
  await panel.change('mic-enabled', true);
  assert.notEqual(panel.text('usage-note'), '', 'both lanes enabled: the doubling note');

  await panel.click('btn-start');
  const tab = await world.connect({ worklet: 0, socket: 0 });
  const mic = await world.connect({ worklet: 1, socket: 1 });
  const state = world.lastState();
  assert.equal(running(state, 'tab') && running(state, 'mic'), true);
  assert.equal(state.concurrent, 2);
  assert.equal(state.speechMuted, true);

  content(tab.socket, { outputTranscription: { text: 'from the tab audio' } });
  content(mic.socket, { outputTranscription: { text: 'my own speech' } });
  await tick();
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  assert.ok(panel.text('tab-preview').includes('from the tab audio'));
  assert.ok(panel.text('mic-preview').includes('my own speech'));
  assert.equal(panel.text('mic-preview').includes('from the tab audio'), false);
  panel.close();
});

test('the volume slider changes the gain through storage -> worker -> host; the mute button reaches the host too', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await world.armTab(5);
  await panel.click('btn-start');
  await world.connect({ worklet: 0, socket: 0 });
  const gains = () => world.audio.contexts.flatMap((context) => context.nodes).filter((node) => node.kind === 'gain');
  assert.equal(gains().at(-1).gain.value, 0.65, 'the default matches the screenshot');

  await panel.change('tab-volume', 30);
  assert.equal(gains().at(-1).gain.value, 0.3);

  await panel.click('btn-mute');
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  assert.equal(world.lastState().speechMuted, false, 'the host state frame carries the new mute');
  assert.equal(panel.el('btn-mute').getAttribute('data-muted'), 'false');
  panel.close();
});

test('Start then Stop within one fake second ends with no live raw track and no engine', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await world.armTab(5);
  world.audio.setGetUserMediaMode('held');   // the host is inside getUserMedia when Stop lands
  await panel.click('btn-start');
  assert.equal(world.browser.captures.has(5), true, 'the tab capture was taken');
  assert.equal(panel.text('btn-start'), 'Stop');
  await panel.click('btn-start');            // Stop
  world.audio.releaseGetUserMedia();
  await world.clock.advance(900);
  await world.settle();

  assert.equal(world.browser.captures.size, 0, 'no live raw track is left');
  assert.equal(world.sockets.sockets.length, 0, 'no engine was ever created');
  assert.equal(world.lastState().lanes.tab.phase, 'off');
  assert.equal(world.lastState().lanes.tab.errorCode, null);
  assert.equal(panel.text('tab-notice'), '', 'a cancelled start is silent');
  assert.equal(panel.text('btn-start'), 'Start');
  panel.close();
});

test('ticking "Show captions on the page" mid-run attaches the overlay; unticking clears it', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await world.armTab(5);
  await panel.change('tab-captions', false);
  await panel.click('btn-start');
  const tab = await world.connect({ worklet: 0, socket: 0 });
  assert.equal(world.attaches.length, 0, 'captions are off: no overlay');

  await panel.change('tab-captions', true);
  await world.settle();
  assert.deepEqual(world.attaches, [5]);
  content(tab.socket, { outputTranscription: { text: 'now visible' } });
  await tick();
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  const overlay = world.overlays.find((entry) => entry.tabId === 5);
  assert.ok(overlay.frames.some((frame) => frame.type === 'captions' && frame.rows.some((row) => row.text.includes('now visible'))));

  await panel.change('tab-captions', false);
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  assert.ok(overlay.frames.some((frame) => frame.type === 'clear' && frame.lane === 'tab'), 'the host cleared the lane on the page');
  panel.close();
});

test('microphone captions reach only the tab you look at, and follow it when you switch tabs', async () => {
  const world = await makeWorld({ tabs: [{ id: 5, url: 'https://a.example/' }, { id: 6, url: 'https://b.example/' }] });
  const panel = await world.openPanel();
  await panel.change('tab-enabled', false);
  await panel.change('mic-enabled', true);
  await panel.change('mic-captions', true);
  await panel.click('btn-start');
  const mic = await world.connect({ worklet: 0, socket: 0 });
  content(mic.socket, { outputTranscription: { text: 'said in tab five' } });
  await tick();
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  const overlayFor = (tabId) => world.overlays.filter((entry) => entry.tabId === tabId);
  assert.equal(overlayFor(5).length, 1);
  assert.equal(overlayFor(6).length, 0, 'the background tab never got an overlay for the microphone');
  assert.ok(overlayFor(5)[0].frames.some((frame) => frame.type === 'captions' && frame.rows.some((row) => row.text.includes('said in tab five'))));

  await world.browser.activateTab(6);
  await world.settle();
  content(mic.socket, { outputTranscription: { text: 'said in tab six' } });
  await tick();
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  assert.equal(overlayFor(6).length, 1, 'the overlay moved with the active tab');
  assert.ok(overlayFor(6)[0].frames.some((frame) => frame.type === 'captions' && frame.rows.some((row) => row.text.includes('said in tab six'))));
  assert.ok(overlayFor(5)[0].frames.some((frame) => frame.type === 'clear' && frame.lane === 'mic'), 'and the old tab was cleared');
  assert.equal(overlayFor(5)[0].frames.some((frame) => frame.type === 'captions' && frame.rows.some((row) => row.text.includes('said in tab six'))), false);
  panel.close();
});

test('closing the panel stops the lanes after the grace, the host tells the worker, the offscreen document closes and lastStop is recorded', async () => {
  const world = await makeWorld();
  const first = await world.openPanel();
  await first.change('tab-enabled', false);
  await first.change('mic-enabled', true);
  await first.click('btn-start');
  await world.connect({ worklet: 0, socket: 0 });
  assert.ok(world.browser.offscreenDocument);

  first.close();
  await world.clock.advance(LIMITS.panelGraceMs - 100);
  assert.ok(world.browser.offscreenDocument, 'still inside the grace');
  await world.clock.advance(200);
  await world.settle();
  await world.clock.advance(LIMITS.statusLingerMs);
  await world.settle();
  assert.equal(world.browser.offscreenDocument, null, 'the worker closed the document');
  const stop = world.session()[STORAGE_KEYS.lastStop];
  assert.equal(stop.reason, 'panel-gone');
  assert.equal(world.session()[STORAGE_KEYS.host].up, false);
  assert.ok(world.sockets.sockets.every((socket) => socket.readyState !== 1), 'the Live session was closed');

  const second = await world.openPanel();
  assert.notEqual(second.text('stop-note'), '', 'a reopened panel explains why it stopped');
  assert.match(second.text('stop-note'), /panel was closed/i);
  second.close();
});

test('closing the captured tab ends the tab lane with TAB_ENDED while the microphone keeps running', async () => {
  const world = await makeWorld({ tabs: [{ id: 5, url: 'https://a.example/' }, { id: 6, url: 'https://b.example/' }] });
  const panel = await world.openPanel();
  await world.armTab(5);
  await panel.change('mic-enabled', true);
  await panel.click('btn-start');
  await world.connect({ worklet: 0, socket: 0 });
  await world.connect({ worklet: 1, socket: 1 });
  assert.equal(running(world.lastState(), 'tab') && running(world.lastState(), 'mic'), true);

  await world.browser.closeTab(5);
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  const state = world.lastState();
  assert.equal(state.lanes.tab.phase, 'error');
  assert.equal(state.lanes.tab.errorCode, 'TAB_ENDED');
  assert.equal(state.lanes.mic.phase, 'running', 'the other lane is unaffected');
  assert.match(panel.text('tab-notice'), /no longer be taken from this tab/i);
  assert.equal(panel.el('status-pill').getAttribute('data-state'), 'warning');
  assert.equal(world.session()[STORAGE_KEYS.armed].tabs['5'], undefined);
  panel.close();
});

// §19 (2026-09-30) reverses the end of this test: a Start on the tab whose arming was cleared used to WAIT for a fresh
// toolbar click; now it asks through the share picker and runs as soon as the tab is chosen.
test('a cross-origin navigation clears the arming: the panel says Start will ask, and Start runs through the share picker', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await world.armTab(5);
  assert.match(panel.text('tab-arm-note'), /ready/i);

  await world.browser.navigate(5, 'https://elsewhere.example/');
  await world.settle();
  assert.equal(world.session()[STORAGE_KEYS.armed].tabs['5'], undefined);
  assert.match(panel.text('tab-arm-note'), /Chrome asks which tab/i);
  assert.equal(/This tab is ready/.test(panel.text('tab-arm-note')), false);

  await panel.click('btn-start');
  assert.equal(panel.text('btn-start'), 'Cancel', 'the start is waiting for the choice in the share picker');
  assert.equal(world.audio.picker.pending(), 1);
  assert.equal(world.sockets.sockets.length, 0);
  world.audio.picker.choose({ label: world.labels.get(5) });
  await world.connect({ worklet: 0, socket: 0 });
  assert.equal(running(world.lastState(), 'tab'), true);
  assert.equal(world.lastState().lanes.tab.tabId, 5);
  panel.close();
});

// =============================================================================================
// §19 (2026-09-30): the panel's Start alone, end to end over the real worker, host and panel. The tests fail on v0.3.1,
// except the last one (the control: an armed tab still starts at once, as it did).

test('§19 Start WITHOUT the toolbar icon: the picker opens, the chosen tab is interpreted, and its page gets the captions', async () => {
  const world = await makeWorld({ tabs: [{ id: 5, url: 'https://video.example/watch', title: 'Video' }, { id: 6, url: 'https://claude.ai/doc', title: 'Doc' }] });
  const { browser } = world;
  const panel = await world.openPanel();
  assert.deepEqual(browser.panelOpens, [], 'the toolbar icon was never clicked');
  assert.equal(world.session()[STORAGE_KEYS.armed], undefined);
  assert.match(panel.text('tab-arm-note'), /Chrome asks which tab/i);

  await panel.click('btn-start');
  // The dialog is open: one share-picker call in the host document, the panel's tab labelled, no stream id minted.
  assert.equal(world.audio.picker.pending(), 1);
  assert.equal(panel.text('btn-start'), 'Cancel');
  assert.match(panel.text('status-pill'), /choose the tab/i);
  assert.match(panel.text('tab-arm-note'), /choose the tab to interpret and press Share/i);
  assert.equal(panel.el('tab-arm-note').getAttribute('data-attention'), 'true');
  assert.deepEqual(browser.offscreenDocument.reasons, ['USER_MEDIA', 'DISPLAY_MEDIA']);
  const [start] = laneStarts(world);
  assert.deepEqual(Object.keys(start.tab).sort(), ['originalVolume', 'pick']);
  assert.deepEqual([...world.labels], [[5, `${start.tab.pick}.5`]], 'only the tab the panel is on was labelled; the other page was not touched');
  assert.equal(browser.captures.size, 0, 'nothing is captured through tabCapture');
  assert.equal(world.lastState().lanes.tab.tabId, null, 'no tab is claimed before the user chose');

  world.audio.picker.choose({ label: world.labels.get(5) });
  const tab = await world.connect({ worklet: 0, socket: 0 });
  assert.equal(panel.el('status-pill').getAttribute('data-state'), 'running');
  assert.equal(world.lastState().lanes.tab.tabId, 5);
  assert.equal(setupOf(tab.socket).model, `models/${TRANSLATION_ONLY}`, 'the tab lane default model, as on the armed path');
  assert.deepEqual(start.request, { targetLanguage: 'en', model: TRANSLATION_ONLY });
  assert.match(panel.text('tab-tabline'), /Video/, 'the panel names the tab that is interpreted');
  assert.equal(panel.text('tab-arm-note'), '');

  content(tab.socket, { outputTranscription: { text: 'hello from the chosen tab' } });
  await tick();
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  assert.ok(panel.el('tab-preview').textContent.includes('hello from the chosen tab'));
  assert.deepEqual(world.overlays.map((overlay) => overlay.tabId), [5]);
  assert.equal(world.overlays[0].frames.some((frame) => frame.type === 'captions' && frame.lane === 'tab'
    && frame.rows.some((row) => row.text.includes('hello from the chosen tab'))), true);

  // The key is in the one lane-start message; the nonce is in that message and the label message, never stored.
  assertNothingLeaks(world);
  const nonce = start.tab.pick;
  for (const entry of browser.deliveries.filter((delivery) => delivery.json.includes(nonce))) {
    assert.ok(['host/lane-start', 'content/capture-label'].includes(JSON.parse(entry.json).type), entry.json);
  }
  assert.equal(JSON.stringify([browser.storageData('session'), browser.storageData('local')]).includes(nonce), false);

  // Stop releases the share.
  await panel.click('btn-start');
  await world.settle();
  assert.equal(world.audio.picker.streams[0].getTracks().every((track) => track.readyState === 'ended'), true);
  assert.equal(world.lastState().lanes.tab.phase, 'off');
  panel.close();
});

test('§19 ANOTHER tab chosen in the dialog is interpreted too, with captions in the panel only: its page was never labelled', async () => {
  const world = await makeWorld({ tabs: [{ id: 5, url: 'https://claude.ai/doc', title: 'Doc' }, { id: 6, url: 'https://video.example/watch', title: 'Video' }] });
  const panel = await world.openPanel();
  await panel.click('btn-start');
  assert.equal(world.labels.has(6), false);
  world.audio.picker.choose({ label: null });   // what the captured track of an unlabelled page reports
  const tab = await world.connect({ worklet: 0, socket: 0 });
  assert.equal(running(world.lastState(), 'tab'), true);
  assert.equal(world.lastState().lanes.tab.tabId, null);
  content(tab.socket, { outputTranscription: { text: 'from the other tab' } });
  await tick();
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  assert.ok(panel.el('tab-preview').textContent.includes('from the other tab'));
  assert.deepEqual(world.overlays, [], 'no page is drawn on, above all not the labelled tab the panel is on');
  assert.match(panel.text('tab-notice'), /Captions cannot be shown on this page/i);
  panel.close();
});

test('§19 both lanes on: the microphone is interpreting while the share dialog of the tab lane is still open', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.change('mic-enabled', true);
  await panel.click('btn-start');
  assert.equal(world.audio.picker.pending(), 1);
  const mic = await world.connect({ worklet: 0, socket: 0 });
  assert.equal(running(world.lastState(), 'mic'), true, 'the microphone did not wait for the dialog');
  assert.equal(world.lastState().lanes.tab.phase, 'starting');
  assert.equal(panel.text('btn-start'), 'Stop');
  assert.match(panel.text('tab-arm-note'), /choose the tab to interpret and press Share/i);
  world.audio.picker.choose({ label: world.labels.get(5) });
  await world.connect({ worklet: 1, socket: 1 });
  assert.equal(running(world.lastState(), 'tab') && running(world.lastState(), 'mic'), true);
  assert.equal(mic.socket.closeCalls, 0);
  assertNothingLeaks(world);
  panel.close();
});

test('§19 Cancel while the picker is open returns to idle at once; the next Start takes the same dialog over and runs', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.click('btn-start');
  assert.equal(world.audio.picker.pending(), 1);
  await panel.click('btn-start');   // Cancel
  assert.equal(panel.text('btn-start'), 'Start');
  assert.equal(panel.el('status-pill').getAttribute('data-state'), 'idle');
  assert.equal(panel.text('tab-notice'), '');
  assert.equal(world.lastState().lanes.tab.phase, 'off');

  await panel.click('btn-start');
  assert.equal(world.audio.picker.calls.length, 1, 'the dialog that was left open is reused, not stacked');
  assert.equal(panel.text('btn-start'), 'Cancel');
  world.audio.picker.choose({ label: world.labels.get(5) });   // the page was labelled again for this start
  await world.connect({ worklet: 0, socket: 0 });
  assert.equal(running(world.lastState(), 'tab'), true);
  assert.equal(world.lastState().lanes.tab.tabId, 5);
  panel.close();
});

test('§19 closing the picker is not an error, and a share without audio says how to share it', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.click('btn-start');
  world.audio.picker.dismiss();
  await world.settle();
  assert.equal(panel.text('btn-start'), 'Start');
  assert.equal(panel.text('tab-notice'), '');
  assert.equal(panel.el('status-pill').getAttribute('data-state'), 'idle');

  await panel.click('btn-start');
  const stream = world.audio.picker.choose({ label: world.labels.get(5), audio: false });
  await world.settle();
  assert.match(panel.text('tab-notice'), /Also share tab audio/);
  assert.equal(panel.text('tab-arm-note'), '');
  assert.equal(stream.getTracks().every((track) => track.readyState === 'ended'), true);
  assert.equal(world.sockets.sockets.length, 0);
  panel.close();
});

test('§19 an armed tab still starts at once, without any dialog', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await world.armTab(5);
  await panel.click('btn-start');
  await world.connect({ worklet: 0, socket: 0 });
  assert.equal(world.audio.picker.calls.length, 0);
  assert.equal(world.labels.size, 0);
  assert.equal(world.browser.captures.has(5), true);
  assert.equal(running(world.lastState(), 'tab'), true);
  panel.close();
});

test('a worker killed mid-session still forwards settings to the host on the next event', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.change('tab-enabled', false);
  await panel.change('mic-enabled', true);
  await panel.click('btn-start');
  await world.connect({ worklet: 0, socket: 0 });
  world.browser.sw.kill();
  assert.equal(world.browser.sw.running, false);

  await panel.click('btn-mute');
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  assert.equal(world.browser.sw.starts, 2, 'the storage event revived the worker');
  assert.equal(world.lastState().speechMuted, false, 'the mute edit reached the running host');
  assert.equal(running(world.lastState(), 'mic'), true);
  panel.close();
});

test('a quota error on one lane shows its notice and keeps the other lane running', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await world.armTab(5);
  await panel.change('mic-enabled', true);
  await panel.click('btn-start');
  const tab = await world.connect({ worklet: 0, socket: 0 });
  await world.connect({ worklet: 1, socket: 1 });

  tab.socket.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } });
  await tick();
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  const state = world.lastState();
  assert.equal(state.lanes.tab.phase, 'error');
  assert.equal(state.lanes.tab.quota || state.lanes.tab.errorCode === 'UNKNOWN_429', true, JSON.stringify(state.lanes.tab));
  assert.equal(state.lanes.mic.phase, 'running');
  assert.notEqual(panel.text('tab-notice'), '');
  assert.equal(panel.text('mic-notice'), '');
  assert.equal(panel.el('status-pill').getAttribute('data-state'), 'warning', 'one fails while the other runs');
  assert.equal(panel.el('usage-note').getAttribute('data-emphasis'), 'true', 'both lanes on: the doubling note is emphasized');
  panel.close();
});

// =============================================================================================
// Two-way mode (the contract's non-goal D10 was reversed): panel toggle -> stored settings -> worker -> host/lane-start
// -> lane host -> engine start -> Live setup message, over the real modules and the fake browser. Fake sockets and fake
// audio only: no sound, no network, no browser. The model's actual two-way OUTPUT is not tested here (checklist 13).

const TRANSLATION_ONLY = 'gemini-3.5-live-translate-preview';
const INSTRUCTION_MODEL = 'gemini-3.8-live';

const PAIR_LANGUAGES = ['ko', 'en', 'ja'];
const setupOf = (socket) => socket.sent[0].setup;
const instructionOf = (socket) => setupOf(socket).systemInstruction?.parts[0].text ?? '';
const optionValues = (panel, id) => panel.el(id).options.map((option) => option.value);
const storedLane = (world, lane) => world.browser.storageData('local')[STORAGE_KEYS.settings].lanes[lane];
// Every host/lane-start the worker sent, parsed: the only place the key, the stream id and the pair may travel.
const laneStarts = (world) => world.browser.deliveries
  .filter((entry) => entry.kind === 'message' && entry.to === 'offscreen')
  .map((entry) => JSON.parse(entry.json || 'null')).filter((message) => message?.type === 'host/lane-start');
const startOf = (world, lane) => laneStarts(world).find((message) => message.lane === lane);
const lastCaptions = (world, lane) => world.hostFrames('captions').filter((frame) => frame.lane === lane).at(-1);
const langsOf = (frame) => frame.rows.map((row) => row.lang);
const overlayCaptions = (world, tabId, lane) => world.overlays.find((entry) => entry.tabId === tabId)
  .frames.filter((frame) => frame.type === 'captions' && frame.lane === lane).at(-1);
// One finished caption row: the model's output text, the end of its turn, then the frame interval.
async function say(world, socket, text) {
  content(socket, { outputTranscription: { text } });
  content(socket, { turnComplete: true });
  await tick();
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
}

// Whatever the worker sent, a pair is absent or exactly two DISTINCT ko|en|ja languages, the first being the lane's own
// target language; and no start ever named a pair the engine was not given (and the other way round).
function assertPairsAreSane(world) {
  for (const message of laneStarts(world)) {
    const { request } = message;
    if (!Object.hasOwn(request, 'languages')) continue;
    assert.equal(Array.isArray(request.languages) && request.languages.length, 2, `${message.lane}: two languages`);
    for (const language of request.languages) assert.ok(PAIR_LANGUAGES.includes(language), `${message.lane}: ${language} is a language`);
    assert.notEqual(request.languages[0], request.languages[1], `${message.lane}: the two languages differ`);
    assert.equal(request.languages[0], request.targetLanguage, `${message.lane}: the first is the lane's own language`);
  }
  for (const request of world.engineStarts) {
    if (Object.hasOwn(request, 'languages')) assert.notEqual(request.languages[0], request.languages[1]);
  }
}

// The key and the pair each cross in the lane-start message and nowhere else: not a port frame, not a response, not
// storage, not the engine's request.
function assertNothingLeaks(world) {
  const starts = laneStarts(world);
  const carrying = world.browser.deliveries.filter((entry) => entry.json.includes(KEY));
  assert.equal(carrying.length, starts.length, 'the key is in exactly one message per lane start');
  for (const entry of carrying) {
    assert.deepEqual([entry.kind, entry.to, JSON.parse(entry.json).type], ['message', 'offscreen', 'host/lane-start']);
    assert.equal(entry.json.split(KEY).length, 2, 'and once inside it');
  }
  const pairing = world.browser.deliveries.filter((entry) => entry.json.includes('"languages"'));
  for (const entry of pairing) assert.deepEqual([entry.kind, entry.to, JSON.parse(entry.json).type], ['message', 'offscreen', 'host/lane-start']);
  assert.equal(pairing.length, starts.filter((message) => Object.hasOwn(message.request, 'languages')).length, 'one pair per two-way start');
  assert.equal(JSON.stringify(world.browser.storageData('session')).includes(KEY), false);
  assert.equal(JSON.stringify(world.browser.storageData('local')[STORAGE_KEYS.settings] ?? {}).includes(KEY), false);
  assert.equal(JSON.stringify(world.engineStarts).includes(KEY), false, 'the engine request carries no key');
  assert.equal(JSON.stringify(world.browser.storageData('session')).includes('"languages"'), false);
}

test('TWO-WAY microphone lane: the toggle and the partner are stored, Start sends languages [target, partner] in the one lane-start message, the engine is given it, and the Live setup is one two-way instruction', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.change('tab-enabled', false);
  await panel.change('mic-enabled', true);
  assert.equal(panel.el('mic-two-way').checked, false, 'off by default');
  assert.equal(panel.el('mic-partner-row').hidden, true);
  const oneWayLabel = panel.text('mic-target-label');

  await panel.change('mic-target', 'ko');
  await panel.change('mic-two-way', true);
  assert.equal(panel.el('mic-partner-row').hidden, false, 'the partner row shows while two-way is on');
  assert.equal(panel.text('mic-target-label'), 'First language');
  assert.notEqual(panel.text('mic-target-label'), oneWayLabel);
  assert.deepEqual(optionValues(panel, 'mic-partner'), ['en', 'ja'], 'every language but the first');
  assert.equal(panel.el('mic-two-way-note').hidden, true, 'the mic model is instruction-driven: nothing to note');
  await panel.change('mic-partner', 'ja');
  assert.deepEqual([storedLane(world, 'mic').twoWay, storedLane(world, 'mic').targetLanguage, storedLane(world, 'mic').partnerLanguage],
    [true, 'ko', 'ja'], 'the panel stored the choice');

  await panel.click('btn-start');
  const mic = await world.connect({ worklet: 0, socket: 0 });
  // The worker's message: the pair is exactly [target, partner] and the target stays in the request.
  assert.deepEqual(startOf(world, 'mic').request, { targetLanguage: 'ko', model: INSTRUCTION_MODEL, languages: ['ko', 'ja'] });
  // The host handed the engine that same pair (and still no source language).
  assert.equal(world.engineStarts.length, 1);
  assert.deepEqual(world.engineStarts[0].languages, ['ko', 'ja']);
  assert.equal(world.engineStarts[0].targetLanguage, 'ko');
  assert.equal(Object.hasOwn(world.engineStarts[0], 'sourceLanguage'), false);
  // The Live setup: one two-way instruction on the instruction-driven model, no single translation target.
  assert.equal(setupOf(mic.socket).model, `models/${INSTRUCTION_MODEL}`);
  assert.match(instructionOf(mic.socket), /two-way INTERPRETER between Korean and Japanese/);
  assert.equal(setupOf(mic.socket).generationConfig?.translationConfig, undefined);
  assert.equal(world.lastState().lanes.mic.phase, 'running');
  assert.equal(world.lastState().lanes.mic.targetLanguage, 'ko', 'the lane state keeps the first language');
  assert.equal(panel.text('mic-apply-next'), '', 'no "applies next" claim for a run that started with the settings it shows');

  // Rows come out in either language of the pair, each with its language.
  await say(world, mic.socket, '안녕하세요');
  await say(world, mic.socket, 'こんにちは');
  const frame = lastCaptions(world, 'mic');
  assert.deepEqual(frame.rows.map((row) => row.text), ['안녕하세요', 'こんにちは']);
  assert.deepEqual(langsOf(frame), ['ko', 'ja']);
  assert.equal(frame.lang, 'ja', 'the frame language is the newest row\'s');
  assertPairsAreSane(world);
  assertNothingLeaks(world);
  assert.equal(laneStarts(world).length, 1);
  panel.close();
});

test('TWO-WAY tab lane on the translation-only default: the panel says so, the host moves it to Gemini 3.8 Live, the setup is one two-way instruction and the overlay rows carry their language', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await world.armTab(5);
  assert.equal(storedLane(world, 'tab').model, TRANSLATION_ONLY, 'the tab lane defaults to the translation-only model');
  assert.equal(panel.el('tab-two-way-note').hidden, true, 'no note while two-way is off');

  await panel.change('tab-two-way', true);
  assert.deepEqual([panel.el('tab-target').value, panel.el('tab-partner').value], ['en', 'ko'], 'the default partner: Korean, for an English lane');
  assert.equal(panel.el('tab-two-way-note').hidden, false, 'two-way on the translation-only model: the panel says which model is used instead');
  assert.match(panel.text('tab-two-way-note'), /Gemini 3\.8 Live/);
  assert.equal(panel.el('mic-two-way-note').hidden, true, 'and the note is per lane');

  await panel.click('btn-start');
  const tab = await world.connect({ worklet: 0, socket: 0 });
  // The worker still sends the CHOSEN model; the engine is the one that moves it.
  assert.deepEqual(startOf(world, 'tab').request, { targetLanguage: 'en', model: TRANSLATION_ONLY, languages: ['en', 'ko'] });
  assert.deepEqual(world.engineStarts.map((request) => [request.model, request.languages]), [[TRANSLATION_ONLY, ['en', 'ko']]]);
  assert.equal(setupOf(tab.socket).model, `models/${INSTRUCTION_MODEL}`, 'the Live setup names the instruction-driven model');
  assert.equal(setupOf(tab.socket).generationConfig?.translationConfig, undefined, 'and no single translation target');
  assert.match(instructionOf(tab.socket), /two-way INTERPRETER between English and Korean/);
  const lane = world.lastState().lanes.tab;
  assert.deepEqual([lane.phase, lane.model, lane.route, lane.fallback], ['running', INSTRUCTION_MODEL, 'flash', false], 'the state tells the truth about the model');
  assert.match(panel.text('tab-route'), /General Live model/);
  assert.match(panel.text('tab-route'), new RegExp(INSTRUCTION_MODEL.replaceAll('.', '\\.')));
  assert.equal(panel.text('tab-route').includes('translate-preview'), false, 'the route line names the model really in use');
  assert.equal(panel.el('tab-two-way-note').hidden, false, 'the note stays while the run uses the substitute');
  assert.equal(panel.text('tab-apply-next'), '', 'the substitution is not a pending change');
  assert.equal(panel.el('status-pill').getAttribute('data-state'), 'running');

  // English and Korean rows, each labelled, on the panel and on the page.
  await say(world, tab.socket, 'Hello everyone, welcome');
  await say(world, tab.socket, '안녕하세요 여러분');
  assert.deepEqual(langsOf(lastCaptions(world, 'tab')), ['en', 'ko']);
  const overlay = overlayCaptions(world, 5, 'tab');
  assert.deepEqual(overlay.rows.map((row) => row.text), ['Hello everyone, welcome', '안녕하세요 여러분']);
  assert.deepEqual(langsOf(overlay), ['en', 'ko']);
  assert.equal(overlay.lang, 'ko');
  assertPairsAreSane(world);
  assertNothingLeaks(world);
  assert.equal(world.overlays.every((entry) => entry.frames.every((frame) => !JSON.stringify(frame).includes('"languages"'))), true, 'the pair never reaches the page');
  panel.close();
});

for (const twoWayLane of ['tab', 'mic']) {
  test(`TWO LANES at once, the ${twoWayLane} lane two-way and the other one-way: each setup is its own, the pair reaches only its lane, the key is in one message per lane`, async () => {
    const world = await makeWorld();
    const oneWayLane = twoWayLane === 'tab' ? 'mic' : 'tab';
    const panel = await world.openPanel();
    await world.armTab(5);
    await panel.change('mic-enabled', true);
    await panel.change(`${twoWayLane}-two-way`, true);
    assert.notEqual(panel.text('usage-note'), '', 'both lanes on: the doubling note');
    await panel.click('btn-start');
    const sockets = { tab: await world.connect({ worklet: 0, socket: 0 }), mic: await world.connect({ worklet: 1, socket: 1 }) };

    const [pairStart, plainStart] = [startOf(world, twoWayLane), startOf(world, oneWayLane)];
    assert.equal(pairStart.request.languages.length, 2);
    assert.equal(pairStart.request.languages[0], pairStart.request.targetLanguage);
    assert.equal(Object.hasOwn(plainStart.request, 'languages'), false, 'the pair of one lane never leaks into the other');
    assert.match(instructionOf(sockets[twoWayLane].socket), /two-way INTERPRETER between/);
    assert.equal(setupOf(sockets[twoWayLane].socket).model, `models/${INSTRUCTION_MODEL}`, 'a two-way lane is never on the translation-only model');
    assert.doesNotMatch(instructionOf(sockets[oneWayLane].socket), /two-way/);
    if (oneWayLane === 'tab') {
      assert.equal(setupOf(sockets.tab.socket).model, `models/${TRANSLATION_ONLY}`, 'the one-way tab lane keeps the translation-only model');
      assert.equal(setupOf(sockets.tab.socket).generationConfig.translationConfig.targetLanguageCode, plainStart.request.targetLanguage);
    } else {
      assert.match(instructionOf(sockets.mic.socket), /simultaneous INTERPRETER into/);
    }
    assert.equal(world.engineStarts.length, 2);
    assert.equal(world.engineStarts.filter((request) => Object.hasOwn(request, 'languages')).length, 1);
    const state = world.lastState();
    assert.equal(running(state, 'tab') && running(state, 'mic'), true);
    assert.equal(state.concurrent, 2);

    // Rows: only the two-way lane labels them.
    for (const lane of ['tab', 'mic']) await say(world, sockets[lane].socket, lane === 'tab' ? '안녕하세요' : 'こんにちは');
    assert.equal(lastCaptions(world, twoWayLane).rows.every((row) => PAIR_LANGUAGES.includes(row.lang)), true);
    assert.equal(lastCaptions(world, oneWayLane).rows.some((row) => Object.hasOwn(row, 'lang')), false);
    assertPairsAreSane(world);
    assertNothingLeaks(world);
    assert.equal(laneStarts(world).length, 2);
    panel.close();
  });
}

test('one-way lanes send no pair: defaults, and a two-way switch turned on and off again before Start', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await world.armTab(5);
  await panel.change('mic-enabled', true);
  await panel.change('mic-two-way', true);
  await panel.change('mic-two-way', false);
  assert.equal(panel.el('mic-partner-row').hidden, true);
  assert.equal(panel.text('mic-target-label'), panel.text('tab-target-label'), 'the label is back to the one-way wording');
  assert.equal(panel.el('mic-two-way-note').hidden, true);
  assert.deepEqual([storedLane(world, 'mic').twoWay, storedLane(world, 'tab').twoWay], [false, false]);

  await panel.click('btn-start');
  const tab = await world.connect({ worklet: 0, socket: 0 });
  const mic = await world.connect({ worklet: 1, socket: 1 });
  for (const lane of ['tab', 'mic']) {
    const { request } = startOf(world, lane);
    assert.deepEqual(Object.keys(request).sort(), ['model', 'targetLanguage'], `${lane}: the request is exactly a language and a model`);
  }
  assert.equal(world.engineStarts.some((request) => Object.hasOwn(request, 'languages')), false, 'the engine was given no pair');
  // The one-way setups: the translation-only target for the tab lane, "simultaneous INTERPRETER into" for the mic lane.
  assert.equal(setupOf(tab.socket).model, `models/${TRANSLATION_ONLY}`);
  assert.equal(setupOf(tab.socket).generationConfig.translationConfig.targetLanguageCode, startOf(world, 'tab').request.targetLanguage);
  assert.equal(instructionOf(tab.socket), '');
  assert.match(instructionOf(mic.socket), /simultaneous INTERPRETER into/);
  assert.doesNotMatch(instructionOf(mic.socket), /two-way/);
  assert.match(panel.text('tab-route'), new RegExp(TRANSLATION_ONLY.replaceAll('.', '\\.')), 'a one-way tab lane still reports the translation-only model');

  await say(world, tab.socket, '안녕하세요');
  await say(world, tab.socket, 'Hello');
  assert.equal(lastCaptions(world, 'tab').rows.some((row) => Object.hasOwn(row, 'lang')), false, 'one-way rows have no language of their own');
  assert.equal(overlayCaptions(world, 5, 'tab').rows.some((row) => Object.hasOwn(row, 'lang')), false);
  assertPairsAreSane(world);
  assertNothingLeaks(world);
  panel.close();
});

test('equal languages are never sent: the panel keeps the pair apart (the partner moves when the first language becomes it) and Start sends the repaired pair', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.change('tab-enabled', false);
  await panel.change('mic-enabled', true);
  await panel.change('mic-two-way', true);
  // Defaults for an English UI: the microphone lane targets Japanese and its partner is English.
  assert.deepEqual([panel.el('mic-target').value, panel.el('mic-partner').value], ['ja', 'en']);

  for (const target of ['en', 'ko', 'ja', 'en']) {
    const before = { target: panel.el('mic-target').value, partner: panel.el('mic-partner').value };
    await panel.change('mic-target', target);
    const after = { target: panel.el('mic-target').value, partner: panel.el('mic-partner').value };
    assert.equal(after.target, target);
    assert.notEqual(after.partner, target, `target ${target}: the partner is never the same language`);
    assert.equal(optionValues(panel, 'mic-partner').includes(target), false, `target ${target}: the partner select does not offer it`);
    assert.deepEqual([storedLane(world, 'mic').targetLanguage, storedLane(world, 'mic').partnerLanguage], [after.target, after.partner], 'the repaired pair was saved');
    if (before.partner === target) assert.equal(after.partner, before.target, 'the language just left takes the partner\'s place');
  }
  await panel.click('btn-start');
  await world.connect({ worklet: 0, socket: 0 });
  const { request } = startOf(world, 'mic');
  assert.equal(request.targetLanguage, 'en');
  assert.equal(request.languages.length, 2);
  assert.equal(request.languages[0], 'en');
  assert.notEqual(request.languages[1], 'en');
  assertPairsAreSane(world);
  panel.close();
});

test('equal languages are never sent, whatever is in storage: a partner equal to the target, missing, or not a language is repaired before it reaches the host', async () => {
  const cases = [
    { name: 'partner equals target', target: 'ko', partner: 'ko', expected: ['ko', 'en'] },
    { name: 'partner equals an English target', target: 'en', partner: 'en', expected: ['en', 'ko'] },
    { name: 'partner is not a language', target: 'ja', partner: 'fr', expected: ['ja', 'en'] },
    { name: 'partner is missing', target: 'ja', partner: undefined, expected: ['ja', 'en'] },
    { name: 'partner is a number', target: 'ko', partner: 7, expected: ['ko', 'en'] },
  ];
  for (const { name, target, partner, expected } of cases) {
    const settings = { v: 1, lanes: {
      tab: { enabled: false, targetLanguage: 'en', model: TRANSLATION_ONLY, originalVolume: 65, captions: true },
      mic: { enabled: true, targetLanguage: target, twoWay: true, ...(partner === undefined ? {} : { partnerLanguage: partner }), model: INSTRUCTION_MODEL, captions: false } } };
    const world = await makeWorld({ settings });
    const panel = await world.openPanel();
    assert.equal(panel.el('mic-partner').value, expected[1], `${name}: the panel shows the repaired partner`);
    await panel.click('btn-start');
    const mic = await world.connect({ worklet: 0, socket: 0 });
    assert.deepEqual(startOf(world, 'mic').request.languages, expected, name);
    assert.deepEqual(world.engineStarts.map((request) => request.languages), [expected], name);
    assert.match(instructionOf(mic.socket), /two-way INTERPRETER between/, name);
    assertPairsAreSane(world);
    panel.close();
  }
});

test('settings stored before two-way existed stay one-way; switching two-way on keeps every older field and starts with the default partner', async () => {
  const oldRecord = () => ({ v: 1, uiLanguage: 'auto', voiceGender: 'female', speechMuted: true, lanes: {
    tab: { enabled: true, targetLanguage: 'ko', model: TRANSLATION_ONLY, originalVolume: 40, captions: true },
    mic: { enabled: false, targetLanguage: 'en', model: INSTRUCTION_MODEL, captions: false } } });

  const plain = await makeWorld({ settings: oldRecord() });
  const first = await plain.openPanel();
  assert.deepEqual([first.el('tab-two-way').checked, first.el('mic-two-way').checked], [false, false]);
  assert.equal(Object.hasOwn(storedLane(plain, 'tab'), 'twoWay'), false, 'the panel did not rewrite the old record just by opening it');
  await plain.armTab(5);
  await first.click('btn-start');
  await plain.connect({ worklet: 0, socket: 0 });
  assert.deepEqual(startOf(plain, 'tab').request, { targetLanguage: 'ko', model: TRANSLATION_ONLY });
  assertPairsAreSane(plain);
  first.close();

  const switched = await makeWorld({ settings: oldRecord() });
  const second = await switched.openPanel();
  await switched.armTab(5);
  await second.change('tab-two-way', true);
  assert.deepEqual(storedLane(switched, 'tab'), { enabled: true, targetLanguage: 'ko', twoWay: true, partnerLanguage: 'en',
    model: TRANSLATION_ONLY, originalVolume: 40, captions: true }, 'the old fields are kept next to the new ones');
  await second.click('btn-start');
  const tab = await switched.connect({ worklet: 0, socket: 0 });
  assert.deepEqual(startOf(switched, 'tab').request, { targetLanguage: 'ko', model: TRANSLATION_ONLY, languages: ['ko', 'en'] });
  assert.match(instructionOf(tab.socket), /two-way INTERPRETER between Korean and English/);
  assertPairsAreSane(switched);
  second.close();
});

test('changing two-way while a lane runs applies from the next start: the hint appears, the running session is untouched, and the next start uses the new choice', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.change('tab-enabled', false);
  await panel.change('mic-enabled', true);
  await panel.click('btn-start');
  const first = await world.connect({ worklet: 0, socket: 0 });
  assert.equal(panel.text('mic-apply-next'), '');
  assert.match(instructionOf(first.socket), /simultaneous INTERPRETER into/, 'the run started one-way');

  await panel.change('mic-two-way', true);
  assert.notEqual(panel.text('mic-apply-next'), '', 'switching two-way on mid-run: the change applies from the next start');
  assert.equal(world.sockets.sockets.length, 1, 'no second session, the running one is untouched');
  assert.equal(laneStarts(world).length, 1);
  assert.equal(running(world.lastState(), 'mic'), true);
  await panel.change('mic-two-way', false);
  assert.equal(panel.text('mic-apply-next'), '', 'back to what the run has: nothing pending');
  await panel.change('mic-two-way', true);
  assert.notEqual(panel.text('mic-apply-next'), '');

  await panel.click('btn-start');                 // Stop
  await world.clock.advance(900);
  await world.settle();
  assert.equal(world.lastState().lanes.mic.phase, 'off');
  await panel.click('btn-start');                 // Start again: the new choice
  const second = await world.connect({ worklet: 1, socket: 1 });
  const starts = laneStarts(world);
  assert.equal(starts.length, 2);
  assert.equal(Object.hasOwn(starts[0].request, 'languages'), false, 'the first run was one-way');
  assert.equal(starts[1].request.languages.length, 2, 'the second one carries the pair');
  assert.equal(starts[1].request.languages[0], starts[1].request.targetLanguage);
  assert.deepEqual(world.engineStarts.map((engineRequest) => Object.hasOwn(engineRequest, 'languages')), [false, true]);
  assert.match(instructionOf(second.socket), /two-way INTERPRETER between/);
  assert.equal(panel.text('mic-apply-next'), '', 'the new run has the choice the settings show');
  assertPairsAreSane(world);
  assertNothingLeaks(world);
  panel.close();
});
