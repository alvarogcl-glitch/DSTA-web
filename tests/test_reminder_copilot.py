import _hermetic  # noqa: F401
import unittest
from pathlib import Path
from unittest.mock import patch, Mock
from reminder_copilot import prompt
import hermes_bridge as hb
import user_copilot
from multiuser_bridge import MultiuserBridge


class ReminderCopilotTests(unittest.TestCase):
    def test_prompt_scoped_and_without_tools(self):
        text = prompt({'message': 'recuérdame mañana', 'reminderContext': {'reminders': [{'id': 'qa', 'text': 'Privado A'}]}})
        self.assertIn('Privado A', text)
        self.assertIn('America/Santiago', text)
        self.assertIn('Si falta fecha u hora', text)
        self.assertIn('No uses cronjob', text)

    def test_owner_uses_isolated_parser_and_no_hermes_cron(self):
        job = {'reminderMode': True, 'message': 'Recuérdame mañana a las 9'}
        with patch.object(user_copilot.UserCopilot, 'ask', return_value='```recordatorios\n{}\n```') as ask, patch.object(hb, 'run_hermes') as old:
            self.assertIn('recordatorios', hb.answer_chat(job, 'hermes', Path('.'), 'p', 'm'))
        old.assert_not_called()
        self.assertIn('Recuérdame mañana', ask.call_args.args[2])

    def test_other_account_does_not_need_vikunja_or_queue_task_proposals(self):
        bridge = object.__new__(MultiuserBridge)
        bridge.base, bridge.token = 'https://qa.example', 'synthetic'
        bridge.copilot = Mock()
        bridge.copilot.ask.return_value = '```recordatorios\n{}\n```'
        bridge.fetch_snapshot = Mock(side_effect=AssertionError('No Vikunja lookup for reminders'))
        bridge.finish_job = Mock()
        job = {'reminderMode': True, 'message': 'Recuérdame mañana a las 9'}
        bridge.answer_chat('qa-a', {}, job)
        bridge.fetch_snapshot.assert_not_called()
        self.assertEqual(bridge.finish_job.call_args.kwargs, {'reply': bridge.copilot.ask.return_value})


if __name__ == '__main__':
    unittest.main()
