"""Concurrent chat/action publication must not replace a fresh snapshot with an old one."""
import threading
import unittest
from unittest.mock import patch
from test_hermes_bridge import bridge

class SnapshotPublicationTests(unittest.TestCase):
    def test_old_chat_publication_finishes_before_new_action_publication(self):
        held, release, fresh = threading.Event(), threading.Event(), threading.Event()
        posted, errors = [], []
        def fetch(*args):
            old = threading.current_thread().name == 'old-chat'
            return {'timestamp': '2026-10-06T14:00:00Z' if old else '2026-10-06T14:00:01Z',
                    'tasks': [{'id': 17, 'done': not old}]}
        def send(url, **kwargs):
            snapshot = kwargs['payload']
            if not snapshot['tasks'][0]['done']:
                held.set()
                if not release.wait(3):
                    raise RuntimeError('test failed to release old publication')
            posted.append(snapshot)
            if snapshot['tasks'][0]['done']:
                fresh.set()
            return {'ok': True}
        def publish():
            try:
                bridge.publish_snapshot('https://fake.test', 'fake', 'fake', 'http://fake.test')
            except Exception as exc:
                errors.append(str(exc))
        with patch.object(bridge, 'fetch_dashboard', side_effect=fetch), \
                patch.object(bridge, 'request_json', side_effect=send):
            old = threading.Thread(target=publish, name='old-chat')
            new = threading.Thread(target=publish, name='new-action')
            try:
                old.start()
                self.assertTrue(held.wait(2))
                new.start()
                fresh.wait(0.25)
            finally:
                release.set()
                old.join(4)
                if new.ident is not None:
                    new.join(4)
        self.assertFalse(old.is_alive())
        self.assertFalse(new.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual([item['tasks'][0]['done'] for item in posted], [False, True],
                         'older chat data must not overwrite confirmed action state')

if __name__ == '__main__':
    unittest.main()

