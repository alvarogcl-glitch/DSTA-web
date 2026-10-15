(() => {
  'use strict';

  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = '/assistant.css';
  document.head.append(style);

  const widget = document.createElement('div');
  widget.id = 'dsta-assistant';
  widget.innerHTML = '<button id="dsta-assistant-toggle" type="button" aria-expanded="false" aria-controls="dsta-assistant-panel">✦ Copiloto</button>' +
    '<section id="dsta-assistant-panel" aria-label="Copiloto" hidden>' +
    '<header><div><span class="kicker">COPILOTO · PMO-DSTA</span><strong>Copiloto de gestión</strong></div><div class="dsta-assistant-actions"><button id="dsta-assistant-new" type="button" title="Borra la conversación: el copiloto parte sin el contexto anterior">Nueva sesión</button><button id="dsta-assistant-close" type="button" aria-label="Cerrar copiloto">×</button></div></header>' +
    '<div id="dsta-assistant-status" role="status">Consulta el portafolio o pide una acción en Vikunja.</div>' +
    '<div id="dsta-assistant-messages" aria-live="polite"></div>' +
    '<form id="dsta-assistant-form"><textarea id="dsta-assistant-input" rows="3" maxlength="4000" placeholder="Pregunta o indica una acción…" aria-label="Mensaje para el copiloto"></textarea><div><small id="dsta-assistant-context"></small><button id="dsta-assistant-send" type="submit">Enviar</button></div></form>' +
    '</section>';
  document.body.append(widget);

  const $ = selector => widget.querySelector(selector);
  const toggle = $('#dsta-assistant-toggle');
  const panel = $('#dsta-assistant-panel');
  const input = $('#dsta-assistant-input');
  const send = $('#dsta-assistant-send');
  const status = $('#dsta-assistant-status');
  const messagesEl = $('#dsta-assistant-messages');
  const contextEl = $('#dsta-assistant-context');
  const newSession = $('#dsta-assistant-new');
  const history = [];
  const pendingKey = 'dsta-assistant-pending-v1';
  let waiting = false;

  function savePending(value) {
    try {
      if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value));
      else sessionStorage.removeItem(pendingKey);
    } catch (_) { /* El chat sigue funcionando si el navegador bloquea el almacenamiento. */ }
  }

  function selectedTask() {
    const id = typeof inspection !== 'undefined' && inspection?.taskId;
    return id ? tasks.find(task => String(task.id) === String(id)) || null : null;
  }

  function showContext() {
    const task = selectedTask();
    contextEl.textContent = task ? `Contexto incluido: #${task.num ?? task.id} · ${task.title}` : 'Se adjunta el contexto si abriste una tarea en el inspector.';
  }

  // While the window is open the VM looks for new questions every 2 s (instead of 12 s).
  let lastWarm = 0;
  function warmUp() {
    if (Date.now() - lastWarm < 90_000) return;
    lastWarm = Date.now();
    fetch('/api/assistant/warm', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
  }
  function openPanel(open = true) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      warmUp();
      showContext();
      input.focus();
    }
    renderChatNotice();
  }

  // While the copilot works and its window is closed, a notice tells where the question is; when the
  // answer arrives it stays as «Respuesta lista», and tapping it opens the copilot.
  let chatNote = null;
  const shortQuestion = text => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > 48 ? t.slice(0, 47) + '…' : t; };
  function renderChatNotice() {
    if (!chatNote || !window.DstaToast) return;
    const toast = window.DstaToast.task(chatNote.key);
    if (!panel.hidden) { toast.close(); if (chatNote.result) chatNote = null; return; }
    const head = `Copiloto: «${chatNote.question}»`;
    if (chatNote.result === 'ready') { toast.ready(`${head} · Respuesta lista: toca para verla`, () => { chatNote = null; openPanel(true); }); return; }
    if (chatNote.result === 'error') { toast.fail(`${head} · ${chatNote.step}`); return; }
    const secs = Math.round((Date.now() - chatNote.started) / 1000);
    toast.step(`${head} · ${chatNote.step}${secs >= 5 ? ` (${secs} s)` : ''}`);
  }
  function chatProgress(step, result = '') {
    if (!chatNote) return;
    Object.assign(chatNote, { step, result });
    renderChatNotice();
    if (result) { if (!panel.hidden) chatNote = null; }
  }

  function setWaiting(value) {
    waiting = value;
    send.disabled = value;
    newSession.disabled = value;
  }

  // The conversation lives only in this tab (the history travels with each request), so
  // clearing it here is enough for the copilot to start without the previous context.
  function startNewSession() {
    if (waiting) return;
    history.length = 0;
    messagesEl.replaceChildren();
    status.textContent = 'Nueva sesión: el copiloto no recuerda la conversación anterior.';
    input.value = '';
    showContext();
    input.focus();
  }

  function addMessage(role, content, pending = false) {
    const bubble = document.createElement('div');
    bubble.className = `dsta-message ${role}${pending ? ' pending' : ''}`;
    bubble.textContent = content;
    messagesEl.append(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  // Minutas citadas como [título](minuta:<id>): el puente adjunta su texto y se abren en una
  // ventana flotante dentro del dashboard. Todo se construye con nodos de texto, sin HTML del modelo.
  const minuteLink = /\[((?:[^\[\]\n]|\[[^\[\]\n]*\]){1,200})\]\(minuta:([^)\n]{1,200})\)/g;
  const knownMinutes = {};

  function renderReply(bubble, reply, minutes = {}) {
    Object.assign(knownMinutes, minutes);
    bubble.replaceChildren();
    let last = 0;
    for (const match of reply.matchAll(minuteLink)) {
      bubble.append(document.createTextNode(reply.slice(last, match.index)));
      const [, label, id] = match;
      if (knownMinutes[id.trim()]) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'dsta-minute-link';
        link.dataset.minute = id.trim();
        link.textContent = `📄 ${label}`;
        bubble.append(link);
      } else {
        bubble.append(document.createTextNode(label));
      }
      last = match.index + match[0].length;
    }
    bubble.append(document.createTextNode(reply.slice(last)));
  }

  const viewer = document.createElement('section');
  viewer.id = 'dsta-minute-viewer';
  viewer.hidden = true;
  viewer.setAttribute('aria-label', 'Minuta');
  viewer.innerHTML = '<header><div><span class="kicker">MINUTA · GRANOLA</span><strong id="dsta-minute-title"></strong><small id="dsta-minute-date"></small></div>' +
    '<button type="button" id="dsta-minute-close" aria-label="Cerrar minuta">×</button></header><article id="dsta-minute-body"></article>';
  document.body.append(viewer);

  function openMinute(id) {
    const minute = knownMinutes[id];
    if (!minute) return;
    viewer.querySelector('#dsta-minute-title').textContent = minute.titulo || id;
    viewer.querySelector('.kicker').textContent = /manual/i.test(minute.origen || '') ? 'MINUTA · MANUAL' : 'MINUTA · GRANOLA';
    viewer.querySelector('#dsta-minute-date').textContent = minute.fecha ? minute.fecha.split('-').reverse().join('-') : '';
    const body = viewer.querySelector('#dsta-minute-body');
    body.replaceChildren(...minute.contenido.split('\n').map(line => {
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      const item = document.createElement(heading ? `h${Math.min(heading[1].length + 2, 6)}` : 'p');
      item.textContent = heading ? heading[2] : line.replace(/^\s*[-*]\s+/, '• ');
      if (!heading && /^\s{2,}[-*]\s+/.test(line)) item.className = 'nested';
      if (!line.trim()) item.className = 'gap';
      return item;
    }));
    // A handwritten manual minute: the original pages above its transcription (read-only).
    if (minute.borrador && window.DstaInk) {
      const holder = Object.assign(document.createElement('div'), { className: 'dsta-minute-ink' });
      body.prepend(holder);
      fetch('/api/manual-minutes/ink?id=' + encodeURIComponent(minute.borrador), { cache: 'no-store', credentials: 'same-origin',
        headers: { 'x-dsta-actor': window.__dstaActorId || '' } })
        .then(r => r.ok ? r.json() : {}).then(p => {
          if (!p.ink) { holder.remove(); return; }
          const pad = window.DstaInk.create({ ink: p.ink, readOnly: true, compact: true });
          holder.append(Object.assign(document.createElement('h5'), { textContent: 'Escrito a mano (original)' }), pad.el);
        }).catch(() => holder.remove());
    }
    body.scrollTop = 0;
    viewer.hidden = false;
    viewer.querySelector('#dsta-minute-close').focus();
  }

  messagesEl.addEventListener('click', event => {
    const link = event.target.closest('[data-minute]');
    if (link) openMinute(link.dataset.minute);
  });
  viewer.querySelector('#dsta-minute-close').addEventListener('click', () => { viewer.hidden = true; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !viewer.hidden) viewer.hidden = true; });

  // Copilot proposals (multiuser): suggestions are applied when the user clicks; explicit requests
  // (D03) were queued by the Worker. Both go through the
  // same verified action queue as the dashboard buttons (/api/task-actions).
  const lineName = id => (typeof projects !== 'undefined' && projects.find(p => p.id === id)?.title) || `LT ${id}`;
  const taskName = id => (typeof tasks !== 'undefined' && tasks.find(t => t.id === id)?.title) || `#${window.DstaTaskNumber?.(id) ?? id}`;
  const labelName = id => (typeof labels !== 'undefined' && labels.find(l => l.id === id)?.title) || `#${id}`;
  // D30: label changes use the label queue; everything else the structure/action queue.
  const isLabel = proposal => proposal.queue === 'label' || String(proposal.action).startsWith('label.');
  const queueUrl = proposal => (isLabel(proposal) ? '/api/label-actions' : '/api/task-actions');
  window.DstaDescribeAction = p => describeProposal(p);  // shared concrete wording (notices, D62)
  function describeProposal(p) {
    switch (p.action) {
      case 'task.create': return `Crear tarea «${p.title}» en ${lineName(p.projectId)}${p.dueDate ? ` (fecha ${p.dueDate})` : ''}`;
      case 'task.update': return `Editar «${taskName(p.taskId)}» → «${p.title}»`;
      case 'task.move': return `Mover «${taskName(p.taskId)}» a ${lineName(p.projectId)}`;
      case 'complete': return `Completar «${taskName(p.taskId)}»`;
      case 'task.reopen': return `Reabrir «${taskName(p.taskId)}»`;
      case 'lt.create': return `Crear línea «${p.title}»`;
      case 'lt.rename': return `Renombrar ${lineName(p.projectId)} → «${p.title}»`;
      case 'lt.describe': return `Cambiar la descripción de ${lineName(p.projectId)}`;
      case 'lt.archive': return `Archivar ${lineName(p.projectId)}`;
      case 'lt.restore': return `Restaurar la línea archivada ${(window.__dstaArchived || []).find(l => l.id === p.projectId)?.title || `LT ${p.projectId}`}`;
      case 'lt.merge': return `Fusionar ${lineName(p.projectId)} en ${lineName(p.targetProjectId)} (mueve sus tareas y archiva el origen)`;
      case 'label.assign': return `Poner la etiqueta «${labelName(p.labelId)}» a «${taskName(p.taskId)}»`;
      case 'label.unassign': return `Quitar la etiqueta «${labelName(p.labelId)}» de «${taskName(p.taskId)}»`;
      default: return p.action;
    }
  }
  // refresh() returns false while another refresh is running: retry like the dashboard's own
  // 'dsta-snapshot-ready' handler until the confirmed snapshot is shown.
  async function refreshUntil(timestamp) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (typeof refresh === 'function' && await refresh(timestamp)) return true;
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    return false;
  }
  // Follows a queued action until the snapshot confirms it (same proof as the dashboard buttons).
  async function watchAction(requestId, note, url = '/api/task-actions', label = 'Cambio del copiloto') {
    const toast = window.DstaToast?.task(requestId);
    toast?.step(`${label} · ${window.DstaSteps?.queue('queued') || 'En cola…'}`);
    try {
      for (let i = 0; i < 80; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const job = await (await fetch(`${url}?id=${requestId}`, { cache: 'no-store' })).json();
        if (job.status === 'completed') {
          note.textContent = 'Actualizando el dashboard…';
          toast?.step(`${label} · ${window.DstaSteps?.refreshing || 'Actualizando…'}`);
          const shown = await refreshUntil(job.snapshotTimestamp || '');
          note.textContent = shown ? '✓ Aplicado' : '✓ Aplicado (pulsa Actualizar ahora para verlo)';
          toast?.done(`${label} · ✓ Aplicado`);
          return;
        }
        if (job.status === 'error') throw new Error(job.error || 'No se pudo aplicar.');
        if (job.status) toast?.step(`${label} · ${window.DstaSteps?.queue(job.status) || 'En proceso…'}`);
      }
    } catch (error) {
      toast?.fail(`${label}: ${error.message}`);
      throw error;
    }
    note.textContent = 'Sigue en proceso; revisa en unos minutos.';
    toast?.fail(`${label}: sigue en proceso; revisa en unos minutos.`);
  }
  async function applyProposal(proposal, button, note) {
    button.disabled = true;
    note.textContent = 'Aplicando…';
    const requestId = crypto.randomUUID();
    const { execute, requestId: _executed, executeError, queue, ...action } = proposal;
    const body = isLabel(proposal)
      ? { action: action.action === 'label.assign' ? 'assign' : 'unassign', taskId: action.taskId, labelId: action.labelId, requestId }
      : { ...action, requestId };
    try {
      const response = await fetch(queueUrl(proposal), { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const queued = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(queued.error || `HTTP ${response.status}`);
      window.DstaPending?.add({ id: requestId, url: queueUrl(proposal), label: describeProposal(proposal) });  // D62
      await watchAction(requestId, note, queueUrl(proposal), describeProposal(proposal));
      window.DstaPending?.done(requestId);
      button.hidden = true;
      return true;
    } catch (error) {
      note.textContent = error.message;
      if (/no se pudo|error/i.test(error.message)) window.DstaPending?.done(requestId);
      button.disabled = false;
      return false;
    }
  }
  function renderProposals(bubble, proposals) {
    if (!proposals.length) return;
    const box = document.createElement('div');
    box.className = 'dsta-proposals';
    box.style.cssText = 'margin-top:10px;display:grid;gap:6px';
    const pending = [];
    for (const proposal of proposals) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
      const button = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Aplicar' });
      button.style.cssText = 'width:auto;padding:4px 10px';
      const label = Object.assign(document.createElement('span'), { textContent: describeProposal(proposal) });
      const note = Object.assign(document.createElement('small'), { className: 'muted' });
      button.addEventListener('click', () => void applyProposal(proposal, button, note));
      // D03: what was asked explicitly already runs by itself; "Aplicar" only reappears to retry.
      if (proposal.requestId) {
        button.hidden = true;
        note.textContent = 'Ejecutando…';
        window.DstaPending?.add({ id: proposal.requestId, url: queueUrl(proposal), label: describeProposal(proposal) });  // D62
        watchAction(proposal.requestId, note, queueUrl(proposal), describeProposal(proposal)).then(() => window.DstaPending?.done(proposal.requestId)).catch(error => {
          window.DstaPending?.done(proposal.requestId);
          note.textContent = `${error.message} Puedes reintentar.`;
          button.textContent = 'Reintentar';
          button.hidden = false;
        });
      } else if (proposal.executeError) {
        note.textContent = `No se ejecutó: ${proposal.executeError}`;
        button.textContent = 'Reintentar';
      }
      row.append(button, label, note);
      box.append(row);
      if (!proposal.requestId) pending.push({ proposal, button, note });
    }
    // D37: suggestions can be applied together, one after another in the proposed order; it stops at
    // the first failure so a later change never runs on top of one that did not happen.
    if (pending.length > 1) {
      const all = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Aplicar todas' });
      all.style.cssText = 'width:auto;padding:4px 10px;justify-self:start';
      all.addEventListener('click', async () => {
        all.disabled = true;
        for (const item of pending) {
          if (item.button.hidden) continue;
          if (!await applyProposal(item.proposal, item.button, item.note)) { all.disabled = false; return; }
        }
        all.hidden = true;
      });
      box.append(all);
    }
    bubble.append(box);
  }

  async function waitForReply(id) {
    const deadline = Date.now() + 360_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const response = await fetch(`/api/assistant?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'No se pudo consultar el estado del copiloto.');
      if (result.status === 'completed') return result;
      if (result.status === 'error') throw new Error(result.error || 'El copiloto no pudo completar la consulta.');
      status.textContent = result.status === 'running' ? 'Pensando: consulta tu portafolio y minutas…' : 'En cola, esperando a la VM…';
      chatProgress(result.status === 'running' ? 'Pensando: revisa tu portafolio y minutas…' : 'En cola, esperando a la VM…');
    }
    throw new Error('La consulta excedió el tiempo de espera. Puedes volver a intentarlo.');
  }

  async function finishPending(id, message, replyBubble) {
    try {
      const result = await waitForReply(id);
      const reply = result.reply;
      renderReply(replyBubble, reply, result.minutes || {});
      renderProposals(replyBubble, result.proposals || []);
      replyBubble.classList.remove('pending');
      history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
      if (history.length > 20) history.splice(0, history.length - 20);
      // Which engine answered and how long it took (engine time and total time since sending).
      const timing = result.engine ? `Respondió ${result.engine}${result.engineSeconds != null ? ` · ${result.engineSeconds} s el motor` : ''}${result.totalSeconds != null ? ` · ${result.totalSeconds} s en total` : ''}.` : '';
      status.textContent = result.refreshError || `Listo. ${timing} Puedes continuar la conversación.`.replace('  ', ' ');
      chatProgress('Respuesta lista', 'ready');
      window.dispatchEvent(new CustomEvent('dsta-snapshot-ready', {
        detail: { timestamp: result.snapshotTimestamp || '' },
      }));
      savePending(null);
    } catch (error) {
      replyBubble.textContent = error.message;
      replyBubble.classList.remove('pending');
      status.textContent = 'No se completó la solicitud.';
      chatProgress(error.message, 'error');
      if (!error.message.includes('excedió el tiempo')) savePending(null);
    } finally {
      setWaiting(false);
      input.focus();
    }
  }

  async function submitMessage(event) {
    event.preventDefault();
    const message = input.value.trim();
    if (!message || waiting) return;
    setWaiting(true);
    const task = selectedTask();
    const historyForRequest = history.slice(-20);
    addMessage('user', message);
    const replyBubble = addMessage('assistant', 'Pensando…', true);
    status.textContent = 'Enviando a la VM…';
    chatNote = { key: 'chat:' + Date.now(), question: shortQuestion(message), started: Date.now(), step: 'Enviando…', result: '' };
    renderChatNotice();
    input.value = '';
    try {
      const response = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, history: historyForRequest, taskId: task?.id ?? null }),
      });
      const queued = await response.json();
      if (!response.ok) throw new Error(queued.error || 'No se pudo enviar la consulta.');
      savePending({ id: queued.id, message });
      await finishPending(queued.id, message, replyBubble);
    } catch (error) {
      replyBubble.textContent = error.message;
      replyBubble.classList.remove('pending');
      status.textContent = 'No se completó la solicitud.';
      input.value = message;
      setWaiting(false);
      input.focus();
    }
  }

  toggle.addEventListener('click', () => openPanel(panel.hidden));
  $('#dsta-assistant-close').addEventListener('click', () => openPanel(false));
  newSession.addEventListener('click', startNewSession);
  $('#dsta-assistant-form').addEventListener('submit', submitMessage);
  input.addEventListener('input', warmUp);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#dsta-assistant-form').requestSubmit();
    }
  });

  try {
    const pending = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
    if (pending && /^[0-9a-f-]{36}$/i.test(pending.id) && typeof pending.message === 'string') {
      setWaiting(true);
      openPanel(true);
      addMessage('user', pending.message);
      const replyBubble = addMessage('assistant', 'Recuperando la respuesta…', true);
      status.textContent = 'Retomando la consulta pendiente…';
      chatNote = { key: 'chat:' + pending.id, question: shortQuestion(pending.message), started: Date.now(), step: 'Retomando…', result: '' };
      void finishPending(pending.id, pending.message, replyBubble);
    }
  } catch (_) { savePending(null); }

  function renderCataSummaries() {
    const summaries = window.__dstaAiSummaries || {};
    document.querySelectorAll('.dsta-ai-task-summary').forEach(item => item.remove());
    document.querySelectorAll('#cata .review-note').forEach(item => { item.hidden = false; });
    document.querySelectorAll('#cata .priority-card[data-task]').forEach(card => {
      const record = summaries[card.dataset.task];
      if (!record?.summary) return;
      const summary = card.querySelector('.review-note') || document.createElement('span');
      summary.className = `review-note dsta-ai-task-summary ${record.attention || 'normal'}`;
      summary.replaceChildren();
      const label = document.createElement('b');
      label.textContent = 'Para revisar con Cata · Resumen IA';
      const text = document.createElement('span');
      text.textContent = record.summary;
      summary.append(label, text);
      if (record.nextAction) {
        const action = document.createElement('span');
        action.className = 'dsta-ai-next-action';
        action.textContent = `Próxima acción: ${record.nextAction}`;
        summary.append(action);
      }
      if (!summary.parentElement) card.append(summary);
    });
  }

  window.addEventListener('dsta-ai-summaries', renderCataSummaries);
  renderCataSummaries();
  window.DstaAssistant = { open: () => openPanel(true), renderCataSummaries };
})();
