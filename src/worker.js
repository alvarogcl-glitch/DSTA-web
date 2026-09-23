const SNAPSHOT_KEY = "vikunja-dashboard-v1";
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
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

function ingestAuthorized(request, env) {
  return safeEqual(request.headers.get("authorization") || "", `Bearer ${env.INGEST_TOKEN}`);
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

async function receiveSnapshot(request, env) {
  if (!ingestAuthorized(request, env)) return json({ error: "No autorizado" }, 401);
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > 2_000_000) return json({ error: "Snapshot demasiado grande" }, 413);

  let snapshot;
  try {
    snapshot = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
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
  return json(snapshot);
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

    if (!basicAuthorized(request, env)) return requestAuthentication();

    if (url.pathname === "/api/dashboard") {
      if (request.method !== "GET") return json({ error: "Método no permitido" }, 405);
      return serveSnapshot(env);
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
