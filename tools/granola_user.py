"""F4: per-user Granola on the VM. Wraps the vendored GranolaClient with a store backed by the
user's DPAPI vault entry, so OAuth state, PKCE verifier and access token never leave the VM.

Only each meeting's title, date and summary go to the dashboard inbox (as a minute without
proposed actions; proposals come with the per-user Copilot in F5). Private notes stay on the VM.
"""
from __future__ import annotations

import hashlib
import re
import sys
import xml.etree.ElementTree as ET
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
        self.ensure_fresh(actor)
        secret = self.store.get_authenticated_secret(actor, "granola") or {}
        token = secret.get("access_token")
        if not token or not self.connected(actor):
            raise GranolaError("Connector is disconnected")
        records = import_meetings(self.client, token)
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


MONTHS = {m: i for i, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}
EMPTY = {"", "no summary", "not available", "no notes", "none", "null"}


def iso_date(value: str) -> str:
    match = re.search(r"\b([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s+(20\d{2})", value or "")
    if match and match.group(1).lower() in MONTHS:
        return f"{match.group(3)}-{MONTHS[match.group(1).lower()]:02d}-{int(match.group(2)):02d}"
    match = re.search(r"\b(20\d{2}-\d{2}-\d{2})\b", value or "")
    return match.group(1) if match else ""


def _meetings(result: dict) -> list[dict]:
    """Granola answers either JSON (structuredContent) or, as the real service does, XML text
    (<meetings_data><meeting id title date><summary/><private_notes/>...). Same format the
    production exporter (tools/granola_summary_export.py) reads."""
    if isinstance(result.get("structuredContent"), dict):
        return [m for m in result["structuredContent"].get("meetings", []) if isinstance(m, dict)]
    text = "\n".join(c.get("text", "") for c in result.get("content", []) if isinstance(c, dict) and c.get("type") == "text")
    start = min([p for p in (text.find("<meetings_data"), text.find("<meeting")) if p >= 0], default=-1)
    if start < 0:
        if not text.strip() or "no meetings" in text.lower():
            return []
        raise GranolaError("Unsupported meeting output")
    try:
        root = ET.fromstring(text[start:])
    except ET.ParseError:
        raise GranolaError("Unsupported meeting output") from None
    nodes = [root] if root.tag == "meeting" else root.findall(".//meeting")
    out = []
    for node in nodes:
        item = dict(node.attrib)
        for field in ("summary", "private_notes"):
            child = node.find(field)
            if child is not None:
                item[field] = "".join(child.itertext()).strip()
        out.append(item)
    return out


def import_meetings(client: GranolaClient, token: str, *, days: str = "last_30_days") -> list[dict]:
    """Read-only import with only list_meetings and get_meetings, through the client's allowlisted
    transport. Returns records with id, version, title, ISO date and summary (+ notes, VM only)."""
    with client._session() as http:
        state = {"session": None, "id": 0}

        def rpc(method, params=None, notification=False):
            state["id"] += 1
            body = {"jsonrpc": "2.0", "method": method, **({} if notification else {"id": state["id"]}),
                    **({"params": params} if params is not None else {})}
            headers = {"Authorization": "Bearer " + token, "Accept": "application/json, text/event-stream",
                       "Content-Type": "application/json", "MCP-Protocol-Version": "2025-03-26",
                       **({"Mcp-Session-Id": state["session"]} if state["session"] else {})}
            raw, response_headers = client._request(http, "POST", client._mcp, headers=headers, body=body, empty=notification)
            advertised = next((v for k, v in response_headers.items() if k.lower() == "mcp-session-id"), None)
            if method == "initialize" and advertised:
                state["session"] = advertised[:1024]
            return None if notification else client._rpc_result(raw, response_headers, state["id"])

        rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "dsta-multiuser", "version": "1"}})
        rpc("notifications/initialized", notification=True)
        listed = _meetings(rpc("tools/call", {"name": "list_meetings", "arguments": {"time_range": days}}))
        ids = [str(m["id"]) for m in listed if m.get("id")][:500]
        records = []
        for start in range(0, len(ids), 10):
            for meeting in _meetings(rpc("tools/call", {"name": "get_meetings", "arguments": {"meeting_ids": ids[start:start + 10]}})):
                summary = str(meeting.get("summary") or meeting.get("summarized_notes") or "").strip()
                if not meeting.get("id") or summary.lower() in EMPTY:
                    continue  # summary not ready yet: picked up on a later sync
                notes = str(meeting.get("private_notes") or "")
                version = hashlib.sha256(f"{summary}\n{notes}".encode("utf-8")).hexdigest()
                records.append({"source_id": str(meeting["id"]), "version": version, "title": str(meeting.get("title") or ""),
                                "date": iso_date(str(meeting.get("date") or "")), "summary": summary, "private_notes": notes})
        return records


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
