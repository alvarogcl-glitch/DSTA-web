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
await a.click('.structure-actions button:has-text("Editar tarea")');
await submitDialog(a, { title: 'Tarea editada desde UI' });
const edited = await a.evaluate(() => tasks.find(t => t.title === 'Tarea editada desde UI'));
assert.equal(edited.description, 'Detalle sintético', 'editing the title keeps the description'); step('A edita la tarea y se conserva la descripción');

await openTask(a, 'Tarea editada desde UI');
await a.click('.structure-actions button:has-text("Mover a otra línea")');
await submitDialog(a, { projectId: cfg.A.lt });
assert.equal(await a.evaluate(n => tasks.find(t => t.title === 'Tarea editada desde UI').project, cfg.A.lt), cfg.A.lt); step('A mueve la tarea a otra línea');

await openProject(a, 'LT creada desde UI');
await a.click('.structure-actions button:has-text("Renombrar línea")');
await submitDialog(a, { title: 'LT renombrada desde UI' });
await openProject(a, 'LT renombrada desde UI');
a.on('dialog', d => d.accept());
await a.click('.structure-actions button:has-text("Archivar línea")');
await submitDialog(a, {});
assert.ok(!(await a.evaluate(() => projects.some(p => p.title.startsWith('LT renombrada'))))); step('A renombra y archiva la línea');

const b = await session(cfg.B);
const seenByB = await b.evaluate(() => [...projects.map(p => p.title), ...tasks.map(t => t.title)].join('|'));
assert.doesNotMatch(seenByB, /desde UI/); step('B no ve nada de lo que hizo A');
assert.deepEqual(errors, []); step('sin errores de JavaScript');
await browser.close();
