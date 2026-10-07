import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from test_hermes_bridge import bridge

class SchedulingTests(unittest.TestCase):
    def test_blocked_chat_does_not_block_next_action_poll(self):
        started, release, acted = threading.Event(), threading.Event(), threading.Event()
        polls = []
        def process(job, *args):
            if job['kind'] == 'chat':
                started.set()
                if not release.wait(0.5):
                    raise AssertionError('chat ran synchronously and blocked polling')
            else:
                self.assertTrue(started.is_set())
                self.assertFalse(release.is_set())
                acted.set()
        def request(url, **kwargs):
            polls.append(url)
            if url.endswith('kind=chat'):
                return {'job': {'kind':'chat','id':'chat'}} if polls.count(url)==1 else {}
            if url.endswith('kind=action'):
                return {'job': {'kind':'action','id':'action'}} if started.is_set() else {}
            return {}
        def sleep(_):
            if acted.is_set():
                release.set()
                raise KeyboardInterrupt()
            started.wait(1)
        values = {'DSTA_DASHBOARD_URL':'https://example.test','DSTA_BRIDGE_TOKEN':'test','HERMES_CLI':'test','DSTA_GRANOLA_INTERVAL_SECONDS':'0'}
        try:
            with patch.object(bridge,'load_env_file',return_value=values), patch.object(bridge,'setting',side_effect=lambda n,v,d='': v.get(n,d)), \
                 patch.object(bridge.shutil,'which',return_value='test'), patch.object(bridge.minute_inbox,'load_store',return_value={'minutes':{}}), \
                 patch.object(bridge,'HealthMonitor'), patch.object(bridge,'request_json',side_effect=request), \
                 patch.object(bridge,'process_job',side_effect=process), patch.object(bridge,'ACTION_POLL_SECONDS',0.01), \
                 patch.object(bridge.time,'sleep',side_effect=sleep):
                with self.assertRaises(KeyboardInterrupt): bridge.run(once=False,env_file=Path('none'))
        finally:
            release.set()
        self.assertTrue(acted.is_set(),'action polling must continue while chat is blocked')

    def test_blocked_health_poll_does_not_delay_action(self):
        blocked, acted = threading.Event(), threading.Event()
        def request(url, **kwargs):
            if url.endswith('kind=action'):
                self.assertEqual(kwargs['timeout'], 10)
                return {'job': {'kind': 'action', 'id': 'direct'}} if blocked.is_set() else {}
            if url.endswith('kind=health'):
                blocked.set()
                self.assertTrue(acted.wait(1), 'health request blocked direct actions')
                raise KeyboardInterrupt()
            return {}
        values = {'DSTA_DASHBOARD_URL':'https://example.test','DSTA_BRIDGE_TOKEN':'test','HERMES_CLI':'test','DSTA_GRANOLA_INTERVAL_SECONDS':'0'}
        with patch.object(bridge,'load_env_file',return_value=values), \
             patch.object(bridge,'setting',side_effect=lambda n,v,d='': v.get(n,d)), \
             patch.object(bridge.shutil,'which',return_value='test'), \
             patch.object(bridge.minute_inbox,'load_store',return_value={'minutes':{}}), \
             patch.object(bridge,'HealthMonitor'), patch.object(bridge,'request_json',side_effect=request), \
             patch.object(bridge,'process_job',side_effect=lambda *args: acted.set()), \
             patch.object(bridge,'ACTION_POLL_SECONDS',0.01):
            with self.assertRaises(KeyboardInterrupt): bridge.run(once=False,env_file=Path('none'))
        self.assertTrue(acted.is_set())
        self.assertFalse(any(t.name == 'dsta-direct-actions' for t in threading.enumerate()))

    def test_action_poll_recovers_after_network_failure(self):
        acted = threading.Event()
        with patch.object(bridge,'request_json',side_effect=[bridge.URLError('offline'),
                     {'job': {'kind':'action','id':'recovered'}}]), \
             patch.object(bridge,'process_job',side_effect=lambda *args: acted.set()), \
             patch.object(bridge,'ACTION_POLL_SECONDS',0.01):
            with bridge.action_polling(True,'https://example.test','test'):
                self.assertTrue(acted.wait(1))

if __name__ == '__main__': unittest.main()
