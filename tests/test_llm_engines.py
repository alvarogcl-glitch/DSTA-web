"""Engine per function (CEO 15-10): the order in llm_profiles.json is followed, a failing engine is skipped
for 10 minutes, reminders go to Hermes, and Codex direct runs sandboxed with the dashboard tools only."""
import _hermetic  # noqa: F401  (never a real AI engine in tests)
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import hermes_bridge as hb  # noqa: E402
import llm_engines  # noqa: E402
import user_copilot  # noqa: E402

REAL = TOOLS / "llm_profiles.json"


class ProfilesTest(unittest.TestCase):
    def test_perfiles_definidos_por_el_ceo(self):
        p = json.loads(REAL.read_text(encoding="utf-8"))
        chain = lambda name: [(s["motor"], s.get("modelo"), s.get("razonamiento")) for s in p[name]]
        luna = [("codex", "gpt-6-luna", "medium"), ("claude", "claude-sonnet-5-5", None), ("hermes", None, None)]
        self.assertEqual(chain("copiloto"), luna)
        self.assertEqual(chain("analisis_minutas"), [("codex", "gpt-6.1-sol", "medium"), ("claude", "claude-opus-5-5", None), ("hermes", None, None)])
        self.assertEqual(chain("instrucciones_bandeja"), luna)
        self.assertEqual(chain("transcripcion"), [("claude", "claude-opus-5-5", None)])
        self.assertEqual(chain("resumenes"), luna)
        self.assertEqual(chain("recordatorios"), [("hermes", None, None)])


class RunTest(unittest.TestCase):
    def setUp(self):
        self.now = 0.0
        self.calls = []
        self.real = patch.object(llm_engines, "PROFILES_PATH", REAL); self.real.start()

    def tearDown(self):
        self.real.stop()

    def engine(self, name, answer):
        def call(step):
            self.calls.append((name, step.get("modelo")))
            if isinstance(answer, Exception):
                raise answer
            return answer
        return call

    def test_orden_respaldo_y_pausa_de_diez_minutos(self):
        state = {}
        engines = {"codex": self.engine("codex", RuntimeError("caído")), "claude": self.engine("claude", "ok"), "hermes": self.engine("hermes", "h")}
        answer, step, fallback = llm_engines.run("copiloto", engines, clock=lambda: self.now, state=state, log=lambda t: None)
        self.assertEqual((answer, step["motor"], fallback), ("ok", "claude", True))
        self.assertEqual(self.calls, [("codex", "gpt-6-luna"), ("claude", "claude-sonnet-5-5")])
        self.calls.clear(); self.now = 300
        llm_engines.run("copiloto", engines, clock=lambda: self.now, state=state, log=lambda t: None)
        self.assertEqual(self.calls, [("claude", "claude-sonnet-5-5")], "Codex skipped while in cooldown")
        self.calls.clear(); self.now = 601
        llm_engines.run("copiloto", engines, clock=lambda: self.now, state=state, log=lambda t: None)
        self.assertEqual(self.calls[0], ("codex", "gpt-6-luna"), "tried again after 10 minutes")

    def test_respuesta_vacia_es_falla_y_si_todos_fallan_error(self):
        engines = {m: self.engine(m, "") for m in ("codex", "claude", "hermes")}
        with self.assertRaises(llm_engines.EngineFailed):
            llm_engines.run("analisis_minutas", engines, state={}, log=lambda t: None)
        self.assertEqual([c[0] for c in self.calls], ["codex", "claude", "hermes"])

    def test_cambiar_el_archivo_aplica_sin_reiniciar(self):
        other = Path(tempfile.mkdtemp()) / "p.json"
        other.write_text(json.dumps({"copiloto": [{"motor": "hermes"}]}), encoding="utf-8")
        with patch.object(llm_engines, "PROFILES_PATH", other):
            _, step, _ = llm_engines.run("copiloto", {m: self.engine(m, "x") for m in ("codex", "hermes")}, state={})
        self.assertEqual(step["motor"], "hermes")


class CodexDirectTest(unittest.TestCase):
    def test_codex_en_solo_lectura_sin_sesion_y_con_herramientas_aprobadas(self):
        seen = {}

        def fake_run(args, **kwargs):
            seen["args"], seen["input"] = args, kwargs["input"].decode("utf-8")
            Path(args[args.index("-o") + 1]).write_text("respuesta", encoding="utf-8")
            return subprocess.CompletedProcess(args, 0, b"", b"")
        with patch.object(llm_engines, "codex_cli", return_value="codex.exe"):
            answer = llm_engines.__dict__["_ask_codex_real"]("hola", "gpt-6-luna", "medium",
                                                             mcp=llm_engines.mcp_servers(read_only=True), run=fake_run)
        args = " ".join(seen["args"])
        self.assertEqual(answer, "respuesta"); self.assertEqual(seen["input"], "hola")
        for flag in ("--sandbox read-only", "--ephemeral", "--ignore-user-config", "-m gpt-6-luna", "model_reasoning_effort=medium",
                     'default_tools_approval_mode="approve"', "--read-only", "approval_policy=never"):
            self.assertIn(flag, args)

    def test_codex_que_falla_lanza_error(self):
        fail = lambda args, **kw: subprocess.CompletedProcess(args, 1, b"", b"")
        with patch.object(llm_engines, "codex_cli", return_value="codex.exe"), self.assertRaises(llm_engines.EngineFailed):
            llm_engines.__dict__["_ask_codex_real"]("hola", "gpt-6-luna", run=fail)


class BridgeRoutingTest(unittest.TestCase):
    def setUp(self):
        self.real = patch.object(llm_engines, "PROFILES_PATH", REAL); self.real.start()

    def tearDown(self):
        self.real.stop()

    def test_copiloto_del_dueno_usa_codex_con_herramientas_de_escritura(self):
        with patch.object(llm_engines, "ask_codex", return_value="Listo") as codex, patch.object(hb, "run_hermes") as hermes:
            self.assertEqual(hb.answer_chat({"message": "¿Qué tareas vencen?"}, "hermes", Path("."), "p", "m", "claude.exe"), "Listo")
        hermes.assert_not_called()
        self.assertEqual(codex.call_args.args[1], "gpt-6-luna")
        self.assertNotIn("--read-only", codex.call_args.kwargs["mcp"]["vikunja-dashboard"])

    def test_el_motor_sabe_quien_es_y_se_registra(self):
        with patch.object(llm_engines, "ask_codex", return_value="Soy Codex") as codex:
            hb.answer_chat({"message": "¿qué modelo usas?"}, "hermes", Path("."), "p", "m", "claude.exe")
        self.assertIn("Codex de OpenAI, modelo gpt-6-luna", codex.call_args.args[0])
        self.assertEqual(hb.LAST_ENGINE["label"], "Codex (gpt-6-luna)")

    def test_recordatorios_van_a_hermes(self):
        with patch.object(llm_engines, "ask_codex") as codex, patch.object(hb, "run_hermes", return_value="Programado") as hermes:
            self.assertEqual(hb.answer_chat({"message": "Recuérdame mañana a las 9 llamar a Cata"}, "hermes", Path("."), "p", "m", "claude.exe"), "Programado")
        codex.assert_not_called(); hermes.assert_called_once()

    def test_respaldo_se_indica_en_la_respuesta(self):
        with patch.object(llm_engines, "ask_codex", side_effect=RuntimeError("caído")), \
                patch.object(hb, "ask_claude", return_value="Respuesta") as claude:
            reply = hb.answer_chat({"message": "hola"}, "hermes", Path("."), "p", "m", "claude.exe")
        self.assertIn("Respondido por Claude (claude-sonnet-5-5) (respaldo)", reply)
        self.assertEqual(claude.call_args.args[3], "claude-sonnet-5-5")

    def test_analisis_y_bandeja_usan_su_perfil_en_solo_lectura(self):
        with patch.object(llm_engines, "ask_codex", return_value="{}") as codex:
            hb.analysis_asker("hermes", Path("."), "p", "m", "claude.exe", "sonnet")("minuta")
            self.assertEqual(codex.call_args.args[1], "gpt-6.1-sol")
            self.assertIn("--read-only", codex.call_args.kwargs["mcp"]["vikunja-dashboard"])
            hb.analysis_asker("hermes", Path("."), "p", "m", "claude.exe", "sonnet", function="instrucciones_bandeja")("instrucción")
            self.assertEqual(codex.call_args.args[1], "gpt-6-luna")

    def test_copiloto_multiusuario_por_funcion_y_sin_herramientas(self):
        copilot = user_copilot.UserCopilot(hermes_cli="hermes", hermes_home=Path("."), claude_cli="claude.exe",
                                           work_dir=Path(tempfile.mkdtemp()))
        with patch.object(llm_engines, "ask_codex", return_value="ok") as codex:
            self.assertEqual(copilot.ask("paula", {}, "prompt", "analisis_minutas"), "ok")
        self.assertEqual(codex.call_args.args[1], "gpt-6.1-sol")
        self.assertNotIn("mcp", codex.call_args.kwargs, "users' engines get no tools")


if __name__ == "__main__":
    unittest.main()
