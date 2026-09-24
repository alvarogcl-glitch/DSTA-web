import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8')
  .replace('import { DurableObject } from "cloudflare:workers";',
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
const { default: worker, DashboardChatQueue } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);
const auth = `Basic ${Buffer.from('admin:password').toString('base64')}`;

function environment() {
  const snapshotValues = new Map();
  const queueValues = new Map();
  const chat = new DashboardChatQueue({
    storage: {
      kv: {
        get(key) { return queueValues.get(key); },
        put(key, value) { queueValues.set(key, structuredClone(value)); },
        delete(key) { queueValues.delete(key); },
        list({ prefix }) { return [...queueValues.entries()].filter(([key]) => key.startsWith(prefix)); },
      },
    },
  }, {});
  return {
    DASHBOARD_USER: 'admin',
    DASHBOARD_PASSWORD: 'password',
    INGEST_TOKEN: 'ingest',
    DSTA_BRIDGE_TOKEN: 'bridge',
    CHAT_STATE: { getByName() { return { fetch(request) {
      return chat.fetch(typeof request === 'string' ? new Request(request) : request);
    } }; } },
    DASHBOARD_DATA: {
      async get(key) { return snapshotValues.get(key) ?? null; },
      async put(key, value) { snapshotValues.set(key, JSON.parse(value)); },
      async delete(key) { snapshotValues.delete(key); },
    },
  };
}

async function call(env, method, path, body, authorization = auth) {
  const request = new Request(`https://example.com${path}`, {
    method,
    headers: { authorization, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const response = await worker.fetch(request, env);
  return { status: response.status, body: await response.json() };
}

const env = environment();
const first = await call(env, 'POST', '/api/assistant', { message: 'hola' });
assert.equal(first.status, 202);
assert.equal(first.body.status, 'queued');

const duplicate = await call(env, 'POST', '/api/assistant', { message: 'hola' });
assert.equal(duplicate.body.id, first.body.id, 'a duplicate resumes the same job');
const other = await call(env, 'POST', '/api/assistant', { message: 'otra consulta' });
assert.equal(other.status, 429, 'a different request waits for the active job');

const claimed = await call(env, 'GET', '/api/bridge/next?kind=chat', null, 'Bearer bridge');
assert.equal(claimed.body.job.id, first.body.id);
assert.equal(claimed.body.job.status, 'running');
const empty = await call(env, 'GET', '/api/bridge/next?kind=chat', null, 'Bearer bridge');
assert.equal(empty.body.job, null);

const done = await call(env, 'POST', '/api/bridge/complete',
  { id: first.body.id, reply: 'Hola, Álvaro.' }, 'Bearer bridge');
assert.equal(done.body.ok, true);
const status = await call(env, 'GET', `/api/assistant?id=${first.body.id}`);
assert.equal(status.body.status, 'completed');
assert.equal(status.body.reply, 'Hola, Álvaro.');

const next = await call(env, 'POST', '/api/assistant', { message: 'otra consulta' });
assert.equal(next.status, 202);
assert.notEqual(next.body.id, first.body.id);

console.log('assistant Durable Object queue checks passed');
