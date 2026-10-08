// New implementation of docs/extension.md §11.1 (extension-integration); no legacy code is ported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSimEngine } from '../app/engine/sim.js';
import { createServiceWorker } from '../extension/background/sw-core.js';
import { createLaneHost } from '../extension/engine/lane-host.js';
import { RELAY_CHANNEL_PREFIX, createRelaySender } from '../extension/lib/audio-relay.js';
import { createChromeAdapter } from '../extension/lib/chrome-adapter.js';
import { DISPLAY_MEDIA_CONSTRAINTS, canOpenDialogInPanel } from '../extension/lib/display-media.js';
import { loadExtensionI18n } from '../extension/lib/i18n.js';
import { LIMITS, PORT_NAMES, STORAGE_KEYS, makeFrame } from '../extension/lib/protocol.js';
import { createDefaultSettings } from '../extension/lib/settings.js';
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

// §22 (2026-10-08): the side panel's `media`, wired exactly like extension/panel/panel.js wires it, over the panel realm of
// the fake audio env (its navigator with the given Chrome version, its MediaStreamTrackProcessor and BroadcastChannel,
// its own share dialog `audio.panelPicker`). The display-capture method name is assembled at runtime (the D13 scan).
const SHARE_METHOD = ['getDisplay', 'Media'].join('');
function panelRealmOf(audio, spec) {
  const realm = audio.panelMedia(spec);
  return { navigator: realm.navigator, media: Object.freeze({
    canOpenDialog: () => canOpenDialogInPanel({ navigator: realm.navigator, env: realm.env }),
    openShareDialog: (constraints) => realm.navigator.mediaDevices[SHARE_METHOD](constraints),
    createRelaySender: ({ track, relayId }) => createRelaySender({ track, relayId, env: realm.env }),
    random: (bytes) => globalThis.crypto.getRandomValues(bytes),
  }) };
}

// `panelChrome` (§22): undefined = a panel with no `media` (every test before §22); a number or null = the Chrome major
// version the panel's navigator reports (null: none at all); an object = the panelMedia() options. With it, the host's
// realm also has the relay's constructors.
async function makeWorld({ tabs = [{ id: 5, url: 'https://claude.ai/doc' }], settings, key = KEY, micPermission = 'granted',
  builtinKeys, panelChrome } = {}) {
  const browser = createFakeBrowser({ messages: { menuOpen: 'Interpret this tab' } });
  // §20: every Live URL, in order, so a test can tell which key of the built-in pool a session used (never printed).
  const urls = [];
  const sockets = createSocketFixture({ inspectURL: (url) => urls.push(url) });
  const audio = createFakeAudioEnv({ browser, sockets, micPermission, ...(panelChrome === undefined ? {} : { relay: true }) });
  const panelSpec = panelChrome === undefined ? null
    : (panelChrome !== null && typeof panelChrome === 'object' ? panelChrome : { chromeMajor: panelChrome });
  const world = { browser, sockets, urls, audio, clock: browser.clock, hosts: [], overlays: [], attaches: [], swCores: [], engineStarts: [],
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
    const core = createServiceWorker({ adapter: createChromeAdapter(chromeApi), now: browser.clock.now, setTimeout: browser.clock.setTimeout,
      ...(builtinKeys ? { builtinKeys } : {}) });
    core.register();
    world.swCores.push(core);
  });

  world.settle = async () => { await browser.settle(); await tick(); await browser.settle(); };
  const seed = browser.createContext('options');
  if (key) await seed.chrome.storage.local.set({ [STORAGE_KEYS.key]: { v: 1, value: key } });
  if (settings) await seed.chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  seed.close();

  // A side panel: a fake page context, the parsed real markup and the real controller. `windowId` = the window it is
  // the side panel of; `wrap(adapter)` lets a test stand between the panel and the browser (§20 review: a host port
  // whose frames arrive late).
  world.openPanel = async ({ windowId = 1, wrap = (adapter) => adapter } = {}) => {
    const context = browser.createContext('panel', { windowId });
    const document = parseHtml(PANEL_HTML);
    const realm = panelSpec === null ? null : panelRealmOf(audio, panelSpec);
    const controller = createPanelController({
      document, adapter: wrap(createChromeAdapter(context.chrome)), i18n: { current: null },
      loadI18n: (options) => loadExtensionI18n({ fetch: fileFetch, ...options }),
      timers: { setTimeout: browser.clock.setTimeout, clearTimeout: browser.clock.clearTimeout, now: browser.clock.now },
      navigator: realm?.navigator ?? audio.env.navigator, ...(realm ? { media: realm.media } : {}),
      ...(builtinKeys ? { builtinKeys } : {}),
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
// The panel's own sw/lane-start requests to the worker, parsed, in order (the fake bus also delivers a copy to every other
// extension page, which ignores it: only the delivery to the worker counts). `pick: true` = "ask through Chrome's share dialog".
const panelLaneStarts = (world, lane = 'tab') => world.browser.deliveries
  .filter((entry) => entry.from === 'panel' && entry.to === 'sw' && entry.kind === 'message')
  .map((entry) => JSON.parse(entry.json)).filter((message) => message.type === 'sw/lane-start' && message.lane === lane);

// What the arm note says while Chrome's share dialog is open: the steps in the order the user takes them, with the labels
// of BOTH generations of the dialog (Chrome with the audio selection on says "Share with tab audio" and, once it is on,
// "Share with Audio"; the classic dialog says "Also share tab audio" and "Share").
function assertPickingNote(text) {
  assert.match(text, /choose the tab to interpret/i);
  assert.match(text, /Share with tab audio/);
  assert.match(text, /Also share tab audio/);
  assert.match(text, /Share with Audio/);
  assert.match(text, /"Share"/);
  assert.ok(text.indexOf('choose the tab') < text.indexOf('tab audio') && text.indexOf('tab audio') < text.indexOf('Share with Audio'),
    'choose the tab, leave the audio option on, then press the button');
}

// ---------------------------------------------------------------------------------------------
// §20 (2026-10-02): the icon click alone starts the tab lane (it used to arm the tab and wait for Start).
test('icon click arms, opens the panel and starts the tab lane at once; the key and the stream id cross in ONE message; captions reach the panel and the overlay', async () => {
  const world = await makeWorld();
  const { browser } = world;
  const panel = await world.openPanel();

  await world.armTab(5);
  assert.deepEqual(browser.panelOpens, [{ windowId: 1, tabId: null }], 'the icon click opened the panel');
  assert.equal(panel.text('btn-start'), 'Stop', 'and started interpreting that tab: no Start to press');
  assert.equal(world.session()[STORAGE_KEYS.autostart], undefined, 'the panel consumed the start request');
  assert.equal(world.audio.picker.calls.length, 0, 'no dialog');

  const tab = await world.connect({ worklet: 0, socket: 0 });
  assert.equal(panel.el('status-pill').getAttribute('data-state'), 'running');
  assert.equal(world.lastState().lanes.tab.phase, 'running');
  assert.equal(world.lastState().lanes.tab.tabId, 5);
  assert.equal(browser.captures.has(5), true);
  assert.equal(world.lastState().speechMuted, false, '§20: the interpreted voice plays by default');
  assert.equal(panel.el('btn-mute').getAttribute('data-muted'), 'false');

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

test('microphone and tab audio run at once (the icon starts both lanes that are on); the usage note appears; the voice plays', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.change('mic-enabled', true);
  assert.notEqual(panel.text('usage-note'), '', 'both lanes enabled: the doubling note');

  await world.armTab(5);
  const tab = await world.connect({ worklet: 0, socket: 0 });
  const mic = await world.connect({ worklet: 1, socket: 1 });
  const state = world.lastState();
  assert.equal(running(state, 'tab') && running(state, 'mic'), true);
  assert.equal(state.concurrent, 2);
  assert.equal(state.speechMuted, false, '§20: the voice plays by default');

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
  await world.connect({ worklet: 0, socket: 0 });
  const gains = () => world.audio.contexts.flatMap((context) => context.nodes).filter((node) => node.kind === 'gain');
  assert.equal(gains().at(-1).gain.value, 0.45, '§20: the owner\'s starting original volume');

  await panel.change('tab-volume', 30);
  assert.equal(gains().at(-1).gain.value, 0.3);

  await panel.click('btn-mute');
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  assert.equal(world.lastState().speechMuted, true, 'the host state frame carries the new mute');
  assert.equal(panel.el('btn-mute').getAttribute('data-muted'), 'true');
  panel.close();
});

test('a start (the icon) then Stop within one fake second ends with no live raw track and no engine', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  world.audio.setGetUserMediaMode('held');   // the host is inside getUserMedia when Stop lands
  await world.armTab(5);
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
  await panel.change('tab-captions', false);
  await world.armTab(5);
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
  await panel.change('mic-enabled', true);
  await world.armTab(5);
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

// §20 (2026-10-08): a Start on a tab the toolbar icon did not arm (here: its arming was cleared by a cross-origin
// navigation) opens Chrome's share dialog at once; the dialog is answered by choosing the tab in it, or the icon pressed
// on the tab takes it over.
for (const how of ['choosing the tab in the dialog', 'pressing the icon']) {
  test(`a cross-origin navigation clears the arming: the panel says Start opens a Chrome window, Start opens it at once, and ${how} starts the tab`, async () => {
    const world = await makeWorld();
    const panel = await world.openPanel();
    // An icon click while the tab lane is switched off arms the tab and starts nothing (no surprise enabling).
    await panel.change('tab-enabled', false);
    await world.armTab(5);
    assert.equal(world.sockets.sockets.length, 0);
    await panel.change('tab-enabled', true);
    assert.match(panel.text('tab-arm-note'), /ready/i);

    await world.browser.navigate(5, 'https://elsewhere.example/');
    await world.settle();
    assert.equal(world.session()[STORAGE_KEYS.armed].tabs['5'], undefined);
    assert.match(panel.text('tab-arm-note'), /Chrome opens a window where you choose the tab/i);
    assert.match(panel.text('tab-arm-note'), /press the Live Interpreter icon/i, 'and that the icon starts this tab at once');
    assert.equal(/This tab is ready/.test(panel.text('tab-arm-note')), false);

    await panel.click('btn-start');
    assert.equal(world.audio.picker.pending(), 1, 'Start opened the share dialog by itself: there is no wait for the icon');
    assert.equal(panel.text('btn-start'), 'Cancel', 'the start is waiting for the choice in the dialog');
    assert.deepEqual(panelLaneStarts(world).map((message) => message.pick), [true], 'the panel asked for the dialog, once');
    assert.deepEqual(answersWith(world, 'NEEDS_ARM'), [], 'the worker was told to open it, not refused first');
    assert.equal(laneStarts(world).length, 1);
    assert.ok(laneStarts(world)[0].tab.pick, 'a share-dialog start');
    assert.equal(world.sockets.sockets.length, 0);

    if (how === 'choosing the tab in the dialog') {
      world.audio.picker.choose({ label: world.labels.get(5) });
      await world.connect({ worklet: 0, socket: 0 });
      assert.equal(world.browser.captures.size, 0, 'through the dialog, not tabCapture');
      assert.equal(world.audio.picker.calls.length, 1);
    } else {
      await world.clock.advance(1000);   // a person's second click (a start request is told apart by its tab and time)
      await world.armTab(5);
      await world.connect({ worklet: 0, socket: 0 });
      assert.equal(world.browser.captures.has(5), true, 'through the icon\'s grant, not the dialog');
      assert.equal(world.audio.picker.calls.length, 1, 'no second dialog');
      assert.deepEqual(answersWith(world, 'ALREADY_RUNNING'), []);
    }
    assert.equal(running(world.lastState(), 'tab'), true);
    assert.equal(world.lastState().lanes.tab.tabId, 5);
    assert.equal(panel.text('tab-notice'), '');
    panel.close();
  });
}

// =============================================================================================
// §19 (2026-09-30), §20 (2026-10-08): the share dialog, end to end over the real worker, host and panel. Start alone
// opens it on a tab the toolbar icon did not arm (the same dialog on every OS); there is no second button and no wait.

test('§19 Start ALONE (no toolbar icon) opens the share dialog at once: the picker opens, the chosen tab is interpreted, and its page gets the captions', async () => {
  const world = await makeWorld({ tabs: [{ id: 5, url: 'https://video.example/watch', title: 'Video' }, { id: 6, url: 'https://claude.ai/doc', title: 'Doc' }] });
  const { browser } = world;
  const panel = await world.openPanel();
  assert.deepEqual(browser.panelOpens, [], 'the toolbar icon was never clicked');
  assert.equal(world.session()[STORAGE_KEYS.armed], undefined);
  assert.match(panel.text('tab-arm-note'), /Chrome opens a window where you choose the tab/i, 'idle, un-armed: Start opens a Chrome window');
  assert.match(panel.text('tab-arm-note'), /press the Live Interpreter icon/i, 'and the icon is the instant start');
  assert.equal(world.audio.picker.pending(), 0, 'nothing opens before Start');

  await panel.click('btn-start');
  // The dialog is open: one share-picker call in the host document, the panel's tab labelled, no stream id minted.
  assert.equal(world.audio.picker.pending(), 1, 'Start alone opens the dialog');
  assert.equal(panel.text('btn-start'), 'Cancel');
  assert.match(panel.text('status-pill'), /choose the tab/i);
  assertPickingNote(panel.text('tab-arm-note'));
  assert.match(panel.text('tab-arm-note'), /Or press the Live Interpreter icon at the top right: this tab starts at once/i, 'the icon hint is there from the first second');
  assert.match(panel.text('tab-arm-note'), /Shortcut: Alt\+Shift\+Y/);
  assert.equal(/Cannot see the Chrome window/.test(panel.text('tab-arm-note')), false, 'the "where is the window" hint waits');
  assert.equal(panel.el('tab-arm-note').getAttribute('data-attention'), 'true');
  assert.deepEqual(browser.offscreenDocument.reasons, ['USER_MEDIA', 'DISPLAY_MEDIA']);
  assert.equal(laneStarts(world).length, 1, 'one pick start');
  const [start] = laneStarts(world);
  assert.deepEqual(Object.keys(start.tab).sort(), ['originalVolume', 'pick']);
  assert.deepEqual([...world.labels], [[5, `${start.tab.pick}.5`]], 'only the tab the panel is on was labelled; the other page was not touched');
  assert.equal(browser.captures.size, 0, 'nothing is captured through tabCapture');
  assert.equal(world.lastState().lanes.tab.tabId, null, 'no tab is claimed before the user chose');
  assert.deepEqual(panelLaneStarts(world).map((message) => message.pick), [true], 'the panel itself asked for the dialog');
  assert.deepEqual(answersWith(world, 'NEEDS_ARM'), []);

  world.audio.picker.choose({ label: world.labels.get(5) });
  const tab = await world.connect({ worklet: 0, socket: 0 });
  assert.equal(panel.el('status-pill').getAttribute('data-state'), 'running');
  assert.equal(world.lastState().lanes.tab.tabId, 5);
  assert.equal(setupOf(tab.socket).model, `models/${INSTRUCTION_MODEL}`, 'the tab lane default model (0.5.1: the latest Live model), as on the armed path');
  assert.deepEqual(start.request, { targetLanguage: 'en', model: INSTRUCTION_MODEL });
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

test('§20 a dialog nobody answers: the hint to the icon is there at once, "cannot see the Chrome window" after eight seconds, and both go when the tab is chosen', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.click('btn-start');
  assert.match(panel.text('tab-arm-note'), /this tab starts at once/i);
  await world.clock.advance(7_900);
  await world.settle();
  assert.equal(/Cannot see the Chrome window/.test(panel.text('tab-arm-note')), false, 'not yet');
  await world.clock.advance(200);
  await world.settle();
  assert.match(panel.text('tab-arm-note'), /Cannot see the Chrome window\? Look behind the Chrome window you are working in, or on another screen\./);
  assert.equal(/taskbar|Dock/i.test(panel.text('tab-arm-note')), false, 'no claim about a taskbar or a Dock: nothing was verified');
  assert.match(panel.text('tab-arm-note'), /this tab starts at once/i, 'the icon hint stays');
  assert.equal(world.audio.picker.pending(), 1, 'the dialog is still the same one');
  world.audio.picker.choose({ label: world.labels.get(5) });
  await world.connect({ worklet: 0, socket: 0 });
  assert.equal(panel.text('tab-arm-note'), '');
  panel.close();
});

test('§19 ANOTHER tab chosen in the dialog is interpreted too, with captions in the panel only: its page was never labelled', async () => {
  const world = await makeWorld({ tabs: [{ id: 5, url: 'https://claude.ai/doc', title: 'Doc' }, { id: 6, url: 'https://video.example/watch', title: 'Video' }] });
  const panel = await world.openPanel();
  await panel.click('btn-start');
  assert.equal(world.audio.picker.pending(), 1);
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
  assert.equal(world.audio.picker.pending(), 1, 'Start opened the dialog; the tab lane is expected to open one, so the microphone does not wait for it');
  const mic = await world.connect({ worklet: 0, socket: 0 });
  assert.equal(world.audio.picker.pending(), 1, 'the dialog is still open while the microphone interprets');
  assert.equal(running(world.lastState(), 'mic'), true, 'the microphone did not wait for the dialog');
  assert.equal(world.lastState().lanes.tab.phase, 'starting');
  assert.equal(panel.text('btn-start'), 'Stop');
  assertPickingNote(panel.text('tab-arm-note'));
  world.audio.picker.choose({ label: world.labels.get(5) });
  await world.connect({ worklet: 1, socket: 1 });
  assert.equal(running(world.lastState(), 'tab') && running(world.lastState(), 'mic'), true);
  assert.equal(mic.socket.closeCalls, 0);
  assertNothingLeaks(world);
  panel.close();
});

// The real-browser finding (docs/extension.md §20, check 20.5; headless Chrome for Testing 149, headed Chrome and Windows
// UNVERIFIED): a dialog that nobody answered cannot be closed from the document, and while it is open a stream-id start
// of the SAME document never completes (the fake models it: tests/fixtures/fake-audio.mjs). So Cancel closes the offscreen
// document, which takes the dialog with it, unless the microphone lives in it.
test('§19 Cancel while the picker is open returns to idle at once and closes the offscreen document with the dialog in it; the panel stays quiet and the next Start opens a NEW dialog that runs', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.click('btn-start');
  assert.equal(world.audio.picker.pending(), 1);
  assert.equal(world.hosts.length, 1);
  await panel.click('btn-start');   // Cancel
  assert.equal(panel.text('btn-start'), 'Start');
  assert.equal(panel.el('status-pill').getAttribute('data-state'), 'idle');
  assert.equal(panel.text('tab-notice'), '');
  assert.equal(panel.text('stop-note'), '', 'closing the document is our own stop: no "connection lost" notice');
  assert.equal(world.browser.offscreenDocument, null, 'the document is gone');
  assert.equal(world.audio.picker.pending(), 0, 'and the dialog with it');
  assert.equal(world.audio.picker.gone(), 1);
  assert.equal(world.session()[STORAGE_KEYS.host].up, false, 'the host flag follows');
  assert.equal(world.session()[STORAGE_KEYS.lastStop], undefined);
  await world.clock.advance(20_000);   // nothing else happens by itself: no recreated document, no late notice
  await world.settle();
  assert.equal(world.browser.offscreenDocument, null);
  assert.equal(panel.text('stop-note'), '');

  await panel.click('btn-start');
  assert.equal(world.audio.picker.calls.length, 2, 'a NEW dialog: the old document and its dialog are gone, nothing is taken over');
  assert.equal(world.audio.picker.pending(), 1);
  assert.equal(world.hosts.length, 2, 'in a new document');
  assert.equal(world.session()[STORAGE_KEYS.host].up, true);
  assert.equal(panel.text('btn-start'), 'Cancel');
  world.audio.picker.choose({ label: world.labels.get(5) });   // the page was labelled again for this start
  await world.connect({ worklet: 0, socket: 0 });
  assert.equal(running(world.lastState(), 'tab'), true);
  assert.equal(world.lastState().lanes.tab.tabId, 5);
  assert.equal(panel.text('tab-notice'), '');
  panel.close();
});

test('§20 Cancel while the picker is open, then the icon on the tab: the document is recreated and the tab runs through the stream id, with no dialog left', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.click('btn-start');
  assert.equal(world.audio.picker.pending(), 1);
  await panel.click('btn-start');   // Cancel
  assert.equal(world.browser.offscreenDocument, null);

  await world.armTab(5);
  await world.connect({ worklet: 0, socket: 0 });
  assert.equal(running(world.lastState(), 'tab'), true);
  assert.equal(world.lastState().lanes.tab.tabId, 5);
  assert.equal(world.browser.captures.has(5), true, 'through the icon\'s grant');
  assert.equal(world.audio.picker.calls.length, 1, 'no second dialog');
  assert.equal(world.audio.picker.pending(), 0);
  assert.equal(world.audio.blockedTabCaptures(), 0);
  assert.equal(world.hosts.length, 2, 'a fresh document');
  assert.deepEqual(panelLaneStarts(world).map((message) => message.pick), [true, undefined]);
  assert.deepEqual(answersWith(world, 'LANE_STOPPING'), []);
  assert.equal(panel.text('tab-notice'), '');
  assert.equal(panel.text('stop-note'), '');
  panel.close();
});

// A microphone in the document is why it cannot be closed. Switching the tab lane off while its dialog is open leaves
// the dialog behind (the microphone goes on); switching the lane on again takes that same dialog over (tab-lane.js).
test('§19 the microphone interprets while the tab lane is switched off with its dialog open: the document stays, the microphone is untouched, and switching the lane on takes the same dialog over', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.change('mic-enabled', true);
  await panel.click('btn-start');
  const mic = await world.connect({ worklet: 0, socket: 0 });
  assert.equal(running(world.lastState(), 'mic'), true);
  assert.equal(world.audio.picker.pending(), 1);

  await panel.change('tab-enabled', false);
  assert.equal(world.lastState().lanes.tab.phase, 'off');
  assert.equal(running(world.lastState(), 'mic'), true, 'the microphone keeps interpreting');
  assert.equal(mic.socket.closeCalls, 0);
  assert.notEqual(world.browser.offscreenDocument, null, 'the document is NOT closed: it would end the microphone');
  assert.equal(world.hosts.length, 1);
  assert.equal(world.audio.picker.pending(), 1, 'the dialog is left behind: it cannot be closed from the document');
  assert.equal(world.audio.picker.gone(), 0);
  assert.equal(world.session()[STORAGE_KEYS.host].up, true);
  assert.equal(panel.text('tab-notice'), '');

  await panel.change('tab-enabled', true);
  assert.equal(world.audio.picker.calls.length, 1, 'the new start took the left-over dialog over instead of stacking a second one');
  assert.equal(world.audio.picker.pending(), 1);
  assert.match(panel.text('status-pill'), /choose the tab/i);
  world.audio.picker.choose({ label: world.labels.get(5) });
  await world.connect({ worklet: 1, socket: 1 });
  assert.equal(running(world.lastState(), 'tab') && running(world.lastState(), 'mic'), true);
  assert.equal(mic.socket.closeCalls, 0, 'and the microphone never noticed');
  assertNothingLeaks(world);
  panel.close();
});

// What a dialog that was left behind (the microphone kept the document) still delivers is released at once: it belongs to no start.
test('§19 a dialog left behind by a lane switched off (the microphone kept the document) delivers a tab later: the stream is released at once and no lane starts', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.change('mic-enabled', true);
  await panel.click('btn-start');
  await world.connect({ worklet: 0, socket: 0 });
  await panel.change('tab-enabled', false);
  assert.equal(world.audio.picker.pending(), 1, 'the dialog is still open');
  const late = world.audio.picker.choose({ label: world.labels.get(5) });   // the user answers it after all
  await world.settle();
  assert.equal(late.getTracks().every((track) => track.readyState === 'ended'), true, 'nothing keeps capturing');
  assert.equal(late.source.released, true);
  assert.equal(world.lastState().lanes.tab.phase, 'off');
  assert.equal(running(world.lastState(), 'mic'), true);
  assert.equal(world.sockets.sockets.length, 1, 'no session was opened for the tab');
  assert.equal(panel.text('tab-notice'), '');
  panel.close();
});

test('§19 closing the picker is not an error, and a share without audio says how to share it', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.click('btn-start');
  await world.clock.advance(5_000);   // a person closing the dialog takes time (a refusal at once is the next test)
  world.audio.picker.dismiss();
  await world.settle();
  assert.equal(panel.text('btn-start'), 'Start');
  assert.equal(panel.text('tab-notice'), '');
  assert.equal(panel.el('status-pill').getAttribute('data-state'), 'idle');
  assert.equal(world.lastState().lanes.tab.errorCode, null);

  await panel.click('btn-start');
  const stream = world.audio.picker.choose({ label: world.labels.get(5), audio: false });
  await world.settle();
  assert.match(panel.text('tab-notice'), /Also share tab audio/);
  assert.match(panel.text('tab-notice'), /press the Live Interpreter icon/i, 'the other way is named');
  assert.equal(/\bbutton\b/i.test(panel.text('tab-notice')), false, 'there is no button of the panel to name');
  assert.equal(panel.text('tab-arm-note'), '');
  assert.equal(stream.getTracks().every((track) => track.readyState === 'ended'), true);
  assert.equal(world.sockets.sockets.length, 0);
  panel.close();
});

// The 400 ms rule counts from the moment the dialog was asked for, not from the clock's zero: every start below is made
// long after the clock started, so a rule on the absolute clock, or a start time that was never set, calls all of them
// dismissals (a silent return to Start) and fails the first three.
test('§20 a dialog the browser refuses at once is shown as a failure, not a silent return to Start; the 400 ms are counted from the call, at any clock value', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  for (const [openFor, refused] of [[0, true], [1, true], [399, true], [400, false], [401, false]]) {
    await world.clock.advance(10_000);   // the clock is far from 0 when the dialog is asked for
    await panel.click('btn-start');
    assert.equal(world.audio.picker.pending(), 1, `${openFor} ms: Start opened a dialog`);
    await world.clock.advance(openFor);
    world.audio.picker.dismiss();   // NotAllowedError, `openFor` ms after the call
    await world.settle();
    if (refused) {
      assert.equal(world.lastState().lanes.tab.errorCode, 'TAB_CAPTURE_FAILED', `${openFor} ms: nobody reacts to a window that fast`);
      assert.match(panel.text('tab-notice'), /Could not capture this tab's audio/);
      assert.match(panel.text('tab-notice'), /press the Live Interpreter icon on the tab you want to interpret/i,
        'a policy that blocks the dialog is not helped by reloading the tab: the icon is the way out');
    } else {
      assert.equal(panel.text('tab-notice'), '', `${openFor} ms: a person closing the dialog is silent`);
      assert.equal(world.lastState().lanes.tab.errorCode, null);
    }
    assert.equal(panel.text('btn-start'), 'Start', 'and Start can be pressed again');
  }
  panel.close();
});

// §20 (2026-10-08): the panel reads a tab as armed from the worker's stored record. Chrome's own grant can be gone while
// that record is still there (here: dropped by the browser, with nothing telling the worker or the panel). Start then
// goes out WITHOUT `pick` (an armed tab starts by stream id), the mint fails, the worker answers NEEDS_ARM, and the panel
// asks once more WITH `pick`: the person ends in the share dialog, with no notice and no second press of anything.
test('§20 a STALE armed record (the panel believes the tab armed, Chrome\'s grant is gone): Start is answered NEEDS_ARM once, then ends in the dialog with no notice', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.change('tab-enabled', false);
  await world.armTab(5);   // armed, nothing started
  await panel.change('tab-enabled', true);
  assert.match(panel.text('tab-arm-note'), /ready/i, 'the panel believes the tab is armed');
  assert.equal(world.browser.hasGrant(5), true);
  world.browser.grants.delete(5);   // Chrome let go of the grant; the record in storage.session outlives it
  assert.ok(world.session()[STORAGE_KEYS.armed].tabs['5'], 'the stale record is still there');
  assert.equal(world.sockets.sockets.length, 0);

  await panel.click('btn-start');
  // First request: the armed tab's instant path (no pick). The worker finds no grant, clears the record, answers NEEDS_ARM.
  // Second request: the panel's own retry, with pick, opens the dialog.
  assert.deepEqual(panelLaneStarts(world).map((message) => message.pick), [undefined, true], 'one request without pick, then one with');
  assert.equal(answersWith(world, 'NEEDS_ARM').length, 1, 'refused exactly once: the retry is never refused again');
  assert.equal(world.session()[STORAGE_KEYS.armed].tabs['5'], undefined, 'the worker dropped the stale record');
  assert.equal(laneStarts(world).length, 1, 'the mint\'s refusal sent nothing to the host as a start: only the dialog start did');
  assert.ok(laneStarts(world)[0].tab.pick);
  assert.equal(world.audio.picker.pending(), 1, 'the share dialog is open');
  assert.equal(world.browser.captures.size, 0);
  assert.equal(panel.text('btn-start'), 'Cancel');
  assert.match(panel.text('status-pill'), /choose the tab/i);
  assertPickingNote(panel.text('tab-arm-note'));
  assert.equal(panel.text('tab-notice'), '', 'no notice for the refusal');
  assert.equal(panel.text('stop-note'), '');

  world.audio.picker.choose({ label: world.labels.get(5) });
  await world.connect({ worklet: 0, socket: 0 });
  assert.equal(running(world.lastState(), 'tab'), true);
  assert.equal(world.lastState().lanes.tab.tabId, 5);
  assert.equal(panel.text('tab-notice'), '');
  assert.equal(panelLaneStarts(world).length, 2, 'and nothing was asked again');
  assert.equal(answersWith(world, 'NEEDS_ARM').length, 1);
  assert.deepEqual(answersWith(world, 'ALREADY_RUNNING'), []);
  assert.equal(world.hostFrames('state').some((frame) => frame.state.lanes.tab.phase === 'error'), false, 'the lane never showed an error');
  panel.close();
});

test('§20 a STALE armed record with both lanes on: the dialog opens and the microphone interprets while it is still open', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.change('tab-enabled', false);
  await world.armTab(5);
  await panel.change('tab-enabled', true);
  await panel.change('mic-enabled', true);
  world.browser.grants.delete(5);   // Chrome let go of the grant; the record in storage.session outlives it
  await panel.click('btn-start');
  assert.equal(world.audio.picker.pending(), 1, 'the retry opened the dialog');
  assert.deepEqual(panelLaneStarts(world).map((message) => message.pick), [undefined, true],
    'tab without pick (refused), then tab with pick');
  assert.equal(panelLaneStarts(world, 'mic').length, 1, 'and the microphone start was sent while the dialog is open');
  assert.deepEqual(laneStarts(world).map((message) => message.lane).sort(), ['mic', 'tab'], 'only the dialog start and the microphone reached the host (in either order: the dialog start does the label step first)');
  await world.connect({ worklet: 0, socket: 0 });
  assert.equal(world.audio.picker.pending(), 1, 'the dialog is still open while the microphone interprets');
  assert.equal(running(world.lastState(), 'mic'), true, 'the microphone did not wait behind the dialog');
  assert.equal(world.lastState().lanes.tab.phase, 'starting');
  assert.equal(panel.text('tab-notice'), '');
  world.audio.picker.choose({ label: world.labels.get(5) });
  await world.connect({ worklet: 1, socket: 1 });
  assert.equal(running(world.lastState(), 'tab') && running(world.lastState(), 'mic'), true);
  assertNothingLeaks(world);
  panel.close();
});

test('§20 Start on an ARMED tab (the icon armed it while the lane was off) starts by stream id: no pick, no dialog, the microphone after it', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.change('tab-enabled', false);
  await world.armTab(5);   // armed, nothing started
  await panel.change('tab-enabled', true);
  await panel.change('mic-enabled', true);
  assert.match(panel.text('tab-arm-note'), /ready/i);
  await panel.click('btn-start');
  assert.deepEqual(panelLaneStarts(world).map((message) => message.pick), [undefined], 'an armed tab is not sent to the dialog');
  assert.equal(world.audio.picker.calls.length, 0);
  assert.equal(world.labels.size, 0);
  assert.equal(world.browser.captures.has(5), true, 'through tabCapture');
  assert.deepEqual(laneStarts(world).map((message) => message.lane), ['tab', 'mic'], 'the tab first, then the microphone');
  assert.deepEqual(answersWith(world, 'NEEDS_ARM'), []);
  await world.connect({ worklet: 0, socket: 0 });
  await world.connect({ worklet: 1, socket: 1 });
  assert.equal(running(world.lastState(), 'tab') && running(world.lastState(), 'mic'), true);
  panel.close();
});

test('§19 an armed tab still starts at once, without any dialog (§20: the icon click itself starts it)', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await world.armTab(5);
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
  assert.equal(world.lastState().speechMuted, true, 'the mute edit reached the running host');
  assert.equal(running(world.lastState(), 'mic'), true);
  panel.close();
});

test('a quota error on one lane shows its notice and keeps the other lane running', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.change('mic-enabled', true);
  await world.armTab(5);
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
// §20 (2026-10-02) "zero setup", end to end over the real worker, host and panel.

const answersWith = (world, code) => world.browser.deliveries.filter((entry) => entry.kind === 'response' && entry.json.includes(`"code":"${code}"`));

test('§20 the icon on ANOTHER tab while the tab lane runs: the lane moves to that tab, and no start is ever refused as ALREADY_RUNNING', async () => {
  const world = await makeWorld({ tabs: [{ id: 5, url: 'https://a.example/', title: 'A' }, { id: 6, url: 'https://b.example/', title: 'B' }] });
  const panel = await world.openPanel();
  await world.armTab(5);
  await world.connect({ worklet: 0, socket: 0 });
  assert.equal(world.lastState().lanes.tab.tabId, 5);

  await world.browser.activateTab(6);
  await world.settle();
  await world.clock.advance(1000);
  await world.armTab(6);
  await world.connect({ worklet: 1, socket: 1 });
  const state = world.lastState();
  assert.equal(running(state, 'tab'), true);
  assert.equal(state.lanes.tab.tabId, 6, 'the tab the icon was pressed on');
  assert.deepEqual([world.browser.captures.has(5), world.browser.captures.has(6)], [false, true], 'the first capture was released');
  assert.equal(world.sockets.sockets[0].readyState === 1, false, 'the first session was closed');
  assert.deepEqual(answersWith(world, 'ALREADY_RUNNING'), [], 'the start never raced the stop');
  assert.deepEqual(answersWith(world, 'LANE_STOPPING'), []);
  assert.equal(panel.text('tab-notice'), '');
  assert.equal(panel.text('stop-note'), '', 'a switch is not a lost connection');
  assert.match(panel.text('tab-tabline'), /B/);
  // and the icon on the tab it already interprets changes nothing
  await world.clock.advance(1000);
  await world.armTab(6);
  assert.equal(world.sockets.sockets.length, 2);
  assert.equal(laneStarts(world).length, 2);
  panel.close();
});

// A panel adapter whose host port holds the host's frames until `gate.open()`: a host that answers the new panel's port
// after the panel's own storage reads (in Chrome a race between three storage.session round trips and the
// connect/hello/state route through the offscreen document).
function heldHostFrames() {
  const gate = { held: [], opened: false, open() { this.opened = true; for (const deliver of this.held.splice(0)) deliver(); } };
  const wrap = (adapter) => ({
    ...adapter,
    runtime: { ...adapter.runtime, connect: (info) => {
      const port = adapter.runtime.connect(info);
      return {
        get name() { return port.name; },
        postMessage: (message) => port.postMessage(message),
        disconnect: () => port.disconnect(),
        onDisconnect: port.onDisconnect,
        onMessage: { addListener: (listener) => port.onMessage.addListener((frame, sender) => {
          if (gate.opened) listener(frame, sender); else gate.held.push(() => listener(frame, sender));
        }) },
      };
    } },
  });
  return { gate, wrap };
}

// §20 review (F1): the panel that the icon click in window 2 opened had no host state yet and read that as "idle". Its
// start next to the lane running in window 1 was refused as ALREADY_RUNNING after a stream id had been minted for the
// clicked tab; that id then broke the next click there (TAB_CAPTURE_BUSY, interpretation off). Fails on the first 0.5.0
// build.
test('§20 the icon in ANOTHER WINDOW whose new panel has no host state yet: the lane moves there, nothing is refused, the next click is fine', async () => {
  const world = await makeWorld({ tabs: [{ id: 5, url: 'https://a.example/', title: 'A' }] });
  world.browser.addTab({ id: 7, url: 'https://b.example/', title: 'B', windowId: 2, active: true });
  const first = await world.openPanel({ windowId: 1 });
  await world.armTab(5);
  await world.connect({ worklet: 0, socket: 0 });
  assert.equal(world.lastState().lanes.tab.tabId, 5);

  world.browser.focusWindow(2);
  await world.clock.advance(1000);
  await world.armTab(7);   // the click; its window's panel opens now
  const { gate, wrap } = heldHostFrames();
  const second = await world.openPanel({ windowId: 2, wrap });
  await world.settle();
  assert.equal(laneStarts(world).length, 1, 'the new panel waits for the host\'s word before it decides');
  gate.open();
  await world.settle();
  await world.connect({ worklet: 1, socket: 1 });
  let state = world.lastState();
  assert.equal(running(state, 'tab'), true);
  assert.equal(state.lanes.tab.tabId, 7, 'the tab the icon was pressed on');
  assert.deepEqual([world.browser.captures.has(5), world.browser.captures.has(7)], [false, true]);
  assert.deepEqual(answersWith(world, 'ALREADY_RUNNING'), [], 'no start was sent next to the running lane');
  assert.equal(world.session()[STORAGE_KEYS.autostart], undefined, 'the click was consumed');
  assert.equal(second.text('tab-notice'), '');
  // The next click on the same tab: nothing to do, and no stream id was left behind to refuse a mint.
  await world.clock.advance(1000);
  await world.armTab(7);
  state = world.lastState();
  assert.equal(running(state, 'tab'), true);
  assert.equal(state.lanes.tab.tabId, 7);
  assert.deepEqual(answersWith(world, 'TAB_CAPTURE_BUSY'), []);
  assert.equal(second.text('tab-notice'), '');
  assert.equal(laneStarts(world).length, 2);
  first.close();
  second.close();
});

// §20 review (F2/UX-2): an icon click on another tab while the icon start of the first tab was still in flight was used
// up and did nothing; the lane ran on the first tab.
test('§20 the icon on another tab while the first icon start is still in flight (getUserMedia held): the lane ends up on the tab clicked last', async () => {
  const world = await makeWorld({ tabs: [{ id: 5, url: 'https://a.example/', title: 'A' }, { id: 6, url: 'https://b.example/', title: 'B' }] });
  const panel = await world.openPanel();
  world.audio.setGetUserMediaMode('held');
  await world.armTab(5);
  assert.equal(world.audio.pendingGetUserMedia(), 1, 'the first start is inside getUserMedia');
  await world.browser.activateTab(6);
  await world.settle();
  await world.clock.advance(500);
  await world.armTab(6);
  world.audio.setGetUserMediaMode('normal');
  world.audio.releaseGetUserMedia();
  await world.settle();
  for (let round = 0; round < 20 && !running(world.lastState(), 'tab'); round += 1) {
    world.audio.worklets.at(-1)?.emitFrames(0.25);
    await world.settle();
    const socket = world.sockets.sockets.at(-1);
    if (socket && socket.readyState === 0) { socket.open(); socket.json({ setupComplete: {} }); await world.settle(); }
  }
  const state = world.lastState();
  assert.equal(running(state, 'tab'), true);
  assert.equal(state.lanes.tab.tabId, 6, 'the tab the icon was pressed on last');
  assert.equal(world.browser.captures.has(5), false, 'the first tab\'s capture was released');
  assert.deepEqual(answersWith(world, 'ALREADY_RUNNING'), []);
  assert.equal(panel.text('tab-notice'), '');
  assert.match(panel.text('tab-tabline'), /B/);
  panel.close();
});

// With the real-browser finding in the fake (a dialog that is still open blocks a stream-id start of its document), this
// is the test that needs the document to be closed: without it the icon's start would hang behind the left-over dialog.
test('§20 the icon while the share dialog is open: the dialog start is cancelled, the document and its dialog are closed, and the tab starts through the icon\'s grant', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.click('btn-start');
  assert.equal(world.audio.picker.pending(), 1, 'Start alone opened the dialog');
  await world.armTab(5);
  assert.equal(world.audio.blockedTabCaptures(), 0, 'the instant start was not held behind the dialog');
  await world.connect({ worklet: 0, socket: 0 });
  const state = world.lastState();
  assert.equal(running(state, 'tab'), true);
  assert.equal(state.lanes.tab.tabId, 5);
  assert.equal(world.browser.captures.has(5), true, 'through tabCapture, not the dialog');
  assert.equal(world.audio.picker.calls.length, 1, 'no second dialog');
  // Exactly one tab start through the icon's grant, after the dialog's own start; none of them was refused.
  assert.deepEqual(panelLaneStarts(world).map((message) => message.pick), [true, undefined], 'the dialog start, then the icon\'s start by stream id');
  assert.equal(laneStarts(world).filter((message) => message.tab.streamId !== undefined).length, 1, 'one start through the icon\'s grant');
  assert.equal(world.sockets.sockets.length, 1, 'one session: the dialog never produced one');
  assert.deepEqual(answersWith(world, 'ALREADY_RUNNING'), []);
  assert.deepEqual(answersWith(world, 'LANE_STOPPING'), []);
  assert.deepEqual(answersWith(world, 'NEEDS_ARM'), []);
  assert.equal(panel.text('tab-notice'), '');
  // The dialog that was open is gone with its document; the tab runs in a new one.
  assert.equal(world.audio.picker.pending(), 0);
  assert.equal(world.audio.picker.gone(), 1);
  assert.equal(world.hosts.length, 2);
  assert.throws(() => world.audio.picker.choose({ label: world.labels.get(5) }), /no share picker is open/);
  assert.equal(world.lastState().lanes.tab.tabId, 5);
  assert.equal(panel.text('stop-note'), '', 'closing the old document is our own stop: no "connection lost" notice');
  panel.close();
});

// KNOWN LIMIT (sw-core.js, closeLeftOverDialog): with the microphone running the document cannot be closed, so a dialog
// that was left open blocks the instant start of the tab until it is answered.
test('KNOWN LIMIT: with the microphone running the left-over dialog stays, and the icon\'s instant start of the tab waits behind it until the dialog is answered', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  await panel.change('mic-enabled', true);
  await panel.click('btn-start');
  await world.connect({ worklet: 0, socket: 0 });
  assert.equal(world.audio.picker.pending(), 1);
  await world.armTab(5);   // the icon takes the dialog start over: the dialog start is stopped, the stream-id start is sent
  assert.equal(world.hosts.length, 1, 'the document could not be closed: the microphone lives in it');
  assert.equal(world.audio.picker.pending(), 1, 'so the dialog is still open');
  assert.equal(world.audio.blockedTabCaptures(), 1, 'and the tab capture waits behind it');
  assert.equal(world.browser.captures.has(5), false);
  assert.equal(world.lastState().lanes.tab.phase, 'starting');
  assert.equal(running(world.lastState(), 'mic'), true, 'the microphone is untouched');
  // The user answers the dialog that was left behind (here: closes it): the waiting start goes on.
  world.audio.picker.dismiss();
  await world.settle();
  assert.equal(world.audio.blockedTabCaptures(), 0);
  assert.equal(world.browser.captures.has(5), true);
  await world.connect({ worklet: 1, socket: 1 });
  assert.equal(running(world.lastState(), 'tab') && running(world.lastState(), 'mic'), true);
  assert.equal(world.lastState().lanes.tab.tabId, 5);
  panel.close();
});

test('§20 no personal key: the built-in pool travels, and a refused first key moves the lane to the next one with no failure shown', async () => {
  const POOL = [`synthetic-${'a'.repeat(24)}`, `synthetic-${'b'.repeat(24)}`];
  const world = await makeWorld({ key: null, builtinKeys: POOL });
  const panel = await world.openPanel();
  assert.equal(panel.text('key-missing-text'), '', 'a keyless member is not asked for a key');
  await world.armTab(5);
  await tick();
  for (let block = 0; block < 3; block += 1) world.audio.worklets[0].emitFrames(0.25);
  await tick();
  const keyOf = (url) => decodeURIComponent(new URL(url).searchParams.get('key'));
  assert.equal(keyOf(world.urls[0]), POOL[0]);
  world.sockets.sockets[0].open();
  world.sockets.sockets[0].finishClose(1007, 'API key not valid. Please pass a valid API key.');
  await world.settle();
  for (let round = 0; round < 20 && world.sockets.sockets.length < 2; round += 1) {
    world.audio.worklets.at(-1).emitFrames(0.25);
    await world.settle();
  }
  assert.equal(keyOf(world.urls[1]), POOL[1], 'the next key, at once');
  world.sockets.sockets[1].open();
  world.sockets.sockets[1].json({ setupComplete: {} });
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  assert.equal(running(world.lastState(), 'tab'), true);
  assert.equal(panel.text('tab-notice'), '');
  assert.notEqual(panel.el('status-pill').getAttribute('data-state'), 'error');
  const states = world.hostFrames('state').map((frame) => frame.state.lanes.tab);
  assert.equal(states.some((lane) => lane.phase === 'error' || lane.errorCode !== null), false, 'the refused key never showed as a failure');
  // The pool is in the one host/lane-start and nowhere else.
  for (const key of POOL) {
    const carrying = world.browser.deliveries.filter((entry) => entry.json.includes(key));
    assert.equal(carrying.length, 1);
    assert.equal(JSON.parse(carrying[0].json).type, 'host/lane-start');
  }
  panel.close();
});

// =============================================================================================
// Two-way mode (the contract's non-goal D10 was reversed): panel toggle -> stored settings -> worker -> host/lane-start
// -> lane host -> engine start -> Live setup message, over the real modules and the fake browser. Fake sockets and fake
// audio only: no sound, no network, no browser. The model's actual two-way OUTPUT is not tested here (checklist 13).

const TRANSLATION_ONLY = 'gemini-3.5-live-translate-preview';
const INSTRUCTION_MODEL = 'gemini-3.8-live';
// 0.5.1: the tab lane's DEFAULT is the latest Live model. The scenarios below that are about the translation-only preview
// (a choice a user can still make) start with that choice stored; everything else is the first-run defaults.
const translationOnlyTab = () => {
  const settings = createDefaultSettings('en');
  return { ...settings, lanes: { ...settings.lanes, tab: { ...settings.lanes.tab, model: TRANSLATION_ONLY } } };
};

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

test('TWO-WAY tab lane on the translation-only model (a choice): the panel says so, the host moves it to Gemini 3.8 Live, the setup is one two-way instruction and the overlay rows carry their language', async () => {
  const world = await makeWorld({ settings: translationOnlyTab() });
  const panel = await world.openPanel();
  assert.equal(storedLane(world, 'tab').model, TRANSLATION_ONLY, 'the tab lane holds the translation-only model that was chosen');
  assert.equal(panel.el('tab-two-way-note').hidden, true, 'no note while two-way is off');

  await panel.change('tab-two-way', true);
  assert.deepEqual([panel.el('tab-target').value, panel.el('tab-partner').value], ['en', 'ko'], 'the default partner: Korean, for an English lane');
  assert.equal(panel.el('tab-two-way-note').hidden, false, 'two-way on the translation-only model: the panel says which model is used instead');
  assert.match(panel.text('tab-two-way-note'), /Gemini 3\.8 Live/);
  assert.equal(panel.el('mic-two-way-note').hidden, true, 'and the note is per lane');

  await world.armTab(5);   // §20: the icon starts the tab
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
    const world = await makeWorld({ settings: translationOnlyTab() });
    const oneWayLane = twoWayLane === 'tab' ? 'mic' : 'tab';
    const panel = await world.openPanel();
    await panel.change('mic-enabled', true);
    await panel.change(`${twoWayLane}-two-way`, true);
    assert.notEqual(panel.text('usage-note'), '', 'both lanes on: the doubling note');
    await world.armTab(5);   // §20: the icon starts both lanes that are on
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

test('0.5.1 the tab lane defaults to the latest Live model end to end: the icon start sends it and the Live setup is the instruction route', async () => {
  const world = await makeWorld();
  const panel = await world.openPanel();
  assert.deepEqual([storedLane(world, 'tab').model, storedLane(world, 'mic').model], [INSTRUCTION_MODEL, INSTRUCTION_MODEL], 'both lanes default to the latest Live model');
  assert.equal(panel.el('tab-two-way-note').hidden, true, 'no model note: nothing is substituted');
  await world.armTab(5);   // §20: the icon starts the tab
  const tab = await world.connect({ worklet: 0, socket: 0 });
  assert.deepEqual(startOf(world, 'tab').request, { targetLanguage: 'en', model: INSTRUCTION_MODEL });
  assert.equal(setupOf(tab.socket).model, `models/${INSTRUCTION_MODEL}`);
  assert.equal(setupOf(tab.socket).generationConfig?.translationConfig, undefined, 'the instruction route has no single translation target');
  assert.match(instructionOf(tab.socket), /simultaneous INTERPRETER into/);
  const lane = world.lastState().lanes.tab;
  assert.deepEqual([lane.phase, lane.model, lane.route, lane.fallback], ['running', INSTRUCTION_MODEL, 'flash', false], 'the state tells the truth about the model');
  assertNothingLeaks(world);
  panel.close();
});

test('one-way lanes send no pair: a translation-only tab lane and the default microphone lane, and a two-way switch turned on and off again before Start', async () => {
  const world = await makeWorld({ settings: translationOnlyTab() });
  const panel = await world.openPanel();
  await panel.change('mic-enabled', true);
  await panel.change('mic-two-way', true);
  await panel.change('mic-two-way', false);
  assert.equal(panel.el('mic-partner-row').hidden, true);
  assert.equal(panel.text('mic-target-label'), panel.text('tab-target-label'), 'the label is back to the one-way wording');
  assert.equal(panel.el('mic-two-way-note').hidden, true);
  assert.deepEqual([storedLane(world, 'mic').twoWay, storedLane(world, 'tab').twoWay], [false, false]);

  await world.armTab(5);   // §20: the icon starts both lanes that are on
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
  await plain.armTab(5);   // §20: the icon starts the tab
  await plain.connect({ worklet: 0, socket: 0 });
  assert.deepEqual(startOf(plain, 'tab').request, { targetLanguage: 'ko', model: TRANSLATION_ONLY });
  assertPairsAreSane(plain);
  first.close();

  const switched = await makeWorld({ settings: oldRecord() });
  const second = await switched.openPanel();
  await second.change('tab-two-way', true);
  assert.deepEqual(storedLane(switched, 'tab'), { enabled: true, targetLanguage: 'ko', twoWay: true, partnerLanguage: 'en',
    model: TRANSLATION_ONLY, originalVolume: 40, captions: true }, 'the old fields are kept next to the new ones');
  await switched.armTab(5);   // §20: the icon starts the tab
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

// =============================================================================================
// §22 (2026-10-08, the owner's Windows report): on Chrome 153 and later the SIDE PANEL opens Chrome's share dialog itself
// (a dialog the offscreen document asks for has no owner window: on Windows it opens on the primary monitor and drops
// behind the browser, crbug 326508296) and relays the chosen tab's audio to the host over a BroadcastChannel. End to end
// over the real worker, host, panel and lib/audio-relay.js, with the relay world of tests/fixtures/fake-relay.mjs: nothing
// is captured and nothing sounds. That the dialog is VISIBLE over the browser on Windows no fake can say (docs §22).

const panelMessages = (world, type) => world.browser.deliveries
  .filter((entry) => entry.from === 'panel' && entry.to === 'sw' && entry.kind === 'message')
  .map((entry) => JSON.parse(entry.json)).filter((message) => message.type === type);
const relayChannels = (world) => world.audio.relay.channels.filter((channel) => channel.name.startsWith(RELAY_CHANNEL_PREFIX));
const relayEnds = (world) => world.audio.relay.posted.filter(({ data }) => data.t === 'end').map(({ data }) => data.reason);
const HEX32 = /^[0-9a-f]{32}$/;
// The chosen tab plays: `chunks` AudioData of 10 ms each (48 kHz stereo, every sample `value`) arrive on the captured
// audio track the panel holds. Two make the sender's first 20 ms message, which is the host's first frame.
async function playTab(world, stream, { chunks = 2, value = 0.5 } = {}) {
  const track = stream.getAudioTracks()[0];
  for (let chunk = 0; chunk < chunks; chunk += 1) {
    world.audio.relay.feed(track, { frames: 480, sampleRate: 48000, channels: 2, fill: () => value });
  }
  await world.settle();
}
// Start alone, tab 5 chosen in the panel's dialog, its audio plays, the session connects: a relayed tab lane that runs.
async function startRelayed(world, panel, { worklet = 0, socket = 0 } = {}) {
  await panel.click('btn-start');
  const stream = world.audio.panelPicker.choose({ label: world.labels.get(5) });
  await world.settle();
  await playTab(world, stream);
  const lane = await world.connect({ worklet, socket });
  return { stream, relayId: panelMessages(world, 'sw/lane-start').at(-1).relay, ...lane };
}
// Everything a relay ever opened is closed: the panel's reader, both ends of every channel, every generator.
function assertRelayClosed(world) {
  assert.equal(world.audio.relay.processors.every((record) => record.done), true, 'the panel reads nothing any more');
  assert.equal(relayChannels(world).every((channel) => channel.closed), true, 'every relay channel is closed');
  assert.equal(world.audio.relay.generators.every((generator) => generator.readyState === 'ended' && generator.writerClosed), true,
    'the host\'s relayed track is stopped and its writer closed');
}

test('§22 Chrome 154, Start on a tab the icon did not arm: the SIDE PANEL opens the share dialog, the chosen tab\'s audio is relayed to the host, and the tab is interpreted with its page captions', async () => {
  const world = await makeWorld({ panelChrome: 154,
    tabs: [{ id: 5, url: 'https://video.example/watch', title: 'Video' }, { id: 6, url: 'https://claude.ai/doc', title: 'Doc' }] });
  const { browser, audio } = world;
  const panel = await world.openPanel();
  assert.match(panel.text('tab-arm-note'), /Chrome opens a window where you choose the tab/i, 'idle: the same note as before');

  await panel.click('btn-start');
  // 1.-3. The wait shows at once; the panel's tab gets its label first; then ONE dialog, asked by the PANEL.
  assert.equal(audio.panelPicker.pending(), 1, 'the panel asked for the dialog');
  assert.equal(audio.panelPicker.calls[0], DISPLAY_MEDIA_CONSTRAINTS, 'with the one definition of lib/display-media.js');
  assert.equal(audio.picker.calls.length, 0, 'the offscreen document asked for nothing');
  assert.equal(browser.offscreenDocument, null, 'and does not even exist: nothing reaches the host before the choice');
  assert.deepEqual(panelMessages(world, 'sw/lane-start'), [], 'no start is sent before the choice');
  const labelRequests = panelMessages(world, 'sw/tab-label');
  assert.equal(labelRequests.length, 1);
  assert.equal(labelRequests[0].tabId, 5);
  assert.match(labelRequests[0].nonce, HEX32);
  assert.deepEqual([...world.labels], [[5, `${labelRequests[0].nonce}.5`]], 'only the panel\'s tab was labelled');
  assert.equal(panel.text('btn-start'), 'Cancel');
  assert.match(panel.text('status-pill'), /choose the tab/i);
  assertPickingNote(panel.text('tab-arm-note'));
  assert.match(panel.text('tab-arm-note'), /this tab starts at once/i, 'the icon is still named as the instant start');
  assert.equal(panel.el('tab-arm-note').getAttribute('data-attention'), 'true');

  // 4.-7. Tab 5 chosen: the video is dropped, the audio is relayed under a fresh id, and the worker starts the host on it.
  const stream = audio.panelPicker.choose({ label: world.labels.get(5) });
  await world.settle();
  assert.equal(stream.getVideoTracks().length, 0, 'the video track was stopped and removed');
  assert.equal(stream.getAudioTracks()[0].readyState, 'live', 'the panel holds the tab\'s audio');
  const starts = panelMessages(world, 'sw/lane-start');
  assert.equal(starts.length, 1);
  const [start] = starts;
  assert.match(start.relay, HEX32);
  assert.notEqual(start.relay, labelRequests[0].nonce, 'a fresh id, not the label\'s nonce');
  assert.deepEqual([start.lane, start.tabId, start.chosenTab, start.passthrough, start.pick], ['tab', 5, 5, true, undefined]);
  assert.equal(laneStarts(world).length, 1);
  const [hostStart] = laneStarts(world);
  assert.deepEqual(Object.keys(hostStart.tab).sort(), ['originalVolume', 'passthrough', 'relay', 'tabId']);
  assert.deepEqual([hostStart.tab.relay, hostStart.tab.tabId, hostStart.tab.passthrough], [start.relay, 5, true]);
  assert.deepEqual(browser.offscreenDocument.reasons, ['USER_MEDIA', 'DISPLAY_MEDIA'], 'the offscreen reasons are unchanged');
  assert.equal(browser.captures.size, 0, 'nothing is captured through tabCapture');
  assert.deepEqual(relayChannels(world).filter((channel) => !channel.closed).map((channel) => channel.name),
    [`${RELAY_CHANNEL_PREFIX}${start.relay}`, `${RELAY_CHANNEL_PREFIX}${start.relay}`], 'the panel sends and the host listens on the one channel');
  assert.equal(world.lastState().lanes.tab.phase, 'starting', 'the host waits for the first audio');
  assert.equal(panel.text('btn-start'), 'Stop');
  assert.doesNotMatch(panel.text('status-pill'), /choose the tab/i, 'the choice is made: the lane reads as starting');

  await playTab(world, stream);
  const tab = await world.connect({ worklet: 0, socket: 0 });
  assert.equal(panel.el('status-pill').getAttribute('data-state'), 'running');
  assert.equal(running(world.lastState(), 'tab'), true);
  assert.equal(world.lastState().lanes.tab.tabId, 5, 'the chosen tab, as the panel named it');
  assert.match(panel.text('tab-tabline'), /Video/);
  assert.equal(panel.text('tab-arm-note'), '');
  assert.equal(panel.text('tab-notice'), '');
  // The tab's audio reached the host as mono (the average of its two channels) and plays through the passthrough graph.
  const [generator] = audio.relay.generators;
  assert.ok(generator.written.length >= 1);
  assert.deepEqual([generator.written[0].numberOfChannels, generator.written[0].sampleRate], [1, 48000]);
  assert.equal(generator.samples().every((sample) => sample === 0.5), true);
  const nodes = audio.contexts.flatMap((context) => context.nodes);
  const source = nodes.find((node) => node.kind === 'mediaStreamSource' && node.mediaStream.getAudioTracks()[0] === generator);
  assert.ok(source, 'the tab graph plays the relayed track');
  const gain = [...source.connections].find((node) => node.kind === 'gain');
  assert.equal(gain.gain.value, 0.45, 'Chrome silenced the tab, so it is played back at the original volume');
  assert.equal(gain.connections.has(gain.context.destination), true);
  const keeper = nodes.find((node) => node.kind === 'constantSource');
  assert.ok(keeper?.started && keeper.connections.has(keeper.context.destination), 'the relayed graph\'s keep-alive runs');

  content(tab.socket, { outputTranscription: { text: 'hello from the relayed tab' } });
  await tick();
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  assert.ok(panel.el('tab-preview').textContent.includes('hello from the relayed tab'));
  assert.deepEqual(world.overlays.map((overlay) => overlay.tabId), [5], 'the captions are drawn on the chosen tab');
  assert.equal(world.overlays[0].frames.some((frame) => frame.type === 'captions' && frame.lane === 'tab'
    && frame.rows.some((row) => row.text.includes('hello from the relayed tab'))), true);

  // The key in the one host/lane-start; the relay id only in the two start messages; the nonce only where it labels.
  assertNothingLeaks(world);
  for (const [needle, types] of [[start.relay, ['sw/lane-start', 'host/lane-start']], [labelRequests[0].nonce, ['sw/tab-label', 'content/capture-label']]]) {
    const carrying = browser.deliveries.filter((delivery) => delivery.json.includes(needle));
    assert.ok(carrying.length >= 2);
    for (const entry of carrying) assert.ok(types.includes(JSON.parse(entry.json).type), entry.json);
    assert.equal(JSON.stringify([browser.storageData('session'), browser.storageData('local')]).includes(needle), false, 'never stored');
  }

  // Stop: the lane goes off with no notice, the panel releases the tab and ends the relay as its own stop.
  await panel.click('btn-start');
  await world.settle();
  assert.equal(world.lastState().lanes.tab.phase, 'off');
  assert.equal(world.lastState().lanes.tab.errorCode, null, 'an own Stop is never "the tab ended"');
  assert.equal(panel.text('tab-notice'), '');
  assert.equal(panel.text('btn-start'), 'Start');
  assert.equal(stream.getTracks().every((track) => track.readyState === 'ended'), true, 'the panel released the tab');
  assert.deepEqual(relayEnds(world), ['stop']);
  assertRelayClosed(world);
  panel.close();
});

test('§22 another tab chosen in the panel\'s dialog is interpreted too, with captions in the panel only; while its first audio is awaited the panel does not fall back to "choose the tab"; a tab Chrome did not silence is not played a second time', async () => {
  const world = await makeWorld({ panelChrome: 154,
    tabs: [{ id: 5, url: 'https://claude.ai/doc', title: 'Doc' }, { id: 6, url: 'https://video.example/watch', title: 'Video' }] });
  const panel = await world.openPanel();
  await panel.click('btn-start');
  assert.equal(world.labels.has(6), false);
  // An unlabelled page (its track reports no capture handle), shared without Chrome silencing it.
  const stream = world.audio.panelPicker.choose({ label: null, suppressed: false });
  await world.settle();
  const [start] = panelMessages(world, 'sw/lane-start');
  assert.deepEqual([start.tabId, start.chosenTab, start.passthrough], [5, null, false], 'the panel\'s tab, no chosen tab it could name, no passthrough');
  assert.deepEqual([laneStarts(world)[0].tab.tabId, laneStarts(world)[0].tab.passthrough], [null, false]);
  assert.equal(world.lastState().lanes.tab.phase, 'starting');
  assert.equal(world.lastState().lanes.tab.tabId, null);
  assert.doesNotMatch(panel.text('status-pill'), /choose the tab/i);
  assert.equal(panel.text('btn-start'), 'Stop');
  await playTab(world, stream);
  const tab = await world.connect({ worklet: 0, socket: 0 });
  assert.equal(running(world.lastState(), 'tab'), true);
  assert.equal(world.lastState().lanes.tab.tabId, null);
  const gains = world.audio.contexts.flatMap((context) => context.nodes).filter((node) => node.kind === 'gain');
  assert.equal(gains.at(-1).gain.value, 0, 'the tab is still heard by itself: the graph plays nothing of it');
  content(tab.socket, { outputTranscription: { text: 'from the other tab' } });
  await tick();
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  assert.ok(panel.el('tab-preview').textContent.includes('from the other tab'));
  assert.deepEqual(world.overlays, [], 'no page is drawn on, above all not the labelled tab the panel is on');
  assert.match(panel.text('tab-notice'), /Captions cannot be shown on this page/i);
  panel.close();
});

test('§22 Cancel while the PANEL\'s dialog is open: idle at once and nothing reaches the host; the dialog cannot be closed by code, so what it delivers later is released at once', async () => {
  const world = await makeWorld({ panelChrome: 154 });
  const { browser, audio } = world;
  const panel = await world.openPanel();
  await panel.click('btn-start');
  assert.equal(audio.panelPicker.pending(), 1);
  await panel.click('btn-start');   // Cancel
  assert.equal(panel.text('btn-start'), 'Start');
  assert.equal(panel.el('status-pill').getAttribute('data-state'), 'idle');
  assert.equal(panel.text('tab-notice'), '');
  assert.equal(panel.text('stop-note'), '');
  assert.equal(audio.panelPicker.pending(), 1, 'Chrome\'s dialog stays until it is answered');
  assert.deepEqual(panelMessages(world, 'sw/lane-start'), []);
  assert.deepEqual(laneStarts(world), [], 'no host start');
  assert.equal(browser.offscreenDocument, null, 'no document was ever made for it');

  const late = audio.panelPicker.choose({ label: world.labels.get(5) });   // the person answers it after all
  await world.settle();
  assert.equal(late.getTracks().length, 2);
  assert.equal(late.getTracks().every((track) => track.readyState === 'ended'), true, 'released at once: nothing keeps capturing');
  assert.equal(audio.relay.processors.length, 0, 'no relay was started');
  assert.deepEqual(relayChannels(world), []);
  assert.deepEqual(panelMessages(world, 'sw/lane-start'), []);
  assert.equal(browser.offscreenDocument, null);
  await world.clock.advance(20_000);
  await world.settle();
  assert.equal(panel.text('btn-start'), 'Start');
  assert.equal(panel.text('tab-notice'), '');

  // The next Start opens a NEW dialog (the old one was answered) and runs.
  await startRelayed(world, panel);
  assert.equal(audio.panelPicker.calls.length, 2);
  assert.equal(running(world.lastState(), 'tab'), true);
  assert.equal(world.lastState().lanes.tab.tabId, 5);
  panel.close();
});

test('§22 Cancel, then Start again while the first dialog is still open: the new start takes that dialog over (never a second one), and the tab chosen in it is named by either label', async () => {
  const world = await makeWorld({ panelChrome: 154 });
  const { audio } = world;
  const panel = await world.openPanel();
  await panel.click('btn-start');
  const firstLabel = world.labels.get(5);
  await panel.click('btn-start');   // Cancel
  await panel.click('btn-start');   // Start again
  assert.equal(audio.panelPicker.calls.length, 1, 'no second dialog is stacked on the first');
  assert.equal(audio.panelPicker.pending(), 1);
  assert.equal(panelMessages(world, 'sw/tab-label').length, 2, 'the page was labelled for each start');
  assert.notEqual(world.labels.get(5), firstLabel);
  assert.equal(panel.text('btn-start'), 'Cancel');
  // Chrome may still show the page under the first start's label: it names the tab all the same.
  const stream = audio.panelPicker.choose({ label: firstLabel });
  await world.settle();
  assert.equal(stream.getAudioTracks()[0].readyState, 'live', 'the stream went to the start that took the dialog over');
  const starts = panelMessages(world, 'sw/lane-start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].chosenTab, 5);
  await playTab(world, stream);
  await world.connect({ worklet: 0, socket: 0 });
  assert.equal(running(world.lastState(), 'tab'), true);
  assert.equal(world.lastState().lanes.tab.tabId, 5);
  assert.deepEqual(world.overlays.map((overlay) => overlay.tabId), [5]);
  panel.close();
});

test('§22 the icon while the PANEL\'s dialog is open: the tab starts at once through the icon\'s grant (no dialog of the offscreen document holds it), and the stream the dialog delivers later is released', async () => {
  const world = await makeWorld({ panelChrome: 154 });
  const { browser, audio } = world;
  const panel = await world.openPanel();
  await panel.click('btn-start');
  assert.equal(audio.panelPicker.pending(), 1);
  await world.armTab(5);
  assert.equal(audio.blockedTabCaptures(), 0, 'the instant start was not held');
  await world.connect({ worklet: 0, socket: 0 });
  const state = world.lastState();
  assert.equal(running(state, 'tab'), true);
  assert.equal(state.lanes.tab.tabId, 5);
  assert.equal(browser.captures.has(5), true, 'through tabCapture, not the dialog');
  assert.deepEqual(panelMessages(world, 'sw/lane-start').map((message) => [message.tabId, message.pick, message.relay]),
    [[5, undefined, undefined]], 'one start, by the icon\'s stream id');
  assert.equal(laneStarts(world).length, 1);
  assert.equal(typeof laneStarts(world)[0].tab.streamId, 'string');
  assert.equal(audio.picker.calls.length, 0, 'no dialog in the offscreen document');
  assert.equal(world.hosts.length, 1, 'no document had to be closed: the panel\'s dialog is not in it');
  assert.equal(audio.panelPicker.pending(), 1, 'the panel\'s dialog is still open: it cannot be closed by code');
  assert.equal(panel.text('btn-start'), 'Stop');
  assert.equal(panel.text('tab-notice'), '');
  assert.equal(panel.text('tab-arm-note'), '', 'no "choose the tab" note is left');
  for (const code of ['ALREADY_RUNNING', 'LANE_STOPPING', 'NEEDS_ARM']) assert.deepEqual(answersWith(world, code), [], code);

  const late = audio.panelPicker.choose({ label: world.labels.get(5) });   // answered after all
  await world.settle();
  assert.equal(late.getTracks().every((track) => track.readyState === 'ended'), true, 'released at once');
  assert.equal(audio.relay.processors.length, 0, 'no relay was started');
  assert.deepEqual(relayChannels(world), []);
  assert.equal(laneStarts(world).length, 1);
  assert.equal(world.sockets.sockets.length, 1);
  assert.equal(running(world.lastState(), 'tab'), true);
  assert.equal(world.lastState().lanes.tab.tabId, 5);
  panel.close();
});

// Two orders of the panel going away. The panel's own pagehide first (what panel.js codes: dispose ends the relay as an
// own stop) ends the lane in off. Chrome for Testing 149 was seen to do it the other way round (2026-10-08 smoke, headless,
// chrome.sidePanel.close while a relayed lane connected): "hidden" about 280 ms after the close, then the document went
// away and the relay's end arrived as `ended`, never `pagehide`; the fake models that by stopping the panel's capture
// first (its reader finishes), then disposing. The lane then ends as TAB_ENDED. Either way nothing keeps capturing and the
// document closes after the grace with `panel-gone`, which is what a panel opened after it says.
for (const [order, expected] of [['the panel\'s own pagehide first', { phase: 'off', code: null, ends: ['pagehide'] }],
  ['Chrome ends the capture first (seen in Chrome for Testing 149)', { phase: 'error', code: 'TAB_ENDED', ends: ['ended'] }]]) {
  test(`§22 closing the panel while a relayed tab runs, ${order}: the lane ends at once (${expected.code ?? 'off, no notice'}), nothing keeps capturing, and the document closes after the grace`, async () => {
    const world = await makeWorld({ panelChrome: 154 });
    const { browser } = world;
    const panel = await world.openPanel();
    const run = await startRelayed(world, panel);
    assert.equal(running(world.lastState(), 'tab'), true);

    if (expected.code !== null) {
      run.stream.getAudioTracks()[0].stop();   // the closing document's capture stops (no event); the panel's reader finishes
      await world.settle();
    }
    panel.close();   // pagehide
    await world.settle();
    const host = world.hosts.at(-1);
    assert.equal(host.uiState().lanes.tab.phase, expected.phase, 'the relay\'s end stopped the lane at once');
    assert.equal(host.uiState().lanes.tab.errorCode, expected.code);
    assert.deepEqual(relayEnds(world), expected.ends);
    assert.equal(run.stream.getTracks().every((track) => track.readyState === 'ended'), true, 'the panel stopped the captured tab');
    assertRelayClosed(world);
    assert.ok(world.sockets.sockets.every((socket) => socket.readyState !== 1), 'the Live session was closed');
    assert.ok(browser.offscreenDocument, 'the document waits out the grace');

    await world.clock.advance(LIMITS.panelGraceMs + 100);
    await world.settle();
    await world.clock.advance(LIMITS.statusLingerMs);
    await world.settle();
    assert.equal(browser.offscreenDocument, null, 'then the worker closed it');
    assert.equal(world.session()[STORAGE_KEYS.lastStop].reason, 'panel-gone');
    assert.equal(world.session()[STORAGE_KEYS.host].up, false);
    const second = await world.openPanel();
    assert.match(second.text('stop-note'), /panel was closed/i, 'a reopened panel explains why it stopped');
    assert.equal(second.text('tab-notice'), '');
    second.close();
  });
}

test('§22 the captured tab closes (or Chrome\'s "Stop sharing"): the panel\'s track ends, the relay says so, and the host ends the tab lane with TAB_ENDED while the microphone keeps running', async () => {
  const world = await makeWorld({ panelChrome: 154 });
  const { audio } = world;
  const panel = await world.openPanel();
  await panel.change('mic-enabled', true);
  await panel.click('btn-start');
  const mic = await world.connect({ worklet: 0, socket: 0 });
  const stream = audio.panelPicker.choose({ label: world.labels.get(5) });
  await world.settle();
  await playTab(world, stream);
  await world.connect({ worklet: 1, socket: 1 });
  assert.equal(running(world.lastState(), 'tab') && running(world.lastState(), 'mic'), true);

  stream.getAudioTracks()[0].end();   // Chrome ended the capture
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  const state = world.lastState();
  assert.equal(state.lanes.tab.phase, 'error');
  assert.equal(state.lanes.tab.errorCode, 'TAB_ENDED');
  assert.equal(state.lanes.mic.phase, 'running', 'the other lane is unaffected');
  assert.equal(mic.socket.closeCalls, 0);
  assert.match(panel.text('tab-notice'), /no longer be taken from this tab/i);
  assert.equal(panel.el('status-pill').getAttribute('data-state'), 'warning');
  assert.deepEqual(relayEnds(world), ['ended']);
  assertRelayClosed(world);
  panel.close();
});

test('§22 both lanes on: the microphone interprets while the PANEL\'s dialog is still open, and the relayed tab joins it after the choice', async () => {
  const world = await makeWorld({ panelChrome: 154 });
  const { audio } = world;
  const panel = await world.openPanel();
  await panel.change('mic-enabled', true);
  await panel.click('btn-start');
  assert.equal(audio.panelPicker.pending(), 1);
  assert.equal(panelMessages(world, 'sw/lane-start').filter((message) => message.lane === 'mic').length, 1, 'the microphone start was sent');
  const mic = await world.connect({ worklet: 0, socket: 0 });
  assert.equal(running(world.lastState(), 'mic'), true, 'the microphone did not wait for the dialog');
  assert.equal(audio.panelPicker.pending(), 1, 'the dialog is still open');
  assert.equal(world.lastState().lanes.tab.phase, 'off', 'nothing of the tab reached the host yet');
  assert.equal(panel.text('btn-start'), 'Stop');
  assertPickingNote(panel.text('tab-arm-note'));

  const stream = audio.panelPicker.choose({ label: world.labels.get(5) });
  await world.settle();
  await playTab(world, stream);
  await world.connect({ worklet: 1, socket: 1 });
  assert.equal(running(world.lastState(), 'tab') && running(world.lastState(), 'mic'), true);
  assert.equal(world.lastState().lanes.tab.tabId, 5);
  assert.equal(mic.socket.closeCalls, 0);
  assertNothingLeaks(world);

  await panel.click('btn-start');   // Stop: both lanes, the relay as an own stop
  await world.settle();
  assert.equal(world.lastState().lanes.tab.errorCode, null);
  assert.equal(world.lastState().lanes.mic.phase, 'off');
  assert.deepEqual(relayEnds(world), ['stop']);
  assertRelayClosed(world);
  panel.close();
});

test('§22 a STALE armed record on Chrome 154: Start is answered NEEDS_ARM once, and the retry opens the PANEL\'s dialog and runs relayed, with no notice', async () => {
  const world = await makeWorld({ panelChrome: 154 });
  const { audio } = world;
  const panel = await world.openPanel();
  await panel.change('tab-enabled', false);
  await world.armTab(5);   // armed, nothing started
  await panel.change('tab-enabled', true);
  world.browser.grants.delete(5);   // Chrome let go of the grant; the record in storage.session outlives it
  await panel.click('btn-start');
  assert.equal(answersWith(world, 'NEEDS_ARM').length, 1);
  assert.deepEqual(panelMessages(world, 'sw/lane-start').map((message) => [message.pick, message.relay]), [[undefined, undefined]],
    'the armed start only: the retry is the panel\'s dialog');
  assert.equal(audio.panelPicker.pending(), 1);
  assert.equal(audio.picker.calls.length, 0);
  assert.equal(laneStarts(world).length, 0, 'the refused mint sent nothing to the host');
  assert.equal(panel.text('btn-start'), 'Cancel');
  assertPickingNote(panel.text('tab-arm-note'));
  assert.equal(panel.text('tab-notice'), '');

  const stream = audio.panelPicker.choose({ label: world.labels.get(5) });
  await world.settle();
  await playTab(world, stream);
  await world.connect({ worklet: 0, socket: 0 });
  assert.equal(running(world.lastState(), 'tab'), true);
  assert.equal(world.lastState().lanes.tab.tabId, 5);
  assert.match(panelMessages(world, 'sw/lane-start').at(-1).relay, HEX32);
  assert.equal(answersWith(world, 'NEEDS_ARM').length, 1, 'refused exactly once');
  assert.equal(panel.text('tab-notice'), '');
  assert.equal(world.hostFrames('state').some((frame) => frame.state.lanes.tab.phase === 'error'), false);
  panel.close();
});

// The gate (lib/display-media.js) is closed on anything older than Chrome 153, on a realm without the relay's APIs, and on
// an unknown version: the panel then never asks for a dialog itself, and the §19 path runs exactly as before, including
// Cancel closing the offscreen document with the dialog in it (sw-core.js, closeLeftOverDialog).
for (const [what, panelChrome] of [['Chrome 152', 152], ['Chrome 154 without MediaStreamTrackProcessor', { chromeMajor: 154, processor: false }],
  ['no Chrome version at all', null]]) {
  test(`§22 gate closed (${what}): Start still asks the OFFSCREEN document for the dialog, unchanged; the panel opens nothing and labels nothing itself`, async () => {
    const world = await makeWorld({ panelChrome });
    const { browser, audio } = world;
    const panel = await world.openPanel();
    await panel.click('btn-start');
    assert.equal(audio.picker.pending(), 1, 'the offscreen document asked for the dialog');
    assert.equal(audio.panelPicker.calls.length, 0, 'the panel did not');
    assert.deepEqual(panelMessages(world, 'sw/tab-label'), []);
    assert.deepEqual(panelLaneStarts(world).map((message) => [message.pick, message.relay]), [[true, undefined]]);
    assert.deepEqual(Object.keys(laneStarts(world)[0].tab).sort(), ['originalVolume', 'pick']);
    assert.equal(panel.text('btn-start'), 'Cancel');
    assertPickingNote(panel.text('tab-arm-note'));
    await panel.click('btn-start');   // Cancel: the document goes, and its dialog with it
    assert.equal(browser.offscreenDocument, null);
    assert.equal(audio.picker.gone(), 1);

    await panel.click('btn-start');
    const [, second] = laneStarts(world);
    assert.deepEqual([...world.labels], [[5, `${second.tab.pick}.5`]], 'the worker labelled the tab, as before');
    audio.picker.choose({ label: world.labels.get(5) });
    await world.connect({ worklet: 0, socket: 0 });
    assert.equal(running(world.lastState(), 'tab'), true);
    assert.equal(world.lastState().lanes.tab.tabId, 5);
    assert.equal(audio.panelPicker.calls.length, 0);
    assert.deepEqual(world.audio.relay.channels, [], 'no relay at all');
    assert.deepEqual(world.audio.relay.processors, []);
    await panel.click('btn-start');   // Stop releases the share
    await world.settle();
    assert.equal(audio.picker.streams[0].getTracks().every((track) => track.readyState === 'ended'), true);
    panel.close();
  });
}

test('§22 Stop while the relayed start still waits for its first audio: idle at once with no notice, the relay ends as an own stop, and the offscreen document stays (a relay start leaves no dialog in it to close)', async () => {
  const world = await makeWorld({ panelChrome: 154 });
  const { browser, audio } = world;
  const panel = await world.openPanel();
  await panel.click('btn-start');
  const stream = audio.panelPicker.choose({ label: world.labels.get(5) });
  await world.settle();
  assert.equal(world.lastState().lanes.tab.phase, 'starting');
  await panel.click('btn-start');   // Stop
  await world.settle();
  assert.equal(world.lastState().lanes.tab.phase, 'off');
  assert.equal(world.lastState().lanes.tab.errorCode, null);
  assert.equal(panel.text('btn-start'), 'Start');
  assert.equal(panel.text('tab-notice'), '');
  assert.equal(panel.text('stop-note'), '');
  assert.equal(stream.getTracks().every((track) => track.readyState === 'ended'), true);
  assert.deepEqual(relayEnds(world), ['stop']);
  assertRelayClosed(world);
  assert.notEqual(browser.offscreenDocument, null, 'not closed: closeLeftOverDialog is for a dialog in the document, and there is none');
  assert.equal(world.hosts.length, 1);
  assert.equal(world.session()[STORAGE_KEYS.host].up, true);
  await world.clock.advance(LIMITS.relayFirstFrameMs + 100);   // the first-frame timer finds nothing left to fail
  await world.settle();
  assert.equal(world.lastState().lanes.tab.errorCode, null);
  assert.equal(panel.text('tab-notice'), '');
  assert.equal(world.sockets.sockets.length, 0, 'no session was opened');

  await startRelayed(world, panel);   // and the next Start runs in the same document
  assert.equal(running(world.lastState(), 'tab'), true);
  assert.equal(world.hosts.length, 1);
  for (const code of ['ALREADY_RUNNING', 'LANE_STOPPING']) assert.deepEqual(answersWith(world, code), [], code);
  panel.close();
});

// What the person sees if the relay carries nothing (say, a Chrome that does not let the side panel and the offscreen
// document share a BroadcastChannel): the host gives up after LIMITS.relayFirstFrameMs, and the tab is released.
test('§22 a relay that delivers no audio: after LIMITS.relayFirstFrameMs the tab lane fails with TAB_CAPTURE_FAILED, the notice names the icon, and the panel releases the tab', async () => {
  const world = await makeWorld({ panelChrome: 154 });
  const { audio } = world;
  const panel = await world.openPanel();
  await panel.click('btn-start');
  const stream = audio.panelPicker.choose({ label: world.labels.get(5) });
  await world.settle();
  await world.clock.advance(LIMITS.relayFirstFrameMs - 100);
  await world.settle();
  assert.equal(world.lastState().lanes.tab.phase, 'starting', 'still waiting');
  await world.clock.advance(200);
  await world.clock.advance(LIMITS.frameIntervalMs);
  await world.settle();
  assert.equal(world.lastState().lanes.tab.phase, 'error');
  assert.equal(world.lastState().lanes.tab.errorCode, 'TAB_CAPTURE_FAILED');
  assert.match(panel.text('tab-notice'), /Could not capture this tab's audio/);
  assert.match(panel.text('tab-notice'), /press the Live Interpreter icon on the tab you want to interpret/i);
  assert.equal(panel.text('btn-start'), 'Start');
  assert.equal(stream.getTracks().every((track) => track.readyState === 'ended'), true, 'the panel released the tab');
  assertRelayClosed(world);
  assert.equal(world.sockets.sockets.length, 0);
  panel.close();
});

test('§22 a relay start the worker refuses (the key was removed in Options while the dialog was open): the notice says why, nothing reaches the host, and the panel releases the tab and ends its relay', async () => {
  const world = await makeWorld({ panelChrome: 154 });
  const { browser, audio } = world;
  const panel = await world.openPanel();
  await panel.click('btn-start');
  assert.equal(audio.panelPicker.pending(), 1);
  const options = browser.createContext('options');
  await options.chrome.storage.local.remove(STORAGE_KEYS.key);
  options.close();
  await world.settle();
  const stream = audio.panelPicker.choose({ label: world.labels.get(5) });
  await world.settle();
  assert.equal(panelMessages(world, 'sw/lane-start').length, 1, 'the relay start was sent');
  assert.equal(answersWith(world, 'CREDENTIAL_REQUIRED').length, 1);
  assert.deepEqual(laneStarts(world), [], 'nothing reached the host');
  assert.equal(browser.offscreenDocument, null);
  assert.match(panel.text('tab-notice'), /Cannot start without an API key/);
  assert.equal(panel.text('btn-start'), 'Start');
  assert.deepEqual(relayEnds(world), ['failed'], 'ended by the panel as its own stop');
  assert.equal(stream.getTracks().every((track) => track.readyState === 'ended'), true, 'the tab was released');
  assertRelayClosed(world);
  panel.close();
});
