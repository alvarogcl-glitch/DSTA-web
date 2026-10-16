'use strict';
// Only a generic offline page is cached. Never cache credentials, dashboard data,
// chat, minutes or mutations. All application requests keep their network behavior.
const OFFLINE_CACHE = 'dsta-offline-v1';
const OFFLINE_URL = '/offline';
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const response = await fetch(OFFLINE_URL, { cache: 'reload', credentials: 'omit' });
    if (!response.ok) throw new Error('Offline page unavailable');
    const cache = await caches.open(OFFLINE_CACHE);
    await cache.put(OFFLINE_URL, response);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('dsta-offline-') && name !== OFFLINE_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || event.request.mode !== 'navigate' ||
      url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    try {
      return await fetch(event.request);
    } catch {
      return await caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE }) ||
        new Response('Sin conexión. Reconéctate y abre DSTA nuevamente.', {
          status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' }
        });
    }
  })());
});

// Only the active account binding is stored, without task text, credentials or push endpoints.
function reminderBinding(value) {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('dsta-reminder-binding',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('binding');
    request.onerror=()=>reject(new Error('No se pudo abrir la cuenta de avisos.'));
    request.onsuccess=()=>{
      const db=request.result,tx=db.transaction('binding',value===undefined?'readonly':'readwrite'),store=tx.objectStore('binding');
      const op=value===undefined?store.get('active'):store.put(value,'active');let result='';op.onsuccess=()=>{result=op.result||'';};
      tx.oncomplete=()=>{db.close();resolve(value===undefined?result:value);};tx.onerror=()=>{db.close();reject(new Error('No se pudo guardar la cuenta de avisos.'));};
    };
  });
}
self.addEventListener('message',event=>{
  if(event.data?.type!=='DSTA_REMINDER_ACCOUNT'||typeof event.data.accountTag!=='string'||event.data.accountTag.length>100)return;
  event.waitUntil((async()=>{
    await reminderBinding(event.data.accountTag);
    for(const notice of await self.registration.getNotifications())notice.close();
    event.ports[0]?.postMessage({ok:true});
  })());
});
self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let payload;try{payload=event.data?.json();}catch{return;}
    if(!payload?.eventId||typeof payload.eventId!=='string'||payload.eventId.length>100||!payload.accountTag||payload.accountTag!==await reminderBinding())return;
    // The same occurrence replaces its notification on retry, instead of stacking duplicates.
    await self.registration.showNotification('DSTA · Recordatorio',{
      body:typeof payload.body==='string'?payload.body.slice(0,300):'Tienes un recordatorio pendiente.',
      icon:'/icons/dsta-192.png',badge:'/icons/dsta-192.png',tag:'dsta-reminder-'+payload.eventId,
      renotify:false,data:{eventId:payload.eventId,accountTag:payload.accountTag},
    });
  })());
});
self.addEventListener('notificationclick',event=>{
  if(!event.notification.tag?.startsWith('dsta-reminder-'))return;
  event.notification.close();event.waitUntil((async()=>{
    const {eventId,accountTag}=event.notification.data||{};if(!eventId||accountTag!==await reminderBinding())return;
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows)if(new URL(client.url).origin===self.location.origin&&new URL(client.url).pathname==='/'){
      await client.focus();client.postMessage({type:'DSTA_OPEN_REMINDER',eventId,accountTag});return;
    }
    await self.clients.openWindow('/?reminder='+encodeURIComponent(eventId)+'&binding='+encodeURIComponent(accountTag));
  })());
});
