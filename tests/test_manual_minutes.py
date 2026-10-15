import _hermetic  # noqa: F401  (never a real AI engine in tests)
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from user_minute_inbox import UserMinuteInbox
from granola_user import inbox_record


class ManualMinutesTest(unittest.TestCase):
    def test_manual_reuses_engine_but_requires_approval_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            writes, prompts = [], []
            inbox = UserMinuteInbox(Path(directory), vk_factory=lambda _: 'QA',
                                    apply=lambda *args: writes.append(args))
            minute = dict(source='Manual-Dashboard', source_id='manual-qa', version='v1',
                          title='Reunión QA', date='2026-10-14T12:00:00Z', summary='',
                          private_notes='Se completó la propuesta', context={'sections': ['Portafolio']})
            snapshot = dict(projects=[dict(id=8, title='LT QA')], tasks=[dict(id=81, title='Propuesta', project_id=8)])
            def ask(prompt):
                prompts.append(prompt)
                return json.dumps(dict(resumen='Lista', acciones=[dict(tipo='completar', task_id=81,
                                      evidente=True, confianza='alta', nota='Lista')]))
            record = inbox.process('qa-a', {}, minute, snapshot, ask)
            self.assertEqual(writes, [], 'manual never writes before human approval')
            self.assertEqual(record['source'], 'Manual-Dashboard')
            self.assertEqual(record['estado'], 'por_revisar')
            self.assertIn('Portafolio', prompts[0])
            self.assertIsNone(inbox.process('qa-a', {}, minute, snapshot, ask))
            self.assertEqual(len(prompts), 1)
            self.assertFalse(inbox.is_current('qa-b', minute))
            action = record['acciones'][0]
            inbox.decide('qa-a', {}, dict(minuteId=record['id'], decisions=[dict(actionId=action['id'], decision='aprobar')]), snapshot)
            self.assertEqual(len(writes), 1)
            self.assertEqual(inbox_record(dict(minute, source='Granola'))['id'][:2], 'g-')
            self.assertEqual(record['id'][:2], 'm-')

    def test_analysis_failure_does_not_save_or_write(self):
        with tempfile.TemporaryDirectory() as directory:
            inbox = UserMinuteInbox(Path(directory), vk_factory=lambda _: self.fail('no Vikunja'))
            minute = dict(source='Manual-Dashboard', source_id='manual-qa', version='v1')
            with self.assertRaises(ValueError):
                inbox.process('qa', {}, minute, {}, lambda _: 'invalid JSON')
            self.assertFalse(inbox.is_current('qa', minute))


class ManualBridgeTest(unittest.TestCase):
    def test_delivery_failure_republishes_saved_analysis_without_second_model_call(self):
        from multiuser_bridge import MultiuserBridge
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            posts=[]
            inbox=UserMinuteInbox(Path(directory),vk_factory=lambda _: self.fail('no automatic writes'))
            copilot=Mock();copilot.ask.return_value=json.dumps({'resumen':'QA','acciones':[]})
            fail=[True]
            def request(url, **kwargs):
                posts.append((url,kwargs.get('payload')))
                if url.endswith('/api/bridge/minute') and fail[0]:
                    fail[0]=False
                    raise OSError('lost publication')
                return {'ok':True}
            bridge=MultiuserBridge('https://qa.test','QA',load_user=lambda _: {},request_json=request,
                process_job=None,finish_job=None,users_dir=Path(directory),minute_inbox=inbox,
                copilot=copilot,fetch_snapshot=lambda _: {'tasks':[],'projects':[]})
            job=dict(id='qa',revision=1,attempt='one',title='QA',date='2026-10-14',content='Notas QA',context={})
            bridge.handle_manual('qa-a',{'rootProjectId':8,'vikunjaToken':'QA'},job)
            self.assertTrue(posts[-1][1]['error'])
            bridge.handle_manual('qa-a',{'rootProjectId':8,'vikunjaToken':'QA'},dict(job,attempt='two'))
            self.assertIn('minuteId',posts[-1][1])
            self.assertEqual(copilot.ask.call_count,1)
            self.assertNotIn('texto',posts[-2][1])
            self.assertTrue(all('/u/qa-a/' in url for url,_ in posts))

    def test_owner_uses_existing_inbox_and_decisions_without_granola_queue(self):
        import hermes_bridge as hb
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            home=Path(directory)
            job=dict(id='qa',revision=1,attempt='one',title='QA',date='2026-10-14',content='Acuerdo',context={})
            snapshot={'tasks':[],'projects':[]}
            with patch.object(hb,'fetch_dashboard',return_value=snapshot), patch.object(hb,'request_json') as post:
                hb.process_manual(job,'https://qa.test','QA',home,'QA','http://qa',lambda _:json.dumps({'resumen':'QA','acciones':[]}))
                record=next(iter(hb.minute_inbox.load_store(hb.inbox_store(home))['minutes'].values()))
                self.assertEqual(record['source'],'Manual-Dashboard')
                self.assertIn('texto',record)
                self.assertNotIn('texto',post.call_args_list[0].kwargs['payload'])
                with patch.object(hb.minute_inbox,'mark_queue',side_effect=AssertionError('manual must not touch Granola queue')):
                    hb.process_decision({'id':'decision-qa','minuteId':record['id'],'decision':'descartar'},'https://qa.test','QA',home,'QA','http://qa')
                self.assertEqual(hb.minute_inbox.get_record(hb.inbox_store(home),record['id'])['estado'],'descartada')

    def test_atomic_vm_save_keeps_previous_record_after_replace_failure(self):
        import minute_inbox as mi
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'inbox.json';mi.save_record(path,{'id':'qa','digest':'old'})
            with patch.object(mi.os,'replace',side_effect=OSError('disk failure')):
                with self.assertRaises(OSError):mi.save_record(path,{'id':'qa','digest':'new'})
            self.assertEqual(mi.get_record(path,'qa')['digest'],'old')

    def test_vikunja_write_before_lost_ack_does_not_duplicate_note_or_creation(self):
        import minute_inbox as mi
        from test_minute_inbox import FakeVikunja
        vk=FakeVikunja()
        minute={'source':'Manual-Dashboard','sourceId':'manual-qa','titulo':'QA','fecha':'2026-10-14'}
        actions=mi.parse_plan(json.dumps({'acciones':[
            {'tipo':'actualizar','task_id':63,'nota':'Avance QA'},
            {'tipo':'crear','project_id':3,'titulo':'Nueva QA','nota':'Acuerdo'}]}))['acciones']
        for action in actions:
            mi.execute(action,minute,vk)
            mi.execute(action,minute,vk)  # VM crashed before recording applied state
        self.assertEqual(vk.tasks[63]['description'].count('Avance QA'),1)
        self.assertEqual(len(vk.created),1)
        self.assertIn('Manual-Dashboard',vk.created[0]['source'])
        # A second minute with the same open title is rejected instead of creating another task.
        with self.assertRaises(ValueError):mi.execute(actions[1],dict(minute,sourceId='manual-other'),vk)

    def test_manual_date_keeps_meeting_day_with_offset(self):
        record=inbox_record(dict(source='Manual-Dashboard',source_id='qa',version=1,date='2026-10-14T23:30:00-03:00'))
        self.assertEqual(record['fecha'],'2026-10-14')

    def test_manual_instruction_does_not_collide_with_original_action_ids(self):
        import minute_inbox as mi
        from test_minute_inbox import FakeVikunja
        vk=FakeVikunja();minute={'source':'Manual-Dashboard','sourceId':'manual-qa','titulo':'QA','fecha':'2026-10-14','minuta':'manual-qa'}
        action=mi.normalize_action({'tipo':'actualizar','task_id':63,'nota':'Primer avance'},1)
        mi.apply_action(action,minute,vk)
        action['instruccionId']='decision-qa'
        plan={'operaciones':[{'tipo':'actualizar','task_id':63,'nota':'Segundo avance','responsable':'QA nueva'}]}
        mi.apply_instruction(action,minute,'Añade el avance',lambda _:json.dumps(plan),vk)
        self.assertIn('Segundo avance',vk.tasks[63]['description'])
        self.assertIn('Responsable: QA nueva',vk.tasks[63]['description'])
