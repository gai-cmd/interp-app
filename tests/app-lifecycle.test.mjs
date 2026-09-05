import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { checkSource } from '../scripts/check-i18n.mjs';
import { TURN_PHASE } from '../app/state.js';
import {
  AUDIO_CONTEXT_OPTIONS, INSTALL_HINT_STORAGE_KEY, UI_LANGUAGE_STORAGE_KEY, applyManifestLanguage,
  autoStart, captureSharedFragment, readUiLanguage, startApp, usableStorage, writeUiLanguage,
} from '../app/main.js';
import { createSocketFixture } from './fixtures/live.mjs';
import { response as geminiResponse } from './fixtures/gemini.mjs';

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

// The fake browser. fetch serves app/i18n/*.json from disk and scripted
// Gemini responses; everything else is refused.
function createBrowser({ hash = '', storage: storageInit = {}, languages = ['ko-KR', 'en-US'], withStorage = true,
  controller = null, waiting = null, replaceStateError = null, clients = 1 } = {}) {
  const ops = [];
  const { doc, root, manifest } = createDocument();
  const timers = fakeTimers();
  const gemini = { calls: [], script: [] };
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
  win.location = { hash, pathname: '/', search: '', reloads: 0, reload() { this.reloads += 1; } };
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
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      ops.push('fetch:gemini');
      const call = { url, headers: { ...init.headers }, signal: init.signal, body: init.body };
      gemini.calls.push(call);
      const next = gemini.script.shift();
      return typeof next === 'function' ? next(call) : next ?? geminiResponse();
    }
    throw new Error('UNEXPECTED_FETCH');
  };
  return { win, doc, root, manifest, ops, timers, gemini, audio, container, registration, sockets,
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
  if (remember) el(browser, 'settings-remember').childNodes[0].checked = true;
  el(browser, 'settings-key-form').dispatch('submit');
  assert.equal(input.value, '', 'the field is emptied on save');
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
  assert.equal(b.storage.has('interp-app.personal-key.v1.gemini'), false, 'a session-only key leaves nothing behind');
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
