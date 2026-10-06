"""Cooperative local task transactions preserve metadata and completion."""
import copy
import os
import tempfile
import threading
import unittest
from unittest.mock import patch
from test_hermes_bridge import bridge
from test_vikunja_dashboard_mcp import dashboard_mcp as vk, sample_task

class MutationConcurrencyTests(unittest.TestCase):
    def test_chat_read_waits_for_completion_transaction(self):
        task = sample_task()
        held, release, chat_read = threading.Event(), threading.Event(), threading.Event()
        errors = []
        def request(method, path, **kwargs):
            if path.endswith('/projects/2'):
                if threading.current_thread().name == 'completion' and not held.is_set():
                    held.set()
                    if not release.wait(4): raise RuntimeError('release missing')
                return {'id': 2, 'is_archived': False}
            if path.endswith('/projects/3'):
                return {'id': 3, 'parent_project_id': 2, 'is_archived': False}
            if method == 'GET':
                if threading.current_thread().name == 'chat':
                    chat_read.set()
                return copy.deepcopy(task)
            task.update(copy.deepcopy(kwargs.get('payload', kwargs.get('json'))))
            return copy.deepcopy(task)
        def run(fn):
            try: fn()
            except Exception as exc: errors.append(str(exc))
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'DSTA_TASK_LOCK_ROOT': root}), \
                patch.object(vk, 'request', side_effect=request), \
                patch.object(vk, 'pmo_projects', return_value=[{'id':3,'parent_project_id':2}]):
            first = threading.Thread(name='completion', target=run, args=(lambda: bridge.execute_completion(
                {'kind':'action','action':'complete','taskId':17,'projectId':3}, request),))
            second = threading.Thread(name='chat', target=run, args=(lambda: vk.pmo_append_log(17, 'chat history', '2026-10-06'),))
            first.start()
            self.assertTrue(held.wait(2))
            second.start()
            premature = chat_read.wait(.25)
            release.set()
            first.join(5); second.join(5)
        self.assertEqual(errors, [])
        self.assertFalse(premature, 'chat read escaped the shared task transaction')
        self.assertTrue(task['done'], 'stale chat payload resurrected task')
        self.assertIn('chat history', task['description'])

    def test_supplied_stale_current_is_not_authoritative(self):
        stale = sample_task()
        task = dict(stale, done=True, description='new history')
        def request(method, path, **kwargs):
            if method == 'POST': task.update(kwargs['json'])
            return dict(task)
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'DSTA_TASK_LOCK_ROOT': root}), \
                patch.object(vk, 'request', side_effect=request), \
                patch.object(vk, 'pmo_projects', return_value=[{'id':3,'parent_project_id':2}]):
            vk.update_task_fields(17, {'title':'edited'}, current=stale)
        self.assertTrue(task['done'])
        self.assertEqual(task['description'], 'new history')

    def test_comment_scope_read_participates_in_task_transaction(self):
        from task_mutation_lock import task_lock
        read, errors = threading.Event(), []
        task = sample_task()
        def request(method,path,**kwargs):
            read.set()
            return dict(task)
        def work():
            try: vk.pmo_add_comment(17, 'comment')
            except Exception as exc: errors.append(str(exc))
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'DSTA_TASK_LOCK_ROOT':root}), \
                patch.object(vk, 'request', side_effect=request), \
                patch.object(vk, 'pmo_projects', return_value=[{'id':3,'parent_project_id':2}]):
            with task_lock(vk.BASE_URL,17):
                thread = threading.Thread(target=work); thread.start()
                premature = read.wait(.2)
            thread.join(5)
        self.assertEqual(errors, [])
        self.assertFalse(premature, 'comment scope read bypassed task transaction')

class MinuteTransactionTests(unittest.TestCase):
    def test_execute_and_undo_read_only_after_shared_lock(self):
        from task_mutation_lock import task_lock
        minute = {'fecha':'2026-10-06','sourceId':'source','titulo':'Meeting'}
        for operation in ('execute', 'undo'):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as root, \
                    patch.dict(os.environ, {'DSTA_TASK_LOCK_ROOT': root}):
                task = sample_task()
                read, errors = threading.Event(), []
                action = {'tipo':'actualizar','task_id':17,'estado':'aplicada',
                          'responsable':'','fecha_objetivo':'','dependencia':'',
                          'titulo':'','nota':'minute history','antes':{}}
                def request(method, path, **kwargs):
                    if method == 'GET': read.set()
                    if method == 'POST': task.update(kwargs['json'])
                    return dict(task)
                def work():
                    try: getattr(bridge.minute_inbox, operation)(action, minute, vk)
                    except Exception as exc: errors.append(str(exc))
                with patch.object(vk, 'request', side_effect=request), \
                        patch.object(vk, 'pmo_projects', return_value=[{'id':3,'parent_project_id':2}]):
                    with task_lock(vk.BASE_URL,17):
                        thread = threading.Thread(target=work)
                        thread.start()
                        premature = read.wait(.2)
                        task['description'] += '\nconcurrent history'
                        task['done'] = True
                    thread.join(5)
                self.assertFalse(premature, 'minute description read was outside transaction')
                self.assertEqual(errors, [])
                self.assertIn('concurrent history', task['description'])
                self.assertTrue(task['done'])

if __name__ == '__main__': unittest.main()
