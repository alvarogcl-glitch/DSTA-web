"""Per-user credentials for the multiuser bridge, encrypted at rest with Windows DPAPI.

Each user has one file ``<actor>.dpapi`` holding JSON (Vikunja URL/token, root project, and later
Granola and LLM settings) encrypted with CryptProtectData for the current Windows account plus an
application entropy. Nothing here is ever printed or sent to the Worker; the dashboard only learns
the actor id. Directory: %LOCALAPPDATA%/dsta-multiuser/vault (DSTA_VAULT_DIR overrides it for tests).
"""
from __future__ import annotations

import ctypes
import json
import os
import re
from ctypes import wintypes
from pathlib import Path

ACTOR_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
ENTROPY = b"dsta-multiuser-vault-v1"
SUFFIX = ".dpapi"


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes) -> _Blob:
    buffer = ctypes.create_string_buffer(data, len(data))
    return _Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))


def _crypt(function_name: str, data: bytes) -> bytes:
    if os.name != "nt":
        raise RuntimeError("El vault multiusuario requiere Windows (DPAPI)")
    crypt32 = ctypes.windll.crypt32
    source, entropy, output = _blob(data), _blob(ENTROPY), _Blob()
    function = getattr(crypt32, function_name)
    ok = function(ctypes.byref(source), None, ctypes.byref(entropy), None, None, 0x1, ctypes.byref(output))
    if not ok:
        raise RuntimeError("DPAPI no pudo procesar el vault")
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(output.pbData)


def vault_dir() -> Path:
    base = os.environ.get("DSTA_VAULT_DIR") or str(
        Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "dsta-multiuser" / "vault")
    path = Path(base)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _path(actor_id: str) -> Path:
    if not ACTOR_ID.match(actor_id or ""):
        raise ValueError("Identificador de usuario inválido")
    return vault_dir() / f"{actor_id}{SUFFIX}"


def save(actor_id: str, data: dict) -> None:
    payload = json.dumps({**data, "actorId": actor_id}, ensure_ascii=False).encode("utf-8")
    target = _path(actor_id)
    temporary = target.with_suffix(".tmp")
    temporary.write_bytes(_crypt("CryptProtectData", payload))
    os.replace(temporary, target)


def load(actor_id: str) -> dict | None:
    path = _path(actor_id)
    if not path.exists():
        return None
    data = json.loads(_crypt("CryptUnprotectData", path.read_bytes()).decode("utf-8"))
    if data.get("actorId") != actor_id:
        raise ValueError("El vault no corresponde a este usuario")
    return data


def delete(actor_id: str) -> bool:
    path = _path(actor_id)
    if path.exists():
        path.unlink()
        return True
    return False


def actors() -> list[str]:
    return sorted(p.name[:-len(SUFFIX)] for p in vault_dir().glob(f"*{SUFFIX}") if ACTOR_ID.match(p.name[:-len(SUFFIX)]))
