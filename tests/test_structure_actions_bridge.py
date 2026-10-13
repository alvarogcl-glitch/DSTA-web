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
        parts = path.strip("/").split("/")  # api v1 <res> <id> [tasks]
        res, ident = parts[2], (int(parts[3]) if len(parts) > 3 and parts[3].isdigit() else None)
        store = self.projects if res == "projects" else self.tasks
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
            return sa.execute({"id": "req-1", "kind": "action", **job}, self.vk, cache_dir=self.cache, server_url="http://lab")

    def test_crear_tarea_en_lt_propia(self):
        result = self.run_action({"action": "task.create", "projectId": 8, "title": " Nueva ", "description": "d", "dueDate": "2026-11-01"})
        task = self.vk.tasks[result["taskId"]]
        self.assertEqual((task["title"], task["project_id"], task["description"]), ("Nueva", 8, "d"))
        self.assertTrue(task["due_date"].startswith("2026-11-01"))

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

    def test_accion_desconocida(self):
        with self.assertRaises(ValueError):
            self.run_action({"action": "lt.delete", "projectId": 8})


if __name__ == "__main__":
    unittest.main()
