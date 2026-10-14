"""F3.3 orchestrator: lab Vikunja + staging Worker (wrangler dev) + real multiuser bridge loop +
browser (tests/e2e_structure_ui.mjs). Provisions two synthetic users, runs the UI flow, removes them.

  DSTA_VAULT_DIR=<tmp> python tests/e2e_structure_lab.py http://127.0.0.1:<port> <d1 persist dir> <dir with playwright-core>
"""
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import provision_user as pu  # noqa: E402
import user_vault  # noqa: E402

BASE, PERSIST, NODE_DIR = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]
SCOPE = ("--local", "--persist-to", PERSIST)
suffix = secrets.token_hex(3)
actors = {"A": f"ui-a-{suffix}", "B": f"ui-b-{suffix}"}
work = Path(tempfile.mkdtemp())
cfg = {"base": BASE}
bridge = None
code = 1
try:
    for k, actor in actors.items():
        user = pu.provision_vikunja("http://127.0.0.1:14701", actor, f"{actor}@dsta.test", f"UI {k}")
        user_vault.save(actor, user)
        lt = pu.vikunja(user["vikunjaUrl"], "PUT", "/projects", {"title": f"LT base {k}", "parent_project_id": user["rootProjectId"]},
                        token=user["vikunjaToken"])
        pu.vikunja(user["vikunjaUrl"], "PUT", f"/projects/{lt['id']}/tasks", {"title": f"Tarea base {k}"}, token=user["vikunjaToken"])
        token, password = secrets.token_urlsafe(32), "ui-" + secrets.token_urlsafe(18)
        pu.d1_execute(pu.invitation_sql(actor, f"{actor}@dsta.test", f"UI {k}", token, int(time.time())), SCOPE)
        req = urllib.request.Request(f"{BASE}/api/auth/accept-invite", method="POST", data=json.dumps({"token": token, "password": password}).encode(),
                                     headers={"Content-Type": "application/json", "Origin": BASE})
        assert urllib.request.urlopen(req, timeout=20).status == 201
        cfg[k] = {"email": f"{actor}@dsta.test", "password": password, "lt": f"LT base {k}"}
    (work / "bridge.env").write_text(f"DSTA_DASHBOARD_URL={BASE}\nDSTA_BRIDGE_TOKEN={pu.bridge_token()}\n", encoding="utf-8")
    bridge = subprocess.Popen([sys.executable, str(ROOT / "tools" / "multiuser_bridge.py"), "--env-file", str(work / "bridge.env")],
                              cwd=ROOT, env=os.environ.copy(), stdout=open(work / "bridge.log", "w"), stderr=subprocess.STDOUT)
    time.sleep(8)  # first publication of both snapshots
    (work / "cfg.json").write_text(json.dumps(cfg), encoding="utf-8")
    # ESM resolves playwright-core next to the script: run a copy inside NODE_DIR.
    script = Path(NODE_DIR) / "e2e_structure_ui.mjs"
    script.write_text((ROOT / "tests" / "e2e_structure_ui.mjs").read_text(encoding="utf-8"), encoding="utf-8")
    code = subprocess.run(["node", str(script), str(work / "cfg.json")], cwd=NODE_DIR).returncode
    if code == 0:
        # D67: the admin reset link (provision_user reset) sets a new password once and the old one stops working.
        reset_token = secrets.token_urlsafe(32)
        pu.d1_execute(pu.reset_sql(actors["A"], reset_token, int(time.time())), SCOPE)
        new_password = "ui-reset-" + secrets.token_urlsafe(18)
        def post(path, body):
            req = urllib.request.Request(f"{BASE}{path}", method="POST", data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json", "Origin": BASE})
            try:
                with urllib.request.urlopen(req, timeout=20) as response:
                    return response.status, json.loads(response.read() or b"{}")
            except urllib.error.HTTPError as error:
                return error.code, {}
        status, body = post("/api/auth/accept-invite", {"token": reset_token, "password": new_password})
        assert (status, body.get("reset")) == (200, True), status
        assert post("/api/auth/login", {"email": cfg["A"]["email"], "password": cfg["A"]["password"]})[0] == 401
        assert post("/api/auth/login", {"email": cfg["A"]["email"], "password": new_password})[0] == 200
        print("OK  D67: link de restablecimiento de un solo uso cambia la contraseña")
finally:
    if bridge:
        bridge.terminate()
        bridge.wait(timeout=20)
    for actor in actors.values():
        pu.main(["remove", "--actor", actor, "--dashboard-url", BASE, "--local", "--persist-to", PERSIST])
    for name in ("cfg.json", "bridge.env"):
        (work / name).unlink(missing_ok=True)
    print("log del puente (sin secretos):")
    print((work / "bridge.log").read_text(encoding="utf-8", errors="replace")[-1500:] if (work / "bridge.log").exists() else "")
sys.exit(code)
