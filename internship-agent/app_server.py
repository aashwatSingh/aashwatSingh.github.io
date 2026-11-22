"""Mission Control: run and watch blitz batches from the browser instead of PowerShell.

    Launch_Mission_Control.bat          # Windows: starts this server and opens the page
    python app_server.py                # http://127.0.0.1:4760

A FastAPI backend (this file) and a React page (mission_control_ui/, built to mission_control_ui/dist).
The page shows:

  * the 500-application goal from internship_tracker.xlsx (via tracker_sync.py, the same numbers
    Internship Hunter shows): applied, e-mail verified, in the queue, blocked, failed, remaining;
  * the posting being worked on and its step, and the recent results;
  * Start / Pause / Resume / Stop for a batch of N postings, and the runner's log, live (SSE);
  * the Unblock Queue (unblock.py): postings that stopped on a CAPTCHA, a question the profile
    cannot answer, a login wall or a missing confirmation e-mail, with Retry / Confirm Submitted /
    Dismiss and a form whose answers are saved to custom_answers.json.

It binds to 127.0.0.1, answers only requests addressed to localhost (DNS-rebinding guard), refuses
cross-site POSTs, only ever starts the one fixed runner command, and never sends .env values to
the page.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import config
import phone_notify
import run_state
import unblock
from fileutil import read_json

HOST, PORT = "127.0.0.1", 4760
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
MAX_BODY = 64 * 1024
MAX_BATCH = 500
UI_DIR = Path(__file__).resolve().parent / "mission_control_ui" / "dist"
CODE_DIR = Path(__file__).resolve().parent
BLITZ_ARGS = ["--local-blitz", "--dedup-level", "role", "--max-per-company", "3"]
ATTENTION = "[ACTION REQUIRED]"


# ---- the tracker ---------------------------------------------------------------------- #

class TrackerCache:
    """tracker_sync.summary(), recomputed only when the workbook or the hold lists change."""

    def __init__(self, compute=None):
        self._compute = compute
        self._key = None
        self._value = None
        self._lock = threading.Lock()

    @staticmethod
    def _stamp(path) -> float:
        try:
            return Path(path).stat().st_mtime
        except OSError:
            return 0.0

    def get(self) -> dict:
        key = tuple(self._stamp(p) for p in (config.TRACKER_XLSX, config.PENDING_XLSX_JSON, config.UNCONFIRMED_CSV))
        with self._lock:
            if key == self._key and self._value is not None:
                return self._value
            try:
                if self._compute is None:
                    import tracker_sync
                    self._compute = tracker_sync.summary
                full = self._compute()
                value = {k: v for k, v in full.items() if k != "rows"}
                value["error"] = ""
            except Exception as exc:                       # noqa: BLE001 - locked or mid-save: keep the last good one
                value = dict(self._value or {"total": 0, "target": config.TARGET_TOTAL,
                                             "remaining": config.TARGET_TOTAL, "byStatus": [],
                                             "pendingWrites": 0, "unconfirmed": 0})
                value["error"] = f"could not read {config.TRACKER_XLSX.name} ({type(exc).__name__})"
                return value                               # not cached: try again on the next poll
            self._key, self._value = key, value
            return value

    def invalidate(self) -> None:
        with self._lock:
            self._key = None


tracker = TrackerCache()


# ---- the blitz run ---------------------------------------------------------------------- #

def _kill_tree(pid: int) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(int(pid)), "/T", "/F"], capture_output=True, timeout=20)
    else:
        import signal
        os.kill(int(pid), signal.SIGTERM)


def blitz_log_path() -> Path:
    return config.LOG_DIR / "blitz.log"


class Blitz:
    """Starts the one blitz command, and Pause / Resume / Stop via run_control.json."""

    ACTIONS = ("start", "pause", "resume", "stop", "force-stop")

    def __init__(self, popen=subprocess.Popen, kill=_kill_tree):
        self._popen, self._kill = popen, kill
        self.proc = None
        self.started = ""
        self._lock = threading.Lock()

    def _own_running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def status(self) -> dict:
        runner = run_state.read_runner()
        own = self._own_running()
        running = own or runner is not None
        control = run_state.read_control()
        exit_code = None
        if self.proc is not None and not own:
            exit_code = self.proc.returncode
        return {
            "running": running,
            "pid": (runner or {}).get("pid") or (self.proc.pid if own else None),
            "started": (runner or {}).get("started") or (self.started if own else ""),
            "paused": running and control["paused"],
            "stopping": running and control["stop"],
            "external": running and not own,           # started from a terminal, not this page
            "exit_code": exit_code,
            "command": "agent_runner.py " + " ".join(BLITZ_ARGS),
            "limit": getattr(self, "limit", None) if running else None,
        }

    def act(self, action, limit=None) -> tuple[int, dict]:
        if action not in self.ACTIONS:
            return 400, {"error": "action must be one of: " + ", ".join(self.ACTIONS)}
        if limit not in (None, "", 0):
            if isinstance(limit, bool) or not isinstance(limit, (int, str)) or not str(limit).isdigit() \
                    or not 1 <= int(limit) <= MAX_BATCH:
                return 400, {"error": f"batch size must be a whole number from 1 to {MAX_BATCH}"}
            limit = int(limit)
        else:
            limit = None
        with self._lock:
            st = self.status()
            if action == "start":
                if st["running"]:
                    return 409, {"error": "a run is already going"}
                return self._start(limit)
            if not st["running"]:
                return 409, {"error": "no run is going"}
            if action == "pause":
                run_state.set_control(paused=True)
            elif action == "resume":
                run_state.set_control(paused=False)
            elif action == "stop":
                run_state.set_control(stop=True, paused=False)
            else:
                pid = st["pid"]
                if self._own_running():
                    pid = self.proc.pid
                try:
                    self._kill(int(pid))
                except Exception as exc:                   # noqa: BLE001
                    return 500, {"error": f"could not stop it ({type(exc).__name__})"}
                run_state.clear_control()
                run_state.update(None, "", "Run force-stopped from Mission Control")
            return 200, {"ok": True, **self.status()}

    def _start(self, limit: int | None = None) -> tuple[int, dict]:
        run_state.clear_control()
        run_state.clear_choice()
        config.LOG_DIR.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
        flags = 0
        if os.name == "nt":
            # Its own process group and no console: closing Mission Control's window does not kill a
            # run mid-application, and Stop still reaches it through run_control.json.
            flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        with blitz_log_path().open("w", encoding="utf-8") as log:
            try:
                extra = ["--limit", str(limit)] if limit else []
                self.proc = self._popen([sys.executable, "-u", str(CODE_DIR / "agent_runner.py"), *BLITZ_ARGS, *extra],
                                        cwd=str(CODE_DIR), stdin=subprocess.DEVNULL, stdout=log,
                                        stderr=subprocess.STDOUT, env=env, creationflags=flags)
            except OSError as exc:
                return 500, {"error": f"could not start the runner ({exc.strerror or type(exc).__name__})"}
        self.started = time.strftime("%Y-%m-%d %H:%M:%S")
        self.limit = limit
        run_state.update(None, "", f"Blitz run starting ({f'batch of {limit}' if limit else 'whole queue'})...")
        return 200, {"ok": True, **self.status()}


blitz = Blitz()


# ---- state for the page ------------------------------------------------------------------ #

def _log_tail(lines: int = 14) -> list[str]:
    """The newer of the blitz output and runner.log."""
    candidates = [p for p in (blitz_log_path(), config.LOG_DIR / "runner.log") if p.exists()]
    if not candidates:
        return []
    newest = max(candidates, key=lambda p: p.stat().st_mtime)
    try:
        text = newest.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return [line.replace("\a", "") for line in text.splitlines() if line.strip()][-lines:]


def build_state() -> dict:
    """Everything the page shows, as plain data."""
    state = run_state.read()
    step = state.get("step") or ""
    order = [key for key, _ in run_state.STEPS]
    reached = order.index(step) if step in order else -1
    steps = []
    for i, (key, label) in enumerate(run_state.STEPS):
        if key == run_state.CONFIRMED and step == run_state.CONFIRMED and state.get("subject"):
            label = f'Confirmed: "{state["subject"]}"'
        status = "done" if i < reached else "active" if i == reached else "todo"
        if key == run_state.CONFIRMED and i == reached:
            status = "done"
        if key == run_state.ENTERING_OTP and status == "done" and not state.get("otp"):
            status, label = "skipped", label + " (not asked for)"
        steps.append({"key": key, "label": label, "status": status})
    log = _log_tail()
    tracker_view = tracker.get()
    open_items = unblock.items(open_only=True)
    open_blockers = sum(1 for i in open_items if i.get("status") == unblock.OPEN)
    return {
        "job": state.get("job"),
        "step": step,
        "message": state.get("message") or "",
        "updated": state.get("updated") or "",
        "timed_out": bool(state.get("timed_out")),
        "unconfirmed": step == run_state.UNCONFIRMED,
        # A required question the profile cannot answer is highlighted in the browser; the runner
        # continues by itself once it is filled and focus has left it.
        "waiting": (state.get("waiting") or {}) if step == run_state.WAITING_FOR_ANSWER else None,
        "phone": phone_notify.dashboard_status(),               # Phone Assist: Connected / Off (secrets masked)
        "captchas": int(state.get("captchas") or 0),            # CAPTCHAs cleared on this posting (the message names the current one)
        "steps": steps,
        "choices": [{"key": k, "label": v} for k, v in run_state.CHOICES.items()],
        "tracker": tracker_view,
        "metrics": metrics(tracker_view, queue_stats.get(), open_blockers),
        "unblock": open_items,
        "activity": activity.get(),
        "blitz": blitz.status(),
        "log": log,
        "attention": next((line for line in reversed(log) if ATTENTION in line), ""),
    }


def handle_choice(payload) -> tuple[int, dict]:
    """POST /api/gate-choice. Only accepted while the runner is actually waiting on a timeout."""
    if not isinstance(payload, dict) or payload.get("choice") not in run_state.CHOICES:
        return 400, {"error": "choice must be one of: " + ", ".join(run_state.CHOICES)}
    state = run_state.read()
    if not state.get("timed_out"):
        return 409, {"error": "the runner is not waiting for a choice"}
    job_id = str((state.get("job") or {}).get("id") or "")
    run_state.post_choice(payload["choice"], job_id)
    return 200, {"ok": True, "choice": payload["choice"]}


def handle_blitz(payload) -> tuple[int, dict]:
    """POST /api/blitz {"action": "start" | "pause" | "resume" | "stop" | "force-stop", "limit": N}."""
    if not isinstance(payload, dict):
        return 400, {"error": "send {\"action\": ...}"}
    return blitz.act(payload.get("action"), payload.get("limit"))


def handle_unblock(item_id: str, payload) -> tuple[int, dict]:
    """POST /api/unblock/<id> {"action": "retry" | "resume" | "confirm" | "dismiss", "answers": {label: text}}."""
    if not isinstance(payload, dict):
        return 400, {"error": "send {\"action\": ...}"}
    answers = payload.get("answers")
    if answers is not None and (not isinstance(answers, dict)
                                or not all(isinstance(k, str) and isinstance(v, (str, int, float)) for k, v in answers.items())):
        return 400, {"error": "answers must map each question to its answer text"}
    code, body = unblock.resolve(item_id, payload.get("action"), answers)
    if code == 200:
        tracker.invalidate()
    return code, body


def host_ok(host_header: str) -> bool:
    """Requests must be addressed to this machine by a local name (guards against DNS rebinding)."""
    host = (host_header or "").strip().lower()
    name = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
    return name in LOCAL_HOSTS


def origin_ok(origin: str, host_header: str) -> bool:
    """A browser sends Origin on a POST; it has to be this page's own."""
    if not origin:
        return True
    try:
        return urlparse(origin).netloc.lower() == (host_header or "").strip().lower()
    except ValueError:
        return False




# ---- queue, activity and the goal numbers -------------------------------------------------- #

class MtimeCache:
    """A value recomputed only when the files / directories it depends on change."""

    def __init__(self, paths, compute, empty, ttl_s: float = 0):
        self._paths, self._compute, self._empty, self._ttl = paths, compute, empty, ttl_s
        self._key, self._value = None, None
        self._lock = threading.Lock()

    def get(self):
        key = tuple(TrackerCache._stamp(p) for p in self._paths())
        if self._ttl:                                      # a rewritten file does not touch its folder's mtime
            key += (int(time.time() // self._ttl),)
        with self._lock:
            if key != self._key or self._value is None:
                try:
                    self._value = self._compute()
                except Exception:                          # noqa: BLE001 - mid-write: keep the last good one
                    return self._value if self._value is not None else self._empty()
                self._key = key
            return self._value


def _queue_counts() -> dict:
    data = read_json(config.QUEUE_JSON, [])
    counts: dict[str, int] = {}
    for job in data if isinstance(data, list) else []:
        status = (job or {}).get("status") or "pending"
        counts[status] = counts.get(status, 0) + 1
    return counts


queue_stats = MtimeCache(lambda: (config.QUEUE_JSON,), _queue_counts, dict)

ACTIVITY_SIZE = 15


def _recent_activity() -> list[dict]:
    folder = config.LOG_DIR / "applications"
    try:
        entries = sorted(os.scandir(folder), key=lambda e: e.stat().st_mtime, reverse=True)[:ACTIVITY_SIZE]
    except OSError:
        return []
    out = []
    for e in entries:
        d = read_json(Path(e.path), {})
        if not isinstance(d, dict):
            continue
        job = d.get("job") or {}
        out.append({"when": d.get("when", ""), "company": job.get("company", ""), "title": job.get("title", ""),
                    "ats": job.get("ats", ""), "url": job.get("url", ""), "status": d.get("status", ""),
                    "reason": d.get("reason", ""), "detail": (d.get("detail") or "")[:200]})
    return out


activity = MtimeCache(lambda: (config.LOG_DIR / "applications",), _recent_activity, list, ttl_s=10)


def metrics(tracker_view: dict, queue_counts: dict, blocked: int) -> dict:
    """The goal tracker: everything counted from the workbook, the queue and the Unblock Queue."""
    applied = int(tracker_view.get("total") or 0)
    target = int(tracker_view.get("target") or config.TARGET_TOTAL)
    return {
        "applied": applied,
        "verified": int(tracker_view.get("verified") or 0),
        "unverified": int(tracker_view.get("unverified") or 0),
        "inProgress": int(queue_counts.get("pending", 0)),
        "blocked": blocked,
        "failed": int(queue_counts.get("error", 0)),
        "remaining": max(target - applied, 0),
        "target": target,
        "progress": round(min(applied / target, 1.0), 4) if target else 0.0,
    }


# ---- live log ---------------------------------------------------------------------------- #

def current_log() -> Path | None:
    """The newer of the blitz output and runner.log."""
    candidates = [p for p in (blitz_log_path(), config.LOG_DIR / "runner.log") if p.exists()]
    return max(candidates, key=lambda p: p.stat().st_mtime) if candidates else None


def _clean(line: str) -> str:
    return line.replace("\a", "").rstrip("\r\n")


async def log_events(follow: bool = True, backlog: int = 200, poll_s: float = 0.5,
                     disconnected=None, heartbeat_s: float = 15.0):
    """Server-sent events: the last `backlog` lines, then each new line as it is written.
    Follows a switch to a newer log file (a new run truncates blitz.log)."""
    path = current_log()
    pos = 0
    if path is not None:
        try:
            raw = path.read_bytes()
        except OSError:
            raw = b""
        pos = len(raw)
        for line in raw.decode("utf-8", "replace").splitlines()[-backlog:]:
            if line.strip():
                yield f"data: {json.dumps(_clean(line), ensure_ascii=False)}\n\n"
    if not follow:
        return
    yield "event: ready\ndata: {}\n\n"
    last_beat = time.monotonic()
    buffer = b""
    while True:
        if disconnected is not None and await disconnected():
            return
        await asyncio.sleep(poll_s)
        newest = current_log()
        if newest != path:
            path, pos, buffer = newest, 0, b""
        if path is None:
            continue
        try:
            size = path.stat().st_size
            if size < pos:                                 # truncated: a new run started
                pos, buffer = 0, b""
            if size > pos:
                with path.open("rb") as fh:
                    fh.seek(pos)
                    chunk = fh.read(size - pos)
                pos = size
                buffer += chunk
                *lines, buffer = buffer.split(b"\n")
                for line in lines:
                    text = _clean(line.decode("utf-8", "replace"))
                    if text.strip():
                        yield f"data: {json.dumps(text, ensure_ascii=False)}\n\n"
        except OSError:
            continue
        if time.monotonic() - last_beat > heartbeat_s:
            last_beat = time.monotonic()
            yield ": ping\n\n"


# ---- the web app ------------------------------------------------------------------------- #

NO_UI = """<!doctype html><meta charset="utf-8"><title>Mission Control</title>
<body style="font:15px system-ui;margin:40px">The Mission Control page has not been built.
Run <code>npm --prefix mission_control_ui install</code> and <code>npm --prefix mission_control_ui run build</code>,
then reload. The API is running: <a href="/api/state">/api/state</a>.</body>"""

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
                               "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}


try:                                                       # module level: the route signatures name it
    from fastapi import Request
except ImportError:                                        # main() explains how to install it
    Request = None


def create_app():
    from fastapi import FastAPI
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse

    app = FastAPI(title="Mission Control", docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def guard(request: Request, call_next):
        host = request.headers.get("host", "")
        if not host_ok(host):
            return JSONResponse({"error": "local requests only"}, status_code=403)
        if request.method not in ("GET", "HEAD"):
            if not origin_ok(request.headers.get("origin", ""), host):
                return JSONResponse({"error": "cross-site request refused"}, status_code=403)
            if "application/json" not in (request.headers.get("content-type") or "").lower():
                return JSONResponse({"error": "send JSON"}, status_code=415)
            try:
                length = int(request.headers.get("content-length") or 0)
            except ValueError:
                length = -1
            if not 0 < length <= MAX_BODY:
                return JSONResponse({"error": "bad body size"}, status_code=413)
        response = await call_next(request)
        for k, v in SECURITY_HEADERS.items():
            response.headers.setdefault(k, v)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    async def body(request: Request):
        try:
            return json.loads((await request.body()).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def reply(result: tuple[int, dict]):
        code, data = result
        return JSONResponse(data, status_code=code)

    @app.get("/api/state")
    def state():
        return build_state()

    @app.post("/api/blitz")
    async def blitz_action(request: Request):
        payload = await body(request)
        return reply(handle_blitz(payload) if payload is not None else (400, {"error": "bad json"}))

    @app.post("/api/gate-choice")
    async def gate_choice(request: Request):
        payload = await body(request)
        return reply(handle_choice(payload) if payload is not None else (400, {"error": "bad json"}))

    @app.get("/api/unblock")
    def unblock_list(all: int = 0):                         # noqa: A002 - query parameter name
        return {"items": unblock.items(open_only=not all)}

    @app.post("/api/unblock/{item_id}")
    async def unblock_action(item_id: str, request: Request):
        payload = await body(request)
        return reply(handle_unblock(item_id, payload) if payload is not None else (400, {"error": "bad json"}))

    @app.get("/api/logs/stream")
    async def logs_stream(request: Request, follow: int = 1):
        return StreamingResponse(log_events(follow=bool(follow), disconnected=request.is_disconnected),
                                 media_type="text/event-stream",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    @app.get("/")
    def index():
        page = UI_DIR / "index.html"
        if page.is_file():
            return FileResponse(page, media_type="text/html")
        return HTMLResponse(NO_UI)

    @app.get("/assets/{name}")
    def asset(name: str):
        if not re.fullmatch(r"[\w.-]+\.(js|css|svg|png|woff2?)", name) or ".." in name:
            return JSONResponse({"error": "not found"}, status_code=404)
        path = UI_DIR / "assets" / name
        if not path.is_file():
            return JSONResponse({"error": "not found"}, status_code=404)
        return FileResponse(path)

    return app


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args(argv)
    try:
        import uvicorn
        app = create_app()
    except ImportError:
        print("Mission Control needs FastAPI and uvicorn:  python -m pip install -r requirements.txt", file=sys.stderr)
        return 2
    import socket
    with socket.socket() as probe:
        if probe.connect_ex((HOST, args.port)) == 0:
            print(f"Port {args.port} is in use: Mission Control is probably already running "
                  f"(http://{HOST}:{args.port})", file=sys.stderr)
            return 1
    print(f"Mission Control: http://{HOST}:{args.port}  (close this window to stop it; a blitz run keeps going)",
          flush=True)
    uvicorn.run(app, host=HOST, port=args.port, log_level="warning", access_log=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
