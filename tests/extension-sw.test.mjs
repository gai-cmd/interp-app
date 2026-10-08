// New implementation of docs/extension.md §11.1 (extension-sw); no legacy code is ported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceWorker } from '../extension/background/sw-core.js';
import { createChromeAdapter } from '../extension/lib/chrome-adapter.js';
import { LIMITS, PATHS, STORAGE_KEYS, createMessageRouter, makeMessage } from '../extension/lib/protocol.js';
import { ACTIVE_STREAM_ERROR, GRANT_ERROR, createFakeBrowser } from './fixtures/fake-chrome.mjs';

// Section 6: the service worker against the fake browser and a STUB host (a fake offscreen context that answers host/*
// through the REAL message router, so the sender classification of 4.4 is exercised too). Every claim of the task
// ("open is first", "the mint is last", the three cancellation cases, the key in one message only) is proven by a
// call log of the adapter, not by a flag. Nothing here touches a browser, an audio device or a clock but the fake's.

const KEY = `synthetic-${'x'.repeat(24)}`;   // assembled at runtime: the privacy scan reads every file under tests/
const HOST_URL = PATHS.host;
const NO_ANSWER = Symbol('no answer');
const PASS = Symbol('pass');   // an override that hands the request to the stub's real handler
const RELAY_ID = 'fedcba9876543210'.repeat(2);   // §22
const LABEL_NONCE = '0123456789abcdef'.repeat(2);

const deferred = () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
};
const codeError = (code) => Object.assign(new Error(code), { code });

// ---------------------------------------------------------------------------------------------
// The stub host: a fake offscreen document that behaves like the real one closely enough for the worker's protocol.
function createStubHost(browser, options = {}) {
  const stub = {
    hostId: 'h-stub', lanes: { tab: 'off', mic: 'off' }, panels: 0, tabId: null, epoch: 0, creations: 0,
    captions: { tab: false, mic: false }, requests: [], settings: [], overlayResults: [], removed: [], stops: { tab: 0, mic: 0 },
    contexts: [], streams: new Map(), overrides: new Map(), holds: new Map(),
    // §19, the share-picker start: the nonces received, and what the "user" chooses ({ tabId } or { code }). The
    // dialog stays open while the test holds 'pick'.
    picks: [], choice: options.choice ?? { tabId: null },
    // §22, the relay start: the tab payloads received. The host waits for the panel's first audio while the test holds 'relay'.
    relays: [],
    answer: options.answer ?? true,            // false: a zombie document that never answers
    answerFor: options.answerFor ?? null,      // (creationNumber) => boolean, per document
    honorCancel: options.honorCancel ?? true,  // the real host notices a stop that overtakes a start
    count: (type) => stub.requests.filter((request) => request.type === type).length,
    of: (type) => stub.requests.filter((request) => request.type === type),
    on(type, fn) { stub.overrides.set(type, fn); },
    hold(name) {
      const gate = deferred();
      stub.holds.set(name, gate);
      return gate;
    },
    releaseStreams() {
      for (const stream of stub.streams.values()) for (const track of stream.getTracks()) track.stop();
      stub.streams.clear();
    },
  };
  const takeHold = async (name) => {
    const gate = stub.holds.get(name);
    if (gate) { stub.holds.delete(name); await gate.promise; }
  };
  const wantedFor = ({ tabId, active }) => {
    const lanes = [];
    if (stub.lanes.tab !== 'off' && stub.captions.tab && stub.tabId === tabId) lanes.push('tab');
    if (stub.lanes.mic !== 'off' && stub.captions.mic && active) lanes.push('mic');
    return { wanted: lanes.length > 0, lanes };
  };
  const handlers = {
    'host/ping': async () => {
      await takeHold('ping');
      return { hostId: stub.hostId, protocol: 1, lanes: { ...stub.lanes }, tabId: stub.tabId, panels: stub.panels };
    },
    'host/lane-start': async (message) => {
      const { lane } = message;
      if (stub.lanes[lane] !== 'off') throw codeError('ALREADY_RUNNING');
      stub.lanes[lane] = 'starting';
      const stopsBefore = stub.stops[lane];
      let picked = false;
      if (lane === 'tab' && message.tab.relay !== undefined) {
        stub.relays.push({ ...message.tab });
        await takeHold('relay');
        if (stub.honorCancel && stub.stops[lane] !== stopsBefore) { stub.lanes[lane] = 'off'; throw codeError('START_CANCELLED'); }
        stub.tabId = message.tab.tabId;
        picked = true;   // the answer names the tab, like the real host
      } else if (lane === 'tab' && message.tab.pick !== undefined) {
        stub.picks.push(message.tab.pick);
        await takeHold('pick');
        if (stub.honorCancel && stub.stops[lane] !== stopsBefore) { stub.lanes[lane] = 'off'; throw codeError('START_CANCELLED'); }
        if (stub.choice.code) { stub.lanes.tab = 'off'; throw codeError(stub.choice.code); }
        stub.tabId = stub.choice.tabId ?? null;
        picked = true;
      } else if (lane === 'tab') {
        try { stub.streams.set('tab', browser.consumeStreamId(message.tab.streamId)); } catch {
          stub.lanes.tab = 'off';
          throw codeError('TAB_CAPTURE_FAILED');
        }
        stub.tabId = message.tab.tabId;
      }
      await takeHold('lane-start');
      if (stub.honorCancel && stub.stops[lane] !== stopsBefore) { stub.lanes[lane] = 'off'; throw codeError('START_CANCELLED'); }
      stub.captions[lane] = message.captions;
      stub.lanes[lane] = 'running';
      stub.epoch += 1;
      return { epoch: stub.epoch, ...(picked ? { tabId: stub.tabId } : {}) };
    },
    'host/lane-stop': async (message) => {
      for (const lane of message.lane ? [message.lane] : ['tab', 'mic']) {
        stub.stops[lane] += 1;
        stub.lanes[lane] = 'off';
        if (lane === 'tab') { stub.streams.get('tab')?.getTracks().forEach((track) => track.stop()); stub.streams.delete('tab'); stub.tabId = null; }
      }
      return {};
    },
    'host/settings': async (message) => {
      stub.settings.push(message.settings);
      stub.captions.tab = message.settings.captions.tab;
      stub.captions.mic = message.settings.captions.mic;
      return {};
    },
    'host/overlay-wanted': async (message) => wantedFor(message),
    'host/overlay-result': async (message) => { stub.overlayResults.push(message); return {}; },
    'host/tab-removed': async (message) => { stub.removed.push(message.tabId); return {}; },
  };
  stub.attach = (context) => {
    stub.contexts.push(context);
    stub.creations += 1;
    const answers = stub.answerFor ? stub.answerFor(stub.creations) : stub.answer;
    if (!answers) return;   // a zombie: the page exists but its script never registered a listener
    const { runtime } = context.chrome;
    let routed;
    createMessageRouter({
      runtime: { id: runtime.id, getURL: runtime.getURL, onMessage: { addListener(fn) { routed = fn; } } },
      target: 'offscreen', handlers,
    });
    runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.target !== 'offscreen') return false;
      stub.requests.push({ type: message.type, message: JSON.parse(JSON.stringify(message)), senderUrl: sender.url, at: browser.clock.now() });
      const custom = stub.overrides.get(message.type);
      if (custom) {
        const out = custom(message);
        if (out === NO_ANSWER) return false;
        if (out === PASS) return routed(message, sender, sendResponse);
        Promise.resolve(out).then((value) => { if (value !== NO_ANSWER) sendResponse(value); });
        return true;
      }
      return routed(message, sender, sendResponse);
    });
    context.onClose(() => stub.releaseStreams());
  };
  return stub;
}

// The adapter as the worker sees it, with every call written to `log` (names only, never arguments except the message
// type) and an optional per-call hook: hooks[path](real, ...args).
function observe(adapter, log, hooks) {
  const walk = (path, value) => {
    if (typeof value === 'function') {
      return (...args) => {
        const label = path === 'runtime.sendMessage' ? `${path}:${args[0]?.type}`
          : path === 'tabs.sendMessage' ? `${path}:${args[1]?.type}` : path;
        log.push(label);
        const real = (...override) => value(...(override.length ? override : args));
        return hooks[path] ? hooks[path](real, ...args) : real();
      };
    }
    if (value === null || typeof value !== 'object' || typeof value.addListener === 'function') return value;
    return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, walk(path ? `${path}.${name}` : name, inner)]));
  };
  return walk('', adapter);
}

function makeEnv({ browserOptions = {}, stubOptions = {}, builtinKeys } = {}) {
  const browser = createFakeBrowser({ messages: { menuOpen: 'Interpret this tab' }, ...browserOptions });
  const stub = createStubHost(browser, stubOptions);
  const env = { browser, stub, log: [], hooks: {}, sw: null, starts: [], counts: [], attaches: [], injected: [] };
  browser.onCreateOffscreen = (context) => stub.attach(context);
  // The overlay stand-in: every content script created answers content/overlay-attach and records it.
  const overlay = (context) => {
    context.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      env.attaches.push({ tabId: context.tabId, message: JSON.parse(JSON.stringify(message)), at: browser.clock.now() });
      sendResponse({ ok: true });
      return true;
    });
  };
  browser.onContentCreated = overlay;
  browser.onInject = (tabId) => { env.injected.push(tabId); overlay(browser.createContext('content', { tabId })); };
  env.overlay = overlay;
  const timerLog = (fn, ms) => { env.log.push('timer'); return browser.clock.setTimeout(fn, ms); };
  browser.sw.register((chromeApi) => {
    const adapter = observe(createChromeAdapter(chromeApi), env.log, env.hooks);
    env.sw = createServiceWorker({ adapter, now: browser.clock.now, setTimeout: timerLog, ...(builtinKeys ? { builtinKeys } : {}) });
    env.sw.register();
    // Captured in the same synchronous turn as register(): proves the nine listeners are registered synchronously.
    env.starts.push([...browser.sw.context.listeners.keys()].sort());
    // ... and how many listeners each event got: the list above only names the events.
    env.counts.push(Object.fromEntries([...browser.sw.context.listeners].map(([name, list]) => [name, list.length])));
  });
  env.panel = browser.createContext('panel', { windowId: 1 });
  env.send = (context, type, payload) => context.chrome.runtime.sendMessage(makeMessage(type, payload));
  env.fromPanel = (type, payload = {}) => env.send(env.panel, type, payload);
  env.seedKey = () => env.panel.chrome.storage.local.set({ [STORAGE_KEYS.key]: { v: 1, value: KEY } });
  env.seedSettings = async (patch) => {
    const { readSettings } = await import('../extension/lib/settings.js');
    const current = JSON.parse(JSON.stringify(await readSettings(env.panel.chrome.storage.local)));
    await env.panel.chrome.storage.local.set({ [STORAGE_KEYS.settings]: patch(current) ?? current });
  };
  env.armTab = async (id, url = 'https://claude.ai/doc', { active = true } = {}) => {
    browser.addTab({ id, url, active });
    await browser.clickAction(id);
    await browser.settle();
  };
  env.session = () => browser.storageData('session');
  env.calls = (name) => env.log.filter((entry) => entry === name).length;
  // `pick` (§20): the panel's explicit request for Chrome's share dialog, the only way an un-armed tab is started.
  env.start = (lane, tabId, { pick = false } = {}) => env.fromPanel('sw/lane-start', lane === 'tab' ? { lane, tabId, ...(pick ? { pick } : {}) } : { lane });
  env.pick = (tabId) => env.start('tab', tabId, { pick: true });
  // §22: the panel opened the dialog itself and relays the tab's audio.
  env.relay = (tabId, { relay = RELAY_ID, passthrough = true, chosenTab = tabId, ...rest } = {}) => env.fromPanel('sw/lane-start',
    { lane: 'tab', tabId, relay, passthrough, chosenTab, ...rest });
  env.label = (tabId, nonce = LABEL_NONCE) => env.fromPanel('sw/tab-label', { tabId, nonce });
  env.advance = async (ms, promise) => {
    await browser.clock.advance(ms);
    return promise;
  };
  return env;
}

const assertOrder = (log, names) => {
  let at = -1;
  for (const name of names) {
    const next = log.indexOf(name, at + 1);
    assert.ok(next > at, `${name} follows ${at < 0 ? 'the start' : log[at]} in ${JSON.stringify(log)}`);
    at = next;
  }
};

// ---------------------------------------------------------------------------------------------
test('register() adds exactly the nine listeners of 6.1 synchronously, and no runtime.onConnect or commands.onCommand', () => {
  const env = makeEnv();
  const expected = ['action.onClicked', 'contextMenus.onClicked', 'runtime.onInstalled', 'runtime.onMessage', 'runtime.onStartup',
    'storage.onChanged', 'tabs.onActivated', 'tabs.onRemoved', 'tabs.onUpdated'];
  assert.deepEqual(env.starts[0], expected);
  assert.equal(env.starts[0].length, 9);
  assert.ok(!env.starts[0].includes('runtime.onConnect'));
  assert.ok(!env.starts[0].includes('commands.onCommand'));
  // Nine events is not nine listeners: a second registration on one event would run its handler twice per click.
  assert.deepEqual(env.counts[0], Object.fromEntries(expected.map((name) => [name, 1])), 'exactly one listener per event');
  assert.equal(Object.values(env.counts[0]).reduce((sum, count) => sum + count, 0), 9);
  assert.deepEqual(Object.keys(env.sw.handlers).sort(), ['onActionClicked', 'onInstalled', 'onMenuClicked', 'onStartup',
    'onStorageChanged', 'onTabActivated', 'onTabRemoved', 'onTabUpdated']);
});

test('bootstrap applies setPanelBehavior(false) and TRUSTED_CONTEXTS at every start, after a kill and at runtime.onStartup', async () => {
  const env = makeEnv();
  await env.browser.settle();
  assert.deepEqual(env.browser.panelBehavior, { openPanelOnActionClick: false });
  assert.equal(env.browser.accessLevel, 'TRUSTED_CONTEXTS');
  assert.equal(env.calls('sidePanel.setPanelBehavior'), 1);
  assert.equal(env.calls('storage.local.setAccessLevel'), 1);

  env.browser.sw.kill();
  await env.fromPanel('sw/host-probe');   // the next event revives the worker
  assert.equal(env.browser.sw.starts, 2);
  assert.equal(env.calls('sidePanel.setPanelBehavior'), 2, 're-applied after a restart');
  assert.equal(env.calls('storage.local.setAccessLevel'), 2);
  assert.equal(env.starts.length, 2);
  assert.deepEqual(env.starts[1], env.starts[0], 'a restart registers the same nine listeners');

  await env.browser.startup();   // runtime.onStartup on a LIVE worker runs bootstrap again
  assert.equal(env.calls('sidePanel.setPanelBehavior'), 3);
  assert.equal(env.calls('storage.local.setAccessLevel'), 3);
  assert.equal(env.browser.sw.starts, 2);
});

test('bootstrap swallows a failing API: setAccessLevel rejecting does not stop the other call or the listeners', async () => {
  const env = makeEnv();
  env.browser.failSetAccessLevel(true);
  env.browser.sw.kill();
  await env.fromPanel('sw/host-probe');
  assert.equal(env.calls('sidePanel.setPanelBehavior'), 2);
  assert.equal(env.browser.listenerErrors.length, 0);
});

test('onInstalled recreates the context menu once, clears the session keys and never throws "duplicate id"', async () => {
  const env = makeEnv();
  await env.panel.chrome.storage.session.set({ [STORAGE_KEYS.armed]: { v: 1, tabs: {} }, [STORAGE_KEYS.host]: { v: 1, up: true, hostId: 'h', at: 1 },
    [STORAGE_KEYS.lastStop]: { v: 1, reason: 'panel-gone', at: 1 }, [STORAGE_KEYS.autostart]: { v: 1, tabId: 7, windowId: 1, at: 1 } });
  await env.browser.install('install');
  await env.browser.install('update');
  assert.equal(env.browser.menus.length, 1);
  assert.deepEqual(env.browser.menus[0], { id: 'interp-open', title: 'Interpret this tab', contexts: ['page', 'video', 'audio', 'frame'] });
  assert.deepEqual(Object.keys(env.session()), []);
  assert.equal(env.browser.listenerErrors.length, 0);
});

// ---------------------------------------------------------------------------------------------
test('onActionClicked: sidePanel.open is the FIRST call, in the same synchronous turn, then the armed record', async (t) => {
  const env = makeEnv();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', windowId: 1, active: true });
  await env.browser.settle();
  env.log.length = 0;
  await env.browser.clickAction(7);
  await env.browser.settle();
  t.diagnostic(`onActionClicked call log: ${JSON.stringify(env.log)}`);
  assert.equal(env.log[0], 'sidePanel.open', 'no await and no storage read before sidePanel.open');
  assert.deepEqual(env.browser.panelOpens, [{ windowId: 1, tabId: null }], 'the strict gesture model let the call through');
  assert.deepEqual(env.log.slice(0, 3), ['sidePanel.open', 'storage.session.get', 'storage.session.set']);
  const record = env.session()[STORAGE_KEYS.armed];
  assert.equal(record.v, 1);
  assert.equal(record.tabs['7'].windowId, 1);
  assert.equal(record.tabs['7'].origin, 'https://claude.ai');
  assert.equal(typeof record.tabs['7'].at, 'number');
});

test('the context-menu path is the same: open first, then arm; a foreign menu id does nothing', async () => {
  const env = makeEnv();
  await env.browser.install('install');
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', windowId: 1, active: true });
  env.log.length = 0;
  await env.browser.clickContextMenu(7, 'interp-open');
  await env.browser.settle();
  assert.equal(env.log[0], 'sidePanel.open');
  assert.equal(env.browser.panelOpens.length, 1);
  assert.ok(env.session()[STORAGE_KEYS.armed].tabs['7']);
  assert.equal(await env.sw.handlers.onMenuClicked({ menuItemId: 'other' }, { id: 7, windowId: 1 }), undefined);
  assert.equal(await env.sw.handlers.onMenuClicked({ menuItemId: 'interp-open' }, undefined), undefined);
  assert.equal(env.browser.panelOpens.length, 1);
});

test('a rejected sidePanel.open (no gesture) still records the arm and does not throw into the browser', async () => {
  const env = makeEnv({ browserOptions: { strictGesture: true } });
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', windowId: 1, active: true });
  await env.sw.handlers.onActionClicked({ id: 7, windowId: 1, url: 'https://claude.ai/doc' });   // outside the gesture
  await env.browser.settle();
  assert.deepEqual(env.browser.panelOpens, []);
  assert.ok(env.session()[STORAGE_KEYS.armed].tabs['7']);
});

// ---------------------------------------------------------------------------------------------
// §20 (2026-10-02): the icon = start on this tab. Fails on 0.4.0, where the click only armed the tab and opened the panel.
test('§20 the toolbar icon asks the panel to start on that tab: open first, the arming written, THEN the autostart record', async (t) => {
  const env = makeEnv();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', windowId: 1, active: true });
  await env.browser.settle();
  env.log.length = 0;
  const writes = [];
  env.hooks['storage.session.set'] = (real, items) => { writes.push(Object.keys(items)); return real(); };
  await env.advance(1234, env.browser.clickAction(7));
  await env.browser.settle();
  t.diagnostic(`icon click call log: ${JSON.stringify(env.log)}`);
  assert.equal(env.log[0], 'sidePanel.open', 'still the first call: the user gesture');
  assert.deepEqual(writes.slice(0, 2), [[STORAGE_KEYS.armed], [STORAGE_KEYS.autostart]], 'the panel starts only on a tab it reads as armed');
  const record = env.session()[STORAGE_KEYS.autostart];
  assert.deepEqual(record, { v: 1, tabId: 7, windowId: 1, at: record.at });
  assert.equal(typeof record.at, 'number');
  assert.equal(env.stub.count('host/lane-start'), 0, 'the worker starts nothing by itself: the panel of that window does');
  // The shortcut (_execute_action dispatches action.onClicked) and the context menu write the same record.
  await env.browser.install('install');
  env.browser.addTab({ id: 8, url: 'https://example.com/video', windowId: 2, active: true });
  for (const [label, invoke] of [['shortcut', () => env.browser.pressShortcut(8)], ['context menu', () => env.browser.clickContextMenu(8, 'interp-open')]]) {
    await env.panel.chrome.storage.session.remove(STORAGE_KEYS.autostart);
    await invoke();
    await env.browser.settle();
    assert.deepEqual(env.session()[STORAGE_KEYS.autostart]?.tabId, 8, label);
    assert.deepEqual(env.session()[STORAGE_KEYS.autostart]?.windowId, 2, label);
  }
  assert.equal(env.browser.listenerErrors.length, 0);
});

test('§20 a page that cannot be captured gets no autostart record: the click only opens the panel (and arms, as before)', async () => {
  const env = makeEnv();
  for (const [id, url] of [[9, 'chrome://extensions'], [10, 'about:blank'], [11, 'chrome-extension://abc/panel.html'], [12, 'data:text/html,hi']]) {
    env.browser.addTab({ id, url, windowId: 1, active: true, content: false });
    await env.browser.clickAction(id);
    await env.browser.settle();
    assert.equal(env.session()[STORAGE_KEYS.autostart], undefined, url);
  }
  assert.equal(env.browser.panelOpens.length, 4, 'the panel still opens');
  // file: pages can be captured (with file access): they get one
  env.browser.addTab({ id: 13, url: 'file:///tmp/a.html', windowId: 1, active: true, content: false });
  await env.browser.clickAction(13);
  await env.browser.settle();
  assert.equal(env.session()[STORAGE_KEYS.autostart]?.tabId, 13);
});

// §20: 0.4.x started muted. An update from before 0.5.0 turns the voice on once; nothing else changes.
test('0.5.1 an update from a version before 0.5.1 moves a tab lane that still holds the OLD default model to the latest Live model, once, keeps a model the user chose, and never touches the voice from 0.5.0 on', async () => {
  const OLD = 'gemini-3.5-live-translate-preview';
  const LATEST = 'gemini-3.8-live';
  const stored = async (env) => env.browser.storageData('local')[STORAGE_KEYS.settings];
  const seed = (tabModel, micModel, speechMuted = false) => (settings) => ({ ...settings, speechMuted,
    lanes: { ...settings.lanes, tab: { ...settings.lanes.tab, model: tabModel }, mic: { ...settings.lanes.mic, model: micModel } } });

  // The 0.4.x / 0.5.0 default (the translation-only preview on the tab lane) moves; the microphone lane is not touched.
  for (const previousVersion of ['0.4.0', '0.5.0']) {
    const env = makeEnv();
    await env.seedSettings(seed(OLD, OLD));
    await env.browser.install('update', { previousVersion });
    await env.browser.settle();
    assert.deepEqual([(await stored(env)).lanes.tab.model, (await stored(env)).lanes.mic.model], [LATEST, OLD], previousVersion);
  }

  // From 0.5.0 on the voice is the user's own: the model move runs, a deliberate mute stays.
  const muted = makeEnv();
  await muted.seedSettings(seed(OLD, LATEST, true));
  await muted.browser.install('update', { previousVersion: '0.5.0' });
  await muted.browser.settle();
  assert.deepEqual([(await stored(muted)).lanes.tab.model, (await stored(muted)).speechMuted], [LATEST, true]);

  // Once: the user picks the translation-only preview again; an update from 0.5.1 on leaves that choice alone.
  const env = makeEnv();
  await env.seedSettings(seed(OLD, LATEST));
  for (const previousVersion of ['0.5.1', '0.5.2', '1.0']) {
    await env.browser.install('update', { previousVersion });
    await env.browser.settle();
    assert.equal((await stored(env)).lanes.tab.model, OLD, previousVersion);
  }

  // A model the user chose on purpose is not the old default: it stays, whatever it is.
  const chosen = makeEnv();
  await chosen.seedSettings(seed('gemini-2.5-flash-native-audio-latest', LATEST));
  await chosen.browser.install('update', { previousVersion: '0.4.0' });
  await chosen.browser.settle();
  assert.equal((await stored(chosen)).lanes.tab.model, 'gemini-2.5-flash-native-audio-latest');

  // Other reasons, an unreadable version, or no stored settings at all: nothing is written.
  for (const details of [['install', {}], ['chrome_update', { previousVersion: '0.4.0' }], ['update', {}], ['update', { previousVersion: 'x' }]]) {
    await env.browser.install(...details);
    await env.browser.settle();
    assert.equal((await stored(env)).lanes.tab.model, OLD, JSON.stringify(details));
  }
  const fresh = makeEnv();
  await fresh.browser.install('update', { previousVersion: '0.4.0' });
  await fresh.browser.settle();
  assert.equal(await stored(fresh), undefined, 'no record is created: the new defaults already say the latest model');
  assert.equal(env.browser.listenerErrors.length + muted.browser.listenerErrors.length + chosen.browser.listenerErrors.length + fresh.browser.listenerErrors.length, 0);
});

test('§20 an update from a version before 0.5.0 turns the interpreted voice on once and changes no other setting', async () => {
  const stored = async (env) => env.browser.storageData('local')[STORAGE_KEYS.settings];
  const env = makeEnv();
  await env.seedSettings((settings) => ({ ...settings, speechMuted: true, uiLanguage: 'ja',
    lanes: { ...settings.lanes, tab: { ...settings.lanes.tab, originalVolume: 65, targetLanguage: 'ja' } } }));
  const before = await stored(env);
  await env.browser.install('update', { previousVersion: '0.4.0' });
  await env.browser.settle();
  const after = await stored(env);
  assert.equal(after.speechMuted, false);
  assert.deepEqual({ ...after, speechMuted: true }, before, 'only speechMuted changed');
  // Once: a later mute is the user's own, and the next updates (from 0.5.0 on) leave it alone.
  await env.seedSettings((settings) => ({ ...settings, speechMuted: true }));
  for (const previousVersion of ['0.5.0', '0.5.1', '1.0']) {
    await env.browser.install('update', { previousVersion });
    await env.browser.settle();
    assert.equal((await stored(env)).speechMuted, true, previousVersion);
  }
  // Other reasons, an unreadable version, or no stored settings at all: nothing is written.
  for (const details of [['install', {}], ['chrome_update', { previousVersion: '0.4.0' }], ['update', {}], ['update', { previousVersion: 'x' }]]) {
    await env.browser.install(...details);
    await env.browser.settle();
    assert.equal((await stored(env)).speechMuted, true, JSON.stringify(details));
  }
  const fresh = makeEnv();
  await fresh.browser.install('update', { previousVersion: '0.3.1' });
  await fresh.browser.settle();
  assert.equal(await stored(fresh), undefined, 'no record is created: the panel still seeds the languages on its first run');
  assert.equal(env.browser.listenerErrors.length + fresh.browser.listenerErrors.length, 0);
});

// §20: without a personal key the whole built-in pool travels; a personal key wins alone.
test('§20 the built-in pool travels in the ONE host/lane-start (keys, no key); a stored personal key is sent alone', async () => {
  const POOL = [`synthetic-${'p'.repeat(24)}`, `synthetic-${'q'.repeat(24)}`, `synthetic-${'r'.repeat(24)}`];
  const env = makeEnv({ builtinKeys: POOL });
  await env.armTab(7);
  assert.deepEqual(await env.start('tab', 7), { ok: true });
  const [start] = env.stub.of('host/lane-start');
  assert.deepEqual(start.message.keys, POOL);
  assert.equal('key' in start.message, false);
  for (const key of POOL) {
    const carrying = env.browser.deliveries.filter((delivery) => delivery.json.includes(key));
    assert.equal(carrying.length, 1, 'each key is in exactly one delivery');
    assert.equal(JSON.parse(carrying[0].json).type, 'host/lane-start');
  }
  assert.equal(JSON.stringify(env.browser.storageData('session')).includes(POOL[0]), false);
  await env.fromPanel('sw/lane-stop', {});
  await env.seedKey();
  assert.deepEqual(await env.start('mic'), { ok: true });
  const mic = env.stub.of('host/lane-start').find((entry) => entry.message.lane === 'mic');
  assert.equal(mic.message.key, KEY);
  assert.equal('keys' in mic.message, false, 'a person\'s key never falls back to the pool');
});

// §24 (0.5.2): a lane on the default model follows the latest general Live model. The worker only reads its record and tells the
// lane; the lane asks the provider (it holds the key) and reports back what it saw.
const LATEST_ID = 'gemini-3.9-live';
const HOUR_MS = 60 * 60 * 1000;
const recordOf = (env, extra = {}) => ({ v: 1, newest: LATEST_ID, checkedAt: env.browser.clock.now(), failedAt: null, rejected: null, ...extra });
const putRecord = (env, record) => env.panel.chrome.storage.local.set({ [STORAGE_KEYS.latestLive]: record });
const recordNow = (env) => env.browser.storageData('local')[STORAGE_KEYS.latestLive];
const offscreenOf = (env) => env.browser.contexts().find((context) => context.kind === 'offscreen');

test('§24 a lane on the default model is told what the worker knows about the latest model: nothing known = ask first, a fresh record = use it, an older one = use it and ask again', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  assert.deepEqual(await env.start('tab', 7), { ok: true });
  const first = env.stub.of('host/lane-start').at(-1).message;
  assert.deepEqual(first.latest, { model: null, refresh: 'blocking' }, 'no record: the lane asks the provider before its first setup');
  await env.fromPanel('sw/lane-stop', {});

  await env.browser.clock.advance(3 * 24 * HOUR_MS);
  await putRecord(env, recordOf(env));
  assert.deepEqual(await env.start('mic'), { ok: true });
  assert.deepEqual(env.stub.of('host/lane-start').at(-1).message.latest, { model: LATEST_ID, refresh: 'none' }, 'a fresh record is used as it is');
  await env.fromPanel('sw/lane-stop', {});

  await env.browser.clock.advance(2 * HOUR_MS);
  assert.deepEqual(await env.start('mic'), { ok: true });
  assert.deepEqual(env.stub.of('host/lane-start').at(-1).message.latest, { model: LATEST_ID, refresh: 'background' });
  await env.fromPanel('sw/lane-stop', {});

  await env.browser.clock.advance(30 * HOUR_MS);
  assert.deepEqual(await env.start('mic'), { ok: true });
  assert.deepEqual(env.stub.of('host/lane-start').at(-1).message.latest, { model: LATEST_ID, refresh: 'background' }, 'a day later: still no wait');
  await env.fromPanel('sw/lane-stop', {});

  await env.browser.clock.advance(8 * 24 * HOUR_MS);
  assert.deepEqual(await env.start('mic'), { ok: true });
  assert.deepEqual(env.stub.of('host/lane-start').at(-1).message.latest, { model: LATEST_ID, refresh: 'blocking' }, 'expired (a week): ask first');
});

test('§24 a lane on a model the person chose is told nothing about the latest model; a damaged record never fails a start', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  await env.seedSettings((settings) => { settings.lanes.tab.model = 'gemini-3.5-live-translate-preview'; });
  await putRecord(env, recordOf(env));
  assert.deepEqual(await env.start('tab', 7), { ok: true });
  const [chosen] = env.stub.of('host/lane-start');
  assert.equal('latest' in chosen.message, false, 'the choice is the person\'s: nothing is adopted, nothing is asked');
  assert.equal(chosen.message.request.model, 'gemini-3.5-live-translate-preview');
  await env.fromPanel('sw/lane-stop', {});

  for (const damaged of ['text', 5, [], { v: 2 }, { ...recordOf(env), newest: 'gemini-3.9-live-preview' }, { ...recordOf(env), checkedAt: 'x' }, { v: 1 }, null]) {
    await putRecord(env, damaged);
    assert.deepEqual(await env.start('mic'), { ok: true }, JSON.stringify(damaged));
    assert.deepEqual(env.stub.of('host/lane-start').at(-1).message.latest, { model: null, refresh: 'blocking' }, `${JSON.stringify(damaged)} is no record`);
    await env.fromPanel('sw/lane-stop', {});
  }
});

test('§24 a record whose model the provider refused is left alone for six hours, and only that model; the key is never part of any of it', async () => {
  const POOL = [`synthetic-${'p'.repeat(24)}`, `synthetic-${'q'.repeat(24)}`];
  const env = makeEnv({ builtinKeys: POOL });
  await env.armTab(7);
  await env.browser.clock.advance(3 * 24 * HOUR_MS);
  await putRecord(env, recordOf(env, { rejected: { model: LATEST_ID, at: env.browser.clock.now() } }));
  assert.deepEqual(await env.start('mic'), { ok: true });
  assert.deepEqual(env.stub.of('host/lane-start').at(-1).message.latest, { model: null, refresh: 'none' }, 'refused a moment ago: not tried again');
  await env.fromPanel('sw/lane-stop', {});
  await env.browser.clock.advance(7 * HOUR_MS);
  await putRecord(env, recordOf(env, { rejected: { model: LATEST_ID, at: env.browser.clock.now() - 7 * HOUR_MS } }));
  assert.deepEqual(await env.start('mic'), { ok: true });
  assert.equal(env.stub.of('host/lane-start').at(-1).message.latest.model, LATEST_ID);
  assert.equal(JSON.stringify(recordNow(env)).includes('synthetic-'), false);
  // an expired record whose own candidate was just refused: asking first could not change what this start runs
  await env.fromPanel('sw/lane-stop', {});
  await env.browser.clock.advance(9 * 24 * HOUR_MS);
  await putRecord(env, recordOf(env, { checkedAt: env.browser.clock.now() - 8 * 24 * HOUR_MS, rejected: { model: LATEST_ID, at: env.browser.clock.now() - HOUR_MS } }));
  assert.deepEqual(await env.start('mic'), { ok: true });
  assert.deepEqual(env.stub.of('host/lane-start').at(-1).message.latest, { model: null, refresh: 'background' });
});

test('§24 sw/latest-live (from the offscreen host only): seen, failed and rejected change their own field of the record; two reports at once lose neither', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  await env.sw.ensureOffscreen();
  const host = offscreenOf(env);
  await env.browser.clock.advance(HOUR_MS);
  assert.deepEqual(await env.send(host, 'sw/latest-live', { kind: 'seen', newest: LATEST_ID }), { ok: true });
  assert.deepEqual(recordNow(env), { v: 1, newest: LATEST_ID, checkedAt: env.browser.clock.now(), failedAt: null, rejected: null });
  await env.browser.clock.advance(1000);
  const [failed, rejected] = await Promise.all([env.send(host, 'sw/latest-live', { kind: 'failed' }),
    env.send(host, 'sw/latest-live', { kind: 'rejected', model: LATEST_ID })]);
  assert.deepEqual([failed, rejected], [{ ok: true }, { ok: true }]);
  const record = recordNow(env);
  assert.equal(record.failedAt, env.browser.clock.now());
  assert.deepEqual(record.rejected, { model: LATEST_ID, at: env.browser.clock.now() });
  assert.equal(record.newest, LATEST_ID, 'the answer of the earlier look stays');
  await env.send(host, 'sw/latest-live', { kind: 'seen', newest: null });
  assert.deepEqual([recordNow(env).newest, recordNow(env).failedAt], [null, null], 'a look that found none says so, and ends the cool-down');
  // not the host: refused before any write
  const before = JSON.stringify(recordNow(env));
  for (const sender of [env.panel, env.browser.createContext('options'), env.browser.createContext('permission')]) {
    assert.deepEqual(await env.send(sender, 'sw/latest-live', { kind: 'seen', newest: 'gemini-9.0-live' }), { ok: false, code: 'FORBIDDEN' });
  }
  // a receiver refuses what the sender's makeMessage would have refused too: sent raw, as a hostile page of the extension could
  assert.deepEqual(await host.chrome.runtime.sendMessage({ v: 1, target: 'sw', type: 'sw/latest-live', kind: 'seen', newest: 'gemini-3.5-live-translate-preview' }),
    { ok: false, code: 'INVALID_MESSAGE' });
  assert.equal(JSON.stringify(recordNow(env)), before, 'nothing was written by a refused or invalid report');
});

test('§24 the report queue survives a link that rejects: a later report is still applied', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  await env.sw.ensureOffscreen();
  const host = offscreenOf(env);
  let poisoned = true;
  env.hooks['storage.local.get'] = (real, ...args) => (poisoned && args[0] === STORAGE_KEYS.latestLive
    ? { get [STORAGE_KEYS.latestLive]() { throw new Error('unreadable'); } } : real());
  assert.deepEqual(await env.send(host, 'sw/latest-live', { kind: 'seen', newest: LATEST_ID }), { ok: true });
  assert.equal(recordNow(env), undefined, 'the poisoned report wrote nothing');
  poisoned = false;
  assert.deepEqual(await env.send(host, 'sw/latest-live', { kind: 'seen', newest: LATEST_ID }), { ok: true });
  assert.equal(recordNow(env)?.newest, LATEST_ID, 'the next one is applied');
});

test('§24 a report that arrives while the storage is failing never breaks the worker or the next start', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  await env.sw.ensureOffscreen();
  const host = offscreenOf(env);
  env.hooks['storage.local.set'] = async () => { throw new Error('quota'); };
  assert.deepEqual(await env.send(host, 'sw/latest-live', { kind: 'seen', newest: LATEST_ID }), { ok: true });
  assert.equal(recordNow(env), undefined);
});

// ---------------------------------------------------------------------------------------------
test('sw/lane-start (tab): the order of 6.3, the mint is the LAST awaited step, the key travels in ONE message only', async (t) => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  env.log.length = 0;
  const res = await env.start('tab', 7);
  await env.browser.settle();
  assert.deepEqual(res, { ok: true });
  t.diagnostic(`sw/lane-start call log: ${JSON.stringify(env.log)}`);

  assertOrder(env.log, ['storage.local.get', 'tabs.get', 'storage.session.get', 'offscreen.createDocument',
    'runtime.sendMessage:host/ping', 'storage.session.set', 'tabCapture.getMediaStreamId', 'runtime.sendMessage:host/lane-start']);
  const mint = env.log.indexOf('tabCapture.getMediaStreamId');
  assert.equal(env.log[mint + 1], 'runtime.sendMessage:host/lane-start', 'nothing, not even a timer, between the mint and the send');
  assert.equal(env.calls('tabCapture.getMediaStreamId'), 1);
  assert.ok(env.log.indexOf('offscreen.createDocument') < mint && env.log.lastIndexOf('runtime.sendMessage:host/ping') < mint);

  const [start] = env.stub.of('host/lane-start');
  assert.equal(env.stub.count('host/lane-start'), 1);
  const message = start.message;
  assert.equal(message.lane, 'tab');
  assert.equal(message.key, KEY);
  assert.match(message.tab.streamId, /^fake-stream-\d+$/);
  assert.equal(message.tab.tabId, 7);
  assert.equal(message.tab.originalVolume, 45, '§20: the starting original volume');
  assert.deepEqual(message.request, { targetLanguage: 'en', model: 'gemini-3.8-live' }, '0.5.1: the latest Live model on the tab lane');
  assert.deepEqual(Object.keys(message.tab).sort(), ['originalVolume', 'streamId', 'tabId'], 'an armed tab never carries a picker nonce');
  assert.equal(message.voiceGender, 'female');
  assert.equal(message.muted, false, '§20: the interpreted voice plays by default');
  assert.equal(message.captions, true);
  assert.deepEqual(Object.keys(message.style).sort(), ['autoHideSeconds', 'display', 'maxLines', 'position', 'showSource', 'size']);
  assert.ok(env.browser.captures.has(7), 'the host consumed the id');
  assert.deepEqual(env.browser.offscreenDocument.reasons, ['USER_MEDIA', 'DISPLAY_MEDIA']);
  assert.equal(env.calls('tabs.query'), 1, 'only the overlay lookup of the active tab: an armed start labels no page');
  assert.equal(env.calls('tabs.sendMessage:content/capture-label'), 0);
  assert.equal(env.session()[STORAGE_KEYS.host].up, true);
  assert.equal(env.session()[STORAGE_KEYS.host].hostId, 'h-stub');

  // The key, and the stream id, appear in exactly one delivery and nowhere else.
  const streamId = message.tab.streamId;
  const carrying = (needle) => env.browser.deliveries.filter((delivery) => delivery.json.includes(needle));
  assert.equal(carrying(KEY).length, 1);
  assert.equal(carrying(KEY)[0].kind, 'message');
  assert.equal(carrying(KEY)[0].to, 'offscreen');
  assert.equal(carrying(streamId).length, 1);
  assert.equal(carrying(streamId)[0].kind, 'message');
  assert.equal(carrying(KEY).filter((delivery) => delivery.to === 'content' || delivery.kind === 'port-frame').length, 0);
  const stored = JSON.stringify([env.session(), env.browser.storageData('local')[STORAGE_KEYS.settings] ?? null]);
  assert.equal(stored.includes(KEY) || stored.includes(streamId), false, 'neither is stored outside the key record');
  for (const request of env.stub.requests) if (request.type !== 'host/lane-start') assert.equal(JSON.stringify(request.message).includes(KEY), false, request.type);
});

test('sw/lane-start (mic): no arming, no tabId, no mint, and the mic defaults reach the host', async () => {
  const env = makeEnv();
  await env.seedKey();
  await env.browser.settle();
  env.log.length = 0;
  assert.deepEqual(await env.start('mic'), { ok: true });
  assert.equal(env.calls('tabCapture.getMediaStreamId'), 0);
  assert.equal(env.calls('tabs.get'), 0);
  const [start] = env.stub.of('host/lane-start');
  assert.equal(start.message.lane, 'mic');
  assert.equal('tab' in start.message, false);
  assert.deepEqual(start.message.request, { targetLanguage: 'ja', model: 'gemini-3.8-live' });
  assert.equal(start.message.captions, false, 'mic captions are opt-in (F14)');
});

// §19 (2026-09-30) reverses one case of this test: an un-armed tab is no longer refused with NEEDS_ARM (its start goes
// through the share picker, pinned by the tests of §19 below), so it left this list.
test('start refusals happen before any host exists: no key, a page that cannot be captured, a tab that is gone', async () => {
  const env = makeEnv();
  await env.armTab(7);
  assert.deepEqual(await env.start('tab', 7), { ok: false, code: 'CREDENTIAL_REQUIRED' });
  await env.seedKey();
  await env.browser.settle();

  env.browser.addTab({ id: 9, url: 'chrome://extensions', active: false, content: false });
  await env.browser.clickAction(9);
  await env.browser.settle();
  assert.deepEqual(await env.start('tab', 9), { ok: false, code: 'TAB_UNSUPPORTED' });
  for (const [id, url] of [[10, 'about:blank'], [11, 'chrome-extension://abc/panel.html'], [12, 'data:text/html,hi']]) {
    env.browser.addTab({ id, url, active: false, content: false });
    await env.browser.clickAction(id);
    await env.browser.settle();
    assert.deepEqual(await env.start('tab', id), { ok: false, code: 'TAB_UNSUPPORTED' }, url);
  }
  assert.deepEqual(await env.start('tab', 999), { ok: false, code: 'TAB_GONE' });

  assert.equal(env.calls('tabCapture.getMediaStreamId'), 0, 'no stream id was ever minted');
  assert.equal(env.calls('offscreen.createDocument'), 0, 'no host was created');
  assert.equal(env.browser.offscreenDocument, null);
});

test('a file: page is allowed, and a corrupt key record counts as no key', async () => {
  const env = makeEnv();
  await env.armTab(7, 'file:///tmp/a.html');
  await env.panel.chrome.storage.local.set({ [STORAGE_KEYS.key]: { v: 2, value: KEY } });
  assert.deepEqual(await env.start('tab', 7), { ok: false, code: 'CREDENTIAL_REQUIRED' });
  await env.seedKey();
  assert.deepEqual(await env.start('tab', 7), { ok: true });
});

// §19 went on through the share picker after this error; §20 answers NEEDS_ARM (the panel then waits for the icon) unless
// the panel asked for the dialog. The stale record is cleared either way.
test('the exact grant error from the mint clears the armed record: NEEDS_ARM, or the share picker when the panel asked for it', async () => {
  const env = makeEnv();
  await env.seedKey();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  // A stale record: the worker believes the tab is armed, Chromium holds no grant.
  const stale = { [STORAGE_KEYS.armed]: { v: 1, tabs: { 7: { windowId: 1, origin: 'https://claude.ai', at: 1 } } } };
  await env.panel.chrome.storage.session.set(stale);
  assert.equal(env.browser.hasGrant(7), false);
  const seen = [];
  env.hooks['tabCapture.getMediaStreamId'] = async (real) => {
    try { return await real(); } catch (error) { seen.push(error.message); throw error; }
  };
  env.stub.choice = { tabId: 7 };
  assert.deepEqual(await env.start('tab', 7), { ok: false, code: 'NEEDS_ARM' });
  assert.deepEqual(seen, [GRANT_ERROR]);
  assert.equal(env.session()[STORAGE_KEYS.armed].tabs['7'], undefined);
  assert.equal(env.stub.count('host/lane-start'), 0, 'nothing was asked of the host');
  // Unlike the refusal of a tab that has no armed record at all (next test), this one comes from the MINT, which is step 6:
  // the document was created and flagged up before it (docs/extension.md §20 must not claim "before any host work" for it).
  assert.notEqual(env.browser.offscreenDocument, null, 'a stale record is only found by the mint, after the document exists');
  assert.equal(env.session()[STORAGE_KEYS.host].up, true);

  await env.panel.chrome.storage.session.set(stale);
  assert.deepEqual(await env.pick(7), { ok: true });
  assert.deepEqual(seen, [GRANT_ERROR, GRANT_ERROR]);
  assert.equal(env.session()[STORAGE_KEYS.armed].tabs['7'], undefined);
  assert.equal(env.stub.count('host/lane-start'), 1);
  const { tab } = env.stub.of('host/lane-start')[0].message;
  assert.deepEqual(Object.keys(tab).sort(), ['originalVolume', 'pick'], 'no stream id: the host asks through the picker');
  assert.match(tab.pick, /^[a-f0-9]{32}$/);
});

// ---------------------------------------------------------------------------------------------
// §20 (2026-10-02): an un-armed tab is NEEDS_ARM again, unless the panel asked for the share dialog. Fails on 0.4.0, where
// every start of an un-armed tab opened the dialog by itself.
test('§20 an UN-ARMED tab without `pick` is NEEDS_ARM before any host work: no document, no label, no dialog', async () => {
  const env = makeEnv();
  await env.seedKey();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  await env.browser.settle();
  env.log.length = 0;
  assert.deepEqual(await env.start('tab', 7), { ok: false, code: 'NEEDS_ARM' });
  assert.equal(env.calls('offscreen.createDocument'), 0, 'a press that only waits for the icon creates no offscreen document');
  assert.equal(env.calls('tabCapture.getMediaStreamId'), 0);
  assert.equal(env.calls('tabs.sendMessage:content/capture-label'), 0);
  assert.equal(env.browser.offscreenDocument, null);
  assert.equal(env.stub.count('host/lane-start'), 0);
  // pick:false is the default, and the microphone ignores it
  assert.deepEqual(await env.fromPanel('sw/lane-start', { lane: 'tab', tabId: 7, pick: false }), { ok: false, code: 'NEEDS_ARM' });
  assert.deepEqual(await env.fromPanel('sw/lane-start', { lane: 'mic', pick: true }), { ok: true });
  // the icon click arms the tab: the same start takes the instant path
  await env.browser.clickAction(7);
  await env.browser.settle();
  assert.deepEqual(await env.start('tab', 7), { ok: true });
  assert.equal(env.stub.of('host/lane-start').find((entry) => entry.message.lane === 'tab').message.tab.streamId.startsWith('fake-stream-'), true);
});

// §19 (2026-09-30): the share-picker start, which §20 keeps as the explicit other way (`pick: true`, the panel's
// "Or choose the tab in a Chrome window" button). Unchanged from §19 apart from that flag.
test('§19 an UN-ARMED tab is not refused: the panel\'s tab alone gets a capture label, then the host is asked to open the share picker', async (t) => {
  const env = makeEnv();
  await env.seedKey();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });      // the tab the panel is on, never armed
  env.browser.addTab({ id: 8, url: 'http://example.com/video', active: false });
  env.browser.addTab({ id: 9, url: 'chrome://extensions', active: false, content: false });
  await env.browser.settle();
  env.stub.choice = { tabId: 7 };
  env.log.length = 0;
  assert.deepEqual(await env.pick(7), { ok: true });
  await env.browser.settle();
  t.diagnostic(`un-armed start call log: ${JSON.stringify(env.log)}`);

  assert.equal(env.calls('tabCapture.getMediaStreamId'), 0, 'no mint is attempted for a tab that was never armed');
  const [start] = env.stub.of('host/lane-start');
  assert.equal(env.stub.count('host/lane-start'), 1);
  const nonce = start.message.tab.pick;
  assert.match(nonce, /^[a-f0-9]{32}$/);
  assert.deepEqual(start.message.tab, { pick: nonce, originalVolume: 45 }, 'a nonce and the volume: no stream id, no tab id');
  assert.equal(start.message.key, KEY);

  // ONE label, `<nonce>.<tabId>`, for the tab the panel is on, to its top frame, BEFORE the host is asked. No other
  // page is touched: a page has one capture-handle setting and cannot get its own back once it is replaced.
  const labels = env.attaches.filter((entry) => entry.message.type === 'content/capture-label');
  assert.deepEqual(labels.map((entry) => [entry.tabId, entry.message.label]), [[7, `${nonce}.7`]]);
  assert.equal(env.calls('tabs.sendMessage:content/capture-label'), 1);
  assertOrder(env.log, ['storage.local.get', 'tabs.get', 'offscreen.createDocument',
    'tabs.sendMessage:content/capture-label', 'runtime.sendMessage:host/lane-start']);

  // the tab the host identified gets the page captions
  const attached = env.attaches.filter((entry) => entry.message.type === 'content/overlay-attach');
  assert.deepEqual(attached.map((entry) => entry.tabId), [7]);
  assert.equal(env.session()[STORAGE_KEYS.host].up, true);
  // the nonce is in the label message and the one start message, never in storage
  assert.equal(JSON.stringify([env.session(), env.browser.storageData('local')]).includes(nonce), false);
});

test('§19 a page that cannot take a label is not asked, and a page that never answers delays the start by LIMITS.pickLabelWaitMs at most', async () => {
  // chrome:// and file: pages have no content script: no message at all, the start goes straight to the host.
  for (const url of ['chrome://extensions', 'file:///tmp/a.html']) {
    const env = makeEnv();
    await env.seedKey();
    env.browser.addTab({ id: 7, url, active: true, content: false });
    await env.browser.settle();
    const res = await env.pick(7);
    assert.equal(env.calls('tabs.sendMessage:content/capture-label'), 0, url);
    if (url.startsWith('file:')) assert.deepEqual(res, { ok: true }); else assert.deepEqual(res, { ok: false, code: 'TAB_UNSUPPORTED' });
  }
  // A content script that never answers (a frozen tab).
  const env = makeEnv();
  await env.seedKey();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  await env.browser.settle();
  env.hooks['tabs.sendMessage'] = (real, tabId, message) => (message?.type === 'content/capture-label' ? new Promise(() => {}) : real());
  const pending = env.pick(7);
  // §22 gave the panel's own label wait (LIMITS.labelWaitMs) more time; this start keeps its 500 ms.
  assert.equal(LIMITS.pickLabelWaitMs, 500);
  await env.browser.clock.advance(LIMITS.pickLabelWaitMs - 1);
  assert.equal(env.stub.count('host/lane-start'), 0, 'still waiting for the label');
  await env.browser.clock.advance(1);
  assert.deepEqual(await pending, { ok: true });
  assert.equal(env.stub.count('host/lane-start'), 1);
});

test('§19 Stop during the label wait ends the start at once: nothing reaches the host as a start, and the next Start works', async () => {
  const env = makeEnv();
  await env.seedKey();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  await env.browser.settle();
  env.hooks['tabs.sendMessage'] = (real, tabId, message) => (message?.type === 'content/capture-label' ? new Promise(() => {}) : real());
  const first = env.pick(7);
  await env.browser.settle();
  assert.equal(env.calls('tabs.sendMessage:content/capture-label'), 1, 'the start is inside the label wait');
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  // No clock advance: the wait does not run out its 500 ms. (Raced, so a worker that kept waiting fails here instead of hanging.)
  await env.browser.settle();
  assert.deepEqual(await Promise.race([first, Promise.resolve('still waiting for the label')]), { ok: false, code: 'START_CANCELLED' });
  assert.equal(env.stub.count('host/lane-start'), 0);
  delete env.hooks['tabs.sendMessage'];
  assert.deepEqual(await env.pick(7), { ok: true });
});

test('§19 HOST_UNAVAILABLE on a picker start is re-sent only while the document may not have been listening yet', async () => {
  // At once: the one retry of every start (a document that was not listening yet).
  const early = makeEnv();
  await early.seedKey();
  early.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  await early.browser.settle();
  let sends = 0;
  early.stub.on('host/lane-start', () => (++sends === 1 ? { ok: false, code: 'HOST_UNAVAILABLE' } : PASS));
  assert.deepEqual(await early.pick(7), { ok: true });
  assert.equal(early.stub.count('host/lane-start'), 2);

  // After the dialog has been open for a while: the document went away. A re-send would open a second dialog by
  // itself and send the key again, so the failure is reported instead.
  const late = makeEnv();
  await late.seedKey();
  late.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  await late.browser.settle();
  const answer = deferred();
  late.stub.on('host/lane-start', () => answer.promise);
  const pending = late.pick(7);
  await late.browser.settle();
  await late.browser.clock.advance(5000);
  answer.release({ ok: false, code: 'HOST_UNAVAILABLE' });
  assert.deepEqual(await pending, { ok: false, code: 'HOST_UNAVAILABLE' });
  assert.equal(late.stub.count('host/lane-start'), 1, 'not asked a second time');
  // and the keep-alive loop ended with the start
  late.log.length = 0;
  await late.browser.clock.advance(LIMITS.pickKeepAliveMs * 2);
  assert.equal(late.calls('storage.session.get'), 0);
});

test('§19 each start uses a fresh nonce, and a tab that could not be identified gets no page captions', async () => {
  const env = makeEnv();
  await env.seedKey();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  await env.browser.settle();
  env.stub.choice = { tabId: null };   // a page without the content script: the host cannot tell which tab it is
  assert.deepEqual(await env.pick(7), { ok: true });
  await env.advance(3000, env.browser.settle());
  assert.equal(env.attaches.filter((entry) => entry.message.type === 'content/overlay-attach').length, 0,
    'never the active tab by guess: captions of one tab must not be drawn over another');
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  assert.deepEqual(await env.pick(7), { ok: true });
  assert.equal(env.stub.picks.length, 2);
  assert.notEqual(env.stub.picks[0], env.stub.picks[1]);
});

test('§19 closing the picker comes back as the silent START_CANCELLED; what was shared without audio as TAB_SHARE_NO_AUDIO', async () => {
  const env = makeEnv();
  await env.seedKey();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  await env.browser.settle();
  env.stub.choice = { code: 'START_CANCELLED' };
  assert.deepEqual(await env.pick(7), { ok: false, code: 'START_CANCELLED' });
  env.stub.choice = { code: 'TAB_SHARE_NO_AUDIO' };
  assert.deepEqual(await env.pick(7), { ok: false, code: 'TAB_SHARE_NO_AUDIO' });
  assert.equal(env.session()[STORAGE_KEYS.lastStop], undefined);
  env.stub.choice = { tabId: 7 };
  assert.deepEqual(await env.pick(7), { ok: true }, 'and the next Start asks again');
});

test('§19 while the picker is open the worker keeps itself awake, a second Start is ALREADY_RUNNING, and Stop ends the start at once', async () => {
  const env = makeEnv();
  await env.seedKey();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  await env.browser.settle();
  const gate = env.stub.hold('pick');
  const first = env.pick(7);
  await env.browser.settle();
  assert.equal(env.stub.count('host/lane-start'), 1, 'the start is waiting for the user inside host/lane-start');
  env.log.length = 0;
  // Two keep-alive periods pass with the dialog open: one cheap storage read each, nothing else.
  await env.browser.clock.advance(LIMITS.pickKeepAliveMs * 2);
  assert.equal(env.calls('storage.session.get'), 2);
  assert.deepEqual(env.log.filter((entry) => entry !== 'timer' && entry !== 'storage.session.get'), []);
  assert.deepEqual(await env.pick(7), { ok: false, code: 'ALREADY_RUNNING' });
  // Stop: the host is told, and the start answers START_CANCELLED as soon as the host lets go.
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  gate.release();
  assert.deepEqual(await first, { ok: false, code: 'START_CANCELLED' });
  assert.ok(env.stub.stops.tab >= 1);
  // The loop has ended: more time brings no further reads.
  env.log.length = 0;
  await env.browser.clock.advance(LIMITS.pickKeepAliveMs * 3);
  assert.equal(env.calls('storage.session.get'), 0);
});

test('§19 an ARMED tab whose start succeeds never keeps the worker awake and never labels a page', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  env.log.length = 0;
  assert.deepEqual(await env.start('tab', 7), { ok: true });
  await env.browser.settle();
  env.log.length = 0;
  await env.browser.clock.advance(LIMITS.pickKeepAliveMs * 2);
  assert.equal(env.calls('storage.session.get'), 0);
  assert.equal(env.attaches.filter((entry) => entry.message.type === 'content/capture-label').length, 0);
});

// ---------------------------------------------------------------------------------------------
// §22 (2026-10-08): the panel opens the share dialog itself (Chrome 153+). sw/tab-label labels its tab first; the relay
// start skips everything the dialog needed from the worker. Every test here fails on 0.5.0.
test('§22 sw/tab-label puts `<nonce>.<tabId>` on the panel\'s tab (top frame) and answers labelled:true; no document, no mint, no other page', async () => {
  const env = makeEnv();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  env.browser.addTab({ id: 8, url: 'https://example.com/other', active: false });
  await env.browser.settle();
  env.log.length = 0;
  assert.deepEqual(await env.label(7), { ok: true, labelled: true });
  const labels = env.attaches.filter((entry) => entry.message.type === 'content/capture-label');
  assert.deepEqual(labels.map((entry) => [entry.tabId, entry.message.label]), [[7, `${LABEL_NONCE}.7`]]);
  assertOrder(env.log, ['tabs.get', 'tabs.sendMessage:content/capture-label']);
  assert.equal(env.calls('offscreen.createDocument'), 0);
  assert.equal(env.calls('tabCapture.getMediaStreamId'), 0);
  assert.equal(env.browser.offscreenDocument, null);
  assert.equal(JSON.stringify([env.session(), env.browser.storageData('local')]).includes(LABEL_NONCE), false, 'the nonce is never stored');
});

test('§22 sw/tab-label is never an error: a page that cannot take a label, a tab that is gone, a page that refuses or never answers is labelled:false', async () => {
  const env = makeEnv();
  env.browser.addTab({ id: 7, url: 'chrome://extensions', active: true, content: false });
  env.browser.addTab({ id: 8, url: 'file:///tmp/a.html', active: false, content: false });
  env.browser.addTab({ id: 9, url: 'https://claude.ai/no-script', active: false, content: false });
  env.browser.addTab({ id: 10, url: 'https://claude.ai/frozen', active: false });
  await env.browser.settle();
  assert.deepEqual(await env.label(7), { ok: true, labelled: false }, 'chrome://: not asked');
  assert.deepEqual(await env.label(8), { ok: true, labelled: false }, 'file:: not asked');
  assert.deepEqual(await env.label(999), { ok: true, labelled: false }, 'a tab that is gone');
  assert.equal(env.calls('tabs.sendMessage:content/capture-label'), 0);
  assert.deepEqual(await env.label(9), { ok: true, labelled: false }, 'no content script: the send fails at once');
  // a page that never answers: the worker waits LIMITS.labelWaitMs (1500 ms), not a moment less
  assert.equal(LIMITS.labelWaitMs, 1500);
  env.hooks['tabs.sendMessage'] = (real, tabId, message) => (message?.type === 'content/capture-label' ? new Promise(() => {}) : real());
  const pending = env.label(10);
  let answered = null;
  pending.then((value) => { answered = value; });
  await env.browser.clock.advance(LIMITS.labelWaitMs - 1);
  assert.equal(answered, null, 'still waiting one millisecond before the limit');
  await env.browser.clock.advance(1);
  assert.deepEqual(await pending, { ok: true, labelled: false });
  // a page that answers something other than ok:true
  env.hooks['tabs.sendMessage'] = (real, tabId, message) => (message?.type === 'content/capture-label' ? Promise.resolve({ ok: false }) : real());
  assert.deepEqual(await env.label(10), { ok: true, labelled: false });
  // only the panel may ask, and a bad nonce never reaches a page
  const options = env.browser.createContext('options');
  assert.deepEqual(await env.send(options, 'sw/tab-label', { tabId: 10, nonce: LABEL_NONCE }), { ok: false, code: 'FORBIDDEN' });
  delete env.hooks['tabs.sendMessage'];
  const sent = env.calls('tabs.sendMessage:content/capture-label');
  assert.deepEqual(await env.panel.chrome.runtime.sendMessage({ v: 1, target: 'sw', type: 'sw/tab-label', tabId: 10, nonce: 'nope' }), { ok: false, code: 'INVALID_MESSAGE' });
  assert.equal(env.calls('tabs.sendMessage:content/capture-label'), sent);
});

test('§22 a relay start asks the worker for nothing the dialog needed: no tab lookup, no arming, no mint, no label, no keep-alive; the host gets the relay shape', async (t) => {
  const env = makeEnv();
  await env.seedKey();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });   // the panel's tab, never armed
  env.browser.addTab({ id: 9, url: 'https://example.com/talk', active: false }); // the tab chosen in the panel's dialog
  await env.browser.settle();
  env.log.length = 0;
  assert.deepEqual(await env.relay(7, { chosenTab: 9, passthrough: false }), { ok: true });
  await env.browser.settle();
  t.diagnostic(`relay start call log: ${JSON.stringify(env.log)}`);
  assert.equal(env.calls('tabs.get'), 0, 'the panel\'s tab is not looked up');
  assert.equal(env.calls('tabCapture.getMediaStreamId'), 0);
  assert.equal(env.calls('tabs.sendMessage:content/capture-label'), 0, 'the panel labelled its tab itself (sw/tab-label)');
  assertOrder(env.log, ['storage.local.get', 'offscreen.createDocument', 'runtime.sendMessage:host/ping', 'storage.session.set', 'runtime.sendMessage:host/lane-start']);
  const [start] = env.stub.of('host/lane-start');
  assert.deepEqual(start.message.tab, { relay: RELAY_ID, tabId: 9, passthrough: false, originalVolume: 45 });
  assert.equal(start.message.key, KEY, 'the key still travels in the one host/lane-start');
  assert.equal(env.session()[STORAGE_KEYS.host].up, true, 'the document exists and is flagged up');
  // the chosen tab gets the page captions
  assert.deepEqual(env.attaches.filter((entry) => entry.message.type === 'content/overlay-attach').map((entry) => entry.tabId), [9]);
  // no keep-alive loop: time passes without a storage read
  env.log.length = 0;
  await env.browser.clock.advance(LIMITS.pickKeepAliveMs * 2);
  assert.equal(env.calls('storage.session.get'), 0);
  // the panel's tab may be anything, even a page that could not be captured by itself, or gone
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  env.browser.addTab({ id: 11, url: 'chrome://newtab', active: false, content: false });
  assert.deepEqual(await env.relay(11, { chosenTab: 9 }), { ok: true });
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  assert.deepEqual(await env.relay(999, { chosenTab: 9 }), { ok: true });
});

test('§22 a relay start whose tab the panel could not name attaches no page overlay (never the active tab by guess)', async () => {
  const env = makeEnv();
  await env.seedKey();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  await env.browser.settle();
  assert.deepEqual(await env.relay(7, { chosenTab: null }), { ok: true });
  await env.advance(3000, env.browser.settle());
  assert.equal(env.attaches.filter((entry) => entry.message.type === 'content/overlay-attach').length, 0);
  assert.equal(env.stub.relays[0].tabId, null);
  // an absent chosenTab is the same as null
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  assert.deepEqual(await env.fromPanel('sw/lane-start', { lane: 'tab', tabId: 7, relay: RELAY_ID, passthrough: true }), { ok: true });
  assert.equal(env.stub.relays[1].tabId, null);
});

test('§22 `pick` and `relay` together is INVALID_REQUEST before anything happens', async () => {
  const env = makeEnv();
  await env.seedKey();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  await env.browser.settle();
  env.log.length = 0;
  assert.deepEqual(await env.relay(7, { pick: true }), { ok: false, code: 'INVALID_REQUEST' });
  assert.equal(env.calls('storage.local.get'), 0);
  assert.equal(env.calls('offscreen.createDocument'), 0);
  assert.equal(env.stub.count('host/lane-start'), 0);
  assert.deepEqual(await env.relay(7, { pick: false }), { ok: true }, '`pick: false` is no pick');
});

test('§22 a relay start still waits out a stopping lane, refuses a running one, and a second Start while it waits is ALREADY_RUNNING', async () => {
  const env = makeEnv();
  await env.seedKey();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  await env.browser.settle();
  // running
  assert.deepEqual(await env.relay(7), { ok: true });
  assert.deepEqual(await env.relay(7, { relay: 'abcdef0123456789'.repeat(2) }), { ok: false, code: 'ALREADY_RUNNING' });
  assert.equal(env.stub.count('host/lane-start'), 1, 'refused before the host was asked');
  // stopping, settles within the wait
  env.stub.lanes.tab = 'stopping';
  env.browser.clock.setTimeout(() => { env.stub.lanes.tab = 'off'; }, 300);
  const waiting = env.relay(7);
  await env.browser.clock.advance(LIMITS.stopWaitMs);
  assert.deepEqual(await waiting, { ok: true });
  // stopping for good: LANE_STOPPING
  env.stub.lanes.tab = 'stopping';
  const stuck = env.relay(7);
  await env.browser.clock.advance(LIMITS.stopWaitMs + 500);
  assert.deepEqual(await stuck, { ok: false, code: 'LANE_STOPPING' });
  // while a relay start waits for the panel's first audio, another Start is ALREADY_RUNNING
  env.stub.lanes.tab = 'off';
  const gate = env.stub.hold('relay');
  const held = env.relay(7);
  await env.browser.settle();
  assert.deepEqual(await env.relay(7), { ok: false, code: 'ALREADY_RUNNING' });
  gate.release();
  assert.deepEqual(await held, { ok: true });
});

test('§22 a Stop of a relay start never closes the document for a left-over dialog (there is none): the start ends START_CANCELLED, the host is told', async () => {
  const env = makeEnv();
  await env.seedKey();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  await env.browser.settle();
  const gate = env.stub.hold('relay');   // the host waits for the panel's first audio
  const first = env.relay(7);
  await env.browser.settle();
  assert.equal(env.stub.relays.length, 1, 'the relay start is inside the host');
  env.log.length = 0;
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  assert.equal(env.calls('offscreen.closeDocument'), 0, 'closeLeftOverDialog never fires for a relay start');
  assert.notEqual(env.browser.offscreenDocument, null);
  assert.equal(hostFlag(env).up, true);
  assert.ok(env.stub.stops.tab >= 1, 'the host got its host/lane-stop');
  gate.release();
  assert.deepEqual(await first, { ok: false, code: 'START_CANCELLED' });
  assert.equal(env.stub.count('host/lane-start'), 1, 'not sent again');
  // the same for a Stop of everything
  const again = env.stub.hold('relay');
  const second = env.relay(7);
  await env.browser.settle();
  env.log.length = 0;
  assert.deepEqual(await env.fromPanel('sw/lane-stop'), { ok: true });
  assert.equal(env.calls('offscreen.closeDocument'), 0);
  again.release();
  assert.deepEqual(await second, { ok: false, code: 'START_CANCELLED' });
});

test('§22 HOST_UNAVAILABLE on a relay start is re-sent once (there is no dialog to duplicate), whenever it comes', async () => {
  const env = makeEnv();
  await env.seedKey();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  await env.browser.settle();
  const answer = deferred();
  let sends = 0;
  env.stub.on('host/lane-start', () => (++sends === 1 ? answer.promise : PASS));
  const pending = env.relay(7);
  await env.browser.settle();
  await env.browser.clock.advance(3000);
  answer.release({ ok: false, code: 'HOST_UNAVAILABLE' });
  assert.deepEqual(await pending, { ok: true });
  assert.equal(env.stub.count('host/lane-start'), 2);
});

test('the other mint strings map to their codes and never leak the message', async () => {
  const cases = [
    ['Cannot capture this page.', 'TAB_UNSUPPORTED'],
    ['Error finding tab to capture.', 'TAB_GONE'],
    ['Invalid tab specified.', 'TAB_GONE'],
    ['Some new Chromium wording with a secret-ish detail', 'TAB_CAPTURE_FAILED'],
  ];
  for (const [text, code] of cases) {
    const env = makeEnv();
    await env.armTab(7);
    await env.seedKey();
    env.hooks['tabCapture.getMediaStreamId'] = async () => { throw new Error(text); };
    const res = await env.start('tab', 7);
    assert.deepEqual(res, { ok: false, code }, text);
    assert.equal(env.stub.count('host/lane-start'), 0);
    assert.equal(JSON.stringify(res).includes('secret'), false);
  }
});

// ---------------------------------------------------------------------------------------------
// §19: DISPLAY_MEDIA joined USER_MEDIA (the share picker runs in the document); still never AUDIO_PLAYBACK.
test('ensureOffscreen: ten concurrent calls create ONE document with reasons exactly [USER_MEDIA, DISPLAY_MEDIA]', async () => {
  const env = makeEnv();
  const answers = await Promise.all(Array.from({ length: 10 }, () => env.sw.ensureOffscreen()));
  assert.equal(env.calls('offscreen.createDocument'), 1);
  assert.deepEqual(env.browser.offscreenDocument.reasons, ['USER_MEDIA', 'DISPLAY_MEDIA']);
  assert.equal(env.browser.offscreenDocument.url, HOST_URL);
  assert.ok(answers.every((answer) => answer.hostId === 'h-stub'));
  await env.sw.ensureOffscreen();   // an existing document is found with getContexts, not recreated
  assert.equal(env.calls('offscreen.createDocument'), 1);
});

test('closeHost runs inside the same mutex: an ensureOffscreen that begins during a close waits and gets a fresh document', async () => {
  const env = makeEnv();
  await env.sw.ensureOffscreen();
  assert.equal(env.stub.creations, 1);
  const gate = deferred();
  env.hooks['offscreen.closeDocument'] = async (real, ...args) => { await gate.promise; return real(...args); };
  const closing = env.sw.closeHost({ except: null });
  await env.browser.settle();
  assert.equal(env.calls('offscreen.closeDocument'), 1, 'the close is blocked inside closeDocument');
  const ensuring = env.sw.ensureOffscreen();
  await env.browser.settle();
  assert.equal(env.stub.creations, 1, 'the ensure did not run against the document that is being closed');
  gate.release();
  assert.equal(await closing, true);
  const { hostId } = await ensuring;
  assert.equal(typeof hostId, 'string');
  assert.ok(env.browser.offscreenDocument, 'a document exists after the ensure resolved');
  assert.equal(env.stub.creations, 2, 'the ensure waited for the close and created a fresh document');
});

test('closeHost waits for an ensureOffscreen that is still creating: the close is never lost under the new document', async () => {
  const env = makeEnv();
  const gate = deferred();
  env.hooks['offscreen.createDocument'] = async (real, ...args) => { await gate.promise; return real(...args); };
  const ensuring = env.sw.ensureOffscreen();
  await env.browser.settle();
  assert.equal(env.calls('offscreen.createDocument'), 1, 'the ensure is blocked inside createDocument');
  const closing = env.sw.closeHost({ except: null });
  await env.browser.settle();
  assert.equal(env.calls('offscreen.closeDocument'), 0, 'the close waits for the ensure instead of running against an empty slot');
  gate.release();
  await ensuring;
  assert.equal(await closing, true);
  assert.equal(env.calls('offscreen.closeDocument'), 1);
  assert.equal(env.browser.offscreenDocument, null, 'the close ran AFTER the ensure and removed the document it created');
});

test('a "single offscreen document" refusal is treated as "it exists"; any other createDocument error is HOST_UNAVAILABLE', async () => {
  const env = makeEnv();
  env.hooks['offscreen.createDocument'] = async () => { throw new Error('Only a single offscreen document may be created.'); };
  // Nobody is listening (the hook never created one), so the ping loop fails after the recreate rounds.
  const pending = env.sw.ensureOffscreen().catch((error) => error.code);
  assert.equal(await env.advance(10_000, pending), 'HOST_UNAVAILABLE');

  const other = makeEnv();
  other.hooks['offscreen.createDocument'] = async () => { throw new Error('Something else went wrong'); };
  await assert.rejects(other.sw.ensureOffscreen(), { code: 'HOST_UNAVAILABLE' });
  assert.equal(other.calls('runtime.sendMessage:host/ping'), 0, 'no ping loop after a real creation failure');
});

test('a zombie document (host.js failed at import) is closed and recreated ONCE; a host that never answers is HOST_UNAVAILABLE', async () => {
  const healthySecond = makeEnv({ stubOptions: { answerFor: (creation) => creation >= 2 } });
  // Create the zombie directly, so attempt 1 of ensureOffscreen FINDS it with getContexts.
  await healthySecond.browser.sw.context.chrome.offscreen.createDocument({ url: HOST_URL, reasons: ['USER_MEDIA'], justification: 'zombie' });
  assert.equal(healthySecond.stub.creations, 1);
  const recovered = healthySecond.sw.ensureOffscreen();
  assert.deepEqual(await healthySecond.advance(10_000, recovered), { hostId: 'h-stub' });
  assert.equal(healthySecond.stub.creations, 2);
  assert.equal(healthySecond.calls('offscreen.closeDocument'), 1);
  assert.equal(healthySecond.calls('offscreen.createDocument'), 1, 'the zombie was created outside the worker; the worker created one');

  const never = makeEnv({ stubOptions: { answer: false } });
  await never.seedKey();
  const start = never.start('mic');
  assert.deepEqual(await never.advance(20_000, start), { ok: false, code: 'HOST_UNAVAILABLE' });
  assert.equal(never.calls('offscreen.createDocument'), 2, 'recreated exactly once');
  assert.equal(never.calls('offscreen.closeDocument'), 2);
  assert.equal(never.browser.offscreenDocument, null, 'no zombie is left behind');
  assert.equal(never.calls('runtime.sendMessage:host/ping'), 2 * 20, 'twenty pings per round, two rounds');
});

test('host/lane-start is re-sent ONCE (same message, same unspent id) after HOST_UNAVAILABLE; any other code is final', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  let attempts = 0;
  env.stub.on('host/lane-start', () => {
    attempts += 1;
    return attempts === 1 ? { ok: false, code: 'HOST_UNAVAILABLE' } : PASS;   // the document was "not listening yet"
  });
  const res = await env.start('tab', 7);
  assert.deepEqual(res, { ok: true });
  const sent = env.stub.of('host/lane-start');
  assert.equal(sent.length, 2, 'the first attempt and exactly one re-send');
  assert.deepEqual(sent[0].message, sent[1].message, 'the same message, so the same unspent stream id');
  assert.equal(env.calls('runtime.sendMessage:host/lane-start'), 2);
  assert.equal(env.calls('tabCapture.getMediaStreamId'), 1, 'the id is minted once and never re-minted for the retry');
  assert.ok(env.browser.captures.has(7), 'the re-sent id was still valid');

  const stubborn = makeEnv();
  await stubborn.armTab(7);
  await stubborn.seedKey();
  stubborn.stub.on('host/lane-start', () => ({ ok: false, code: 'HOST_UNAVAILABLE' }));
  assert.deepEqual(await stubborn.start('tab', 7), { ok: false, code: 'HOST_UNAVAILABLE' });
  const attemptsSent = stubborn.stub.of('host/lane-start');
  assert.equal(attemptsSent.length, 2, 'exactly one retry');
  assert.deepEqual(attemptsSent[0].message, attemptsSent[1].message, 'the same message is re-sent');

  const denied = makeEnv();
  await denied.seedKey();
  denied.stub.on('host/lane-start', () => ({ ok: false, code: 'MICROPHONE_DENIED' }));
  assert.deepEqual(await denied.start('mic'), { ok: false, code: 'MICROPHONE_DENIED' });
  assert.equal(denied.stub.count('host/lane-start'), 1, 'no retry for a real answer');
});

test('sendToHost tolerates every way a host can fail to answer: rejection, undefined, a non-object and {ok:false}', async () => {
  for (const noResponder of ['reject', 'undefined']) {
    for (const [name, script] of [
      ['listeners exist but nobody answers', () => NO_ANSWER],
      ['a non-object answer', () => 'nope'],
      ['an answer without ok', () => ({ status: 'fine' })],
      ['ok:false without a code', () => ({ ok: false })],
      ['ok:false with a garbage code', () => ({ ok: false, code: 'lower case' })],
      ['ok:true is required, truthy is not enough', () => ({ ok: 1 })],
    ]) {
      const env = makeEnv({ browserOptions: { noResponder } });
      await env.seedKey();
      env.stub.on('host/lane-start', script);
      const res = await env.start('mic');
      assert.deepEqual(res, { ok: false, code: 'HOST_UNAVAILABLE' }, `${noResponder}: ${name}`);
      assert.equal(env.calls('runtime.sendMessage:host/lane-start'), 2, `${noResponder}: ${name}: one retry`);
    }
  }
});

test('the happy path works with a service worker sender WITHOUT url, in both no-responder modes: never FORBIDDEN', async () => {
  for (const swSenderHasUrl of [true, false]) {
    for (const noResponder of ['reject', 'undefined']) {
      const env = makeEnv({ browserOptions: { swSenderHasUrl, noResponder } });
      await env.armTab(7);
      await env.seedKey();
      assert.deepEqual(await env.start('tab', 7), { ok: true }, `url=${swSenderHasUrl} noResponder=${noResponder}`);
      assert.deepEqual(await env.start('mic'), { ok: true });
      await env.browser.settle();
      const senders = env.stub.requests.map((request) => request.senderUrl);
      assert.ok(senders.length > 0);
      if (!swSenderHasUrl) assert.ok(senders.every((url) => url === undefined), 'the fake really sent url-less senders');
      assert.equal(env.stub.overlayResults.length > 0, true, 'later host messages were accepted too');
    }
  }
});

// ---------------------------------------------------------------------------------------------
// 6.4 recovery for "Cannot capture a tab with an active stream."
async function occupyTab(env, tabId) {
  const minted = await env.browser.sw.context.chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  return env.browser.consumeStreamId(minted);
}

test('active stream, the host says the tab lane runs: ALREADY_RUNNING', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  await env.sw.ensureOffscreen();
  env.stub.lanes.tab = 'running';
  await occupyTab(env, 7);
  assert.deepEqual(await env.start('tab', 7), { ok: false, code: 'ALREADY_RUNNING' });
});

test('active stream that is released 100 ms later: the worker waits 250 ms and mints again', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  await env.sw.ensureOffscreen();
  const stream = await occupyTab(env, 7);
  env.browser.clock.setTimeout(() => stream.getTracks().forEach((track) => track.stop()), 100);
  env.log.length = 0;
  const res = await env.advance(1000, env.start('tab', 7));
  assert.deepEqual(res, { ok: true });
  assert.equal(env.calls('tabCapture.getMediaStreamId'), 2);
  assert.equal(env.calls('offscreen.closeDocument'), 0, 'no need to recreate the document');
});

test('an orphaned capture held by our own dead document: fresh pings, close, recreate, mint again', async (t) => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  await env.sw.ensureOffscreen();
  const orphan = await occupyTab(env, 7);
  env.stub.contexts[0].onClose(() => orphan.getTracks().forEach((track) => track.stop()));   // a dead document releases its capture
  env.log.length = 0;
  const res = await env.advance(2000, env.start('tab', 7));
  t.diagnostic(`orphan recovery call log: ${JSON.stringify(env.log)}`);
  assert.deepEqual(res, { ok: true });
  assert.equal(env.stub.creations, 2);
  assert.equal(env.calls('offscreen.closeDocument'), 1);
  assert.equal(env.calls('tabCapture.getMediaStreamId'), 3);
  const firstMint = env.log.indexOf('tabCapture.getMediaStreamId');
  const close = env.log.indexOf('offscreen.closeDocument');
  const pingsBetween = env.log.slice(firstMint, close).filter((entry) => entry === 'runtime.sendMessage:host/ping').length;
  assert.equal(pingsBetween, 2, 'a FRESH ping before the retry and another before the close');
  assertOrder(env.log, ['tabCapture.getMediaStreamId', 'timer', 'tabCapture.getMediaStreamId', 'offscreen.closeDocument',
    'offscreen.createDocument', 'tabCapture.getMediaStreamId', 'runtime.sendMessage:host/lane-start']);
});

test('a capture nobody can release is TAB_CAPTURE_BUSY; with the mic lane running the document is left alone', async () => {
  const busy = makeEnv();
  await busy.armTab(7);
  await busy.seedKey();
  await busy.sw.ensureOffscreen();
  await occupyTab(busy, 7);
  assert.deepEqual(await busy.advance(2000, busy.start('tab', 7)), { ok: false, code: 'TAB_CAPTURE_BUSY' });
  assert.equal(busy.calls('offscreen.closeDocument'), 1, 'both host lanes were idle, so the document was recreated once');
  assert.equal(busy.stub.count('host/lane-start'), 0);

  const micRunning = makeEnv();
  await micRunning.armTab(7);
  await micRunning.seedKey();
  assert.deepEqual(await micRunning.start('mic'), { ok: true });
  await occupyTab(micRunning, 7);
  assert.deepEqual(await micRunning.advance(2000, micRunning.start('tab', 7)), { ok: false, code: 'TAB_CAPTURE_BUSY' });
  assert.equal(micRunning.calls('offscreen.closeDocument'), 0, 'a running mic lane is never torn down');
  assert.equal(micRunning.stub.lanes.mic, 'running');
});

// ---------------------------------------------------------------------------------------------
test('LANE_STOPPING: a lane that settles is waited out BEFORE the mint; one that does not ends in LANE_STOPPING with NO mint', async () => {
  const settles = makeEnv();
  await settles.armTab(7);
  await settles.seedKey();
  await settles.sw.ensureOffscreen();
  settles.stub.lanes.tab = 'stopping';
  settles.browser.clock.setTimeout(() => { settles.stub.lanes.tab = 'off'; }, 350);
  settles.log.length = 0;
  assert.deepEqual(await settles.advance(2000, settles.start('tab', 7)), { ok: true });
  assert.ok(settles.log.filter((entry) => entry === 'runtime.sendMessage:host/ping').length >= 4, 'polled every 100 ms with fresh pings');
  assert.ok(settles.log.indexOf('tabCapture.getMediaStreamId') > settles.log.lastIndexOf('timer') - 1, 'the mint came after the waiting');

  const stuck = makeEnv();
  await stuck.armTab(7);
  await stuck.seedKey();
  await stuck.sw.ensureOffscreen();
  stuck.stub.lanes.tab = 'stopping';
  stuck.log.length = 0;
  assert.deepEqual(await stuck.advance(LIMITS.stopWaitMs + 1000, stuck.start('tab', 7)), { ok: false, code: 'LANE_STOPPING' });
  assert.equal(stuck.calls('tabCapture.getMediaStreamId'), 0, 'an id the host would refuse must never be minted');
  assert.equal(stuck.stub.count('host/lane-start'), 0);
});

// §20 review (F1): a panel that had no host state yet sent a start next to a lane that ran on another tab. The host
// refused it, but only after the mint, and the id left pending on the clicked tab made the NEXT click there end in
// TAB_CAPTURE_BUSY. Fails on the first 0.5.0 build, which checked only for 'stopping' before the mint.
test('§20 a lane the host already runs is refused as ALREADY_RUNNING BEFORE the mint: no stream id is left pending', async () => {
  for (const phase of ['starting', 'running', 'reconnecting']) {
    const env = makeEnv();
    await env.armTab(7);
    await env.seedKey();
    await env.sw.ensureOffscreen();
    env.stub.lanes.tab = phase;
    env.log.length = 0;
    assert.deepEqual(await env.start('tab', 7), { ok: false, code: 'ALREADY_RUNNING' }, phase);
    assert.equal(env.calls('tabCapture.getMediaStreamId'), 0, `${phase}: nothing minted`);
    assert.equal(env.stub.count('host/lane-start'), 0, phase);
    // once the lane is off the same tab starts (no id was left pending on it)
    env.stub.lanes.tab = 'off';
    assert.deepEqual(await env.start('tab', 7), { ok: true }, `${phase}: the tab is not blocked`);
  }
});

// ---------------------------------------------------------------------------------------------
test('CANCELLATION 1: sw/lane-stop during ensureOffscreen ends in START_CANCELLED, no mint, and the stop reaches the host', async (t) => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  const gate = env.stub.hold('ping');
  env.log.length = 0;
  const start = env.start('tab', 7);
  await env.browser.settle();
  assert.equal(env.stub.count('host/ping'), 1, 'the start is blocked inside ensureOffscreen');
  assert.deepEqual(await env.fromPanel('sw/lane-stop'), { ok: true });
  gate.release();
  assert.deepEqual(await start, { ok: false, code: 'START_CANCELLED' });
  t.diagnostic(`cancel during ensureOffscreen: ${JSON.stringify(env.log)}`);
  assert.equal(env.calls('tabCapture.getMediaStreamId'), 0);
  assert.equal(env.stub.count('host/lane-start'), 0);
  assert.ok(env.stub.count('host/lane-stop') >= 1, 'a host/lane-stop reached the host');
  assert.equal(env.stub.lanes.tab, 'off');
});

test('CANCELLATION 2: sw/lane-stop during the mint ends in START_CANCELLED, nothing is sent to start, the stop reaches the host', async (t) => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  const gate = deferred();
  env.hooks['tabCapture.getMediaStreamId'] = async (real) => { await gate.promise; return real(); };
  env.log.length = 0;
  const start = env.start('tab', 7);
  await env.browser.settle();
  assert.equal(env.calls('tabCapture.getMediaStreamId'), 1, 'blocked inside the mint');
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  gate.release();
  assert.deepEqual(await start, { ok: false, code: 'START_CANCELLED' });
  t.diagnostic(`cancel during the mint: ${JSON.stringify(env.log)}`);
  assert.equal(env.stub.count('host/lane-start'), 0, 'a cancelled start is never sent');
  assert.deepEqual(env.stub.of('host/lane-stop').map((request) => request.message.lane), ['tab']);
  assert.equal(env.stub.lanes.tab, 'off');
});

test('CANCELLATION 3: sw/lane-stop between the mint and the host answer: the host is told again and the lane ends off', async (t) => {
  for (const honorCancel of [true, false]) {
    const env = makeEnv({ stubOptions: { honorCancel } });
    await env.armTab(7);
    await env.seedKey();
    const gate = env.stub.hold('lane-start');
    env.log.length = 0;
    const start = env.start('tab', 7);
    await env.browser.settle();
    assert.equal(env.stub.count('host/lane-start'), 1);
    assert.ok(env.browser.captures.has(7), 'the host holds the tab capture while it starts');
    assert.deepEqual(await env.fromPanel('sw/lane-stop'), { ok: true });
    gate.release();
    assert.deepEqual(await start, { ok: false, code: 'START_CANCELLED' }, `honorCancel=${honorCancel}`);
    t.diagnostic(`cancel between mint and send (honorCancel=${honorCancel}): ${JSON.stringify(env.log)}`);
    assert.ok(env.stub.count('host/lane-stop') >= 2, 'once from sw/lane-stop and once after the host answered (stop wins)');
    assert.equal(env.stub.lanes.tab, 'off', 'the lane is off even when the host accepted the start');
    assert.equal(env.browser.captures.has(7), false, 'the capture was released');
    assert.equal(env.session()[STORAGE_KEYS.lastStop], undefined);
  }
});

// 6.3 step 0: after EVERY await the start checks for a stop. The three cases below cover the awaits before any host
// exists (settings and key, tabs.get, the arm lookup); a stop that lands there must end the start before it can create
// an offscreen document for a run the user already cancelled (only the 15 s initial grace would close it again).
test('CANCELLATION 4: sw/lane-stop while the settings and the key are read ends in START_CANCELLED before any tab lookup', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  const gate = deferred();
  env.hooks['storage.local.get'] = async (real, ...args) => { await gate.promise; return real(...args); };
  env.log.length = 0;
  const start = env.start('tab', 7);
  await env.browser.settle();
  assert.equal(env.calls('storage.local.get'), 1, 'blocked inside the settings read');
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  gate.release();
  assert.deepEqual(await start, { ok: false, code: 'START_CANCELLED' });
  assert.equal(env.calls('tabs.get'), 0, 'the start ended before it looked at the tab');
  assert.equal(env.calls('storage.session.get'), 0, 'and before the arm lookup');
  assert.equal(env.calls('offscreen.createDocument'), 0);
  assert.equal(env.browser.offscreenDocument, null, 'a cancelled start created no document');
  assert.equal(env.stub.count('host/lane-start'), 0);
});

test('CANCELLATION 5: sw/lane-stop while tabs.get is pending ends in START_CANCELLED before the arm lookup and any host work', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  const gate = deferred();
  env.hooks['tabs.get'] = async (real) => { await gate.promise; return real(); };
  env.log.length = 0;
  const start = env.start('tab', 7);
  await env.browser.settle();
  assert.equal(env.calls('tabs.get'), 1, 'blocked inside tabs.get');
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  gate.release();
  assert.deepEqual(await start, { ok: false, code: 'START_CANCELLED' });
  assert.equal(env.calls('storage.session.get'), 0, 'the start ended right after tabs.get, before it asked whether the tab is armed');
  assert.equal(env.calls('offscreen.createDocument'), 0);
  assert.equal(env.browser.offscreenDocument, null, 'a cancelled start created no document');
  assert.equal(env.calls('tabCapture.getMediaStreamId'), 0);
  assert.equal(env.stub.count('host/lane-start'), 0);
});

test('CANCELLATION 6: sw/lane-stop while the arm lookup is pending ends in START_CANCELLED before any host work', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  const gate = deferred();
  env.hooks['storage.session.get'] = async (real, ...args) => { await gate.promise; return real(...args); };
  env.log.length = 0;
  const start = env.start('tab', 7);
  await env.browser.settle();
  assert.equal(env.calls('storage.session.get'), 1, 'blocked inside the arm lookup');
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  gate.release();
  assert.deepEqual(await start, { ok: false, code: 'START_CANCELLED' });
  assert.equal(env.calls('runtime.getContexts'), 0, 'the start ended before it looked for a host');
  assert.equal(env.calls('offscreen.createDocument'), 0);
  assert.equal(env.browser.offscreenDocument, null, 'a cancelled start created no document');
  assert.equal(env.calls('tabCapture.getMediaStreamId'), 0);
  assert.equal(env.stub.count('host/lane-start'), 0);
});

test('a stop with no host at all answers ok, and a stop after the worker was killed still forwards to the host', async () => {
  const env = makeEnv();
  assert.deepEqual(await env.fromPanel('sw/lane-stop'), { ok: true });
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'mic' }), { ok: true });
  assert.equal(env.stub.requests.length, 0);

  await env.seedKey();
  assert.deepEqual(await env.start('mic'), { ok: true });
  env.browser.sw.kill();
  assert.equal(env.browser.sw.running, false);
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'mic' }), { ok: true });
  assert.equal(env.browser.sw.starts, 2, 'the stop revived the worker');
  assert.deepEqual(env.stub.of('host/lane-stop').map((request) => request.message.lane), ['mic']);
  assert.equal(env.stub.lanes.mic, 'off');
});

test('a second start of a lane that is still starting is ALREADY_RUNNING; a stop then a fresh start uses a NEW stream id', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  const gate = env.stub.hold('lane-start');
  const first = env.start('tab', 7);
  await env.browser.settle();
  assert.deepEqual(await env.start('tab', 7), { ok: false, code: 'ALREADY_RUNNING' });
  gate.release();
  assert.deepEqual(await first, { ok: true });

  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  await env.browser.settle();
  await env.browser.clickAction(7);   // re-arm, as a user would after a stop
  await env.browser.settle();
  assert.deepEqual(await env.start('tab', 7), { ok: true });
  const [one, two] = env.stub.of('host/lane-start').map((request) => request.message.tab.streamId);
  assert.notEqual(one, two, 'a stream id is single-use: the worker never reuses one');
  assert.throws(() => env.browser.consumeStreamId(one), { name: 'NotAllowedError' }, 'and the fake would refuse a used id');
  await env.browser.clock.advance(6000);
  assert.throws(() => env.browser.consumeStreamId(two), { name: 'NotAllowedError' }, 'or an expired one');
});

// A stop only FLAGS a start that has not finished; the entry leaves `starting` when that start has unwound. A start
// that arrives in that window is not a duplicate of a running lane (the panel deliberately ignores ALREADY_RUNNING,
// so answering it would swallow the user's press): it is told the lane is still stopping, which the panel renders.
test('Start, Stop, Start in one tick: the second start is LANE_STOPPING, not ALREADY_RUNNING, and the lane ends off', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  const first = env.start('tab', 7);
  const stop = env.fromPanel('sw/lane-stop', { lane: 'tab' });
  const second = env.start('tab', 7);
  assert.deepEqual(await Promise.all([first, stop, second]), [
    { ok: false, code: 'START_CANCELLED' }, { ok: true }, { ok: false, code: 'LANE_STOPPING' },
  ]);
  await env.browser.settle();
  assert.equal(env.stub.lanes.tab, 'off', 'the cancelled start left nothing behind');
  assert.equal(env.browser.captures.has(7), false);
  // Once the cancelled start has unwound the lane is free again: the same request is now a normal start.
  await env.browser.clickAction(7);
  await env.browser.settle();
  assert.deepEqual(await env.start('tab', 7), { ok: true });
});

test('a start that hangs inside the host (getUserMedia never answers): Stop, then Start answers LANE_STOPPING at once and the lane frees after the release', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  const gate = env.stub.hold('lane-start');
  const first = env.start('tab', 7);
  await env.browser.settle();
  assert.equal(env.stub.count('host/lane-start'), 1, 'the start is inside host/lane-start');
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  // No timer has to run: the answer does not wait for the hung start.
  assert.deepEqual(await env.start('tab', 7), { ok: false, code: 'LANE_STOPPING' });
  assert.deepEqual(await env.start('tab', 7), { ok: false, code: 'LANE_STOPPING' }, 'and stays so for as long as the first start hangs');
  assert.equal(env.stub.count('host/lane-start'), 1, 'no second host/lane-start was sent meanwhile');
  gate.release();
  assert.deepEqual(await first, { ok: false, code: 'START_CANCELLED' });
  await env.browser.settle();
  await env.browser.clickAction(7);
  await env.browser.settle();
  assert.deepEqual(await env.start('tab', 7), { ok: true }, 'after the unwind the lane starts again');
  // A start that was NOT cancelled still reports a duplicate as ALREADY_RUNNING (the panel ignores that one).
  const plain = makeEnv();
  await plain.armTab(7);
  await plain.seedKey();
  const hold = plain.stub.hold('lane-start');
  const running = plain.start('tab', 7);
  await plain.browser.settle();
  assert.deepEqual(await plain.start('tab', 7), { ok: false, code: 'ALREADY_RUNNING' });
  hold.release();
  assert.deepEqual(await running, { ok: true });
});

test('a cancelled mic start that is still unwinding is LANE_STOPPING too (the rule is per lane, not tab-only)', async () => {
  const env = makeEnv();
  await env.seedKey();
  const gate = env.stub.hold('lane-start');
  const first = env.start('mic');
  await env.browser.settle();
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'mic' }), { ok: true });
  assert.deepEqual(await env.start('mic'), { ok: false, code: 'LANE_STOPPING' });
  gate.release();
  assert.deepEqual(await first, { ok: false, code: 'START_CANCELLED' });
  assert.deepEqual(await env.start('mic'), { ok: true });
});

// ---------------------------------------------------------------------------------------------
// §20 (2026-10-08), the real-browser finding (docs/extension.md §20, check 20.5): a share dialog that nobody answered
// stays open in the offscreen document, and while it is open a stream-id start of the SAME document never completes. So a
// Stop that cancels a dialog start closes the document (the dialog goes with it) unless something else lives in it. The
// stub host cannot model the block itself; tests/extension-integration.test.mjs does, over the real host and panel.
const hostFlag = (env) => env.session()[STORAGE_KEYS.host];
async function dialogEnv(options) {
  const env = makeEnv(options);
  await env.seedKey();
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  await env.browser.settle();
  return env;
}

test('R1 a Stop that cancels a share-dialog start closes the offscreen document: the start ends START_CANCELLED without sending or creating anything, the flag says down, and the next Start recreates the document', async () => {
  const env = await dialogEnv();
  const gate = env.stub.hold('pick');   // never released: the close alone must end the start
  const first = env.pick(7);
  await env.browser.settle();
  assert.equal(env.stub.count('host/lane-start'), 1, 'the dialog start is inside the host');
  assert.notEqual(env.browser.offscreenDocument, null);
  assert.equal(hostFlag(env).up, true);
  env.log.length = 0;
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  assert.equal(env.calls('offscreen.closeDocument'), 1, 'the dialog the stop leaves open is closed with its document');
  assert.equal(env.browser.offscreenDocument, null);
  assert.equal(hostFlag(env).up, false, 'the host flag follows the close');
  assert.deepEqual(await first, { ok: false, code: 'START_CANCELLED' });
  // The cancelled start did not go on: no second host/lane-start, no document created for a run that was cancelled.
  assert.equal(env.stub.count('host/lane-start'), 1, 'not sent again');
  assert.equal(env.calls('offscreen.createDocument'), 0, 'the HOST_UNAVAILABLE retry did not recreate the document');
  assert.equal(env.browser.offscreenDocument, null);
  assert.equal(hostFlag(env).up, false, 'and the flag was not set up again by the unwinding start');
  assert.equal(env.session()[STORAGE_KEYS.lastStop], undefined, 'our own stop is not a host loss');
  // The next Start creates a fresh document through ensureOffscreen and runs.
  assert.deepEqual(await env.pick(7), { ok: true });
  assert.equal(env.stub.creations, 2, 'a second document');
  assert.equal(hostFlag(env).up, true);
  gate.release();
});

test('R1 the close is for a cancelled DIALOG start only: a normal Stop of a running lane, and a dialog start cancelled before the dialog was asked for, leave the document alone', async () => {
  // a running armed lane
  const armed = makeEnv();
  await armed.armTab(7);
  await armed.seedKey();
  assert.deepEqual(await armed.start('tab', 7), { ok: true });
  armed.log.length = 0;
  assert.deepEqual(await armed.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  assert.equal(armed.calls('offscreen.closeDocument'), 0);
  assert.notEqual(armed.browser.offscreenDocument, null);
  assert.equal(hostFlag(armed).up, true);

  // a running dialog lane (the dialog was answered long ago): there is no start left to cancel
  const picked = await dialogEnv();
  picked.stub.choice = { tabId: 7 };
  assert.deepEqual(await picked.pick(7), { ok: true });
  picked.log.length = 0;
  assert.deepEqual(await picked.fromPanel('sw/lane-stop'), { ok: true });
  assert.equal(picked.calls('offscreen.closeDocument'), 0);

  // a dialog start that a Stop overtakes inside the label wait: nothing was sent to the host, so no dialog exists
  const labelling = await dialogEnv();
  labelling.hooks['tabs.sendMessage'] = (real, tabId, message) => (message?.type === 'content/capture-label' ? new Promise(() => {}) : real());
  const start = labelling.pick(7);
  await labelling.browser.settle();
  assert.equal(labelling.calls('tabs.sendMessage:content/capture-label'), 1, 'the start is inside the label wait');
  labelling.log.length = 0;
  assert.deepEqual(await labelling.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  assert.deepEqual(await start, { ok: false, code: 'START_CANCELLED' });
  assert.equal(labelling.stub.count('host/lane-start'), 0);
  assert.equal(labelling.calls('offscreen.closeDocument'), 0, 'no dialog was ever asked for');
  assert.notEqual(labelling.browser.offscreenDocument, null);
});

test('R1 the microphone keeps the document: a running (or starting) microphone is never closed under, and the dialog start still ends START_CANCELLED', async () => {
  // running microphone, Stop of the tab lane only
  const env = await dialogEnv();
  assert.deepEqual(await env.start('mic'), { ok: true });
  const gate = env.stub.hold('pick');
  const first = env.pick(7);
  await env.browser.settle();
  env.log.length = 0;
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  assert.equal(env.calls('offscreen.closeDocument'), 0, 'closing would end the microphone');
  assert.notEqual(env.browser.offscreenDocument, null);
  assert.equal(env.stub.lanes.mic, 'running');
  assert.equal(hostFlag(env).up, true);
  gate.release();
  assert.deepEqual(await first, { ok: false, code: 'START_CANCELLED' });
  assert.equal(env.calls('offscreen.closeDocument'), 0);

  // a Stop of EVERYTHING stops the microphone with the same command, so nothing is left to protect
  const all = await dialogEnv();
  assert.deepEqual(await all.start('mic'), { ok: true });
  all.stub.hold('pick');
  const dialog = all.pick(7);
  await all.browser.settle();
  all.log.length = 0;
  assert.deepEqual(await all.fromPanel('sw/lane-stop'), { ok: true });
  assert.equal(all.stub.lanes.mic, 'off');
  assert.equal(all.calls('offscreen.closeDocument'), 1);
  assert.equal(all.browser.offscreenDocument, null);
  assert.deepEqual(await dialog, { ok: false, code: 'START_CANCELLED' });

  // a microphone that is still starting in the host (the fresh ping sees it) is protected as well
  const starting = await dialogEnv();
  const micGate = starting.stub.hold('lane-start');
  const mic = starting.start('mic');
  await starting.browser.settle();
  assert.equal(starting.stub.lanes.mic, 'starting');
  const pickGate = starting.stub.hold('pick');
  const tab = starting.pick(7);
  await starting.browser.settle();
  starting.log.length = 0;
  assert.deepEqual(await starting.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  assert.equal(starting.calls('offscreen.closeDocument'), 0);
  pickGate.release();
  micGate.release();
  assert.deepEqual(await tab, { ok: false, code: 'START_CANCELLED' });
  assert.deepEqual(await mic, { ok: true });
});

test('R1 a start of another lane that has not reached the host yet is invisible to the ping, but closeHost still refuses while it is in flight', async () => {
  const env = await dialogEnv();
  const pickGate = env.stub.hold('pick');
  const dialog = env.pick(7);
  await env.browser.settle();
  const pingGate = env.stub.hold('ping');
  const mic = env.start('mic');   // its wait-out ping takes the gate: this start sits in `starting`, unseen by the host
  await env.browser.settle();
  assert.equal(env.stub.lanes.mic, 'off', 'the host has not heard of it');
  env.log.length = 0;
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  assert.equal(env.stub.lanes.mic, 'off');
  assert.equal(env.calls('offscreen.closeDocument'), 0, 'the document stays: the microphone start is about to use it');
  assert.notEqual(env.browser.offscreenDocument, null);
  pingGate.release();
  assert.deepEqual(await mic, { ok: true });
  pickGate.release();   // the document was kept, so the cancelled start unwinds through the host's own answer
  assert.deepEqual(await dialog, { ok: false, code: 'START_CANCELLED' });
});

test('R1 a Stop of everything cancels both starts at once: both unwinding starts may sit in `starting`, and the document is still closed', async () => {
  const env = await dialogEnv();
  env.stub.hold('pick');
  const micGate = env.stub.hold('lane-start');
  const mic = env.start('mic');
  await env.browser.settle();
  const dialog = env.pick(7);
  await env.browser.settle();
  assert.equal(env.stub.lanes.mic, 'starting');
  env.log.length = 0;
  assert.deepEqual(await env.fromPanel('sw/lane-stop'), { ok: true });
  assert.equal(env.calls('offscreen.closeDocument'), 1, 'both cancelled lanes are excepted from the in-flight rule');
  assert.equal(env.browser.offscreenDocument, null);
  micGate.release();
  assert.deepEqual(await dialog, { ok: false, code: 'START_CANCELLED' });
  assert.deepEqual(await mic, { ok: false, code: 'START_CANCELLED' });
  assert.equal(env.calls('offscreen.createDocument'), 0, 'nothing recreated the document for a cancelled run');
});

test('R1 a ping that fails means the host is unusable: the document is closed even with the microphone listed as running', async () => {
  const env = await dialogEnv();
  assert.deepEqual(await env.start('mic'), { ok: true });
  env.stub.hold('pick');
  const first = env.pick(7);
  await env.browser.settle();
  env.stub.on('host/ping', () => ({ ok: false, code: 'INTERNAL' }));
  env.log.length = 0;
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  assert.ok(env.calls('runtime.sendMessage:host/ping') >= 1, 'a fresh ping was asked');
  assert.equal(env.calls('offscreen.closeDocument'), 1);
  assert.equal(env.browser.offscreenDocument, null);
  assert.equal(hostFlag(env).up, false);
  assert.deepEqual(await first, { ok: false, code: 'START_CANCELLED' });
});

test('R1 a Stop that lands inside the ONE HOST_UNAVAILABLE retry (its ensureOffscreen) ends the start: nothing is sent a second time', async () => {
  for (const how of ['armed', 'dialog']) {
    const env = how === 'armed' ? makeEnv() : await dialogEnv();
    if (how === 'armed') { await env.armTab(7); await env.seedKey(); }
    let gate = null;
    env.stub.on('host/lane-start', () => { gate ??= env.stub.hold('ping'); return { ok: false, code: 'HOST_UNAVAILABLE' }; });
    const start = how === 'armed' ? env.start('tab', 7) : env.pick(7);
    await env.browser.settle();
    assert.equal(env.stub.count('host/lane-start'), 1, `${how}: the first send was refused`);
    assert.equal(env.stub.count('host/ping') >= 2, true, `${how}: the retry is inside ensureOffscreen (its ping is held)`);
    // (a close queues behind the ensureOffscreen that is in progress, so the stop answers once the held ping is released)
    const stopping = env.fromPanel('sw/lane-stop', { lane: 'tab' });
    await env.browser.settle();
    gate.release();
    assert.deepEqual(await stopping, { ok: true });
    assert.deepEqual(await start, { ok: false, code: 'START_CANCELLED' }, how);
    assert.equal(env.stub.count('host/lane-start'), 1, `${how}: not sent a second time`);
    assert.equal(env.calls('offscreen.closeDocument'), how === 'dialog' ? 1 : 0, how);
    assert.equal(env.calls('offscreen.createDocument'), 1, `${how}: the retry found the document it expected, and nothing recreated one`);
  }
});

test('R1 the lane whose start was cancelled may still be unwinding in the host: only the OTHER lane decides whether the document is kept', async () => {
  const env = await dialogEnv();
  env.stub.hold('pick');
  const first = env.pick(7);
  await env.browser.settle();
  // A host that answers the stop while the cancelled lane has not settled yet (the ping then reports it as stopping).
  env.stub.on('host/lane-stop', (message) => { env.stub.stops[message.lane ?? 'tab'] += 1; env.stub.lanes.tab = 'stopping'; return { ok: true }; });
  env.log.length = 0;
  assert.deepEqual(await env.fromPanel('sw/lane-stop', { lane: 'tab' }), { ok: true });
  assert.equal(env.stub.lanes.tab, 'stopping');
  assert.equal(env.calls('offscreen.closeDocument'), 1, 'the cancelled lane itself does not keep the document alive');
  assert.deepEqual(await first, { ok: false, code: 'START_CANCELLED' });
});

// ---------------------------------------------------------------------------------------------
test('settings are forwarded to the host only while the host flag is up, as one host/settings message', async () => {
  const env = makeEnv();
  await env.seedSettings((s) => { s.speechMuted = false; });
  await env.browser.settle();
  assert.equal(env.stub.count('host/settings'), 0, 'no host yet');
  assert.equal(env.calls('runtime.sendMessage:host/settings'), 0);

  await env.seedKey();
  assert.deepEqual(await env.start('mic'), { ok: true });
  await env.seedSettings((s) => { s.speechMuted = true; s.lanes.tab.originalVolume = 30; s.captions.size = 1.75; });
  await env.browser.settle();
  const [settings] = env.stub.settings.slice(-1);
  assert.equal(settings.speechMuted, true);
  assert.equal(settings.tabOriginalVolume, 30);
  assert.equal(settings.style.size, 1.75);
  assert.equal('key' in settings || 'model' in settings || 'targetLanguage' in settings, false, 'never a key, language or model');
  assert.equal(JSON.stringify(env.stub.of('host/settings')).includes(KEY), false);
});

test('a killed worker still forwards a settings edit on the next event', async () => {
  const env = makeEnv();
  await env.seedKey();
  assert.deepEqual(await env.start('mic'), { ok: true });
  env.browser.sw.kill();
  const before = env.stub.count('host/settings');
  await env.seedSettings((s) => { s.speechMuted = false; });
  await env.browser.settle();
  assert.equal(env.browser.sw.starts, 2, 'the storage event revived the worker');
  assert.equal(env.stub.count('host/settings'), before + 1);
  assert.equal(env.stub.settings.at(-1).speechMuted, false);
});

test('captions false -> true attaches the overlay (tab lane through host/ping.tabId, mic lane to the active tab); true -> false does not', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  await env.seedSettings((s) => { s.lanes.tab.captions = false; s.lanes.mic.captions = false; });
  assert.deepEqual(await env.start('tab', 7), { ok: true });
  assert.deepEqual(await env.start('mic'), { ok: true });
  await env.browser.settle();
  assert.equal(env.attaches.length, 0, 'captions are off: nothing wanted the overlay');

  await env.seedSettings((s) => { s.lanes.tab.captions = true; });
  await env.browser.settle();
  assert.deepEqual(env.attaches.map((attach) => attach.tabId), [7]);
  assert.deepEqual(env.attaches[0].message, { v: 1, target: 'content', type: 'content/overlay-attach' });
  assert.deepEqual(env.stub.overlayResults.at(-1), { v: 1, target: 'offscreen', type: 'host/overlay-result', tabId: 7, ok: true, lanes: ['tab'] });
  const orderTypes = env.stub.requests.map((request) => request.type);
  assert.ok(orderTypes.lastIndexOf('host/settings') < orderTypes.lastIndexOf('host/overlay-wanted'), 'settings are sent first');

  env.browser.addTab({ id: 8, url: 'https://example.com/', active: false });
  await env.browser.activateTab(8);
  await env.seedSettings((s) => { s.lanes.mic.captions = true; });
  await env.browser.settle();
  assert.ok(env.attaches.some((attach) => attach.tabId === 8), 'the mic lane follows the tab you look at');
  assert.equal(env.stub.of('host/overlay-wanted').at(-1).message.active, true);

  const attachesBefore = env.attaches.length;
  await env.seedSettings((s) => { s.lanes.tab.captions = false; s.lanes.mic.captions = false; });
  await env.browser.settle();
  assert.equal(env.attaches.length, attachesBefore, 'turning captions off attaches nothing');
});

// ---------------------------------------------------------------------------------------------
test('attachOverlay retries at 0/150/400/1000 ms and reports the result for the lanes that wanted it', async () => {
  const env = makeEnv();
  env.browser.contentScripts = false;   // no content script yet: nothing listens
  env.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  await env.browser.clickAction(7);
  await env.seedKey();
  await env.seedSettings((s) => { s.lanes.tab.captions = false; });   // the start itself does not ask for the overlay
  assert.deepEqual(await env.start('tab', 7), { ok: true });
  await env.browser.settle();
  env.stub.captions.tab = true;   // now the host wants it
  env.log.length = 0;
  env.browser.clock.setTimeout(() => env.overlay(env.browser.createContext('content', { tabId: 7 })), 300);   // the script arrives late
  const pending = env.sw.considerOverlay(7);
  await env.advance(2000, pending);
  assert.equal(env.calls('tabs.sendMessage:content/overlay-attach'), 3, 'attempts at 0 ms, 150 ms and 550 ms; the third one lands');
  assert.equal(env.attaches.length, 1);
  assert.equal(env.attaches[0].at, 550);
  assert.equal(env.stub.overlayResults.at(-1).ok, true);
  assert.equal(env.injected.length, 0, 'no injection was needed');
});

test('the injection fallback is used only for an ARMED tab, one more attach follows it, and an unarmed tab reports ok:false', async () => {
  const armed = makeEnv();
  armed.browser.contentScripts = false;
  armed.browser.addTab({ id: 7, url: 'https://claude.ai/doc', active: true });
  await armed.browser.clickAction(7);
  await armed.seedKey();
  assert.deepEqual(await armed.start('tab', 7), { ok: true });
  await armed.advance(3000, armed.browser.settle());
  assert.deepEqual(armed.browser.injections, [{ tabId: 7, files: [PATHS.overlay] }]);
  assert.deepEqual(armed.injected, [7]);
  assert.equal(armed.calls('tabs.sendMessage:content/overlay-attach'), 5, 'four timed attempts, then one after the injection');
  assert.equal(armed.stub.overlayResults.at(-1).ok, true);

  const unarmed = makeEnv();
  unarmed.browser.contentScripts = false;
  unarmed.browser.addTab({ id: 8, url: 'https://example.com/', active: true });   // active, but never invoked
  await unarmed.seedKey();
  await unarmed.seedSettings((s) => { s.lanes.mic.captions = true; });
  assert.deepEqual(await unarmed.start('mic'), { ok: true });
  await unarmed.advance(3000, unarmed.browser.settle());
  assert.deepEqual(unarmed.browser.injections, [], 'activeTab gives no scripting access to a tab the user did not invoke');
  assert.deepEqual(unarmed.stub.overlayResults.at(-1), { v: 1, target: 'offscreen', type: 'host/overlay-result', tabId: 8, ok: false, lanes: ['mic'] });
});

test('the MIC lane is attached only to the active tab of the last focused window; onActivated moves it', async () => {
  const env = makeEnv();
  await env.seedKey();
  await env.seedSettings((s) => { s.lanes.mic.captions = true; });
  env.browser.addTab({ id: 1, url: 'https://a.example/', active: true });
  env.browser.addTab({ id: 2, url: 'https://b.example/', active: false });
  assert.deepEqual(await env.start('mic'), { ok: true });
  await env.browser.settle();
  assert.deepEqual(env.attaches.map((attach) => attach.tabId), [1], 'the tab you look at');

  await env.browser.navigate(2, 'https://b.example/next');   // a BACKGROUND tab finishes loading
  await env.browser.settle();
  assert.deepEqual(env.attaches.map((attach) => attach.tabId), [1], 'never attached for the microphone');
  assert.equal(env.stub.of('host/overlay-wanted').at(-1).message.active, false);

  await env.browser.activateTab(2);
  await env.browser.settle();
  assert.deepEqual(env.attaches.map((attach) => attach.tabId), [1, 2]);
  assert.equal(env.stub.of('host/overlay-wanted').at(-1).message.active, true);
});

// ---------------------------------------------------------------------------------------------
test('tab events: onRemoved clears the record and tells the host (only when it is up); navigation clears cross-origin only', async () => {
  const env = makeEnv();
  await env.armTab(7, 'https://claude.ai/doc');
  await env.armTab(8, 'https://example.com/', { active: false });
  await env.browser.closeTab(8);
  await env.browser.settle();
  assert.equal(env.session()[STORAGE_KEYS.armed].tabs['8'], undefined);
  assert.equal(env.stub.count('host/tab-removed'), 0, 'no host, no message');

  await env.seedKey();
  assert.deepEqual(await env.start('tab', 7), { ok: true });
  await env.browser.pushState(7, 'https://claude.ai/doc#section');
  await env.browser.settle();
  assert.ok(env.session()[STORAGE_KEYS.armed].tabs['7'], 'same-origin (pushState) keeps the grant');
  await env.browser.navigate(7, 'https://claude.ai/other');
  assert.ok(env.session()[STORAGE_KEYS.armed].tabs['7'], 'a same-origin navigation keeps it too');
  await env.browser.navigate(7, 'https://elsewhere.example/');
  await env.browser.settle();
  assert.equal(env.session()[STORAGE_KEYS.armed].tabs['7'], undefined, 'cross-origin clears');

  await env.armTab(9, 'https://third.example/', { active: false });
  await env.browser.closeTab(9);
  await env.browser.settle();
  assert.deepEqual(env.stub.removed, [9], 'the host is told when it is up');
});

test('onUpdated status:complete re-attaches the overlay to the captured tab after a navigation', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  assert.deepEqual(await env.start('tab', 7), { ok: true });
  await env.browser.settle();
  const before = env.attaches.length;
  await env.browser.navigate(7, 'https://claude.ai/other');
  await env.browser.settle();
  assert.ok(env.attaches.length > before, 'the new document got a fresh attach');
});

// ---------------------------------------------------------------------------------------------
test('sw/host-idle closes only when no start is in flight, no panel is connected and both lanes are off; then it records lastStop', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  const { hostId } = await env.sw.ensureOffscreen();
  const idle = (reason = 'panel-gone') => env.send(env.browser.contexts().find((c) => c.kind === 'offscreen'), 'sw/host-idle', { hostId, reason });

  // a start in flight (blocked inside ensureOffscreen on its first ping): the worker's own map is the only thing that sees it
  const gate = env.stub.hold('ping');
  const start = env.start('mic');
  await env.browser.settle();
  assert.deepEqual(await idle(), { ok: true, closed: false });
  assert.ok(env.browser.offscreenDocument, 'the document was NOT closed under a start');
  gate.release();
  assert.deepEqual(await start, { ok: true });

  // Each guard alone: the lane that the start above left running must be off while the panel is the only reason to stay
  // open, or the running lane would answer closed:false by itself and the panel check would never be exercised.
  env.stub.lanes.mic = 'off';
  env.stub.panels = 2;
  assert.deepEqual(await idle(), { ok: true, closed: false }, 'a panel is connected');
  assert.ok(env.browser.offscreenDocument, 'the document was NOT closed under a connected panel');
  env.stub.panels = 0;
  env.stub.lanes.mic = 'running';
  assert.deepEqual(await idle(), { ok: true, closed: false }, 'a lane is running');
  assert.ok(env.browser.offscreenDocument, 'the document was NOT closed under a running lane');
  env.stub.lanes.mic = 'off';
  const done = await idle('panel-gone');
  assert.deepEqual(done, { ok: true, closed: true });
  assert.equal(env.browser.offscreenDocument, null);
  const host = env.session()[STORAGE_KEYS.host];
  assert.equal(host.up, false);
  assert.equal(host.hostId, null);
  const lastStop = env.session()[STORAGE_KEYS.lastStop];
  assert.equal(lastStop.reason, 'panel-gone');
  assert.equal(lastStop.v, 1);
  assert.equal(JSON.stringify(lastStop).includes(KEY), false);
});

test('sw/host-idle never closes the document under a panel that reconnected after the grace stopped the lanes', async () => {
  const env = makeEnv();
  await env.seedKey();
  assert.deepEqual(await env.start('mic'), { ok: true });
  const { hostId } = await env.sw.ensureOffscreen();
  // The 3 s grace fired with no panel: the host stopped its lanes and asks the worker to close. In the same second the
  // panel opened and connected, so both lanes are off and nothing is starting, and a panel is the ONLY reason to stay.
  env.stub.lanes.mic = 'off';
  env.stub.panels = 1;
  const offscreenSender = env.browser.contexts().find((context) => context.kind === 'offscreen');
  assert.deepEqual(await env.send(offscreenSender, 'sw/host-idle', { hostId, reason: 'panel-gone' }), { ok: true, closed: false });
  assert.ok(env.browser.offscreenDocument, 'the document stays under the connected panel');
  assert.equal(env.calls('offscreen.closeDocument'), 0);
  assert.equal(env.session()[STORAGE_KEYS.host].up, true, 'the host flag still says up');
  assert.equal(env.session()[STORAGE_KEYS.lastStop], undefined, 'nothing was recorded as stopped');

  env.stub.panels = 0;   // the panel goes away again: now the same request closes
  assert.deepEqual(await env.send(offscreenSender, 'sw/host-idle', { hostId, reason: 'panel-gone' }), { ok: true, closed: true });
  assert.equal(env.browser.offscreenDocument, null);
});

test('sw/host-idle from a host that is already gone writes up:false and the reported reason; a start removes lastStop', async () => {
  const env = makeEnv();
  await env.seedKey();
  await env.panel.chrome.storage.session.set({ [STORAGE_KEYS.host]: { v: 1, up: true, hostId: 'h-gone', at: 1 } });
  const offscreenSender = env.browser.createContext('offscreen');
  const res = await env.send(offscreenSender, 'sw/host-idle', { hostId: 'h-gone', reason: 'initial-grace' });
  offscreenSender.close();
  assert.deepEqual(res, { ok: true, closed: false });
  assert.equal(env.session()[STORAGE_KEYS.host].up, false);
  assert.equal(env.session()[STORAGE_KEYS.lastStop].reason, 'initial-grace');

  assert.deepEqual(await env.start('mic'), { ok: true });
  assert.equal(env.session()[STORAGE_KEYS.lastStop], undefined, 'a new run removes it');
});

test('sw/host-probe heals a stale up:true (no document, or a zombie) and records host-lost; a healthy host answers up:true', async () => {
  const gone = makeEnv();
  await gone.panel.chrome.storage.session.set({ [STORAGE_KEYS.host]: { v: 1, up: true, hostId: 'h-x', at: 1 } });
  assert.deepEqual(await gone.fromPanel('sw/host-probe'), { ok: true, up: false });
  assert.equal(gone.session()[STORAGE_KEYS.host].up, false);
  assert.equal(gone.session()[STORAGE_KEYS.lastStop].reason, 'host-lost');
  assert.deepEqual(await gone.fromPanel('sw/host-probe'), { ok: true, up: false }, 'already down: no new record needed');

  const zombie = makeEnv({ stubOptions: { answer: false } });
  await zombie.browser.sw.context.chrome.offscreen.createDocument({ url: HOST_URL, reasons: ['USER_MEDIA'], justification: 'zombie' });
  await zombie.panel.chrome.storage.session.set({ [STORAGE_KEYS.host]: { v: 1, up: true, hostId: 'h-z', at: 1 } });
  const probing = zombie.fromPanel('sw/host-probe');
  assert.deepEqual(await zombie.advance(5000, probing), { ok: true, up: false });
  assert.equal(zombie.browser.offscreenDocument, null, 'the zombie was closed');
  assert.equal(zombie.session()[STORAGE_KEYS.lastStop].reason, 'host-lost');

  const healthy = makeEnv();
  await healthy.seedKey();
  assert.deepEqual(await healthy.start('mic'), { ok: true });
  healthy.browser.sw.kill();
  assert.deepEqual(await healthy.fromPanel('sw/host-probe'), { ok: true, up: true }, 'an existing document is found with getContexts after a restart');
  assert.equal(healthy.session()[STORAGE_KEYS.lastStop], undefined);
});

test('sw/permission-open creates ONE permission tab and focuses it the second time', async () => {
  const env = makeEnv();
  env.browser.addTab({ id: 1, url: 'https://a.example/', active: true });
  const first = await env.fromPanel('sw/permission-open');
  assert.equal(first.ok, true);
  assert.ok(Number.isInteger(first.tabId));
  const created = env.browser.tabs.get(first.tabId);
  assert.equal(created.url, env.browser.url(PATHS.permission));
  env.browser.tabs.get(1).active = true;
  const second = await env.fromPanel('sw/permission-open');
  assert.equal(second.tabId, first.tabId, 'no second tab');
  assert.equal([...env.browser.tabs.values()].filter((tab) => tab.url === env.browser.url(PATHS.permission)).length, 1);
  assert.equal(env.browser.tabs.get(first.tabId).active, true, 'the existing tab was focused');
});

// ---------------------------------------------------------------------------------------------
test('only the panel may command the worker: every other sender is FORBIDDEN, and a bad payload is INVALID_MESSAGE', async () => {
  const env = makeEnv();
  await env.seedKey();
  const options = env.browser.createContext('options');
  const permission = env.browser.createContext('permission');
  const offscreen = env.browser.createContext('offscreen');
  env.browser.addTab({ id: 1, url: 'https://a.example/', active: true });
  const content = env.browser.contentContext(1);
  for (const [name, context] of [['options', options], ['permission', permission], ['offscreen', offscreen], ['content', content]]) {
    assert.deepEqual(await env.send(context, 'sw/lane-start', { lane: 'mic' }), { ok: false, code: 'FORBIDDEN' }, name);
    assert.deepEqual(await env.send(context, 'sw/lane-stop', {}), { ok: false, code: 'FORBIDDEN' }, name);
    assert.deepEqual(await env.send(context, 'sw/permission-open', {}), { ok: false, code: 'FORBIDDEN' }, name);
  }
  assert.deepEqual(await env.send(env.panel, 'sw/host-idle', { hostId: 'h', reason: 'panel-gone' }), { ok: false, code: 'FORBIDDEN' });
  assert.equal(env.stub.count('host/lane-start'), 0);

  const bad = await env.panel.chrome.runtime.sendMessage({ v: 1, target: 'sw', type: 'sw/lane-start', lane: 'nope' });
  assert.deepEqual(bad, { ok: false, code: 'INVALID_MESSAGE' });
  const unknown = await env.panel.chrome.runtime.sendMessage({ v: 1, target: 'sw', type: 'sw/unknown' });
  assert.deepEqual(unknown, { ok: false, code: 'INVALID_MESSAGE' });
});

test('SW kill/revive between the steps of a start keeps correctness: the armed record, the key and the host survive in storage', async () => {
  const env = makeEnv();
  await env.armTab(7);
  await env.seedKey();
  env.browser.sw.kill();
  assert.deepEqual(await env.start('tab', 7), { ok: true }, 'the revived worker read the armed record from storage.session');
  env.browser.sw.kill();
  const hostFlag = env.session()[STORAGE_KEYS.host];
  assert.equal(hostFlag.up, true);
  assert.deepEqual(await env.fromPanel('sw/host-probe'), { ok: true, up: true });
  env.browser.sw.kill();
  await env.browser.closeTab(7);
  await env.browser.settle();
  assert.equal(env.session()[STORAGE_KEYS.armed].tabs['7'], undefined, 'the removal event revived the worker and cleared the record');
  assert.deepEqual(env.stub.removed, [7]);
  assert.equal(env.browser.listenerErrors.length, 0);
});

test('a start whose host answers with a stale hostId still works: the worker trusts the ping, not a cached id', async () => {
  const env = makeEnv();
  await env.seedKey();
  assert.deepEqual(await env.start('mic'), { ok: true });
  env.stub.hostId = 'h-second';
  // §20 review: a lane the host still runs is refused before any host work (step 3), so the lane must be off first.
  assert.deepEqual(await env.start('mic'), { ok: false, code: 'ALREADY_RUNNING' });
  env.stub.lanes.mic = 'off';
  assert.deepEqual(await env.start('mic'), { ok: true });
  assert.equal(env.session()[STORAGE_KEYS.host].hostId, 'h-second', 'the flag follows the host that answered');
});

test('§17: a FIRST install opens the setup page (the permission page in setup mode) once; an update opens nothing', async () => {
  const env = makeEnv();
  const pages = async () => (await env.panel.chrome.tabs.query({})).map((tab) => tab.url).filter((url) => url.includes('mic-permission.html'));
  await env.browser.install('update');
  await env.browser.settle();
  assert.deepEqual(await pages(), [], 'Reload after a new folder is an update: no page');
  await env.browser.install('install');
  await env.browser.settle();
  const opened = await pages();
  assert.equal(opened.length, 1);
  assert.match(opened[0], /\/extension\/permission\/mic-permission\.html\?setup=1$/);
  assert.equal(env.browser.listenerErrors.length, 0);
});
