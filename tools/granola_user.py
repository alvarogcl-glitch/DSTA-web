"""F4: per-user Granola on the VM. Wraps the vendored GranolaClient with a store backed by the
user's DPAPI vault entry, so OAuth state, PKCE verifier and access token never leave the VM.

Only each meeting's title, date and summary go to the dashboard inbox (as a minute without
proposed actions; proposals come with the per-user Copilot in F5). Private notes stay on the VM.
"""
from __future__ import annotations

import hashlib
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

_tools_dir = str(Path(__file__).resolve().parent)
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)
import user_vault  # noqa: E402
import time  # noqa: E402
from granola_client import GranolaClient, GranolaConfig, GranolaError, refresh_access_token  # noqa: E402

_lock = threading.Lock()


class VaultGranolaStore:
    """Store interface expected by GranolaClient, persisted in each user's vault entry."""

    def __init__(self, load=user_vault.load, save=user_vault.save):
        self._load, self._save = load, save
        self.saved: dict[str, list] = {}

    def _get(self, user):
        data = self._load(user)
        if data is None:
            raise GranolaError("Usuario sin vault")
        data.setdefault("granola", {"epoch": 0, "state": "disconnected", "pending": None, "secret": None})
        return data

    def status(self, user, provider):
        with _lock:
            g = self._get(user)["granola"]
            return {"state": g["state"], "epoch": g["epoch"]}

    def put_pending(self, user, provider, state, session, payload, expires, expected_epoch):
        with _lock:
            data = self._get(user)
            if data["granola"]["epoch"] != expected_epoch:
                raise GranolaError("Connector changed")
            data["granola"]["pending"] = {"state": state, "session": session, "payload": payload, "expires": expires}
            self._save(user, data)

    def consume_pending(self, user, provider, state, session, now):
        with _lock:
            data = self._get(user)
            pending = data["granola"].get("pending")
            data["granola"]["pending"] = None
            self._save(user, data)
            if (not pending or pending["state"] != state or pending["session"] != session or now >= pending["expires"]):
                raise GranolaError("OAuth state is invalid or expired")
            return {**pending["payload"], "epoch": data["granola"]["epoch"]}

    def set_secret(self, user, provider, secret, expected_epoch):
        with _lock:
            data = self._get(user)
            if data["granola"]["epoch"] != expected_epoch:
                raise GranolaError("Connector changed")
            data["granola"].update(secret=secret, state="ready", epoch=expected_epoch + 1)
            self._save(user, data)
            return expected_epoch + 1

    def claim_job(self, user, jobid):
        status = self.status(user, "granola")
        return {"owner": user, "provider": "granola", "state": "running", "epoch": status["epoch"], "attempts": 1}

    def get_authenticated_secret(self, user, provider):
        with _lock:
            return self._get(user)["granola"].get("secret")

    def save_minute(self, user, provider, source_id, version, record, *, expected_epoch, job_id, expected_attempt):
        self.saved.setdefault(job_id, []).append({"source_id": source_id, "version": version, **record})

    def finish_job(self, user, jobid, *, expected_epoch, expected_attempt):
        return None

    def disconnect(self, user):
        with _lock:
            data = self._get(user)
            g = data["granola"]
            data["granola"] = {"epoch": g["epoch"] + 1, "state": "disconnected", "pending": None, "secret": None}
            self._save(user, data)


class GranolaService:
    def __init__(self, redirect_uri: str, *, test_origin: str | None = None, store: VaultGranolaStore | None = None):
        self.store = store or VaultGranolaStore()
        self.client = GranolaClient(self.store, GranolaConfig(redirect_uri=redirect_uri, allowed_redirect_uris=(redirect_uri,),
                                                              test_origin=test_origin))

    def authorize(self, actor: str, request_id: str) -> dict:
        started = self.client.begin_oauth(actor, request_id)
        return {"authorizationUrl": started["authorization_url"], "state": started["state"]}

    def exchange(self, actor: str, request_id: str, state: str, code: str) -> None:
        self.client.callback(actor, request_id, state, code)

    def connected(self, actor: str) -> bool:
        try:
            return self.store.status(actor, "granola")["state"] == "ready"
        except GranolaError:
            return False

    def ensure_fresh(self, actor: str) -> None:
        secret = self.store.get_authenticated_secret(actor, "granola") or {}
        expiry = secret.get("expires_at")
        if isinstance(expiry, (int, float)) and time.time() >= expiry - 60:
            try:
                refresh_access_token(self.client, actor)
            except GranolaError:
                self.store.disconnect(actor)
                raise

    def sync(self, actor: str) -> list[dict]:
        job = str(uuid.uuid4())
        self.ensure_fresh(actor)
        self.client.sync(actor, job)
        records = self.store.saved.pop(job, [])
        # F5 context: the user's recent summaries, kept encrypted in THEIR vault entry.
        with _lock:
            data = self.store._get(actor)
            recent = sorted(records, key=lambda r: str(r.get("date") or ""), reverse=True)[:30]
            data["minutes"] = [{"title": str(r.get("title") or "")[:200], "date": str(r.get("date") or "")[:10],
                                "summary": str(r.get("summary") or "")[:1500]} for r in recent]
            self.store._save(actor, data)
        return records

    def disconnect(self, actor: str) -> None:
        self.store.disconnect(actor)


def inbox_record(record: dict) -> dict:
    """Minute for the user's dashboard inbox: title, date and summary only (no private notes)."""
    source = str(record["source_id"])
    return {
        "id": "g-" + hashlib.sha256(source.encode()).hexdigest()[:32],
        "sourceId": source[:200],
        "digest": str(record["version"])[:64],
        "titulo": str(record.get("title") or "Reunión sin título")[:200],
        "fecha": str(record.get("date") or "")[:10],
        "detectadaEn": datetime.now(timezone.utc).isoformat(),
        "resumen": str(record.get("summary") or "")[:800],
        "acciones": [],
        "estado": "procesada",
        "vista": False,
    }
