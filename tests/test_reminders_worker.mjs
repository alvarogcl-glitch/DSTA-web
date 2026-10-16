import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const reminderUrl=new URL('../src/reminders.js',import.meta.url).href;
const source=readFileSync(new URL('../src/worker.js',import.meta.url),'utf8').replace('import { DurableObject } from "cloudflare:workers";','class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}').replaceAll('import("./reminders.js")',`import(${JSON.stringify(reminderUrl)})`);
const {default:worker,DashboardChatQueue}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const origin='https://qa.example',users={},boxes=new Map();
for(const actor of ['qa-a','qa-b','owner']) {const token=actor+'-session',hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('base64url');users[hash]={id:actor,token_hash:hash,email:actor+'@example.test',display_name:actor,...(actor==='owner'?{do_name:'pmo-dsta'}:{})};}
const env={AUTH_MODE:'accounts',DSTA_BRIDGE_TOKEN:'synthetic-bridge',DB:{prepare(){return {bind(hash){return {first:async()=>users[hash]||Object.values(users).find(u=>u.id===hash)||null,run:async()=>({success:true})}}}}},DASHBOARD_DATA:{get:async()=>null},ASSETS:{fetch:async()=>new Response('asset')}};
env.CHAT_STATE={getByName(name){if(!boxes.has(name)){const data=new Map();const ctx={id:{name},storage:{setAlarm:async at=>{ctx.alarm=at},deleteAlarm:async()=>{ctx.alarm=null},kv:{get:k=>structuredClone(data.get(k)),put:(k,v)=>data.set(k,structuredClone(v)),delete:k=>data.delete(k),list:({prefix})=>new Map([...data].filter(([k])=>k.startsWith(prefix)))}}};boxes.set(name,new DashboardChatQueue(ctx,env));}const b=boxes.get(name);return new Proxy(b,{get(t,k){if(k==='fetch')return r=>t.fetch(typeof r==='string'?new Request(r):r);return typeof t[k]==='function'?t[k].bind(t):t[k];}});}};
async function call(path,actor='qa-a',body,extra={}) {return worker.fetch(new Request(origin+path,{method:body?'POST':'GET',headers:{...(actor?{cookie:'__Host-dsta_session='+actor+'-session','x-dsta-actor':actor}:{}),...(body?{origin,'content-type':'application/json'}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})}),env);}
const id=crypto.randomUUID(),operationId=crypto.randomUUID();
const draft={id,operationId,revision:0,text:'Recordatorio privado A',local:'2026-12-01T09:00',timeZone:'America/Santiago',repeat:'none'};
assert.equal((await call('/api/reminders/list',null)).status,401);
assert.equal((await call('/api/reminders/save','qa-a',draft,{'x-dsta-actor':'qa-b'})).status,409);
assert.equal((await call('/api/reminders/save','qa-a',draft,{origin:'https://foreign.example'})).status,403);
assert.equal((await call('/api/reminders/save','qa-a',draft)).status,200);
assert.ok(!JSON.stringify(await (await call('/api/reminders/list','qa-b')).json()).includes(draft.text));
assert.equal((await call('/api/reminders/cancel','qa-b',{id,revision:1,operationId:crypto.randomUUID()})).status,409);
assert.equal((await call('/api/reminders/operation?id='+operationId,'qa-b')).status,404);
assert.equal((await call('/api/reminders/operation?id='+operationId)).status,200);
assert.equal((await call('/api/reminders/save','owner',{...draft,text:'Dueño'})).status,200);assert.ok(boxes.has('pmo-dsta'));
// A model interpretation passes through the real chat queue; only the saved result becomes success.
const job=await (await call('/api/assistant','qa-a',{message:'Recuérdame el 2 de diciembre de 2026 a las 9 revisar informe'})).json();
const next=await (await call('/u/qa-a/api/bridge/next',null,undefined,{authorization:'Bearer synthetic-bridge'})).json();assert.equal(next.job.id,job.id);assert.equal(next.job.reminderMode,true);assert.equal(next.job.reminderContext.reminders.length,1);
assert.ok(!JSON.stringify(next).includes('Dueño'));
const modelReply='```recordatorios\n'+JSON.stringify({action:'save',text:'Revisar informe',local:'2026-12-02T09:00',repeat:'none',taskId:null})+'\n```';
assert.equal((await call('/u/qa-a/api/bridge/complete',null,{id:job.id,reply:modelReply,proposals:[{action:'lt.create',title:'Injected extra task action',execute:true}]},{authorization:'Bearer synthetic-bridge'})).status,200);
const answer=await(await call('/api/assistant?id='+job.id)).json();assert.match(answer.reply,/✓ Recordatorio guardado/);assert.ok(!answer.reply.includes('```'));
assert.equal(answer.proposals.length,0,'reminder mode refuses unrelated task/label actions');
assert.equal((await(await call('/api/reminders/list')).json()).reminders.length,2);
await call('/u/qa-a/api/bridge/complete',null,{id:job.id,reply:modelReply},{authorization:'Bearer synthetic-bridge'});
assert.equal((await(await call('/api/reminders/list')).json()).reminders.length,2,'replayed completion never creates twice');
// Malformed time cannot turn a model claim of success into a persisted reminder.
const badJob=await(await call('/api/assistant','qa-a',{message:'Recuérdame revisar mañana a las 9'})).json();await call('/u/qa-a/api/bridge/next',null,undefined,{authorization:'Bearer synthetic-bridge'});
await call('/u/qa-a/api/bridge/complete',null,{id:badJob.id,reply:'Programado.\n```recordatorios\n'+JSON.stringify({action:'save',text:'QA',local:'no-date'})+'\n```'},{authorization:'Bearer synthetic-bridge'});
assert.match((await(await call('/api/assistant?id='+badJob.id)).json()).reply,/No se guardó/);
const nav=await call('/?reminder=qa-event&binding=qa-binding',null);assert.equal(nav.headers.get('location'),'/login?reminder=qa-event&binding=qa-binding');
assert.equal((await call('/?reminder=https://evil.example&binding=qa',null)).headers.get('location'),'/login');
// Existing Basic mode never enters this feature; old Hermes reminders remain unchanged.
env.AUTH_MODE='legacy';env.DASHBOARD_USER='qa';env.DASHBOARD_PASSWORD='synthetic-password';env.INGEST_TOKEN='qa';
assert.equal((await call('/api/reminders/list',null,undefined,{authorization:'Basic '+btoa('qa:synthetic-password')})).status,404);
console.log('Recordatorios Worker: account authentication, actor binding, CSRF, A/B/owner isolation, chat save proof, replay, validation and legacy OK');
