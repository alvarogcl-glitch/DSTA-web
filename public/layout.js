'use strict';
// Customisable dashboard sections: order, on/off, names and custom filter sections (keywords,
// owner, dependency, work lines, labels, status) with optional AI summaries.
// The layout is stored per box (/api/preferences/layout) and edited from the settings gear.
(() => {
  const BUILTIN_ANCHORS = { portfolio: '#projects', upcoming: '#upcoming', cata: '#cata', labels: '#label-section', inventory: '#rows' };
  const FIELD_LABELS = { title: 'Título', description: 'Descripción', owner: 'Responsable', dependency: 'Dependencia', criterion: 'Criterio de cierre' };
  let layout = null;

  const fold = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Same semantics as taskMatchesFilters in src/worker.js.
  function matches(task, filters = {}) {
    if (filters.status === 'open' && task.done) return false;
    const keywords = (filters.keywords || []).map(fold).filter(Boolean);
    if (keywords.length) {
      const fields = filters.fields?.length ? filters.fields : Object.keys(FIELD_LABELS);
      const text = fields.map(field => fold(task[field])).join(' \n ');
      if (!keywords.some(word => text.includes(word))) return false;
    }
    if (filters.owner && !fold(task.owner).includes(fold(filters.owner))) return false;
    if (filters.dependency && !fold(task.dependency).includes(fold(filters.dependency))) return false;
    if (filters.projectIds?.length && !filters.projectIds.includes(task.project_id)) return false;
    if (filters.labelIds?.length && !(task.label_ids || []).some(id => filters.labelIds.includes(id))) return false;
    return true;
  }
  const builtinSection = key => document.querySelector(BUILTIN_ANCHORS[key])?.closest('section.panel') || null;
  const sectionHeading = section => section.querySelector('.panel-heading h2, h2');

  // ── Apply the layout to the page ──
  function apply() {
    if (!layout) return;
    const main = document.querySelector('main.wrap');
    const anchor = document.querySelector('#metrics');
    if (!main || !anchor) return;
    let previous = anchor;
    const wanted = new Set();
    for (const section of layout.sections) {
      let element;
      if (section.kind === 'builtin') {
        element = builtinSection(section.key);
        if (!element) continue;
        if (!element.dataset.originalTitle) element.dataset.originalTitle = sectionHeading(element)?.textContent || '';
        const heading = sectionHeading(element);
        if (heading) heading.textContent = section.title;
      } else {
        element = document.querySelector(`section[data-custom-section="${section.id}"]`) || createCustom(section);
        element.querySelector('h2').textContent = section.title;
        element.classList.toggle('dsta-ai-section', Boolean(section.ai));
      }
      wanted.add(element);
      element.hidden = !section.enabled;
      previous.after(element);
      previous = element;
    }
    document.querySelectorAll('section[data-custom-section]').forEach(element => { if (!wanted.has(element)) element.remove(); });
    for (const key of Object.keys(BUILTIN_ANCHORS)) {
      const element = builtinSection(key);
      if (element && !wanted.has(element)) element.hidden = true;
    }
    renderCustom();
  }

  function createCustom(section) {
    const element = document.createElement('section');
    element.className = 'panel dsta-custom-section';
    element.dataset.customSection = section.id;
    const heading = document.createElement('div');
    heading.className = 'panel-heading';
    const title = document.createElement('h2');
    const minute = Object.assign(document.createElement('button'), { type: 'button', className: 'dsta-custom-minute', textContent: 'Generar minuta' });
    minute.addEventListener('click', () => customMinute(section.id));
    heading.append(title, minute);
    const list = Object.assign(document.createElement('div'), { className: 'priority-list dsta-custom-list' });
    // D51: same selection hint as the original panels (shown while the section is in selection mode).
    const hint = Object.assign(document.createElement('div'), { className: 'select-hint' });
    hint.setAttribute('role', 'status');
    const clear = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Quitar selección' });
    clear.dataset.selectClear = `custom-${section.id}`;
    hint.append(Object.assign(document.createElement('span'), {
      textContent: 'Modo selección para minuta · toca tareas para sumarlas o quitarlas · toca un espacio vacío para salir' }), clear);
    element.append(heading, hint, list);
    return element;
  }

  const contextTitles = {};
  function renderCustom() {
    if (!layout || typeof tasks === 'undefined' || typeof priorityCard !== 'function') return;
    for (const section of layout.sections.filter(s => s.kind === 'custom')) {
      const element = document.querySelector(`section[data-custom-section="${section.id}"]`);
      if (!element) continue;
      const related = tasks.filter(task => matches(task, section.filters));
      const byDate = (a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')) || a.id - b.id;
      const open = related.filter(t => !t.done).sort(byDate);
      const done = related.filter(t => t.done).sort((a, b) => a.id - b.id);
      const openContext = `custom-${section.id}-open`, doneContext = `custom-${section.id}-done`;
      panelSets[openContext] = open;
      panelSets[doneContext] = done;
      contextTitles[openContext] = `${section.title} · pendientes`;
      contextTitles[doneContext] = `${section.title} · completadas`;
      const note = t => [t.owner, t.date].filter(Boolean).join(' · ') || 'Sin responsable ni fecha';
      element.querySelector('.dsta-custom-list').innerHTML =
        `<h3>Pendientes · ${open.length}</h3>` +
        (open.map(t => priorityCard(t, openContext, note(t))).join('') || '<p class="empty muted">Sin tareas que cumplan los filtros.</p>') +
        (done.length ? `<details><summary>Antecedentes completados · ${done.length}</summary><div class="priority-list">${done.map(t => priorityCard(t, doneContext, 'Completada')).join('')}</div></details>` : '');
    }
    renderSummaries();
  }

  // AI summaries (computed on the server for sections with AI enabled).
  function renderSummaries() {
    const summaries = window.__dstaAiSummaries || {};
    document.querySelectorAll('.dsta-ai-section .priority-card[data-task]').forEach(card => {
      card.querySelector('.dsta-custom-summary')?.remove();
      const record = summaries[card.dataset.task];
      const note = document.createElement('span');
      note.className = `review-note dsta-custom-summary ${record?.attention || 'normal'}`;
      const label = Object.assign(document.createElement('b'), { textContent: 'Resumen IA' });
      note.append(label, document.createTextNode(' ' + (record?.summary || 'pendiente')));
      if (record?.nextAction) note.append(Object.assign(document.createElement('span'), { className: 'dsta-ai-next-action', textContent: `Próxima acción: ${record.nextAction}` }));
      card.append(note);
    });
  }

  function customMinute(id) {
    const section = layout?.sections.find(s => s.id === id);
    if (!section || typeof minuteView !== 'function') return;
    // D51: long-press selection like the original panels (none selected = all); D53: common line format.
    const minute = window.DstaMinute;
    const open = minute.chosenOrAll(`custom-${id}`, panelSets[`custom-${id}-open`] || []);
    minute.exitSelectMode();
    const lines = open.map(t => minute.line(t, Boolean(section.ai)));
    minuteView(`Minuta · ${section.title}`, `${section.title} - ${typeof minuteDate === 'function' ? minuteDate() : ''}\n\n${lines.join('\n') || '-'}`);
  }

  // ── Editor inside the settings gear ──
  let draft = null;
  const editor = document.createElement('div');
  editor.className = 'dsta-layout-editor';
  const style = document.createElement('style');
  style.textContent = `
.dsta-layout-list{list-style:none;margin:0 0 10px;padding:0;display:grid;gap:6px}
.dsta-layout-list li{display:flex;gap:4px;align-items:center;border:1px solid #2b3745;border-radius:8px;padding:6px;background:#0d1117}
.dsta-layout-list li.dragging{opacity:.5}.dsta-layout-list li.over{border-color:#68d391}
.dsta-layout-list .handle{cursor:grab;color:#9bacbd;user-select:none;padding:0 4px}
.dsta-layout-list input[type=text]{flex:1 1 auto;width:0;min-width:0;padding:6px;border-radius:6px;border:1px solid #2b3745;background:#151b23;color:#eef3f8}
.dsta-layout-list button,.dsta-layout-actions button{width:auto;padding:4px 8px}
.dsta-layout-actions{display:flex;gap:8px;flex-wrap:wrap}.dsta-layout-actions .primary{background:#68d391;color:#0d1117;font-weight:700}
.dsta-layout-status{min-height:1.2em;font-size:12px;color:#9bacbd;margin:8px 0 0}
.dsta-tag{font-size:10px;color:#68d391;border:1px solid #2b5d47;border-radius:6px;padding:1px 4px}
dialog.dsta-section-dialog{width:min(520px,calc(100vw - 32px));background:#151b23;color:#eef3f8;border:1px solid #3a4859;border-radius:12px;padding:18px}
dialog.dsta-section-dialog::backdrop{background:rgba(0,0,0,.6)}
.dsta-section-dialog label{display:block;margin:10px 0 4px;font-size:13px;color:#c5d1dd}
.dsta-section-dialog input[type=text],.dsta-section-dialog select{width:100%;padding:8px;border-radius:8px;border:1px solid #3a4859;background:#0d1117;color:#eef3f8}
.dsta-checklist{max-height:150px;overflow:auto;border:1px solid #3a4859;border-radius:8px;padding:6px 8px;background:#0d1117;display:grid;gap:4px}
.dsta-checklist label{display:flex;gap:6px;align-items:center;margin:0;font-size:13px;color:#eef3f8}
.dsta-section-dialog .checks{display:flex;flex-wrap:wrap;gap:10px}.dsta-section-dialog .checks label{display:flex;gap:4px;margin:0;align-items:center}
.dsta-section-dialog .row{display:flex;gap:8px;margin-top:14px}.dsta-section-dialog .row button{flex:1}
.dsta-section-dialog .hint{font-size:12px;color:#9bacbd;margin:4px 0 0}
.dsta-filter-preview{margin:12px 0 0;padding:8px;border-radius:8px;background:#0d1117;border:1px solid #2b5d47;color:#68d391;font-size:13px}`;
  document.head.append(style);

  function renderEditor() {
    editor.replaceChildren();
    const help = Object.assign(document.createElement('p'), { textContent: 'Activa, renombra y arrastra (o usa ↑↓) para ordenar. Guarda para aplicar.' });
    const list = Object.assign(document.createElement('ul'), { className: 'dsta-layout-list' });
    draft.sections.forEach((section, index) => {
      const item = document.createElement('li');
      item.draggable = true;
      item.dataset.index = String(index);
      const handle = Object.assign(document.createElement('span'), { className: 'handle', textContent: '⠿', title: 'Arrastrar' });
      const enabled = Object.assign(document.createElement('input'), { type: 'checkbox', checked: section.enabled, title: 'Mostrar' });
      enabled.setAttribute('aria-label', `Mostrar ${section.title}`);
      enabled.addEventListener('change', () => { section.enabled = enabled.checked; });
      const name = Object.assign(document.createElement('input'), { type: 'text', value: section.title, maxLength: 80 });
      name.setAttribute('aria-label', 'Nombre de la sección');
      name.addEventListener('input', () => { section.title = name.value; });
      const up = Object.assign(document.createElement('button'), { type: 'button', textContent: '↑', disabled: index === 0 });
      up.setAttribute('aria-label', 'Subir');
      up.addEventListener('click', () => move(index, index - 1));
      const down = Object.assign(document.createElement('button'), { type: 'button', textContent: '↓', disabled: index === draft.sections.length - 1 });
      down.setAttribute('aria-label', 'Bajar');
      down.addEventListener('click', () => move(index, index + 1));
      item.append(handle, enabled, name);
      if (section.kind === 'custom') {
        if (section.ai) item.append(Object.assign(document.createElement('span'), { className: 'dsta-tag', textContent: 'IA' }));
        const edit = Object.assign(document.createElement('button'), { type: 'button', textContent: '✎', title: 'Editar filtros' });
        edit.addEventListener('click', () => openSectionDialog(section));
        const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: '🗑', title: 'Eliminar sección' });
        remove.addEventListener('click', () => { draft.sections.splice(index, 1); renderEditor(); });
        item.append(edit, remove);
      }
      item.append(up, down);
      item.addEventListener('dragstart', event => { item.classList.add('dragging'); event.dataTransfer.setData('text/plain', String(index)); });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));
      item.addEventListener('dragover', event => { event.preventDefault(); item.classList.add('over'); });
      item.addEventListener('dragleave', () => item.classList.remove('over'));
      item.addEventListener('drop', event => {
        event.preventDefault();
        item.classList.remove('over');
        move(Number(event.dataTransfer.getData('text/plain')), index);
      });
      list.append(item);
    });
    const actions = Object.assign(document.createElement('div'), { className: 'dsta-layout-actions' });
    const add = Object.assign(document.createElement('button'), { type: 'button', className: 'dsta-add-section', textContent: '+ Agregar sección' });
    add.addEventListener('click', () => openSectionDialog(null));
    const save = Object.assign(document.createElement('button'), { type: 'button', className: 'primary dsta-save-layout', textContent: 'Guardar' });
    save.addEventListener('click', saveLayout);
    actions.append(add, save);
    editor.append(help, list, actions, Object.assign(document.createElement('p'), { className: 'dsta-layout-status' }));
  }

  function move(from, to) {
    if (to < 0 || to >= draft.sections.length || from === to) return;
    const [section] = draft.sections.splice(from, 1);
    draft.sections.splice(to, 0, section);
    renderEditor();
  }

  function openSectionDialog(existing) {
    const section = existing || { id: `c-${Date.now().toString(36)}`, kind: 'custom', title: '', enabled: true, filters: { status: 'all' } };
    const f = section.filters || {};
    const dialog = Object.assign(document.createElement('dialog'), { className: 'dsta-section-dialog' });
    const form = document.createElement('form');
    form.method = 'dialog';
    const field = (label, input, hint) => {
      const wrap = document.createElement('div');
      wrap.append(Object.assign(document.createElement('label'), { textContent: label }), input);
      if (hint) wrap.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: hint }));
      form.append(wrap);
      return input;
    };
    form.append(Object.assign(document.createElement('h2'), { textContent: existing ? 'Editar sección' : 'Nueva sección' }));
    const name = field('Nombre de la sección', Object.assign(document.createElement('input'), { type: 'text', value: section.title, maxLength: 80, required: true, name: 'title' }));
    const keywords = field('Palabras clave (separadas por coma)', Object.assign(document.createElement('input'), { type: 'text', value: (f.keywords || []).join(', '), name: 'keywords' }),
      'Basta que aparezca una; también encuentra palabras parciales. Ej.: proveedor, contrato');
    const fieldsBox = Object.assign(document.createElement('div'), { className: 'checks' });
    for (const [key, label] of Object.entries(FIELD_LABELS)) {
      const check = Object.assign(document.createElement('input'), { type: 'checkbox', value: key, checked: !f.fields?.length || f.fields.includes(key) });
      const wrap = document.createElement('label');
      wrap.append(check, document.createTextNode(label));
      fieldsBox.append(wrap);
    }
    field('Buscar las palabras en', fieldsBox);
    const owner = field('Responsable contiene', Object.assign(document.createElement('input'), { type: 'text', value: f.owner || '', name: 'owner', maxLength: 80 }));
    const dependency = field('Dependencia contiene', Object.assign(document.createElement('input'), { type: 'text', value: f.dependency || '', name: 'dependency', maxLength: 80 }));
    const checklist = (items, chosen, empty) => {
      const box = Object.assign(document.createElement('div'), { className: 'dsta-checklist' });
      if (!items.length) box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: empty }));
      for (const item of items) {
        const check = Object.assign(document.createElement('input'), { type: 'checkbox', value: String(item.id), checked: (chosen || []).includes(item.id) });
        const wrap = document.createElement('label');
        wrap.append(check, document.createTextNode(item.title));
        box.append(wrap);
      }
      return box;
    };
    const picked = box => [...box.querySelectorAll('input:checked')].map(c => Number(c.value));
    const lines = field('Líneas de trabajo (opcional: sin marcar = todas)', checklist(typeof projects !== 'undefined' ? projects : [], f.projectIds, 'Aún no hay líneas.'));
    const labelList = typeof labels !== 'undefined' && Array.isArray(labels) ? labels : [];
    const labelSelect = field('Etiquetas (opcional: solo tareas con alguna de las marcadas; sin marcar = todas)', checklist(labelList, f.labelIds, 'Aún no hay etiquetas.'));
    const status = Object.assign(document.createElement('select'), { name: 'status' });
    status.append(new Option('Pendientes + completadas como antecedentes', 'all', false, f.status !== 'open'),
      new Option('Solo pendientes', 'open', false, f.status === 'open'));
    field('Qué tareas mostrar', status);
    const ai = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(section.ai), name: 'ai' });
    const aiLabel = document.createElement('label');
    aiLabel.append(ai, document.createTextNode(' Mostrar resúmenes con IA en las tarjetas'));
    form.append(aiLabel);
    const error = Object.assign(document.createElement('p'), { className: 'hint' });
    error.setAttribute('role', 'alert');
    const row = Object.assign(document.createElement('div'), { className: 'row' });
    const ok = Object.assign(document.createElement('button'), { type: 'submit', textContent: existing ? 'Aplicar' : 'Agregar' });
    const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Cancelar' });
    cancel.addEventListener('click', () => dialog.close());
    row.append(ok, cancel);
    // Live preview: how many tasks the current filters select, before saving.
    const preview = Object.assign(document.createElement('p'), { className: 'dsta-filter-preview' });
    preview.setAttribute('aria-live', 'polite');
    form.append(preview, error, row);
    const allProjects = typeof projects !== 'undefined' ? projects.length : 0;
    const readFilters = () => {
      const filters = {};
      const words = keywords.value.split(',').map(w => w.trim()).filter(Boolean);
      if (words.length) filters.keywords = words.slice(0, 20);
      const chosenFields = [...fieldsBox.querySelectorAll('input:checked')].map(c => c.value);
      if (words.length && chosenFields.length && chosenFields.length < Object.keys(FIELD_LABELS).length) filters.fields = chosenFields;
      if (owner.value.trim()) filters.owner = owner.value.trim();
      if (dependency.value.trim()) filters.dependency = dependency.value.trim();
      // Ticking every line or every label means "all": it must not exclude tasks without labels.
      const pids = picked(lines);
      if (pids.length && pids.length < allProjects) filters.projectIds = pids;
      const lids = picked(labelSelect);
      if (lids.length && lids.length < labelList.length) filters.labelIds = lids;
      filters.status = status.value;
      return filters;
    };
    const updatePreview = () => {
      const filters = readFilters();
      if (!filters.keywords && !filters.owner && !filters.dependency && !filters.projectIds && !filters.labelIds) {
        preview.textContent = 'Agrega al menos un filtro para ver qué tareas incluye.';
        return;
      }
      const found = (typeof tasks !== 'undefined' ? tasks : []).filter(task => matches(task, filters));
      const open = found.filter(task => !task.done).length;
      preview.textContent = `Con estos filtros: ${found.length} tarea(s) · ${open} pendiente(s).`;
    };
    form.addEventListener('input', updatePreview);
    form.addEventListener('change', updatePreview);
    updatePreview();
    form.addEventListener('submit', event => {
      event.preventDefault();
      const filters = readFilters();
      if (!name.value.trim()) { error.textContent = 'Ponle un nombre a la sección.'; return; }
      if (!filters.keywords && !filters.owner && !filters.dependency && !filters.projectIds && !filters.labelIds) {
        error.textContent = 'Define al menos un filtro (palabra clave, responsable, dependencia, línea o etiqueta).'; return;
      }
      Object.assign(section, { title: name.value.trim(), filters });
      if (ai.checked) section.ai = true; else delete section.ai;
      if (!existing) draft.sections.push(section);
      dialog.close();
      renderEditor();
    });
    dialog.append(form);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  async function saveLayout() {
    const status = editor.querySelector('.dsta-layout-status');
    status.textContent = 'Guardando…';
    try {
      const response = await fetch('/api/preferences/layout', { method: 'PUT', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout: draft }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      layout = payload.layout;
      draft = structuredClone(layout);
      apply();
      renderEditor();
      editor.querySelector('.dsta-layout-status').textContent = '✓ Guardado. El dashboard ya usa este orden.';
    } catch (error) {
      status.textContent = `No se pudo guardar: ${error.message}`;
    }
  }

  async function load() {
    try {
      const response = await fetch('/api/preferences/layout', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      layout = (await response.json()).layout;
      draft = structuredClone(layout);
      apply();
      renderEditor();
      window.DstaSettings?.addSection('Secciones del dashboard', editor, 30);
    } catch { /* keep the default page layout */ }
  }

  window.addEventListener('dsta-rendered', renderCustom);
  window.addEventListener('dsta-ai-summaries', renderSummaries);
  window.addEventListener('dsta-settings-open', () => { if (layout) { draft = structuredClone(layout); renderEditor(); } });
  window.DstaLayout = { contextTitle: context => contextTitles[context], matches };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
