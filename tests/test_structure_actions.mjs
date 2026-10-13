// F3: structure actions (work lines and tasks) through the same leased, snapshot-verified
// action queue as "complete". Strict schema per action, scope limited to the current snapshot,
// and completion only when the bridge's post-write snapshot proves the requested result.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8')
  .replace('import { DurableObject } from "cloudflare:workers";',
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
const { default: worker, DashboardChatQueue } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const auth = `Basic ${Buffer.from('admin:password').toString('base64')}`;

function environment() {
  const values = new Map();
  const env = { DASHBOARD_USER: 'admin', DASHBOARD_PASSWORD: 'password', INGEST_TOKEN: 'ingest', DSTA_BRIDGE_TOKEN: 'bridge', STRUCTURE_ACTIONS: 'on',
    DASHBOARD_DATA: { async get() { return null; } } };
  const chat = new DashboardChatQueue({ storage: { kv: {
    get: k => structuredClone(values.get(k)), put: (k, v) => values.set(k, structuredClone(v)), delete: k => values.delete(k),
    list: ({ prefix }) => [...values].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)]),
  } } }, env);
  env.CHAT_STATE = { getByName: () => new Proxy({}, { get(_, name) {
    if (name === 'fetch') return r => chat.fetch(typeof r === 'string' ? new Request(r) : r);
    return async (...args) => structuredClone(await chat[name](...args));
  } }) };
  return env;
}
async function call(env, method, path, body, authorization = auth) {
  const response = await worker.fetch(new Request(`https://example.com${path}`, { method,
    headers: { authorization, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env);
  const text = await response.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
  return { status: response.status, body: parsed };
}
const uuid = () => crypto.randomUUID();
const later = ms => new Date(Date.now() + ms).toISOString();
const base = { projects: [{ id: 3, title: 'LT1' }, { id: 4, title: 'LT2' }],
  tasks: [{ id: 15, title: 'Tarea', project_id: 3, done: false, description: 'd' }] };

// 1. Strict schema.
const env = environment();
await call(env, 'POST', '/api/bridge/snapshot', { ...base, timestamp: later(0) }, 'Bearer bridge');
const valid = [
  { action: 'task.create', requestId: uuid(), projectId: 3, title: 'Nueva tarea', description: 'detalle', dueDate: '2026-11-01' },
  { action: 'task.update', requestId: uuid(), taskId: 15, title: 'Renombrada', description: 'nuevo', dueDate: '' },
  { action: 'task.move', requestId: uuid(), taskId: 15, projectId: 4 },
  { action: 'lt.create', requestId: uuid(), title: 'LT nueva' },
  { action: 'lt.rename', requestId: uuid(), projectId: 4, title: 'LT2 renombrada' },
  { action: 'lt.archive', requestId: uuid(), projectId: 4 },
];
const invalid = [
  { action: 'task.create', requestId: uuid(), projectId: 3 },
  { action: 'task.create', requestId: uuid(), projectId: 3, title: ' ' },
  { action: 'task.create', requestId: uuid(), projectId: 3, title: 'x'.repeat(251) },
  { action: 'task.create', requestId: uuid(), projectId: 3, title: 'ok', dueDate: '01-11-2026' },
  { action: 'task.update', requestId: uuid(), taskId: 15 },
  { action: 'task.update', requestId: uuid(), taskId: 15, title: 'ok', done: true },
  { action: 'task.move', requestId: uuid(), taskId: 15, projectId: '4' },
  { action: 'lt.create', requestId: uuid(), title: 'ok', parentProjectId: 99 },
  { action: 'lt.delete', requestId: uuid(), projectId: 4 },
  { action: 'task.create', requestId: 'bad', projectId: 3, title: 'ok' },
  { action: 'task.create', requestId: uuid(), projectId: 3, title: 'ok', description: 'x'.repeat(20001) },
];
for (const body of invalid) assert.equal((await call(env, 'POST', '/api/task-actions', body)).status, 400, JSON.stringify(body).slice(0, 80));

// 2. Scope: references must exist in the current snapshot.
for (const body of [
  { action: 'task.create', requestId: uuid(), projectId: 99, title: 'fuera' },
  { action: 'task.update', requestId: uuid(), taskId: 999, title: 'fuera' },
  { action: 'task.move', requestId: uuid(), taskId: 15, projectId: 99 },
  { action: 'lt.rename', requestId: uuid(), projectId: 99, title: 'fuera' },
  { action: 'lt.archive', requestId: uuid(), projectId: 99 },
]) assert.equal((await call(env, 'POST', '/api/task-actions', body)).status, 404, body.action);

// 3. Each valid action is queued, delivered with its fields, and completed only with proof.
const proofs = {
  'task.create': [{ taskId: 16 }, s => ({ ...s, tasks: [...s.tasks, { id: 16, title: 'Nueva tarea', project_id: 3, done: false, description: 'detalle', date: '2026-11-01' }] })],
  'task.update': [{ taskId: 15 }, s => ({ ...s, tasks: [{ ...s.tasks[0], title: 'Renombrada', description: 'nuevo', date: '' }] })],
  'task.move': [{ taskId: 15 }, s => ({ ...s, tasks: [{ ...s.tasks[0], project_id: 4 }] })],
  'lt.create': [{ projectId: 5 }, s => ({ ...s, projects: [...s.projects, { id: 5, title: 'LT nueva' }] })],
  'lt.rename': [{ projectId: 4 }, s => ({ ...s, projects: [s.projects[0], { id: 4, title: 'LT2 renombrada' }] })],
  'lt.archive': [{ projectId: 4 }, s => ({ ...s, projects: [s.projects[0]], tasks: s.tasks.filter(t => t.project_id !== 4) })],
};
for (const body of valid) {
  const e = environment();
  await call(e, 'POST', '/api/bridge/snapshot', { ...base, timestamp: later(0) }, 'Bearer bridge');
  const queued = await call(e, 'POST', '/api/task-actions', body);
  assert.equal(queued.status, 202, body.action);
  assert.equal((await call(e, 'POST', '/api/task-actions', body)).status, 202, 'same request id is idempotent');
  const job = (await call(e, 'GET', '/api/bridge/next?kind=action', null, 'Bearer bridge')).body.job;
  assert.equal(job.action, body.action);
  for (const key of Object.keys(body).filter(k => !['requestId'].includes(k))) assert.deepEqual(job[key], body[key], `${body.action}.${key}`);
  const [result, transform] = proofs[body.action];
  const unchanged = { ...base, timestamp: later(50), actionConfirmation: { id: job.id, attempt: job.attempt, result } };
  assert.equal((await call(e, 'POST', '/api/bridge/snapshot', unchanged, 'Bearer bridge')).status, 409, `${body.action}: unchanged snapshot is no proof`);
  const proof = { ...transform(base), timestamp: later(100), actionConfirmation: { id: job.id, attempt: job.attempt, result } };
  assert.equal((await call(e, 'POST', '/api/bridge/snapshot', proof, 'Bearer bridge')).status, 202, `${body.action}: proof accepted`);
  const done = await call(e, 'POST', '/api/bridge/complete', { kind: 'action', id: job.id, attempt: job.attempt, snapshotTimestamp: proof.timestamp }, 'Bearer bridge');
  assert.equal(done.body.status, 'completed', body.action);
  const status = await call(e, 'GET', `/api/task-actions?id=${body.requestId}`);
  assert.equal(status.body.status, 'completed');
  assert.deepEqual(status.body.result, result);
}

// 4. Without accounts mode or the explicit flag, production keeps only "complete".
const legacy = environment();
delete legacy.STRUCTURE_ACTIONS;
await call(legacy, 'POST', '/api/bridge/snapshot', { ...base, timestamp: later(0) }, 'Bearer bridge');
assert.equal((await call(legacy, 'POST', '/api/task-actions', { action: 'lt.create', requestId: uuid(), title: 'x' })).status, 400);
assert.equal((await call(legacy, 'POST', '/api/task-actions', { action: 'complete', taskId: 15, requestId: uuid() })).status, 202);

// 5. "complete" keeps its exact legacy schema and behaviour.
assert.equal((await call(env, 'POST', '/api/task-actions', { action: 'complete', taskId: 15, requestId: uuid() })).status, 202);
assert.equal((await call(env, 'POST', '/api/task-actions', { action: 'complete', taskId: 15, requestId: uuid(), title: 'x' })).status, 400);

console.log('Structure actions (LT/task create, update, move, rename, archive): schema, scope, idempotency and snapshot-verified completion passed');
