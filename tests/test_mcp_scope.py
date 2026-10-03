"""Prove dashboard writes cannot escape active PMO lines; no live API calls."""
import unittest
from unittest.mock import patch
from test_vikunja_dashboard_mcp import dashboard_mcp, sample_task


class DashboardScopeTests(unittest.TestCase):
    def test_task_writes_reject_non_pmo_and_archived_lines_before_mutation(self):
        methods = [
            lambda: dashboard_mcp.pmo_update_task(17, title='Updated'),
            lambda: dashboard_mcp.pmo_complete_task(17),
            lambda: dashboard_mcp.pmo_set_dependency(17, 'LT2'),
            lambda: dashboard_mcp.pmo_add_comment(17, 'Follow-up'),
        ]
        for project in [
            {'id':3, 'title':'Personal', 'parent_project_id':0},
            {'id':3, 'title':'LT1', 'parent_project_id':2, 'is_archived':True},
        ]:
            for method in methods:
                with self.subTest(project=project, method=method), \
                     patch.object(dashboard_mcp, 'pmo_projects', return_value=[project]), \
                     patch.object(dashboard_mcp, 'request', return_value=sample_task()) as request:
                    with self.assertRaisesRegex(ValueError, 'línea activa'):
                        method()
                    self.assertFalse(any(c.args[0] != 'GET' for c in request.call_args_list))

    def test_in_scope_comment_is_still_supported(self):
        project = {'id':3, 'title':'LT1', 'parent_project_id':2}
        with patch.object(dashboard_mcp, 'pmo_projects', return_value=[project]), \
             patch.object(dashboard_mcp, 'request', side_effect=[sample_task(), {'id':91,'comment':'Follow-up'}]) as request:
            result = dashboard_mcp.pmo_add_comment(17, 'Follow-up')
        self.assertEqual(result['comment'], 'Follow-up')
        self.assertEqual(request.call_args_list[1].args, ('PUT', '/api/v1/tasks/17/comments'))


if __name__ == '__main__':
    unittest.main()
