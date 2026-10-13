#!/usr/bin/env python3
"""Isolation checks for the multiuser DSTA dashboard (AUTH_MODE=accounts), staging only.

Creates two temporary QA accounts with random ids through single-use invitations (D1 stores
only token hashes), with random passwords that live only in this process. Publishes synthetic
snapshots/minutes for each actor through the bridge channel, runs every cross-actor check and
deletes the QA accounts, sessions and invitations at the end, also on failure.

Usage (from the repo root, never against production):
    DSTA_STAGING_BRIDGE_TOKEN=... python tools/staging_isolation_check.py https://dsta-web-staging.<sub>.workers.dev
    ... --local --persist-to <dir> http://127.0.0.1:<port>
The log holds only check names and HTTP statuses: never passwords, cookies or tokens.
"""
import argparse
import base64
import hashlib
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from http.cookies import SimpleCookie
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = "wrangler.staging.jsonc"
DATABASE = "dsta-web-staging-db"
PRODUCTION_HOSTS = ("dsta-web.", "dsta-web-")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.cookies = {}
        self.opener = urllib.request.build_opener(NoRedirect)

    def request(self, method, path, body=None, origin=True, headers=None):
        h = {"Accept": "application/json", "User-Agent": "dsta-staging-isolation-check", **(headers or {})}
        if self.cookies:
            h["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        if origin and method != "GET" and "Origin" not in h:
            h["Origin"] = self.base
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            response = self.opener.open(req, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        status = getattr(response, "status", None) or response.code
        for header in response.headers.get_all("Set-Cookie") or []:
            cookie = SimpleCookie()
            cookie.load(header)
            for name, morsel in cookie.items():
                if morsel["max-age"] == "0" or not morsel.value:
                    self.cookies.pop(name, None)
                else:
                    self.cookies[name] = morsel.value
        raw = response.read()
        try:
            payload = json.loads(raw) if raw else None
        except ValueError:
            payload = None
        return status, payload, response.headers


def wrangler_sql(sql, scope_args):
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".sql", delete=False) as file:
        file.write(sql)
        path = file.name
    try:
        command = ["npx.cmd" if os.name == "nt" else "npx", "wrangler", "d1", "execute", DATABASE, *scope_args,
                   "--config", CONFIG, "--file", path]
        result = subprocess.run(subprocess.list2cmdline(command) if os.name == "nt" else command, shell=os.name == "nt",
                                cwd=ROOT, text=True, encoding="utf-8", errors="replace",
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        if result.returncode:
            raise RuntimeError("wrangler d1 execute falló")
    finally:
        Path(path).unlink(missing_ok=True)


def token_hash(token):
    return base64.urlsafe_b64encode(hashlib.sha256(token.encode()).digest()).decode().rstrip("=")


def run(base, bridge_token, scope_args, log=print):
    suffix = secrets.token_hex(3)
    actors = {"A": f"qa-a-{suffix}", "B": f"qa-b-{suffix}"}
    passwords = {k: "qa-" + secrets.token_urlsafe(24) for k in actors}
    tokens = {k: secrets.token_urlsafe(32) for k in actors}
    results = []

    def check(name, ok, status=None):
        results.append(bool(ok))
        log(f"{'OK  ' if ok else 'FAIL'} {name}" + (f" [HTTP {status}]" if status is not None else ""))

    now = int(time.time())
    sql = "".join(
        "INSERT INTO invitations(token_hash,actor_id,email,display_name,expires_at,created_at) VALUES "
        f"('{token_hash(tokens[k])}','{actors[k]}','{actors[k]}@dsta.test','QA {k} temporal',{now + 900},{now});\n"
        for k in actors)
    try:
        wrangler_sql(sql, scope_args)
        clients = {k: Client(base) for k in actors}
        for k, actor in actors.items():
            status, _, _ = Client(base).request("POST", "/api/auth/accept-invite", {"token": tokens[k], "password": passwords[k]})
            check(f"cuenta {k} creada por invitación", status == 201, status)
        tokens.clear()
        status, _, headers = Client(base).request("GET", "/", headers={"Accept": "text/html"})
        check("sin sesión, el dashboard redirige a /login", status == 302 and headers.get("Location") == "/login", status)
        status, _, _ = Client(base).request("GET", "/api/dashboard")
        check("sin sesión, la API responde 401", status == 401, status)
        status, _, _ = Client(base).request("GET", "/api/dashboard", headers={"Authorization": "Basic " + base64.b64encode(b"admin:x").decode()})
        check("Basic Auth no sirve en modo cuentas", status == 401, status)
        for k, actor in actors.items():
            status, payload, _ = clients[k].request("POST", "/api/auth/login", {"email": f"{actor}@dsta.test", "password": passwords[k]})
            check(f"login {k}", status == 200 and (payload or {}).get("actor", {}).get("id") == actor, status)
        passwords.clear()

        bridge = Client(base)
        def as_bridge(method, path, actor, body=None):
            return bridge.request(method, path, body, origin=False,
                                  headers={"Authorization": f"Bearer {bridge_token}", **({"X-DSTA-Actor": actor} if actor else {})})
        status, _, _ = as_bridge("POST", "/api/bridge/snapshot", None, {"timestamp": "2026-10-13T00:00:00Z", "projects": [], "tasks": []})
        check("el puente sin usuario es rechazado", status == 400, status)
        status, _, _ = bridge.request("POST", "/api/bridge/snapshot", {"timestamp": "2026-10-13T00:00:00Z", "projects": [], "tasks": []},
                                      origin=False, headers={"Authorization": "Bearer token-invalido", "X-DSTA-Actor": actors["A"]})
        check("el puente con token inválido es rechazado", status == 401, status)
        ids = {"A": 301, "B": 302}
        for k, actor in actors.items():
            snap = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "projects": [{"id": ids[k], "title": f"LT sintética {k}"}],
                    "tasks": [{"id": ids[k] * 10, "title": f"Tarea privada {k}", "project_id": ids[k], "done": False}]}
            status, _, _ = as_bridge("POST", "/api/bridge/snapshot", actor, snap)
            check(f"el puente publica el snapshot de {k}", status == 202, status)
        for k, other in (("A", "B"), ("B", "A")):
            status, payload, _ = clients[k].request("GET", "/api/dashboard")
            titles = [t["title"] for t in (payload or {}).get("tasks", [])]
            check(f"{k} ve solo su snapshot", status == 200 and titles == [f"Tarea privada {k}"], status)

        status, job, _ = clients["A"].request("POST", "/api/assistant", {"message": "resumen sintético"})
        check("A crea una consulta al Copilot", status == 202 and job and job.get("id"), status)
        status, polled, _ = as_bridge("GET", "/api/bridge/next", actors["B"])
        check("la cola de B no contiene la consulta de A", status == 200 and (polled or {}).get("job") is None, status)
        status, _, _ = clients["B"].request("GET", f"/api/assistant?id={job['id']}")
        check("B no puede leer la consulta de A (404)", status == 404, status)
        status, polled, _ = as_bridge("GET", "/api/bridge/next", actors["A"])
        check("la cola de A entrega su consulta", status == 200 and (polled or {}).get("job", {}).get("id") == job["id"], status)

        status, _, _ = clients["A"].request("POST", "/api/task-actions", {"action": "complete", "taskId": ids["B"] * 10, "requestId": str(uuid.uuid4())})
        check("A no puede actuar sobre la tarea de B (404)", status == 404, status)
        minute = {"id": f"m-{suffix}", "titulo": "Minuta sintética", "detectadaEn": "2026-10-13T00:00:00Z", "digest": "d", "acciones": []}
        status, _, _ = as_bridge("POST", "/api/bridge/minute", actors["A"], minute)
        check("el puente publica una minuta para A", status == 200, status)
        _, mins_a, _ = clients["A"].request("GET", "/api/minutes")
        _, mins_b, _ = clients["B"].request("GET", "/api/minutes")
        check("la minuta de A no aparece en la bandeja de B",
              len((mins_a or {}).get("minutes", [])) == 1 and len((mins_b or {}).get("minutes", [])) == 0)

        status, _, _ = clients["B"].request("POST", "/api/assistant", {"message": "x"}, origin=False)
        check("escritura sin Origin rechazada (CSRF)", status == 403, status)
        status, _, _ = clients["B"].request("POST", "/api/assistant", {"message": "x"}, headers={"Origin": "https://attacker.example"})
        check("escritura con Origin ajeno rechazada", status == 403, status)

        stale = dict(clients["A"].cookies)
        status, _, _ = clients["A"].request("POST", "/api/auth/logout")
        check("logout A", status == 204, status)
        replay = Client(base)
        replay.cookies = stale
        status, _, _ = replay.request("GET", "/api/dashboard")
        check("la cookie anterior de A quedó revocada", status == 401, status)
        status, _, _ = clients["B"].request("GET", "/api/dashboard")
        check("B sigue con sesión tras el logout de A", status == 200, status)
    finally:
        passwords.clear()
        tokens.clear()
        ids_sql = ",".join(f"'{a}'" for a in actors.values())
        try:
            wrangler_sql(f"DELETE FROM sessions WHERE actor_id IN ({ids_sql});\nDELETE FROM users WHERE id IN ({ids_sql});\n"
                         f"DELETE FROM invitations WHERE actor_id IN ({ids_sql});\n", scope_args)
            log("     limpieza: cuentas, sesiones e invitaciones QA eliminadas")
        except Exception:
            log("FAIL limpieza de cuentas QA")
            results.append(False)
    passed = sum(results)
    log(f"\nResultado: {passed}/{len(results)} pruebas OK")
    return len(results) - passed


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("base_url")
    parser.add_argument("--local", action="store_true")
    parser.add_argument("--persist-to")
    args = parser.parse_args(argv)
    host = args.base_url.split("//", 1)[-1]
    if any(host.startswith(p) for p in PRODUCTION_HOSTS) and "staging" not in host:
        print("Este script es solo para staging; no se ejecuta contra producción.")
        return 2
    token = os.environ.get("DSTA_STAGING_BRIDGE_TOKEN", "")
    if not token:
        print("Falta DSTA_STAGING_BRIDGE_TOKEN en el entorno.")
        return 2
    scope = ("--local", *(("--persist-to", args.persist_to) if args.persist_to else ())) if args.local else ("--remote",)
    return 1 if run(args.base_url, token, scope) else 0


if __name__ == "__main__":
    raise SystemExit(main())
