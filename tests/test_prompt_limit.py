"""Hermes takes the prompt as a command-line argument (Windows caps it at 32,767 characters, WinError
206 → FileNotFoundError). Longer prompts must go to Claude via stdin, without pausing Hermes for others."""
import importlib.util
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import hermes_bridge as hb  # noqa: E402

spec = importlib.util.spec_from_file_location("user_copilot_limit", TOOLS / "user_copilot.py")
uc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uc)


class PromptLimitTest(unittest.TestCase):
    def test_puente_del_dueno_manda_prompt_largo_a_claude(self):
        with self.assertRaises(hb.PromptTooLong):
            hb.ask_hermes("x" * 40_000, "hermes.exe", Path("C:/no-existe"), "p", "m", "t")
        hb._codex_retry_at = 0.0
        answer = hb.codex_or_claude(lambda: hb.ask_hermes("x" * 40_000, "hermes.exe", Path("C:/no-existe"), "p", "m", "t"),
                                    lambda: "respuesta Claude", "claude.exe")
        self.assertEqual(answer, "respuesta Claude")
        self.assertEqual(hb._codex_retry_at, 0.0, "Hermes no queda en pausa por un prompt largo")

    def test_copiloto_multiusuario_no_pausa_hermes(self):
        calls = []

        def run(args, *, input_text=None, cwd=None, env=None, timeout=None):
            calls.append(Path(args[0]).name)
            if "hermes" in Path(args[0]).name:
                return 0, "", ""
            return 0, "Respuesta Claude", ""

        copilot = uc.UserCopilot(hermes_cli="C:/x/hermes.exe", hermes_home=Path("C:/ceo/hermes"), claude_cli="C:/x/claude.exe",
                                 work_dir=Path("C:/tmp/copilot"), run=run, clock=lambda: 100.0)
        self.assertTrue(copilot.ask("ana", {}, "x" * 40_000).startswith("Respuesta Claude"))
        self.assertEqual(copilot.hermes_down_until, 0.0, "the next normal prompt still tries Hermes")
        self.assertEqual(calls, ["claude.exe"], "the long prompt never reaches Hermes")


if __name__ == "__main__":
    unittest.main()
