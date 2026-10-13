const loginPanel = document.querySelector('#login-panel');
const workspace = document.querySelector('#workspace');
const loginForm = document.querySelector('#login-form');
const loginMessage = document.querySelector('#login-message');
const actorName = document.querySelector('#actor-name');
const actorEmail = document.querySelector('#actor-email');
const itemsElement = document.querySelector('#items');
const itemCount = document.querySelector('#item-count');
const itemForm = document.querySelector('#item-form');
const itemMessage = document.querySelector('#item-message');
const probeMessage = document.querySelector('#probe-message');
const probeButton = document.querySelector('#probe-button');
const logoutButton = document.querySelector('#logout-button');

let session = null;

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase()) && session?.csrfToken) {
    headers.set('X-CSRF-Token', session.csrfToken);
  }
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* Respuesta sin cuerpo JSON. */ }
  return { response, payload };
}

function showMessage(element, text, kind = '') {
  element.textContent = text;
  element.className = `message${kind ? ` ${kind}` : ''}`;
}

function renderActor(actor) {
  actorName.textContent = actor.displayName;
  actorEmail.textContent = actor.email;
  loginPanel.hidden = true;
  workspace.hidden = false;
}

function renderItems(items) {
  itemsElement.replaceChildren();
  itemCount.textContent = String(items.length);
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Aún no hay registros en este espacio.';
    itemsElement.append(empty);
    return;
  }
  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'item-card';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const detail = document.createElement('p');
    detail.textContent = item.detail || 'Sin detalle.';
    const owner = document.createElement('span');
    owner.className = 'item-owner';
    owner.textContent = `ACTOR ${item.actor_id}`;
    card.append(title, detail, owner);
    itemsElement.append(card);
  }
}

async function refreshItems() {
  const { response, payload } = await api('/api/demo/items');
  if (!response.ok) throw new Error(payload.error || 'No se pudieron cargar los registros.');
  renderItems(payload.items);
}

async function enter(actor, csrfToken) {
  session = { actor, csrfToken };
  renderActor(actor);
  showMessage(loginMessage, '');
  try { await refreshItems(); }
  catch (error) { showMessage(itemMessage, error.message, 'error'); }
}

async function restoreSession() {
  try {
    const { response, payload } = await api('/api/session');
    if (response.ok) await enter(payload.actor, payload.csrfToken);
  } catch {
    showMessage(loginMessage, 'No se pudo contactar al piloto. Recarga la página e inténtalo de nuevo.', 'error');
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = loginForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  showMessage(loginMessage, 'Validando cuenta…');
  try {
    const form = new FormData(loginForm);
    const { response, payload } = await api('/api/auth/login', {
      method: 'POST',
      body: { email: form.get('email'), password: form.get('password') },
    });
    if (!response.ok) throw new Error(payload.error || 'No se pudo iniciar sesión.');
    loginForm.reset();
    await enter(payload.actor, payload.csrfToken);
  } catch (error) {
    showMessage(loginMessage, error.message, 'error');
  } finally {
    submit.disabled = false;
  }
});

itemForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = itemForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  showMessage(itemMessage, 'Guardando en D1…');
  try {
    const form = new FormData(itemForm);
    const otherActor = session.actor.id === 'demo-a' ? 'demo-b' : 'demo-a';
    const { response, payload } = await api('/api/demo/items', {
      method: 'POST',
      body: { title: form.get('title'), detail: form.get('detail'), actor_id: otherActor },
    });
    if (!response.ok) throw new Error(payload.error || 'No se pudo guardar.');
    if (payload.item.actor_id !== session.actor.id) throw new Error('FALLO: el servidor aceptó un actor enviado por el cliente.');
    itemForm.reset();
    showMessage(itemMessage, 'Guardado solo en tu espacio. El actor del cliente fue ignorado.', 'success');
    await refreshItems();
  } catch (error) {
    showMessage(itemMessage, error.message, 'error');
  } finally {
    submit.disabled = false;
  }
});

probeButton.addEventListener('click', async () => {
  probeButton.disabled = true;
  showMessage(probeMessage, 'Consultando el registro ajeno…');
  try {
    const foreignItemId = session.actor.id === 'demo-a' ? 'demo-item-b' : 'demo-item-a';
    const { response, payload } = await api(`/api/demo/items/${encodeURIComponent(foreignItemId)}`);
    if (response.status === 404) {
      showMessage(probeMessage, 'Bloqueado correctamente: la otra cuenta recibe 404, sin revelar el registro.', 'success');
    } else if (response.ok) {
      showMessage(probeMessage, `FALLO DE AISLAMIENTO: la API devolvió ${payload.item?.title || 'un registro ajeno'}.`, 'error');
    } else {
      showMessage(probeMessage, `La prueba no concluyó (HTTP ${response.status}).`, 'error');
    }
  } catch {
    showMessage(probeMessage, 'No se pudo completar la prueba de lectura cruzada.', 'error');
  } finally {
    probeButton.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try {
    const { response } = await api('/api/auth/logout', { method: 'POST' });
    if (!response.ok) throw new Error('No se pudo revocar la sesión.');
    session = null;
    workspace.hidden = true;
    loginPanel.hidden = false;
    renderItems([]);
    showMessage(loginMessage, 'Sesión cerrada y revocada.', 'success');
  } catch (error) {
    showMessage(probeMessage, error.message, 'error');
  } finally {
    logoutButton.disabled = false;
  }
});

restoreSession();
