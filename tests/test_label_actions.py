import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.error import HTTPError
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import label_actions as actions


class NativeLabels:
    def __init__(self):
        self.labels = {1: {'id':1,'title':'Carrera tecnológica','hex_color':'86e2bb','description':''},
                       2: {'id':2,'title':'Antigua','hex_color':'8bbcff','description':'Original'}}
        self.tasks = {15:{'id':15,'project_id':3,'description':'SOURCE: real\nACTION_KEY: original','done':False,'labels':[self.labels[2]]}}
        self.writes = []
        self.archived = False
    def request(self, method, path, payload=None):
        path = path.split('?')[0]
        if method != 'GET': self.writes.append((method,path,payload))
        if path == '/api/v1/projects/2': return {'id':2,'is_archived':False}
        if path == '/api/v1/projects/3': return {'id':3,'parent_project_id':2,'is_archived':self.archived}
        if path == '/api/v1/tasks': return list(self.tasks.values())
        if path == '/api/v1/tasks/15': return self.tasks[15]
        if path == '/api/v1/tasks/15/labels':
            if method == 'GET': return self.tasks[15]['labels'][:]
            self.tasks[15]['labels'].append(self.labels[payload['label_id']]);return {}
        if path.startswith('/api/v1/tasks/15/labels/'):
            self.tasks[15]['labels'] = [l for l in self.tasks[15]['labels'] if l['id'] != int(path.rsplit('/',1)[1])];return {}
        if path == '/api/v1/labels':
            if method == 'GET': return list(self.labels.values())
            lid=max(self.labels)+1; self.labels[lid]={'id':lid,**payload};return self.labels[lid]
        if path.startswith('/api/v1/labels/'):
            lid=int(path.rsplit('/',1)[1])
            if lid not in self.labels: raise HTTPError(path,404,'missing',{},None)
            if method == 'GET': return self.labels[lid].copy()
            if method == 'POST': self.labels[lid].update(payload);return self.labels[lid]
            if method == 'DELETE':
                del self.labels[lid]
                for t in self.tasks.values(): t['labels']=[l for l in t['labels'] if l['id']!=lid]
                return {}
        raise AssertionError((method,path))


class LabelActionTests(unittest.TestCase):
    def test_backup_pagination_reads_associations_beyond_server_limit(self):
        from urllib.parse import urlparse, parse_qs
        rows = [{'id': i} for i in range(1, 122)]
        def request(method, path):
            query = parse_qs(urlparse(path).query)
            page = int(query['page'][0])
            size = min(int(query['per_page'][0]), 50)
            return rows[(page - 1) * size:page * size]
        self.assertEqual(actions.list_all(request, '/api/v1/tasks'), rows)

    def setUp(self):
        self.native=NativeLabels();self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
    def run_job(self, **job):
        return actions.execute({'id':'test-request',**job},self.native.request,server_url='http://native.test',cache_dir=self.temp.name)
    def test_create_and_assign_is_idempotent_and_preserves_task(self):
        before={k:v for k,v in self.native.tasks[15].items() if k!='labels'}
        args=dict(action='create',title='Innovación',color='f6c85f',taskId=15,projectId=3)
        result=self.run_job(**args);self.run_job(**args)
        self.assertEqual(len(self.native.labels),3)
        self.assertEqual(sum(1 for m,p,_ in self.native.writes if m=='PUT' and p=='/api/v1/labels'),1)
        self.assertIn(result['labelId'],[l['id'] for l in self.native.tasks[15]['labels']])
        self.assertEqual(before,{k:v for k,v in self.native.tasks[15].items() if k!='labels'})
    def test_assign_unassign_does_not_replace_other_labels(self):
        self.run_job(action='assign',labelId=1,taskId=15,projectId=3)
        self.run_job(action='assign',labelId=1,taskId=15,projectId=3)
        self.run_job(action='unassign',labelId=1,taskId=15,projectId=3)
        self.run_job(action='unassign',labelId=1,taskId=15,projectId=3)
        self.assertEqual([l['id'] for l in self.native.tasks[15]['labels']],[2])
    def test_archived_task_scope_rejects_before_writing(self):
        self.native.archived=True
        with self.assertRaises(ValueError):self.run_job(action='assign',labelId=1,taskId=15,projectId=3)
        self.assertEqual(self.native.writes,[])
    def test_update_preserves_description_and_rejects_arbitrary_rgb(self):
        self.run_job(action='update',labelId=2,title='Seguimiento',color='f6c85f')
        self.assertEqual(self.native.labels[2]['description'],'Original')
        with self.assertRaises(ValueError):self.run_job(action='update',labelId=2,title='Seguimiento',color='123456')
    def test_duplicate_title_matches_accents_and_case(self):
        with self.assertRaises(ValueError):self.run_job(action='create',title='CARRERA TECNOLOGICA',color='86e2bb')
        self.assertEqual(self.native.writes,[])
    def test_reset_backups_and_preserves_protected_and_new_labels(self):
        target=self.native.labels[2].copy()
        self.native.labels[4]={'id':4,'title':'Posterior','hex_color':'f6c85f'}
        self.run_job(action='reset',preservedId=1,targets=[target])
        self.assertEqual(set(self.native.labels),{1,4})
        backup=json.loads((Path(self.temp.name)/'label-backups/test-request.json').read_text())
        self.assertEqual(backup['associations'],[{'taskId':15,'labelIds':[2]}])
        self.assertEqual(backup['labels'][0]['description'],'Original')
        self.run_job(action='reset',preservedId=1,targets=[target])
        self.assertEqual(len([w for w in self.native.writes if w[0]=='DELETE']),1)
    def test_reset_missing_protected_and_changed_label_fail_closed(self):
        target=self.native.labels[2].copy();self.native.labels[1]['title']='Otra'
        with self.assertRaises(ValueError):self.run_job(action='reset',preservedId=1,targets=[target])
        self.assertEqual(self.native.writes,[])
        self.native.labels[1]['title']='Carrera tecnológica';self.native.labels[2]['title']='Renombrada'
        with self.assertRaises(ValueError):self.run_job(action='reset',preservedId=1,targets=[target])
        self.assertEqual(self.native.writes,[])
    def test_cannot_delete_protected_label(self):
        with self.assertRaises(ValueError):self.run_job(action='delete',target=self.native.labels[1].copy())
        self.assertEqual(self.native.writes,[])
    def test_publisher_exposes_native_labels_and_hash_changes_with_colors(self):
        spec=importlib.util.spec_from_file_location('label_publisher',Path(__file__).resolve().parents[1]/'tools/publish_dashboard.py')
        publisher=importlib.util.module_from_spec(spec);spec.loader.exec_module(publisher)
        from unittest.mock import patch
        def pages(base,path,token):
            if path=='/api/v1/projects':return [{'id':2},{'id':3,'parent_project_id':2,'title':'LT1'}]
            if path=='/api/v1/labels':return list(self.native.labels.values())
            return list(self.native.tasks.values())
        with patch.object(publisher,'pages',side_effect=pages):snapshot=publisher.fetch_dashboard('local','test')
        self.assertEqual(snapshot['tasks'][0]['label_ids'],[2])
        before=publisher.content_hash(snapshot);snapshot['labels'][0]['hex_color']='8bbcff'
        self.assertNotEqual(before,publisher.content_hash(snapshot))

if __name__=='__main__':unittest.main()
