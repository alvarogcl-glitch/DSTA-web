"""«Minutas» shows Granola's own text: the owner's bridge attaches the exported file to each minute it
publishes (the Worker keeps it apart from the inbox list)."""
import _hermetic  # noqa: F401  (never a real AI engine in tests)
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import hermes_bridge as hb  # noqa: E402


class MinuteTextTest(unittest.TestCase):
    def test_puente_del_dueno_adjunta_el_texto_de_granola(self):
        sent = []
        record = {"id": "g-1", "minuta": "Minutas 2026/2026-10-14-cata.md", "texto": "recorte", "acciones": []}
        with patch.object(hb.minutas, "minute_files", return_value={"Minutas 2026/2026-10-14-cata.md": Path("C:/x.md")}), \
                patch.object(hb.minutas, "read_text", return_value="Texto textual de Granola"), \
                patch.object(hb, "request_json", side_effect=lambda url, **kw: sent.append(kw["payload"])):
            hb.push_minute("https://dash/u/ceo", "token", record)
        self.assertEqual(sent[0]["contenido"], "Texto textual de Granola")
        self.assertNotIn("texto", sent[0], "the old truncated copy is not sent")

    def test_sin_archivo_no_envia_contenido(self):
        sent = []
        with patch.object(hb.minutas, "minute_files", return_value={}), \
                patch.object(hb, "request_json", side_effect=lambda url, **kw: sent.append(kw["payload"])):
            hb.push_minute("https://dash/u/ceo", "token", {"id": "m-1", "acciones": []})
        self.assertNotIn("contenido", sent[0])


if __name__ == "__main__":
    unittest.main()
