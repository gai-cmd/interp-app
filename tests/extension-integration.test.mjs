// New implementation of docs/extension.md §11.1 (extension-integration); no legacy code is ported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  const world = { browser, sockets, audio, clock: browser.clock, hosts: [], overlays: [], attaches: [], swCores: [] };
  browser.sw.idleTimeoutMs = 1e12;   // the tests kill the worker explicitly

  browser.onCreateOffscreen = (context) => {
    const host = createLaneHost({ adapter: { runtime: context.chrome.runtime }, env: audio.env, timers: browser.clock, hostId: `h-int-${world.hosts.length + 1}` });
    host.start();
    world.hosts.push(host);
  };
  // The overlay stand-in: it answers content/overlay-attach and then opens the port like the real script does.
  browser.onContentCreated = (context) => {
    context.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

test('a cross-origin navigation clears the arming: the panel asks for a fresh click and a Start waits for it', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await world.armTab(5);
  assert.match(panel.text('tab-arm-note'), /ready/i);

  await world.browser.navigate(5, 'https://elsewhere.example/');
  await world.settle();
  assert.equal(world.session()[STORAGE_KEYS.armed].tabs['5'], undefined);
  assert.match(panel.text('tab-arm-note'), /click the Live Interpreter icon/i);
  assert.equal(/This tab is ready/.test(panel.text('tab-arm-note')), false);

  await panel.click('btn-start');
  assert.equal(panel.text('btn-start'), 'Cancel', 'Start waits for the toolbar click');
  assert.equal(world.sockets.sockets.length, 0);
  await world.armTab(5);                          // the click both arms and starts
  await world.connect({ worklet: 0, socket: 0 });
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
