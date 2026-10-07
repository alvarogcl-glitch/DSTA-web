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

function chatStub(env) {
  return env.CHAT_STATE.getByName("pmo-dsta");
}

function configured(env) {
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
  const projectIds = new Set(snapshot.projects.map(item => item.id));
  if (projectIds.size !== snapshot.projects.length || new Set(snapshot.tasks.map(item => item.id)).size !== snapshot.tasks.length) return false;
  return snapshot.tasks.every(task =>
    (task.project_id === undefined || projectIds.has(task.project_id)) &&
    (task.done === undefined || typeof task.done === "boolean") &&
    ["project", "owner", "date", "dependency", "criterion", "source", "action_key", "description"]
      .every(key => task[key] === undefined || typeof task[key] === "string"));
}

async function receiveSnapshot(request, env, fromBridge = false) {
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
    projects: snapshot.projects,
    tasks: snapshot.tasks,
    stale: false,
  };
  if (snapshot.actionConfirmation !== undefined && !fromBridge) {
    return json({ error: "La confirmación requiere el canal del puente." }, 400);
  }
  if (!await chatStub(env).saveSnapshot(normalized, snapshot.actionConfirmation ?? null)) {
    return json({ error: "Snapshot anterior a la observación vigente; no se reemplazaron los datos." }, 409);
  }
  return json({ ok: true, projects: normalized.projects.length, tasks: normalized.tasks.length }, 202);
}

async function serveSnapshot(env) {
  const dashboard = await chatStub(env).dashboard();
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

async function createAssistantJob(request, env) {
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
  const snapshot = taskId === null ? null : await chatStub(env).snapshot();
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
  return chatStub(env).fetch(new Request("https://chat.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(job),
  }));
}

const ACTION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function taskActionRoute(request, url, env) {
  if (!env.DSTA_BRIDGE_TOKEN) return json({ error: "Puente no configurado" }, 503);
  if (request.method === "GET") {
    const id = url.searchParams.get("id") || "";
    if (!ACTION_UUID.test(id)) return json({ error: "Identificador inválido." }, 400);
    return chatStub(env).fetch(`https://chat.internal/actions/status?id=${id}`);
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
  return forwardToChatObject(env, "/actions/create", body);
}

async function readAssistantJob(url, env) {
  const id = url.searchParams.get("id") || "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Identificador inválido." }, 400);
  const response = await chatStub(env).fetch(`https://chat.internal/status?id=${encodeURIComponent(id)}`);
  if (response.status !== 404) return response;
  // Old KV replies remain readable during the one-day cutover window.
  const oldJob = await env.DASHBOARD_DATA.get(JOB_PREFIX + id, "json");
  if (!oldJob || oldJob.kind !== "chat") return response;
  return json({ id: oldJob.id, status: oldJob.status, reply: oldJob.reply || "", error: oldJob.error || "" });
}

function bridgeAuthorized(request, env) {
  return bearerAuthorized(request, env.DSTA_BRIDGE_TOKEN);
}

async function takeBridgeJob(request, env) {
  if (!env.DSTA_BRIDGE_TOKEN) return json({ error: "Puente no configurado" }, 503);
  if (!bridgeAuthorized(request, env)) return json({ error: "No autorizado" }, 401);
  const requestedKind = new URL(request.url).searchParams.get("kind");
  if (requestedKind === "health") return json({ request: await chatStub(env).pendingHealthCheck() });
  if (requestedKind === "action") return chatStub(env).fetch("https://chat.internal/actions/next");
  const kind = requestedKind === "summary" ? "summary" : "chat";
  if (kind === "chat") return chatStub(env).fetch("https://chat.internal/next" + (new URL(request.url).searchParams.get("chatBusy") === "1" ? "?chatBusy=1" : ""));
  return json({ job: await chatStub(env).takeSummaryJob() });
}

async function completeBridgeJob(request, env) {
  if (!env.DSTA_BRIDGE_TOKEN) return json({ error: "Puente no configurado" }, 503);
  if (!bridgeAuthorized(request, env)) return json({ error: "No autorizado" }, 401);
  const parsed = await readJson(request, 400_000);
  if (parsed.error) return parsed.error;
  if (parsed.body?.kind === "action") return forwardToChatObject(env, "/actions/complete", parsed.body);
  const { id, reply, error, summaries, refreshError, snapshotTimestamp, minutes } = parsed.body || {};
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Identificador inválido." }, 400);
  const chatResponse = await chatStub(env).fetch(new Request("https://chat.internal/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, reply, error, refreshError, snapshotTimestamp, minutes: citedMinutes(minutes) }),
  }));
  if (chatResponse.status !== 404) return chatResponse;
  const done = await chatStub(env).completeSummaryJob(id, Boolean(error), summaries);
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
async function receiveHealth(request, env) {
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
  await chatStub(env).saveHealth(health);
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

function forwardToChatObject(env, path, body) {
  return chatStub(env).fetch(new Request(`https://chat.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function bridgeMinuteRoute(request, env, path) {
  if (!env.DSTA_BRIDGE_TOKEN) return json({ error: "Puente no configurado" }, 503);
  if (!bridgeAuthorized(request, env)) return json({ error: "No autorizado" }, 401);
  const parsed = await readJson(request, 400_000);
  if (parsed.error) return parsed.error;
  return forwardToChatObject(env, path, parsed.body);
}

async function browserMinuteRoute(request, env, path) {
  const parsed = await readJson(request, 60_000);
  if (parsed.error) return parsed.error;
  if (path === "/minutes/decide") {
    const decision = validDecision(parsed.body);
    if (!decision) return json({ error: "Decisión inválida." }, 400);
    return forwardToChatObject(env, path, decision);
  }
  const id = String(parsed.body?.id || "");
  if (!MINUTE_ID.test(id)) return json({ error: "Identificador inválido." }, 400);
  return forwardToChatObject(env, path, { id });
}

// Chat needs immediate, strongly consistent hand-off between the browser and VM.
// Snapshot and Cata summaries remain in Workers KV, where eventual consistency is acceptable.
export class DashboardChatQueue extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const storage = this.ctx.storage.kv;

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

  // Dashboard data (RPC from the Worker). Storage calls run synchronously after the awaits,
  // so each read-modify-write completes without another request interleaving.
  async snapshot() {
    return this.ctx.storage.kv.get("data:snapshot") ?? await this.env.DASHBOARD_DATA.get(SNAPSHOT_KEY, "json");
  }

  async storedSummaries() {
    const storage = this.ctx.storage.kv;
    if (storage.get("data:summaries") === undefined) {
      // One-time move of the summaries written while they lived in Workers KV.
      const legacy = await this.env.DASHBOARD_DATA.get(SUMMARY_KEY, "json") || {};
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

  async saveSnapshot(snapshot, actionConfirmation = null) {
    const storage = this.ctx.storage.kv;
    const legacy = storage.get("data:snapshot") === undefined
      ? await this.env.DASHBOARD_DATA.get(SNAPSHOT_KEY, "json") : null;
    // Re-read after the legacy await: another request may have published meanwhile.
    const current = storage.get("data:snapshot") ?? legacy;
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
    // Synchronous compare+put is atomic within the DO. Ordering uses collection START,
    // not completion time: a slow old collection must not resurrect completed tasks.
    storage.put("data:snapshot", snapshot);
    if (actionJob) {
      actionJob.snapshotConfirmation = { attempt: actionConfirmation.attempt, timestamp: snapshot.timestamp };
      storage.put(`action:${actionJob.id}`, actionJob);
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

    if (url.pathname === "/api/ingest") {
      if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
      return receiveSnapshot(request, env);
    }

    if (url.pathname === "/api/bridge/snapshot") {
      if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
      return receiveSnapshot(request, env, true);
    }
    if (url.pathname === "/api/bridge/next") {
      if (request.method !== "GET") return json({ error: "Método no permitido" }, 405);
      return takeBridgeJob(request, env);
    }
    if (url.pathname === "/api/bridge/complete") {
      if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
      return completeBridgeJob(request, env);
    }

    if (url.pathname === "/api/bridge/health") {
      if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
      return receiveHealth(request, env);
    }
    if (url.pathname === "/api/bridge/minute") {
      if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
      return bridgeMinuteRoute(request, env, "/minutes/upsert");
    }
    if (url.pathname === "/api/bridge/decision-done") {
      if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
      return bridgeMinuteRoute(request, env, "/minutes/decision-done");
    }

    // Android fetches installation metadata without the user's Basic credentials.
    // Expose only exact, generic PWA assets; all dashboard files and APIs stay private.
    const publicPwaAsset = new Set([
      "/manifest.webmanifest", "/sw.js", "/offline", "/offline.html",
      "/icons/dsta-192.png", "/icons/dsta-512.png", "/icons/dsta-maskable-512.png",
    ]).has(url.pathname) && ["GET", "HEAD"].includes(request.method);
    if (!publicPwaAsset && !basicAuthorized(request, env)) return requestAuthentication();

    // Basic auth is ambient browser authority: reject foreign-site writes before
    // reading a body or scheduling a job. CLI clients without Origin remain valid.
    if (request.method === "POST" && ["/api/assistant", "/api/task-actions", "/api/minutes/seen", "/api/minutes/decide", "/api/health/refresh"].includes(url.pathname)) {
      const origin = request.headers.get("origin");
      const site = request.headers.get("sec-fetch-site");
      if ((origin !== null && origin !== url.origin) || (site && site !== "same-origin" && site !== "none")) {
        return json({ error: "Origen de solicitud no permitido." }, 403);
      }
      const mediaType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      if (mediaType !== "application/json") return json({ error: "Se requiere application/json." }, 415);
    }

    if (url.pathname === "/api/minutes") {
      if (request.method !== "GET") return json({ error: "Método no permitido" }, 405);
      return chatStub(env).fetch("https://chat.internal/minutes/list");
    }
    if (url.pathname === "/api/minutes/seen" || url.pathname === "/api/minutes/decide") {
      if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
      return browserMinuteRoute(request, env, url.pathname.replace("/api", ""));
    }

    if (url.pathname === "/api/health/refresh") {
      if (request.method === "GET") return json({ health: await chatStub(env).healthStatus() });
      if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
      if (!env.DSTA_BRIDGE_TOKEN) return json({ error: "Puente no configurado" }, 503);
      return json(await chatStub(env).requestHealthCheck(), 202);
    }
    if (url.pathname === "/api/dashboard") {
      if (request.method !== "GET") return json({ error: "Método no permitido" }, 405);
      return serveSnapshot(env);
    }
    if (url.pathname === "/api/task-actions") return taskActionRoute(request, url, env);
    if (url.pathname === "/api/assistant") {
      if (request.method === "POST") return createAssistantJob(request, env);
      if (request.method === "GET") return readAssistantJob(url, env);
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
