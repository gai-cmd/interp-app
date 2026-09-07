// Retirement worker for gai-cmd.github.io/interp-app (owner, 2026-09-07).
// The app moved to https://interp-app.vercel.app/. This worker replaces the
// app's worker on every installed copy: it activates at once, drops the old
// shell caches, and answers every navigation with a redirect to the new
// address, so an old home-screen icon lands on the current app instead of a
// key-less build. Release directories are left in place for any tab that is
// still open on them.
const NEW_ADDRESS = 'https://interp-app.vercel.app/';
self.addEventListener('install', (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) { try { await caches.delete(name); } catch {} }
    await self.clients.claim();
    for (const client of await self.clients.matchAll({ type: 'window' })) { try { await client.navigate(client.url); } catch {} }
  })());
});
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    const url = new URL(event.request.url);
    event.respondWith(Response.redirect(`${NEW_ADDRESS}${url.search}${url.hash}`, 302));
  }
});
// Old pages ask this worker for its release id; answer so their update flow settles.
self.addEventListener('message', (event) => {
  const port = event.ports?.[0] ?? event.source;
  if (event.data?.type === 'interp:get-release') port?.postMessage?.({ type: 'interp:release', release: 'retired-20260907' });
  else if (event.data?.type === 'interp:count-clients') port?.postMessage?.({ type: 'interp:clients', count: 1 });
  else if (event.data?.type === 'interp:apply-update') port?.postMessage?.({ type: 'interp:updating', release: 'retired-20260907' });
});
