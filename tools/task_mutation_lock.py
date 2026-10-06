"""Cooperative per-task transactions. OS locks, not lockfile existence, exclude writers.

Only local clients using this helper are coordinated; Vikunja REST has no CAS
contract here, so external native UI/API writes can still race these clients.
Import this module by its stable name so nested bridge/minute/MCP calls reenter.
"""
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit

_guard = threading.Lock()
_locks = {}
_local = threading.local()


def _scope(server_url):
    parts = urlsplit(server_url)
    scheme = parts.scheme.lower()
    host = (parts.hostname or '').lower()
    port = parts.port
    if port == {'http':80, 'https':443}.get(scheme): port = None
    return f'{scheme}://{host}' + (f':{port}' if port else '') + parts.path.rstrip('/')


def _root():
    default = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / 'AppData' / 'Local'))) / 'hermes' / 'cache' / 'dsta-task-locks'
    return Path(os.environ.get('DSTA_TASK_LOCK_ROOT', str(default)))


def task_lock_owned(server_url, task_id):
    """Whether this thread already holds the OS transaction for a safe nested read."""
    digest = hashlib.sha256(f'{_scope(server_url)}\n{int(task_id)}'.encode()).hexdigest()
    key = str(_root().resolve() / (digest + '.lock'))
    return key in getattr(_local, 'held', {})


@contextmanager
def task_lock(server_url, task_id, *, timeout=15.0):
    """Bound acquisition (seconds); hold through authoritative read/build/write/verify."""
    digest = hashlib.sha256(f'{_scope(server_url)}\n{int(task_id)}'.encode()).hexdigest()
    root = _root().resolve()
    key = str(root / (digest + '.lock'))
    deadline = time.monotonic() + max(0, timeout)
    with _guard:
        lock = _locks.setdefault(key, threading.RLock())
    if not lock.acquire(timeout=max(0, deadline - time.monotonic())):
        raise TimeoutError('Task mutation lock acquisition timed out')
    held = getattr(_local, 'held', None)
    if held is None:
        held = _local.held = {}
    handle = None
    acquired = False
    try:
        if key in held:
            yield
            return
        root.mkdir(parents=True, exist_ok=True)
        handle = open(key, 'a+b')
        # msvcrt byte-range locking requires a byte; concurrent initial writes are harmless.
        if os.fstat(handle.fileno()).st_size == 0:
            handle.write(b'\0'); handle.flush()
        while True:
            try:
                handle.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except (OSError, BlockingIOError):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Task mutation lock acquisition timed out') from None
                time.sleep(min(.025, remaining))
        held[key] = True
        yield
    finally:
        if acquired:
            held.pop(key, None)
            handle.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        if handle is not None: handle.close()
        lock.release()
