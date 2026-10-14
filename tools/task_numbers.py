"""Per-user task numbers (#1, #2, #3…) shown in the dashboard instead of Vikunja's server-wide IDs.

Vikunja IDs are global to the server, so a new user's first task may be #204. Each user gets their
own counter here: a task keeps its number forever (even if archived and restored), new tasks get
the next one, and the real Vikunja ID keeps doing all the work underneath (actions, links, proofs).
The owner's production profile does not use this (vault flag ownNumbering=False keeps its IDs).

One small JSON file per user root on the VM; writes are atomic and serialized per file.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock(path: Path) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(str(path), threading.Lock())


def assign(path: Path, task_ids: list[int]) -> dict[int, int]:
    """Number every unseen task in creation order (ascending Vikunja ID); return id → number."""
    with _lock(path):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        numbers = {int(k): int(v) for k, v in (data.get("map") or {}).items()}
        following = int(data.get("next") or (max(numbers.values(), default=0) + 1))
        changed = False
        for task_id in sorted(set(task_ids) - set(numbers)):
            numbers[task_id] = following
            following += 1
            changed = True
        if changed:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps({"next": following, "map": {str(k): v for k, v in numbers.items()}}), encoding="utf-8")
            os.replace(temporary, path)
        return numbers
