// Multiuser mode (AUTH_MODE=accounts): per-user accounts in D1 and one Durable Object per user.
// Each actor sees only its own snapshot, minutes, copilot jobs and actions; the bridge must name
// the actor it publishes for; legacy KV data never leaks into a user's box.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8')
  .replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
const { default: worker, DashboardChatQueue } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const ORIGIN = 'https://staging.example';
const b64url = bytes => Buffer.from(bytes).toString('base64url');
async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64url(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(salt, 'base64url'), iterations: 100000 }, key, 256));
}

function d1(database) {
  return { prepare(sql) { return { bind(...values) { return {
    async first() { return database.prepare(sql).get(...values) ?? null; },
    async all() { return { results: database.prepare(sql).all(...values) }; },
    async run() { const r = database.prepare(sql).run(...values); return { success: true, meta: { changes: Number(r.changes) } }; },
  }; } }; } };
}

function memoryKv() {
  const m = new Map();
  return { get: k => structuredClone(m.get(k)), put: (k, v) => m.set(k, structuredClone(v)), delete: k => m.delete(k),
    list: ({ prefix }) => [...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)]) };
}

const CEO_LEGACY_SNAPSHOT = { timestamp: '2026-10-01T00:00:00Z', projects: [{ id: 2, title: 'PMO-DSTA real' }],
  tasks: [{ id: 999, title: 'Tarea real del CEO', project_id: 2, done: false }] };
const boxes = new Map();
const sqlite = new DatabaseSync(':memory:');
for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
  sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
}
const env = {
  AUTH_MODE: 'accounts', DSTA_BRIDGE_TOKEN: 'bridge-test', DB: d1(sqlite),
  DASHBOARD_DATA: { async get() { return structuredClone(CEO_LEGACY_SNAPSHOT); } },
  ASSETS: { fetch: async req => new Response(`<html>${new URL(req.url).pathname}</html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
};
// Like a real DO stub: fetch() accepts a URL string or a Request; RPC methods pass through.
env.CHAT_STATE = { getByName(name) {
  if (!boxes.has(name)) boxes.set(name, new DashboardChatQueue({ id: { name }, storage: { kv: memoryKv() } }, env));
  const box = boxes.get(name);
  return new Proxy(box, { get(target, key) {
    if (key === 'fetch') return input => target.fetch(typeof input === 'string' ? new Request(input) : input);
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
} };

const users = [
  { id: 'demo-a', email: 'a@dsta.test', name: 'Cuenta A', password: 'synthetic-A-password-2026' },
  { id: 'demo-b', email: 'b@dsta.test', name: 'Cuenta B', password: 'synthetic-B-password-2026' },
];
for (const [i, u] of users.entries()) {
  const salt = b64url(Buffer.from(`salt-${i}-0123456789abcdef`));
  sqlite.prepare('INSERT INTO users(id,email,display_name,password_salt,password_hash) VALUES(?,?,?,?,?)')
    .run(u.id, u.email, u.name, salt, await pbkdf2(u.password, salt));
}

async function call(path, { method = 'GET', body, headers = {}, cookie } = {}) {
  const h = new Headers(headers);
  if (cookie) h.set('cookie', cookie);
  if (body !== undefined && !h.has('content-type')) h.set('content-type', 'application/json');
  if (method !== 'GET' && !h.has('origin') && !headers.noOrigin) h.set('origin', ORIGIN);
  h.delete('noOrigin');
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const bridge = (path, actor, init = {}) => call(path, { ...init, headers: { authorization: 'Bearer bridge-test', ...(actor ? { 'x-dsta-actor': actor } : {}), ...(init.headers || {}) } });
async function login(user) {
  const response = await call('/api/auth/login', { method: 'POST', body: { email: user.email, password: user.password } });
  assert.equal(response.status, 200, `login ${user.id}`);
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.some(c => /^__Host-dsta_session=.*HttpOnly.*SameSite=Lax/i.test(c) && /Secure/.test(c)), 'session cookie is HttpOnly/Secure/Lax');
  return cookies.map(c => c.split(';', 1)[0]).join('; ');
}
const snapshot = (prefix, id) => ({ timestamp: new Date().toISOString(), projects: [{ id: id, title: `${prefix} LT` }],
  tasks: [{ id: id * 10, title: `${prefix} tarea privada`, project_id: id, done: false }] });

// 1. Without a session nothing private is served; navigation goes to the login page.
assert.equal((await call('/api/dashboard')).status, 401);
const nav = await call('/', { headers: { accept: 'text/html' } });
assert.equal(nav.status, 302);
assert.equal(nav.headers.get('location'), '/login');
assert.equal((await call('/login')).status, 200, 'login page is public');
assert.equal((await call('/api/dashboard', { headers: { authorization: 'Basic ' + btoa('admin:password') } })).status, 401, 'Basic Auth is disabled in accounts mode');

// 2. Login and per-user boxes.
const a = await login(users[0]);
const b = await login(users[1]);
assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: users[0].email, password: 'wrong-password-123' } })).status, 401);
const session = await (await call('/api/session', { cookie: a })).json();
assert.equal(session.actor.id, 'demo-a');

// 3. A new user's box never falls back to the legacy (CEO) KV snapshot.
const empty = await call('/api/dashboard', { cookie: a });
assert.equal(empty.status, 503);
assert.doesNotMatch(await empty.text(), /Tarea real del CEO/);

// 4. The bridge must name an existing actor; each snapshot lands only in that actor's box.
assert.equal((await bridge('/api/bridge/snapshot', null, { method: 'POST', body: snapshot('A', 3), headers: { noOrigin: '1' } })).status, 400);
assert.equal((await bridge('/api/bridge/snapshot', 'ghost', { method: 'POST', body: snapshot('A', 3), headers: { noOrigin: '1' } })).status, 404);
assert.equal((await call('/api/bridge/snapshot', { method: 'POST', body: snapshot('A', 3), headers: { 'x-dsta-actor': 'demo-a', authorization: 'Bearer wrong' } })).status, 401);
assert.equal((await bridge('/api/bridge/snapshot', 'demo-a', { method: 'POST', body: snapshot('A', 3), headers: { noOrigin: '1' } })).status, 202);
assert.equal((await bridge('/api/bridge/snapshot', 'demo-b', { method: 'POST', body: snapshot('B', 4), headers: { noOrigin: '1' } })).status, 202);
const dashA = await (await call('/api/dashboard', { cookie: a })).json();
const dashB = await (await call('/api/dashboard', { cookie: b })).json();
assert.deepEqual(dashA.tasks.map(t => t.title), ['A tarea privada']);
assert.deepEqual(dashB.tasks.map(t => t.title), ['B tarea privada']);
assert.ok(!boxes.has('pmo-dsta'), 'the legacy production box is never touched by user traffic');

// 5. Copilot jobs are per user: B's bridge poll never sees A's question, B cannot read A's job.
const job = await (await call('/api/assistant', { method: 'POST', cookie: a, body: { message: 'resumen de mis LTs' } })).json();
const pollB = await (await bridge('/api/bridge/next', 'demo-b')).json();
assert.equal(pollB.job, null);
assert.equal((await call(`/api/assistant?id=${job.id}`, { cookie: b })).status, 404, 'B cannot read A\'s copilot job');
const pollA = await (await bridge('/api/bridge/next', 'demo-a')).json();
assert.equal(pollA.job.id, job.id);
assert.equal(pollA.job.message, 'resumen de mis LTs');

// 6. Actions can only target tasks in the actor's own snapshot.
const foreign = await call('/api/task-actions', { method: 'POST', cookie: a, body: { action: 'complete', taskId: 40, requestId: crypto.randomUUID() } });
assert.equal(foreign.status, 404, 'A cannot act on B\'s task');
const own = await call('/api/task-actions', { method: 'POST', cookie: a, body: { action: 'complete', taskId: 30, requestId: crypto.randomUUID() } });
assert.equal(own.status, 202);
assert.equal((await (await bridge('/api/bridge/next?kind=action', 'demo-b')).json()).job, null);
assert.equal((await (await bridge('/api/bridge/next?kind=action', 'demo-a')).json()).job.taskId, 30);

// 7. Minutes inbox is per user.
const minute = { id: 'm-a-1', titulo: 'Minuta A', detectadaEn: new Date().toISOString(), digest: 'd1', acciones: [] };
assert.equal((await bridge('/api/bridge/minute', 'demo-a', { method: 'POST', body: minute, headers: { noOrigin: '1' } })).status, 200);
assert.equal((await (await call('/api/minutes', { cookie: a })).json()).minutes.length, 1);
assert.equal((await (await call('/api/minutes', { cookie: b })).json()).minutes.length, 0);

// 8. Browser writes require a same-origin Origin header (CSRF), even with a valid session.
assert.equal((await call('/api/assistant', { method: 'POST', cookie: b, body: { message: 'x' }, headers: { origin: 'https://attacker.example' } })).status, 403);
assert.equal((await call('/api/assistant', { method: 'POST', cookie: b, body: { message: 'x' }, headers: { noOrigin: '1' } })).status, 403);

// 9. Logout revokes only that session.
assert.equal((await call('/api/auth/logout', { method: 'POST', cookie: a })).status, 204);
assert.equal((await call('/api/dashboard', { cookie: a })).status, 401);
assert.equal((await call('/api/dashboard', { cookie: b })).status, 200);

// 10. Invitation: single use, creates the account with salt+hash only, then login works.
const token = 'invite-token-for-c-0123456789abcdef';
const tokenHash = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
const now = Math.floor(Date.now() / 1000);
sqlite.prepare('INSERT INTO invitations(token_hash,actor_id,email,display_name,expires_at,created_at) VALUES(?,?,?,?,?,?)')
  .run(tokenHash, 'demo-c', 'c@dsta.test', 'Cuenta C', now + 3600, now);
assert.equal((await call('/api/auth/accept-invite', { method: 'POST', body: { token, password: 'corta' } })).status, 400);
assert.equal((await call('/api/auth/accept-invite', { method: 'POST', body: { token, password: 'synthetic-C-password-2026' } })).status, 201);
assert.equal((await call('/api/auth/accept-invite', { method: 'POST', body: { token, password: 'synthetic-C-password-2027' } })).status, 400, 'single use');
const rowC = sqlite.prepare("SELECT * FROM users WHERE id='demo-c'").get();
assert.ok(!Object.values(rowC).some(v => String(v).includes('synthetic-C-password')), 'no plaintext password stored');
await login({ email: 'c@dsta.test', password: 'synthetic-C-password-2026', id: 'demo-c' });

// 11. Login is rate limited per IP (hashed).
let status = 0;
for (let i = 0; i < 12 && status !== 429; i += 1) {
  status = (await call('/api/auth/login', { method: 'POST', body: { email: 'x@dsta.test', password: 'wrong-password-123' }, headers: { 'cf-connecting-ip': '203.0.113.9' } })).status;
}
assert.equal(status, 429);

// 12. F1: the bridge may name the actor in the path (/u/<actor>/api/bridge/...), so the
// single-user bridge functions work per user just by receiving a per-user base URL.
const viaPath = await call('/u/demo-b/api/bridge/next?kind=action', { headers: { authorization: 'Bearer bridge-test' } });
assert.equal(viaPath.status, 200);
assert.equal((await call('/u/ghost/api/bridge/next', { headers: { authorization: 'Bearer bridge-test' } })).status, 404);
assert.equal((await call('/u/demo-b/api/bridge/next', { headers: { authorization: 'Bearer wrong' } })).status, 401);
assert.equal((await call('/u/demo-b/api/dashboard', { cookie: b })).status, 404, 'the /u/ prefix is only for the bridge');
assert.equal((await call('/u/demo-a/api/bridge/next', { headers: { authorization: 'Bearer bridge-test', 'x-dsta-actor': 'demo-b' } })).status, 400,
  'path and header naming different actors is rejected');

// 13. F1: dispatcher. One poll tells the bridge which users have pending work.
assert.equal((await call('/api/bridge/dispatch', { headers: { authorization: 'Bearer wrong' } })).status, 401);
const d0 = await (await call('/api/bridge/dispatch', { headers: { authorization: 'Bearer bridge-test' } })).json();
const pendingKinds = actor => Object.keys(d0.pending?.[actor] || {});
assert.ok(pendingKinds('demo-a').includes('action'), 'A queued an action in step 6');
assert.ok(typeof d0.now === 'number');
await call('/api/assistant', { method: 'POST', cookie: b, body: { message: 'hola desde B' } });
const d1r = await (await call('/api/bridge/dispatch', { headers: { authorization: 'Bearer bridge-test' } })).json();
assert.ok(Object.keys(d1r.pending['demo-b'] || {}).includes('chat'), 'B\'s chat is announced');
// Ack clears only marks not newer than the dispatch read, so a job arriving meanwhile is kept.
const ack = await call('/api/bridge/dispatch', { method: 'POST', headers: { authorization: 'Bearer bridge-test', noOrigin: '1' },
  body: { actor: 'demo-b', kinds: ['chat'], seenAt: d1r.now } });
assert.equal(ack.status, 200);
const d2 = await (await call('/api/bridge/dispatch', { headers: { authorization: 'Bearer bridge-test' } })).json();
assert.ok(!Object.keys(d2.pending['demo-b'] || {}).includes('chat'));
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal((await call('/api/task-actions', { method: 'POST', cookie: b, body: { action: 'complete', taskId: 40, requestId: crypto.randomUUID() } })).status, 202);
await call('/api/bridge/dispatch', { method: 'POST', headers: { authorization: 'Bearer bridge-test', noOrigin: '1' },
  body: { actor: 'demo-b', kinds: ['action'], seenAt: d1r.now } });
const d3 = await (await call('/api/bridge/dispatch', { headers: { authorization: 'Bearer bridge-test' } })).json();
assert.ok(Object.keys(d3.pending['demo-b'] || {}).includes('action'), 'a stale ack never erases a newer mark');
assert.equal((await call('/api/bridge/dispatch', { method: 'POST', headers: { authorization: 'Bearer bridge-test', noOrigin: '1' },
  body: { actor: 'demo-b', kinds: ['bogus'], seenAt: d3.now } })).status, 400);

// 14. F2: removing a user wipes their box through the bridge; never the production box.
assert.equal((await call('/u/demo-b/api/bridge/wipe', { method: 'POST', body: {}, headers: { authorization: 'Bearer wrong', noOrigin: '1' } })).status, 401);
assert.equal((await call('/u/demo-b/api/bridge/wipe', { method: 'POST', body: {}, headers: { authorization: 'Bearer bridge-test', noOrigin: '1' } })).status, 200);
assert.equal((await call('/api/dashboard', { cookie: b })).status, 503, 'B\'s data is gone after the wipe');
sqlite.prepare("INSERT INTO users(id,email,display_name,password_salt,password_hash,do_name) VALUES('ceo','ceo@dsta.test','CEO','x','y','pmo-dsta')").run();
assert.equal((await call('/u/ceo/api/bridge/wipe', { method: 'POST', body: {}, headers: { authorization: 'Bearer bridge-test', noOrigin: '1' } })).status, 403,
  'the production box can never be wiped');
const legacyEnv = { DASHBOARD_USER: 'u', DASHBOARD_PASSWORD: 'p', INGEST_TOKEN: 'i', DSTA_BRIDGE_TOKEN: 'bridge-test', CHAT_STATE: env.CHAT_STATE };
assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/bridge/wipe`, { method: 'POST', headers: { authorization: 'Bearer bridge-test' } }), legacyEnv)).status, 401,
  'single-user mode has no wipe route (falls back to Basic Auth)');

console.log('Multiuser accounts mode: login, per-user boxes, bridge actor routing, copilot/actions/minutes isolation, CSRF, logout, invitations and rate limit passed');
