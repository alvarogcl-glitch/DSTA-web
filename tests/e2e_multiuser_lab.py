"""E2E multiuser lab (F1.4 + F2.3): lab Vikunja (:14701) + staging Worker under wrangler dev.

Not part of npm test (needs both services running). Usage from the repo root:
  DSTA_VAULT_DIR=<tmp vault> DSTA_BRIDGE_TOKEN=<staging token> \
  python tests/e2e_multiuser_lab.py http://127.0.0.1:<port> <local D1 persist dir>
Provisions two synthetic users (own Vikunja account, root, LT and task), activates them by
invitation, runs the real multiuser bridge, checks isolation end to end, then removes both users
and verifies that token, box, D1 rows and vault are gone. Logs only check names and statuses.
"""
import json
import secrets
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from http.cookies import SimpleCookie
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import multiuser_bridge as mb  # noqa: E402
import provision_user as pu  # noqa: E402
import user_vault  # noqa: E402

BASE, PERSIST = sys.argv[1].rstrip("/"), sys.argv[2]
SCOPE = ("--local", "--persist-to", PERSIST)
VIKUNJA = "http://127.0.0.1:14701"
results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'OK  ' if ok else 'FAIL'} {name}" + (f" [{detail}]" if detail != "" else ""), flush=True)


def http(method, path, body=None, cookies=None, headers=None):
    h = {"Content-Type": "application/json", **(headers or {})}
    if method != "GET":
        h.setdefault("Origin", BASE)
    if cookies:
        h["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
    try:
        response = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    for header in response.headers.get_all("Set-Cookie") or []:
        parsed = SimpleCookie()
        parsed.load(header)
        for name, morsel in parsed.items():
            if cookies is not None:
                cookies[name] = morsel.value
    raw = response.read()
    return response.status if hasattr(response, "status") else response.code, (json.loads(raw) if raw else None)


def vk(user, method, path, body=None):
    return pu.vikunja(user["vikunjaUrl"], method, path, body, token=user["vikunjaToken"])


suffix = secrets.token_hex(3)
actors = {"A": f"lab-a-{suffix}", "B": f"lab-b-{suffix}"}
passwords = {k: "lab-" + secrets.token_urlsafe(18) for k in actors}
cookies = {k: {} for k in actors}
tasks = {}
env_file = Path(tempfile.mkdtemp()) / "bridge.env"
env_file.write_text(f"DSTA_DASHBOARD_URL={BASE}\nDSTA_BRIDGE_TOKEN={pu.bridge_token()}\n", encoding="utf-8")
try:
    for k, actor in actors.items():
        user = pu.provision_vikunja(VIKUNJA, actor, f"{actor}@dsta.test", f"Lab {k}")
        user_vault.save(actor, user)
        lt = vk(user, "PUT", "/projects", {"title": f"LT sintética {k}", "parent_project_id": user["rootProjectId"]})
        task = vk(user, "PUT", f"/projects/{lt['id']}/tasks", {"title": f"Tarea lab {k}"})
        tasks[k] = task["id"]
        token = secrets.token_urlsafe(32)
        pu.d1_execute(pu.invitation_sql(actor, f"{actor}@dsta.test", f"Lab {k}", token, int(__import__("time").time())), SCOPE)
        status, _ = http("POST", "/api/auth/accept-invite", {"token": token, "password": passwords[k]})
        check(f"F2 alta de {k}: espacio Vikunja + invitación aceptada", status == 201, status)
        status, _ = http("POST", "/api/auth/login", {"email": f"{actor}@dsta.test", "password": passwords[k]}, cookies=cookies[k])
        check(f"login {k}", status == 200, status)
    user_a, user_b = user_vault.load(actors["A"]), user_vault.load(actors["B"])
    try:
        vk(user_a, "GET", f"/projects/{user_b['rootProjectId']}")
        check("Vikunja: el token de A no puede leer la raíz de B", False)
    except urllib.error.HTTPError as error:
        check("Vikunja: el token de A no puede leer la raíz de B", error.code in (403, 404), error.code)

    bridge = mb.build(env_file)
    published = bridge.publish_all(list(actors.values()))
    check("el puente publica el snapshot de cada usuario desde SU Vikunja", published == 2, published)
    for k, other in (("A", "B"), ("B", "A")):
        status, dash = http("GET", "/api/dashboard", cookies=cookies[k])
        titles = [t["title"] for t in (dash or {}).get("tasks", [])]
        check(f"{k} ve solo su tarea de Vikunja", status == 200 and titles == [f"Tarea lab {k}"], status)

    status, _ = http("POST", "/api/task-actions", {"action": "complete", "taskId": tasks["B"], "requestId": str(uuid.uuid4())}, cookies=cookies["A"])
    check("A no puede completar la tarea de B", status == 404, status)
    status, _ = http("POST", "/api/task-actions", {"action": "complete", "taskId": tasks["A"], "requestId": str(uuid.uuid4())}, cookies=cookies["A"])
    check("A pide completar su tarea", status == 202, status)
    handled = bridge.dispatch_once()
    check("un sondeo de despacho atiende la acción de A", handled >= 1, handled)
    check("Vikunja: la tarea de A quedó completada con el token de A", vk(user_a, "GET", f"/tasks/{tasks['A']}")["done"] is True)
    check("Vikunja: la tarea de B no cambió", vk(user_b, "GET", f"/tasks/{tasks['B']}")["done"] is False)
    status, dash = http("GET", "/api/dashboard", cookies=cookies["A"])
    check("el dashboard de A refleja la tarea completada", status == 200 and dash["tasks"][0]["done"] is True, status)

    status, job = http("POST", "/api/assistant", {"message": "hola"}, cookies=cookies["B"])
    bridge.dispatch_once()
    status, reply = http("GET", f"/api/assistant?id={job['id']}", cookies=cookies["B"])
    check("Copilot multiusuario responde 'no habilitado' sin llamar a ningún modelo (hasta F5)",
          status == 200 and reply["status"] == "error" and "F5" in reply["error"], status)
finally:
    for k, actor in actors.items():
        user = user_vault.load(actor)
        pu.main(["remove", "--actor", actor, "--dashboard-url", BASE, "--local", "--persist-to", PERSIST])
        check(f"F2 baja de {k}: vault eliminado", user_vault.load(actor) is None)
        if user:
            try:
                pu.vikunja(user["vikunjaUrl"], "GET", "/projects", token=user["vikunjaToken"])
                check(f"F2 baja de {k}: token de Vikunja revocado", False)
            except urllib.error.HTTPError as error:
                check(f"F2 baja de {k}: token de Vikunja revocado", error.code == 401, error.code)
        status, _ = http("GET", "/api/dashboard", cookies=cookies[k])
        check(f"F2 baja de {k}: la sesión ya no sirve", status == 401, status)
        status, _ = http("POST", "/api/auth/login", {"email": f"{actor}@dsta.test", "password": passwords[k]})
        check(f"F2 baja de {k}: la cuenta ya no existe", status == 401, status)
    passwords.clear()
    env_file.unlink(missing_ok=True)
print(f"\nResultado: {sum(results)}/{len(results)} pruebas OK")
sys.exit(0 if all(results) else 1)
