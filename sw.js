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
// - Activate preserves older release caches: an older tab may still need
//   them. Retention/garbage collection needs a separate release policy.
//
// Message protocol (page -> worker; replies go to event.ports[0] when a
// MessageChannel port is supplied, else to event.source):
//   { type: 'interp:get-release' }   -> { type: 'interp:release', release }
//   { type: 'interp:count-clients' } -> { type: 'interp:clients', count }
//   { type: 'interp:apply-update' }  -> { type: 'interp:updating', release }
//                                       then skipWaiting(); claim on activate
// Unknown messages are ignored. Nothing is logged.

const RELEASE = {"id":"p1-20260905","shell":["./","./manifest.ko.webmanifest","./manifest.en.webmanifest","./manifest.ja.webmanifest","./icons/icon-192.png","./icons/icon-512.png","./releases/p1-20260905/styles.css","./releases/p1-20260905/app/audio/capture-worklet.js","./releases/p1-20260905/app/audio/capture.js","./releases/p1-20260905/app/audio/device-tts.js","./releases/p1-20260905/app/audio/pcm-player.js","./releases/p1-20260905/app/audio/resampler.js","./releases/p1-20260905/app/audio/wav.js","./releases/p1-20260905/app/config.js","./releases/p1-20260905/app/engine/diagnostics.js","./releases/p1-20260905/app/engine/output-validator.js","./releases/p1-20260905/app/engine/retry.js","./releases/p1-20260905/app/engine/seq.js","./releases/p1-20260905/app/engine/session-manager.js","./releases/p1-20260905/app/engine/voice.js","./releases/p1-20260905/app/i18n/en.json","./releases/p1-20260905/app/i18n/index.js","./releases/p1-20260905/app/i18n/ja.json","./releases/p1-20260905/app/i18n/ko.json","./releases/p1-20260905/app/main.js","./releases/p1-20260905/app/platform.js","./releases/p1-20260905/app/providers/contract.js","./releases/p1-20260905/app/providers/gemini/config.js","./releases/p1-20260905/app/providers/gemini/errors.js","./releases/p1-20260905/app/providers/gemini/index.js","./releases/p1-20260905/app/providers/gemini/live-client.js","./releases/p1-20260905/app/providers/gemini/prompts.js","./releases/p1-20260905/app/providers/gemini/rest.js","./releases/p1-20260905/app/providers/gemini/stt.js","./releases/p1-20260905/app/providers/gemini/translate.js","./releases/p1-20260905/app/providers/gemini/voice.js","./releases/p1-20260905/app/providers/registry.js","./releases/p1-20260905/app/providers/router.js","./releases/p1-20260905/app/pwa.js","./releases/p1-20260905/app/security/bootstrap.js","./releases/p1-20260905/app/security/key-store.js","./releases/p1-20260905/app/security/redact.js","./releases/p1-20260905/app/security/shared-key.js","./releases/p1-20260905/app/state.js","./releases/p1-20260905/app/ui/diagnostics-view.js","./releases/p1-20260905/app/ui/errors.js","./releases/p1-20260905/app/ui/seq-view.js","./releases/p1-20260905/app/ui/settings-view.js","./releases/p1-20260905/app/ui/shell.js"]}; // @release

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
    const skipping = self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      // A tab may have opened since the page's earlier count request.
      if (clients.length !== 1) { reply({ type: 'interp:update-deferred' }); return; }
      applyRequested = true;
      reply({ type: 'interp:updating', release: RELEASE.id });
      await self.skipWaiting();
    }).catch(() => reply({ type: 'interp:update-deferred' }));
    if (typeof event.waitUntil === 'function') event.waitUntil(skipping);
  }
});
