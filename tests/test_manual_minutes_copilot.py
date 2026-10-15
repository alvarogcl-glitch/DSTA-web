"""The copilot sees every minute: Granola's and the dashboard's manual ones (typed or handwritten
and transcribed), for the owner (dsta-minutas MCP) and for each user (prompt context)."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import manual_minutes  # noqa: E402
import minutas_mcp  # noqa: E402
import user_copilot  # noqa: E402

BLOCK = json.dumps({"title": "Comité a mano", "date": "2026-10-15T16:31:00-03:00", "source": "Manual-Dashboard",
                    "private_notes": "[Escrito a mano · transcripción revisada]\nAcuerdo: renovar el contrato de Starlink"})
STORE = {"minutes": {
    "m-1": {"id": "m-1", "source": "Manual-Dashboard", "titulo": "Comité a mano", "fecha": "2026-10-15", "texto": BLOCK},
    "m-2": {"id": "m-2", "source": "Manual-Dashboard", "titulo": "Borrada", "fecha": "2026-10-14", "texto": BLOCK,
            "eliminadaEn": "2026-10-15T00:00:00Z"},
    "m-3": {"id": "m-3", "source": "Manual-Dashboard", "titulo": "Antigua", "fecha": "2026-10-01",
            "texto": "Minuta «Antigua»\nOrigen: Manual-Dashboard\n\nSe revisó la licitación de drones"},
    "g-1": {"id": "g-1", "source": "Granola", "titulo": "Granola", "fecha": "2026-10-15", "texto": "no es manual"},
}}


class ManualMinutesCopilotTest(unittest.TestCase):
    def setUp(self):
        self.store = Path(tempfile.mkdtemp()) / "inbox.json"
        self.store.write_text(json.dumps(STORE), encoding="utf-8")

    def test_entradas_manuales_sin_eliminadas_ni_granola(self):
        items = manual_minutes.entries(self.store)
        self.assertEqual([i["id"] for i in items], ["Manual/m-1", "Manual/m-3"])
        self.assertIn("renovar el contrato de Starlink", items[0]["contenido"])
        self.assertIn("escritura a mano", items[0]["contenido"])
        self.assertIn("licitación de drones", items[1]["contenido"], "older plain-text records too")
        self.assertEqual(manual_minutes.entries(Path("no-existe.json")), [])

    def test_mcp_del_dueno_lista_busca_y_lee_ambos_origenes(self):
        folder = Path(tempfile.mkdtemp()) / "Minutas 2026"; folder.mkdir()
        (folder / "2026-10-10-comite.md").write_text("# Comité Granola\nSe habló del dron", encoding="utf-8")
        with patch.object(minutas_mcp, "MANUAL_STORE", self.store), patch.object(minutas_mcp, "minutes_dirs", return_value=[folder]):
            listed = minutas_mcp.minutas_listar()["minutas"]
            self.assertEqual({m["origen"] for m in listed}, {"Granola", "Manual (dashboard)"})
            found = minutas_mcp.minutas_buscar("Starlink contrato")["resultados"]
            self.assertEqual(found[0]["id"], "Manual/m-1")
            read = minutas_mcp.minutas_leer("Manual/m-1")
            self.assertTrue(read["ok"]); self.assertIn("Starlink", read["contenido"])
            self.assertTrue(minutas_mcp.minutas_leer("Minutas 2026/2026-10-10-comite.md")["ok"])
            self.assertFalse(minutas_mcp.minutas_leer("Manual/m-2")["ok"], "deleted minutes stay out")

    def test_copiloto_de_usuario_incluye_y_cita_manuales(self):
        user = {"minutes": [{"id": "g", "title": "Granola reciente", "date": "2026-10-12", "summary": "x"}], "minuteArchive": []}
        manual = manual_minutes.entries(self.store)
        minutes = user_copilot.minutes_for(user, "contrato", manual)
        self.assertIn("Manual/m-1", [m["id"] for m in minutes])
        prompt = user_copilot.build_prompt({"message": "¿qué minutas tengo?"}, {"projects": [], "tasks": []}, minutes)
        self.assertIn("(minuta manual)", prompt)
        self.assertIn("minuta:Manual/m-1", prompt)
        cited = user_copilot.cited_minutes(user, "Ver [Comité a mano](minuta:Manual/m-1)", manual)
        self.assertIn("Starlink", cited["Manual/m-1"]["contenido"])


if __name__ == "__main__":
    unittest.main()
