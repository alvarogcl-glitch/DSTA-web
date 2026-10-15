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
    return {id:crypto.randomUUID(),revision:0,title:title||'Minuta de reunión',date:localISO(new Date()),content,transcript:'',
      context:contextFor(content,title||'Registro manual'),status:'draft',dirty:true,updatedAt:new Date().toISOString()};
  }
  // Teclado / Lápiz: the preferred input is a per-device setting (iPad defaults to the pencil).
  const MODE='dsta-minute-input';
  const isTablet=()=>/iPad/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  const preferredMode=()=>{try{return localStorage.getItem(MODE)||(isTablet()?'pen':'keys');}catch{return isTablet()?'pen':'keys';}};
  const transcribing=d=>['queued','running'].includes(d.transcription?.status);
  // Per-action notices: what this browser sent is followed until it ends (analysis or transcription).
  const followed=new Map();
  const follow=(key,d)=>followed.set(key,d.title||'Minuta');
  function reportProgress(){
    for(const [key,title] of followed){
      const [kind,id]=key.split(':'),d=cache[id],toast=window.DstaToast?.task(key);if(!d||!toast)continue;
      if(kind==='ink'){
        const t=d.transcription?.status;
        if(t==='done'){toast.done(`«${title}» · transcripción lista para revisar`);followed.delete(key);}
        else if(t==='error'){toast.fail(`«${title}»: ${d.transcription.error||'no se pudo transcribir'}`);followed.delete(key);}
        else toast.step(`«${title}» · ${t==='running'?'Transcribiendo…':'Transcripción en cola…'}`);
      }else{
        if(d.status==='processed'){toast.done(`«${title}» procesada · revisa la 🔔`);followed.delete(key);}
        else if(d.status==='error'){toast.fail(`«${title}»: ${d.error||'no se pudo analizar'}`);followed.delete(key);}
        else toast.step(`«${title}» · ${d.status==='running'?'Analizando con IA…':'Análisis en cola…'}`);
      }
    }
  }
  const inkCurrent=d=>!d.hasInk&&!d.ink||(!d.inkDirty&&d.transcription?.status==='done'&&d.transcription.inkRev===d.inkRev);
  const fullText=d=>[d.content,d.transcript?'[Escrito a mano · transcripción]\n'+d.transcript:''].filter(x=>String(x||'').trim()).join('\n\n');
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
    // Input mode switch, handwriting pad and the editable transcription of the handwriting.
    const modes=document.createElement('div');modes.className='manual-modes';modes.setAttribute('role','group');modes.setAttribute('aria-label','Forma de escribir');
    modes.innerHTML='<button type="button" data-mode="keys">⌨️ Teclado</button><button type="button" data-mode="pen">✏️ Lápiz</button>';
    container.insertBefore(modes,field);
    const inkArea=document.createElement('div');inkArea.className='manual-ink';
    const pad=window.DstaInk?.create({ink:draft.ink||'',onChange:()=>{draft.ink=pad.serialize();draft.inkDirty=true;changed();renderStatus();}});
    const transcribeRow=document.createElement('div');transcribeRow.className='manual-transcribe';
    transcribeRow.innerHTML='<button type="button" data-transcribe>Transcribir a texto</button><span>La IA convierte tu letra en texto; lo revisas antes de procesar.</span>';
    if(pad)inkArea.append(pad.el,transcribeRow);
    const transcriptBox=document.createElement('label');transcriptBox.className='manual-transcript';
    transcriptBox.innerHTML='Transcripción de lo escrito a mano · revísala y corrígela<textarea maxlength="60000" data-transcript placeholder="Aquí aparecerá el texto de tu escritura a mano."></textarea>';
    const transcript=transcriptBox.querySelector('textarea');transcript.value=draft.transcript||'';
    field.after(inkArea,transcriptBox);
    let mode=(draft.hasInk||draft.ink)&&!draft.content?.trim()?'pen':preferredMode();
    if(!pad)mode='keys';
    const setMode=(next,remember)=>{
      mode=next;container.classList.toggle('manual-pen',mode==='pen');
      modes.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
      transcriptBox.hidden=!(draft.transcript||transcript.value||(mode==='pen'&&!pad?.isEmpty()));
      if(remember)try{localStorage.setItem(MODE,mode);}catch{}
    };
    modes.addEventListener('click',e=>{const b=e.target.closest('[data-mode]');if(b)setMode(b.dataset.mode,true);});
    if(!pad)modes.hidden=true;
    if(pad&&draft.hasInk&&draft.ink===undefined)api('/ink?id='+encodeURIComponent(draft.id)).then(r=>{if(draft.ink===undefined){draft.ink=r.ink||'';pad.setInk(draft.ink);renderStatus();}}).catch(()=>message('No se pudo cargar la escritura a mano. Recarga para reintentar.',true));
    const buttons=container.querySelector('.minute-actions')||document.createElement('div');buttons.classList.add('manual-buttons');
    buttons.insertAdjacentHTML('beforeend','<button type="button" data-save>Guardar borrador</button><button type="button" data-submit>Guardar y procesar minuta</button>');
    if(copyButton&&!buttons.contains(copyButton))buttons.prepend(copyButton);
    const status=document.createElement('span');status.className='manual-status';status.setAttribute('role','status');
    container.append(buttons,status);
    let timer=null,busy=false,pendingSave=null;
    const message=(text,error=false)=>{status.textContent=text;status.classList.toggle('manual-error',error);};
    let padLocked=null;
    const renderStatus=()=>{
      const locked=draft.status!=='draft'||transcribing(draft);field.readOnly=transcript.readOnly=locked;title.disabled=date.disabled=locked;
      if(pad&&padLocked!==locked){padLocked=locked;pad.setReadOnly(locked);}
      const tb=transcribeRow.querySelector('[data-transcribe]');
      tb.disabled=busy||locked||!pad||pad.isEmpty()||inkCurrent(draft);
      tb.textContent=transcribing(draft)?'Transcribiendo…':inkCurrent(draft)&&draft.transcript?'✓ Transcrita':draft.transcript?'Volver a transcribir':'Transcribir a texto';
      setMode(mode);
      container.querySelectorAll('.manual-tools button').forEach(b=>b.disabled=locked);
      buttons.querySelector('[data-save]').disabled=locked||busy;
      buttons.querySelector('[data-submit]').disabled=busy||!['draft','error'].includes(draft.status);
      buttons.querySelector('[data-submit]').textContent=draft.status==='error'?'Reintentar procesamiento':'Guardar y procesar minuta';
      if(draft.status==='draft'&&transcribing(draft))message('Transcribiendo tu escritura a mano… suele tardar menos de un minuto.');
      else if(draft.status==='draft'&&draft.transcription?.status==='error')message(draft.transcription.error||'No se pudo transcribir.',true);
      else message(states[draft.status]+(draft.error?' · '+draft.error:''));
    };
    async function sync(){
      if(pendingSave){await pendingSave;if(draft.dirty)return sync();return;}
      if(!draft.dirty||draft.status!=='draft')return;
      const request=draft.pendingRequest||{id:draft.id,revision:draft.revision,operationId:crypto.randomUUID(),title:draft.title,date:draft.date,content:draft.content,context:draft.context,
        transcript:draft.transcript||'',...(draft.inkDirty?{ink:draft.ink||''}:{})};
      draft.pendingRequest=request;
      await persistLocal(draft).catch(()=>message('Recuperación local no disponible · guardando en tu cuenta…',true));
      const run=async()=>{
        const result=await api('',request);
        const inkSent=request.ink!==undefined&&(draft.ink||'')===request.ink;
        const unchanged=draft.title===request.title&&draft.date===request.date&&draft.content===request.content&&
          (draft.transcript||'')===request.transcript&&(request.ink===undefined?!draft.inkDirty:inkSent);
        Object.assign(draft,{revision:result.revision,status:result.status,hasInk:result.hasInk,inkRev:result.inkRev,transcription:result.transcription,
          dirty:!unchanged,pendingRequest:null,...(inkSent?{inkDirty:false}:{})});
        server[draft.id]=result;await persistLocal(draft).catch(()=>{});unsaved=draft.dirty;
        message(unchanged?'✓ Borrador guardado en tu cuenta':'Hay cambios nuevos por guardar');
      };
      pendingSave=run();try{await pendingSave;}finally{pendingSave=null;}
      if(draft.dirty)return sync();
    }
    function changed(){
      if(draft.status!=='draft')return;
      draft.title=title.value;draft.content=field.value;draft.transcript=transcript.value;
      if(date.value)draft.date=localISO(new Date(date.value));else draft.date='';
      draft.dirty=true;draft.updatedAt=new Date().toISOString();unsaved=true;
      persistLocal(draft).then(()=>message('Borrador protegido en este dispositivo · guardando en tu cuenta…')).catch(()=>message('No se pudo guardar en este dispositivo. Mantén esta ventana abierta y guarda en tu cuenta.',true));
      clearTimeout(timer);timer=setTimeout(()=>sync().catch(e=>message(e.message+' · tu texto se conserva para reintentar.',true)),2500);
    }
    for(const input of [field,title,date,transcript])input.addEventListener('input',changed);
    transcribeRow.querySelector('[data-transcribe]').addEventListener('click',async()=>{
      if(busy)return;busy=true;clearTimeout(timer);renderStatus();
      try{
        await sync();
        const result=await api('/transcribe',{id:draft.id,revision:draft.revision});
        Object.assign(draft,result,{dirty:false});server[draft.id]=result;cache[draft.id]=draft;await persistLocal(draft).catch(()=>{});
        follow('ink:'+draft.id,draft);reportProgress();
      }catch(e){message(e.message,true);}finally{busy=false;renderStatus();}
    });
    toolbar(field,container,changed);
    buttons.querySelector('[data-save]').addEventListener('click',()=>sync().catch(e=>message(e.message,true)));
    buttons.querySelector('[data-submit]').addEventListener('click',async()=>{
      if(busy)return;busy=true;renderStatus();clearTimeout(timer);
      if(pad&&!pad.isEmpty()&&!inkCurrent(draft)){busy=false;renderStatus();message('Tienes escritura a mano sin transcribir. Usa «Transcribir a texto» y revisa el resultado antes de procesar.',true);return;}
      try{await sync();const result=await api('/submit',{id:draft.id,revision:draft.revision});Object.assign(draft,result,{dirty:false});cache[draft.id]=draft;follow('manual:'+draft.id,draft);reportProgress();await persistLocal(draft).catch(()=>{});unsaved=false;renderStatus();}
      catch(e){message(e.message+' · el borrador se conserva.',true);}finally{busy=false;renderControls();}
    });
    function renderControls(){renderStatus();}
    if(copyButton && copyButton.id!=='copy-minute')copyButton.addEventListener('click',()=>navigator.clipboard.writeText(fullText({content:field.value,transcript:transcript.value})).then(()=>message('✓ Texto copiado')).catch(()=>message('Selecciona el texto y cópialo manualmente.',true)));
    renderStatus();
    if(draft.dirty)changed();
    active.update=()=>{
      const remote=server[draft.id];if(!remote)return;
      if(remote.status!=='draft'){Object.assign(draft,remote,{dirty:false});renderStatus();return;}
      // Transcription finished on the VM: it bumped the revision with the text; the editor was locked meanwhile.
      if(transcribing(draft)&&!transcribing(remote)&&!draft.dirty){
        Object.assign(draft,{revision:remote.revision,transcript:remote.transcript||'',transcription:remote.transcription});
        transcript.value=draft.transcript;persistLocal(draft).catch(()=>{});renderStatus();
        if(remote.transcription?.status==='done'){message('✓ Transcripción lista. Revísala y corrígela; luego «Guardar y procesar minuta».');transcriptBox.hidden=false;transcript.focus();}
      }
    };
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
      (!q||[i.title,i.record?.resumen,i.draft?.content,i.draft?.transcript].some(t=>String(t||'').toLowerCase().includes(q))));
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
      <h4>Minuta · texto original${item.source==='Manual-Dashboard'?'':` (${esc(o.label)})`}</h4>
      <div class="mm-original" data-original><p class="mm-note">Cargando…</p></div>
      ${r?`<div class="mm-analysis"><h4>Análisis del asistente</h4>${r.resumen?`<p class="mm-text">${esc(r.resumen)}</p>`:''}`:''}
      ${(r?.antecedentes||[]).length?`<h4>Antecedentes</h4><ul>${r.antecedentes.map(a=>`<li>${esc(a)}</li>`).join('')}</ul>`:''}
      ${r?`<h4>Acciones</h4><p class="mm-text">${appliedOf(r)} aplicadas · ${left} por revisar · ${(r.acciones||[]).length} en total</p></div>`:''}
      <div class="mm-actions"></div><p class="mm-note" role="status"></p>`;
    pane.querySelector('[data-back]').onclick=()=>{selected=null;renderList();renderDetail(null);};
    // The meeting's own text: the manual draft, or Granola's text kept apart in the account.
    const original=pane.querySelector('[data-original]');
    const showOriginal=text=>{original.replaceChildren(text?Object.assign(document.createElement('div'),{className:'mm-text mm-original-text',textContent:text})
      :Object.assign(document.createElement('p'),{className:'mm-note',textContent:'El texto original de esta minuta aún no está disponible. Llegará en la próxima sincronización con Granola.'}));};
    if(d&&fullText(d))showOriginal(fullText(d));
    else if(r)fetch('/api/minutes/text?id='+encodeURIComponent(r.id),{cache:'no-store',credentials:'same-origin'})
      .then(res=>res.ok?res.json():{}).then(p=>{if(selected===item.key||!selected)showOriginal(p.contenido||'');}).catch(()=>showOriginal(''));
    else showOriginal('');
    const actions=pane.querySelector('.mm-actions'),note=pane.querySelector('.mm-note');
    const add=(text,cls,fn)=>{const b=Object.assign(document.createElement('button'),{type:'button',className:cls,textContent:text});b.onclick=fn;actions.append(b);return b;};
    if(r)add(left?`Revisar ${left} ${left===1?"propuesta":"propuestas"} en 🔔`:'Abrir en la bandeja 🔔',left?'mm-primary':'',()=>{dialog.close();window.DstaInbox?.open(r.id);});
    if(!r?.aplicando)deleteButton(actions,item,note);
    if(d){
      add('Ver texto','',()=>showEditor(d));
      if(d.status==='processed'&&!appliedOf(r)&&!r?.descartadaEn)add('Volver a procesar','',async e=>{
        e.target.disabled=true;note.textContent='Enviando a análisis…';
        try{const result=await api('/submit',{id:d.id,revision:d.revision,reprocess:true});Object.assign(d,result,{dirty:false});follow('manual:'+d.id,d);reportProgress();note.textContent='En cola de análisis. Las nuevas propuestas llegarán a la 🔔 en unos minutos.';}
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
      if(!Object.values(cache).some(d=>['queued','running'].includes(d.status)||transcribing(d)))return;
      load().then(()=>{active?.update?.();reportProgress();window.dispatchEvent(new Event('dsta-minutes-changed'));}).catch(()=>{});
    },5000);
  }
  start().catch(()=>{const button=Object.assign(document.createElement('button'),{type:'button',textContent:'Reintentar minutas'});button.onclick=()=>{button.remove();start().catch(()=>window.DstaToast?.show('No se pudieron cargar los borradores. Recarga para reintentar.',false));};document.querySelector('#refresh')?.before(button);});
})();
