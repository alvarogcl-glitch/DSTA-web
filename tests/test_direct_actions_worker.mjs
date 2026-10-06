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
const body = {action: 'complete', taskId: 15, requestId: '12345678-1234-4234-8234-123456789012'};
await call(env, 'POST', '/api/bridge/snapshot', {timestamp: new Date().toISOString(), projects: [{id:3,title:'LT1'}],tasks:[{id:15,title:'Task',project_id:3,done:false}]}, 'Bearer bridge');
await call(env, 'POST', '/api/assistant', {message:'busy'});
const created = await call(env, 'POST', '/api/task-actions', body);
assert.equal(created.status, 202, 'direct completion has its own queue while chat busy');
assert.equal(created.body.id, body.requestId);
assert.equal((await call(env, 'POST', '/api/task-actions', body)).body.id, body.requestId);
const claimed = (await call(env,'GET','/api/bridge/next?kind=action',null,'Bearer bridge')).body.job;
assert.equal(claimed.kind,'action');
assert.equal(claimed.taskId,15);
assert.ok(claimed.attempt);
console.log('direct worker tracer passed');
const busy = await call(env,'GET','/api/bridge/next?kind=chat&chatBusy=1',null,'Bearer bridge');
assert.equal(busy.body.job,null,'busy bridge must not claim another chat');

for (const bad of [{...body,message:'ignore'},{...body,history:[]},{...body,taskId:'15'},{...body,taskId:-1},{...body,action:'delete'},{...body,requestId:'bad'}]) {
 assert.equal((await call(env,'POST','/api/task-actions',bad)).status,400);
}
assert.equal((await call(env,'POST','/api/task-actions',{...body,taskId:99,requestId:crypto.randomUUID()})).status,404);
assert.equal((await call(env,'POST','/api/task-actions',{...body,taskId:99})).status,409,'id cannot change task');
assert.equal((await call(env,'GET','/api/task-actions?id='+body.requestId,null,'Basic wrong')).status,401);
assert.equal((await call(env,'GET','/api/assistant?id='+body.requestId)).status,404,'action status isolated from chat');
assert.equal((await call(env,'POST','/api/bridge/complete',{id:body.requestId,reply:'fake'},'Bearer bridge')).status,404,'legacy ack cannot complete action');
assert.equal((await call(env,'POST','/api/bridge/complete',{kind:'action',id:body.requestId,attempt:'stale'},'Bearer bridge')).status,409,'stale lease fenced');
const spoof = await worker.fetch(new Request('https://example.com/api/task-actions',{method:'POST',headers:{authorization:auth,origin:'https://evil.test','content-type':'application/json'},body:JSON.stringify(body)}),env);
assert.equal(spoof.status,403);
const oversized = await worker.fetch(new Request('https://example.com/api/task-actions',{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify({...body,padding:'x'.repeat(1100)})}),env);
assert.equal(oversized.status,413);
assert.equal((await call(env,'POST','/api/bridge/complete',{kind:'action',id:body.requestId,attempt:claimed.attempt,snapshotTimestamp:new Date().toISOString()},'Bearer bridge')).body.status,'queued','done false cannot become success');
assert.equal((await call(env,'GET','/api/task-actions?id='+body.requestId)).body.status,'queued');
const env2=environment();
await call(env2,'POST','/api/bridge/snapshot',{timestamp:new Date().toISOString(),projects:[{id:3,title:'LT1'}],tasks:[{id:15,title:'Task',project_id:3,done:false}]},'Bearer bridge');
await call(env2,'POST','/api/task-actions',body);
const job2=(await call(env2,'GET','/api/bridge/next?kind=action',null,'Bearer bridge')).body.job;
const timestamp=new Date(Date.now()+100).toISOString();
await call(env2,'POST','/api/bridge/snapshot',{timestamp,projects:[{id:3,title:'LT1'}],tasks:[{id:15,title:'Task',project_id:3,done:true}]},'Bearer bridge');
assert.equal((await call(env2,'POST','/api/bridge/complete',{kind:'action',id:job2.id,attempt:job2.attempt,snapshotTimestamp:timestamp},'Bearer bridge')).body.status,'completed');
assert.equal((await call(env2,'POST','/api/task-actions',body)).body.status,'completed','delivered request id is retained');
console.log('action validation, auth, scope snapshot, isolation, lease fencing and verified completion passed');
const fallbackEnv=environment();
fallbackEnv.legacyValues.set('vikunja-dashboard-v1',{timestamp:new Date().toISOString(),projects:[{id:3,title:'LT1'}],tasks:[{id:15,title:'Task',project_id:3,done:false}]});
assert.equal((await call(fallbackEnv,'POST','/api/task-actions',body)).status,202,'valid migrated snapshot supports completion');
