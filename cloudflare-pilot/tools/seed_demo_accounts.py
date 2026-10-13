#!/usr/bin/env python3
"""Seed two synthetic accounts into the configured D1 database.

The two synthetic passwords are typed by the operator in hidden prompts (getpass, no
echo), with confirmation and a minimum length. Only PBKDF2-SHA256 salts and hashes are
written to D1. Passwords are never printed, logged, written to files, passed as command
arguments or environment variables, and references are dropped right after hashing.
Without an interactive terminal the script stops: there is no safe way to ask.
"""
import argparse
import base64
import getpass
import hashlib
import os
import secrets
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATABASE = "dsta-multiuser-pilot-20261012-db"
PERSIST_TO = Path(tempfile.gettempdir()) / "dsta-multiuser-pilot-local-20261012"
ITERATIONS = 100_000  # máximo PBKDF2 que acepta el runtime de Cloudflare Workers
MIN_LENGTH = 14
DEFAULT_PROMPT = getpass.getpass
ACCOUNTS = (
    ("demo-a", "cuenta-a@dsta.test", "Cuenta A · laboratorio"),
    ("demo-b", "cuenta-b@dsta.test", "Cuenta B · laboratorio"),
)


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def run_wrangler(*args: str) -> None:
    command = ["npx.cmd" if os.name == "nt" else "npx", "wrangler", *args, "--config", "wrangler.jsonc"]
    result = subprocess.run(
        subprocess.list2cmdline(command) if os.name == "nt" else command,
        shell=os.name == "nt",
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(result.stdout)
    print(result.stdout, end="")


def ask_password(email: str, prompt):
    """Pide la contraseña sin eco y con confirmación. Devuelve bytes, o None si no es válida."""
    first = prompt(f"Contraseña sintética para {email} (no se muestra): ")
    second = prompt(f"Repite la contraseña para {email}: ")
    try:
        if first != second:
            print(f"Las contraseñas de {email} no coinciden. No se modificó D1.")
            return None
        if len(first) < MIN_LENGTH:
            print(f"La contraseña de {email} debe tener al menos {MIN_LENGTH} caracteres. No se modificó D1.")
            return None
        return first.encode("utf-8")
    finally:
        del first, second


def hash_account(actor_id: str, email: str, name: str, secret: bytes) -> dict:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", secret, salt, ITERATIONS, dklen=32)
    return {"id": actor_id, "email": email, "name": name, "salt": b64url(salt), "digest": b64url(digest)}


def main(argv=None, prompt=None, interactive=None) -> int:
    prompt = prompt or DEFAULT_PROMPT
    interactive = interactive or (lambda: sys.stdin.isatty())
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--local", action="store_true", help="use local Wrangler D1 (default)")
    target.add_argument("--remote", action="store_true", help="write Cloudflare D1; explicit opt-in")
    args = parser.parse_args(argv)
    scope = "--remote" if args.remote else "--local"
    scope_args = (scope,) if args.remote else (scope, "--persist-to", str(PERSIST_TO))

    if not interactive():
        print("Se necesita una terminal interactiva para escribir las contraseñas sin eco. No se modificó D1.")
        return 2

    accounts = []
    for actor_id, email, name in ACCOUNTS:
        secret = ask_password(email, prompt)
        if secret is None:
            return 2
        accounts.append(hash_account(actor_id, email, name, secret))
        del secret  # desde aquí solo existen salt y hash

    now = int(time.time())
    sql = []
    for account in accounts:
        sql.append(
            "INSERT INTO users(id,email,display_name,password_salt,password_hash) VALUES "
            f"({quote(account['id'])},{quote(account['email'])},{quote(account['name'])},"
            f"{quote(account['salt'])},{quote(account['digest'])});"
        )
    sql.extend([
        "INSERT INTO demo_items(id,actor_id,title,detail,created_at) VALUES "
        f"('demo-item-a','demo-a','Registro privado A','Dato sintético exclusivo de Cuenta A.',{now});",
        "INSERT INTO demo_items(id,actor_id,title,detail,created_at) VALUES "
        f"('demo-item-b','demo-b','Registro privado B','Dato sintético exclusivo de Cuenta B.',{now});",
    ])

    try:
        run_wrangler("d1", "migrations", "apply", DATABASE, *scope_args)
        # el archivo temporal contiene solo salt/hash (nunca contraseñas) y se borra al terminar
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".sql", delete=False) as file:
            file.write("\n".join(sql) + "\n")
            sql_path = Path(file.name)
        try:
            run_wrangler("d1", "execute", DATABASE, *scope_args, "--file", str(sql_path))
        finally:
            sql_path.unlink(missing_ok=True)
    except Exception as error:
        print(f"No se sembraron cuentas: {error}")
        return 1

    print("\nCuentas sintéticas creadas: " + ", ".join(a["email"] for a in accounts) +
          ". D1 guarda solo salt y hash; las contraseñas no se muestran ni se guardan.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
