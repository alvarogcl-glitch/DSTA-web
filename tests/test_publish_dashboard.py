import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

module_path = Path(__file__).resolve().parents[1] / "tools" / "publish_dashboard.py"
spec = importlib.util.spec_from_file_location("dsta_publisher", module_path)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class DynamicPortfolioTests(unittest.TestCase):
    def test_new_line_is_published_and_archived_line_is_excluded(self):
        projects = [
            {"id": 2, "title": "PMO-DSTA", "parent_project_id": 0},
            {"id": 11, "title": "LT9 - Nueva", "parent_project_id": 2, "position": 1},
            {"id": 12, "title": "TR2 - Antigua", "parent_project_id": 2, "is_archived": True},
            {"id": 13, "title": "Personal", "parent_project_id": 0},
        ]
        def pages(_, path, __):
            if path == "/api/v1/projects":
                return projects
            self.assertEqual(path, "/api/v1/projects/11/tasks")
            return [{"id": 27, "title": "Acción", "description": "Responsable: Ana"}]
        with patch.object(publisher, "pages", side_effect=pages):
            snapshot = publisher.fetch_dashboard("http://local", "test")
        self.assertEqual([project["id"] for project in snapshot["projects"]], [11])
        self.assertEqual(snapshot["tasks"][0]["project"], "LT9 - Nueva")

    def test_missing_root_fails_without_publishing_partial_portfolio(self):
        with patch.object(publisher, "pages", return_value=[]):
            with self.assertRaisesRegex(RuntimeError, "raíz PMO-DSTA"):
                publisher.fetch_dashboard("http://local", "test")


if __name__ == "__main__":
    unittest.main()
