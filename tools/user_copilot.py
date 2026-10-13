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
from pathlib import Path
from typing import Callable

ACTOR_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
SESSION_ID = re.compile(r"^session_id:\s*(\S+)\s*$", re.MULTILINE)
LISTED_SESSION = re.compile(r"\b(\d{8}_\d{6}_[0-9a-f]{6})\b")
HERMES_TIMEOUT = 180
CLAUDE_TIMEOUT = 150
MAX_CONTEXT_CHARS = 30_000
BACKUP_NOTE = "\n\n— Respondido por Claude (respaldo: Hermes no disponible)."
INSTRUCTIONS = (
    "Eres el copiloto del dashboard DSTA de UNA persona. Responde en español, directo y conciso. "
    "Usa SOLO el contexto de abajo: son sus líneas de trabajo, tareas y minutas. No inventes datos; "
    "si algo no está en el contexto, dilo. No tienes herramientas para modificar nada: si conviene un "
    "cambio, propónlo para que la persona lo aplique desde el dashboard (crear, editar, mover o "
    "completar tareas y líneas). Si propones cambios concretos, al final agrega un bloque\n"
    "```acciones\n[{...}]\n```\ncon como máximo 5 objetos JSON, usando SOLO ids del contexto. Formatos: "
    '{"action":"task.create","projectId":<LT>,"title":"...","description":"...","dueDate":"AAAA-MM-DD"}, '
    '{"action":"task.update","taskId":<id>,"title":"...","description":"...","dueDate":"AAAA-MM-DD"}, '
    '{"action":"task.move","taskId":<id>,"projectId":<LT destino>}, {"action":"complete","taskId":<id>}, '
    '{"action":"lt.create","title":"..."}, {"action":"lt.rename","projectId":<LT>,"title":"..."}, '
    '{"action":"lt.archive","projectId":<LT>}. La persona decide si aplicarlos.')


class CopilotUnavailable(RuntimeError):
    pass


def default_run(args, *, input_text=None, cwd=None, env=None, timeout=None):
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    result = subprocess.run(args, input=input_text, cwd=cwd, env=env, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=timeout, check=False, creationflags=flags)
    return result.returncode, (result.stdout or ""), (result.stderr or "")


def build_prompt(job: dict, snapshot: dict | None, minutes: list[dict]) -> str:
    snapshot = snapshot or {"projects": [], "tasks": []}
    lines = [INSTRUCTIONS, "", "## Líneas de trabajo y tareas"]
    by_project: dict[int, list[dict]] = {}
    for task in snapshot.get("tasks", []):
        by_project.setdefault(task.get("project_id"), []).append(task)
    for project in snapshot.get("projects", []):
        lines.append(f"### {project.get('title', '')} (LT {project.get('id')})")
        for task in by_project.get(project.get("id"), []):
            state = "completada" if task.get("done") else "abierta"
            extra = " · ".join(v for v in (task.get("owner"), task.get("date")) if v)
            lines.append(f"- #{task.get('id')} {task.get('title', '')} [{state}]" + (f" ({extra})" if extra else ""))
            if task.get("description"):
                lines.append("  " + str(task["description"])[:400].replace("\n", " "))
    if minutes:
        lines += ["", "## Minutas recientes"]
        for minute in minutes[:15]:
            lines.append(f"- {minute.get('date', '')} · {minute.get('title', '')}: {str(minute.get('summary', ''))[:600]}")
    if job.get("task"):
        task = job["task"]
        lines += ["", f"## Tarea seleccionada: #{task.get('id')} {task.get('title', '')}"]
    context = "\n".join(lines)[:MAX_CONTEXT_CHARS]
    history = "\n".join(f"{item['role']}: {item['content'][:2000]}" for item in (job.get("history") or [])[-10:])
    return f"{context}\n\n## Conversación\n{history}\nuser: {job.get('message', '')}\n"


PROPOSALS_BLOCK = re.compile(r"```acciones\s*(.*?)```", re.DOTALL)
SCHEMAS = {
    "complete": (("taskId",), ()), "task.create": (("projectId", "title"), ("description", "dueDate")),
    "task.update": (("taskId", "title"), ("description", "dueDate")), "task.move": (("taskId", "projectId"), ()),
    "lt.create": (("title",), ()), "lt.rename": (("projectId", "title"), ()), "lt.archive": (("projectId",), ()),
}
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _valid_proposal(item: dict, snapshot: dict) -> dict | None:
    if not isinstance(item, dict) or item.get("action") not in SCHEMAS:
        return None
    required, optional = SCHEMAS[item["action"]]
    # Models often send empty optional fields ("dueDate": ""): treat them as absent.
    clean = {"action": item["action"], **{k: item[k] for k in required if item.get(k) is not None},
             **{k: item[k] for k in optional if item.get(k) not in (None, "")}}
    if any(k not in clean for k in required):
        return None
    tasks = {t.get("id"): t for t in snapshot.get("tasks", [])}
    projects = {p.get("id") for p in snapshot.get("projects", [])}
    if "taskId" in clean and (type(clean["taskId"]) is not int or clean["taskId"] not in tasks):
        return None
    if "projectId" in clean and (type(clean["projectId"]) is not int or clean["projectId"] not in projects):
        return None
    if "title" in clean and (not isinstance(clean["title"], str) or not clean["title"].strip() or len(clean["title"].strip()) > 250):
        return None
    if "description" in clean and (not isinstance(clean["description"], str) or len(clean["description"]) > 20_000):
        return None
    if "dueDate" in clean and (not isinstance(clean["dueDate"], str) or not DATE.match(clean["dueDate"])):
        return None
    if clean["action"] == "complete" and tasks[clean["taskId"]].get("done"):
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
                 run: Callable = default_run):
        self.hermes_cli, self.hermes_home, self.claude_cli = hermes_cli, hermes_home, claude_cli
        self.work_dir, self.provider, self.model, self.claude_model, self.run = work_dir, provider, model, claude_model, run

    def answer(self, actor: str, user: dict, job: dict, snapshot: dict | None, minutes: list[dict]) -> str:
        if not ACTOR_ID.match(actor or ""):
            raise ValueError("Identificador de usuario inválido")
        provider = (user.get("llm") or {}).get("provider", "ceo-hermes")
        if provider != "ceo-hermes":
            raise CopilotUnavailable("El proveedor de IA configurado para este usuario aún no está disponible.")
        cwd = self.work_dir / actor
        cwd.mkdir(parents=True, exist_ok=True)
        prompt = build_prompt(job, snapshot, minutes)
        reply = self._hermes(actor, prompt, cwd)
        if reply:
            return reply
        reply = self._claude(prompt, cwd)
        if reply:
            return reply + BACKUP_NOTE
        raise CopilotUnavailable("Ni Hermes ni el respaldo Claude pudieron responder.")

    def _hermes(self, actor: str, prompt: str, cwd: Path) -> str:
        env = {**os.environ, "HERMES_HOME": str(self.hermes_home), "PYTHONIOENCODING": "utf-8"}
        args = [self.hermes_cli, "chat", "--quiet", "--source", f"dsta-mu-{actor}", "--ignore-rules", "--ignore-user-config",
                "--provider", self.provider, "--model", self.model, "-t", "todo", "--max-turns", "3", "--query", prompt]
        try:
            code, out, err = self.run(args, cwd=str(cwd), env=env, timeout=HERMES_TIMEOUT)
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


def minutes_for(user: dict) -> list[dict]:
    """Recent Granola summaries kept in the user's vault entry (title, date, summary)."""
    value = user.get("minutes") or []
    return value if isinstance(value, list) else json.loads(value)
