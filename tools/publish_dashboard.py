"""Publica snapshots de Vikunja en el Worker de Cloudflare.

Consulta Vikunja cada 30 segundos y escribe en Workers KV únicamente cuando
hay cambios o cuando corresponde el pulso de cinco minutos.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

POLL_SECONDS = 30
HEARTBEAT_SECONDS = 300
USER_AGENT = "DSTA-Dashboard-Publisher/1.0"


def load_env_file(path: Path | None) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path or not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def setting(name: str, file_values: dict[str, str]) -> str:
    value = os.environ.get(name) or file_values.get(name)
    if not value:
        raise RuntimeError(f"Falta la variable {name}")
    return value


def request_json(url: str, *, headers: dict[str, str], timeout: int = 30):
    request = Request(url, headers={"User-Agent": USER_AGENT, **headers})
    with urlopen(request, timeout=timeout) as response:
        return json.load(response), response.headers


def pages(base_url: str, path: str, token: str) -> list[dict]:
    items: list[dict] = []
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    for page in range(1, 101):
        query = urlencode({"page": page, "per_page": 100})
        batch, response_headers = request_json(
            f"{base_url}{path}?{query}", headers=headers
        )
        if not isinstance(batch, list):
            raise RuntimeError(f"Respuesta inválida de Vikunja: {path}")
        items.extend(batch)
        total_pages = response_headers.get("x-pagination-total-pages")
        if (total_pages and page >= int(total_pages)) or (not total_pages and len(batch) < 100):
            return items
    raise RuntimeError(f"Paginación incompleta: {path}")


def description_field(description: str, name: str) -> str:
    for line in (description or "").splitlines():
        if line.lower().startswith(name.lower() + ":"):
            return line.split(":", 1)[1].strip() or "Por confirmar"
    return "Por confirmar"


def fetch_dashboard(base_url: str, token: str) -> dict:
    projects = pages(base_url, "/api/v1/projects", token)
    if not any(int(project.get("id") or 0) == 2 for project in projects):
        raise RuntimeError("No se encontró la raíz PMO-DSTA; no se publica información parcial")
    scope = sorted(
        (project for project in projects
         if int(project.get("parent_project_id") or 0) == 2 and not project.get("is_archived")),
        key=lambda project: (float(project.get("position") or 0), str(project.get("title") or "").casefold()),
    )

    tasks: list[dict] = []
    project_summary: list[dict] = []
    for project in scope:
        project_id = int(project["id"])
        raw_tasks = pages(base_url, f"/api/v1/projects/{project_id}/tasks", token)
        project_summary.append(
            {"id": project["id"], "title": project["title"], "count": len(raw_tasks)}
        )
        for raw in raw_tasks:
            description = raw.get("description") or ""
            due_date = raw.get("due_date") or ""
            if due_date.startswith("0001-01-01"):
                due_date = ""
            tasks.append(
                {
                    "id": raw["id"],
                    "title": raw.get("title") or "",
                    "done": bool(raw.get("done")),
                    "project": project["title"],
                    "project_id": project["id"],
                    "owner": description_field(description, "Responsable"),
                    "date": due_date[:10] if due_date else description_field(description, "Fecha objetivo"),
                    "dependency": description_field(description, "Dependencia"),
                    "criterion": description_field(description, "Criterio de cierre"),
                    "source": description_field(description, "SOURCE"),
                    "action_key": description_field(description, "ACTION_KEY"),
                    "description": description,
                }
            )
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "projects": project_summary,
        "tasks": tasks,
        "stale": False,
    }


def content_hash(snapshot: dict) -> str:
    stable = {"projects": snapshot["projects"], "tasks": snapshot["tasks"]}
    encoded = json.dumps(stable, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def publish(ingest_url: str, ingest_token: str, snapshot: dict) -> dict:
    payload = json.dumps(snapshot, ensure_ascii=False).encode("utf-8")
    request = Request(
        ingest_url,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {ingest_token}",
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": str(len(payload)),
            "User-Agent": USER_AGENT,
        },
    )
    with urlopen(request, timeout=60) as response:
        return json.load(response)


def run(
    once: bool,
    env_file: Path | None,
    dashboard_url_option: str | None,
    ingest_token_file: Path | None,
) -> int:
    values = load_env_file(env_file)
    vikunja_url = (os.environ.get("VIKUNJA_URL") or values.get("VIKUNJA_URL") or "http://127.0.0.1:3456").rstrip("/")
    vikunja_token = setting("VIKUNJA_API_TOKEN", values)
    dashboard_url = (
        dashboard_url_option or setting("DSTA_DASHBOARD_URL", values)
    ).rstrip("/")
    if ingest_token_file:
        ingest_token = ingest_token_file.read_text(encoding="utf-8").strip()
        if not ingest_token:
            raise RuntimeError("El archivo del token de publicación está vacío")
    else:
        ingest_token = setting("DSTA_DASHBOARD_INGEST_TOKEN", values)
    if not dashboard_url.startswith("https://"):
        raise RuntimeError("DSTA_DASHBOARD_URL debe usar HTTPS")

    previous_hash = ""
    last_publish = 0.0
    while True:
        try:
            snapshot = fetch_dashboard(vikunja_url, vikunja_token)
            current_hash = content_hash(snapshot)
            now = time.monotonic()
            if current_hash != previous_hash or now - last_publish >= HEARTBEAT_SECONDS:
                result = publish(f"{dashboard_url}/api/ingest", ingest_token, snapshot)
                previous_hash = current_hash
                last_publish = now
                print(
                    f"{snapshot['timestamp']} publicado: "
                    f"{result.get('projects')} proyectos, {result.get('tasks')} tareas",
                    flush=True,
                )
        except (HTTPError, URLError, OSError, ValueError, RuntimeError) as error:
            print(f"Error de sincronización: {error}", file=sys.stderr, flush=True)
            if once:
                return 1
        if once:
            return 0
        time.sleep(POLL_SECONDS)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="Publica una vez y termina")
    parser.add_argument("--env-file", type=Path, help="Archivo local con variables de entorno")
    parser.add_argument("--dashboard-url", help="URL HTTPS del Worker")
    parser.add_argument(
        "--ingest-token-file",
        type=Path,
        help="Archivo local que contiene únicamente el token de publicación",
    )
    arguments = parser.parse_args()
    return run(
        arguments.once,
        arguments.env_file,
        arguments.dashboard_url,
        arguments.ingest_token_file,
    )


if __name__ == "__main__":
    raise SystemExit(main())
