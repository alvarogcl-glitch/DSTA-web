"""Synthetic Granola (OAuth + MCP) on 127.0.0.1 for tests. Never contacts the real service.

Implements discovery metadata, dynamic client registration, an authorize endpoint that
"consents" immediately (302 back to redirect_uri with code+state), PKCE-verified token
exchange and an MCP endpoint exposing list_meetings/get_meetings with synthetic meetings.
"""
import base64
import hashlib
import json
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit

MEETINGS = [
    {"id": "meet-1", "title": "Comité sintético", "date": "2026-10-10", "summary": "Resumen sintético 1", "private_notes": "nota privada 1"},
    {"id": "meet-2", "title": "Revisión sintética", "date": "2026-10-11", "summary": "Resumen sintético 2", "private_notes": "nota privada 2"},
]


class FakeGranola:
    def __init__(self):
        self.codes, self.tokens, self.clients = {}, set(), {}
        self.refresh_tokens, self.refreshes, self.expires_in = {}, 0, 3600
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send(self, status, body=None, headers=None):
                data = json.dumps(body).encode() if body is not None else b""
                self.send_response(status)
                if body is not None:
                    self.send_header("Content-Type", "application/json")
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                url = urlsplit(self.path)
                origin = fake.origin
                if url.path == "/.well-known/oauth-protected-resource":
                    return self.send(200, {"resource": origin + "/mcp", "authorization_servers": [origin]})
                if url.path == "/.well-known/oauth-authorization-server":
                    return self.send(200, {"issuer": origin, "authorization_endpoint": origin + "/authorize",
                                           "token_endpoint": origin + "/token", "registration_endpoint": origin + "/register",
                                           "response_types_supported": ["code"], "grant_types_supported": ["authorization_code"],
                                           "token_endpoint_auth_methods_supported": ["none"], "code_challenge_methods_supported": ["S256"]})
                if url.path == "/authorize":
                    q = {k: v[0] for k, v in parse_qs(url.query).items()}
                    if fake.clients.get(q.get("client_id")) != q.get("redirect_uri") or q.get("code_challenge_method") != "S256":
                        return self.send(400, {"error": "invalid_request"})
                    code = secrets.token_urlsafe(16)
                    fake.codes[code] = (q["code_challenge"], q["client_id"], q["redirect_uri"])
                    return self.send(302, None, {"Location": q["redirect_uri"] + "?" + urlencode({"code": code, "state": q["state"]})})
                return self.send(404, {"error": "not found"})

            def do_POST(self):
                url = urlsplit(self.path)
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
                if url.path == "/register":
                    body = json.loads(raw)
                    client_id = "client-" + secrets.token_hex(4)
                    fake.clients[client_id] = body["redirect_uris"][0]
                    return self.send(201, {"client_id": client_id, "token_endpoint_auth_method": "none",
                                           "redirect_uris": body["redirect_uris"]})
                if url.path == "/token":
                    form = {k: v[0] for k, v in parse_qs(raw).items()}
                    if form.get("grant_type") == "refresh_token":
                        client = fake.refresh_tokens.pop(form.get("refresh_token"), None)
                        if client is None or client != form.get("client_id"):
                            return self.send(400, {"error": "invalid_grant"})
                        fake.refreshes += 1
                        token, refresh = "at-" + secrets.token_urlsafe(16), "rt-" + secrets.token_urlsafe(16)
                        fake.tokens.add(token)
                        fake.refresh_tokens[refresh] = client
                        return self.send(200, {"access_token": token, "token_type": "Bearer", "expires_in": fake.expires_in,
                                               "refresh_token": refresh})
                    entry = fake.codes.pop(form.get("code"), None)
                    challenge = base64.urlsafe_b64encode(hashlib.sha256(form.get("code_verifier", "").encode()).digest()).rstrip(b"=").decode()
                    if not entry or entry[0] != challenge or entry[1] != form.get("client_id") or entry[2] != form.get("redirect_uri"):
                        return self.send(400, {"error": "invalid_grant"})
                    token, refresh = "at-" + secrets.token_urlsafe(16), "rt-" + secrets.token_urlsafe(16)
                    fake.tokens.add(token)
                    fake.refresh_tokens[refresh] = form.get("client_id")
                    return self.send(200, {"access_token": token, "token_type": "Bearer", "expires_in": fake.expires_in,
                                           "refresh_token": refresh})
                if url.path == "/mcp":
                    if self.headers.get("Authorization", "").removeprefix("Bearer ") not in fake.tokens:
                        return self.send(401, {"error": "unauthorized"})
                    message = json.loads(raw)
                    method, rid = message.get("method"), message.get("id")
                    if method == "notifications/initialized":
                        return self.send(202)
                    if method == "initialize":
                        result = {"protocolVersion": "2025-03-26"}
                    elif method == "tools/list":
                        result = {"tools": [
                            {"name": "list_meetings", "inputSchema": {"type": "object", "properties": {"cursor": {"type": "string"}}}},
                            {"name": "get_meetings", "inputSchema": {"type": "object", "required": ["meeting_ids"],
                             "properties": {"meeting_ids": {"type": "array", "items": {"type": "string"}}}}}]}
                    elif method == "tools/call" and message["params"]["name"] == "list_meetings":
                        result = {"structuredContent": {"meetings": [{"id": m["id"]} for m in MEETINGS]}}
                    elif method == "tools/call" and message["params"]["name"] == "get_meetings":
                        wanted = message["params"]["arguments"]["meeting_ids"]
                        result = {"structuredContent": {"meetings": [m for m in MEETINGS if m["id"] in wanted]}}
                    else:
                        return self.send(400, {"error": "unsupported"})
                    return self.send(200, {"jsonrpc": "2.0", "id": rid, "result": result}, {"Mcp-Session-Id": "sess-1"})
                return self.send(404, {"error": "not found"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.origin = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


if __name__ == "__main__":
    import time
    with FakeGranola() as fake:
        print(fake.origin, flush=True)
        while True:
            time.sleep(3600)
