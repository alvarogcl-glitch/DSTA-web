'use strict';
// Only a generic offline page is cached. Never cache credentials, dashboard data,
// chat, minutes or mutations. All application requests keep their network behavior.
const OFFLINE_CACHE = 'dsta-offline-v1';
const OFFLINE_URL = '/offline';
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const response = await fetch(OFFLINE_URL, { cache: 'reload', credentials: 'omit' });
    if (!response.ok) throw new Error('Offline page unavailable');
    const cache = await caches.open(OFFLINE_CACHE);
    await cache.put(OFFLINE_URL, response);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('dsta-offline-') && name !== OFFLINE_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || event.request.mode !== 'navigate' ||
      url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    try {
      return await fetch(event.request);
    } catch {
      return await caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE }) ||
        new Response('Sin conexión. Reconéctate y abre DSTA nuevamente.', {
          status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' }
        });
    }
  })());
});
