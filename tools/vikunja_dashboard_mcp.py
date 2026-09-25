"""Scoped Vikunja tools for the DSTA web copilot."""
from __future__ import annotations

import os
import re
import uuid
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
TASK_EDITABLE_FIELDS = {"title", "description", "priority", "due_date", "done", "project_id"}
PMO_ROOT_PROJECT_ID = 2
PROJECT_UPDATE_FIELDS = ("id", "title", "description", "parent_project_id", "is_archived",
                         "hex_color", "identifier", "position", "is_favorite",
                         "background_blur_hash", "background_information")


def pmo_projects() -> list[dict[str, Any]]:
    projects = request("GET", "/api/v1/projects")
    if not isinstance(projects, list):
        raise RuntimeError("Vikunja devolvió una lista de proyectos inválida.")
    return projects


def is_pmo_line(project: dict[str, Any]) -> bool:
    return (
        int(project.get("parent_project_id") or 0) == PMO_ROOT_PROJECT_ID
        and not project.get("is_archived")
    )


def require_line(project_id: int, projects: list[dict[str, Any]]) -> dict[str, Any]:
    project = next((item for item in projects if int(item.get("id") or 0) == project_id), None)
    if not project or not is_pmo_line(project):
        raise ValueError(f"El proyecto {project_id} no es una línea activa de PMO-DSTA.")
    return project


def check_unique_title(title: str, projects: list[dict[str, Any]], except_id: int = 0) -> None:
    if not title or len(title) > 250:
        raise ValueError("El título de la línea debe tener entre 1 y 250 caracteres.")
    def line_key(value: str) -> str:
        match = re.match(r"^(LT\d+|TR\d*|Transversal)(?=\s|[-–—:]|$)", value, re.IGNORECASE)
        return match.group(1).casefold() if match else value.casefold()
    if any(is_pmo_line(project) and int(project.get("id") or 0) != except_id
           and line_key(str(project.get("title") or "").strip()) == line_key(title)
           for project in projects):
        raise ValueError(f"La línea «{title}» ya existe en PMO-DSTA.")


def project_update_payload(current: dict[str, Any], changes: dict[str, Any]) -> dict[str, Any]:
    missing = [field for field in PROJECT_UPDATE_FIELDS if field not in current]
    if missing:
        raise RuntimeError("Vikunja no devolvió todos los campos del proyecto; no se aplicó el cambio: "
                           + ", ".join(missing))
    return {**{field: current[field] for field in PROJECT_UPDATE_FIELDS}, **changes}


def project_tasks(project_id: int) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    for page in range(1, 101):
        batch = request("GET", f"/api/v1/projects/{project_id}/tasks",
                        params={"page": page, "per_page": 100})
        if not isinstance(batch, list):
            raise RuntimeError("Vikunja devolvió una página de tareas inválida; no se modificó la línea.")
        tasks.extend(batch)
        if len(batch) < 100:
            return tasks
    raise RuntimeError("La paginación de tareas no terminó; no se modificó la línea.")


def structured_task_description(description: str, owner: str, target_date: str,
                                dependency: str, closure_criterion: str,
                                source: str, action_key: str) -> str:
    fields = [
        ("Responsable", owner),
        ("Fecha objetivo", target_date),
        ("Dependencia", dependency),
        ("Criterio de cierre", closure_criterion),
        ("SOURCE", source),
        ("ACTION_KEY", action_key),
    ]
    metadata = "\n".join(f"{name}: {value.strip() or 'Por confirmar'}" for name, value in fields)
    detail = description.strip()
    return f"{metadata}\n\n{detail}" if detail else metadata


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
def pmo_list_projects(include_archived: bool = False) -> dict[str, Any]:
    """List Vikunja projects; include archived ones when locating a line to restore."""
    kwargs = {"params": {"is_archived": "true"}} if include_archived else {}
    return {"projects": request("GET", "/api/v1/projects", **kwargs)}


@mcp.tool()
def pmo_create_project(title: str, description: str = "") -> dict[str, Any]:
    """Create a new portfolio line directly under the PMO-DSTA root."""
    title = title.strip()
    projects = pmo_projects()
    if not any(int(project.get("id", 0)) == PMO_ROOT_PROJECT_ID for project in projects):
        raise RuntimeError("No se encontró el proyecto raíz PMO-DSTA (ID 2); no se creó el proyecto.")
    check_unique_title(title, projects)

    created = request("PUT", "/api/v1/projects", json={
        "title": title,
        "description": description.strip(),
        "parent_project_id": PMO_ROOT_PROJECT_ID,
    })
    project_id = created.get("id") if isinstance(created, dict) else None
    if not project_id:
        raise RuntimeError("Vikunja no devolvió el ID del proyecto creado; verifica el portafolio antes de reintentar.")
    verified = request("GET", f"/api/v1/projects/{project_id}")
    if (not isinstance(verified, dict) or str(verified.get("title", "")).casefold() != title.casefold()
            or int(verified.get("parent_project_id") or 0) != PMO_ROOT_PROJECT_ID):
        raise RuntimeError("El proyecto se creó, pero la verificación de su título o carpeta PMO-DSTA no coincidió.")
    return {"ok": True, "project": verified, "verified": True}


@mcp.tool()
def pmo_update_project(project_id: int, title: str | None = None,
                       description: str | None = None) -> dict[str, Any]:
    """Rename or describe an active PMO line, preserving its other project settings."""
    if title is None and description is None:
        raise ValueError("Indica un título o una descripción para actualizar.")
    projects = pmo_projects()
    require_line(project_id, projects)
    changes: dict[str, Any] = {}
    if title is not None:
        title = title.strip()
        check_unique_title(title, projects, project_id)
        changes["title"] = title
    if description is not None:
        changes["description"] = description
    current = request("GET", f"/api/v1/projects/{project_id}")
    request("POST", f"/api/v1/projects/{project_id}",
            json=project_update_payload(current, changes))
    verified = request("GET", f"/api/v1/projects/{project_id}")
    if any(verified.get(key) != value for key, value in changes.items()):
        raise RuntimeError("Vikunja no confirmó la actualización de la línea; revisa el proyecto antes de reintentar.")
    return {"ok": True, "project": verified, "verified": True}


@mcp.tool()
def pmo_move_task(task_id: int, destination_project_id: int) -> dict[str, Any]:
    """Move a task between active PMO lines while preserving all its fields."""
    require_line(destination_project_id, pmo_projects())
    current = request("GET", f"/api/v1/tasks/{task_id}")
    require_line(int(current.get("project_id") or 0), pmo_projects())
    if int(current["project_id"]) == destination_project_id:
        return {"ok": True, "task": current, "verified": True}
    update_task_fields(task_id, {"project_id": destination_project_id}, current=current)
    verified = request("GET", f"/api/v1/tasks/{task_id}")
    if int(verified.get("project_id") or 0) != destination_project_id:
        raise RuntimeError(f"La tarea {task_id} no quedó en la línea destino; revisa Vikunja antes de reintentar.")
    return {"ok": True, "task": verified, "verified": True}


def archive_empty_line(project_id: int, projects: list[dict[str, Any]]) -> dict[str, Any]:
    require_line(project_id, projects)
    if any(int(project.get("parent_project_id") or 0) == project_id for project in projects):
        raise ValueError("La línea tiene subproyectos; muévelos en Vikunja antes de archivarla.")
    if project_tasks(project_id):
        raise ValueError("La línea aún tiene tareas; muévelas o fusiónala antes de archivarla.")
    current = request("GET", f"/api/v1/projects/{project_id}")
    request("POST", f"/api/v1/projects/{project_id}",
            json=project_update_payload(current, {"is_archived": True}))
    verified = request("GET", f"/api/v1/projects/{project_id}")
    if not verified.get("is_archived"):
        raise RuntimeError("Vikunja no confirmó el archivo de la línea; revisa el proyecto.")
    return {"ok": True, "project": verified, "verified": True}


@mcp.tool()
def pmo_archive_project(project_id: int) -> dict[str, Any]:
    """Remove an empty PMO line from the dashboard by archiving it reversibly."""
    return archive_empty_line(project_id, pmo_projects())


@mcp.tool()
def pmo_restore_project(project_id: int) -> dict[str, Any]:
    """Restore an archived PMO line, preserving its original project and task IDs."""
    current = request("GET", f"/api/v1/projects/{project_id}")
    if int(current.get("parent_project_id") or 0) != PMO_ROOT_PROJECT_ID or not current.get("is_archived"):
        raise ValueError("El proyecto no es una línea archivada bajo PMO-DSTA.")
    check_unique_title(str(current.get("title") or "").strip(), pmo_projects(), project_id)
    request("POST", f"/api/v1/projects/{project_id}",
            json=project_update_payload(current, {"is_archived": False}))
    verified = request("GET", f"/api/v1/projects/{project_id}")
    if verified.get("is_archived"):
        raise RuntimeError("Vikunja no confirmó la restauración de la línea; revisa el proyecto.")
    return {"ok": True, "project": verified, "verified": True}


@mcp.tool()
def pmo_merge_projects(source_project_id: int, destination_project_id: int) -> dict[str, Any]:
    """Move every source task to another PMO line, then archive the empty source."""
    if source_project_id == destination_project_id:
        raise ValueError("La línea de origen y la de destino deben ser distintas.")
    projects = pmo_projects()
    source = require_line(source_project_id, projects)
    target = require_line(destination_project_id, projects)
    if any(int(project.get("parent_project_id") or 0) == source_project_id for project in projects):
        raise ValueError("La línea de origen tiene subproyectos; muévelos en Vikunja antes de fusionarla.")
    task_ids = [int(task["id"]) for task in project_tasks(source_project_id)]
    moved: list[int] = []
    for task_id in task_ids:
        try:
            pmo_move_task(task_id, destination_project_id)
        except Exception as error:
            raise RuntimeError(f"Fusión incompleta: se movieron {len(moved)} de {len(task_ids)} tareas "
                               f"({moved}). El origen sigue activo. Error en #{task_id}: {error}") from error
        moved.append(task_id)
    try:
        archived = archive_empty_line(source_project_id, pmo_projects())
    except Exception as error:
        raise RuntimeError(f"Se movieron {len(moved)} tareas ({moved}), pero el origen sigue activo: {error}") from error
    return {"ok": True, "source": source["title"], "destination": target["title"],
            "moved_task_ids": moved, "archived_project": archived["project"], "verified": True}


@mcp.tool()
def pmo_list_tasks(project_id: int | None = None, limit: int = 100) -> dict[str, Any]:
    """List PMO tasks, optionally scoped to one project."""
    if project_id is not None:
        result = request("GET", f"/api/v1/projects/{project_id}/tasks", params={"per_page": min(max(limit, 1), 100)})
    else:
        result = request("GET", "/api/v1/tasks", params={"per_page": min(max(limit, 1), 100)})
    return {"tasks": result}


@mcp.tool()
def pmo_create_task(
    project_id: int,
    title: str,
    description: str = "",
    owner: str = "",
    target_date: str = "",
    dependency: str = "",
    closure_criterion: str = "",
    source: str = "DSTA Dashboard Copilot",
    action_key: str = "",
) -> dict[str, Any]:
    """Create a structured task in an existing PMO-DSTA LT/TR project and verify it."""
    title = title.strip()
    if not title:
        raise ValueError("El título de la tarea no puede estar vacío.")
    projects = pmo_projects()
    project = next((item for item in projects if int(item.get("id", 0)) == project_id), None)
    if not project or not is_pmo_line(project):
        raise ValueError("Solo se pueden crear tareas en una línea activa del proyecto PMO-DSTA.")

    structured = structured_task_description(
        description, owner, target_date, dependency, closure_criterion,
        source, action_key.strip() or f"DSTA-COPILOT-{uuid.uuid4().hex}",
    )
    created = request("PUT", f"/api/v1/projects/{project_id}/tasks", json={
        "title": title,
        "description": structured,
    })
    task_id = created.get("id") if isinstance(created, dict) else None
    if not task_id:
        raise RuntimeError("Vikunja no devolvió el ID de la tarea creada; verifica el proyecto antes de reintentar.")
    verified = request("GET", f"/api/v1/tasks/{task_id}")
    if (not isinstance(verified, dict) or int(verified.get("project_id") or 0) != project_id
            or str(verified.get("title", "")).strip() != title):
        raise RuntimeError("La tarea se creó, pero la verificación de su título o proyecto no coincidió.")
    return {"ok": True, "task": verified, "verified": True}


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
