#!/usr/bin/env python3
"""Create single-use invitation links for the two synthetic pilot accounts.

Each person opens their link and chooses their own password in the browser, so no
password ever passes through a terminal, chat or log. D1 stores only the SHA-256 of
each random token. The token travels in the URL fragment (#), which browsers never
send to the server. Links expire (24 h by default). Issuing new links revokes the
unused previous ones for the same accounts.

Usage (from cloudflare-pilot/):
    python tools/create_invites.py --remote --base-url https://<url returned by wrangler deploy>
The links are printed once, for delivery to their owner; treat them as secrets.
"""
import argparse
import base64
import hashlib
import importlib.util
import secrets
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATABASE = "dsta-multiuser-pilot-20261012-db"
# (actor_id, email, display_name, initial_item_id)
ACCOUNTS = (
    ("demo-a", "cuenta-a@dsta.test", "Cuenta A · laboratorio", "demo-item-a"),
    ("demo-b", "cuenta-b@dsta.test", "Cuenta B · laboratorio", "demo-item-b"),
)


def _seeder():
    spec = importlib.util.spec_from_file_location("seed_demo_accounts", ROOT / "tools" / "seed_demo_accounts.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_wrangler(*args):
    return _seeder().run_wrangler(*args)


def token_hash(token: str) -> str:
    digest = hashlib.sha256(token.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def quote(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def build_invites(accounts, now: int, ttl_seconds: int):
    """Return (sql, tokens). The SQL holds only token hashes; tokens map actor_id -> token."""
    tokens, sql = {}, []
    for actor_id, email, name, item_id in accounts:
        token = secrets.token_urlsafe(32)
        tokens[actor_id] = token
        sql.append(f"UPDATE invitations SET used_at = {now} WHERE actor_id = {quote(actor_id)} AND used_at IS NULL;")
        sql.append(
            "INSERT INTO invitations(token_hash,actor_id,email,display_name,initial_item_id,expires_at,created_at) VALUES "
            f"({quote(token_hash(token))},{quote(actor_id)},{quote(email)},{quote(name)},{quote(item_id)},"
            f"{now + ttl_seconds},{now});"
        )
    return "\n".join(sql) + "\n", tokens


def invite_link(base_url: str, token: str) -> str:
    return f"{base_url.rstrip('/')}/invite#t={token}"


def store_invites(sql: str, scope_args) -> None:
    """Write the hash-only SQL to a temp file, execute it, and delete the file."""
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".sql", delete=False) as file:
        file.write(sql)
        sql_path = Path(file.name)
    try:
        run_wrangler("d1", "execute", DATABASE, *scope_args, "--file", str(sql_path))
    finally:
        sql_path.unlink(missing_ok=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--local", action="store_true")
    target.add_argument("--remote", action="store_true")
    parser.add_argument("--base-url", required=True, help="URL returned by wrangler deploy (https://…)")
    parser.add_argument("--ttl-hours", type=int, default=24)
    parser.add_argument("--persist-to", help="local D1 directory (only with --local)")
    args = parser.parse_args(argv)
    if not args.base_url.startswith(("https://", "http://127.0.0.1", "http://localhost")):
        print("La URL base debe ser https:// (o localhost para pruebas locales).")
        return 2
    if not 1 <= args.ttl_hours <= 72:
        print("La vigencia debe estar entre 1 y 72 horas.")
        return 2
    scope_args = ("--remote",) if args.remote else ("--local", *(("--persist-to", args.persist_to) if args.persist_to else ()))

    sql, tokens = build_invites(ACCOUNTS, int(time.time()), args.ttl_hours * 3600)
    try:
        store_invites(sql, scope_args)
    except Exception as error:
        print(f"No se crearon invitaciones: {error}")
        return 1
    print(f"\nInvitaciones creadas (un solo uso, vencen en {args.ttl_hours} h). Entrégalas solo a su dueño:")
    for actor_id, email, _, _ in ACCOUNTS:
        print(f"{email}\t{invite_link(args.base_url, tokens[actor_id])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
