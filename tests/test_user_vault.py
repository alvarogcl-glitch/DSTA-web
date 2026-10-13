"""El vault multiusuario cifra con DPAPI: el token nunca queda en texto plano en disco."""
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location("user_vault", TOOLS / "user_vault.py")
vault = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vault)


@unittest.skipUnless(os.name == "nt", "DPAPI solo existe en Windows")
class UserVaultTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["DSTA_VAULT_DIR"] = self.tmp.name

    def tearDown(self):
        os.environ.pop("DSTA_VAULT_DIR", None)
        self.tmp.cleanup()

    def test_roundtrip_sin_texto_plano(self):
        secret = "tk_sintetico_0123456789abcdef"
        vault.save("demo-a", {"vikunjaToken": secret, "vikunjaUrl": "http://127.0.0.1:14701", "rootProjectId": 7})
        raw = (Path(self.tmp.name) / "demo-a.dpapi").read_bytes()
        self.assertNotIn(secret.encode(), raw)
        self.assertNotIn(b"vikunjaToken", raw)
        data = vault.load("demo-a")
        self.assertEqual(data["vikunjaToken"], secret)
        self.assertEqual(data["rootProjectId"], 7)
        self.assertEqual(vault.actors(), ["demo-a"])

    def test_archivo_de_otro_usuario_es_rechazado(self):
        vault.save("demo-a", {"vikunjaToken": "x"})
        (Path(self.tmp.name) / "demo-a.dpapi").replace(Path(self.tmp.name) / "demo-b.dpapi")
        with self.assertRaises(ValueError):
            vault.load("demo-b")

    def test_identificador_invalido(self):
        for bad in ("../ceo", "A", "", "x" * 80):
            with self.assertRaises(ValueError):
                vault.save(bad, {})

    def test_delete_y_ausente(self):
        self.assertIsNone(vault.load("nadie"))
        vault.save("demo-c", {"vikunjaToken": "x"})
        self.assertTrue(vault.delete("demo-c"))
        self.assertIsNone(vault.load("demo-c"))


if __name__ == "__main__":
    unittest.main()
