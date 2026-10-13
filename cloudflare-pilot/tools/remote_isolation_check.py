#!/usr/bin/env python3
"""Verify actor isolation against a deployed pilot URL (or local wrangler dev).

Usage (from cloudflare-pilot/):
    python tools/remote_isolation_check.py --auto https://<url returned by wrangler deploy>
    python tools/remote_isolation_check.py https://<url>          # interactive: accounts A and B

--auto creates two temporary QA accounts through single-use invitations, with random
passwords that exist only in this process's memory. It runs every check and deletes
the QA accounts, sessions, records and invitations at the end (also on failure). Without
--auto it uses accounts A and B and asks for their passwords in hidden prompts (getpass).

Each account uses its own cookie jar. The log records only check names, HTTP status codes
and assert results: never passwords, cookies, CSRF tokens, invitation tokens or hashes.
The rate-limit check runs last and blocks logins from this IP for about a minute.
"""
import argparse
import getpass
import importlib.util
import json
import secrets
import sys
import time
import urllib.error
import urllib.request
from http.cookies import SimpleCookie
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ACCOUNT_A = "cuenta-a@dsta.test"
ACCOUNT_B = "cuenta-b@dsta.test"
# (email, actor_id, own_item_id)
DEFAULT_ACCOUNTS = ((ACCOUNT_A, "demo-a", "demo-item-a"), (ACCOUNT_B, "demo-b", "demo-item-b"))
# (actor_id, email, display_name, initial_item_id)
QA_ACCOUNTS = (
    ("qa-a", "qa-a@dsta.test", "QA A · temporal", "qa-item-a"),
    ("qa-b", "qa-b@dsta.test", "QA B · temporal", "qa-item-b"),
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    """Minimal HTTP client with its own cookie jar (one per actor)."""

    def __init__(self, base_url):
        self.base = base_url.rstrip("/")
        self.cookies = {}
        self.csrf = ""
        self.opener = urllib.request.build_opener(NoRedirect)

    def request(self, method, path, body=None, origin=True, csrf=True, csrf_value=None):
        headers = {"Accept": "application/json", "User-Agent": "dsta-pilot-isolation-check"}
        if self.cookies:
            headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        if origin:
            headers["Origin"] = self.base
        if csrf and (csrf_value or self.csrf):
            headers["X-CSRF-Token"] = csrf_value or self.csrf
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            response = self.opener.open(req, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        status = response.status if hasattr(response, "status") else response.code
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
        return status, payload

    def login(self, email, password):
        status, payload = self.request("POST", "/api/auth/login", {"email": email, "password": password}, csrf=False)
        if status == 200 and payload:
            self.csrf = payload.get("csrfToken", "")
        return status, payload


def run_checks(base_url, password_a, password_b, log=print, accounts=DEFAULT_ACCOUNTS):
    """Run every check; returns (passed, failed). Logs only names, statuses and results."""
    (email_a, actor_a, item_a), (email_b, actor_b, item_b) = accounts
    results = []

    def check(name, condition, status=None):
        results.append(bool(condition))
        suffix = f" [HTTP {status}]" if status is not None else ""
        log(f"{'OK  ' if condition else 'FAIL'} {name}{suffix}")

    def actor_of(payload):
        return ((payload or {}).get("actor") or {}).get("id")

    a, b = Client(base_url), Client(base_url)

    status, payload = a.request("GET", "/api/health", origin=False, csrf=False)
    check("health responde y usa D1", status == 200 and (payload or {}).get("storage") == "D1", status)

    status, payload = a.login(email_a, password_a)
    check("login A", status == 200 and actor_of(payload) == actor_a, status)
    status, payload = b.login(email_b, password_b)
    check("login B", status == 200 and actor_of(payload) == actor_b, status)
    del password_a, password_b

    status, payload = a.request("GET", "/api/session")
    check("restauración de sesión A", status == 200 and actor_of(payload) == actor_a, status)
    status, payload = b.request("GET", "/api/session")
    check("restauración de sesión B", status == 200 and actor_of(payload) == actor_b, status)

    status, payload = a.request("GET", "/api/demo/items")
    items_a = (payload or {}).get("items", [])
    check("A lista solo sus registros", status == 200 and items_a and all(i["actor_id"] == actor_a for i in items_a)
          and any(i["id"] == item_a for i in items_a), status)
    status, payload = b.request("GET", "/api/demo/items")
    items_b = (payload or {}).get("items", [])
    check("B lista solo sus registros", status == 200 and items_b and all(i["actor_id"] == actor_b for i in items_b)
          and any(i["id"] == item_b for i in items_b), status)

    status, _ = a.request("GET", f"/api/demo/items/{item_b}")
    check("A no puede leer el registro de B (404)", status == 404, status)
    status, _ = b.request("GET", f"/api/demo/items/{item_a}")
    check("B no puede leer el registro de A (404)", status == 404, status)

    status, payload = a.request("POST", "/api/demo/items",
                                {"title": "Prueba de suplantación", "detail": "sintético", "actor_id": actor_b})
    spoof_id = ((payload or {}).get("item") or {}).get("id")
    check(f"escritura de A con actor_id {actor_b} queda atribuida a A",
          status == 201 and payload["item"]["actor_id"] == actor_a, status)
    status, payload = b.request("GET", "/api/demo/items")
    check("B no ve el registro escrito por A",
          status == 200 and all(i["id"] != spoof_id for i in (payload or {}).get("items", [])), status)
    status, _ = b.request("GET", f"/api/demo/items/{spoof_id}")
    check("B recibe 404 al leer el registro escrito por A", status == 404, status)

    body = {"title": "No debería guardarse", "detail": "sintético"}
    status, _ = a.request("POST", "/api/demo/items", body, origin=False)
    check("mutación sin Origin rechazada", status == 403, status)
    status, _ = a.request("POST", "/api/demo/items", body, csrf=False)
    check("mutación sin token CSRF rechazada", status == 403, status)
    status, _ = a.request("POST", "/api/demo/items", body, csrf_value="token-invalido")
    check("mutación con token CSRF inválido rechazada", status == 403, status)
    status, _ = a.request("POST", "/api/auth/logout", csrf=False)
    check("logout sin CSRF rechazado", status == 403, status)
    status, payload = a.request("GET", "/api/demo/items")
    check("las mutaciones rechazadas no crearon registros",
          status == 200 and not any(i["title"] == body["title"] for i in (payload or {}).get("items", [])), status)

    stale_cookies = dict(a.cookies)
    status, _ = a.request("POST", "/api/auth/logout")
    check("logout A", status == 204, status)
    replay = Client(base_url)
    replay.cookies = stale_cookies
    status, _ = replay.request("GET", "/api/session")
    check("la cookie anterior de A quedó revocada", status == 401, status)
    del stale_cookies
    status, payload = b.request("GET", "/api/session")
    check("la sesión de B sigue activa tras logout de A", status == 200 and actor_of(payload) == actor_b, status)

    probe = Client(base_url)
    statuses = []
    for _ in range(12):
        status, _ = probe.login("no-existe@dsta.test", "credencial-invalida-de-prueba")
        statuses.append(status)
        if status == 429:
            break
    check("límite de intentos de login devuelve 429",
          statuses[-1] == 429 and all(s == 401 for s in statuses[:-1]), statuses[-1])
    log(f"     intentos hasta el límite: {len(statuses)} (estados {sorted(set(statuses))})")

    status, _ = b.request("POST", "/api/auth/logout")
    log(f"     limpieza: logout B [HTTP {status}]")

    passed = sum(results)
    log(f"\nResultado: {passed}/{len(results)} pruebas OK")
    return passed, len(results) - passed


def _invites_module():
    spec = importlib.util.spec_from_file_location("create_invites", ROOT / "tools" / "create_invites.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cleanup_sql(accounts):
    ids = ",".join("'" + actor_id + "'" for actor_id, *_ in accounts)
    return "\n".join([
        f"DELETE FROM sessions WHERE actor_id IN ({ids});",
        f"DELETE FROM demo_items WHERE actor_id IN ({ids});",
        f"DELETE FROM users WHERE id IN ({ids});",
        f"DELETE FROM invitations WHERE actor_id IN ({ids});",
    ]) + "\n"


def run_auto(base_url, scope_args, log=print, invites=None):
    """Create QA accounts by invitation, run every check, and always delete the QA data."""
    invites = invites or _invites_module()
    passwords = {actor_id: "qa-" + secrets.token_urlsafe(24) for actor_id, *_ in QA_ACCOUNTS}
    failed = 1
    try:
        sql, tokens = invites.build_invites(QA_ACCOUNTS, int(time.time()), 15 * 60)
        invites.store_invites(sql, scope_args)
        log("     invitaciones QA creadas (solo hash en D1)")
        accepted = True
        for actor_id, *_ in QA_ACCOUNTS:
            status, _ = Client(base_url).request(
                "POST", "/api/auth/accept-invite", {"token": tokens[actor_id], "password": passwords[actor_id]}, csrf=False)
            log(f"{'OK  ' if status == 201 else 'FAIL'} cuenta {actor_id} creada por invitación [HTTP {status}]")
            accepted = accepted and status == 201
        del tokens
        if accepted:
            accounts = tuple((email, actor_id, item_id) for actor_id, email, _, item_id in QA_ACCOUNTS)
            _, failed = run_checks(base_url, passwords["qa-a"], passwords["qa-b"], log=log, accounts=accounts)
    finally:
        passwords.clear()
        try:
            invites.store_invites(cleanup_sql(QA_ACCOUNTS), scope_args)
            log("     limpieza: cuentas, sesiones, registros e invitaciones QA eliminados")
        except Exception as error:  # pragma: no cover - reported, not hidden
            log(f"FAIL limpieza de datos QA: {error}")
            failed = failed or 1
    return failed


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("base_url")
    parser.add_argument("--auto", action="store_true", help="use temporary QA accounts created by invitation")
    parser.add_argument("--local", action="store_true", help="with --auto: local D1 instead of remote")
    parser.add_argument("--persist-to", help="with --auto --local: local D1 directory")
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if not args.base_url.startswith(("https://", "http://127.0.0.1", "http://localhost")):
        print("La URL debe ser la https:// devuelta por wrangler deploy.")
        return 2
    if args.auto:
        scope_args = ("--local", *(("--persist-to", args.persist_to) if args.persist_to else ())) if args.local else ("--remote",)
        return 1 if run_auto(args.base_url, scope_args) else 0
    if not sys.stdin.isatty():
        print("Se necesita una terminal interactiva para escribir las contraseñas sin eco (o usa --auto).")
        return 2
    password_a = getpass.getpass(f"Contraseña de {ACCOUNT_A} (no se muestra): ")
    password_b = getpass.getpass(f"Contraseña de {ACCOUNT_B} (no se muestra): ")
    try:
        _, failed = run_checks(args.base_url, password_a, password_b)
    finally:
        del password_a, password_b
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
