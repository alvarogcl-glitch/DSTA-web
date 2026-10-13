"""Creation queries must be complete, compact and use Santiago calendar days."""
from datetime import datetime as real_datetime
import unittest
from unittest.mock import call, patch

from test_vikunja_dashboard_mcp import dashboard_mcp, sample_project
from test_hermes_bridge import bridge


def task(task_id, created, **fields):
    return {"id": task_id, "title": f"Tarea {task_id}", "created": created,
            "done": False, "description": "Bitácora extensa" * 1000, **fields}


class CreatedTaskTests(unittest.TestCase):
    def test_day_boundaries_and_updates_are_not_creations(self):
        rows = [
            task(1, "2026-10-13T02:59:59Z", updated="2026-10-13T15:00:00Z"),
            task(2, "2026-10-13T03:00:00Z"),
            task(3, "2026-10-14T02:59:59Z", done=True),
            task(4, "2026-10-14T03:00:00Z"),
        ]
        with patch.object(dashboard_mcp, "pmo_projects", return_value=[sample_project()]), \
             patch.object(dashboard_mcp, "project_tasks", return_value=rows):
            result = dashboard_mcp.pmo_tasks_created("2026-10-13")
        self.assertEqual(result["total"], 2)
        self.assertEqual([t["id"] for t in result["tasks"]], [2, 3])
        self.assertTrue(result["tasks"][1]["done"])
        self.assertNotIn("description", result["tasks"][0])
        self.assertEqual(result["tasks"][0]["created"], "2026-10-13T00:00:00-03:00")

    def test_winter_offset_and_inclusive_range(self):
        rows = [task(1, "2026-07-13T03:59:59Z"), task(2, "2026-07-13T04:00:00Z"),
                task(3, "2026-07-15T03:59:59Z"), task(4, "2026-07-15T04:00:00Z")]
        with patch.object(dashboard_mcp, "pmo_projects", return_value=[sample_project()]), \
             patch.object(dashboard_mcp, "project_tasks", return_value=rows):
            result = dashboard_mcp.pmo_tasks_created("2026-07-13", "2026-07-14")
        self.assertEqual([t["id"] for t in result["tasks"]], [2, 3])
        self.assertTrue(result["tasks"][0]["created"].endswith("-04:00"))

    def test_today_uses_santiago_not_host_day(self):
        with patch.object(dashboard_mcp, "datetime") as clock, \
             patch.object(dashboard_mcp, "pmo_projects", return_value=[]):
            clock.now.return_value = real_datetime(2026, 10, 12, 23, 30)
            result = dashboard_mcp.pmo_tasks_created()
        self.assertEqual(clock.now.call_args.args[0].key, "America/Santiago")
        self.assertEqual(result["start_date"], "2026-10-12")
        self.assertEqual(result["total"], 0)
        self.assertTrue(result["total_is_exact"])

    def test_all_api_pages_and_all_active_lines_are_scanned(self):
        projects = [sample_project(), sample_project(19, "TR1"),
                    {**sample_project(20), "is_archived": True},
                    {**sample_project(21), "parent_project_id": 0}]
        old = [task(i, "2026-10-12T15:00:00Z") for i in range(1, 101)]
        with patch.object(dashboard_mcp, "pmo_projects", return_value=projects), \
             patch.object(dashboard_mcp, "request", side_effect=[
                 old[:50], old[50:], [task(101, "2026-10-13T15:00:00Z")], [],
                 [task(102, "2026-10-13T16:00:00Z")], []]) as request:
            result = dashboard_mcp.pmo_tasks_created("2026-10-13")
        self.assertEqual(result["total"], 2)
        self.assertEqual(request.call_args_list, [
            call("GET", "/api/v1/projects/13/tasks", params={"page": 1, "per_page": 50}),
            call("GET", "/api/v1/projects/13/tasks", params={"page": 2, "per_page": 50}),
            call("GET", "/api/v1/projects/13/tasks", params={"page": 3, "per_page": 50}),
            call("GET", "/api/v1/projects/13/tasks", params={"page": 4, "per_page": 50}),
            call("GET", "/api/v1/projects/19/tasks", params={"page": 1, "per_page": 50}),
            call("GET", "/api/v1/projects/19/tasks", params={"page": 2, "per_page": 50}),
        ])

    def test_compact_response_pages_preserve_exact_total(self):
        rows = [task(i, "2026-10-13T15:00:00Z") for i in range(1, 62)]
        with patch.object(dashboard_mcp, "pmo_projects", return_value=[sample_project()]), \
             patch.object(dashboard_mcp, "project_tasks", return_value=rows):
            first = dashboard_mcp.pmo_tasks_created("2026-10-13")
            second = dashboard_mcp.pmo_tasks_created("2026-10-13", offset=first["next_offset"])
        self.assertEqual(first["total"], 61)
        self.assertEqual(second["total"], 61)
        self.assertEqual(len(first["tasks"]), 50)
        self.assertTrue(first["has_more"])
        self.assertFalse(second["has_more"])
        self.assertIsNone(second["next_offset"])
        self.assertEqual([t["id"] for t in first["tasks"] + second["tasks"]], list(range(1, 62)))

    def test_invalid_dates_and_scope_fail_before_reading_tasks(self):
        with patch.object(dashboard_mcp, "pmo_projects", return_value=[sample_project()]), \
             patch.object(dashboard_mcp, "project_tasks") as read:
            for kwargs in ({"start_date": "bad"}, {"start_date": "2026-10-13", "end_date": "2026-10-12"},
                           {"offset": -1}, {"limit": 51}, {"project_id": 99}):
                with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                    dashboard_mcp.pmo_tasks_created(**kwargs)
        read.assert_not_called()

    def test_project_filter_only_reads_requested_line(self):
        with patch.object(dashboard_mcp, "pmo_projects", return_value=[sample_project(), sample_project(19)]), \
             patch.object(dashboard_mcp, "project_tasks", return_value=[]) as read:
            dashboard_mcp.pmo_tasks_created("2026-10-13", project_id=19)
        read.assert_called_once_with(19, until_empty=True)

    def test_server_page_cap_does_not_hide_matches(self):
        with patch.object(dashboard_mcp, "pmo_projects", return_value=[sample_project()]), \
             patch.object(dashboard_mcp, "request", side_effect=[
                 [task(1, "2026-10-12T15:00:00Z")],
                 [task(2, "2026-10-13T15:00:00Z")], []]) as request:
            result = dashboard_mcp.pmo_tasks_created("2026-10-13")
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["tasks"][0]["id"], 2)
        self.assertEqual(request.call_count, 3)

    def test_unfinished_pagination_does_not_report_a_partial_count(self):
        with patch.object(dashboard_mcp, "pmo_projects", return_value=[sample_project()]), \
             patch.object(dashboard_mcp, "request", return_value=[task(1, "2026-10-13T15:00:00Z")]), \
             self.assertRaisesRegex(RuntimeError, "paginación de tareas no terminó"):
            dashboard_mcp.pmo_tasks_created("2026-10-13")

    def test_unknown_creation_and_failed_pages_cannot_produce_false_total(self):
        with patch.object(dashboard_mcp, "pmo_projects", return_value=[sample_project()]):
            for created in ("", "invalid", "2026-10-13T00:00:00", "0001-01-01T00:00:00Z"):
                with self.subTest(created=created), \
                     patch.object(dashboard_mcp, "project_tasks", return_value=[task(1, created)]), \
                     self.assertRaisesRegex(RuntimeError, "no se puede confirmar el total"):
                    dashboard_mcp.pmo_tasks_created("2026-10-13")
            with patch.object(dashboard_mcp, "request", side_effect=[
                    [task(i, "2026-10-13T15:00:00Z") for i in range(50)], RuntimeError("API error")]), \
                 self.assertRaisesRegex(RuntimeError, "API error"):
                dashboard_mcp.pmo_tasks_created("2026-10-13")

    def test_tool_is_registered_and_read_only(self):
        names = {t.name for t in dashboard_mcp.mcp._tool_manager.list_tools()}
        self.assertIn("pmo_tasks_created", names)
        self.assertIn("pmo_tasks_created", dashboard_mcp.READ_ONLY_TOOLS)

    def test_chat_prompt_routes_creation_queries_and_continuation(self):
        prompt = bridge.chat_prompt({"message": "¿Qué tareas se crearon hoy?"})
        for text in ("pmo_tasks_created", "America/Santiago", "next_offset", "total exacto",
                     "una actualización", "abiertas y completadas"):
            self.assertIn(text, prompt)


if __name__ == "__main__":
    unittest.main()
