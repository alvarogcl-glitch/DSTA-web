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
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) return { error: json({ error: "Solicitud demasiado grande" }, 413) };
  try {
    const body = await request.json();
    if (new TextEncoder().encode(JSON.stringify(body)).length > maxBytes) {
      return { error: json({ error: "Solicitud demasiado grande" }, 413) };
    }
    return { body };
  } catch {
    return { error: json({ error: "JSON inválido" }, 400) };
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

async function receiveSnapshot(request, env, fromBridge = false) {
  if (!(fromBridge ? bridgeAuthorized(request, env) : ingestAuthorized(request, env))) {
    return json({ error: "No autorizado" }, 401);
  }
  const parsed = await readJson(request, 2_000_000);
  if (parsed.error) return parsed.error;
  const snapshot = parsed.body;
  if (!snapshot || !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.tasks) ||
      typeof snapshot.timestamp !== "string") {
    return json({ error: "Estructura de snapshot inválida" }, 400);
  }

  const normalized = {
    timestamp: snapshot.timestamp,
    projects: snapshot.projects,
    tasks: snapshot.tasks,
    stale: false,
  };
  await chatStub(env).saveSnapshot(normalized);
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
  const kind = new URL(request.url).searchParams.get("kind") === "summary" ? "summary" : "chat";
  if (kind === "chat") return chatStub(env).fetch("https://chat.internal/next");
  return json({ job: await chatStub(env).takeSummaryJob() });
}

async function completeBridgeJob(request, env) {
  if (!env.DSTA_BRIDGE_TOKEN) return json({ error: "Puente no configurado" }, 503);
  if (!bridgeAuthorized(request, env)) return json({ error: "No autorizado" }, 401);
  const parsed = await readJson(request, 100_000);
  if (parsed.error) return parsed.error;
  const { id, reply, error, summaries, refreshError, snapshotTimestamp } = parsed.body || {};
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Identificador inválido." }, 400);
  const chatResponse = await chatStub(env).fetch(new Request("https://chat.internal/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, reply, error, refreshError, snapshotTimestamp }),
  }));
  if (chatResponse.status !== 404) return chatResponse;
  const done = await chatStub(env).completeSummaryJob(id, Boolean(error), summaries);
  if (!done) return json({ error: "Trabajo no encontrado o no está activo." }, 404);
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
    if (!["aprobar", "rechazar"].includes(item.decision)) return null;
    const edits = {};
    for (const [key, value] of Object.entries(item.edits || {})) {
      if (!MINUTE_EDIT_KEYS.has(key) || !["string", "number"].includes(typeof value)) return null;
      if (String(value).length > 1500) return null;
      edits[key] = value;
    }
    clean.push({ actionId: item.actionId, decision: item.decision, edits });
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
        refreshError: job.refreshError || "", snapshotTimestamp: job.snapshotTimestamp || "" });
    }

    if (url.pathname === "/next" && request.method === "GET") {
      // The bridge already polls for chat; pending minute decisions ride on the same request.
      const decision = this.takeDecision();
      const currentId = storage.get("current");
      const job = currentId ? storage.get(`job:${currentId}`) : null;
      if (!job || job.status !== "queued") return json({ job: null, decision });
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
      const { id, reply, error, refreshError, snapshotTimestamp } = await request.json();
      const job = storage.get(`job:${id}`);
      if (!job || job.status !== "running" || storage.get("current") !== id) {
        return json({ error: "Trabajo no encontrado o no está activo." }, 404);
      }
      job.status = error ? "error" : "completed";
      job.error = typeof error === "string" ? error.slice(0, 1000) : "";
      job.reply = typeof reply === "string" ? reply.slice(0, 20_000) : "";
      job.refreshError = typeof refreshError === "string" ? refreshError.slice(0, 300) : "";
      job.snapshotTimestamp = typeof snapshotTimestamp === "string" ? snapshotTimestamp.slice(0, 40) : "";
      job.completedAt = new Date().toISOString();
      storage.put(`job:${id}`, job);
      storage.delete("current");
      return json({ ok: true });
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
    return { ...snapshot, aiSummaries };
  }

  async saveSnapshot(snapshot) {
    this.ctx.storage.kv.put("data:snapshot", snapshot);
    await this.enqueueChangedCataTasks(snapshot.tasks);
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
      const stalled = decision.status === "running" && Date.now() - Date.parse(decision.startedAt || "") > 300_000;
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

    if (url.pathname === "/api/bridge/minute") {
      if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
      return bridgeMinuteRoute(request, env, "/minutes/upsert");
    }
    if (url.pathname === "/api/bridge/decision-done") {
      if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
      return bridgeMinuteRoute(request, env, "/minutes/decision-done");
    }

    if (!basicAuthorized(request, env)) return requestAuthentication();

    if (url.pathname === "/api/minutes") {
      if (request.method !== "GET") return json({ error: "Método no permitido" }, 405);
      return chatStub(env).fetch("https://chat.internal/minutes/list");
    }
    if (url.pathname === "/api/minutes/seen" || url.pathname === "/api/minutes/decide") {
      if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
      return browserMinuteRoute(request, env, url.pathname.replace("/api", ""));
    }

    if (url.pathname === "/api/dashboard") {
      if (request.method !== "GET") return json({ error: "Método no permitido" }, 405);
      return serveSnapshot(env);
    }
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
    headers.set("content-security-policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  },
};
