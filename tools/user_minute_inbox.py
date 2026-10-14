"""Per-user Granola minutes inbox, same behaviour as the CEO's dashboard (tools/minute_inbox.py).

Each new minute is analysed by the user's isolated Copilot with the same rules as production
(parse_plan, is_evident, the same action types and fields); evident high-confidence actions are
applied automatically and the rest stay as proposals; the user approves, edits, rejects, gives
free-text instructions (including undo) or discards the minute. Differences, all for isolation:
- no MCP tools: the minute text and the user's open tasks go in the prompt;
- writes go through a separate vikunja_dashboard_mcp module instance whose TOKEN, BASE_URL and
  root are the user's (never the CEO's .env);
- state lives in <users_dir>/<actor>/minute-inbox.json on the VM; no reports or queue in the CEO's
  PMO folders. Private notes stay on the VM (only title, date, summary and actions reach the Worker).
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any, Callable

_tools_dir = str(Path(__file__).resolve().parent)
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)
import minute_inbox as mi  # noqa: E402
from granola_user import inbox_record  # noqa: E402

ACTOR_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
_module_lock = threading.Lock()
_store_lock = threading.Lock()


def user_vk(user: dict):
    """A private vikunja_dashboard_mcp instance bound to the user's Vikunja URL, token and root.
    Loaded with a temporary environment (no CEO .env); the process environment is restored."""
    with _module_lock:
        saved = {key: os.environ.get(key) for key in ("HERMES_HOME", "VIKUNJA_API_TOKEN", "VIKUNJA_URL", "DSTA_ROOT_PROJECT_ID")}
        empty_home = tempfile.mkdtemp(prefix="dsta-vk-")
        try:
            os.environ.update(HERMES_HOME=empty_home, VIKUNJA_API_TOKEN=user["vikunjaToken"],
                              VIKUNJA_URL=user.get("vikunjaUrl", "http://127.0.0.1:3456"),
                              DSTA_ROOT_PROJECT_ID=str(user["rootProjectId"]))
            spec = importlib.util.spec_from_file_location(f"dsta_vk_user_{uuid.uuid4().hex}", Path(_tools_dir) / "vikunja_dashboard_mcp.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
    # Belt and braces: every request reads these module globals at call time.
    module.TOKEN = user["vikunjaToken"]
    module.BASE_URL = user.get("vikunjaUrl", "http://127.0.0.1:3456").rstrip("/")
    module.PMO_ROOT_PROJECT_ID = int(user["rootProjectId"])
    if module.TOKEN != user["vikunjaToken"]:
        raise RuntimeError("No se pudo aislar la credencial de Vikunja del usuario")
    return module


TASKS_BLOCK_CHARS = 50_000


def _tasks_block(snapshot: dict | None) -> str:
    """D42: same context as the copilot (D28): open tasks with their full structured description
    (dependency, closure criterion, log) and completed ones in short, so the analyst neither duplicates
    what was already done nor misses the dependency a meeting resolves."""
    snapshot = snapshot or {}
    lines = []
    open_tasks = [t for t in snapshot.get("tasks", []) if not t.get("done")]
    for project in snapshot.get("projects", []):
        lines.append(f"Línea «{project.get('title', '')}» (project_id {project.get('id')}):")
        if project.get("description"):
            lines.append(f"  Descripción de la línea: {project['description']}")
        for task in (t for t in open_tasks if t.get("project_id") == project.get("id")):
            extra = " · ".join(str(v) for v in (task.get("owner"), task.get("date")) if v)
            lines.append(f"  - #{task.get('id')} {task.get('title', '')}" + (f" ({extra})" if extra else ""))
            if task.get("description"):
                lines.append("    " + str(task["description"])[:4000].replace("\n", "\n    "))
    text = "\n".join(lines) or "(sin líneas de trabajo todavía)"
    done = [t for t in snapshot.get("tasks", []) if t.get("done")]
    if done:
        closed = "\n".join(["", "Tareas ya completadas (no proponer rehacerlas):"] +
                           [f"  - #{t.get('id')} {t.get('title', '')} [project_id {t.get('project_id')}]" +
                            (f": {str(t['description'])[:300]}".replace("\n", " ") if t.get("description") else "") for t in done])
        if len(text) + len(closed) <= TASKS_BLOCK_CHARS:
            text += closed
    if len(text) > TASKS_BLOCK_CHARS:
        text = text[:TASKS_BLOCK_CHARS] + "\n[Aviso: el contexto se recortó por tamaño; ante la duda, propone en vez de aplicar.]"
    return text


def _minute_block(minute: dict) -> str:
    return (f"Minuta «{minute.get('title') or minute.get('titulo', '')}» ({minute.get('date') or minute.get('fecha', '')})\n"
            f"Resumen:\n{minute.get('summary', '')}\n\nNotas:\n{minute.get('private_notes', '')}")


def analysis_prompt(minute: dict, snapshot: dict | None) -> str:
    rules = mi.analysis_prompt("x", "x", "x")
    rules = rules[rules.index("Extrae hechos"):]
    rules = (rules.replace("Si la reunión no tiene relación con PMO-DSTA", "Si la reunión no tiene relación con sus líneas de trabajo")
             .replace("Álvaro", "la persona"))
    return ("Eres el analista que reconcilia las minutas de Granola de UNA persona con sus líneas de trabajo y tareas "
            "en Vikunja. Responde en español. No tienes herramientas: usa SOLO el contexto de abajo; Vikunja es la fuente "
            "oficial y la minuta es evidencia de cambios.\n\n"
            f"## Tareas abiertas por línea\n{_tasks_block(snapshot)}\n\n## {_minute_block(minute)}\n\n{rules}")


def scope_actions(actions: list[dict], snapshot: dict | None) -> None:
    """Minutes often cite task numbers of other portfolios (e.g. "#63"). Only the user's own tasks
    and lines are valid targets; anything else becomes a proposal asking for the right target."""
    snapshot = snapshot or {}
    task_ids = {t.get("id") for t in snapshot.get("tasks", [])}
    project_ids = {p.get("id") for p in snapshot.get("projects", [])}
    for action in actions:
        missing = []
        if action.get("task_id") is not None and action["task_id"] not in task_ids:
            missing.append(f"la tarea #{action['task_id']}")
            action["task_id"] = None
        if action.get("project_id") is not None and action["project_id"] not in project_ids:
            missing.append(f"la línea {action['project_id']}")
            action["project_id"] = None
        if missing:
            action["evidente"] = False
            action["motivo"] = (f"La minuta menciona {' y '.join(missing)}, que no existe en tu espacio: "
                                "indica la tarea o línea correcta antes de aprobar.")[:400]


INSTRUCTION_NOTE = ("\n\nAdemás del JSON indicado, incluye la clave \"descartar\": true SOLO si la instrucción pide "
                    "descartar o no realizar esta acción; en cualquier otro caso false. Si no puedes cumplir la "
                    "instrucción (por ejemplo, la línea o tarea indicada no existe en el contexto), devuelve "
                    "operaciones vacías, descartar=false y explica el motivo en resumen.")


def apply_user_instruction(action: dict, record: dict, instruction: str, ask: Callable[[str], str], vk,
                           context: str, apply_ops: Callable = None) -> None:
    """Production instruction semantics, except that an instruction that could not be carried out
    never silently discards the proposal: it stays visible with the reason (estado 'error')."""
    prompt = context + mi.instruction_prompt(record, action, instruction).replace("Álvaro", "la persona") + INSTRUCTION_NOTE
    try:
        decoded = mi.loads_lenient(mi.extract_json(ask(prompt)))
    except ValueError:
        decoded = mi.loads_lenient(mi.extract_json(ask(prompt + mi.RETRY_NOTE)))
    operations = [op for op in (decoded.get("operaciones") or []) if isinstance(op, dict)]
    summary = mi.text_field(decoded.get("resumen"), 400)
    if operations:
        mi.apply_instruction(action, record, instruction, lambda _prompt: json.dumps(decoded, ensure_ascii=False), vk)
        return
    action.setdefault("instrucciones", []).append({"texto": instruction[:1500], "resultado": summary or "Sin cambios", "fecha": mi.now()})
    if decoded.get("descartar") is True and not action.get("auto"):
        action["estado"], action["resultado"] = "rechazada", "Descartada según tu instrucción"
    elif not action.get("auto"):
        action["estado"] = "error"
        action["resultado"] = f"No se aplicó tu instrucción: {summary or 'no se pudo interpretar'}"[:400]
    else:
        action["resultado"] = f"{action['resultado']} → Instrucción sin cambios: {summary}"[:600]


def public_record(record: dict) -> dict:
    """What the Worker inbox receives (no minute text / private notes)."""
    return {key: value for key, value in record.items() if key not in ("texto",)}


class UserMinuteInbox:
    def __init__(self, users_dir: Path, *, vk_factory: Callable[[dict], Any] = user_vk,
                 apply: Callable[[dict, dict, Any], None] = mi.apply_action):
        self.users_dir, self.vk_factory, self.apply = Path(users_dir), vk_factory, apply

    def _store(self, actor: str) -> Path:
        if not ACTOR_ID.match(actor or ""):
            raise ValueError("Identificador de usuario inválido")
        path = self.users_dir / actor / "minute-inbox.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def _get(self, actor: str, record_id: str) -> dict | None:
        with _store_lock:
            return mi.get_record(self._store(actor), record_id)

    def _save(self, actor: str, record: dict) -> None:
        with _store_lock:
            mi.save_record(self._store(actor), record)

    def is_current(self, actor: str, minute: dict) -> bool:
        record = self._get(actor, inbox_record(minute)["id"])
        return bool(record and (record.get("descartadaEn") or record.get("digest") == str(minute["version"])[:64]))

    def process(self, actor: str, user: dict, minute: dict, snapshot: dict | None, ask: Callable[[str], str]) -> dict | None:
        """Analyse one imported Granola minute like production; None if already current or discarded."""
        base = inbox_record(minute)
        previous = self._get(actor, base["id"])
        if previous and (previous.get("descartadaEn") or previous.get("digest") == base["digest"]):
            return None
        prompt = analysis_prompt(minute, snapshot)
        try:
            plan = mi.parse_plan(ask(prompt))
        except ValueError:
            plan = mi.parse_plan(ask(prompt + mi.RETRY_NOTE))
        record = {**base, "minuta": base["sourceId"], "detectadaEn": mi.now(), "resumen": plan["resumen"] or base["resumen"],
                  "antecedentes": plan["antecedentes"], "acciones": plan["acciones"], "vista": False,
                  "texto": _minute_block(minute)}
        scope_actions(record["acciones"], snapshot)
        vk = self.vk_factory(user) if any(mi.is_evident(a) for a in record["acciones"]) else None
        for action in record["acciones"]:
            if mi.is_evident(action):
                action["auto"] = True
                self.apply(action, record, vk)
                if action["estado"] == "error":
                    action["auto"] = False  # a failed automatic action goes back as a proposal
        record["estado"] = mi.record_status(record)
        record["actualizadaEn"] = mi.now()
        self._save(actor, record)
        return record

    def decide(self, actor: str, user: dict, decision: dict, snapshot: dict | None,
               ask: Callable[[str], str] | None = None) -> dict:
        """Same decisions as production (approve with edits, reject, instruction, discard)."""
        record = self._get(actor, str(decision.get("minuteId", "")))
        if not record:
            raise KeyError("La minuta ya no está en la bandeja.")
        if decision.get("decision") == "descartar":
            if not record.get("descartadaEn"):
                record["descartadaEn"] = mi.now()
                for action in record["acciones"]:
                    if not action.get("auto") and action["estado"] in {"propuesta", "error"}:
                        action["estado"], action["resultado"] = "rechazada", "Minuta descartada: no realizar acciones."
            record.update(estado="descartada", vista=True, actualizadaEn=mi.now())
            self._save(actor, record)
            return record
        if record.get("descartadaEn"):
            raise ValueError("Esta minuta ya fue descartada.")
        vk = None
        by_id = {action["id"]: action for action in record["acciones"]}
        for choice in decision.get("decisions") or []:
            action = by_id.get(str(choice.get("actionId", "")))
            instruction = mi.text_field(choice.get("instruccion"), 1500)
            if action and choice.get("decision") == "instruccion" and instruction and ask:
                vk = vk or self.vk_factory(user)
                context = (f"Contexto (no tienes herramientas, usa solo esto):\n## Tareas abiertas por línea\n"
                           f"{_tasks_block(snapshot)}\n\n## {record.get('texto', '')}\n\n")
                apply_user_instruction(action, record, instruction, ask, vk, context)
                continue
            if not action or action.get("auto") or action["estado"] not in {"propuesta", "error"}:
                continue
            if choice.get("decision") == "rechazar":
                action["estado"], action["resultado"] = "rechazada", "Rechazada"
                continue
            if choice.get("decision") != "aprobar":
                continue
            for key, value in (choice.get("edits") or {}).items():
                if key in {"task_id", "project_id"}:
                    action[key] = mi.int_or_none(value)
                elif key in mi.EDITABLE_FIELDS:
                    action[key] = mi.text_field(value, 1500)
            if action["fecha_objetivo"] and not mi.DATE_RE.match(action["fecha_objetivo"]):
                action["fecha_objetivo"] = ""
            vk = vk or self.vk_factory(user)
            self.apply(action, record, vk)
        record["estado"] = mi.record_status(record)
        record["actualizadaEn"] = mi.now()
        self._save(actor, record)
        return record
