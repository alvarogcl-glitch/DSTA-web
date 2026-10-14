"""Per-user context shared by the bridge tools (multiuser mode).

The root Vikunja project of the dashboard used to be fixed at 2 (the CEO's PMO-DSTA). In
multiuser mode each user has their own root in their own Vikunja account, so the tools read it
from a context variable that the multiuser bridge sets around each job. Single-user mode is
unchanged: the default stays 2 (or DSTA_ROOT_PROJECT_ID when set, e.g. for a child MCP process).

Always import this module normally (``import user_context``) so every importer shares one
context variable.
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from contextvars import ContextVar

DEFAULT_ROOT_PROJECT_ID = int(os.environ.get("DSTA_ROOT_PROJECT_ID", "2"))
_ROOT_PROJECT_ID: ContextVar[int] = ContextVar("dsta_root_project_id", default=DEFAULT_ROOT_PROJECT_ID)


def root_project_id() -> int:
    return _ROOT_PROJECT_ID.get()


_NUMBERS_FILE: ContextVar = ContextVar("dsta_task_numbers_file", default=None)
_numbers_dir = None


def set_numbers_dir(path) -> None:
    """The multiuser bridge enables per-user task numbers by giving them a directory."""
    global _numbers_dir
    _numbers_dir = path


def task_numbers_file():
    """File with this user's own task numbers, or None (single-user mode / owner profile)."""
    return _NUMBERS_FILE.get()


@contextmanager
def using_user(user: dict):
    """Root project plus (unless the vault says ownNumbering=False) the user's task numbering."""
    import hashlib
    from pathlib import Path
    root = user["rootProjectId"]
    numbers = None
    if _numbers_dir is not None and user.get("ownNumbering", True):
        server = hashlib.sha256(str(user.get("vikunjaUrl", "")).encode()).hexdigest()[:8]
        numbers = Path(_numbers_dir) / f"{server}-{root}.json"
    token = _NUMBERS_FILE.set(numbers)
    try:
        with using_root(root):
            yield
    finally:
        _NUMBERS_FILE.reset(token)


@contextmanager
def using_root(project_id: int):
    """Run the enclosed code against another user's root project."""
    if not isinstance(project_id, int) or project_id <= 0:
        raise ValueError("La raíz del usuario debe ser un ID de proyecto positivo")
    token = _ROOT_PROJECT_ID.set(project_id)
    try:
        yield
    finally:
        _ROOT_PROJECT_ID.reset(token)
