import unittest
from pathlib import Path
from unittest.mock import patch
from test_hermes_bridge import bridge

class DirectActionTests(unittest.TestCase):
    def test_action_never_calls_model_and_fences_ack(self):
        job = {'id':'12345678-1234-4234-8234-123456789012','kind':'action','action':'complete','taskId':15,'projectId':3,'attempt':'lease'}
        with patch.object(bridge, 'answer_chat', side_effect=AssertionError('AI forbidden')) as ai, \
             patch.object(bridge, 'execute_completion', create=True, return_value={'done':True}) as execute, \
             patch.object(bridge, 'publish_snapshot', return_value='2026-10-06T14:00:00Z'), \
             patch.object(bridge, 'request_json', return_value={}) as requests:
            bridge.process_job(job,'https://example.test','bridge','hermes',Path('.'),'p','m','vk','http://local')
        ai.assert_not_called()
        execute.assert_called_once()
        payload = requests.call_args.kwargs['payload']
        self.assertEqual(payload['kind'],'action')
        self.assertEqual(payload['attempt'],'lease')
        self.assertEqual(payload['snapshotTimestamp'],'2026-10-06T14:00:00Z')

    def test_preserves_fields_rereads_and_verifies(self):
        execute = getattr(bridge, 'execute_completion', None)
        self.assertTrue(callable(execute), 'deterministic executor missing')
        fields = 'id title description project_id done due_date reminders repeat_after repeat_mode priority start_date end_date assignees hex_color percent_done cover_image_attachment_id is_favorite'.split()
        task = {key: None for key in fields}
        task.update(id=15, title='Task', description='SOURCE: meeting; ACTION_KEY: stable', project_id=3, done=False)
        calls = []
        def request(method,path,**kwargs):
            calls.append((method,path,kwargs))
            if path.endswith('/projects/2'): return {'id':2,'is_archived':False}
            if path.endswith('/projects/3'): return {'id':3,'parent_project_id':2,'is_archived':False}
            if method == 'POST':
                self.assertEqual(kwargs['payload'],dict(task,done=True))
                task['done'] = True
            return dict(task)
        job = {'kind':'action','action':'complete','taskId':15,'projectId':3}
        self.assertTrue(execute(job,request)['done'])
        self.assertEqual(sum(c[0]=='POST' for c in calls),1)
        execute(job,request)
        self.assertEqual(sum(c[0]=='POST' for c in calls),1,'already done must not POST')

if __name__ == '__main__': unittest.main()
