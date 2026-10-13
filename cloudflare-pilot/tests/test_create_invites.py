"""Las invitaciones guardan solo el hash del token y el token viaja en el fragmento del link.

Ejecutar desde cloudflare-pilot/:
    python -m unittest discover -s tests -p "test_create_invites.py"
"""
import base64
import contextlib
import hashlib
import importlib.util
import io
import re
import unittest
from pathlib import Path
from unittest.mock import patch

TOOL = Path(__file__).resolve().parents[1] / "tools" / "create_invites.py"
spec = importlib.util.spec_from_file_location("create_invites", TOOL)
invites = importlib.util.module_from_spec(spec)
spec.loader.exec_module(invites)


class CreateInvitesTest(unittest.TestCase):
    def run_tool(self, argv):
        calls, sql_files = [], []

        def fake_wrangler(*args):
            calls.append(args)
            sql_files.append(Path(args[args.index("--file") + 1]).read_text(encoding="utf-8"))

        out = io.StringIO()
        with patch.object(invites, "run_wrangler", side_effect=fake_wrangler), contextlib.redirect_stdout(out):
            code = invites.main(argv)
        return code, out.getvalue(), calls, sql_files

    def test_sql_tiene_solo_hashes_y_links_llevan_token_en_fragmento(self):
        code, output, calls, sql_files = self.run_tool(["--remote", "--base-url", "https://pilot.example.workers.dev"])
        self.assertEqual(code, 0)
        links = re.findall(r"https://pilot\.example\.workers\.dev/invite#t=([A-Za-z0-9_-]+)", output)
        self.assertEqual(len(links), 2)
        sql = sql_files[0]
        for token in links:
            self.assertNotIn(token, sql, "el token no llega a D1")
            self.assertFalse(any(token in " ".join(c) for c in calls), "ni a los argumentos de Wrangler")
            expected = base64.urlsafe_b64encode(hashlib.sha256(token.encode()).digest()).decode().rstrip("=")
            self.assertIn(expected, sql, "D1 recibe el SHA-256 del token")
        self.assertEqual(sql.count("UPDATE invitations SET used_at"), 2, "revoca invitaciones previas sin usar")
        self.assertIn("--remote", calls[0])

    def test_tokens_son_distintos_y_largos(self):
        _, tokens = invites.build_invites(invites.ACCOUNTS, 1000, 3600)
        self.assertEqual(len(set(tokens.values())), 2)
        self.assertTrue(all(len(t) >= 40 for t in tokens.values()))

    def test_exige_url_https_y_vigencia_acotada(self):
        code, _, calls, _ = self.run_tool(["--remote", "--base-url", "http://pilot.example"])
        self.assertNotEqual(code, 0)
        self.assertEqual(calls, [])
        code, _, calls, _ = self.run_tool(["--remote", "--base-url", "https://x.workers.dev", "--ttl-hours", "500"])
        self.assertNotEqual(code, 0)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
