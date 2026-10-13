'use strict';
const form = document.querySelector('#login-form');
const message = document.querySelector('#message');
function show(text, kind = '') { message.textContent = text; message.className = `message${kind ? ` ${kind}` : ''}`; }
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  show('Entrando…');
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', cache: 'no-store',
      body: JSON.stringify({ email: form.email.value, password: form.password.value }),
    });
    if (response.ok) { window.location.replace('/'); return; }
    let payload = {};
    try { payload = await response.json(); } catch { /* sin cuerpo */ }
    show(payload.error || `No se pudo entrar (HTTP ${response.status}).`, 'error');
  } catch {
    show('Error de red. Intenta de nuevo.', 'error');
  } finally {
    form.password.value = '';
    button.disabled = false;
  }
});
