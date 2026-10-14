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
    buttons.insertAdjacentHTML('beforeend','<button type="button" data-save>Guardar borrador</button><button type="button" data-submit>Guardar y procesar minuta</button>');
    if(copyButton&&!buttons.contains(copyButton))buttons.prepend(copyButton);
    const status=document.createElement('span');status.className='manual-status';status.setAttribute('role','status');
    container.append(buttons,status);
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
    if(copyButton && copyButton.id!=='copy-minute')copyButton.addEventListener('click',()=>navigator.clipboard.writeText(field.value).then(()=>message('✓ Texto copiado')).catch(()=>message('Selecciona el texto y cópialo manualmente.',true)));
    renderStatus();
    if(draft.dirty)changed();
    active.update=()=>{const remote=server[draft.id];if(remote&&remote.status!=='draft'){Object.assign(draft,remote,{dirty:false});renderStatus();}};
  }
  function attach(){
    if(!ready)return;
    // Every "Generar minuta" re-renders #detail-body with a new #minute-text: attach once per field.
    // (#detail-body itself keeps no marker, or only the first minute of the page got the editor.)
    const body=document.querySelector('#detail-body'),field=document.querySelector('#minute-text');
    if(!field){body?.classList.remove('manual-editor');return;}
    if(field.dataset.manualAttached)return;
    field.dataset.manualAttached='1';
    const title=document.querySelector('#detail-title').textContent;
    editor(field.parentElement,newDraft(title,field.value),field,document.querySelector('#copy-minute'));
  }
  // ── «Minutas»: every stored minute (Granola, manual, future sources) in one window. ──
  const dialog=document.createElement('dialog');dialog.className='manual-dialog mm';dialog.setAttribute('aria-label','Minutas');document.body.append(dialog);
  let opener=null,records=[],filter='all',query='',selected=null;
  dialog.addEventListener('close',()=>{active=null;opener?.focus();});
  const ORIGINS={'Granola':{label:'Granola',cls:'granola'},'Manual-Dashboard':{label:'Manual',cls:'manual'}};
  const origin=source=>ORIGINS[source||'Granola']||{label:String(source),cls:'other'};
  const months=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const pendingOf=r=>r&&!r.descartadaEn?(r.acciones||[]).filter(a=>!a.auto&&['propuesta','error'].includes(a.estado)).length:0;
  const appliedOf=r=>(r?.acciones||[]).filter(a=>a.estado==='aplicada').length;
  const niceDate=value=>{
    const text=String(value||'');if(!/^\d{4}-\d{2}-\d{2}/.test(text))return 'Sin fecha';
    const date=new Date(text.length>10?text:text+'T12:00:00');
    const day=`${date.getDate()} de ${months[date.getMonth()]} ${date.getFullYear()}`;
    return text.length>10?`${day} · ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`:day;
  };
  function status(item){
    const d=item.draft,r=item.record;
    if(d&&d.status!=='processed')return {draft:['Borrador','muted'],queued:['En cola de análisis','busy'],running:['Analizando con IA…','busy'],error:['Error · reintentar','error']}[d.status]||[d.status,'muted'];
    if(r?.descartadaEn)return ['Descartada','muted'];
    const left=pendingOf(r);
    return left?[`${left} por revisar`,'attention']:[appliedOf(r)?`${appliedOf(r)} aplicadas`:'Sin cambios propuestos','ok'];
  }
  function items(){
    const byMinute=new Map(records.map(r=>[r.id,{key:'r:'+r.id,record:r,title:r.titulo,date:r.fecha,source:r.source||'Granola'}]));
    for(const d of Object.values(cache)){
      const linked=d.minuteId&&byMinute.get(d.minuteId);
      if(linked){linked.draft=d;linked.date=d.date||linked.date;continue;}
      byMinute.set('d:'+d.id,{key:'d:'+d.id,draft:d,title:d.title,date:d.date,source:'Manual-Dashboard'});
    }
    return [...byMinute.values()].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
  }
  function visible(list){
    const q=query.trim().toLowerCase();
    return list.filter(i=>(filter==='all'||(filter==='pending'?pendingOf(i.record)>0:origin(i.source).cls===filter))&&
      (!q||[i.title,i.record?.resumen,i.draft?.content].some(t=>String(t||'').toLowerCase().includes(q))));
  }
  async function refreshRecords(){
    const response=await fetch('/api/minutes?all=1',{cache:'no-store',credentials:'same-origin'});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(payload.error||'No se pudieron leer las minutas.');
    records=payload.minutes||[];
  }
  async function openList(){
    opener=document.activeElement;
    await Promise.all([load(),refreshRecords()]);
    dialog.innerHTML=`<header class="mm-head"><div><span class="kicker">MINUTAS</span><h2>Minutas</h2></div>
      <div class="mm-head-actions"><button type="button" class="mm-primary" data-new>+ Nueva minuta</button><button type="button" class="mm-close" data-close aria-label="Cerrar">×</button></div></header>
      <div class="mm-toolbar"><input type="search" class="mm-search" placeholder="Buscar por título o contenido…" aria-label="Buscar minutas"><div class="mm-chips" role="group" aria-label="Filtrar por origen"></div></div>
      <div class="mm-body"><div class="mm-list" role="list"></div><section class="mm-detail" aria-live="polite"></section></div>`;
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();
    dialog.querySelector('[data-new]').onclick=()=>{selected=null;showEditor(newDraft());};
    const search=dialog.querySelector('.mm-search');search.value=query;search.oninput=()=>{query=search.value;renderList();};
    renderList();
    if(selected)renderDetail(items().find(i=>i.key===selected));else renderDetail(null);
    if(!dialog.open)dialog.showModal();
  }
  function renderList(){
    const all=items(),list=visible(all);
    const count=key=>key==='all'?all.length:key==='pending'?all.filter(i=>pendingOf(i.record)>0).length:all.filter(i=>origin(i.source).cls===key).length;
    const chips=dialog.querySelector('.mm-chips');chips.replaceChildren();
    for(const [key,label] of [['all','Todas'],['granola','Granola'],['manual','Manual'],['pending','Por revisar']]){
      const chip=Object.assign(document.createElement('button'),{type:'button',className:'mm-chip'+(filter===key?' on':''),textContent:`${label} · ${count(key)}`});
      chip.setAttribute('aria-pressed',String(filter===key));chip.onclick=()=>{filter=key;renderList();};chips.append(chip);
    }
    const box=dialog.querySelector('.mm-list');box.replaceChildren();
    if(!list.length){box.innerHTML=`<p class="mm-empty">${all.length?'Ninguna minuta coincide con el filtro.':'Aún no hay minutas. Las de Granola llegan solas cada hora; las manuales se crean con «+ Nueva minuta» o desde «Generar minuta».'}</p>`;return;}
    let month='';
    for(const item of list){
      const text=String(item.date||'');const head=/^\d{4}-\d{2}/.test(text)?`${months[Number(text.slice(5,7))-1]} ${text.slice(0,4)}`:'Sin fecha';
      if(head!==month){month=head;box.append(Object.assign(document.createElement('h3'),{className:'mm-month',textContent:head}));}
      const [label,tone]=status(item),o=origin(item.source);
      const row=Object.assign(document.createElement('button'),{type:'button',className:'mm-item'+(selected===item.key?' on':'')});
      row.setAttribute('role','listitem');
      row.innerHTML=`<span class="mm-row1"><span class="mm-badge ${o.cls}">${esc(o.label)}</span><span class="mm-pill ${tone}">${esc(label)}</span></span>
        <strong>${esc(item.title||'Reunión sin título')}</strong><small>${esc(niceDate(item.date))}</small>
        ${item.record?.resumen?`<span class="mm-snippet">${esc(item.record.resumen)}</span>`:''}`;
      row.onclick=()=>{selected=item.key;renderList();renderDetail(item);};
      box.append(row);
    }
  }
  // Eliminar (14-10): a draft is deleted; a processed minute leaves the lists and the VM keeps a
  // tombstone so its source is never imported again. Changes already applied in Vikunja stay.
  async function removeItem(item,note){
    if(item.record){
      const response=await fetch('/api/minutes/decide',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
        body:JSON.stringify({minuteId:item.record.id,decision:'eliminar',digest:item.record.digest})});
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw Error(payload.error||'No se pudo eliminar la minuta.');
      records=records.filter(r=>r.id!==item.record.id);
      window.DstaInbox?.reload?.();
    }else if(server[item.draft.id]){
      await api('/delete',{id:item.draft.id});
    }
    if(item.draft){delete cache[item.draft.id];delete server[item.draft.id];try{localStorage.removeItem(localName()+':'+item.draft.id);}catch{}}
    selected=null;renderList();renderDetail(null);
    window.DstaToast?.show('✓ Minuta eliminada',true);
  }
  function deleteButton(container,item,note){
    const wrap=document.createElement('span');wrap.className='mm-delete';
    const ask=Object.assign(document.createElement('button'),{type:'button',className:'mm-danger',textContent:'Eliminar'});
    ask.onclick=()=>{
      wrap.replaceChildren(Object.assign(document.createElement('span'),{className:'mm-confirm',
        textContent:item.record?'¿Eliminar esta minuta? Sale de la lista y de la bandeja; lo ya aplicado en Vikunja se mantiene.':'¿Eliminar este borrador?'}));
      const yes=Object.assign(document.createElement('button'),{type:'button',className:'mm-danger',textContent:'Sí, eliminar'});
      const no=Object.assign(document.createElement('button'),{type:'button',textContent:'Cancelar'});
      yes.onclick=async()=>{yes.disabled=no.disabled=true;try{await removeItem(item,note);}catch(e){note.textContent=e.message;wrap.replaceChildren(ask);}};
      no.onclick=()=>wrap.replaceChildren(ask);
      wrap.append(yes,no);yes.focus();
    };
    wrap.append(ask);container.append(wrap);
  }
  function renderDetail(item){
    const pane=dialog.querySelector('.mm-detail');dialog.classList.toggle('mm-showing',Boolean(item));
    if(!item){pane.innerHTML='<p class="mm-empty">Selecciona una minuta para ver su resumen, sus propuestas y su estado.</p>';return;}
    if(item.draft&&['draft','error','queued','running'].includes(item.draft.status)&&!item.record){showEditor(item.draft);return;}
    const r=item.record,d=item.draft,o=origin(item.source),[label,tone]=status(item),left=pendingOf(r);
    pane.innerHTML=`<button type="button" class="mm-back" data-back>← Minutas</button>
      <div class="mm-row1"><span class="mm-badge ${o.cls}">${esc(o.label)}</span><span class="mm-pill ${tone}">${esc(label)}</span></div>
      <h3 class="mm-title">${esc(item.title||'Reunión sin título')}</h3><p class="mm-meta">${esc(niceDate(item.date))}</p>
      ${r?.resumen?`<h4>Resumen</h4><p class="mm-text">${esc(r.resumen)}</p>`:''}
      ${(r?.antecedentes||[]).length?`<h4>Antecedentes</h4><ul>${r.antecedentes.map(a=>`<li>${esc(a)}</li>`).join('')}</ul>`:''}
      ${r?`<h4>Acciones</h4><p class="mm-text">${appliedOf(r)} aplicadas · ${left} por revisar · ${(r.acciones||[]).length} en total</p>`:''}
      <div class="mm-actions"></div><p class="mm-note" role="status"></p>`;
    pane.querySelector('[data-back]').onclick=()=>{selected=null;renderList();renderDetail(null);};
    const actions=pane.querySelector('.mm-actions'),note=pane.querySelector('.mm-note');
    const add=(text,cls,fn)=>{const b=Object.assign(document.createElement('button'),{type:'button',className:cls,textContent:text});b.onclick=fn;actions.append(b);return b;};
    if(r)add(left?`Revisar ${left} ${left===1?"propuesta":"propuestas"} en 🔔`:'Abrir en la bandeja 🔔',left?'mm-primary':'',()=>{dialog.close();window.DstaInbox?.open(r.id);});
    if(!r?.aplicando)deleteButton(actions,item,note);
    if(d){
      add('Ver texto','',()=>showEditor(d));
      if(d.status==='processed'&&!appliedOf(r)&&!r?.descartadaEn)add('Volver a procesar','',async e=>{
        e.target.disabled=true;note.textContent='Enviando a análisis…';
        try{const result=await api('/submit',{id:d.id,revision:d.revision,reprocess:true});Object.assign(d,result,{dirty:false});note.textContent='En cola de análisis. Las nuevas propuestas llegarán a la 🔔 en unos minutos.';}
        catch(error){note.textContent=error.message;e.target.disabled=false;}
      });
    }
  }
  function showEditor(draft){
    const pane=dialog.querySelector('.mm-detail');dialog.classList.add('mm-showing');
    pane.innerHTML=`<div class="mm-editor-top"><button type="button" class="mm-back" data-back>← Minutas</button><span class="mm-editor-del"></span></div><p class="mm-note" role="status"></p><div data-editor class="mm-editor"><textarea class="minute-text" aria-label="Contenido de la minuta" maxlength="60000" placeholder="Escribe aquí las notas de la reunión: acuerdos, avances, responsables y fechas."></textarea><button type="button" data-copy>Copiar texto</button></div>`;
    pane.querySelector('[data-back]').onclick=()=>{openList().catch(e=>window.DstaToast?.show(e.message,false));};
    if(['draft','error'].includes(draft.status))deleteButton(pane.querySelector('.mm-editor-del'),{draft},pane.querySelector('.mm-note'));
    const field=pane.querySelector('textarea');field.value=draft.content;
    editor(pane.querySelector('[data-editor]'),draft,field,pane.querySelector('[data-copy]'));field.focus();
  }
  window.addEventListener('beforeunload',e=>{if(unsaved||Object.values(cache).some(d=>d.dirty)){e.preventDefault();e.returnValue='';}});
  window.addEventListener('online',()=>{if(ready)load().then(()=>active?.update?.()).catch(()=>{});});
  async function start(){
    const response=await fetch('/api/session',{cache:'no-store'});if(!response.ok)return;
    actor=(await response.json()).actor;
    await load();ready=true;
    const style=Object.assign(document.createElement('link'),{rel:'stylesheet',href:'/manual-minutes.css'});document.head.append(style);
    const button=Object.assign(document.createElement('button'),{type:'button',id:'manual-minutes-open',textContent:'Minutas'});
    document.querySelector('#refresh').before(button,' ');
    button.onclick=()=>{selected=null;openList().catch(e=>window.DstaToast?.show(e.message,false));};
    new MutationObserver(attach).observe(document.querySelector('#detail-body'),{childList:true});attach();
    setInterval(()=>{
      if(!Object.values(cache).some(d=>['queued','running'].includes(d.status)))return;
      load().then(()=>{active?.update?.();window.dispatchEvent(new Event('dsta-minutes-changed'));}).catch(()=>{});
    },10000);
  }
  start().catch(()=>{const button=Object.assign(document.createElement('button'),{type:'button',textContent:'Reintentar minutas'});button.onclick=()=>{button.remove();start().catch(()=>window.DstaToast?.show('No se pudieron cargar los borradores. Recarga para reintentar.',false));};document.querySelector('#refresh')?.before(button);});
})();
