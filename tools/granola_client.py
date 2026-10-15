# Vendored from DSTA-multiuser/implementation-20261011/multiuser/granola.py (Codex candidate),
# with one local patch (marked DSTA-PATCH): keep refresh_token for renewal. Principal-scoped Granola OAuth (PKCE, public client) and an
# allowlisted MCP import (list_meetings/get_meetings only). Storage is injected (see granola_user.py).
"""Principal-scoped Granola OAuth and narrowly allowlisted MCP import."""

import base64
from dataclasses import dataclass
import hashlib
import json
import math
import re
import secrets
import time
from urllib.parse import urlencode, urlsplit

import requests


MCP_URL = "https://mcp.granola.ai/mcp"
PROTECTED_METADATA_URL = "https://mcp.granola.ai/.well-known/oauth-protected-resource"
AUTH_METADATA_URL = "https://mcp.granola.ai/.well-known/oauth-authorization-server"
ISSUER = "https://mcp-auth.granola.ai"
PROTOCOL_VERSION = "2025-03-26"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_MEETINGS = 10000


class GranolaError(RuntimeError):
    """Sanitized failure safe to expose without provider response contents."""


@dataclass(frozen=True)
class GranolaConfig:
    client_id: str | None = None
    redirect_uri: str = ""
    allowed_redirect_uris: tuple[str, ...] = ()
    test_origin: str | None = None
    max_pages: int = 20
    oauth_ttl: int = 300
    batch_size: int = 100

    def __post_init__(self):
        if self.client_id is not None:
            _text(self.client_id, "Invalid public client configuration")
        if not isinstance(self.allowed_redirect_uris, (tuple, list)):
            raise GranolaError("Invalid redirect allowlist")
        object.__setattr__(self, "allowed_redirect_uris", tuple(self.allowed_redirect_uris))
        _text(self.redirect_uri, "Invalid redirect configuration")
        if self.redirect_uri not in self.allowed_redirect_uris:
            raise GranolaError("Redirect URI is not allowlisted")
        for uri in self.allowed_redirect_uris:
            _text(uri, "Invalid redirect allowlist")
            try:
                parsed = urlsplit(uri)
                port = parsed.port
            except ValueError:
                raise GranolaError("Invalid redirect allowlist") from None
            if (parsed.username is not None or parsed.password is not None
                    or parsed.fragment or not parsed.hostname
                    or parsed.scheme not in ("https", "http")):
                raise GranolaError("Invalid redirect allowlist")
            if parsed.scheme == "http" and (parsed.hostname != "127.0.0.1" or port is None):
                raise GranolaError("HTTP callbacks require literal IPv4 loopback and a port")
        if self.test_origin is not None:
            if not isinstance(self.test_origin, str):
                raise GranolaError("Invalid synthetic origin")
            match = re.fullmatch(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})", self.test_origin)
            if match is None or not 1 <= int(match.group(1)) <= 65535:
                raise GranolaError("Synthetic origin must be http://127.0.0.1:port")
        for value, maximum in ((self.max_pages, 100), (self.oauth_ttl, 900), (self.batch_size, 100)):
            if type(value) is not int or not 1 <= value <= maximum:
                raise GranolaError("Invalid connector limit")


def _text(value, message):
    if not isinstance(value, str) or not value.strip() or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise GranolaError(message)
    return value


def _json(data):
    try:
        return json.loads(data, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, TypeError, RecursionError):
        raise GranolaError("Provider returned invalid JSON") from None


class GranolaClient:
    """Server-only API. Owners and sessions must come from trusted authentication."""

    def __init__(self, store, config, *, clock=time.time):
        if not isinstance(config, GranolaConfig):
            raise TypeError("config must be GranolaConfig")
        self.store = store
        self.config = config
        self.clock = clock
        origin = config.test_origin
        self._mcp = origin + "/mcp" if origin else MCP_URL
        self._protected = origin + "/.well-known/oauth-protected-resource" if origin else PROTECTED_METADATA_URL
        self._metadata = origin + "/.well-known/oauth-authorization-server" if origin else AUTH_METADATA_URL
        self._issuer = origin if origin else ISSUER
        paths = ("authorize", "token", "register") if origin else ("oauth2/authorize", "oauth2/token", "oauth2/register")
        self._endpoints = dict(zip(("authorization_endpoint", "token_endpoint", "registration_endpoint"),
                                   (self._issuer + "/" + path for path in paths)))
        self._allowed_urls = frozenset((self._mcp, self._protected, self._metadata, *self._endpoints.values()))

    def _now(self):
        value = self.clock()
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise GranolaError("Invalid connector clock")
        return float(value)

    def _request(self, http, method, url, *, headers=None, body=None, form=None, empty=False):
        if url not in self._allowed_urls:
            raise GranolaError("Provider endpoint is not permitted")
        try:
            with http.request(method, url, headers=headers, json=body, data=form,
                              timeout=(5, 20), allow_redirects=False, stream=True) as response:
                if response.status_code not in (200, 201, 202):
                    raise GranolaError("Provider HTTP request failed")
                chunks = []
                size = 0
                for chunk in response.iter_content(chunk_size=65536):
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        raise GranolaError("Provider response exceeded size limit")
                    chunks.append(chunk)
                response_headers = dict(response.headers)
                raw = b"".join(chunks)
                if empty:
                    return None, response_headers
                if response.status_code == 202 or not raw:
                    raise GranolaError("Provider returned no synchronous result")
                return raw.decode("utf-8"), response_headers
        except GranolaError:
            raise
        except (requests.RequestException, UnicodeError, ValueError, RecursionError):
            raise GranolaError("Provider transport failed") from None

    @staticmethod
    def _session():
        http = requests.Session()
        http.trust_env = False
        return http

    def _discovery(self, http):
        raw, _ = self._request(http, "GET", self._protected)
        protected = _json(raw)
        if (not isinstance(protected, dict) or protected.get("resource") != self._mcp
                or protected.get("authorization_servers") != [self._issuer]):
            raise GranolaError("Protected resource metadata failed validation")
        raw, _ = self._request(http, "GET", self._metadata)
        metadata = _json(raw)
        if not isinstance(metadata, dict) or metadata.get("issuer") != self._issuer:
            raise GranolaError("Authorization issuer failed validation")
        for name, expected in self._endpoints.items():
            if name == "registration_endpoint" and name not in metadata:
                continue
            if metadata.get(name) != expected:
                raise GranolaError("Authorization endpoint failed validation")
        for name, required in (("response_types_supported", "code"),
                               ("grant_types_supported", "authorization_code"),
                               ("token_endpoint_auth_methods_supported", "none"),
                               ("code_challenge_methods_supported", "S256")):
            values = metadata.get(name)
            if not isinstance(values, list) or required not in values:
                raise GranolaError("Required public PKCE OAuth capability is unavailable")
        # Return only validated capabilities; never return arbitrary provider metadata.
        return {"issuer": self._issuer, "resource": self._mcp,
                **{name: metadata[name] for name in self._endpoints if name in metadata},
                "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code"],
                "token_endpoint_auth_methods_supported": ["none"],
                "code_challenge_methods_supported": ["S256"]}

    def discovery(self):
        with self._session() as http:
            return self._discovery(http)

    def begin_oauth(self, user, session):
        _text(user, "Authenticated principal is required")
        _text(session, "Authenticated session is required")
        epoch = self.store.status(user, "granola")["epoch"]
        with self._session() as http:
            metadata = self._discovery(http)
            client_id = self.config.client_id
            if client_id is None:
                endpoint = metadata.get("registration_endpoint")
                if endpoint is None:
                    raise GranolaError("Dynamic client registration is unavailable")
                raw, _ = self._request(http, "POST", endpoint, body={
                    "client_name": "Granola individual meeting import",
                    "redirect_uris": [self.config.redirect_uri],
                    "grant_types": ["authorization_code"],
                    "response_types": ["code"],
                    "token_endpoint_auth_method": "none",
                })
                registration = _json(raw)
                if not isinstance(registration, dict):
                    raise GranolaError("Invalid public client registration")
                client_id = _text(registration.get("client_id"), "Invalid public client registration")
                if (registration.get("token_endpoint_auth_method", "none") != "none"
                        or registration.get("client_secret")):
                    raise GranolaError("Provider registration is not a public client")
                if "redirect_uris" in registration and registration["redirect_uris"] != [self.config.redirect_uri]:
                    raise GranolaError("Provider registration changed callback URI")
        state = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
        self.store.put_pending(user, "granola", state, session, {
            "verifier": verifier, "client_id": client_id,
            "redirect_uri": self.config.redirect_uri,
            "token_endpoint": metadata["token_endpoint"], "resource": self._mcp,
        }, self._now() + self.config.oauth_ttl, expected_epoch=epoch)
        params = {"response_type": "code", "client_id": client_id,
                  "redirect_uri": self.config.redirect_uri, "state": state,
                  "code_challenge": challenge, "code_challenge_method": "S256",
                  "resource": self._mcp}
        return {"state": state, "authorization_url": metadata["authorization_endpoint"] + "?" + urlencode(params)}

    def callback(self, user, session, state, code):
        _text(code, "Authorization code is required")
        pending = self.store.consume_pending(user, "granola", state, session, self._now())
        if not isinstance(pending, dict):
            raise GranolaError("OAuth storage must return consumed payload and epoch")
        epoch = pending.get("epoch")
        if (type(epoch) is not int or epoch < 0
                or pending.get("redirect_uri") != self.config.redirect_uri
                or pending.get("redirect_uri") not in self.config.allowed_redirect_uris
                or pending.get("resource") != self._mcp
                or pending.get("token_endpoint") != self._endpoints["token_endpoint"]):
            raise GranolaError("Pending OAuth configuration is invalid")
        verifier = _text(pending.get("verifier"), "Pending PKCE verifier is invalid")
        if re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", verifier) is None:
            raise GranolaError("Pending PKCE verifier is invalid")
        client_id = _text(pending.get("client_id"), "Pending client is invalid")
        if self.config.client_id is not None and client_id != self.config.client_id:
            raise GranolaError("Pending client configuration changed")
        with self._session() as http:
            raw, _ = self._request(http, "POST", pending["token_endpoint"], form={
                "grant_type": "authorization_code", "code": code,
                "client_id": client_id, "redirect_uri": pending["redirect_uri"],
                "code_verifier": verifier, "resource": self._mcp,
            })
        result = _json(raw)
        if not isinstance(result, dict):
            raise GranolaError("Invalid OAuth exchange result")
        token = _text(result.get("access_token"), "OAuth exchange returned no usable access token")
        if not isinstance(result.get("token_type"), str) or result["token_type"].lower() != "bearer":
            raise GranolaError("OAuth exchange returned unsupported token type")
        secret = {"access_token": token, "token_type": "Bearer", "client_id": client_id}
        # DSTA-PATCH: keep the refresh token (encrypted by the vault-backed store) for renewal.
        if isinstance(result.get("refresh_token"), str) and result["refresh_token"]:
            secret["refresh_token"] = result["refresh_token"]
            secret["token_endpoint"] = pending["token_endpoint"]
        expires = result.get("expires_in")
        if expires is not None:
            if isinstance(expires, bool) or not isinstance(expires, (int, float)) or not math.isfinite(expires) or expires <= 0:
                raise GranolaError("OAuth exchange returned invalid expiry")
            secret["expires_at"] = self._now() + expires
        new_epoch = self.store.set_secret(user, "granola", secret, expected_epoch=epoch)
        return {"status": "ready", "epoch": new_epoch}

    def _current(self, user, epoch):
        status = self.store.status(user, "granola")
        if status.get("state") != "ready" or status.get("epoch") != epoch:
            raise GranolaError("Connector is disconnected or stale")

    @staticmethod
    def _rpc_result(raw, headers, request_id):
        content_type = next((v for k, v in headers.items() if k.lower() == "content-type"), "")
        if content_type.split(";", 1)[0].strip().lower() == "text/event-stream":
            # Streamable HTTP SSE is parsed after the bounded response is closed.
            messages = []
            data = []
            for line in raw.replace("\r\n", "\n").replace("\r", "\n").split("\n") + [""]:
                if not line:
                    if data:
                        messages.append(_json("\n".join(data)))
                        data = []
                elif line.startswith("data:"):
                    data.append(line[5:].removeprefix(" "))
            matches = [m for m in messages if isinstance(m, dict) and m.get("id") == request_id]
            if len(matches) != 1:
                raise GranolaError("MCP SSE response did not contain one matching result")
            response = matches[0]
        elif content_type.split(";", 1)[0].strip().lower() == "application/json":
            response = _json(raw)
        else:
            raise GranolaError("Unsupported MCP response content type")
        if (not isinstance(response, dict) or response.get("jsonrpc") != "2.0"
                or response.get("id") != request_id or "error" in response
                or not isinstance(response.get("result"), dict)):
            raise GranolaError("MCP request failed or returned invalid result")
        result = response["result"]
        if result.get("isError"):
            raise GranolaError("MCP tool failed")
        return result

    @staticmethod
    def _schemas(tools):
        selected = {}
        for tool in tools:
            if not isinstance(tool, dict):
                raise GranolaError("Invalid MCP tool advertisement")
            name = tool.get("name")
            if name not in ("list_meetings", "get_meetings"):
                continue
            if name in selected:
                raise GranolaError("Ambiguous MCP tool advertisement")
            schema = tool.get("inputSchema")
            if not isinstance(schema, dict) or schema.get("type") != "object":
                raise GranolaError("Unsupported meeting tool schema; adapter needed")
            properties = schema.get("properties", {})
            required = schema.get("required", [])
            if (not isinstance(properties, dict) or not isinstance(required, list)
                    or any(not isinstance(field, str) for field in required)
                    or len(set(required)) != len(required)):
                raise GranolaError("Invalid meeting tool schema; adapter needed")
            if any(key in schema for key in ("$ref", "allOf", "anyOf", "oneOf", "not", "dependentRequired", "dependencies")):
                raise GranolaError("Unsupported composed tool schema; adapter needed")
            if name == "list_meetings":
                if required:
                    raise GranolaError("Unsupported required listing fields; adapter needed")
                cursor = properties.get("cursor")
                if "cursor" in properties and (not isinstance(cursor, dict) or cursor.get("type") != "string"):
                    raise GranolaError("Unsupported cursor schema; adapter needed")
                selected[name] = {"cursor": cursor, "required": required}
            else:
                supported = []
                for field in ("meeting_ids", "ids"):
                    if field in properties:
                        item = properties[field]
                        if (not isinstance(item, dict) or item.get("type") != "array"
                                or not isinstance(item.get("items"), dict)
                                or item["items"].get("type") != "string"):
                            raise GranolaError("Unsupported meeting ID schema; adapter needed")
                        supported.append(field)
                if not supported:
                    raise GranolaError("No supported meeting ID argument; adapter needed")
                field = "meeting_ids" if "meeting_ids" in supported else "ids"
                if set(required) - {field}:
                    raise GranolaError("Unsupported required detail fields; adapter needed")
                selected[name] = {"field": field, "schema": properties[field]}
        if set(selected) != {"list_meetings", "get_meetings"}:
            raise GranolaError("Required meeting tools are unavailable; adapter needed")
        return selected

    @staticmethod
    def _validate_argument(value, schema):
        if any(key in schema for key in ("$ref", "allOf", "anyOf", "oneOf", "not", "pattern", "format", "contains", "prefixItems")):
            raise GranolaError("Unsupported argument constraints; adapter needed")
        if "enum" in schema and value not in schema["enum"]:
            raise GranolaError("Argument violates advertised schema")
        if "const" in schema and value != schema["const"]:
            raise GranolaError("Argument violates advertised schema")
        if isinstance(value, str):
            for key, fails in (("minLength", lambda n: len(value) < n), ("maxLength", lambda n: len(value) > n)):
                if key in schema:
                    n = schema[key]
                    if type(n) is not int or n < 0 or fails(n):
                        raise GranolaError("Argument violates advertised schema")
        elif isinstance(value, list):
            for key, fails in (("minItems", lambda n: len(value) < n), ("maxItems", lambda n: len(value) > n)):
                if key in schema:
                    n = schema[key]
                    if type(n) is not int or n < 0 or fails(n):
                        raise GranolaError("Meeting batch violates advertised schema")
            if schema.get("uniqueItems") and len(set(value)) != len(value):
                raise GranolaError("Meeting batch violates advertised schema")
            for item in value:
                GranolaClient._validate_argument(item, schema["items"])

    @staticmethod
    def _meetings(result):
        if "structuredContent" in result:
            payload = result["structuredContent"]
        else:
            content = result.get("content")
            if (not isinstance(content, list) or len(content) != 1
                    or not isinstance(content[0], dict) or content[0].get("type") != "text"
                    or not isinstance(content[0].get("text"), str)):
                raise GranolaError("Unsupported meeting output; adapter needed")
            payload = _json(content[0]["text"])
        if (not isinstance(payload, dict) or not isinstance(payload.get("meetings"), list)
                or len(payload["meetings"]) > MAX_MEETINGS
                or any(not isinstance(meeting, dict) for meeting in payload["meetings"])):
            raise GranolaError("Unsupported meeting output; adapter needed")
        cursor = payload.get("next_cursor")
        if cursor is not None:
            _text(cursor, "Unsupported pagination cursor; adapter needed")
        return payload["meetings"], cursor

    @staticmethod
    def _normalize(meeting):
        source_id = _text(meeting.get("id"), "Unsupported meeting identifier; adapter needed")
        summary_key = "summary" if "summary" in meeting else "summarized_notes"
        summary = meeting.get(summary_key)
        notes = meeting.get("private_notes")
        if not isinstance(summary, str) or not isinstance(notes, str):
            raise GranolaError("Explicit text summary and private_notes are required; adapter needed")
        record = {"summary": summary, "private_notes": notes}
        for field in ("title", "date"):
            value = meeting.get(field, "")
            if not isinstance(value, str):
                raise GranolaError("Unsupported meeting metadata; adapter needed")
            record[field] = value
        for field in ('participants', 'attendees', 'location', 'duration', 'body', 'content'):
            if field in meeting:
                record[field] = meeting[field]
        if "version" in meeting:
            version = _text(meeting["version"], "Unsupported explicit version; adapter needed")
        else:
            canonical = json.dumps({"summary": summary, "private_notes": notes}, ensure_ascii=False,
                                   sort_keys=True, separators=(",", ":"), allow_nan=False)
            version = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        return {"source_id": source_id, "version": version, **record}

    def sync(self, user, jobid):
        # Claim and verify credentials before opening any provider connection.
        job = self.store.claim_job(user, jobid)
        if job.get("owner") != user or job.get("provider") != "granola" or job.get("state") != "running":
            raise GranolaError("Job scope is invalid")
        epoch = job.get("epoch")
        if type(epoch) is not int or epoch < 0:
            raise GranolaError("Job epoch is invalid")
        attempt = job.get("attempts")
        if type(attempt) is not int or attempt < 1:
            raise GranolaError("Job attempt is invalid")
        self._current(user, epoch)
        secret = self.store.get_authenticated_secret(user, "granola")
        self._current(user, epoch)
        if not isinstance(secret, dict):
            raise GranolaError("Connector credentials are invalid")
        token = _text(secret.get("access_token"), "Connector access token is unavailable")
        expiry = secret.get("expires_at")
        if expiry is not None and (isinstance(expiry, bool) or not isinstance(expiry, (int, float))
                                   or not math.isfinite(expiry) or self._now() >= expiry):
            raise GranolaError("Connector access token has expired; reconnect required")
        records = []
        with self._session() as http:
            session_id = None
            counter = 0

            def rpc(method, params=None, notification=False):
                nonlocal session_id, counter
                self._current(user, epoch)
                counter += 1
                request_id = counter
                body = {"jsonrpc": "2.0", "method": method}
                if not notification:
                    body["id"] = request_id
                if params is not None:
                    body["params"] = params
                headers = {"Authorization": "Bearer " + token,
                           "Accept": "application/json, text/event-stream",
                           "Content-Type": "application/json",
                           "MCP-Protocol-Version": PROTOCOL_VERSION}
                if session_id is not None:
                    headers["Mcp-Session-Id"] = session_id
                raw, response_headers = self._request(http, "POST", self._mcp,
                                                     headers=headers, body=body, empty=notification)
                advertised_session = next((v for k, v in response_headers.items() if k.lower() == "mcp-session-id"), None)
                if advertised_session is not None:
                    _text(advertised_session, "Invalid MCP session identifier")
                    if len(advertised_session) > 1024:
                        raise GranolaError("Invalid MCP session identifier")
                    if method == "initialize":
                        session_id = advertised_session
                    elif advertised_session != session_id:
                        raise GranolaError("MCP session changed unexpectedly")
                if notification:
                    return None
                return self._rpc_result(raw, response_headers, request_id)

            initialized = rpc("initialize", {"protocolVersion": PROTOCOL_VERSION,
                              "capabilities": {}, "clientInfo": {"name": "multiuser-granola", "version": "1"}})
            if initialized.get("protocolVersion") != PROTOCOL_VERSION:
                raise GranolaError("Unsupported MCP protocol version")
            rpc("notifications/initialized", notification=True)
            tools = []
            cursor = None
            seen = set()
            for page in range(self.config.max_pages):
                result = rpc("tools/list", {"cursor": cursor} if cursor is not None else {})
                advertised = result.get("tools")
                if not isinstance(advertised, list) or len(tools) + len(advertised) > 1000:
                    raise GranolaError("Invalid or excessive tool advertisement")
                tools.extend(advertised)
                cursor = result.get("nextCursor")
                if cursor is None:
                    break
                _text(cursor, "Invalid tool pagination cursor")
                if cursor in seen or page + 1 == self.config.max_pages:
                    raise GranolaError("Tool pagination exceeded limit or repeated cursor")
                seen.add(cursor)
            schemas = self._schemas(tools)
            ids = []
            id_set = set()
            cursor = None
            seen = set()
            for page in range(self.config.max_pages):
                args = {}
                if cursor is not None:
                    schema = schemas["list_meetings"]["cursor"]
                    if schema is None:
                        raise GranolaError("Pagination argument is not advertised; adapter needed")
                    self._validate_argument(cursor, schema)
                    args["cursor"] = cursor
                meetings, cursor = self._meetings(rpc("tools/call", {"name": "list_meetings", "arguments": args}))
                for meeting in meetings:
                    meeting_id = _text(meeting.get("id"), "Unsupported listing identifier; adapter needed")
                    if meeting_id not in id_set:
                        id_set.add(meeting_id)
                        ids.append(meeting_id)
                        if len(ids) > MAX_MEETINGS:
                            raise GranolaError("Meeting count exceeded limit")
                if cursor is None:
                    break
                if cursor in seen or page + 1 == self.config.max_pages:
                    raise GranolaError("Meeting pagination exceeded limit or repeated cursor")
                seen.add(cursor)
            details = schemas["get_meetings"]
            batch_size = self.config.batch_size
            advertised_max = details["schema"].get("maxItems")
            if advertised_max is not None:
                if type(advertised_max) is not int or advertised_max < 1:
                    raise GranolaError("Unsupported meeting batch limit; adapter needed")
                batch_size = min(batch_size, advertised_max)
            for offset in range(0, len(ids), batch_size):
                batch = ids[offset:offset + batch_size]
                self._validate_argument(batch, details["schema"])
                meetings, next_cursor = self._meetings(rpc("tools/call", {
                    "name": "get_meetings", "arguments": {details["field"]: batch}}))
                if next_cursor is not None:
                    raise GranolaError("Detail pagination is unsupported; adapter needed")
                returned = set()
                normalized = []
                for meeting in meetings:
                    record = self._normalize(meeting)
                    source_id = record["source_id"]
                    if source_id not in batch or source_id in returned:
                        raise GranolaError("Unexpected or duplicate detail identifier")
                    returned.add(source_id)
                    normalized.append(record)
                if returned != set(batch):
                    raise GranolaError("Provider omitted requested meeting details; adapter needed")
                records.extend(normalized)
        # Validate all provider output before persisting any imported records.
        for record in records:
            self.store.save_minute(user, "granola", record["source_id"], record["version"],
                                   {key: value for key, value in record.items() if key not in ("source_id", "version")},
                                   expected_epoch=epoch, job_id=jobid,
                                   expected_attempt=attempt)
        self.store.finish_job(user, jobid, expected_epoch=epoch,
                              expected_attempt=attempt)
        return records


def refresh_access_token(client, user):
    """DSTA-PATCH: renew an expired access token with the stored refresh token (public PKCE client)."""
    secret = client.store.get_authenticated_secret(user, "granola")
    if not isinstance(secret, dict) or not secret.get("refresh_token"):
        raise GranolaError("No refresh token; reconnect required")
    endpoint = secret.get("token_endpoint")
    if endpoint != client._endpoints["token_endpoint"]:
        raise GranolaError("Stored token endpoint is not permitted")
    epoch = client.store.status(user, "granola")["epoch"]
    with client._session() as http:
        raw, _ = client._request(http, "POST", endpoint, form={
            "grant_type": "refresh_token", "refresh_token": secret["refresh_token"],
            "client_id": secret["client_id"], "resource": client._mcp,
        })
    result = _json(raw)
    if not isinstance(result, dict):
        raise GranolaError("Invalid refresh result")
    token = _text(result.get("access_token"), "Refresh returned no usable access token")
    renewed = {**secret, "access_token": token}
    renewed.pop("expires_at", None)
    if isinstance(result.get("refresh_token"), str) and result["refresh_token"]:
        renewed["refresh_token"] = result["refresh_token"]
    expires = result.get("expires_in")
    if isinstance(expires, (int, float)) and not isinstance(expires, bool) and math.isfinite(expires) and expires > 0:
        renewed["expires_at"] = client._now() + expires
    client.store.set_secret(user, "granola", renewed, expected_epoch=epoch)
