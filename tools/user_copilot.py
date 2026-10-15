"""F5: per-user Copilot on the CEO's accounts (Hermes primary, Claude backup), isolated.

Isolation by construction, not by instruction:
- Hermes runs with --ignore-rules (no SOUL.md, memory or preloaded skills) and
  --ignore-user-config (no config.yaml: no MCP servers holding the CEO's Vikunja token, no
  fallback providers, so never Ollama), with only the harmless "todo" toolset (no terminal,
  files, web, cronjob or MCP). Its session is deleted right after the answer.
- Claude runs with no tools (--tools ""), no MCP (--strict-mcp-config) and no session
  persistence, in a per-user empty working directory (no project memory).
- The model sees only a context the bridge builds from THIS user's snapshot and minutes.
Read-only: the Copilot answers and proposes; changes go through the F3 actions in the UI.

Per-user LLM profile (vault "llm"): only "ceo-hermes" (default) is supported today; a user's own
API key provider will plug in here later.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from typing import Callable

ACTOR_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
SESSION_ID = re.compile(r"^session_id:\s*(\S+)\s*$", re.MULTILINE)
LISTED_SESSION = re.compile(r"\b(\d{8}_\d{6}_[0-9a-f]{6})\b")
HERMES_TIMEOUT = 180
CLAUDE_TIMEOUT = 150
HERMES_COOLDOWN = 600  # D35: seconds on Claude after a Hermes failure, as in production
MINUTE_LINK = re.compile(r"\]\(minuta:([^)\n]{1,200})\)")
MAX_CONTEXT_CHARS = 200_000  # the whole portfolio fits: long prompts reach every engine via stdin (E14)
BACKUP_NOTE = "\n\n— Respondido por Claude (respaldo: Hermes no disponible)."
INSTRUCTIONS = (
    "Eres el copiloto del dashboard DSTA de UNA persona. Responde en español, directo y conciso. "
    "Usa SOLO el contexto de abajo: son sus líneas de trabajo, tareas y minutas. No inventes datos; "
    "si algo no está en el contexto, dilo. Las tareas se muestran como «#N (id X)»: al hablar con la persona usa #N; "
    "en el bloque de acciones usa SIEMPRE el id X. No tienes herramientas para modificar nada: los cambios se "
    "aplican desde el dashboard (crear, editar, mover o completar tareas y líneas). Si la persona PIDE "
    "explícitamente un cambio (\"crea…\", \"mueve…\", \"completa…\"), marca ese objeto con \"ejecutar\": true "
    "y el dashboard lo aplicará por sí solo; lo que sugieras por iniciativa propia va SIN esa marca para "
    "que la persona decida. Si propones o ejecutas cambios concretos, al final agrega un bloque\n"
    "```acciones\n[{...}]\n```\ncon como máximo 5 objetos JSON, usando SOLO ids del contexto. Formatos: "
    '{"action":"task.create","projectId":<LT>,"title":"...","owner":"responsable","dueDate":"AAAA-MM-DD",'
    '"dependency":"...","criterion":"criterio de cierre","description":"..."}, '
    '{"action":"task.update","taskId":<id>,"title":"...","owner":"...","dueDate":"AAAA-MM-DD",'
    '"dependency":"...","criterion":"...","detail":"nuevo texto del detalle, sin metadatos ni bitácora"} '
    '(la bitácora no se edita ni se borra), '
    '{"action":"task.move","taskId":<id>,"projectId":<LT destino>}, {"action":"complete","taskId":<id>}, {"action":"task.reopen","taskId":<id completada>}, '
    '{"action":"lt.create","title":"..."}, {"action":"lt.rename","projectId":<LT>,"title":"..."}, '
    '{"action":"lt.describe","projectId":<LT>,"description":"..."}, '
    '{"action":"lt.archive","projectId":<LT>} (solo sin tareas abiertas), {"action":"lt.restore","projectId":<LT archivada>}, '
    '{"action":"lt.merge","projectId":<LT origen>,"targetProjectId":<LT destino>} (mueve todas sus tareas y archiva el origen), '
    '{"action":"label.assign","taskId":<id>,"labelId":<id etiqueta>}, {"action":"label.unassign","taskId":<id>,"labelId":<id etiqueta>}. '
    'Omite los campos que no sepas. Pedido explícito, por ejemplo: '
    '{"action":"complete","taskId":<id>,"ejecutar": true}.')


class CopilotUnavailable(RuntimeError):
    pass


def default_run(args, *, input_text=None, cwd=None, env=None, timeout=None):
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    result = subprocess.run(args, input=input_text, cwd=cwd, env=env, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=timeout, check=False, creationflags=flags)
    return result.returncode, (result.stdout or ""), (result.stderr or "")


def build_prompt(job: dict, snapshot: dict | None, minutes: list[dict]) -> str:
    """D28: open tasks go in full (by priority); completed ones and minutes are summarized, and the
    model is told when something did not fit. D29: creation date in Chile time. D30: labels."""
    snapshot = snapshot or {"projects": [], "tasks": []}
    labels = {label.get("id"): label.get("title", "") for label in snapshot.get("labels") or []}
    by_project: dict[int, list[dict]] = {}
    for task in snapshot.get("tasks", []):
        by_project.setdefault(task.get("project_id"), []).append(task)

    def head(task: dict) -> str:
        extra = " · ".join(v for v in (task.get("owner") and f"responsable {task['owner']}", task.get("date") and f"fecha {task['date']}",
                                        task.get("created") and f"creada {local_date(task['created'])}") if v)
        names = [labels[i] for i in task.get("label_ids") or [] if i in labels]
        tags = f" · etiquetas: {', '.join(names)}" if names else ""
        return f"- {task_label(task)} {task.get('title', '')}" + (f" ({extra})" if extra else "") + tags

    essential = [INSTRUCTIONS, "", f"Hoy es {today_local()} (hora de Chile).", "", "## Líneas de trabajo y tareas abiertas"]
    if job.get("task"):
        task = job["task"]
        known = next((t for t in snapshot.get("tasks", []) if t.get("id") == task.get("id")), task)
        essential[4:4] = [f"## Tarea seleccionada: {task_label(known)} {task.get('title', '')}", ""]
    for project in snapshot.get("projects", []):
        essential.append(f"### {project.get('title', '')} (LT {project.get('id')})")
        if project.get("description"):
            essential.append(f"Descripción de la línea: {project['description']}")
        for task in (t for t in by_project.get(project.get("id"), []) if not t.get("done")):
            essential.append(head(task))
            if task.get("description"):
                essential.append("  " + str(task["description"])[:4000].replace("\n", "\n  "))
    secondary = []
    if labels:
        secondary.append(["", "## Etiquetas disponibles"] + [f"- {title} (id {i})" for i, title in labels.items()])
    if snapshot.get("archivedProjects"):
        secondary.append(["", "## Líneas archivadas (se pueden restaurar)"] +
                         [f"- {p.get('title', '')} (LT {p.get('id')})" for p in snapshot["archivedProjects"]])
    if minutes:
        # D31/D32: recent minutes plus older ones found for this question; cite them by id.
        def minute_line(m: dict) -> str:
            cite = f" [cítala como [{m.get('title', '')}](minuta:{m['id']})]" if m.get("id") else ""
            size = 1500 if m.get("found") else 600
            kind = " (minuta manual)" if m.get("source") == "Manual" else ""
            return f"- {m.get('date', '')} · {m.get('title', '')}{kind}{cite}: {str(m.get('summary', ''))[:size]}"
        recent = [m for m in minutes if not m.get("found")]
        found = [m for m in minutes if m.get("found")]
        secondary.append(["", "## Minutas recientes"] + [minute_line(m) for m in recent[:25]] +
                         (["", "## Minutas anteriores relacionadas con la pregunta"] + [minute_line(m) for m in found[:5]] if found else []))
    done = [t for t in snapshot.get("tasks", []) if t.get("done")]
    if done:
        secondary.append(["", "## Tareas completadas (resumen)"] +
                         [head(t) + f" [LT {t.get('project_id')}]" + (f": {str(t['description'])[:300]}".replace("\n", " ") if t.get("description") else "")
                          for t in done])
    context = "\n".join(essential)
    omitted = 0
    if len(context) > MAX_CONTEXT_CHARS:
        context, omitted = context[:MAX_CONTEXT_CHARS], 1
    for section in secondary:
        text = "\n".join(section)
        if len(context) + len(text) <= MAX_CONTEXT_CHARS:
            context += "\n" + text
        else:
            omitted += 1
    if omitted:
        context += ("\n\n[Aviso: parte del contexto no cupo por tamaño. Si te preguntan algo que no aparece arriba, "
                    "dilo explícitamente en vez de suponer.]")
    history = "\n".join(f"{item['role']}: {item['content'][:2000]}" for item in (job.get("history") or [])[-10:])
    return f"{context}\n\n## Conversación\n{history}\nuser: {job.get('message', '')}\n"


PROPOSALS_BLOCK = re.compile(r"```acciones\s*(.*?)```", re.DOTALL)
SCHEMAS = {
    "complete": (("taskId",), ()),
    "task.create": (("projectId", "title"), ("description", "dueDate", "owner", "dependency", "criterion")),
    # D06-A: an edit replaces only the detail; metadata goes in its fields and the log is append-only.
    "task.update": (("taskId", "title"), ("detail", "dueDate", "owner", "dependency", "criterion")),
    "task.move": (("taskId", "projectId"), ()), "task.reopen": (("taskId",), ()),
    "lt.create": (("title",), ()), "lt.describe": (("projectId", "description"), ()), "lt.rename": (("projectId", "title"), ()), "lt.archive": (("projectId",), ()),
    # D27 restore an archived line; D26 merge like production (move every task, archive the empty source).
    "lt.restore": (("projectId",), ()), "lt.merge": (("projectId", "targetProjectId"), ()),
    # D30: labels from the chat, one task and one existing label at a time.
    "label.assign": (("taskId", "labelId"), ()), "label.unassign": (("taskId", "labelId"), ()),
}
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


CHILE = ZoneInfo("America/Santiago")


def local_date(value: str) -> str:
    """Vikunja timestamp → date in Chile (D29: "today"/"yesterday" follow Santiago, not UTC)."""
    try:
        return datetime.fromisoformat(str(value)).astimezone(CHILE).date().isoformat()
    except ValueError:
        return str(value)[:10]


def today_local() -> str:
    return datetime.now(CHILE).date().isoformat()


def task_label(task: dict) -> str:
    """E12: the person's own number (#N) plus the real Vikunja id the actions need."""
    # Without own numbering (the owner) #N and the id are the same number: say so, never leave it ambiguous.
    return f"#{task['num']} (id {task.get('id')})" if task.get("num") else f"#{task.get('id')} (id {task.get('id')})"


def line_key(title) -> str:
    """Same normalization as structure_actions.line_key (case, accents and spaces ignored)."""
    text = unicodedata.normalize("NFKD", str(title or ""))
    return " ".join("".join(c for c in text if not unicodedata.combining(c)).lower().split())


def _valid_proposal(item: dict, snapshot: dict) -> dict | None:
    if not isinstance(item, dict) or item.get("action") not in SCHEMAS:
        return None
    required, optional = SCHEMAS[item["action"]]
    if item["action"] == "task.update" and not item.get("title"):
        # "change only the date/owner…": the edit keeps the current title (the queue needs one).
        current = next((t for t in snapshot.get("tasks", []) if t.get("id") == item.get("taskId")), None)
        if current and current.get("title"):
            item = {**item, "title": current["title"]}
    # Models often send empty optional fields ("dueDate": ""): treat them as absent.
    clean = {"action": item["action"], **{k: item[k] for k in required if item.get(k) is not None},
             **{k: item[k] for k in optional if item.get(k) not in (None, "")}}
    if any(k not in clean for k in required):
        return None
    tasks = {t.get("id"): t for t in snapshot.get("tasks", [])}
    projects = {p.get("id") for p in snapshot.get("projects", [])}
    archived = {p.get("id"): p for p in snapshot.get("archivedProjects") or []}
    labels = {label.get("id") for label in snapshot.get("labels") or []}
    if "taskId" in clean and (type(clean["taskId"]) is not int or clean["taskId"] not in tasks):
        return None
    scope = archived if clean["action"] == "lt.restore" else projects
    if "projectId" in clean and (type(clean["projectId"]) is not int or clean["projectId"] not in scope):
        return None
    if "targetProjectId" in clean and (type(clean["targetProjectId"]) is not int or clean["targetProjectId"] not in projects
                                       or clean["targetProjectId"] == clean["projectId"]):
        return None
    if "labelId" in clean:
        current = tasks[clean["taskId"]].get("label_ids") or []
        if type(clean["labelId"]) is not int or clean["labelId"] not in labels or \
                (clean["labelId"] in current) == (clean["action"] == "label.assign"):
            return None
    if clean["action"] == "lt.restore" and any(line_key(p.get("title")) == line_key(archived[clean["projectId"]].get("title"))
                                               for p in snapshot.get("projects", [])):
        return None
    if "title" in clean and (not isinstance(clean["title"], str) or not clean["title"].strip() or len(clean["title"].strip()) > 250):
        return None
    if any(k in clean and (not isinstance(clean[k], str) or len(clean[k]) > 20_000) for k in ("description", "detail")):
        return None
    if "dueDate" in clean and (not isinstance(clean["dueDate"], str) or not DATE.match(clean["dueDate"])):
        return None
    if any(k in clean and (not isinstance(clean[k], str) or len(clean[k].strip()) > 300) for k in ("owner", "dependency", "criterion")):
        return None
    # D03: an explicit request runs by itself through the verified action queue.
    if item.get("ejecutar") is True or item.get("execute") is True:
        clean["execute"] = True
    if clean["action"] == "complete" and tasks[clean["taskId"]].get("done"):
        return None
    if clean["action"] == "task.reopen" and not tasks[clean["taskId"]].get("done"):
        return None
    # D24/D25: same rules as the dashboard buttons.
    if clean["action"] in ("lt.create", "lt.rename") and any(
            p.get("id") != clean.get("projectId") and line_key(p.get("title")) == line_key(clean["title"])
            for p in snapshot.get("projects", [])):
        return None
    if clean["action"] == "lt.archive" and any(
            t.get("project_id") == clean["projectId"] and not t.get("done") for t in tasks.values()):
        return None
    if clean["action"] == "task.move" and tasks[clean["taskId"]].get("project_id") == clean["projectId"]:
        return None
    return clean


def split_proposals(reply: str, snapshot: dict | None) -> tuple[str, list[dict]]:
    """Strip the ```acciones block from the reply and keep only valid, applicable proposals (max 5)."""
    match = PROPOSALS_BLOCK.search(reply or "")
    if not match:
        return (reply or "").strip(), []
    text = (reply[:match.start()] + reply[match.end():]).strip()
    try:
        items = json.loads(match.group(1).strip())
    except ValueError:
        return text, []
    proposals = []
    for item in items if isinstance(items, list) else []:
        valid = _valid_proposal(item, snapshot or {})
        if valid and valid not in proposals:
            proposals.append(valid)
        if len(proposals) == 5:
            break
    return text, proposals


def clean(text: str) -> str:
    text = SESSION_ID.sub("", text or "")
    text = re.sub(r"<think(?:ing)?>.*?</think(?:ing)?>", "", text, flags=re.DOTALL | re.IGNORECASE)
    return re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", text).strip()


class UserCopilot:
    def __init__(self, *, hermes_cli: str, hermes_home: Path, claude_cli: str, work_dir: Path,
                 provider: str = "openai-codex", model: str = "gpt-6-luna", claude_model: str = "sonnet",
                 run: Callable = default_run, clock: Callable[[], float] = time.monotonic):
        self.hermes_cli, self.hermes_home, self.claude_cli = hermes_cli, hermes_home, claude_cli
        self.work_dir, self.provider, self.model, self.claude_model, self.run = work_dir, provider, model, claude_model, run
        self.clock, self.hermes_down_until = clock, 0.0

    def answer(self, actor: str, user: dict, job: dict, snapshot: dict | None, minutes: list[dict]) -> str:
        return self.ask(actor, user, build_prompt(job, snapshot, minutes))

    def ask(self, actor: str, user: dict, prompt: str) -> str:
        """Any prompt (chat or minute analysis) on the same isolated Hermes → Claude chain."""
        if not ACTOR_ID.match(actor or ""):
            raise ValueError("Identificador de usuario inválido")
        provider = (user.get("llm") or {}).get("provider", "ceo-hermes")
        if provider != "ceo-hermes":
            raise CopilotUnavailable("El proveedor de IA configurado para este usuario aún no está disponible.")
        cwd = self.work_dir / actor
        cwd.mkdir(parents=True, exist_ok=True)
        # D35: like production, after a Hermes failure go straight to Claude for 10 minutes.
        if self.clock() >= self.hermes_down_until:
            reply = self._hermes(actor, prompt, cwd)
            if reply:
                return reply
            self.hermes_down_until = self.clock() + HERMES_COOLDOWN
        reply = self._claude(prompt, cwd)
        if reply:
            return reply + BACKUP_NOTE
        raise CopilotUnavailable("Ni Hermes ni el respaldo Claude pudieron responder.")

    def _hermes(self, actor: str, prompt: str, cwd: Path) -> str:
        env = {**os.environ, "HERMES_HOME": str(self.hermes_home), "PYTHONIOENCODING": "utf-8"}
        args = [self.hermes_cli, "chat", "--quiet", "--source", f"dsta-mu-{actor}", "--ignore-rules", "--ignore-user-config",
                "--provider", self.provider, "--model", self.model, "-t", "todo", "--max-turns", "3", "--query", prompt]
        try:
            from hermes_prompt_transport import prepare_query
            args, query_input = prepare_query(args)
            code, out, err = self.run(args, cwd=str(cwd), env=env, timeout=HERMES_TIMEOUT,
                                      **({'input_text': query_input} if query_input is not None else {}))
        except (OSError, subprocess.TimeoutExpired):
            code, out, err = 1, "", ""
        finally:
            self.purge_sessions(actor, cwd, env)
        if code != 0 or "Fallback activated" in (out or "") + (err or ""):
            return ""
        return clean(out)[:20_000]

    def purge_sessions(self, actor: str, cwd: Path, env: dict) -> int:
        """Another user's conversation must not stay in the CEO's Hermes history: delete every
        session tagged with this user's source (also covers runs that crashed mid-way)."""
        deleted = 0
        try:
            _, out, err = self.run([self.hermes_cli, "sessions", "list", "--source", f"dsta-mu-{actor}"],
                                   cwd=str(cwd), env=env, timeout=30)
            for session in sorted(set(LISTED_SESSION.findall((out or "") + (err or "")))):
                self.run([self.hermes_cli, "sessions", "delete", "--yes", session], cwd=str(cwd), env=env, timeout=30)
                deleted += 1
        except (OSError, subprocess.TimeoutExpired):
            pass
        return deleted

    def _claude(self, prompt: str, cwd: Path) -> str:
        if not self.claude_cli:
            return ""
        args = [self.claude_cli, "-p", "--strict-mcp-config", "--tools", "", "--no-session-persistence",
                "--model", self.claude_model, "--output-format", "text"]
        try:
            code, out, _ = self.run(args, input_text=prompt, cwd=str(cwd), env=dict(os.environ), timeout=CLAUDE_TIMEOUT)
        except (OSError, subprocess.TimeoutExpired):
            return ""
        return clean(out)[:20_000] if code == 0 else ""


def _stored(user: dict, key: str) -> list[dict]:
    value = user.get(key) or []
    return value if isinstance(value, list) else json.loads(value)


WORD = re.compile(r"[a-z0-9]{4,}")


def _words(text: str) -> set[str]:
    return set(WORD.findall(line_key(text)))


def _manual(manual: list[dict] | None) -> list[dict]:
    """Manual minutes of the dashboard (typed or handwritten) in the copilot's minute shape."""
    return [{"id": m["id"], "title": m["titulo"], "date": m["fecha"], "summary": m["contenido"], "source": "Manual",
             "draft": m.get("borrador", "")} for m in (manual or [])]


def minutes_for(user: dict, query: str = "", manual: list[dict] | None = None) -> list[dict]:
    """The user's 15 most recent Granola summaries plus (D31) up to 5 older ones from THEIR archive
    that best match the question. Never another user's minutes: both lists live in this vault entry.
    Their manual minutes (up to 10 recent, plus older matches) are included too."""
    manual = _manual(manual)
    recent = sorted(_stored(user, "minutes")[:15] + manual[:10], key=lambda m: str(m.get("date") or ""), reverse=True)
    seen = {m.get("id") for m in recent if m.get("id")} | {(m.get("title"), m.get("date")) for m in recent}
    wanted = _words(query)
    if not wanted:
        return recent
    scored = []
    for minute in _stored(user, "minuteArchive") + manual[10:]:
        if minute.get("id") in seen or (minute.get("title"), minute.get("date")) in seen:
            continue
        title_hits = len(wanted & _words(minute.get("title", "")))
        hits = len(wanted & _words(minute.get("summary", ""))) + 2 * title_hits
        if hits:
            scored.append((hits, str(minute.get("date") or ""), minute))
    found = [{**m, "found": True} for _, _, m in sorted(scored, key=lambda item: (item[0], item[1]), reverse=True)[:5]]
    return recent + found


def cited_minutes(user: dict, reply: str, manual: list[dict] | None = None) -> dict[str, dict]:
    """D32: text of the user's minutes the copilot linked as [título](minuta:<id>), for the chat viewer."""
    by_id = {m["id"]: m for m in _stored(user, "minuteArchive") + _stored(user, "minutes") + _manual(manual) if m.get("id")}
    cited: dict[str, dict] = {}
    for minute_id in MINUTE_LINK.findall(reply or ""):
        minute = by_id.get(minute_id.strip())
        if minute and minute_id.strip() not in cited and len(cited) < 5:
            cited[minute_id.strip()] = {"titulo": minute.get("title", ""), "fecha": minute.get("date", ""),
                                        "contenido": str(minute.get("summary") or ""),
                                        "origen": "Manual (dashboard)" if minute.get("source") == "Manual" else "Granola",
                                        "borrador": minute.get("draft", "")}
    return cited
