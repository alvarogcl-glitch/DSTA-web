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
                 patch.object(bridge,'process_job',side_effect=process), patch.object(bridge.time,'sleep',side_effect=sleep):
                with self.assertRaises(KeyboardInterrupt): bridge.run(once=False,env_file=Path('none'))
        finally:
            release.set()
        self.assertTrue(acted.is_set(),'action polling must continue while chat is blocked')

if __name__ == '__main__': unittest.main()
