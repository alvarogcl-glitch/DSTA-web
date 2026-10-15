"""Synthetic portfolios only: complete context, duplicate guard and additional instructions."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import minute_inbox as mi
import user_minute_inbox as umi


class MinuteSkillTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.snapshot = {'projects': [{'id': 3, 'title': 'LT Aeronáutica', 'description': 'Convenio ENAER'}],
                         'tasks': [{'id': 63, 'project_id': 3, 'title': 'Solicitar costos a ENAER',
                                    'description': 'x' * 5100 + '\nBitácora: cotización recibida', 'done': False}]}
        self.minute = {'source': 'Manual-Dashboard', 'source_id': 'qa-skill', 'version': '1',
                       'title': 'Comité ENAER', 'date': '2026-10-15T09:00:00-03:00',
                       'summary': 'Llegaron los costos.', 'private_notes': 'Validar el presupuesto.',
                       'participants': ['Ana QA'], 'context': {'section': 'Portafolio'}}

    def test_complete_context_and_identical_skill_in_both_prompts(self):
        from minute_analysis import skill_instructions
        prompt = umi.analysis_prompt(self.minute, self.snapshot)
        self.assertIn(skill_instructions(), prompt)
        self.assertIn(skill_instructions(), mi.analysis_prompt('qa.md', 'Comité ENAER', '2026-10-15'))
        for value in ('Ana QA', '09:00:00-03:00', 'Bitácora: cotización recibida', 'Convenio ENAER'):
            self.assertIn(value, prompt)
        with patch('minute_analysis.SKILL_PATH', Path(self.tmp.name) / 'missing.md'):
            with self.assertRaises(FileNotFoundError):
                umi.analysis_prompt(self.minute, self.snapshot)

    def test_similar_creation_becomes_proposed_log_without_writes(self):
        applied = []
        inbox = umi.UserMinuteInbox(Path(self.tmp.name), vk_factory=lambda _: None,
                                   apply=lambda *args: applied.append(args))
        plan = {'puntos_tratados': ['Costos ENAER recibidos'], 'acciones': [
            {'tipo': 'crear', 'project_id': 3, 'titulo': 'Solicitar los costos a ENAER',
             'nota': 'Cotización recibida', 'evidente': True, 'confianza': 'alta'}]}
        record = inbox.process('qa', {}, {**self.minute, 'source': 'Granola'}, self.snapshot,
                               lambda _: json.dumps(plan))
        action = record['acciones'][0]
        self.assertEqual((action['tipo'], action['task_id'], action['estado']), ('comentar', 63, 'propuesta'))
        self.assertFalse(action['evidente'])
        self.assertEqual(action['titulo'], '', 'a log must not rename the existing task')
        self.assertEqual(record['puntos_tratados'], ['Costos ENAER recibidos'])
        self.assertEqual(applied, [])

    def test_other_changes_work_without_an_original_proposal_and_retry_is_stable(self):
        inbox = umi.UserMinuteInbox(Path(self.tmp.name), vk_factory=lambda _: object())
        record = inbox.process('qa', {}, self.minute, self.snapshot, lambda _: '{"acciones":[]}')
        prompts = []
        def ask(prompt):
            prompts.append(prompt)
            return json.dumps({'resumen': 'Falta indicar destino', 'operaciones': [], 'descartar': False})
        decision = {'id': 'qa-decision-1', 'minuteId': record['id'], 'decisions': [
            {'actionId': 'otros', 'decision': 'instruccion', 'instruccion': 'Registrar otro acuerdo'}]}
        for _ in range(2):
            result = inbox.decide('qa', {}, decision, self.snapshot, ask)
        self.assertEqual(len(result['acciones']), 1)
        self.assertEqual(result['acciones'][0]['estado'], 'error')
        self.assertIn('Falta indicar destino', result['acciones'][0]['resultado'])
        self.assertIn('Llegaron los costos', prompts[0])

    def test_review_topic_cannot_automatically_create_a_line(self):
        applied = []
        inbox = umi.UserMinuteInbox(Path(self.tmp.name), vk_factory=lambda _: object(),
                                   apply=lambda *args: applied.append(args))
        record = inbox.process('qa', {}, self.minute, self.snapshot, lambda _: json.dumps({'acciones': [
            {'tipo': 'revisar', 'titulo': 'Explorar nueva LT de materiales', 'nota': 'Acuerdo de estudiar alcance',
             'evidente': True, 'confianza': 'alta'}]}))
        self.assertEqual(len(record['acciones']), 1)
        result = inbox.decide('qa', {}, {'minuteId': record['id'], 'decisions': [
            {'actionId': 'a1', 'decision': 'aprobar'}]}, self.snapshot)
        self.assertEqual(result['acciones'][0]['estado'], 'aplicada')
        self.assertIn('revisión', result['acciones'][0]['resultado'])
        self.assertEqual(applied, [])

    def test_large_context_fails_before_model_and_preserves_last_report(self):
        inbox = umi.UserMinuteInbox(Path(self.tmp.name), vk_factory=lambda _: None)
        first = inbox.process('qa', {}, self.minute, self.snapshot, lambda _: '{"acciones":[]}')
        with patch('minute_analysis.CONTEXT_LIMIT', 100):
            with self.assertRaisesRegex(ValueError, 'No se recortó'):
                inbox.process('qa', {}, {**self.minute, 'version': '2'}, self.snapshot,
                              lambda _: self.fail('incomplete context must not reach any model'))
        self.assertEqual(inbox.current_record('qa', self.minute)['digest'], first['digest'])

    def test_legacy_owner_receives_complete_local_minute_and_portfolio(self):
        from test_minute_inbox import FakeVikunja
        source = Path(self.tmp.name) / 'qa.md'
        source.write_text('# Comité QA\nFecha: 2026-10-15 09:00\nParticipantes: Ana QA\nENAER envió costos.', encoding='utf-8')
        vk = FakeVikunja()
        prompts = []
        def ask(prompt):
            prompts.append(prompt)
            return '{"puntos_tratados":["Costos ENAER"],"acciones":[]}'
        with patch.object(mi, 'MINUTES_DIR', Path(self.tmp.name)), patch.object(mi, 'REPORTS', Path(self.tmp.name)/'reports'), patch.object(mi, 'mark_queue'):
            record = mi.process_item({'source_id': 'qa', 'digest': 'v1', 'file': str(source),
                                      'meeting_date': 'Oct 15, 2026 9:00 AM GMT-3'}, ask, vk, Path(self.tmp.name)/'store.json')
        self.assertIn('Ana QA', prompts[0])
        self.assertIn('Solicitar costos a ENAER', prompts[0])
        self.assertEqual(record['puntos_tratados'], ['Costos ENAER'])
        self.assertNotIn('texto', umi.public_record(record))

    def test_import_adapters_preserve_metadata_without_requeueing_all_revisions(self):
        from granola_client import GranolaClient
        from granola_user import _meetings
        meeting = {'id': 'qa', 'title': 'QA', 'date': '2026-10-15T09:00:00-03:00',
                   'summary': 'Resumen', 'private_notes': 'Notas', 'participants': ['Ana QA']}
        with_metadata = GranolaClient._normalize(meeting)
        without_metadata = GranolaClient._normalize({k: v for k, v in meeting.items() if k != 'participants'})
        self.assertEqual(with_metadata['participants'], ['Ana QA'])
        self.assertEqual(with_metadata['version'], without_metadata['version'])
        xml = '<meetings_data><meeting id="qa"><participants><name>Ana QA</name></participants></meeting></meetings_data>'
        self.assertIn('Ana QA', _meetings({'content': [{'type': 'text', 'text': xml}]})[0]['participants'])

    def test_large_hermes_query_preserves_unicode_and_cli_options(self):
        import hermes_prompt_transport as transport
        root = Path(self.tmp.name)
        package = root / 'hermes_cli'
        package.mkdir()
        (package / '__init__.py').write_text('', encoding='utf-8')
        (package / 'main.py').write_text(
            'import json,sys\ndef main():\n print(json.dumps(sys.argv[1:], ensure_ascii=False))\n', encoding='utf-8')
        prompt = 'Minuta íntegra: actualización de aeronáutica.\n' * 3000
        options = ['chat', '--ignore-rules', '--ignore-user-config', '--model', 'qa-model', '-t', 'todo']
        if os.name == 'nt':
            scripts = root / 'Scripts'
            scripts.mkdir()
            (root / 'python.exe').touch()
            args, input_text = transport.prepare_query([str(scripts/'hermes.exe'), *options, '--query', prompt])
            self.assertNotIn(prompt, args)
            self.assertEqual(input_text, prompt)
            self.assertEqual(args[2:], options)
        result = subprocess.run([sys.executable, str(Path(transport.__file__).with_name('hermes_query_stdin.py')), *options],
                                input=prompt, capture_output=True, encoding='utf-8', check=True, timeout=10,
                                env={**os.environ, 'PYTHONPATH': str(root), 'PYTHONUTF8': '1'})
        received = json.loads(result.stdout)
        self.assertEqual(received[:-1], [*options, '--query'])
        self.assertTrue(received[-1] == prompt,
                        f'Query differs: sent {len(prompt)}, received {len(received[-1])}; start={received[-1][:50]!r}')

    def test_watched_owner_transport_delivers_complete_stdin(self):
        from hermes_bridge import run_watched
        prompt = 'Reunión íntegra\n' * 5000
        code, output, fallback = run_watched(
            [sys.executable, '-c', 'import sys; print(len(sys.stdin.buffer.read().decode("utf-8")))'],
            cwd=Path(self.tmp.name), env=dict(os.environ), timeout=10,
            log_path=Path(self.tmp.name)/'absent.log', input_text=prompt)
        self.assertEqual(code, 0)
        self.assertEqual(int(output), len(prompt))
        self.assertFalse(fallback)
        from hermes_bridge import ask_hermes, CodexUnavailable
        with patch('hermes_prompt_transport.prepare_query', side_effect=OSError('QA interpreter unavailable')):
            with self.assertRaises(CodexUnavailable):
                ask_hermes('QA', 'missing.exe', Path(self.tmp.name), 'qa-provider', 'qa-model', 'todo')


if __name__ == '__main__':
    unittest.main()
