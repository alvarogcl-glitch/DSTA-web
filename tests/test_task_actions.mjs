import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/task-actions.js', import.meta.url), 'utf8');
async function scenario(mode) {
  const task = { id: 17, done: false, description: 'Responsable: Álvaro\nAntecedentes' };
  let section, complete, posts = 0, sent, now = 0, toast;
  const dismissTimers = [];
  const storage = new Map();
  const field = () => ({ value: '', disabled: false, focus() {}, children: [], append(...nodes) { this.children.push(...nodes); }, setAttribute(name, value) { this[name] = value; }, addEventListener(name, fn) { this[name] = fn; } });
  const context = {
    tasks: [task], inspection: { taskId: '17' }, Intl,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, delay) => { if (delay === 6000) { dismissTimers.push(fn); return dismissTimers.length; } now += 2000; fn(); },
    clearTimeout() {},
    sessionStorage: { setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k), getItem: k => storage.get(k) },
    document: {
      head: { append() {} },
      body: { append(value) { toast = value; } },
      createElement(tag) {
        if (tag !== 'section') return field();
        const form = { elements: { entry: field(), date: field(), kind: field() }, addEventListener(name, fn) { this[name] = fn; } };
        const toggle = field(), cancel = field(), status = {};
        return { form, toggle, cancel, status, append() {},
          querySelector(sel) { return sel === 'form' ? form : sel === '.task-log-toggle' ? toggle : sel === '.task-log-cancel' ? cancel : status; },
          querySelectorAll() { return [toggle, cancel, ...Object.values(form.elements)]; } };
      },
      querySelector: sel => ({ append(value) { if (sel.endsWith('.detail-value')) complete = value; else section = value; } }),
    },
    taskView: () => ({ taskId: '17' }),
    refresh: async () => {
      assert.doesNotMatch(toast?.children[0]?.textContent || '', /completada|guardado/, 'no éxito antes de confirmar snapshot');
      if (mode === 'stale') return false;
      if (sent.message.includes('pmo_complete_task')) task.done = true;
      else task.description += '\n\nNota 2026-10-05: Acuerdo <literal>';
      return true;
    },
    fetch: async (url, opts) => {
      if (opts.method === 'POST') {
        posts++; sent = JSON.parse(opts.body);
        return { ok: mode !== 'rejected', json: async () => mode === 'rejected' ? { error: 'Sin autorización' } : { id: '12345678-1234-1234-1234-123456789012' } };
      }
      return { ok: true, json: async () => mode === 'timeout' ? { status: 'running' } : { status: 'completed', snapshotTimestamp: '2026-10-05T12:00:00Z' } };
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
  if (mode === 'complete') complete.click();
  else section.form.submit({ preventDefault() {} });
  complete.click();
  assert.equal(toast?.['role'], 'status', 'feedback independiente del inspector');
  assert.equal(toast?.['aria-live'], 'polite');
  assert.match(toast.children[0].textContent, /#17/);
  if (mode === 'complete') assert.match(toast.children[0].textContent, /Completando…/);
  context.inspection = null; // navegar no debe perder el estado de la acción
  for (let i = 0; i < 1500; i++) await Promise.resolve();
  context.inspection = { taskId: '17' };
  context.showInspection(context.inspection);
  assert.equal(posts, 1, 'no se duplica la solicitud pendiente');
  assert.deepEqual(sent.history, [], 'las acciones no arrastran contexto del chat');
  assert.equal(sent.taskId, 17);
  if (mode === 'success') {
    assert.match(sent.message, /pmo_append_log/);
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
  assert.match(toast.children[0].textContent, /#17/);
  assert.equal(toast.hidden, false, 'feedback sigue visible tras navegar');
  if (['success', 'complete'].includes(mode)) {
    assert.match(toast.children[0].textContent, mode === 'complete' ? /Tarea completada/ : /Registro guardado/);
    assert.equal(dismissTimers.length, 1);
    dismissTimers[0]();
    assert.equal(toast.hidden, true, 'el éxito desaparece automáticamente');
  } else {
    assert.doesNotMatch(toast.children[0].textContent, /Tarea completada|Registro guardado/);
    assert.equal(dismissTimers.length, 0, 'errores y resultados inciertos no desaparecen');
    toast.children[1].click();
    assert.equal(toast.hidden, true, 'se puede descartar sin modal');
  }
  assert.equal(storage.size, mode === 'timeout' ? 1 : 0, 'una solicitud incierta conserva su id para consultar sin reenviar');
}
for (const mode of ['success', 'complete', 'stale', 'rejected', 'timeout']) await scenario(mode);
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
