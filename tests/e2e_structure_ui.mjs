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
await a.click('.structure-new-lt');
await submitDialog(a, { title: 'LT creada desde UI' });
assert.ok(await a.evaluate(() => projects.some(p => p.title === 'LT creada desde UI'))); step('A crea una línea desde la interfaz');

await openProject(a, 'LT creada desde UI');
await a.click('.structure-actions button:has-text("+ Nueva tarea")');
await submitDialog(a, { title: 'Tarea creada desde UI', description: 'Detalle sintético', dueDate: '2026-12-15' });
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
await openProject(a, 'LT renombrada desde UI');
await a.click('.structure-more summary');
await a.click('.structure-more button:has-text("Archivar línea")');
await submitDialog(a, {});

const b = await session(cfg.B);
const seenByB = await b.evaluate(() => [...projects.map(p => p.title), ...tasks.map(t => t.title)].join('|'));
assert.doesNotMatch(seenByB, /desde UI/); step('B no ve nada de lo que hizo A');
assert.deepEqual(errors, []); step('sin errores de JavaScript');
await browser.close();
