import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { applyRelease, readRelease, shellFor } from '../scripts/stage-release.mjs';

// P1-18 service worker: sw.js is evaluated inside a vm sandbox that fakes the
// ServiceWorkerGlobalScope surface it touches (registration, caches, clients,
// fetch, skipWaiting, addEventListener). No browser, no network.

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://app.example.test/';
const ID = 'r-2026-09-05';
const VERSIONED = ['styles.css', 'app/main.js', 'app/i18n/ko.json', 'app/audio/capture-worklet.js'];
const RELEASE = { id: ID, shell: shellFor(ID, VERSIONED) };
const CACHE = `interp-shell-${ID}`;
const API = 'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=TEST_SECRET';

class FakeCache {
  #store = new Map();
  async put(key, response) { this.#store.set(String(key), response); }
  async match(key) { const hit = this.#store.get(String(key)); return hit ? hit.clone() : undefined; }
  async delete(key) { return this.#store.delete(String(key)); }
  async keys() { return [...this.#store.keys()]; }
}

class FakeCacheStorage {
  caches = new Map();
  async open(name) { if (!this.caches.has(name)) this.caches.set(name, new FakeCache()); return this.caches.get(name); }
  async keys() { return [...this.caches.keys()]; }
  async delete(name) { return this.caches.delete(name); }
  async has(name) { return this.caches.has(name); }
}

function createWorker({ release = RELEASE, respond, clients = [] } = {}) {
  const listeners = new Map();
  const fetches = [];
  const calls = { skipWaiting: 0, claim: 0, matchAll: [] };
  const caches = new FakeCacheStorage();
  const reply = respond ?? ((url) => new Response(`body:${url}`, { status: 200 }));
  const sandbox = {
    URL,
    caches,
    registration: { scope: SCOPE },
    clients: {
      async claim() { calls.claim += 1; },
      async matchAll(options) { calls.matchAll.push(structuredClone(options)); return clients; },
    },
    async skipWaiting() { calls.skipWaiting += 1; },
    async fetch(input, init) {
      const url = typeof input === 'string' ? input : input.url;
      fetches.push({ url, init });
      return reply(url, init);
    },
    addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
  };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  new vm.Script(release ? applyRelease(source, release) : source, { filename: 'sw.js' }).runInContext(context);
  async function dispatch(type, fields = {}) {
    const pending = [];
    let responded;
    let handled = false;
    const event = {
      type, ...fields,
      waitUntil(promise) { pending.push(promise); },
      respondWith(promise) { handled = true; responded = promise; },
    };
    for (const listener of listeners.get(type) ?? []) listener(event);
    await Promise.all(pending);
    return { handled, response: handled ? await responded : undefined };
  }
  // Fakes post messages with structuredClone like real postMessage, so
  // assertions compare values rather than cross-realm prototypes.
  const request = (url, fields = {}) => ({ url, method: 'GET', mode: 'no-cors', ...fields });
  return { dispatch, caches, fetches, calls, listeners, request };
}

async function cachedKeys(worker) {
  const cache = worker.caches.caches.get(CACHE);
  return cache ? (await cache.keys()).sort() : [];
}

test('registers the four handlers and never skips waiting or claims on its own', async () => {
  const worker = createWorker();
  assert.deepEqual([...worker.listeners.keys()].sort(), ['activate', 'fetch', 'install', 'message']);
  await worker.dispatch('install');
  await worker.dispatch('activate');
  assert.equal(worker.calls.skipWaiting, 0);
  assert.equal(worker.calls.claim, 0);
});

test('install precaches the complete shell with cache: reload under a release-tagged cache', async () => {
  const worker = createWorker();
  await worker.dispatch('install');
  const expected = RELEASE.shell.map((path) => new URL(path, SCOPE).href).sort();
  assert.deepEqual(await cachedKeys(worker), expected);
  assert.deepEqual([...worker.caches.caches.keys()], [CACHE]);
  assert.equal(worker.fetches.length, expected.length);
  for (const { url, init } of worker.fetches) {
    assert.ok(expected.includes(url), url);
    assert.equal(init.cache, 'reload');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'same-origin');
  }
  assert.ok(expected.includes(SCOPE), 'the root entry is part of the shell');
  assert.ok(!expected.some((url) => url.endsWith('/sw.js') || url.includes('release.json') || url.endsWith('/_headers')));
});

test('install fails and removes the partial cache when any shell file is missing, failing or redirected', async () => {
  const failing = [
    (url) => (url.endsWith('/app/main.js') ? new Response('', { status: 404 }) : new Response('ok')),
    (url) => { if (url.endsWith('/styles.css')) throw new TypeError('network'); return new Response('ok'); },
    (url) => {
      const response = new Response('ok');
      if (url === SCOPE) Object.defineProperty(response, 'redirected', { value: true });
      return response;
    },
  ];
  for (const respond of failing) {
    const worker = createWorker({ respond });
    await assert.rejects(worker.dispatch('install'));
    assert.equal(await worker.caches.has(CACHE), false);
    assert.equal(worker.calls.skipWaiting, 0);
  }
});

test('fetch serves shell files cache-first, maps navigation to the cached root and ignores everything else', async () => {
  const worker = createWorker();
  await worker.dispatch('install');
  worker.fetches.length = 0;
  const shellUrl = `${SCOPE}releases/${ID}/app/main.js`;
  const hit = await worker.dispatch('fetch', { request: worker.request(`${shellUrl}?v=2#x`) });
  assert.equal(hit.handled, true);
  assert.equal(await hit.response.text(), `body:${shellUrl}`);
  for (const url of [SCOPE, `${SCOPE}index.html`, `${SCOPE}?utm=1`]) {
    const navigation = await worker.dispatch('fetch', { request: worker.request(url, { mode: 'navigate' }) });
    assert.equal(navigation.handled, true, url);
    assert.equal(await navigation.response.text(), `body:${SCOPE}`, url);
  }
  assert.equal(worker.fetches.length, 0, 'served from cache without touching the network');
  const passthrough = [
    worker.request(API),
    worker.request('https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'),
    worker.request('https://cdn.example.test/lib.js'),
    worker.request(`${SCOPE}releases/${ID}/release.json`),
    worker.request(`${SCOPE}releases/other/app/main.js`),
    worker.request(`${SCOPE}sw.js`),
    worker.request(`${SCOPE}api/records`),
    worker.request(`${SCOPE}index.html`, { mode: 'no-cors' }),
    worker.request(shellUrl, { method: 'POST' }),
    worker.request('blob:https://app.example.test/1234'),
    worker.request('data:text/plain,hello'),
    worker.request('not a url'),
  ];
  for (const request of passthrough) {
    const result = await worker.dispatch('fetch', { request });
    assert.equal(result.handled, false, request.url);
  }
  assert.equal(worker.fetches.length, 0);
  assert.deepEqual(await cachedKeys(worker), RELEASE.shell.map((path) => new URL(path, SCOPE).href).sort(), 'nothing new was cached');
});

test('an evicted shell entry falls back to the network without being re-cached', async () => {
  const worker = createWorker();
  await worker.dispatch('install');
  const cache = await worker.caches.open(CACHE);
  const url = `${SCOPE}releases/${ID}/styles.css`;
  await cache.delete(url);
  worker.fetches.length = 0;
  const request = worker.request(url);
  const result = await worker.dispatch('fetch', { request });
  assert.equal(result.handled, true);
  assert.equal(await result.response.text(), `body:${url}`);
  assert.equal(worker.fetches.length, 1);
  assert.equal(worker.fetches[0].url, url);
  assert.equal(await cache.match(url), undefined);
});

test('activate deletes other shell caches only and claims clients only after an explicit update request', async () => {
  const worker = createWorker();
  await worker.caches.open('interp-shell-old-1');
  await worker.caches.open('interp-shell-old-2');
  await worker.caches.open('records-p3');
  await worker.dispatch('install');
  await worker.dispatch('activate');
  assert.deepEqual((await worker.caches.keys()).sort(), [CACHE, 'records-p3']);
  assert.equal(worker.calls.claim, 0);

  const updating = createWorker({ clients: [{}, {}] });
  await updating.dispatch('install');
  const port = { messages: [], postMessage(message) { this.messages.push(structuredClone(message)); } };
  await updating.dispatch('message', { data: { type: 'interp:apply-update' }, ports: [port], source: null });
  assert.equal(updating.calls.skipWaiting, 1);
  assert.deepEqual(port.messages, [{ type: 'interp:updating', release: ID }]);
  await updating.dispatch('activate');
  assert.equal(updating.calls.claim, 1);
});

test('message protocol answers release and client-count queries and ignores anything else', async () => {
  const worker = createWorker({ clients: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  const source = { messages: [], postMessage(message) { this.messages.push(structuredClone(message)); } };
  await worker.dispatch('message', { data: { type: 'interp:get-release' }, ports: [], source });
  assert.deepEqual(source.messages, [{ type: 'interp:release', release: ID }]);
  const port = { messages: [], postMessage(message) { this.messages.push(structuredClone(message)); } };
  await worker.dispatch('message', { data: { type: 'interp:count-clients' }, ports: [port], source });
  assert.deepEqual(port.messages, [{ type: 'interp:clients', count: 3 }]);
  assert.deepEqual(worker.calls.matchAll, [{ type: 'window', includeUncontrolled: true }]);
  for (const data of [undefined, null, 'interp:apply-update', { type: 'skipWaiting' }, { type: 42 }, {}]) {
    await worker.dispatch('message', { data, ports: [port], source });
  }
  assert.equal(port.messages.length, 1);
  assert.equal(source.messages.length, 1);
  assert.equal(worker.calls.skipWaiting, 0);
  assert.equal(worker.calls.claim, 0);
});

test('the repository copy is the inert dev release and contains no logging, eval or automatic activation', async () => {
  assert.deepEqual(readRelease(source), { id: 'dev', shell: [] });
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /console\.|importScripts|\beval\(|new Function|XMLHttpRequest/);
  assert.equal(code.match(/skipWaiting\(/g)?.length, 1, 'skipWaiting is called in exactly one place');
  assert.equal(code.match(/clients\.claim\(/g)?.length, 1, 'claim is called in exactly one place');
  assert.doesNotMatch(code, /cache\.addAll|cache\.add\(/, 'writes go through the checked put path');
  const worker = createWorker({ release: null });
  await worker.dispatch('install');
  await worker.dispatch('activate');
  assert.equal(worker.fetches.length, 0);
  const result = await worker.dispatch('fetch', { request: worker.request(`${SCOPE}app/main.js`) });
  assert.equal(result.handled, false);
  assert.equal(worker.calls.skipWaiting + worker.calls.claim, 0);
});
