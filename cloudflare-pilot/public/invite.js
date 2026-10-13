const form = document.querySelector('#invite-form');
const message = document.querySelector('#invite-message');
const password = document.querySelector('#password');
const confirm = document.querySelector('#confirm');

// El token viaja en el fragmento (#t=…), que el navegador no envía al servidor ni a terceros.
const token = new URLSearchParams(window.location.hash.slice(1)).get('t') || '';
history.replaceState(null, '', window.location.pathname);

function showMessage(text, kind = '') {
  message.textContent = text;
  message.className = `message${kind ? ` ${kind}` : ''}`;
}

if (!token) {
  form.querySelector('button').disabled = true;
  showMessage('Este link no trae una invitación válida. Pide uno nuevo al administrador del piloto.', 'error');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (password.value !== confirm.value) return showMessage('Las contraseñas no coinciden.', 'error');
  if (password.value.length < 14) return showMessage('Usa al menos 14 caracteres.', 'error');
  const button = form.querySelector('button');
  button.disabled = true;
  showMessage('Activando…');
  try {
    const response = await fetch('/api/auth/accept-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ token, password: password.value }),
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* sin cuerpo */ }
    if (response.status === 201) {
      form.reset();
      form.hidden = true;
      showMessage(`Cuenta ${payload.email} activada. Ya puedes iniciar sesión.`, 'success');
      const link = document.createElement('a');
      link.href = '/';
      link.className = 'button primary';
      link.textContent = 'Ir a iniciar sesión →';
      message.after(link);
      return;
    }
    showMessage(payload.error || `No se pudo activar (HTTP ${response.status}).`, 'error');
    if (response.status !== 400 || /contraseña/i.test(payload.error || '')) button.disabled = false;
  } catch {
    showMessage('Error de red. Intenta de nuevo.', 'error');
    button.disabled = false;
  } finally {
    password.value = '';
    confirm.value = '';
  }
});
