"""El seeder nunca debe imprimir ni guardar contraseñas en texto plano.

Las contraseñas sintéticas se piden con entrada oculta (getpass), con confirmación y largo
mínimo; D1 recibe solo salt y hash PBKDF2-SHA256. Ejecutar desde cloudflare-pilot/:
    python -m unittest tests/test_seed_demo_accounts.py
"""
import base64
import contextlib
import hashlib
import importlib.util
import io
import unittest
from pathlib import Path
from unittest.mock import patch

SEEDER = Path(__file__).resolve().parents[1] / "tools" / "seed_demo_accounts.py"
spec = importlib.util.spec_from_file_location("seed_demo_accounts", SEEDER)
seeder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seeder)

PASSWORD_A = "Sintetica-A-9f3k2L7q"
PASSWORD_B = "Sintetica-B-4x8Zr1Wm"


def b64url_decode(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class SeederSecretsTest(unittest.TestCase):
    def run_seeder(self, answers, interactive=True, argv=("--local",)):
        """Ejecuta main() con respuestas simuladas a los prompts ocultos y captura todo."""
        calls, sql_files, prompts = [], [], []
        answers = iter(answers)

        def fake_prompt(message):
            prompts.append(message)
            return next(answers)

        def fake_wrangler(*args):
            calls.append(args)
            if "--file" in args:
                sql_files.append(Path(args[args.index("--file") + 1]).read_text(encoding="utf-8"))
            return ""

        out = io.StringIO()
        with patch.object(seeder, "run_wrangler", side_effect=fake_wrangler), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = seeder.main(list(argv), prompt=fake_prompt, interactive=lambda: interactive)
        return code, out.getvalue(), calls, sql_files, prompts

    def test_no_imprime_ni_guarda_contrasenas(self):
        code, output, calls, sql_files, _ = self.run_seeder([PASSWORD_A, PASSWORD_A, PASSWORD_B, PASSWORD_B])
        self.assertEqual(code, 0)
        for secret in (PASSWORD_A, PASSWORD_B):
            self.assertNotIn(secret, output, "la contraseña no debe aparecer en la salida")
            self.assertNotIn(secret, "\n".join(sql_files), "la contraseña no debe llegar al SQL")
            self.assertFalse(any(secret in " ".join(map(str, c)) for c in calls), "ni en argumentos de Wrangler")

    def test_d1_recibe_solo_salt_y_hash_verificables(self):
        _, _, _, sql_files, _ = self.run_seeder([PASSWORD_A, PASSWORD_A, PASSWORD_B, PASSWORD_B])
        sql = sql_files[0]
        import re
        rows = re.findall(r"VALUES \('(demo-[ab])','[^']+','[^']+','([^']+)','([^']+)'\)", sql)
        self.assertEqual([r[0] for r in rows], ["demo-a", "demo-b"])
        for (actor, salt, digest), password in zip(rows, (PASSWORD_A, PASSWORD_B)):
            expected = hashlib.pbkdf2_hmac("sha256", password.encode(), b64url_decode(salt), seeder.ITERATIONS, dklen=32)
            self.assertEqual(b64url_decode(digest), expected, actor)

    def test_pide_con_entrada_oculta_y_confirmacion(self):
        _, _, _, _, prompts = self.run_seeder([PASSWORD_A, PASSWORD_A, PASSWORD_B, PASSWORD_B])
        self.assertEqual(len(prompts), 4, "contraseña + confirmación por cuenta")
        self.assertIs(seeder.DEFAULT_PROMPT, seeder.getpass.getpass, "el prompt por defecto es getpass (sin eco)")

    def test_rechaza_confirmacion_distinta_sin_tocar_d1(self):
        code, output, calls, _, _ = self.run_seeder([PASSWORD_A, "otra-cosa-distinta", PASSWORD_A, PASSWORD_A, PASSWORD_B, PASSWORD_B][:2] + ["x"] * 10)
        self.assertNotEqual(code, 0)
        self.assertEqual(calls, [], "no se aplica nada en D1 si la confirmación falla")
        self.assertNotIn(PASSWORD_A, output)

    def test_rechaza_contrasena_corta(self):
        code, _, calls, _, _ = self.run_seeder(["corta", "corta"])
        self.assertNotEqual(code, 0)
        self.assertEqual(calls, [])

    def test_sin_terminal_interactiva_se_detiene(self):
        code, output, calls, _, prompts = self.run_seeder([], interactive=False)
        self.assertNotEqual(code, 0)
        self.assertEqual(calls, [])
        self.assertEqual(prompts, [], "sin terminal no hay forma segura de pedir la contraseña")
        self.assertIn("terminal", output.lower())


if __name__ == "__main__":
    unittest.main()
