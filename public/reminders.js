/* Account reminders. No task/minute content or push endpoints persisted in browser storage. */
(async () => {
  'use strict';
  let session;
  try {const r=await fetch('/api/session',{cache:'no-store'});if(!r.ok)return;session=await r.json();} catch {return;}
  const actor=session.actor.id;
  const accountTag=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(actor))))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  const style=Object.assign(document.createElement('link'),{rel:'stylesheet',href:'/reminders.css'});document.head.append(style);
  const el=(tag,text,cls)=>Object.assign(document.createElement(tag),{...(text!==undefined?{textContent:text}:{}),...(cls?{className:cls}:{})});
  const button=(text,fn)=>{const b=el('button',text);b.type='button';b.addEventListener('click',e=>{e.stopPropagation();void fn(b);});return b;};
  const zone='America/Santiago', labels={none:'Una vez',daily:'Cada día',weekly:'Cada semana',weekdays:'Lunes a viernes'};
  const parts=at=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at).map(p=>[p.type,p.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;};
  const date=at=>new Date(at).toLocaleString('es-CL',{timeZone:zone,dateStyle:'medium',timeStyle:'short'});
  let data={reminders:[],events:[]},history=false,loading=false,returnFocus=null;
  const toggle=button('⏰',()=>open());toggle.id='dsta-reminders-toggle';toggle.setAttribute('aria-label','Recordatorios');toggle.title='Recordatorios';
  document.querySelector('#refresh').before(toggle);
  const dialog=el('dialog',undefined,'reminders-dialog');dialog.id='dsta-reminders';dialog.setAttribute('aria-labelledby','reminders-title');
  const heading=el('header'), title=el('h2','Recordatorios');title.id='reminders-title';heading.append(title,button('Cerrar',()=>dialog.close()));
  const tabs=el('div',undefined,'reminders-tools');const upcoming=button('Próximos y pendientes',()=>{history=false;render();}),past=button('Historial',()=>{history=true;render();});
  tabs.append(button('+ Nuevo recordatorio',()=>edit()),upcoming,past);
  const status=el('p','','reminders-status');status.setAttribute('role','status');
  const list=el('div',undefined,'reminders-list'),devices=el('section',undefined,'reminders-device');
  dialog.append(heading,tabs,status,list,devices);document.body.append(dialog);
  const editor=el('dialog',undefined,'reminders-dialog reminders-editor');editor.setAttribute('aria-labelledby','reminders-editor-title');document.body.append(editor);
  for(const d of [dialog,editor]) {
    d.addEventListener('keydown',e=>{if(e.key==='Escape')e.stopPropagation();});
    d.addEventListener('cancel',e=>e.stopPropagation());
  }
  dialog.addEventListener('close',()=>returnFocus?.focus());
  let editorFocus=null;editor.addEventListener('close',()=>editorFocus?.isConnected&&editorFocus.focus());
  const api=async(path,body)=>{
    const r=await fetch('/api/reminders/'+path,{method:body?'POST':'GET',cache:'no-store',credentials:'same-origin',headers:{'x-dsta-actor':actor,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const payload=await r.json();if(!r.ok)throw Object.assign(new Error(payload.error||'No se pudo guardar.'),{httpStatus:r.status});return payload;
  };
  // Persist only operation identity to recover confirmation after reload. Never resend a mutation
  // under a fresh UUID on uncertain transport; a repeated click reuses the original in-memory body.
  const pendingKey='dsta-reminder-pending:'+actor;
  function persist(value) {try {value?sessionStorage.setItem(pendingKey,JSON.stringify(value)):sessionStorage.removeItem(pendingKey);}catch{}}
  async function mutate(path,body) {
    persist({id:body.id,operationId:body.operationId});
    try {const result=await api(path,body);persist(null);return result;}
    catch(error) {
      if(error.httpStatus) {persist(null);throw error;}
      try {const result=await api('operation?id='+body.operationId);persist(null);return result;}catch{}
      throw new Error('Sin confirmación. Conservamos la solicitud; vuelve a pulsar para consultar o reintentar sin duplicar.');
    }
  }
  async function refresh() {
    if(loading)return;loading=true;
    try {data=await api('list');const count=data.events.filter(e=>!e.attendedAt&&!e.cancelledAt).length;toggle.textContent=count?`⏰ ${count}`:'⏰';toggle.setAttribute('aria-label',`Recordatorios${count?': '+count+' pendientes':''}`);if(dialog.open)render();}
    catch(e){if(dialog.open)status.textContent=e.message;}finally{loading=false;}
  }
  async function open() {returnFocus=document.activeElement;if(!dialog.open)dialog.showModal();status.textContent='Cargando…';await refresh();status.textContent='Horarios de Santiago · Atender un aviso no completa la tarea.';await deviceStatus();}
  function taskLink(container,id,title) {
    if(!id)return;
    const task=typeof tasks!=='undefined'&&tasks.find(t=>t.id===id);
    if(task)container.append(button('Abrir tarea · '+(title||task.title),()=>{dialog.close();showTask(String(id));}));
    else container.append(el('small','La tarea vinculada no está en el portafolio actual.'));
  }
  function operationButton(container,text,path,r,extra={}) {
    let body=null;
    container.append(button(text,async b=>{
      b.disabled=true;status.textContent='Guardando…';body??={id:r.id,revision:r.revision,operationId:crypto.randomUUID(),...extra};
      try {await mutate(path,body);await refresh();status.textContent='✓ Cambio guardado.';}
      catch(e){status.textContent=e.message;b.disabled=false;if(e.httpStatus){body=null;await refresh();}}
    }));
  }
  function render() {
    list.replaceChildren();upcoming.setAttribute('aria-pressed',String(!history));past.setAttribute('aria-pressed',String(history));
    const events=data.events.filter(e=>history?(e.attendedAt||e.cancelledAt):(!e.attendedAt&&!e.cancelledAt));
    for(const e of events) {
      const r=data.reminders.find(r=>r.id===e.reminderId);if(!r)continue;
      const card=el('article',undefined,'reminder-card reminder-due');card.append(el('strong',e.text),el('p',`${date(e.dueAt)} · ${e.cancelledAt?'Cancelado':e.attendedAt?'Atendido':'Pendiente'}`));
      const push={sent:'Aviso enviado al servicio del dispositivo; lectura sin confirmar.',error:'No se pudo enviar el aviso al dispositivo.',pending:'Aviso al dispositivo pendiente.','no-devices':'Sin dispositivo conectado: el aviso queda aquí.'};
      card.append(el('small',push[e.pushState]||''));taskLink(card,e.taskId,e.taskTitle);
      if(!history) {
        const actions=el('div',undefined,'reminders-tools');
        actions.append(button('Editar recordatorio',()=>edit(r)));operationButton(actions,r.repeat==='none'?'Cancelar recordatorio':'Cancelar serie','cancel',r);
        operationButton(actions,'Atendido','attend',r,{eventId:e.id});operationButton(actions,'15 min','snooze',r,{eventId:e.id,minutes:15});operationButton(actions,'1 hora','snooze',r,{eventId:e.id,minutes:60});operationButton(actions,'Mañana 09:00','snooze',r,{eventId:e.id,minutes:'tomorrow'});card.append(actions);
      }
      list.append(card);
    }
    const records=data.reminders.filter(r=>history?['cancelled','attended'].includes(r.status)&&!events.some(e=>e.reminderId===r.id):r.status==='scheduled');
    for(const r of records) {
      const card=el('article',undefined,'reminder-card');card.append(el('strong',r.text),el('p',`${r.nextAt?date(r.nextAt):r.status==='cancelled'?'Cancelado':'Atendido'} · ${labels[r.repeat]}`));taskLink(card,r.taskId,r.taskTitle);
      if(!history) {const actions=el('div',undefined,'reminders-tools');actions.append(button('Editar',()=>edit(r)));operationButton(actions,'Cancelar','cancel',r);card.append(actions);}
      list.append(card);
    }
    if(!list.childElementCount)list.append(el('p',history?'Aún no hay avisos atendidos o cancelados.':'No tienes recordatorios próximos ni avisos pendientes.'));
  }
  function edit(record=null,task=null) {
    editorFocus=document.activeElement;editor.replaceChildren();
    const h=el('h2',record?'Editar recordatorio':'Nuevo recordatorio');h.id='reminders-editor-title';
    const form=el('form'),note=el('p',task?`Vinculado a: ${task.title}`:record?.taskTitle?`Vinculado a: ${record.taskTitle}`:'Recordatorio independiente.');
    function field(label,input){const l=el('label',label);l.append(input);form.append(l);return input;}
    const text=field('Texto del aviso',Object.assign(el('input'),{name:'text',required:true,maxLength:300,value:record?.text||task?.title||''}));
    const local=field('Fecha y hora · Santiago',Object.assign(el('input'),{name:'local',type:'datetime-local',required:true,value:record?.nextAt>Date.now()?parts(record.nextAt):parts(Date.now()+3600000)}));
    const repeat=el('select');repeat.name='repeat';for(const [v,l] of Object.entries(labels))repeat.append(Object.assign(el('option',l),{value:v}));repeat.value=record?.repeat||'none';field('Repetición',repeat);
    form.append(el('small','Las repeticiones conservan la hora de Santiago. Se omite una fecha si esa hora no existe o se repite por el cambio de hora.'));
    const feedback=el('p','','reminders-status');feedback.setAttribute('role','status');
    const actions=el('div',undefined,'reminders-tools'),save=el('button','Guardar recordatorio');save.type='submit';
    actions.append(save,button('Cancelar',()=>editor.close()));form.append(feedback,actions);editor.append(h,note,form);
    let pending=null;
    form.addEventListener('submit',async event=>{
      event.preventDefault();save.disabled=true;feedback.textContent='Guardando…';
      pending??={id:record?.id||crypto.randomUUID(),operationId:crypto.randomUUID(),revision:record?.revision||0,text:text.value,local:local.value,timeZone:zone,repeat:repeat.value,taskId:task?.id??record?.taskId??null};
      for(const input of [text,local,repeat])input.disabled=true;
      try {await mutate('save',pending);editor.close();if(!dialog.open){returnFocus=editorFocus;dialog.showModal();}await refresh();status.textContent='✓ Recordatorio guardado · '+pending.local.replace('T',' ')+' (America/Santiago).';}
      catch(e){feedback.textContent=e.message;save.disabled=false;if(e.httpStatus){pending=null;for(const input of [text,local,repeat])input.disabled=false;}}
    });
    editor.showModal();text.focus();
  }
  let deviceId;try{deviceId=localStorage.getItem('dsta-reminder-device');if(!deviceId){deviceId=crypto.randomUUID();localStorage.setItem('dsta-reminder-device',deviceId);}}catch{deviceId=crypto.randomUUID();}
  const supported=()=>('serviceWorker'in navigator)&&('PushManager'in window)&&('Notification'in window)&&window.isSecureContext;
  async function workerReady() {const registration=await navigator.serviceWorker.getRegistration('/');if(!registration?.active)throw new Error('El dispositivo aún no está listo para avisos. Recarga e inténtalo de nuevo.');return registration;}
  const swMessage=async(binding)=>{
    const registration=await workerReady();const target=registration.active||navigator.serviceWorker.controller;
    if(!target)return;await new Promise((resolve,reject)=>{const channel=new MessageChannel(),timer=setTimeout(()=>reject(new Error('El dispositivo no confirmó la cuenta.')),5000);channel.port1.onmessage=()=>{clearTimeout(timer);resolve();};target.postMessage({type:'DSTA_REMINDER_ACCOUNT',accountTag:binding},[channel.port2]);});
  };
  async function deviceStatus() {
    devices.replaceChildren(el('h3','Avisos en este dispositivo'));
    if(!supported()){devices.append(el('p','Este navegador no admite avisos push. Tus recordatorios seguirán disponibles aquí.'));return;}
    let config;try {config=await api('push-config');}catch(e){devices.append(el('p',e.message));return;}
    if(!config.available){devices.append(el('p','Los avisos al dispositivo estarán disponibles cuando se configure la publicación. Los recordatorios del dashboard ya se pueden usar.'));return;}
    devices.append(el('p',Notification.permission==='denied'?'Notificaciones bloqueadas. Actívalas en la configuración del navegador.':'Activa los avisos para recibirlos aunque el dashboard no esté abierto.'));
    const details=Object.assign(el('input'),{type:'checkbox'}),label=el('label','Mostrar el texto del aviso en pantalla bloqueada (opcional)');label.prepend(details);devices.append(label);
    devices.append(button('Activar / actualizar avisos',async b=>{
      b.disabled=true;
      try {
        if(await Notification.requestPermission()!=='granted')throw new Error('No se concedió permiso. El aviso seguirá en el dashboard.');
        const registration=await workerReady();
        let subscription=await registration.pushManager.getSubscription();
        // Renew when switching accounts; an endpoint from the previous account is invalidated.
        const old=localStorage.getItem('dsta-reminder-account');
        if(subscription&&old!==actor){await subscription.unsubscribe();subscription=null;}
        const bytes=Uint8Array.from(atob(config.publicKey.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-config.publicKey.length%4)%4)),c=>c.charCodeAt(0));
        subscription??=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
        await api('subscribe',{deviceId,subscription:subscription.toJSON(),details:details.checked});
        await swMessage(accountTag);localStorage.setItem('dsta-reminder-account',actor);status.textContent='✓ Avisos activados en este dispositivo.';
      }catch(e){status.textContent=e.message;}finally{b.disabled=false;}
    }),button('Desactivar avisos',async b=>{b.disabled=true;try{await api('unsubscribe',{deviceId});await swMessage('');const reg=await workerReady();await(await reg.pushManager.getSubscription())?.unsubscribe();status.textContent='Avisos desactivados en este dispositivo.';}catch(e){status.textContent=e.message;}finally{b.disabled=false;}}));
  }
  window.DstaReminders={open,refresh,mount(view){if(!view.taskId)return;const task=typeof tasks!=='undefined'&&tasks.find(t=>String(t.id)===String(view.taskId));if(task)document.querySelector('#detail-body')?.prepend(button('⏰ Recordarme',()=>edit(null,task)));},async logout(){if(supported()){try{await swMessage('');const r=await workerReady();await(await r.pushManager.getSubscription())?.unsubscribe();}catch{}}}};
  await refresh();
  if(supported()) {
    try {const old=localStorage.getItem('dsta-reminder-account');if(old&&old!==actor){await swMessage('');const reg=await workerReady();await(await reg.pushManager.getSubscription())?.unsubscribe();localStorage.removeItem('dsta-reminder-account');}}catch{}
    navigator.serviceWorker.addEventListener('message',event=>{if(event.data?.type==='DSTA_OPEN_REMINDER'&&event.data.accountTag===accountTag)void open();});
  }
  // The badge rides on the existing dashboard response. Fetch the list only while it is open.
  window.addEventListener('dsta-reminders-count',event=>{const count=event.detail;toggle.textContent=count?`⏰ ${count}`:'⏰';toggle.setAttribute('aria-label',`Recordatorios${count?': '+count+' pendientes':''}`);if(dialog.open)void refresh();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
  if(new URL(location.href).searchParams.has('reminder')) {const u=new URL(location.href);if(!u.searchParams.get('binding')||u.searchParams.get('binding')===accountTag)void open();u.searchParams.delete('reminder');u.searchParams.delete('binding');historyReplace(u);}
  function historyReplace(u){window.history.replaceState(window.history.state,'',u);}
  try {const pending=JSON.parse(sessionStorage.getItem(pendingKey)||'null');if(pending){const result=await api('operation?id='+pending.operationId);if(result.ok){persist(null);await open();status.textContent='✓ Solicitud anterior confirmada.';}}}catch{status.textContent='Hay una solicitud anterior sin confirmar. Revisa tus recordatorios antes de crear otra.';toggle.title=status.textContent;}
})();
