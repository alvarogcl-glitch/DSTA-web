// F3.3 browser E2E (driven by tests/e2e_structure_lab.py): user A creates, renames and archives a
// work line and creates, edits and moves a task from the UI; user B never sees any of it.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const errors = [];
async function session(user) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(cfg.base + '/login');
  await page.fill('#email', user.email); await page.fill('#password', user.password); await page.click('#login-form button');
  await page.waitForURL(cfg.base + '/');
  await page.waitForFunction(() => typeof projects !== 'undefined' && projects.length > 0, null, { timeout: 30000 });
  return page;
}
async function submitDialog(page, values) {
  const dialog = page.locator('dialog.structure-dialog');
  await dialog.waitFor();
  for (const [name, value] of Object.entries(values)) {
    const input = dialog.locator(`[name="${name}"]`);
    if (await input.evaluate(el => el.tagName) === 'SELECT') await input.selectOption({ label: value });
    else await input.fill(value);
  }
  await dialog.locator('button[type="submit"]').click();
  await dialog.waitFor({ state: 'detached', timeout: 90000 });
}
const openProject = (page, title) => page.evaluate(t => showInspection(projectView(projects.find(p => p.title === t))), title);
const openTask = (page, title) => page.evaluate(t => showInspection(taskView(tasks.find(x => x.title === t))), title);
const step = m => console.log('OK  ' + m);

const a = await session(cfg.A);

// D55: a new user's header is "Dashboard de <name>" with no PMO-DSTA; they can set their own title.
await a.waitForFunction(() => document.querySelector('#dsta-title')?.textContent === 'Dashboard de UI A', null, { timeout: 15000 });
assert.doesNotMatch(await a.locator('#dsta-kicker').innerText(), /PMO-DSTA/);
await a.click('#dsta-settings-toggle');
await a.fill('.dsta-layout-title input', 'Tablero de prueba');
await a.click('#dsta-settings-panel button:text-is("Guardar")');
await a.waitForFunction(() => document.querySelector('#dsta-title')?.textContent === 'Tablero de prueba' && document.title === 'Tablero de prueba');
// D58: the success notice fades out by itself.
await a.locator('.task-action-toast', { hasText: 'Configuración guardada' }).waitFor({ state: 'visible' });
await a.locator('.task-action-toast').waitFor({ state: 'hidden', timeout: 12000 });
await a.click('#dsta-settings-toggle');
step('D55/D58: título propio editable en ⚙ y aviso de éxito que se desvanece');

// D59: an account with no lines sees three first steps (nothing created for them).
await a.evaluate(() => { window.__savedProjects = projects; projects = []; window.dispatchEvent(new Event('dsta-rendered')); });
assert.equal(await a.locator('.dsta-welcome button').count(), 3);
await a.evaluate(() => { projects = window.__savedProjects; window.dispatchEvent(new Event('dsta-rendered')); });
assert.equal(await a.locator('.dsta-welcome').count(), 0, 'the card goes away once there are lines');
step('D59: tarjeta de bienvenida con 3 pasos solo si no hay líneas');

// E12: own numbering — A's first task is #1 (B's too, checked below), whatever its Vikunja ID.
const baseA = await a.evaluate(() => tasks.find(t => t.title === 'Tarea base A'));
assert.equal(baseA.num, 1);
assert.match(await a.locator('#rows').innerText(), /#1\s+Tarea base A/);
step('E12: la primera tarea de A se ve como #1');
await a.click('.structure-new-lt');
await submitDialog(a, { title: 'LT creada desde UI' });
assert.ok(await a.evaluate(() => projects.some(p => p.title === 'LT creada desde UI'))); step('A crea una línea desde la interfaz');

await openProject(a, 'LT creada desde UI');
// D57: focus starts in the first field and Escape closes without sending anything.
await a.click('.structure-actions button:has-text("+ Nueva tarea")');
assert.equal(await a.evaluate(() => document.activeElement?.name), 'title');
await a.keyboard.press('Escape');
await a.locator('dialog.structure-dialog').waitFor({ state: 'detached' });
await a.click('.structure-more summary');
await a.click('.structure-more button:has-text("Archivar línea")');
assert.equal(await a.evaluate(() => document.activeElement?.textContent), 'Cancelar', 'archive focuses Cancelar, not the confirm button');
await a.keyboard.press('Escape');
await a.locator('dialog.structure-dialog').waitFor({ state: 'detached' });
step('D57: foco en el primer campo, Escape cierra, archivar enfoca Cancelar');
await a.click('.structure-actions button:has-text("+ Nueva tarea")');
await submitDialog(a, { title: 'Tarea creada desde UI', description: 'Detalle sintético', dueDate: '2026-12-15' });
await a.locator('.task-action-toast.ok', { hasText: 'Tarea creada' }).waitFor({ state: 'visible', timeout: 5000 });
const created = await a.evaluate(() => tasks.find(t => t.title === 'Tarea creada desde UI'));
assert.equal(created.date, '2026-12-15'); step('A crea una tarea con fecha en esa línea');

await openTask(a, 'Tarea creada desde UI');
await a.click('.structure-actions > button:has-text("Editar")');
assert.equal(await a.locator('dialog.structure-dialog [name="detail"]').inputValue(), 'Detalle sintético', 'D06: the form shows only the detail');
await submitDialog(a, { title: 'Tarea editada desde UI' });
let edited = await a.evaluate(() => tasks.find(t => t.title === 'Tarea editada desde UI'));
assert.match(edited.description, /^Responsable: Por confirmar\nFecha objetivo: 2026-12-15\n[\s\S]*\n\nDetalle sintético$/, 'editing the title keeps the description');
step('A edita el título y la descripción estructurada queda igual');

await openTask(a, 'Tarea editada desde UI');
await a.click('.structure-actions > button:has-text("Editar")');
await submitDialog(a, { detail: 'Detalle nuevo', dueDate: '2026-12-20', owner: 'Paula' });
edited = await a.evaluate(() => tasks.find(t => t.title === 'Tarea editada desde UI'));
assert.equal(edited.date, '2026-12-20');
assert.match(edited.description, /Fecha objetivo: 2026-12-20/, 'D05: the line follows the native date');
assert.match(edited.description, /Responsable: Paula/);
assert.match(edited.description, /SOURCE: DSTA Dashboard Formulario/, 'D06: metadata kept');
assert.match(edited.description, /\n\nDetalle nuevo$/);
step('A cambia detalle, fecha y responsable: la línea de fecha coincide y se conservan los metadatos');

const mobile = await a.context().newPage();
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.goto(cfg.base + '/');
await mobile.waitForFunction(() => typeof projects !== 'undefined' && projects.length > 0, null, { timeout: 30000 });
await mobile.evaluate(t => showInspection(taskView(tasks.find(x => x.title === t))), 'Tarea editada desde UI');
await mobile.click('.structure-more summary');
const box = await mobile.locator('.structure-more > div').boundingBox();
assert.ok(box && box.x >= 0 && box.x + box.width <= 390, 'D02: the ⋯ menu fits on a phone');
if (process.env.SHOT_DIR) await mobile.screenshot({ path: `${process.env.SHOT_DIR}/e03-mobile.png` });
await mobile.close();
step('D02: acciones secundarias en el menú ⋯, visible completo en móvil');

// D23-D25 on the line that still holds the open task.
async function refusedDialog(page, item, values, message) {
  await page.click('.structure-more summary');
  await page.click(`.structure-more button:has-text("${item}")`);
  const dialog = page.locator('dialog.structure-dialog');
  for (const [name, value] of Object.entries(values)) await dialog.locator(`[name="${name}"]`).fill(value);
  await dialog.locator('button[type="submit"]').click();
  await dialog.locator('.status.error', { hasText: message }).waitFor({ timeout: 30000 });
  await dialog.locator('button:has-text("Cancelar")').click();
}
await openProject(a, 'LT creada desde UI');
await refusedDialog(a, 'Archivar línea', {}, '1 tareas abiertas');
await openProject(a, 'LT creada desde UI');
await refusedDialog(a, 'Renombrar línea', { title: 'lt  BASE a' }, 'Ya existe una línea con ese nombre');
assert.ok(await a.evaluate(() => projects.some(p => p.title === 'LT creada desde UI')));
step('D24/D25: no archiva con tareas abiertas ni repite nombres, con mensaje claro');
await openProject(a, 'LT creada desde UI');
await a.click('.structure-more summary');
await a.click('.structure-more button:has-text("Editar descripción")');
await submitDialog(a, { description: 'Objetivo de la línea UI' });
assert.equal(await a.evaluate(() => projects.find(p => p.title === 'LT creada desde UI').description), 'Objetivo de la línea UI');
await openProject(a, 'LT creada desde UI');
assert.match(await a.locator('#detail-body').innerText(), /Objetivo de la línea UI/);
step('D23: A edita la descripción de la línea y se ve en el inspector');

await openTask(a, 'Tarea editada desde UI');
if (process.env.SHOT_DIR) { await a.click('.structure-more summary'); await a.screenshot({ path: `${process.env.SHOT_DIR}/e03-desktop.png` }); await a.click('.structure-more summary'); }
await a.click('.structure-more summary');
await a.click('.structure-more button:has-text("Mover a otra línea")');
await submitDialog(a, { projectId: cfg.A.lt });
assert.equal(await a.evaluate(n => tasks.find(t => t.title === 'Tarea editada desde UI').project, cfg.A.lt), cfg.A.lt); step('A mueve la tarea a otra línea');

await openTask(a, 'Tarea editada desde UI');
await a.click('[aria-label="Marcar como completada"]');
await a.waitForFunction(() => tasks.find(t => t.title === 'Tarea editada desde UI')?.done === true, null, { timeout: 90000 });
await openTask(a, 'Tarea editada desde UI');
await a.click('.structure-more summary');
await a.click('.structure-more button:has-text("Reabrir tarea")');
await a.waitForFunction(() => tasks.find(t => t.title === 'Tarea editada desde UI')?.done === false, null, { timeout: 90000 });
const reopened = await a.evaluate(() => tasks.find(t => t.title === 'Tarea editada desde UI'));
assert.equal(reopened.owner, 'Paula', 'D14: reopening keeps the fields');
step('D14: A completa la tarea y la reabre sin confirmación; conserva sus campos');

await openProject(a, 'LT creada desde UI');
await a.click('.structure-more summary');
await a.click('.structure-more button:has-text("Renombrar línea")');
await submitDialog(a, { title: 'LT renombrada desde UI' });
await openProject(a, 'LT renombrada desde UI');
a.on('dialog', d => d.accept());
await a.click('.structure-more summary');
await a.click('.structure-more button:has-text("Archivar línea")');
await submitDialog(a, {});
assert.ok(!(await a.evaluate(() => projects.some(p => p.title.startsWith('LT renombrada'))))); step('A renombra y archiva la línea');

await a.evaluate(() => { const d = document.querySelector('#drawer'); if (d?.classList.contains('open')) document.querySelector('#close')?.click(); });
await a.click('#dsta-settings-toggle');
const archivedRow = a.locator('.structure-archived > div', { hasText: 'LT renombrada desde UI' });
await archivedRow.locator('button:has-text("Restaurar")').click();
await a.waitForFunction(() => projects.some(p => p.title === 'LT renombrada desde UI'), null, { timeout: 90000 });
if (process.env.SHOT_DIR) await a.screenshot({ path: `${process.env.SHOT_DIR}/e06-settings.png` });
await a.click('#dsta-settings-toggle');
step('D27: A restaura la línea desde ⚙ Configuración y vuelve a aparecer');

// D37: "Aplicar todas" applies the suggested changes in order through the real queue and bridge.
// Only the model's answer is simulated (there is no LLM in the lab).
const ltA = await a.evaluate(t => projects.find(p => p.title === t).id, cfg.A.lt);
const chatId = '11111111-2222-4333-8444-555555555555';
await a.route('**/api/assistant**', route => route.request().method() === 'POST'
  ? route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ id: chatId }) })
  : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: chatId, status: 'completed',
    reply: 'Te sugiero dos tareas.', proposals: [
      { action: 'task.create', projectId: ltA, title: 'Sugerida uno', origin: 'copilot' },
      { action: 'task.create', projectId: ltA, title: 'Sugerida dos', origin: 'copilot' }] }) }));
await a.click('#dsta-assistant-toggle');
await a.fill('#dsta-assistant-input', '¿qué me sugieres?');
await a.click('#dsta-assistant-send');
await a.click('.dsta-proposals button:has-text("Aplicar todas")', { timeout: 30000 });
await a.waitForFunction(() => ['Sugerida uno', 'Sugerida dos'].every(t => tasks.some(x => x.title === t)), null, { timeout: 120000 });
assert.ok(await a.locator('.dsta-proposals button:has-text("Aplicar todas")').isHidden());
await a.unroute('**/api/assistant**');
await a.click('#dsta-assistant-close');
step('D37: «Aplicar todas» aplica las sugerencias en orden por la cola verificada');

// D51/D53: a custom section supports long-press selection and uses the common minute format.
await a.evaluate(async () => {
  const current = (await (await fetch('/api/preferences/layout')).json()).layout;
  current.sections.push({ id: 'c-e2e', kind: 'custom', title: 'Sugeridas', enabled: true,
    filters: { keywords: ['Sugerida'], fields: ['title'], status: 'open' } });
  const saved = await fetch('/api/preferences/layout', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ layout: current }) });
  if (!saved.ok) throw new Error('layout ' + saved.status);
});
await a.reload();
await a.waitForFunction(() => document.querySelectorAll('[data-custom-section="c-e2e"] .priority-card').length === 2, null, { timeout: 30000 });
const card = a.locator('[data-custom-section="c-e2e"] .priority-card', { hasText: 'Sugerida dos' });
await card.scrollIntoViewIfNeeded();
const cardBox = await card.boundingBox();
await a.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
await a.mouse.down();
await a.waitForTimeout(900);
await a.mouse.up();
await a.locator('[data-custom-section="c-e2e"] .dsta-custom-minute', { hasText: '1 seleccionada' }).click();
const minuteText = await a.locator('#minute-text').inputValue();
assert.match(minuteText, /^Sugeridas - /);
assert.match(minuteText, /- #\d+ Sugerida dos · Estado: Abierta/);
assert.doesNotMatch(minuteText, /Sugerida uno/, 'only the selected task');
step('D51/D53: selección por pulsación larga en sección personalizada y formato común de minuta');

// D62: a change sent just before a reload is followed after it (never resent) and reported.
const sentBeforeReload = await a.evaluate(async lt => {
  const requestId = crypto.randomUUID();
  const response = await fetch('/api/task-actions', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'task.create', requestId, projectId: lt, title: 'Creada antes de recargar', origin: 'form' }) });
  if (response.status !== 202) throw new Error('queue ' + response.status);
  window.DstaPending.add({ id: requestId, url: '/api/task-actions', label: 'Tarea creada antes de recargar' });
  return requestId;
}, ltA);
await a.reload();
await a.locator('.task-action-toast.ok', { hasText: 'Tarea creada antes de recargar' }).waitFor({ state: 'visible', timeout: 90000 });
assert.equal(await a.evaluate(() => tasks.filter(t => t.title === 'Creada antes de recargar').length), 1, 'created once, not resent');
assert.equal(await a.evaluate(id => (JSON.parse(sessionStorage.getItem('dsta-structure-pending-v1') || '[]')).some(x => x.id === id), sentBeforeReload), false);
step('D62: tras recargar se retoma el seguimiento del cambio y se informa, sin reenviarlo');
await openProject(a, 'LT renombrada desde UI');
await a.click('.structure-more summary');
await a.click('.structure-more button:has-text("Archivar línea")');
await submitDialog(a, {});

const b = await session(cfg.B);
const seenByB = await b.evaluate(() => [...projects.map(p => p.title), ...tasks.map(t => t.title)].join('|'));
assert.doesNotMatch(seenByB, /desde UI/); step('B no ve nada de lo que hizo A');
const baseB = await b.evaluate(() => tasks.find(t => t.title === 'Tarea base B'));
assert.equal(baseB.num, 1, 'B also starts at #1');
assert.notEqual(baseB.id, baseA.id, 'different real IDs underneath');
step('E12: B también parte en #1, con otro ID real por debajo');

// D67: B changes their own password from ⚙ (asks for the current one).
await b.click('#dsta-settings-toggle');
await b.click('.dsta-password summary');
await b.fill('.dsta-password [name="current"]', 'equivocada-123456789');
await b.fill('.dsta-password [name="next"]', 'nueva-clave-B-2026-ok');
await b.fill('.dsta-password [name="repeat"]', 'nueva-clave-B-2026-ok');
await b.click('.dsta-password button[type="submit"]');
await b.locator('.dsta-password small', { hasText: 'no es correcta' }).waitFor();
await b.fill('.dsta-password [name="current"]', cfg.B.password);
await b.fill('.dsta-password [name="next"]', 'nueva-clave-B-2026-ok');
await b.fill('.dsta-password [name="repeat"]', 'nueva-clave-B-2026-ok');
await b.click('.dsta-password button[type="submit"]');
await b.locator('.task-action-toast', { hasText: 'Contraseña actualizada' }).waitFor({ state: 'visible' });
const loginWith = password => b.evaluate(async ([email, pw]) => (await fetch('/api/auth/login', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: pw }) })).status, [cfg.B.email, password]);
assert.equal(await loginWith(cfg.B.password), 401);
assert.equal(await loginWith('nueva-clave-B-2026-ok'), 200);
step('D67: B cambia su contraseña desde ⚙; la anterior deja de servir');
assert.deepEqual(errors, []); step('sin errores de JavaScript');
await browser.close();
