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
  const env = {
    DASHBOARD_USER: 'admin',
    DASHBOARD_PASSWORD: 'password',
    INGEST_TOKEN: 'ingest',
    DSTA_BRIDGE_TOKEN: 'bridge',
    legacyValues: snapshotValues,
    kvWrites: 0,
    DASHBOARD_DATA: {
      async get(key) { return snapshotValues.get(key) ?? null; },
      async put(key, value) { env.kvWrites += 1; snapshotValues.set(key, JSON.parse(value)); },
      async delete(key) { env.kvWrites += 1; snapshotValues.delete(key); },
    },
  };
  const chat = new DashboardChatQueue({
    storage: {
      kv: {
        get(key) { return queueValues.get(key); },
        put(key, value) { queueValues.set(key, structuredClone(value)); },
        delete(key) { queueValues.delete(key); },
        list({ prefix }) { return [...queueValues.entries()].filter(([key]) => key.startsWith(prefix)); },
      },
    },
  }, env);
  // Stub: fetch() plus RPC methods, which return structured clones like the real runtime.
  const stub = new Proxy({}, { get(_, name) {
    if (name === 'fetch') return request => chat.fetch(typeof request === 'string' ? new Request(request) : request);
    return async (...args) => structuredClone(await chat[name](...args));
  } });
  env.CHAT_STATE = { getByName() { return stub; } };
  return env;
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

// Resúmenes de Cata: viven en el Durable Object y un fallo no se reintenta en cada snapshot.
const cataSnapshot = { timestamp: '2026-09-25T15:00:00Z', projects: [{ id: 3, title: 'LT1' }],
  tasks: [{ id: 21, title: 'Revisar con Cata el plan', project: 'LT1' }, { id: 22, title: 'Otra', project: 'LT1' }] };
env.legacyValues.set('dsta-ai-summaries-v1', { 99: { sourceHash: 'x', summary: 'migrado' } });
await call(env, 'POST', '/api/ingest', cataSnapshot, 'Bearer ingest');
const summaryJob = (await call(env, 'GET', '/api/bridge/next?kind=summary', null, 'Bearer bridge')).body.job;
assert.deepEqual(summaryJob.tasks.map(task => task.id), [21]);
assert.equal((await call(env, 'GET', '/api/bridge/next?kind=summary', null, 'Bearer bridge')).body.job, null, 'one summary job at a time');
await call(env, 'POST', '/api/bridge/complete', { id: summaryJob.id, error: 'Hermes no pudo generar los resúmenes.' }, 'Bearer bridge');
await call(env, 'POST', '/api/ingest', cataSnapshot, 'Bearer ingest');
assert.equal((await call(env, 'GET', '/api/bridge/next?kind=summary', null, 'Bearer bridge')).body.job, null,
  'a failed summary waits before retrying the same task');
const editedSnapshot = structuredClone(cataSnapshot);
editedSnapshot.tasks[0].title = 'Revisar con Cata el plan v2';
await call(env, 'POST', '/api/ingest', editedSnapshot, 'Bearer ingest');
const retryJob = (await call(env, 'GET', '/api/bridge/next?kind=summary', null, 'Bearer bridge')).body.job;
assert.equal(retryJob.tasks[0].title, 'Revisar con Cata el plan v2', 'an edited task is summarized again');
await call(env, 'POST', '/api/bridge/complete', { id: retryJob.id, summaries: [{ id: 21, summary: 'Plan listo', attention: 'normal' }] }, 'Bearer bridge');
const withSummary = await call(env, 'GET', '/api/dashboard');
assert.equal(withSummary.body.aiSummaries['21'].summary, 'Plan listo');
assert.equal(env.kvWrites, 0, 'the dashboard no longer writes to Workers KV');

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

// Semáforos de disponibilidad
assert.equal((await call(env, 'POST', '/api/bridge/health', { vikunja: { ok: true } }, 'Bearer wrong')).status, 401);
await call(env, 'POST', '/api/bridge/health',
  { vikunja: { ok: true, detail: 'Respondiendo', checkedAt: '2026-09-30T14:00:00-0300' }, granola: { ok: false, detail: 'Requiere reautorizar' }, otro: { ok: true } }, 'Bearer bridge');
let health = (await call(env, 'GET', '/api/dashboard')).body.health;
assert.equal(health.vikunja.ok, true);
assert.equal(health.granola.detail, 'Requiere reautorizar');
assert.ok(health.granola.receivedAt, 'the Worker stamps when it heard from the bridge');
assert.equal(health.otro, undefined, 'only known services are stored');
await call(env, 'POST', '/api/bridge/health', { granola: { ok: true, detail: 'Conectado' } }, 'Bearer bridge');
health = (await call(env, 'GET', '/api/dashboard')).body.health;
assert.equal(health.granola.ok, true);
assert.equal(health.vikunja.ok, true, 'a partial report keeps the other service');

// Minutas citadas por el copiloto
await call(env, 'POST', '/api/bridge/complete', { id: next.body.id, reply: 'listo' }, 'Bearer bridge');
const cite =await call(env, 'POST', '/api/assistant', { message: '¿qué se habló de ENAER?' });
const citeJob = (await call(env, 'GET', '/api/bridge/next?kind=chat', null, 'Bearer bridge')).body.job;
assert.equal(citeJob.id, cite.body.id);
await call(env, 'POST', '/api/bridge/complete', { id: citeJob.id,
  reply: 'Ver [Directores](minuta:Minutas 2026/x.md).',
  minutes: { 'Minutas 2026/x.md': { titulo: 'Reunión Directores', fecha: '2026-09-28', contenido: '# Reunión Directores\n- ENAER' } } }, 'Bearer bridge');
const citeStatus = await call(env, 'GET', `/api/assistant?id=${cite.body.id}`);
assert.equal(citeStatus.body.minutes['Minutas 2026/x.md'].titulo, 'Reunión Directores');
assert.match(citeStatus.body.minutes['Minutas 2026/x.md'].contenido, /ENAER/);

console.log('assistant Durable Object queue checks passed');
