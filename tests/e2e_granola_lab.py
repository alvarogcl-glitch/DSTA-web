"""F4.3 orchestrator: synthetic Granola + lab Vikunja + staging Worker (wrangler dev started with
--var GRANOLA_TEST_ORIGIN:1) + real multiuser bridge + browser (tests/e2e_granola_ui.mjs).

  DSTA_VAULT_DIR=<tmp> python tests/e2e_granola_lab.py http://127.0.0.1:<port> <d1 persist dir> <dir with playwright-core>
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
sys.path.insert(0, str(ROOT / "tests"))
import provision_user as pu  # noqa: E402
import user_vault  # noqa: E402
from fake_granola import FakeGranola  # noqa: E402

BASE, PERSIST, NODE_DIR = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]
SCOPE = ("--local", "--persist-to", PERSIST)
suffix = secrets.token_hex(3)
actors = {"A": f"gr-a-{suffix}", "B": f"gr-b-{suffix}"}
work = Path(tempfile.mkdtemp())
cfg = {"base": BASE}
bridge = None
code = 1
with FakeGranola() as fake:
    try:
        for k, actor in actors.items():
            user = pu.provision_vikunja("http://127.0.0.1:14701", actor, f"{actor}@dsta.test", f"Granola {k}")
            user_vault.save(actor, user)
            pu.vikunja(user["vikunjaUrl"], "PUT", "/projects", {"title": f"LT {k}", "parent_project_id": user["rootProjectId"]},
                       token=user["vikunjaToken"])
            token, password = secrets.token_urlsafe(32), "gr-" + secrets.token_urlsafe(18)
            pu.d1_execute(pu.invitation_sql(actor, f"{actor}@dsta.test", f"Granola {k}", token, int(time.time())), SCOPE)
            req = urllib.request.Request(f"{BASE}/api/auth/accept-invite", method="POST",
                                         data=json.dumps({"token": token, "password": password}).encode(),
                                         headers={"Content-Type": "application/json", "Origin": BASE})
            assert urllib.request.urlopen(req, timeout=20).status == 201
            cfg[k] = {"email": f"{actor}@dsta.test", "password": password}
        (work / "bridge.env").write_text(f"DSTA_DASHBOARD_URL={BASE}\nDSTA_BRIDGE_TOKEN={pu.bridge_token()}\n"
                                         f"DSTA_GRANOLA_TEST_ORIGIN={fake.origin}\n", encoding="utf-8")
        bridge = subprocess.Popen([sys.executable, str(ROOT / "tools" / "multiuser_bridge.py"), "--env-file", str(work / "bridge.env")],
                                  cwd=ROOT, env=os.environ.copy(), stdout=open(work / "bridge.log", "w"), stderr=subprocess.STDOUT)
        time.sleep(6)
        (work / "cfg.json").write_text(json.dumps(cfg), encoding="utf-8")
        script = Path(NODE_DIR) / "e2e_granola_ui.mjs"
        script.write_text((ROOT / "tests" / "e2e_granola_ui.mjs").read_text(encoding="utf-8"), encoding="utf-8")
        code = subprocess.run(["node", str(script), str(work / "cfg.json")], cwd=NODE_DIR).returncode
    finally:
        if bridge:
            bridge.terminate()
            bridge.wait(timeout=20)
        for actor in actors.values():
            pu.main(["remove", "--actor", actor, "--dashboard-url", BASE, "--local", "--persist-to", PERSIST])
        for name in ("cfg.json", "bridge.env"):
            (work / name).unlink(missing_ok=True)
        log = (work / "bridge.log").read_text(encoding="utf-8", errors="replace") if (work / "bridge.log").exists() else ""
        print("log del puente (sin secretos):\n" + "\n".join(l for l in log.splitlines() if "pydantic" not in l and "warn" not in l)[-1200:])
sys.exit(code)
