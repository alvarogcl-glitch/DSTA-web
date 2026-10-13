"""F3 en el puente: acciones de estructura en Vikunja dentro de la raíz del usuario, preservando todos
los campos (Vikunja borra los omitidos) y sin duplicar creaciones en reintentos."""
import copy
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import user_context  # noqa: E402

spec = importlib.util.spec_from_file_location("structure_actions", TOOLS / "structure_actions.py")
sa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sa)

TASK_EXTRA = {"reminders": [], "repeat_after": 0, "repeat_mode": 0, "priority": 3, "start_date": "x", "end_date": "y",
              "assignees": [{"id": 9}], "hex_color": "ff0000", "percent_done": 0.5, "cover_image_attachment_id": 0,
              "is_favorite": True}


class FakeVikunja:
    def __init__(self):
        self.projects = {
            7: {"id": 7, "title": "Raíz A", "parent_project_id": 0, "is_archived": False},
            8: {"id": 8, "title": "LT A1", "parent_project_id": 7, "is_archived": False, "hex_color": "00ff00", "position": 2},
            9: {"id": 9, "title": "LT A2", "parent_project_id": 7, "is_archived": False},
            50: {"id": 50, "title": "Raíz ajena", "parent_project_id": 0, "is_archived": False},
            51: {"id": 51, "title": "LT ajena", "parent_project_id": 50, "is_archived": False},
        }
        self.tasks = {100: {"id": 100, "title": "Tarea", "description": "desc", "project_id": 8, "done": False,
                            "due_date": "0001-01-01T00:00:00Z", **TASK_EXTRA}}
        self.writes = []
        self.next_id = 200

    def __call__(self, method, path, payload=None, **kwargs):
        path, _, query = path.partition("?")
        parts = path.strip("/").split("/")  # api v1 <res> <id> [tasks]
        res, ident = parts[2], (int(parts[3]) if len(parts) > 3 and parts[3].isdigit() else None)
        store = self.projects if res == "projects" else self.tasks
        if method == "GET" and "page=" in query:  # paginated lists (one page)
            if "page=1&" not in query:
                return []
            if ident is None:
                return copy.deepcopy(list(self.projects.values()))
            return copy.deepcopy([t for t in self.tasks.values() if t["project_id"] == ident])
        if method == "GET":
            if ident not in store:
                raise ValueError("404")
            return copy.deepcopy(store[ident])
        self.writes.append((method, path, copy.deepcopy(payload)))
        if method == "PUT" and res == "projects" and len(parts) == 5:  # create task
            self.next_id += 1
            task = {"id": self.next_id, "done": False, "due_date": "0001-01-01T00:00:00Z", **TASK_EXTRA, "description": "",
                    **payload, "project_id": ident}
            self.tasks[self.next_id] = task
            return copy.deepcopy(task)
        if method == "PUT" and res == "projects":  # create project
            self.next_id += 1
            self.projects[self.next_id] = {"id": self.next_id, "is_archived": False, **payload}
            return copy.deepcopy(self.projects[self.next_id])
        if method == "POST":
            store[ident] = copy.deepcopy(payload)
            return copy.deepcopy(payload)
        raise AssertionError(path)


class StructureActionsTest(unittest.TestCase):
    def setUp(self):
        self.vk = FakeVikunja()
        self.cache = Path(tempfile.mkdtemp())

    def run_action(self, job):
        with user_context.using_root(7):
            return sa.execute({"id": "req-1", "kind": "action", **job} if "id" not in job else {"kind": "action", **job}, self.vk, cache_dir=self.cache, server_url="http://lab")

    def test_crear_tarea_en_lt_propia(self):
        result = self.run_action({"action": "task.create", "projectId": 8, "title": " Nueva ", "description": "d", "dueDate": "2026-11-01"})
        task = self.vk.tasks[result["taskId"]]
        self.assertEqual((task["title"], task["project_id"]), ("Nueva", 8))
        self.assertTrue(task["description"].startswith("Responsable: Por confirmar\nFecha objetivo: 2026-11-01"), "D04: formato estructurado")
        self.assertTrue(task["description"].endswith("\n\nd"))
        self.assertTrue(task["due_date"].startswith("2026-11-01"))

    def test_crear_con_campos_estructurados_como_produccion(self):
        result = self.run_action({"action": "task.create", "projectId": 8, "title": "Preparar informe de riesgos",
                                  "description": "Informe para el comité.", "owner": "Paula", "dueDate": "2026-10-20",
                                  "dependency": "Informe de Finanzas", "criterion": "Informe revisado y enviado", "origin": "form"})
        description = self.vk.tasks[result["taskId"]]["description"]
        self.assertEqual(description,
                         "Responsable: Paula\nFecha objetivo: 2026-10-20\nDependencia: Informe de Finanzas\n"
                         "Criterio de cierre: Informe revisado y enviado\nSOURCE: DSTA Dashboard Formulario\n"
                         "ACTION_KEY: DSTA-FORM-req-1\n\nInforme para el comité.")
        empty = self.run_action({"action": "task.create", "projectId": 8, "title": "Sin datos", "origin": "copilot"} | {"id": "req-9"})
        self.assertIn("Responsable: Por confirmar\nFecha objetivo: Por confirmar", self.vk.tasks[empty["taskId"]]["description"])
        self.assertIn("SOURCE: DSTA Dashboard Copilot", self.vk.tasks[empty["taskId"]]["description"])

    def test_editar_campos_estructurados_conserva_bitacora(self):
        self.vk.tasks[100]["description"] = ("Responsable: Por confirmar\nFecha objetivo: 2026-10-01\nDependencia: Por confirmar\n"
                                             "Criterio de cierre: Por confirmar\n\nDetalle\n\nAvance 2026-10-02: hito")
        self.run_action({"action": "task.update", "taskId": 100, "sourceProjectId": 8, "title": "Tarea",
                         "owner": "José", "dependency": "Legal"})
        description = self.vk.tasks[100]["description"]
        self.assertIn("Responsable: José", description)
        self.assertIn("Dependencia: Legal", description)
        self.assertIn("Fecha objetivo: 2026-10-01", description, "campos no enviados no cambian")
        self.assertTrue(description.endswith("Detalle\n\nAvance 2026-10-02: hito"), "bitácora intacta")

    def test_editar_detalle_no_toca_metadatos_ni_bitacora(self):
        """D06-A: only the detail is editable; the log is append-only."""
        self.vk.tasks[100]["description"] = ("Responsable: Ana\nFecha objetivo: 2026-10-01\nSOURCE: DSTA Dashboard Formulario\n\n"
                                             "Detalle viejo\n\nsegundo párrafo\n\nAvance 2026-10-02: hito\n\nNota 2026-10-03: ojo")
        self.run_action({"action": "task.update", "taskId": 100, "sourceProjectId": 8, "title": "Tarea",
                         "detail": "Detalle nuevo", "owner": "Paula"})
        self.assertEqual(self.vk.tasks[100]["description"],
                         "Responsable: Paula\nFecha objetivo: 2026-10-01\nSOURCE: DSTA Dashboard Formulario\n\n"
                         "Detalle nuevo\n\nAvance 2026-10-02: hito\n\nNota 2026-10-03: ojo")
        # Emptying the detail keeps metadata and log; plain old descriptions are all detail.
        self.run_action({"action": "task.update", "taskId": 100, "sourceProjectId": 8, "title": "Tarea", "detail": "", "id": "req-2"})
        self.assertEqual(self.vk.tasks[100]["description"],
                         "Responsable: Paula\nFecha objetivo: 2026-10-01\nSOURCE: DSTA Dashboard Formulario\n\n"
                         "Avance 2026-10-02: hito\n\nNota 2026-10-03: ojo")
        self.assertEqual(sa.split_description("Texto libre: con dos puntos\n\nmás"), ("", "Texto libre: con dos puntos\n\nmás", ""))

    def test_fecha_nativa_manda_y_la_linea_la_sigue(self):
        """D05: changing or removing the date keeps due_date and "Fecha objetivo" consistent."""
        self.vk.tasks[100]["description"] = "Responsable: Ana\nFecha objetivo: 2026-10-20\n\nDetalle"
        self.run_action({"action": "task.update", "taskId": 100, "sourceProjectId": 8, "title": "Tarea", "dueDate": "2026-10-30"})
        self.assertTrue(self.vk.tasks[100]["due_date"].startswith("2026-10-30T12:00"), "mediodía UTC: mismo día en Santiago")
        self.assertEqual(self.vk.tasks[100]["description"], "Responsable: Ana\nFecha objetivo: 2026-10-30\n\nDetalle")
        self.run_action({"action": "task.update", "taskId": 100, "sourceProjectId": 8, "title": "Tarea", "dueDate": "", "id": "req-2"})
        self.assertTrue(self.vk.tasks[100]["due_date"].startswith("0001-01-01"))
        self.assertIn("Fecha objetivo: Por confirmar", self.vk.tasks[100]["description"])

    def test_crear_es_idempotente_ante_reintentos(self):
        first = self.run_action({"action": "task.create", "projectId": 8, "title": "Una vez"})
        second = self.run_action({"action": "task.create", "projectId": 8, "title": "Una vez"})
        self.assertEqual(first, second)
        self.assertEqual(sum(1 for t in self.vk.tasks.values() if t["title"] == "Una vez"), 1)

    def test_editar_preserva_campos_no_tocados(self):
        result = self.run_action({"action": "task.update", "taskId": 100, "sourceProjectId": 8, "title": "Renombrada"})
        self.assertEqual(result, {"taskId": 100})
        task = self.vk.tasks[100]
        self.assertEqual(task["title"], "Renombrada")
        self.assertEqual(task["description"], "desc", "sin description en el job, se conserva")
        for key, value in TASK_EXTRA.items():
            self.assertEqual(task[key], value, f"{key} preservado")

    def test_mover_entre_lts_propias(self):
        self.run_action({"action": "task.move", "taskId": 100, "sourceProjectId": 8, "projectId": 9})
        self.assertEqual(self.vk.tasks[100]["project_id"], 9)
        self.assertEqual(self.vk.tasks[100]["assignees"], [{"id": 9}])

    def test_nombres_de_linea_unicos(self):
        """D24: no two active lines with the same name (case, accents and spaces ignored)."""
        for job in ({"action": "lt.create", "title": "lt  a1"}, {"action": "lt.rename", "projectId": 9, "title": "LT Á1"}):
            with self.assertRaisesRegex(ValueError, "Ya existe una línea con ese nombre"):
                self.run_action(job)
        self.assertEqual(self.vk.writes, [])
        self.run_action({"action": "lt.rename", "projectId": 8, "title": "lt a1"})  # same line, other casing: allowed
        self.run_action({"action": "lt.create", "title": "LT ajena"})  # another user's root does not count
        created = self.run_action({"action": "lt.create", "title": "Nueva única", "id": "req-new"})
        self.assertEqual(self.run_action({"action": "lt.create", "title": "Nueva única", "id": "req-new"}), created,
                         "a retry of the same request is not a duplicate")

    def test_archivar_solo_sin_tareas_abiertas(self):
        """D25: a line with open tasks is not archived; completed ones go with it."""
        with self.assertRaisesRegex(ValueError, "1 tareas abiertas"):
            self.run_action({"action": "lt.archive", "projectId": 8})
        self.assertFalse(self.vk.projects[8]["is_archived"])
        self.vk.tasks[100]["done"] = True
        self.run_action({"action": "lt.archive", "projectId": 8, "id": "req-2"})
        self.assertTrue(self.vk.projects[8]["is_archived"])
        self.assertIn(100, self.vk.tasks, "completed tasks are kept")

    def test_restaurar_linea_archivada(self):
        """D27: restore keeps the ID; refused if an active line now has its name."""
        self.vk.projects[30] = {"id": 30, "title": "LT archivada", "parent_project_id": 7, "is_archived": True, "hex_color": "abcdef"}
        self.vk.projects[31] = {"id": 31, "title": "LT A2", "parent_project_id": 7, "is_archived": True}
        self.assertEqual(self.run_action({"action": "lt.restore", "projectId": 30}), {"projectId": 30})
        self.assertFalse(self.vk.projects[30]["is_archived"])
        self.assertEqual(self.vk.projects[30]["hex_color"], "abcdef")
        with self.assertRaisesRegex(ValueError, "Ya existe una línea con ese nombre"):
            self.run_action({"action": "lt.restore", "projectId": 31, "id": "req-2"})
        with self.assertRaises(ValueError):
            self.run_action({"action": "lt.restore", "projectId": 50, "id": "req-3"})  # another user's root

    def test_fusionar_lineas_como_produccion(self):
        """D26: move every task (open and done) keeping its fields, then archive the empty source."""
        self.vk.tasks[101] = {**self.vk.tasks[100], "id": 101, "title": "Hecha", "done": True}
        result = self.run_action({"action": "lt.merge", "projectId": 8, "targetProjectId": 9})
        self.assertEqual(result, {"projectId": 8, "movedTaskIds": [100, 101]})
        self.assertEqual({self.vk.tasks[i]["project_id"] for i in (100, 101)}, {9})
        self.assertEqual(self.vk.tasks[101]["assignees"], [{"id": 9}])
        self.assertTrue(self.vk.projects[8]["is_archived"])
        self.assertEqual(self.run_action({"action": "lt.merge", "projectId": 8, "targetProjectId": 9}), result,
                         "a retry after success returns the same result")
        with self.assertRaises(ValueError):
            self.run_action({"action": "lt.merge", "projectId": 9, "targetProjectId": 51, "id": "req-2"})  # foreign target

    def test_descripcion_de_linea(self):
        """D23: editing a line's description keeps its other fields."""
        self.run_action({"action": "lt.describe", "projectId": 8, "description": " Objetivo de la línea "})
        self.assertEqual(self.vk.projects[8]["description"], "Objetivo de la línea")
        self.assertEqual((self.vk.projects[8]["title"], self.vk.projects[8]["hex_color"]), ("LT A1", "00ff00"))

    def test_reabrir_tarea_completada(self):
        """D14: reopening only flips done; every other field is preserved."""
        self.vk.tasks[100]["done"] = True
        self.assertEqual(self.run_action({"action": "task.reopen", "taskId": 100, "sourceProjectId": 8}), {"taskId": 100})
        task = self.vk.tasks[100]
        self.assertFalse(task["done"])
        self.assertEqual((task["title"], task["description"]), ("Tarea", "desc"))
        for key, value in TASK_EXTRA.items():
            self.assertEqual(task[key], value, f"{key} preservado")

    def test_no_sale_de_la_raiz_del_usuario(self):
        for job in ({"action": "task.move", "taskId": 100, "sourceProjectId": 8, "projectId": 51},
                    {"action": "task.create", "projectId": 51, "title": "x"},
                    {"action": "lt.rename", "projectId": 51, "title": "x"},
                    {"action": "lt.archive", "projectId": 7}):
            with self.assertRaises(ValueError, msg=job["action"]):
                self.run_action(job)
        self.assertEqual(self.vk.writes, [], "ninguna escritura fuera de alcance")

    def test_lts_crear_renombrar_archivar(self):
        created = self.run_action({"action": "lt.create", "title": "LT nueva"})
        self.assertEqual(self.vk.projects[created["projectId"]]["parent_project_id"], 7)
        self.run_action({"action": "lt.rename", "projectId": 8, "title": "LT A1 bis"})
        self.assertEqual(self.vk.projects[8]["title"], "LT A1 bis")
        self.assertEqual(self.vk.projects[8]["hex_color"], "00ff00", "renombrar preserva el color")
        self.run_action({"action": "lt.archive", "projectId": 9})
        self.assertTrue(self.vk.projects[9]["is_archived"])

    def test_registro_en_bitacora_preserva_campos(self):
        result = self.run_action({"action": "task.log", "taskId": 100, "sourceProjectId": 8, "entry": " Avance real ",
                                  "entryDate": "2026-10-13", "logKind": "Avance"})
        self.assertEqual(result, {"taskId": 100})
        task = self.vk.tasks[100]
        self.assertEqual(task["description"], "desc\n\nAvance 2026-10-13: Avance real", "mismo formato que pmo_append_log")
        for key, value in TASK_EXTRA.items():
            self.assertEqual(task[key], value, f"{key} preservado")
        with self.assertRaises(ValueError):
            self.run_action({"action": "task.log", "taskId": 100, "sourceProjectId": 8, "entry": "x", "entryDate": "2026-10-13", "logKind": "Chisme"})

    def test_registro_repetido_se_escribe_una_sola_vez(self):
        """D18: if the confirmation is lost and the same request is delivered again, one entry only."""
        job = {"action": "task.log", "taskId": 100, "sourceProjectId": 8, "entry": "Avance único", "entryDate": "2026-10-13"}
        self.run_action(job)
        self.run_action(job)  # same request id delivered again
        self.assertEqual(self.vk.tasks[100]["description"].count("Actualización 2026-10-13: Avance único"), 1)
        # Crash after writing but before recording "done": the pending marker (written before the
        # write) survives, so the entry already at the end is not appended again.
        done = self.cache / "structure-created" / "req-1.json"
        done.unlink()
        (self.cache / "structure-pending").mkdir(parents=True, exist_ok=True)
        (self.cache / "structure-pending" / "req-1").write_text("", encoding="utf-8")
        self.run_action(job)
        self.assertEqual(self.vk.tasks[100]["description"].count("Actualización 2026-10-13: Avance único"), 1)
        # A different request with the same text (a deliberate new entry) is written.
        with user_context.using_root(7):
            sa.execute({"id": "req-2", "kind": "action", **job}, self.vk, cache_dir=self.cache, server_url="http://lab")
        self.assertEqual(self.vk.tasks[100]["description"].count("Actualización 2026-10-13: Avance único"), 2)

    def test_accion_desconocida(self):
        with self.assertRaises(ValueError):
            self.run_action({"action": "lt.delete", "projectId": 8})


if __name__ == "__main__":
    unittest.main()
