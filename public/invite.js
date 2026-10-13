'use strict';
const form = document.querySelector('#invite-form');
const message = document.querySelector('#message');
const password = document.querySelector('#password');
const confirmField = document.querySelector('#confirm');
// The token travels in the fragment (#t=…), which browsers never send to the server.
const token = new URLSearchParams(window.location.hash.slice(1)).get('t') || '';
history.replaceState(null, '', window.location.pathname);
function show(text, kind = '') { message.textContent = text; message.className = `message${kind ? ` ${kind}` : ''}`; }
if (!token) {
  form.querySelector('button').disabled = true;
  show('Este link no trae una invitación válida. Pide uno nuevo al administrador.', 'error');
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (password.value !== confirmField.value) return show('Las contraseñas no coinciden.', 'error');
  if (password.value.length < 14) return show('Usa al menos 14 caracteres.', 'error');
  const button = form.querySelector('button');
  button.disabled = true;
  show('Activando…');
  try {
    const response = await fetch('/api/auth/accept-invite', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', cache: 'no-store',
      body: JSON.stringify({ token, password: password.value }),
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* sin cuerpo */ }
    if (response.status === 201) {
      form.hidden = true;
      show(`Cuenta ${payload.email} activada. Ya puedes iniciar sesión.`, 'success');
      const link = Object.assign(document.createElement('a'), { href: '/login', className: 'button', textContent: 'Ir a iniciar sesión' });
      message.after(link);
      return;
    }
    show(payload.error || `No se pudo activar (HTTP ${response.status}).`, 'error');
    if (response.status !== 400 || /contraseña/i.test(payload.error || '')) button.disabled = false;
  } catch {
    show('Error de red. Intenta de nuevo.', 'error');
    button.disabled = false;
  } finally {
    password.value = '';
    confirmField.value = '';
  }
});
