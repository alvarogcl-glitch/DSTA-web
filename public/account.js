'use strict';
// Accounts mode only: shows who is signed in and a logout button in the dashboard header.
// In single-user mode /api/session does not exist (404) and this script does nothing.
(async () => {
  let response;
  try { response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' }); } catch { return; }
  if (response.status === 401) { window.location.replace('/login'); return; }
  if (!response.ok) return;
  const { actor } = await response.json();
  const header = document.querySelector('main.wrap > header > div:last-child');
  if (!header || !actor) return;
  const bar = document.createElement('div');
  bar.className = 'account-bar';
  bar.style.cssText = 'display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:8px;color:#9bacbd;font-size:13px';
  const who = document.createElement('span');
  who.textContent = actor.displayName ? `${actor.displayName} · ${actor.email}` : actor.email;
  const logout = document.createElement('button');
  logout.type = 'button';
  logout.textContent = 'Cerrar sesión';
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } finally { window.location.replace('/login'); }
  });
  bar.append(who, logout);
  header.append(bar);

  // F4: per-user Granola connection. Tokens live on the VM; the browser only follows the
  // provider's authorization URL and sees the connection status.
  const granola = document.createElement('button');
  granola.type = 'button';
  granola.className = 'granola-connect';
  const granolaStatus = document.createElement('span');
  granolaStatus.className = 'granola-status';
  granolaStatus.setAttribute('role', 'status');
  bar.prepend(granolaStatus, granola);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function status() {
    const res = await fetch('/api/granola/status', { credentials: 'same-origin', cache: 'no-store' });
    return res.ok ? res.json() : { status: 'error', error: 'No se pudo consultar Granola.' };
  }
  function render(state) {
    const labels = { connected: 'Granola conectado', disconnected: 'Granola sin conectar', error: state.error || 'Error con Granola',
      requested: 'Preparando conexión…', authorize: 'Esperando autorización…', exchanging: 'Conectando…', disconnecting: 'Desconectando…' };
    granolaStatus.textContent = labels[state.status] || state.status;
    granola.textContent = state.status === 'connected' ? 'Desconectar Granola' : 'Conectar Granola';
    granola.disabled = ['requested', 'exchanging', 'disconnecting'].includes(state.status);
    if (state.status === 'connected' && Number.isInteger(state.count)) granolaStatus.textContent += ` · ${state.count} minutas`;
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
    void follow(['connected', 'error']);
  } else {
    render(await status());
  }
})();
