import assert from 'node:assert/strict';
import {createECDH,randomBytes} from 'node:crypto';
import {Reminders} from '../src/reminders.js';
const realNow=Date.now;let now=Date.parse('2026-10-15T12:00Z');Date.now=()=>now;
const point=createECDH('prime256v1');point.generateKeys();
const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/synthetic',keys:{auth:randomBytes(16).toString('base64url'),p256dh:point.getPublicKey().toString('base64url')}};
function fixture(send) {
  const data=new Map();const box={env:{WEB_PUSH_PUBLIC_KEY:'configured',WEB_PUSH_PRIVATE_KEY:'configured',WEB_PUSH_SUBJECT:'mailto:qa@example.test'},ctx:{storage:{setAlarm:async at=>box.alarmAt=at,deleteAlarm:async()=>box.alarmAt=null,kv:{get:k=>structuredClone(data.get(k)),put:(k,v)=>data.set(k,structuredClone(v)),delete:k=>data.delete(k),list:({prefix})=>new Map([...data].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>[k,structuredClone(v)]))}}},snapshot:async()=>null};
  const service=new Reminders(box,{send});const call=(path,body)=>service.fetch(new Request('https://qa/reminders/'+path,{method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})}));return {data,box,service,call};
}
async function prepare(f,details=false) {
  const deviceId=crypto.randomUUID();assert.equal((await f.call('subscribe',{deviceId,subscription,accountTag:'qa',sessionHash:'synthetic-session',details})).status,200);
  const id=crypto.randomUUID(),operationId=crypto.randomUUID();const body={id,operationId,revision:0,text:'Contenido privado',local:'2026-10-15T10:00',timeZone:'America/Santiago',repeat:'none'};
  assert.equal((await f.call('save',body)).status,200);return {id,body,deviceId};
}
try {
  let sends=0;const a=fixture(async(s,p,env,active)=>{sends++;assert.equal(p.body,'Tienes un recordatorio pendiente.');assert.ok(active());return 503;});
  const {id}=await prepare(a);now=Date.parse('2026-10-15T13:00:01Z');await a.service.alarm();
  let event=[...a.data].find(([k])=>k.startsWith('reminder-event:'))[1];assert.equal(event.pushState,'error');assert.equal(sends,1);assert.ok(a.box.alarmAt>now);
  now+=60001;await a.service.alarm();now+=60001;await a.service.alarm();now+=60001;await a.service.alarm();
  assert.equal(sends,3,'retries stop after three attempts');assert.equal(a.box.alarmAt,null);
  now=Date.parse('2026-10-15T12:00Z');let expiredSends=0;const b=fixture(async()=>{expiredSends++;return 410;});const db=await prepare(b);
  now=Date.parse('2026-10-15T13:00:01Z');await b.service.alarm();assert.equal(b.data.has('reminder-device:'+db.deviceId),false,'expired endpoint removed');await b.service.alarm();assert.equal(expiredSends,1);
  now=Date.parse('2026-10-15T12:00Z');let disabledSends=0;const c=fixture(async()=>{disabledSends++;return 201;});await prepare(c);c.box.env.DB={prepare(){return {bind(){return {first:async()=>null}}}}};
  now=Date.parse('2026-10-15T13:00:01Z');await c.service.alarm();assert.equal(disabledSends,0,'revoked/expired session never sends');
  // Cancellation concurrent with network preparation fences the send through the live callback.
  now=Date.parse('2026-10-15T12:00Z');let d,dr;d=fixture(async(s,p,env,active)=>{await d.call('cancel',{id:dr.id,revision:1,operationId:crypto.randomUUID()});assert.equal(Boolean(active()),false);return 410;});dr=await prepare(d);
  now=Date.parse('2026-10-15T13:00:01Z');await d.service.alarm();assert.equal(d.data.get('reminder:'+dr.id).status,'cancelled');assert.ok([...d.data.values()].find(v=>v.reminderId===dr.id).cancelledAt);
  // Storage committed but setAlarm failed: retrying the same operation re-arms it, one record.
  now=Date.parse('2026-10-15T12:00Z');const e=fixture(async()=>201),oldSet=e.box.ctx.storage.setAlarm;e.box.ctx.storage.setAlarm=async()=>{throw new Error('Synthetic alarm fault');};
  const body={id:crypto.randomUUID(),operationId:crypto.randomUUID(),revision:0,text:'QA',local:'2026-10-15T10:00',timeZone:'America/Santiago',repeat:'none'};
  await assert.rejects(()=>e.call('save',body));e.box.ctx.storage.setAlarm=oldSet;assert.equal((await e.call('save',body)).status,200);assert.equal([...e.data.keys()].filter(k=>k.startsWith('reminder:')).length,1);assert.equal(e.box.alarmAt,Date.parse('2026-10-15T13:00Z'));
  assert.equal((await e.call('save',{...body,text:'Changed with same op'})).status,409);
  now=Date.parse('2026-10-15T12:00Z');let pauseSends=0;const paused=fixture(async()=>{pauseSends++;return 201;});const pr=await prepare(paused);paused.box.env.REMINDERS_PAUSED='on';now=Date.parse('2026-10-15T13:00:01Z');await paused.service.alarm();assert.equal(pauseSends,0);assert.equal(paused.box.alarmAt,null);assert.equal((await paused.call('save',pr.body)).status,503);assert.equal(paused.data.get('reminder:'+pr.id).status,'scheduled','pause preserves data');
  console.log('Reminder delivery: privacy default, bounded retries, expired endpoints, revoked sessions, cancellation and alarm fault recovery OK');
} finally {Date.now=realNow;}
