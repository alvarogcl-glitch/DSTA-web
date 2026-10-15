"""AI engine per function (CEO, 15-10-2026): Codex direct, Claude Code and Hermes in a configurable order.

`llm_profiles.json` holds, for each function (copilot, minute analysis, inbox instructions, summaries,
handwriting, reminders), the main engine and its fallbacks with their model. `run()` tries them in
order; an engine that fails is skipped for COOLDOWN seconds (same idea as D35). Each caller supplies
how to run each engine in its context (tools, isolation), so this module only decides the order."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

PROFILES_PATH = Path(os.environ.get("DSTA_LLM_PROFILES") or Path(__file__).with_name("llm_profiles.json"))
COOLDOWN = 600
CODEX_TIMEOUT = 600
NAMES = {"codex": "Codex", "claude": "Claude", "hermes": "Hermes"}
_down: dict[tuple, float] = {}
_lock = threading.Lock()
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


class EngineFailed(RuntimeError):
    pass


def profile(name: str) -> list[dict]:
    """Steps of a function's profile; the file is read on each call so a change applies at once."""
    try:
        steps = json.loads(PROFILES_PATH.read_text(encoding="utf-8")).get(name)
    except (OSError, ValueError):
        steps = None
    if not isinstance(steps, list) or not steps:
        raise EngineFailed(f"No hay motores configurados para «{name}».")
    return [step for step in steps if isinstance(step, dict) and step.get("motor") in NAMES]


def label(step: dict) -> str:
    return NAMES[step["motor"]] + (f" ({step['modelo']})" if step.get("modelo") else "")


def run(name: str, engines: dict[str, Callable[[dict], str]], *, clock: Callable[[], float] = time.monotonic,
        state: dict | None = None,
        log: Callable[[str], None] = lambda text: print(text, file=sys.stderr, flush=True)) -> tuple[str, dict, bool]:
    """(answer, step that answered, whether it was a fallback). Engines missing from `engines` are skipped.
    `state` keeps the cooldowns (default: shared by the process)."""
    down = _down if state is None else state
    steps = [step for step in profile(name) if step["motor"] in engines]
    for index, step in enumerate(steps):
        key = (step["motor"], step.get("modelo"))
        with _lock:
            if clock() < down.get(key, 0):
                continue
        try:
            answer = engines[step["motor"]](step)
            if answer and answer.strip():
                return answer, step, index > 0
            raise EngineFailed("respuesta vacía")
        except Exception as error:  # noqa: BLE001 - any engine failure moves on to the next one
            with _lock:
                down[key] = clock() + COOLDOWN
            log(f"{name}: {label(step)} no respondió ({type(error).__name__}); se prueba el siguiente")
    raise EngineFailed(f"Ningún motor configurado pudo responder ({name}).")


def reset() -> None:
    with _lock:
        _down.clear()


def codex_cli() -> str:
    """The Codex desktop app's CLI; its folder changes with each update, so take the newest."""
    configured = os.environ.get("DSTA_CODEX_CLI", "")
    if configured:
        return configured
    found = list(Path(os.environ.get("LOCALAPPDATA", ""), "OpenAI", "Codex", "bin").glob("*/codex.exe"))
    return str(max(found, key=lambda path: path.stat().st_mtime)) if found else ""


def mcp_servers(read_only: bool) -> dict[str, list[str]]:
    """The dashboard's own MCP servers (Vikunja and minutes), the same ones Hermes and Claude use."""
    tools = Path(__file__).resolve().parent
    return {"vikunja-dashboard": [str(tools / "vikunja_dashboard_mcp.py")] + (["--read-only"] if read_only else []),
            "dsta-minutas": [str(tools / "minutas_mcp.py")]}


def ask_codex(prompt: str, model: str, effort: str = "medium", *, mcp: dict[str, list[str]] | None = None,
              timeout: int = CODEX_TIMEOUT, cwd: Path | None = None, run=subprocess.run) -> str:
    """Codex direct (ChatGPT login of the VM), sandboxed read-only: it can only answer or use the MCP tools given."""
    cli = codex_cli()
    if not cli:
        raise EngineFailed("Codex no está instalado en la VM.")
    args = [cli, "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check",
            "--sandbox", "read-only", "-m", model, "-c", f"model_reasoning_effort={effort}"]
    python = sys.executable.replace("\\", "/")
    for name, server_args in (mcp or {}).items():
        args += ["-c", f'mcp_servers.{name}.command="{python}"',
                 "-c", f"mcp_servers.{name}.args={json.dumps([a.replace(chr(92), '/') for a in server_args])}",
                 "-c", f'mcp_servers.{name}.default_tools_approval_mode="approve"']
    if mcp:
        args += ["-c", "approval_policy=never"]
    with tempfile.TemporaryDirectory(prefix="dsta-codex-") as work:
        out_file = Path(work) / "respuesta.txt"
        result = run(args + ["-o", str(out_file), "-"], input=prompt.encode("utf-8"), capture_output=True,
                     cwd=str(cwd or work), timeout=timeout, check=False, creationflags=NO_WINDOW)
        answer = out_file.read_text(encoding="utf-8") if out_file.exists() else ""
    if result.returncode != 0 or not answer.strip():
        raise EngineFailed("Codex no respondió.")
    return answer.strip()
