"""Alta/baja de usuarios: D1 recibe solo el hash de la invitación; el token de Vikunja queda acotado."""
import base64
import hashlib
import importlib.util
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location("provision_user", TOOLS / "provision_user.py")
pu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pu)


class ProvisionUserTest(unittest.TestCase):
    def test_invitacion_guarda_solo_hash_y_revoca_previas(self):
        token = "token-de-invitacion-sintetico-0123456789"
        sql = pu.invitation_sql("ana", "ana@dsta.test", "Ana O'Higgins", token, 1000)
        self.assertNotIn(token, sql)
        digest = base64.urlsafe_b64encode(hashlib.sha256(token.encode()).digest()).decode().rstrip("=")
        self.assertIn(digest, sql)
        self.assertIn("UPDATE invitations SET used_at = 1000 WHERE actor_id = 'ana'", sql)
        self.assertIn("'Ana O''Higgins'", sql, "las comillas se escapan")
        self.assertIn(str(1000 + pu.INVITE_HOURS * 3600), sql)

    def test_baja_borra_sesiones_invitaciones_y_cuenta(self):
        sql = pu.removal_sql("ana")
        for table in ("sessions", "invitations", "users"):
            self.assertIn(f"DELETE FROM {table}", sql)

    def test_token_vikunja_solo_con_grupos_necesarios(self):
        routes = {"tasks": {"read_all": {}, "update": {}}, "projects": {"read_one": {}}, "migration": {"x": {}},
                  "caldav": {"x": {}}, "user": {"read": {}}}
        permissions = pu.scoped_permissions(routes)
        self.assertEqual(set(permissions), {"tasks", "projects", "user"})
        self.assertEqual(permissions["tasks"], ["read_all", "update"])

    def test_rechaza_produccion_e_identificadores_invalidos(self):
        self.assertEqual(pu.main(["provision", "--actor", "Ana!", "--email", "a@b.c", "--name", "A",
                                  "--dashboard-url", "https://dsta-web-staging.x.workers.dev"]), 2)
        self.assertEqual(pu.main(["provision", "--actor", "ana", "--email", "a@b.c", "--name", "A",
                                  "--dashboard-url", "https://dsta-web.alvaro-gcl.workers.dev"]), 2)


if __name__ == "__main__":
    unittest.main()
