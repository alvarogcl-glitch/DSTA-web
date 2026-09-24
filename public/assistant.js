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
    '<header><div><span class="kicker">HERMES · PMO-DSTA</span><strong>Copiloto de gestión</strong></div><button id="dsta-assistant-close" type="button" aria-label="Cerrar copiloto">×</button></header>' +
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
  const history = [];
  let waiting = false;

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

  function addMessage(role, content, pending = false) {
    const bubble = document.createElement('div');
    bubble.className = `dsta-message ${role}${pending ? ' pending' : ''}`;
    bubble.textContent = content;
    messagesEl.append(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  async function waitForReply(id) {
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const response = await fetch(`/api/assistant?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'No se pudo consultar el estado de Hermes.');
      if (result.status === 'completed') return result.reply;
      if (result.status === 'error') throw new Error(result.error || 'Hermes no pudo completar la consulta.');
      status.textContent = result.status === 'running' ? 'Hermes está consultando o ejecutando la acción…' : 'Solicitud en cola para Hermes…';
    }
    throw new Error('La consulta excedió el tiempo de espera. Puedes volver a intentarlo.');
  }

  async function submitMessage(event) {
    event.preventDefault();
    const message = input.value.trim();
    if (!message || waiting) return;
    waiting = true;
    send.disabled = true;
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
      const reply = await waitForReply(queued.id);
      replyBubble.textContent = reply;
      replyBubble.classList.remove('pending');
      history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
      if (history.length > 20) history.splice(0, history.length - 20);
      status.textContent = 'Listo. Puedes continuar la conversación.';
    } catch (error) {
      replyBubble.textContent = error.message;
      replyBubble.classList.remove('pending');
      status.textContent = 'No se completó la solicitud.';
    } finally {
      waiting = false;
      send.disabled = false;
      input.focus();
    }
  }

  toggle.addEventListener('click', () => openPanel(panel.hidden));
  $('#dsta-assistant-close').addEventListener('click', () => openPanel(false));
  $('#dsta-assistant-form').addEventListener('submit', submitMessage);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#dsta-assistant-form').requestSubmit();
    }
  });

  function renderCataSummaries() {
    const summaries = window.__dstaAiSummaries || {};
    document.querySelectorAll('.dsta-ai-task-summary').forEach(item => item.remove());
    document.querySelectorAll('#cata .review-note').forEach(item => { item.hidden = false; });
    document.querySelectorAll('#cata .priority-card[data-task]').forEach(card => {
      const record = summaries[card.dataset.task];
      if (!record?.summary) return;
      const summary = document.createElement('span');
      summary.className = `dsta-ai-task-summary ${record.attention || 'normal'}`;
      const label = document.createElement('b');
      label.textContent = record.attention === 'bloqueada' ? 'Resumen IA · bloqueada' : record.attention === 'seguimiento' ? 'Resumen IA · seguimiento' : 'Resumen IA';
      const text = document.createElement('span');
      text.textContent = record.summary;
      summary.append(label, text);
      if (record.nextAction) {
        const action = document.createElement('span');
        action.className = 'dsta-ai-next-action';
        action.textContent = `Próxima acción: ${record.nextAction}`;
        summary.append(action);
      }
      const oldNote = card.querySelector('.review-note');
      if (oldNote) oldNote.hidden = true;
      card.append(summary);
    });
  }

  window.addEventListener('dsta-ai-summaries', renderCataSummaries);
  renderCataSummaries();
  window.DstaAssistant = { open: () => openPanel(true), renderCataSummaries };
})();
