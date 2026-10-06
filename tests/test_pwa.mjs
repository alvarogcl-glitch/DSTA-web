import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = read('src/worker.js').replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject {}');
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const env = { DASHBOARD_USER: 'test', DASHBOARD_PASSWORD: 'test', INGEST_TOKEN: 'test',
  ASSETS: { fetch: async request => new Response(new URL(request.url).pathname) } };
for (const path of ['/manifest.webmanifest', '/sw.js', '/offline', '/offline.html', '/icons/dsta-192.png', '/icons/dsta-512.png', '/icons/dsta-maskable-512.png']) {
  for (const method of ['GET', 'HEAD']) assert.equal((await worker.fetch(new Request(`https://example.com${path}`, { method }), env)).status, 200);
  assert.equal((await worker.fetch(new Request(`https://example.com${path}`, { method: 'POST' }), env)).status, 401);
}
for (const path of ['/', '/index.html', '/pwa.js', '/api/dashboard', '/api/minutes', '/api/task-actions', '/icons/private.png', '/manifest.webmanifest/private']) {
  assert.equal((await worker.fetch(new Request(`https://example.com${path}`), env)).status, 401, path);
}
assert.equal((await worker.fetch(new Request('https://example.com/manifest.webmanifest'), {})).status, 503);
const handlers = {}, cached = new Map(), fetches = [];
let offline = false;
const context = { URL, Response, self: { location: { origin: 'https://example.com' },
  addEventListener: (name, fn) => handlers[name] = fn, skipWaiting: async () => {}, clients: { claim: async () => {} } },
  caches: { open: async () => ({ put: async (url, response) => cached.set(url, response) }),
    keys: async () => [], match: async url => cached.get(url)?.clone() },
  fetch: async request => { fetches.push(request); if (offline) throw new Error('offline'); return new Response(typeof request === 'string' ? 'generic offline page' : 'private live data'); } };
vm.runInNewContext(read('public/sw.js'), context);
let pending;
handlers.install({ waitUntil: p => pending = p }); await pending;
assert.deepEqual([...cached.keys()], ['/offline']);
async function navigate() {
  let response;
  handlers.fetch({ request: { url: 'https://example.com/', method: 'GET', mode: 'navigate' }, respondWith: p => response = p });
  return response;
}
assert.equal(await (await navigate()).text(), 'private live data');
assert.equal(cached.size, 1, 'private navigations must never enter CacheStorage');
offline = true;
assert.equal(await (await navigate()).text(), 'generic offline page');
for (const request of [
  { url: 'https://example.com/api/dashboard', method: 'GET', mode: 'navigate' },
  { url: 'https://example.com/api/task-actions', method: 'POST', mode: 'cors' },
  { url: 'https://example.com/assistant.js', method: 'GET', mode: 'cors' },
  { url: 'https://other.example/', method: 'GET', mode: 'navigate' },
]) handlers.fetch({ request, respondWith: () => assert.fail('APIs, mutations and assets must bypass the service worker') });
// An expired login is returned as 401, never replaced with an offline success page.
offline = false;
context.fetch = async () => new Response('Authentication required', { status: 401 });
assert.equal((await navigate()).status, 401);
console.log('PWA public allowlist, authentication and offline privacy checks passed');
