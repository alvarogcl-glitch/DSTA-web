import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/task-actions.js', import.meta.url), 'utf8');
async function scenario(mode) {
  const task = { id: 17, done: false, description: 'Responsable: Álvaro\nAntecedentes' };
  let section, complete, posts = 0, sent, now = 0, toast;
  const dismissTimers = [];
  const storage = new Map();
  const field = () => { const el = { value: '', disabled: false, className: '', focus() {}, children: [], append(...nodes) { for (const n of nodes) { if (n && typeof n === 'object') n.parent = this; this.children.push(n); } }, setAttribute(name, value) { this[name] = value; }, addEventListener(name, fn) { this[name] = fn; },
    remove() { const i = this.parent?.children.indexOf(this) ?? -1; if (i >= 0) this.parent.children.splice(i, 1); this.removed = true; } };
    el.classList = { add: c => { el.className += ' ' + c; }, contains: c => el.className.split(' ').includes(c) }; return el; };
  // Notices are stacked per action: the current one is the last child of the stack (icon, text, ×).
  const note = () => toast?.children[toast.children.length - 1];
  const noteText = () => note()?.title || '';
  const context = {
    crypto: {randomUUID: () => '12345678-1234-4234-8234-123456789012'}, tasks: [task], inspection: { taskId: '17' }, Intl,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, delay) => { if (delay === 1800) { dismissTimers.push(fn); return dismissTimers.length; } now += 2000; fn(); },
    clearTimeout() {},
    sessionStorage: { setItem: (k, v) => { if (mode === 'complete-storage') throw Error('Almacenamiento bloqueado'); storage.set(k, v); }, removeItem: k => storage.delete(k), getItem: k => storage.get(k) },
    document: {
      head: { append() {} },
      body: { append(value) { toast = value; } },
      createElement(tag) {
        if (tag !== 'section') return field();
        const form = { elements: { entry: field(), date: field(), kind: field() }, addEventListener(name, fn) { this[name] = fn; } };
        const toggle = field(), cancel = field(), status = {};
        return { form, toggle, cancel, status, children: [], append(...nodes) { this.children.push(...nodes); },
          querySelector(sel) { return sel === 'form' ? form : sel === '.task-log-toggle' ? toggle : sel === '.task-log-cancel' ? cancel : status; },
          querySelectorAll() { return [toggle, cancel, ...Object.values(form.elements)]; } };
      },
      querySelector: sel => ({ append(value) { if (sel.endsWith('.detail-value')) complete = value; else section = value; } }),
    },
    taskView: () => ({ taskId: '17' }),
    refresh: async () => {
      assert.doesNotMatch(noteText(), /completada|guardado/, 'no éxito antes de confirmar snapshot');
      if (mode === 'stale' || mode === 'complete-stale') return false;
      if (sent.action === 'complete') task.done = true;
      else task.description += '\n\nNota 2026-10-05: Acuerdo <literal>';
      return true;
    },
    fetch: async (url, opts) => {
      if (url === '/api/session') {
        if (mode === 'log-session-fail') throw Error('Sin red');
        return mode === 'log-accounts' ? { ok: true, status: 200, json: async () => ({ actor: { id: 'ana' } }) }
          : { ok: false, status: 404, json: async () => ({ error: 'No encontrado' }) };
      }
      if (opts.method === 'POST') {
        posts++; sent = JSON.parse(opts.body);
        if (mode === 'log-accounts') assert.equal(url, '/api/task-actions', 'accounts mode: verified action, never the copilot');
        if (mode.startsWith('complete')) { assert.equal(url, '/api/task-actions'); assert.equal(JSON.parse(storage.values().next().value).id, sent.requestId, 'persist before send'); }
        return { ok: mode !== 'rejected' && mode !== 'complete-500', status: mode === 'complete-500' ? 500 : 202, json: async () => mode === 'rejected' ? { error: 'Sin autorización' } : { id: '12345678-1234-1234-1234-123456789012' } };
      }
      return { ok: true, json: async () => mode === 'complete-error' ? { status: 'error', error: 'Fallo terminal' } : (mode === 'timeout' || mode === 'complete-timeout') ? { status: 'running' } : { status: 'completed', snapshotTimestamp: '2026-10-05T12:00:00Z' } };
    },
  };
  context.window = {};
  context.showInspection = view => context.window.DstaTaskActions.mount(view);
  vm.runInNewContext(source, context);
  context.showInspection(context.inspection);
  assert.equal(section.form.hidden, true, 'el formulario comienza cerrado');
  assert.equal(complete['aria-label'], 'Marcar como completada');
  section.toggle.click();
  assert.equal(section.form.hidden, false);
  assert.equal(section.toggle['aria-expanded'], 'true');
  const edit = (name, value) => { section.form.elements[name].value = value; section.form.elements[name].input(); };
  edit('entry', 'Acuerdo <literal>'); edit('date', '2026-10-05'); edit('kind', 'Nota');
  context.showInspection(context.inspection);
  assert.equal(section.form.hidden, false, 'el refresco conserva el formulario abierto');
  assert.equal(section.form.elements.entry.value, 'Acuerdo <literal>', 'el borrador sobrevive al refresco');
  section.cancel.click();
  assert.equal(section.form.hidden, true);
  section.toggle.click();
  assert.equal(section.form.elements.entry.value, 'Acuerdo <literal>', 'cerrar conserva el borrador');
  if (mode.startsWith('complete')) complete.click();
  else section.form.submit({ preventDefault() {} });
  complete.click();
  if (mode === 'log-session-fail') {
    for (let i = 0; i < 200; i++) await Promise.resolve();
    assert.equal(posts, 0, 'D19: if the mode cannot be determined, nothing is sent');
    assert.match(section.status.textContent, /no se envió/i);
    assert.equal(section.form.elements.entry.value, 'Acuerdo <literal>', 'the draft is kept');
    return;
  }
  if (mode === 'complete-storage') {
    for (let i=0;i<30;i++) await Promise.resolve();
    assert.equal(posts,0,'blocked storage must prevent all writes before losing idempotency');
    assert.equal(task.done,false);
    assert.match(noteText(),/No se pudo guardar la solicitud; no se envió el cambio/);
    return;
  }
  assert.equal(toast?.['role'], 'status', 'feedback independiente del inspector');
  assert.equal(toast?.['aria-live'], 'polite');
  assert.match(noteText(), /#17/);
  if (mode.startsWith('complete')) assert.match(noteText(), /Enviando…|En cola|Aplicando|Completando…/);
  assert.equal(toast.children.length, 1, 'one notice per action, updated in place');
  context.inspection = null; // navegar no debe perder el estado de la acción
  for (let i = 0; i < 1500; i++) await Promise.resolve();
  context.inspection = { taskId: '17' };
  context.showInspection(context.inspection);
  assert.equal(posts, 1, 'no se duplica la solicitud pendiente');
  if (mode.startsWith('complete')) { assert.deepEqual(Object.keys(sent).sort(), ['action', 'requestId', 'taskId']); assert.equal(sent.action, 'complete'); }
  else if (mode === 'log-accounts') {
    assert.deepEqual([sent.action, sent.entry, sent.entryDate, sent.logKind], ['task.log', 'Acuerdo <literal>', '2026-10-05', 'Nota']);
  } else assert.deepEqual(sent.history, [], 'log preserves copilot');
  assert.equal(sent.taskId, 17);
  if (mode === 'success' || mode === 'log-accounts') {
    if (mode === 'success') assert.match(sent.message, /pmo_append_log/, 'single-user keeps its copilot path');
    assert.equal(section.form.elements.entry.value, '');
    assert.equal(section.status.textContent, 'Registro guardado en la bitácora.');
    assert.equal(section.form.hidden, true, 'guardar cierra el formulario');
  } else if (mode === 'complete') {
    assert.equal(task.done, true);
    assert.equal(section.status.textContent, 'Tarea completada.');
  } else {
    assert.equal(section.form.elements.entry.value, 'Acuerdo <literal>', 'un fallo conserva el registro');
    assert.doesNotMatch(section.status.textContent, /Registro guardado/);
  }
  assert.match(noteText(), /#17/);
  assert.equal(toast.children.length, 1, 'feedback sigue visible tras navegar');
  if (['success', 'complete', 'log-accounts'].includes(mode)) {
    assert.match(noteText(), mode === 'complete' ? /Tarea completada/ : /Registro guardado/);
    assert.ok(note().classList.contains('ok'));
    assert.equal(dismissTimers.length, 1);
    dismissTimers[0]();
    assert.equal(toast.children.length, 0, 'el éxito desaparece automáticamente (~2 s)');
  } else {
    assert.doesNotMatch(noteText(), /Tarea completada|Registro guardado/);
    assert.ok(note().classList.contains('error'));
    assert.equal(dismissTimers.length, 0, 'errores y resultados inciertos no desaparecen');
    note().children[2].click();
    assert.equal(toast.children.length, 0, 'se puede descartar sin modal');
  }
  assert.equal(storage.size, ['timeout','complete-timeout','complete-stale','complete-500','complete-error'].includes(mode) ? 1 : 0, 'una solicitud incierta conserva su id para consultar sin reenviar');
  if (mode === 'complete-error') {
    assert.equal(JSON.parse(storage.values().next().value).terminal,true);
    const review=section.children.find(node=>node.textContent==='Actualizar y revisar tarea');
    assert.ok(review,'a terminal request offers read-only review rather than permanent global lock');
    await review.click();
    assert.equal(posts,1,'manual review performs no extra mutation');
    assert.equal(storage.size,0,'successful manual read releases terminal request');
  }
}
for (const mode of ['success', 'log-accounts', 'log-session-fail', 'complete', 'stale', 'rejected', 'timeout', 'complete-500', 'complete-stale', 'complete-timeout', 'complete-error', 'complete-storage']) await scenario(mode);
const css = readFileSync(new URL('../public/task-actions.css', import.meta.url), 'utf8');
assert.match(css, /@media\s*\(any-hover:none\),\s*\(pointer:coarse\),\s*\(max-width:620px\)/, 'etiqueta visible en móvil y táctil');
const touch = css.slice(css.indexOf('@media(any-hover:none)'));
assert.match(touch, /min-height:44px/);
assert.match(touch, /\.task-complete-text\{[^}]*max-width:none[^}]*opacity:1/);
assert.match(touch, /white-space:normal/);
assert.match(touch, /margin-left:0/);
assert.match(css, /\.task-action-toast\{[^}]*position:fixed[^}]*z-index:30[^}]*max-width:calc\(100vw - 24px\)/);
assert.match(css, /\.task-action-toast\[hidden\]\{display:none\}/);
console.log('task inspector actions, draft preservation, feedback and mobile checks passed');
