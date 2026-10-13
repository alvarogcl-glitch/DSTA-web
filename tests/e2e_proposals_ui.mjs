// Live E2E (driven by tests/e2e_proposals_lab.py): A asks the real Copilot for a change, the reply
// carries a proposal, A clicks "Aplicar" and the change lands in A's Vikunja through the action queue.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const step = m => console.log('OK  ' + m);
await page.goto(cfg.base + '/login');
await page.fill('#email', cfg.A.email); await page.fill('#password', cfg.A.password); await page.click('#login-form button');
await page.waitForURL(cfg.base + '/');
await page.waitForFunction(() => typeof projects !== 'undefined' && projects.length > 0, null, { timeout: 30000 });
await page.click('#dsta-assistant-toggle');
await page.fill('#dsta-assistant-input', `Crea en mi línea "${cfg.A.lt}" una tarea llamada exactamente "${cfg.title}". Propón la acción.`);
await page.click('#dsta-assistant-send');
await page.waitForSelector('.dsta-proposals button', { timeout: 300000 });
const label = await page.textContent('.dsta-proposals');
assert.match(label, new RegExp(cfg.title)); step('el Copilot propone la acción con el título pedido');
await page.click('.dsta-proposals button');
await page.waitForFunction(() => /Aplicado/.test(document.querySelector('.dsta-proposals')?.textContent || ''), null, { timeout: 120000 });
step('A aplica la propuesta con un clic');
const visible = await page.evaluate(t => tasks.some(x => x.title === t), cfg.title);
if (!visible) {
  const api = await page.evaluate(async () => (await (await fetch('/api/dashboard', { cache: 'no-store' })).json()).tasks.map(t => t.title));
  const local = await page.evaluate(() => tasks.map(t => t.title));
  console.log('DIAG pedido:', JSON.stringify(cfg.title), '| API:', JSON.stringify(api), '| en memoria:', JSON.stringify(local));
  console.log('DIAG propuesta:', await page.textContent('.dsta-proposals'));
}
assert.ok(visible); step('la tarea aparece en el dashboard de A');
assert.deepEqual(errors, []); step('sin errores de JavaScript');
await browser.close();
