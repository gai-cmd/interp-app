import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { applyRelease, shellFor } from '../scripts/stage-release.mjs';
import { createI18n, SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { checkSource } from '../scripts/check-i18n.mjs';
import {
  INSTALL_KEYS, PWA_POLICY, UPDATE_KEYS, UPDATE_RESULT, VERSION_PATTERN, WORKER_SCOPE, WORKER_URL,
  createPwa, createPwaControls, installGuidanceKey, isIOS, isStandalone, versionOf,
} from '../app/pwa.js';

// P1-19 PWA policy: the page side of the P1-18 worker, exercised without a
// browser. Workers are the real sw.js evaluated in a vm sandbox (as in
// tests/sw.test.mjs) so the message protocol is the shipped one; navigator,
// window, registration and MessageChannel are fakes.

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const dictionaries = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async (language) =>
  [language, JSON.parse(await read(`app/i18n/${language}.json`))])));
const swSource = await read('sw.js');
const SCOPE = 'https://app.example.test/';
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition, limit = 200) {
  for (let i = 0; i < limit && !condition(); i++) await tick();
  assert.ok(condition(), 'condition not reached');
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
class Emitter {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatch(type, init = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    return event;
  }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
// MessageChannel double: port messages are delivered asynchronously as clones.
class FakePort {
  constructor() { this.onmessage = null; this.peer = null; this.closed = false; }
  postMessage(message) {
    const data = structuredClone(message);
    const peer = this.peer;
    queueMicrotask(() => { if (peer && !peer.closed) peer.onmessage?.({ data }); });
  }
  close() { this.closed = true; }
}
class FakeMessageChannel {
  constructor() { this.port1 = new FakePort(); this.port2 = new FakePort(); this.port1.peer = this.port2; this.port2.peer = this.port1; }
}

// A worker running the real sw.js with `clients` window clients.
function createWorker({ id = 'r-1', clients = 1, state = 'activated' } = {}) {
  const listeners = new Map();
  const calls = { skipWaiting: 0, claim: 0, matchAll: [] };
  const sandbox = {
    URL, caches: { async open() { return { async put() {}, async match() {} }; }, async keys() { return []; }, async delete() { return true; } },
    registration: { scope: SCOPE },
    clients: { async claim() { calls.claim += 1; }, async matchAll(options) { calls.matchAll.push(structuredClone(options)); return Array.from({ length: clients }, () => ({})); } },
    async skipWaiting() { calls.skipWaiting += 1; },
    async fetch() { return new Response('', { status: 200 }); },
    addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
  };
  sandbox.self = sandbox;
  new vm.Script(applyRelease(swSource, { id, shell: shellFor(id, ['styles.css', 'app/main.js']) }), { filename: 'sw.js' })
    .runInContext(vm.createContext(sandbox));
  const worker = new Emitter();
  worker.state = state;
  worker.calls = calls;
  worker.received = [];
  worker.postMessage = (message, transfer = []) => {
    worker.received.push(structuredClone(message));
    const event = { data: structuredClone(message), ports: transfer, source: null, waitUntil() {} };
    for (const listener of listeners.get('message') ?? []) listener(event);
  };
  worker.setState = (next) => { worker.state = next; worker.dispatch('statechange'); };
  return worker;
}
function createRegistration({ waiting = null, installing = null, active = null } = {}) {
  const registration = new Emitter();
  Object.assign(registration, { scope: SCOPE, waiting, installing, active });
  return registration;
}
function createEnvironment({ controller = null, registration = createRegistration(), registerError = null, serviceWorker = true,
  secure = true, standalone = false, userAgent = 'Mozilla/5.0 (Linux; Android 14) Chrome/128', busy = false, autoApply = false } = {}) {
  const timers = fakeTimers();
  const container = new Emitter();
  container.controller = controller;
  container.registrations = [];
  container.register = async (url, options) => {
    container.registrations.push({ url, options: structuredClone(options) });
    if (registerError) throw registerError;
    return registration;
  };
  const win = new Emitter();
  win.isSecureContext = secure;
  win.MessageChannel = FakeMessageChannel;
  win.matchMedia = (query) => ({ matches: standalone && query === '(display-mode: standalone)' });
  win.location = { reloads: 0, reload() { this.reloads += 1; } };
  win.navigator = { userAgent, onLine: true, ...(serviceWorker ? { serviceWorker: container } : {}) };
  const env = { win, container, registration, timers, busy };
  env.pwa = createPwa({ window: win, isBusy: () => env.busy, autoApply, ...timers });
  return env;
}

test('pwa.js uses existing dictionary keys only, never logs or renders markup', async () => {
  const source = await read('app/pwa.js');
  assert.deepEqual(checkSource(source, dictionaries.en), []);
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|innerText|createContextualFragment/.test(source), false);
  assert.equal(/\bDOMParser\b|document\.write|\beval\(|console\.|skipWaiting|clients\.claim/.test(source), false);
  const keyPattern = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
  const literals = [...source.matchAll(/(['"`])([^'"`\r\n]+)\1/g)].map((match) => match[2]).filter((value) => keyPattern.test(value));
  assert.ok(literals.length > 0);
  for (const key of literals) assert.ok(Object.hasOwn(dictionaries.en, key), key);
  for (const key of [...Object.values(INSTALL_KEYS), ...Object.values(UPDATE_KEYS)]) assert.ok(Object.hasOwn(dictionaries.en, key), key);
  assert.equal(WORKER_URL, './sw.js');
  assert.equal(WORKER_SCOPE, './');
  assert.equal(PWA_POLICY.maxClientsForUpdate, 1);
  // Version strings follow the release id pattern the settings view accepts.
  assert.equal(versionOf({ type: 'interp:release', release: 'r-2026-09-05' }), 'r-2026-09-05');
  assert.equal(versionOf({ type: 'interp:release', release: '../x' }), null);
  assert.equal(versionOf({ type: 'interp:release', release: 'a'.repeat(41) }), null);
  assert.equal(versionOf({ type: 'other', release: 'r-1' }), null);
  assert.equal(versionOf(null), null);
  assert.ok(VERSION_PATTERN.test('dev'));
});

test('install guidance: installed, prompt, iOS manual steps, browser menu, unavailable', () => {
  assert.equal(installGuidanceKey({ standalone: true, installAvailable: true }), 'pwa.installed');
  assert.equal(installGuidanceKey({ installed: true, ios: true }), 'pwa.installed');
  assert.equal(installGuidanceKey({ installAvailable: true, ios: true, supported: true }), 'pwa.install');
  assert.equal(installGuidanceKey({ ios: true, supported: true }), 'pwa.iosInstall');
  assert.equal(installGuidanceKey({ ios: true, supported: false }), 'pwa.iosInstall');
  assert.equal(installGuidanceKey({ supported: true }), 'pwa.browserInstall');
  assert.equal(installGuidanceKey({ supported: false }), 'pwa.installUnavailable');
  assert.equal(installGuidanceKey(), 'pwa.installUnavailable');
  assert.equal(isIOS({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1' }), true);
  assert.equal(isIOS({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 }), true);
  assert.equal(isIOS({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 }), false);
  assert.equal(isIOS({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/128' }), false);
  assert.equal(isIOS({}), false);
  assert.equal(isStandalone({ navigator: { standalone: true } }), true);
  assert.equal(isStandalone({ matchMedia: (query) => ({ matches: query === '(display-mode: standalone)' }), navigator: {} }), true);
  assert.equal(isStandalone({ matchMedia: () => ({ matches: false }), navigator: {} }), false);
  assert.equal(isStandalone({ matchMedia: () => { throw new Error('SECRET'); }, navigator: {} }), false);
  assert.equal(isStandalone({}), false);
});

test('registers ./sw.js at the root scope, reads the version from the controller and detects a waiting worker', async () => {
  const controller = createWorker({ id: 'r-1' });
  const waiting = createWorker({ id: 'r-2', state: 'installed' });
  const env = createEnvironment({ controller, registration: createRegistration({ waiting, active: controller }) });
  const events = [];
  env.pwa.subscribe((snapshot) => events.push(snapshot));
  assert.equal(env.pwa.supported, true);
  assert.deepEqual(env.pwa.snapshot(), { supported: true, registered: false, standalone: false, ios: false, installAvailable: false,
    installed: false, updateAvailable: false, version: null, applying: false, reloadPending: false, autoApply: false });
  assert.equal(await env.pwa.getVersion(), 'r-1');
  assert.deepEqual(controller.received, [{ type: 'interp:get-release' }]);
  assert.equal(env.pwa.snapshot().version, 'r-1');
  const registration = await env.pwa.register();
  assert.equal(registration, env.registration);
  assert.deepEqual(env.container.registrations, [{ url: './sw.js', options: { scope: './', updateViaCache: 'none' } }]);
  assert.equal(env.pwa.snapshot().registered, true);
  assert.equal(env.pwa.snapshot().updateAvailable, true);
  assert.ok(events.some((snapshot) => snapshot.updateAvailable));
  // The waiting worker counts every window of the scope, uncontrolled included.
  assert.equal(await env.pwa.countClients(), 1);
  assert.deepEqual(waiting.calls.matchAll, [{ type: 'window', includeUncontrolled: true }]);
  env.pwa.close();
  assert.equal(env.container.listenerCount + env.win.listenerCount + env.registration.listenerCount, 0);
});

test('updatefound -> installed beside a controller announces an update; a first install does not', async () => {
  const controller = createWorker({ id: 'r-1' });
  const env = createEnvironment({ controller, registration: createRegistration({ active: controller }) });
  await env.pwa.register();
  assert.equal(env.pwa.snapshot().updateAvailable, false);
  const installing = createWorker({ id: 'r-2', state: 'installing' });
  env.registration.installing = installing;
  env.registration.dispatch('updatefound');
  assert.equal(env.pwa.snapshot().updateAvailable, false);
  installing.setState('installed');
  assert.equal(env.pwa.snapshot().updateAvailable, true);
  // A worker that becomes redundant (e.g. replaced) withdraws the update.
  installing.setState('redundant');
  assert.equal(env.pwa.snapshot().updateAvailable, false);
  assert.equal(installing.listenerCount, 0);
  env.pwa.close();

  // Without a controller the new worker is the first install, not an update.
  const first = createEnvironment({ registration: createRegistration() });
  await first.pwa.register();
  const worker = createWorker({ id: 'r-1', state: 'installing' });
  first.registration.installing = worker;
  first.registration.dispatch('updatefound');
  worker.setState('installed');
  assert.equal(first.pwa.snapshot().updateAvailable, false);
  worker.setState('activated');
  assert.equal(first.pwa.snapshot().updateAvailable, false);
  first.pwa.close();
});

test('update applies only when idle and alone: busy -> active, other tabs -> deferred, then skipWaiting and reload', async () => {
  const controller = createWorker({ id: 'r-1' });
  const waiting = createWorker({ id: 'r-2', state: 'installed', clients: 2 });
  const env = createEnvironment({ controller, registration: createRegistration({ waiting, active: controller }), busy: true });
  assert.deepEqual(await env.pwa.applyUpdate(), { result: UPDATE_RESULT.NONE }, 'nothing waiting before registration');
  await env.pwa.register();
  assert.deepEqual(await env.pwa.applyUpdate(), { result: UPDATE_RESULT.ACTIVE });
  assert.equal(waiting.received.length, 0, 'no message while interpreting');
  env.busy = false;
  assert.deepEqual(await env.pwa.applyUpdate(), { result: UPDATE_RESULT.OTHER_TABS, count: 2 });
  assert.deepEqual(waiting.received, [{ type: 'interp:count-clients' }]);
  assert.equal(waiting.calls.skipWaiting, 0);
  assert.equal(env.pwa.snapshot().updateAvailable, true, 'the update stays pending');
  assert.equal(env.win.location.reloads, 0);

  // Alone: the worker skips waiting; the controller change reloads once.
  const alone = createWorker({ id: 'r-3', state: 'installed', clients: 1 });
  const again = createEnvironment({ controller, registration: createRegistration({ waiting: alone, active: controller }) });
  await again.pwa.register();
  const states = [];
  again.pwa.subscribe((snapshot) => states.push(snapshot.applying));
  assert.deepEqual(await again.pwa.applyUpdate(), { result: UPDATE_RESULT.APPLIED, release: 'r-3' });
  assert.deepEqual(states, [true, false]);
  assert.deepEqual(alone.received.map((message) => message.type), ['interp:count-clients', 'interp:apply-update']);
  assert.equal(alone.calls.skipWaiting, 1);
  assert.equal(again.win.location.reloads, 0, 'reload waits for controllerchange');
  again.busy = true;
  again.container.dispatch('controllerchange');
  assert.equal(again.win.location.reloads, 1, 'a requested update reloads even mid-gesture');
  again.container.dispatch('controllerchange');
  assert.equal(again.win.location.reloads, 1, 'reload happens once');
  env.pwa.close();
  again.pwa.close();
});

// Owner (2026-09-07): the app opts into autoApply so a visitor is on the current
// release without pressing anything; the refusals of the button path still hold.
test('autoApply: a waiting worker applies itself when idle and alone, waits for a busy page or other tabs, and re-checks on visibility', async () => {
  const controller = createWorker({ id: 'r-1' });
  const alone = createWorker({ id: 'r-2', state: 'installed', clients: 1 });
  const registration = createRegistration({ waiting: alone, active: controller });
  let updates = 0; registration.update = async () => { updates += 1; };
  const env = createEnvironment({ controller, registration, autoApply: true });
  env.win.document = Object.assign(new Emitter(), { hidden: false });
  assert.equal(env.pwa.snapshot().autoApply, true);
  await env.pwa.register();
  assert.equal(updates, 1, 'registration asks the browser for a fresh worker');
  await tick();
  assert.deepEqual(alone.received.map((message) => message.type), ['interp:count-clients', 'interp:apply-update'], 'no button press needed');
  assert.equal(alone.calls.skipWaiting, 1);
  env.container.dispatch('controllerchange');
  assert.equal(env.win.location.reloads, 1);
  env.win.document.dispatch('visibilitychange');
  assert.equal(updates, 2, 'coming back into view checks again');
  env.pwa.close();

  // Busy: nothing is sent; the idle signal (reloadIfPending) applies it later.
  const later = createWorker({ id: 'r-3', state: 'installed', clients: 1 });
  const busy = createEnvironment({ controller, registration: createRegistration({ waiting: later, active: controller }), busy: true, autoApply: true });
  await busy.pwa.register();
  await tick();
  assert.equal(later.received.length, 0, 'a running interpretation is never interrupted');
  busy.busy = false;
  busy.pwa.reloadIfPending();
  await tick();
  assert.deepEqual(later.received.map((message) => message.type), ['interp:count-clients', 'interp:apply-update']);
  busy.pwa.close();

  // Other tabs: deferred and retried on the timer, not forced.
  const crowded = createWorker({ id: 'r-4', state: 'installed', clients: 2 });
  const tabs = createEnvironment({ controller, registration: createRegistration({ waiting: crowded, active: controller }), autoApply: true });
  await tabs.pwa.register();
  await tick();
  assert.deepEqual(crowded.received.map((message) => message.type), ['interp:count-clients']);
  assert.equal(crowded.calls.skipWaiting, 0);
  assert.equal(tabs.pwa.snapshot().updateAvailable, true, 'the update stays pending for the button or the next attempt');
  assert.ok(tabs.timers.pending.some((timer) => timer.ms === PWA_POLICY.autoRetryMs), 'a retry is scheduled');
  tabs.pwa.close();
  assert.equal(tabs.timers.pending.length, 0, 'close cancels the retry');

  // Off by default: the library does nothing on its own.
  const quiet = createWorker({ id: 'r-5', state: 'installed', clients: 1 });
  const off = createEnvironment({ controller, registration: createRegistration({ waiting: quiet, active: controller }) });
  await off.pwa.register();
  await tick();
  assert.equal(quiet.received.length, 0);
  off.pwa.close();
});

test('a controller change this page did not request reloads only when idle; reloadIfPending completes it later', async () => {
  const controller = createWorker({ id: 'r-1' });
  const env = createEnvironment({ controller, registration: createRegistration({ active: controller }), busy: true });
  await env.pwa.register();
  env.container.dispatch('controllerchange');
  assert.equal(env.win.location.reloads, 0);
  assert.equal(env.pwa.snapshot().reloadPending, true);
  assert.equal(env.pwa.reloadIfPending(), false, 'still busy');
  env.busy = false;
  assert.equal(env.pwa.reloadIfPending(), true);
  assert.equal(env.win.location.reloads, 1);
  assert.equal(env.pwa.snapshot().reloadPending, false);
  assert.equal(env.pwa.reloadIfPending(), false);
  env.pwa.close();

  const idle = createEnvironment({ controller, registration: createRegistration({ active: controller }) });
  await idle.pwa.register();
  idle.container.dispatch('controllerchange');
  assert.equal(idle.win.location.reloads, 1, 'idle pages follow the new worker at once');
  idle.pwa.close();
});

test('worker replies time out to null and never block: version, client count and apply degrade safely', async () => {
  const silent = new Emitter();
  silent.state = 'activated';
  silent.postMessage = () => {};
  const env = createEnvironment({ controller: silent, registration: createRegistration({ waiting: silent, active: silent }) });
  await env.pwa.register();
  const version = env.pwa.getVersion();
  const count = env.pwa.countClients();
  const apply = env.pwa.applyUpdate();
  await tick();
  assert.ok(env.timers.pending.length >= 2, 'reply timers armed');
  assert.ok(env.timers.pending.every((timer) => timer.ms === PWA_POLICY.replyTimeoutMs));
  env.timers.run();
  assert.equal(await version, null);
  assert.equal(await count, null);
  assert.deepEqual(await apply, { result: UPDATE_RESULT.OTHER_TABS, count: null }, 'unknown count never applies');
  assert.equal(env.win.location.reloads, 0);
  // A worker that throws on postMessage is also just "no reply".
  const throwing = new Emitter();
  throwing.state = 'activated';
  throwing.postMessage = () => { throw new Error('SECRET'); };
  const broken = createEnvironment({ controller: throwing, registration: createRegistration({ waiting: throwing }) });
  await broken.pwa.register();
  assert.equal(await broken.pwa.getVersion(), null);
  assert.deepEqual(await broken.pwa.applyUpdate(), { result: UPDATE_RESULT.OTHER_TABS, count: null });
  // A registration failure leaves the app running without a worker.
  const failing = createEnvironment({ registerError: new Error('SECRET register') });
  assert.equal(await failing.pwa.register(), null);
  assert.equal(failing.pwa.snapshot().registered, false);
  assert.deepEqual(await failing.pwa.applyUpdate(), { result: UPDATE_RESULT.NONE });
  env.pwa.close(); broken.pwa.close(); failing.pwa.close();
});

test('without service worker support (or an insecure context) nothing registers and the guidance says so', async () => {
  const none = createEnvironment({ serviceWorker: false });
  assert.equal(none.pwa.supported, false);
  assert.equal(await none.pwa.register(), null);
  assert.equal(await none.pwa.getVersion(), null);
  assert.equal(await none.pwa.countClients(), null);
  assert.deepEqual(await none.pwa.applyUpdate(), { result: UPDATE_RESULT.UNSUPPORTED });
  assert.equal(installGuidanceKey(none.pwa.snapshot()), 'pwa.installUnavailable');
  none.container.dispatch('controllerchange');
  assert.equal(none.win.location.reloads, 0);
  const insecure = createEnvironment({ secure: false });
  assert.equal(insecure.pwa.supported, false);
  assert.equal(insecure.container.registrations.length, 0);
  await insecure.pwa.register();
  assert.equal(insecure.container.registrations.length, 0);
  const ios = createEnvironment({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1' });
  assert.equal(installGuidanceKey(ios.pwa.snapshot()), 'pwa.iosInstall');
  const home = createEnvironment({ standalone: true });
  assert.equal(home.pwa.snapshot().standalone, true);
  assert.equal(installGuidanceKey(home.pwa.snapshot()), 'pwa.installed');
  for (const env of [none, insecure, ios, home]) env.pwa.close();
});

test('beforeinstallprompt is deferred into a button; promptInstall runs it once; appinstalled marks installed', async () => {
  const env = createEnvironment();
  assert.equal(await env.pwa.promptInstall(), null);
  let prompted = 0;
  const event = env.win.dispatch('beforeinstallprompt', { prompt: async () => { prompted += 1; }, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  assert.equal(event.defaultPrevented, true, 'the mini-infobar is suppressed');
  assert.equal(env.pwa.snapshot().installAvailable, true);
  assert.equal(installGuidanceKey(env.pwa.snapshot()), 'pwa.install');
  assert.equal(await env.pwa.promptInstall(), 'dismissed');
  assert.equal(prompted, 1);
  assert.equal(env.pwa.snapshot().installAvailable, false, 'a prompt event is single use');
  assert.equal(await env.pwa.promptInstall(), null);
  env.win.dispatch('beforeinstallprompt', { prompt: async () => { prompted += 1; }, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  assert.equal(await env.pwa.promptInstall(), 'accepted');
  assert.equal(env.pwa.snapshot().installed, true);
  assert.equal(installGuidanceKey(env.pwa.snapshot()), 'pwa.installed');
  const fresh = createEnvironment();
  fresh.win.dispatch('beforeinstallprompt', { prompt: async () => { throw new Error('SECRET'); }, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  assert.equal(await fresh.pwa.promptInstall(), null, 'prompt failures are swallowed');
  fresh.win.dispatch('appinstalled');
  assert.equal(fresh.pwa.snapshot().installed, true);
  assert.equal(fresh.pwa.snapshot().installAvailable, false);
  env.pwa.close(); fresh.pwa.close();
});

// Minimal DOM double for the settings-section controls (same surface as the
// P1-15/16 tests): innerHTML throws so markup rendering fails loudly.
class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null;
    this.attributes = new Map(); this.listeners = new Map(); this.classes = new Set();
    this.hidden = false; this.disabled = false; this.text = '';
  }
  get textContent() { return this.childNodes.length ? this.childNodes.map((child) => child.textContent).join('') : this.text; }
  set textContent(value) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; this.text = String(value ?? ''); }
  get innerHTML() { throw new Error('INNER_HTML_USED'); }
  set innerHTML(_value) { throw new Error('INNER_HTML_USED'); }
  set innerText(_value) { throw new Error('INNER_TEXT_USED'); }
  append(...nodes) { this.text = ''; for (const node of nodes) { node.remove(); node.parentNode = this; this.childNodes.push(node); } }
  remove() { if (!this.parentNode) return; this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this); this.parentNode = null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'class') this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatch(type, init = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    return event;
  }
}
function createDocument() {
  const doc = { title: '' };
  doc.createElement = (tag) => new FakeElement(doc, tag);
  return doc;
}
const all = (node, predicate, out = []) => {
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes) all(child, predicate, out);
  return out;
};
const byClass = (node, name) => all(node, (item) => item.classes.has(name))[0];
const visible = (node) => { for (let item = node; item; item = item.parentNode) if (item.hidden) return false; return true; };
function fakeShell() {
  const listeners = new Set();
  return { onLanguageChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    changed(language) { for (const listener of [...listeners]) listener(language); }, get count() { return listeners.size; } };
}

test('settings controls: guidance text, install button, update button and notices follow the policy', async () => {
  const controller = createWorker({ id: 'r-1' });
  const waiting = createWorker({ id: 'r-2', state: 'installed', clients: 3 });
  const env = createEnvironment({ controller, registration: createRegistration({ waiting, active: controller }), busy: true });
  const doc = createDocument();
  const root = doc.createElement('div');
  const i18n = createI18n({ dictionaries, language: 'ko' });
  const shell = fakeShell();
  const notices = [];
  const controls = createPwaControls({ root, document: doc, i18n, shell, pwa: env.pwa, notify: (key) => notices.push(key) });
  const hint = byClass(root, 'pwa-install-hint');
  const install = byClass(root, 'pwa-install');
  const update = byClass(root, 'pwa-update');
  const updateHint = byClass(root, 'pwa-update-hint');
  assert.equal(root.childNodes[0], controls.element);
  assert.equal(hint.textContent, dictionaries.ko['pwa.browserInstall']);
  assert.equal(hint.getAttribute('data-install'), 'browserInstall');
  assert.equal(visible(install), false);
  assert.equal(visible(update), false);
  assert.equal(visible(updateHint), false);
  assert.equal(install.textContent, dictionaries.ko['pwa.install']);
  assert.equal(update.textContent, dictionaries.ko['pwa.update']);
  assert.equal(updateHint.textContent, dictionaries.ko['pwa.updateAvailable']);

  // Language change re-applies every bound string.
  i18n.setLanguage('en');
  shell.changed('en');
  assert.equal(hint.textContent, dictionaries.en['pwa.browserInstall']);
  assert.equal(update.textContent, dictionaries.en['pwa.update']);

  // Install prompt available -> button; clicking runs the prompt.
  let prompted = 0;
  env.win.dispatch('beforeinstallprompt', { prompt: async () => { prompted += 1; }, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  assert.equal(visible(install), true);
  assert.equal(hint.textContent, dictionaries.en['pwa.install']);
  install.dispatch('click');
  await until(() => env.pwa.snapshot().installed);
  assert.equal(prompted, 1);
  assert.equal(visible(install), false);
  assert.equal(hint.textContent, dictionaries.en['pwa.installed']);

  // Update available -> button and hint; busy click -> "finish first" notice.
  await env.pwa.register();
  assert.equal(visible(update), true);
  assert.equal(visible(updateHint), true);
  update.dispatch('click');
  await until(() => notices.length === 1);
  assert.deepEqual(notices, [UPDATE_KEYS.active]);
  assert.equal(waiting.calls.skipWaiting, 0);
  // Idle but other tabs open -> guidance notice, update still pending.
  env.busy = false;
  update.dispatch('click');
  await until(() => notices.length === 2);
  assert.equal(notices[1], UPDATE_KEYS.otherTabs);
  assert.equal(waiting.calls.skipWaiting, 0);
  assert.equal(visible(update), true);
  assert.equal(update.disabled, false, 're-enabled after the deferred attempt');
  // Nothing in the DOM is a raw worker value or a secret.
  const text = all(root, () => true).map((node) => `${node.text}\n${[...node.attributes.values()].join('\n')}`).join('\n');
  assert.equal(/SECRET|interp:|r-2/.test(text), false);

  controls.destroy();
  assert.equal(root.childNodes.length, 0);
  assert.equal(shell.count, 0);
  env.win.dispatch('beforeinstallprompt', { prompt: async () => {}, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  assert.equal(visible(install), false, 'destroyed controls stop rendering');
  env.pwa.close();
  assert.throws(() => createPwaControls({ root, document: doc, i18n, shell }), /INVALID_REQUEST/);
  assert.throws(() => createPwa({}), /INVALID_REQUEST/);
});
