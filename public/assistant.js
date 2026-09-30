(() => {
  'use strict';

  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = '/assistant.css';
  document.head.append(style);

  const widget = document.createElement('div');
  widget.id = 'dsta-assistant';
  widget.innerHTML = '<button id="dsta-assistant-toggle" type="button" aria-expanded="false" aria-controls="dsta-assistant-panel">✦ Copiloto</button>' +
    '<section id="dsta-assistant-panel" aria-label="Copiloto Hermes" hidden>' +
    '<header><div><span class="kicker">HERMES · PMO-DSTA</span><strong>Copiloto de gestión</strong></div><div class="dsta-assistant-actions"><button id="dsta-assistant-new" type="button" title="Borra la conversación: el copiloto parte sin el contexto anterior">Nueva sesión</button><button id="dsta-assistant-close" type="button" aria-label="Cerrar copiloto">×</button></div></header>' +
    '<div id="dsta-assistant-status" role="status">Consulta el portafolio o pide una acción en Vikunja.</div>' +
    '<div id="dsta-assistant-messages" aria-live="polite"></div>' +
    '<form id="dsta-assistant-form"><textarea id="dsta-assistant-input" rows="3" maxlength="4000" placeholder="Pregunta o indica una acción…" aria-label="Mensaje para Hermes"></textarea><div><small id="dsta-assistant-context"></small><button id="dsta-assistant-send" type="submit">Enviar</button></div></form>' +
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
    contextEl.textContent = task ? `Contexto incluido: #${task.id} · ${task.title}` : 'Se adjunta el contexto si abriste una tarea en el inspector.';
  }

  function openPanel(open = true) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      showContext();
      input.focus();
    }
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
  const minuteLink = /\[([^\]\n]{1,200})\]\(minuta:([^)\n]{1,200})\)/g;
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

  async function waitForReply(id) {
    const deadline = Date.now() + 360_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const response = await fetch(`/api/assistant?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'No se pudo consultar el estado de Hermes.');
      if (result.status === 'completed') return result;
      if (result.status === 'error') throw new Error(result.error || 'Hermes no pudo completar la consulta.');
      status.textContent = result.status === 'running' ? 'Hermes está consultando o ejecutando la acción…' : 'Solicitud en cola para Hermes…';
    }
    throw new Error('La consulta excedió el tiempo de espera. Puedes volver a intentarlo.');
  }

  async function finishPending(id, message, replyBubble) {
    try {
      const result = await waitForReply(id);
      const reply = result.reply;
      renderReply(replyBubble, reply, result.minutes || {});
      replyBubble.classList.remove('pending');
      history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
      if (history.length > 20) history.splice(0, history.length - 20);
      status.textContent = result.refreshError || 'Listo. Puedes continuar la conversación.';
      window.dispatchEvent(new CustomEvent('dsta-snapshot-ready', {
        detail: { timestamp: result.snapshotTimestamp || '' },
      }));
      savePending(null);
    } catch (error) {
      replyBubble.textContent = error.message;
      replyBubble.classList.remove('pending');
      status.textContent = 'No se completó la solicitud.';
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
    const replyBubble = addMessage('assistant', 'Hermes está trabajando…', true);
    status.textContent = 'Conectando con Hermes en la VM…';
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
      const replyBubble = addMessage('assistant', 'Recuperando la respuesta de Hermes…', true);
      status.textContent = 'Retomando la consulta pendiente…';
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
