(() => {
  'use strict';

  // Bandeja de minutas Granola: la VM revisa Granola cada hora, aplica lo evidente y deja
  // propuestas aquí para aprobar, editar o rechazar.
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = '/inbox.css';
  document.head.append(style);

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LABELS = { actualizar: 'Actualizar tarea', comentar: 'Registrar nota', completar: 'Completar tarea', crear: 'Crear tarea', mover: 'Mover tarea' };
  const bell = document.createElement('button');
  bell.type = 'button';
  bell.id = 'dsta-inbox-toggle';
  bell.setAttribute('aria-label', 'Notificaciones de minutas');
  bell.setAttribute('aria-expanded', 'false');
  bell.innerHTML = '<span aria-hidden="true">🔔</span><span class="dsta-inbox-badge" hidden></span>';
  const refreshButton = document.querySelector('#refresh');
  refreshButton.parentElement.insertBefore(bell, refreshButton);

  const panel = document.createElement('aside');
  panel.id = 'dsta-inbox';
  panel.setAttribute('aria-label', 'Minutas Granola');
  panel.hidden = true;
  panel.innerHTML = '<header><div><span class="kicker">GRANOLA · REVISIÓN CADA HORA</span><strong>Minutas nuevas</strong></div>' +
    '<button type="button" id="dsta-inbox-close" aria-label="Cerrar notificaciones">×</button></header>' +
    '<div id="dsta-inbox-body" aria-live="polite"><p class="muted">Cargando…</p></div>';
  document.body.append(panel);
  const body = panel.querySelector('#dsta-inbox-body');

  let minutes = [];
  let lastPayload = '';
  let openId = '';
  let loadError = '';
  const drafts = {}; // minuteId -> actionId -> { decision, instruccion }
  let pollTimer = null;

  const currentTasks = () => (typeof tasks !== 'undefined' && Array.isArray(tasks) ? tasks : []);
  const currentProjects = () => (typeof projects !== 'undefined' && Array.isArray(projects) ? projects : []);
  const pending = minute => minute.acciones.filter(a => !a.auto && ['propuesta', 'error'].includes(a.estado));
  const attention = minute => minute.estado === 'por_revisar' || !minute.vista;
  // Una minuta sale de la bandeja cuando ya no tiene nada por decidir (y ya fue vista).
  const inInbox = minute => attention(minute) || minute.aplicando || minute.id === openId;
  const awaiting = new Set(); // minutas con decisiones enviadas, para avisar el resultado
  let notice = '';

  function draftFor(minuteId, actionId) {
    drafts[minuteId] ??= {};
    drafts[minuteId][actionId] ??= { decision: '', instruccion: '' };
    return drafts[minuteId][actionId];
  }

  // Una instrucción escrita manda sobre Aprobar/Rechazar.
  function chosenDecision(minuteId, action) {
    const draft = draftFor(minuteId, action.id);
    if (draft.instruccion.trim()) return 'instruccion';
    return action.auto ? '' : draft.decision;
  }

  function decidable(minute) {
    return [...pending(minute), ...minute.acciones.filter(a => a.auto)];
  }

  function instructionBox(minute, action, placeholder) {
    const draft = draftFor(minute.id, action.id);
    return `<textarea rows="2" data-instr="${esc(minute.id + '|' + action.id)}" placeholder="${esc(placeholder)}">${esc(draft.instruccion)}</textarea>`;
  }

  function previousInstructions(action) {
    return (action.instrucciones || []).map(item => `<p class="dsta-inbox-instr-done">Tu instrucción: «${esc(item.texto)}» → ${esc(item.resultado)}</p>`).join('');
  }

  function taskLabel(id) {
    const task = currentTasks().find(item => String(item.id) === String(id));
    return task ? `#${task.id} · ${task.title}` : (id ? `#${id}` : 'Sin tarea indicada');
  }

  function lineLabel(id) {
    const project = currentProjects().find(item => String(item.id) === String(id));
    return project ? project.title : (id ? `Línea ${id}` : 'Sin línea indicada');
  }

  function target(action) {
    if (action.tipo === 'crear') return `En ${esc(lineLabel(action.project_id))}: <b>${esc(action.titulo || 'sin título')}</b>`;
    if (action.tipo === 'mover') return `${esc(taskLabel(action.task_id))} → ${esc(lineLabel(action.project_id))}`;
    return esc(taskLabel(action.task_id));
  }

  function proposal(minute, action) {
    const draft = draftFor(minute.id, action.id);
    const choice = value => `<label><input type="radio" name="${esc(minute.id + '|' + action.id)}" data-decision="${esc(minute.id + '|' + action.id)}" value="${value}"${draft.decision === value ? ' checked' : ''}> ${({ aprobar: 'Aprobar', rechazar: 'Rechazar', '': 'Después' })[value]}</label>`;
    return `<article class="dsta-inbox-action${action.estado === 'error' ? ' failed' : ''}">
      <div class="dsta-inbox-action-head"><span class="dsta-inbox-op">${esc(LABELS[action.tipo] || action.tipo)}</span><span class="dsta-inbox-confidence">Confianza ${esc(action.confianza)}</span></div>
      <p class="dsta-inbox-target">${target(action)}</p>
      ${action.nota ? `<p>${esc(action.nota)}</p>` : ''}
      ${action.evidencia ? `<blockquote>${esc(action.evidencia)}</blockquote>` : ''}
      ${action.motivo ? `<p class="muted">Por qué requiere tu revisión: ${esc(action.motivo)}</p>` : ''}
      ${action.estado === 'error' ? `<p class="dsta-inbox-error">${esc(action.resultado)}</p>` : ''}
      ${previousInstructions(action)}
      <div class="dsta-inbox-choice" role="radiogroup" aria-label="Decisión">${choice('aprobar')}${choice('rechazar')}${choice('')}</div>
      <label class="dsta-inbox-field"><span>O indica qué hacer</span>${instructionBox(minute, action, 'Ej: créala en LT2 con responsable Nelson y fecha 15-10 · agrégalo como antecedente en #63 · no corresponde')}</label>
    </article>`;
  }

  function minuteCard(minute) {
    const open = openId === minute.id;
    const proposals = pending(minute);
    const automatic = minute.acciones.filter(a => a.auto);
    const resolved = minute.acciones.filter(a => !a.auto && !['propuesta', 'error'].includes(a.estado));
    const chosen = decidable(minute).filter(a => chosenDecision(minute.id, a)).length;
    const chip = minute.estado === 'por_revisar' ? '<span class="dsta-inbox-chip todo">Nueva minuta por procesar</span>' : '<span class="dsta-inbox-chip done">Procesada</span>';
    let detail = '';
    if (open) {
      detail = `<div class="dsta-inbox-detail">
        ${minute.resumen ? `<p>${esc(minute.resumen)}</p>` : ''}
        <h4>Aplicado automáticamente · ${automatic.length}</h4>
        ${automatic.length ? '<ul class="dsta-inbox-done">' + automatic.map(a => `<li><b>${esc(a.resultado)}</b>${a.nota ? `<br><span>${esc(a.nota)}</span>` : ''}${previousInstructions(a)}
          <details class="dsta-inbox-modify"${draftFor(minute.id, a.id).instruccion ? ' open' : ''}><summary>Modificar</summary>${instructionBox(minute, a, 'Ej: cambia el responsable a Nelson · elimina esta tarea · agrega que falta la firma')}</details></li>`).join('') + '</ul>' : '<p class="muted">Nada evidente para aplicar sin tu revisión.</p>'}
        <h4>Propuestas para tu revisión · ${proposals.length}</h4>
        ${proposals.map(action => proposal(minute, action)).join('') || '<p class="muted">Sin propuestas pendientes.</p>'}
        ${resolved.length ? `<details><summary>Resueltas · ${resolved.length}</summary><ul class="dsta-inbox-done">${resolved.map(a => `<li>${esc(LABELS[a.tipo])}: ${esc(a.resultado)}</li>`).join('')}</ul></details>` : ''}
        ${minute.antecedentes?.length ? `<details><summary>Antecedentes · ${minute.antecedentes.length}</summary><ul>${minute.antecedentes.map(item => `<li>${esc(item)}</li>`).join('')}</ul></details>` : ''}
        ${minute.errorDecision ? `<p class="dsta-inbox-error">${esc(minute.errorDecision)}</p>` : ''}
        ${decidable(minute).length ? `<div class="dsta-inbox-submit"><button type="button" data-submit="${esc(minute.id)}"${chosen && !minute.aplicando ? '' : ' disabled'}>${minute.aplicando ? 'Aplicando en Vikunja… (las instrucciones pueden tardar 1-2 min)' : `Enviar (${chosen})`}</button></div>` : ''}
        <p class="muted dsta-inbox-source">Copia guardada: ${esc(minute.minuta)}</p>
      </div>`;
    }
    return `<section class="dsta-inbox-minute${attention(minute) ? ' attention' : ''}">
      <button type="button" class="dsta-inbox-minute-head" data-open="${esc(minute.id)}" aria-expanded="${open}">
        <span>${chip}${minute.vista ? '' : '<span class="dsta-inbox-dot" aria-label="No vista"></span>'}</span>
        <strong>${esc(minute.titulo)}</strong>
        <small>${esc(minute.fecha || '')} · ${automatic.length} aplicadas · ${proposals.length} por revisar</small>
      </button>${detail}</section>`;
  }

  const processedCount = () => minutes.filter(m => !inInbox(m)).length;

  function render() {
    const count = minutes.filter(attention).length;
    const badge = bell.querySelector('.dsta-inbox-badge');
    badge.hidden = count === 0;
    badge.textContent = count > 9 ? '9+' : String(count);
    bell.classList.toggle('has-news', count > 0);
    bell.title = count ? `${count} minuta(s) por revisar` : 'Sin minutas nuevas';
    if (panel.hidden) return;
    const focused = panel.contains(document.activeElement) && document.activeElement.matches('input:not([type=radio]),textarea,select');
    if (focused) return; // no reescribir mientras se edita un campo
    body.innerHTML = (loadError ? `<p class="dsta-inbox-error">${esc(loadError)}</p>` : '') +
      (notice ? `<p class="dsta-inbox-notice" role="status">${esc(notice)}</p>` : '') +
      (minutes.filter(inInbox).map(minuteCard).join('') || '<p class="muted">Sin minutas pendientes. Granola se revisa cada hora.</p>') +
      (processedCount() ? `<details class="dsta-inbox-history"><summary>Minutas procesadas · ${processedCount()}</summary>${minutes.filter(m => !inInbox(m)).map(minuteCard).join('')}</details>` : '');
  }

  async function load() {
    try {
      const response = await fetch('/api/minutes', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'No se pudo leer la bandeja.');
      loadError = '';
      const text = JSON.stringify(payload.minutes || []);
      if (text !== lastPayload) {
        lastPayload = text;
        minutes = payload.minutes || [];
        for (const id of [...awaiting]) {
          const minute = minutes.find(item => item.id === id);
          if (!minute || minute.aplicando) continue;
          awaiting.delete(id);
          const left = pending(minute).length;
          notice = left ? `Decisiones aplicadas en «${minute.titulo}»; quedan ${left} por decidir.`
            : `«${minute.titulo}» quedó procesada y salió de la bandeja.`;
          if (!left && openId === id) openId = '';
        }
      }
    } catch (error) {
      loadError = error.message;
    }
    render();
    const applying = minutes.some(minute => minute.aplicando);
    clearTimeout(pollTimer);
    pollTimer = setTimeout(load, applying ? 3000 : panel.hidden ? 60000 : 20000);
  }

  function openPanel(open) {
    panel.hidden = !open;
    bell.setAttribute('aria-expanded', String(open));
    if (open) {
      render();
      load();
    }
  }

  async function markSeen(minute) {
    render();
    if (minute.vista) return;
    minute.vista = true;
    try {
      await fetch('/api/minutes/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: minute.id }) });
    } catch (_) { /* se reintenta al volver a abrirla */ }
  }

  async function submit(minuteId) {
    const minute = minutes.find(item => item.id === minuteId);
    if (!minute) return;
    const decisions = decidable(minute).map(action => {
      const decision = chosenDecision(minuteId, action);
      if (!decision) return null;
      const item = { actionId: action.id, decision, edits: {} };
      if (decision === 'instruccion') item.instruccion = draftFor(minuteId, action.id).instruccion.trim();
      return item;
    }).filter(Boolean);
    if (!decisions.length) return;
    minute.aplicando = true;
    render();
    try {
      const response = await fetch('/api/minutes/decide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minuteId, decisions }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'No se pudo enviar la decisión.');
      delete drafts[minuteId];
      awaiting.add(minuteId);
    } catch (error) {
      minute.aplicando = false;
      loadError = error.message;
    }
    lastPayload = '';
    load();
  }

  bell.addEventListener('click', () => openPanel(panel.hidden));
  panel.querySelector('#dsta-inbox-close').addEventListener('click', () => openPanel(false));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) openPanel(false); });
  body.addEventListener('click', event => {
    const opener = event.target.closest('[data-open]');
    if (opener) {
      const minute = minutes.find(item => item.id === opener.dataset.open);
      openId = openId === opener.dataset.open ? '' : opener.dataset.open;
      if (minute && openId) markSeen(minute); else render();
      return;
    }
    const sender = event.target.closest('[data-submit]');
    if (sender) submit(sender.dataset.submit);
  });
  function updateSubmit(minuteId) {
    const button = panel.querySelector(`[data-submit="${CSS.escape(minuteId)}"]`);
    const minute = minutes.find(item => item.id === minuteId);
    if (!button || !minute || minute.aplicando) return;
    const chosen = decidable(minute).filter(a => chosenDecision(minuteId, a)).length;
    button.disabled = chosen === 0;
    button.textContent = `Enviar (${chosen})`;
  }

  body.addEventListener('change', event => {
    const decision = event.target.closest('[data-decision]');
    if (!decision) return;
    const [minuteId, actionId] = decision.dataset.decision.split('|');
    draftFor(minuteId, actionId).decision = decision.value;
    updateSubmit(minuteId);
  });
  body.addEventListener('input', event => {
    const box = event.target.closest('[data-instr]');
    if (!box) return;
    const [minuteId, actionId] = box.dataset.instr.split('|');
    draftFor(minuteId, actionId).instruccion = box.value;
    updateSubmit(minuteId);
  });

  load();
  window.DstaInbox = { open: () => openPanel(true), reload: load };
})();
