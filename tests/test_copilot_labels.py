"""Copilot label tools use native incremental operations without live writes."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from test_vikunja_dashboard_mcp import dashboard_mcp as vk
from test_label_actions import NativeLabels


class CopilotLabelTests(unittest.TestCase):
    def setUp(self):
        self.native = NativeLabels()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        def request(method, path, **kwargs):
            return self.native.request(method, path, kwargs.get('json'))
        for mock in (
            patch.object(vk, 'request', side_effect=request),
            patch.object(vk, 'pmo_projects', return_value=[{'id': 3, 'parent_project_id': 2}]),
            patch.object(vk, 'HERMES_ENV', Path(self.tmp.name) / '.env'),
        ):
            mock.start()
            self.addCleanup(mock.stop)

    def test_incremental_classification_preserves_native_task_fields(self):
        before = {k: v for k, v in self.native.tasks[15].items() if k != 'labels'}
        result = vk.pmo_edit_task_labels(15, add_ids=[1])
        self.assertTrue(result['verified'])
        self.assertEqual({l['id'] for l in result['task']['labels']}, {1, 2})
        vk.pmo_edit_task_labels(15, remove_ids=[2])
        self.assertEqual({l['id'] for l in self.native.tasks[15]['labels']}, {1})
        self.assertEqual(before, {k: v for k, v in self.native.tasks[15].items() if k != 'labels'})
        self.assertFalse(any(m == 'POST' and p == '/api/v1/tasks/15' for m, p, _ in self.native.writes))

    def test_create_reuse_rename_and_recolor(self):
        vk.pmo_edit_task_labels(15, new_title='Innovación', hex_color='f6c85f')
        vk.pmo_edit_task_labels(15, new_title='INNOVACION')
        self.assertEqual(len(self.native.labels), 3)
        vk.pmo_update_label(3, title='Innovación aplicada')
        self.assertEqual(self.native.labels[3]['hex_color'], 'f6c85f')
        vk.pmo_update_label(3, hex_color='c6a0f6')
        self.assertEqual(self.native.labels[3]['title'], 'Innovación aplicada')

    def test_rename_preserves_existing_color_outside_palette(self):
        self.native.labels[2]['hex_color'] = '09f190'
        vk.pmo_update_label(2, title='Renombrada')
        self.assertEqual(self.native.labels[2]['hex_color'], '09f190')
        with self.assertRaises(ValueError):
            vk.pmo_update_label(2, hex_color='123456')

    def test_invalid_or_out_of_scope_change_has_no_writes(self):
        for fields in [{'add_ids': [999]}, {'add_ids': [1], 'remove_ids': [1]}]:
            with self.assertRaises(ValueError):
                vk.pmo_edit_task_labels(15, **fields)
        with patch.object(vk, 'pmo_projects', return_value=[]):
            with self.assertRaises(ValueError):
                vk.pmo_edit_task_labels(15, new_title='No crear')
        self.assertEqual(self.native.writes, [])

    def test_delete_backups_and_protects_carrera(self):
        with self.assertRaises(ValueError):
            vk.pmo_delete_label(1)
        vk.pmo_delete_label(2)
        self.assertEqual(set(self.native.labels), {1})
        self.assertEqual(len(list((Path(self.tmp.name) / 'cache/label-backups').glob('*.json'))), 1)

    def test_readonly_allowlist_exposes_catalog_without_mutations(self):
        self.assertIn('pmo_list_labels', vk.READ_ONLY_TOOLS)
        self.assertIn('pmo_list_label_tasks', vk.READ_ONLY_TOOLS)
        for tool in ['pmo_create_label', 'pmo_update_label', 'pmo_delete_label', 'pmo_edit_task_labels']:
            self.assertNotIn(tool, vk.READ_ONLY_TOOLS)
            self.assertIn(tool, {t.name for t in vk.mcp._tool_manager.list_tools()})

    def test_label_task_query_filters_scope_and_completion(self):
        tasks = [dict(self.native.tasks[15]), {'id': 16, 'done': True, 'labels': [{'id': 2}]},
                 {'id': 17, 'done': False, 'labels': []}]
        with patch.object(vk, 'project_tasks', return_value=tasks):
            self.assertEqual([t['id'] for t in vk.pmo_list_label_tasks(2)['tasks']], [15, 16])
            self.assertEqual([t['id'] for t in vk.pmo_list_label_tasks(2, False)['tasks']], [15])
        self.assertEqual(self.native.writes, [])

    def test_task_query_does_not_stop_at_server_page_limit(self):
        rows = [{'id': i} for i in range(121)]
        def request(method, path, params):
            size = min(params['per_page'], 50)
            return rows[(params['page'] - 1) * size:params['page'] * size]
        with patch.object(vk, 'request', side_effect=request):
            self.assertEqual(vk.project_tasks(3), rows)


if __name__ == '__main__':
    unittest.main()
