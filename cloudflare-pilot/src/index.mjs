const encoder = new TextEncoder();
const SESSION_COOKIE = '__Host-dsta_pilot_session';
const CSRF_COOKIE = '__Host-dsta_pilot_csrf';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const PBKDF2_ITERATIONS = 100000; // máximo que acepta el runtime de Workers
const MAX_LOGIN_ATTEMPTS_PER_MINUTE = 10;
const MIN_PASSWORD_LENGTH = 14;
const INVALID_EMAIL_SALT = 'aW52YWxpZC1lbWFpbC1zYWx0LWRzdGE=';
const INVALID_PASSWORD_HASH = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  let difference = left.length ^ right.length;
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function sha256(value) {
  return toBase64Url(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function derivePasswordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64Url(salt), iterations: PBKDF2_ITERATIONS,
  }, key, 256);
  return toBase64Url(bits);
}

function securityHeaders(headers = {}) {
  const result = new Headers(headers);
  result.set('X-Content-Type-Options', 'nosniff');
  result.set('X-Frame-Options', 'DENY');
  result.set('Referrer-Policy', 'no-referrer');
  result.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  result.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  result.set('Cache-Control', 'no-store');
  result.set('Cross-Origin-Resource-Policy', 'same-origin');
  return result;
}

function json(data, status = 200, extraHeaders = {}) {
  const headers = securityHeaders(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(data === null ? null : JSON.stringify(data), { status, headers });
}

function hasDatabase(env) {
  return env.DB && typeof env.DB.prepare === 'function';
}

function readCookie(request, wantedName) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === wantedName) return part.slice(separator + 1).trim();
  }
  return '';
}

function originMatches(request) {
  return request.headers.get('Origin') === new URL(request.url).origin;
}

async function parseJsonBody(request, limit = 4096) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return { error: json({ error: 'Se requiere application/json.' }, 415) };
  }
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > limit) return { error: json({ error: 'Solicitud demasiado grande.' }, 413) };
  const text = await request.text();
  if (encoder.encode(text).byteLength > limit) return { error: json({ error: 'Solicitud demasiado grande.' }, 413) };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object');
    return { value };
  } catch {
    return { error: json({ error: 'JSON inválido.' }, 400) };
  }
}

function sessionCookie(token, maxAge = SESSION_TTL_SECONDS) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function csrfCookie(token, maxAge = SESSION_TTL_SECONDS) {
  return `${CSRF_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict`;
}

function expiredCookies() {
  return [sessionCookie('', 0), csrfCookie('', 0)];
}

async function currentSession(request, env) {
  if (!hasDatabase(env)) return { unavailable: true };
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || token.length > 128) return null;
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(`
    SELECT s.token_hash, s.actor_id, s.expires_at, u.email, u.display_name
    FROM sessions s JOIN users u ON u.id = s.actor_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, now).first();
  if (!row) return null;
  return {
    tokenHash,
    actor: { id: row.actor_id, email: row.email, displayName: row.display_name },
    csrfToken: readCookie(request, CSRF_COOKIE),
  };
}

async function validateCsrf(request, session) {
  if (!originMatches(request)) return false;
  const header = request.headers.get('X-CSRF-Token') || '';
  return Boolean(header && session.csrfToken && safeEqual(header, session.csrfToken));
}

async function takeLoginAttempt(request, env) {
  const address = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await sha256(`login:${address}`);
  const minuteBucket = Math.floor(Date.now() / 60000);
  await env.DB.prepare('DELETE FROM login_limits WHERE minute_bucket < ?').bind(minuteBucket - 60).run();
  await env.DB.prepare(`
    INSERT INTO login_limits(ip_hash, minute_bucket, attempts) VALUES(?,?,1)
    ON CONFLICT(ip_hash) DO UPDATE SET
      minute_bucket = excluded.minute_bucket,
      attempts = CASE WHEN login_limits.minute_bucket = excluded.minute_bucket
        THEN login_limits.attempts + 1 ELSE 1 END
  `).bind(ipHash, minuteBucket).run();
  const row = await env.DB.prepare('SELECT attempts FROM login_limits WHERE ip_hash = ? AND minute_bucket = ?')
    .bind(ipHash, minuteBucket).first();
  return Number(row?.attempts || 0) <= MAX_LOGIN_ATTEMPTS_PER_MINUTE;
}

async function login(request, env) {
  if (!originMatches(request)) return json({ error: 'Origen no permitido.' }, 403);
  if (!hasDatabase(env)) return json({ error: 'Servicio de prueba no disponible.' }, 503);
  try {
    if (!(await takeLoginAttempt(request, env))) return json({ error: 'Demasiados intentos; vuelve a probar en un minuto.' }, 429);
  } catch {
    return json({ error: 'Servicio de prueba no disponible.' }, 503);
  }
  const parsed = await parseJsonBody(request);
  if (parsed.error) return parsed.error;
  const email = typeof parsed.value.email === 'string' ? parsed.value.email.trim().toLowerCase() : '';
  const password = typeof parsed.value.password === 'string' ? parsed.value.password : '';
  if (!email || email.length > 254 || !password || password.length > 256) {
    return json({ error: 'Credenciales inválidas.' }, 401);
  }
  const user = await env.DB.prepare(`
    SELECT id, email, display_name, password_salt, password_hash
    FROM users WHERE lower(email) = ? LIMIT 1
  `).bind(email).first();
  const salt = user?.password_salt || INVALID_EMAIL_SALT;
  let calculated;
  try {
    calculated = await derivePasswordHash(password, salt);
  } catch {
    return json({ error: 'Servicio de prueba no disponible.' }, 503);
  }
  if (!user || !safeEqual(calculated, user.password_hash || INVALID_PASSWORD_HASH)) {
    return json({ error: 'Credenciales inválidas.' }, 401);
  }

  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const csrfToken = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256(token);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  try {
    await env.DB.prepare('INSERT INTO sessions(token_hash, actor_id, expires_at) VALUES(?,?,?)')
      .bind(tokenHash, user.id, expiresAt).run();
  } catch {
    return json({ error: 'No se pudo iniciar la sesión.' }, 503);
  }
  const response = json({
    actor: { id: user.id, email: user.email, displayName: user.display_name },
    csrfToken,
  });
  response.headers.append('Set-Cookie', sessionCookie(token));
  response.headers.append('Set-Cookie', csrfCookie(csrfToken));
  return response;
}

async function acceptInvite(request, env) {
  if (!originMatches(request)) return json({ error: 'Origen no permitido.' }, 403);
  if (!hasDatabase(env)) return json({ error: 'Servicio de prueba no disponible.' }, 503);
  try {
    if (!(await takeLoginAttempt(request, env))) return json({ error: 'Demasiados intentos; vuelve a probar en un minuto.' }, 429);
  } catch {
    return json({ error: 'Servicio de prueba no disponible.' }, 503);
  }
  const parsed = await parseJsonBody(request);
  if (parsed.error) return parsed.error;
  const token = typeof parsed.value.token === 'string' ? parsed.value.token : '';
  const password = typeof parsed.value.password === 'string' ? parsed.value.password : '';
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 256) {
    return json({ error: `La contraseña debe tener entre ${MIN_PASSWORD_LENGTH} y 256 caracteres.` }, 400);
  }
  const invalid = json({ error: 'Invitación inválida, vencida o ya usada.' }, 400);
  if (!token || token.length > 128) return invalid;

  // El hash se calcula antes de reclamar, para que un fallo aquí no consuma la invitación.
  const salt = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  let passwordHash;
  try {
    passwordHash = await derivePasswordHash(password, salt);
  } catch {
    return json({ error: 'Servicio de prueba no disponible.' }, 503);
  }

  // Reclamar la invitación es atómico: solo una solicitud puede marcarla como usada.
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const claimed = await env.DB.prepare(`
    UPDATE invitations SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
  `).bind(now, tokenHash, now).run();
  if (Number(claimed?.meta?.changes || 0) !== 1) return invalid;
  const invite = await env.DB.prepare(`
    SELECT actor_id, email, display_name, initial_item_id FROM invitations WHERE token_hash = ?
  `).bind(tokenHash).first();

  try {
    await env.DB.prepare('INSERT INTO users(id,email,display_name,password_salt,password_hash) VALUES(?,?,?,?,?)')
      .bind(invite.actor_id, invite.email, invite.display_name, salt, passwordHash).run();
  } catch {
    return json({ error: 'La cuenta de esta invitación ya existe.' }, 409);
  }
  if (invite.initial_item_id) {
    await env.DB.prepare('INSERT OR IGNORE INTO demo_items(id,actor_id,title,detail,created_at) VALUES(?,?,?,?,?)')
      .bind(invite.initial_item_id, invite.actor_id, `Registro privado de ${invite.display_name}`,
        'Dato sintético exclusivo de esta cuenta.', now).run();
  }
  return json({ created: true, email: invite.email }, 201);
}

function publicItem(item) {
  return {
    id: item.id,
    actor_id: item.actor_id,
    title: item.title,
    detail: item.detail,
    createdAt: Number(item.created_at),
  };
}

async function routeApi(request, env, url) {
  const { pathname } = url;
  if (pathname === '/api/health' && request.method === 'GET') {
    return json({ service: 'dsta-multiuser-isolation-pilot', mode: 'synthetic', storage: 'D1' });
  }
  if (pathname === '/api/auth/login' && request.method === 'POST') return login(request, env);
  if (pathname === '/api/auth/accept-invite' && request.method === 'POST') return acceptInvite(request, env);

  if (!hasDatabase(env)) return json({ error: 'Servicio de prueba no disponible.' }, 503);
  const session = await currentSession(request, env);
  if (session?.unavailable) return json({ error: 'Servicio de prueba no disponible.' }, 503);

  if (pathname === '/api/session' && request.method === 'GET') {
    if (!session) return json({ error: 'No autenticado.' }, 401);
    return json({ actor: session.actor, csrfToken: session.csrfToken });
  }
  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    if (!session) return json({ error: 'No autenticado.' }, 401);
    if (!(await validateCsrf(request, session))) return json({ error: 'CSRF/origen inválido.' }, 403);
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.tokenHash).run();
    const response = json(null, 204);
    for (const cookie of expiredCookies()) response.headers.append('Set-Cookie', cookie);
    return response;
  }
  if (pathname === '/api/demo/items' && request.method === 'GET') {
    if (!session) return json({ error: 'No autenticado.' }, 401);
    const result = await env.DB.prepare(`
      SELECT id, actor_id, title, detail, created_at
      FROM demo_items WHERE actor_id = ? ORDER BY created_at DESC, id
    `).bind(session.actor.id).all();
    return json({ items: result.results.map(publicItem) });
  }
  if (pathname === '/api/demo/items' && request.method === 'POST') {
    if (!session) return json({ error: 'No autenticado.' }, 401);
    if (!(await validateCsrf(request, session))) return json({ error: 'CSRF/origen inválido.' }, 403);
    const parsed = await parseJsonBody(request, 4096);
    if (parsed.error) return parsed.error;
    const title = typeof parsed.value.title === 'string' ? parsed.value.title.trim() : '';
    const detail = typeof parsed.value.detail === 'string' ? parsed.value.detail.trim() : '';
    if (!title || title.length > 120 || detail.length > 1000) {
      return json({ error: 'Título o detalle fuera de límites.' }, 400);
    }
    const item = {
      id: crypto.randomUUID(), actor_id: session.actor.id, title, detail, created_at: Math.floor(Date.now() / 1000),
    };
    await env.DB.prepare('INSERT INTO demo_items(id,actor_id,title,detail,created_at) VALUES(?,?,?,?,?)')
      .bind(item.id, item.actor_id, item.title, item.detail, item.created_at).run();
    return json({ item: publicItem(item) }, 201);
  }
  const itemMatch = pathname.match(/^\/api\/demo\/items\/([A-Za-z0-9-]{1,80})$/);
  if (itemMatch && request.method === 'GET') {
    if (!session) return json({ error: 'No autenticado.' }, 401);
    const item = await env.DB.prepare(`
      SELECT id, actor_id, title, detail, created_at
      FROM demo_items WHERE id = ? AND actor_id = ? LIMIT 1
    `).bind(itemMatch[1], session.actor.id).first();
    return item ? json({ item: publicItem(item) }) : json({ error: 'No encontrado.' }, 404);
  }
  return json({ error: 'Ruta no encontrada.' }, 404);
}

async function fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    try {
      return await routeApi(request, env, url);
    } catch {
      return json({ error: 'Error interno del piloto.' }, 500);
    }
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Método no permitido.' }, 405);
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return json({ error: 'Recurso no encontrado.' }, 404);
  try {
    const asset = await env.ASSETS.fetch(request);
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers: securityHeaders(asset.headers) });
  } catch {
    return json({ error: 'Recurso no encontrado.' }, 404);
  }
}

export default { fetch };
