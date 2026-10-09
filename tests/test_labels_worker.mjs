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


const palette = JSON.parse(readFileSync(new URL('../public/label-palette.json',import.meta.url)));
for(const {hex} of palette) assert.ok(source.includes("'"+hex+"'"), 'worker and browser palettes agree');
const snapshot = {timestamp:new Date().toISOString(),observationStartedAt:new Date().toISOString(),projects:[{id:3,title:'LT1'}],
 labels:[{id:1,title:'Carrera tecnológica',hex_color:'86e2bb'},{id:2,title:'Antigua',hex_color:'8bbcff'}],
 tasks:[{id:15,title:'Task',project_id:3,done:false,label_ids:[2]}]};
// Start timestamp must precede completion timestamp.
snapshot.timestamp=snapshot.observationStartedAt;
const env=environment();
assert.equal((await call(env,'POST','/api/ingest',snapshot,'Bearer ingest')).status,202);
for(const bad of [{...snapshot,labels:[null]},{...snapshot,tasks:[{...snapshot.tasks[0],label_ids:[99]}]},
 {...snapshot,labels:[...snapshot.labels,snapshot.labels[0]]},{...snapshot,labels:[{id:1,title:'Bad',hex_color:'rgb(0,0,0)'}]}]) {
 assert.equal((await call(env,'POST','/api/ingest',bad,'Bearer ingest')).status,400);
}
const body={action:'assign',taskId:15,labelId:1,requestId:crypto.randomUUID()};
assert.equal((await call(env,'POST','/api/label-actions',body,'Basic wrong')).status,401);
assert.equal((await worker.fetch(new Request('https://example.com/api/label-actions',{method:'POST',headers:{authorization:auth,origin:'https://evil.test','content-type':'application/json'},body:JSON.stringify(body)}),env)).status,403);
for(const bad of [{...body,taskId:99},{...body,labelId:99}]) assert.equal((await call(env,'POST','/api/label-actions',bad)).status,404);
for(const bad of [{...body,extra:true},{...body,taskId:'15'},{...body,requestId:'bad'},
 {action:'create',title:'X',color:'123456',requestId:crypto.randomUUID()}]) assert.equal((await call(env,'POST','/api/label-actions',bad)).status,400);
const deleteEnv=environment();
assert.equal((await call(deleteEnv,'POST','/api/ingest',snapshot,'Bearer ingest')).status,202);
assert.equal((await call(deleteEnv,'POST','/api/label-actions',{action:'delete',labelId:1,requestId:crypto.randomUUID()})).status,202);
assert.equal((await call(env,'POST','/api/label-actions',body)).status,202);
assert.equal((await call(env,'POST','/api/label-actions',body)).body.id,body.requestId);
assert.equal((await call(env,'POST','/api/label-actions',{...body,labelId:2})).status,409);
const job=(await call(env,'GET','/api/bridge/next?kind=label',null,'Bearer bridge')).body.job;
assert.equal(job.kind,'label');
assert.equal((await call(env,'GET','/api/bridge/next?kind=label',null,'Bearer bridge')).body.job,null);
assert.equal((await call(env,'POST','/api/bridge/complete',{kind:'label',id:job.id,attempt:'old'},'Bearer bridge')).status,409);
const changed={...snapshot,timestamp:new Date().toISOString(),observationStartedAt:new Date().toISOString(),tasks:[{...snapshot.tasks[0],label_ids:[1,2]}],
 labelConfirmation:{id:job.id,attempt:job.attempt,result:{labelId:1}}};changed.timestamp=changed.observationStartedAt;
assert.equal((await call(env,'POST','/api/ingest',changed,'Bearer ingest')).status,400);
assert.equal((await call(env,'POST','/api/bridge/snapshot',{...changed,labelConfirmation:{...changed.labelConfirmation,attempt:'old'}},'Bearer bridge')).status,409);
assert.equal((await call(env,'POST','/api/bridge/snapshot',changed,'Bearer bridge')).status,202);
assert.equal((await call(env,'POST','/api/bridge/complete',{kind:'label',id:job.id,attempt:job.attempt,snapshotTimestamp:changed.timestamp},'Bearer bridge')).body.status,'completed');
assert.equal((await call(env,'GET','/api/label-actions?id='+job.id)).body.status,'completed');
const legacy={timestamp:new Date().toISOString(),projects:snapshot.projects,tasks:[{id:15,title:'Old',project_id:3}]};
assert.equal((await call(env,'POST','/api/ingest',legacy,'Bearer ingest')).status,409,'old producer cannot erase label data');
const reset=(await call(env,'POST','/api/label-actions',{action:'reset',requestId:crypto.randomUUID()}));
assert.equal(reset.status,202);
const resetJob=(await call(env,'GET','/api/bridge/next?kind=label',null,'Bearer bridge')).body.job;
assert.deepEqual(resetJob.targets.map(l=>l.id),[2]);assert.equal(resetJob.preservedId,1);
console.log('Native labels: auth, strict schema, scope, protected label, leases, snapshot proof, migration and reset checks passed');
