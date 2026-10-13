// F3: create, edit, move and archive work lines (LT) and tasks from the dashboard.
// Every change goes through /api/task-actions (leased queue + bridge + snapshot proof) and the
// view refreshes only when the Worker confirms the result.
(() => {
  'use strict';
  const css = document.createElement('style');
  css.textContent = `
.structure-actions{display:flex;align-items:center;gap:6px;margin:10px 0;position:relative}
.structure-actions button,.structure-new-lt,.structure-more summary{width:auto;padding:5px 10px;border-radius:8px;border:1px solid #3a4859;background:transparent;color:#c5d1dd;font:inherit;font-size:13px;cursor:pointer}
.structure-actions button:hover,.structure-new-lt:hover,.structure-more summary:hover{border-color:#68d391;color:#eef3f8}
.structure-more summary{list-style:none;padding:5px 12px}.structure-more summary::-webkit-details-marker{display:none}
.structure-more>div{position:absolute;z-index:5;margin-top:6px;display:grid;gap:4px;min-width:190px;padding:6px;background:#151b23;border:1px solid #3a4859;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.4)}
.structure-more>div button{text-align:left;border-color:transparent}
.structure-actions button.danger{color:#ff9a9a}
.structure-actions .status{color:#9bacbd;font-size:12px}.structure-actions .status.error{color:#ff8a80}
.structure-dialog .hint{display:block;margin-top:4px;color:#9bacbd;font-size:12px}
dialog.structure-dialog{width:min(480px,calc(100vw - 32px));background:#151b23;color:#eef3f8;border:1px solid #3a4859;border-radius:12px;padding:20px}
dialog.structure-dialog::backdrop{background:rgba(0,0,0,.6)}
.structure-dialog label{display:block;margin:12px 0 4px;font-size:13px;color:#c5d1dd}
.structure-dialog input,.structure-dialog textarea,.structure-dialog select{width:100%;padding:9px;border-radius:8px;border:1px solid #3a4859;background:#0d1117;color:#eef3f8;font:inherit}
.structure-dialog .row{display:flex;gap:8px;margin-top:16px}.structure-dialog .row button{flex:1;width:auto}
.structure-dialog .status{min-height:1.3em;margin:10px 0 0;color:#9bacbd}.structure-dialog .status.error{color:#ff8a80}`;
  document.head.append(css);

  const byId = id => projects.find(p => String(p.id) === String(id));
  const taskById = id => tasks.find(t => String(t.id) === String(id));
  const ACTION_TEXT = {
    'lt.create': 'Nueva línea de trabajo', 'lt.rename': 'Renombrar línea', 'lt.describe': 'Descripción de la línea', 'lt.archive': 'Archivar línea',
    'task.create': 'Nueva tarea', 'task.update': 'Editar tarea', 'task.move': 'Mover tarea a otra línea',
  };

  // Same split as tools/structure_actions.split_description: metadata block, detail, trailing log.
  const METADATA_LABELS = new Set(['responsable', 'fecha objetivo', 'dependencia', 'criterio de cierre', 'source', 'action_key']);
  const LOG_ENTRY = /^(?:Actualización|Avance|Cierre|Nota|Seguimiento) \d{4}-\d{2}-\d{2}: /;
  function descriptionParts(description) {
    const paragraphs = String(description || '').replace(/\r/g, '').split('\n\n');
    const first = paragraphs[0].split('\n').filter(line => line.trim());
    if (first.length && first.every(line => line.includes(':')) &&
        first.some(line => METADATA_LABELS.has(line.split(':')[0].trim().toLowerCase()))) paragraphs.shift();
    let logStart = paragraphs.length;
    while (logStart > 0 && LOG_ENTRY.test(paragraphs[logStart - 1].trimStart())) logStart -= 1;
    return { detail: paragraphs.slice(0, logStart).join('\n\n').trim(), log: paragraphs.slice(logStart).join('\n\n') };
  }

  function field(form, { name, label, type = 'text', value = '', options = null, required = false, max = 250, hint = '' }) {
    const wrap = document.createElement('div');
    const id = `structure-${name}`;
    const caption = Object.assign(document.createElement('label'), { htmlFor: id, textContent: label });
    let input;
    if (options) {
      input = document.createElement('select');
      for (const [optionValue, text] of options) input.append(new Option(text, optionValue, false, String(optionValue) === String(value)));
    } else if (type === 'textarea') {
      input = Object.assign(document.createElement('textarea'), { rows: 4, maxLength: 20000, value });
    } else {
      input = Object.assign(document.createElement('input'), { type, value, maxLength: max });
    }
    Object.assign(input, { id, name, required });
    wrap.append(caption, input);
    if (hint) wrap.append(Object.assign(document.createElement('small'), { className: 'hint', textContent: hint }));
    form.append(wrap);
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
  async function track(requestId, status, dialog) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      let job;
      try {
        const response = await fetch(`/api/task-actions?id=${encodeURIComponent(requestId)}`, { cache: 'no-store', credentials: 'same-origin' });
        job = await response.json();
      } catch { continue; }
      if (job.status === 'completed') {
        status.textContent = 'Listo. Actualizando el dashboard…';
        await refreshUntil(job.snapshotTimestamp || '');
        dialog.close();
        return;
      }
      if (job.status === 'error') {
        status.textContent = job.error || 'No se pudo aplicar el cambio.';
        status.className = 'status error';
        return;
      }
      status.textContent = job.status === 'running' ? 'Aplicando en Vikunja…' : 'En cola…';
    }
    status.textContent = 'Sigue en proceso. Revisa en unos minutos con «Actualizar ahora».';
  }

  function open(action, fields, build) {
    const dialog = document.createElement('dialog');
    dialog.className = 'structure-dialog';
    dialog.setAttribute('aria-labelledby', 'structure-title');
    const form = document.createElement('form');
    form.method = 'dialog';
    form.append(Object.assign(document.createElement('h2'), { id: 'structure-title', textContent: ACTION_TEXT[action] }));
    fields.forEach(spec => field(form, spec));
    const status = Object.assign(document.createElement('p'), { className: 'status' });
    status.setAttribute('role', 'status');
    const row = Object.assign(document.createElement('div'), { className: 'row' });
    const submit = Object.assign(document.createElement('button'), { type: 'submit', textContent: action === 'lt.archive' ? 'Archivar' : 'Guardar' });
    const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Cancelar' });
    cancel.addEventListener('click', () => dialog.close());
    row.append(submit, cancel);
    form.append(status, row);
    dialog.append(form);
    dialog.addEventListener('close', () => dialog.remove());
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const body = { action, requestId: crypto.randomUUID(), ...build(values) };
      submit.disabled = true;
      status.className = 'status';
      status.textContent = 'Enviando…';
      try {
        const response = await fetch('/api/task-actions', { method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw Error(payload.error || `HTTP ${response.status}`);
        await track(body.requestId, status, dialog);
      } catch (error) {
        status.textContent = error.message;
        status.className = 'status error';
      } finally {
        submit.disabled = false;
      }
    });
    document.body.append(dialog);
    dialog.showModal();
  }

  // An action without a form: same verified queue, status shown inline instead of in a dialog.
  async function runDirect(action, fields, bar) {
    const status = bar.querySelector('.status') || bar.appendChild(Object.assign(document.createElement('small'), { className: 'status' }));
    status.setAttribute('role', 'status');
    status.textContent = 'Enviando…';
    const requestId = crypto.randomUUID();
    try {
      const response = await fetch('/api/task-actions', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, requestId, ...fields }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(payload.error || `HTTP ${response.status}`);
      await track(requestId, status, { close() {} });
    } catch (error) {
      status.textContent = error.message;
      status.className = 'status error';
    }
  }

  const clean = values => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
  const ltOptions = exceptId => projects.filter(p => String(p.id) !== String(exceptId)).map(p => [p.id, p.title]);

  function mount(view) {
    const body = document.querySelector('#detail-body');
    if (!body || view.minuteText !== undefined || view.labelId) return;
    // D02-A: one discreet main action; the rest live in a "⋯" menu (same on desktop and mobile).
    const bar = Object.assign(document.createElement('div'), { className: 'structure-actions' });
    const more = Object.assign(document.createElement('details'), { className: 'structure-more' });
    const menu = document.createElement('div');
    more.append(Object.assign(document.createElement('summary'), { textContent: '⋯', title: 'Más acciones' }), menu);
    more.querySelector('summary').setAttribute('aria-label', 'Más acciones');
    const button = (text, handler, danger = false, primary = false) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text });
      if (danger) b.className = 'danger';
      b.addEventListener('click', () => { more.open = false; handler(); });
      (primary ? bar : menu).append(b);
    };
    if (view.taskId) {
      const task = taskById(view.taskId);
      if (!task) return;
      // D04 + D06-A: separate fields; only changed ones are sent. The log is append-only (Registrar),
      // so the form never rewrites the whole description. D05: the date sent is the native one.
      const known = value => (value && !/^por confirmar$/i.test(String(value).trim()) ? String(value) : '');
      const parts = descriptionParts(task.description);
      const original = { owner: known(task.owner), dependency: known(task.dependency), criterion: known(task.criterion),
        dueDate: /^\d{4}-\d{2}-\d{2}$/.test(task.date || '') ? task.date : '', detail: parts.detail };
      const logCount = parts.log ? parts.log.split('\n\n').length : 0;
      button('Editar', () => open('task.update', [
        { name: 'title', label: 'Título', value: task.title, required: true },
        { name: 'owner', label: 'Responsable', value: original.owner, max: 300 },
        { name: 'dueDate', label: 'Fecha objetivo', type: 'date', value: original.dueDate },
        { name: 'dependency', label: 'Dependencia', value: original.dependency, max: 300 },
        { name: 'criterion', label: 'Criterio de cierre', value: original.criterion, max: 300 },
        { name: 'detail', label: 'Detalle', type: 'textarea', value: original.detail,
          hint: logCount ? `La bitácora (${logCount} ${logCount === 1 ? 'registro' : 'registros'}) se conserva; para sumar uno usa «+ Agregar registro».` : '' },
      ], v => clean({ taskId: task.id, title: v.title.trim(),
        ...Object.fromEntries(['owner', 'dependency', 'criterion', 'dueDate', 'detail']
          .filter(key => v[key].trim() !== original[key].trim()).map(key => [key, v[key].trim()])) })), false, true);
      if (projects.length > 1) {
        button('Mover a otra línea', () => open('task.move', [
          { name: 'projectId', label: 'Línea de destino', options: ltOptions(task.project_id) },
        ], v => ({ taskId: task.id, projectId: Number(v.projectId) })));
      }
      // D14: reversible, so no confirmation; progress shows next to the buttons.
      if (task.done) button('Reabrir tarea', () => void runDirect('task.reopen', { taskId: task.id }, bar));
    } else if (view.projectId) {
      const project = byId(view.projectId);
      if (!project) return;
      // D04/D07: same fields as the copilot's creation tool; the origin goes to SOURCE/ACTION_KEY.
      button('+ Nueva tarea', () => open('task.create', [
        { name: 'title', label: 'Título', required: true },
        { name: 'owner', label: 'Responsable', max: 300 },
        { name: 'dueDate', label: 'Fecha objetivo', type: 'date' },
        { name: 'dependency', label: 'Dependencia', max: 300 },
        { name: 'criterion', label: 'Criterio de cierre', max: 300 },
        { name: 'description', label: 'Descripción', type: 'textarea' },
      ], v => clean({ projectId: project.id, title: v.title.trim(), description: v.description || undefined, dueDate: v.dueDate || undefined,
        owner: v.owner.trim() || undefined, dependency: v.dependency.trim() || undefined, criterion: v.criterion.trim() || undefined,
        origin: 'form' })), false, true);
      button('Renombrar línea', () => open('lt.rename', [
        { name: 'title', label: 'Nuevo nombre', value: project.title, required: true },
      ], v => ({ projectId: project.id, title: v.title.trim() })));
      button('Editar descripción', () => open('lt.describe', [
        { name: 'description', label: 'Descripción de la línea', type: 'textarea', value: project.description || '' },
      ], v => ({ projectId: project.id, description: v.description.trim() })));
      // D25: the Worker and the bridge refuse it while the line has open tasks (the message says how many).
      button('Archivar línea', () => open('lt.archive', [], () => ({ projectId: project.id })), true);
    } else {
      return;
    }
    if (menu.childElementCount) bar.append(more);
    body.prepend(bar);
  }

  function addNewLineButton() {
    const minute = document.querySelector('#portfolio-minute');
    if (!minute || document.querySelector('.structure-new-lt')) return;
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'structure-new-lt', textContent: '+ Nueva línea' });
    button.addEventListener('click', () => open('lt.create', [{ name: 'title', label: 'Nombre de la línea', required: true }],
      v => ({ title: v.title.trim() })));
    minute.before(button);
  }

  // D27: archived lines live in ⚙ Configuración, each with "Restaurar" (same verified queue).
  function addArchivedSection() {
    if (!window.DstaSettings || document.querySelector('.structure-archived')) return;
    const box = Object.assign(document.createElement('div'), { className: 'structure-archived structure-actions' });
    box.style.cssText = 'display:grid;gap:6px;margin:0';
    const render = () => {
      const archived = window.__dstaArchived || [];
      box.replaceChildren(...(archived.length ? archived.map(line => {
        const row = Object.assign(document.createElement('div'), { className: 'structure-actions' });
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:0;flex-wrap:wrap';
        const name = Object.assign(document.createElement('span'), { textContent: line.title });
        name.style.flex = '1 1 auto';
        const restore = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Restaurar' });
        restore.addEventListener('click', () => { restore.disabled = true; void runDirect('lt.restore', { projectId: line.id }, row); });
        row.append(name, restore);
        return row;
      }) : [Object.assign(document.createElement('small'), { className: 'muted', textContent: 'No hay líneas archivadas.' })]));
    };
    render();
    window.addEventListener('dsta-archived', render);
    window.DstaSettings.addSection('Líneas archivadas', box, 40);
  }

  // Only in accounts mode (the single-user dashboard keeps its legacy surface).
  let enabled = false;
  window.DstaStructure = { mount: view => { if (enabled) mount(view); } };
  fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' }).then(response => {
    if (!response.ok) return;
    enabled = true;
    const start = () => { addNewLineButton(); addArchivedSection(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
    window.addEventListener('dsta-settings-ready', addArchivedSection);
  }).catch(() => {});
})();
