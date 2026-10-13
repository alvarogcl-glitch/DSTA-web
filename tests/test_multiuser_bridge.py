"""Puente multiusuario: un sondeo de despacho para N usuarios; cada trabajo corre con la credencial
y la raíz de SU usuario; nunca con la de otro ni con la del CEO."""
import importlib.util
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import user_context  # noqa: E402  (shared context variable)

spec = importlib.util.spec_from_file_location("multiuser_bridge", TOOLS / "multiuser_bridge.py")
mb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mb)

BASE = "https://dsta-web-staging.example.workers.dev"
USERS = {
    "demo-a": {"vikunjaUrl": "http://127.0.0.1:14701", "vikunjaToken": "token-de-A", "rootProjectId": 11},
    "demo-b": {"vikunjaUrl": "http://127.0.0.1:14701", "vikunjaToken": "token-de-B", "rootProjectId": 22},
}


class FakeWorker:
    def __init__(self, pending, queues):
        self.pending, self.queues, self.calls, self.acks = pending, queues, [], []

    def request_json(self, url, *, token, method="GET", payload=None, timeout=30):
        assert token == "bridge-token"
        self.calls.append((method, url))
        if url == f"{BASE}/api/bridge/dispatch" and method == "GET":
            return {"now": 1000, "pending": self.pending}
        if url == f"{BASE}/api/bridge/dispatch" and method == "POST":
            self.acks.append(payload)
            return {"ok": True}
        prefix = f"{BASE}/u/"
        assert url.startswith(prefix), url
        actor, rest = url[len(prefix):].split("/", 1)
        kind = rest.split("kind=")[1].split("&")[0] if "kind=" in rest else "chat"
        queue = self.queues.get((actor, kind), [])
        return {"job": queue.pop(0) if queue else None}


class MultiuserBridgeTest(unittest.TestCase):
    def make(self, worker, processed, finished):
        def process_job(job, base_url, token, hermes_cli, hermes_home, provider, model, vikunja_token, vikunja_url, *rest):
            processed.append({"job": job["id"], "base": base_url, "vikunja_token": vikunja_token,
                              "root": user_context.root_project_id(), "home": str(hermes_home)})
        def finish_job(base_url, token, job, **kwargs):
            finished.append({"job": job["id"], "base": base_url, **kwargs})
        return mb.MultiuserBridge(BASE, "bridge-token", load_user=USERS.get, request_json=worker.request_json,
                                  process_job=process_job, finish_job=finish_job, users_dir=Path("C:/tmp/dsta-users"))

    def test_cada_trabajo_usa_la_credencial_y_raiz_de_su_usuario(self):
        worker = FakeWorker({"demo-a": {"action": 900}, "demo-b": {"label": 950}},
                            {("demo-a", "action"): [{"id": "act-a", "kind": "action"}],
                             ("demo-b", "label"): [{"id": "lab-b", "kind": "label"}]})
        processed, finished = [], []
        self.make(worker, processed, finished).dispatch_once()
        by_job = {p["job"]: p for p in processed}
        self.assertEqual(by_job["act-a"]["vikunja_token"], "token-de-A")
        self.assertEqual(by_job["act-a"]["root"], 11)
        self.assertEqual(by_job["act-a"]["base"], f"{BASE}/u/demo-a")
        self.assertEqual(by_job["lab-b"]["vikunja_token"], "token-de-B")
        self.assertEqual(by_job["lab-b"]["root"], 22)
        self.assertIn("demo-b", by_job["lab-b"]["home"])
        self.assertEqual(user_context.root_project_id(), user_context.DEFAULT_ROOT_PROJECT_ID, "la raíz vuelve al default")
        self.assertIn({"actor": "demo-a", "kinds": ["action"], "seenAt": 1000}, worker.acks)

    def test_usuario_sin_vault_no_se_procesa_ni_se_confirma(self):
        worker = FakeWorker({"intruso": {"action": 900}}, {("intruso", "action"): [{"id": "x", "kind": "action"}]})
        processed, finished = [], []
        self.make(worker, processed, finished).dispatch_once()
        self.assertEqual(processed, [])
        self.assertFalse(any("/u/intruso/" in url for _, url in worker.calls))
        self.assertEqual(worker.acks, [])

    def test_copilot_no_habilitado_hasta_f5(self):
        worker = FakeWorker({"demo-a": {"chat": 900}}, {("demo-a", "chat"): [{"id": "chat-a", "kind": "chat"}]})
        processed, finished = [], []
        self.make(worker, processed, finished).dispatch_once()
        self.assertEqual(processed, [], "ningún modelo atiende consultas multiusuario antes de F5")
        self.assertEqual(finished[0]["job"], "chat-a")
        self.assertIn("Copilot", finished[0]["error"])
        self.assertEqual(finished[0]["base"], f"{BASE}/u/demo-a")

    def test_barrido_revisa_a_todos_los_usuarios_del_vault(self):
        worker = FakeWorker({}, {("demo-b", "action"): [{"id": "retry-b", "kind": "action"}]})
        processed, finished = [], []
        bridge = self.make(worker, processed, finished)
        bridge.sweep(["demo-a", "demo-b"])
        self.assertEqual([p["job"] for p in processed], ["retry-b"])
        self.assertEqual(processed[0]["vikunja_token"], "token-de-B")


if __name__ == "__main__":
    unittest.main()
