import { DurableObject } from "cloudflare:workers";

const SNAPSHOT_KEY = "vikunja-dashboard-v1";
const SUMMARY_KEY = "dsta-ai-summaries-v1";
// Snapshot, summaries and the summary queue live in the Durable Object. Workers KV (free
// plan: 1,000 writes/day) ran out every afternoon and silently froze the dashboard; KV is
// now only read once to migrate the summaries and as a fallback for the last snapshot.
const SUMMARY_RETRY_MS = 3_600_000;
const JOB_PREFIX = "dsta-ai-job-v1:";
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

// "pmo-dsta" is the single-user (legacy/production) box; in accounts mode each user has its own.
const LEGACY_BOX = "pmo-dsta";
function chatStub(env, box = LEGACY_BOX) {
  return env.CHAT_STATE.getByName(box);
}

function accountsMode(env) {
  return env.AUTH_MODE === "accounts";
}

function configured(env) {
  if (accountsMode(env)) return Boolean(env.DB && env.DSTA_BRIDGE_TOKEN);
  return Boolean(env.DASHBOARD_USER && env.DASHBOARD_PASSWORD && env.INGEST_TOKEN);
}

function safeEqual(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function basicAuthorized(request, env) {
  const expected = `Basic ${btoa(`${env.DASHBOARD_USER}:${env.DASHBOARD_PASSWORD}`)}`;
  return safeEqual(request.headers.get("authorization") || "", expected);
}

function bearerAuthorized(request, secret) {
  return Boolean(secret) && safeEqual(request.headers.get("authorization") || "", `Bearer ${secret}`);
}

function ingestAuthorized(request, env) {
  return bearerAuthorized(request, env.INGEST_TOKEN);
}

function requestAuthentication() {
  return new Response("Autenticación requerida", {
    status: 401,
    headers: {
      "www-authenticate": 'Basic realm="PMO-DSTA", charset="UTF-8"',
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

async function readJson(request, maxBytes = 1_000_000) {
  const tooLarge = () => ({ error: json({ error: "Solicitud demasiado grande" }, 413) });
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) return tooLarge();
  const reader = request.body?.getReader();
  if (!reader) return { error: json({ error: "JSON inválido" }, 400) };
  try {
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return tooLarge();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { error: json({ error: "JSON inválido" }, 400) };
  } finally {
    reader.releaseLock();
  }
}

async function hash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

const cataMention = /\b(?:Cata|Catalina)\b/i;
function isCataTask(task) {
  return [task.title, task.owner, task.dependency, task.criterion, task.description]
    .some(value => cataMention.test(String(value || "")));
}

function validSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.tasks) ||
      typeof snapshot.timestamp !== "string" || !Number.isFinite(Date.parse(snapshot.timestamp))) return false;
  if (snapshot.observationStartedAt !== undefined &&
      (typeof snapshot.observationStartedAt !== "string" ||
       !Number.isFinite(Date.parse(snapshot.observationStartedAt)) ||
       Date.parse(snapshot.observationStartedAt) > Date.parse(snapshot.timestamp))) return false;
  const validRecord = item => item && typeof item === "object" && !Array.isArray(item) &&
    Number.isSafeInteger(item.id) && item.id > 0 && typeof item.title === "string";
  if (snapshot.projects.some(item => !validRecord(item)) || snapshot.tasks.some(item => !validRecord(item))) return false;
  if (snapshot.labels !== undefined) {
    if (!Array.isArray(snapshot.labels) || snapshot.labels.some(l => !validRecord(l) ||
        typeof l.hex_color !== "string" || !/^[0-9a-f]{6}$/i.test(l.hex_color)) ||
        new Set(snapshot.labels.map(l => l.id)).size !== snapshot.labels.length) return false;
    const labelIds = new Set(snapshot.labels.map(l => l.id));
    if (snapshot.tasks.some(t => !Array.isArray(t.label_ids) ||
        new Set(t.label_ids).size !== t.label_ids.length || t.label_ids.some(id => !labelIds.has(id)))) return false;
  } else if (snapshot.tasks.some(t => t.label_ids !== undefined)) return false;
  const projectIds = new Set(snapshot.projects.map(item => item.id));
  if (projectIds.size !== snapshot.projects.length || new Set(snapshot.tasks.map(item => item.id)).size !== snapshot.tasks.length) return false;
  return snapshot.tasks.every(task =>
    (task.project_id === undefined || projectIds.has(task.project_id)) &&
    (task.done === undefined || typeof task.done === "boolean") &&
    ["project", "owner", "date", "dependency", "criterion", "source", "action_key", "description"]
      .every(key => task[key] === undefined || typeof task[key] === "string"));
}

async function receiveSnapshot(request, env, fromBridge = false, box = LEGACY_BOX) {
  if (!(fromBridge ? bridgeAuthorized(request, env) : ingestAuthorized(request, env))) {
    return json({ error: "No autorizado" }, 401);
  }
  const parsed = await readJson(request, 2_000_000);
  if (parsed.error) return parsed.error;
  const snapshot = parsed.body;
  if (!validSnapshot(snapshot)) {
    return json({ error: "Estructura de snapshot inválida" }, 400);
  }

  const normalized = {
    timestamp: snapshot.timestamp,
    ...(snapshot.observationStartedAt ? { observationStartedAt: snapshot.observationStartedAt } : {}),
    ...(snapshot.labels !== undefined ? {labels: snapshot.labels} : {}),
    projects: snapshot.projects,
    tasks: snapshot.tasks,
    stale: false,
  };
  if ((snapshot.actionConfirmation !== undefined || snapshot.labelConfirmation !== undefined) && !fromBridge) {
    return json({ error: "La confirmación requiere el canal del puente." }, 400);
  }
  if (!await chatStub(env, box).saveSnapshot(normalized, snapshot.actionConfirmation ?? null, snapshot.labelConfirmation ?? null)) {
    return json({ error: "Snapshot anterior a la observación vigente; no se reemplazaron los datos." }, 409);
  }
  return json({ ok: true, projects: normalized.projects.length, tasks: normalized.tasks.length }, 202);
}

async function serveSnapshot(env, box = LEGACY_BOX) {
  const dashboard = await chatStub(env, box).dashboard();
  if (!dashboard) {
    return json({
      error: "El dashboard aún no ha recibido su primer snapshot desde Vikunja.",
      stale: true,
    }, 503);
  }
  return json(dashboard);
}

function publicTask(task) {
  return {
    id: task.id,
    title: task.title,
    done: task.done,
    project: task.project,
    owner: task.owner,
    date: task.date,
    dependency: task.dependency,
    description: String(task.description || "").slice(0, 6000),
  };
}

async function createAssistantJob(request, env, box = LEGACY_BOX) {
  if (!env.DSTA_BRIDGE_TOKEN) return json({ error: "El puente de Hermes aún no está configurado." }, 503);
  const parsed = await readJson(request, 24_000);
  if (parsed.error) return parsed.error;
  const { message, history = [], taskId = null } = parsed.body || {};
  if (typeof message !== "string" || !message.trim() || message.length > 4_000 || !Array.isArray(history)) {
    return json({ error: "La consulta debe ser texto y no superar 4.000 caracteres." }, 400);
  }
  if (history.length > 20 || history.some(item => !item || !["user", "assistant"].includes(item.role) ||
      typeof item.content !== "string" || item.content.length > 4_000)) {
    return json({ error: "Historial de conversación inválido." }, 400);
  }
  const snapshot = taskId === null ? null : await chatStub(env, box).snapshot();
  const task = taskId === null ? null : snapshot?.tasks?.find(item => String(item.id) === String(taskId));
  if (taskId !== null && !task) return json({ error: "La tarea seleccionada ya no está en el snapshot actual." }, 404);
  const job = {
    id: crypto.randomUUID(),
    kind: "chat",
    status: "queued",
    createdAt: new Date().toISOString(),
    message: message.trim(),
    history: history.slice(-20),
    task: task ? publicTask(task) : null,
  };
  return chatStub(env, box).fetch(new Request("https://chat.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(job),
  }));
}

const ACTION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_COLORS = new Set(['86e2bb','8bbcff','c6a0f6','f5a9cf','ffa194','f6c85f','c4df83','7bd9df','b7baff','bac7d5']);
const labelName = value => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
const protectedLabel = label => labelName(label.title) === 'carrera tecnologica';
function validLabelAction(body) {
  if (!body || Array.isArray(body) || !ACTION_UUID.test(body.requestId || '')) return false;
  const fields = {
    create: ['title','color','taskId'], update: ['labelId','title','color'],
    delete: ['labelId'], assign: ['taskId','labelId'], unassign: ['taskId','labelId'], reset: [],
  }[body.action];
  if (!fields || Object.keys(body).some(key => !['action','requestId',...fields].includes(key))) return false;
  if (fields.includes('labelId') && (!Number.isSafeInteger(body.labelId) || body.labelId <= 0)) return false;
  if ((['assign','unassign'].includes(body.action) || body.taskId !== undefined) &&
      (!Number.isSafeInteger(body.taskId) || body.taskId <= 0)) return false;
  return !fields.includes('title') || (typeof body.title === 'string' && body.title.trim().length > 0 &&
    body.title.trim().length <= 100 && LABEL_COLORS.has(body.color));
}
async function labelActionRoute(request, url, env, box = LEGACY_BOX) {
  if (!env.DSTA_BRIDGE_TOKEN) return json({error:'Puente no configurado'},503);
  if (request.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    if (!ACTION_UUID.test(id)) return json({error:'Identificador inválido'},400);
    return chatStub(env, box).fetch(`https://chat.internal/labels/status?id=${id}`);
  }
  if (request.method !== 'POST') return json({error:'Método no permitido'},405);
  const parsed = await readJson(request,4096);
  if (parsed.error) return parsed.error;
  if (!validLabelAction(parsed.body)) return json({error:'Acción de etiquetas inválida'},400);
  return forwardToChatObject(env,'/labels/create',parsed.body,box);
}
function labelResultMatches(job, snapshot, result) {
  if (!Array.isArray(snapshot?.labels) || !result || typeof result !== 'object') return false;
  const label = snapshot.labels.find(l => l.id === result.labelId);
  const task = snapshot.tasks.find(t => t.id === job.taskId && t.project_id === job.projectId);
  if (job.taskId && !task) return false;
  switch (job.action) {
    case 'create': return Boolean(label && label.title === job.title.trim() && label.hex_color === job.color &&
      (!job.taskId || task.label_ids?.includes(label.id)));
    case 'update': return Boolean(label && label.id === job.labelId && label.title === job.title.trim() && label.hex_color === job.color);
    case 'assign': return Boolean(label && label.id === job.labelId && task.label_ids?.includes(job.labelId));
    case 'unassign': return result.labelId === job.labelId && Array.isArray(task?.label_ids) && !task.label_ids.includes(job.labelId);
    case 'delete': return !snapshot.labels.some(l => l.id === job.labelId);
    case 'reset': return Boolean(snapshot.labels.some(l => l.id === job.preservedId && protectedLabel(l)) &&
      job.targets.every(target => !snapshot.labels.some(l => l.id === target.id)));
    default: return false;
  }
}

async function taskActionRoute(request, url, env, box = LEGACY_BOX) {
  if (!env.DSTA_BRIDGE_TOKEN) return json({ error: "Puente no configurado" }, 503);
  if (request.method === "GET") {
    const id = url.searchParams.get("id") || "";
    if (!ACTION_UUID.test(id)) return json({ error: "Identificador inválido." }, 400);
    return chatStub(env, box).fetch(`https://chat.internal/actions/status?id=${id}`);
  }
  if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const parsed = await readJson(request, 1024);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  if (!body || Array.isArray(body) || Object.keys(body).sort().join(",") !== "action,requestId,taskId" ||
      body.action !== "complete" || !Number.isSafeInteger(body.taskId) || body.taskId <= 0 ||
      typeof body.requestId !== "string" || !ACTION_UUID.test(body.requestId)) {
    return json({ error: "Acción estructurada inválida." }, 400);
  }
  return forwardToChatObject(env, "/actions/create", body, box);
}

async function readAssistantJob(url, env, box = LEGACY_BOX) {
  const id = url.searchParams.get("id") || "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Identificador inválido." }, 400);
  const response = await chatStub(env, box).fetch(`https://chat.internal/status?id=${encodeURIComponent(id)}`);
  if (response.status !== 404 || accountsMode(env)) return response;
  // Old KV replies remain readable during the one-day cutover window (single-user mode only).
  const oldJob = await env.DASHBOARD_DATA.get(JOB_PREFIX + id, "json");
  if (!oldJob || oldJob.kind !== "chat") return response;
  return json({ id: oldJob.id, status: oldJob.status, reply: oldJob.reply || "", error: oldJob.error || "" });
}

function bridgeAuthorized(request, env) {
  return bearerAuthorized(request, env.DSTA_BRIDGE_TOKEN);
}

async function takeBridgeJob(request, env, box = LEGACY_BOX) {
  if (!env.DSTA_BRIDGE_TOKEN) return json({ error: "Puente no configurado" }, 503);
  if (!bridgeAuthorized(request, env)) return json({ error: "No autorizado" }, 401);
  const requestedKind = new URL(request.url).searchParams.get("kind");
  if (requestedKind === "health") return json({ request: await chatStub(env, box).pendingHealthCheck() });
  if (requestedKind === "label") return chatStub(env, box).fetch("https://chat.internal/labels/next");
  if (requestedKind === "action") return chatStub(env, box).fetch("https://chat.internal/actions/next");
  const kind = requestedKind === "summary" ? "summary" : "chat";
  if (kind === "chat") return chatStub(env, box).fetch("https://chat.internal/next" + (new URL(request.url).searchParams.get("chatBusy") === "1" ? "?chatBusy=1" : ""));
  return json({ job: await chatStub(env, box).takeSummaryJob() });
}

async function completeBridgeJob(request, env, box = LEGACY_BOX) {
  if (!env.DSTA_BRIDGE_TOKEN) return json({ error: "Puente no configurado" }, 503);
  if (!bridgeAuthorized(request, env)) return json({ error: "No autorizado" }, 401);
  const parsed = await readJson(request, 400_000);
  if (parsed.error) return parsed.error;
  if (parsed.body?.kind === "label") return forwardToChatObject(env, "/labels/complete", parsed.body, box);
  if (parsed.body?.kind === "action") return forwardToChatObject(env, "/actions/complete", parsed.body, box);
  const { id, reply, error, summaries, refreshError, snapshotTimestamp, minutes } = parsed.body || {};
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Identificador inválido." }, 400);
  const chatResponse = await chatStub(env, box).fetch(new Request("https://chat.internal/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, reply, error, refreshError, snapshotTimestamp, minutes: citedMinutes(minutes) }),
  }));
  if (chatResponse.status !== 404) return chatResponse;
  const done = await chatStub(env, box).completeSummaryJob(id, Boolean(error), summaries);
  if (!done) return json({ error: "Trabajo no encontrado o no está activo." }, 404);
  return json({ ok: true });
}

// Minutes the copilot cited as [título](minuta:<id>), so the browser can open them in place.
function citedMinutes(minutes) {
  if (!minutes || typeof minutes !== "object") return {};
  const clean = {};
  for (const [id, minute] of Object.entries(minutes).slice(0, 5)) {
    if (id.length > 200 || typeof minute?.contenido !== "string") continue;
    clean[id] = {
      titulo: String(minute.titulo || "").slice(0, 200),
      fecha: String(minute.fecha || "").slice(0, 10),
      contenido: minute.contenido.slice(0, 60_000),
    };
  }
  return clean;
}

// Status lights: availability of Vikunja and Granola as measured by the bridge on the VM.
async function receiveHealth(request, env, box = LEGACY_BOX) {
  if (!env.DSTA_BRIDGE_TOKEN) return json({ error: "Puente no configurado" }, 503);
  if (!bridgeAuthorized(request, env)) return json({ error: "No autorizado" }, 401);
  const parsed = await readJson(request, 10_000);
  if (parsed.error) return parsed.error;
  const health = {};
  for (const name of ["vikunja", "granola"]) {
    const item = parsed.body?.[name];
    if (!item || typeof item.ok !== "boolean") continue;
    health[name] = { ok: item.ok, detail: String(item.detail || "").slice(0, 120),
      checkedAt: String(item.checkedAt || "").slice(0, 40),
      requestId: String(item.requestId || "").slice(0, 36) };
  }
  await chatStub(env, box).saveHealth(health);
  return json({ ok: true });
}

// Granola minutes inbox: the VM owns each record; the Durable Object mirrors it for the
// browser and queues the user's decisions until the bridge applies them.
const MINUTE_ID = /^[\w-]{1,80}$/;
const MINUTE_ACTION_ID = /^a\d{1,3}$/;
const MINUTE_EDIT_KEYS = new Set(["task_id", "project_id", "titulo", "nota", "responsable", "fecha_objetivo",
  "dependencia", "criterio_cierre"]);

function validDecision(body) {
  const { minuteId, decisions } = body || {};
  if (typeof minuteId !== "string" || !MINUTE_ID.test(minuteId)) return null;
  if (body.decision === "descartar") {
    if (decisions !== undefined || typeof body.digest !== "string" || !body.digest || body.digest.length > 100) return null;
    return { minuteId, decision: "descartar", digest: body.digest };
  }
  if (body.decision !== undefined) return null;
  if (!Array.isArray(decisions) || !decisions.length || decisions.length > 25) return null;
  const clean = [];
  for (const item of decisions) {
    if (!item || !MINUTE_ACTION_ID.test(String(item.actionId || ""))) return null;
    if (!["aprobar", "rechazar", "instruccion"].includes(item.decision)) return null;
    const instruccion = typeof item.instruccion === "string" ? item.instruccion.trim() : "";
    if (item.decision === "instruccion" && (!instruccion || instruccion.length > 1500)) return null;
    const edits = {};
    for (const [key, value] of Object.entries(item.edits || {})) {
      if (!MINUTE_EDIT_KEYS.has(key) || !["string", "number"].includes(typeof value)) return null;
      if (String(value).length > 1500) return null;
      edits[key] = value;
    }
    clean.push({ actionId: item.actionId, decision: item.decision, edits, ...(instruccion ? { instruccion } : {}) });
  }
  return { minuteId, decisions: clean };
}

function forwardToChatObject(env, path, body, box = LEGACY_BOX) {
  return chatStub(env, box).fetch(new Request(`https://chat.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function bridgeMinuteRoute(request, env, path, box = LEGACY_BOX) {
  if (!env.DSTA_BRIDGE_TOKEN) return json({ error: "Puente no configurado" }, 503);
  if (!bridgeAuthorized(request, env)) return json({ error: "No autorizado" }, 401);
  const parsed = await readJson(request, 400_000);
  if (parsed.error) return parsed.error;
  return forwardToChatObject(env, path, parsed.body, box);
}

async function browserMinuteRoute(request, env, path, box = LEGACY_BOX) {
  const parsed = await readJson(request, 60_000);
  if (parsed.error) return parsed.error;
  if (path === "/minutes/decide") {
    const decision = validDecision(parsed.body);
    if (!decision) return json({ error: "Decisión inválida." }, 400);
    return forwardToChatObject(env, path, decision, box);
  }
  const id = String(parsed.body?.id || "");
  if (!MINUTE_ID.test(id)) return json({ error: "Identificador inválido." }, 400);
  return forwardToChatObject(env, path, { id }, box);
}

// ── Accounts mode (AUTH_MODE=accounts) ─────────────────────────────────────────────────
// Per-user accounts in D1 (pattern proven in the cloudflare-pilot): PBKDF2 at 100000
// iterations (Workers maximum), revocable sessions stored as SHA-256, HttpOnly cookie,
// per-IP login limit, single-use invitations. Browser writes require a same-origin Origin.
const SESSION_COOKIE = "__Host-dsta_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const PBKDF2_ITERATIONS = 100000;
const MIN_PASSWORD_LENGTH = 14;
const MAX_LOGIN_ATTEMPTS_PER_MINUTE = 10;
const INVALID_SALT = "aW52YWxpZC1lbWFpbC1zYWx0LWRzdGE";
const INVALID_HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ACTOR_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PUBLIC_ACCOUNT_PATHS = new Set(["/login", "/login.html", "/login.js", "/invite", "/invite.html", "/invite.js", "/auth.css"]);

const toBase64Url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
function fromBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)), c => c.charCodeAt(0));
}
async function sha256Url(value) {
  return toBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
async function derivePasswordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return toBase64Url(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromBase64Url(salt), iterations: PBKDF2_ITERATIONS }, key, 256));
}
function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return "";
}
function sessionCookie(token, maxAge = SESSION_TTL_SECONDS) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}
const boxOf = user => user.do_name || `u:${user.id}`;

async function currentSession(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || token.length > 128) return null;
  const tokenHash = await sha256Url(token);
  const row = await env.DB.prepare(`
    SELECT s.token_hash, u.id, u.email, u.display_name, u.do_name
    FROM sessions s JOIN users u ON u.id = s.actor_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL
  `).bind(tokenHash, Math.floor(Date.now() / 1000)).first();
  if (!row) return null;
  return { tokenHash, box: boxOf(row), actor: { id: row.id, email: row.email, displayName: row.display_name } };
}

async function takeLoginAttempt(request, env) {
  const ipHash = await sha256Url(`login:${request.headers.get("cf-connecting-ip") || "unknown"}`);
  const minute = Math.floor(Date.now() / 60000);
  await env.DB.prepare("DELETE FROM login_limits WHERE minute_bucket < ?").bind(minute - 60).run();
  await env.DB.prepare(`
    INSERT INTO login_limits(ip_hash, minute_bucket, attempts) VALUES(?,?,1)
    ON CONFLICT(ip_hash) DO UPDATE SET minute_bucket = excluded.minute_bucket,
      attempts = CASE WHEN login_limits.minute_bucket = excluded.minute_bucket THEN login_limits.attempts + 1 ELSE 1 END
  `).bind(ipHash, minute).run();
  const row = await env.DB.prepare("SELECT attempts FROM login_limits WHERE ip_hash = ? AND minute_bucket = ?").bind(ipHash, minute).first();
  return Number(row?.attempts || 0) <= MAX_LOGIN_ATTEMPTS_PER_MINUTE;
}

async function accountsLogin(request, env) {
  if (!(await takeLoginAttempt(request, env))) return json({ error: "Demasiados intentos; vuelve a probar en un minuto." }, 429);
  const parsed = await readJson(request, 4096);
  if (parsed.error) return parsed.error;
  const email = typeof parsed.body?.email === "string" ? parsed.body.email.trim().toLowerCase() : "";
  const password = typeof parsed.body?.password === "string" ? parsed.body.password : "";
  if (!email || email.length > 254 || !password || password.length > 256) return json({ error: "Credenciales inválidas." }, 401);
  const user = await env.DB.prepare(`SELECT id, email, display_name, password_salt, password_hash, disabled_at
    FROM users WHERE lower(email) = ? LIMIT 1`).bind(email).first();
  // Same PBKDF2 cost for unknown emails: response time does not reveal which accounts exist.
  const calculated = await derivePasswordHash(password, user?.password_salt || INVALID_SALT);
  if (!user || user.disabled_at || !safeEqual(calculated, user.password_hash || INVALID_HASH)) {
    return json({ error: "Credenciales inválidas." }, 401);
  }
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT INTO sessions(token_hash, actor_id, expires_at) VALUES(?,?,?)")
    .bind(await sha256Url(token), user.id, Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS).run();
  const response = json({ actor: { id: user.id, email: user.email, displayName: user.display_name } });
  response.headers.append("set-cookie", sessionCookie(token));
  return response;
}

async function accountsAcceptInvite(request, env) {
  if (!(await takeLoginAttempt(request, env))) return json({ error: "Demasiados intentos; vuelve a probar en un minuto." }, 429);
  const parsed = await readJson(request, 4096);
  if (parsed.error) return parsed.error;
  const token = typeof parsed.body?.token === "string" ? parsed.body.token : "";
  const password = typeof parsed.body?.password === "string" ? parsed.body.password : "";
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 256) {
    return json({ error: `La contraseña debe tener entre ${MIN_PASSWORD_LENGTH} y 256 caracteres.` }, 400);
  }
  const invalid = json({ error: "Invitación inválida, vencida o ya usada." }, 400);
  if (!token || token.length > 128) return invalid;
  // Hash first: a failure here must not consume the invitation.
  const salt = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const passwordHash = await derivePasswordHash(password, salt);
  const tokenHash = await sha256Url(token);
  const now = Math.floor(Date.now() / 1000);
  const claimed = await env.DB.prepare(
    "UPDATE invitations SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
  ).bind(now, tokenHash, now).run();
  if (Number(claimed?.meta?.changes || 0) !== 1) return invalid;
  const invite = await env.DB.prepare("SELECT actor_id, email, display_name FROM invitations WHERE token_hash = ?").bind(tokenHash).first();
  if (!ACTOR_ID.test(invite.actor_id)) return invalid;
  try {
    await env.DB.prepare("INSERT INTO users(id,email,display_name,password_salt,password_hash) VALUES(?,?,?,?,?)")
      .bind(invite.actor_id, invite.email, invite.display_name, salt, passwordHash).run();
  } catch {
    return json({ error: "La cuenta de esta invitación ya existe." }, 409);
  }
  return json({ created: true, email: invite.email }, 201);
}

async function accountsLogout(env, session) {
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(session.tokenHash).run();
  const response = new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  response.headers.append("set-cookie", sessionCookie("", 0));
  return response;
}

// The bridge is trusted for every user, but must say which one it acts for; the box comes
// from D1, never from a name the caller builds.
async function bridgeBox(request, env, bridgePath, pathActor = null) {
  const authorized = bridgePath === "/api/ingest" ? ingestAuthorized(request, env) : bridgeAuthorized(request, env);
  if (!authorized) return { error: json({ error: "No autorizado" }, 401) };
  const headerActor = request.headers.get("x-dsta-actor");
  if (pathActor && headerActor && headerActor !== pathActor) return { error: json({ error: "Usuario contradictorio." }, 400) };
  const actorId = pathActor || headerActor || "";
  if (!ACTOR_ID.test(actorId)) return { error: json({ error: "Falta el usuario (X-DSTA-Actor)." }, 400) };
  const user = await env.DB.prepare("SELECT id, do_name FROM users WHERE id = ? AND disabled_at IS NULL").bind(actorId).first();
  if (!user) return { error: json({ error: "Usuario no encontrado." }, 404) };
  return { box: boxOf(user) };
}

// F1 dispatcher: a single box remembers which users have pending work, so the bridge makes
// one poll for N users and only then polls the queues of those users.
const DISPATCH_BOX = "dispatch";
const DISPATCH_KINDS = new Set(["chat", "action", "label", "health"]);
async function markPending(env, actorId, kind) {
  await chatStub(env, DISPATCH_BOX).fetch(new Request("https://chat.internal/dispatch/mark", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor: actorId, kind }),
  }));
}
async function dispatchRoute(request, env) {
  if (!bridgeAuthorized(request, env)) return json({ error: "No autorizado" }, 401);
  if (request.method === "GET") return chatStub(env, DISPATCH_BOX).fetch("https://chat.internal/dispatch/list");
  if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const parsed = await readJson(request, 4096);
  if (parsed.error) return parsed.error;
  const { actor, kinds, seenAt } = parsed.body || {};
  if (!ACTOR_ID.test(String(actor || "")) || !Array.isArray(kinds) || !kinds.length ||
      kinds.some(kind => !DISPATCH_KINDS.has(kind)) || !Number.isFinite(seenAt)) {
    return json({ error: "Confirmación de despacho inválida." }, 400);
  }
  return chatStub(env, DISPATCH_BOX).fetch(new Request("https://chat.internal/dispatch/ack", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor, kinds, seenAt }),
  }));
}

// Chat needs immediate, strongly consistent hand-off between the browser and VM.
// Snapshot and Cata summaries remain in Workers KV, where eventual consistency is acceptable.
export class DashboardChatQueue extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const storage = this.ctx.storage.kv;

    if (url.pathname.startsWith("/dispatch/")) return this.dispatchRequest(request, url);

    if (url.pathname.startsWith("/labels/")) return this.labelRequest(request, url);

    if (url.pathname.startsWith("/actions/")) return this.actionRequest(request, url);

    if (url.pathname === "/create" && request.method === "POST") {
      const job = await request.json();
      if (job?.kind !== "chat" || !/^[0-9a-f-]{36}$/i.test(job.id || "")) {
        return json({ error: "Consulta inválida." }, 400);
      }
      const currentId = storage.get("current");
      const active = currentId ? storage.get(`job:${currentId}`) : null;
      const age = Date.now() - Date.parse(active?.startedAt || active?.createdAt || "");
      if (active && ["queued", "running"].includes(active.status) && age < 600_000) {
        if (active.message === job.message && String(active.task?.id ?? "") === String(job.task?.id ?? "")) {
          return json({ id: active.id, status: active.status }, 202);
        }
        return json({ error: "Hermes ya está atendiendo una consulta. Espera un momento y vuelve a intentar." }, 429);
      }
      if (active && ["queued", "running"].includes(active.status)) {
        active.status = "error";
        active.error = "La consulta anterior expiró. Vuelve a intentarlo.";
        active.completedAt = new Date().toISOString();
        storage.put(`job:${active.id}`, active);
      }
      for (const [key, oldJob] of storage.list({ prefix: "job:" })) {
        if (Date.now() - Date.parse(oldJob.completedAt || oldJob.createdAt || "") > 86_400_000) {
          storage.delete(key);
        }
      }
      storage.put(`job:${job.id}`, job);
      storage.put("current", job.id);
      return json({ id: job.id, status: "queued" }, 202);
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const id = url.searchParams.get("id") || "";
      const job = storage.get(`job:${id}`);
      if (!job || job.kind !== "chat") return json({ error: "Consulta no encontrada." }, 404);
      return json({ id: job.id, status: job.status, reply: job.reply || "", error: job.error || "",
        refreshError: job.refreshError || "", snapshotTimestamp: job.snapshotTimestamp || "",
        minutes: job.minutes || {} });
    }

    if (url.pathname === "/next" && request.method === "GET") {
      // The bridge already polls for chat; pending minute decisions ride on the same request.
      const decision = this.takeDecision();
      const currentId = storage.get("current");
      const job = currentId ? storage.get(`job:${currentId}`) : null;
      if (url.searchParams.get("chatBusy") === "1" || !job || job.status !== "queued") return json({ job: null, decision });
      job.status = "running";
      job.startedAt = new Date().toISOString();
      storage.put(`job:${job.id}`, job);
      return json({ job, decision });
    }

    if (url.pathname === "/minutes/upsert" && request.method === "POST") {
      const record = await request.json();
      if (!record || !MINUTE_ID.test(String(record.id || "")) || !Array.isArray(record.acciones)) {
        return json({ error: "Minuta inválida." }, 400);
      }
      const previous = storage.get(`minute:${record.id}`);
      // A source dismissed by the user stays out even when its content changes.
      if (previous?.descartadaEn) {
        record.descartadaEn = previous.descartadaEn;
        record.estado = "descartada";
        record.vista = true;
      }
      record.vista = Boolean(record.vista) || Boolean(previous && previous.digest === record.digest && previous.vista);
      record.aplicando = [...storage.list({ prefix: "decision:" })]
        .some(([, decision]) => decision.minuteId === record.id);
      storage.put(`minute:${record.id}`, record);
      const minutes = [...storage.list({ prefix: "minute:" })]
        .sort(([, a], [, b]) => String(b.detectadaEn).localeCompare(String(a.detectadaEn)));
      for (const [key] of minutes.slice(60)) storage.delete(key);
      return json({ ok: true });
    }

    if (url.pathname === "/minutes/list" && request.method === "GET") {
      const minutes = [...storage.list({ prefix: "minute:" })].map(([, record]) => record)
        .sort((a, b) => String(b.detectadaEn).localeCompare(String(a.detectadaEn))).slice(0, 30);
      return json({ minutes });
    }

    if (url.pathname === "/minutes/seen" && request.method === "POST") {
      const { id } = await request.json();
      const record = storage.get(`minute:${id}`);
      if (!record) return json({ error: "Minuta no encontrada." }, 404);
      record.vista = true;
      storage.put(`minute:${id}`, record);
      return json({ ok: true });
    }

    if (url.pathname === "/minutes/decide" && request.method === "POST") {
      const decision = await request.json();
      const record = storage.get(`minute:${decision.minuteId}`);
      if (!record) return json({ error: "Minuta no encontrada." }, 404);
      if (record.aplicando) return json({ error: "Ya se están aplicando decisiones de esta minuta." }, 409);
      if (record.descartadaEn) return json({ error: "Esta minuta ya fue descartada." }, 409);
      if (decision.decision === "descartar" && decision.digest !== record.digest) {
        return json({ error: "La minuta cambió. Actualiza la bandeja antes de descartarla." }, 409);
      }
      const id = crypto.randomUUID();
      storage.put(`decision:${id}`, { ...decision, id, status: "queued", createdAt: new Date().toISOString() });
      record.aplicando = true;
      record.vista = true;
      storage.put(`minute:${record.id}`, record);
      return json({ ok: true, id }, 202);
    }

    if (url.pathname === "/minutes/decision-done" && request.method === "POST") {
      const { id, error } = await request.json();
      const decision = storage.get(`decision:${id}`);
      if (!decision) return json({ error: "Decisión no encontrada." }, 404);
      storage.delete(`decision:${id}`);
      const record = storage.get(`minute:${decision.minuteId}`);
      if (record) {
        record.aplicando = false;
        record.errorDecision = typeof error === "string" ? error.slice(0, 300) : "";
        storage.put(`minute:${record.id}`, record);
      }
      return json({ ok: true });
    }

    if (url.pathname === "/complete" && request.method === "POST") {
      const { id, reply, error, refreshError, snapshotTimestamp, minutes } = await request.json();
      const job = storage.get(`job:${id}`);
      if (!job || job.status !== "running" || storage.get("current") !== id) {
        return json({ error: "Trabajo no encontrado o no está activo." }, 404);
      }
      job.status = error ? "error" : "completed";
      job.error = typeof error === "string" ? error.slice(0, 1000) : "";
      job.reply = typeof reply === "string" ? reply.slice(0, 20_000) : "";
      job.refreshError = typeof refreshError === "string" ? refreshError.slice(0, 300) : "";
      job.snapshotTimestamp = typeof snapshotTimestamp === "string" ? snapshotTimestamp.slice(0, 40) : "";
      job.minutes = minutes && typeof minutes === "object" ? minutes : {};
      job.completedAt = new Date().toISOString();
      storage.put(`job:${id}`, job);
      storage.delete("current");
      return json({ ok: true });
    }

    return json({ error: "Ruta interna no encontrada." }, 404);
  }

  async dispatchRequest(request, url) {
    const storage = this.ctx.storage.kv;
    if (url.pathname === "/dispatch/mark" && request.method === "POST") {
      const { actor, kind } = await request.json();
      const marks = storage.get(`pending:${actor}`) || {};
      marks[kind] = Date.now();
      storage.put(`pending:${actor}`, marks);
      return json({ ok: true });
    }
    if (url.pathname === "/dispatch/list" && request.method === "GET") {
      const pending = Object.fromEntries([...storage.list({ prefix: "pending:" })]
        .map(([key, marks]) => [key.slice("pending:".length), marks]));
      return json({ now: Date.now(), pending });
    }
    if (url.pathname === "/dispatch/ack" && request.method === "POST") {
      const { actor, kinds, seenAt } = await request.json();
      const marks = storage.get(`pending:${actor}`) || {};
      // Only marks not newer than the dispatch read are cleared: work queued meanwhile stays.
      for (const kind of kinds) if (marks[kind] !== undefined && marks[kind] <= seenAt) delete marks[kind];
      if (Object.keys(marks).length) storage.put(`pending:${actor}`, marks);
      else storage.delete(`pending:${actor}`);
      return json({ ok: true });
    }
    return json({ error: "Ruta interna no encontrada." }, 404);
  }

  async labelRequest(request, url) {
    const body = request.method === 'POST' ? await request.json() : null;
    const initial = url.pathname === '/labels/create' ? await this.snapshot() : null;
    const storage = this.ctx.storage.kv, now = Date.now();
    const jobs = () => [...storage.list({prefix:'label-job:'})];
    const view = j => ({id:j.id,status:j.status,error:j.error || '',snapshotTimestamp:j.snapshotTimestamp || '',result:j.result || {}});
    if (url.pathname === '/labels/create' && request.method === 'POST') {
      const old = storage.get(`label-job:${body.requestId}`);
      if (old) return JSON.stringify(old.request) === JSON.stringify(body) ? json(view(old),202) : json({error:'Identificador reutilizado'},409);
      const snapshot = storage.get('data:snapshot') ?? initial;
      if (!Array.isArray(snapshot?.labels)) return json({error:'El publicador todavía no entrega etiquetas. Actualiza los servicios de la VM.'},503);
      const label = snapshot.labels.find(l => l.id === body.labelId);
      if (body.labelId && !label && body.action !== 'unassign') return json({error:'La etiqueta ya no existe'},404);
      if (['create','update'].includes(body.action) && snapshot.labels.some(l => l.id !== body.labelId && labelName(l.title) === labelName(body.title))) {
        return json({error:'Ya existe una etiqueta con ese nombre'},409);
      }
      const task = body.taskId && snapshot.tasks.find(t => t.id === body.taskId);
      if (body.taskId && (!task || !snapshot.projects.some(p => p.id === task.project_id))) return json({error:'Tarea fuera del portafolio'},404);
      const preserved = snapshot.labels.find(protectedLabel);
      if (body.action === 'reset' && !preserved) return json({error:'No se encontró Carrera tecnológica; no se eliminarán etiquetas.'},409);
      for (const [key,j] of jobs()) if (['completed','error'].includes(j.status) && now - Date.parse(j.completedAt) > 604800000) storage.delete(key);
      if (jobs().some(([,j]) => ['queued','running'].includes(j.status))) return json({error:'Ya hay un cambio de etiquetas pendiente. Espera su confirmación.'},409);
      if (jobs().length >= 500) return json({error:'Cola llena'},429);
      const job = {...body, id:body.requestId, request:body, kind:'label',status:'queued',attempts:0,createdAt:new Date(now).toISOString(),
        ...(task ? {projectId:task.project_id} : {}),
        ...(body.action === 'delete' ? {target:label} : {}),
        ...(body.action === 'reset' ? {preservedId:preserved.id,targets:snapshot.labels.filter(l => !protectedLabel(l))} : {})};
      storage.put(`label-job:${job.id}`,job);
      return json(view(job),202);
    }
    if (url.pathname === '/labels/status' && request.method === 'GET') {
      const job = storage.get(`label-job:${url.searchParams.get('id')}`);
      return job ? json(view(job)) : json({error:'Solicitud no encontrada'},404);
    }
    if (url.pathname === '/labels/next' && request.method === 'GET') {
      const active = jobs().find(([,j]) => j.status === 'running');
      if (active && active[1].leaseUntil > now) return json({job:null});
      if (active) {
        const j = active[1]; j.status = j.attempts >= 5 ? 'error' : 'queued';
        if (j.status === 'error') {j.error='Cambio sin confirmación. Revisa las etiquetas.';j.completedAt=new Date(now).toISOString();}
        storage.put(active[0],j);
      }
      const job = jobs().map(([,j]) => j).find(j => j.status === 'queued' && (!j.nextAt || j.nextAt <= now));
      if (!job) return json({job:null});
      Object.assign(job,{status:'running',attempt:crypto.randomUUID(),attempts:job.attempts+1,leaseUntil:now+180000});
      storage.put(`label-job:${job.id}`,job);
      return json({job});
    }
    if (url.pathname === '/labels/complete' && request.method === 'POST') {
      const job = storage.get(`label-job:${body.id}`);
      if (!job || job.status !== 'running' || job.attempt !== body.attempt || job.leaseUntil <= now) return json({error:'Intento no activo'},409);
      const proof = job.confirmation;
      const verified = proof?.attempt === body.attempt && proof.timestamp === body.snapshotTimestamp &&
        labelResultMatches(job,storage.get('data:snapshot'),proof.result);
      job.status = body.error ? 'error' : verified ? 'completed' : job.attempts >= 5 ? 'error' : 'queued';
      job.error = body.error ? 'No se pudo aplicar el cambio de etiquetas; revisa Vikunja antes de reintentar.' : job.status === 'error' ? 'No se pudo confirmar el cambio actualizado.' : '';
      if (verified) {job.snapshotTimestamp=proof.timestamp;job.result=proof.result;}
      if (job.status === 'queued') job.nextAt=now+30000;
      else job.completedAt=new Date(now).toISOString();
      storage.put(`label-job:${job.id}`,job);
      return json({ok:true,status:job.status});
    }
    return json({error:'Ruta no encontrada'},404);
  }

  async actionRequest(request, url) {
    // Synchronous KV read-modify-write after body/snapshot awaits: no interleaving.
    const body = request.method === "POST" ? await request.json() : null;
    const createSnapshot = url.pathname === "/actions/create" ? await this.snapshot() : null;
    const storage = this.ctx.storage.kv;
    const now = Date.now();
    const jobs = () => [...storage.list({ prefix: "action:" })];
    const view = job => ({ id: job.id, kind: "action", taskId: job.taskId, status: job.status,
      error: job.error || "", refreshError: job.refreshError || "", snapshotTimestamp: job.snapshotTimestamp || "" });
    if (url.pathname === "/actions/create" && request.method === "POST") {
      const old = storage.get(`action:${body.requestId}`);
      if (old) return old.taskId === body.taskId && old.action === body.action
        ? json(view(old), 202) : json({ error: "Identificador reutilizado para otra acción." }, 409);
      const snapshot = storage.get("data:snapshot") ?? createSnapshot;
      const task = validSnapshot(snapshot) ? snapshot.tasks.find(item => item.id === body.taskId) : null;
      if (!task || !Number.isSafeInteger(task.project_id) || !snapshot.projects.some(p => p.id === task.project_id)) {
        return json({ error: "La tarea no está en el snapshot actual." }, 404);
      }
      for (const [key, job] of jobs()) {
        if (["completed", "error"].includes(job.status) && now - Date.parse(job.completedAt) > 604_800_000) storage.delete(key);
      }
      const existing = jobs().find(([, job]) => job.taskId === body.taskId && ["queued", "running"].includes(job.status));
      if (existing) return json({ error: "La tarea ya tiene una acción pendiente.", id: existing[1].id }, 409);
      if (jobs().length >= 500) return json({ error: "Cola de acciones llena." }, 429);
      const job = { id: body.requestId, kind: "action", action: "complete", taskId: task.id,
        projectId: task.project_id, status: "queued", createdAt: new Date(now).toISOString(), attempts: 0 };
      storage.put(`action:${job.id}`, job);
      return json(view(job), 202);
    }
    if (url.pathname === "/actions/status" && request.method === "GET") {
      const job = storage.get(`action:${url.searchParams.get("id")}`);
      return job ? json(view(job)) : json({ error: "Acción no encontrada." }, 404);
    }
    if (url.pathname === "/actions/next" && request.method === "GET") {
      const activeId = storage.get("action-current");
      const active = activeId ? storage.get(`action:${activeId}`) : null;
      if (active?.status === "running" && active.leaseUntil > now) return json({ job: null });
      if (active?.status === "running") {
        active.status = active.attempts >= 5 ? "error" : "queued";
        if (active.status === "error") { active.error = "Acción sin confirmación; revisa la tarea."; active.completedAt = new Date(now).toISOString(); }
        storage.put(`action:${active.id}`, active);
      }
      storage.delete("action-current");
      const next = jobs().map(([,job]) => job).filter(job => job.status === "queued" && (!job.nextAt || job.nextAt <= now))
        .sort((a,b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!next) return json({ job: null });
      next.status = "running";
      next.attempt = crypto.randomUUID();
      next.attempts += 1;
      next.leaseUntil = now + 180_000;
      next.startedAt = new Date(now).toISOString();
      storage.put(`action:${next.id}`, next);
      storage.put("action-current", next.id);
      return json({ job: next });
    }
    if (url.pathname === "/actions/complete" && request.method === "POST") {
      const job = storage.get(`action:${body.id}`);
      if (!job || job.status !== "running" || storage.get("action-current") !== job.id ||
          body.attempt !== job.attempt || job.leaseUntil <= now) return json({ error: "Intento no activo." }, 409);
      const snapshot = storage.get("data:snapshot");
      const confirmedAttempt = job.snapshotConfirmation?.attempt === body.attempt &&
        job.snapshotConfirmation?.timestamp === body.snapshotTimestamp;
      const verified = body.snapshotTimestamp && Number.isFinite(Date.parse(body.snapshotTimestamp)) &&
        (confirmedAttempt || Date.parse(body.snapshotTimestamp) >= Date.parse(job.startedAt)) &&
        Date.parse(snapshot?.timestamp) >= Date.parse(body.snapshotTimestamp) &&
        snapshot.tasks.some(task => task.id === job.taskId && task.project_id === job.projectId && task.done === true);
      job.error = body.error ? "No se pudo completar la tarea de forma segura; revisa su estado y alcance." : "";
      job.refreshError = !job.error && !verified ? "No se pudo confirmar el snapshot actualizado." : "";
      job.snapshotTimestamp = verified ? body.snapshotTimestamp : "";
      job.status = job.error ? "error" : verified ? "completed" : job.attempts >= 5 ? "error" : "queued";
      if (job.status === "queued") job.nextAt = now + 30_000;
      else job.completedAt = new Date(now).toISOString();
      storage.put(`action:${job.id}`, job);
      storage.delete("action-current");
      return json({ ok: true, status: job.status });
    }
    return json({ error: "Ruta interna no encontrada." }, 404);
  }

  // Legacy KV data belongs to the single-user production box. A user box in accounts mode
  // must never read it, or a new user would see the CEO's last snapshot and summaries.
  legacyAllowed() {
    return this.env.AUTH_MODE !== "accounts" || this.ctx.id?.name === LEGACY_BOX;
  }

  // Dashboard data (RPC from the Worker). Storage calls run synchronously after the awaits,
  // so each read-modify-write completes without another request interleaving.
  async snapshot() {
    const stored = this.ctx.storage.kv.get("data:snapshot");
    if (stored !== undefined || !this.legacyAllowed()) return stored ?? null;
    return await this.env.DASHBOARD_DATA.get(SNAPSHOT_KEY, "json");
  }

  async storedSummaries() {
    const storage = this.ctx.storage.kv;
    if (storage.get("data:summaries") === undefined) {
      // One-time move of the summaries written while they lived in Workers KV.
      const legacy = this.legacyAllowed() ? await this.env.DASHBOARD_DATA.get(SUMMARY_KEY, "json") || {} : {};
      if (storage.get("data:summaries") === undefined) storage.put("data:summaries", legacy);
    }
    return storage.get("data:summaries");
  }

  async dashboard() {
    const snapshot = await this.snapshot();
    if (!snapshot) return null;
    const stored = await this.storedSummaries();
    const aiSummaries = {};
    await Promise.all(snapshot.tasks.map(async task => {
      const record = stored[String(task.id)];
      if (record?.sourceHash && record.sourceHash === await hash(task)) aiSummaries[String(task.id)] = record;
    }));
    return { ...snapshot, aiSummaries, health: this.ctx.storage.kv.get("data:health") || {} };
  }

  requestHealthCheck() {
    const storage = this.ctx.storage.kv;
    const pending = storage.get("data:health-request");
    if (pending && Date.now() - Date.parse(pending.createdAt) < 120_000) return pending;
    const request = { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    storage.put("data:health-request", request);
    return request;
  }

  pendingHealthCheck() {
    const request = this.ctx.storage.kv.get("data:health-request");
    return request && Date.now() - Date.parse(request.createdAt) < 120_000 ? request : null;
  }

  healthStatus() { return this.ctx.storage.kv.get("data:health") || {}; }

  // F2: delete everything stored for a removed user (only reachable for user boxes).
  async wipe() {
    if (typeof this.ctx.storage.deleteAll === "function") {
      await this.ctx.storage.deleteAll();
      return;
    }
    const storage = this.ctx.storage.kv;
    for (const [key] of [...storage.list({ prefix: "" })]) storage.delete(key);
  }

  saveHealth(health) {
    const storage = this.ctx.storage.kv;
    const current = storage.get("data:health") || {};
    const receivedAt = new Date().toISOString();
    for (const [name, item] of Object.entries(health)) current[name] = { ...item, receivedAt };
    storage.put("data:health", current);
    const pending = storage.get("data:health-request");
    if (pending && ["vikunja", "granola"].every(name => current[name]?.requestId === pending.id)) {
      storage.delete("data:health-request");
    }
  }

  async saveSnapshot(snapshot, actionConfirmation = null, labelConfirmation = null) {
    const storage = this.ctx.storage.kv;
    const legacy = storage.get("data:snapshot") === undefined && this.legacyAllowed()
      ? await this.env.DASHBOARD_DATA.get(SNAPSHOT_KEY, "json") : null;
    // Re-read after the legacy await: another request may have published meanwhile.
    const current = storage.get("data:snapshot") ?? legacy;
    if (Array.isArray(current?.labels) && !Array.isArray(snapshot.labels)) return false;
    const observedAt = value => Date.parse(value?.observationStartedAt || value?.timestamp);
    if (current && ((current.observationStartedAt && !snapshot.observationStartedAt) ||
        observedAt(snapshot) < observedAt(current))) return false;
    // Bind the authenticated post-write snapshot to the current delivery. VM and
    // edge timestamps cannot be compared for causality: their clocks may differ.
    let actionJob = null;
    if (actionConfirmation !== null) {
      if (!actionConfirmation || typeof actionConfirmation !== "object" ||
          Object.keys(actionConfirmation).sort().join(",") !== "attempt,id" ||
          typeof actionConfirmation.id !== "string" || typeof actionConfirmation.attempt !== "string") return false;
      actionJob = storage.get(`action:${actionConfirmation.id}`);
      if (!actionJob || actionJob.status !== "running" || storage.get("action-current") !== actionJob.id ||
          actionJob.attempt !== actionConfirmation.attempt || actionJob.leaseUntil <= Date.now() ||
          !snapshot.tasks.some(task => task.id === actionJob.taskId &&
            task.project_id === actionJob.projectId && task.done === true)) return false;
    }
    let labelJob = null;
    if (labelConfirmation !== null) {
      if (!labelConfirmation || typeof labelConfirmation !== 'object' ||
          Object.keys(labelConfirmation).sort().join(',') !== 'attempt,id,result') return false;
      labelJob = storage.get(`label-job:${labelConfirmation.id}`);
      if (!labelJob || labelJob.status !== 'running' || labelJob.attempt !== labelConfirmation.attempt ||
          labelJob.leaseUntil <= Date.now() || !labelResultMatches(labelJob,snapshot,labelConfirmation.result)) return false;
    }
    // Synchronous compare+put is atomic within the DO. Ordering uses collection START,
    // not completion time: a slow old collection must not resurrect completed tasks.
    storage.put("data:snapshot", snapshot);
    if (actionJob) {
      actionJob.snapshotConfirmation = { attempt: actionConfirmation.attempt, timestamp: snapshot.timestamp };
      storage.put(`action:${actionJob.id}`, actionJob);
    }
    if (labelJob) {
      labelJob.confirmation = {attempt:labelConfirmation.attempt,timestamp:snapshot.timestamp,result:labelConfirmation.result};
      storage.put(`label-job:${labelJob.id}`,labelJob);
    }
    await this.enqueueChangedCataTasks(snapshot.tasks);
    return true;
  }

  async enqueueChangedCataTasks(tasks) {
    if (!this.env.DSTA_BRIDGE_TOKEN) return;
    const cataTasks = tasks.filter(isCataTask).slice(0, 80);
    const hashes = await Promise.all(cataTasks.map(hash));
    const existing = await this.storedSummaries();
    const storage = this.ctx.storage.kv;
    // A task whose summary just failed waits an hour instead of retrying on every snapshot.
    const failed = storage.get("data:summary-failed") || {};
    const changed = [];
    const sourceHashes = {};
    cataTasks.forEach((task, index) => {
      const id = String(task.id);
      if (existing[id]?.sourceHash === hashes[index]) return;
      if (failed[id]?.sourceHash === hashes[index] && Date.now() < failed[id].retryAt) return;
      changed.push(task);
      sourceHashes[id] = hashes[index];
    });
    if (!changed.length) return;
    const same = record => record && JSON.stringify(record.sourceHashes) === JSON.stringify(sourceHashes);
    if (same(storage.get("data:summary-queue")) || same(storage.get("data:summary-busy"))) return;
    storage.put("data:summary-queue", {
      id: crypto.randomUUID(),
      kind: "summary",
      status: "queued",
      createdAt: new Date().toISOString(),
      sourceHashes,
      tasks: changed.map(task => ({
        id: task.id,
        title: task.title,
        done: task.done,
        project: task.project,
        owner: task.owner,
        date: task.date,
        dependency: task.dependency,
        description: String(task.description || "").slice(0, 6000),
      })),
    });
  }

  takeSummaryJob() {
    const storage = this.ctx.storage.kv;
    const busy = storage.get("data:summary-busy");
    if (busy && Date.now() - Date.parse(busy.startedAt) < 600_000) return null;
    const job = storage.get("data:summary-queue");
    if (!job) return null;
    storage.delete("data:summary-queue");
    if (Date.now() - Date.parse(job.createdAt) > 86_400_000) return null;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    storage.put("data:summary-busy", { id: job.id, sourceHashes: job.sourceHashes, startedAt: job.startedAt });
    return job;
  }

  async completeSummaryJob(id, failedJob, summaries) {
    const busy = this.ctx.storage.kv.get("data:summary-busy");
    if (!busy || busy.id !== id) return false;
    const snapshot = await this.snapshot();
    const currentTasks = new Map((snapshot?.tasks || []).map(task => [String(task.id), task]));
    const updates = {};
    if (!failedJob && Array.isArray(summaries)) {
      for (const item of summaries.slice(0, 80)) {
        const taskId = String(item?.id ?? "");
        const task = currentTasks.get(taskId);
        const sourceHash = busy.sourceHashes?.[taskId];
        if (!task || !sourceHash || await hash(task) !== sourceHash) continue;
        if (typeof item.summary !== "string" || !item.summary.trim()) continue;
        updates[taskId] = {
          sourceHash,
          summary: item.summary.trim().slice(0, 700),
          nextAction: typeof item.nextAction === "string" ? item.nextAction.trim().slice(0, 300) : "",
          attention: ["normal", "seguimiento", "bloqueada"].includes(item.attention) ? item.attention : "normal",
          updatedAt: new Date().toISOString(),
        };
      }
    }
    const stored = await this.storedSummaries();
    const storage = this.ctx.storage.kv;
    const failed = Object.fromEntries(Object.entries(storage.get("data:summary-failed") || {})
      .filter(([, record]) => Date.now() < record.retryAt));
    for (const [taskId, sourceHash] of Object.entries(busy.sourceHashes || {})) {
      if (updates[taskId]) delete failed[taskId];
      else failed[taskId] = { sourceHash, retryAt: Date.now() + SUMMARY_RETRY_MS };
    }
    storage.put("data:summaries", { ...stored, ...updates });
    storage.put("data:summary-failed", failed);
    if (storage.get("data:summary-busy")?.id === id) storage.delete("data:summary-busy");
    return true;
  }

  takeDecision() {
    const storage = this.ctx.storage.kv;
    for (const [key, decision] of storage.list({ prefix: "decision:" })) {
      const stalled = decision.status === "running" && Date.now() - Date.parse(decision.startedAt || "") > 900_000; // instrucciones llaman al modelo
      if (decision.status === "queued" || stalled) {
        decision.status = "running";
        decision.startedAt = new Date().toISOString();
        storage.put(key, decision);
        return decision;
      }
    }
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!configured(env)) {
      return json({ error: "Faltan secretos de configuración del Worker." }, 503);
    }

    const accounts = accountsMode(env);
    const bridgeRoutes = {
      "/api/ingest": ["POST", (req, box) => receiveSnapshot(req, env, false, box)],
      "/api/bridge/snapshot": ["POST", (req, box) => receiveSnapshot(req, env, true, box)],
      "/api/bridge/next": ["GET", (req, box) => takeBridgeJob(req, env, box)],
      "/api/bridge/complete": ["POST", (req, box) => completeBridgeJob(req, env, box)],
      "/api/bridge/health": ["POST", (req, box) => receiveHealth(req, env, box)],
      "/api/bridge/minute": ["POST", (req, box) => bridgeMinuteRoute(req, env, "/minutes/upsert", box)],
      "/api/bridge/decision-done": ["POST", (req, box) => bridgeMinuteRoute(req, env, "/minutes/decision-done", box)],
    };
    // Accounts mode: the bridge may name the actor in the path (/u/<actor>/api/bridge/...).
    const prefixed = accounts ? /^\/u\/([a-z0-9][a-z0-9-]{0,62})(\/api\/(?:bridge\/[a-z-]+|ingest))$/.exec(url.pathname) : null;
    if (accounts && url.pathname.startsWith("/u/") && !prefixed) return json({ error: "No encontrado" }, 404);
    const bridgePath = prefixed ? prefixed[2] : url.pathname;
    if (accounts && bridgePath === "/api/bridge/dispatch" && !prefixed) return dispatchRoute(request, env);
    // F2: removing a user wipes their box. Accounts mode only; the production box is never wiped.
    if (accounts && bridgePath === "/api/bridge/wipe") {
      if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
      const resolved = await bridgeBox(request, env, bridgePath, prefixed ? prefixed[1] : null);
      if (resolved.error) return resolved.error;
      if (resolved.box === LEGACY_BOX || resolved.box === DISPATCH_BOX) {
        return json({ error: "Ese cajón no se puede borrar." }, 403);
      }
      await chatStub(env, resolved.box).wipe();
      return json({ ok: true });
    }
    const bridgeRoute = bridgeRoutes[bridgePath];
    if (bridgeRoute) {
      if (request.method !== bridgeRoute[0]) return json({ error: "Método no permitido" }, 405);
      if (!accounts) return bridgeRoute[1](request, LEGACY_BOX);
      const resolved = await bridgeBox(request, env, bridgePath, prefixed ? prefixed[1] : null);
      return resolved.error || bridgeRoute[1](request, resolved.box);
    }
    if (prefixed) return json({ error: "No encontrado" }, 404);

    // Android fetches installation metadata without the user's Basic credentials.
    // Expose only exact, generic PWA assets; all dashboard files and APIs stay private.
    const publicPwaAsset = new Set([
      "/manifest.webmanifest", "/sw.js", "/offline", "/offline.html",
      "/icons/dsta-192.png", "/icons/dsta-512.png", "/icons/dsta-maskable-512.png",
    ]).has(url.pathname) && ["GET", "HEAD"].includes(request.method);

    let box = LEGACY_BOX;
    let session = null;
    if (accounts) {
      // Every browser write carries a same-origin Origin; the session cookie is the
      // ambient authority, so a missing Origin is rejected too (CSRF).
      if (!["GET", "HEAD"].includes(request.method)) {
        if (request.headers.get("origin") !== url.origin) return json({ error: "Origen de solicitud no permitido." }, 403);
        const mediaType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
        if (url.pathname !== "/api/auth/logout" && mediaType !== "application/json") return json({ error: "Se requiere application/json." }, 415);
      }
      if (url.pathname === "/api/auth/login") {
        return request.method === "POST" ? accountsLogin(request, env) : json({ error: "Método no permitido" }, 405);
      }
      if (url.pathname === "/api/auth/accept-invite") {
        return request.method === "POST" ? accountsAcceptInvite(request, env) : json({ error: "Método no permitido" }, 405);
      }
      session = publicPwaAsset || PUBLIC_ACCOUNT_PATHS.has(url.pathname) ? null : await currentSession(request, env);
      if (!session && !publicPwaAsset && !PUBLIC_ACCOUNT_PATHS.has(url.pathname)) {
        if (url.pathname.startsWith("/api/")) return json({ error: "No autenticado." }, 401);
        return new Response(null, { status: 302, headers: { location: "/login", "cache-control": "no-store" } });
      }
      if (session) box = session.box;
      if (url.pathname === "/api/session") {
        return request.method === "GET" ? json({ actor: session.actor }) : json({ error: "Método no permitido" }, 405);
      }
      if (url.pathname === "/api/auth/logout") {
        return request.method === "POST" ? accountsLogout(env, session) : json({ error: "Método no permitido" }, 405);
      }
    } else {
      if (!publicPwaAsset && !basicAuthorized(request, env)) return requestAuthentication();

      // Basic auth is ambient browser authority: reject foreign-site writes before
      // reading a body or scheduling a job. CLI clients without Origin remain valid.
      if (request.method === "POST" && ["/api/assistant", "/api/label-actions", "/api/task-actions", "/api/minutes/seen", "/api/minutes/decide", "/api/health/refresh"].includes(url.pathname)) {
        const origin = request.headers.get("origin");
        const site = request.headers.get("sec-fetch-site");
        if ((origin !== null && origin !== url.origin) || (site && site !== "same-origin" && site !== "none")) {
          return json({ error: "Origen de solicitud no permitido." }, 403);
        }
        const mediaType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
        if (mediaType !== "application/json") return json({ error: "Se requiere application/json." }, 415);
      }
    }

    // Accounts mode: announce new work to the dispatcher after a successful browser write.
    const announce = async (pending, kind) => {
      const response = await pending;
      if (kind && accounts && session && request.method === "POST" && response.status >= 200 && response.status < 300) {
        await markPending(env, session.actor.id, kind);
      }
      return response;
    };

    if (url.pathname === "/api/minutes") {
      if (request.method !== "GET") return json({ error: "Método no permitido" }, 405);
      return chatStub(env, box).fetch("https://chat.internal/minutes/list");
    }
    if (url.pathname === "/api/minutes/seen" || url.pathname === "/api/minutes/decide") {
      if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
      // Minute decisions ride on the chat poll (see /next in the Durable Object).
      return announce(browserMinuteRoute(request, env, url.pathname.replace("/api", ""), box),
        url.pathname === "/api/minutes/decide" ? "chat" : null);
    }

    if (url.pathname === "/api/health/refresh") {
      if (request.method === "GET") return json({ health: await chatStub(env, box).healthStatus() });
      if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
      if (!env.DSTA_BRIDGE_TOKEN) return json({ error: "Puente no configurado" }, 503);
      return announce(Promise.resolve(json(await chatStub(env, box).requestHealthCheck(), 202)), "health");
    }
    if (url.pathname === "/api/dashboard") {
      if (request.method !== "GET") return json({ error: "Método no permitido" }, 405);
      return serveSnapshot(env, box);
    }
    if (url.pathname === "/api/label-actions") return announce(labelActionRoute(request, url, env, box), "label");
    if (url.pathname === "/api/task-actions") return announce(taskActionRoute(request, url, env, box), "action");
    if (url.pathname === "/api/assistant") {
      if (request.method === "POST") return announce(createAssistantJob(request, env, box), "chat");
      if (request.method === "GET") return readAssistantJob(url, env, box);
      return json({ error: "Método no permitido" }, 405);
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "No encontrado" }, 404);
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    const scriptSources = ["'self'"];
    if ((asset.headers.get("content-type") || "").includes("text/html")) {
      const html = await asset.clone().text();
      for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (/\bsrc\s*=/i.test(match[1]) || !match[2].trim()) continue;
        // HTML parsing normalizes CRLF/CR to LF before CSP hashes are evaluated.
        const bytes = new TextEncoder().encode(match[2].replace(/\r\n?/g, "\n"));
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        scriptSources.push(`'sha256-${btoa(String.fromCharCode(...digest))}'`);
      }
    }
    headers.set("content-security-policy", `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src ${scriptSources.join(" ")}; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'none'`);
    headers.set("x-frame-options", "DENY");
    headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  },
};
