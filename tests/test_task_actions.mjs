import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/task-actions.js', import.meta.url), 'utf8');
async function scenario(mode) {
  const task = { id: 17, done: false, description: 'Responsable: Álvaro\nAntecedentes' };
  let section, complete, posts = 0, sent, now = 0;
  const storage = new Map();
  const field = () => ({ value: '', disabled: false, focus() {}, setAttribute(name, value) { this[name] = value; }, addEventListener(name, fn) { this[name] = fn; } });
  const context = {
    tasks: [task], inspection: { taskId: '17' }, Intl,
    Date: class extends Date { static now() { return now; } },
    setTimeout: fn => { now += 2000; fn(); },
    sessionStorage: { setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k), getItem: k => storage.get(k) },
    document: {
      head: { append() {} },
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
  for (let i = 0; i < 1500; i++) await Promise.resolve();
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
  assert.equal(storage.size, mode === 'timeout' ? 1 : 0, 'una solicitud incierta conserva su id para consultar sin reenviar');
}
for (const mode of ['success', 'complete', 'stale', 'rejected', 'timeout']) await scenario(mode);
console.log('task inspector actions, draft preservation and pending recovery checks passed');
