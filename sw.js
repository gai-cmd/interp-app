// Service worker for the static app shell (design-v0.6 §11.2, §13.2).
// New implementation; nothing is ported from interp-web or jp-patch.
//
// The file is served from the deploy root next to index.html. The repository
// copy carries the "dev" release with an empty shell, so the development
// server (scripts/serve.mjs) behaves like a plain page: nothing is cached and
// every request goes to the network. scripts/stage-release.mjs rewrites the
// RELEASE line below with the release id and the complete shell list; the
// browser then sees a new worker whenever a release is staged.
//
// Policy:
// - Install fetches every shell file with cache: 'reload' and stores it in a
//   cache named after the release. One failure fails the whole install and
//   removes the partial cache, so a worker never activates with a mixed or
//   incomplete shell.
// - Fetch serves shell files cache-first. Anything else (provider REST, Live
//   WebSocket handshakes, cross-origin, non-GET, blob/data URLs, unknown
//   paths) is left to the browser and never cached.
// - No automatic skipWaiting() or clients.claim(). The page decides when an
//   update may apply (after interpretation ends and no other tab is open,
//   P1-19) and posts 'interp:apply-update'; only then does the worker skip
//   waiting and claim its clients on activate.
// - Activate deletes caches of other releases with the same prefix and
//   leaves every other cache alone.
//
// Message protocol (page -> worker; replies go to event.ports[0] when a
// MessageChannel port is supplied, else to event.source):
//   { type: 'interp:get-release' }   -> { type: 'interp:release', release }
//   { type: 'interp:count-clients' } -> { type: 'interp:clients', count }
//   { type: 'interp:apply-update' }  -> { type: 'interp:updating', release }
//                                       then skipWaiting(); claim on activate
// Unknown messages are ignored. Nothing is logged.

const RELEASE = {"id":"dev","shell":[]}; // @release

const CACHE_PREFIX = 'interp-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${RELEASE.id}`;
const SCOPE = self.registration.scope;
const ORIGIN = new URL(SCOPE).origin;

// Cache keys are absolute URLs without query or fragment so that
// "app/main.js?v=1" and "app/main.js" resolve to the same shell entry.
function keyOf(url) {
  const resolved = new URL(url, SCOPE);
  resolved.search = '';
  resolved.hash = '';
  return resolved.href;
}

const SHELL = new Set(RELEASE.shell.map((path) => keyOf(path)));
const ROOT_KEY = keyOf('./');

let applyRequested = false;

async function precache() {
  const cache = await self.caches.open(CACHE_NAME);
  try {
    await Promise.all([...SHELL].map(async (key) => {
      const response = await self.fetch(key, { cache: 'reload', credentials: 'same-origin', redirect: 'error' });
      if (!response || !response.ok || response.redirected) throw new Error('SHELL_FETCH_FAILED');
      await cache.put(key, response);
    }));
  } catch (error) {
    // An incomplete shell must not survive; the browser then keeps the
    // previous worker (or none) instead of a half-installed release.
    await self.caches.delete(CACHE_NAME);
    throw error;
  }
}

async function fromShell(key, request) {
  const cache = await self.caches.open(CACHE_NAME);
  const cached = await cache.match(key);
  // A missing entry (storage eviction) falls through to the network without
  // being re-cached: the install step is the only writer of the shell cache.
  return cached ?? self.fetch(request);
}

async function cleanup() {
  const names = await self.caches.keys();
  await Promise.all(names
    .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
    .map((name) => self.caches.delete(name)));
  if (applyRequested) await self.clients.claim();
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(cleanup());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!request || request.method !== 'GET') return;
  let key;
  try { key = keyOf(request.url); } catch { return; }
  if (!key.startsWith(ORIGIN)) return;
  if (request.mode === 'navigate' && key === `${ROOT_KEY}index.html`) key = ROOT_KEY;
  if (!SHELL.has(key)) return;
  event.respondWith(fromShell(key, request));
});

self.addEventListener('message', (event) => {
  const type = event.data?.type;
  if (typeof type !== 'string') return;
  const target = event.ports?.[0] ?? event.source;
  const reply = (message) => { if (target && typeof target.postMessage === 'function') target.postMessage(message); };
  if (type === 'interp:get-release') {
    reply({ type: 'interp:release', release: RELEASE.id });
  } else if (type === 'interp:count-clients') {
    const counting = self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => reply({ type: 'interp:clients', count: clients.length }));
    if (typeof event.waitUntil === 'function') event.waitUntil(counting);
  } else if (type === 'interp:apply-update') {
    applyRequested = true;
    reply({ type: 'interp:updating', release: RELEASE.id });
    const skipping = self.skipWaiting();
    if (typeof event.waitUntil === 'function') event.waitUntil(skipping);
  }
});
