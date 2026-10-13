"""F4 en la VM: OAuth Granola por usuario contra un Granola sintético. El token queda cifrado en
el vault de SU usuario; la bandeja recibe solo título, fecha y resumen."""
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS.parent / "tools"))
sys.path.insert(0, str(TESTS))
from fake_granola import FakeGranola  # noqa: E402


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


@unittest.skipUnless(os.name == "nt", "el vault usa DPAPI")
class GranolaUserTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["DSTA_VAULT_DIR"] = self.tmp.name
        import user_vault
        import granola_user
        self.vault, self.gu = user_vault, granola_user
        for actor in ("ana", "beto"):
            user_vault.save(actor, {"vikunjaToken": "x", "rootProjectId": 1})

    def tearDown(self):
        os.environ.pop("DSTA_VAULT_DIR", None)
        self.tmp.cleanup()

    def consent(self, authorization_url):
        try:
            urllib.request.build_opener(NoRedirect).open(authorization_url, timeout=10)
        except urllib.error.HTTPError as redirect:
            location = redirect.headers["Location"]
        query = {k: v[0] for k, v in parse_qs(urlsplit(location).query).items()}
        return query["code"], query["state"]

    def test_conexion_sync_y_desconexion_por_usuario(self):
        with FakeGranola() as fake:
            service = self.gu.GranolaService("http://127.0.0.1:8787/oauth/granola/callback", test_origin=fake.origin)
            started = service.authorize("ana", "req-1")
            self.assertTrue(started["authorizationUrl"].startswith(fake.origin + "/authorize?"))
            code, state = self.consent(started["authorizationUrl"])
            self.assertEqual(state, started["state"])
            service.exchange("ana", "req-1", state, code)
            self.assertTrue(service.connected("ana"))
            self.assertFalse(service.connected("beto"), "conectar a Ana no conecta a Beto")
            raw = (Path(self.tmp.name) / "ana.dpapi").read_bytes()
            self.assertNotIn(b"at-", raw, "el token de Granola está cifrado en disco")
            records = service.sync("ana")
            self.assertEqual(sorted(r["source_id"] for r in records), ["meet-1", "meet-2"])
            inbox = self.gu.inbox_record(records[0])
            self.assertRegex(inbox["id"], r"^[\w-]{1,80}$")
            self.assertEqual(inbox["acciones"], [])
            self.assertNotIn("nota privada", str(inbox), "las notas privadas no salen de la VM")
            with self.assertRaises(self.gu.GranolaError):
                service.sync("beto")
            service.disconnect("ana")
            self.assertFalse(service.connected("ana"))
            with self.assertRaises(self.gu.GranolaError):
                service.sync("ana")

    def test_state_de_otro_usuario_o_reusado_falla(self):
        with FakeGranola() as fake:
            service = self.gu.GranolaService("http://127.0.0.1:8787/oauth/granola/callback", test_origin=fake.origin)
            started = service.authorize("ana", "req-1")
            code, state = self.consent(started["authorizationUrl"])
            with self.assertRaises(self.gu.GranolaError):
                service.exchange("beto", "req-1", state, code)
            with self.assertRaises(self.gu.GranolaError):
                service.exchange("ana", "otra-solicitud", state, code)
            self.assertFalse(service.connected("ana"))


if __name__ == "__main__":
    unittest.main()
