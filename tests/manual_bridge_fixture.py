"""Local-only E2E bridge: real dispatcher/inbox/decisions, synthetic model and Vikunja."""
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from multiuser_bridge import MultiuserBridge
from user_minute_inbox import UserMinuteInbox
from hermes_bridge import request_json

base,work=sys.argv[1],Path(sys.argv[2])
assert urlparse(base).hostname in ('localhost','127.0.0.1')
users={a:{'rootProjectId':2,'vikunjaToken':'qa-only','vikunjaUrl':'http://qa.invalid'} for a in ('qa-a','qa-b')}

def read():return json.loads((work/'vikunja.json').read_text(encoding='utf-8'))

class FakeVK:
    BASE_URL='http://qa.invalid'
    PMO_ROOT_PROJECT_ID=2
    def __init__(self,actor):self.actor=actor
    def request(self,method,path,**kwargs):
        assert method=='GET'
        return next(t.copy() for t in read()[self.actor]['tasks'] if t['id']==int(path.split('/')[-1]))
    def update_task_fields(self,task_id,changes,current=None):
        data=read();task=next(t for t in data[self.actor]['tasks'] if t['id']==task_id);task.update(changes)
        self.save(data)
    def save(self,data):
        temp=work/'vikunja.tmp';temp.write_text(json.dumps(data),encoding='utf-8');temp.replace(work/'vikunja.json')
    def pmo_projects(self):return read()[self.actor]['projects']
    def is_pmo_line(self,p):return p['parent_project_id']==2
    def project_tasks(self,id):return [t for t in read()[self.actor]['tasks'] if t['project_id']==id]
    def pmo_create_task(self,**fields):
        data=read();task={'id':200,'project_id':fields['project_id'],'title':fields['title'],'done':False,
             'label_ids':[], 'description':f"SOURCE: {fields['source']}\nACTION_KEY: {fields['action_key']}"}
        data[self.actor]['tasks'].append(task);self.save(data);return {'task':task}

class Model:
    def ask(self,actor,user,prompt,function='copiloto'):
        assert actor=='qa-a'
        assert 'Minuta QA' in prompt and 'Portafolio' in prompt
        assert 'Revisión contextual de minutas DSTA' in prompt
        if 'Traduce la instrucción en operaciones' in prompt:
            assert 'NO DEBE ENVIARSE' not in prompt
            if 'Cambiar título a Seguimiento QA ajustado' in prompt:
                return json.dumps({'resumen':'Título ajustado','operaciones':[
                    {'tipo':'crear','project_id':3,'titulo':'Seguimiento QA ajustado','nota':'Próximo paso'}]})
            assert 'Registrar presupuesto validado QA' in prompt
            return json.dumps({'resumen':'Registrar acuerdo omitido','operaciones':[
                {'tipo':'comentar','task_id':63,'nota':'Presupuesto validado QA'}]})
        return json.dumps({'resumen':'Compromisos QA','puntos_tratados':['Entrega completada','Seguimiento pendiente','Presupuesto tratado'], 'acciones':[
            {'tipo':'completar','task_id':63,'evidente':True,'confianza':'alta','nota':'Entregado'},
            {'tipo':'crear','project_id':3,'titulo':'Seguimiento QA','evidente':True,'confianza':'alta','nota':'Próximo paso'},
            {'tipo':'revisar','titulo':'Posible LT de materiales','nota':'Estudiar alcance','evidente':False,'confianza':'baja'}]})

def snapshot(user):
    actor=next(a for a,u in users.items() if u is user)
    return read()[actor]

def publish(base,token,*args):
    actor=base.split('/u/')[-1];data=read()[actor];data['timestamp']=datetime.now(timezone.utc).isoformat()
    request_json(base+'/api/bridge/snapshot',token=token,method='POST',payload=data)

inbox=UserMinuteInbox(work/'users',vk_factory=lambda u:FakeVK(next(a for a,v in users.items() if v is u)))
bridge=MultiuserBridge(base,'qa-only',load_user=users.get,request_json=request_json,process_job=None,
    finish_job=None,users_dir=work/'users',copilot=Model(),minute_inbox=inbox,fetch_snapshot=snapshot,publish_snapshot=publish)
while True:
    bridge.dispatch_once()
    time.sleep(.1)
