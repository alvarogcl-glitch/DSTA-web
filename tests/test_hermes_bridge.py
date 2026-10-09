"""Hermes subprocesses must not create a visible console on Windows."""

import importlib.util
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "tools" / "hermes_bridge.py"
SPEC = importlib.util.spec_from_file_location("dsta_hermes_bridge", MODULE_PATH)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class HermesWindowTests(unittest.TestCase):
    def test_whole_minute_discard_does_not_access_vikunja_or_publish_snapshot(self):
        decision = {"id": "decision-1", "minuteId": "minute-1", "decision": "descartar"}
        record = {"id": "minute-1", "estado": "descartada"}
        with patch.object(bridge.minute_inbox, "load_vikunja") as load, \
             patch.object(bridge.minute_inbox, "apply_decision", return_value=record) as apply, \
             patch.object(bridge, "push_minute") as push, \
             patch.object(bridge, "publish_snapshot") as snapshot, \
             patch.object(bridge, "request_json") as ack:
            bridge.process_decision(decision, "https://example.test", "test-token", Path("home"), "", "")
        load.assert_not_called()
        snapshot.assert_not_called()
        self.assertIsNone(apply.call_args.args[2])
        push.assert_called_once_with("https://example.test", "test-token", record)
        self.assertEqual(ack.call_args.kwargs["payload"], {"id": "decision-1", "error": ""})

    def test_chat_hides_console(self):
        with patch.object(bridge.subprocess, "Popen", wraps=subprocess.Popen) as popen, \
             tempfile.TemporaryDirectory() as home:
            bridge.run_watched([sys.executable, "-c", "print('Hola')"], cwd=Path(home), env=os.environ.copy(),
                               timeout=30, log_path=Path(home) / "agent.log")
        expected = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.assertEqual(popen.call_args.kwargs["creationflags"], expected)

    def test_chat_prompt_lists_scoped_tools(self):
        prompt = bridge.chat_prompt({"message": "Clasificar tarea", "history": []})
        for name in ("pmo_list_labels", "pmo_list_label_tasks", "pmo_create_label", "pmo_update_label",
                     "pmo_delete_label", "pmo_edit_task_labels"):
            self.assertIn(name, prompt)
        with patch.object(bridge, "run_watched", return_value=(0, "Hola", False)) as run:
            self.assertEqual(
                bridge.run_hermes({"message": "hola"}, "hermes", Path.cwd(),
                                  "openai-codex", "gpt-6-luna"),
                "Hola",
            )
        prompt = run.call_args.args[0][-1]
        self.assertIn("pmo_create_task", prompt)
        self.assertIn("pmo_create_project", prompt)
        self.assertIn("pmo_merge_projects", prompt)
        self.assertIn("no una lista fija LT1-LT7", prompt)

    def test_summaries_use_codex_without_tools(self):
        bridge._codex_retry_at = 0.0
        output = '{"summaries":[{"id":1,"summary":"Pendiente","nextAction":"","attention":"normal"}]}'
        with patch.object(bridge, "run_watched", return_value=(0, output, False)) as run:
            summaries = bridge.run_summarizer(
                {"tasks": [{"id": 1, "title": "Tarea"}]}, "hermes", Path.cwd(),
                "openai-codex", "gpt-6-luna",
            )
        self.assertEqual(len(summaries), 1)
        self.assertIn("--safe-mode", run.call_args.args[0])

    def test_summaries_fall_back_to_claude_without_tools(self):
        bridge._codex_retry_at = 0.0
        output = '```json\n{"summaries":[{"id":1,"summary":"Resumen Claude","attention":"seguimiento"}]}\n```'
        completed = subprocess.CompletedProcess([], 0, stdout=output)
        with patch.object(bridge, "run_watched", return_value=(1, "", True)),              patch.object(bridge.subprocess, "run", return_value=completed) as run,              tempfile.TemporaryDirectory() as home:
            summaries = bridge.run_summarizer(
                {"tasks": [{"id": 1, "title": "Tarea"}]}, "hermes", Path(home),
                "openai-codex", "gpt-6-luna", "claude.exe", "sonnet",
            )
        self.assertEqual(summaries[0]["summary"], "Resumen Claude")
        args = run.call_args.args[0]
        self.assertEqual(args[args.index("--tools") + 1], "")
        self.assertIn("--strict-mcp-config", args)
        self.assertNotIn("--mcp-config", args)
        self.assertIn("Tarea", run.call_args.kwargs["input"])
        bridge._codex_retry_at = 0.0

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

    def test_reply_hides_reasoning_panel_and_terminal_codes(self):
        stdout = (
            "\x1b[2;3m┌─ Reasoning ─────────────┐\x1b[0m\n"
            "\x1b[2;3mEl usuario pregunta por LT1.\x1b[0m\n"
            "\x1b[2;3m1. Consultar Vikunja\nEl usuario pregunta por LT1.\x1b[0m\n"
            "<think>paso interno</think>\n"
            "LT1 tiene 10 tareas abiertas.\n\n"
            "Session ID: 20260928_181932_451e42\n"
        )
        self.assertEqual(bridge.clean_reply(stdout), "LT1 tiene 10 tareas abiertas.")

    def test_chat_can_read_meeting_minutes(self):
        with patch.object(bridge, "run_watched", return_value=(0, "Hola", False)) as run:
            bridge.run_hermes({"message": "hola"}, "hermes", Path.cwd(), "openai-codex", "gpt-6-luna")
        args = run.call_args.args[0]
        self.assertIn("dsta-minutas", args[args.index("--toolsets") + 1])
        self.assertIn("minutas_buscar", args[-1])

    def test_watcher_stops_hermes_when_it_switches_to_local_model(self):
        with tempfile.TemporaryDirectory() as home:
            log = Path(home) / "agent.log"
            log.write_text("línea previa\n", encoding="utf-8")
            script = (f"import time; open(r'{log}','a').write('Fallback activated: gpt-6-luna -> qwen\\n'); "
                      "time.sleep(60)")
            started = time.monotonic()
            code, _, fell_back = bridge.run_watched([sys.executable, "-c", script], cwd=Path(home),
                                                    env=os.environ.copy(), timeout=90, log_path=log)
        self.assertTrue(fell_back)
        self.assertLess(time.monotonic() - started, 20)

    def test_claude_answers_when_codex_is_unavailable(self):
        bridge._codex_retry_at = 0.0
        completed = subprocess.CompletedProcess([], 0, stdout="LT1 tiene 10 tareas abiertas.")
        with patch.object(bridge, "run_hermes", side_effect=bridge.CodexUnavailable("402")) as hermes, \
             patch.object(bridge.subprocess, "run", return_value=completed) as run, \
             tempfile.TemporaryDirectory() as home:
            first = bridge.answer_chat({"message": "LT1"}, "hermes", Path(home), "openai-codex", "gpt-6-luna",
                                       "claude.exe", "sonnet")
            second = bridge.answer_chat({"message": "LT2"}, "hermes", Path(home), "openai-codex", "gpt-6-luna",
                                        "claude.exe", "sonnet")
        self.assertTrue(first.startswith("LT1 tiene 10 tareas abiertas."))
        self.assertIn("Respondido por Claude", first)
        self.assertTrue(second)
        self.assertEqual(hermes.call_count, 1, "Codex is not retried during the cooldown")
        args = run.call_args.args[0]
        self.assertEqual(args[args.index("--tools") + 1], "")
        self.assertIn("--strict-mcp-config", args)
        self.assertEqual(args[args.index("--allowedTools") + 1], "mcp__vikunja-dashboard,mcp__dsta-minutas")
        self.assertIn("LT2", run.call_args.kwargs["input"])
        bridge._codex_retry_at = 0.0

    def test_codex_failure_without_claude_reports_error(self):
        bridge._codex_retry_at = 0.0
        with patch.object(bridge, "run_hermes", side_effect=bridge.CodexUnavailable("402")):
            with self.assertRaises(RuntimeError):
                bridge.answer_chat({"message": "hola"}, "hermes", Path.cwd(), "openai-codex", "gpt-6-luna")

    def test_summary_jobs_receive_the_claude_backup(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        submit = source[source.index("summary_future = summaries.submit("):]
        submit = submit[:submit.index(")") + 1]
        self.assertIn("claude_cli", submit, "summary jobs must get claude_cli or the backup never runs")

    def test_cited_minutes_are_attached_only_when_they_exist(self):
        with tempfile.TemporaryDirectory() as folder:
            minute = Path(folder) / "2026-09-28-directores.md"
            minute.write_text('---\nsource: "granola"\n---\n\n# Reunión Directores\n\n- ENAER\n', encoding="utf-8")
            with patch.object(bridge.minutas, "minute_files", return_value={"Minutas 2026/d.md": minute}):
                cited = bridge.cited_minutes("Ver [Directores](minuta:Minutas 2026/d.md) y [Otra](minuta:no/existe.md).")
        self.assertEqual(list(cited), ["Minutas 2026/d.md"])
        self.assertEqual(cited["Minutas 2026/d.md"]["titulo"], "Reunión Directores")
        self.assertEqual(cited["Minutas 2026/d.md"]["fecha"], "2026-09-28")
        self.assertTrue(cited["Minutas 2026/d.md"]["contenido"].startswith("# Reunión Directores"))

    def test_granola_check_reads_the_connection_test(self):
        ok = subprocess.CompletedProcess([], 0, stdout="✓ Connected (1985ms)")
        auth = subprocess.CompletedProcess([], 1, stdout="MCP OAuth requires browser authorization")
        with patch.object(bridge.subprocess, "run", return_value=ok):
            self.assertEqual(bridge.check_granola("hermes", Path.cwd()), (True, "Conectado"))
        with patch.object(bridge.subprocess, "run", return_value=auth):
            healthy, detail = bridge.check_granola("hermes", Path.cwd())
        self.assertFalse(healthy)
        self.assertIn("hermes mcp login granola", detail)

    def test_manual_health_checks_acknowledge_even_unchanged_health(self):
        monitor = bridge.HealthMonitor("https://example.com", "bridge", "http://127.0.0.1:3456", "hermes", Path.cwd())
        with patch.object(bridge, "vikunja_listening", return_value=True), \
             patch.object(bridge, "check_granola", return_value=(True, "Conectado")), \
             patch.object(bridge, "request_json") as send:
            monitor.refresh_requested("first")
            monitor.refresh_requested("second")
        self.assertEqual(send.call_count, 2)
        for item in send.call_args.kwargs["payload"].values():
            self.assertEqual(item["requestId"], "second")
            self.assertTrue(item["ok"])

    def test_health_reports_changes_and_heartbeats_only(self):
        sent = []
        monitor = bridge.HealthMonitor("https://example.com", "bridge", "http://127.0.0.1:3456", "hermes", Path.cwd())
        with patch.object(bridge, "request_json", side_effect=lambda url, **kw: sent.append(kw["payload"]) or {}):
            monitor.set("vikunja", True, "Respondiendo")
            monitor.publish()
            monitor.publish()  # sin cambios: no se reenvía
            monitor.set("vikunja", False, "No responde")
            monitor.publish()
        self.assertEqual([item["vikunja"]["ok"] for item in sent], [True, False])

    def test_vikunja_watchdog_restarts_only_when_down(self):
        with patch.object(bridge, "vikunja_listening", return_value=True), \
             patch.object(bridge.subprocess, "run") as run:
            bridge.ensure_vikunja("http://127.0.0.1:3456")
        run.assert_not_called()
        states = iter([False, True])
        with patch.object(bridge, "vikunja_listening", side_effect=lambda url: next(states)), \
             patch.object(bridge.subprocess, "run") as run, patch.object(bridge.time, "sleep"), \
             patch.object(bridge, "ENSURE_VIKUNJA", Path(__file__)):
            bridge.ensure_vikunja("http://127.0.0.1:3456")
        self.assertIn(str(Path(__file__)), run.call_args.args[0])
        with patch.object(bridge, "vikunja_listening", return_value=False), \
             patch.object(bridge.subprocess, "run") as run:
            bridge.ensure_vikunja("https://vikunja.example.com")
        run.assert_not_called()  # never tries to start a remote Vikunja

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
