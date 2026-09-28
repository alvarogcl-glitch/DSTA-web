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
    legacyValues: snapshotValues,
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
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = { error: text }; }
  return { status: response.status, body: result };
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
  { id: first.body.id, reply: 'Hola, Álvaro.', refreshError: 'No se pudo actualizar.', snapshotTimestamp: '2026-09-25T14:00:00Z' }, 'Bearer bridge');
assert.equal(done.body.ok, true);
const status = await call(env, 'GET', `/api/assistant?id=${first.body.id}`);
assert.equal(status.body.status, 'completed');
assert.equal(status.body.reply, 'Hola, Álvaro.');
assert.equal(status.body.refreshError, 'No se pudo actualizar.');
assert.equal(status.body.snapshotTimestamp, '2026-09-25T14:00:00Z');

const freshSnapshot = { timestamp: '2026-09-25T14:00:00Z', projects: [{ id: 3, title: 'LT1' }], tasks: [{ id: 15, title: 'Nueva', project_id: 3 }] };
const acceptedSnapshot = await call(env, 'POST', '/api/bridge/snapshot', freshSnapshot, 'Bearer bridge');
assert.equal(acceptedSnapshot.status, 202);
const deniedSnapshot = await call(env, 'POST', '/api/bridge/snapshot', freshSnapshot, 'Bearer wrong');
assert.equal(deniedSnapshot.status, 401);
const latest = await call(env, 'GET', '/api/dashboard');
assert.equal(latest.body.tasks[0].title, 'Nueva');
assert.equal(latest.body.timestamp, freshSnapshot.timestamp);

const next = await call(env, 'POST', '/api/assistant', { message: 'otra consulta' });
assert.equal(next.status, 202);
assert.notEqual(next.body.id, first.body.id);

const legacyId = 'd2228b81-07db-4c0e-9ff5-4c8d60e9bdf7';
env.legacyValues.set(`dsta-ai-job-v1:${legacyId}`,
  { id: legacyId, kind: 'chat', status: 'completed', reply: 'Respuesta anterior' });
const legacy = await call(env, 'GET', `/api/assistant?id=${legacyId}`);
assert.equal(legacy.body.reply, 'Respuesta anterior');

// Bandeja de minutas Granola
const minute = { id: 'abc-123', digest: 'd1', titulo: 'Reunión Directores', detectadaEn: '2026-09-28T22:00:00Z',
  estado: 'por_revisar', vista: false, acciones: [{ id: 'a1', tipo: 'crear', estado: 'propuesta' }] };
assert.equal((await call(env, 'POST', '/api/bridge/minute', minute, 'Bearer wrong')).status, 401);
assert.equal((await call(env, 'POST', '/api/bridge/minute', minute, 'Bearer bridge')).status, 200);
assert.equal((await call(env, 'GET', '/api/minutes', null, 'Bearer bridge')).status, 401, 'browser routes need basic auth');
let inbox = await call(env, 'GET', '/api/minutes');
assert.equal(inbox.body.minutes[0].titulo, 'Reunión Directores');
assert.equal(inbox.body.minutes[0].vista, false);
await call(env, 'POST', '/api/minutes/seen', { id: 'abc-123' });
await call(env, 'POST', '/api/bridge/minute', minute, 'Bearer bridge');
inbox = await call(env, 'GET', '/api/minutes');
assert.equal(inbox.body.minutes[0].vista, true, 'a re-published record with the same digest stays seen');

assert.equal((await call(env, 'POST', '/api/minutes/decide', { minuteId: 'abc-123', decisions: [{ actionId: 'a1', decision: 'borrar' }] })).status, 400);
assert.equal((await call(env, 'POST', '/api/minutes/decide', { minuteId: 'abc-123', decisions: [{ actionId: 'a1', decision: 'aprobar', edits: { sql: 'x' } }] })).status, 400);
const decided = await call(env, 'POST', '/api/minutes/decide',
  { minuteId: 'abc-123', decisions: [{ actionId: 'a1', decision: 'aprobar', edits: { titulo: 'Coordinar FACh', project_id: 3 } }] });
assert.equal(decided.status, 202);
assert.equal((await call(env, 'POST', '/api/minutes/decide', { minuteId: 'abc-123', decisions: [{ actionId: 'a1', decision: 'rechazar' }] })).status, 409,
  'only one pending decision per minute');
const withDecision = await call(env, 'GET', '/api/bridge/next?kind=chat', null, 'Bearer bridge');
assert.equal(withDecision.body.decision.minuteId, 'abc-123');
assert.deepEqual(withDecision.body.decision.decisions[0].edits, { titulo: 'Coordinar FACh', project_id: 3 });
assert.equal((await call(env, 'GET', '/api/bridge/next?kind=chat', null, 'Bearer bridge')).body.decision, null, 'a decision is handed out once');
await call(env, 'POST', '/api/bridge/decision-done', { id: withDecision.body.decision.id, error: '' }, 'Bearer bridge');
inbox = await call(env, 'GET', '/api/minutes');
assert.equal(inbox.body.minutes[0].aplicando, false);

console.log('assistant Durable Object queue checks passed');
