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


if __name__ == "__main__":
    unittest.main()
