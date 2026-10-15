"""Handwritten manual minutes: the VM renders the dashboard's ink and transcribes it (Claude vision);
the result (or an opaque error) goes back to the draft for the user to review."""
import _hermetic  # noqa: F401  (never a real AI engine in tests)
import io
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import hermes_bridge as hb  # noqa: E402
import ink_transcribe as it  # noqa: E402

# Two strokes on page 1 (delta-encoded, as public/ink.js stores them), page 2 empty.
INK = json.dumps({"v": 1, "w": 1000, "h": 1414, "pages": [
    [[0, 1, [100, 100, 5, 50, 0, 5, 50, 20, 7]], [2, 2, [300, 400, 5]]], []]})


def claude_output(text, ok=True):
    lines = [json.dumps({"type": "system"}), json.dumps({"type": "result", "is_error": not ok, "result": text})]
    return subprocess.CompletedProcess([], 0, "\n".join(lines).encode("utf-8"), b"")


class InkTranscribeTest(unittest.TestCase):
    def test_decodifica_deltas(self):
        pages = it.decode(INK)
        self.assertEqual([(x, y) for x, y, _ in pages[0][0]["pts"]], [(100, 100), (150, 100), (200, 120)])
        self.assertAlmostEqual(pages[0][0]["pts"][2][2], 7 / 9, msg="early drafts: pressure 1..9")
        fine = json.dumps({"v": 1, "q": 10, "pq": 100, "pages": [[[0, 1, [1005, 2003, 40, 5, 0, 60]]]]})
        self.assertEqual(it.decode(fine)[0][0]["pts"], [(100.5, 200.3, 0.4), (101.0, 200.3, 0.6)])
        self.assertEqual(pages[1], [])

    def test_renderiza_solo_hojas_con_escritura_recortadas(self):
        images = it.render(INK)
        self.assertEqual(len(images), 1, "empty pages are skipped")
        image = Image.open(io.BytesIO(images[0]))
        self.assertEqual(image.width, int(1000 * it.SCALE))
        self.assertLess(image.height, int(1414 * it.SCALE), "cropped below the last stroke")
        self.assertNotEqual(image.getpixel((int(120 * it.SCALE), int(100 * it.SCALE))), (255, 255, 255))

    def test_envia_imagenes_a_claude_y_devuelve_texto(self):
        sent = {}

        def run(args, **kwargs):
            sent["args"], sent["input"] = args, json.loads(kwargs["input"].decode("utf-8"))
            return claude_output("Reunión\n- acuerdo")
        with patch.object(it.subprocess, "run", side_effect=run):
            self.assertEqual(it.transcribe(INK, "claude.exe"), "Reunión\n- acuerdo")
        content = sent["input"]["message"]["content"]
        self.assertEqual([c["type"] for c in content], ["image", "text"])
        self.assertIn("--tools", sent["args"])
        self.assertIn("--strict-mcp-config", sent["args"])

    def test_falla_si_claude_falla_o_no_hay_cli(self):
        with patch.object(it.subprocess, "run", return_value=claude_output("x", ok=False)):
            with self.assertRaises(it.TranscriptionError):
                it.transcribe(INK, "claude.exe")
        with self.assertRaises(it.TranscriptionError):
            it.transcribe(INK, "")

    def test_puente_devuelve_texto_o_error_opaco(self):
        posted = []
        post = lambda url, **kw: posted.append((url, kw["payload"]))
        job = {"id": "d-1", "attempt": "a-1", "kind": "transcribe", "ink": INK}
        with patch.object(it, "transcribe", return_value="Acuerdo"):
            hb.process_transcription(job, "https://dash/u/ceo/api/bridge/manual-done", "t", "claude.exe", "sonnet", post=post)
        self.assertEqual(posted[-1][1], {"id": "d-1", "attempt": "a-1", "kind": "transcribe", "text": "Acuerdo"})
        with patch.object(it, "transcribe", side_effect=RuntimeError("detalle privado")):
            hb.process_transcription(job, "https://dash/u/ceo/api/bridge/manual-done", "t", "claude.exe", "sonnet", post=post)
        self.assertEqual(posted[-1][1], {"id": "d-1", "attempt": "a-1", "kind": "transcribe", "error": True})

    def test_process_manual_deriva_la_transcripcion(self):
        with patch.object(hb, "process_transcription") as transcription, patch.object(hb, "owner_manual_inbox") as inbox:
            hb.process_manual({"kind": "transcribe", "id": "d", "attempt": "a"}, "https://dash/u/ceo", "t",
                              Path("."), "", "", lambda p: "", "claude.exe", "sonnet")
        transcription.assert_called_once()
        inbox.assert_not_called()


if __name__ == "__main__":
    unittest.main()
