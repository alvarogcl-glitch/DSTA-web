'use strict';
// Accounts mode only: a settings gear (⚙) next to the bell / refresh / install buttons, with the
// account (who is signed in, logout) and the minutes connection (Granola). Future settings go in
// this same panel. In single-user mode /api/session does not exist (404) and nothing is added.
(async () => {
  let response;
  try { response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' }); } catch { return; }
  if (response.status === 401) { window.location.replace('/login'); return; }
  if (!response.ok) return;
  const { actor } = await response.json();
  const refreshButton = document.querySelector('#refresh');
  if (!refreshButton || !actor) return;

  const css = document.createElement('style');
  css.textContent = `
#dsta-settings-toggle{width:auto;min-width:42px}
#dsta-settings-panel{position:absolute;right:0;top:calc(100% + 8px);z-index:6;width:min(360px,calc(100vw - 32px));background:#151b23;
  border:1px solid #3a4859;border-radius:12px;padding:16px;box-shadow:0 12px 32px rgba(0,0,0,.45);text-align:left}
#dsta-settings-panel h3{margin:0 0 10px;font-size:13px;letter-spacing:.06em;color:#68d391;text-transform:uppercase}
#dsta-settings-panel section+section{border-top:1px solid #2b3745;margin-top:14px;padding-top:14px}
#dsta-settings-panel p{margin:0 0 10px;color:#c5d1dd;font-size:13px;line-height:1.4}
#dsta-settings-panel button{width:100%}
.dsta-settings-anchor{position:relative;display:inline-block}`;
  document.head.append(css);

  const anchor = document.createElement('span');
  anchor.className = 'dsta-settings-anchor';
  const gear = document.createElement('button');
  gear.type = 'button';
  gear.id = 'dsta-settings-toggle';
  gear.setAttribute('aria-label', 'Configuración');
  gear.setAttribute('aria-expanded', 'false');
  gear.setAttribute('aria-controls', 'dsta-settings-panel');
  gear.title = 'Configuración';
  gear.textContent = '⚙';
  const panel = document.createElement('div');
  panel.id = 'dsta-settings-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Configuración');
  panel.hidden = true;
  anchor.append(gear, panel);
  const install = document.querySelector('#install-app');
  (install && !install.hidden ? install : refreshButton).after(anchor);

  function section(title) {
    const box = document.createElement('section');
    box.append(Object.assign(document.createElement('h3'), { textContent: title }));
    panel.append(box);
    return box;
  }

  // Account
  const account = section('Cuenta');
  account.append(Object.assign(document.createElement('p'), {
    textContent: actor.displayName ? `${actor.displayName} · ${actor.email}` : actor.email }));
  const logout = Object.assign(document.createElement('button'), { type: 'button', className: 'dsta-logout', textContent: 'Cerrar sesión' });
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } finally { window.location.replace('/login'); }
  });
  account.append(logout);

  // Minutes connection (F4): tokens live on the VM; the browser only follows the provider's
  // authorization URL and sees the connection status.
  const minutes = section('Conexión de minutas');
  const granolaStatus = Object.assign(document.createElement('p'), { className: 'granola-status' });
  granolaStatus.setAttribute('role', 'status');
  const granola = Object.assign(document.createElement('button'), { type: 'button', className: 'granola-connect' });
  minutes.append(granolaStatus, granola);

  function setOpen(open) {
    panel.hidden = !open;
    gear.setAttribute('aria-expanded', String(open));
  }
  gear.addEventListener('click', event => { event.stopPropagation(); setOpen(panel.hidden); });
  document.addEventListener('click', event => { if (!anchor.contains(event.target)) setOpen(false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { setOpen(false); gear.focus(); } });

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function status() {
    const res = await fetch('/api/granola/status', { credentials: 'same-origin', cache: 'no-store' });
    return res.ok ? res.json() : { status: 'error', error: 'No se pudo consultar Granola.' };
  }
  function render(state) {
    const labels = { connected: 'Granola conectado', disconnected: 'Granola sin conectar', error: state.error || 'Error con Granola',
      requested: 'Preparando conexión…', authorize: 'Esperando autorización…', exchanging: 'Conectando…', disconnecting: 'Desconectando…' };
    granolaStatus.textContent = labels[state.status] || state.status;
    if (state.status === 'connected' && Number.isInteger(state.count)) granolaStatus.textContent += ` · ${state.count} minutas`;
    granola.textContent = state.status === 'connected' ? 'Desconectar Granola' : 'Conectar Granola';
    granola.disabled = ['requested', 'exchanging', 'disconnecting'].includes(state.status);
  }
  async function follow(until, onAuthorize) {
    for (let i = 0; i < 60; i += 1) {
      const state = await status();
      render(state);
      if (state.status === 'authorize' && onAuthorize && state.authorizationUrl) { window.location.assign(state.authorizationUrl); return; }
      if (until.includes(state.status)) return state;
      await wait(1500);
    }
  }
  granola.addEventListener('click', async () => {
    const connecting = granola.textContent === 'Conectar Granola';
    granola.disabled = true;
    await fetch(`/api/granola/${connecting ? 'connect' : 'disconnect'}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    await follow(connecting ? ['error', 'connected'] : ['disconnected', 'error'], connecting);
  });
  const params = new URLSearchParams(window.location.search);
  if (params.has('granola')) {
    history.replaceState(null, '', window.location.pathname);
    setOpen(true);
    void follow(['connected', 'error']);
  } else {
    render(await status());
  }
})();
