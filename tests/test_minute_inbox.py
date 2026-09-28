"""Granola minute processing: evident actions are applied, the rest wait for the user."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "tools" / "minute_inbox.py"
SPEC = importlib.util.spec_from_file_location("dsta_minute_inbox", MODULE_PATH)
inbox = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inbox)


class FakeVikunja:
    """Minimal stand-in for the dashboard MCP helpers."""

    def __init__(self):
        self.tasks = {
            63: {"id": 63, "title": "Solicitar costos a ENAER", "project_id": 3, "done": False,
                 "description": "Responsable: Por confirmar\nDependencia: Por confirmar"},
            9: {"id": 9, "title": "Robot MEDS", "project_id": 3, "done": False, "description": "Detalle: robot"},
        }
        self.created = []

    def request(self, method, path, **kwargs):
        return dict(self.tasks[int(path.rsplit("/", 1)[-1])])

    def update_task_fields(self, task_id, changes, current=None):
        self.tasks[task_id].update(changes)

    def pmo_projects(self):
        return [{"id": 3, "title": "LT1 — AER", "parent_project_id": 2}]

    def is_pmo_line(self, project):
        return project["parent_project_id"] == 2

    def project_tasks(self, project_id):
        return [task for task in self.tasks.values() if task["project_id"] == project_id]

    def pmo_create_task(self, **kwargs):
        self.created.append(kwargs)
        return {"task": {"id": 200}}

    def pmo_move_task(self, task_id, destination):
        self.tasks[task_id]["project_id"] = destination


PLAN = {
    "resumen": "Revisión de LT1.",
    "acciones": [
        {"tipo": "actualizar", "evidente": True, "confianza": "alta", "task_id": 63,
         "nota": "Pendiente de las pruebas del sábado.", "dependencia": "Pruebas de vuelo 03-10",
         "evidencia": "Pendiente pruebas del sábado"},
        {"tipo": "completar", "evidente": False, "confianza": "media", "task_id": 9,
         "nota": "Robot entregado.", "motivo": "No queda claro si hubo entrega formal."},
        {"tipo": "crear", "evidente": True, "confianza": "media", "project_id": 3,
         "titulo": "Coordinar con la Fuerza Aérea", "nota": "Nuevo compromiso."},
        {"tipo": "borrar", "evidente": True, "confianza": "alta", "task_id": 9},
    ],
    "antecedentes": ["Huawei presentará presupuesto."],
}


class MinuteInboxTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Path(self.tmp.name) / "inbox.json"
        self.vk = FakeVikunja()
        self.item = {"source_id": "abc-123", "digest": "d1", "file": "x.md",
                     "meeting_date": "Sep 28, 2026 9:30 AM GMT-3"}
        self.marks = []
        patches = [
            patch.object(inbox, "minute_ref", return_value=("Minutas 2026/x.md", "Reunión Directores")),
            patch.object(inbox, "mark_queue", side_effect=lambda item, status, report: self.marks.append(status)),
            patch.object(inbox, "REPORTS", Path(self.tmp.name) / "reports"),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def process(self, plan=PLAN):
        return inbox.process_item(self.item, lambda prompt: "Plan:\n" + json.dumps(plan), self.vk, self.store)

    def test_only_evident_high_confidence_actions_are_applied(self):
        record = self.process()
        self.assertEqual([a["tipo"] for a in record["acciones"]], ["actualizar", "completar", "crear"],
                         "unknown operations are discarded")
        update, close, create = record["acciones"]
        self.assertEqual(update["estado"], "aplicada")
        self.assertIn("Actualización 2026-09-28: Pendiente de las pruebas del sábado.", self.vk.tasks[63]["description"])
        self.assertIn("Dependencia: Pruebas de vuelo 03-10", self.vk.tasks[63]["description"])
        self.assertEqual(close["estado"], "propuesta")
        self.assertFalse(self.vk.tasks[9]["done"])
        self.assertEqual(create["estado"], "propuesta", "medium confidence waits for the user")
        self.assertEqual(self.vk.created, [])
        self.assertEqual(record["estado"], "por_revisar")
        self.assertEqual(self.marks, ["awaiting_user"])
        self.assertTrue(any(Path(self.tmp.name, "reports").glob("abc-123-d1.md")))

    def test_minute_without_proposals_is_processed(self):
        plan = {"resumen": "Sin relación con PMO.", "acciones": [], "antecedentes": []}
        self.assertEqual(self.process(plan)["estado"], "procesada")
        self.assertEqual(self.marks, ["processed"])

    def test_user_decisions_apply_edits_and_rejections(self):
        self.process()
        record = inbox.apply_decision(self.store, {"minuteId": "abc-123", "decisions": [
            {"actionId": "a2", "decision": "aprobar", "edits": {"nota": "Entrega confirmada por Nelson."}},
            {"actionId": "a3", "decision": "rechazar"},
            {"actionId": "a1", "decision": "rechazar"},  # already applied automatically: ignored
        ]}, self.vk)
        close, create = record["acciones"][1], record["acciones"][2]
        self.assertEqual(close["estado"], "aplicada")
        self.assertTrue(self.vk.tasks[9]["done"])
        self.assertIn("Cierre 2026-09-28: Entrega confirmada por Nelson.", self.vk.tasks[9]["description"])
        self.assertEqual(create["estado"], "rechazada")
        self.assertEqual(record["acciones"][0]["estado"], "aplicada")
        self.assertEqual(record["estado"], "procesada")
        self.assertEqual(self.marks, ["awaiting_user", "processed"])

    def test_creation_rejects_duplicates_and_reports_the_error(self):
        plan = {"acciones": [{"tipo": "crear", "evidente": True, "confianza": "alta", "project_id": 3,
                              "titulo": "Robot MEDS", "nota": "x"}]}
        record = self.process(plan)
        action = record["acciones"][0]
        self.assertEqual(action["estado"], "error")
        self.assertIn("#9", action["resultado"])
        self.assertFalse(action.get("auto"), "a failed automatic action returns to the user")
        self.assertEqual(record["estado"], "por_revisar")

    def test_evident_creation_uses_traceable_action_key(self):
        plan = {"acciones": [{"tipo": "crear", "evidente": True, "confianza": "alta", "project_id": 3,
                              "titulo": "Coordinar con la Fuerza Aérea", "nota": "Compromiso nuevo",
                              "fecha_objetivo": "3 de octubre"}]}
        self.process(plan)
        created = self.vk.created[0]
        self.assertEqual(created["action_key"], "granola-abc-123-coordinar-con-la-fuerza-aerea")
        self.assertEqual(created["source"], "Granola abc-123")
        self.assertEqual(created["target_date"], "", "non ISO dates are dropped, never invented")

    def test_pending_items_keep_accented_file_names(self):
        queue = Path(self.tmp.name) / "queue.json"
        name = str(Path(self.tmp.name) / "2026-09-28-reunión-con-maría.md")
        queue.write_text(json.dumps({"items": {
            "a": {"source_id": "a", "status": "pending_review", "file": name},
            "b": {"source_id": "b", "status": "processed", "file": "x.md"},
        }}, ensure_ascii=False), encoding="utf-8")
        with patch.object(inbox, "QUEUE_PATH", queue):
            self.assertEqual([item["file"] for item in inbox.pending_items()], [name])

    def test_stray_quotes_inside_texts_are_repaired(self):
        output = '{"resumen":"ok","acciones":[{"tipo":"comentar","evidente":false,"task_id":9,' \
                 '"nota":"Nelson dijo "en standby" hasta octubre","evidencia":"el "robot""}]}'
        action = inbox.parse_plan(output)["acciones"][0]
        self.assertEqual(action["nota"], 'Nelson dijo "en standby" hasta octubre')
        self.assertEqual(action["evidencia"], 'el "robot"')

    def test_invalid_model_output_is_retried_once(self):
        answers = iter(['{"acciones": [ {"tipo": "comentar", } ]}', json.dumps({"resumen": "ok", "acciones": []})])
        prompts = []
        record = inbox.process_item(self.item, lambda prompt: prompts.append(prompt) or next(answers), self.vk, self.store)
        self.assertEqual(record["resumen"], "ok")
        self.assertIn("no fue JSON válido", prompts[1])
        with self.assertRaises(ValueError):
            inbox.process_item(self.item, lambda prompt: "no hay json", self.vk, self.store)


if __name__ == "__main__":
    unittest.main()
