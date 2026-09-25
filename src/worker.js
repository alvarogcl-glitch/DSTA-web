import { DurableObject } from "cloudflare:workers";

const SNAPSHOT_KEY = "vikunja-dashboard-v1";
const SUMMARY_KEY = "dsta-ai-summaries-v1";
const SUMMARY_QUEUE_KEY = "dsta-ai-summary-queue-v1";
const SUMMARY_BUSY_KEY = "dsta-ai-summary-busy-v1";
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

async function enqueueChangedCataTasks(env, tasks) {
  if (!env.DSTA_BRIDGE_TOKEN) return;
  const cataTasks = tasks.filter(isCataTask).slice(0, 80);
  const existing = await env.DASHBOARD_DATA.get(SUMMARY_KEY, "json") || {};
  const changed = [];
  const sourceHashes = {};
  for (const task of cataTasks) {
    const sourceHash = await hash(task);
    if (existing[String(task.id)]?.sourceHash === sourceHash) continue;
    changed.push(task);
    sourceHashes[String(task.id)] = sourceHash;
  }
  if (!changed.length) return;

  const queued = await env.DASHBOARD_DATA.get(SUMMARY_QUEUE_KEY, "json");
  if (queued && JSON.stringify(queued.sourceHashes) === JSON.stringify(sourceHashes)) return;
  const running = await env.DASHBOARD_DATA.get(SUMMARY_BUSY_KEY, "json");
  if (running && JSON.stringify(running.sourceHashes) === JSON.stringify(sourceHashes)) return;
  const job = {
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
  };
  await env.DASHBOARD_DATA.put(JOB_PREFIX + job.id, JSON.stringify(job), { expirationTtl: 86_400 });
  await env.DASHBOARD_DATA.put(SUMMARY_QUEUE_KEY, JSON.stringify(job), { expirationTtl: 86_400 });
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
  await env.DASHBOARD_DATA.put(SNAPSHOT_KEY, JSON.stringify(normalized));
  await enqueueChangedCataTasks(env, normalized.tasks);
  return json({ ok: true, projects: normalized.projects.length, tasks: normalized.tasks.length }, 202);
}

async function serveSnapshot(env) {
  const snapshot = await env.DASHBOARD_DATA.get(SNAPSHOT_KEY, "json");
  if (!snapshot) {
    return json({
      error: "El dashboard aún no ha recibido su primer snapshot desde Vikunja.",
      stale: true,
    }, 503);
  }
  const storedSummaries = await env.DASHBOARD_DATA.get(SUMMARY_KEY, "json") || {};
  const aiSummaries = {};
  await Promise.all(snapshot.tasks.map(async task => {
    const record = storedSummaries[String(task.id)];
    if (record?.sourceHash && record.sourceHash === await hash(task)) aiSummaries[String(task.id)] = record;
  }));
  return json({ ...snapshot, aiSummaries });
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
  const snapshot = await env.DASHBOARD_DATA.get(SNAPSHOT_KEY, "json");
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
  if (await env.DASHBOARD_DATA.get(SUMMARY_BUSY_KEY, "json")) {
    return json({ job: null });
  }
  const job = await env.DASHBOARD_DATA.get(SUMMARY_QUEUE_KEY, "json");
  if (!job || job.kind !== kind) return json({ job: null });
  await env.DASHBOARD_DATA.put(SUMMARY_BUSY_KEY, JSON.stringify({
    id: job.id,
    sourceHashes: job.sourceHashes,
  }), { expirationTtl: 600 });
  await env.DASHBOARD_DATA.delete(SUMMARY_QUEUE_KEY);
  job.status = "running";
  job.startedAt = new Date().toISOString();
  await env.DASHBOARD_DATA.put(JOB_PREFIX + job.id, JSON.stringify(job), { expirationTtl: 86_400 });
  return json({ job });
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
  const job = await env.DASHBOARD_DATA.get(JOB_PREFIX + id, "json");
  if (!job || job.kind !== "summary" || job.status !== "running") return json({ error: "Trabajo no encontrado o no está activo." }, 404);

  job.status = error ? "error" : "completed";
  job.error = typeof error === "string" ? error.slice(0, 1000) : "";
  job.completedAt = new Date().toISOString();
  if (!error && Array.isArray(summaries)) {
    const current = await env.DASHBOARD_DATA.get(SNAPSHOT_KEY, "json");
    const stored = await env.DASHBOARD_DATA.get(SUMMARY_KEY, "json") || {};
    const currentTasks = new Map((current?.tasks || []).map(task => [String(task.id), task]));
    for (const item of summaries.slice(0, 80)) {
      const taskId = String(item?.id ?? "");
      const task = currentTasks.get(taskId);
      const sourceHash = job.sourceHashes?.[taskId];
      if (!task || !sourceHash || await hash(task) !== sourceHash) continue;
      if (typeof item.summary !== "string" || !item.summary.trim()) continue;
      stored[taskId] = {
        sourceHash,
        summary: item.summary.trim().slice(0, 700),
        nextAction: typeof item.nextAction === "string" ? item.nextAction.trim().slice(0, 300) : "",
        attention: ["normal", "seguimiento", "bloqueada"].includes(item.attention) ? item.attention : "normal",
        updatedAt: new Date().toISOString(),
      };
    }
    await env.DASHBOARD_DATA.put(SUMMARY_KEY, JSON.stringify(stored));
  }
  await env.DASHBOARD_DATA.put(JOB_PREFIX + id, JSON.stringify(job), { expirationTtl: 86_400 });
  const running = await env.DASHBOARD_DATA.get(SUMMARY_BUSY_KEY, "json");
  if (running?.id === id) await env.DASHBOARD_DATA.delete(SUMMARY_BUSY_KEY);
  return json({ ok: true });
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
      const currentId = storage.get("current");
      const job = currentId ? storage.get(`job:${currentId}`) : null;
      if (!job || job.status !== "queued") return json({ job: null });
      job.status = "running";
      job.startedAt = new Date().toISOString();
      storage.put(`job:${job.id}`, job);
      return json({ job });
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

    if (!basicAuthorized(request, env)) return requestAuthentication();

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
