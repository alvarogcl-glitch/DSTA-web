"""F5: Copilot por usuario con las cuentas del CEO (Hermes → Claude), aislado: sin memoria ni reglas
del CEO, sin herramientas ni MCP, contexto solo con los datos del usuario y sesión borrada al final."""
import importlib.util
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location("user_copilot", TOOLS / "user_copilot.py")
uc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uc)

SNAP_A = {"projects": [{"id": 8, "title": "LT Ana"}],
          "tasks": [{"id": 81, "title": "Tarea secreta de Ana", "project": "LT Ana", "project_id": 8, "done": False,
                     "owner": "Ana", "date": "2026-11-01", "description": "detalle A"}]}
MINUTES_A = [{"title": "Comité de Ana", "date": "2026-10-10", "summary": "Acordamos X"}]
JOB = {"id": "j1", "kind": "chat", "message": "¿Qué tengo pendiente?", "history": [], "task": None}


class Runner:
    def __init__(self, hermes_ok=True, claude_ok=True):
        self.calls, self.hermes_ok, self.claude_ok, self.deleted = [], hermes_ok, claude_ok, []

    def __call__(self, args, *, input_text=None, cwd=None, env=None, timeout=None):
        self.calls.append({"args": args, "input": input_text, "cwd": cwd, "env": env})
        exe = Path(args[0]).name
        if "hermes" in exe and args[1:3] == ["sessions", "delete"]:
            self.deleted.append(args[-1])
            return 0, "Deleted", ""
        if "hermes" in exe and args[1:3] == ["sessions", "list"]:
            # Like the real CLI: a table on stdout, one row per remaining session.
            return 0, "Preview  Last Active  Src  ID\n hola  now  dsta-mu-ana  20261013_000000_abc123\n", ""
        if "hermes" in exe:
            # The real CLI prints session_id on stderr, not stdout.
            return (0, "Respuesta Hermes", "session_id: 20261013_000000_abc123") if self.hermes_ok else (1, "", "Fallback activated")
        return (0, "Respuesta Claude", "") if self.claude_ok else (1, "", "")


class UserCopilotTest(unittest.TestCase):
    def copilot(self, runner, profile=None):
        return uc.UserCopilot(hermes_cli="C:/x/hermes.exe", hermes_home=Path("C:/ceo/hermes"), claude_cli="C:/x/claude.exe",
                              work_dir=Path("C:/tmp/copilot"), run=runner)

    def test_contexto_solo_con_datos_del_usuario(self):
        prompt = uc.build_prompt(JOB, SNAP_A, MINUTES_A)
        self.assertIn("Tarea secreta de Ana", prompt)
        self.assertIn("Acordamos X", prompt)
        self.assertIn("¿Qué tengo pendiente?", prompt)
        self.assertNotIn("PMO-DSTA", prompt, "nada del portafolio del CEO")

    def test_hermes_aislado_y_sesion_borrada(self):
        runner = Runner()
        reply = self.copilot(runner).answer("ana", {}, JOB, SNAP_A, MINUTES_A)
        self.assertEqual(reply, "Respuesta Hermes")
        args = runner.calls[0]["args"]
        for flag in ("--ignore-rules", "--ignore-user-config"):
            self.assertIn(flag, args)
        self.assertEqual(args[args.index("-t") + 1], "todo", "sin MCP, terminal, archivos ni cronjob")
        self.assertNotIn("cronjob", " ".join(args))
        self.assertTrue(args[args.index("--source") + 1].startswith("dsta-mu-"))
        self.assertIn("Tarea secreta de Ana", runner.calls[0]["input"] or args[args.index("--query") + 1])
        self.assertEqual(runner.calls[1]["args"][1:], ["sessions", "list", "--source", "dsta-mu-ana"])
        self.assertEqual(runner.deleted, ["20261013_000000_abc123"], "the user's session is purged from the CEO's Hermes")
        self.assertIn("ana", str(runner.calls[0]["cwd"]), "directorio de trabajo propio del usuario")

    def test_respaldo_claude_sin_herramientas_ni_historial(self):
        runner = Runner(hermes_ok=False)
        reply = self.copilot(runner).answer("ana", {}, JOB, SNAP_A, MINUTES_A)
        self.assertTrue(reply.startswith("Respuesta Claude"))
        self.assertIn("respaldo", reply.lower())
        claude = [c for c in runner.calls if "claude" in Path(c["args"][0]).name][0]
        args = claude["args"]
        self.assertEqual(args[args.index("--tools") + 1], "")
        for flag in ("--strict-mcp-config", "--no-session-persistence"):
            self.assertIn(flag, args)
        self.assertNotIn("--mcp-config", args)
        self.assertIn("Tarea secreta de Ana", claude["input"])

    def test_sesiones_se_purgan_aunque_hermes_falle(self):
        runner = Runner(hermes_ok=False)
        self.copilot(runner).answer("ana", {}, JOB, SNAP_A, MINUTES_A)
        self.assertEqual(runner.deleted, ["20261013_000000_abc123"])

    def test_si_ambos_fallan_error_generico(self):
        with self.assertRaises(uc.CopilotUnavailable):
            self.copilot(Runner(hermes_ok=False, claude_ok=False)).answer("ana", {}, JOB, SNAP_A, MINUTES_A)

    def test_perfil_llm_por_usuario(self):
        runner = Runner()
        self.copilot(runner).answer("ana", {"llm": {"provider": "ceo-hermes"}}, JOB, SNAP_A, MINUTES_A)
        with self.assertRaises(uc.CopilotUnavailable):
            self.copilot(Runner()).answer("ana", {"llm": {"provider": "openai-api"}}, JOB, SNAP_A, MINUTES_A)

    def test_identificador_de_usuario_en_rutas_es_seguro(self):
        with self.assertRaises(ValueError):
            self.copilot(Runner()).answer("../ceo", {}, JOB, SNAP_A, MINUTES_A)


if __name__ == "__main__":
    unittest.main()
