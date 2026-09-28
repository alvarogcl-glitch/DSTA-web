"""Granola minutes → PMO-DSTA reconciliation for the dashboard notification inbox.

Every hour the bridge runs Hermes' deterministic export (copy + durable queue) and
analyses each pending minute with a read-only model session. The model returns a
JSON plan; this module executes only the evident, high-confidence actions and keeps
the rest as proposals that the user approves, edits or rejects in the dashboard.
"""
from __future__ import annotations

import importlib.util
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
        "(la fecha y la fuente se agregan solas).\n\n"
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


def parse_plan(output: str) -> dict[str, Any]:
    start, end = output.find("{"), output.rfind("}")
    if start < 0 or end < start:
        raise ValueError("El análisis no devolvió JSON.")
    decoded = json.loads(output[start:end + 1])
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


def with_entry(description: str, heading: str, date: str, note: str, source: str) -> str:
    entry = f"{heading} {date}: {note} (Fuente: {source})"
    return f"{description.rstrip()}\n\n{entry}" if description.strip() else entry


def execute(action: dict[str, Any], minute: dict[str, Any], vk) -> str:
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
    for name, key in (("Responsable", "responsable"), ("Fecha objetivo", "fecha_objetivo"),
                      ("Dependencia", "dependencia")):
        if action[key]:
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


def apply_decision(store: Path, decision: dict[str, Any], vk) -> dict[str, Any]:
    """Execute the user's approvals (with edits) and rejections for one minute."""
    record = get_record(store, str(decision.get("minuteId", "")))
    if not record:
        raise KeyError("La minuta ya no está en la bandeja.")
    by_id = {action["id"]: action for action in record["acciones"]}
    for choice in decision.get("decisions") or []:
        action = by_id.get(str(choice.get("actionId", "")))
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
