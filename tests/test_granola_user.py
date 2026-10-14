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
        self._today = granola_user.today_chile
        granola_user.today_chile = lambda: __import__("datetime").date(2026, 10, 13)  # fixtures are dated Oct 2026
        for actor in ("ana", "beto"):
            user_vault.save(actor, {"vikunjaToken": "x", "rootProjectId": 1})

    def tearDown(self):
        os.environ.pop("DSTA_VAULT_DIR", None)
        self.gu.today_chile = self._today
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

    def test_token_vencido_se_renueva_con_refresh_token(self):
        with FakeGranola() as fake:
            fake.expires_in = 1
            service = self.gu.GranolaService("http://127.0.0.1:8787/oauth/granola/callback", test_origin=fake.origin)
            started = service.authorize("ana", "req-1")
            code, state = self.consent(started["authorizationUrl"])
            service.exchange("ana", "req-1", state, code)
            raw = (Path(self.tmp.name) / "ana.dpapi").read_bytes()
            self.assertNotIn(b"rt-", raw, "el refresh token también queda cifrado")
            import time
            time.sleep(1.2)
            records = service.sync("ana")
            self.assertEqual(len(records), 2, "sincroniza tras renovar el token vencido")
            self.assertEqual(fake.refreshes, 1)
            fake.tokens.clear()
            fake.refresh_tokens.clear()
            time.sleep(1.2)
            with self.assertRaises(self.gu.GranolaError):
                service.sync("ana")
            self.assertFalse(service.connected("ana"), "si el refresh falla, queda desconectado y pide reconectar")

    def test_formato_real_de_granola_xml(self):
        with FakeGranola() as fake:
            fake.xml = True
            service = self.gu.GranolaService("http://127.0.0.1:8787/oauth/granola/callback", test_origin=fake.origin)
            started = service.authorize("ana", "req-1")
            code, state = self.consent(started["authorizationUrl"])
            service.exchange("ana", "req-1", state, code)
            records = service.sync("ana")
            self.assertEqual(sorted(r["source_id"] for r in records), ["meet-1", "meet-2"])
            self.assertEqual(sorted(r["date"] for r in records), ["2026-10-10", "2026-10-11"])
            self.assertEqual(sorted(r["summary"] for r in records), ["Resumen sintético 1", "Resumen sintético 2"])
            self.assertEqual(len(self.vault.load("ana")["minutes"]), 2, "context for the Copilot")
            # D31: an archive that keeps older meetings once they leave Granola's 30-day window.
            data = self.vault.load("ana")
            data["minuteArchive"] = [{"id": "g-vieja", "title": "Comité de agosto", "date": "2026-08-01", "summary": "Acuerdo antiguo"}]
            self.vault.save("ana", data)
            service.sync("ana")
            archive = self.vault.load("ana")["minuteArchive"]
            self.assertEqual([m["date"] for m in archive], ["2026-10-11", "2026-10-10", "2026-08-01"])
            self.assertTrue(all(m["id"].startswith("g-") for m in archive))
            self.assertEqual(len({m["id"] for m in archive}), 3, "re-syncing does not duplicate")

    def test_primera_conexion_trae_90_dias_solo_al_archivo(self):
        """D41: first sync reaches back 90 days; meetings older than 30 days go only to the archive."""
        import datetime as dt
        self.gu.today_chile = lambda: dt.date(2026, 11, 10)  # meet-1 (10-10) is now older than 30 days
        with FakeGranola() as fake:
            fake.xml = True
            service = self.gu.GranolaService("http://127.0.0.1:8787/oauth/granola/callback", test_origin=fake.origin)
            started = service.authorize("ana", "req-1")
            code, state = self.consent(started["authorizationUrl"])
            service.exchange("ana", "req-1", state, code)
            records = service.sync("ana")
            self.assertEqual(fake.list_args[0], {"time_range": "custom", "custom_start": "2026-08-12", "custom_end": "2026-11-10"})
            self.assertEqual([r["source_id"] for r in records], ["meet-2"], "only the last 30 days reach the inbox and its analysis")
            self.assertEqual(len(self.vault.load("ana")["minuteArchive"]), 2, "both are searchable")
            service.sync("ana")
            self.assertEqual(fake.list_args[-1], {"time_range": "last_30_days"}, "afterwards, the regular 30-day window")

    def test_prueba_en_vivo_de_la_conexion(self):
        """D63: probe() checks the live MCP connection; disconnected users fail."""
        with FakeGranola() as fake:
            service = self.gu.GranolaService("http://127.0.0.1:8787/oauth/granola/callback", test_origin=fake.origin)
            with self.assertRaises(self.gu.GranolaError):
                service.probe("ana")
            started = service.authorize("ana", "req-1")
            code, state = self.consent(started["authorizationUrl"])
            service.exchange("ana", "req-1", state, code)
            service.probe("ana")  # no exception: connected and answering
            fake.tokens.clear()  # token revoked on Granola's side
            with self.assertRaises(Exception):
                service.probe("ana")

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
