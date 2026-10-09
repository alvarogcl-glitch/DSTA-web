(() => {
  'use strict';
  const selected = new Set(), storageKey = 'dsta-label-pending-v1';
  let palette = [], pending = null, polling = false;
  const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const catalog = () => typeof labels === 'undefined' ? [] : labels;
  const allTasks = () => typeof tasks === 'undefined' ? [] : tasks;
  const ready = () => typeof labelsReady !== 'undefined' && labelsReady;
  const nameKey = value => value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/\s+/g,' ');
  const protectedLabel = label => nameKey(label.title) === 'carrera tecnologica';
  const color = label => /^[0-9a-f]{6}$/i.test(label.hex_color || '') ? label.hex_color : 'bac7d5';
  function foreground(hex) {
    const rgb = [0,2,4].map(i => parseInt(hex.slice(i,i+2),16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
    return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2] > .179 ? '#10202b' : '#ffffff';
  }
  const chip = label => `<span class="label-chip" style="background-color:#${color(label)};color:${foreground(color(label))}">${e(label.title)}</span>`;
  const taskLabels = task => catalog().filter(label => (task.label_ids || []).includes(label.id));
  const chips = task => taskLabels(task).map(chip).join(' ') || '<span class="muted">Sin etiquetas</span>';
  const matches = task => !selected.size || (task.label_ids || []).some(id => selected.has(id));
  const notice = document.createElement('div');
  notice.className = 'label-notice'; notice.setAttribute('role','status'); notice.setAttribute('aria-live','polite'); notice.hidden = true;
  document.body.append(notice);
  function notify(text) {notice.textContent = text;notice.hidden = false;}
  function persist(value) {
    // Persist before any mutation, even when the browser disallows storage.
    if (value) sessionStorage.setItem(storageKey,JSON.stringify(value)); else sessionStorage.removeItem(storageKey);
    pending = value;
  }
  async function track(job) {
    if (polling) return;
    polling = true;render();
    try {
      const end = Date.now()+360000;
      let result;
      while (Date.now()<end) {
        let response = await fetch('/api/label-actions?id='+encodeURIComponent(job.requestId),{cache:'no-store'});
        if (response.status === 404) response = await fetch('/api/label-actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(job)});
        result = await response.json();
        if (!response.ok) {
          if (response.status >= 400 && response.status < 500 && response.status !== 404) {
            // A structured rejection created no job; preserve all editor drafts.
            persist(null);
          }
          throw Error(result.error || 'No se pudo consultar el cambio');
        }
        if (result.status === 'error') {job.terminal=true;sessionStorage.setItem(storageKey,JSON.stringify(job));throw Error(result.error);}
        if (result.status === 'completed') break;
        await new Promise(r => setTimeout(r,2000));
      }
      if (result?.status !== 'completed') throw Error('El cambio sigue pendiente. Conservamos su identificador para consultar el resultado.');
      let confirmed = false;
      for (let i=0;i<20;i++) {
        if (await refresh(result.snapshotTimestamp)) {confirmed=true;break;}
        await new Promise(r => setTimeout(r,750));
      }
      if (!confirmed) throw Error('El cambio terminó, pero falta cargar el snapshot actualizado. Consulta su resultado.');
      persist(null);notify('Etiquetas actualizadas.');
      setTimeout(() => {if (!pending) notice.hidden=true;},6000);
      if (editor.open) editor.close();
      renderManager();
    } catch (error) {
      notify(error.message);
      if (editor.open) editor.querySelector('.label-error').textContent=error.message;
    } finally {polling=false;render();updatePendingControls();}
  }
  async function submit(action) {
    if (pending) {notify('Hay un cambio pendiente. Consulta su resultado antes de enviar otro.');return;}
    const job = {...action,requestId:crypto.randomUUID()};
    try {persist(job);} catch {notify('No se pudo conservar el identificador; no se envió el cambio.');return;}
    notify('Actualizando etiquetas…');render();updatePendingControls();
    // track performs the initial idempotent POST on 404 and resumes the same UUID.
    await track(job);
  }
  function updatePendingControls() {
    editor.querySelectorAll('button,input').forEach(el => {if (!el.matches('[data-close]')) el.disabled=Boolean(pending);});
    manager.querySelectorAll('button').forEach(el => {if (!el.matches('[data-close]')) el.disabled=Boolean(pending)||!ready();});
    manager.querySelectorAll('[data-delete-label]').forEach(button=>{
      const label=catalog().find(l=>l.id===Number(button.dataset.deleteLabel));
      if(label && protectedLabel(label)) button.disabled=true;
    });
    manager.querySelector('#reset-labels').disabled=Boolean(pending)||!ready()||!catalog().some(protectedLabel)||!catalog().some(l=>!protectedLabel(l));
    manager.querySelector('#new-label').disabled=Boolean(pending)||!ready()||!palette.length;
    if (pending && !polling) {
      const button = document.createElement('button');button.type='button';
      button.textContent=pending.terminal?'Actualizar y revisar etiquetas':'Consultar cambio pendiente';
      button.addEventListener('click',async () => {
        if (pending.terminal) {
          if (await refresh()) {persist(null);render();renderManager();notice.hidden=true;}
        } else void track(pending);
      });
      notice.append(' ',button);
    }
  }
  // One reusable searchable multi-select, retaining focus/search across snapshots.
  function combobox(host, getOptions, isSelected, toggle, caption, create) {
    host.innerHTML='<button type="button" class="label-select" role="combobox" aria-haspopup="listbox" aria-expanded="false"><span></span><span aria-hidden="true">⌄</span></button><div class="label-dropdown" hidden><input class="label-search" type="search" placeholder="Buscar etiqueta…" aria-label="Buscar etiqueta"><div class="label-options" role="listbox" aria-multiselectable="true"></div></div>';
    const button=host.querySelector('button'),dropdown=host.querySelector('.label-dropdown'),search=host.querySelector('input'),list=host.querySelector('.label-options');
    const id='label-options-'+crypto.randomUUID();list.id=id;button.setAttribute('aria-controls',id);
    function close() {dropdown.hidden=true;button.setAttribute('aria-expanded','false');}
    function update() {
      button.querySelector('span').textContent=caption();button.disabled=Boolean(pending)&&Boolean(create)||!ready();
      const active=document.activeElement?.dataset?.labelId;
      const options=getOptions().filter(l => nameKey(l.title).includes(nameKey(search.value)));
      list.innerHTML=options.map(l => `<button type="button" role="option" aria-selected="${isSelected(l.id)}" data-label-id="${l.id}"${pending&&create?' disabled':''}><span aria-hidden="true">${isSelected(l.id)?'✓':'○'}</span>${chip(l)}</button>`).join('')||'<p class="muted">Sin coincidencias</p>';
      if (create) {
        const plus=document.createElement('button');plus.type='button';plus.className='label-create-option';plus.textContent='+ Crear etiqueta'+(search.value.trim()?' «'+search.value.trim()+'»':'');plus.disabled=Boolean(pending)||!palette.length;
        plus.addEventListener('click',() => {close();create(search.value.trim());});list.append(plus);
      }
      if(active) list.querySelector(`[data-label-id="${active}"]`)?.focus();
    }
    button.addEventListener('click',() => {dropdown.hidden=!dropdown.hidden;button.setAttribute('aria-expanded',String(!dropdown.hidden));if(!dropdown.hidden){update();search.focus();}});
    button.addEventListener('keydown',event => {if(event.key==='ArrowDown'){event.preventDefault();dropdown.hidden=false;button.setAttribute('aria-expanded','true');update();search.focus();}});
    search.addEventListener('input',update);
    list.addEventListener('click',event => {const option=event.target.closest('[data-label-id]');if(option){toggle(Number(option.dataset.labelId));update();}});
    host.addEventListener('keydown',event => {
      if(event.key==='Escape'&&!dropdown.hidden){event.preventDefault();event.stopPropagation();close();button.focus();}
      const options=[...list.querySelectorAll('button:not(:disabled)')],index=options.indexOf(document.activeElement);
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)&&!dropdown.hidden) {
        event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?options.length-1:event.key==='ArrowDown'?Math.min(index+1,options.length-1):Math.max(0,index-1);options[next]?.focus();
      }
    });
    host.update=update;host.closeDropdown=close;update();
  }
  const filter=document.getElementById('label-filter');
  combobox(filter,catalog,id=>selected.has(id),id=>{if(selected.has(id))selected.delete(id);else selected.add(id);clear.hidden=!selected.size;renderRows();},()=>selected.size?'Etiquetas ('+selected.size+')':'Todas las etiquetas');
  const clear=document.createElement('button');clear.type='button';clear.className='label-clear';clear.textContent='Limpiar filtro';clear.hidden=true;
  clear.addEventListener('click',()=>{selected.clear();render();renderRows();});filter.append(clear);
  document.addEventListener('click',event=>{document.querySelectorAll('.label-combobox').forEach(host=>{if(!event.composedPath().includes(host))host.closeDropdown?.();});});
  function render() {
    const valid=new Set(catalog().map(l=>l.id));for(const id of selected)if(!valid.has(id))selected.delete(id);
    filter.update();clear.hidden=!selected.size;
    const groups=document.getElementById('label-groups');
    if(!ready()) {groups.innerHTML='<p class="muted">Las etiquetas estarán disponibles cuando el publicador de la VM entregue el catálogo actualizado.</p>';return;}
    const blocks=catalog().map(l=>({label:l,items:allTasks().filter(t=>(t.label_ids||[]).includes(l.id))}));
    blocks.push({label:null,items:allTasks().filter(t=>!t.label_ids?.length)});
    groups.innerHTML=blocks.map(({label,items})=>`<section class="label-group"><h3>${label?chip(label):'Sin etiquetas'} <small>${items.filter(t=>!t.done).length} abiertas · ${items.length} total</small></h3><div class="label-task-list">${items.map(t=>`<button type="button" class="task-card" data-label-task="${t.id}">#${t.id} · ${e(t.title)}<small>${e(t.project)} · ${t.done?'Completada':'Abierta'}</small></button>`).join('')||'<p class="muted">Sin tareas con esta etiqueta.</p>'}</div></section>`).join('');
    document.querySelectorAll('.task-labels').forEach(host=>updateTask(host));
    document.getElementById('customize-labels').disabled=Boolean(pending);
  }
  document.getElementById('label-groups').addEventListener('click',event=>{const item=event.target.closest('[data-label-task]');if(item)showTask(item.dataset.labelTask);});
  const manager=document.createElement('dialog');manager.className='label-dialog';manager.setAttribute('aria-labelledby','label-manager-title');
  manager.innerHTML='<header><h2 id="label-manager-title">Personalizar etiquetas</h2><button type="button" data-close aria-label="Cerrar personalización">×</button></header><p class="muted">Los cambios afectan la etiqueta en todas las tareas de Vikunja que la utilizan.</p><button type="button" id="new-label">+ Crear etiqueta</button><div id="label-manager-list"></div><div class="label-cleanup"><button type="button" id="reset-labels">Eliminar etiquetas anteriores</button><p class="muted">Conserva Carrera tecnológica y elimina las demás etiquetas del catálogo. Guarda un respaldo en la VM antes de eliminarlas.</p></div>';
  document.body.append(manager);
  manager.querySelector('[data-close]').addEventListener('click',()=>manager.close());
  function renderManager() {
    manager.querySelector('#label-manager-list').innerHTML=catalog().map(l=>`<div class="label-manager-row">${chip(l)}<span class="muted">${allTasks().filter(t=>t.label_ids?.includes(l.id)).length} tareas del portafolio</span><button type="button" data-edit-label="${l.id}">Modificar</button><button type="button" data-delete-label="${l.id}"${protectedLabel(l)?' disabled':''}>Eliminar</button></div>`).join('')||'<p class="muted">No hay etiquetas.</p>';
    updatePendingControls();
    manager.querySelectorAll('[data-delete-label]').forEach(button=>{if(protectedLabel(catalog().find(l=>l.id===Number(button.dataset.deleteLabel))))button.disabled=true;});
    manager.querySelector('#reset-labels').disabled=Boolean(pending)||!catalog().some(protectedLabel)||!catalog().some(l=>!protectedLabel(l));
  }
  document.getElementById('customize-labels').addEventListener('click',()=>{renderManager();manager.showModal();});
  manager.querySelector('#new-label').addEventListener('click',()=>openEditor());
  manager.addEventListener('click',event=>{
    const edit=event.target.closest('[data-edit-label]'),remove=event.target.closest('[data-delete-label]');
    if(edit)openEditor(catalog().find(l=>l.id===Number(edit.dataset.editLabel)));
    if(remove){const l=catalog().find(l=>l.id===Number(remove.dataset.deleteLabel));confirmDelete({action:'delete',labelId:l.id},'Eliminar «'+l.title+'»','Se quitará de todas las tareas que la usan. Las tareas se conservan.');}
  });
  manager.querySelector('#reset-labels').addEventListener('click',()=>confirmDelete({action:'reset'},'Eliminar etiquetas anteriores','Se conservará Carrera tecnológica y se eliminarán las otras '+catalog().filter(l=>!protectedLabel(l)).length+' etiquetas y sus asignaciones. Las tareas se conservan.'));
  const confirmation=document.createElement('dialog');confirmation.className='label-dialog';confirmation.setAttribute('aria-labelledby','label-confirm-title');
  confirmation.innerHTML='<h2 id="label-confirm-title"></h2><p></p><div class="label-dialog-actions"><button type="button" data-cancel>Cancelar</button><button type="button" data-confirm>Eliminar</button></div>';document.body.append(confirmation);
  let deletion=null;
  function confirmDelete(action,title,message){deletion=action;confirmation.querySelector('h2').textContent=title;confirmation.querySelector('p').textContent=message;confirmation.showModal();}
  confirmation.querySelector('[data-cancel]').addEventListener('click',()=>confirmation.close());
  confirmation.querySelector('[data-confirm]').addEventListener('click',()=>{confirmation.close();void submit(deletion);});
  const editor=document.createElement('dialog');editor.className='label-dialog';editor.setAttribute('aria-labelledby','label-editor-title');
  editor.innerHTML='<header><h2 id="label-editor-title">Crear etiqueta</h2><button type="button" data-close aria-label="Cerrar editor">×</button></header><form><label class="label-field">Nombre<input name="title" maxlength="100" required autocomplete="off"></label><fieldset><legend>Color</legend><div class="label-palette" role="radiogroup" aria-label="Color de etiqueta"></div></fieldset><div class="label-preview" aria-label="Vista previa"></div><p class="label-error" role="alert"></p><div class="label-dialog-actions"><button type="button" data-close>Cancelar</button><button type="submit">Guardar</button></div></form>';document.body.append(editor);
  let editing=null,editorTaskId=null,picked='86e2bb';
  editor.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>editor.close()));
  function preview(){editor.querySelector('.label-preview').innerHTML=chip({title:editor.querySelector('input').value||'Nueva etiqueta',hex_color:picked});editor.querySelectorAll('[data-color]').forEach(b=>{b.setAttribute('aria-checked',String(b.dataset.color===picked));b.tabIndex=b.dataset.color===picked?0:-1;});}
  function openEditor(label=null,taskId=null,title='') {
    editing=label;editorTaskId=taskId;picked=palette.some(p=>p.hex===label?.hex_color)?label.hex_color:'86e2bb';
    editor.querySelector('h2').textContent=label?'Modificar etiqueta':'Crear etiqueta';editor.querySelector('input').value=label?.title||title;editor.querySelector('.label-error').textContent='';
    editor.querySelector('.label-palette').innerHTML=palette.map(p=>`<button type="button" role="radio" data-color="${p.hex}" aria-label="${e(p.name)}" title="${e(p.name)}" style="background-color:#${p.hex};color:${foreground(p.hex)}"><span aria-hidden="true">✓</span></button>`).join('');preview();updatePendingControls();editor.showModal();
  }
  editor.querySelector('input').addEventListener('input',preview);
  editor.querySelector('.label-palette').addEventListener('click',event=>{const b=event.target.closest('[data-color]');if(b){picked=b.dataset.color;preview();}});
  editor.querySelector('.label-palette').addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
    const buttons=[...editor.querySelectorAll('[data-color]')],i=buttons.indexOf(document.activeElement);event.preventDefault();const b=buttons[(i+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1)+buttons.length)%buttons.length];b.focus();picked=b.dataset.color;preview();
  });
  editor.querySelector('form').addEventListener('submit',event=>{event.preventDefault();if(!palette.length)return;void submit({action:editing?'update':'create',title:editor.querySelector('input').value.trim(),color:picked,...(editing?{labelId:editing.id}:editorTaskId?{taskId:Number(editorTaskId)}:{})});});
  function updateTask(host) {
    const task=allTasks().find(t=>String(t.id)===host.dataset.taskId);if(!task)return;
    host.querySelector('.task-label-chips').innerHTML=taskLabels(task).map(l=>`<span class="task-label-item">${chip(l)}<button type="button" data-inline-edit="${l.id}" aria-label="Modificar ${e(l.title)}"${pending?' disabled':''}>✎</button><button type="button" data-remove-label="${l.id}" aria-label="Quitar ${e(l.title)} de esta tarea"${pending?' disabled':''}>×</button></span>`).join('')||'<span class="muted">Sin etiquetas</span>';
    host.querySelector('.label-combobox').update();
  }
  function capture(view){const host=document.querySelector('.task-labels');return host?.dataset.taskId===view.taskId?host:null;}
  function mount(view,retained) {
    if(!view.taskId)return;
    let host=retained;
    if(!host) {
      host=document.createElement('section');host.className='task-labels';host.dataset.taskId=view.taskId;
      host.innerHTML='<h3 class="detail-label">Etiquetas</h3><div class="task-label-chips"></div><div class="label-combobox"></div>';
      combobox(host.querySelector('.label-combobox'),catalog,id=>allTasks().find(t=>String(t.id)===view.taskId)?.label_ids?.includes(id),id=>{
        const t=allTasks().find(t=>String(t.id)===view.taskId);void submit({action:t?.label_ids?.includes(id)?'unassign':'assign',taskId:Number(view.taskId),labelId:id});
      },()=>'+ Agregar o quitar etiquetas',title=>openEditor(null,view.taskId,title));
      host.addEventListener('click',event=>{
        const remove=event.target.closest('[data-remove-label]'),edit=event.target.closest('[data-inline-edit]');
        if(remove)void submit({action:'unassign',taskId:Number(view.taskId),labelId:Number(remove.dataset.removeLabel)});
        if(edit)openEditor(catalog().find(l=>l.id===Number(edit.dataset.inlineEdit)));
      });
    }
    document.getElementById('detail-body').prepend(host);updateTask(host);
  }
  window.DstaLabels={matches,chips,render,mount,capture};
  window.addEventListener('dsta-ai-summaries',render);
  fetch('/label-palette.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('Paleta no disponible');return r.json();}).then(value=>{palette=value;render();}).catch(error=>notify(error.message));
  try {
    const value=JSON.parse(sessionStorage.getItem(storageKey)||'null');
    if(value&&/^[0-9a-f-]{36}$/i.test(value.requestId)){pending=value;if(value.terminal){notify('Revisa el resultado del cambio anterior.');updatePendingControls();}else void track(value);}
  } catch {notify('No se pudo recuperar el seguimiento del cambio anterior.');}
  render();
})();
