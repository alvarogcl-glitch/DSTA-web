import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8')
  .replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject {}');
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const auth = `Basic ${Buffer.from('admin:password').toString('base64')}`;
let forwarded = 0;
const env = {
  DASHBOARD_USER: 'admin', DASHBOARD_PASSWORD: 'password', INGEST_TOKEN: 'ingest', DSTA_BRIDGE_TOKEN: 'bridge',
  CHAT_STATE: { getByName: () => ({ fetch: async () => { forwarded++; return new Response('{}', {status: 202}); } }) },
};
function request(path, headers = {}, body = '{"message":"hola"}') {
  return new Request(`https://example.com${path}`, {method: 'POST', headers: {authorization: auth, 'content-type': 'application/json', ...headers}, body});
}
// Basic credentials cached by a browser must not authorize writes initiated on another site.
for (const path of ['/api/assistant', '/api/minutes/decide', '/api/minutes/seen', '/api/health/refresh']) {
  const response = await worker.fetch(request(path, {origin: 'https://attacker.example'}), env);
  assert.equal(response.status, 403, `${path} rejects cross-origin browser writes before parsing or forwarding`);
}
assert.equal(forwarded, 0);
assert.equal((await worker.fetch(request('/api/assistant', {'sec-fetch-site': 'cross-site'}), env)).status, 403);
assert.equal((await worker.fetch(request('/api/assistant', {origin: 'null'}), env)).status, 403);
assert.equal((await worker.fetch(request('/api/assistant', {'content-type': 'text/plain'}), env)).status, 415);
assert.equal((await worker.fetch(request('/api/assistant', {origin: 'https://example.com', 'sec-fetch-site': 'same-origin'}), env)).status, 202);
assert.equal((await worker.fetch(request('/api/assistant'), env)).status, 202, 'non-browser clients remain supported');
// An origin header never bypasses Basic authentication.
assert.equal((await worker.fetch(request('/api/assistant', {authorization: 'Bearer bridge', origin: 'https://example.com'}), env)).status, 401);
assert.equal((await worker.fetch(request('/api/assistant', {}, ' '.repeat(24_001) + '{}'), env)).status, 413, 'whitespace counts towards the raw byte limit');
// A streamed body without Content-Length is bounded BEFORE JSON parsing/queue forwarding.
let pulls = 0;
let canceled = false;
const stream = new ReadableStream({
  pull(controller) { pulls++; controller.enqueue(new Uint8Array(12_000).fill(32)); },
  cancel() { canceled = true; },
});
const oversized = new Request('https://example.com/api/assistant', {method: 'POST', headers: {authorization: auth, 'content-type': 'application/json'}, body: stream, duplex: 'half'});
assert.equal((await worker.fetch(oversized, env)).status, 413);
assert.ok(canceled, 'stop reading immediately at the byte limit');
assert.ok(pulls <= 5, 'do not drain an unbounded attacker-controlled body');
assert.equal((await worker.fetch(request('/api/assistant', {}, '{bad'), env)).status, 400);
// Static assets are returned by the real Worker, so CSP must trust only the shipped
// inline code, never arbitrary injected scripts or event handlers.
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
env.ASSETS = { fetch: async () => new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}}) };
const asset = await worker.fetch(new Request('https://example.com/', {headers: {authorization: auth}}), env);
const csp = asset.headers.get('content-security-policy');
const scriptDirective = csp.split(';').find(part => part.trim().startsWith('script-src '));
assert.ok(!scriptDirective.includes("'unsafe-inline'"), 'CSP must not allow arbitrary inline JavaScript');
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (/\bsrc\s*=/i.test(match[1]) || !match[2].trim()) continue;
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(match[2].replace(/\r\n?/g, '\n')).digest('base64');
  assert.ok(scriptDirective.includes(`'sha256-${digest}'`), 'the current dashboard script remains allowed');
}
assert.match(csp, /object-src 'none'/);
assert.match(csp, /form-action 'none'/);
assert.equal(asset.headers.get('x-frame-options'), 'DENY');
assert.equal(await asset.text(), html, 'security headers must not alter the delivered HTML');
let snapshotsSaved = 0;
env.CHAT_STATE = { getByName: () => ({ saveSnapshot: async () => { snapshotsSaved++; } }) };
const validSnapshot = {timestamp:'2026-10-03T00:00:00Z', projects:[{id:3,title:'LT1'}], tasks:[{id:17,title:'Seguimiento',project_id:3,done:false}]};
for (const invalid of [
  {...validSnapshot, timestamp:'not-a-date'},
  {...validSnapshot, tasks:[null]},
  {...validSnapshot, projects:[null]},
  {...validSnapshot, tasks:[{id:17,title:{html:'unsafe'}}]},
  {...validSnapshot, tasks:[{id:17,title:'x',done:'false'}]},
  {...validSnapshot, tasks:[validSnapshot.tasks[0], validSnapshot.tasks[0]]},
  {...validSnapshot, tasks:[{id:17,title:'x',project_id:999}]},
]) {
  const response = await worker.fetch(request('/api/ingest', {authorization:'Bearer ingest'}, JSON.stringify(invalid)), env);
  assert.equal(response.status, 400, 'malformed snapshots must not replace last known good data');
}
assert.equal(snapshotsSaved, 0);
assert.equal((await worker.fetch(request('/api/ingest', {authorization:'Bearer ingest'}, JSON.stringify(validSnapshot)), env)).status, 202);
assert.equal(snapshotsSaved, 1);
console.log('Worker CSRF, bounded body, CSP and snapshot integrity security checks passed');
