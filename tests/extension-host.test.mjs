import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createServiceWorker } from '../extension/background/sw-core.js';
import { createHostEnv, createLaneHost, createRealmClock } from '../extension/engine/lane-host.js';
import { createOverlayHub } from '../extension/engine/overlay-hub.js';
import { createPanelHub } from '../extension/engine/panel-hub.js';
import { createChromeAdapter } from '../extension/lib/chrome-adapter.js';
import { LIMITS, PORT_NAMES, STORAGE_KEYS, makeFrame, makeMessage, validateFrame } from '../extension/lib/protocol.js';
import { createFakeAudioEnv } from './fixtures/fake-audio.mjs';
import { createHostRig, fakeKey, STYLE, tick } from './fixtures/extension-lanes.mjs';
import { createFakeBrowser, createFakeClock } from './fixtures/fake-chrome.mjs';
import { createSocketFixture } from './fixtures/live.mjs';
import { audioContent, content } from './fixtures/sim.mjs';

// docs/extension.md §11.1 (group B): the lane host with its panel and overlay hubs (5.2, 5.6.3, 5.8, 4.4, 4.5).
// The hubs are tested alone over plain fake ports; the host over the shared fake browser (message bus, ports,
// virtual clock), fake audio and fake Live sockets. Nothing here can make a sound or open a device.

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const RUNTIME = Object.freeze({ id: EXT_ID, getURL: (path = '') => `chrome-extension://${EXT_ID}/${path}` });
const SIX = ['connect', 'getURL', 'id', 'onConnect', 'onMessage', 'sendMessage'];

/** A receiving-end port as the host sees it, with hooks to play the other side. */
function fakePort({ name = PORT_NAMES.overlay, tabId = 5, frameId = 0, kind = 'content', hasTab = true } = {}) {
  const messageListeners = [], disconnectListeners = [];
  const sender = kind === 'content'
    ? { id: EXT_ID, url: 'https://page.test/', origin: 'https://page.test', ...(hasTab ? { tab: { id: tabId }, frameId } : {}) }
    : { id: EXT_ID, url: RUNTIME.getURL(`extension/${kind}/${kind}.html`), origin: `chrome-extension://${EXT_ID}` };
  const port = { name, sender, posted: [], disconnects: 0, failPost: false,
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    postMessage(frame) { if (port.failPost) throw new Error('gone'); port.posted.push(frame); },
    disconnect() { port.disconnects += 1; },
    say(frame) { for (const fn of messageListeners) fn(frame, port); },
    drop() { for (const fn of disconnectListeners) fn(port); } };
  return port;
}
const hello = { v: 1, type: 'hello' };

// ---------------------------------------------------------------------------------------------
// Overlay hub, alone.

test('overlay hub accept rules: name, role content, top frame, integer tab id and the host policy; other names are left alone', () => {
  const asked = [];
  const hub = createOverlayHub({ runtime: RUNTIME, canAccept: (tabId) => { asked.push(tabId); return tabId !== 9; } });
  const good = fakePort();
  assert.equal(hub.accept(good), true);
  assert.equal(good.disconnects, 0);
  assert.equal(hub.has(5), true);

  for (const [label, port] of [['wrong role', fakePort({ kind: 'panel' })], ['not the top frame', fakePort({ tabId: 6, frameId: 3 })],
    ['no tab', fakePort({ hasTab: false })], ['refused by the host policy', fakePort({ tabId: 9 })],
    ['a negative tab id', fakePort({ tabId: -1 })]]) {
    assert.equal(hub.accept(port), false, label);
    assert.equal(port.disconnects, 1, `${label}: disconnected at once`);
  }
  const foreign = fakePort({ name: 'someone-else/1' });
  assert.equal(hub.accept(foreign), false);
  assert.equal(foreign.disconnects, 0, 'another page may own that port: it is ignored, not disconnected');
  assert.deepEqual(hub.tabIds(), [5]);
  assert.ok(asked.includes(9));
});

// The ROLE rule of 4.4 on its own. An options or permission page (extension origin) opens in a TAB, so it has sender.tab and
// frameId 0 and passes the name, top-frame and tab-id checks: only the role check keeps it out. The 'wrong role' case above
// (a panel sender WITHOUT a tab) is refused by the tab-id check first, and the wrong-role panel ports below arrive after the
// cap is full, so neither of them proves the role rule.
const OTHER_EXT_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const extensionPageSender = (path, { id = EXT_ID, tabId = 9, frameId = 0 } = {}) =>
  ({ id, url: `chrome-extension://${id}/${path}`, origin: `chrome-extension://${id}`, tab: { id: tabId }, frameId });

test('overlay hub role rule: a port from an extension page that HAS a tab and a top frame (options, permission, panel in a tab) is refused although the host would route to that tab', () => {
  const asked = [];
  const hub = createOverlayHub({ runtime: RUNTIME, canAccept: (tabId) => { asked.push(tabId); return true; } });
  for (const [label, sender] of [
    ['options page', extensionPageSender('extension/options/options.html')],
    ['permission page', extensionPageSender('extension/permission/permission.html')],
    ['panel page opened in a tab', extensionPageSender('extension/panel/panel.html')],
    ['a content-script-shaped sender of ANOTHER extension', { id: OTHER_EXT_ID, url: 'https://page.test/', origin: 'https://page.test',
      tab: { id: 9 }, frameId: 0 }],
  ]) {
    const port = fakePort();
    port.sender = sender;
    assert.equal(hub.accept(port), false, label);
    assert.equal(port.disconnects, 1, `${label}: disconnected at once`);
  }
  assert.equal(hub.count(), 0, 'nothing was registered');
  // Control: the same hub, the same tab and the same policy take a real content script. It was the role that refused the pages.
  const content = fakePort({ tabId: 9 });
  assert.equal(hub.accept(content), true);
  assert.equal(content.disconnects, 0);
  assert.deepEqual(hub.tabIds(), [9]);
  assert.ok(asked.includes(9), 'the host policy would have said yes for tab 9');
});

test('overlay hub: ONE port per tab - a second port REPLACES the first, and the old port\'s late events change nothing', () => {
  const events = [];
  const hub = createOverlayHub({ runtime: RUNTIME, onHello: (tabId) => events.push(['hello', tabId]),
    onClose: (tabId) => events.push(['close', tabId]) });
  const first = fakePort();
  const second = fakePort();
  hub.accept(first);
  hub.accept(second);
  assert.equal(first.disconnects, 1, 'the old port is disconnected by the hub, before the new one is registered');
  assert.equal(second.disconnects, 0);
  assert.equal(hub.count(), 1);
  first.drop();            // a late disconnect of the replaced port
  first.say(hello);        // and a late frame
  assert.deepEqual(events, [], 'neither reported a close nor a hello');
  assert.equal(hub.has(5), true, 'the new port was neither deleted nor disposed');
  second.say(hello);
  assert.deepEqual(events, [['hello', 5]]);
  assert.equal(hub.send(5, makeFrame('clear', { lane: 'tab' })), true);
  assert.equal(second.posted.length, 1);
});

test('overlay hub: invalid frames from the overlay are dropped; only a valid hello counts', () => {
  const hellos = [];
  const hub = createOverlayHub({ runtime: RUNTIME, onHello: (tabId) => hellos.push(tabId) });
  const port = fakePort();
  hub.accept(port);
  for (const junk of [null, 'hello', { type: 'hello' }, { v: 2, type: 'hello' }, { v: 1, type: 'captions' }, { v: 1, type: 'bye' },
    { v: 1, type: 'hello', extra: 'x'.repeat(9000) }]) port.say(junk);
  assert.deepEqual(hellos, []);
  port.say({ v: 1, type: 'hello', ignored: true });
  assert.deepEqual(hellos, [5]);
});

test('overlay hub: beyond maxOverlayPorts the least recently used tab is told bye, closed and reported', async () => {
  const clock = createFakeClock();
  const closed = [];
  const hub = createOverlayHub({ runtime: RUNTIME, timers: clock, maxPorts: 2, onClose: (tabId) => closed.push(tabId) });
  const ports = [1, 2, 3].map((tabId) => fakePort({ tabId }));
  hub.accept(ports[0]);
  hub.accept(ports[1]);
  hub.send(1, makeFrame('clear', { lane: 'tab' }));   // tab 1 is used more recently than tab 2
  hub.accept(ports[2]);
  assert.deepEqual(hub.tabIds().sort(), [1, 3]);
  assert.deepEqual(closed, [2]);
  assert.equal(ports[1].posted.at(-1).type, 'bye');
  await clock.advance(1000);
  assert.equal(ports[1].disconnects, 1);
  assert.equal(LIMITS.maxOverlayPorts, 4);
});

test('overlay hub send: captions and style are deduped per port, events (clear, status) never are, force and forget override', () => {
  const hub = createOverlayHub({ runtime: RUNTIME });
  const port = fakePort();
  hub.accept(port);
  const captions = { v: 1, type: 'captions', epoch: 1, seq: 1, lane: 'tab', lang: 'ko', rows: [], gaps: { input: false, audio: false, reception: false }, live: true };
  hub.send(5, captions);
  hub.send(5, { ...captions, seq: 2 });
  assert.equal(port.posted.length, 1, 'same rows: one frame (seq is not part of the comparison)');
  hub.send(5, { ...captions, seq: 3 }, { force: true });
  assert.equal(port.posted.length, 2);
  hub.send(5, { ...captions, seq: 4, live: false });
  assert.equal(port.posted.length, 3);
  const clear = makeFrame('clear', { lane: 'tab' });
  hub.send(5, clear); hub.send(5, clear);
  assert.equal(port.posted.filter((frame) => frame.type === 'clear').length, 2, 'a second clear after new captions is real');
  hub.forget(5, 'tab');
  hub.send(5, { ...captions, seq: 5, live: false });
  assert.equal(port.posted.length, 6, 'after a clear the next captions frame is never deduped');
  assert.equal(hub.send(99, clear), false, 'no port for that tab');
});

test('overlay hub: a postMessage that throws removes the port and reports it', () => {
  const closed = [];
  const hub = createOverlayHub({ runtime: RUNTIME, onClose: (tabId) => closed.push(tabId) });
  const port = fakePort();
  hub.accept(port);
  port.failPost = true;
  assert.equal(hub.send(5, makeFrame('clear', { lane: 'tab' })), false);
  assert.equal(hub.has(5), false);
  assert.deepEqual(closed, [5]);
});

test('overlay hub close(): bye now, the port is forgotten at once and disconnected after the delay; dispose disconnects immediately', async () => {
  const clock = createFakeClock();
  const closed = [];
  const hub = createOverlayHub({ runtime: RUNTIME, timers: clock, closeDelayMs: 250, onClose: (tabId) => closed.push(tabId) });
  const port = fakePort();
  hub.accept(port);
  assert.equal(hub.close(5), true);
  assert.equal(hub.has(5), false);
  assert.deepEqual(port.posted.map((frame) => frame.type), ['bye']);
  assert.equal(port.disconnects, 0, 'not in the same turn as the bye');
  port.drop();
  assert.deepEqual(closed, [], 'the host\'s own close is not reported as a port that went away');
  await clock.advance(249);
  assert.equal(port.disconnects, 0);
  await clock.advance(1);
  assert.equal(port.disconnects, 1);
  assert.equal(hub.close(5), false);

  const a = fakePort({ tabId: 7 }), b = fakePort({ tabId: 8 });
  hub.accept(a); hub.accept(b);
  hub.close(7);
  hub.dispose();
  await tick();
  assert.deepEqual([a.disconnects, b.disconnects], [1, 1]);
  assert.deepEqual([a.posted.at(-1).type, b.posted.at(-1).type], ['bye', 'bye']);
  assert.equal(hub.accept(fakePort({ tabId: 9 })), false, 'a disposed hub accepts nothing');
});

// ---------------------------------------------------------------------------------------------
// Panel hub, alone.

test('panel hub accept rules: name, role panel, cap; hello reaches the host; other names are left alone', () => {
  const clock = createFakeClock();
  const hellos = [];
  const hub = createPanelHub({ runtime: RUNTIME, timers: clock, onHello: (port) => hellos.push(port) });
  const ports = Array.from({ length: LIMITS.maxPanelPorts }, () => fakePort({ name: PORT_NAMES.panel, kind: 'panel' }));
  for (const port of ports) assert.equal(hub.accept(port), true);
  assert.equal(hub.count(), 4);
  const fifth = fakePort({ name: PORT_NAMES.panel, kind: 'panel' });
  assert.equal(hub.accept(fifth), false);
  assert.equal(fifth.disconnects, 1, 'the cap is maxPanelPorts');
  for (const kind of ['options', 'permission']) {
    const port = fakePort({ name: PORT_NAMES.panel, kind });
    assert.equal(hub.accept(port), false, kind);
    assert.equal(port.disconnects, 1);
  }
  const overlayShaped = fakePort({ name: PORT_NAMES.panel, kind: 'content' });
  assert.equal(hub.accept(overlayShaped), false);
  const foreign = fakePort({ name: 'someone-else/1', kind: 'panel' });
  assert.equal(hub.accept(foreign), false);
  assert.equal(foreign.disconnects, 0);

  ports[0].say({ v: 1, type: 'bye' });
  ports[0].say({ v: 1, type: 'state' });
  ports[0].say('hello');
  assert.deepEqual(hellos, []);
  ports[0].say(hello);
  assert.deepEqual(hellos, [ports[0]]);
});

test('panel hub role rule: on a fresh hub with room to spare only a panel page is accepted; every other role is refused by the role check, not by the cap', () => {
  const clock = createFakeClock();
  const hub = createPanelHub({ runtime: RUNTIME, timers: clock });
  const ports = [
    ['options page', fakePort({ name: PORT_NAMES.panel, kind: 'options' })],
    ['permission page', fakePort({ name: PORT_NAMES.panel, kind: 'permission' })],
    ['content script', fakePort({ name: PORT_NAMES.panel, kind: 'content' })],
    ['options page in a tab', Object.assign(fakePort({ name: PORT_NAMES.panel }), { sender: extensionPageSender('extension/options/options.html') })],
    ['offscreen page', Object.assign(fakePort({ name: PORT_NAMES.panel }), { sender: extensionPageSender('extension/engine/host.html') })],
    ['service worker', Object.assign(fakePort({ name: PORT_NAMES.panel }), { sender: { id: EXT_ID, origin: `chrome-extension://${EXT_ID}` } })],
    ['a panel page of ANOTHER extension', Object.assign(fakePort({ name: PORT_NAMES.panel }), {
      sender: { id: OTHER_EXT_ID, url: `chrome-extension://${OTHER_EXT_ID}/extension/panel/panel.html`, origin: `chrome-extension://${OTHER_EXT_ID}` } })],
  ];
  for (const [label, port] of ports) {
    assert.equal(hub.accept(port), false, label);
    assert.equal(port.disconnects, 1, `${label}: disconnected at once`);
  }
  assert.equal(hub.count(), 0, 'no refused port was counted');
  // Control: the same fresh hub takes the panel page, so the refusals above were about the role only.
  const panel = fakePort({ name: PORT_NAMES.panel, kind: 'panel' });
  assert.equal(hub.accept(panel), true);
  assert.equal(panel.disconnects, 0);
  assert.equal(hub.count(), 1);
});

test('panel hub broadcast: deduped per port and kind (ignoring seq); sendTo is a baseline; a throwing port is removed', () => {
  const clock = createFakeClock();
  const hub = createPanelHub({ runtime: RUNTIME, timers: clock });
  const [a, b] = [fakePort({ name: PORT_NAMES.panel, kind: 'panel' }), fakePort({ name: PORT_NAMES.panel, kind: 'panel' })];
  hub.accept(a); hub.accept(b);
  const captions = (seq, text) => ({ v: 1, type: 'captions', epoch: 1, seq, lane: 'tab', lang: 'ko',
    rows: [{ id: 'r', role: 'translation', status: 'final', text, skipped: false }], gaps: { input: false, audio: false, reception: false }, live: true });
  hub.broadcast(captions(1, 'one'));
  hub.broadcast(captions(2, 'one'));
  assert.deepEqual([a.posted.length, b.posted.length], [1, 1]);
  hub.broadcast({ ...captions(3, 'two'), lane: 'mic' });
  assert.equal(a.posted.length, 2, 'another lane is another kind');
  hub.sendTo(a, captions(4, 'three'));
  hub.broadcast(captions(5, 'three'));
  assert.equal(a.posted.length, 3, 'a port that was just sent this frame does not get it again');
  assert.equal(b.posted.length, 3);
  assert.equal(hub.sendTo(fakePort(), captions(6, 'x')), false, 'not one of ours');

  b.failPost = true;
  hub.broadcast(captions(7, 'four'));
  assert.equal(hub.count(), 1);
});

test('panel hub grace: the last port gone starts panelGraceMs; a new port cancels it; one report per absence', async () => {
  const clock = createFakeClock();
  const gone = [];
  const hub = createPanelHub({ runtime: RUNTIME, timers: clock, onAllGone: (reason) => gone.push(reason) });
  const [a, b] = [fakePort({ name: PORT_NAMES.panel, kind: 'panel' }), fakePort({ name: PORT_NAMES.panel, kind: 'panel' })];
  hub.accept(a); hub.accept(b);
  a.drop();
  await clock.advance(10000);
  assert.deepEqual(gone, [], 'one panel is still there');
  b.drop();
  await clock.advance(LIMITS.panelGraceMs - 1);
  assert.deepEqual(gone, []);
  const c = fakePort({ name: PORT_NAMES.panel, kind: 'panel' });
  hub.accept(c);                       // a reconnect within the grace
  await clock.advance(10000);
  assert.deepEqual(gone, []);
  c.drop();
  await clock.advance(LIMITS.panelGraceMs);
  assert.deepEqual(gone, ['panel-gone']);
  await clock.advance(60000);
  hub.armGrace();
  await clock.advance(60000);
  assert.deepEqual(gone, ['panel-gone'], 'after a report nothing re-arms until a panel connects again');
  hub.accept(fakePort({ name: PORT_NAMES.panel, kind: 'panel' }));
  hub.armGrace();
  await clock.advance(60000);
  assert.deepEqual(gone, ['panel-gone'], 'armGrace is a no-op while a panel is connected');
});

test('panel hub initial grace: no panel ever -> initial-grace after panelInitialGraceMs; a panel cancels it; armGrace counts panelGraceMs', async () => {
  const clock = createFakeClock();
  const gone = [];
  const hub = createPanelHub({ runtime: RUNTIME, timers: clock, onAllGone: (reason) => gone.push(reason) });
  hub.armInitialGrace();
  await clock.advance(LIMITS.panelInitialGraceMs - 1);
  assert.deepEqual(gone, []);
  await clock.advance(1);
  assert.deepEqual(gone, ['initial-grace']);

  const second = createPanelHub({ runtime: RUNTIME, timers: clock, onAllGone: (reason) => gone.push(reason) });
  second.armInitialGrace();
  const port = fakePort({ name: PORT_NAMES.panel, kind: 'panel' });
  second.accept(port);
  await clock.advance(60000);
  assert.deepEqual(gone, ['initial-grace'], 'a connected panel cancelled its host\'s initial grace');

  const third = createPanelHub({ runtime: RUNTIME, timers: clock, onAllGone: (reason) => gone.push(reason) });
  third.armGrace();
  await clock.advance(LIMITS.panelGraceMs);
  assert.deepEqual(gone, ['initial-grace', 'panel-gone']);
});

test('panel hub rearm: a repeat 3 s, 6 s and 12 s after the report with the same reason, at most three times, and no timer left behind', async () => {
  const clock = createFakeClock();
  const gone = [];
  const hub = createPanelHub({ runtime: RUNTIME, timers: clock, onAllGone: (reason) => gone.push([clock.now(), reason]) });
  assert.equal(hub.rearm('panel-gone'), false, 'nothing has been reported yet: there is nothing to repeat');
  assert.equal(clock.pending(), 0);
  hub.armInitialGrace();
  await clock.advance(LIMITS.panelInitialGraceMs);
  assert.deepEqual(gone, [[15000, 'initial-grace']]);
  assert.equal(clock.pending(), 0);

  assert.equal(hub.rearm('initial-grace'), true);
  assert.equal(clock.pending(), 1, 'one timer carries the repeat');
  await clock.advance(2999);
  assert.equal(gone.length, 1);
  await clock.advance(1);
  assert.deepEqual(gone.at(-1), [18000, 'initial-grace']);
  assert.equal(clock.pending(), 0);
  assert.equal(hub.rearm('initial-grace'), true);
  await clock.advance(6000);
  assert.deepEqual(gone.at(-1), [24000, 'initial-grace']);
  assert.equal(hub.rearm('initial-grace'), true);
  await clock.advance(12000);
  assert.deepEqual(gone.at(-1), [36000, 'initial-grace']);
  assert.equal(hub.rearm('initial-grace'), false, 'the cap: three repeats and no more');
  assert.equal(clock.pending(), 0, 'the chain ends without a timer');
  await clock.advance(600000);
  hub.armGrace();
  await clock.advance(600000);
  assert.equal(gone.length, 4, 'armGrace stays a no-op after a report: only rearm or a panel opens the hub again');
});

test('panel hub rearm: a panel that connects cancels the repeat and restores the whole cap; an answer to an older report is void', async () => {
  const clock = createFakeClock();
  const gone = [];
  const hub = createPanelHub({ runtime: RUNTIME, timers: clock, onAllGone: (reason) => gone.push(reason) });
  hub.armGrace();
  await clock.advance(LIMITS.panelGraceMs);
  assert.deepEqual(gone, ['panel-gone']);
  assert.equal(hub.rearm('panel-gone'), true);
  await clock.advance(1000);
  const panel = fakePort({ name: PORT_NAMES.panel, kind: 'panel' });
  hub.accept(panel);
  assert.equal(clock.pending(), 0, 'the pending repeat was cancelled by the panel');
  assert.equal(hub.rearm('panel-gone'), false, 'a panel is connected: the answer to the old report is void');
  await clock.advance(60000);
  assert.equal(gone.length, 1);
  panel.drop();
  assert.equal(hub.rearm('panel-gone'), false, 'the new absence has not been reported: an old answer cannot open it early');
  await clock.advance(LIMITS.panelGraceMs);
  assert.equal(gone.length, 2, 'the new absence reports after its own grace');

  for (const delay of [3000, 6000, 12000]) {   // the cap is whole again
    assert.equal(hub.rearm('panel-gone'), true);
    await clock.advance(delay);
  }
  assert.equal(gone.length, 5);
  assert.equal(hub.rearm('panel-gone'), false);
  assert.equal(clock.pending(), 0);
});

test('panel hub rearm: dispose cancels a pending repeat and refuses later ones', async () => {
  const clock = createFakeClock();
  const gone = [];
  const hub = createPanelHub({ runtime: RUNTIME, timers: clock, onAllGone: (reason) => gone.push(reason) });
  hub.armGrace();
  await clock.advance(LIMITS.panelGraceMs);
  assert.equal(hub.rearm('panel-gone'), true);
  assert.equal(clock.pending(), 1);
  hub.dispose();
  assert.equal(clock.pending(), 0);
  assert.equal(hub.rearm('panel-gone'), false);
  await clock.advance(600000);
  assert.equal(gone.length, 1, 'nothing fires after dispose');
});

// ---------------------------------------------------------------------------------------------
// The host over the fake browser.

async function up(rigH, lane, overrides = {}) {
  const before = rigH.counts();
  const response = await rigH.startLane(lane, overrides);
  assert.equal(response.ok, true, JSON.stringify(response));
  return { response, ...await rigH.connect(before) };
}
const settingsMessage = (overrides = {}) => makeMessage('host/settings', { settings: { speechMuted: true, tabOriginalVolume: 65,
  captions: { tab: true, mic: false }, style: { ...STYLE }, ...overrides } });
const typesOf = (target) => target.frames.map((frame) => (frame.lane ? `${frame.type}:${frame.lane}` : frame.type));
const playbackContexts = (rigH) => rigH.audio.contexts.filter((context) => context.options.sampleRate === 24000);
const idleMessages = (rigH) => rigH.swInbox.filter((entry) => entry.message.type === 'sw/host-idle').map((entry) => entry.message);
// The rig's own worker answers every sw/host-idle with {closed:false}. This lets a test choose the answer: `answerOf(count,
// message)` returns the response, or undefined to stay silent (the host's send then rejects, like a worker that never answered).
const SW_CLOSES = Object.freeze({ ok: true, closed: true }), SW_KEEPS = Object.freeze({ ok: true, closed: false });
function swAnswersIdle(rigH, answerOf) {
  rigH.swReply.mode = 'silent';   // the rig's listener still records the message; it just does not answer it
  let count = 0;
  rigH.swChrome().runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== 'sw' || message.type !== 'sw/host-idle') return false;
    count += 1;
    const answer = answerOf(count, message);
    if (answer === undefined) return false;
    sendResponse(answer);
    return true;
  });
}

test('the host uses only the runtime members an offscreen document has, and start() is idempotent', async () => {
  const used = new Set();
  const rigH = await createHostRig({ wrapRuntime: (runtime) => new Proxy(runtime, { get(target, key) { used.add(String(key)); return Reflect.get(target, key); } }) });
  assert.deepEqual(Object.keys(rigH.offscreen().chrome), ['runtime'], 'nothing but runtime exists there');
  assert.deepEqual(Object.keys(rigH.offscreen().chrome.runtime).sort(), SIX, 'and only six of its members');
  rigH.host().start();
  rigH.host().start();
  assert.equal(rigH.offscreen().listeners.get('runtime.onMessage').length, 1);
  assert.equal(rigH.offscreen().listeners.get('runtime.onConnect').length, 1);

  const panel = rigH.openPanel();
  await up(rigH, 'tab');
  rigH.openOverlay(5);
  await rigH.send(makeMessage('host/lane-stop'));
  panel.close();
  await rigH.clock.advance(LIMITS.panelGraceMs);
  assert.equal(idleMessages(rigH).length, 1);
  assert.deepEqual([...used].filter((member) => !SIX.includes(member)), [], 'no other runtime member was touched');
  for (const member of ['id', 'getURL', 'onMessage', 'onConnect', 'sendMessage']) assert.ok(used.has(member), member);
  assert.equal(used.has('connect'), false, 'the host never opens ports itself');
});

test('host/ping reports the hostId, protocol, both phases, the tab lane\'s tabId and the panel count', async () => {
  const rigH = await createHostRig();
  assert.deepEqual(await rigH.send(makeMessage('host/ping')), { ok: true, hostId: 'h-test', protocol: 1,
    lanes: { tab: 'off', mic: 'off' }, tabId: null, panels: 0 });
  rigH.openPanel();
  await up(rigH, 'tab');
  await up(rigH, 'mic', { model: 'gemini-3.8-live' });
  assert.deepEqual(await rigH.send(makeMessage('host/ping')), { ok: true, hostId: 'h-test', protocol: 1,
    lanes: { tab: 'running', mic: 'running' }, tabId: 5, panels: 1 });
});

test('messages are validated (INVALID_MESSAGE) and only the service worker may send host/* (FORBIDDEN); other targets stay silent', async () => {
  const rigH = await createHostRig();
  assert.deepEqual(await rigH.send({ v: 1, target: 'offscreen', type: 'host/lane-start', lane: 'tab' }), { ok: false, code: 'INVALID_MESSAGE' });
  assert.deepEqual(await rigH.send({ v: 1, target: 'offscreen', type: 'host/nope' }), { ok: false, code: 'INVALID_MESSAGE' });
  assert.deepEqual(await rigH.send({ v: 1, target: 'offscreen', type: 'host/lane-stop', lane: 'both' }), { ok: false, code: 'INVALID_MESSAGE' });
  const panel = rigH.openPanel({ hello: false });
  assert.deepEqual(await panel.context.chrome.runtime.sendMessage(makeMessage('host/ping')), { ok: false, code: 'FORBIDDEN' });
  const start = { v: 1, target: 'offscreen', type: 'host/lane-start', lane: 'mic', key: fakeKey('x'), request: { targetLanguage: 'ko', model: 'gemini-3.8-live' },
    voiceGender: 'female', muted: true, captions: false, style: { ...STYLE } };
  assert.deepEqual(await panel.context.chrome.runtime.sendMessage(start), { ok: false, code: 'FORBIDDEN' }, 'a panel cannot start a lane');
  assert.equal(rigH.sockets.sockets.length, 0);
  // A message for another target reaches this context but gets no answer from it.
  await assert.rejects(panel.context.chrome.runtime.sendMessage({ v: 1, target: 'content', type: 'content/overlay-attach' }), /message port closed/);
  // Lane starts with a bad payload never reach an engine.
  assert.deepEqual(await rigH.send({ ...start, key: 'has a space' }), { ok: false, code: 'INVALID_MESSAGE' });
  assert.deepEqual(await rigH.send({ ...start, request: { targetLanguage: 'fr', model: 'x' } }), { ok: false, code: 'INVALID_MESSAGE' });
  assert.deepEqual(await rigH.send({ ...start, tab: { tabId: 1, streamId: 'x', originalVolume: 5 } }), { ok: false, code: 'INVALID_MESSAGE' });
});

test('host/lane-start: epochs count accepted starts only; ALREADY_RUNNING while running, LANE_STOPPING while stopping', async () => {
  const rigH = await createHostRig();
  const first = await up(rigH, 'tab');
  assert.equal(first.response.epoch, 1);
  assert.deepEqual(await rigH.startLane('tab', { tabId: 6 }), { ok: false, code: 'ALREADY_RUNNING' });
  const prepared = await rigH.laneStartMessage('tab', { tabId: 7 });   // minting is async: prepare before the race
  const stopping = rigH.send(makeMessage('host/lane-stop', { lane: 'tab' }));
  const refused = await rigH.send(prepared);
  assert.deepEqual(refused, { ok: false, code: 'LANE_STOPPING' });
  await stopping;
  const again = await rigH.startLane('tab', { tabId: 8 });
  assert.deepEqual(again, { ok: true, epoch: 2 }, 'the refused starts consumed no epoch');
  const mic = await up(rigH, 'mic', { model: 'gemini-3.8-live' });
  assert.equal(mic.response.epoch, 3, 'one counter for the host');
});

test('host/lane-start refusals come back as machine codes: a refused engine is SESSION_LIMIT-style, a bad tab stream is TAB_CAPTURE_FAILED', async () => {
  const rigH = await createHostRig();
  assert.deepEqual(await rigH.startLane('tab', { streamId: 'not-a-stream' }), { ok: false, code: 'TAB_CAPTURE_FAILED' });
  const ping = await rigH.send(makeMessage('host/ping'));
  assert.equal(ping.lanes.tab, 'error');
  const panel = rigH.openPanel();
  await rigH.settle();
  assert.equal(panel.last('state').state.lanes.tab.errorCode, 'TAB_CAPTURE_FAILED');
});

test('host/lane-stop: absent lane stops both; a stop while a lane is still starting cancels that start', async () => {
  const rigH = await createHostRig();
  await up(rigH, 'tab');
  await up(rigH, 'mic', { model: 'gemini-3.8-live' });
  assert.deepEqual(await rigH.send(makeMessage('host/lane-stop')), { ok: true });
  assert.deepEqual((await rigH.send(makeMessage('host/ping'))).lanes, { tab: 'off', mic: 'off' });
  assert.deepEqual(await rigH.send(makeMessage('host/lane-stop', { lane: 'mic' })), { ok: true }, 'a stop with nothing to stop still succeeds');

  rigH.audio.setGetUserMediaMode('held');
  const prepared = await rigH.laneStartMessage('tab', { tabId: 9 });
  const starting = rigH.send(prepared);
  await tick();
  assert.equal(rigH.audio.pendingGetUserMedia(), 1);
  assert.equal((await rigH.send(makeMessage('host/ping'))).lanes.tab, 'starting');
  // The stop answers once the abandoned start has cleaned up (bounded by startSettleMs), so it is awaited together
  // with the getUserMedia that finally answers.
  const stopping = rigH.send(makeMessage('host/lane-stop', { lane: 'tab' }));
  await tick();
  rigH.audio.releaseGetUserMedia();
  assert.deepEqual(await stopping, { ok: true }, 'ok even though the lane was still starting');
  assert.deepEqual(await starting, { ok: false, code: 'START_CANCELLED' });
  assert.equal(rigH.browser.captures.size, 0);
  assert.equal((await rigH.send(makeMessage('host/ping'))).lanes.tab, 'off');
});

// 5.9: only a lane-less host/lane-stop, the panel-gone grace and dispose() stop BOTH lanes. Everything below runs through the
// host/* messages, so it sees what the lane objects alone cannot: whether the host handler names the lane it was asked about.
test('host/lane-stop {lane} stops ONLY that lane: the other lane keeps its phase, its capture and its socket', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  const tab = await up(rigH, 'tab');
  const mic = await up(rigH, 'mic', { model: 'gemini-3.8-live' });
  assert.deepEqual((await rigH.send(makeMessage('host/ping'))).lanes, { tab: 'running', mic: 'running' });
  assert.equal(rigH.browser.captures.size, 1, 'the tab capture is held');

  assert.deepEqual(await rigH.send(makeMessage('host/lane-stop', { lane: 'mic' })), { ok: true });
  assert.deepEqual((await rigH.send(makeMessage('host/ping'))).lanes, { tab: 'running', mic: 'off' }, 'stopping the microphone must not stop the tab lane');
  assert.equal(rigH.browser.captures.size, 1, 'the tab capture is still held');
  assert.equal(tab.socket.closeCalls, 0, 'the tab lane\'s interpretation is still connected');
  assert.ok(mic.socket.closeCalls >= 1, 'the mic lane really stopped');
  await rigH.clock.advance(100);
  assert.deepEqual([panel.last('state').state.lanes.tab.phase, panel.last('state').state.lanes.mic.phase], ['running', 'off']);

  // And the other way round: bring the mic lane back, then stop only the tab lane.
  const micAgain = await up(rigH, 'mic', { model: 'gemini-3.8-live' });
  assert.deepEqual(await rigH.send(makeMessage('host/lane-stop', { lane: 'tab' })), { ok: true });
  assert.deepEqual((await rigH.send(makeMessage('host/ping'))).lanes, { tab: 'off', mic: 'running' }, 'stopping the tab lane must not stop the microphone');
  assert.equal(rigH.browser.captures.size, 0, 'the tab capture is released');
  assert.equal(micAgain.socket.closeCalls, 0, 'the mic lane\'s interpretation is still connected');
  await rigH.clock.advance(100);
  assert.deepEqual([panel.last('state').state.lanes.tab.phase, panel.last('state').state.lanes.mic.phase], ['off', 'running']);
});

test('a mic start the host refuses (permission denied) leaves the RUNNING tab lane alone', async () => {
  const rigH = await createHostRig({ micPermission: 'denied' });
  rigH.openPanel();
  const tab = await up(rigH, 'tab');
  const refused = await rigH.startLane('mic', { model: 'gemini-3.8-live' });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(typeof refused.code, 'string');
  const ping = await rigH.send(makeMessage('host/ping'));
  assert.equal(ping.lanes.mic, 'error', 'the mic lane carries the failure');
  assert.equal(ping.lanes.tab, 'running', `the tab lane survived: ${JSON.stringify(ping.lanes)} ${JSON.stringify(refused)}`);
  assert.equal(rigH.browser.captures.size, 1, 'the tab capture is still held');
  assert.equal(tab.socket.closeCalls, 0, 'the tab lane\'s interpretation is still connected');
});

test('a tab start the host refuses (bad stream id) leaves the RUNNING mic lane alone', async () => {
  const rigH = await createHostRig();
  rigH.openPanel();
  const mic = await up(rigH, 'mic', { model: 'gemini-3.8-live' });
  assert.deepEqual(await rigH.startLane('tab', { streamId: 'not-a-stream' }), { ok: false, code: 'TAB_CAPTURE_FAILED' });
  const ping = await rigH.send(makeMessage('host/ping'));
  assert.equal(ping.lanes.tab, 'error', 'the tab lane carries the failure');
  assert.equal(ping.lanes.mic, 'running', `the mic lane survived: ${JSON.stringify(ping.lanes)}`);
  assert.equal(mic.socket.closeCalls, 0, 'the mic lane\'s interpretation is still connected');
});

test('host/settings: live mute (both lanes, resumeAudio on unmute), original volume and style', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  const tab = await up(rigH, 'tab');
  const mic = await up(rigH, 'mic', { model: 'gemini-3.8-live' });
  rigH.openOverlay(5);
  await rigH.settle();
  const playback = playbackContexts(rigH);
  assert.equal(playback.length, 2);
  const gain = rigH.audio.contexts[0].nodes.find((node) => node.kind === 'gain');
  assert.equal(gain.gain.value, 0.65);

  const resumes = playback.map((context) => context.resumeCalls);
  assert.deepEqual(await rigH.send(settingsMessage({ speechMuted: false, tabOriginalVolume: 20 })), { ok: true });
  assert.ok(playback.every((context, index) => context.resumeCalls > resumes[index]), 'unmute resumes both playback contexts');
  assert.equal(gain.gain.value, 0.2, 'the passthrough volume is live');
  await rigH.clock.advance(100);
  assert.equal(panel.last('state').state.speechMuted, false);

  const suspends = playback.map((context) => context.suspendCalls);
  await rigH.send(settingsMessage({ speechMuted: true, tabOriginalVolume: 20 }));
  assert.ok(playback.every((context, index) => context.suspendCalls > suspends[index]), 'mute suspends both (hard mute)');

  await rigH.send(settingsMessage({ speechMuted: true, tabOriginalVolume: 20, style: { ...STYLE, size: 2, position: 'top', display: 'mono', maxLines: 5, autoHideSeconds: 0 } }));
  await rigH.settle();
  const overlay = rigH.overlays[0];
  assert.deepEqual(overlay.last('style').style, { size: 2, position: 'top', display: 'mono', maxLines: 5, autoHideSeconds: 0 },
    'the style frame carries exactly five fields (showSource stays host-side)');
  void tab; void mic;
});

test('host/settings captions: turning a lane off clears its rows and closes the port nobody needs; on again only re-enables routing', async () => {
  const rigH = await createHostRig();
  const tab = await up(rigH, 'tab');
  const overlay = rigH.openOverlay(5);
  await rigH.settle();
  content(tab.socket, { outputTranscription: { text: 'hello' } });
  await tick();
  await rigH.clock.advance(100);
  assert.ok(overlay.frames.some((frame) => frame.type === 'captions' && frame.rows.length > 0));

  await rigH.send(settingsMessage({ captions: { tab: false, mic: false } }));
  await rigH.settle();
  assert.deepEqual(typesOf(overlay).slice(-2), ['clear:tab', 'bye']);
  await rigH.clock.advance(300);
  assert.equal(overlay.disconnected, true);
  content(tab.socket, { outputTranscription: { text: 'still running' } });
  await tick();
  await rigH.clock.advance(100);
  assert.equal(rigH.overlays.length, 1);
  assert.equal(typesOf(overlay).at(-1), 'bye', 'nothing more reaches a closed overlay');

  // On again: routing is re-enabled, but a page only gets an overlay when the SW attaches one.
  await rigH.send(settingsMessage({ captions: { tab: true, mic: false } }));
  const wanted = await rigH.send(makeMessage('host/overlay-wanted', { tabId: 5, active: false }));
  assert.deepEqual(wanted, { ok: true, wanted: true, lanes: ['tab'] });
  const reopened = rigH.openOverlay(5, { fresh: true });
  await rigH.settle();
  assert.deepEqual(typesOf(reopened).slice(0, 2), ['style', 'captions:tab']);
});

test('host/overlay-wanted: the lanes a tab needs, the mic lane only for the tab you look at', async () => {
  const rigH = await createHostRig();
  rigH.browser.addTab({ id: 9, url: 'https://elsewhere.test/', active: false });
  const wanted = (tabId, active) => rigH.send(makeMessage('host/overlay-wanted', { tabId, active }));
  assert.deepEqual(await wanted(5, true), { ok: true, wanted: false, lanes: [] }, 'no lane runs');
  await up(rigH, 'tab');
  await rigH.send(settingsMessage({ captions: { tab: true, mic: true } }));
  assert.deepEqual(await wanted(5, false), { ok: true, wanted: true, lanes: ['tab'] });
  assert.deepEqual(await wanted(9, false), { ok: true, wanted: false, lanes: [] });
  assert.deepEqual(await wanted(9, true), { ok: true, wanted: false, lanes: [] }, 'the mic lane is not running yet');
  await up(rigH, 'mic', { model: 'gemini-3.8-live', captions: true });
  assert.deepEqual(await wanted(5, true), { ok: true, wanted: true, lanes: ['tab', 'mic'] });
  assert.deepEqual(await wanted(9, true), { ok: true, wanted: true, lanes: ['mic'] }, 'the tab you look at gets your own captions');
  assert.deepEqual(await wanted(9, false), { ok: true, wanted: false, lanes: [] }, 'looking away: nothing for that tab');
  await rigH.send(settingsMessage({ captions: { tab: false, mic: true } }));
  assert.deepEqual(await wanted(5, true), { ok: true, wanted: true, lanes: ['mic'] }, 'captions off for the tab lane');
  await rigH.send(makeMessage('host/lane-stop', { lane: 'mic' }));
  assert.deepEqual(await wanted(5, true), { ok: true, wanted: false, lanes: [] }, 'a stopped lane needs nothing');
});

test('host/overlay-result: a failed attach marks only the named lanes unavailable; the mic value resets when the active tab moves', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  await up(rigH, 'tab');
  await up(rigH, 'mic', { model: 'gemini-3.8-live', captions: true });
  await rigH.send(makeMessage('host/overlay-wanted', { tabId: 5, active: true }));
  await rigH.send(makeMessage('host/overlay-result', { tabId: 5, ok: true, lanes: ['tab', 'mic'] }));
  await rigH.clock.advance(100);
  assert.deepEqual([panel.last('state').state.lanes.tab.overlay, panel.last('state').state.lanes.mic.overlay], ['unknown', 'unknown'], 'ok:true changes nothing');
  await rigH.send(makeMessage('host/overlay-result', { tabId: 5, ok: false, lanes: ['tab', 'mic'] }));
  await rigH.clock.advance(100);
  assert.deepEqual([panel.last('state').state.lanes.tab.overlay, panel.last('state').state.lanes.mic.overlay], ['unavailable', 'unavailable']);
  await rigH.send(makeMessage('host/overlay-wanted', { tabId: 9, active: true }));
  await rigH.clock.advance(100);
  assert.deepEqual([panel.last('state').state.lanes.tab.overlay, panel.last('state').state.lanes.mic.overlay], ['unavailable', 'unknown'],
    'the mic value is about the tab you look at, so it resets when that tab changes');
  await rigH.send(makeMessage('host/overlay-result', { tabId: 5, ok: false, lanes: ['tab'] }));
  await rigH.send(makeMessage('host/lane-stop', { lane: 'tab' }));
  await up(rigH, 'tab');
  await rigH.clock.advance(100);
  assert.equal(panel.last('state').state.lanes.tab.overlay, 'unknown', 'a new run starts with a clean slate');
});

test('host/tab-removed stops the tab lane with TAB_ENDED and forgets the tab you looked at; the mic lane keeps running', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  await up(rigH, 'tab');
  const mic = await up(rigH, 'mic', { model: 'gemini-3.8-live', captions: true });
  // You look at the captured tab: your own captions go to its overlay. That tab id is what a removal must forget.
  assert.deepEqual(await rigH.send(makeMessage('host/overlay-wanted', { tabId: 5, active: true })), { ok: true, wanted: true, lanes: ['tab', 'mic'] });
  const overlay = rigH.openOverlay(5);
  await rigH.settle();
  const micText = () => (overlay.frames.filter((frame) => frame.type === 'captions' && frame.lane === 'mic').at(-1)?.rows ?? []).map((row) => row.text).join(' ');
  const speak = async (text) => { content(mic.socket, { outputTranscription: { text } }); await tick(); await rigH.clock.advance(150); };
  await speak('before');
  assert.ok(micText().includes('before'), 'control: your speech reaches the tab you look at');

  assert.deepEqual(await rigH.send(makeMessage('host/tab-removed', { tabId: 77 })), { ok: true });
  assert.equal((await rigH.send(makeMessage('host/ping'))).lanes.tab, 'running', 'another tab');
  await speak('unrelated');
  assert.ok(micText().includes('unrelated'), 'the removal of ANOTHER tab does not move the tab you look at');

  const framesBefore = overlay.frames.length;
  assert.deepEqual(await rigH.send(makeMessage('host/tab-removed', { tabId: 5 })), { ok: true });
  await rigH.clock.advance(100);
  const state = panel.last('state').state;
  assert.equal(state.lanes.tab.phase, 'error');
  assert.equal(state.lanes.tab.errorCode, 'TAB_ENDED');
  assert.equal(state.lanes.mic.phase, 'running');
  assert.equal(rigH.browser.captures.size, 0);
  // The tab you looked at is gone: your captions leave it at once and are not routed to it any more. Its port is still open
  // (the ended tab lane lingers to show why), so only the reset of the looked-at tab keeps your speech away from it.
  assert.ok(overlay.frames.slice(framesBefore).some((frame) => frame.type === 'clear' && frame.lane === 'mic'), 'your captions are cleared from the removed tab');
  assert.equal(overlay.disconnected, false, 'the port of the removed tab is still open');
  await speak('after removal');
  assert.equal(overlay.frames.slice(framesBefore).some((frame) => frame.type === 'captions' && frame.lane === 'mic'), false,
    'no mic caption is routed to the removed tab any more');
  assert.equal(micText().includes('after removal'), false);
  assert.equal((await rigH.send(makeMessage('host/ping'))).lanes.mic, 'running', 'the mic lane itself keeps running');
  // Nothing to end on an idle lane.
  await rigH.send(makeMessage('host/lane-stop', { lane: 'tab' }));
  await rigH.send(makeMessage('host/tab-removed', { tabId: 5 }));
  assert.equal((await rigH.send(makeMessage('host/ping'))).lanes.tab, 'error', 'the earlier verdict stands');
});

test('a tab that closes ends the tab lane with TAB_ENDED through its track, and the mic lane continues', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  const tab = await up(rigH, 'tab');
  const mic = await up(rigH, 'mic', { model: 'gemini-3.8-live' });
  await rigH.browser.closeTab(5);
  await rigH.clock.advance(200);
  assert.equal(panel.last('state').state.lanes.tab.errorCode, 'TAB_ENDED');
  assert.equal(panel.last('state').state.lanes.mic.phase, 'running');
  assert.ok(tab.socket.closeCalls >= 1);
  assert.equal(mic.socket.closeCalls, 0);
});

// ---------------------------------------------------------------------------------------------
// The panel over the host.

test('panel hello: the full current state and the latest captions frame of each lane, all valid frames', async () => {
  const rigH = await createHostRig();
  await up(rigH, 'tab');
  const panel = rigH.openPanel();
  await rigH.settle();
  assert.deepEqual(typesOf(panel), ['state', 'captions:tab', 'captions:mic']);
  for (const frame of panel.frames) assert.equal(validateFrame('host->panel', frame).ok, true, frame.type);
  const { state } = panel.frames[0];
  assert.equal(state.hostId, 'h-test');
  assert.equal(state.lanes.tab.phase, 'running');
  assert.equal(state.lanes.tab.tabId, 5);
  assert.equal(state.lanes.mic.phase, 'off');
  assert.ok(JSON.stringify(state).length <= 2048, 'a UiState stays under 2 KB');
});

test('state frames: valid, monotonically numbered, deduped, and refreshed as the lane changes', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  const tab = await up(rigH, 'tab');
  await rigH.clock.advance(100);
  const states = () => panel.frames.filter((frame) => frame.type === 'state');
  assert.equal(states().at(-1).state.lanes.tab.phase, 'running');
  const seqs = states().map((frame) => frame.state.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length, 'strictly increasing');
  assert.equal(seqs[0], 1);
  for (const frame of states()) assert.equal(validateFrame('host->panel', frame).ok, true);

  const count = states().length;
  await rigH.send(settingsMessage());    // the very same settings
  await rigH.clock.advance(300);
  assert.equal(states().length, count, 'an unchanged state is not sent again');
  tab.worklet.emitFrames(0.25);
  await rigH.clock.advance(100);
  assert.equal(states().at(-1).state.lanes.tab.level, 100, 'the input level rides the state frame');
});

test('panel ports: more than maxPanelPorts, the wrong page kind and a foreign name', async () => {
  const rigH = await createHostRig();
  const panels = Array.from({ length: 5 }, () => rigH.openPanel());
  const options = rigH.openPanel({ kind: 'options' });
  const stranger = rigH.openPanel({ name: 'someone-else/1', hello: false });
  await rigH.settle();
  assert.deepEqual(panels.map((panel) => panel.disconnected), [false, false, false, false, true], 'the cap is maxPanelPorts');
  assert.equal(options.disconnected, true, 'an options page is not a panel');
  assert.equal(stranger.disconnected, false, 'a port with another name is ignored, not disconnected');
  assert.equal((await rigH.send(makeMessage('host/ping'))).panels, 4);
});

test('port roles over the host: an options page in the captured tab is no overlay and an options/permission page is no panel, while there is room', async () => {
  const rigH = await createHostRig();
  await up(rigH, 'tab');   // tab 5 is captured with captions on: the routing policy WOULD accept an overlay port for it
  const connectFrom = (kind, tabId, name) => {
    const context = rigH.browser.createContext(kind, tabId === undefined ? {} : { tabId });
    const port = context.chrome.runtime.connect({ name });
    const seen = { disconnected: false };
    port.onDisconnect.addListener(() => { seen.disconnected = true; });
    port.postMessage(hello);
    return seen;
  };
  const optionsAsOverlay = connectFrom('options', 5, PORT_NAMES.overlay);
  const permissionAsOverlay = connectFrom('permission', 5, PORT_NAMES.overlay);
  const optionsAsPanel = connectFrom('options', undefined, PORT_NAMES.panel);
  const permissionAsPanel = connectFrom('permission', 5, PORT_NAMES.panel);
  const contentAsPanel = rigH.browser.createContext('content', { tabId: 5 }).chrome.runtime.connect({ name: PORT_NAMES.panel });
  let contentAsPanelGone = false;
  contentAsPanel.onDisconnect.addListener(() => { contentAsPanelGone = true; });
  await rigH.settle();
  assert.deepEqual([optionsAsOverlay.disconnected, permissionAsOverlay.disconnected], [true, true], 'an extension page is not a content script');
  assert.deepEqual([optionsAsPanel.disconnected, permissionAsPanel.disconnected, contentAsPanelGone], [true, true, true], 'only the side panel is a panel');
  const ping = await rigH.send(makeMessage('host/ping'));
  assert.equal(ping.panels, 0, 'no refused port was counted');
  // Control: the right pages are taken by the same host.
  const overlay = rigH.openOverlay(5);
  const panel = rigH.openPanel();
  await rigH.settle();
  assert.equal(overlay.disconnected, false);
  assert.equal(panel.disconnected, false);
  assert.equal((await rigH.send(makeMessage('host/ping'))).panels, 1);
  assert.deepEqual(typesOf(overlay), ['style', 'captions:tab'], 'and only the content script is fed');
});

test('panel grace: the last panel gone -> lanes stop after panelGraceMs and exactly one sw/host-idle {panel-gone}; a reconnect cancels it', async () => {
  const rigH = await createHostRig();
  swAnswersIdle(rigH, () => SW_CLOSES);   // a worker that closes the idle host: nothing is asked twice (a closed:false would be)
  const first = rigH.openPanel();
  const links = [await up(rigH, 'tab'), await up(rigH, 'mic', { model: 'gemini-3.8-live' })];
  first.close();
  await rigH.keepAlive(links, LIMITS.panelGraceMs - 500);
  assert.equal(idleMessages(rigH).length, 0);
  const second = rigH.openPanel();                       // reconnect within the grace
  await rigH.settle();
  await rigH.keepAlive(links, 20000);
  assert.equal(idleMessages(rigH).length, 0);
  assert.deepEqual((await rigH.send(makeMessage('host/ping'))).lanes, { tab: 'running', mic: 'running' });

  second.close();
  await rigH.keepAlive(links, LIMITS.panelGraceMs);   // the capture hears audio right up to the moment the host stops it
  assert.deepEqual(idleMessages(rigH), [{ v: 1, target: 'sw', type: 'sw/host-idle', hostId: 'h-test', reason: 'panel-gone' }]);
  assert.deepEqual((await rigH.send(makeMessage('host/ping'))).lanes, { tab: 'off', mic: 'off' }, 'the lanes were stopped first');
  assert.equal(rigH.browser.captures.size, 0);
  await rigH.clock.advance(120000);
  assert.equal(idleMessages(rigH).length, 1, 'reported once');
});

test('sw/host-idle is retried once after 500 ms when the send rejects, and not a third time within one report', async () => {
  const rigH = await createHostRig();
  swAnswersIdle(rigH, (count) => (count === 1 ? undefined : SW_CLOSES));
  const gone = rigH.openPanel();
  await rigH.settle();
  gone.close();
  await rigH.clock.advance(LIMITS.panelGraceMs);
  assert.equal(idleMessages(rigH).length, 1, 'the first send got no answer and rejected');
  await rigH.clock.advance(499);
  assert.equal(idleMessages(rigH).length, 1);
  await rigH.clock.advance(1);
  assert.equal(idleMessages(rigH).length, 2, 'retried after 500 ms');
  await rigH.clock.advance(60000);
  assert.equal(idleMessages(rigH).length, 2);

  const stubborn = await createHostRig();
  stubborn.swReply.mode = 'silent';
  const away = stubborn.openPanel();
  await stubborn.settle();
  away.close();
  await stubborn.clock.advance(LIMITS.panelGraceMs + 500);
  assert.equal(idleMessages(stubborn).length, 2, 'once more within the report, never a third time');
  await stubborn.clock.advance(60000);
  // A worker that never answers is asked again by later reports (3 s, 6 s, 12 s: the hub's cap), two sends each, and
  // then left to the panel-side sw/host-probe and the next Start (6.11).
  assert.equal(idleMessages(stubborn).length, 8, 'the finished report is repeated three times and then stops');
});

test('initial grace: no panel ever connects -> sw/host-idle {initial-grace} after panelInitialGraceMs; a panel in time prevents it', async () => {
  const lonely = await createHostRig();
  await lonely.clock.advance(LIMITS.panelInitialGraceMs - 1);
  assert.equal(idleMessages(lonely).length, 0);
  await lonely.clock.advance(1);
  assert.deepEqual(idleMessages(lonely).map((message) => message.reason), ['initial-grace']);

  const visited = await createHostRig();
  visited.openPanel();
  await visited.clock.advance(LIMITS.panelInitialGraceMs * 4);
  assert.equal(idleMessages(visited).length, 0, 'a connected panel cancelled the initial grace');
});

test('when the last lane ends and nobody is watching, the grace starts (5.7 step 6)', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  await up(rigH, 'tab');
  panel.port.disconnect();                       // the panel goes away while the lane runs
  await rigH.clock.advance(100);
  await rigH.send(makeMessage('host/lane-stop'));
  await rigH.clock.advance(LIMITS.panelGraceMs);
  assert.equal(idleMessages(rigH).length, 1);
});

// A host that is idle with no panel keeps asking the worker until it is closed: the worker answers {closed:false} while a Start of
// its own is in flight (6.9), and the hub's one-shot flag alone would leave the idle document and interp.host.v1.up behind for good.
/** An idle host whose panel just left; `times` are the fake-clock moments the worker was asked. */
async function idleHostAfterPanelLeft(answerOf) {
  const rigH = await createHostRig();
  const times = [];
  swAnswersIdle(rigH, (count, message) => { times.push(rigH.clock.now()); return answerOf(count, message); });
  const panel = rigH.openPanel();
  await rigH.settle();
  const baseline = rigH.clock.pending();
  const left = rigH.clock.now();
  panel.close();
  return { rigH, times, baseline, left };
}

test('sw/host-idle answered closed:false: the host reports again after 3 s, 6 s and 12 s until the worker closes it, then never again', async () => {
  const { rigH, times, baseline, left } = await idleHostAfterPanelLeft((count) => (count < 3 ? SW_KEEPS : SW_CLOSES));
  await rigH.clock.advance(LIMITS.panelGraceMs);
  assert.equal(idleMessages(rigH).length, 1);
  await rigH.clock.advance(2999);
  assert.equal(idleMessages(rigH).length, 1, 'the first repeat is 3 s after the report');
  await rigH.clock.advance(1);
  assert.equal(idleMessages(rigH).length, 2);
  await rigH.clock.advance(5999);
  assert.equal(idleMessages(rigH).length, 2, 'the second is 6 s after the first');
  await rigH.clock.advance(1);
  assert.equal(idleMessages(rigH).length, 3);
  await rigH.clock.advance(600000);
  assert.equal(idleMessages(rigH).length, 3, 'closed:true ends the chain');
  assert.deepEqual(times, [left + 3000, left + 6000, left + 12000]);
  assert.deepEqual(idleMessages(rigH).map((message) => message.reason), ['panel-gone', 'panel-gone', 'panel-gone']);
  assert.equal(rigH.clock.pending(), baseline, 'no timer of the chain is left');
});

test('a worker that keeps answering closed:false is asked four times in all (the report and three repeats), then left alone with no timer', async () => {
  const { rigH, times, baseline, left } = await idleHostAfterPanelLeft(() => SW_KEEPS);
  await rigH.clock.advance(LIMITS.panelGraceMs + 3000 + 6000 + 12000);
  assert.equal(idleMessages(rigH).length, 4);
  assert.deepEqual(times, [left + 3000, left + 6000, left + 12000, left + 24000]);
  assert.equal(rigH.clock.pending(), baseline, 'the cap ended the chain: nothing is pending');
  await rigH.clock.advance(600000);
  assert.equal(idleMessages(rigH).length, 4, 'no fifth report, ever');
  assert.equal(rigH.clock.pending(), baseline);
});

test('a closed answer and a refusal are final: the host does not ask again', async () => {
  for (const answer of [SW_CLOSES, { ok: false, code: 'FORBIDDEN' }]) {
    const { rigH, baseline } = await idleHostAfterPanelLeft(() => answer);
    await rigH.clock.advance(LIMITS.panelGraceMs + 600000);
    assert.equal(idleMessages(rigH).length, 1, JSON.stringify(answer));
    assert.equal(rigH.clock.pending(), baseline);
  }
});

test('a panel that connects while a repeat is pending cancels it; its next absence starts the ladder again at 3 s', async () => {
  const { rigH, times, baseline, left } = await idleHostAfterPanelLeft(() => SW_KEEPS);
  await rigH.clock.advance(LIMITS.panelGraceMs);
  assert.equal(idleMessages(rigH).length, 1);
  assert.equal(rigH.clock.pending(), baseline + 1, 'the repeat is pending');
  await rigH.clock.advance(1000);
  const back = rigH.openPanel();
  await rigH.settle();
  assert.equal(rigH.clock.pending(), baseline, 'a connected panel cancelled the repeat');
  await rigH.clock.advance(600000);
  assert.equal(idleMessages(rigH).length, 1);

  const again = rigH.clock.now();
  back.close();
  await rigH.clock.advance(LIMITS.panelGraceMs + 3000 + 6000 + 12000);
  assert.equal(idleMessages(rigH).length, 5, 'one report and three repeats more: the cap was whole again');
  assert.deepEqual(times, [left + 3000, again + 3000, again + 6000, again + 12000, again + 24000]);
  assert.equal(rigH.clock.pending(), baseline);
});

test('a pending repeat dies with the host: dispose cancels the timer and nothing is sent afterwards', async () => {
  const { rigH, baseline } = await idleHostAfterPanelLeft(() => SW_KEEPS);
  await rigH.clock.advance(LIMITS.panelGraceMs);
  assert.equal(idleMessages(rigH).length, 1);
  assert.equal(rigH.clock.pending(), baseline + 1);
  await rigH.host().dispose();
  assert.ok(rigH.clock.pending() <= baseline, 'the repeat timer is gone');
  await rigH.clock.advance(600000);
  assert.equal(idleMessages(rigH).length, 1);
  assert.ok(rigH.clock.pending() <= baseline);
});

test('end to end with the real worker: a Start still in flight when the host reports idle -> the report is repeated and the idle document is closed', async () => {
  const browser = createFakeBrowser({ messages: { menuOpen: 'Interpret this tab' } });
  const audio = createFakeAudioEnv({ browser, sockets: createSocketFixture() });
  browser.sw.idleTimeoutMs = 1e12;
  browser.onCreateOffscreen = (context) => {
    createLaneHost({ adapter: { runtime: context.chrome.runtime }, env: audio.env, timers: browser.clock, hostId: 'h-idle-1' }).start();
  };
  browser.addTab({ id: 5, url: 'https://claude.ai/doc', active: true });
  browser.sw.register((chromeApi) => {
    createServiceWorker({ adapter: createChromeAdapter(chromeApi), now: browser.clock.now, setTimeout: browser.clock.setTimeout }).register();
  });
  const settle = async () => { await browser.settle(); await tick(); await browser.settle(); };
  const seed = browser.createContext('options');
  await seed.chrome.storage.local.set({ [STORAGE_KEYS.key]: { v: 1, value: fakeKey('idle') } });
  seed.close();
  const answers = () => browser.deliveries.filter((entry) => entry.kind === 'response' && entry.from === 'sw' && /"closed"/.test(entry.json))
    .map((entry) => JSON.parse(entry.json).closed);

  await browser.clickAction(5);
  await settle();
  audio.setGetUserMediaMode('held');                        // a slow tab getUserMedia keeps the Start in flight at the worker
  const panel = browser.createContext('panel', { windowId: 1 });
  const started = panel.chrome.runtime.sendMessage(makeMessage('sw/lane-start', { lane: 'tab', tabId: 5 }));
  await settle();
  assert.equal(audio.pendingGetUserMedia(), 1);
  panel.chrome.runtime.connect({ name: PORT_NAMES.panel }).postMessage(makeFrame('hello'));
  await settle();
  panel.close();

  // The grace fires, the host's stop waits startSettleMs for the Start, then it reports: the worker still has the Start in flight.
  await browser.clock.advance(LIMITS.panelGraceMs + LIMITS.startSettleMs + 100);
  await settle();
  assert.deepEqual(answers(), [false], 'the worker refused to close while its Start was in flight');
  assert.ok(browser.offscreenDocument);

  audio.releaseGetUserMedia();                              // the Start ends (cancelled): everything is idle now
  await settle();
  assert.deepEqual(await started, { ok: false, code: 'START_CANCELLED' });
  assert.equal(browser.captures.size, 0);
  await browser.clock.advance(120000);
  await settle();
  assert.deepEqual(answers(), [false, true], 'the host asked again and the worker closed it');
  assert.equal(browser.offscreenDocument, null, 'the idle document is gone');
  assert.equal(browser.storageData('session')[STORAGE_KEYS.host].up, false, 'and the host flag with it');
  assert.equal(browser.storageData('session')[STORAGE_KEYS.lastStop].reason, 'panel-gone');
});

// ---------------------------------------------------------------------------------------------
// The overlay over the host.

test('overlay ports over the host: role, top frame, the routing policy, and hello gets style then the wanted captions', async () => {
  const rigH = await createHostRig();
  await up(rigH, 'tab');
  const good = rigH.openOverlay(5);
  await rigH.settle();
  assert.equal(good.disconnected, false);
  assert.deepEqual(typesOf(good), ['style', 'captions:tab']);
  assert.deepEqual(good.frames[0].style, { size: 1.5, position: 'bottom', display: 'dark', maxLines: 3, autoHideSeconds: 8 });

  const subframe = rigH.openOverlay(5, { frameId: 1, fresh: true });
  rigH.browser.addTab({ id: 6, url: 'https://other.test/', active: false });
  const otherTab = rigH.openOverlay(6);
  const wrongRole = rigH.openPanel({ name: PORT_NAMES.overlay });
  const stranger = rigH.openPanel({ name: 'someone-else/1', hello: false });
  await rigH.settle();
  assert.equal(subframe.disconnected, true, 'not the top frame');
  assert.equal(otherTab.disconnected, true, 'no lane feeds tab 6');
  assert.equal(wrongRole.disconnected, true, 'a panel is not a content script');
  assert.equal(stranger.disconnected, false);
  assert.equal(good.disconnected, false, 'and the good port was never touched by the refusals');
});

test('overlay routing: the tab lane feeds only its captured tab; the mic lane ONLY the tab you look at, never a background tab', async () => {
  const rigH = await createHostRig();
  rigH.browser.addTab({ id: 6, url: 'https://looking.test/', active: false });
  const tab = await up(rigH, 'tab');
  const mic = await up(rigH, 'mic', { model: 'gemini-3.8-live', captions: true });
  const captured = rigH.openOverlay(5);
  // The SW asks first: tab 6 is the one you look at.
  assert.deepEqual(await rigH.send(makeMessage('host/overlay-wanted', { tabId: 6, active: true })), { ok: true, wanted: true, lanes: ['mic'] });
  const watching = rigH.openOverlay(6);
  await rigH.settle();
  assert.deepEqual(typesOf(captured), ['style', 'captions:tab'], 'no mic frame for the captured tab while you look at another');
  assert.deepEqual(typesOf(watching), ['style', 'captions:mic']);

  content(tab.socket, { outputTranscription: { text: 'from the tab audio' } });
  content(mic.socket, { outputTranscription: { text: 'my own speech' } });
  await tick();
  await rigH.clock.advance(150);
  const rowsOf = (overlay, lane) => overlay.frames.filter((frame) => frame.type === 'captions' && frame.lane === lane).at(-1)?.rows.map((row) => row.text);
  assert.deepEqual(rowsOf(captured, 'tab'), ['from the tab audio']);
  assert.equal(rowsOf(captured, 'mic'), undefined, 'no mic frame at all for the captured tab');
  assert.deepEqual(rowsOf(watching, 'mic'), ['my own speech']);
  assert.equal(watching.frames.some((frame) => frame.lane === 'tab' && frame.type === 'captions'), false, 'the tab lane never reaches another tab');
  assert.equal(captured.frames.some((frame) => frame.lane === 'mic'), false, 'your speech never reaches a background tab');

  // You switch to the captured tab: the old port is cleared and closed, the new one gets the latest frame.
  const wantedNow = await rigH.send(makeMessage('host/overlay-wanted', { tabId: 5, active: true }));
  assert.deepEqual(wantedNow, { ok: true, wanted: true, lanes: ['tab', 'mic'] });
  await rigH.settle();
  assert.deepEqual(typesOf(watching).slice(-2), ['clear:mic', 'bye'], 'clear {mic} to the old port, then bye: no lane needs it any more');
  assert.deepEqual(captured.frames.filter((frame) => frame.lane === 'mic').at(-1).rows.map((row) => row.text), ['my own speech'],
    'the latest mic frame went to the new tab');
  await rigH.clock.advance(300);
  assert.equal(watching.disconnected, true);
  assert.equal(captured.disconnected, false);
  content(mic.socket, { outputTranscription: { text: 'more speech' } });
  await tick();
  await rigH.clock.advance(150);
  assert.ok(rowsOf(captured, 'mic').join(' ').includes('more speech'), 'and your speech follows you to the tab you look at now');
  assert.equal(typesOf(watching).at(-1), 'bye', 'the old tab hears nothing more');
});

test('overlay: a lane that goes reconnecting says so, and running when it is back; the rows stay', async () => {
  const rigH = await createHostRig();
  const tab = await up(rigH, 'tab');
  const overlay = rigH.openOverlay(5);
  await rigH.settle();
  tab.socket.json({ error: { code: 503 } });        // UNAVAILABLE: the engine replaces the session
  for (let step = 0; step < 20 && !overlay.frames.some((frame) => frame.type === 'status'); step += 1) await tick();
  assert.deepEqual(overlay.last('status'), { v: 1, type: 'status', lane: 'tab', phase: 'reconnecting' });
  const sockets = rigH.sockets.sockets.length;
  for (let elapsed = 0; rigH.sockets.sockets.length === sockets && elapsed < 5000; elapsed += 250) {
    tab.worklet.emitFrames(0.25);
    await rigH.clock.advance(250);
  }
  const replacement = rigH.sockets.sockets.at(-1);
  assert.notEqual(replacement, tab.socket, 'a replacement session was opened');
  replacement.open();
  replacement.json({ setupComplete: {} });
  await tick();
  await rigH.clock.advance(100);
  assert.deepEqual(overlay.last('status'), { v: 1, type: 'status', lane: 'tab', phase: 'running' });
});

test('overlay: a lane that ends in error sends status stopped, then clear, and bye only after statusLingerMs', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  const tab = await up(rigH, 'tab');
  const overlay = rigH.openOverlay(5);
  await rigH.settle();
  tab.socket.json({ error: { code: 401 } });
  for (let step = 0; step < 100 && !overlay.frames.some((frame) => frame.type === 'clear'); step += 1) await tick();
  const tail = typesOf(overlay).slice(-2);
  assert.deepEqual(tail, ['status:tab', 'clear:tab'], 'the reason is shown BEFORE the rows are cleared');
  assert.equal(overlay.last('status').phase, 'stopped');
  await rigH.clock.advance(LIMITS.statusLingerMs - 1);
  assert.equal(typesOf(overlay).includes('bye'), false, 'the port stays so the stopped row can be read');
  await rigH.clock.advance(1);
  assert.equal(typesOf(overlay).at(-1), 'bye');
  await rigH.clock.advance(300);
  assert.equal(overlay.disconnected, true);
  assert.equal(panel.last('state').state.lanes.tab.errorCode, 'INVALID_KEY');
});

test('overlay: after a requested stop the rows are cleared and the port is told bye at once (no status row)', async () => {
  const rigH = await createHostRig();
  await up(rigH, 'tab');
  const overlay = rigH.openOverlay(5);
  await rigH.settle();
  await rigH.send(makeMessage('host/lane-stop', { lane: 'tab' }));
  await rigH.settle();
  assert.deepEqual(typesOf(overlay).slice(-2), ['clear:tab', 'bye']);
  assert.equal(overlay.frames.some((frame) => frame.type === 'status'), false, 'a lane stopped by the user gets no status');
});

test('a second lane keeps a lingering port open: a requested stop of one lane does not close the other\'s status row early', async () => {
  const rigH = await createHostRig();
  const tab = await up(rigH, 'tab');
  await up(rigH, 'mic', { model: 'gemini-3.8-live', captions: true });
  const overlay = rigH.openOverlay(5);
  await rigH.send(makeMessage('host/overlay-wanted', { tabId: 5, active: true }));
  await rigH.settle();
  tab.socket.json({ error: { code: 401 } });
  for (let step = 0; step < 100 && !overlay.frames.some((frame) => frame.type === 'status'); step += 1) await tick();
  await rigH.send(makeMessage('host/lane-stop', { lane: 'mic' }));
  await rigH.settle();
  assert.equal(typesOf(overlay).includes('bye'), false, 'the tab lane\'s stopped row is still being shown');
  await rigH.clock.advance(LIMITS.statusLingerMs);
  assert.equal(typesOf(overlay).includes('bye'), true);
});

test('frames are throttled to LIMITS.frameIntervalMs per key: at most 10 per second', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  const tab = await up(rigH, 'tab');
  await rigH.clock.advance(200);
  const start = rigH.clock.now();
  for (let step = 0; step < 10; step += 1) {
    for (let burst = 0; burst < 5; burst += 1) {
      content(tab.socket, { outputTranscription: { text: `word ${step}-${burst}` } });
      tab.worklet.emitFrames(0.1 + (burst % 3) * 0.05);
    }
    await tick();
    await rigH.clock.advance(100);
  }
  const inWindow = (predicate) => panel.frames.filter((frame, index) => predicate(frame) && panel.times[index] >= start && panel.times[index] < start + 1000);
  const captions = inWindow((frame) => frame.type === 'captions' && frame.lane === 'tab');
  const states = inWindow((frame) => frame.type === 'state');
  assert.ok(captions.length > 3, `captions did flow (${captions.length})`);
  assert.ok(captions.length <= 10, `captions per second: ${captions.length}`);
  assert.ok(states.length <= 10, `states per second: ${states.length}`);
  await rigH.clock.advance(200);
  const last = panel.frames.filter((frame) => frame.type === 'captions' && frame.lane === 'tab').at(-1);
  assert.ok(last.rows.at(-1).text.endsWith('word 9-4'), 'the trailing send carries the newest rows');
});

test('privacy: the key appears in exactly one delivery per lane (its host/lane-start); no frame or response carries a key, a stream id or a session id', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  const tabKey = fakeKey('tab-secret'), micKey = fakeKey('mic-secret');
  const streamId = await rigH.tabStreamId(5);
  const started = await rigH.startLane('tab', { key: tabKey, streamId });
  assert.equal(started.ok, true);
  const tab = await rigH.connect({ worklet: 0, socket: 0 });
  await up(rigH, 'mic', { key: micKey, model: 'gemini-3.8-live', captions: true });
  const overlay = rigH.openOverlay(5);
  await rigH.send(makeMessage('host/overlay-wanted', { tabId: 5, active: true }));
  content(tab.socket, { outputTranscription: { text: 'plain caption text' } });
  await tick();
  await rigH.clock.advance(300);
  tab.socket.json({ error: { code: 401 } });
  for (let step = 0; step < 100; step += 1) await tick();
  await rigH.send(makeMessage('host/lane-stop'));
  panel.close();
  await rigH.clock.advance(LIMITS.panelGraceMs + LIMITS.statusLingerMs);

  const deliveries = rigH.browser.deliveries;
  const holding = (secret) => deliveries.filter((entry) => entry.json.includes(secret));
  assert.deepEqual(holding(tabKey).map((entry) => entry.kind), ['message'], 'the tab key: one message delivery, nothing else');
  assert.deepEqual(holding(micKey).map((entry) => entry.kind), ['message']);
  assert.deepEqual(holding(streamId).map((entry) => entry.kind), ['message'], 'the stream id: the same single delivery');
  for (const entry of deliveries.filter((item) => item.kind === 'port-frame' || item.kind === 'response')) {
    assert.doesNotMatch(entry.json, /synthetic-/, `${entry.kind} carries no key-shaped text`);
    assert.doesNotMatch(entry.json, /sessionId|generation|metrics/, `${entry.kind} carries no engine internals`);
  }
  assert.ok(panel.frames.length > 0 && overlay.frames.length > 0);
  assert.equal(JSON.stringify(rigH.host().uiState()).includes('synthetic-'), false);
});

test('host.uiState() is the current UiState; dispose stops both lanes, says bye and removes the listeners', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  await up(rigH, 'tab');
  await up(rigH, 'mic', { model: 'gemini-3.8-live' });
  const overlay = rigH.openOverlay(5);
  await rigH.settle();
  const state = rigH.host().uiState();
  assert.equal(state.concurrent, 2);
  assert.deepEqual([state.lanes.tab.phase, state.lanes.mic.phase], ['running', 'running']);
  assert.equal(validateFrame('host->panel', { v: 1, type: 'state', state }).ok, true);

  await rigH.host().dispose();
  await rigH.settle();
  assert.equal(rigH.host().uiState().concurrent, 0);
  assert.equal(panel.frames.at(-1).type, 'bye');
  assert.equal(overlay.frames.at(-1).type, 'bye');
  assert.equal(panel.disconnected, true);
  assert.equal(overlay.disconnected, true);
  assert.equal(rigH.browser.captures.size, 0);
  await assert.rejects(rigH.send(makeMessage('host/ping')), /Receiving end does not exist/, 'the router is gone');
  await rigH.host().dispose();   // idempotent
});

// ---------------------------------------------------------------------------------------------
// The environment builders of host.js, and structural checks of the engine files (R5, R8, R9, R11, the key rule).

test('createRealmClock / createHostEnv wrap the scope: arrow wrappers, nothing read up front, isSecureContext strict', async () => {
  const calls = [];
  const scope = { setTimeout: function setTimeoutProbe(fn, ms) { calls.push(['set', this === scope, ms]); return 7; },
    clearTimeout: function clearTimeoutProbe(id) { calls.push(['clear', this === scope, id]); },
    performance: { now: () => 1234 }, fetch: function fetchProbe(...args) { calls.push(['fetch', this === scope, args]); return 'fetched'; },
    AudioContext: class {}, AudioWorkletNode: class {}, navigator: { mediaDevices: {} }, WebSocket: class {}, isSecureContext: true };
  const realm = createRealmClock(scope);
  const detached = realm.setTimeout;                    // called with no receiver, like the engine does
  assert.equal(detached(() => {}, 5), 7);
  realm.clearTimeout(7);
  assert.equal(realm.now(), 1234);
  assert.deepEqual(calls, [['set', true, 5], ['clear', true, 7]], 'the native function still gets the scope as its receiver');

  const engineClock = { setTimeout: () => 1, clearTimeout: () => {}, now: () => 9 };
  const env = createHostEnv(scope, engineClock);
  assert.equal(Object.isFrozen(env), true);
  assert.equal(env.setTimeout, engineClock.setTimeout, 'the ENGINE clock is what env carries');
  assert.equal(env.now(), 9);
  assert.equal(env.AudioContext, scope.AudioContext);
  assert.equal(env.navigator, scope.navigator);
  assert.equal(env.isSecureContext, true);
  assert.equal(env.fetch('a', 'b'), 'fetched');
  assert.deepEqual(calls.at(-1), ['fetch', true, ['a', 'b']]);
  const random = env.random();
  assert.ok(random >= 0 && random < 1);
  assert.equal(createHostEnv({ ...scope, isSecureContext: 'yes' }, engineClock).isSecureContext, false, 'only a literal true counts');
  assert.equal(createHostEnv({}, engineClock).AudioContext, undefined, 'a missing capability is undefined, not a throw');
});

const ENGINE_DIR = new URL('../extension/engine/', import.meta.url);
const ENGINE_FILES = readdirSync(ENGINE_DIR).filter((name) => name.endsWith('.js')).sort();
const readEngine = (name) => readFileSync(new URL(name, ENGINE_DIR), 'utf8');
// Comments, then string and template literals, so a justification string never trips an identifier scan.
const codeOf = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``').replace(/'(?:\\.|[^'\\\n])*'/g, "''").replace(/"(?:\\.|[^"\\\n])*"/g, '""');

test('the engine directory holds exactly the files of the module map', () => {
  assert.deepEqual(ENGINE_FILES, ['audio-graph.js', 'host.js', 'lane-engine.js', 'lane-host.js', 'mic-lane.js', 'overlay-hub.js',
    'panel-hub.js', 'platform-shim.js', 'tab-lane.js', 'timer-worker.js', 'worker-timers.js']);
});

test('host.html: an empty title and exactly one module script, nothing else; host.js is a five-line composition', () => {
  const html = readFileSync(new URL('host.html', ENGINE_DIR), 'utf8');
  const body = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.deepEqual(body.match(/<script\b[^>]*>/g), ['<script type="module" src="./host.js">']);
  assert.match(body, /<title><\/title>/);
  assert.doesNotMatch(body, /<(link|meta|style|img|iframe|div|p|span|button)\b|\son[a-z]+=|https?:\/\//i);
  assert.equal(body.replace(/<[^>]+>/g, '').trim(), '', 'no literal text between tags');

  const host = codeOf(readEngine('host.js'));
  assert.match(host, /createChromeAdapter\(\)/);
  assert.match(host, /createLaneHost\(\{[^}]*adapter: createChromeAdapter\(\)/);
  assert.match(host, /\.start\(\);/);
  assert.match(host, /createEngineClock\(/);
  assert.equal((readEngine('host.js').match(/^import /gm) ?? []).length, 3);
});

test('R5/R8/R11 over the engine files: allowed imports only, no chrome/browser identifier, no logging, no eval, no innerHTML, no storage APIs', () => {
  const allowed = new Set(['../../app/config.js', '../../app/engine/sim.js', '../../app/platform.js',
    '../../app/providers/gemini/live-config.js']);
  for (const name of ENGINE_FILES) {
    const source = readEngine(name);
    const code = codeOf(source);
    for (const [, specifier] of source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)) {
      assert.ok(specifier.startsWith('./') || specifier.startsWith('../lib/') || allowed.has(specifier), `${name}: ${specifier}`);
      assert.match(specifier, /\.js$/);
    }
    assert.doesNotMatch(code, /\b(chrome|browser)\b/, `${name}: no chrome/browser identifier (R8)`);
    assert.doesNotMatch(code, /\bconsole\s*\.|\beval\s*\(|new\s+Function\b|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|importScripts|\bdebugger\b/, name);
    assert.doesNotMatch(code, /\b(localStorage|sessionStorage|indexedDB)\b/, name);
    assert.doesNotMatch(code, /\bawait\s+import\s*\(|\brequire\s*\(/, name);
    assert.doesNotMatch(source, /synthetic-|AIza|https?:\/\/(?!$)/, `${name}: no key-shaped or URL literal`);
  }
  // The identifier of the key exists in ONE file: everything else hands the start parameters over untouched.
  for (const name of ENGINE_FILES.filter((file) => file !== 'lane-engine.js')) {
    assert.doesNotMatch(codeOf(readEngine(name)), /\.key\b|\bapiKey\b|\{\s*key\b|\bkey\s*:\s*(?!kindOf)/, `${name}: the API key is named only in lane-engine.js`);
  }
  assert.match(codeOf(readEngine('lane-engine.js')), /setPersonal\(''\s*,\s*key\)/, 'the one place the key is used (string literals are stripped by codeOf)');
  assert.equal((codeOf(readEngine('lane-engine.js')).match(/\bsetPersonal\b/g) ?? []).length, 1);
  // The stream id is named only where the tab stream is acquired.
  for (const name of ENGINE_FILES.filter((file) => file !== 'tab-lane.js')) {
    assert.doesNotMatch(codeOf(readEngine(name)), /\bstreamId\b/, `${name}: the tab stream id lives in tab-lane.js only`);
  }
});

test('R9: importing an engine module touches no global (throwing getters on every environment global)', async () => {
  const names = ['chrome', 'document', 'window', 'localStorage', 'sessionStorage', 'indexedDB', 'AudioContext', 'AudioWorkletNode',
    'Worker', 'WebSocket', 'fetch', 'navigator'];
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const touched = [];
  for (const name of names) {
    Object.defineProperty(globalThis, name, { configurable: true, get() { touched.push(name); throw new Error(`touched ${name}`); } });
  }
  try {
    for (const name of ENGINE_FILES.filter((file) => !['host.js', 'timer-worker.js'].includes(file))) {
      await import(`../extension/engine/${name}?purity=${Date.now()}`);
    }
  } finally {
    for (const name of names) {
      const descriptor = saved.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
  assert.deepEqual(touched, []);
});

// ---------------------------------------------------------------------------------------------
// The entry file itself, and what a panel keeps after an error.

test('host.js (the entry file, R10) builds the real adapter and starts a host that answers the service worker', async (t) => {
  const installed = [];
  const install = (name, value) => {
    installed.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  t.after(() => {
    for (const [name, descriptor] of installed.reverse()) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  const rigH = await createHostRig({ boot: async (context, rig) => {
    install('chrome', context.chrome);            // the offscreen fake: `runtime` only, exactly like the real document
    install('AudioContext', rig.env.AudioContext);
    install('AudioWorkletNode', rig.env.AudioWorkletNode);
    await import(`../extension/engine/host.js?boot=${Date.now()}`);
  } });
  const ping = await rigH.send(makeMessage('host/ping'));
  assert.equal(ping.ok, true);
  assert.match(ping.hostId, /^h-[0-9a-z]{8}$/);
  assert.deepEqual(ping.lanes, { tab: 'off', mic: 'off' });
  // A panel connects (which also cancels the 15 s initial grace that runs on the REAL clock in this test).
  const panel = rigH.openPanel();
  await rigH.settle();
  assert.deepEqual(typesOf(panel), ['state', 'captions:tab', 'captions:mic']);
  assert.equal(panel.frames[0].state.hostId, ping.hostId);
});

test('a lane that ends in error keeps its last rows in the panel preview (marked not live); a requested stop clears them; a new run never shows an old run\'s rows', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  const tab = await up(rigH, 'tab');
  content(tab.socket, { outputTranscription: { text: 'last words' } });
  await tick();
  await rigH.clock.advance(150);
  const lastCaptions = () => panel.frames.filter((frame) => frame.type === 'captions' && frame.lane === 'tab').at(-1);
  assert.equal(lastCaptions().live, true);
  assert.deepEqual(lastCaptions().rows.map((row) => row.text), ['last words']);

  tab.socket.json({ error: { code: 401 } });
  for (let step = 0; step < 100 && panel.last('state').state.lanes.tab.phase !== 'error'; step += 1) await tick();
  await rigH.clock.advance(300);
  assert.equal(panel.last('state').state.lanes.tab.errorCode, 'INVALID_KEY');
  assert.deepEqual(lastCaptions().rows.map((row) => row.text), ['last words'], 'the failure did not wipe what was said');
  assert.equal(lastCaptions().live, false);

  // A panel that opens now sees the same.
  const late = rigH.openPanel();
  await rigH.settle();
  assert.deepEqual(late.last('captions', 'tab').rows.map((row) => row.text), ['last words']);

  // A run that fails before it says anything shows nothing of the old run.
  const failed = await rigH.startLane('tab', { streamId: 'not-a-stream', tabId: 6 });
  assert.deepEqual(failed, { ok: false, code: 'TAB_CAPTURE_FAILED' });
  await rigH.clock.advance(300);
  assert.deepEqual(lastCaptions().rows, []);
  assert.equal(lastCaptions().epoch, 2);

  // A requested stop clears the preview.
  const second = await up(rigH, 'tab', { tabId: 7 });
  content(second.socket, { outputTranscription: { text: 'again' } });
  await tick();
  await rigH.clock.advance(150);
  assert.deepEqual(lastCaptions().rows.map((row) => row.text), ['again']);
  await rigH.send(makeMessage('host/lane-stop', { lane: 'tab' }));
  await rigH.clock.advance(300);
  assert.deepEqual(lastCaptions().rows, []);
});

// ---------------------------------------------------------------------------------------------
// Two-way mode over the host: the pair comes in with host/lane-start, the rows come out labelled.

const TRANSLATE = 'gemini-3.5-live-translate-preview';
// One finished caption row: the model's output text, then the end of its turn, then the frame interval.
const say = async (rigH, socket, text) => {
  content(socket, { outputTranscription: { text } });
  content(socket, { turnComplete: true });
  await tick();
  await rigH.clock.advance(150);
};
const langsOf = (frame) => frame.rows.map((row) => row.lang);

test('two-way over the host: a translation-only model with a pair starts, the panel state names the real model, and rows carry their language to the panel and the overlay', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  const tab = await up(rigH, 'tab', { model: TRANSLATE, languages: ['ko', 'en'] });
  const overlay = rigH.openOverlay(5);
  await rigH.settle();
  assert.match(tab.socket.sent[0].setup.systemInstruction.parts[0].text, /two-way INTERPRETER between Korean and English/);
  assert.equal(rigH.sockets.sockets.length, 1);
  const lane = panel.last('state').state.lanes.tab;
  assert.deepEqual([lane.phase, lane.model, lane.route, lane.fallback, lane.targetLanguage, lane.errorCode],
    ['running', 'gemini-3.8-live', 'flash', false, 'ko', null], 'the state shows the model the engine moved to, not the chosen one');
  assert.equal(validateFrame('host->panel', panel.last('state')).ok, true);

  await say(rigH, tab.socket, 'Hello everyone, welcome');
  await say(rigH, tab.socket, '안녕하세요 여러분');
  for (const target of [panel, overlay]) {
    const frame = target.last('captions', 'tab');
    assert.deepEqual(frame.rows.map((row) => row.text), ['Hello everyone, welcome', '안녕하세요 여러분'], target === panel ? 'panel' : 'overlay');
    assert.deepEqual(langsOf(frame), ['en', 'ko']);
    assert.equal(frame.lang, 'ko', 'the frame lang is the newest row\'s (Korean)');
    assert.equal(validateFrame(target === panel ? 'host->panel' : 'host->overlay', frame).ok, true);
  }
  await say(rigH, tab.socket, 'Thank you all');
  assert.equal(panel.last('captions', 'tab').lang, 'en', 'and moves back to English with the next English row');
  assert.deepEqual(langsOf(overlay.last('captions', 'tab')), ['en', 'ko', 'en']);
  // a script outside the pair is labelled with the lane's own language, never with a language the lane does not speak
  await say(rigH, tab.socket, 'こんにちは');
  assert.equal(langsOf(panel.last('captions', 'tab')).at(-1), 'ko');

  // a panel that opens late gets the labelled rows too
  const late = rigH.openPanel();
  await rigH.settle();
  assert.deepEqual(langsOf(late.last('captions', 'tab')), ['en', 'ko', 'en', 'ko']);
});

test('two-way over the host: neither the key, the pair machinery, audio nor engine internals cross a port frame', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  const key = fakeKey('twoway-host');
  const tab = await up(rigH, 'tab', { key, model: TRANSLATE, languages: ['ja', 'ko'], targetLanguage: 'ja' });
  const overlay = rigH.openOverlay(5);
  await rigH.settle();
  content(tab.socket, audioContent);                 // synthetic model audio (never played: the fake context is silent)
  await say(rigH, tab.socket, 'こんにちは、みなさん');
  await say(rigH, tab.socket, '안녕하세요');
  tab.socket.json({ error: { code: 401 } });
  for (let step = 0; step < 100; step += 1) await tick();
  await rigH.send(makeMessage('host/lane-stop'));
  await rigH.clock.advance(LIMITS.statusLingerMs);
  // the two-way session really ran (a guard against passing because the pair was silently dropped)
  assert.match(tab.socket.sent[0].setup.systemInstruction.parts[0].text, /two-way INTERPRETER between Japanese and Korean/);
  assert.deepEqual(langsOf(overlay.frames.filter((frame) => frame.type === 'captions').at(-1)), ['ja', 'ko']);
  const frames = rigH.browser.deliveries.filter((entry) => entry.kind === 'port-frame' || entry.kind === 'response');
  assert.ok(frames.length > 0 && panel.frames.length > 0 && overlay.frames.length > 0);
  for (const entry of frames) {
    assert.doesNotMatch(entry.json, /synthetic-/, `${entry.kind}: no key-shaped text`);
    assert.doesNotMatch(entry.json, /AQD\/fw==|inlineData|audio\/pcm/, `${entry.kind}: no audio`);
    assert.doesNotMatch(entry.json, /sessionId|generation|metrics|systemInstruction|"languages"/, `${entry.kind}: no engine internals and no pair (the rows carry a lang, not the pair)`);
  }
  assert.deepEqual(rigH.browser.deliveries.filter((entry) => entry.json.includes(key)).map((entry) => entry.kind), ['message'], 'the key: one message delivery');
});

test('one-way over the host is unchanged: rows have no lang and the frame lang is the lane\'s language', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  const tab = await up(rigH, 'tab');
  const overlay = rigH.openOverlay(5);
  await rigH.settle();
  await say(rigH, tab.socket, 'Hello everyone');
  await say(rigH, tab.socket, '안녕하세요');
  for (const target of [panel, overlay]) {
    const frame = target.last('captions', 'tab');
    assert.equal(frame.rows.length, 2);
    assert.equal(frame.rows.some((row) => Object.hasOwn(row, 'lang')), false);
    assert.equal(frame.lang, 'ko');
  }
  assert.equal(panel.last('state').state.lanes.tab.model, TRANSLATE, 'and a one-way lane still reports the translation-only model');
});

test('two-way over the host: only the two-way lane labels its rows; the pair does not leak into the other lane', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  const tab = await up(rigH, 'tab', { model: TRANSLATE, languages: ['ko', 'en'] });
  const mic = await up(rigH, 'mic', { model: 'gemini-3.8-live', targetLanguage: 'en', captions: true });
  await say(rigH, tab.socket, 'Hello everyone');
  await say(rigH, mic.socket, 'Hello, can you hear me');
  assert.deepEqual(langsOf(panel.last('captions', 'tab')), ['en']);
  assert.deepEqual(langsOf(panel.last('captions', 'mic')), [undefined], 'the one-way microphone lane has no row lang');
  assert.equal(panel.last('captions', 'mic').lang, 'en');
  assert.match(mic.socket.sent[0].setup.systemInstruction.parts[0].text, /simultaneous INTERPRETER into English/);
});

test('a two-way run followed by a one-way run: the new run\'s rows are plain, the old pair is gone', async () => {
  const rigH = await createHostRig();
  const panel = rigH.openPanel();
  const first = await up(rigH, 'tab', { model: TRANSLATE, languages: ['ko', 'en'] });
  await say(rigH, first.socket, 'Hello everyone');
  assert.deepEqual(langsOf(panel.last('captions', 'tab')), ['en']);
  await rigH.send(makeMessage('host/lane-stop', { lane: 'tab' }));
  await rigH.clock.advance(300);
  const second = await up(rigH, 'tab', { tabId: 6 });
  await say(rigH, second.socket, 'Hello again');
  const frame = panel.last('captions', 'tab');
  assert.equal(frame.epoch, 2);
  assert.deepEqual(frame.rows.map((row) => row.text), ['Hello again']);
  assert.equal(Object.hasOwn(frame.rows[0], 'lang'), false);
  assert.equal(frame.lang, 'ko');
  assert.doesNotMatch(second.socket.sent[0].setup.systemInstruction?.parts[0].text ?? '', /two-way/);
});

test('host/lane-start with a pair that is not two distinct ko|en|ja languages is INVALID_MESSAGE: no engine, no epoch, no lane change', async () => {
  const rigH = await createHostRig();
  const valid = await rigH.laneStartMessage('mic', { model: 'gemini-3.8-live', targetLanguage: 'ko', languages: ['ko', 'en'] });
  assert.deepEqual(valid.request.languages, ['ko', 'en']);
  for (const languages of [['ko', 'ko'], ['ko', 'en', 'ja'], ['ko', 'fr'], ['ko'], 'ko,en', null, [1, 2]]) {
    const refused = await rigH.send({ ...valid, request: { ...valid.request, languages } });
    assert.deepEqual(refused, { ok: false, code: 'INVALID_MESSAGE' }, JSON.stringify(languages));
  }
  assert.equal(rigH.sockets.sockets.length, 0, 'no Live session was opened');
  assert.equal(rigH.audio.micStreams.length, 0, 'and no microphone');
  assert.equal((await rigH.send(makeMessage('host/ping'))).lanes.mic, 'off');
  assert.deepEqual(await rigH.send(valid), { ok: true, epoch: 1 }, 'the refusals consumed no epoch, and the same message with a good pair starts');
});
