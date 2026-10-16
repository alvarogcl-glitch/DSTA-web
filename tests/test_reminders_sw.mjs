import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const handlers={},db=new Map(),notifications=new Map(),clients=[];
// IDB completion ordering is explicit; test the service worker's binding and notification lifecycle.
const indexedDB={open(){const request={};queueMicrotask(()=>{
  request.result={createObjectStore(){},close(){},transaction(){const tx={objectStore:()=>({get:key=>op(()=>db.get(key)),put:(value,key)=>op(()=>{db.set(key,value);return key;})})};function op(fn){const r={};queueMicrotask(()=>{r.result=fn();r.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.());});return r;}return tx;}};
  request.onsuccess?.();
});return request;}};
const self={location:{origin:'https://qa.example'},addEventListener:(key,fn)=>handlers[key]=fn,registration:{getNotifications:async()=>[...notifications.values()],showNotification:async(title,options)=>notifications.set(options.tag,{...options,title,close(){notifications.delete(options.tag);}})},clients:{matchAll:async()=>clients,openWindow:async url=>{clients.push({url});}}};
vm.runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),{self,indexedDB,URL,Response,queueMicrotask});
async function event(name,body){let pending;handlers[name]({...body,waitUntil:p=>pending=p});await pending;}
const push=payload=>event('push',{data:{json:()=>payload}});
const bind=tag=>event('message',{data:{type:'DSTA_REMINDER_ACCOUNT',accountTag:tag},ports:[{postMessage(){}}]});
const p={accountTag:'account-a',eventId:'qa-event',body:'Aviso QA'};
await push(p);assert.equal(notifications.size,0,'no binding means no private notification');
await bind('account-a');await push(p);await push(p);assert.equal(notifications.size,1,'stable occurrence tag collapses redelivery');
assert.equal([...notifications.values()][0].body,p.body);
await event('notificationclick',{notification:[...notifications.values()][0]});assert.equal(notifications.size,0);assert.match(clients[0].url,/^\/\?reminder=qa-event&binding=account-a$/);
clients.length=0;let focused=false,received;
clients.push({url:'https://qa.example/',focus:async()=>{focused=true;},postMessage:p=>received=p});await push(p);await event('notificationclick',{notification:[...notifications.values()][0]});assert.ok(focused);assert.equal(received.accountTag,'account-a');
await bind('account-b');await push(p);assert.equal(notifications.size,0,'switching account refuses queued pushes for previous user');
await push({...p,accountTag:'account-b'});assert.equal(notifications.size,1);await bind('');assert.equal(notifications.size,0,'logout closes visible notifications');await push({...p,accountTag:'account-b'});assert.equal(notifications.size,0);
console.log('Reminder SW: binding, push, redelivery tags, clicks, account switch, logout and queued-push privacy OK');
