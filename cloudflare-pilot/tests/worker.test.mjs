import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const modulePath = new URL('../src/index.mjs', import.meta.url);
const encoder = new TextEncoder();
const base64url = (bytes) => Buffer.from(bytes).toString('base64url');
let worker;
let sqlite;
let users;
let userHashes;
const env = {};

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(salt, 'base64url'), iterations: 100000,
  }, key, 256);
  return base64url(bits);
}

function createD1Binding(database) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() { return database.prepare(sql).get(...values) ?? null; },
            async all() { return { results: database.prepare(sql).all(...values) }; },
            async run() {
              try {
                const result = database.prepare(sql).run(...values);
                return { success: true, meta: { changes: Number(result.changes) } };
              } catch (error) {
                database.lastError = `${sql}: ${error.message}`;
                throw error;
              }
            },
          };
        },
      };
    },
  };
}

function freshDatabase() {
  const database = new DatabaseSync(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    database.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  return database;
}

function seedDatabase() {
  sqlite?.close();
  sqlite = freshDatabase();
  const insertUser = sqlite.prepare('INSERT INTO users(id,email,display_name,password_salt,password_hash) VALUES(?,?,?,?,?)');
  for (const user of userHashes) {
    insertUser.run(user.id, user.email, user.displayName, user.salt, user.passwordHash);
  }
  const insertItem = sqlite.prepare('INSERT INTO demo_items(id,actor_id,title,detail,created_at) VALUES(?,?,?,?,?)');
  insertItem.run('item-alice', 'actor-a', 'Registro sintético A', 'Visible solo para la Cuenta A.', 1);
  insertItem.run('item-bob', 'actor-b', 'Registro sintético B', 'Visible solo para la Cuenta B.', 1);
  env.DB = createD1Binding(sqlite);
}

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const request = new Request(`https://pilot.example${path}`, {
    method,
    headers: new Headers(headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return worker.fetch(request, env, {});
}

function sessionCookies(response) {
  const cookies = response.headers.getSetCookie();
  return cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

async function login(user) {
  const response = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://pilot.example' },
    body: { email: user.email, password: user.password },
  });
  assert.equal(response.status, 200, sqlite?.lastError || 'login should create a D1 session');
  const cookieHeaders = response.headers.getSetCookie();
  assert.equal(cookieHeaders.length, 2, 'expected session and CSRF cookies');
  assert.match(cookieHeaders.find((cookie) => cookie.startsWith('__Host-dsta_pilot_session=')), /HttpOnly; SameSite=Lax/);
  assert.match(cookieHeaders.find((cookie) => cookie.startsWith('__Host-dsta_pilot_csrf=')), /SameSite=Strict/);
  assert.doesNotMatch(cookieHeaders.find((cookie) => cookie.startsWith('__Host-dsta_pilot_csrf=')), /HttpOnly/);
  return { response, cookie: sessionCookies(response), payload: await response.json() };
}

before(async () => {
  if (!existsSync(modulePath)) return;
  ({ default: worker } = await import(modulePath.href));
  users = [
    { id: 'actor-a', email: 'alice@dsta.test', displayName: 'Cuenta A', password: 'synthetic-pass-A-2026' },
    { id: 'actor-b', email: 'bob@dsta.test', displayName: 'Cuenta B', password: 'synthetic-pass-B-2026' },
  ];
  userHashes = await Promise.all(users.map(async (user, index) => {
    const salt = base64url(Buffer.from(`pilot-salt-${index}-0123456789`));
    return { ...user, salt, passwordHash: await passwordHash(user.password, salt) };
  }));
});

beforeEach(() => seedDatabase());

test('D1 migrations create actor-owned tables and a login rate-limit store', () => {
  const migrations = new URL('../migrations/', import.meta.url);
  const files = readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort();
  assert.ok(files.includes('0001_init.sql'));
  assert.ok(files.includes('0002_login_rate_limits.sql'), 'expected the login rate-limit migration');
  const database = new DatabaseSync(':memory:');
  for (const file of files) database.exec(readFileSync(new URL(file, migrations), 'utf8'));
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','sessions','demo_items','login_limits') ORDER BY name").all();
  assert.deepEqual(tables.map((row) => row.name), ['demo_items', 'login_limits', 'sessions', 'users']);
  const foreignKeys = database.prepare('PRAGMA foreign_key_list(demo_items)').all();
  assert.ok(foreignKeys.some((key) => key.table === 'users' && key.from === 'actor_id'));
  database.close();
});

test('Cloudflare Worker entrypoint exists', () => {
  assert.ok(existsSync(modulePath), 'expected cloudflare-pilot/src/index.mjs');
});

test('two synthetic accounts see only their own D1 records; foreign reads return 404', async (t) => {
  if (!worker) return t.skip('Worker entrypoint not implemented yet');
  const alice = await login(users[0]);
  const bob = await login(users[1]);
  assert.equal(alice.payload.actor.id, 'actor-a');
  assert.equal(bob.payload.actor.id, 'actor-b');
  const restored = await call('/api/session', { headers: { Cookie: alice.cookie } });
  assert.equal(restored.status, 200);
  const restoredBody = await restored.json();
  assert.equal(restoredBody.actor.id, 'actor-a');
  assert.equal(restoredBody.csrfToken, alice.payload.csrfToken);

  const aliceItems = await call('/api/demo/items', { headers: { Cookie: alice.cookie } });
  const bobItems = await call('/api/demo/items', { headers: { Cookie: bob.cookie } });
  assert.equal(aliceItems.status, 200);
  assert.equal(bobItems.status, 200);
  assert.deepEqual((await aliceItems.json()).items.map((item) => item.id), ['item-alice']);
  assert.deepEqual((await bobItems.json()).items.map((item) => item.id), ['item-bob']);

  const crossRead = await call('/api/demo/items/item-bob', { headers: { Cookie: alice.cookie } });
  assert.equal(crossRead.status, 404);
  assert.doesNotMatch(await crossRead.text(), /Cuenta B|Registro sintético B/i);
});

test('invalid credentials are rejected without issuing a session cookie', async (t) => {
  if (!worker) return t.skip('Worker entrypoint not implemented yet');
  const response = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://pilot.example' },
    body: { email: users[0].email, password: 'incorrect-password' },
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.getSetCookie().length, 0);
});

test('mutations enforce same-origin and CSRF; logout revokes the D1 session', async (t) => {
  if (!worker) return t.skip('Worker entrypoint not implemented yet');
  const wrongOrigin = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: { email: users[0].email, password: users[0].password },
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.headers.getSetCookie().length, 0);

  const alice = await login(users[0]);
  const missingCsrf = await call('/api/auth/logout', {
    method: 'POST', headers: { Cookie: alice.cookie, Origin: 'https://pilot.example' },
  });
  assert.equal(missingCsrf.status, 403);

  const logout = await call('/api/auth/logout', {
    method: 'POST', headers: { Cookie: alice.cookie, Origin: 'https://pilot.example', 'X-CSRF-Token': alice.payload.csrfToken },
  });
  assert.equal(logout.status, 204);
  const session = await call('/api/session', { headers: { Cookie: alice.cookie } });
  assert.equal(session.status, 401);
});

test('the public login is rate-limited by a non-reversible IP key', async (t) => {
  if (!worker) return t.skip('Worker entrypoint not implemented yet');
  const ip = '198.51.100.42';
  const ipHash = base64url(await crypto.subtle.digest('SHA-256', encoder.encode(`login:${ip}`)));
  const bucket = Math.floor(Date.now() / 60000);
  sqlite.prepare('INSERT INTO login_limits(ip_hash, minute_bucket, attempts) VALUES(?,?,?)').run(ipHash, bucket, 10);
  const response = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://pilot.example', 'CF-Connecting-IP': ip },
    body: { email: users[0].email, password: users[0].password },
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.getSetCookie().length, 0);
});

test('a client-supplied actor id cannot redirect a synthetic D1 write', async (t) => {
  if (!worker) return t.skip('Worker entrypoint not implemented yet');
  const alice = await login(users[0]);
  const bob = await login(users[1]);
  const created = await call('/api/demo/items', {
    method: 'POST',
    headers: { Cookie: alice.cookie, Origin: 'https://pilot.example', 'X-CSRF-Token': alice.payload.csrfToken, 'Content-Type': 'application/json' },
    body: { title: 'A-owned test record', detail: 'Synthetic only', actor_id: 'actor-b' },
  });
  assert.equal(created.status, 201);
  const item = await created.json();
  assert.equal(item.item.actor_id, 'actor-a');

  const bobRead = await call(`/api/demo/items/${encodeURIComponent(item.item.id)}`, { headers: { Cookie: bob.cookie } });
  assert.equal(bobRead.status, 404);
  const bobItems = await call('/api/demo/items', { headers: { Cookie: bob.cookie } });
  assert.deepEqual((await bobItems.json()).items.map((record) => record.id), ['item-bob']);
});

// ── Invitaciones: cada persona crea su propia contraseña con un link de un solo uso ──

const invitedUser = { id: 'actor-c', email: 'carol@dsta.test', displayName: 'Cuenta C', password: 'synthetic-invite-C-2026' };

async function tokenHash(token) {
  return base64url(await crypto.subtle.digest('SHA-256', encoder.encode(token)));
}

async function insertInvitation(token, { actorId = invitedUser.id, email = invitedUser.email, expiresIn = 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO invitations(token_hash, actor_id, email, display_name, initial_item_id, expires_at, created_at)
    VALUES(?,?,?,?,?,?,?)`).run(await tokenHash(token), actorId, email, invitedUser.displayName, `item-${actorId}`, now + expiresIn, now);
}

async function acceptInvite(token, password, headers = {}) {
  return call('/api/auth/accept-invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://pilot.example', ...headers },
    body: { token, password },
  });
}

test('the invitations migration stores only token hashes', () => {
  const columns = sqlite.prepare('PRAGMA table_info(invitations)').all().map((column) => column.name);
  assert.ok(columns.includes('token_hash'));
  assert.ok(!columns.includes('token') && !columns.some((name) => name.includes('password')));
});

test('a valid invitation creates the account with salt+hash only and allows login', async (t) => {
  if (!worker) return t.skip('Worker entrypoint not implemented yet');
  const token = 'invite-token-valid-0123456789abcdef';
  await insertInvitation(token);
  const accepted = await acceptInvite(token, invitedUser.password);
  assert.equal(accepted.status, 201, sqlite.lastError);
  assert.equal(accepted.headers.getSetCookie().length, 0, 'accepting does not open a session by itself');
  const row = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(invitedUser.id);
  assert.equal(row.email, invitedUser.email);
  assert.ok(!Object.values(row).some((value) => String(value).includes(invitedUser.password)), 'no plaintext password in D1');
  assert.equal(await passwordHash(invitedUser.password, row.password_salt), row.password_hash);
  const invite = sqlite.prepare('SELECT used_at FROM invitations WHERE token_hash = ?').get(await tokenHash(token));
  assert.ok(invite.used_at > 0, 'the invitation is consumed');

  const carol = await login(invitedUser);
  assert.equal(carol.payload.actor.id, invitedUser.id);
  const items = await call('/api/demo/items', { headers: { Cookie: carol.cookie } });
  assert.deepEqual((await items.json()).items.map((item) => item.id), [`item-${invitedUser.id}`]);
  const cross = await call('/api/demo/items/item-alice', { headers: { Cookie: carol.cookie } });
  assert.equal(cross.status, 404);
});

test('an invitation is single-use, expires, and unknown tokens are rejected', async (t) => {
  if (!worker) return t.skip('Worker entrypoint not implemented yet');
  const token = 'invite-token-once-0123456789abcdef';
  await insertInvitation(token);
  assert.equal((await acceptInvite(token, invitedUser.password)).status, 201);
  const reused = await acceptInvite(token, 'another-password-attempt-1');
  assert.equal(reused.status, 400);
  const row = sqlite.prepare('SELECT password_salt, password_hash FROM users WHERE id = ?').get(invitedUser.id);
  assert.equal(await passwordHash(invitedUser.password, row.password_salt), row.password_hash, 'reuse cannot change the password');

  await insertInvitation('invite-token-expired-0123456789ab', { actorId: 'actor-d', email: 'dave@dsta.test', expiresIn: -5 });
  assert.equal((await acceptInvite('invite-token-expired-0123456789ab', 'expired-invite-password')).status, 400);
  assert.equal((await acceptInvite('invite-token-unknown-0123456789ab', 'unknown-invite-password')).status, 400);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM users WHERE id = 'actor-d'").get().n, 0);
});

test('a weak password or a missing Origin does not consume the invitation', async (t) => {
  if (!worker) return t.skip('Worker entrypoint not implemented yet');
  const token = 'invite-token-weak-0123456789abcdef';
  await insertInvitation(token);
  assert.equal((await acceptInvite(token, 'short')).status, 400);
  const noOrigin = await call('/api/auth/accept-invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { token, password: invitedUser.password },
  });
  assert.equal(noOrigin.status, 403);
  assert.equal((await acceptInvite(token, invitedUser.password, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await acceptInvite(token, invitedUser.password)).status, 201, 'still usable after rejected attempts');
});

test('an invitation cannot overwrite an existing account', async (t) => {
  if (!worker) return t.skip('Worker entrypoint not implemented yet');
  const token = 'invite-token-takeover-0123456789ab';
  await insertInvitation(token, { actorId: users[0].id, email: users[0].email });
  const response = await acceptInvite(token, 'takeover-attempt-password');
  assert.equal(response.status, 409);
  await login(users[0]);
});

test('invitation acceptance shares the per-IP attempt limit', async (t) => {
  if (!worker) return t.skip('Worker entrypoint not implemented yet');
  const ip = '198.51.100.77';
  const ipHash = base64url(await crypto.subtle.digest('SHA-256', encoder.encode(`login:${ip}`)));
  sqlite.prepare('INSERT INTO login_limits(ip_hash, minute_bucket, attempts) VALUES(?,?,?)').run(ipHash, Math.floor(Date.now() / 60000), 10);
  const token = 'invite-token-limited-0123456789ab';
  await insertInvitation(token);
  assert.equal((await acceptInvite(token, invitedUser.password, { 'CF-Connecting-IP': ip })).status, 429);
});

test('PBKDF2 iterations stay within the Cloudflare Workers limit (100000)', () => {
  // workerd rechaza deriveBits con más de 100000 iteraciones; wrangler dev local no lo aplica.
  const source = readFileSync(modulePath, 'utf8');
  const iterations = Number(source.match(/PBKDF2_ITERATIONS = (\d+)/)?.[1]);
  assert.ok(iterations >= 100000 && iterations <= 100000, `PBKDF2_ITERATIONS=${iterations}`);
  const seeder = readFileSync(new URL('../tools/seed_demo_accounts.py', import.meta.url), 'utf8');
  assert.equal(Number(seeder.match(/ITERATIONS = ([\d_]+)/)[1].replaceAll('_', '')), iterations, 'seeder and Worker agree');
});
