import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { checkSource } from '../scripts/check-i18n.mjs';
import { TURN_PHASE, isAppBusy } from '../app/state.js';
import {
  AUDIO_CONTEXT_OPTIONS, INSTALL_HINT_STORAGE_KEY, UI_LANGUAGE_STORAGE_KEY, UI_TAB_STORAGE_KEY, applyManifestLanguage,
  autoStart, captureSharedFragment, readUiLanguage, readUiTab, startApp, usableStorage, writeUiLanguage, writeUiTab,
} from '../app/main.js';
import { APP_ORIGIN, POLICY_URL, createBrowser as listeningBrowser, policyReply, scenarioPolicy } from './fixtures/scenarios.mjs';
import { createSeqEngine } from '../app/engine/seq.js';
import { createAppConfig } from '../app/config.js';
import { createSocketFixture } from './fixtures/live.mjs';
import { response as geminiResponse } from './fixtures/gemini.mjs';
import { examplePolicy, policyWith, trilingual } from './fixtures/policy.mjs';
import { POLICY_CLIENT } from '../app/policy/client.js';
import { ACTIONS, PolicyError } from '../app/policy/runtime.js';
import { APP_VERSION } from '../app/version.js';

// P1-19 bootstrap: the real modules (i18n, config with the Gemini adapter,
// key store, capture, voice and sequential engines, shell, diagnostics,
// settings, PWA) are started against a fake browser. No network: fetch
// serves the i18n JSON from disk and scripted Gemini REST responses.

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const dictionaries = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async (language) =>
  [language, JSON.parse(await read(`app/i18n/${language}.json`))])));
const ko = dictionaries.ko;
const KEY = 'PERSONAL-SECRET-KEY-0123456789';
const SHARED_KEY = 'SHARED-SECRET-KEY-0123456789';
const fragment = (providerId = 'gemini', eventName = 'Sunday <b>service</b>') => `#shared=${encodeURIComponent(JSON.stringify(
  { version: 1, providerId, eventName, key: SHARED_KEY }))}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition, limit = 300) {
  for (let i = 0; i < limit && !condition(); i++) await tick();
  assert.ok(condition(), 'condition not reached');
}
const leaks = (value) => /SECRET/.test(`${inspect(value, { depth: 6 })}`);

// Minimal DOM double (same surface as the P1-15/16 tests): innerHTML throws so
// any markup rendering of provider, QR or worker text fails loudly.
class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null;
    this.attributes = new Map(); this.listeners = new Map(); this.classes = new Set();
    this.hidden = false; this.disabled = false; this.checked = false; this.value = ''; this.style = {}; this.text = '';
    this.classList = {
      add: (...names) => { for (const name of names) this.classes.add(name); this.syncClass(); },
      remove: (...names) => { for (const name of names) this.classes.delete(name); this.syncClass(); },
      toggle: (name, force) => { const on = force ?? !this.classes.has(name); if (on) this.classes.add(name); else this.classes.delete(name); this.syncClass(); return on; },
      contains: (name) => this.classes.has(name),
    };
  }
  syncClass() { this.attributes.set('class', [...this.classes].join(' ')); }
  get children() { return this.childNodes; }
  get textContent() { return this.childNodes.length ? this.childNodes.map((child) => child.textContent).join('') : this.text; }
  set textContent(value) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; this.text = String(value ?? ''); }
  get innerHTML() { throw new Error('INNER_HTML_USED'); }
  set innerHTML(_value) { throw new Error('INNER_HTML_USED'); }
  set innerText(_value) { throw new Error('INNER_TEXT_USED'); }
  set outerHTML(_value) { throw new Error('OUTER_HTML_USED'); }
  append(...nodes) { this.text = ''; for (const node of nodes) { node.remove(); node.parentNode = this; this.childNodes.push(node); } }
  appendChild(node) { this.append(node); return node; }
  remove() { if (!this.parentNode) return; this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this); this.parentNode = null; }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'class') this.classes.clear(); }
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatch(type, init = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    return event;
  }
  focus() { this.ownerDocument.activeElement = this; }
  contains(node) { return node === this || this.childNodes.some((child) => child.contains(node)); }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
const all = (node, predicate, out = []) => {
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes) all(child, predicate, out);
  return out;
};
const byClass = (node, name) => all(node, (item) => item.classes.has(name))[0];
const visible = (node) => { for (let item = node; item; item = item.parentNode) if (item.hidden) return false; return true; };
// Every text node and attribute value in the tree, for secret scans.
const domText = (node) => all(node, () => true).map((item) => `${item.text}\n${[...item.attributes.values()].join('\n')}\n${item.value}`).join('\n');
function choose(select, value) { select.value = value; return select.dispatch('change'); }

function createDocument() {
  const doc = new FakeElement(null, '#document');
  doc.ownerDocument = doc;
  doc.title = ''; doc.activeElement = null; doc.hidden = false;
  doc.createElement = (tag) => new FakeElement(doc, tag);
  doc.documentElement = doc.createElement('html');
  doc.head = doc.createElement('head');
  doc.body = doc.createElement('body');
  doc.documentElement.append(doc.head, doc.body);
  doc.append(doc.documentElement);
  const manifest = doc.createElement('link');
  manifest.setAttribute('rel', 'manifest');
  manifest.setAttribute('href', './manifest.ko.webmanifest');
  doc.head.append(manifest);
  const root = doc.createElement('div');
  root.setAttribute('id', 'app');
  doc.body.append(root);
  doc.getElementById = (id) => all(doc, (node) => node.getAttribute('id') === id)[0] ?? null;
  doc.querySelector = (selector) => {
    assert.equal(selector, 'link[rel="manifest"]');
    return all(doc, (node) => node.tagName === 'LINK' && node.getAttribute('rel') === 'manifest')[0] ?? null;
  };
  return { doc, root, manifest };
}
function fakeTimers() {
  const queue = [];
  return {
    setTimeout: (fn, ms) => { queue.push({ fn, ms }); return queue.length; },
    clearTimeout: (id) => { if (queue[id - 1]) queue[id - 1].fn = null; },
    run() { const pending = queue.splice(0); for (const timer of pending) timer.fn?.(); return pending.filter((timer) => timer.fn).length; },
    get pending() { return queue.filter((timer) => timer.fn); },
  };
}
function fakeStorage(ops, initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map,
    getItem: (key) => { ops.push(`storage.get:${key}`); return map.has(key) ? map.get(key) : null; },
    setItem: (key, value) => { ops.push(`storage.set:${key}`); map.set(key, String(value)); },
    removeItem: (key) => { ops.push(`storage.remove:${key}`); map.delete(key); } };
}
// Fake 24 kHz-capable AudioContext: records construction options and resumes.
function fakeAudio() {
  const contexts = [];
  class AudioContext {
    constructor(options) { this.options = options; this.state = 'suspended'; this.resumes = 0; this.closes = 0; this.currentTime = 0; this.destination = {}; contexts.push(this); }
    async resume() { this.resumes += 1; this.state = 'running'; }
    async close() { this.closes += 1; this.state = 'closed'; }
    createBuffer(channels, size, rate) { const data = new Float32Array(size); return { data, duration: size / rate, getChannelData: () => data }; }
    createBufferSource() { return { connect() {}, disconnect() {}, stop() {}, start() { setImmediate(() => this.onended?.()); } }; }
  }
  return { AudioContext, contexts };
}
// Controller worker double answering the P1-18 protocol for one release id.
function fakeWorker(release, { clients = 1 } = {}) {
  const worker = new FakeElement(null, 'worker');
  worker.state = 'activated';
  worker.received = [];
  worker.calls = { skipWaiting: 0 };
  worker.postMessage = (message, [port] = []) => {
    worker.received.push(structuredClone(message));
    const reply = (data) => port?.postMessage(data);
    if (message.type === 'interp:get-release') reply({ type: 'interp:release', release });
    else if (message.type === 'interp:count-clients') reply({ type: 'interp:clients', count: clients });
    else if (message.type === 'interp:apply-update') { worker.calls.skipWaiting += 1; reply({ type: 'interp:updating', release }); }
  };
  return worker;
}
class FakePort {
  constructor() { this.onmessage = null; this.closed = false; }
  postMessage(message) { const peer = this.peer; const data = structuredClone(message); queueMicrotask(() => { if (!peer.closed) peer.onmessage?.({ data }); }); }
  close() { this.closed = true; }
}
class FakeMessageChannel {
  constructor() { this.port1 = new FakePort(); this.port2 = new FakePort(); this.port1.peer = this.port2; this.port2.peer = this.port1; }
}

// The fake browser. fetch serves app/i18n/*.json from disk, the site policy
// at the deployed root (P3-07; `policy` is a document, a function or null to
// refuse) and scripted Gemini responses; everything else is refused.
function createBrowser({ hash = '', storage: storageInit = {}, languages = ['ko-KR', 'en-US'], withStorage = true,
  controller = null, waiting = null, replaceStateError = null, clients = 1, policy = scenarioPolicy() } = {}) {
  const ops = [];
  const { doc, root, manifest } = createDocument();
  const timers = fakeTimers();
  const gemini = { calls: [], script: [], discoveryCalls: [], discoveryScript: [] };
  const policyCalls = [];
  const sockets = createSocketFixture({ inspectURL: (url) => { if (/SECRET/i.test(url)) throw new Error('KEY_IN_URL'); } });
  const win = new FakeElement(doc, 'window');
  win.document = doc;
  win.isSecureContext = true;
  win.MessageChannel = FakeMessageChannel;
  win.WebSocket = sockets.WebSocket;
  win.Blob = Blob;
  win.setTimeout = timers.setTimeout;
  win.clearTimeout = timers.clearTimeout;
  win.matchMedia = () => ({ matches: false });
  win.location = { hash, pathname: '/', search: '', origin: APP_ORIGIN, protocol: 'https:',
    get href() { return `${APP_ORIGIN}${this.pathname}${this.search}${this.hash}`; }, reloads: 0, reload() { this.reloads += 1; } };
  win.history = { replaceState(state, title, url) {
    ops.push(`replaceState:${url}`);
    if (replaceStateError) throw replaceStateError;
    win.location.hash = '';
  } };
  if (withStorage) win.localStorage = fakeStorage(ops, storageInit);
  const audio = fakeAudio();
  win.AudioContext = audio.AudioContext;
  const container = new FakeElement(doc, 'serviceworker');
  container.controller = controller;
  container.registrations = [];
  const registration = new FakeElement(doc, 'registration');
  Object.assign(registration, { scope: 'https://app.example.test/', waiting, installing: null, active: controller });
  container.register = async (url, options) => { container.registrations.push({ url, options }); return registration; };
  win.navigator = { languages, onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/128', serviceWorker: container,
    userActivation: { isActive: true }, mediaDevices: { getUserMedia: async () => { throw new Error('NO_DEVICE'); } } };
  win.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('file:')) {
      ops.push('fetch:i18n');
      assert.match(url, /\/app\/i18n\/(?:ko|en|ja)\.json$/);
      return new Response(await readFile(fileURLToPath(url)), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Owner, 2026-09-06: the Live model listing is a GET on the models endpoint
    // itself. Kept out of gemini.calls so interpretation counts stay honest.
    if (url === 'https://generativelanguage.googleapis.com/v1beta/models') {
      ops.push('fetch:models');
      gemini.discoveryCalls.push({ url, method: init.method, headers: { ...init.headers } });
      const next = gemini.discoveryScript.shift();
      if (typeof next === 'function') return next();
      if (next !== undefined) return next;
      return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      ops.push('fetch:gemini');
      const call = { url, headers: { ...init.headers }, signal: init.signal, body: init.body };
      gemini.calls.push(call);
      const next = gemini.script.shift();
      return typeof next === 'function' ? next(call) : next ?? geminiResponse();
    }
    if (url === POLICY_URL) {
      ops.push('fetch:policy');
      const call = { url, init, signal: init.signal, index: policyCalls.length };
      policyCalls.push(call);
      if (policy === null) throw new Error('UNEXPECTED_FETCH');
      const produced = typeof policy === 'function' ? await policy(call, call.index) : policy;
      if (produced instanceof Error) throw produced;
      return produced instanceof Response ? produced : policyReply(produced);
    }
    throw new Error('UNEXPECTED_FETCH');
  };
  return { win, doc, root, manifest, ops, timers, gemini, audio, container, registration, sockets, policyCalls,
    get storage() { return win.localStorage?.map; } };
}

async function start(options = {}) {
  const browser = createBrowser(options);
  const app = await startApp({ window: browser.win });
  return { ...browser, app };
}
const notice = (app) => app.engine.state.snapshot().notice?.messageKey ?? null;
const el = (browser, name) => byClass(browser.root, name);
const byId = (browser, id) => all(browser.root, (node) => node.getAttribute('id') === id)[0];
// Enter a personal key through the settings form and select personal mode.
function enterKey(browser, { remember = false } = {}) {
  const input = el(browser, 'settings-key-input');
  input.value = KEY;
  // P3-22: typing is what clears the mask of a stored key.
  input.dispatch('input');
  if (remember) el(browser, 'settings-remember').childNodes[0].checked = true;
  el(browser, 'settings-key-form').dispatch('submit');
  assert.equal(input.value.includes(KEY), false, 'the key value never stays in the field');
  assert.match(input.value, /^\u2022*$/, 'the saved key is shown as a mask, not as text');
}

test('main.js: exports only, guarded browser entry, no logging, existing dictionary keys only', async () => {
  const source = await read('app/main.js');
  assert.equal(typeof globalThis.window, 'undefined', 'Node has no window: importing main.js must not start anything');
  assert.deepEqual(checkSource(source, dictionaries.en), []);
  assert.equal(/console\.|innerHTML|outerHTML|insertAdjacentHTML|innerText|\beval\(|document\.write/.test(source), false);
  assert.match(source, /typeof window !== 'undefined'/, 'the entry call is guarded');
  assert.ok(source.indexOf('captureSharedFragment({ location') < source.indexOf('loadMessages({ fetch'), 'fragment first, i18n second');
  assert.ok(source.indexOf('loadMessages({ fetch') < source.indexOf('createAppConfig({'), 'config after i18n');
  const keyPattern = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
  const literals = [...source.matchAll(/(['"`])([^'"`\r\n]+)\1/g)].map((match) => match[2]).filter((value) => keyPattern.test(value));
  assert.ok(literals.length > 0);
  for (const key of literals) assert.ok(Object.hasOwn(dictionaries.en, key), key);
  assert.deepEqual(AUDIO_CONTEXT_OPTIONS, { sampleRate: 24000 });
  // Storage helpers accept only supported languages and never throw.
  assert.equal(readUiLanguage({ getItem: () => 'ja' }), 'ja');
  assert.equal(readUiLanguage({ getItem: () => 'zz' }), undefined);
  assert.equal(readUiLanguage({ getItem: () => { throw new Error('SECRET'); } }), undefined);
  assert.equal(readUiLanguage(null), undefined);
  assert.equal(writeUiLanguage({ setItem: () => { throw new Error('SECRET'); } }, 'ko'), false);
  assert.equal(writeUiLanguage({ setItem: () => {} }, 'xx'), false);
  assert.equal(usableStorage({ get localStorage() { throw new Error('SECRET'); } }), null);
  assert.equal(usableStorage({ localStorage: { getItem() {} } }), null);
  assert.equal(applyManifestLanguage({ querySelector: () => null }, 'ko'), false);
  assert.equal(applyManifestLanguage({ querySelector: () => ({ setAttribute() {} }) }, 'xx'), false);
});

test('fragment is removed before i18n or storage run; the shared key is held until the store exists; no auto-selection', async () => {
  const controller = fakeWorker('r-2026-09-05');
  const b = await start({ hash: fragment(), controller });
  assert.ok(b.app);
  assert.equal(b.ops[0], 'replaceState:/', 'history is rewritten first');
  assert.equal(b.win.location.hash, '');
  assert.ok(b.ops.indexOf('fetch:i18n') > 0);
  assert.ok(b.ops.indexOf(`storage.get:${UI_LANGUAGE_STORAGE_KEY}`) > 0);
  assert.equal(b.ops.filter((op) => op === 'fetch:gemini').length, 0);
  const { keyStore } = b.app.config;
  assert.equal(keyStore.getMetadata('gemini', 'shared')?.eventName, 'Sunday <b>service</b>');
  assert.equal(keyStore.getSelection(), null, 'shared mode is chosen by the user (§5.4)');
  assert.equal(keyStore.getMetadata('gemini', 'personal'), null);
  // The shell is mounted into #app with the dictionary, language and manifest applied.
  assert.equal(b.root.childNodes.length, 1);
  assert.ok(b.root.childNodes[0].classes.has('shell'));
  assert.equal(b.doc.title, ko['app.name']);
  assert.equal(b.doc.documentElement.getAttribute('lang'), 'ko');
  assert.equal(b.manifest.getAttribute('href'), './manifest.ko.webmanifest');
  assert.equal(b.app.i18n.language, 'ko');
  // Version from the controlling worker reaches the settings app section.
  assert.deepEqual(controller.received, [{ type: 'interp:get-release' }]);
  assert.equal(el(b, 'settings-app-version').textContent, ko['pwa.version'].replace('{version}', 'r-2026-09-05'));
  assert.equal(el(b, 'settings-app-mode').textContent, ko['pwa.web']);
  assert.ok(el(b, 'pwa-controls'), 'install/update controls live in the app section');
  assert.equal(el(b, 'pwa-install-hint').textContent, ko['pwa.browserInstall']);
  assert.equal(el(b, 'settings-remember').hidden, false, 'personal-key persistence is offered with storage');
  // Registration happened once, at the root scope, after the UI was up.
  await until(() => b.container.registrations.length === 1);
  assert.deepEqual(b.container.registrations, [{ url: './sw.js', options: { scope: './' } }]);
  // Secrets never reach the DOM, the store or the config surface.
  assert.equal(/SECRET/.test(domText(b.root)), false);
  assert.equal(leaks(b.app.engine.state.snapshot()), false);
  assert.equal(b.storage.size, 0, 'nothing is persisted without a choice');
  await b.app.close();
});

test('UI language: remembered choice restores; navigator.languages otherwise; changes persist and swap the manifest', async () => {
  const b = await start({ storage: { [UI_LANGUAGE_STORAGE_KEY]: 'ja' } });
  assert.equal(b.app.i18n.language, 'ja');
  assert.equal(b.doc.documentElement.getAttribute('lang'), 'ja');
  assert.equal(b.manifest.getAttribute('href'), './manifest.ja.webmanifest');
  assert.equal(b.doc.title, dictionaries.ja['app.name']);
  choose(byId(b, 'settings-ui-language'), 'en');
  assert.equal(b.app.i18n.language, 'en');
  assert.equal(b.storage.get(UI_LANGUAGE_STORAGE_KEY), 'en');
  assert.equal(b.manifest.getAttribute('href'), './manifest.en.webmanifest');
  assert.equal(b.doc.documentElement.getAttribute('lang'), 'en');
  assert.equal(b.doc.title, dictionaries.en['app.name']);
  assert.equal(b.app.setLanguage('ko'), 'ko');
  assert.equal(b.storage.get(UI_LANGUAGE_STORAGE_KEY), 'ko');
  assert.equal(b.manifest.getAttribute('href'), './manifest.ko.webmanifest');
  await b.app.close();

  const fallback = await start({ languages: ['fr-FR', 'de'], withStorage: false });
  assert.equal(fallback.app.i18n.language, 'en', 'unsupported languages fall back to English');
  assert.equal(el(fallback, 'settings-remember').hidden, true, 'no persistence offered without storage');
  assert.equal(fallback.app.setLanguage('ja'), 'ja');
  assert.equal(fallback.manifest.getAttribute('href'), './manifest.ja.webmanifest');
  await fallback.app.close();
  const stored = await start({ storage: { [UI_LANGUAGE_STORAGE_KEY]: 'zz' }, languages: ['ja-JP'] });
  assert.equal(stored.app.i18n.language, 'ja', 'an invalid stored value is ignored');
  await stored.app.close();
});

test('text interpretation end to end: key saved from settings, Gemini called with the key in a header, result committed; deletion cancels late work', async () => {
  const b = await start();
  const { app } = b;
  const store = app.engine.state;
  enterKey(b, { remember: true });
  assert.equal(b.storage.get('interp-app.personal-key.v1.gemini'), KEY, 'remembered keys use the key store slot');
  assert.deepEqual(app.config.keyStore.getSelection(), { providerId: 'gemini', keySource: 'personal' });
  assert.deepEqual(store.snapshot().keySelection, { providerId: 'gemini', keySource: 'personal' });
  assert.equal(el(b, 'shell-mode').textContent, ko['mode.personal']);
  choose(byId(b, 'settings-voice-output'), 'off');
  assert.equal(store.snapshot().voice.output, 'off');

  const first = app.engine.submitText('사과 12개');
  const done = await first.done;
  assert.equal(done.phase, TURN_PHASE.COMPLETED);
  assert.equal(done.translatedText, '12 apples');
  assert.deepEqual(done.voice, { status: 'off', engine: null, messageKey: 'seq.captionsOnly', errorCode: null, fallback: false,
    deviceFallbackAvailable: false, gap: false, said: '' });
  assert.equal(b.gemini.calls.length, 1);
  assert.equal(b.gemini.calls[0].headers['x-goog-api-key'], KEY, 'authentication happens in the adapter header');
  assert.equal(/SECRET/.test(b.gemini.calls[0].url), false, 'never in the URL');
  assert.equal(store.snapshot().activeTurnId, null);
  const bubble = all(b.root, (node) => node.classes.has('turn'))[0];
  assert.ok(bubble, 'the sequential view rendered the turn');
  assert.ok(domText(bubble).includes('12 apples'));

  // A second turn is in flight when the key is deleted: the request aborts,
  // the turn is cancelled and no late result is committed.
  let release;
  b.gemini.script.push(() => new Promise((resolve) => { release = resolve; }));
  const second = app.engine.submitText('두 번째');
  await until(() => b.gemini.calls.length === 2);
  assert.equal(store.snapshot().activeTurnId, second.turnId);
  el(b, 'settings-key-delete').dispatch('click');
  el(b, 'settings-key-delete-confirm').dispatch('click');
  assert.equal(b.gemini.calls[1].signal.aborted, true);
  const cancelled = await second.done;
  assert.equal(cancelled.phase, TURN_PHASE.CANCELLED);
  // The selection is kept so nothing falls back to another source (§9.4); only the key is gone.
  assert.deepEqual(store.snapshot().keySelection, { providerId: 'gemini', keySource: 'personal' });
  assert.equal(app.config.keyStore.getMetadata('gemini', 'personal'), null);
  assert.equal(b.storage.has('interp-app.personal-key.v1.gemini'), false, 'the stored copy is removed too');
  assert.equal(notice(app), 'settings.keyDeleted');
  release(geminiResponse());
  await tick(); await tick();
  assert.equal(store.snapshot().turns.find((turn) => turn.turnId === second.turnId).phase, TURN_PHASE.CANCELLED, 'late result discarded');
  assert.equal(el(b, 'settings-key-status').textContent, ko['settings.noKey']);
  // Without a key a new turn fails with CREDENTIAL_REQUIRED and no request.
  const third = await app.engine.submitText('세 번째').done;
  assert.equal(third.phase, TURN_PHASE.ERROR);
  assert.equal(third.errorCode, 'CREDENTIAL_REQUIRED');
  assert.equal(b.gemini.calls.length, 2);
  assert.equal(/SECRET/.test(domText(b.root)), false);
  await app.close();
});

test('a remembered personal key is loaded before the views; a corrupt stored value is dropped with a notice', async () => {
  const b = await start({ storage: { 'interp-app.personal-key.v1.gemini': KEY } });
  assert.deepEqual(b.app.config.keyStore.getSelection(), { providerId: 'gemini', keySource: 'personal' });
  assert.equal(b.app.config.keyStore.getMetadata('gemini', 'personal')?.remembered, true);
  assert.equal(el(b, 'settings-key-status').getAttribute('data-key'), 'remembered');
  assert.equal(el(b, 'shell-mode').textContent, ko['mode.personal']);
  assert.equal(/SECRET/.test(domText(b.root)), false);
  await b.app.close();
  const corrupt = await start({ storage: { 'interp-app.personal-key.v1.gemini': 'bad key with spaces' } });
  assert.ok(corrupt.app);
  assert.equal(corrupt.app.config.keyStore.getMetadata('gemini', 'personal'), null);
  assert.equal(corrupt.storage.has('interp-app.personal-key.v1.gemini'), false);
  assert.equal(notice(corrupt.app), 'error.INVALID_KEY');
  await corrupt.app.close();
});

test('URL cleanup failure stops the start with a dictionary message; an invalid payload starts with a notice', async () => {
  const failed = createBrowser({ hash: fragment(), replaceStateError: new Error('SECRET history') });
  assert.equal(await startApp({ window: failed.win }), null);
  assert.equal(failed.root.textContent, ko['error.URL_CLEANUP_FAILED']);
  assert.deepEqual(failed.ops.filter((op) => !op.startsWith('fetch:i18n')), ['replaceState:/'], 'no storage, no provider call');
  assert.equal(failed.container.registrations.length, 0);

  const invalid = await start({ hash: '#shared=not-a-payload' });
  assert.ok(invalid.app);
  assert.equal(invalid.win.location.hash, '');
  assert.equal(notice(invalid.app), 'error.INVALID_SHARED_PAYLOAD');
  assert.equal(invalid.app.config.keyStore.getMetadata('gemini', 'shared'), null);
  assert.equal(el(invalid, 'shell-notice-text').textContent, ko['error.INVALID_SHARED_PAYLOAD']);
  await invalid.app.close();

  const plain = await start();
  assert.equal(plain.ops.some((op) => op.startsWith('replaceState')), false, 'no fragment, no history rewrite');
  await plain.app.close();
  await assert.rejects(startApp({ window: {} }), /INVALID_REQUEST/);
});

test('shared mode: explicit selection, ending shared use clears the conversation and the key', async () => {
  const b = await start({ hash: fragment() });
  const { app } = b;
  const store = app.engine.state;
  assert.equal(el(b, 'settings-shared-event').textContent, ko['settings.event'].replace('{event}', 'Sunday <b>service</b>'));
  const sharedRadio = all(b.root, (node) => node.getAttribute('id') === 'settings-mode-shared')[0];
  assert.equal(sharedRadio.disabled, false);
  sharedRadio.checked = true;
  sharedRadio.dispatch('change');
  assert.deepEqual(store.snapshot().keySelection, { providerId: 'gemini', keySource: 'shared' });
  assert.equal(el(b, 'shell-mode').textContent, ko['mode.shared']);
  choose(byId(b, 'settings-voice-output'), 'off');
  const turn = await app.engine.submitText('사과 12개').done;
  assert.equal(turn.phase, TURN_PHASE.COMPLETED);
  assert.equal(b.gemini.calls[0].headers['x-goog-api-key'], SHARED_KEY);
  el(b, 'settings-shared-end').dispatch('click');
  assert.equal(store.snapshot().turns.length, 0, 'shared end clears the in-memory conversation');
  assert.equal(notice(app), 'records.sharedEnded');
  assert.equal(app.config.keyStore.getMetadata('gemini', 'shared'), null);
  assert.deepEqual(store.snapshot().keySelection, { providerId: 'gemini', keySource: 'shared' }, 'no automatic switch to personal');
  assert.equal((await app.engine.submitText('사과 12개').done).errorCode, 'CREDENTIAL_REQUIRED');
  assert.equal(b.gemini.calls.length, 1, 'no request without a key');
  assert.equal(/SECRET/.test(domText(b.root)), false);
  await app.close();
});

test('audio context: created at 24 kHz and resumed inside the first gesture, shared by voice and diagnostics, closed on teardown', async () => {
  const b = await start();
  assert.equal(b.audio.contexts.length, 0, 'no context before a gesture');
  b.doc.dispatch('pointerdown');
  assert.equal(b.audio.contexts.length, 1);
  assert.deepEqual(b.audio.contexts[0].options, { sampleRate: 24000 });
  assert.equal(b.audio.contexts[0].resumes, 1);
  b.doc.dispatch('keydown');
  assert.equal(b.audio.contexts.length, 1, 'one context for the page');
  assert.equal(b.app.getAudioContext(), b.audio.contexts[0]);
  await b.app.close();
  assert.equal(b.audio.contexts[0].closes, 1);
  assert.equal(b.doc.listenerCount, 0, 'gesture listeners removed');
  // Without Web Audio the getter yields null and the engines fall back on their own.
  const silent = createBrowser();
  delete silent.win.AudioContext;
  const app = await startApp({ window: silent.win });
  assert.equal(app.getAudioContext(), null);
  await app.close();
});

test('pagehide cancels active work; an unload (not bfcache) tears everything down in order', async () => {
  const b = await start();
  const { app } = b;
  enterKey(b);
  choose(byId(b, 'settings-voice-output'), 'off');
  b.gemini.script.push(() => new Promise(() => {}));
  const turn = app.engine.submitText('사과 12개');
  await until(() => b.gemini.calls.length === 1);
  b.win.dispatch('pagehide', { persisted: true });
  assert.equal((await turn.done).phase, TURN_PHASE.CANCELLED, 'bfcache entry cancels the turn');
  assert.equal(app.closed, false, 'the page may come back from bfcache');
  assert.equal(b.gemini.calls[0].signal.aborted, true);
  await app.stopWork();
  b.gemini.script.push(() => new Promise(() => {}));
  const second = app.engine.submitText('사과 12개');
  await until(() => b.gemini.calls.length === 2);
  b.win.dispatch('pagehide', { persisted: false });
  assert.equal(app.closed, true, 'close starts synchronously with the unload');
  assert.equal((await second.done).phase, TURN_PHASE.CANCELLED);
  // Teardown finishes asynchronously: views, diagnostics, shell, engine, config.
  await until(() => app.engine.state.closed);
  assert.equal(b.root.childNodes.length, 0, 'the shell is removed');
  assert.throws(() => app.config.keyStore.getSelection(), /STORE_CLOSED/);
  assert.equal(b.win.listenerCount, 0, 'window listeners removed');
  assert.equal(b.doc.listenerCount, 0);
  assert.equal(b.storage.has('interp-app.personal-key.v1.gemini'), true, 'the default remembered key survives unload');
  await app.close();
  assert.equal(app.closed, true);
});

test('notices: offline, update available (button deferred while busy), install hint after the first success', async () => {
  const waiting = fakeWorker('r-2', { clients: 1 });
  const b = await start({ controller: fakeWorker('r-1'), waiting });
  const { app } = b;
  const store = app.engine.state;
  await until(() => notice(app) === 'pwa.updateAvailable');
  assert.equal(el(b, 'pwa-update').hidden, false);
  b.win.dispatch('offline');
  assert.equal(notice(app), 'pwa.offline');
  enterKey(b);
  choose(byId(b, 'settings-voice-output'), 'off');
  store.setNotice(null);
  b.gemini.script.push(() => new Promise((resolve) => { b.release = resolve; }));
  const turn = app.engine.submitText('사과 12개');
  await until(() => b.gemini.calls.length === 1);
  el(b, 'pwa-update').dispatch('click');
  await until(() => notice(app) === 'pwa.updateAvailable');
  assert.equal(waiting.calls.skipWaiting, 0, 'an active turn defers the update');
  assert.equal(waiting.received.length, 0);
  b.release(geminiResponse());
  assert.equal((await turn.done).phase, TURN_PHASE.COMPLETED);
  assert.equal(b.timers.pending.some((timer) => timer.ms === 0), true, 'install hint is deferred out of the commit');
  b.timers.run();
  assert.equal(notice(app), 'pwa.installPrompt');
  assert.equal(b.storage.get(INSTALL_HINT_STORAGE_KEY), '1');
  store.setNotice(null);
  assert.equal((await app.engine.submitText('사과 12개').done).phase, TURN_PHASE.COMPLETED);
  b.timers.run();
  assert.equal(notice(app), null, 'the hint shows once');
  // Idle and alone: the update applies and the controller change reloads.
  el(b, 'pwa-update').dispatch('click');
  await until(() => waiting.calls.skipWaiting === 1);
  assert.deepEqual(waiting.received.map((message) => message.type), ['interp:count-clients', 'interp:apply-update']);
  b.container.dispatch('controllerchange');
  assert.equal(b.win.location.reloads, 1);
  await app.close();
  const hinted = await start({ storage: { [INSTALL_HINT_STORAGE_KEY]: '1' } });
  enterKey(hinted);
  choose(byId(hinted, 'settings-voice-output'), 'off');
  await hinted.app.engine.submitText('사과 12개').done;
  hinted.timers.run();
  assert.equal(notice(hinted.app), null, 'a remembered hint is not repeated');
  await hinted.app.close();
});

test('captureSharedFragment strips first and delivers once', () => {
  const ops = [];
  const location = { hash: '#shared=abc', pathname: '/x' };
  const history = { replaceState: (state, title, url) => { ops.push(url); location.hash = ''; } };
  const held = captureSharedFragment({ location, history });
  assert.equal(held.received, true);
  assert.deepEqual(ops, ['/x']);
  const received = [];
  assert.equal(held.deliver({ receiveSharedFragment: (value) => received.push(value) }), true);
  assert.deepEqual(received, ['#shared=abc']);
  assert.equal(held.deliver({ receiveSharedFragment: (value) => received.push(value) }), false, 'the fragment is dropped after delivery');
  const none = captureSharedFragment({ location: { hash: '', pathname: '/' }, history });
  assert.equal(none.received, false);
  assert.equal(none.deliver({ receiveSharedFragment: () => { throw new Error('unexpected'); } }), false);
  assert.throws(() => captureSharedFragment({ location: { hash: '#a', pathname: '/' }, history: { replaceState() { throw new Error('SECRET'); } } }),
    (error) => error.code === 'URL_CLEANUP_FAILED');
});

test('boot failure is visible without exposing errors when i18n fetch rejects or hangs', async () => {
  for (const hang of [false, true]) {
    const b = createBrowser({ hash: fragment() });
    let timeout, cleared = 0;
    const requests = [];
    b.win.fetch = (_url, options) => {
      requests.push(options);
      return hang ? new Promise(() => {}) : Promise.reject(new Error('SECRET fetch'));
    };
    const pending = startApp({ window: b.win,
      setTimeout(fn) { timeout = fn; return 1; }, clearTimeout() { cleared++; } });
    if (hang) { await tick(); timeout(); }
    assert.equal(await pending, null);
    assert.equal(b.win.location.hash, '');
    assert.equal(b.root.textContent, dictionaries.en['error.NETWORK_ERROR']);
    assert.equal(b.root.getAttribute('role'), 'alert');
    assert.equal(b.root.getAttribute('lang'), 'en');
    assert.equal(b.container.registrations.length, 0);
    assert.equal(b.audio.contexts.length, 0);
    assert.ok(cleared > 0);
    if (hang) assert.ok(requests.every((request) => request.signal.aborted));
    assert.doesNotMatch(b.root.textContent, /SECRET/);
  }
});

test('initialization failures clean gesture listeners and show dictionary text; SW and audio failures do not blank the shell', async () => {
  const broken = createBrowser();
  Object.defineProperty(broken.win, 'speechSynthesis', { get() { throw new Error('SECRET getter'); } });
  assert.equal(await startApp({ window: broken.win }), null);
  assert.equal(broken.doc.listenerCount, 0);
  assert.equal(broken.root.textContent, ko['error.unknown']);
  assert.equal(broken.root.getAttribute('role'), 'alert');

  const b = createBrowser();
  Object.defineProperty(b.win, 'localStorage', { get() { throw new Error('SECRET storage'); } });
  b.container.register = async () => { throw new Error('SECRET worker'); };
  b.win.AudioContext = class { constructor() { throw new Error('SECRET audio'); } };
  const app = await startApp({ window: b.win });
  assert.ok(app);
  b.doc.dispatch('pointerdown');
  assert.equal(app.getAudioContext(), null);
  assert.ok(el(b, 'shell'));
  await tick();
  assert.equal(app.pwa.snapshot().registered, false);
  await app.close();
});


test('automatic entry waits for DOM readiness and starts the first load', async () => {
  const b = createBrowser();
  b.doc.readyState = 'loading';
  const pending = autoStart(b.win);
  assert.equal(b.ops.filter((op) => op.startsWith('fetch')).length, 0);
  b.doc.readyState = 'interactive';
  b.doc.dispatch('DOMContentLoaded');
  const app = await pending;
  assert.ok(app);
  assert.ok(el(b, 'shell'));
  assert.equal(b.container.registrations.length, 1);
  await app.close();
});

// P2 lifecycle integration uses the real engines, router, sockets and views.
const testHubs = [{ id: 'test', labelKey: 'hub.venue', url: 'wss://hub.example.test/ws' }];
async function listeningApp(t, { personal = true, ...options } = {}) {
  const b = listeningBrowser(options);
  b.app = await startApp({ window: b.win, hubs: testHubs });
  assert.ok(b.app);
  t.after(async () => {
    for (const socket of b.sockets) socket.finishClose();
    await b.app.close();
  });
  if (personal) enterKey(b);
  await b.app.shell.switchTab('simultaneous');
  return b;
}
async function runDirect(b) {
  const handle = b.app.listenEngines.direct.start({ targetLanguage: 'ja' });
  assert.equal(b.microphone.streams.length, 1, 'permission starts in the gesture');
  await until(() => b.audio.nodes.at(-1)?.port.onmessage);
  b.microphone.feed(new Float32Array(4096).fill(0.1));
  await until(() => b.sockets.length > 0);
  const socket = b.sockets.at(-1);
  socket.open(); socket.json({ setupComplete: {} });
  await handle.ready;
  assert.equal(b.app.listenEngines.direct.snapshot().status, 'running');
  return { handle, socket };
}

test('P2 mounts without starting resources; direct listening blocks sequential work, diagnostics and updates through physical close', async t => {
  const waiting = fakeWorker('r-2');
  const b = await listeningApp(t, { controller: fakeWorker('r-1'), waiting });
  assert.ok(b.app.shell.simView);
  assert.equal(b.microphone.streams.length, 0);
  assert.equal(b.sockets.length, 0);
  const { socket } = await runDirect(b);
  socket.close = () => { socket.closeCalls++; socket.readyState = 2; };
  assert.equal(b.app.engine.state.snapshot().activeTurnId, null);
  assert.throws(() => b.app.engine.submitText('test'), { code: 'INVALID_REQUEST' });
  assert.throws(() => b.app.diagnostics.run('voice'), { code: 'INVALID_REQUEST' });
  await b.app.pwa.applyUpdate();
  assert.equal(waiting.calls.skipWaiting, 0);
  b.container.dispatch('controllerchange');
  assert.equal(b.win.location.reloads, 0);
  b.app.shell.openSettings(); b.app.setLanguage('en'); b.app.listenEngines.direct.setMuted(true);
  assert.equal(b.app.listenEngines.direct.snapshot().status, 'running');
  b.app.shell.closeSettings();
  const switched = b.app.shell.switchTab('sequential');
  await until(() => socket.closeCalls > 0);
  assert.equal(b.app.shell.selectedTab, 'simultaneous');
  assert.equal(b.app.activity.occupied, true);
  assert.ok(b.microphone.streams.every(stream => stream.stopped));
  assert.throws(() => b.app.engine.submitText('test'), { code: 'INVALID_REQUEST' });
  assert.equal(b.win.location.reloads, 0);
  socket.finishClose();
  assert.equal(await switched, 'sequential');
  await until(() => !b.app.activity.occupied);
  assert.equal(b.win.location.reloads, 1);
  assert.equal(b.app.config.sessionManager.occupied, false);
  assert.equal(b.gemini.calls.length, 0);
});

test('P2 discards pending language changes after a key change and ignores late captions', async t => {
  const b = await listeningApp(t);
  const { socket } = await runDirect(b);
  socket.close = () => { socket.closeCalls++; socket.readyState = 2; };
  const target = el(b, 'sim-target');
  choose(target, 'en');
  assert.equal(target.disabled, true);
  b.app.config.keyStore.setPersonal('gemini', KEY + '-changed');
  socket.json({ serverContent: { outputTranscription: { text: 'late', finished: true } } });
  socket.finishClose();
  await until(() => !target.disabled && !b.app.activity.occupied);
  assert.equal(target.value, 'ja', 'old settings transaction cannot commit');
  assert.equal(b.app.listenEngines.direct.snapshot().captions.captions.length, 0);
  assert.equal(b.sockets.length, 1, 'key change never restarts automatically');
  choose(target, 'en');
  await until(() => !target.disabled);
  assert.equal(target.value, 'en', 'a new explicit settings change can commit');
});

for (const event of ['visibilitychange', 'pagehide']) {
  test(`P2 ${event} stops listening; returning requires manual start`, async t => {
    const b = await listeningApp(t);
    const { handle } = await runDirect(b);
    if (event === 'visibilitychange') { b.doc.hidden = true; b.doc.dispatch(event); }
    else b.win.dispatch(event, { persisted: true });
    await handle.done;
    await until(() => !b.app.activity.occupied);
    assert.equal(b.app.listenEngines.direct.snapshot().status, 'stopped');
    assert.ok(b.microphone.streams.every(stream => stream.stopped));
    b.doc.hidden = false; b.doc.dispatch('visibilitychange');
    await tick();
    assert.equal(b.sockets.length, 1);
    assert.equal(b.app.closed, false);
  });
}

test('P2 hub reception requires no personal key or microphone and remains usable without device speech', async t => {
  const b = listeningBrowser();
  delete b.win.speechSynthesis; delete b.win.SpeechSynthesisUtterance;
  b.app = await startApp({ window: b.win, hubs: testHubs });
  t.after(() => b.app.close());
  await b.app.shell.switchTab('simultaneous');
  choose(el(b, 'sim-mode'), 'hub');
  await until(() => el(b, 'sim-mode').value === 'hub');
  const handle = b.app.listenEngines.hub.join({ hubId: 'test', roomCode: 'abc123', language: 'ja' });
  await until(() => b.sockets.length === 1);
  const socket = b.sockets[0];
  socket.open(); socket.json({ type: 'hello', sessionId: 'room-session', settings: { allowedLangs: ['ja'] } });
  await handle.ready;
  assert.equal(b.app.listenEngines.hub.snapshot().status, 'running');
  b.app.listenEngines.hub.setMuted(false);
  socket.json({ type: 'cast.caption', lang: 'ja', segmentId: 's1', seq: 1, revision: 1, text: '字幕', final: true });
  await until(() => b.app.listenEngines.hub.snapshot().translations.length === 1);
  await until(() => b.app.listenEngines.hub.snapshot().output === 'unavailable');
  assert.equal(b.app.config.keyStore.getSelection(), null);
  assert.equal(b.microphone.streams.length, 0);
  assert.equal(b.gemini.calls.length, 0);
  assert.throws(() => b.app.engine.submitText('test'), { code: 'INVALID_REQUEST' });
  assert.throws(() => b.app.diagnostics.run('playback'), { code: 'INVALID_REQUEST' });
  await b.app.shell.switchTab('sequential');
  assert.equal(socket.readyState, 3);
  assert.equal(b.app.activity.occupied, false);
  assert.equal(b.sockets.length, 1);
});

test('P2 busy includes reconnect, cleanup and playback without an active sequential turn', () => {
  for (const status of ['preparing', 'connecting', 'running', 'reconnecting', 'stopping']) {
    assert.equal(isAppBusy({ listening: [{ status }] }), true);
  }
  for (const value of [{ sequential: { busy: true } }, { activity: { occupied: true } },
    { diagnostics: { running: {} } }, { transitioning: true }, { listening: [{ status: 'failed', busy: true }] }]) {
    assert.equal(isAppBusy(value), true);
  }
  assert.equal(isAppBusy({ listening: [{ status: 'stopped' }] }), false);
});

test('P2 a late cancelled replay cannot overwrite a newer replay of the same turn', async t => {
  const config = createAppConfig({ fetch: async () => geminiResponse() });
  config.keyStore.setPersonal('gemini', KEY); config.keyStore.select('gemini', 'personal');
  const pending = [];
  const voice = { speak: () => new Promise(resolve => pending.push(resolve)), close: async () => {} };
  const engine = createSeqEngine({ config, capture: { start() {}, cancel() {} }, voiceEngine: voice });
  t.after(async () => { await engine.close(); await config.dispose(); });
  engine.setVoice({ output: 'off' });
  engine.setInterpretation({ sourceLanguage: 'ko', targetLanguage: 'en' });
  const original = await engine.submitText('사과 12개').done;
  assert.equal(original.phase, TURN_PHASE.COMPLETED);
  const first = engine.replay(original.turnId);
  const second = engine.replay(original.turnId);
  pending[0]({ status: 'completed' }); await first.done;
  assert.equal(engine.state.snapshot().activeTurnId, original.turnId);
  assert.equal(engine.state.snapshot().turns[0].voice.status, 'off');
  pending[1]({ status: 'completed' }); await second.done;
  assert.equal(engine.state.snapshot().turns[0].voice.status, 'completed');
  assert.equal(engine.snapshot().busy, false);
});


test('P2 direct credentials are checked before permission; a pending permission result is cleaned after unload', async t => {
  const b = await listeningApp(t, { personal: false });
  assert.throws(() => b.app.listenEngines.direct.start({ targetLanguage: 'ja' }), { code: 'CREDENTIAL_REQUIRED' });
  assert.equal(b.microphone.streams.length, 0);
  await b.app.stopWork();
  enterKey(b);
  let release;
  const stream = await b.microphone.getUserMedia();
  b.win.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { release = resolve; });
  const handle = b.app.listenEngines.direct.start({ targetLanguage: 'ja' });
  b.win.dispatch('pagehide', { persisted: false });
  const closed = b.app.close();
  assert.equal(b.app.close(), closed, 'all close callers await the same teardown');
  release(stream);
  await handle.done; await closed;
  assert.equal(stream.stopped, true);
  assert.equal(b.sockets.length, 0);
  assert.equal(b.root.childNodes.length, 0);
  assert.equal(b.doc.listenerCount, 0);
  assert.equal(b.win.listenerCount, 0);
});

// P3-02e: first screen, key badge, key retention note. Owner, 2026-09-06:
// every launch opens on simultaneous interpretation, whatever was used last.
test('P3-02e every launch opens simultaneous interpretation; the key badge opens the key entry', async t => {
  const b = await start(); t.after(() => b.app.close());
  assert.equal(b.app.shell.selectedTab, 'simultaneous');
  assert.equal(b.app.shell.elements.panels.simultaneous.hidden, false);
  assert.equal(b.app.shell.elements.panels.sequential.hidden, true);
  assert.equal(b.storage.has(UI_TAB_STORAGE_KEY), false, 'the default is not written');
  await b.app.shell.switchTab('sequential');
  assert.equal(b.storage.get(UI_TAB_STORAGE_KEY), 'sequential');
  // The last tab is still recorded, but it no longer decides the first screen:
  // interpretation is what the app is for, so that is where it opens.
  const remembered = await start({ storage: { [UI_TAB_STORAGE_KEY]: 'sequential' } }); t.after(() => remembered.app.close());
  assert.equal(remembered.app.shell.selectedTab, 'simultaneous');
  const corrupt = await start({ storage: { [UI_TAB_STORAGE_KEY]: 'settings' } }); t.after(() => corrupt.app.close());
  assert.equal(corrupt.app.shell.selectedTab, 'simultaneous');
  const bare = await start({ withStorage: false }); t.after(() => bare.app.close());
  assert.equal(bare.app.shell.selectedTab, 'simultaneous');
  await bare.app.shell.switchTab('sequential');
  assert.equal(bare.app.shell.selectedTab, 'sequential', 'no storage: the choice still applies for this run');
  assert.equal(readUiTab(null), undefined);
  assert.equal(writeUiTab(null, 'sequential'), false);
  assert.equal(writeUiTab(b.win.localStorage, 'bogus'), false);
  // The key badge is a button: "no key" opens settings with the key entry focused.
  const badge = el(b, 'shell-mode');
  assert.equal(badge.tagName, 'BUTTON');
  assert.equal(badge.textContent, ko['settings.noKey']);
  badge.dispatch('click');
  assert.equal(b.app.shell.settingsOpen, true);
  assert.equal(b.doc.activeElement, el(b, 'settings-key-input'));
  assert.equal(badge.getAttribute('aria-expanded'), 'true');
  b.app.shell.closeSettings();
  assert.equal(badge.getAttribute('aria-expanded'), 'false');
  // The key section says the key may have to be entered again on this device (iOS storage).
  const note = el(b, 'settings-key-retention');
  assert.ok(el(b, 'settings-key').contains(note));
  assert.equal(note.textContent, ko['settings.keyRetentionHint']);
  b.app.setLanguage('ja');
  assert.equal(note.textContent, dictionaries.ja['settings.keyRetentionHint']);
  assert.equal(b.app.shell.elements.settingsButton.getAttribute('aria-expanded'), 'false');
});

test('P3-02e starting without a key names the cause on the simultaneous screen and offers the key entry; a browser without streaming capture is named', async t => {
  const b = await listeningApp(t, { personal: false });
  el(b, 'sim-start').dispatch('click');
  assert.equal(el(b, 'sim-notice').textContent, ko['sim.error.CREDENTIAL_REQUIRED']);
  assert.notEqual(el(b, 'sim-notice').textContent, ko['error.unknown']);
  assert.equal(el(b, 'sim-open-settings').hidden, false);
  assert.equal(b.microphone.streams.length, 0); assert.equal(b.sockets.length, 0);
  el(b, 'sim-open-settings').dispatch('click');
  assert.equal(b.app.shell.settingsOpen, true);
  assert.equal(b.doc.activeElement, el(b, 'settings-key-input'));
  enterKey(b);
  b.app.shell.closeSettings();
  await until(() => !b.app.activity.occupied);
  delete b.win.AudioWorkletNode;
  assert.throws(() => b.app.listenEngines.direct.start({ targetLanguage: 'ja' }), { code: 'INPUT_UNSUPPORTED' });
  await until(() => !b.app.activity.occupied);
  el(b, 'sim-start').dispatch('click');
  assert.equal(el(b, 'sim-notice').textContent, ko['sim.error.INPUT_UNSUPPORTED']);
  assert.equal(el(b, 'sim-open-settings').hidden, true);
  await until(() => !b.app.activity.occupied);
  assert.equal(b.microphone.streams.length, 0); assert.equal(b.sockets.length, 0);
  assert.equal(b.app.listenEngines.direct.snapshot().status, 'idle');
});

test('P3-02e manual reopen replaces the running direct session through the app: old socket closed, new session with a fresh budget', async t => {
  const b = await listeningApp(t);
  const { socket, handle } = await runDirect(b);
  assert.equal(el(b, 'sim-reopen').hidden, false);
  assert.equal(el(b, 'sim-fs-reopen').hidden, false);
  el(b, 'sim-reopen').dispatch('click');
  await handle.done;
  await until(() => socket.readyState === 3);
  await until(() => b.audio.nodes.at(-1)?.port.onmessage && b.app.listenEngines.direct.snapshot().busy);
  b.microphone.feed(new Float32Array(4096).fill(0.1));
  await until(() => b.sockets.length === 2);
  const next = b.sockets[1]; next.open(); next.json({ setupComplete: {} });
  await until(() => b.app.listenEngines.direct.snapshot().status === 'running');
  assert.equal(b.app.listenEngines.direct.snapshot().retries, 0, 'a manual reopen is a new operation');
  // runDirect started the engine directly, so this is the screen's first own start: the headphone hint, no error.
  assert.equal(el(b, 'sim-notice').textContent, ko['sim.headphonesStart']);
  assert.equal(b.app.activity.occupied, true);
  assert.equal(b.gemini.calls.length, 0);
});

test('P3-02e a key that does not survive the storage write is reported as a storage failure and is not kept', async t => {
  const b = await start(); t.after(() => b.app.close());
  // Private browsing or evicted storage: setItem raises nothing and stores nothing.
  b.win.localStorage.setItem = () => {};
  enterKey(b, { remember: true });
  assert.equal(el(b, 'settings-key-feedback').textContent, ko['error.STORAGE_FAILED']);
  assert.equal(el(b, 'settings-key-status').getAttribute('data-key'), 'none');
  assert.equal(b.app.config.keyStore.getMetadata('gemini', 'personal'), null);
  assert.equal(b.storage.has('interp-app.personal-key.v1.gemini'), false);
  assert.equal(notice(b.app), 'error.STORAGE_FAILED');
  assert.equal(el(b, 'shell-mode').textContent, ko['settings.noKey']);
  // Without "remember" the key serves this run.
  el(b, 'settings-remember').childNodes[0].checked = false;
  enterKey(b);
  assert.equal(el(b, 'settings-key-status').getAttribute('data-key'), 'memory');
  // P3-22 (owner wording): the save result sits under the field.
  assert.equal(el(b, 'settings-key-feedback').textContent, ko['keyGuide.saved.session']);
  assert.equal(leaks(b.ops), false);
});

test('P2 reconnect waiting keeps update and auxiliary work blocked and visibility cancels the retry', async t => {
  const b = await listeningApp(t);
  const { socket, handle } = await runDirect(b);
  socket.json({ goAway: { timeLeft: '10s' } });
  await until(() => b.app.listenEngines.direct.snapshot().status === 'reconnecting');
  assert.equal(b.app.engine.state.snapshot().activeTurnId, null);
  assert.equal(b.app.activity.occupied, true);
  assert.throws(() => b.app.diagnostics.run('voice'), { code: 'INVALID_REQUEST' });
  b.container.dispatch('controllerchange');
  assert.equal(b.win.location.reloads, 0);
  b.doc.hidden = true; b.doc.dispatch('visibilitychange');
  await handle.done; await until(() => !b.app.activity.occupied);
  b.clock.advance(8000); await tick();
  assert.equal(b.sockets.length, 1, 'cancelled recovery never opens a replacement');
  assert.equal(b.app.listenEngines.direct.snapshot().status, 'stopped');
});

// P2-19: the bootstrap graph must parse without JSON module syntax.
test('bootstrap graph uses JS modules and the minimal fallback matches English JSON exactly', async () => {
  const { default: fallback } = await import('../app/i18n/boot-fallback.js');
  assert.deepEqual(Object.keys(fallback).sort(), ['error.ABORTED', 'error.NETWORK_ERROR', 'error.unknown']);
  assert.ok(Object.isFrozen(fallback));
  for (const [key, value] of Object.entries(fallback)) assert.equal(value, dictionaries.en[key]);
  const visited = new Set();
  async function visit(url) {
    if (visited.has(url.href)) return;
    visited.add(url.href);
    const source = await readFile(url, 'utf8');
    assert.doesNotMatch(source, /\b(?:with|assert)\s*\{\s*type\s*:\s*['"]json['"]/);
    for (const [, specifier] of source.matchAll(/^[ \t]*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?['"]([^'"]+)['"]/gm)) {
      assert.ok(specifier.startsWith('.'), specifier);
      assert.ok(specifier.endsWith('.js'), specifier);
      await visit(new URL(specifier, url));
    }
  }
  await visit(new URL('../app/main.js', import.meta.url));
  assert.ok([...visited].some(url => url.endsWith('/i18n/boot-fallback.js')));
});

test('dictionary loading rejects HTTP, JSON and invalid dictionary failures and aborts siblings', async () => {
  const { loadI18n } = await import('../app/i18n/index.js');
  for (const bad of [
    { ok: false },
    { ok: true, json() { throw new Error('SECRET body'); } },
    ...[null, [], {}, { 'error.unknown': ' ' }, { 'error.unknown': 'valid', bad: 4 }]
      .map(value => ({ ok: true, json: async () => value })),
  ]) {
    const signals = [];
    await assert.rejects(loadI18n({ fetch: async (url, { signal }) => {
      signals.push(signal);
      return url.pathname.endsWith('/ja.json') ? bad : new Promise(() => {});
    } }), error => error.message === 'I18N_LOAD_FAILED' && !leaks(error) && !error.cause);
    assert.equal(signals.length, 3);
    assert.ok(signals.every(signal => signal.aborted));
  }
});

test('dictionary cancellation settles ignored signals during fetch or JSON reading and discards late results', async () => {
  const { loadI18n } = await import('../app/i18n/index.js');
  for (const phase of ['before', 'fetch', 'body']) {
    const controller = new AbortController();
    const signals = [], late = [];
    if (phase === 'before') controller.abort(new Error('SECRET abort reason'));
    const pending = loadI18n({ signal: controller.signal, fetch: async (url, { signal }) => {
      signals.push(signal);
      const language = url.pathname.match(/(ko|en|ja)\.json$/)[1];
      const response = { ok: true, json: () => phase === 'body'
        ? new Promise(resolve => late.push(() => resolve(dictionaries[language]))) : dictionaries[language] };
      return phase === 'fetch' ? new Promise(resolve => late.push(() => resolve(response))) : response;
    } });
    const rejected = assert.rejects(pending, error => error.message === 'I18N_LOAD_FAILED' && !leaks(error));
    await tick();
    controller.abort(new Error('SECRET abort reason'));
    await rejected;
    assert.equal(signals.length, phase === 'before' ? 0 : 3);
    assert.ok(signals.every(signal => signal.aborted));
    for (const finish of late) finish();
    await tick();
  }
});

test('startup cancellation and body timeout leave no shell, registration, listeners or late mount', async () => {
  for (const reason of ['signal', 'pre-aborted', 'pagehide', 'timeout']) {
    const b = createBrowser({ hash: fragment() });
    const controller = new AbortController();
    const requests = [], late = [];
    b.win.fetch = async (url, { signal }) => {
      requests.push(signal);
      return { ok: true, json: () => new Promise(resolve => late.push(() =>
        resolve(dictionaries[url.pathname.match(/(ko|en|ja)\.json$/)[1]]))) };
    };
    if (reason === 'pre-aborted') controller.abort('SECRET');
    const pending = startApp({ window: b.win, signal: controller.signal });
    await tick();
    if (reason === 'signal') controller.abort('SECRET');
    if (reason === 'pagehide') b.win.dispatch('pagehide');
    if (reason === 'timeout') b.timers.run();
    assert.equal(await pending, null);
    assert.equal(b.root.textContent, dictionaries.en[reason === 'timeout' ? 'error.NETWORK_ERROR' : 'error.ABORTED']);
    assert.equal(b.win.location.hash, '');
    assert.ok(requests.every(signal => signal.aborted));
    assert.equal(b.win.listenerCount, 0);
    assert.equal(b.timers.pending.length, 0);
    for (const finish of late) finish();
    await tick();
    assert.equal(b.root.getAttribute('role'), 'alert');
    assert.equal(b.container.registrations.length, 0);
    assert.equal(b.audio.contexts.length, 0);
    assert.equal(b.gemini.calls.length, 0);
  }
});

test('offline dictionary miss shows fallback and a fresh start can recover; cached dictionaries still boot', async () => {
  const b = createBrowser();
  b.win.navigator.onLine = false;
  const cachedFetch = b.win.fetch;
  b.win.fetch = async () => { throw new Error('SECRET offline'); };
  assert.equal(await startApp({ window: b.win }), null);
  assert.equal(b.root.textContent, dictionaries.en['error.NETWORK_ERROR']);
  b.win.fetch = cachedFetch;
  const app = await startApp({ window: b.win });
  assert.ok(app, 'offline hint must not block cache-backed fetch');
  assert.equal(b.root.hasAttribute('role'), false);
  assert.equal(b.root.hasAttribute('lang'), false);
  assert.equal(app.i18n.language, 'ko');
  assert.equal(app.setLanguage('ja'), 'ja');
  assert.equal(app.i18n.t('common.start'), dictionaries.ja['common.start']);
  assert.equal(app.setLanguage('en'), 'en');
  assert.equal(app.i18n.t('common.start'), dictionaries.en['common.start']);
  await app.close();
});


test('P3-40 direct permission denial is requested once and reports the microphone reason', async t => {
  const b = await listeningApp(t);
  let calls = 0;
  b.win.navigator.mediaDevices.getUserMedia = async () => {
    calls++;
    throw Object.assign(new Error('private browser detail'), { name: 'NotAllowedError' });
  };
  const handle = b.app.listenEngines.direct.start({ targetLanguage: 'ja' });
  const result = await handle.done;
  assert.equal(result.errorCode, 'MICROPHONE_DENIED');
  assert.equal(calls, 1);
  assert.equal(b.sockets.length, 0);
  assert.equal(b.root.textContent.includes('private browser detail'), false);
});
