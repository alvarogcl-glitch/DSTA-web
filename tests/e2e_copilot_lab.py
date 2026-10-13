"""F5.5 live canaries: real Hermes (CEO account) behind the multiuser bridge, lab Vikunja, staging
Worker under wrangler dev. Uses a few real Copilot calls.

  DSTA_VAULT_DIR=<tmp> python tests/e2e_copilot_lab.py http://127.0.0.1:<port> <d1 persist dir>
Checks: A's answer uses A's data; B never gets A's data; the CEO's memory is not injected; the
users' Hermes sessions do not remain in the CEO's history.
"""
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from http.cookies import SimpleCookie
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import hermes_bridge as hb  # noqa: E402
import provision_user as pu  # noqa: E402
import user_vault  # noqa: E402

BASE, PERSIST = sys.argv[1].rstrip("/"), sys.argv[2]
SCOPE = ("--local", "--persist-to", PERSIST)
suffix = secrets.token_hex(3)
actors = {"A": f"cp-a-{suffix}", "B": f"cp-b-{suffix}"}
canary = {"A": f"Instalar sensor Kappa-{suffix}", "B": f"Auditar bodega Omega-{suffix}"}
results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'OK  ' if ok else 'FAIL'} {name}" + (f" [{detail}]" if detail else ""), flush=True)


def http(method, path, body=None, cookies=None):
    h = {"Content-Type": "application/json"}
    if method != "GET":
        h["Origin"] = BASE
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
    return (getattr(response, "status", None) or response.code), (json.loads(raw) if raw else None)


def ask(cookies, message):
    status, job = http("POST", "/api/assistant", {"message": message}, cookies)
    if status != 202:
        return f"<HTTP {status}>"
    for _ in range(100):
        time.sleep(3)
        _, state = http("GET", f"/api/assistant?id={job['id']}", cookies=cookies)
        if state["status"] in ("completed", "error"):
            return state.get("reply") or f"<error: {state.get('error')}>"
    return "<timeout>"


cookies = {k: {} for k in actors}
work = Path(tempfile.mkdtemp())
bridge = None
try:
    for k, actor in actors.items():
        user = pu.provision_vikunja("http://127.0.0.1:14701", actor, f"{actor}@dsta.test", f"Copiloto {k}")
        user_vault.save(actor, user)
        lt = pu.vikunja(user["vikunjaUrl"], "PUT", "/projects", {"title": f"LT {k}", "parent_project_id": user["rootProjectId"]},
                        token=user["vikunjaToken"])
        pu.vikunja(user["vikunjaUrl"], "PUT", f"/projects/{lt['id']}/tasks",
                   {"title": canary[k], "description": f"Responsable: Persona {k}"}, token=user["vikunjaToken"])
        token, password = secrets.token_urlsafe(32), "cp-" + secrets.token_urlsafe(18)
        pu.d1_execute(pu.invitation_sql(actor, f"{actor}@dsta.test", f"Copiloto {k}", token, int(time.time())), SCOPE)
        assert http("POST", "/api/auth/accept-invite", {"token": token, "password": password})[0] == 201
        assert http("POST", "/api/auth/login", {"email": f"{actor}@dsta.test", "password": password}, cookies[k])[0] == 200
    (work / "bridge.env").write_text(f"DSTA_DASHBOARD_URL={BASE}\nDSTA_BRIDGE_TOKEN={pu.bridge_token()}\n", encoding="utf-8")
    bridge = subprocess.Popen([sys.executable, str(ROOT / "tools" / "multiuser_bridge.py"), "--env-file", str(work / "bridge.env")],
                              cwd=ROOT, env=os.environ.copy(), stdout=open(work / "bridge.log", "w"), stderr=subprocess.STDOUT)
    time.sleep(5)

    reply = ask(cookies["A"], "Lista mis tareas abiertas con su título exacto.")
    check("A: el Copilot responde con la tarea de A", canary["A"] in reply, reply[:120].replace("\n", " "))
    check("A: la respuesta no contiene datos de B", canary["B"] not in reply)
    reply = ask(cookies["B"], f"¿Qué sabes de la tarea «Instalar sensor Kappa» o de la persona A? Responde breve.")
    # The question itself names "Persona A"; the leak test is the unique suffixed title and A's task id.
    check("B: no obtiene datos de A", canary["A"] not in reply and suffix not in reply, reply[:120].replace("\n", " "))
    reply = ask(cookies["A"], "¿Cómo se llama la persona dueña de la cuenta de Hermes que te ejecuta y qué recuerdas de ella? Si no lo sabes, responde NO_SE.")
    check("A: no se inyecta la memoria del CEO", "lvaro" not in reply and "Castro" not in reply, reply[:120].replace("\n", " "))
    env = {**os.environ, "HERMES_HOME": str(hb.DEFAULT_HERMES_HOME), "PYTHONIOENCODING": "utf-8"}
    for k, actor in actors.items():
        listed = subprocess.run([str(hb.DEFAULT_HERMES_CLI), "sessions", "list", "--source", f"dsta-mu-{actor}"], env=env,
                                capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
        check(f"{k}: sus sesiones no quedan en el historial de Hermes del CEO", "No sessions" in listed, listed.strip()[:80])
finally:
    if bridge:
        bridge.terminate()
        bridge.wait(timeout=30)
    for actor in actors.values():
        pu.main(["remove", "--actor", actor, "--dashboard-url", BASE, "--local", "--persist-to", PERSIST])
    (work / "bridge.env").unlink(missing_ok=True)
print(f"\nResultado: {sum(results)}/{len(results)} pruebas OK")
sys.exit(0 if results and all(results) else 1)
