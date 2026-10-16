import assert from 'node:assert/strict';
import { Reminders, localInstant, nextOccurrence } from '../src/reminders.js';
const now = Date.now;
let clock = Date.parse('2026-10-15T12:00:00Z');
Date.now = () => clock;
function fixture() {
  const data = new Map(); let alarm = null;
  const kv = {get:k=>structuredClone(data.get(k)),put:(k,v)=>data.set(k,structuredClone(v)),delete:k=>data.delete(k),list:({prefix})=>new Map([...data].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>[k,structuredClone(v)]))};
  const ctx = {storage:{kv,setAlarm:async t=>{alarm=Number(t)},deleteAlarm:async()=>{alarm=null}}};
  const box = {ctx,env:{},snapshot:async()=>({tasks:[{id:7,title:'QA propia',project_id:3}]})};
  const api = new Reminders(box);
  const call = (action,body) => api.fetch(new Request('https://internal/reminders/'+action,{method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})}));
  return {data,box,api,call,alarm:()=>alarm};
}
try {
  const a=fixture(),b=fixture(),id=crypto.randomUUID(),operationId=crypto.randomUUID();
  const draft={id,operationId,revision:0,text:'Revisar informe',local:'2026-10-15T10:00',timeZone:'America/Santiago',repeat:'none',taskId:7};
  assert.equal((await a.call('save',draft)).status,200);
  assert.equal(a.alarm(),Date.parse('2026-10-15T13:00:00Z'));
  assert.equal((await (await a.call('save',draft)).json()).reminder.revision,1,'same UUID recovers lost response');
  assert.equal((await a.call('save',{...draft,operationId:crypto.randomUUID()})).status,409);
  assert.equal((await b.call('save',draft)).status,200,'same UUID belongs to separate account');
  assert.equal((await a.call('save',{...draft,id:crypto.randomUUID(),operationId:crypto.randomUUID(),taskId:999})).status,403);
  assert.equal((await a.call('save',{...draft,id:crypto.randomUUID(),operationId:crypto.randomUUID(),local:'2026-10-14T09:00'})).status,400);
  clock=Date.parse('2026-10-15T13:00:01Z');await a.api.alarm();await a.api.alarm();
  let list=await (await a.call('list')).json();
  assert.equal(list.events.length,1,'repeated alarm has one occurrence');assert.equal(list.reminders[0].status,'due');
  assert.equal((await (await b.call('list')).json()).events.length,0);
  assert.equal(list.events[0].pushState,'no-devices');
  const eventId=list.events[0].id;
  assert.equal((await a.call('attend',{id,revision:1,operationId:crypto.randomUUID(),eventId})).status,200);
  list=await (await a.call('list')).json();assert.ok(list.events[0].attendedAt);assert.equal(list.reminders[0].status,'attended');
  // Cancellation/repetition and a stalled runtime: only one catch-up notice, next future local time.
  const rid=crypto.randomUUID();clock=Date.parse('2026-10-16T12:00Z');
  await a.call('save',{...draft,id:rid,operationId:crypto.randomUUID(),local:'2026-10-16T10:00',repeat:'weekdays'});
  clock=Date.parse('2026-10-19T14:00Z');await a.api.alarm();
  list=await (await a.call('list')).json();const repeated=list.reminders.find(r=>r.id===rid);
  assert.equal(repeated.nextAt,Date.parse('2026-10-20T13:00Z'));assert.equal(list.events.filter(e=>e.reminderId===rid).length,1);
  await a.call('cancel',{id:rid,revision:1,operationId:crypto.randomUUID()});
  clock+=86400000*8;await a.api.alarm();assert.equal((await (await a.call('list')).json()).events.filter(e=>e.reminderId===rid).length,1);
  // Chile's spring gap is rejected; repeated hours need explicit choice instead of silently moving.
  assert.throws(()=>localInstant('2026-09-06T00:30','America/Santiago'),/no existe/);
  assert.throws(()=>localInstant('2026-04-04T23:30','America/Santiago'),/dos veces/);
  const before=Date.parse('2026-09-05T13:00Z');
  assert.equal(nextOccurrence({local:'2026-09-05T09:00',timeZone:'America/Santiago',repeat:'daily'},before),Date.parse('2026-09-06T12:00Z'));
  // SSRF and malformed push keys are rejected before any network request.
  for(const endpoint of ['https://127.0.0.1/push','https://evil.example/push','http://fcm.googleapis.com/x'])
    assert.equal((await a.call('subscribe',{deviceId:crypto.randomUUID(),subscription:{endpoint,keys:{auth:'x',p256dh:'x'}}})).status,400);
  assert.equal((await a.call('push-config')).status,200);
  console.log('Recordatorios: scope, replay, concurrent edits, occurrences, attendance, cancel, catch-up, DST and push validation OK');
} finally {Date.now=now;}
