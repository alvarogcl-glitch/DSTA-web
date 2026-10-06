import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../src/worker.js',import.meta.url),'utf8').replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {default:worker,DashboardChatQueue}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
function queue(legacy=null){
 const m=new Map();const q=new DashboardChatQueue({storage:{kv:{get:k=>m.get(k),put:(k,v)=>m.set(k,structuredClone(v)),delete:k=>m.delete(k),list:({prefix})=>[...m].filter(([k])=>k.startsWith(prefix))}}},{DASHBOARD_DATA:{async get(){return legacy}},DSTA_BRIDGE_TOKEN:'fake'});
 q.enqueueChangedCataTasks=async()=>{};return {q,m};
}
const snap=(timestamp,done,observationStartedAt)=>({timestamp,...(observationStartedAt?{observationStartedAt}:{}),projects:[{id:3,title:'LT'}],tasks:[{id:15,title:'Task',project_id:3,done}]});
{
 const {q,m}=queue();
 await q.saveSnapshot(snap('2026-10-06T14:00:02Z',true,'2026-10-06T14:00:01Z'));
 const accepted=await q.saveSnapshot(snap('2026-10-06T14:01:00Z',false,'2026-10-06T14:00:00Z'));
 assert.equal(accepted,false,'late-ending older collection must be rejected');
 assert.equal(m.get('data:snapshot').tasks[0].done,true,'stale collection must not resurrect task');
 assert.equal(await q.saveSnapshot(snap('2026-10-06T14:02:00Z',false)),false,'legacy writer cannot bypass collection watermark after cutover');
 assert.equal(await q.saveSnapshot(snap('2026-10-06T14:03:00Z',false,'2026-10-06T14:02:59Z')),true,'newer observation can represent legitimate reopening');
 assert.equal(m.get('data:snapshot').tasks[0].done,false);
}
{
 const {q,m}=queue(snap('2026-10-06T14:00:00Z',true));
 assert.equal(await q.saveSnapshot(snap('2026-10-06T13:59:00Z',false)),false,'legacy fallback also respects monotonic timestamp');
 assert.equal(m.has('data:snapshot'),false,'rejected legacy input must not poison native storage');
}
{
 const {q,m}=queue();
 const env={DSTA_BRIDGE_TOKEN:'fake',DASHBOARD_USER:'admin',DASHBOARD_PASSWORD:'password',INGEST_TOKEN:'ingest',CHAT_STATE:{getByName(){return new Proxy({}, {get(_,name){return (...args)=>q[name](...args);}});}}};
 const send=body=>worker.fetch(new Request('https://example.test/api/bridge/snapshot',{method:'POST',headers:{authorization:'Bearer fake','content-type':'application/json'},body:JSON.stringify(body)}),env);
 const first=snap('2026-10-06T14:00:02Z',true,'2026-10-06T14:00:01Z');
 assert.equal((await send(first)).status,202);
 assert.equal(m.get('data:snapshot').observationStartedAt,first.observationStartedAt,'ingress preserves observation watermark');
 assert.equal((await send({...first,observationStartedAt:'bad'})).status,400);
 assert.equal((await send({...first,observationStartedAt:'2026-10-06T14:01:00Z'})).status,400);
 assert.equal((await send(snap('2026-10-06T14:02:00Z',false,'2026-10-06T14:00:00Z'))).status,409);
 assert.equal(m.get('data:snapshot').tasks[0].done,true);
}
console.log('snapshot collection watermark rejects delayed publications and legacy bypass, preserving legitimate newer changes');
