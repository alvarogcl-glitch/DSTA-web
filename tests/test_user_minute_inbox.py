"""Bandeja de minutas por usuario, igual que la del CEO: análisis → acciones evidentes automáticas y
propuestas para revisar; decisiones (aprobar/rechazar/descartar). Escribe en Vikunja SOLO con el
token y la raíz del usuario (canario contra el token del CEO)."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location("user_minute_inbox", TOOLS / "user_minute_inbox.py")
umi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(umi)

USER = {"vikunjaUrl": "http://127.0.0.1:14701", "vikunjaToken": "token-de-paula", "rootProjectId": 77}
SNAP = {"projects": [{"id": 8, "title": "LT Clientes"}],
        "tasks": [{"id": 81, "title": "Propuesta comercial", "project_id": 8, "done": False, "owner": "Paula"}]}
MINUTE = {"source_id": "meet-9", "version": "v1", "title": "Comité clientes", "date": "2026-10-12",
          "summary": "Se envió la propuesta comercial.", "private_notes": "Llamar a Rodrigo el jueves."}
PLAN = {"resumen": "Avance en propuesta.", "antecedentes": ["contexto"], "acciones": [
    {"tipo": "actualizar", "evidente": True, "confianza": "alta", "task_id": 81, "nota": "Propuesta enviada",
     "evidencia": "Se envió la propuesta", "motivo": "explícito"},
    {"tipo": "crear", "evidente": False, "confianza": "media", "project_id": 8, "titulo": "Llamar a Rodrigo",
     "nota": "seguimiento", "evidencia": "Llamar a Rodrigo", "motivo": "dudoso"},
]}


class UserMinuteInboxTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.prompts, self.applied = [], []

        def ask(prompt):
            self.prompts.append(prompt)
            return json.dumps(PLAN)

        def apply(action, minute, vk):
            self.applied.append((action["tipo"], vk))
            action["estado"], action["resultado"] = "aplicada", "ok"
        self.inbox = umi.UserMinuteInbox(self.dir, vk_factory=lambda user: f"vk:{user['vikunjaToken']}", apply=apply)
        self.ask = ask

    def test_analiza_aplica_evidentes_y_deja_propuestas(self):
        record = self.inbox.process("paula", USER, MINUTE, SNAP, self.ask)
        self.assertEqual(record["estado"], "por_revisar")
        auto = [a for a in record["acciones"] if a.get("auto")]
        pending = [a for a in record["acciones"] if not a.get("auto")]
        self.assertEqual([a["tipo"] for a in auto], ["actualizar"])
        self.assertEqual([a["estado"] for a in pending], ["propuesta"])
        self.assertEqual(self.applied, [("actualizar", "vk:token-de-paula")], "escribe con la credencial de la usuaria")
        prompt = self.prompts[0]
        for expected in ("Propuesta comercial", "#81", "Se envió la propuesta comercial", "Llamar a Rodrigo el jueves"):
            self.assertIn(expected, prompt)
        self.assertNotIn("minutas_leer", prompt, "sin herramientas: el contexto va en el prompt")
        self.assertNotIn("Álvaro", prompt)
        self.assertRegex(record["id"], r"^[\w-]{1,80}$")
        self.assertNotIn("Llamar a Rodrigo el jueves", json.dumps(umi.public_record(record)), "notas privadas no van al Worker")

    def test_no_reprocesa_la_misma_version(self):
        self.inbox.process("paula", USER, MINUTE, SNAP, self.ask)
        self.assertIsNone(self.inbox.process("paula", USER, MINUTE, SNAP, self.ask))
        self.assertEqual(len(self.prompts), 1)
        self.assertTrue(self.inbox.is_current("paula", MINUTE))

    def test_decisiones_aprobar_rechazar_y_descartar(self):
        record = self.inbox.process("paula", USER, MINUTE, SNAP, self.ask)
        proposal = next(a for a in record["acciones"] if not a.get("auto"))
        decided = self.inbox.decide("paula", USER, {"minuteId": record["id"], "decisions": [
            {"actionId": proposal["id"], "decision": "aprobar", "edits": {"titulo": "Llamar a Rodrigo (jueves)"}}]}, SNAP, self.ask)
        self.assertEqual(decided["estado"], "procesada")
        self.assertEqual(self.applied[-1][0], "crear")
        again = self.inbox.process("paula", USER, {**MINUTE, "version": "v2"}, SNAP, self.ask)
        dropped = self.inbox.decide("paula", USER, {"minuteId": again["id"], "decision": "descartar", "digest": again["digest"]}, SNAP, self.ask)
        self.assertEqual(dropped["estado"], "descartada")
        self.assertIsNone(self.inbox.process("paula", USER, {**MINUTE, "version": "v3"}, SNAP, self.ask), "descartada sigue fuera")

    def test_cada_usuario_tiene_su_propia_bandeja(self):
        self.inbox.process("paula", USER, MINUTE, SNAP, self.ask)
        self.assertFalse(self.inbox.is_current("alvaro", MINUTE))
        self.assertTrue((self.dir / "paula" / "minute-inbox.json").exists())


class UserVikunjaModuleTest(unittest.TestCase):
    def test_canario_nunca_usa_el_token_del_ceo(self):
        os.environ["VIKUNJA_API_TOKEN"] = "TOKEN-DEL-CEO-CANARIO"
        try:
            vk = umi.user_vk(USER)
            self.assertEqual(vk.TOKEN, "token-de-paula")
            self.assertEqual(vk.BASE_URL, "http://127.0.0.1:14701")
            self.assertEqual(vk.PMO_ROOT_PROJECT_ID, 77)
            sent = {}

            class FakeClient:
                def __init__(self, base_url, headers, timeout):
                    sent.update(base_url=base_url, auth=headers["Authorization"])
                def __enter__(self): return self
                def __exit__(self, *a): return False
                def request(self, method, path, **kwargs):
                    class R:
                        status_code = 200
                        def raise_for_status(self): pass
                        def json(self): return []
                        content = b"[]"
                    return R()
            vk.httpx.Client = FakeClient
            vk.request("GET", "/api/v1/projects")
            self.assertEqual(sent["auth"], "Bearer token-de-paula")
            self.assertNotIn("CEO", sent["auth"])
            self.assertEqual(os.environ["VIKUNJA_API_TOKEN"], "TOKEN-DEL-CEO-CANARIO", "el entorno del proceso no se altera")
        finally:
            os.environ.pop("VIKUNJA_API_TOKEN", None)


if __name__ == "__main__":
    unittest.main()
