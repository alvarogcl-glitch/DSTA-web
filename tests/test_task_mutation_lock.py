"""OS task locks: subprocess exclusion, reentrancy, deadline and crash release."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / 'tools'

class TaskLockTests(unittest.TestCase):
    def test_process_exclusion_reentrancy_and_crash_release(self):
        self.assertTrue((TOOLS / 'task_mutation_lock.py').exists(), 'shared OS lock helper missing')
        sys.path.insert(0, str(TOOLS))
        import task_mutation_lock as locks
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'DSTA_TASK_LOCK_ROOT':root}):
            env = dict(os.environ, PYTHONPATH=str(TOOLS))
            code = "from task_mutation_lock import task_lock\nwith task_lock('HTTP://localhost:3456/',17,timeout=.2):\n print('acquired',flush=True)"
            with locks.task_lock('http://LOCALHOST:3456',17):
                with locks.task_lock('http://user:secret@localhost:3456/',17,timeout=.1):
                    blocked = subprocess.run([sys.executable,'-c',code],env=env,capture_output=True,text=True,timeout=5)
                    self.assertNotEqual(blocked.returncode,0)
                    self.assertIn('TimeoutError',blocked.stderr)
                different = subprocess.run([sys.executable,'-c',code.replace(',17,',',18,')],env=env,capture_output=True,text=True,timeout=5)
                self.assertEqual(different.returncode,0,different.stderr)
            released = subprocess.run([sys.executable,'-c',code],env=env,capture_output=True,text=True,timeout=5)
            self.assertEqual(released.returncode,0,released.stderr)
            child = subprocess.Popen([sys.executable,'-c',code.replace("print('acquired',flush=True)","print('acquired',flush=True); __import__('time').sleep(30)")], env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(),'acquired')
                child.kill(); child.communicate(timeout=5)
                with locks.task_lock('http://localhost:3456',17,timeout=.5): pass
            finally:
                if child.poll() is None: child.kill(); child.communicate(timeout=5)
            self.assertEqual(len(list(Path(root).glob('*.lock'))),2)

    def test_reports_current_thread_ownership_for_safe_nested_reads(self):
        sys.path.insert(0, str(TOOLS))
        import task_mutation_lock as locks
        self.assertTrue(callable(getattr(locks, 'task_lock_owned', None)), 'ownership helper missing')
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'DSTA_TASK_LOCK_ROOT':root}):
            self.assertFalse(locks.task_lock_owned('http://local',17))
            with locks.task_lock('http://local',17):
                self.assertTrue(locks.task_lock_owned('http://local/',17))
                self.assertFalse(locks.task_lock_owned('http://local',18))
            self.assertFalse(locks.task_lock_owned('http://local',17))

if __name__ == '__main__': unittest.main()
