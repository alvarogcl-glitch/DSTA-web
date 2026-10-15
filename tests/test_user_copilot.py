"""F5: Copilot por usuario con las cuentas del CEO (Hermes → Claude), aislado: sin memoria ni reglas
del CEO, sin herramientas ni MCP, contexto solo con los datos del usuario y sesión borrada al final."""
import _hermetic  # noqa: F401  (never a real AI engine in tests)
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

    def test_respaldo_directo_por_diez_minutos(self):
        """D35: after a Hermes failure, Claude answers directly for 10 minutes, then Hermes is retried."""
        now = [1000.0]
        runner = Runner(hermes_ok=False)
        copilot = uc.UserCopilot(hermes_cli="C:/x/hermes.exe", hermes_home=Path("C:/ceo/hermes"), claude_cli="C:/x/claude.exe",
                                 work_dir=Path("C:/tmp/copilot"), run=runner, clock=lambda: now[0])
        hermes_chats = lambda: sum(1 for c in runner.calls if "hermes" in Path(c["args"][0]).name and c["args"][1] == "chat")
        copilot.answer("ana", {}, JOB, SNAP_A, MINUTES_A)
        self.assertEqual(hermes_chats(), 1)
        now[0] += 300
        self.assertIn("respaldo", copilot.answer("ana", {}, JOB, SNAP_A, MINUTES_A).lower())
        self.assertEqual(hermes_chats(), 1, "within 10 minutes Hermes is not retried")
        now[0] += 301
        runner.hermes_ok = True
        self.assertEqual(copilot.answer("ana", {}, JOB, SNAP_A, MINUTES_A), "Respuesta Hermes")

    def test_buscar_minutas_antiguas_y_citarlas(self):
        """D31/D32: older minutes matching the question join the recent ones, and cited ones can be opened."""
        user = {"minutes": [{"id": "g-1", "title": "Reciente", "date": "2026-10-10", "summary": "nada"}],
                "minuteArchive": [{"id": "g-1", "title": "Reciente", "date": "2026-10-10", "summary": "nada"},
                                  {"id": "g-2", "title": "Comité proveedores", "date": "2026-07-01", "summary": "Acordamos licitación eléctrica"},
                                  {"id": "g-3", "title": "Otra", "date": "2026-06-01", "summary": "sin relación"}]}
        minutes = uc.minutes_for(user, "¿Qué acordamos sobre la licitacion electrica con proveedores?")
        self.assertEqual([m["id"] for m in minutes], ["g-1", "g-2"])
        self.assertTrue(minutes[1]["found"])
        prompt = uc.build_prompt(JOB, SNAP_A, minutes)
        self.assertIn("Minutas anteriores relacionadas", prompt)
        self.assertIn("(minuta:g-2)", prompt)
        cited = uc.cited_minutes(user, "Ver [Comité proveedores](minuta:g-2) y [falsa](minuta:g-999)")
        self.assertEqual(list(cited), ["g-2"])
        self.assertEqual(cited["g-2"]["contenido"], "Acordamos licitación eléctrica")
        self.assertEqual(uc.minutes_for(user, ""), user["minutes"])

    def test_identificador_de_usuario_en_rutas_es_seguro(self):
        with self.assertRaises(ValueError):
            self.copilot(Runner()).answer("../ceo", {}, JOB, SNAP_A, MINUTES_A)


class ProposalsTest(unittest.TestCase):
    SNAP = {"projects": [{"id": 8, "title": "LT Ana"}, {"id": 9, "title": "LT B"}],
            "tasks": [{"id": 81, "title": "Abierta", "project_id": 8, "done": False},
                      {"id": 82, "title": "Cerrada", "project_id": 8, "done": True}]}

    def test_extrae_y_valida_propuestas(self):
        reply = ("Te sugiero dos cambios.\n```acciones\n["
                 '{"action":"task.create","projectId":8,"title":"Llamar a proveedor","dueDate":"2026-11-02"},'
                 '{"action":"complete","taskId":81},'
                 '{"action":"complete","taskId":82},'
                 '{"action":"task.move","taskId":81,"projectId":999},'
                 '{"action":"lt.delete","projectId":8},'
                 '{"action":"task.update","taskId":777,"title":"x"},'
                 '{"action":"lt.rename","projectId":9,"title":"LT B renombrada","extra":"campo"}'
                 "]\n```")
        text, proposals = uc.split_proposals(reply, self.SNAP)
        self.assertEqual(text, "Te sugiero dos cambios.")
        self.assertEqual(proposals, [
            {"action": "task.create", "projectId": 8, "title": "Llamar a proveedor", "dueDate": "2026-11-02"},
            {"action": "complete", "taskId": 81},
            {"action": "lt.rename", "projectId": 9, "title": "LT B renombrada"},
        ], "solo acciones válidas, sobre elementos del usuario y aún aplicables; sin campos extra")

    def test_campos_opcionales_vacios_se_ignoran(self):
        reply = 'Ok\n```acciones\n[{"action":"task.create","projectId":8,"title":"T","description":"","dueDate":""}]\n```'
        self.assertEqual(uc.split_proposals(reply, self.SNAP)[1], [{"action": "task.create", "projectId": 8, "title": "T"}])

    def test_pedido_explicito_se_marca_para_ejecutar(self):
        reply = ('Listo.\n```acciones\n[{"action":"task.create","projectId":8,"title":"Informe","owner":"Paula",'
                 '"dependency":"Finanzas","criterion":"Enviado","ejecutar":true},{"action":"complete","taskId":81}]\n```')
        text, proposals = uc.split_proposals(reply, self.SNAP)
        self.assertEqual(proposals[0], {"action": "task.create", "projectId": 8, "title": "Informe", "owner": "Paula",
                                        "dependency": "Finanzas", "criterion": "Enviado", "execute": True})
        self.assertNotIn("execute", proposals[1], "sin marca explícita queda como propuesta con Aplicar")
        edit = ('x\n```acciones\n[{"action":"task.update","taskId":81,"title":"T","description":"todo el texto",'
                '"detail":"solo el detalle"}]\n```')
        self.assertEqual(uc.split_proposals(edit, self.SNAP)[1], [{"action": "task.update", "taskId": 81, "title": "T",
                                                                   "detail": "solo el detalle"}],
                         "D06-A: nunca reemplaza la descripción completa")
        self.assertIn('"ejecutar": true', uc.INSTRUCTIONS.replace("'", '"'), "el prompt explica cuándo marcar ejecutar")

    def test_reglas_de_lineas(self):
        """D23-D25: describe lines; no duplicate names; never archive a line with open tasks."""
        reply = ('x\n```acciones\n[{"action":"lt.create","title":"lt  ána"},{"action":"lt.rename","projectId":9,"title":"LT Ana"},'
                 '{"action":"lt.archive","projectId":8},{"action":"lt.archive","projectId":9},'
                 '{"action":"lt.describe","projectId":9,"description":"Objetivo"}]\n```')
        self.assertEqual(uc.split_proposals(reply, self.SNAP)[1], [{"action": "lt.archive", "projectId": 9},
                                                                   {"action": "lt.describe", "projectId": 9, "description": "Objetivo"}])
        prompt = uc.build_prompt(JOB, {"projects": [{"id": 9, "title": "LT B", "description": "Objetivo B"}], "tasks": []}, [])
        self.assertIn("Descripción de la línea: Objetivo B", prompt)

    def test_restaurar_fusionar_y_etiquetas(self):
        """D26/D27/D30: proposals only over what exists and makes sense right now."""
        snap = {**self.SNAP, "archivedProjects": [{"id": 20, "title": "LT vieja"}, {"id": 21, "title": "lt ana"}],
                "labels": [{"id": 5, "title": "Urgente"}, {"id": 6, "title": "Cata"}],
                "tasks": [{**self.SNAP["tasks"][0], "label_ids": [6]}, self.SNAP["tasks"][1]]}
        reply = ('x\n```acciones\n['
                 '{"action":"lt.restore","projectId":20},{"action":"lt.restore","projectId":21},{"action":"lt.restore","projectId":8},'
                 '{"action":"lt.merge","projectId":9,"targetProjectId":8},{"action":"lt.merge","projectId":8,"targetProjectId":8},'
                 '{"action":"label.assign","taskId":81,"labelId":5},{"action":"label.assign","taskId":81,"labelId":6},'
                 '{"action":"label.unassign","taskId":81,"labelId":6},{"action":"label.assign","taskId":81,"labelId":99}'
                 ']\n```')
        self.assertEqual(uc.split_proposals(reply, snap)[1], [
            {"action": "lt.restore", "projectId": 20},
            {"action": "lt.merge", "projectId": 9, "targetProjectId": 8},
            {"action": "label.assign", "taskId": 81, "labelId": 5},
            {"action": "label.unassign", "taskId": 81, "labelId": 6},
        ], "restore only archived lines whose name is free; merge into another line; labels only if they change something")

    def test_contexto_completo_y_fechas_de_chile(self):
        """D28/D29: full description of open tasks, creation date in Chile, notice when something did not fit."""
        long_log = "Detalle\n\n" + "\n\n".join(f"Avance 2026-10-{d:02d}: paso {d}" for d in range(1, 13)) + "\n\nNota 2026-10-13: DATO-FINAL"
        snap = {"projects": [{"id": 8, "title": "LT Ana"}], "labels": [{"id": 5, "title": "Urgente"}],
                "tasks": [{"id": 81, "title": "Abierta", "project_id": 8, "done": False, "description": long_log,
                           "created": "2026-10-14T01:30:00Z", "label_ids": [5]}]}
        prompt = uc.build_prompt(JOB, snap, [])
        self.assertIn("DATO-FINAL", prompt, "the end of a long open-task description is visible")
        self.assertIn("creada 2026-10-13", prompt, "01:30 UTC on the 14th is still the 13th in Santiago")
        self.assertIn("etiquetas: Urgente", prompt)
        self.assertNotIn("[Aviso:", prompt)
        big = {"projects": [{"id": 8, "title": "LT"}], "tasks": [
            {"id": i, "title": f"T{i}", "project_id": 8, "done": True, "description": "x" * 300} for i in range(1, 1000)]}  # > MAX_CONTEXT_CHARS
        self.assertIn("[Aviso: parte del contexto no cupo", uc.build_prompt(JOB, big, []))

    def test_editar_solo_la_fecha_conserva_el_titulo(self):
        """«Cambia la fecha de #143»: the model sends no title; the proposal keeps the current one."""
        snap = {"projects": [{"id": 11, "title": "LT"}], "tasks": [{"id": 143, "project_id": 11, "title": "Starlink", "done": False}]}
        _, proposals = uc.split_proposals('```acciones\n[{"action":"task.update","taskId":143,"dueDate":"2026-11-15","ejecutar":true}]\n```', snap)
        self.assertEqual(proposals[0]["title"], "Starlink")
        self.assertEqual(proposals[0]["dueDate"], "2026-11-15")
        self.assertIn("#143 (id 143)", uc.build_prompt(JOB, snap, []), "without own numbering the id is explicit too")

    def test_numero_propio_en_el_contexto(self):
        """E12: the copilot shows #N to the person and uses the real id in actions."""
        snap = {"projects": [{"id": 8, "title": "LT"}], "tasks": [{"id": 204, "num": 3, "title": "Informe", "project_id": 8, "done": False}]}
        prompt = uc.build_prompt({**JOB, "task": {"id": 204, "title": "Informe"}}, snap, [])
        self.assertIn("- #3 (id 204) Informe", prompt)
        self.assertIn("Tarea seleccionada: #3 (id 204)", prompt)
        self.assertIn("usa SIEMPRE el id X", prompt)

    def test_reabrir_solo_tareas_completadas(self):
        reply = 'x\n```acciones\n[{"action":"task.reopen","taskId":82},{"action":"task.reopen","taskId":81}]\n```'
        self.assertEqual(uc.split_proposals(reply, self.SNAP)[1], [{"action": "task.reopen", "taskId": 82}])

    def test_sin_bloque_o_json_invalido(self):
        self.assertEqual(uc.split_proposals("Solo texto.", self.SNAP), ("Solo texto.", []))
        self.assertEqual(uc.split_proposals("Hola\n```acciones\nno es json\n```", self.SNAP), ("Hola", []))

    def test_maximo_cinco(self):
        many = "\n```acciones\n" + str([{"action": "lt.create", "title": f"LT {i}"} for i in range(9)]).replace("'", '"') + "\n```"
        self.assertEqual(len(uc.split_proposals("x" + many, self.SNAP)[1]), 5)


if __name__ == "__main__":
    unittest.main()
