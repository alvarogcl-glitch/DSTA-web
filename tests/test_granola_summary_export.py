"""Exercise Granola's delayed summary without network or operational writes."""
import asyncio
from contextlib import asynccontextmanager, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import sys
from types import ModuleType
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

SPEC = importlib.util.spec_from_file_location(
    "granola_export", Path(__file__).resolve().parents[1] / "tools/granola_summary_export.py")
export = importlib.util.module_from_spec(SPEC)
# The OAuth call is mocked by these offline tests. Hermes owns this module
# outside this repository; importing the test must not require its installation.
oauth_stub = ModuleType("tools.mcp_oauth")
def offline_oauth(*args, **kwargs):
    raise AssertionError("Offline tests must mock OAuth")
oauth_stub.build_oauth_auth = offline_oauth
with patch.dict(sys.modules, {"tools.mcp_oauth": oauth_stub}):
    SPEC.loader.exec_module(export)


class ExportTests(unittest.TestCase):
    def run_export(self, folder, summaries, notes="not available", discarded=()):
        calls = []
        values = iter(summaries)

        class Session:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def initialize(self):
                pass

            async def call_tool(self, name, args):
                calls.append((name, args))
                meeting = ET.Element("meeting", id="m1", title="Reunión", date="Oct 7, 2026")
                if name == "get_meetings":
                    ET.SubElement(meeting, "summary").text = next(values)
                    ET.SubElement(meeting, "private_notes").text = notes
                root = ET.Element("meetings_data")
                root.append(meeting)
                return SimpleNamespace(isError=False, content=[SimpleNamespace(text=ET.tostring(root, encoding="unicode"))])

        @asynccontextmanager
        async def connection(*args, **kwargs):
            yield None, None, None

        output = io.StringIO()
        with patch.object(export, "STAGING", folder), \
             patch.object(export, "discarded_sources", return_value=set(discarded)), \
             patch.object(export, "build_oauth_auth", return_value=None), \
             patch.object(export, "streamablehttp_client", connection), \
             patch.object(export, "ClientSession", lambda *args: Session()), redirect_stdout(output):
            asyncio.run(export.main())
        return json.loads(output.getvalue()), calls

    def test_empty_summary_is_deferred_then_exported_when_ready(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            report, calls = self.run_export(folder, ["No summary", "No summary"])
            self.assertEqual(len(report["deferred"]), 1)
            self.assertEqual(report["exported"], [])
            self.assertEqual(list(folder.glob("*.md")), [])
            self.assertEqual([c[0] for c in calls], ["list_meetings", "get_meetings", "get_meetings"])
            report, _ = self.run_export(folder, ["Acuerdo: entregar informe."])
            self.assertEqual(len(report["exported"]), 1)
            self.assertIn("Acuerdo: entregar informe.", next(folder.glob("*.md")).read_text(encoding="utf-8"))

    def test_single_retry_recovers_ready_summary(self):
        with tempfile.TemporaryDirectory() as temp:
            report, _ = self.run_export(Path(temp), ["No summary", "Resumen listo."])
            self.assertEqual(len(report["exported"]), 1)
            self.assertEqual(report["deferred"], [])

    def test_discarded_source_is_not_exported_or_queued_again(self):
        with tempfile.TemporaryDirectory() as temp:
            report, _ = self.run_export(Path(temp), ["Nueva revisión del resumen."], discarded=["m1"])
            self.assertEqual(report["exported"], [])
            self.assertEqual(report["deferred"], [{"id": "m1", "reason": "discarded_by_user"}])

    def test_temporary_empty_response_preserves_previous_content(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            self.run_export(folder, ["Resumen válido."])
            file = next(folder.glob("*.md"))
            original = file.read_bytes()
            report, _ = self.run_export(folder, ["No summary", "No summary"])
            self.assertEqual(file.read_bytes(), original)
            self.assertEqual(len(report["deferred"]), 1)

    def test_notes_without_summary_are_exported(self):
        with tempfile.TemporaryDirectory() as temp:
            report, calls = self.run_export(Path(temp), ["No summary"], notes="Se acuerda revisión el viernes.")
            self.assertEqual(len(report["exported"]), 1)
            self.assertEqual(len(calls), 2)

    def test_unchanged_content_is_not_requeued(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            self.run_export(folder, ["Resumen válido."])
            report, _ = self.run_export(folder, ["Resumen válido."])
            self.assertEqual(len(report["unchanged"]), 1)
            self.assertEqual(report["exported"], [])

    def test_single_meeting_response_is_supported(self):
        meeting = ET.fromstring('<meeting id="m1"><summary>Resumen</summary></meeting>')
        self.assertEqual(export.meeting_nodes(meeting), [meeting])
        self.assertTrue(export.has_content(export.detail_dict(meeting)))

    def test_placeholders_and_participants_are_not_content(self):
        for placeholder in ["No summary", " NOT AVAILABLE ", "", "none", "null"]:
            self.assertFalse(export.has_content({"summary": placeholder, "private_notes": "not available", "known_participants": "Ana"}))

    def test_promoter_does_not_replace_valid_minute_with_legacy_empty_export(self):
        spec = importlib.util.spec_from_file_location(
            "promote_granola", Path(__file__).resolve().parents[1] / "tools/promote_granola_summaries.py")
        promote = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(promote)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            staging = root / ".granola-summary-staging"
            staging.mkdir()
            detail = {"id": "m1", "title": "Reunión", "date": "Oct 7, 2026", "known_participants": "Ana",
                      "summary": "No summary", "private_notes": "not available"}
            (staging / "minute.md").write_text(export.markdown(detail, "now"), encoding="utf-8")
            existing = root / "minute.md"
            existing.write_text("Contenido anterior válido.", encoding="utf-8")
            self.assertEqual(promote.promote(root)["promoted"], 0)
            self.assertEqual(existing.read_text(encoding="utf-8"), "Contenido anterior válido.")
            detail["summary"] = "Resumen disponible."
            (staging / "minute.md").write_text(export.markdown(detail, "now"), encoding="utf-8")
            self.assertEqual(promote.promote(root)["promoted"], 1)
            self.assertIn("Resumen disponible.", existing.read_text(encoding="utf-8"))
