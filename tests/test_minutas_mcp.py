"""The minutes MCP must only expose Markdown files inside the configured folders."""

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "tools" / "minutas_mcp.py"


def load_module():
    spec = importlib.util.spec_from_file_location("dsta_minutas_mcp", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MinutasTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.primary, self.secondary = base / "Minutas 2026", base / "07_reuniones"
        self.primary.mkdir()
        self.secondary.mkdir()
        (self.primary / "2026-09-23-1-1-cata.md").write_text(
            '---\nsource: "granola"\n---\n\n# 1-1 Cata - 23-09-2026\n\n- Gonzalo confirmó la metodología de casos\n',
            encoding="utf-8")
        (self.secondary / "2026-09-23-1-1-cata.md").write_text("# duplicado\n", encoding="utf-8")
        (self.secondary / "2026-09-14-consejo-vrai.md").write_text(
            "# Consejo VRAI\n\n- Presupuesto de la Academia\n", encoding="utf-8")
        (base / "secreto.md").write_text("# fuera de alcance\n", encoding="utf-8")
        env = {"DSTA_MINUTAS_DIRS": os.pathsep.join([str(self.primary), str(self.secondary)])}
        self.env = patch.dict(os.environ, env)
        self.env.start()
        self.module = load_module()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_list_is_newest_first_and_deduplicated(self):
        result = self.module.minutas_listar()
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["minutas"][0]["titulo"], "1-1 Cata - 23-09-2026")
        self.assertEqual(result["minutas"][1]["fecha"], "2026-09-14")
        self.assertEqual(self.module.minutas_listar(desde="2026-09-20")["total"], 1)

    def test_search_ignores_accents(self):
        result = self.module.minutas_buscar("metodologia gonzalo")
        self.assertEqual(result["total"], 1)
        self.assertIn("Gonzalo", result["resultados"][0]["extractos"][0])

    def test_read_strips_frontmatter_and_rejects_outside_paths(self):
        minute_id = self.module.minutas_listar()["minutas"][0]["id"]
        content = self.module.minutas_leer(minute_id)["contenido"]
        self.assertTrue(content.startswith("# 1-1 Cata"))
        self.assertFalse(self.module.minutas_leer("../secreto.md")["ok"])
        self.assertFalse(self.module.minutas_leer(str(Path(self.tmp.name) / "secreto.md"))["ok"])


if __name__ == "__main__":
    unittest.main()
