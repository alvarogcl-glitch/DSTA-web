"""Narrow Vikunja tool surface for the DSTA web copilot.

Credentials are read from Hermes' local .env file. This MCP deliberately omits
project/label administration and all delete operations.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP


DEFAULT_HERMES_HOME = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "hermes"
HERMES_ENV = Path(os.environ.get("HERMES_HOME", str(DEFAULT_HERMES_HOME))) / ".env"


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file(HERMES_ENV)
BASE_URL = os.environ.get("VIKUNJA_URL", "http://127.0.0.1:3456").rstrip("/")
TOKEN = os.environ.get("VIKUNJA_API_TOKEN", "")
if not TOKEN:
    raise RuntimeError("VIKUNJA_API_TOKEN is missing from the Hermes .env file")

mcp = FastMCP("vikunja-dashboard")

TASK_UPDATE_FIELDS = (
    "id",
    "title",
    "description",
    "project_id",
    "done",
    "due_date",
    "reminders",
    "repeat_after",
    "repeat_mode",
    "priority",
    "start_date",
    "end_date",
    "assignees",
    "hex_color",
    "percent_done",
    "cover_image_attachment_id",
    "is_favorite",
)
TASK_EDITABLE_FIELDS = {"title", "description", "priority", "due_date", "done"}


def request(method: str, path: str, **kwargs: Any) -> Any:
    headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
    with httpx.Client(base_url=BASE_URL, headers=headers, timeout=30.0) as client:
        response = client.request(method, path, **kwargs)
        response.raise_for_status()
        if not response.content:
            return {"ok": True}
        return response.json()


def task_update_payload(task_id: int, current: dict[str, Any], changes: dict[str, Any]) -> dict[str, Any]:
    """Build a safe v1 update body from the current task plus requested changes."""
    if int(current.get("id", 0)) != task_id:
        raise RuntimeError("Vikunja devolvió una tarea distinta; no se aplicó el cambio.")
    missing = [field for field in TASK_UPDATE_FIELDS if field not in current]
    if missing:
        raise RuntimeError(
            "Vikunja no devolvió todos los campos necesarios para preservar la tarea; "
            f"faltan: {', '.join(missing)}. No se aplicó el cambio."
        )
    unknown = set(changes) - TASK_EDITABLE_FIELDS
    if unknown:
        raise ValueError(f"Campos de tarea no permitidos: {', '.join(sorted(unknown))}")
    return {**{field: current[field] for field in TASK_UPDATE_FIELDS}, **changes}


def update_task_fields(task_id: int, changes: dict[str, Any], current: dict[str, Any] | None = None) -> Any:
    if not changes:
        raise ValueError("No se indicó ningún campo para actualizar.")
    if current is None:
        current = request("GET", f"/api/v1/tasks/{task_id}")
    payload = task_update_payload(task_id, current, changes)
    return request("POST", f"/api/v1/tasks/{task_id}", json=payload)


@mcp.tool()
def pmo_list_projects() -> dict[str, Any]:
    """List Vikunja projects visible to the authenticated PMO account."""
    return {"projects": request("GET", "/api/v1/projects")}


@mcp.tool()
def pmo_list_tasks(project_id: int | None = None, limit: int = 100) -> dict[str, Any]:
    """List PMO tasks, optionally scoped to one project."""
    if project_id is not None:
        result = request("GET", f"/api/v1/projects/{project_id}/tasks", params={"per_page": min(max(limit, 1), 100)})
    else:
        result = request("GET", "/api/v1/tasks", params={"per_page": min(max(limit, 1), 100)})
    return {"tasks": result}


@mcp.tool()
def pmo_update_task(
    task_id: int,
    title: str | None = None,
    description: str | None = None,
    priority: int | None = None,
    due_date: str | None = None,
) -> dict[str, Any]:
    """Update selected fields of one Vikunja task; omitted fields stay unchanged."""
    payload = {
        key: value
        for key, value in (("title", title), ("description", description), ("priority", priority), ("due_date", due_date))
        if value is not None
    }
    if not payload:
        return {"ok": False, "error": "No se indicó ningún campo para actualizar."}
    return update_task_fields(task_id, payload)


@mcp.tool()
def pmo_complete_task(task_id: int) -> dict[str, Any]:
    """Mark the specified Vikunja task as completed."""
    return update_task_fields(task_id, {"done": True})


@mcp.tool()
def pmo_set_dependency(task_id: int, dependency: str) -> dict[str, Any]:
    """Set the structured Dependencia field while preserving the rest of the task description."""
    task = request("GET", f"/api/v1/tasks/{task_id}")
    lines = (task.get("description") or "").replace("\r", "").split("\n")
    for index, line in enumerate(lines):
        if line.lower().startswith("dependencia:"):
            lines[index] = f"Dependencia: {dependency.strip()}"
            break
    else:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(f"Dependencia: {dependency.strip()}")
    return update_task_fields(task_id, {"description": "\n".join(lines)}, current=task)


@mcp.tool()
def pmo_add_comment(task_id: int, comment: str) -> dict[str, Any]:
    """Add a dated comment to the specified Vikunja task."""
    return request("PUT", f"/api/v1/tasks/{task_id}/comments", json={"comment": comment})


if __name__ == "__main__":
    mcp.run(transport="stdio")
