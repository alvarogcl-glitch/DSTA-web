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

    def test_publicacion_periodica_reporta_semaforos_de_cada_usuario(self):
        posts = []
        def request_json(url, *, token, method="GET", payload=None, timeout=30):
            posts.append((url, payload))
            return {"ok": True}
        bridge = mb.MultiuserBridge(BASE, "bridge-token", load_user=USERS.get, request_json=request_json, process_job=None,
                                    finish_job=None, users_dir=Path("C:/tmp/x"), publish_snapshot=lambda *a, **k: "ts")
        self.assertEqual(bridge.publish_all(["demo-a", "demo-b"]), 2)
        health = [u for u, p in posts if u.endswith("/api/bridge/health")]
        self.assertEqual(health, [f"{BASE}/u/demo-a/api/bridge/health", f"{BASE}/u/demo-b/api/bridge/health"])

    def test_barrido_revisa_a_todos_los_usuarios_del_vault(self):
        worker = FakeWorker({}, {("demo-b", "action"): [{"id": "retry-b", "kind": "action"}]})
        processed, finished = [], []
        bridge = self.make(worker, processed, finished)
        bridge.sweep(["demo-a", "demo-b"])
        self.assertEqual([p["job"] for p in processed], ["retry-b"])
        self.assertEqual(processed[0]["vikunja_token"], "token-de-B")


class CopilotBridgeTest(unittest.TestCase):
    def test_chat_responde_con_contexto_del_usuario(self):
        finished, fetched, asked = [], [], []

        class FakeCopilot:
            def answer(self, actor, user, job, snapshot, minutes):
                asked.append((actor, user["vikunjaToken"], snapshot, minutes))
                return f"respuesta para {actor}"

        def fetch_snapshot(user):
            fetched.append((user["vikunjaToken"], user_context.root_project_id()))
            return {"projects": [], "tasks": [{"id": 1, "title": f"tarea de {user['vikunjaToken']}"}]}

        worker = FakeWorker({"demo-b": {"chat": 1}}, {("demo-b", "chat"): [{"id": "chat-b", "kind": "chat"}]})
        bridge = mb.MultiuserBridge(BASE, "bridge-token", load_user=USERS.get, request_json=worker.request_json,
                                    process_job=None, finish_job=lambda base, token, job, **kw: finished.append((base, job["id"], kw)),
                                    users_dir=Path("C:/tmp/x"), copilot=FakeCopilot(), fetch_snapshot=fetch_snapshot)
        bridge.dispatch_once()
        self.assertEqual(fetched, [("token-de-B", 22)], "snapshot leído con el token y la raíz de B")
        self.assertEqual(asked[0][0], "demo-b")
        self.assertEqual(asked[0][2]["tasks"][0]["title"], "tarea de token-de-B")
        self.assertEqual(finished, [(f"{BASE}/u/demo-b", "chat-b", {"reply": "respuesta para demo-b"})])


class FakeGranolaService:
    def __init__(self):
        self.calls = []
        self.ready = set()

    def authorize(self, actor, request_id):
        self.calls.append(("authorize", actor, request_id))
        return {"authorizationUrl": "https://granola.example/authorize?x=1", "state": f"st-{actor}"}

    def exchange(self, actor, request_id, state, code):
        self.calls.append(("exchange", actor, request_id, state, code))
        self.ready.add(actor)

    def connected(self, actor):
        return actor in self.ready

    def sync(self, actor):
        self.calls.append(("sync", actor))
        return [{"source_id": f"{actor}-m1", "version": "v1", "title": "Reunión", "date": "2026-10-12", "summary": "s"}]

    def disconnect(self, actor):
        self.calls.append(("disconnect", actor))
        self.ready.discard(actor)


class GranolaBridgeTest(unittest.TestCase):
    def setUp(self):
        self.posts = []
        self.granola = FakeGranolaService()

    def make(self, queue):
        test = self

        def request_json(url, *, token, method="GET", payload=None, timeout=30):
            if method == "POST":
                test.posts.append((url, payload))
                return {"ok": True}
            if url.endswith("/api/bridge/dispatch"):
                return {"now": 5, "pending": {"demo-a": {"granola": 1}}}
            return {"granola": queue.pop(0) if queue else None}
        return mb.MultiuserBridge(BASE, "bridge-token", load_user=USERS.get, request_json=request_json,
                                  process_job=None, finish_job=None, users_dir=Path("C:/tmp/x"), granola=self.granola)

    def test_flujo_conectar_intercambiar_y_sincronizar(self):
        bridge = self.make([{"op": "authorize", "id": "g1"}])
        bridge.dispatch_once()
        self.assertEqual(self.granola.calls[0], ("authorize", "demo-a", "g1"))
        url, payload = self.posts[0]
        self.assertEqual(url, f"{BASE}/u/demo-a/api/bridge/granola")
        self.assertEqual(payload["status"], "authorize")
        self.assertEqual(payload["state"], "st-demo-a")

        self.posts.clear()
        bridge = self.make([{"op": "exchange", "id": "g1", "code": "c0de", "state": "st-demo-a"}])
        bridge.dispatch_once()
        self.assertIn(("exchange", "demo-a", "g1", "st-demo-a", "c0de"), self.granola.calls)
        statuses = [p["status"] for u, p in self.posts if u.endswith("/api/bridge/granola")]
        self.assertEqual(statuses[:1], ["connected"])
        minutes = [p for u, p in self.posts if u.endswith("/api/bridge/minute")]
        self.assertEqual(len(minutes), 1, "tras conectar se importan las minutas del usuario")
        self.assertTrue(minutes[0]["id"].startswith("g-"))
        self.assertIn("synced", statuses)

    def test_error_de_granola_se_informa_sin_detalles(self):
        def boom(actor, request_id):
            raise RuntimeError("detalle interno con token secreto")
        self.granola.authorize = boom
        self.make([{"op": "authorize", "id": "g9"}]).dispatch_once()
        url, payload = self.posts[0]
        self.assertEqual(payload["status"], "error")
        self.assertNotIn("secreto", payload["error"])

    def test_sync_periodico_solo_usuarios_conectados(self):
        self.granola.ready = {"demo-b"}
        bridge = self.make([])
        bridge.sync_granola(["demo-a", "demo-b"])
        self.assertEqual([c for c in self.granola.calls if c[0] == "sync"], [("sync", "demo-b")])


if __name__ == "__main__":
    unittest.main()
