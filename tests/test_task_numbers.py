"""E12: each user sees their own task numbers (#1, #2…); the real Vikunja ID keeps working underneath."""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import task_numbers  # noqa: E402
import user_context  # noqa: E402

spec = importlib.util.spec_from_file_location("publish_dashboard", TOOLS / "publish_dashboard.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class TaskNumbersTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_numeracion_propia_estable(self):
        path = self.dir / "a.json"
        self.assertEqual(task_numbers.assign(path, [204, 207, 205]), {204: 1, 205: 2, 207: 3}, "creation order")
        self.assertEqual(task_numbers.assign(path, [207, 230]), {204: 1, 205: 2, 207: 3, 230: 4},
                         "a hidden (archived) task keeps its number; a new one gets the next")
        self.assertEqual(task_numbers.assign(path, [204, 205, 207, 230])[230], 4, "stable across runs")

    def test_cada_usuario_parte_en_uno_y_el_dueno_conserva_ids(self):
        user_context.set_numbers_dir(self.dir)
        try:
            ana = {"rootProjectId": 11, "vikunjaUrl": "http://lab"}
            beto = {"rootProjectId": 22, "vikunjaUrl": "http://lab"}
            owner = {"rootProjectId": 2, "vikunjaUrl": "http://prod", "ownNumbering": False}

            def snapshot_for(user, task_ids, root):
                projects = [{"id": root, "title": "Raíz"}, {"id": root + 1, "title": "LT", "parent_project_id": root}]
                def pages(base, path, token, params=None):
                    if path == "/api/v1/projects":
                        return projects
                    if path == "/api/v1/labels":
                        return []
                    return [{"id": i, "title": f"T{i}"} for i in task_ids]
                with user_context.using_user(user), patch.object(publisher, "pages", side_effect=pages):
                    return publisher.fetch_dashboard("http://lab", "token")

            self.assertEqual([t["num"] for t in snapshot_for(ana, [300, 301], 11)["tasks"]], [1, 2])
            self.assertEqual([t["num"] for t in snapshot_for(beto, [302], 22)["tasks"]], [1], "B also starts at #1")
            self.assertNotIn("num", snapshot_for(owner, [5], 2)["tasks"][0], "the owner keeps the real IDs")
        finally:
            user_context.set_numbers_dir(None)
        with user_context.using_user({"rootProjectId": 11}):
            self.assertIsNone(user_context.task_numbers_file(), "single-user mode: no numbering")


if __name__ == "__main__":
    unittest.main()
