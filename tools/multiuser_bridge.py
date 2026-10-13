#!/usr/bin/env python3
"""Multiuser bridge (AUTH_MODE=accounts): outbound-only, like the single-user bridge.

One dispatcher poll (/api/bridge/dispatch) tells which users have pending work. For each of
them the bridge polls that user's queues under /u/<actor>/api/bridge/..., and runs every job with
THAT user's Vikunja URL/token and root project, loaded from the DPAPI vault (user_vault). The
single-user job code (hermes_bridge.process_job) is reused unchanged: it only receives a per-user
base URL, token and root. A periodic sweep catches retries whose mark was already acknowledged.

Copilot (chat), Cata summaries and minute decisions are answered with a clear "not enabled yet"
until F4/F5, so no model ever runs with another user's context in the meantime.

Usage: python tools/multiuser_bridge.py [--once] [--env-file PATH]
The env file holds DSTA_DASHBOARD_URL (staging) and DSTA_BRIDGE_TOKEN; nothing is printed.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Callable
from urllib.error import HTTPError, URLError

_tools_dir = str(Path(__file__).resolve().parent)
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)
from user_context import using_root  # noqa: E402

KINDS = ("action", "label", "chat", "health", "granola")
DRAIN_LIMIT = 5
DISPATCH_SECONDS = 3
SWEEP_SECONDS = 300
PUBLISH_SECONDS = 120
GRANOLA_SYNC_SECONDS = 3600
GRANOLA_FAILED = "No se pudo completar la conexión con Granola. Inténtalo de nuevo."
COPILOT_PENDING = ("El Copilot multiusuario aún no está habilitado en este entorno (fase F5). "
                   "Tu consulta no fue procesada.")
INBOX_PENDING = "La bandeja de minutas multiusuario aún no está habilitada (fase F4)."
DEFAULT_ENV = Path.home() / "AppData" / "Local" / "dsta-multiuser" / "bridge.env"


def log(message: str) -> None:
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}", flush=True)


class MultiuserBridge:
    def __init__(self, base_url: str, token: str, *, load_user: Callable[[str], dict | None],
                 request_json: Callable, process_job: Callable, finish_job: Callable, users_dir: Path,
                 publish_snapshot: Callable | None = None, check_vikunja: Callable | None = None,
                 granola=None):
        self.base = base_url.rstrip("/")
        self.token = token
        self.load_user = load_user
        self.request_json = request_json
        self.process_job = process_job
        self.finish_job = finish_job
        self.users_dir = users_dir
        self.publish_snapshot = publish_snapshot
        self.check_vikunja = check_vikunja or (lambda user: (True, "sin verificar"))
        self.granola = granola

    def user_base(self, actor: str) -> str:
        return f"{self.base}/u/{actor}"

    def _user(self, actor: str) -> dict | None:
        try:
            user = self.load_user(actor)
        except (OSError, ValueError, RuntimeError):
            user = None
        if not user or not user.get("vikunjaToken") or not isinstance(user.get("rootProjectId"), int):
            return None
        return user

    def dispatch_once(self) -> int:
        dispatch = self.request_json(f"{self.base}/api/bridge/dispatch", token=self.token, timeout=10)
        handled = 0
        for actor, marks in (dispatch.get("pending") or {}).items():
            user = self._user(actor)
            if not user:
                # Unknown to this VM: never poll or acknowledge someone else's queue.
                log(f"despacho ignorado: usuario sin vault ({actor[:20]})")
                continue
            kinds = [kind for kind in marks if kind in KINDS]
            for kind in kinds:
                handled += self.drain(actor, user, kind)
            if kinds:
                self.request_json(f"{self.base}/api/bridge/dispatch", token=self.token, method="POST",
                                  payload={"actor": actor, "kinds": kinds, "seenAt": dispatch["now"]}, timeout=10)
        return handled

    def sweep(self, actors: list[str]) -> int:
        handled = 0
        for actor in actors:
            user = self._user(actor)
            if user:
                for kind in ("action", "label"):
                    handled += self.drain(actor, user, kind)
        return handled

    def drain(self, actor: str, user: dict, kind: str) -> int:
        base = self.user_base(actor)
        handled = 0
        for _ in range(DRAIN_LIMIT):
            result = self.request_json(f"{base}/api/bridge/next?kind={kind}", token=self.token, timeout=10)
            if kind == "health":
                if result.get("request"):
                    self.report_health(actor, user, result["request"])
                    handled += 1
                return handled
            if kind == "granola":
                if result.get("granola"):
                    self.handle_granola(actor, result["granola"])
                    handled += 1
                return handled
            if result.get("decision"):
                self.request_json(f"{base}/api/bridge/decision-done", token=self.token, method="POST",
                                  payload={"id": result["decision"]["id"], "error": INBOX_PENDING}, timeout=20)
                handled += 1
            job = result.get("job")
            if not job:
                return handled
            self.run_job(actor, user, job)
            handled += 1
        return handled

    def run_job(self, actor: str, user: dict, job: dict) -> None:
        base = self.user_base(actor)
        if job.get("kind") in ("action", "label"):
            home = self.users_dir / actor
            with using_root(user["rootProjectId"]):
                self.process_job(job, base, self.token, "", home, "", "", user["vikunjaToken"],
                                 user.get("vikunjaUrl", "http://127.0.0.1:3456"), "", "sonnet")
            return
        self.finish_job(base, self.token, job, error=COPILOT_PENDING)

    def _granola_post(self, actor: str, payload: dict) -> None:
        self.request_json(f"{self.user_base(actor)}/api/bridge/granola", token=self.token, method="POST",
                          payload=payload, timeout=20)

    def handle_granola(self, actor: str, op: dict) -> None:
        if not self.granola:
            self._granola_post(actor, {"id": op.get("id"), "status": "error", "error": "Granola no está habilitado en este puente."})
            return
        try:
            if op.get("op") == "authorize":
                started = self.granola.authorize(actor, op["id"])
                self._granola_post(actor, {"id": op["id"], "status": "authorize", **started})
            elif op.get("op") == "exchange":
                self.granola.exchange(actor, op["id"], op["state"], op["code"])
                self._granola_post(actor, {"id": op["id"], "status": "connected"})
                self.sync_granola([actor])
            elif op.get("op") == "disconnect":
                self.granola.disconnect(actor)
                self._granola_post(actor, {"id": op["id"], "status": "disconnected"})
        except Exception as error:  # provider/OAuth failures: report a generic message, never details
            log(f"granola de {actor[:20]} falló ({type(error).__name__})")
            self._granola_post(actor, {"id": op.get("id"), "status": "error", "error": GRANOLA_FAILED})

    def sync_granola(self, actors: list[str]) -> int:
        """Import each connected user's meetings into THEIR inbox (title, date, summary)."""
        if not self.granola:
            return 0
        import granola_user
        imported = 0
        for actor in actors:
            if not self.granola.connected(actor):
                continue
            try:
                records = self.granola.sync(actor)
                for record in records:
                    self.request_json(f"{self.user_base(actor)}/api/bridge/minute", token=self.token, method="POST",
                                      payload=granola_user.inbox_record(record), timeout=20)
                self._granola_post(actor, {"status": "synced", "count": len(records)})
                imported += len(records)
            except Exception as error:
                log(f"sync granola de {actor[:20]} falló ({type(error).__name__})")
        return imported

    def report_health(self, actor: str, user: dict, request: dict) -> None:
        ok, detail = self.check_vikunja(user)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.request_json(f"{self.user_base(actor)}/api/bridge/health", token=self.token, method="POST", timeout=20,
                          payload={"vikunja": {"ok": ok, "detail": detail, "checkedAt": now, "requestId": request["id"]},
                                   "granola": {"ok": bool(self.granola and self.granola.connected(actor)),
                                               "detail": "Granola conectado" if self.granola and self.granola.connected(actor)
                                               else "Granola no conectado", "checkedAt": now, "requestId": request["id"]}})

    def publish_all(self, actors: list[str]) -> int:
        published = 0
        for actor in actors:
            user = self._user(actor)
            if not user or not self.publish_snapshot:
                continue
            try:
                with using_root(user["rootProjectId"]):
                    self.publish_snapshot(self.user_base(actor), self.token, user["vikunjaToken"],
                                          user.get("vikunjaUrl", "http://127.0.0.1:3456"))
                published += 1
            except (HTTPError, URLError, OSError, ValueError, RuntimeError) as error:
                log(f"snapshot de {actor[:20]} falló ({type(error).__name__})")
        return published


def vikunja_checker(request_json: Callable) -> Callable:
    def check(user: dict) -> tuple[bool, str]:
        try:
            request_json(user["vikunjaUrl"].rstrip("/") + "/api/v1/user", token=user["vikunjaToken"], timeout=10)
            return True, "Vikunja responde con la credencial del usuario"
        except (HTTPError, URLError, OSError, ValueError):
            return False, "Vikunja no responde o la credencial no es válida"
    return check


def build(env_file: Path) -> MultiuserBridge:
    import hermes_bridge as hb
    import user_vault
    values = hb.load_env_file(env_file)
    base = hb.setting("DSTA_DASHBOARD_URL", values).rstrip("/")
    token = hb.setting("DSTA_BRIDGE_TOKEN", values)
    if not base.startswith("https://") and not base.startswith("http://127.0.0.1"):
        raise RuntimeError("DSTA_DASHBOARD_URL debe usar HTTPS")
    if "dsta-web." in base and "staging" not in base:
        raise RuntimeError("El puente multiusuario no se conecta a producción antes de F6")
    if not token:
        raise RuntimeError("Falta DSTA_BRIDGE_TOKEN")
    users_dir = user_vault.vault_dir().parent / "users"
    import granola_user
    test_origin = hb.setting("DSTA_GRANOLA_TEST_ORIGIN", values) or None
    granola = granola_user.GranolaService(f"{base}/oauth/granola/callback", test_origin=test_origin)
    return MultiuserBridge(base, token, load_user=user_vault.load, request_json=hb.request_json,
                           process_job=hb.process_job, finish_job=hb.finish_job, users_dir=users_dir,
                           publish_snapshot=hb.publish_snapshot, check_vikunja=vikunja_checker(hb.request_json),
                           granola=granola)


def run(bridge: MultiuserBridge, actors: Callable[[], list[str]], *, once: bool) -> int:
    next_sweep = next_publish = 0.0
    next_granola = time.monotonic() + 60
    log("Puente multiusuario listo (solo conexiones salientes).")
    while True:
        try:
            if time.monotonic() >= next_publish:
                next_publish = time.monotonic() + PUBLISH_SECONDS
                bridge.publish_all(actors())
            bridge.dispatch_once()
            if time.monotonic() >= next_sweep:
                next_sweep = time.monotonic() + SWEEP_SECONDS
                bridge.sweep(actors())
            if time.monotonic() >= next_granola:
                next_granola = time.monotonic() + GRANOLA_SYNC_SECONDS
                bridge.sync_granola(actors())
        except (HTTPError, URLError, OSError, ValueError, RuntimeError) as error:
            log(f"puente sin conexión ({type(error).__name__}); reintenta")
        if once:
            return 0
        time.sleep(DISPATCH_SECONDS)


def main() -> int:
    parser = argparse.ArgumentParser(description="Puente saliente multiusuario del dashboard DSTA")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV)
    args = parser.parse_args()
    try:
        import user_vault
        return run(build(args.env_file), user_vault.actors, once=args.once)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
