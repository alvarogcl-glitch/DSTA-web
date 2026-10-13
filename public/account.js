'use strict';
// Settings panel entries: account (accounts mode) and minutes connection. In accounts mode the
// user connects their own Granola here; in single-user mode Granola is managed on the VM and this
// only shows its status.
(async () => {
  const settings = window.DstaSettings;
  if (!settings) return;
  let response;
  try { response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' }); } catch { return; }
  if (response.status === 401) { window.location.replace('/login'); return; }
  const accounts = response.ok;
  const minutes = document.createElement('div');
  const granolaStatus = Object.assign(document.createElement('p'), { className: 'granola-status' });
  granolaStatus.setAttribute('role', 'status');
  minutes.append(granolaStatus);

  if (!accounts) {
    // Single-user dashboard: the bridge on the VM reports Granola's state (status light).
    const note = Object.assign(document.createElement('p'), { textContent: 'La conexión con Granola se administra en la VM (Hermes).' });
    minutes.append(note);
    settings.addSection('Conexión de minutas', minutes, 20);
    const show = async () => {
      try {
        const { health } = await (await fetch('/api/health/refresh', { cache: 'no-store' })).json();
        const granola = health?.granola;
        granolaStatus.textContent = granola ? (granola.ok ? 'Granola conectado' : `Granola: ${granola.detail || 'sin conexión'}`) : 'Granola: sin reporte del puente';
      } catch { granolaStatus.textContent = 'Granola: estado no disponible'; }
    };
    window.addEventListener('dsta-settings-open', show);
    return show();
  }

  const { actor } = await response.json();
  const account = document.createElement('div');
  account.append(Object.assign(document.createElement('p'), {
    textContent: actor.displayName ? `${actor.displayName} · ${actor.email}` : actor.email }));
  const logout = Object.assign(document.createElement('button'), { type: 'button', className: 'dsta-logout', textContent: 'Cerrar sesión' });
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } finally { window.location.replace('/login'); }
  });
  account.append(logout);
  settings.addSection('Cuenta', account, 10);

  const granola = Object.assign(document.createElement('button'), { type: 'button', className: 'granola-connect' });
  minutes.append(granola);
  settings.addSection('Conexión de minutas', minutes, 20);
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
    settings.open();
    void follow(['connected', 'error']);
  } else {
    render(await status());
  }
})();
