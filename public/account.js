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
})();
