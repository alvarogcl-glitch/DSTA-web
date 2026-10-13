"""F3: structure actions on Vikunja (work lines and tasks) executed by the bridge.

Every action stays inside the current user's root project (user_context.root_project_id): the
work line must be a direct, active child of that root. Updates re-read the whole object and send
it back complete, because Vikunja clears omitted fields on partial updates. Creations record the
created id under the request id, so a retried delivery returns the same object instead of
creating a duplicate. Returns the ids the Worker uses to verify the post-write snapshot.
"""
from __future__ import annotations

import json
import re
import sys
from contextlib import nullcontext
from pathlib import Path
from typing import Callable
from urllib.error import HTTPError

_tools_dir = str(Path(__file__).resolve().parent)
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)
from user_context import root_project_id  # noqa: E402

TASK_FIELDS = (
    "id", "title", "description", "project_id", "done", "due_date", "reminders", "repeat_after",
    "repeat_mode", "priority", "start_date", "end_date", "assignees", "hex_color", "percent_done",
    "cover_image_attachment_id", "is_favorite",
)
PROJECT_FIELDS = ("id", "title", "description", "parent_project_id", "is_archived", "hex_color", "identifier",
                  "position", "is_favorite", "background_blur_hash", "background_information")
NO_DUE_DATE = "0001-01-01T00:00:00Z"
ACTIONS = {"task.create", "task.update", "task.move", "task.reopen", "task.log", "lt.create", "lt.rename", "lt.archive"}
LOG_KINDS = {"Actualización", "Avance", "Seguimiento", "Nota", "Cierre"}


def _read(request: Callable, path: str) -> dict:
    try:
        value = request("GET", path)
    except (HTTPError, ValueError) as error:
        raise ValueError("Elemento inexistente o fuera de alcance") from error
    if not isinstance(value, dict):
        raise ValueError("Respuesta inválida de Vikunja")
    return value


def _root(request: Callable) -> int:
    root_id = root_project_id()
    root = _read(request, f"/api/v1/projects/{root_id}")
    if root.get("id") != root_id or root.get("is_archived") is not False:
        raise ValueError("La raíz del usuario no está activa")
    return root_id


def _work_line(request: Callable, project_id: int) -> dict:
    root_id = _root(request)
    if type(project_id) is not int or project_id == root_id:
        raise ValueError("No es una línea de trabajo")
    project = _read(request, f"/api/v1/projects/{project_id}")
    if project.get("id") != project_id or project.get("parent_project_id") != root_id or project.get("is_archived") is not False:
        raise ValueError("La línea no pertenece a la raíz activa del usuario")
    return project


def _task(request: Callable, task_id: int, project_id: int) -> dict:
    task = _read(request, f"/api/v1/tasks/{task_id}")
    if task.get("id") != task_id or task.get("project_id") != project_id:
        raise ValueError("La tarea cambió de alcance")
    _work_line(request, project_id)
    if any(field not in task for field in TASK_FIELDS):
        raise ValueError("No se pueden preservar todos los campos de la tarea")
    return task


STRUCTURED_FIELDS = (("owner", "Responsable"), ("dueDate", "Fecha objetivo"), ("dependency", "Dependencia"),
                     ("criterion", "Criterio de cierre"))
SOURCES = {"form": ("DSTA Dashboard Formulario", "FORM"), "copilot": ("DSTA Dashboard Copilot", "COPILOT")}


def structured_description(job: dict) -> str:
    """Same layout as vikunja_dashboard_mcp.structured_task_description (production creation)."""
    source, key = SOURCES.get(job.get("origin"), ("DSTA Dashboard", "DASHBOARD"))
    fields = [(label, str(job.get(name) or "").strip()) for name, label in STRUCTURED_FIELDS]
    fields += [("SOURCE", source), ("ACTION_KEY", f"DSTA-{key}-{job['id']}")]
    metadata = "\n".join(f"{label}: {value or 'Por confirmar'}" for label, value in fields)
    detail = str(job.get("description") or "").strip()
    return f"{metadata}\n\n{detail}" if detail else metadata


METADATA_LABELS = {label.lower() for _, label in STRUCTURED_FIELDS} | {"source", "action_key"}
LOG_ENTRY = re.compile(r"^(?:%s) \d{4}-\d{2}-\d{2}: " % "|".join(sorted(LOG_KINDS)))


def split_description(description: str) -> tuple[str, str, str]:
    """D06: (metadata block, editable detail, append-only log) of a structured description."""
    paragraphs = [p for p in str(description or "").replace("\r", "").split("\n\n")]
    meta = ""
    first = [line for line in paragraphs[0].split("\n") if line.strip()] if paragraphs else []
    if first and all(":" in line for line in first) and any(line.split(":", 1)[0].strip().lower() in METADATA_LABELS for line in first):
        meta = paragraphs.pop(0)
    log_start = len(paragraphs)
    while log_start > 0 and LOG_ENTRY.match(paragraphs[log_start - 1].lstrip()):
        log_start -= 1
    detail = "\n\n".join(paragraphs[:log_start]).strip()
    return meta, detail, "\n\n".join(paragraphs[log_start:])


def replace_detail(description: str, detail: str) -> str:
    """Change only the detail; metadata and log stay exactly as they were."""
    meta, _, log = split_description(description)
    return "\n\n".join(part for part in (meta, str(detail or "").strip(), log) if part)


def set_metadata(description: str, label: str, value: str) -> str:
    """Replace 'label: …' in the metadata block (or add it there), keeping everything else."""
    lines = description.replace("\r", "").split("\n")
    value = value.strip() or "Por confirmar"
    for index, line in enumerate(lines):
        if not line.strip():
            break
        if line.lower().startswith(label.lower() + ":"):
            lines[index] = f"{label}: {value}"
            return "\n".join(lines)
    head = 0
    while head < len(lines) and lines[head].strip() and ":" in lines[head]:
        head += 1
    if head == 0:
        return f"{label}: {value}\n\n{description}" if description else f"{label}: {value}"
    lines.insert(head, f"{label}: {value}")
    return "\n".join(lines)


def _due(value: str) -> str:
    return f"{value}T12:00:00Z" if value else NO_DUE_DATE


def _remembered(cache_dir: Path | None, request_id: str, create: Callable[[], dict]) -> dict:
    record = cache_dir / "structure-created" / f"{request_id}.json" if cache_dir else None
    if record and record.exists():
        return json.loads(record.read_text(encoding="utf-8"))
    result = create()
    if record:
        record.parent.mkdir(parents=True, exist_ok=True)
        record.write_text(json.dumps(result), encoding="utf-8")
    return result


def execute(job: dict, request: Callable, *, cache_dir: Path | None = None, server_url: str = "",
            lock: Callable | None = None) -> dict:
    action = job.get("action")
    if job.get("kind") != "action" or action not in ACTIONS:
        raise ValueError("Acción de estructura inválida")
    lock = lock or (lambda *_: nullcontext())
    title = str(job.get("title") or "").strip()

    if action == "task.create":
        def create() -> dict:
            _work_line(request, job["projectId"])
            payload = {"title": title, "description": structured_description(job)}
            if job.get("dueDate"):
                payload["due_date"] = _due(job["dueDate"])
            created = request("PUT", f"/api/v1/projects/{job['projectId']}/tasks", payload=payload)
            if not isinstance(created, dict) or created.get("project_id") != job["projectId"]:
                raise RuntimeError("Vikunja no confirmó la tarea creada")
            return {"taskId": created["id"]}
        return _remembered(cache_dir, job["id"], create)

    if action == "task.log":
        kind = job.get("logKind") or "Actualización"
        entry = str(job.get("entry") or "").strip()
        if kind not in LOG_KINDS or not entry or len(entry) > 2500 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(job.get("entryDate", ""))):
            raise ValueError("Registro inválido")
        task_id = job["taskId"]
        line = f"{kind} {job['entryDate']}: {entry}"
        # D18: one entry per request. A request already applied returns its result; a request
        # whose write may have happened before a crash (pending marker) is not appended again
        # when its line is already the last entry. A NEW request with the same text is written.
        done = cache_dir / "structure-created" / f"{job['id']}.json" if cache_dir else None
        pending = cache_dir / "structure-pending" / f"{job['id']}" if cache_dir else None
        if done and done.exists():
            return json.loads(done.read_text(encoding="utf-8"))
        with lock(server_url, task_id):
            current = _task(request, task_id, job["sourceProjectId"])
            original = str(current.get("description") or "")
            already = pending is not None and pending.exists() and original.rstrip().endswith(line)
            if not already:
                if pending:
                    pending.parent.mkdir(parents=True, exist_ok=True)
                    pending.write_text("", encoding="utf-8")
                payload = {field: current[field] for field in TASK_FIELDS}
                payload["description"] = original + ("\n\n" if original else "") + line
                written = request("POST", f"/api/v1/tasks/{task_id}", payload=payload)
                if not isinstance(written, dict) or written.get("id") != task_id:
                    raise RuntimeError("Vikunja no confirmó el registro")
        result = {"taskId": task_id}
        if done:
            done.parent.mkdir(parents=True, exist_ok=True)
            done.write_text(json.dumps(result), encoding="utf-8")
            pending.unlink(missing_ok=True)
        return result

    if action in ("task.update", "task.move", "task.reopen"):
        task_id = job["taskId"]
        with lock(server_url, task_id):
            current = _task(request, task_id, job["sourceProjectId"])
            payload = {field: current[field] for field in TASK_FIELDS}
            if action == "task.update":
                payload["title"] = title
                if job.get("detail") is not None:
                    payload["description"] = replace_detail(str(payload.get("description") or ""), job["detail"])
                if job.get("dueDate") is not None:
                    payload["due_date"] = _due(job["dueDate"])
                for name, label in STRUCTURED_FIELDS:
                    if job.get(name) is not None:  # D05: "Fecha objetivo" follows the native date
                        payload["description"] = set_metadata(str(payload.get("description") or ""), label, job[name])
            elif action == "task.reopen":  # D14: back to pending, everything else preserved
                payload["done"] = False
            else:
                _work_line(request, job["projectId"])
                payload["project_id"] = job["projectId"]
            written = request("POST", f"/api/v1/tasks/{task_id}", payload=payload)
            if not isinstance(written, dict) or written.get("id") != task_id:
                raise RuntimeError("Vikunja no confirmó la tarea")
        return {"taskId": task_id}

    if action == "lt.create":
        def create() -> dict:
            root_id = _root(request)
            created = request("PUT", "/api/v1/projects", payload={"title": title, "parent_project_id": root_id})
            if not isinstance(created, dict) or created.get("parent_project_id") != root_id:
                raise RuntimeError("Vikunja no confirmó la línea creada")
            return {"projectId": created["id"]}
        return _remembered(cache_dir, job["id"], create)

    project = _work_line(request, job["projectId"])
    payload = {field: project[field] for field in PROJECT_FIELDS if field in project}
    if action == "lt.rename":
        payload["title"] = title
    else:
        payload["is_archived"] = True
    written = request("POST", f"/api/v1/projects/{job['projectId']}", payload=payload)
    if not isinstance(written, dict) or written.get("id") != job["projectId"]:
        raise RuntimeError("Vikunja no confirmó la línea")
    return {"projectId": job["projectId"]}
