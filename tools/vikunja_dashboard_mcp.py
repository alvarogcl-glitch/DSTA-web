"""Scoped Vikunja tools for the DSTA web copilot."""
from __future__ import annotations

import os
import re
import sys
import uuid
from datetime import date
from pathlib import Path
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP


# Stable normal import shares reentrant state across importlib-loaded clients.
_tools_dir = str(Path(__file__).resolve().parent)
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)
from task_mutation_lock import task_lock, task_lock_owned
import label_actions
from urllib.error import HTTPError

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
                        params={"page": page, "per_page": 50})
        if not isinstance(batch, list):
            raise RuntimeError("Vikunja devolvió una página de tareas inválida; no se modificó la línea.")
        tasks.extend(batch)
        if len(batch) < 50:
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
    # Only callers already holding the transaction can supply an authoritative read.
    nested = task_lock_owned(BASE_URL, task_id)
    with task_lock(BASE_URL, task_id):
        if not changes:
            raise ValueError("No se indicó ningún campo para actualizar.")
        if current is None or not nested:
            current = request("GET", f"/api/v1/tasks/{task_id}")
        payload = task_update_payload(task_id, current, changes)
        projects = pmo_projects()
        require_line(int(current.get("project_id") or 0), projects)
        if "project_id" in changes:
            require_line(int(changes["project_id"]), projects)
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
    with task_lock(BASE_URL, task_id):
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
def pmo_open_tasks() -> dict[str, Any]:
    """Compact list of every open task in the active PMO-DSTA lines, with the start of its description."""
    lines = [project for project in pmo_projects() if is_pmo_line(project)]
    tasks = []
    for project in lines:
        for task in project_tasks(int(project["id"])):
            if task.get("done"):
                continue
            tasks.append({"id": task["id"], "project_id": project["id"], "line": project["title"],
                          "title": task.get("title", ""),
                          "labels": task.get("labels") or [],
                          "description": str(task.get("description") or "")[:1200]})
    return {"lines": [{"id": project["id"], "title": project["title"]} for project in lines],
            "open_tasks": tasks}


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
def pmo_append_log(task_id: int, entry: str, entry_date: str, kind: str = "Actualización") -> dict[str, Any]:
    """Append a dated entry to the structured description, preserving fields and prior history."""
    with task_lock(BASE_URL, task_id):
        if kind not in {"Actualización", "Avance", "Seguimiento", "Nota", "Cierre"}:
            raise ValueError("Tipo de registro inválido.")
        if date.fromisoformat(entry_date).isoformat() != entry_date:
            raise ValueError("La fecha debe usar AAAA-MM-DD.")
        entry = entry.strip()
        if not entry or len(entry) > 2500:
            raise ValueError("El registro debe contener entre 1 y 2500 caracteres.")
        current = request("GET", f"/api/v1/tasks/{task_id}")
        original = str(current.get("description") or "")
        addition = f"{kind} {entry_date}: {entry}"
        description = original + ("\n\n" if original else "") + addition
        update_task_fields(task_id, {"description": description}, current=current)
        verified = request("GET", f"/api/v1/tasks/{task_id}")
        if int(verified.get("id") or 0) != task_id or verified.get("description") != description:
            raise RuntimeError("Se envió el registro, pero no se pudo verificar su descripción en Vikunja. Revisa antes de reintentar.")
        return {"ok": True, "verified": True, "task": verified}


@mcp.tool()
def pmo_set_dependency(task_id: int, dependency: str) -> dict[str, Any]:
    """Set the structured Dependencia field while preserving the rest of the task description."""
    with task_lock(BASE_URL, task_id):
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
    """Add a dated comment to a task in an active PMO-DSTA line."""
    with task_lock(BASE_URL, task_id):
        current = request("GET", f"/api/v1/tasks/{task_id}")
        if int(current.get("id") or 0) != task_id:
            raise RuntimeError("Vikunja devolvió una tarea distinta; no se agregó el comentario.")
        require_line(int(current.get("project_id") or 0), pmo_projects())
        return request("PUT", f"/api/v1/tasks/{task_id}/comments", json={"comment": comment})


def _label_request(method: str, path: str, payload=None):
    try:
        return request(method, path, **({"json": payload} if payload is not None else {}))
    except httpx.HTTPStatusError as error:
        # Shared label operations distinguish absent labels from failed requests.
        raise HTTPError(path, error.response.status_code, "Vikunja label request failed", {}, None) from error


def _label_operation(action: str, **fields) -> dict[str, Any]:
    result = label_actions.execute({"id": str(uuid.uuid4()), "action": action, **fields},
                                   _label_request, server_url=BASE_URL,
                                   cache_dir=HERMES_ENV.parent / "cache")
    return {"ok": True, "verified": True, **result}


@mcp.tool()
def pmo_list_labels() -> dict[str, Any]:
    """List all native labels (transversal task classifications), including IDs and colors."""
    return {"labels": label_actions.list_all(_label_request, "/api/v1/labels")}


@mcp.tool()
def pmo_list_label_tasks(label_id: int, include_completed: bool = True) -> dict[str, Any]:
    """List tasks classified with one native label in active PMO-DSTA lines."""
    if not any(l["id"] == label_id for l in pmo_list_labels()["labels"]):
        raise ValueError("La etiqueta no existe.")
    tasks = []
    for project in pmo_projects():
        if is_pmo_line(project):
            tasks.extend(t for t in project_tasks(project["id"])
                         if (include_completed or not t.get("done"))
                         and label_id in {l["id"] for l in t.get("labels") or []})
    return {"label_id": label_id, "tasks": tasks}


@mcp.tool()
def pmo_create_label(title: str, hex_color: str = "86e2bb") -> dict[str, Any]:
    """Create a native label. Use a color from the dashboard palette, without #."""
    return _label_operation("create", title=title.strip(), color=hex_color.lstrip("#").lower())


@mcp.tool()
def pmo_update_label(label_id: int, title: str | None = None,
                     hex_color: str | None = None) -> dict[str, Any]:
    """Rename or recolor a native label globally; preserve omitted fields and description."""
    with task_lock(BASE_URL + "/labels-catalog", 1):
        current = label_actions.label_or_none(_label_request, label_id)
        if not current:
            raise ValueError("La etiqueta ya no existe.")
        if title is None and hex_color is None:
            raise ValueError("Indica nombre o color para modificar.")
        return _label_operation("update", labelId=label_id,
                                title=current["title"] if title is None else title.strip(),
                                color=str(current.get("hex_color") or "bac7d5").lstrip("#").lower()
                                if hex_color is None else hex_color.lstrip("#").lower())


@mcp.tool()
def pmo_delete_label(label_id: int) -> dict[str, Any]:
    """Delete any native label globally with backup of its assignments.

    Only use when the user explicitly requests global deletion, not removing it from one task.
    """
    with task_lock(BASE_URL + "/labels-catalog", 1):
        current = label_actions.label_or_none(_label_request, label_id)
        if not current:
            raise ValueError("La etiqueta ya no existe.")
        target = {"id": label_id, "title": current["title"],
                  "hex_color": str(current.get("hex_color") or "bac7d5").lstrip("#").lower()}
        return _label_operation("delete", target=target)


@mcp.tool()
def pmo_edit_task_labels(task_id: int, add_ids: list[int] | None = None,
                         remove_ids: list[int] | None = None,
                         new_title: str = "", hex_color: str = "86e2bb") -> dict[str, Any]:
    """Classify an active PMO task by adding/removing label IDs, preserving other labels.

    Optionally create/reuse new_title and assign it. On failure inspect before retrying:
    multiple requested changes can be partially applied. This does not move the task's LT/TR.
    """
    add, remove = set(add_ids or []), set(remove_ids or [])
    if any(type(i) is not int or i <= 0 for i in add | remove) or add & remove:
        raise ValueError("IDs de etiquetas inválidos o presentes en ambas listas.")
    if not add and not remove and not new_title.strip():
        raise ValueError("Indica etiquetas para agregar o quitar.")
    with task_lock(BASE_URL + "/labels-catalog", 1), task_lock(BASE_URL, task_id):
        current = request("GET", f"/api/v1/tasks/{task_id}")
        if current.get("id") != task_id:
            raise ValueError("Vikunja devolvió una tarea distinta.")
        project = require_line(int(current.get("project_id") or 0), pmo_projects())
        catalog = pmo_list_labels()["labels"]
        if not add.issubset({l["id"] for l in catalog}):
            raise ValueError("Una etiqueta solicitada no existe.")
        if new_title.strip():
            matches = [l for l in catalog if label_actions.normalized(l["title"]) == label_actions.normalized(new_title)]
            if len(matches) > 1:
                raise ValueError("Hay etiquetas con el mismo nombre; usa su ID.")
            if matches and matches[0]["id"] in remove:
                raise ValueError("La nueva etiqueta también se solicitó quitar.")
            label_id = matches[0]["id"] if matches else pmo_create_label(new_title, hex_color)["labelId"]
            add.add(label_id)
        existing = {l["id"] for l in current.get("labels") or []}
        try:
            for label_id in sorted(remove & existing):
                _label_operation("unassign", taskId=task_id, projectId=project["id"], labelId=label_id)
            for label_id in sorted(add - existing):
                _label_operation("assign", taskId=task_id, projectId=project["id"], labelId=label_id)
            verified = request("GET", f"/api/v1/tasks/{task_id}")
            if verified.get("id") != task_id or {l["id"] for l in verified.get("labels") or []} != (existing - remove) | add:
                raise RuntimeError("La clasificación devuelta no coincide.")
        except Exception as error:
            raise RuntimeError("Cambio de etiquetas incompleto o sin confirmar; consulta la tarea antes de reintentar.") from error
        return {"ok": True, "verified": True, "task": verified}


READ_ONLY_TOOLS = {"pmo_list_projects", "pmo_list_tasks", "pmo_open_tasks", "pmo_list_labels", "pmo_list_label_tasks"}


def restrict_to_read_only() -> None:
    """`--read-only` exposes only query tools (used to analyse minutes before any write)."""
    for tool in list(mcp._tool_manager.list_tools()):
        if tool.name not in READ_ONLY_TOOLS:
            mcp.remove_tool(tool.name)


if __name__ == "__main__":
    if "--read-only" in sys.argv:
        restrict_to_read_only()
    mcp.run(transport="stdio")
