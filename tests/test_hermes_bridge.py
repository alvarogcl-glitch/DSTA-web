"""Hermes subprocesses must not create a visible console on Windows."""

import importlib.util
import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "tools" / "hermes_bridge.py"
SPEC = importlib.util.spec_from_file_location("dsta_hermes_bridge", MODULE_PATH)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class HermesWindowTests(unittest.TestCase):
    def test_chat_hides_console(self):
        completed = subprocess.CompletedProcess([], 0, stdout="Hola")
        with patch.object(bridge.subprocess, "run", return_value=completed) as run:
            self.assertEqual(
                bridge.run_hermes({"message": "hola"}, "hermes", Path.cwd(),
                                  "openai-codex", "gpt-6-luna"),
                "Hola",
            )
        expected = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.assertEqual(run.call_args.kwargs["creationflags"], expected)
        prompt = run.call_args.args[0][-1]
        self.assertIn("pmo_create_task", prompt)
        self.assertIn("pmo_create_project", prompt)
        self.assertIn("pmo_merge_projects", prompt)
        self.assertIn("no una lista fija LT1-LT7", prompt)

    def test_summaries_hide_console(self):
        output = '{"summaries":[{"id":1,"summary":"Pendiente","nextAction":"","attention":"normal"}]}'
        completed = subprocess.CompletedProcess([], 0, stdout=output)
        with patch.object(bridge.subprocess, "run", return_value=completed) as run:
            summaries = bridge.run_summarizer(
                {"tasks": [{"id": 1, "title": "Tarea"}]}, "hermes", Path.cwd(),
                "openai-codex", "gpt-6-luna",
            )
        self.assertEqual(len(summaries), 1)
        expected = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.assertEqual(run.call_args.kwargs["creationflags"], expected)
    def test_chat_rebuilds_snapshot_before_reporting_completion(self):
        job = {"id": "test-id", "kind": "chat", "message": "crear tarea"}
        snapshot = {"timestamp": "2026-09-25T14:00:00Z", "projects": [], "tasks": []}
        events = []
        with patch.object(bridge, "run_hermes", return_value="Tarea creada"), \
             patch.object(bridge, "fetch_dashboard", return_value=snapshot), \
             patch.object(bridge, "request_json", side_effect=lambda url, **kw: events.append((url, kw.get("payload"))) or {"ok": True}):
            bridge.process_job(job, "https://example.com", "bridge", "hermes", Path.cwd(),
                               "openai-codex", "gpt-6-luna", vikunja_token="vikunja")
        self.assertEqual(events[0][0], "https://example.com/api/bridge/snapshot")
        self.assertEqual(events[0][1], snapshot)
        self.assertEqual(events[1][0], "https://example.com/api/bridge/complete")
        self.assertEqual(events[1][1]["reply"], "Tarea creada")
        self.assertEqual(events[1][1]["snapshotTimestamp"], snapshot["timestamp"])

    def test_failed_snapshot_does_not_hide_successful_action(self):
        job = {"id": "test-id", "kind": "chat", "message": "crear tarea"}
        events = []
        with patch.object(bridge, "run_hermes", return_value="Tarea creada"), \
             patch.object(bridge, "fetch_dashboard", side_effect=OSError("offline")), \
             patch.object(bridge, "request_json", side_effect=lambda url, **kw: events.append(kw.get("payload")) or {"ok": True}):
            bridge.process_job(job, "https://example.com", "bridge", "hermes", Path.cwd(),
                               "openai-codex", "gpt-6-luna", vikunja_token="vikunja")
        self.assertEqual(events[0]["reply"], "Tarea creada")
        self.assertTrue(events[0]["refreshError"])


if __name__ == "__main__":
    unittest.main()
