import unittest
from unittest.mock import patch
from pathlib import Path
from test_hermes_bridge import bridge

FIELDS='id title description project_id done due_date reminders repeat_after repeat_mode priority start_date end_date assignees hex_color percent_done cover_image_attachment_id is_favorite'.split()
def task():
    result={k:None for k in FIELDS}
    result.update(id=15,title='Task',description='SOURCE: synthetic; ACTION_KEY: stable',project_id=3,done=False)
    return result

class SafetyTests(unittest.TestCase):
    def test_expired_lease_never_writes_upstream(self):
        calls=[]
        def request(url,**kwargs):
            calls.append((url,kwargs))
            if url.endswith('/projects/2'):return {'id':2,'is_archived':False}
            if url.endswith('/projects/3'):return {'id':3,'parent_project_id':2,'is_archived':False}
            return task()
        job={'id':'id','kind':'action','action':'complete','taskId':15,'projectId':3,'attempt':'lease','leaseUntil':1}
        with patch.object(bridge,'request_json',side_effect=request), patch.object(bridge,'publish_snapshot',return_value='fresh'):
            bridge.process_job(job,'https://example.test','test','unused',Path('.'),'p','m','test','http://local')
        writes=[c for c in calls if '/api/v1/' in c[0] and c[1].get('method')=='POST']
        self.assertEqual(writes,[],'expired delivery must not POST to Vikunja')

    def test_invalid_or_archived_scope_never_writes(self):
        for missing in ('root','project','moved','partial','state'):
            calls=[]
            def request(method,path,**kwargs):
                calls.append(method)
                if path.endswith('/projects/2'):return {'id':2,'is_archived': missing=='root'}
                if path.endswith('/projects/3'):return {'id':3,'parent_project_id':2,'is_archived':missing=='project'}
                value=task()
                if missing=='moved':value['project_id']=4
                if missing=='partial':del value['reminders']
                if missing=='state':value['done']=None
                return value
            with self.subTest(missing=missing),self.assertRaises((ValueError,RuntimeError)):
                bridge.execute_completion({'kind':'action','action':'complete','taskId':15,'projectId':3},request)
            self.assertNotIn('POST',calls)

    def test_verification_failure_is_not_success(self):
        def request(method,path,**kwargs):
            if path.endswith('/projects/2'):return {'id':2,'is_archived':False}
            if path.endswith('/projects/3'):return {'id':3,'parent_project_id':2,'is_archived':False}
            return task() # POST ignored by upstream
        with self.assertRaises(RuntimeError):bridge.execute_completion({'kind':'action','action':'complete','taskId':15,'projectId':3},request)

if __name__=='__main__':unittest.main()
