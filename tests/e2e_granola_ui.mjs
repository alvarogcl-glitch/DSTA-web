// F4.3 browser E2E (driven by tests/e2e_granola_lab.py): A connects Granola from the dashboard
// (synthetic provider), the bridge exchanges the code on the VM and imports A's meetings into A's
// inbox only; then A disconnects.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const errors = [];
const step = m => console.log('OK  ' + m);
async function session(user) {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(cfg.base + '/login');
  await page.fill('#email', user.email); await page.fill('#password', user.password); await page.click('#login-form button');
  await page.waitForURL(cfg.base + '/');
  await page.waitForSelector('.granola-connect');
  return page;
}
const api = (page, path) => page.evaluate(async p => (await fetch(p, { cache: 'no-store' })).json(), path);

const a = await session(cfg.A);
assert.match(await a.textContent('.granola-status'), /sin conectar/); step('A ve «Granola sin conectar»');
await a.click('.granola-connect');
// Browser goes to the (synthetic) provider, which consents and redirects to /oauth/granola/callback.
await a.waitForURL(url => url.pathname === '/' && url.origin === cfg.base, { timeout: 60000 });
await a.waitForFunction(() => /Granola conectado/.test(document.querySelector('.granola-status')?.textContent || ''), null, { timeout: 60000 });
step('A conecta Granola: autorización, callback e intercambio en la VM');
const minutesA = await api(a, '/api/minutes');
assert.deepEqual(minutesA.minutes.map(m => m.titulo).sort(), ['Comité sintético', 'Revisión sintética']);
assert.ok(!JSON.stringify(minutesA).includes('nota privada'), 'private notes never leave the VM');
step('las minutas de A llegan a SU bandeja (sin notas privadas)');
assert.match(await a.textContent('.granola-status'), /2 minutas/); step('el estado muestra la cantidad importada');

const b = await session(cfg.B);
assert.equal((await api(b, '/api/minutes')).minutes.length, 0);
assert.equal((await api(b, '/api/granola/status')).status, 'disconnected'); step('B no ve las minutas de A ni queda conectado');

await a.click('.granola-connect');
await a.waitForFunction(() => /sin conectar/.test(document.querySelector('.granola-status')?.textContent || ''), null, { timeout: 60000 });
step('A desconecta Granola');
assert.deepEqual(errors, []); step('sin errores de JavaScript');
await browser.close();
