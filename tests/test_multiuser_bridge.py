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


class MinuteInboxBridgeTest(unittest.TestCase):
    def test_minutas_nuevas_se_analizan_y_decisiones_se_aplican(self):
        posts, analysed, decided = [], [], []

        class FakeInbox:
            def is_current(self, actor, minute):
                return minute["source_id"] == "ya-analizada"
            def process(self, actor, user, minute, snapshot, ask):
                analysed.append((actor, minute["source_id"], ask("p")))
                return {"id": "g-1", "acciones": [{"auto": True, "estado": "aplicada"}, {"auto": False}], "texto": "privado"}
            def decide(self, actor, user, decision, snapshot, ask):
                decided.append((actor, decision["minuteId"]))
                return {"id": "g-1", "acciones": [], "texto": "privado"}

        class FakeCopilot:
            def ask(self, actor, user, prompt):
                return f"respuesta-{actor}"

        class Granola(FakeGranolaService):
            def sync(self, actor):
                return [{"source_id": "nueva", "version": "v", "title": "N", "date": "2026-10-12", "summary": "s"},
                        {"source_id": "ya-analizada", "version": "v", "title": "V", "date": "2026-10-01", "summary": "s"}]

        def request_json(url, *, token, method="GET", payload=None, timeout=30):
            if method == "POST":
                posts.append((url, payload))
                return {"ok": True}
            if url.endswith("/api/bridge/dispatch"):
                return {"now": 1, "pending": {"demo-a": {"chat": 1}}}
            return {"job": None, "decision": {"id": "d1", "minuteId": "g-1", "decisions": []}}

        granola = Granola()
        granola.ready = {"demo-a"}
        published = []
        bridge = mb.MultiuserBridge(BASE, "bridge-token", load_user=USERS.get, request_json=request_json, process_job=None,
                                    finish_job=None, users_dir=Path("C:/tmp/x"), granola=granola, copilot=FakeCopilot(),
                                    minute_inbox=FakeInbox(), publish_snapshot=lambda base, token, vk, url: published.append(vk))
        bridge.sync_granola(["demo-a"])
        self.assertEqual(analysed, [("demo-a", "nueva", "respuesta-demo-a")], "solo la nueva, con el copiloto del usuario")
        minute_posts = [p for u, p in posts if u.endswith("/api/bridge/minute")]
        self.assertEqual(len(minute_posts), 2, "importación inicial + resultado del análisis (la ya analizada no se pisa)")
        self.assertNotIn("texto", minute_posts[-1], "el texto de la minuta no sale de la VM")
        self.assertEqual(published, ["token-de-A"], "D46: an automatic change is published right away")
        posts.clear()
        bridge.dispatch_once()
        self.assertEqual(decided, [("demo-a", "g-1")])
        done = [p for u, p in posts if u.endswith("/api/bridge/decision-done")]
        self.assertEqual(done, [{"id": "d1"}])
        self.assertEqual(published, ["token-de-A", "token-de-A"], "D46: a decision is published right away too")


class SummaryBridgeTest(unittest.TestCase):
    def test_resumenes_ia_por_usuario(self):
        finished = []

        class FakeCopilot:
            def ask(self, actor, user, prompt):
                assert "Revisar contrato" in prompt and user["vikunjaToken"] == "token-de-A"
                return '{"summaries":[{"id":7,"summary":"Resumen","nextAction":"Firmar","attention":"normal"},{"id":999,"summary":"ajena"}]}'

        def request_json(url, *, token, method="GET", payload=None, timeout=30):
            if "kind=summary" in url:
                return {"job": {"id": "s1", "kind": "summary", "tasks": [{"id": 7, "title": "Revisar contrato"}]}}
            return {"ok": True}
        bridge = mb.MultiuserBridge(BASE, "bridge-token", load_user=USERS.get, request_json=request_json, process_job=None,
                                    finish_job=lambda base, token, job, **kw: finished.append((base, job["id"], kw)),
                                    users_dir=Path("C:/tmp/x"), publish_snapshot=lambda *a, **k: "ts", copilot=FakeCopilot())
        bridge.publish_all(["demo-a"])
        self.assertEqual(finished, [(f"{BASE}/u/demo-a", "s1", {"summaries": [
            {"id": 7, "summary": "Resumen", "nextAction": "Firmar", "attention": "normal"}]})], "solo ids pedidos")


class ExecuteProposalsBridgeTest(unittest.TestCase):
    def test_propuestas_ejecutadas_se_aplican_de_inmediato(self):
        processed, finished = [], []

        class FakeCopilot:
            def answer(self, actor, user, job, snapshot, minutes):
                return 'Hecho.\n```acciones\n[{"action":"task.create","projectId":1,"title":"Nueva","ejecutar":true}]\n```'

        def request_json(url, *, token, method="GET", payload=None, timeout=30):
            if url.endswith("/api/bridge/dispatch") and method == "GET":
                return {"now": 1, "pending": {"demo-a": {"chat": 1}}}
            if "kind=action" in url:
                return {"job": {"id": "act-1", "kind": "action", "action": "task.create"}} if not processed else {"job": None}
            if "kind=chat" in url:
                return {"job": {"id": "chat-1", "kind": "chat", "message": "crea Nueva"}} if not finished else {"job": None}
            return {"ok": True}

        bridge = mb.MultiuserBridge(BASE, "bridge-token", load_user=USERS.get, request_json=request_json,
                                    process_job=lambda job, *a: processed.append(job["id"]),
                                    finish_job=lambda base, token, job, **kw: finished.append(kw), users_dir=Path("C:/tmp/x"),
                                    copilot=FakeCopilot(), fetch_snapshot=lambda user: {"projects": [{"id": 1}], "tasks": []})
        bridge.dispatch_once()
        self.assertEqual(finished[0]["proposals"][0]["execute"], True)
        self.assertEqual(processed, ["act-1"], "the queued action is executed without waiting for the next dispatch")


class CitedMinutesBridgeTest(unittest.TestCase):
    def test_minuta_citada_se_adjunta_para_abrirla(self):
        """D32: the answer carries the text of the user's minutes it cites; D31: the question searches the archive."""
        finished, prompts = [], []
        user = {**USERS["demo-a"], "minuteArchive": [{"id": "g-2", "title": "Comité", "date": "2026-07-01", "summary": "Acuerdo licitación"}]}

        class FakeCopilot:
            def answer(self, actor, user, job, snapshot, minutes):
                prompts.append(minutes)
                return "Ver [Comité](minuta:g-2)."

        def request_json(url, *, token, method="GET", payload=None, timeout=30):
            if url.endswith("/api/bridge/dispatch") and method == "GET":
                return {"now": 1, "pending": {"demo-a": {"chat": 1}}}
            if "kind=chat" in url:
                return {"job": {"id": "chat-1", "kind": "chat", "message": "¿qué pasó con la licitación?"}} if not finished else {"job": None}
            return {"ok": True}

        bridge = mb.MultiuserBridge(BASE, "bridge-token", load_user={"demo-a": user}.get, request_json=request_json,
                                    process_job=lambda *a: None, finish_job=lambda base, token, job, **kw: finished.append(kw),
                                    users_dir=Path("C:/tmp/x"), copilot=FakeCopilot(), fetch_snapshot=lambda u: {"projects": [], "tasks": []})
        bridge.dispatch_once()
        self.assertEqual([m["id"] for m in prompts[0]], ["g-2"])
        self.assertEqual(finished[0]["minutes"], {"g-2": {"titulo": "Comité", "fecha": "2026-07-01", "contenido": "Acuerdo licitación"}})


class ExecuteLabelProposalsBridgeTest(unittest.TestCase):
    def test_etiqueta_pedida_se_aplica_de_inmediato(self):
        """D30: an explicit label request drains the label queue right after the answer."""
        processed, polled = [], []

        class FakeCopilot:
            def answer(self, actor, user, job, snapshot, minutes):
                return 'Hecho.\n```acciones\n[{"action":"label.assign","taskId":5,"labelId":2,"ejecutar":true}]\n```'

        def request_json(url, *, token, method="GET", payload=None, timeout=30):
            if url.endswith("/api/bridge/dispatch") and method == "GET":
                return {"now": 1, "pending": {"demo-a": {"chat": 1}}}
            if "kind=" in url:
                polled.append(url.rsplit("kind=", 1)[1])
            if "kind=label" in url:
                return {"job": {"id": "lab-1", "kind": "label", "action": "assign"}} if not processed else {"job": None}
            if "kind=chat" in url:
                return {"job": {"id": "chat-1", "kind": "chat", "message": "ponle 2"}} if "chat" not in polled[:-1] else {"job": None}
            return {"job": None}

        snapshot = {"projects": [{"id": 1}], "labels": [{"id": 2, "title": "Urgente"}],
                    "tasks": [{"id": 5, "project_id": 1, "done": False, "label_ids": []}]}
        bridge = mb.MultiuserBridge(BASE, "bridge-token", load_user=USERS.get, request_json=request_json,
                                    process_job=lambda job, *a: processed.append(job["id"]),
                                    finish_job=lambda *a, **kw: None, users_dir=Path("C:/tmp/x"),
                                    copilot=FakeCopilot(), fetch_snapshot=lambda user: snapshot)
        bridge.dispatch_once()
        self.assertEqual(processed, ["lab-1"])
        self.assertNotIn("action", polled, "only the queue that received work is drained")


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


class HealthBridgeTest(unittest.TestCase):
    def test_actualizar_ahora_lee_de_verdad_y_prueba_granola(self):
        """D61: a manual refresh publishes a fresh read first. D63: Granola's light reflects a live check."""
        posts, published = [], []

        class Granola(FakeGranolaService):
            healthy = True
            def probe(self, actor):
                self.calls.append(("probe", actor))
                if not self.healthy:
                    raise RuntimeError("token vencido")

        def request_json(url, *, token, method="GET", payload=None, timeout=30):
            posts.append(payload)
            return {"ok": True}

        granola = Granola()
        granola.ready = {"demo-a"}
        bridge = mb.MultiuserBridge(BASE, "bridge-token", load_user=USERS.get, request_json=request_json, process_job=None,
                                    finish_job=None, users_dir=Path("C:/tmp/x"), granola=granola,
                                    publish_snapshot=lambda base, token, vk, url: published.append(vk),
                                    check_vikunja=lambda user: (True, "Vikunja responde"))
        bridge.report_health("demo-a", USERS["demo-a"], {"id": "h1"})
        self.assertEqual(published, ["token-de-A"], "the manual refresh publishes a real read")
        self.assertEqual(posts[-1]["granola"], {**posts[-1]["granola"], "ok": True, "detail": "Granola conectado y respondiendo"})
        granola.healthy = False
        bridge.report_health("demo-a", USERS["demo-a"], {"id": "h2"})
        self.assertFalse(posts[-1]["granola"]["ok"], "connected but not answering is red")
        self.assertNotIn("token vencido", posts[-1]["granola"]["detail"], "no provider details")
        bridge.report_health("demo-a", USERS["demo-a"], {"id": ""})
        self.assertEqual(len(published), 2, "the periodic report does not publish again")
        self.assertEqual(sum(1 for c in granola.calls if c[0] == "probe"), 2, "the periodic report does not probe")
        self.assertFalse(posts[-1]["granola"]["ok"], "it keeps the last real result")


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
