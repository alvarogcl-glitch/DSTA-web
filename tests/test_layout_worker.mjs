// Customisable dashboard sections: per-box layout (order, on/off, names, custom filter sections)
// and AI summaries for any section that enables them (Cata 1-1 behaviour preserved by default).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8')
  .replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
const { default: worker, DashboardChatQueue, taskMatchesFilters, defaultLayout } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const auth = `Basic ${Buffer.from('admin:password').toString('base64')}`;
const values = new Map();
const env = { DASHBOARD_USER: 'admin', DASHBOARD_PASSWORD: 'password', INGEST_TOKEN: 'ingest', DSTA_BRIDGE_TOKEN: 'bridge',
  DASHBOARD_DATA: { async get() { return null; } } };
const chat = new DashboardChatQueue({ storage: { kv: {
  get: k => structuredClone(values.get(k)), put: (k, v) => values.set(k, structuredClone(v)), delete: k => values.delete(k),
  list: ({ prefix }) => [...values].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)]) } } }, env);
env.CHAT_STATE = { getByName: () => new Proxy({}, { get(_, name) {
  if (name === 'fetch') return r => chat.fetch(typeof r === 'string' ? new Request(r) : r);
  return async (...args) => structuredClone(await chat[name](...args));
} }) };
const call = async (method, path, body, headers = {}) => {
  const res = await worker.fetch(new Request(`https://example.com${path}`, { method,
    headers: { authorization: auth, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// 1. Default layout: production keeps its current five sections (Cata 1-1 included).
const initial = await call('GET', '/api/preferences/layout');
assert.equal(initial.status, 200);
assert.deepEqual(initial.body.layout.sections.map(s => [s.key, s.enabled]),
  [['portfolio', true], ['upcoming', true], ['cata', true], ['labels', true], ['inventory', true]]);
assert.deepEqual(defaultLayout({ cata: false }).sections.map(s => s.key), ['portfolio', 'upcoming', 'labels', 'inventory'], 'new users: four defaults');

// 2. Save: reorder, disable, rename and a custom section with filters and AI.
const layout = { version: 1, sections: [
  { id: 'inventory', kind: 'builtin', key: 'inventory', title: 'Inventario', enabled: true },
  { id: 'c-1', kind: 'custom', title: 'Seguimiento Nelson', enabled: true, ai: true,
    filters: { keywords: ['Nelson'], fields: ['owner', 'title'], status: 'open' } },
  { id: 'portfolio', kind: 'builtin', key: 'portfolio', title: 'Portafolio por línea de trabajo', enabled: true },
  { id: 'upcoming', kind: 'builtin', key: 'upcoming', title: 'Tareas con fechas próximas', enabled: false },
  { id: 'cata', kind: 'builtin', key: 'cata', title: 'Cata 1-1', enabled: true },
  { id: 'labels', kind: 'builtin', key: 'labels', title: 'Portafolio por etiqueta', enabled: true },
] };
assert.equal((await call('PUT', '/api/preferences/layout', { layout }, { origin: 'https://attacker.example' })).status, 403, 'CSRF');
assert.equal((await call('PUT', '/api/preferences/layout', { layout })).status, 200);
assert.deepEqual((await call('GET', '/api/preferences/layout')).body.layout, layout);

// 3. Validation: unknown builtin, duplicated ids, script in titles kept as text, limits.
for (const bad of [
  { version: 1, sections: [{ id: 'x', kind: 'builtin', key: 'nope', title: 'X', enabled: true }] },
  { version: 1, sections: [layout.sections[0], layout.sections[0]] },
  { version: 1, sections: Array.from({ length: 31 }, (_, i) => ({ id: `c-${i}`, kind: 'custom', title: 'x', enabled: true, filters: { keywords: ['a'] } })) },
  { version: 1, sections: [{ id: 'c-2', kind: 'custom', title: 'x'.repeat(81), enabled: true, filters: {} }] },
  { version: 1, sections: [{ id: 'c-2', kind: 'custom', title: 'Sin filtros', enabled: true, filters: {} }] },
  { version: 1, sections: [{ id: 'c-2', kind: 'custom', title: 'x', enabled: true, filters: { keywords: ['a'], fields: ['password'] } }] },
]) assert.equal((await call('PUT', '/api/preferences/layout', { layout: bad })).status, 400, JSON.stringify(bad).slice(0, 80));

// 4. Matcher (same semantics the browser uses).
const task = { id: 5, title: 'Revisar contrato', owner: 'Nelson Pérez', description: 'Pendiente firma', dependency: 'Legal', done: false, project_id: 3, label_ids: [7] };
assert.ok(taskMatchesFilters(task, { keywords: ['nelson'], fields: ['owner'] }), 'case/accent-insensitive');
assert.ok(taskMatchesFilters(task, { keywords: ['Nel'], fields: ['owner'] }), 'partial words match (more intuitive)');
assert.ok(!taskMatchesFilters(task, { keywords: ['Nelson'], fields: ['title'] }), 'only in the chosen fields');
assert.ok(taskMatchesFilters(task, { keywords: ['firma'], fields: ['description'], projectIds: [3], labelIds: [7] }));
assert.ok(!taskMatchesFilters(task, { keywords: ['firma'], fields: ['description'], projectIds: [4] }), 'all criteria must hold');
assert.ok(taskMatchesFilters(task, { dependency: 'legal' }));
assert.ok(!taskMatchesFilters({ ...task, done: true }, { owner: 'Nelson', status: 'open' }));

// 5. AI summaries: tasks of AI-enabled sections are queued; Cata keeps working.
const snapshot = { timestamp: new Date().toISOString(), projects: [{ id: 3, title: 'LT1' }], tasks: [
  { id: 1, title: 'Plan con Nelson', owner: 'Nelson', project_id: 3, done: false },
  { id: 2, title: 'Revisión con Cata', owner: 'Ana', project_id: 3, done: false },
  { id: 3, title: 'Otra tarea', owner: 'Ana', project_id: 3, done: false },
] };
assert.equal((await call('POST', '/api/bridge/snapshot', snapshot, { authorization: 'Bearer bridge' })).status, 202);
const queued = values.get('data:summary-queue');
assert.deepEqual(queued.tasks.map(t => t.id).sort(), [1, 2], 'Nelson (custom AI section) + Cata (builtin)');

console.log('Dashboard layout: defaults, save/validate, CSRF, matcher and AI summaries per section passed');
