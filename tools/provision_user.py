#!/usr/bin/env python3
"""Admin: provision or remove a multiuser DSTA user (F2).

provision: creates the user's own Vikunja account (random password), their root project and an
API token scoped to their own data; stores URL/token/root/credentials encrypted in the DPAPI vault;
creates a single-use dashboard invitation (D1 keeps only its hash) and prints the link once.
remove: revokes the Vikunja API token, deletes the dashboard account, sessions and invitations,
wipes the user's Durable Object through the bridge and deletes the vault entry. The Vikunja account
itself is kept (deactivate or delete it from Vikunja's admin if required).

Nothing secret is printed except the invitation link, which is meant for its owner.
Usage (repo root):
  python tools/provision_user.py provision --actor ana --email ana@empresa.cl --name "Ana" \
      --dashboard-url https://dsta-web-staging.<sub>.workers.dev [--vikunja-url http://127.0.0.1:14701] [--local --persist-to DIR]
  python tools/provision_user.py remove --actor ana --dashboard-url ... [--local --persist-to DIR]
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

_tools_dir = str(Path(__file__).resolve().parent)
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)
import user_vault  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CONFIG = "wrangler.staging.jsonc"
DATABASE = "dsta-web-staging-db"
ACTOR_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}$")
TOKEN_GROUPS = ("projects", "tasks", "labels", "tasks_labels", "projects_views", "projects_views_tasks", "user")
INVITE_HOURS = 24


def vikunja(base: str, method: str, path: str, body=None, token: str | None = None):
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base.rstrip("/") + "/api/v1" + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def scoped_permissions(routes: dict) -> dict:
    return {group: sorted(routes[group]) for group in TOKEN_GROUPS if isinstance(routes.get(group), dict)}


def provision_vikunja(vikunja_url: str, actor: str, email: str, name: str) -> dict:
    username = f"dsta-{actor}"
    password = secrets.token_urlsafe(24)
    vikunja(vikunja_url, "POST", "/register", {"username": username, "email": email, "password": password})
    jwt = vikunja(vikunja_url, "POST", "/login", {"username": username, "password": password})["token"]
    root = vikunja(vikunja_url, "PUT", "/projects", {"title": f"DSTA · {name}"}, token=jwt)
    routes = vikunja(vikunja_url, "GET", "/routes", token=jwt)
    expires = (datetime.now(timezone.utc) + timedelta(days=365)).strftime("%Y-%m-%dT%H:%M:%SZ")
    api_token = vikunja(vikunja_url, "PUT", "/tokens",
                        {"title": "dsta-dashboard", "expires_at": expires, "permissions": scoped_permissions(routes)}, token=jwt)
    return {"vikunjaUrl": vikunja_url.rstrip("/"), "vikunjaToken": api_token["token"], "vikunjaTokenId": api_token["id"],
            "rootProjectId": int(root["id"]), "vikunjaUsername": username, "vikunjaPassword": password}


def d1_execute(sql: str, scope_args) -> None:
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


def quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def invitation_sql(actor: str, email: str, name: str, token: str, now: int) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(token.encode()).digest()).decode().rstrip("=")
    return (f"UPDATE invitations SET used_at = {now} WHERE actor_id = {quote(actor)} AND used_at IS NULL;\n"
            "INSERT INTO invitations(token_hash,actor_id,email,display_name,expires_at,created_at) VALUES "
            f"({quote(digest)},{quote(actor)},{quote(email)},{quote(name)},{now + INVITE_HOURS * 3600},{now});\n")


def reset_sql(actor: str, token: str, now: int) -> str:
    """D67: one-time password reset link for an existing account (its email and name come from D1)."""
    digest = base64.urlsafe_b64encode(hashlib.sha256(token.encode()).digest()).decode().rstrip("=")
    return (f"UPDATE invitations SET used_at = {now} WHERE actor_id = {quote(actor)} AND used_at IS NULL;\n"
            "INSERT INTO invitations(token_hash,actor_id,email,display_name,expires_at,created_at,purpose) "
            f"SELECT {quote(digest)}, id, email, display_name, {now + INVITE_HOURS * 3600}, {now}, 'reset' "
            f"FROM users WHERE id = {quote(actor)};\n")


def removal_sql(actor: str) -> str:
    a = quote(actor)
    return (f"DELETE FROM sessions WHERE actor_id = {a};\nDELETE FROM invitations WHERE actor_id = {a};\n"
            f"DELETE FROM users WHERE id = {a};\n")


def bridge_token() -> str:
    path = Path(os.environ.get("LOCALAPPDATA", "")) / "dsta-staging" / "bridge-token"
    token = os.environ.get("DSTA_BRIDGE_TOKEN") or (path.read_text().strip() if path.exists() else "")
    if not token:
        raise RuntimeError("Falta el token del puente de staging")
    return token


def wipe_box(dashboard_url: str, actor: str) -> int:
    req = urllib.request.Request(f"{dashboard_url.rstrip('/')}/u/{actor}/api/bridge/wipe", data=b"{}", method="POST",
                                 headers={"Authorization": f"Bearer {bridge_token()}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["provision", "remove", "reset"])
    parser.add_argument("--actor", required=True)
    parser.add_argument("--email")
    parser.add_argument("--name")
    parser.add_argument("--dashboard-url", required=True)
    parser.add_argument("--vikunja-url", default="http://127.0.0.1:14701")
    parser.add_argument("--local", action="store_true")
    parser.add_argument("--persist-to")
    parser.add_argument("--produccion", action="store_true",
                        help="Opera contra producción: D1 dsta-web-accounts, wrangler.jsonc y vault de producción")
    args = parser.parse_args(argv)
    global CONFIG, DATABASE
    if args.produccion:
        CONFIG, DATABASE = "wrangler.jsonc", "dsta-web-accounts"
        os.environ["DSTA_VAULT_DIR"] = str(Path(os.environ["LOCALAPPDATA"]) / "dsta-multiuser-prod" / "vault")
    if not ACTOR_ID.match(args.actor):
        print("Identificador inválido (minúsculas, números y guiones).")
        return 2
    if ("dsta-web." in args.dashboard_url and "staging" not in args.dashboard_url) != args.produccion:
        print("Producción exige --produccion (y staging no lo admite): así nunca se mezclan bases ni vaults.")
        return 2
    scope = ("--local", *(("--persist-to", args.persist_to) if args.persist_to else ())) if args.local else ("--remote",)

    if args.command == "reset":
        token = secrets.token_urlsafe(32)
        d1_execute(reset_sql(args.actor, token, int(time.time())), scope)
        print(f"Link de restablecimiento de un solo uso (vence en {INVITE_HOURS} h). Entrégalo solo a su dueño:")
        print(f"{args.dashboard_url.rstrip('/')}/invite#t={token}")
        return 0

    if args.command == "remove":
        user = user_vault.load(args.actor)
        if user and user.get("vikunjaTokenId"):
            try:
                jwt = vikunja(user["vikunjaUrl"], "POST", "/login",
                              {"username": user["vikunjaUsername"], "password": user["vikunjaPassword"]})["token"]
                vikunja(user["vikunjaUrl"], "DELETE", f"/tokens/{user['vikunjaTokenId']}", token=jwt)
                print("Token de Vikunja revocado.")
            except (urllib.error.URLError, OSError, ValueError, KeyError):
                print("No se pudo revocar el token de Vikunja; revócalo manualmente.")
        status = wipe_box(args.dashboard_url, args.actor)
        print(f"Datos del dashboard del usuario borrados [HTTP {status}].")
        d1_execute(removal_sql(args.actor), scope)
        print("Cuenta, sesiones e invitaciones eliminadas de D1.")
        print("Vault eliminado." if user_vault.delete(args.actor) else "No había vault para este usuario.")
        return 0

    if not args.email or not EMAIL.match(args.email) or not args.name:
        print("provision requiere --email y --name válidos.")
        return 2
    if user_vault.load(args.actor):
        print("Ese usuario ya está aprovisionado; usa remove antes de repetir.")
        return 2
    try:
        user = provision_vikunja(args.vikunja_url, args.actor, args.email, args.name)
    except (urllib.error.URLError, OSError, ValueError, KeyError) as error:
        print(f"No se pudo crear el espacio en Vikunja ({type(error).__name__}).")
        return 1
    user_vault.save(args.actor, user)
    print(f"Espacio Vikunja creado (raíz {user['rootProjectId']}); credenciales guardadas cifradas en el vault.")
    token = secrets.token_urlsafe(32)
    d1_execute(invitation_sql(args.actor, args.email, args.name, token, int(time.time())), scope)
    print(f"Invitación de un solo uso (vence en {INVITE_HOURS} h). Entrégala solo a su dueño:")
    print(f"{args.dashboard_url.rstrip('/')}/invite#t={token}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
