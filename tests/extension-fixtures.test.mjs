// New implementation of docs/extension.md 11.1 (extension-fixtures), 11.2 and 11.3; no legacy code is ported.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_STREAM_ERROR, AUDIO_PLAYBACK_CLOSE_MS, CANNOT_CAPTURE_ERROR, FakeMediaStream, FakeTrack, GESTURE_ERROR, GRANT_ERROR,
  INVALIDATED_ERROR, INVALID_TAB_ERROR, MAX_MESSAGE_BYTES, NO_DOCUMENT_ERROR, NO_RECEIVER_ERROR, PORT_CLOSED_ERROR, REASON_ERROR,
  SINGLE_DOCUMENT_ERROR, STORAGE_DENIED_ERROR, STREAM_ID_TTL_MS, SW_IDLE_MS, createFakeBrowser, createFakeClock,
} from './fixtures/fake-chrome.mjs';
import { FakeAudioContext, FakeAudioWorkletNode, createFakeAudioEnv } from './fixtures/fake-audio.mjs';
import {
  FakeCSSStyleSheet, FakeElement, FakeEvent, createFakeDocument, parseHtml, runClassicScript,
} from './fixtures/extension-dom.mjs';
import { createSocketFixture } from './fixtures/live.mjs';

// Self-tests of the extension fixtures (docs/extension.md 11.1, 11.2, 11.3):
// what the fakes enforce is what a green test in groups B and C proves, so each
// behavior the contract promises is pinned here, including the strict gesture
// model and the fixed stream-id TTL. Nothing here touches a browser, a device
// or a clock: time is the fakes' virtual clock and every audio object is data.

const HOST = 'extension/engine/host.html';
const PANEL = 'extension/panel/panel.html';
const settle = () => new Promise((resolve) => setImmediate(resolve));
const errorOf = (promise) => promise.then(() => null, (error) => error);

// ---------------------------------------------------------------------------
// Virtual clock

test('clock: advance fires due timers in order and flushes microtasks between them', async () => {
  const clock = createFakeClock();
  const seen = [];
  clock.setTimeout(() => { seen.push('b'); Promise.resolve().then(() => seen.push('b-micro')); }, 200);
  clock.setTimeout(() => seen.push('a'), 100);
  const cancelled = clock.setTimeout(() => seen.push('cancelled'), 150);
  clock.clearTimeout(cancelled);
  clock.setTimeout(() => { seen.push('c'); clock.setTimeout(() => seen.push('nested'), 50); }, 250);
  assert.equal(clock.pending(), 3);
  await clock.advance(120);
  assert.deepEqual(seen, ['a']);
  assert.equal(clock.now(), 120);
  await clock.advance(200);
  assert.deepEqual(seen, ['a', 'b', 'b-micro', 'c', 'nested']);
  assert.equal(clock.pending(), 0);
  assert.equal(clock.now(), 320);
});

// ---------------------------------------------------------------------------
// Message bus

test('messages: JSON round trip in both directions (typed arrays become objects, Map becomes {})', async () => {
  const browser = createFakeBrowser();
  const received = [];
  browser.createContext('offscreen').chrome.runtime.onMessage.addListener((message, sender, respond) => {
    received.push(message);
    respond({ ok: true, typed: new Float32Array([1, 2]), map: new Map([[1, 2]]), gone: undefined });
    return true;
  });
  const panel = browser.createContext('panel');
  const original = { bytes: new Uint8Array([7, 8]), map: new Map([[1, 2]]), set: new Set([1]), nothing: undefined, nested: { list: [1, { deep: 2 }] } };
  const response = await panel.chrome.runtime.sendMessage(original);
  assert.deepEqual(received[0], { bytes: { 0: 7, 1: 8 }, map: {}, set: {}, nested: { list: [1, { deep: 2 }] } });
  assert.notEqual(received[0].nested, original.nested, 'the receiver got a copy, not the sender\'s object');
  assert.deepEqual(response, { ok: true, typed: { 0: 1, 1: 2 }, map: {} });
});

test('messages: the 64 MiB cap throws in the calling turn (ports too), other failures reject later', async () => {
  const browser = createFakeBrowser();
  const host = browser.createContext('offscreen');
  host.chrome.runtime.onMessage.addListener(() => false);
  host.chrome.runtime.onConnect.addListener(() => {});
  const panel = browser.createContext('panel');
  const big = { big: 'x'.repeat(MAX_MESSAGE_BYTES) };
  assert.throws(() => panel.chrome.runtime.sendMessage(big), /exceeded maximum allowed length/);
  const port = panel.chrome.runtime.connect({ name: 'p' });
  assert.throws(() => port.postMessage(big), /exceeded maximum allowed length/);
  const circular = {}; circular.self = circular;
  assert.throws(() => panel.chrome.runtime.sendMessage(circular), TypeError);
  browser.addTab({ id: 1, url: 'https://a.test/' });
  assert.throws(() => browser.sw.register(() => {}).chrome.tabs.sendMessage(1, big), /exceeded maximum allowed length/);
});

test('messages: fan-out reaches every other context, the first sendResponse wins, the sender is skipped', async () => {
  const browser = createFakeBrowser();
  const heard = [];
  const contexts = { panel: browser.createContext('panel'), options: browser.createContext('options'), offscreen: browser.createContext('offscreen') };
  for (const [name, context] of Object.entries(contexts)) {
    context.chrome.runtime.onMessage.addListener((message, sender, respond) => {
      heard.push(name);
      if (name !== 'panel') respond({ from: name });
      return false;
    });
  }
  const response = await contexts.panel.chrome.runtime.sendMessage({ hello: 1 });
  assert.deepEqual(heard.sort(), ['offscreen', 'options']);
  assert.deepEqual(response, { from: 'options' }, 'options answered first (delivery follows context creation order)');
});

test('messages: a listener that returns true keeps the channel open for an asynchronous response', async () => {
  const browser = createFakeBrowser();
  let respondLater;
  browser.createContext('offscreen').chrome.runtime.onMessage.addListener((message, sender, respond) => { respondLater = respond; return true; });
  const panel = browser.createContext('panel');
  let settled = false;
  const pending = panel.chrome.runtime.sendMessage({ q: 1 }).then((value) => { settled = true; return value; });
  await settle();
  assert.equal(settled, false);
  respondLater({ answer: 42 });
  respondLater({ answer: 'ignored' });
  assert.deepEqual(await pending, { answer: 42 });
});

test('messages: with no responder the promise rejects by default and resolves undefined in the other mode', async () => {
  for (const [mode, expectRejection] of [['reject', true], ['undefined', false]]) {
    const browser = createFakeBrowser({ noResponder: mode });
    browser.createContext('offscreen').chrome.runtime.onMessage.addListener(() => false);
    const panel = browser.createContext('panel');
    const outcome = await panel.chrome.runtime.sendMessage({ x: 1 }).then((value) => ({ value }), (error) => ({ error }));
    if (expectRejection) assert.equal(outcome.error?.message, PORT_CLOSED_ERROR);
    else assert.deepEqual(outcome, { value: undefined });
  }
  assert.throws(() => createFakeBrowser({ noResponder: 'sometimes' }), TypeError);
});

test('messages: no other context with a listener rejects with "Receiving end does not exist"', async () => {
  const browser = createFakeBrowser();
  const panel = browser.createContext('panel');
  panel.chrome.runtime.onMessage.addListener(() => false); // only the sender listens
  assert.equal((await errorOf(panel.chrome.runtime.sendMessage({}))).message, NO_RECEIVER_ERROR);
  assert.equal(NO_RECEIVER_ERROR, 'Could not establish connection. Receiving end does not exist.');
});

test('messages: a responder that goes away without answering ends like an unanswered message', async () => {
  const browser = createFakeBrowser();
  const host = browser.createContext('offscreen');
  host.chrome.runtime.onMessage.addListener(() => true);
  const panel = browser.createContext('panel');
  const pending = errorOf(panel.chrome.runtime.sendMessage({ q: 1 }));
  await settle();
  host.close();
  assert.equal((await pending).message, PORT_CLOSED_ERROR);
});

test('messages: a listener that throws is recorded, never thrown into the sender', async () => {
  const browser = createFakeBrowser();
  const boom = new Error('listener failed');
  browser.createContext('offscreen').chrome.runtime.onMessage.addListener(() => { throw boom; });
  const panel = browser.createContext('panel');
  const outcome = await errorOf(panel.chrome.runtime.sendMessage({ x: 1 }));
  assert.equal(outcome.message, PORT_CLOSED_ERROR, 'no listener answered');
  assert.deepEqual(browser.listenerErrors, [boom]);
});

test('messages: the deliveries log holds JSON text per request, response and port frame', async () => {
  const browser = createFakeBrowser();
  const marker = ['marker', String(12345)].join('-');
  const host = browser.createContext('offscreen');
  host.chrome.runtime.onMessage.addListener((message, sender, respond) => { respond({ ok: true }); return true; });
  host.chrome.runtime.onConnect.addListener((port) => { port.postMessage({ frame: 'from-host' }); });
  const panel = browser.createContext('panel');
  await panel.chrome.runtime.sendMessage({ secret: marker });
  const port = panel.chrome.runtime.connect({ name: 'interp-panel/1' });
  port.postMessage({ type: 'hello' });
  await settle();
  const kinds = browser.deliveries.map((entry) => `${entry.from}>${entry.to}:${entry.kind}`);
  assert.deepEqual(kinds, ['panel>offscreen:message', 'offscreen>panel:response', 'panel>offscreen:port-frame', 'offscreen>panel:port-frame']);
  assert.ok(browser.deliveries.every((entry) => typeof entry.json === 'string'));
  assert.equal(browser.deliveries.filter((entry) => entry.json.includes(marker)).length, 1);
  assert.equal(browser.deliveries.some((entry) => entry.to === 'content'), false);
});

test('contexts: content scripts never hear runtime.sendMessage; tabs.sendMessage reaches one tab; senders are shaped like Chrome\'s', async () => {
  const browser = createFakeBrowser();
  const workerSenders = [];
  const worker = browser.sw.register((chrome) => {
    chrome.runtime.onMessage.addListener((message, sender, respond) => { workerSenders.push(sender); respond({ ok: true, from: 'sw' }); return true; });
  });
  browser.addTab({ id: 1, url: 'https://a.test/page' });
  browser.addTab({ id: 2, url: 'https://b.test/other' });
  const heard = [];
  for (const id of [1, 2]) {
    browser.contentContext(id).chrome.runtime.onMessage.addListener((message, sender, respond) => { heard.push({ id, message, sender }); respond({ ok: true, tab: id }); return true; });
  }
  const panel = browser.createContext('panel');
  await panel.chrome.runtime.sendMessage({ toExtension: true });
  assert.deepEqual(heard, [], 'runtime.sendMessage from an extension page does not reach content scripts');

  const fromContent = await browser.contentContext(1).chrome.runtime.sendMessage({ fromContent: true });
  assert.deepEqual(fromContent, { ok: true, from: 'sw' });
  const contentSender = workerSenders.at(-1);
  assert.equal(contentSender.id, browser.extensionId);
  assert.equal(contentSender.tab.id, 1);
  assert.equal(contentSender.frameId, 0);
  assert.equal(contentSender.url, 'https://a.test/page');
  assert.equal(contentSender.origin, 'https://a.test');

  const reply = await worker.chrome.tabs.sendMessage(1, { v: 1, target: 'content' }, { frameId: 0 });
  assert.deepEqual(reply, { ok: true, tab: 1 });
  assert.deepEqual(heard.map((entry) => entry.id), [1]);
  assert.equal(heard[0].sender.tab, undefined, 'a message from the service worker carries no tab');
  assert.equal(heard[0].sender.id, browser.extensionId);
  assert.equal((await errorOf(worker.chrome.tabs.sendMessage(1, {}, { frameId: 3 }))).message, NO_RECEIVER_ERROR);
  assert.equal((await errorOf(worker.chrome.tabs.sendMessage(99, {}))).message, 'No tab with id: 99.');
});

test('contexts: sender url of the service worker is present or absent by mode; pages in tabs carry a tab', async () => {
  for (const swSenderHasUrl of [true, false]) {
    const browser = createFakeBrowser({ swSenderHasUrl });
    const worker = browser.sw.register(() => {});
    browser.addTab({ id: 3, url: 'https://a.test/' });
    const senders = [];
    browser.createContext('panel').chrome.runtime.onMessage.addListener((message, sender) => { senders.push(sender); return false; });
    await worker.chrome.runtime.sendMessage({ x: 1 }).catch(() => {});
    const sender = senders[0];
    assert.equal(sender.id, browser.extensionId);
    assert.equal(sender.origin, browser.origin);
    assert.equal(sender.tab, undefined);
    assert.equal(sender.frameId, undefined);
    assert.equal(sender.documentId, undefined);
    if (swSenderHasUrl) assert.equal(sender.url, browser.url('extension/background/service-worker.js'));
    else assert.equal('url' in sender, false);
    const optionsTab = browser.createContext('options', { tabId: 3 });
    assert.equal(optionsTab.sender.tab.id, 3);
    assert.equal(optionsTab.sender.frameId, 0);
    assert.equal(optionsTab.sender.origin, browser.origin);
    assert.equal(browser.createContext('panel').sender.tab, undefined);
  }
});

// ---------------------------------------------------------------------------
// Ports

test('ports: a connect fans out to every listening context; frames are JSON; replies go to the sender only', async () => {
  const browser = createFakeBrowser();
  const host = browser.createContext('offscreen');
  const options = browser.createContext('options');
  const ports = {}, frames = { host: [], options: [], panel: [] };
  for (const [name, context] of [['host', host], ['options', options]]) {
    context.chrome.runtime.onConnect.addListener((port) => {
      ports[name] = port;
      port.onMessage.addListener((frame) => frames[name].push(frame));
    });
  }
  const panel = browser.createContext('panel');
  const senderPort = panel.chrome.runtime.connect({ name: 'interp-panel/1' });
  senderPort.onMessage.addListener((frame) => frames.panel.push(frame));
  senderPort.postMessage({ type: 'hello', bytes: new Uint8Array([9]) });
  await settle();
  assert.equal(ports.host.name, 'interp-panel/1');
  assert.equal(ports.host.sender.url, browser.url(PANEL));
  assert.equal(ports.host.sender.tab, undefined);
  assert.deepEqual(frames.host, [{ type: 'hello', bytes: { 0: 9 } }]);
  assert.deepEqual(frames.options, frames.host, 'every receiver got the frame');
  ports.host.postMessage({ type: 'state' });
  await settle();
  assert.deepEqual(frames.panel, [{ type: 'state' }]);
  assert.deepEqual(frames.options.length, 1, 'the other receiver did not see the reply');
});

test('ports: a content script port reaches the offscreen document with the tab and frame of its sender', async () => {
  const browser = createFakeBrowser();
  browser.addTab({ id: 4, url: 'https://a.test/' });
  const host = browser.createContext('offscreen');
  let received;
  host.chrome.runtime.onConnect.addListener((port) => { received = port; });
  browser.contentContext(4).chrome.runtime.connect({ name: 'interp-overlay/1' });
  await settle();
  assert.equal(received.sender.tab.id, 4);
  assert.equal(received.sender.frameId, 0);
  assert.equal(received.sender.origin, 'https://a.test');
});

test('ports: a receiver disconnect notifies only the sender; a sender disconnect notifies every receiver', async () => {
  const browser = createFakeBrowser();
  const receivers = [];
  const disconnected = [];
  for (const kind of ['offscreen', 'options']) {
    browser.createContext(kind).chrome.runtime.onConnect.addListener((port) => {
      receivers.push([kind, port]);
      port.onDisconnect.addListener(() => disconnected.push(kind));
    });
  }
  const panel = browser.createContext('panel');
  let first = panel.chrome.runtime.connect({ name: 'x' });
  first.onDisconnect.addListener(() => disconnected.push('sender-1'));
  await settle();
  receivers.find(([kind]) => kind === 'options')[1].disconnect();
  await settle();
  assert.deepEqual(disconnected, ['sender-1'], 'only the sender heard the receiver leave; the other receiver was not told');

  disconnected.length = 0; receivers.length = 0;
  first = panel.chrome.runtime.connect({ name: 'y' });
  first.onDisconnect.addListener(() => disconnected.push('sender-2'));
  await settle();
  first.disconnect();
  await settle();
  assert.deepEqual(disconnected.sort(), ['offscreen', 'options'], 'every receiver heard the sender leave, the sender did not');
  assert.throws(() => first.postMessage({}), /disconnected port/);
});

test('ports: unload and navigation notify peers; a port with no receiver disconnects at once', async () => {
  const browser = createFakeBrowser();
  browser.addTab({ id: 6, url: 'https://a.test/' });
  const host = browser.createContext('offscreen');
  const events = [];
  host.chrome.runtime.onConnect.addListener((port) => port.onDisconnect.addListener(() => events.push(`host:${port.name}`)));
  browser.contentContext(6).chrome.runtime.connect({ name: 'overlay' });
  const panel = browser.createContext('panel');
  panel.chrome.runtime.connect({ name: 'panel' });
  await settle();
  await browser.navigate(6, 'https://b.test/');
  assert.deepEqual(events, ['host:overlay'], 'navigation destroyed the content script and its port');
  panel.close();
  await settle();
  assert.deepEqual(events, ['host:overlay', 'host:panel'], 'a closed page notifies its peers');

  const empty = createFakeBrowser();
  const lonely = empty.createContext('options').chrome.runtime.connect({ name: 'nobody' });
  let error;
  lonely.onDisconnect.addListener((port) => { error = port.error; });
  assert.equal(error, undefined, 'the disconnect is asynchronous');
  await settle();
  assert.equal(error?.message, NO_RECEIVER_ERROR);
  assert.throws(() => lonely.postMessage({}), /disconnected port/);

  const closing = createFakeBrowser();
  closing.createContext('offscreen').chrome.runtime.onConnect.addListener(() => {});
  const gone = closing.contexts()[0];
  const early = closing.createContext('panel').chrome.runtime.connect({ name: 'early' });
  let earlyError;
  early.onDisconnect.addListener((port) => { earlyError = port.error; });
  gone.close();
  await settle();
  assert.equal(earlyError?.message, NO_RECEIVER_ERROR, 'the only receiver closed before delivery');
});

// ---------------------------------------------------------------------------
// Service worker idle model

test('service worker: idles out after 30 s of fake time, revives on the next event, stale closures fail', async () => {
  const browser = createFakeBrowser();
  const bootstraps = [];
  browser.sw.register((chrome) => {
    bootstraps.push(chrome);
    chrome.runtime.onMessage.addListener((message, sender, respond) => { respond({ boots: bootstraps.length }); return false; });
  });
  assert.equal(SW_IDLE_MS, 30000);
  assert.equal(browser.sw.idleTimeoutMs, 30000);
  assert.equal(browser.sw.running, true);
  assert.equal(browser.sw.starts, 1);
  await browser.clock.advance(29999);
  assert.equal(browser.sw.running, true);
  await browser.clock.advance(1);
  assert.equal(browser.sw.running, false);
  assert.throws(() => bootstraps[0].runtime.getURL(''), { message: INVALIDATED_ERROR });
  const panel = browser.createContext('panel');
  assert.deepEqual(await panel.chrome.runtime.sendMessage({}), { boots: 2 });
  assert.equal(browser.sw.starts, 2);
  assert.equal(browser.sw.running, true);
});

test('service worker: a delivered event, an API call and a port message reset the idle timer; opening a port does not', async () => {
  const browser = createFakeBrowser();
  browser.sw.register((chrome) => {
    chrome.runtime.onMessage.addListener(() => false);
    chrome.runtime.onConnect.addListener((port) => port.onMessage.addListener(() => {}));
  });
  const panel = browser.createContext('panel');
  const alive = async (ms) => { await browser.clock.advance(ms); return browser.sw.running; };

  await browser.clock.advance(20000);
  await panel.chrome.runtime.sendMessage({}).catch(() => {});      // a delivered event: idle restarts at 20000
  assert.equal(await alive(29999), true);
  assert.equal(await alive(1), false, 'died 30000 after the message, at fake time 50000');

  const port = panel.chrome.runtime.connect({ name: 'p' });
  await settle();
  assert.equal(browser.sw.running, true, 'a port opened against a dead worker wakes it');
  await browser.clock.advance(10000);
  const second = panel.chrome.runtime.connect({ name: 'q' });
  await settle();
  assert.equal(await alive(19999), true);
  assert.equal(await alive(1), false, 'opening the second port at +10000 did not extend the life of the worker');
  port.disconnect(); second.disconnect();

  const fresh = createFakeBrowser();
  const chromes = [];
  fresh.sw.register((chrome) => { chromes.push(chrome); chrome.runtime.onConnect.addListener((p) => p.onMessage.addListener(() => {})); });
  await fresh.clock.advance(20000);
  const link = fresh.createContext('panel').chrome.runtime.connect({ name: 'p' });
  await settle();
  link.postMessage({ x: 1 });                                       // a port message: idle restarts at 20000
  await settle();
  await fresh.clock.advance(29999);
  assert.equal(fresh.sw.running, true);
  await fresh.clock.advance(1);
  assert.equal(fresh.sw.running, false);

  const calls = createFakeBrowser();
  const worker = calls.sw.register(() => {});
  await calls.clock.advance(20000);
  await worker.chrome.storage.local.get();                          // an extension API call: idle restarts at 20000
  await calls.clock.advance(29999);
  assert.equal(calls.sw.running, true);
  await calls.clock.advance(1);
  assert.equal(calls.sw.running, false);
});

test('service worker: only events it registered before dying wake it; register() reruns bootstrap at every start', async () => {
  const browser = createFakeBrowser();
  let starts = 0;
  const removed = [];
  browser.sw.register((chrome) => {
    starts++;
    chrome.runtime.onMessage.addListener(() => false);
    chrome.tabs.onRemoved.addListener((tabId) => removed.push(tabId));
  });
  browser.addTab({ id: 1, url: 'https://a.test/' });
  browser.addTab({ id: 2, url: 'https://a.test/two' });
  browser.sw.kill();
  assert.equal(browser.sw.running, false);
  await browser.navigate(1, 'https://a.test/next');            // tabs.onUpdated was never registered
  await browser.activateTab(2);                                 // neither was tabs.onActivated
  assert.equal(browser.sw.running, false);
  assert.equal(starts, 1);
  await browser.closeTab(1);                                    // tabs.onRemoved was
  assert.equal(browser.sw.running, true);
  assert.equal(starts, 2);
  assert.deepEqual(removed, [1]);
  assert.throws(() => browser.sw.register('nope'), TypeError);
  const failing = createFakeBrowser();
  assert.throws(() => failing.sw.register(() => { throw new Error('bootstrap failed'); }), { message: 'bootstrap failed' });
});

test('service worker: startup() and install() run the registered listeners (reviving a dead worker first)', async () => {
  const browser = createFakeBrowser();
  const seen = [];
  browser.sw.register((chrome) => {
    chrome.runtime.onStartup.addListener(() => seen.push('startup'));
    chrome.runtime.onInstalled.addListener((details) => seen.push(`installed:${details.reason}`));
  });
  browser.sw.kill();
  await browser.startup();
  await browser.install('update');
  assert.deepEqual(seen, ['startup', 'installed:update']);
  assert.equal(browser.sw.starts, 2);
});

// ---------------------------------------------------------------------------
// Offscreen document

test('offscreen: one document, validated reasons, a runtime of exactly six members, close errors', async () => {
  const browser = createFakeBrowser();
  const { chrome } = browser.sw.register(() => {});
  const justification = 'run the interpretation engine';
  assert.equal((await errorOf(chrome.offscreen.createDocument({ url: HOST, reasons: [], justification }))).message, REASON_ERROR);
  assert.equal((await errorOf(chrome.offscreen.createDocument({ url: HOST, reasons: ['NOT_A_REASON'], justification }))).message, REASON_ERROR);
  assert.equal((await errorOf(chrome.offscreen.createDocument({ url: HOST, justification }))).message, REASON_ERROR);
  assert.match((await errorOf(chrome.offscreen.createDocument({ url: HOST, reasons: ['USER_MEDIA'] }))).message, /justification/);
  assert.equal(browser.offscreenDocument, null);

  let wired;
  browser.onCreateOffscreen = (context) => { wired = context; };
  await chrome.offscreen.createDocument({ url: HOST, reasons: ['USER_MEDIA'], justification });
  assert.deepEqual(browser.offscreenDocument, { url: HOST, reasons: ['USER_MEDIA'] });
  assert.equal(wired.kind, 'offscreen');
  assert.equal(wired.url, browser.url(HOST));
  assert.deepEqual(Object.keys(wired.chrome), ['runtime']);
  assert.deepEqual(Object.keys(wired.chrome.runtime).sort(), ['connect', 'getURL', 'id', 'onConnect', 'onMessage', 'sendMessage']);
  assert.equal(wired.chrome.runtime.getURL(''), `${browser.origin}/`);
  assert.equal((await errorOf(chrome.offscreen.createDocument({ url: HOST, reasons: ['USER_MEDIA'], justification }))).message, SINGLE_DOCUMENT_ERROR);

  const found = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(HOST)] });
  assert.equal(found.length, 1);
  assert.equal(found[0].contextType, 'OFFSCREEN_DOCUMENT');
  assert.equal(found[0].documentUrl, browser.url(HOST));
  assert.deepEqual(await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }), []);
  assert.deepEqual(await chrome.runtime.getContexts({ documentUrls: [browser.url('elsewhere.html')] }), []);

  await chrome.offscreen.closeDocument();
  assert.equal(browser.offscreenDocument, null);
  assert.equal(wired.alive, false);
  assert.equal((await errorOf(chrome.offscreen.closeDocument())).message, NO_DOCUMENT_ERROR);
  assert.deepEqual(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }), []);
});

test('offscreen: an AUDIO_PLAYBACK-only document closes after 30 s unless audible; USER_MEDIA stays', async () => {
  const browser = createFakeBrowser();
  const { chrome } = browser.sw.register(() => {});
  browser.sw.idleTimeoutMs = Number.MAX_SAFE_INTEGER;
  await chrome.offscreen.createDocument({ url: HOST, reasons: ['AUDIO_PLAYBACK'], justification: 'play' });
  assert.equal(AUDIO_PLAYBACK_CLOSE_MS, 30000);
  browser.audible = true;
  await browser.clock.advance(30000);
  assert.notEqual(browser.offscreenDocument, null, 'audible output keeps it open');
  browser.audible = false;
  await browser.clock.advance(30000);
  assert.equal(browser.offscreenDocument, null);
  assert.equal(browser.contexts().some((context) => context.kind === 'offscreen'), false);

  await chrome.offscreen.createDocument({ url: HOST, reasons: ['USER_MEDIA'], justification: 'capture' });
  await browser.clock.advance(300000);
  assert.notEqual(browser.offscreenDocument, null, 'a USER_MEDIA document is not closed for silence');
});

test('offscreen: a page whose script fails stays as a zombie that nobody answers', async () => {
  const browser = createFakeBrowser();
  const { chrome } = browser.sw.register(() => {});
  const failure = new Error('host.js failed at import');
  browser.onCreateOffscreen = () => { throw failure; };
  await chrome.offscreen.createDocument({ url: HOST, reasons: ['USER_MEDIA'], justification: 'capture' });
  assert.deepEqual(browser.listenerErrors, [failure]);
  assert.equal((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length, 1);
  assert.equal((await errorOf(chrome.runtime.sendMessage({ target: 'offscreen' }))).message, NO_RECEIVER_ERROR);
});

// ---------------------------------------------------------------------------
// Storage

test('storage: JSON copies, onChanged to every context with access, session hidden from content', async () => {
  const browser = createFakeBrowser();
  browser.addTab({ id: 1, url: 'https://a.test/' });
  const worker = browser.sw.register((chrome) => {
    chrome.storage.onChanged.addListener((changes, area) => seen.sw.push([changes, area]));
  });
  const seen = { sw: [], panel: [], content: [] };
  const panel = browser.createContext('panel');
  panel.chrome.storage.onChanged.addListener((changes, area) => seen.panel.push([changes, area]));
  const offscreen = browser.createContext('offscreen');
  assert.equal(offscreen.chrome.storage, undefined, 'the offscreen document has no storage');
  const content = browser.contentContext(1);
  content.chrome.storage.onChanged.addListener((changes, area) => seen.content.push([changes, area]));

  await panel.chrome.storage.local.set({ settings: { volume: 65, list: [1, 2] } });
  await settle();
  const expected = [[{ settings: { newValue: { volume: 65, list: [1, 2] } } }, 'local']];
  assert.deepEqual(seen.sw, expected);
  assert.deepEqual(seen.panel, expected);
  assert.deepEqual(seen.content, expected, 'at the default access level a content script still sees local storage');

  const copy = (await worker.chrome.storage.local.get('settings')).settings;
  copy.volume = 0;
  assert.equal((await worker.chrome.storage.local.get('settings')).settings.volume, 65, 'get returns a copy');
  assert.deepEqual(await worker.chrome.storage.local.get({ settings: null, absent: 'fallback' }), { settings: { volume: 65, list: [1, 2] }, absent: 'fallback' });
  assert.deepEqual(await worker.chrome.storage.local.get(['settings', 'nothing']), { settings: { volume: 65, list: [1, 2] } });

  await panel.chrome.storage.local.set({ settings: { volume: 65, list: [1, 2] } });
  await settle();
  assert.equal(seen.sw.length, 1, 'writing an equal value fires no event');
  await panel.chrome.storage.local.set({ settings: { volume: 70 } });
  await panel.chrome.storage.local.remove('settings');
  await settle();
  assert.deepEqual(seen.sw[1], [{ settings: { oldValue: { volume: 65, list: [1, 2] }, newValue: { volume: 70 } } }, 'local']);
  assert.deepEqual(seen.sw[2], [{ settings: { oldValue: { volume: 70 } } }, 'local']);

  await panel.chrome.storage.session.set({ armed: { 5: true } });
  await settle();
  assert.equal(content.chrome.storage.session, undefined, 'session is never visible to a content script');
  assert.equal(seen.content.length, 3, 'and its change events never reach one');
  assert.deepEqual(browser.storageData('session'), { armed: { 5: true } });
  assert.deepEqual(await worker.chrome.storage.session.get('armed'), { armed: { 5: true } });
});

test('storage: TRUSTED_CONTEXTS hides local storage from content scripts (absent, or present and rejecting)', async () => {
  for (const contentStorage of ['absent', 'rejects']) {
    const browser = createFakeBrowser({ contentStorage });
    browser.addTab({ id: 1, url: 'https://a.test/' });
    const content = browser.contentContext(1);
    const options = browser.createContext('options');
    await options.chrome.storage.local.set({ stored: 'kept' });
    assert.equal(browser.accessLevel, null);
    assert.deepEqual(await content.chrome.storage.local.get(), { stored: 'kept' }, 'before the level is set, content can read: the reason the level is set');
    const early = content.chrome.storage;
    await options.chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    assert.equal(browser.accessLevel, 'TRUSTED_CONTEXTS');
    if (contentStorage === 'absent') assert.equal(content.chrome.storage, undefined);
    else {
      assert.notEqual(content.chrome.storage, undefined);
      assert.equal((await errorOf(content.chrome.storage.local.get())).message, STORAGE_DENIED_ERROR);
      assert.equal((await errorOf(content.chrome.storage.local.set({ x: 1 }))).message, STORAGE_DENIED_ERROR);
    }
    assert.equal((await errorOf(early.local.get())).message, STORAGE_DENIED_ERROR, 'a handle taken earlier is refused too');
    assert.equal(content.storageTouched, true);
    assert.deepEqual(await options.chrome.storage.local.get('stored'), { stored: 'kept' }, 'trusted contexts are unaffected');
  }
});

test('storage: failSetAccessLevel makes setAccessLevel reject and leaves the level unset', async () => {
  const browser = createFakeBrowser();
  const options = browser.createContext('options');
  browser.failSetAccessLevel(true);
  await assert.rejects(options.chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }));
  assert.equal(browser.accessLevel, null);
  browser.failSetAccessLevel(false);
  await assert.rejects(options.chrome.storage.local.setAccessLevel({ accessLevel: 'EVERYONE' }), TypeError);
  await options.chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  assert.equal(browser.accessLevel, 'TRUSTED_CONTEXTS');
});

// ---------------------------------------------------------------------------
// Grants, gestures and tabCapture

function clickFixture(options) {
  const browser = createFakeBrowser(options);
  const calls = { clicks: [], opens: [] };
  // The tests below advance the clock far past 30 s: this fixture is about
  // grants and captures, not the idle model, so the worker stays up.
  browser.sw.register((chrome) => {
    chrome.action.onClicked.addListener(async (tab) => {
      calls.clicks.push(tab.id);
      calls.first = await chrome.sidePanel.open({ windowId: tab.windowId }).then(() => 'opened', (error) => error.message);
    });
  });
  browser.sw.idleTimeoutMs = Number.MAX_SAFE_INTEGER;
  browser.addTab({ id: 5, url: 'https://example.test/a', active: true });
  return { browser, calls };
}

test('gesture: an action click grants the tab and sidePanel.open works only in the synchronous turn', async () => {
  const browser = createFakeBrowser();
  const outcomes = {};
  const worker = browser.sw.register((chrome) => {
    chrome.action.onClicked.addListener(async (tab) => {
      outcomes.first = chrome.sidePanel.open({ windowId: tab.windowId }).then(() => 'opened', (error) => error.message);
      await null;
      outcomes.late = chrome.sidePanel.open({ windowId: tab.windowId }).then(() => 'opened', (error) => error.message);
      outcomes.grantedInside = browser.hasGrant(tab.id);
    });
  });
  browser.addTab({ id: 5, url: 'https://example.test/a', active: true });
  assert.equal(browser.hasGrant(5), false);
  const settled = await browser.clickAction(5);
  assert.deepEqual(settled.map((entry) => entry.status), ['fulfilled']);
  assert.equal(await outcomes.first, 'opened');
  assert.equal(await outcomes.late, GESTURE_ERROR);
  assert.equal(outcomes.grantedInside, true, 'the grant exists BEFORE the listener runs');
  assert.deepEqual(browser.panelOpens, [{ windowId: 1, tabId: null }]);
  assert.equal(browser.gestureActive, false);
  assert.equal(GESTURE_ERROR, '`sidePanel.open()` may only be called in response to a user gesture.');
  // Outside any gesture it rejects; a gesture without a click on the action does not grant.
  assert.equal((await errorOf(worker.chrome.sidePanel.open({ windowId: 1 }))).message, GESTURE_ERROR);
  browser.addTab({ id: 6, url: 'https://example.test/b' });
  await browser.withGesture(() => worker.chrome.sidePanel.open({ tabId: 6 }));
  assert.equal(browser.hasGrant(6), false, 'sidePanel.open never grants tabCapture');
  assert.equal(browser.panelOpens.length, 2);
  await assert.rejects(browser.withGesture(() => worker.chrome.sidePanel.open({})), /tabId.*windowId/);
});

test('gesture: with strictGesture off sidePanel.open needs no gesture', async () => {
  const { browser, calls } = clickFixture({ strictGesture: false });
  await browser.clickAction(5);
  assert.deepEqual(calls.clicks, [5]);
  assert.equal(calls.first, 'opened');
  await browser.sw.context.chrome.sidePanel.open({ windowId: 1 });
  assert.equal(browser.panelOpens.length, 2);
});

test('grants: openPanelOnActionClick true suppresses the click event and the grant; false restores both', async () => {
  const { browser, calls } = clickFixture();
  const { chrome } = browser.sw.context;
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  assert.deepEqual(browser.panelBehavior, { openPanelOnActionClick: true });
  assert.deepEqual(await browser.clickAction(5), []);
  assert.deepEqual(await browser.pressShortcut(5), []);
  assert.deepEqual(calls.clicks, []);
  assert.equal(browser.hasGrant(5), false);
  assert.deepEqual(browser.autoPanelOpens.map((entry) => entry.tabId), [5, 5]);
  await assert.rejects(chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: 'yes' }), TypeError);
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  await browser.clickAction(5);
  assert.deepEqual(calls.clicks, [5]);
  assert.equal(browser.hasGrant(5), true);
});

test('grants: the shortcut and the context menu grant like a click; an unassigned shortcut does nothing', async () => {
  const browser = createFakeBrowser();
  const seen = [];
  const worker = browser.sw.register((chrome) => {
    chrome.action.onClicked.addListener((tab) => seen.push(['action', tab.id]));
    chrome.contextMenus.create({ id: 'interp-open', title: 'open', contexts: ['page'] });
    chrome.contextMenus.onClicked.addListener((info, tab) => seen.push(['menu', info.menuItemId, tab.id, info.pageUrl]));
  });
  browser.addTab({ id: 7, url: 'https://example.test/x', active: true });
  await browser.pressShortcut(7);
  assert.deepEqual(seen, [['action', 7]]);
  assert.equal(browser.hasGrant(7), true);
  assert.deepEqual(await worker.chrome.commands.getAll(), [{ name: '_execute_action', description: '', shortcut: 'Alt+Shift+Y' }]);

  browser.grants.clear();
  await browser.clickContextMenu(7, 'interp-open');
  assert.deepEqual(seen.at(-1), ['menu', 'interp-open', 7, 'https://example.test/x']);
  assert.equal(browser.hasGrant(7), true);
  assert.throws(() => browser.clickContextMenu(7, 'missing'), /No context menu item/);
  assert.throws(() => worker.chrome.contextMenus.create({ id: 'interp-open', title: 'again' }), /duplicate id interp-open/);
  assert.deepEqual(browser.menus.map((menu) => menu.id), ['interp-open']);
  await worker.chrome.contextMenus.removeAll();
  assert.deepEqual(browser.menus, []);
  worker.chrome.contextMenus.create({ id: 'interp-open', title: 'recreated' });

  browser.grants.clear();
  browser.shortcut = null;
  assert.deepEqual(await browser.pressShortcut(7), []);
  assert.equal(browser.hasGrant(7), false, 'an unassigned shortcut is not an invocation');
  assert.equal((await worker.chrome.commands.getAll())[0].shortcut, '');
});

test('grants: cleared by cross-origin navigation and tab close, kept by same-origin navigation and pushState', async () => {
  const { browser } = clickFixture();
  await browser.clickAction(5);
  await browser.navigate(5, 'https://example.test/other-path');
  assert.equal(browser.hasGrant(5), true, 'same origin keeps the grant');
  await browser.pushState(5, 'https://example.test/spa/route');
  assert.equal(browser.hasGrant(5), true);
  assert.equal(browser.tabRecord(5).url, 'https://example.test/spa/route');
  await browser.navigate(5, 'https://elsewhere.test/');
  assert.equal(browser.hasGrant(5), false, 'cross-origin navigation clears it');
  await browser.clickAction(5);
  await browser.closeTab(5);
  assert.equal(browser.hasGrant(5), false, 'closing the tab clears it');
});

test('tabCapture: exact error strings, the order of checks, restricted pages', async () => {
  const { browser } = clickFixture();
  const { chrome } = browser.sw.context;
  assert.equal(GRANT_ERROR, 'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.');
  assert.equal(ACTIVE_STREAM_ERROR, 'Cannot capture a tab with an active stream.');
  assert.equal((await errorOf(chrome.tabCapture.getMediaStreamId({ targetTabId: 5 }))).message, GRANT_ERROR);
  assert.equal((await errorOf(chrome.tabCapture.getMediaStreamId({ targetTabId: 404 }))).message, INVALID_TAB_ERROR);
  assert.equal(INVALID_TAB_ERROR, 'Invalid tab specified.');
  for (const restricted of ['chrome://settings', 'about:blank', `chrome-extension://${browser.extensionId}/x.html`]) {
    browser.addTab({ id: 60, url: restricted });
    await browser.clickAction(60);
    assert.equal((await errorOf(chrome.tabCapture.getMediaStreamId({ targetTabId: 60 }))).message, CANNOT_CAPTURE_ERROR, restricted);
    await browser.closeTab(60);
  }
  assert.equal(CANNOT_CAPTURE_ERROR, 'Cannot capture this page.');
});

test('tabCapture: ids are single use and expire; one capture per tab; stopping the track frees the tab', async () => {
  const { browser } = clickFixture();
  const { chrome } = browser.sw.context;
  await browser.clickAction(5);
  assert.equal(STREAM_ID_TTL_MS, 5000);
  const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: 5 });
  assert.match(id, /^fake-stream-\d+$/);
  assert.equal((await errorOf(chrome.tabCapture.getMediaStreamId({ targetTabId: 5 }))).message, ACTIVE_STREAM_ERROR, 'a pending unexpired id blocks the next mint');
  await browser.clock.advance(STREAM_ID_TTL_MS - 1);
  assert.equal((await errorOf(chrome.tabCapture.getMediaStreamId({ targetTabId: 5 }))).message, ACTIVE_STREAM_ERROR);
  const stream = browser.consumeStreamId(id);
  assert.ok(stream instanceof FakeMediaStream);
  assert.equal(stream.getTracks().length, 1);
  assert.equal(stream.getAudioTracks()[0].readyState, 'live');
  assert.equal(browser.captures.get(5).stream, stream);
  assert.deepEqual(await chrome.tabCapture.getCapturedTabs(), [{ tabId: 5, status: 'active', fullscreen: false }]);
  assert.throws(() => browser.consumeStreamId(id), { name: 'NotAllowedError' });
  await browser.clock.advance(60000);
  assert.equal((await errorOf(chrome.tabCapture.getMediaStreamId({ targetTabId: 5 }))).message, ACTIVE_STREAM_ERROR, 'an active capture blocks forever');
  stream.getTracks()[0].stop();
  assert.equal(browser.captures.has(5), false);
  assert.deepEqual(await chrome.tabCapture.getCapturedTabs(), []);

  const expired = await chrome.tabCapture.getMediaStreamId({ targetTabId: 5 });
  await browser.clock.advance(STREAM_ID_TTL_MS);
  assert.throws(() => browser.consumeStreamId(expired), { name: 'NotAllowedError' }, 'an id is dead at exactly the TTL');
  const again = await chrome.tabCapture.getMediaStreamId({ targetTabId: 5 });
  assert.notEqual(again, expired, 'an expired pending id no longer blocks the tab');
  assert.throws(() => browser.consumeStreamId('fake-stream-unknown'), { name: 'NotAllowedError' });
});

test('tabCapture: a clone keeps the capture alive; closing the tab ends every track with an ended event', async () => {
  const { browser } = clickFixture();
  const worker = browser.sw.context;
  await browser.clickAction(5);
  const stream = browser.consumeStreamId(await worker.chrome.tabCapture.getMediaStreamId({ targetTabId: 5 }));
  const [track] = stream.getAudioTracks();
  const clone = stream.clone();
  const endedEvents = [];
  track.addEventListener('ended', () => endedEvents.push('original'));
  clone.getTracks()[0].addEventListener('ended', () => endedEvents.push('clone'));
  track.stop();
  assert.equal(track.readyState, 'ended');
  assert.deepEqual(endedEvents, [], 'stop() ends a track WITHOUT an ended event');
  assert.equal(browser.captures.has(5), true, 'the clone still holds the capture');
  const removed = [];
  const observer = browser.createContext('panel');
  observer.chrome.tabs.onRemoved.addListener((tabId) => removed.push(tabId));
  await browser.closeTab(5);
  assert.deepEqual(endedEvents, ['clone'], 'the source ended: the live clone fires ended, the stopped original does not');
  assert.equal(browser.captures.has(5), false);
  assert.deepEqual(removed, [5]);
});

// ---------------------------------------------------------------------------
// Tabs, scripting, i18n

test('tabs: query filters, activation, focused window and url patterns', async () => {
  const browser = createFakeBrowser();
  const { chrome } = browser.sw.register(() => {});
  browser.addTab({ id: 1, url: 'https://a.test/one', windowId: 1 });
  browser.addTab({ id: 2, url: 'https://b.test/two', windowId: 1 });
  browser.addTab({ id: 3, url: 'https://c.test/three', windowId: 2 });
  browser.addTab({ id: 4, url: browser.url('extension/permission/mic-permission.html'), windowId: 2 });
  const ids = async (filter) => (await chrome.tabs.query(filter)).map((tab) => tab.id).sort();
  assert.deepEqual(await ids({ active: true, lastFocusedWindow: true }), [1], 'the first tab of a window starts active; window 1 is focused');
  browser.focusWindow(2);
  assert.deepEqual(await ids({ active: true, lastFocusedWindow: true }), [3]);
  await browser.activateTab(4);
  assert.deepEqual(await ids({ active: true, windowId: 2 }), [4]);
  assert.deepEqual(await ids({ active: true, lastFocusedWindow: true }), [4]);
  assert.deepEqual(await ids({ url: browser.url('extension/permission/mic-permission.html') }), [4]);
  assert.deepEqual(await ids({ url: 'https://*.test/*' }), [1, 2, 3]);
  assert.deepEqual(await ids({ url: ['https://a.test/*', '<all_urls>'] }), [1, 2, 3]);
  assert.deepEqual(await ids({ lastFocusedWindow: false }), [1, 2]);
  assert.equal((await chrome.tabs.get(2)).url, 'https://b.test/two');
  assert.equal((await errorOf(chrome.tabs.get(99))).message, 'No tab with id: 99.');
  assert.equal((await chrome.windows.getCurrent()).id, 2);
});

test('tabs: navigate reports loading then complete, replaces the content context, honors browser.contentScripts', async () => {
  const browser = createFakeBrowser();
  const updates = [], activations = [];
  const { chrome } = browser.sw.register((c) => {
    c.tabs.onUpdated.addListener((tabId, changeInfo, tab) => updates.push([tabId, changeInfo, tab.url, tab.status]));
    c.tabs.onActivated.addListener((info) => activations.push(info));
  });
  const created = [];
  browser.onContentCreated = (context) => created.push(context.tabId);
  browser.addTab({ id: 1, url: 'https://a.test/', active: true });
  browser.addTab({ id: 2, url: 'https://b.test/' });
  const first = browser.contentContext(1);
  assert.deepEqual(created, [1, 2]);
  await browser.navigate(1, 'https://c.test/landing');
  assert.deepEqual(updates, [[1, { status: 'loading', url: 'https://c.test/landing' }, 'https://c.test/landing', 'loading'],
    [1, { status: 'complete' }, 'https://c.test/landing', 'complete']]);
  assert.equal(first.alive, false, 'the old document is gone');
  assert.notEqual(browser.contentContext(1), first);
  assert.equal(browser.contentContext(1).url, 'https://c.test/landing');
  assert.equal(browser.hasContent(1), true);
  await browser.navigate(1, 'about:blank');
  assert.equal(browser.hasContent(1), false, 'no content script on a non-http page');
  browser.contentScripts = false;
  await browser.navigate(1, 'https://d.test/');
  assert.equal(browser.hasContent(1), false);
  browser.contentScripts = true;
  await browser.activateTab(2);
  assert.deepEqual(activations, [{ tabId: 2, windowId: 1 }]);
  assert.equal((await chrome.tabs.query({ active: true, windowId: 1 }))[0].id, 2);
  const tab = await chrome.tabs.create({ url: browser.url('extension/options/options.html') });
  assert.equal(tab.active, true);
  assert.equal(browser.tabRecord(tab.id).url, browser.url('extension/options/options.html'));
  assert.equal(browser.hasContent(tab.id), false);
  await chrome.tabs.update(1, { active: true });
  assert.equal((await chrome.tabs.get(1)).active, true);
  assert.equal((await chrome.tabs.get(2)).active, false);
});

test('scripting: executeScript needs an activeTab grant and hands the files to the test hook; i18n reads the messages option', async () => {
  const browser = createFakeBrowser({ messages: { menuOpen: { message: 'Interpret $1' }, plain: 'text' } });
  const { chrome } = browser.sw.register(() => {});
  const injected = [];
  browser.onInject = (tabId, files) => { injected.push([tabId, files]); };
  browser.addTab({ id: 8, url: 'https://example.test/', active: true });
  assert.match((await errorOf(chrome.scripting.executeScript({ target: { tabId: 8 }, files: ['extension/overlay/overlay.js'] }))).message, /Cannot access contents of the page/);
  await browser.clickAction(8);
  const result = await chrome.scripting.executeScript({ target: { tabId: 8 }, files: ['extension/overlay/overlay.js'] });
  assert.deepEqual(injected, [[8, ['extension/overlay/overlay.js']]]);
  assert.equal(result.length, 1);
  assert.deepEqual(browser.injections, [{ tabId: 8, files: ['extension/overlay/overlay.js'] }]);
  assert.equal(chrome.i18n.getMessage('menuOpen', 'this tab'), 'Interpret this tab');
  assert.equal(chrome.i18n.getMessage('plain'), 'text');
  assert.equal(chrome.i18n.getMessage('missing'), '');
  assert.equal(chrome.i18n.getUILanguage(), 'en');
  await chrome.runtime.openOptionsPage();
  assert.equal(browser.optionsOpens, 1);
});

test('hooks: a throwing test hook is recorded, never thrown into the browser call; options are validated', async () => {
  const browser = createFakeBrowser();
  const { chrome } = browser.sw.register(() => {});
  const seen = [];
  browser.onTabCreate = (tab) => { seen.push(['tab', tab.url]); throw new Error('hook failed'); };
  browser.onPanelOpen = (record) => { seen.push(['panel', record.tabId]); };
  browser.onOpenOptions = () => { seen.push(['options']); };
  const tab = await chrome.tabs.create({ url: 'https://example.test/new' });
  assert.equal(tab.url, 'https://example.test/new');
  assert.equal(browser.hasContent(tab.id), true, 'a created web tab gets its content script');
  await browser.withGesture(() => chrome.sidePanel.open({ tabId: tab.id }));
  await chrome.runtime.openOptionsPage();
  assert.deepEqual(seen, [['tab', 'https://example.test/new'], ['panel', tab.id], ['options']]);
  assert.deepEqual(browser.listenerErrors.map((error) => error.message), ['hook failed']);
  assert.throws(() => createFakeBrowser({ contentStorage: 'sometimes' }), TypeError);
  assert.equal(createFakeBrowser({ extensionId: 'custom-id' }).url('/a/b.js'), 'chrome-extension://custom-id/a/b.js');
});

test('contexts: a page kind gets only its namespaces; invalidate() models an orphaned content script', async () => {
  const browser = createFakeBrowser();
  browser.addTab({ id: 1, url: 'https://a.test/' });
  const panel = browser.createContext('panel');
  assert.equal(panel.chrome.tabCapture, undefined, 'only the service worker mints stream ids');
  assert.equal(panel.chrome.offscreen, undefined);
  assert.equal(typeof panel.chrome.commands.getAll, 'function');
  const content = browser.contentContext(1);
  assert.deepEqual(Object.keys(content.chrome.runtime).sort(), ['connect', 'id', 'onMessage', 'sendMessage']);
  assert.deepEqual(Object.keys(content.chrome).sort(), ['i18n', 'runtime', 'storage']);
  assert.throws(() => browser.createContext('sw'), TypeError);
  assert.throws(() => browser.createContext('content', { tabId: 404 }), /No tab with id/);
  assert.throws(() => browser.addTab({ id: 1, url: 'https://dup.test/' }), /already exists/);
  const disconnects = [];
  browser.createContext('offscreen').chrome.runtime.onConnect.addListener(() => {});
  const port = content.chrome.runtime.connect({ name: 'overlay' });
  port.onDisconnect.addListener(() => disconnects.push('own'));
  await settle();
  content.invalidate();
  await settle();
  assert.equal(content.chrome.runtime.id, undefined);
  assert.throws(() => content.chrome.runtime.sendMessage({}), { message: INVALIDATED_ERROR });
  assert.throws(() => content.chrome.runtime.connect({ name: 'again' }), { message: INVALIDATED_ERROR });
  assert.deepEqual(disconnects, ['own']);
});

// ---------------------------------------------------------------------------
// Fake audio

test('audio: tracks and streams (stop has no ended event, end has one, clones share the source)', () => {
  const track = new FakeTrack({ kind: 'audio', label: 'mic' });
  const ended = [];
  track.addEventListener('ended', () => ended.push('ended'));
  track.addEventListener('mute', () => ended.push('mute'));
  track.mute();
  assert.equal(track.muted, true);
  track.unmute();
  const clone = track.clone();
  assert.notEqual(clone.id, track.id);
  track.stop();
  assert.equal(track.readyState, 'ended');
  assert.equal(track.stops, 1);
  track.stop();
  assert.equal(track.stops, 2, 'stop is idempotent but counted');
  assert.deepEqual(ended, ['mute'], 'stop() fires nothing');
  const other = new FakeTrack({ kind: 'audio' });
  other.addEventListener('ended', () => ended.push('other-ended'));
  other.end();
  other.end();
  assert.deepEqual(ended, ['mute', 'other-ended']);
  const stream = new FakeMediaStream([clone, new FakeTrack({ kind: 'video' })]);
  assert.equal(stream.active, true);
  assert.equal(stream.getAudioTracks().length, 1);
  assert.equal(stream.getVideoTracks().length, 1);
  assert.equal(stream.clone().getTracks().length, 2);
  assert.equal(track.getSettings().deviceId, 'fake-device');
});

test('audio: an AudioContext is suspended until resume, follows the clock only while running, and is strict once closed', async () => {
  const fake = createFakeAudioEnv({ clock: createFakeClock() });
  const context = new fake.env.AudioContext({ sampleRate: 24000 });
  assert.equal(context.state, 'suspended');
  assert.equal(context.sampleRate, 24000);
  assert.equal(new fake.env.AudioContext().sampleRate, 48000);
  const states = [];
  context.addEventListener('statechange', () => states.push(context.state));
  await fake.clock.advance(1000);
  assert.equal(context.currentTime, 0, 'a suspended context does not advance');
  await context.resume();
  await fake.clock.advance(2500);
  assert.equal(context.state, 'running');
  assert.equal(context.currentTime, 2.5);
  await context.suspend();
  await fake.clock.advance(4000);
  assert.equal(context.currentTime, 2.5);
  await context.resume();
  await context.resume();
  await fake.clock.advance(500);
  assert.equal(context.currentTime, 3);
  await context.close();
  assert.deepEqual(states, ['running', 'suspended', 'running', 'closed']);
  assert.equal(context.resumeCalls, 3);
  assert.equal(context.closeCalls, 1);
  assert.equal((await errorOf(context.close())).name, 'InvalidStateError');
  assert.equal((await errorOf(context.resume())).name, 'InvalidStateError');
  assert.equal((await errorOf(context.suspend())).name, 'InvalidStateError');
  assert.equal(fake.contexts.length, 2);
  assert.throws(() => new fake.env.AudioWorkletNode(context, 'interp-capture'), { name: 'InvalidStateError' });
});

test('audio: autoplay modes (blocked stays suspended, held waits for releaseResume) and sample rate refusal', async () => {
  const fake = createFakeAudioEnv();
  fake.setAutoplay('blocked');
  const blocked = new fake.env.AudioContext();
  await blocked.resume();
  assert.equal(blocked.state, 'suspended');
  assert.equal(blocked.resumeCalls, 1);

  fake.setAutoplay('held');
  const held = new fake.env.AudioContext();
  let resolved = false;
  const pending = held.resume().then(() => { resolved = true; });
  await settle();
  assert.equal(resolved, false);
  assert.equal(held.state, 'suspended');
  held.releaseResume();
  await pending;
  assert.equal(held.state, 'running');
  const closing = new fake.env.AudioContext();
  const waiting = closing.resume();
  await closing.close();
  await waiting;
  assert.equal(closing.state, 'closed', 'closing releases a held resume');

  assert.throws(() => { fake.setAutoplay('sometimes'); }, TypeError);
  fake.failSampleRates(true);
  assert.throws(() => new fake.env.AudioContext({ sampleRate: 24000 }), { name: 'NotSupportedError' });
  assert.equal(new fake.env.AudioContext().sampleRate, 48000);
  const perContext = new FakeAudioContext({ autoplay: 'blocked' });
  await perContext.resume();
  assert.equal(perContext.state, 'suspended', 'the autoplay option also works per context');
});

test('audio: nodes record their wiring; a source node needs an audio track; destinations are fresh and never end', async () => {
  const fake = createFakeAudioEnv();
  const context = new fake.env.AudioContext();
  await context.resume();
  const raw = new FakeMediaStream([new FakeTrack({ kind: 'audio' })]);
  const source = context.createMediaStreamSource(raw);
  const gain = context.createGain();
  const first = context.createMediaStreamDestination();
  const second = context.createMediaStreamDestination();
  source.connect(gain); gain.connect(context.destination); source.connect(first);
  assert.ok(source.connections.has(gain) && source.connections.has(first));
  assert.ok(gain.connections.has(context.destination));
  assert.notEqual(first.stream, second.stream);
  assert.equal(first.stream.getAudioTracks()[0].readyState, 'live');
  gain.gain.setTargetAtTime(0.65, context.currentTime, 0.02);
  assert.equal(gain.gain.value, 0.65);
  assert.equal(gain.gain.calls.length, 1);
  source.disconnect(gain);
  assert.equal(source.connections.has(gain), false);
  source.disconnect();
  assert.equal(source.connections.size, 0);
  assert.equal(source.disconnects, 2);
  assert.throws(() => context.createMediaStreamSource(new FakeMediaStream([])), { name: 'InvalidStateError' });
  const buffer = context.createBuffer(1, 240, 24000);
  assert.equal(buffer.duration, 0.01);
  assert.equal(buffer.getChannelData(0).length, 240);
  const player = context.createBufferSource();
  let ended = 0;
  player.onended = () => { ended++; };
  player.connect(context.destination);
  player.start(1.5);
  player.end(); player.end();
  assert.deepEqual([player.started, player.startedAt, ended], [true, 1.5, 1]);
  assert.equal(context.sources.length, 1);
  await context.audioWorklet.addModule(new URL('file:///app/audio/capture-worklet.js'));
  assert.deepEqual(context.modules, ['file:///app/audio/capture-worklet.js']);
  fake.failAddModule(true);
  assert.equal((await errorOf(context.audioWorklet.addModule('x.js'))).name, 'AbortError');
});

test('audio: a worklet node exposes a port and emits synthetic frames; nothing else is real', async () => {
  const fake = createFakeAudioEnv();
  const context = new fake.env.AudioContext();
  const node = new fake.env.AudioWorkletNode(context, 'interp-capture', { numberOfInputs: 1 });
  assert.ok(node instanceof FakeAudioWorkletNode);
  assert.deepEqual(fake.worklets, [node]);
  assert.equal(node.emitFrames(), false, 'nobody listens yet');
  const seen = [];
  node.port.onmessage = ({ data }) => seen.push(data);
  assert.equal(node.emitFrames(0.5), true);
  assert.ok(seen[0] instanceof Float32Array);
  assert.equal(seen[0].length, 1024);
  assert.equal(seen[0][0], 0.5);
  node.port.postMessage({ hello: 1 });
  assert.deepEqual(node.port.posted, [{ hello: 1 }]);
  node.port.close();
  assert.equal(node.port.closed, true);
  assert.throws(() => new FakeAudioWorkletNode({}, 'x'), TypeError);
});

test('audio: the env has the shape the host expects and refuses every real dependency', async () => {
  const sockets = createSocketFixture();
  const fake = createFakeAudioEnv({ sockets });
  const { env } = fake;
  assert.deepEqual(Object.keys(env).sort(), ['AudioContext', 'AudioWorkletNode', 'MediaStream', 'WebSocket', 'fetch', 'isSecureContext',
    'navigator', 'now', 'random', 'setTimeout', 'clearTimeout'].sort());
  assert.equal(env.WebSocket, sockets.WebSocket);
  assert.equal(env.random(), 0.5);
  assert.equal(env.isSecureContext, true);
  assert.equal(env.navigator.userActivation.isActive, false);
  assert.equal(typeof env.navigator.mediaDevices.getUserMedia, 'function');
  assert.equal((await errorOf(env.fetch('https://example.test/'))).message, 'unexpected fetch');
  assert.throws(() => new (createFakeAudioEnv().env.WebSocket)('wss://example.test/'), /unexpected WebSocket/);
  const time = env.now();
  await fake.clock.advance(250);
  assert.equal(env.now() - time, 250);
  const fired = [];
  env.setTimeout(() => fired.push(1), 100);
  const cancelled = env.setTimeout(() => fired.push(2), 100);
  env.clearTimeout(cancelled);
  await fake.clock.advance(100);
  assert.deepEqual(fired, [1]);
});

test('audio: getUserMedia serves a tab stream id (audio only or with the video shape) and refuses a bad id', async () => {
  const { browser } = clickFixture();
  const worker = browser.sw.context;
  const fake = createFakeAudioEnv({ browser });
  await browser.clickAction(5);
  const audioOnly = await fake.env.navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: await worker.chrome.tabCapture.getMediaStreamId({ targetTabId: 5 }) } } });
  assert.equal(audioOnly.getAudioTracks().length, 1);
  assert.equal(audioOnly.getVideoTracks().length, 0);
  audioOnly.getTracks()[0].stop();
  const mandatory = { chromeMediaSource: 'tab', chromeMediaSourceId: await worker.chrome.tabCapture.getMediaStreamId({ targetTabId: 5 }) };
  const withVideo = await fake.env.navigator.mediaDevices.getUserMedia({ audio: { mandatory }, video: { mandatory } });
  assert.equal(withVideo.getVideoTracks().length, 1);
  for (const track of withVideo.getTracks()) track.stop();
  assert.equal(browser.captures.has(5), false, 'both tracks stopped: the capture is free');
  assert.equal((await errorOf(fake.env.navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'stale' } } }))).name, 'NotAllowedError');
  assert.equal((await errorOf(createFakeAudioEnv().env.navigator.mediaDevices.getUserMedia({ audio: { mandatory } }))).name, 'NotSupportedError');
  assert.equal((await errorOf(fake.env.navigator.mediaDevices.getUserMedia({}))).name, 'TypeError');
});

test('audio: microphone permission, injected errors and held getUserMedia calls', async () => {
  const fake = createFakeAudioEnv({ micPermission: 'prompt' });
  const { getUserMedia } = fake.env.navigator.mediaDevices;
  assert.equal((await errorOf(getUserMedia({ audio: true }))).name, 'NotAllowedError');
  fake.setMicPermission('denied');
  assert.equal((await errorOf(getUserMedia({ audio: true }))).message, 'Permission denied');
  assert.throws(() => fake.setMicPermission('maybe'), TypeError);
  fake.setMicPermission('granted');
  const stream = await getUserMedia({ audio: { channelCount: 1 }, video: false });
  assert.deepEqual(fake.micStreams, [stream]);
  assert.equal(stream.getAudioTracks()[0].readyState, 'live');
  fake.setMicError('NotFoundError');
  assert.equal((await errorOf(getUserMedia({ audio: true }))).name, 'NotFoundError');
  fake.setMicError('NotReadableError');
  assert.equal((await errorOf(getUserMedia({ audio: true }))).name, 'NotReadableError');
  fake.setMicError(null);

  fake.setGetUserMediaMode('held');
  let resolved = null;
  const pending = getUserMedia({ audio: true }).then((value) => { resolved = value; return value; });
  await settle();
  assert.equal(fake.pendingGetUserMedia(), 1);
  assert.equal(resolved, null);
  assert.equal(fake.micStreams.length, 2, 'the stream exists (the microphone is open) while the promise is held');
  fake.releaseGetUserMedia();
  assert.equal(await pending, fake.micStreams[1]);
  const failing = errorOf(getUserMedia({ audio: true }));
  fake.releaseGetUserMedia({ error: 'AbortError' });
  assert.equal((await failing).name, 'AbortError');
  assert.throws(() => fake.setGetUserMediaMode('later'), TypeError);
});

test('audio: permissions.query modes (normal, throws, held, missing) and change events', async () => {
  const fake = createFakeAudioEnv({ micPermission: 'prompt' });
  const { navigator } = fake.env;
  const status = await navigator.permissions.query({ name: 'microphone' });
  assert.equal(status.state, 'prompt');
  const changes = [];
  status.addEventListener('change', () => changes.push(status.state));
  status.onchange = () => changes.push('onchange');
  fake.setMicPermission('granted');
  assert.deepEqual(changes, ['granted', 'onchange']);
  assert.equal((await errorOf(navigator.permissions.query({ name: 'camera' }))).name, 'TypeError');

  fake.setPermissionsMode('throws');
  assert.equal((await errorOf(navigator.permissions.query({ name: 'microphone' }))).name, 'NotSupportedError');
  fake.setPermissionsMode('held');
  let answered = null;
  const pending = navigator.permissions.query({ name: 'microphone' }).then((value) => { answered = value; return value; });
  await settle();
  assert.equal(fake.pendingPermissionQueries(), 1);
  assert.equal(answered, null);
  fake.releasePermissionQueries();
  assert.equal((await pending).state, 'granted');
  fake.setPermissionsMode('missing');
  assert.equal(navigator.permissions, undefined);
  assert.throws(() => fake.setPermissionsMode('odd'), TypeError);
});

// ---------------------------------------------------------------------------
// Fake DOM

const SKELETON = `<!doctype html>
<!-- a comment is skipped -->
<html lang="en">
<head><meta charset="utf-8"><title data-i18n="ext.name"></title><link rel="stylesheet" href="../../styles.css"></head>
<body class="panel"><main id="app">
  <p id="live" class="notice text-sub" role="status" data-lane="tab" data-x-y="1"></p>
  <label><input id="box" type="checkbox" checked><span data-i18n="ext.captions.show"></span></label>
  <select id="pick"><option value="ko" data-i18n="language.ko"></option><option value="en" selected>English</option><option>plain</option></select>
  <input id="range" type="range" min="0" max="100" step="5"><input id="text" value="a &amp; b">
  <details id="more"><summary id="sum">t</summary><ol><li>one</li></ol></details>
  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M1 1"/></svg>
  <meter id="level" min="0" max="100" value="30"></meter><output id="out"></output>
  <button id="go" type="button" disabled>x</button>
</main><script type="module" src="./panel.js"></script></body></html>`;

test('dom: parseHtml handles the controlled markup and rejects anything a browser would silently repair', () => {
  const document = parseHtml(SKELETON);
  assert.equal(document.doctype, 'doctype html');
  assert.equal(document.documentElement.getAttribute('lang'), 'en');
  assert.equal(document.head.children.length, 3);
  assert.equal(document.body.className, 'panel');
  assert.equal(document.title, '');
  document.title = 'Set from script';
  assert.equal(document.getElementsByTagName('title')[0].textContent, 'Set from script');
  assert.equal(document.getElementById('box').hasAttribute('checked'), true);
  assert.equal(document.getElementById('text').value, 'a & b', 'entities are decoded');
  assert.equal(document.querySelectorAll('svg path').length, 1);
  assert.equal(document.querySelector('svg').namespace, 'svg');
  assert.equal(document.querySelector('script').getAttribute('type'), 'module');
  assert.deepEqual(document.strayText.map((entry) => [entry.parent.localName, entry.text]),
    [['option', 'English'], ['option', 'plain'], ['summary', 't'], ['li', 'one'], ['button', 'x']]);
  for (const [source, message] of [
    ['<div><span></div>', /mismatched/], ['<div>', /unclosed/], ['<div/>', /self-closing/], ['<p id="a" id="b"></p>', /duplicate attribute/],
    ['<!-- open', /unterminated comment/], ['stray <b></b>', /text outside/], ['<p title="x></p>', /unterminated attribute/],
    ['<script>let a;', /unterminated <script>/],
  ]) assert.throws(() => parseHtml(source), message, source);
  const script = parseHtml('<script>if (1 < 2) { run(); }</script>');
  assert.equal(script.querySelector('script').textContent, 'if (1 < 2) { run(); }', 'raw text is kept for inline-script detection');
});

test('dom: selectors cover ids, classes, tags, attributes, combinators, :not and refuse the unsupported', () => {
  const document = parseHtml(SKELETON);
  assert.equal(document.querySelector('#live').id, 'live');
  assert.equal(document.querySelectorAll('.notice, .text-sub').length, 1);
  assert.equal(document.querySelectorAll('[role]').length, 1);
  assert.equal(document.querySelectorAll('[role=status]').length, 1);
  assert.equal(document.querySelectorAll('[data-i18n]').length, 3);
  assert.equal(document.querySelectorAll('[data-i18n^="lang"]').length, 1);
  assert.equal(document.querySelectorAll('[data-i18n$="show"]').length, 1);
  assert.equal(document.querySelectorAll('[data-i18n*=".c"]').length, 1);
  assert.equal(document.querySelectorAll('main > p').length, 1);
  assert.equal(document.querySelectorAll('body p.notice').length, 1);
  assert.equal(document.querySelectorAll('label > span').length, 1);
  assert.equal(document.querySelectorAll('main span').length, 1);
  assert.equal(document.querySelectorAll('input:not([type=range])').length, 2);
  assert.equal(document.querySelectorAll('input:checked').length, 1);
  assert.equal(document.querySelectorAll('button:disabled').length, 1);
  assert.equal(document.querySelector('p.missing'), null);
  assert.equal(document.querySelector('main').querySelectorAll('option').length, 3);
  assert.equal(document.getElementById('live').closest('main').id, 'app');
  assert.equal(document.getElementById('live').matches('p[data-lane=tab]'), true);
  assert.throws(() => document.querySelector('p:hover'), /unsupported pseudo-class/);
  assert.throws(() => document.querySelector('p +'), /bad selector|empty/);
});

test('dom: attributes, classList, dataset, style, hidden and reflected properties', () => {
  const document = parseHtml(SKELETON);
  const element = document.getElementById('live');
  assert.deepEqual(element.attributes.map((attribute) => attribute.name), ['id', 'class', 'role', 'data-lane', 'data-x-y']);
  assert.equal(element.dataset.xY, '1');
  element.dataset.attention = 'true';
  assert.equal(element.getAttribute('data-attention'), 'true');
  assert.deepEqual(Object.keys(element.dataset), ['lane', 'xY', 'attention']);
  delete element.dataset.attention;
  assert.equal(element.hasAttribute('data-attention'), false);
  element.classList.add('a', 'b');
  element.classList.remove('notice');
  assert.equal(element.classList.toggle('b'), false);
  assert.equal(element.classList.toggle('c', true), true);
  assert.equal(element.className, 'text-sub a c');
  assert.equal(element.hidden, false);
  element.hidden = true;
  assert.equal(element.getAttribute('hidden'), '');
  element.hidden = false;
  assert.equal(element.hasAttribute('hidden'), false);
  element.style.setProperty('--size', '1.5', 'important');
  element.style.zIndex = '7';
  assert.equal(element.style.getPropertyValue('--size'), '1.5');
  assert.equal(element.style.getPropertyPriority('--size'), 'important');
  assert.equal(element.style['z-index'], '7');
  assert.match(element.style.cssText, /--size: 1\.5 !important;/);
  element.setAttribute('href', '/x');
  assert.equal(element.href, '/x');
  element.ariaLabel = 'named';
  assert.equal(element.getAttribute('aria-label'), 'named');
  element.title = 'tip';
  assert.equal(element.getAttribute('title'), 'tip');
  assert.equal(document.getElementById('text').maxLength, -1);
  element.textContent = 'hello';
  assert.equal(element.textContent, 'hello');
  element.textContent = '';
  assert.equal(element.childNodes.length, 0);
  element.append('a', document.createElement('b'), 'c');
  assert.equal(element.textContent, 'ac');
  assert.equal(element.children.length, 1);
  element.replaceChildren();
  assert.equal(element.childNodes.length, 0);
  assert.equal(element.toggleAttribute('data-flag'), true);
  assert.equal(element.toggleAttribute('data-flag'), false);
});

test('dom: form controls (select, range, checkbox, meter, output) behave like their DOM counterparts', () => {
  const document = parseHtml(SKELETON);
  const select = document.getElementById('pick');
  assert.equal(select.value, 'en');
  assert.equal(select.selectedIndex, 1);
  select.value = 'ko';
  assert.equal(select.selectedIndex, 0);
  select.value = 'zz';
  assert.equal(select.selectedIndex, -1);
  assert.equal(select.value, '');
  select.selectedIndex = 2;
  assert.equal(select.value, 'plain');
  assert.equal(document.getElementById('range').value, '50');
  document.getElementById('range').value = 65;
  assert.equal(document.getElementById('range').value, '65');
  assert.equal(document.getElementById('box').checked, true);
  assert.equal(document.getElementById('box').value, 'on');
  assert.equal(document.getElementById('level').value, 30);
  document.getElementById('level').value = 80;
  assert.equal(document.getElementById('level').getAttribute('value'), '80');
  document.getElementById('out').value = '65%';
  assert.equal(document.getElementById('out').textContent, '65%');
  assert.equal(document.getElementById('go').disabled, true);
});

test('dom: events bubble in order, honor stopPropagation and once, and click has activation behavior', () => {
  const document = parseHtml(SKELETON);
  const log = [];
  const box = document.getElementById('box');
  const main = document.getElementById('app');
  main.addEventListener('change', (event) => log.push(`main:${event.target.id}`));
  document.addEventListener('change', () => log.push('document'));
  box.addEventListener('change', () => log.push('box'));
  box.addEventListener('input', () => log.push('input'));
  box.addEventListener('click', () => log.push('click'), { once: true });
  box.click();
  assert.equal(box.checked, false, 'a click toggles a checkbox');
  assert.deepEqual(log, ['click', 'input', 'box', 'main:box', 'document']);
  log.length = 0;
  box.click();
  assert.deepEqual(log, ['input', 'box', 'main:box', 'document'], 'the once listener is gone');

  const stopper = (event) => { event.stopPropagation(); };
  box.addEventListener('change', stopper);
  log.length = 0;
  box.dispatchEvent(new FakeEvent('change', { bubbles: true }));
  assert.deepEqual(log, ['box'], 'stopPropagation keeps the event off the ancestors');
  box.removeEventListener('change', stopper);
  log.length = 0;
  box.dispatchEvent(new FakeEvent('change'));
  assert.deepEqual(log, ['box'], 'a non-bubbling event stays on its target');
  box.addEventListener('click', (event) => event.preventDefault());
  const before = box.checked;
  box.click();
  assert.equal(box.checked, before, 'preventDefault reverts the toggle and fires no change');
  assert.equal(main.dispatchEvent(new FakeEvent('click', { cancelable: true })), true, 'dispatchEvent returns true when nothing prevented it');
  assert.equal(box.dispatchEvent(new FakeEvent('click', { cancelable: true })), false, 'and false when a listener did');

  const details = document.getElementById('more');
  assert.equal(details.open, false);
  document.getElementById('sum').click();
  assert.equal(details.open, true);
  document.getElementById('go').addEventListener('click', () => log.push('disabled-clicked'));
  document.getElementById('go').click();
  assert.equal(log.includes('disabled-clicked'), false, 'a disabled control does not click');
  assert.equal(box.listenerCount, 3);
});

test('dom: a throwing listener propagates to the dispatcher (stricter than the DOM)', () => {
  const document = createFakeDocument();
  document.addEventListener('visibilitychange', () => { throw new Error('leaked into the page'); });
  assert.throws(() => document.setVisibility('hidden'), /leaked into the page/);
  assert.equal(document.hidden, true);
  const native = new Event('custom');
  const seen = [];
  document.addEventListener('custom', (event) => seen.push(event.type));
  document.dispatchEvent(native);
  assert.deepEqual(seen, ['custom'], 'native Event objects are accepted');
});

test('dom: focus moves activeElement and fires blur then focus', () => {
  const document = parseHtml(SKELETON);
  const log = [];
  const box = document.getElementById('box');
  const range = document.getElementById('range');
  box.addEventListener('focus', () => log.push('box:focus'));
  box.addEventListener('blur', () => log.push('box:blur'));
  range.addEventListener('focus', () => log.push('range:focus'));
  box.focus();
  range.focus();
  assert.equal(document.activeElement, range);
  range.blur();
  assert.equal(document.activeElement, null);
  document.getElementById('go').focus();
  assert.equal(document.activeElement, null, 'a disabled element cannot take focus');
  assert.deepEqual(log, ['box:focus', 'box:blur', 'range:focus']);
});

test('dom: every way of writing markup throws so untrusted text cannot become HTML', () => {
  const document = parseHtml(SKELETON);
  const element = document.getElementById('live');
  assert.throws(() => { element.innerHTML = '<b>x</b>'; }, /INNER_HTML_USED/);
  assert.throws(() => element.innerHTML, /INNER_HTML_USED/);
  assert.throws(() => { element.outerHTML = '<b>x</b>'; }, /OUTER_HTML_USED/);
  assert.throws(() => element.insertAdjacentHTML('beforeend', '<b>x</b>'), /INSERT_ADJACENT_HTML_USED/);
  assert.throws(() => { element.innerText = 'x'; }, /INNER_TEXT_USED/);
  assert.throws(() => document.write('<b>x</b>'), /DOCUMENT_WRITE_USED/);
  assert.throws(() => { document.body.innerHTML = 'x'; }, /INNER_HTML_USED/);
  const root = document.createElement('interp-live-captions').attachShadow({ mode: 'open' });
  assert.throws(() => { root.innerHTML = 'x'; }, /INNER_HTML_USED/);
});

test('dom: shadow roots (a closed root is invisible to the page), adoptedStyleSheets and the host rules', () => {
  const document = createFakeDocument();
  const host = document.createElement('interp-live-captions');
  document.documentElement.appendChild(host);
  const closed = host.attachShadow({ mode: 'closed' });
  assert.equal(host.shadowRoot, null, 'the page cannot reach a closed root');
  assert.equal(host.lastShadowRoot, closed, 'the test keeps its own handle');
  assert.equal(closed.host, host);
  assert.equal(closed.mode, 'closed');
  assert.throws(() => host.attachShadow({ mode: 'closed' }), { name: 'NotSupportedError' });
  assert.throws(() => document.createElement('video').attachShadow({ mode: 'open' }), { name: 'NotSupportedError' });
  assert.throws(() => document.createElement('div').attachShadow({ mode: 'sideways' }), TypeError);
  const open = document.createElement('div').attachShadow({ mode: 'open' });
  assert.equal(open.host.shadowRoot, open);

  const sheet = new FakeCSSStyleSheet();
  sheet.replaceSync('.wrap { color: red; }');
  closed.adoptedStyleSheets = [sheet];
  assert.equal(closed.adoptedStyleSheets[0].cssText, '.wrap { color: red; }');
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  closed.append(wrap);
  assert.equal(closed.querySelector('.wrap'), wrap);
  assert.equal(closed.getElementById('missing'), null);
  assert.equal(wrap.getRootNode(), closed);
  assert.equal(wrap.isConnected, true, 'a node in a shadow tree is connected when its host is');
  assert.equal(document.querySelector('.wrap'), null, 'the document does not see into a shadow tree');
  host.remove();
  assert.equal(wrap.isConnected, false);
  assert.equal(host.isConnected, false);

  const events = [];
  document.addEventListener('ping', () => events.push('document'));
  document.documentElement.appendChild(host);
  wrap.dispatchEvent(new FakeEvent('ping', { bubbles: true }));
  wrap.dispatchEvent(new FakeEvent('ping', { bubbles: true, composed: true }));
  assert.deepEqual(events, ['document'], 'only the composed event leaves the shadow tree');
});

test('dom: popover records calls, needs the attribute, and can be removed to model an older Chrome', () => {
  const document = createFakeDocument();
  const host = document.createElement('interp-live-captions');
  assert.throws(() => host.showPopover(), { name: 'InvalidStateError' });
  host.popover = 'manual';
  assert.equal(host.getAttribute('popover'), 'manual');
  host.hidePopover();
  host.showPopover();
  assert.equal(host.popoverOpen, true);
  assert.deepEqual(host.popoverCalls, ['hide', 'show']);
  assert.equal(host.togglePopover(), false);
  host.popover = null;
  assert.equal(host.hasAttribute('popover'), false);

  const older = createFakeDocument({ popover: false });
  const legacy = older.createElement('interp-live-captions');
  assert.equal(legacy.showPopover, undefined);
  assert.equal(legacy.hidePopover, undefined);
  legacy.popover = 'manual';
  assert.equal(legacy.hasAttribute('popover'), false, 'assigning popover is a plain expando there');
  assert.equal(legacy.showPopover?.(), undefined);
});

test('dom: the document reports visibility and fullscreen changes and knows its elements', () => {
  const document = createFakeDocument();
  const log = [];
  document.addEventListener('visibilitychange', () => log.push(`visibility:${document.visibilityState}`));
  document.addEventListener('fullscreenchange', () => log.push(`fullscreen:${document.fullscreenElement?.localName ?? 'none'}`));
  assert.equal(document.visibilityState, 'visible');
  assert.equal(document.hidden, false);
  document.setVisibility('hidden');
  assert.equal(document.hidden, true);
  document.setVisibility('visible');
  const video = document.createElement('video');
  document.body.append(video);
  document.setFullscreen(video);
  document.setFullscreen(null);
  assert.deepEqual(log, ['visibility:hidden', 'visibility:visible', 'fullscreen:video', 'fullscreen:none']);
  assert.equal(document.documentElement.localName, 'html');
  assert.ok(document.head && document.body);
  assert.ok(document.createElement('p') instanceof FakeElement);
  assert.equal(document.createTextNode('x').textContent, 'x');
  assert.equal(document.createElementNS('http://www.w3.org/2000/svg', 'svg').namespace, 'svg');
  assert.throws(() => { const child = document.createElement('p'); child.append(child); }, { name: 'HierarchyRequestError' });
  const parent = document.createElement('div');
  const reference = document.createElement('i');
  parent.append(reference);
  parent.insertBefore(document.createElement('b'), reference);
  assert.deepEqual(parent.children.map((element) => element.localName), ['b', 'i']);
  assert.equal(parent.firstElementChild.nextElementSibling, reference);
  assert.equal(reference.previousElementSibling.localName, 'b');
  assert.throws(() => parent.removeChild(document.createElement('u')), { name: 'NotFoundError' });
  parent.prepend('first');
  assert.equal(parent.textContent, 'first');
  const fragment = document.createDocumentFragment();
  const [one, two] = [document.createElement('option'), document.createElement('option')];
  fragment.append(one, two);
  const select = document.createElement('select');
  select.append(fragment);
  assert.deepEqual(select.options, [one, two]);
  assert.equal(fragment.childNodes.length, 0, 'a fragment hands its children over');
  assert.equal(one.parentNode, select);
});

test('dom: runClassicScript runs a classic script in a vm context and refuses module syntax', () => {
  const sandbox = { seen: [] };
  const value = runClassicScript('(() => { "use strict"; globalThis.fakeScript = 7; seen.push(typeof undefinedName); return 6 * 7; })()', sandbox);
  assert.equal(value, 42);
  assert.equal(sandbox.fakeScript, 7);
  assert.deepEqual(sandbox.seen, ['undefined']);
  assert.throws(() => runClassicScript('export const x = 1;', {}), SyntaxError);
  assert.throws(() => runClassicScript('import x from "./x.js";', {}), SyntaxError);
  assert.equal(runClassicScript('typeof require', {}), 'undefined', 'no require, like a content script');
  assert.equal(runClassicScript('typeof process', {}), 'undefined');
});
