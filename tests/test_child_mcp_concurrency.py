"""Actual child MCP and bridge coordinate through OS locks, against localhost only."""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen
from unittest.mock import patch
from test_hermes_bridge import bridge
from test_vikunja_dashboard_mcp import sample_task

TOOLS = Path(__file__).resolve().parents[1] / 'tools'

class ChildMCPConcurrencyTests(unittest.TestCase):
    def test_actual_child_log_cannot_resurrect_completed_task(self):
        task = sample_task()
        child_read = threading.Event()
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                if self.headers.get('Authorization') == 'Bearer child': child_read.set()
                if self.path == '/api/v1/projects': value = [{'id':3,'parent_project_id':2,'is_archived':False}]
                elif self.path == '/api/v1/projects/2': value = {'id':2,'is_archived':False}
                elif self.path == '/api/v1/projects/3': value = {'id':3,'parent_project_id':2,'is_archived':False}
                else: value = copy.deepcopy(task)
                self.send(value)
            def do_POST(self):
                task.update(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send(copy.deepcopy(task))
            def send(self,value):
                body = json.dumps(value).encode()
                self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
        serving = threading.Thread(target=server.serve_forever,daemon=True);serving.start()
        url = f'http://127.0.0.1:{server.server_port}'
        code = "import vikunja_dashboard_mcp as vk; print('ready',flush=True); vk.pmo_append_log(17,'child history','2026-10-06'); print('written',flush=True)"
        def request(method,path,**kwargs):
            data = json.dumps(kwargs['payload']).encode() if 'payload' in kwargs else None
            with urlopen(Request(url+path,data=data,method=method,headers={'Content-Type':'application/json'}),timeout=3) as response:
                return json.load(response)
        child = None
        try:
            with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'DSTA_TASK_LOCK_ROOT':root}):
                from task_mutation_lock import task_lock
                env = dict(os.environ,VIKUNJA_URL=url,VIKUNJA_API_TOKEN='child',PYTHONPATH=str(TOOLS))
                with task_lock(url,17):
                    child = subprocess.Popen([sys.executable,'-c',code],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                    ready = threading.Event()
                    line = []
                    reader = threading.Thread(target=lambda:(line.append(child.stdout.readline().strip()),ready.set()),daemon=True);reader.start()
                    self.assertTrue(ready.wait(8),'child MCP import timed out')
                    self.assertEqual(line,['ready'])
                    self.assertFalse(child_read.wait(.25),'actual child fetched before OS lock')
                    verified = bridge.execute_completion({'kind':'action','action':'complete','taskId':17,'projectId':3},request,server_url=url)
                    self.assertTrue(verified['done'])
                out, err = child.communicate(timeout=8)
                self.assertEqual(child.returncode,0,err)
                self.assertIn('written',out)
                self.assertTrue(task['done'])
                self.assertIn('child history',task['description'])
        finally:
            if child and child.poll() is None: child.kill();child.communicate(timeout=5)
            server.shutdown();server.server_close();serving.join(3)

    def test_lease_is_rechecked_after_lock_acquisition(self):
        from task_mutation_lock import task_lock
        task = sample_task()
        writes, errors = [], []
        clock = [100.0]
        begun = threading.Event()
        job = {'id':'id','kind':'action','action':'complete','taskId':17,'projectId':3,'attempt':'lease','leaseUntil':200000}
        def request(url,**kwargs):
            if kwargs.get('method') == 'POST':
                if '/api/v1/tasks/' in url: writes.append(url)
                else: errors.append(kwargs.get('payload',{}))
                return {}
            if url.endswith('/projects/2'): return {'id':2,'is_archived':False}
            if url.endswith('/projects/3'): return {'id':3,'parent_project_id':2,'is_archived':False}
            return dict(task)
        original_lock = bridge.task_lock
        def observed_lock(*args,**kwargs):
            begun.set();return original_lock(*args,**kwargs)
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'DSTA_TASK_LOCK_ROOT':root}), \
                patch.object(bridge,'request_json',side_effect=request), \
                patch.object(bridge.time,'time',side_effect=lambda:clock[0]), \
                patch.object(bridge,'task_lock',side_effect=observed_lock):
            with task_lock('http://local',17):
                thread = threading.Thread(target=bridge.process_job,args=(job,'https://worker','token','hermes',Path('.'),'p','m','vk','http://local'))
                thread.start();self.assertTrue(begun.wait(2));clock[0] = 190.0
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(writes,[])
        self.assertTrue(any(payload.get('error') for payload in errors))

if __name__ == '__main__': unittest.main()
