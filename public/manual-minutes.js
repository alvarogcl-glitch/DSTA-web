(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const states={draft:'Borrador',queued:'En cola de análisis',running:'Procesando con IA',processed:'Procesada · revisa la bandeja 🔔',error:'Error de análisis · puedes reintentar'};
  let actor=null,key=null,ready=false,cache={},server={},active=null,localWrites=Promise.resolve(),unsaved=false;
  const localName=()=>`dsta-manual-v1:${actor.id}`;
  const api=async(path='',body)=>{
    const response=await fetch('/api/manual-minutes'+path,{method:body?'POST':'GET',cache:'no-store',credentials:'same-origin',
      headers:{'content-type':'application/json','x-dsta-actor':actor.id},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();
    if(!response.ok)throw Error(result.error||'No se pudo guardar la minuta.');
    return result;
  };
  const bytesTo64=bytes=>btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(''));
  const from64=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
  async function persistLocal(draft=active?.draft){
    if(!draft)return;
    const data=JSON.stringify(draft),name=localName()+':'+draft.id;
    const write=async()=>{
      const iv=crypto.getRandomValues(new Uint8Array(12));
      const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(data));
      localStorage.setItem(name,JSON.stringify({iv:bytesTo64(iv),data:bytesTo64(new Uint8Array(encrypted))}));
    };
    localWrites=localWrites.catch(()=>{}).then(write);
    return localWrites;
  }
  async function load(){
    const payload=await api();server=Object.fromEntries(payload.drafts.map(d=>[d.id,d]));
    if(!key){
      const raw=from64(payload.recoveryKey.replaceAll('-','+').replaceAll('_','/'));
      key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
      try{for(let i=0;i<localStorage.length;i++){
        const name=localStorage.key(i);if(!name.startsWith(localName()+':'))continue;
        try{
          const value=JSON.parse(localStorage.getItem(name));
          const draft=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(value.iv)},key,from64(value.data))));cache[draft.id]=draft;
        }catch{window.DstaToast?.show('Una copia local no pudo recuperarse. Las versiones guardadas en tu cuenta siguen disponibles.',false);}
      }}catch{window.DstaToast?.show('Recuperación local no disponible. Puedes guardar y recuperar borradores desde tu cuenta.',false);}
    }
    // Remote state wins after submission. An unsynced local draft stays intact, including conflicts.
    for(const d of payload.drafts)if(!cache[d.id]||d.status!=='draft'||!cache[d.id].dirty)cache[d.id]={...d,dirty:false};
  }
  const dateInput=d=>{const date=new Date(d);return Number.isFinite(date.getTime())?new Date(date-date.getTimezoneOffset()*60000).toISOString().slice(0,16):'';};
  const localISO=date=>{
    const offset=-date.getTimezoneOffset(),sign=offset>=0?'+':'-',pad=n=>String(n).padStart(2,'0');
    return new Date(date.getTime()+offset*60000).toISOString().slice(0,19)+sign+pad(Math.floor(Math.abs(offset)/60))+':'+pad(Math.abs(offset)%60);
  };
  const contextText=c=>[...(c.sections||[]),...(c.projectIds||[]).map(id=>projects.find(p=>p.id===id)?.title||`Línea ${id}`),...(c.taskIds||[]).map(id=>`#${window.DstaTaskNumber?.(id)??id}`)].join(' · ')||'Sin selección';
  function contextFor(text,title){
    const ids=[...text.matchAll(/(?:^|\n)\s*-?\s*#(\d+)\s/g)].map(m=>Number(m[1]));
    const selected=tasks.filter(t=>ids.includes(t.num??t.id));
    const lines=projects.filter(p=>text.split('\n').includes('###### #'+p.title));
    return {taskIds:selected.map(t=>t.id),projectIds:[...new Set([...lines.map(p=>p.id),...selected.map(t=>t.project_id)])],sections:[title]};
  }
  function newDraft(title='',content=''){
    return {id:crypto.randomUUID(),revision:0,title:title||'Minuta de reunión',date:localISO(new Date()),content,
      context:contextFor(content,title||'Registro manual'),status:'draft',dirty:true,updatedAt:new Date().toISOString()};
  }
  function toolbar(field,container,onChange){
    const bar=document.createElement('div');bar.className='manual-tools';bar.setAttribute('aria-label','Formato de texto');
    for(const [label,kind] of [['Negrita','bold'],['Cursiva','italic'],['Lista numerada','number'],['Viñetas','bullet']]){
      const button=Object.assign(document.createElement('button'),{type:'button',textContent:label});
      button.addEventListener('click',()=>{
        const start=field.selectionStart,end=field.selectionEnd,text=field.value.slice(start,end)||'texto';
        const value=kind==='bold'?`**${text}**`:kind==='italic'?`*${text}*`:text.split('\n').map((line,i)=>(kind==='number'?`${i+1}. `:'- ')+line).join('\n');
        field.setRangeText(value,start,end,'select');field.focus();onChange();
      });bar.append(button);
    }
    container.insertBefore(bar,field);
  }
  function editor(container,draft,field,copyButton){
    active={container,draft,field};cache[draft.id]=draft;container.classList.add('manual-editor');field.maxLength=60000;
    const meta=document.createElement('div');meta.className='manual-meta';
    meta.innerHTML=`<label>Título de la minuta<input maxlength="200" data-title value="${esc(draft.title)}"></label><label>Fecha y hora (hora local)<input type="datetime-local" data-date value="${dateInput(draft.date)}"></label><div class="manual-context">Contexto: ${esc(contextText(draft.context))}</div>`;
    container.insertBefore(meta,field);const title=meta.querySelector('[data-title]'),date=meta.querySelector('[data-date]');
    const buttons=container.querySelector('.minute-actions')||document.createElement('div');buttons.classList.add('manual-buttons');
    buttons.insertAdjacentHTML('beforeend','<button type="button" data-save>Guardar borrador</button><button type="button" data-submit>Guardar y procesar minuta</button><button type="button" data-preview>Vista previa</button>');
    if(copyButton&&!buttons.contains(copyButton))buttons.prepend(copyButton);
    const status=document.createElement('span');status.className='manual-status';status.setAttribute('role','status');
    const preview=document.createElement('div');preview.className='manual-preview';preview.hidden=true;
    container.append(buttons,status,preview);
    let timer=null,busy=false,pendingSave=null;
    const message=(text,error=false)=>{status.textContent=text;status.classList.toggle('manual-error',error);};
    const renderStatus=()=>{
      const locked=draft.status!=='draft';field.readOnly=locked;title.disabled=date.disabled=locked;
      container.querySelectorAll('.manual-tools button').forEach(b=>b.disabled=locked);
      buttons.querySelector('[data-save]').disabled=locked||busy;
      buttons.querySelector('[data-submit]').disabled=busy||!['draft','error'].includes(draft.status);
      buttons.querySelector('[data-submit]').textContent=draft.status==='error'?'Reintentar procesamiento':'Guardar y procesar minuta';
      message(states[draft.status]+(draft.error?' · '+draft.error:''));
    };
    async function sync(){
      if(pendingSave){await pendingSave;if(draft.dirty)return sync();return;}
      if(!draft.dirty||draft.status!=='draft')return;
      const request=draft.pendingRequest||{id:draft.id,revision:draft.revision,operationId:crypto.randomUUID(),title:draft.title,date:draft.date,content:draft.content,context:draft.context};
      draft.pendingRequest=request;
      await persistLocal(draft).catch(()=>message('Recuperación local no disponible · guardando en tu cuenta…',true));
      const run=async()=>{
        const result=await api('',request);
        const unchanged=draft.title===request.title&&draft.date===request.date&&draft.content===request.content;
        Object.assign(draft,{revision:result.revision,status:result.status,dirty:!unchanged,pendingRequest:null});
        server[draft.id]=result;await persistLocal(draft).catch(()=>{});unsaved=draft.dirty;
        message(unchanged?'✓ Borrador guardado en tu cuenta':'Hay cambios nuevos por guardar');
      };
      pendingSave=run();try{await pendingSave;}finally{pendingSave=null;}
      if(draft.dirty)return sync();
    }
    function changed(){
      if(draft.status!=='draft')return;
      draft.title=title.value;draft.content=field.value;
      if(date.value)draft.date=localISO(new Date(date.value));else draft.date='';
      draft.dirty=true;draft.updatedAt=new Date().toISOString();unsaved=true;
      persistLocal(draft).then(()=>message('Borrador protegido en este dispositivo · guardando en tu cuenta…')).catch(()=>message('No se pudo guardar en este dispositivo. Mantén esta ventana abierta y guarda en tu cuenta.',true));
      clearTimeout(timer);timer=setTimeout(()=>sync().catch(e=>message(e.message+' · tu texto se conserva para reintentar.',true)),2500);
    }
    for(const input of [field,title,date])input.addEventListener('input',changed);
    toolbar(field,container,changed);
    buttons.querySelector('[data-save]').addEventListener('click',()=>sync().catch(e=>message(e.message,true)));
    buttons.querySelector('[data-submit]').addEventListener('click',async()=>{
      if(busy)return;busy=true;renderStatus();clearTimeout(timer);
      try{await sync();const result=await api('/submit',{id:draft.id,revision:draft.revision});Object.assign(draft,result,{dirty:false});await persistLocal(draft).catch(()=>{});unsaved=false;renderStatus();}
      catch(e){message(e.message+' · el borrador se conserva.',true);}finally{busy=false;renderControls();}
    });
    function renderControls(){buttons.querySelector('[data-submit]').disabled=busy||!['draft','error'].includes(draft.status);buttons.querySelector('[data-save]').disabled=busy||draft.status!=='draft';}
    buttons.querySelector('[data-preview]').addEventListener('click',()=>{
      preview.hidden=!preview.hidden;
      // Escape first: pasted HTML, links and scripts remain inert text. Small Markdown subset.
      preview.innerHTML=esc(field.value).replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*\n]+)\*/g,'<em>$1</em>');
    });
    if(copyButton && copyButton.id!=='copy-minute')copyButton.addEventListener('click',()=>navigator.clipboard.writeText(field.value).then(()=>message('✓ Texto copiado')).catch(()=>message('Selecciona el texto y cópialo manualmente.',true)));
    renderStatus();
    if(draft.dirty)changed();
    active.update=()=>{const remote=server[draft.id];if(remote&&remote.status!=='draft'){Object.assign(draft,remote,{dirty:false});renderStatus();}};
  }
  function attach(){
    if(!ready)return;
    const field=document.querySelector('#minute-text');if(!field||field.closest('.manual-editor'))return;
    const title=document.querySelector('#detail-title').textContent;
    editor(field.parentElement,newDraft(title,field.value),field,document.querySelector('#copy-minute'));
  }
  const dialog=document.createElement('dialog');dialog.className='manual-dialog';dialog.setAttribute('aria-label','Minutas manuales');document.body.append(dialog);
  let opener=null;
  dialog.addEventListener('close',()=>{active=null;opener?.focus();});
  async function openList(){
    opener=document.activeElement;await load();
    dialog.innerHTML='<header><h2>Minutas manuales</h2><button type="button" data-close>Cerrar ×</button></header><p>Generar minuta prepara temas para Granola. Aquí puedes registrar la reunión y recuperar tus borradores.</p><button type="button" data-new>Registrar minuta nueva</button><div class="manual-list"></div>';
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();
    dialog.querySelector('[data-new]').onclick=()=>openEditor(newDraft());
    for(const d of Object.values(cache).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))){
      const button=Object.assign(document.createElement('button'),{type:'button',textContent:`${d.title} · ${states[d.status]}${d.dirty?' · cambios locales':''}`});button.onclick=()=>openEditor(d);dialog.querySelector('.manual-list').append(button);
      if(d.dirty&&server[d.id]){
        const saved=Object.assign(document.createElement('button'),{type:'button',textContent:'Recuperar versión guardada · conservar cambios locales como copia'});
        saved.onclick=async()=>{
          const copy={...d,id:crypto.randomUUID(),revision:0,pendingRequest:null,title:(d.title+' · recuperada').slice(0,200),dirty:true};cache[copy.id]=copy;await persistLocal(copy);
          cache[d.id]={...server[d.id],dirty:false};await persistLocal(cache[d.id]);openEditor(cache[d.id]);
        };dialog.querySelector('.manual-list').append(saved);
      }
    }
    if(!dialog.open)dialog.showModal();
  }
  function openEditor(draft){
    dialog.innerHTML='<header><h2>Registrar minuta</h2><button type="button" data-close>Cerrar ×</button></header><div data-editor><p class="muted">Usa los botones de formato y Vista previa. El análisis crea propuestas para tu aprobación.</p><textarea class="minute-text" aria-label="Contenido de la minuta" maxlength="60000"></textarea><button type="button" data-copy>Copiar texto</button></div>';
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();
    const field=dialog.querySelector('textarea');field.value=draft.content;
    editor(dialog.querySelector('[data-editor]'),draft,field,dialog.querySelector('[data-copy]'));field.focus();
  }
  window.addEventListener('beforeunload',e=>{if(unsaved||Object.values(cache).some(d=>d.dirty)){e.preventDefault();e.returnValue='';}});
  window.addEventListener('online',()=>{if(ready)load().then(()=>active?.update?.()).catch(()=>{});});
  async function start(){
    const response=await fetch('/api/session',{cache:'no-store'});if(!response.ok)return;
    actor=(await response.json()).actor;
    await load();ready=true;
    const style=Object.assign(document.createElement('link'),{rel:'stylesheet',href:'/manual-minutes.css'});document.head.append(style);
    const button=Object.assign(document.createElement('button'),{type:'button',id:'manual-minutes-open',textContent:'Minutas manuales'});
    document.querySelector('#refresh').before(button);
    button.onclick=()=>openList().catch(e=>window.DstaToast?.show(e.message,false));
    new MutationObserver(attach).observe(document.querySelector('#detail-body'),{childList:true});attach();
    setInterval(()=>{
      if(!Object.values(cache).some(d=>['queued','running'].includes(d.status)))return;
      load().then(()=>{active?.update?.();window.dispatchEvent(new Event('dsta-minutes-changed'));}).catch(()=>{});
    },10000);
  }
  start().catch(()=>{const button=Object.assign(document.createElement('button'),{type:'button',textContent:'Reintentar minutas manuales'});button.onclick=()=>{button.remove();start().catch(()=>window.DstaToast?.show('No se pudieron cargar los borradores. Recarga para reintentar.',false));};document.querySelector('#refresh')?.before(button);});
})();
