import os
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import call, patch

os.environ["VIKUNJA_API_TOKEN"] = "test-token-only"

MODULE_PATH = Path(__file__).resolve().parents[1] / "tools" / "vikunja_dashboard_mcp.py"
MODULE_SPEC = importlib.util.spec_from_file_location("dsta_vikunja_dashboard_mcp", MODULE_PATH)
dashboard_mcp = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(dashboard_mcp)


def sample_task():
    return {
        "id": 17,
        "title": "Seguimiento",
        "description": "Bitácora existente\nDependencia: LT2",
        "project_id": 3,
        "done": False,
        "due_date": "2026-10-01T00:00:00Z",
        "reminders": [{"reminder": "2026-09-30T00:00:00Z", "relative_period": 0, "relative_to": ""}],
        "repeat_after": 0,
        "repeat_mode": 0,
        "priority": 3,
        "start_date": "0001-01-01T00:00:00Z",
        "end_date": "0001-01-01T00:00:00Z",
        "assignees": [{"id": 25, "username": "responsable"}],
        "hex_color": "123456",
        "percent_done": 0.25,
        "cover_image_attachment_id": 8,
        "is_favorite": True,
    }


class SafeTaskUpdateTests(unittest.TestCase):
    def test_partial_update_preserves_every_unmodified_field(self):
        current = sample_task()
        payload = dashboard_mcp.task_update_payload(17, current, {"title": "Título actualizado"})

        self.assertEqual(payload["title"], "Título actualizado")
        for field in dashboard_mcp.TASK_UPDATE_FIELDS:
            if field != "title":
                self.assertEqual(payload[field], current[field], field)

    def test_update_fetches_current_task_before_posting(self):
        current = sample_task()
        with patch.object(dashboard_mcp, "request", side_effect=[current, {"ok": True}]) as mocked:
            dashboard_mcp.pmo_update_task(17, priority=5)

        self.assertEqual(mocked.call_args_list[0], call("GET", "/api/v1/tasks/17"))
        posted = mocked.call_args_list[1]
        self.assertEqual(posted.args, ("POST", "/api/v1/tasks/17"))
        self.assertEqual(posted.kwargs["json"]["priority"], 5)
        self.assertEqual(posted.kwargs["json"]["description"], current["description"])
        self.assertEqual(posted.kwargs["json"]["assignees"], current["assignees"])
        self.assertEqual(posted.kwargs["json"]["reminders"], current["reminders"])
        self.assertTrue(posted.kwargs["json"]["is_favorite"])

    def test_complete_preserves_description_and_other_fields(self):
        current = sample_task()
        with patch.object(dashboard_mcp, "request", side_effect=[current, {"ok": True}]) as mocked:
            dashboard_mcp.pmo_complete_task(17)

        payload = mocked.call_args_list[1].kwargs["json"]
        self.assertTrue(payload["done"])
        self.assertEqual(payload["description"], current["description"])
        self.assertEqual(payload["priority"], current["priority"])
        self.assertEqual(payload["reminders"], current["reminders"])

    def test_dependency_change_preserves_description_history_and_task_fields(self):
        current = sample_task()
        with patch.object(dashboard_mcp, "request", side_effect=[current, {"ok": True}]) as mocked:
            dashboard_mcp.pmo_set_dependency(17, "LT4")

        payload = mocked.call_args_list[1].kwargs["json"]
        self.assertEqual(payload["description"], "Bitácora existente\nDependencia: LT4")
        self.assertEqual(payload["due_date"], current["due_date"])
        self.assertEqual(payload["priority"], current["priority"])
        self.assertEqual(payload["assignees"], current["assignees"])

    def test_incomplete_get_response_fails_closed_before_post(self):
        incomplete = sample_task()
        del incomplete["reminders"]
        with patch.object(dashboard_mcp, "request", return_value=incomplete) as mocked:
            with self.assertRaisesRegex(RuntimeError, "No se aplicó el cambio"):
                dashboard_mcp.pmo_complete_task(17)

        mocked.assert_called_once_with("GET", "/api/v1/tasks/17")


class CreateTaskTests(unittest.TestCase):
    def test_create_task_requires_project_in_pmo_scope_and_verifies_result(self):
        projects = [
            {"id": 2, "title": "PMO-DSTA", "parent_project_id": 0},
            {"id": 13, "title": "LT3 - Estrategia", "parent_project_id": 2},
        ]
        created = {"id": 99, "project_id": 13, "title": "Acordar alcance", "description": "Responsable: Ana"}
        with patch.object(dashboard_mcp, "request", side_effect=[projects, created, created]) as mocked:
            result = dashboard_mcp.pmo_create_task(
                project_id=13, title="Acordar alcance", owner="Ana", dependency="LT2",
                target_date="2026-10-20", closure_criterion="Alcance aprobado",
            )

        self.assertEqual(result["task"]["id"], 99)
        self.assertEqual(mocked.call_args_list[0], call("GET", "/api/v1/projects"))
        posted = mocked.call_args_list[1]
        self.assertEqual(posted.args, ("PUT", "/api/v1/projects/13/tasks"))
        self.assertIn("Responsable: Ana", posted.kwargs["json"]["description"])
        self.assertIn("Dependencia: LT2", posted.kwargs["json"]["description"])
        self.assertIn("Criterio de cierre: Alcance aprobado", posted.kwargs["json"]["description"])
        self.assertEqual(mocked.call_args_list[2], call("GET", "/api/v1/tasks/99"))

    def test_create_task_rejects_project_outside_pmo_scope(self):
        projects = [{"id": 7, "title": "Personal", "parent_project_id": 0}]
        with patch.object(dashboard_mcp, "request", return_value=projects) as mocked:
            with self.assertRaisesRegex(ValueError, "proyecto PMO-DSTA"):
                dashboard_mcp.pmo_create_task(project_id=7, title="Nueva tarea")
        mocked.assert_called_once_with("GET", "/api/v1/projects")


class CreateProjectTests(unittest.TestCase):
    def test_create_lt_project_under_pmo_root_and_verify_result(self):
        projects = [{"id": 2, "title": "PMO-DSTA", "parent_project_id": 0}]
        created = {"id": 13, "title": "LT3 - Estrategia", "parent_project_id": 2}
        with patch.object(dashboard_mcp, "request", side_effect=[projects, created, created]) as mocked:
            result = dashboard_mcp.pmo_create_project("LT3 - Estrategia", "Descripción ejecutiva")

        self.assertEqual(result["project"]["id"], 13)
        posted = mocked.call_args_list[1]
        self.assertEqual(posted.args, ("PUT", "/api/v1/projects"))
        self.assertEqual(posted.kwargs["json"], {
            "title": "LT3 - Estrategia", "description": "Descripción ejecutiva", "parent_project_id": 2,
        })
        self.assertEqual(mocked.call_args_list[2], call("GET", "/api/v1/projects/13"))

    def test_create_project_fails_closed_when_pmo_root_is_missing(self):
        with patch.object(dashboard_mcp, "request", return_value=[]) as mocked:
            with self.assertRaisesRegex(RuntimeError, "proyecto raíz PMO-DSTA"):
                dashboard_mcp.pmo_create_project("LT3 - Estrategia")
        mocked.assert_called_once_with("GET", "/api/v1/projects")

    def test_create_project_rejects_duplicate_and_invalid_line(self):
        projects = [{"id": 2, "title": "PMO-DSTA", "parent_project_id": 0},
                    {"id": 13, "title": "LT3 — Estrategia", "parent_project_id": 2}]
        with patch.object(dashboard_mcp, "request", return_value=projects) as mocked:
            with self.assertRaisesRegex(ValueError, "ya existe"):
                dashboard_mcp.pmo_create_project("LT3 — Otra iniciativa")
            with self.assertRaisesRegex(ValueError, "LT1-LT7 o Transversal"):
                dashboard_mcp.pmo_create_project("LT9 - Inventada")
        mocked.assert_called_once_with("GET", "/api/v1/projects")


if __name__ == "__main__":
    unittest.main()
