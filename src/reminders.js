import { sendWebPush, validateSubscription } from './web-push.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPEATS = new Set(['none', 'daily', 'weekly', 'weekdays']);
const reply = (body, status = 200) => new Response(JSON.stringify(body), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const problem = (text, status = 400) => Object.assign(new Error(text), {status});
export function isReminderRequest(message, history=[]) {
  const explicit=/recordatori|recu[eé]rdame|av[ií]same/i.test(message);
  const follows=/^(?:a las? |ma[ñn]ana|el |los |cada |s[ií]\b|canc[eé]la|posp[oó]n|c[aá]mbia|atendido)/i.test(message.trim()) && /recordatori|recu[eé]rdame|av[ií]same/i.test(history.slice(-2).map(h=>h.content).join(' '));
  return explicit||follows;
}
export async function completeReminderChat(box,job,text) {
  const service=new Reminders(box),cacheKey='reminder-chat:'+job.id;
  const cached=service.kv.get(cacheKey);if(cached)return cached.reply;
  const match=String(text||'').match(/```recordatorios\s*([\s\S]*?)```/i);
  if(!match) {
    if(/recu[eé]rdame|av[ií]same|cancela|posp[oó]n/i.test(job.message) && !/[?¿]/.test(String(text||''))) return 'No se guardó ningún cambio. Indica el texto, la fecha y la hora del recordatorio, o usa ⏰ Recordatorios.';
    return String(text||'').replace(/```recordatorios[\s\S]*$/i,'').slice(0,20000);
  }
  let command;try {command=JSON.parse(match[1]);}catch {return 'No se guardó ningún recordatorio: la propuesta no es válida. Inténtalo de nuevo o usa ⏰ Recordatorios.';}
  if(!command||Array.isArray(command)||!['save','cancel','snooze','attend'].includes(command.action)) return 'No se guardaron cambios: acción de recordatorio inválida.';
  // Suggestions and questions never auto-run. A concrete first-person scheduling or management
  // request (or its answer with date/time) is required, independently of the model's execute flag.
  const normalized=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const request=normalized(job.message.trim());
  const follow=/^(?:a las? |manana|el \d|cada |los (?:lunes|martes|miercoles|jueves|viernes)|si\b)/.test(request);
  const intent=follow?normalized(job.history?.filter(h=>h.role==='user').at(-1)?.content)+' '+request:request;
  const permission={save:/recuerdame|avisame|\b(?:crea|programa|agrega|anade|anota|pon|ponme|quiero|necesito|cambia|modifica|edita)\b/,cancel:/\b(?:cancela\w*|anula|elimina|borra)\b/,snooze:/\b(?:pospon\w*|aplaza|retrasa)\b/,attend:/\b(?:marca|atiende|atendido)\b/};
  const informational=/^(?:¿\s*)?(?:como\b|que\b|cuales\b|muestra\b|lista\b|consulta\b|sugiere\b|dame un ejemplo\b|quiero (?:saber|entender)\b)/.test(request);
  if(!permission[command.action].test(intent) || informational) return 'Puedes crear o cambiar ese recordatorio desde ⏰ Recordatorios. Dime «recuérdame…» con fecha y hora para programarlo aquí.';
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(job.id)));
  const hex=[...digest.slice(0,16)].map(b=>b.toString(16).padStart(2,'0')).join('');
  const operationId=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20)}`;
  const existing=job.reminderContext?.reminders?.find(r=>r.id===command.id);
  if(command.id && !existing) return 'No se cambió nada: ese recordatorio no está en tu lista actual.';
  if(command.action!=='save'&&!existing) return 'Indica cuál de tus recordatorios quieres cambiar.';
  const body={id:existing?.id||operationId,operationId,revision:existing?.revision??0};
  if(command.action==='save') Object.assign(body,{text:command.text,local:command.local,timeZone:'America/Santiago',repeat:command.repeat||'none',taskId:command.taskId!==undefined?command.taskId:existing?.taskId??job.task?.id??null});
  if(command.action==='snooze'||command.action==='attend') Object.assign(body,{eventId:command.eventId,minutes:command.minutes});
  const result=await service.fetch(new Request('https://internal/reminders/'+command.action,{method:'POST',body:JSON.stringify(body)}));
  const payload=await result.json();
  if(!result.ok) return 'No se guardó el cambio: '+payload.error;
  const r=payload.reminder;
  const resultText=command.action==='save'?`✓ Recordatorio guardado: «${r.text}» · ${r.local.replace('T',' ')} (America/Santiago)${r.repeat!=='none'?' · '+({daily:'cada día',weekly:'cada semana',weekdays:'lunes a viernes'})[r.repeat]:''}.`:command.action==='cancel'?'✓ Recordatorio cancelado.':command.action==='attend'?'✓ Aviso marcado como atendido.':`✓ Recordatorio pospuesto hasta ${localParts(r.nextAt,r.timeZone).replace('T',' ')} (America/Santiago).`;
  service.kv.put(cacheKey,{reply:resultText,createdAt:Date.now()});return resultText;
}
export function localParts(at, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
export function localInstant(local, timeZone = 'America/Santiago') {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local || '')) throw problem('Indica fecha y hora completas.');
  const nominal = Date.parse(local+'Z');
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0,16)!==local) throw problem('Fecha u hora inválida.');
  try { new Intl.DateTimeFormat('en',{timeZone}).format(); } catch { throw problem('Zona horaria inválida.'); }
  // Sample offsets on both sides of the transition; verify candidates, never silently shift a gap.
  const offsets = new Set([-36,-12,0,12,36].map(h=>{const at=nominal+h*3600000;return Date.parse(localParts(at,timeZone)+'Z')-at;}));
  const candidates = [...offsets].map(offset=>nominal-offset).filter(at=>localParts(at,timeZone)===local);
  if (!candidates.length) throw problem('Esa hora no existe por el cambio de hora. Elige otra.');
  if (candidates.length>1) throw problem('Esa hora ocurre dos veces por el cambio de hora. Elige otra hora.');
  return candidates[0];
}
export function nextOccurrence(reminder, after) {
  if(reminder.repeat==='none') return null;
  const today = localParts(after, reminder.timeZone).slice(0,10), start=reminder.local.slice(0,10);
  const anchor=Date.parse(start+'T12:00Z');
  let day=Date.parse((today>start?today:start)+'T12:00Z');
  for(let i=0;i<370;i++,day+=86400000) {
    const weekday=new Date(day).getUTCDay();
    if(reminder.repeat==='weekdays' && (weekday===0||weekday===6)) continue;
    if(reminder.repeat==='weekly' && Math.round((day-anchor)/86400000)%7!==0) continue;
    let at;try {at=localInstant(new Date(day).toISOString().slice(0,10)+reminder.local.slice(10),reminder.timeZone);} catch {continue;}
    if(at>after) return at;
  }
  throw problem('No se pudo calcular la próxima fecha.');
}
export class Reminders {
  constructor(box, {send=sendWebPush}={}) {this.box=box;this.ctx=box.ctx;this.env=box.env;this.kv=box.ctx.storage.kv;this.send=send;}
  items(prefix) {return [...this.kv.list({prefix})].map(([,v])=>v);}
  async schedule() {
    const pending=this.items('reminder:').filter(r=>r.status==='scheduled' && Number.isFinite(r.nextAt)).map(r=>r.nextAt);
    for(const e of this.items('reminder-event:')) if(!e.attendedAt && !e.cancelledAt && e.retryAt) pending.push(e.retryAt);
    if(pending.length) await this.ctx.storage.setAlarm(Math.max(Date.now()+1000,Math.min(...pending)));
    else await this.ctx.storage.deleteAlarm();
  }
  async fetch(request) {
    const path=new URL(request.url).pathname.split('/').at(-1), body=request.method==='POST'?await request.json():{};
    try {
      if(path==='operation'&&request.method==='GET') {
        const id=new URL(request.url).searchParams.get('id');if(!UUID.test(id||'')) return reply({error:'Identificador inválido.'},400);
        const receipt=this.kv.get('reminder-op:'+id);return receipt?reply(receipt.result):reply({error:'Todavía no hay confirmación guardada.'},404);
      }
      if(path==='list' && request.method==='GET') return reply({reminders:this.items('reminder:').sort((a,b)=>(a.nextAt??Infinity)-(b.nextAt??Infinity)),events:this.items('reminder-event:').map(({deliveries,...e})=>e).sort((a,b)=>b.dueAt-a.dueAt)});
      if(path==='push-config' && request.method==='GET') return reply({available:Boolean(this.env.WEB_PUSH_PUBLIC_KEY&&this.env.WEB_PUSH_PRIVATE_KEY&&this.env.WEB_PUSH_SUBJECT),publicKey:this.env.WEB_PUSH_PUBLIC_KEY||''});
      if(request.method!=='POST') return reply({error:'Método no permitido.'},405);
      if(path==='subscribe') {
        if(!UUID.test(body.deviceId||'') || !validateSubscription(body.subscription)) throw problem('Suscripción de notificaciones inválida.');
        if(!this.env.WEB_PUSH_PUBLIC_KEY || !this.env.WEB_PUSH_PRIVATE_KEY || !this.env.WEB_PUSH_SUBJECT) throw problem('Los avisos al dispositivo aún no están configurados.',503);
        if(!this.kv.get('reminder-device:'+body.deviceId) && this.items('reminder-device:').length>=10) throw problem('Máximo 10 dispositivos. Desactiva uno antes de añadir otro.',409);
        // A push endpoint may only appear once in this account.
        for(const d of this.items('reminder-device:')) if(d.subscription.endpoint===body.subscription.endpoint) this.kv.delete('reminder-device:'+d.deviceId);
        this.kv.put('reminder-device:'+body.deviceId,{deviceId:body.deviceId,subscription:body.subscription,details:body.details===true,accountTag:body.accountTag,sessionHash:body.sessionHash,createdAt:Date.now()});
        return reply({ok:true});
      }
      if(path==='unsubscribe') {if(!UUID.test(body.deviceId||'')) throw problem('Dispositivo inválido.');this.kv.delete('reminder-device:'+body.deviceId);return reply({ok:true});}
      if(path==='logout') {for(const d of this.items('reminder-device:')) if(d.sessionHash===body.sessionHash) this.kv.delete('reminder-device:'+d.deviceId);return reply({ok:true});}
      if(this.env.REMINDERS_PAUSED==='on') return reply({error:'Los recordatorios están temporalmente pausados.'},503);
      if(!['save','cancel','snooze','attend'].includes(path)) return reply({error:'No encontrado.'},404);
      if(!UUID.test(body.id||'') || !UUID.test(body.operationId||'') || !Number.isInteger(body.revision)) throw problem('Solicitud inválida.');
      const key='reminder:'+body.id, opKey='reminder-op:'+body.operationId;
      const replay=this.kv.get(opKey);
      if(replay) {
        if(replay.fingerprint!==JSON.stringify({path,body})) throw problem('La solicitud ya se usó con otros datos.',409);
        await this.schedule();return reply(replay.result);
      }
      // Resolve task scope before the synchronous compare/write; reread after this await.
      let task=null;
      if(path==='save' && body.taskId!=null) {
        const snapshot=await this.box.snapshot();task=snapshot?.tasks?.find(t=>t.id===body.taskId);
        if(!task) throw problem('La tarea no pertenece a tu portafolio actual.',403);
      }
      const previous=this.kv.get(key);
      if((previous?.revision??0)!==body.revision) throw problem('El recordatorio cambió. Actualiza y vuelve a intentarlo.',409);
      if(path!=='save' && !previous) throw problem('Recordatorio no encontrado.',404);
      const now=Date.now();let record;
      if(path==='save') {
        if(typeof body.text!=='string'||!body.text.trim()||body.text.length>300||!REPEATS.has(body.repeat)||body.timeZone!=='America/Santiago') throw problem('Revisa el texto, la repetición y la zona horaria.');
        if((!previous||!['scheduled','due'].includes(previous.status)) && this.items('reminder:').filter(r=>['scheduled','due'].includes(r.status)).length>=200) throw problem('Máximo 200 recordatorios activos.',409);
        const at=localInstant(body.local,body.timeZone);
        if(at<=now||at>now+366*86400000) throw problem('Elige una fecha futura dentro de los próximos 12 meses.');
        if(body.repeat==='weekdays' && [0,6].includes(new Date(body.local.slice(0,10)+'T12:00Z').getUTCDay())) throw problem('Para días hábiles, elige una fecha inicial de lunes a viernes.');
        record={id:body.id,text:body.text.trim(),local:body.local,timeZone:body.timeZone,repeat:body.repeat,taskId:task?.id??null,taskTitle:task?.title??'',nextAt:at,status:'scheduled',createdAt:previous?.createdAt??now};
      } else {
        record={...previous};
        if(path==='cancel') {record.status='cancelled';record.nextAt=null;}
        if(path==='snooze') {
          if(record.status==='cancelled') throw problem('El recordatorio está cancelado.',409);
          const event=this.kv.get('reminder-event:'+body.eventId);
          if(!event||event.reminderId!==record.id||event.attendedAt||event.cancelledAt) throw problem('El aviso ya fue atendido o cambió.',409);
          if(![15,60].includes(body.minutes)&&body.minutes!=='tomorrow') throw problem('Plazo inválido.');
          record.nextAt=body.minutes==='tomorrow'?localInstant(new Date(Date.parse(localParts(now,record.timeZone).slice(0,10)+'T12:00Z')+86400000).toISOString().slice(0,10)+'T09:00',record.timeZone):now+body.minutes*60000;
          record.status='scheduled';event.attendedAt=now;event.retryAt=null;this.kv.put('reminder-event:'+event.id,event);
        }
        if(path==='attend') {
          const event=this.kv.get('reminder-event:'+body.eventId);
          if(!event||event.reminderId!==record.id||event.cancelledAt) throw problem('Aviso no encontrado.',404);
          event.attendedAt=now;event.retryAt=null;this.kv.put('reminder-event:'+event.id,event);
          if(record.repeat==='none' && record.status==='due') record.status='attended';
        }
      }
      if(path==='save'||path==='cancel') for(const event of this.items('reminder-event:')) if(event.reminderId===record.id&&!event.attendedAt&&!event.cancelledAt) {event.cancelledAt=now;event.retryAt=null;this.kv.put('reminder-event:'+event.id,event);}
      record.revision=(previous?.revision??0)+1;record.updatedAt=now;this.kv.put(key,record);
      const result={ok:true,reminder:record};this.kv.put(opKey,{fingerprint:JSON.stringify({path,body}),result,at:now});
      // A replay after a failure in setAlarm re-arms the persisted record before confirming.
      await this.schedule();return reply(result);
    } catch(e) {if(e.status) return reply({error:e.message},e.status);throw e;}
  }
  async alarm() {
    if(this.env.REMINDERS_PAUSED==='on') {await this.ctx.storage.deleteAlarm();return;}
    const now=Date.now();
    for(const r of this.items('reminder:')) {
      if(r.status!=='scheduled'||r.nextAt>now) continue;
      const id=r.id+'-'+r.nextAt, key='reminder-event:'+id;
      if(!this.kv.get(key)) this.kv.put(key,{id,reminderId:r.id,revision:r.revision,text:r.text,taskId:r.taskId,taskTitle:r.taskTitle,dueAt:r.nextAt,createdAt:now,deliveries:{},pushState:'pending',retryAt:now});
      r.nextAt=nextOccurrence(r,now);r.status=r.nextAt?'scheduled':'due';this.kv.put('reminder:'+r.id,r);
    }
    // Arm a recovery alarm before performing network I/O (a terminated invocation is retried).
    const pending=this.items('reminder-event:').filter(e=>!e.attendedAt&&!e.cancelledAt&&e.retryAt&&e.retryAt<=now).slice(0,5);
    if(pending.length) await this.ctx.storage.setAlarm(now+60000);
    for(const e of pending) await this.deliver(e);
    // Ninety days of history and operation receipts; pending notices stay at least this long.
    for(const prefix of ['reminder-event:','reminder-op:','reminder-chat:']) for(const [key,value] of this.kv.list({prefix})) if((value.createdAt??value.at)<now-90*86400000) this.kv.delete(key);
    await this.schedule();
  }
  async deliver(event) {
    const devices=this.items('reminder-device:'), now=Date.now();
    if(!devices.length) {event.pushState='no-devices';event.retryAt=null;this.kv.put('reminder-event:'+event.id,event);return;}
    for(const d of devices) {
      const live=this.kv.get('reminder-event:'+event.id);
      if(!live||live.attendedAt||live.cancelledAt) return;
      const delivery=live.deliveries[d.deviceId]||{attempts:0};
      if(delivery.state==='sent'||delivery.state==='expired'||delivery.attempts>=3) continue;
      if(now-event.dueAt>86400000) {delivery.state='expired';live.deliveries[d.deviceId]=delivery;this.kv.put('reminder-event:'+live.id,live);continue;}
      if(this.env.DB && d.sessionHash) {
        const session=await this.env.DB.prepare('SELECT s.token_hash FROM sessions s JOIN users u ON u.id = s.actor_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL').bind(d.sessionHash,Math.floor(now/1000)).first();
        if(!session) {this.kv.delete('reminder-device:'+d.deviceId);continue;}
      }
      // Collapse retries at the OS by stable event tag; acceptance by a push service is not a read receipt.
      delivery.attempts++;delivery.state='sending';live.deliveries[d.deviceId]=delivery;this.kv.put('reminder-event:'+live.id,live);
      let status=0;
      try {status=await this.send(d.subscription,{title:'DSTA · Recordatorio',body:d.details?event.text:'Tienes un recordatorio pendiente.',eventId:event.id,reminderId:event.reminderId,accountTag:d.accountTag},this.env,()=>{
        const current=this.kv.get('reminder-event:'+event.id);return current&&!current.attendedAt&&!current.cancelledAt&&this.kv.get('reminder-device:'+d.deviceId);
      });} catch { /* bounded retry, no endpoint or provider response in logs */ }
      const current=this.kv.get('reminder-event:'+event.id);if(!current||current.attendedAt||current.cancelledAt) return;
      if(status===404||status===410) {this.kv.delete('reminder-device:'+d.deviceId);delivery.state='expired';}
      else delivery.state=status>=200&&status<300?'sent':'error';
      current.deliveries[d.deviceId]=delivery;this.kv.put('reminder-event:'+current.id,current);
    }
    const current=this.kv.get('reminder-event:'+event.id);if(!current||current.attendedAt||current.cancelledAt) return;
    const values=Object.values(current.deliveries), retry=values.some(v=>v.state==='error'&&v.attempts<3);
    current.pushState=values.some(v=>v.state==='sent')?'sent':values.length?'error':'no-devices';
    current.retryAt=retry?now+60000:null;this.kv.put('reminder-event:'+current.id,current);
  }
}
