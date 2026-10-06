"""Granola minutes → PMO-DSTA reconciliation for the dashboard notification inbox.

Every hour the bridge runs Hermes' deterministic export (copy + durable queue) and
analyses each pending minute with a read-only model session. The model returns a
JSON plan; this module executes only the evident, high-confidence actions and keeps
the rest as proposals that the user approves, edits or rejects in the dashboard.
"""
from __future__ import annotations

import importlib.util
from contextlib import nullcontext
import json
import os
import re
import subprocess
import sys
import threading
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


# A stable import is essential: this file and MCP can have multiple importlib names.
_tools_dir = str(Path(__file__).resolve().parent)
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)
from task_mutation_lock import task_lock


def mutation_scope(vk):
    return getattr(vk, "BASE_URL", os.environ.get("VIKUNJA_URL", "http://127.0.0.1:3456"))


LOCALAPPDATA = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
SYNC_SCRIPT = LOCALAPPDATA / "hermes" / "scripts" / "granola-pmo-summary-sync.py"
QUEUE_TOOL = LOCALAPPDATA / "hermes" / "scripts" / "granola-pmo-analysis-queue.py"
PMO_ROOT = Path(r"C:\Users\admin\.openclaw\workspace\proyectos\pmo-dsta")
REPORTS = PMO_ROOT / "04_reportes" / "granola-reconciliation-reports"
MINUTES_DIR = PMO_ROOT / "Minutas 2026"
CREATION_FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

OPERATIONS = {"actualizar", "comentar", "completar", "crear", "mover"}
AUTO_OPERATIONS = {"actualizar", "comentar", "completar", "crear"}
EDITABLE_FIELDS = {"task_id", "project_id", "titulo", "nota", "responsable", "fecha_objetivo",
                   "dependencia", "criterio_cierre"}
DATE_RE = re.compile(r"^20\d{2}-\d{2}-\d{2}$")
MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
          "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}

_store_lock = threading.Lock()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def iso_meeting_date(value: str) -> str:
    match = re.search(r"\b([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s+(20\d{2})", value or "")
    if not match or match.group(1).lower() not in MONTHS:
        return ""
    return f"{match.group(3)}-{MONTHS[match.group(1).lower()]:02d}-{int(match.group(2)):02d}"


def slug(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", folded).strip("-")[:90]


# ── Local store: the VM keeps the source of truth; the Worker only mirrors it. ──

def load_store(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"minutes": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def save_record(path: Path, record: dict[str, Any]) -> None:
    with _store_lock:
        store = load_store(path)
        store["minutes"][record["id"]] = record
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")


def get_record(path: Path, record_id: str) -> dict[str, Any] | None:
    with _store_lock:
        return load_store(path)["minutes"].get(record_id)


# ── Hermes export and durable queue (same scripts as the nightly Hermes cron). ──

def run_sync(hermes_home: Path) -> dict[str, Any]:
    env = {**os.environ, "HERMES_HOME": str(hermes_home), "PYTHONIOENCODING": "utf-8"}
    result = subprocess.run([sys.executable, str(SYNC_SCRIPT)], cwd=str(PMO_ROOT), env=env,
                            capture_output=True, text=True, encoding="utf-8", errors="replace",
                            creationflags=CREATION_FLAGS, timeout=600, check=False)
    lines = [line for line in (result.stdout or "").splitlines() if line.startswith("{")]
    manifest = json.loads(lines[-1]) if lines else {}
    if result.returncode != 0 or manifest.get("status") != "ok":
        raise RuntimeError(f"La exportación de Granola falló: {manifest.get('error') or manifest.get('errors') or result.returncode}")
    return manifest


QUEUE_PATH = PMO_ROOT / "04_reportes" / "granola-reconciliation-queue.json"


def pending_items() -> list[dict[str, Any]]:
    """Read the durable queue directly: the exporter's stdout garbles accented file names
    (its child process decodes with the Windows code page)."""
    if not QUEUE_PATH.exists():
        return []
    items = json.loads(QUEUE_PATH.read_text(encoding="utf-8")).get("items", {}).values()
    return [item for item in items if item.get("status") in {"pending_review", "failed"}]


def mark_queue(item: dict[str, Any], status: str, report: str) -> None:
    subprocess.run([sys.executable, str(QUEUE_TOOL), "mark", "--source-id", item["source_id"],
                    "--digest", item["digest"], "--status", status, "--report", report],
                   capture_output=True, text=True, creationflags=CREATION_FLAGS, timeout=60, check=True)


# ── Analysis ──

def minute_ref(item: dict[str, Any]) -> tuple[str, str]:
    """ID for the dsta-minutas MCP (the copy in Minutas 2026) and the meeting title."""
    path = Path(item["file"])
    copy = MINUTES_DIR / path.name
    source = copy if copy.exists() else path
    text = source.read_text(encoding="utf-8", errors="replace")
    title = next((line[2:].strip() for line in text.splitlines() if line.startswith("# ")), path.stem)
    return f"{MINUTES_DIR.name}/{path.name}", title


def analysis_prompt(minute_id: str, title: str, meeting_date: str) -> str:
    return (
        "Eres el analista PMO-DSTA que reconcilia minutas de Granola con Vikunja. Responde en español. "
        f"Lee la minuta «{title}» ({meeting_date}) con minutas_leer usando el id exacto `{minute_id}`. "
        "Consulta las líneas y tareas abiertas con pmo_open_tasks; Vikunja es la fuente oficial y la minuta "
        "es evidencia de cambios. Solo puedes leer: no intentes modificar nada.\n\n"
        "Extrae hechos, decisiones, avances, bloqueos, responsables, fechas, dependencias y cierres "
        "(no solo 'Próximos pasos'). Para cada cambio propone una acción:\n"
        "- actualizar: registrar avance en una tarea existente (task_id) y opcionalmente responsable, "
        "fecha_objetivo (YYYY-MM-DD) o dependencia.\n"
        "- comentar: dejar un antecedente breve (sin cambio de estado) en una tarea existente.\n"
        "- completar: cerrar una tarea existente cuyo resultado la minuta declara terminado.\n"
        "- crear: nueva tarea en una línea (project_id) con titulo accionable.\n"
        "- mover: cambiar una tarea de línea.\n"
        "Marca evidente=true y confianza=alta SOLO si la minuta lo dice de forma explícita, la tarea o "
        "línea es inequívoca y no hay conflicto de alcance: p. ej. un avance concreto sobre una tarea "
        "identificable, un cierre declarado sin pendientes, o un compromiso nuevo con línea clara que no "
        "existe ya en Vikunja. Si hay dudas de destino, duplicado, alcance, dueño o si una tarea debería "
        "dividirse o fusionarse, usa evidente=false para que Álvaro decida. Nunca inventes dueños, "
        "fechas, cierres ni destinos. Excluye datos confidenciales y comentarios sin acción verificable "
        "(ponlos en antecedentes si aportan contexto). Si la reunión no tiene relación con PMO-DSTA, no "
        "propongas acciones.\n\n"
        "Redacta cada nota como texto final para la bitácora, sin prefijos de fecha ni «Minuta …» "
        "(la fecha y la fuente se agregan solas). Sé concreto: máximo 15 acciones, nota de hasta 300 "
        "caracteres, evidencia de hasta 160 y sin comillas dobles dentro de los textos.\n\n"
        "Responde SOLO con JSON válido, sin texto adicional, con esta forma:\n"
        '{"resumen":"2-3 frases","acciones":[{"tipo":"actualizar","evidente":true,"confianza":"alta",'
        '"task_id":63,"project_id":null,"titulo":"","nota":"avance a registrar","responsable":"",'
        '"fecha_objetivo":"","dependencia":"","criterio_cierre":"","evidencia":"cita literal breve",'
        '"motivo":"por qué"}],"antecedentes":["..."]}'
    )


RETRY_NOTE = ("\n\nIMPORTANTE: el intento anterior no fue JSON válido. Devuelve únicamente JSON válido, "
              "escapa las comillas dobles dentro de los textos (o usa comillas simples) y limita la "
              "evidencia a una cita breve.")


def text_field(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def int_or_none(value: Any) -> int | None:
    try:
        return int(value) if value not in (None, "", 0, "0") else None
    except (TypeError, ValueError):
        return None


def normalize_action(raw: dict[str, Any], index: int) -> dict[str, Any] | None:
    operation = str(raw.get("tipo", "")).strip().lower()
    if operation not in OPERATIONS:
        return None
    date = text_field(raw.get("fecha_objetivo"), 10)
    return {
        "id": f"a{index}",
        "tipo": operation,
        "evidente": raw.get("evidente") is True,
        "confianza": text_field(raw.get("confianza"), 10).lower() or "baja",
        "task_id": int_or_none(raw.get("task_id")),
        "project_id": int_or_none(raw.get("project_id")),
        "titulo": text_field(raw.get("titulo"), 200),
        "nota": text_field(raw.get("nota"), 1500),
        "responsable": text_field(raw.get("responsable"), 120),
        "fecha_objetivo": date if DATE_RE.match(date) else "",
        "dependencia": text_field(raw.get("dependencia"), 300),
        "criterio_cierre": text_field(raw.get("criterio_cierre"), 300),
        "evidencia": text_field(raw.get("evidencia"), 600),
        "motivo": text_field(raw.get("motivo"), 400),
        "estado": "propuesta",
        "resultado": "",
    }


def loads_lenient(text: str) -> Any:
    """json.loads that escapes stray double quotes inside strings (e.g. quoted phrases in evidence)."""
    for _ in range(200):
        try:
            return json.loads(text)
        except json.JSONDecodeError as error:
            quote = text.rfind('"', 0, error.pos)
            if "delimiter" not in error.msg or quote <= 0 or text[quote - 1] == "\\":
                raise
            text = text[:quote] + '\\"' + text[quote + 1:]
    raise ValueError("No se pudo reparar el JSON del análisis.")


def parse_plan(output: str) -> dict[str, Any]:
    start, end = output.find("{"), output.rfind("}")
    if start < 0 or end < start:
        raise ValueError("El análisis no devolvió JSON.")
    decoded = loads_lenient(output[start:end + 1])
    actions = [normalize_action(item, index + 1) for index, item in enumerate(decoded.get("acciones") or [])
               if isinstance(item, dict)]
    return {
        "resumen": text_field(decoded.get("resumen"), 800),
        "acciones": [action for action in actions if action][:25],
        "antecedentes": [text_field(item, 400) for item in (decoded.get("antecedentes") or [])
                         if isinstance(item, str)][:15],
    }


def is_evident(action: dict[str, Any]) -> bool:
    if not (action["evidente"] and action["confianza"] == "alta" and action["tipo"] in AUTO_OPERATIONS):
        return False
    if action["tipo"] == "crear":
        return bool(action["project_id"] and action["titulo"])
    return bool(action["task_id"] and (action["nota"] or action["tipo"] == "completar"))


# ── Vikunja writes (through the verified helpers of the dashboard MCP) ──

def load_vikunja():
    path = Path(__file__).with_name("vikunja_dashboard_mcp.py")
    spec = importlib.util.spec_from_file_location("dsta_vikunja_writer", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def set_field(description: str, name: str, value: str) -> str:
    lines = description.replace("\r", "").split("\n")
    for index, line in enumerate(lines):
        if line.lower().startswith(name.lower() + ":"):
            lines[index] = f"{name}: {value}"
            return "\n".join(lines)
    return f"{name}: {value}\n" + "\n".join(lines)


def field_value(description: str, name: str) -> str | None:
    for line in description.replace("\r", "").split("\n"):
        if line.lower().startswith(name.lower() + ":"):
            return line.split(":", 1)[1].strip()
    return None


def without_line(description: str, name: str) -> str:
    return "\n".join(line for line in description.replace("\r", "").split("\n")
                     if not line.lower().startswith(name.lower() + ":"))


def with_entry(description: str, heading: str, date: str, note: str, source: str) -> str:
    entry = f"{heading} {date}: {note} (Fuente: {source})"
    return f"{description.rstrip()}\n\n{entry}" if description.strip() else entry


def execute(action: dict[str, Any], minute: dict[str, Any], vk) -> str:
    """Lock existing tasks before reading source fields, never while awaiting AI."""
    task_id = action.get("task_id") if action.get("tipo") != "crear" else None
    with task_lock(mutation_scope(vk), task_id) if task_id else nullcontext():
        return _execute_locked(action, minute, vk)


def _execute_locked(action: dict[str, Any], minute: dict[str, Any], vk) -> str:
    """Apply one action in Vikunja, read it back and return a short confirmation."""
    date = minute.get("fecha") or datetime.now().strftime("%Y-%m-%d")
    source = f"Granola {minute['sourceId']} · {minute['titulo']}"
    operation = action["tipo"]
    if operation == "crear":
        projects = vk.pmo_projects()
        if not any(int(project.get("id") or 0) == action["project_id"] and vk.is_pmo_line(project) for project in projects):
            raise ValueError("La línea indicada no es una línea activa de PMO-DSTA.")
        wanted = slug(action["titulo"])
        for task in vk.project_tasks(action["project_id"]):
            if not task.get("done") and slug(task.get("title", "")) == wanted:
                raise ValueError(f"Ya existe una tarea abierta con ese título (#{task['id']}).")
        created = vk.pmo_create_task(
            project_id=action["project_id"], title=action["titulo"],
            description=f"Registro inicial {date}: {action['nota']}" if action["nota"] else "",
            owner=action["responsable"], target_date=action["fecha_objetivo"],
            dependency=action["dependencia"], closure_criterion=action["criterio_cierre"],
            source=f"Granola {minute['sourceId']}",
            action_key=f"granola-{minute['sourceId']}-{wanted}",
        )
        action["creada_id"] = created["task"]["id"]
        return f"Creada #{created['task']['id']} · {action['titulo']}"

    task_id = action["task_id"]
    if not task_id:
        raise ValueError("Falta la tarea de destino.")
    current = vk.request("GET", f"/api/v1/tasks/{task_id}")
    if operation == "mover":
        if not action["project_id"]:
            raise ValueError("Falta la línea de destino.")
        vk.pmo_move_task(task_id, action["project_id"])
        return f"Movida #{task_id} a la línea {action['project_id']}"

    description = str(current.get("description") or "")
    # What this action changes is remembered so an instruction can undo it later.
    action["antes"] = {"campos": {}, "done": bool(current.get("done")), "title": current.get("title", "")}
    for name, key in (("Responsable", "responsable"), ("Fecha objetivo", "fecha_objetivo"),
                      ("Dependencia", "dependencia")):
        if action[key]:
            action["antes"]["campos"][name] = field_value(description, name)
            description = set_field(description, name, action[key])
    # Notes go to the description log (not Vikunja comments) so the dashboard shows them.
    heading = {"completar": "Cierre", "comentar": "Nota"}.get(operation, "Actualización")
    if action["nota"]:
        description = with_entry(description, heading, date, action["nota"], source)
    changes: dict[str, Any] = {"description": description}
    if action["titulo"] and operation == "actualizar":
        changes["title"] = action["titulo"]
    if operation == "completar":
        changes["done"] = True
    vk.update_task_fields(task_id, changes, current=current)
    verified = vk.request("GET", f"/api/v1/tasks/{task_id}")
    if str(verified.get("description") or "") != description or (operation == "completar" and not verified.get("done")):
        raise RuntimeError("Vikunja no confirmó el cambio al releer la tarea.")
    verb = {"completar": "Completada", "comentar": "Nota registrada en"}.get(operation, "Actualizada")
    return f"{verb} #{task_id} · {verified.get('title', '')}"


def apply_action(action: dict[str, Any], minute: dict[str, Any], vk) -> None:
    try:
        action["resultado"] = execute(action, minute, vk)
        action["estado"] = "aplicada"
    except Exception as error:  # the error is shown to the user next to the action
        action["resultado"] = f"No se aplicó: {error}"[:400]
        action["estado"] = "error"


def undo(action: dict[str, Any], minute: dict[str, Any], vk) -> str:
    """Keep undo's authoritative read/build/write in the same task transaction."""
    created = re.match(r"Creada #(\d+)", action.get("resultado") or "")
    task_id = action.get("creada_id") or (int(created.group(1)) if action.get("tipo") == "crear" and created else action.get("task_id"))
    with task_lock(mutation_scope(vk), task_id) if task_id else nullcontext():
        return _undo_locked(action, minute, vk)


def _undo_locked(action: dict[str, Any], minute: dict[str, Any], vk) -> str:
    """Revert what this minute's action did: delete the task it created, or remove its log
    entries and restore the fields, title and state it changed."""
    source = f"Granola {minute['sourceId']}"
    created = re.match(r"Creada #(\d+)", action.get("resultado") or "")
    if action.get("tipo") == "crear" and not action.get("creada_id") and created:
        action["creada_id"] = int(created.group(1))  # records made before creada_id was stored
    if action.get("creada_id"):
        task_id = action["creada_id"]
        task = vk.request("GET", f"/api/v1/tasks/{task_id}")
        if f"granola-{minute['sourceId']}" not in str(task.get("description") or ""):
            raise ValueError(f"#{task_id} no fue creada por esta minuta; no se elimina.")
        vk.request("DELETE", f"/api/v1/tasks/{task_id}")
        action["creada_id"] = None
        return f"Eliminada #{task_id} (creada por esta minuta)"
    task_id = action.get("task_id")
    if not task_id or action["estado"] != "aplicada":
        raise ValueError("Esta acción no modificó ninguna tarea que deshacer.")
    if action["tipo"] == "mover":
        raise ValueError("Para revertir un movimiento, indica a qué línea volver.")
    current = vk.request("GET", f"/api/v1/tasks/{task_id}")
    lines = str(current.get("description") or "").replace("\r", "").split("\n")
    description = "\n".join(line for line in lines if f"(Fuente: {source}" not in line).rstrip()
    before = action.get("antes") or {}
    for name, value in (before.get("campos") or {}).items():
        description = set_field(description, name, value) if value is not None else without_line(description, name)
    changes: dict[str, Any] = {"description": description}
    if before.get("title") and current.get("title") != before["title"]:
        changes["title"] = before["title"]
    if "done" in before and bool(current.get("done")) != before["done"]:
        changes["done"] = before["done"]
    vk.update_task_fields(task_id, changes, current=current)
    return f"Deshecho en #{task_id} lo registrado por esta minuta"


def instruction_prompt(minute: dict[str, Any], action: dict[str, Any], instruction: str) -> str:
    done = {key: action.get(key) for key in ("tipo", "task_id", "creada_id", "project_id", "titulo", "nota",
                                              "responsable", "fecha_objetivo", "dependencia", "estado", "resultado")}
    state = "ya se aplicó automáticamente" if action.get("auto") else "es una propuesta aún no aplicada"
    return (
        "Eres el analista PMO-DSTA. Álvaro dio una instrucción sobre una acción derivada de la minuta "
        f"«{minute['titulo']}» ({minute.get('fecha', '')}), id `{minute['minuta']}` en dsta-minutas. "
        f"La acción {state}:\n{json.dumps(done, ensure_ascii=False)}\n\n"
        f"Instrucción de Álvaro: «{instruction}»\n\n"
        "Traduce la instrucción en operaciones. Puedes leer la minuta (minutas_leer) y las tareas "
        "(pmo_open_tasks); no modifiques nada tú mismo. Operaciones posibles: actualizar, comentar, "
        "completar, crear, mover (mismos campos que en el análisis: task_id, project_id, titulo, nota, "
        "responsable, fecha_objetivo AAAA-MM-DD, dependencia, criterio_cierre) y deshacer, que revierte "
        "lo que esta acción ya hizo (elimina la tarea que creó, quita su nota, restaura campos y estado). "
        "Para «elimina»/«borra»/«no correspondía» sobre algo ya aplicado usa deshacer. Para corregir algo ya "
        "aplicado, usa deshacer y luego la operación correcta. Si la instrucción es descartar una propuesta, "
        "no devuelvas operaciones. No inventes datos que la instrucción o la minuta no den.\n\n"
        'Responde SOLO JSON: {"resumen":"qué harás en una frase","operaciones":[{"tipo":"deshacer"},'
        '{"tipo":"crear","project_id":4,"titulo":"...","nota":"...","responsable":"Nelson","fecha_objetivo":"2026-10-15"}]}'
    )


def apply_instruction(action: dict[str, Any], minute: dict[str, Any], instruction: str,
                      ask_model: Callable[[str], str], vk) -> None:
    prompt = instruction_prompt(minute, action, instruction)
    try:
        decoded = loads_lenient(extract_json(ask_model(prompt)))
    except ValueError:
        decoded = loads_lenient(extract_json(ask_model(prompt + RETRY_NOTE)))
    results, failed = [], False
    for index, raw in enumerate(decoded.get("operaciones") or []):
        if not isinstance(raw, dict):
            continue
        try:
            if str(raw.get("tipo", "")).lower() == "deshacer":
                results.append(undo(action, minute, vk))
                continue
            operation = normalize_action(raw, index + 1)
            if not operation:
                continue
            results.append(execute(operation, minute, vk))
            if operation.get("creada_id") and not action.get("creada_id"):
                action["creada_id"] = operation["creada_id"]  # later instructions can undo it too
        except Exception as error:
            failed = True
            results.append(f"No se aplicó: {error}"[:300])
    summary = "; ".join(results) or "Sin cambios en Vikunja"
    action.setdefault("instrucciones", []).append({"texto": instruction[:1500], "resultado": summary[:800], "fecha": now()})
    if not action.get("auto"):
        action["estado"] = "error" if failed else ("aplicada" if results else "rechazada")
        action["resultado"] = summary[:400] if results else "Descartada según tu instrucción"
    else:
        action["resultado"] = f"{action['resultado']} → Instrucción: {summary}"[:600]


def extract_json(output: str) -> str:
    start, end = output.find("{"), output.rfind("}")
    if start < 0 or end < start:
        raise ValueError("El modelo no devolvió JSON.")
    return output[start:end + 1]


# ── Record lifecycle ──

def record_status(record: dict[str, Any]) -> str:
    return "por_revisar" if any(a["estado"] in {"propuesta", "error"} and not a.get("auto")
                                for a in record["acciones"]) else "procesada"


def write_report(record: dict[str, Any]) -> str:
    REPORTS.mkdir(parents=True, exist_ok=True)
    path = REPORTS / f"{record['sourceId']}-{record['digest']}.md"
    section = lambda title, items: f"## {title}\n\n" + ("\n".join(items) if items else "- (sin elementos)") + "\n"
    describe = lambda a: (f"- [{a['tipo']}] {('#' + str(a['task_id'])) if a['task_id'] else ''} "
                          f"{a['titulo'] or a['nota'][:120]} — {a['estado']}: {a['resultado'] or a['motivo']}"
                          f"\n  Evidencia: {a['evidencia']}")
    body = (f"# Reconciliación Granola · {record['titulo']} ({record['fecha']})\n\n"
            f"Fuente: {record['sourceId']} · hash {record['digest']}\n\n{record['resumen']}\n\n"
            + section("Actualizadas automáticamente", [describe(a) for a in record["acciones"] if a.get("auto")])
            + section("Propuestas para decisión", [describe(a) for a in record["acciones"] if not a.get("auto")])
            + section("Antecedentes", [f"- {item}" for item in record["antecedentes"]]))
    path.write_text(body, encoding="utf-8")
    return str(path)


def process_item(item: dict[str, Any], ask_model: Callable[[str], str], vk, store: Path) -> dict[str, Any]:
    minute_id, title = minute_ref(item)
    date = iso_meeting_date(item.get("meeting_date", ""))
    prompt = analysis_prompt(minute_id, title, item.get("meeting_date", ""))
    try:
        plan = parse_plan(ask_model(prompt))
    except ValueError:  # includes JSONDecodeError: long plans occasionally break quoting
        plan = parse_plan(ask_model(prompt + RETRY_NOTE))
    record = {
        "id": item["source_id"], "sourceId": item["source_id"], "digest": item["digest"],
        "titulo": title, "fecha": date, "minuta": minute_id, "detectadaEn": now(),
        "resumen": plan["resumen"], "antecedentes": plan["antecedentes"], "acciones": plan["acciones"],
        "vista": False,
    }
    for action in record["acciones"]:
        if is_evident(action):
            action["auto"] = True
            apply_action(action, record, vk)
            if action["estado"] == "error":
                action["auto"] = False  # a failed automatic action goes back to the user as a proposal
    record["estado"] = record_status(record)
    record["actualizadaEn"] = now()
    save_record(store, record)
    report = write_report(record)
    mark_queue(item, "awaiting_user" if record["estado"] == "por_revisar" else "processed", report)
    return record


def apply_decision(store: Path, decision: dict[str, Any], vk,
                   ask_model: Callable[[str], str] | None = None) -> dict[str, Any]:
    """Execute the user's approvals, rejections and free-text instructions for one minute."""
    record = get_record(store, str(decision.get("minuteId", "")))
    if not record:
        raise KeyError("La minuta ya no está en la bandeja.")
    by_id = {action["id"]: action for action in record["acciones"]}
    for choice in decision.get("decisions") or []:
        action = by_id.get(str(choice.get("actionId", "")))
        instruction = text_field(choice.get("instruccion"), 1500)
        if action and choice.get("decision") == "instruccion" and instruction and ask_model:
            # Instructions also work on actions already applied automatically.
            apply_instruction(action, record, instruction, ask_model, vk)
            continue
        if not action or action.get("auto") or action["estado"] not in {"propuesta", "error"}:
            continue
        if choice.get("decision") == "rechazar":
            action["estado"], action["resultado"] = "rechazada", "Rechazada por Álvaro"
            continue
        if choice.get("decision") != "aprobar":
            continue
        for key, value in (choice.get("edits") or {}).items():
            if key in {"task_id", "project_id"}:
                action[key] = int_or_none(value)
            elif key in EDITABLE_FIELDS:
                action[key] = text_field(value, 1500)
        if action["fecha_objetivo"] and not DATE_RE.match(action["fecha_objetivo"]):
            action["fecha_objetivo"] = ""
        apply_action(action, record, vk)
    record["estado"] = record_status(record)
    record["actualizadaEn"] = now()
    save_record(store, record)
    report = write_report(record)
    if record["estado"] == "procesada":
        mark_queue({"source_id": record["sourceId"], "digest": record["digest"]}, "processed", report)
    return record
