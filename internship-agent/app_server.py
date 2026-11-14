"""Mission Control: the tracker count, the runner's live step, and the controls for a blitz run.

    python app_server.py            # http://127.0.0.1:4760

Shows internship_tracker.xlsx's total and status breakdown (the same numbers Internship Hunter
shows, both via tracker_sync.py), the active posting's step from run_state.json, and the
confirmation-gate buttons when an e-mail timed out. Start / Pause / Stop runs

    agent_runner.py --local-blitz --dedup-level role --max-per-company 3

from the page. Pause and Stop are read by the runner between applications (run_control.json),
so they also work on a run started from a terminal.

It binds to 127.0.0.1, answers only requests addressed to localhost, refuses cross-site POSTs,
and only ever starts that one fixed command. No dependencies beyond the standard library and
the project's own modules.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import config
import run_state

HOST, PORT = "127.0.0.1", 4760
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
MAX_BODY = 4096
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
        }

    def act(self, action) -> tuple[int, dict]:
        if action not in self.ACTIONS:
            return 400, {"error": "action must be one of: " + ", ".join(self.ACTIONS)}
        with self._lock:
            st = self.status()
            if action == "start":
                if st["running"]:
                    return 409, {"error": "a run is already going"}
                return self._start()
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

    def _start(self) -> tuple[int, dict]:
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
                self.proc = self._popen([sys.executable, "-u", str(CODE_DIR / "agent_runner.py"), *BLITZ_ARGS],
                                        cwd=str(CODE_DIR), stdin=subprocess.DEVNULL, stdout=log,
                                        stderr=subprocess.STDOUT, env=env, creationflags=flags)
            except OSError as exc:
                return 500, {"error": f"could not start the runner ({exc.strerror or type(exc).__name__})"}
        self.started = time.strftime("%Y-%m-%d %H:%M:%S")
        run_state.update(None, "", "Blitz run starting...")
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
    return {
        "job": state.get("job"),
        "step": step,
        "message": state.get("message") or "",
        "updated": state.get("updated") or "",
        "timed_out": bool(state.get("timed_out")),
        "unconfirmed": step == run_state.UNCONFIRMED,
        "steps": steps,
        "choices": [{"key": k, "label": v} for k, v in run_state.CHOICES.items()],
        "tracker": tracker.get(),
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
    """POST /api/blitz {"action": "start" | "pause" | "resume" | "stop" | "force-stop"}."""
    if not isinstance(payload, dict):
        return 400, {"error": "send {\"action\": ...}"}
    return blitz.act(payload.get("action"))


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


PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mission Control</title>
<style>
  :root {
    --paper: oklch(97% 0.008 85); --card: oklch(99.5% 0.004 85); --ink: oklch(24% 0.02 260);
    --dim: oklch(50% 0.02 260); --line: oklch(88% 0.012 85); --accent: oklch(52% 0.17 262);
    --ok: oklch(50% 0.12 155); --warn: oklch(55% 0.16 50); --warn-bg: oklch(95% 0.045 75);
    --bad: oklch(52% 0.18 25);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: oklch(19% 0.015 260); --card: oklch(23% 0.018 260); --ink: oklch(93% 0.01 85);
      --dim: oklch(70% 0.02 260); --line: oklch(33% 0.02 260); --accent: oklch(74% 0.13 262);
      --ok: oklch(76% 0.13 155); --warn: oklch(80% 0.13 70); --warn-bg: oklch(30% 0.05 60);
      --bad: oklch(72% 0.15 25);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink);
    font: 15px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 28px 20px 48px; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  h1 { font-size: 20px; font-weight: 600; margin: 0; }
  .count { font-variant-numeric: tabular-nums; color: var(--dim); }
  .count b { color: var(--ink); font-size: 18px; font-weight: 600; }
  .track { height: 6px; background: var(--line); border-radius: 3px; margin: 12px 0 10px; overflow: hidden; }
  .track i { display: block; height: 100%; width: 0; background: var(--accent); }
  .statuses { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--dim); font-size: 13px; margin-bottom: 4px; }
  .statuses b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
  .warnline { color: var(--warn); font-size: 13px; }
  .control { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 20px 0 18px;
    padding: 14px 16px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
  .control .state { flex: 1 1 220px; min-width: 0; }
  .control .state b { display: block; font-weight: 600; }
  .control .state small { color: var(--dim); overflow-wrap: anywhere; }
  .banner { background: var(--warn-bg); border: 1px solid var(--warn); border-radius: 10px;
    padding: 16px 18px; margin-bottom: 18px; }
  .banner h2 { font-size: 15px; font-weight: 600; margin: 0 0 4px; color: var(--warn); }
  .banner p { margin: 0 0 12px; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  button { font: inherit; font-weight: 500; padding: 8px 14px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--ink); background: var(--card); color: var(--ink); }
  button.primary { background: var(--ink); color: var(--paper); }
  button.danger { border-color: var(--bad); color: var(--bad); }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 18px; }
  .card h2 { font-size: 17px; font-weight: 600; margin: 0; overflow-wrap: anywhere; }
  .card .sub { color: var(--dim); margin: 2px 0 16px; overflow-wrap: anywhere; }
  ol.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  ol.steps li { display: grid; grid-template-columns: 22px 1fr; gap: 10px; align-items: start;
    color: var(--dim); overflow-wrap: anywhere; }
  ol.steps .dot { width: 14px; height: 14px; margin-top: 4px; border-radius: 50%; border: 2px solid var(--line); }
  ol.steps li.done { color: var(--ink); }
  ol.steps li.done .dot { background: var(--ok); border-color: var(--ok); }
  ol.steps li.active { color: var(--ink); font-weight: 600; }
  ol.steps li.active .dot { border-color: var(--accent); background: var(--accent); }
  .msg { margin-top: 14px; color: var(--dim); }
  .idle { color: var(--dim); }
  h3 { font-size: 13px; font-weight: 600; color: var(--dim); margin: 26px 0 8px; }
  pre { margin: 0; padding: 12px 14px; background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    font: 12px/1.55 Consolas, ui-monospace, monospace; overflow-x: auto; white-space: pre; }
  #note, #cnote { min-height: 1.5em; color: var(--dim); }
  #note { margin-top: 10px; }
  #cnote { flex-basis: 100%; font-size: 13px; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Mission Control</h1>
    <div class="count"><b id="total">0</b> / <span id="target">500</span> applications ·
      <span id="left"></span></div>
  </header>
  <div class="track" role="progressbar" aria-label="Applications in the tracker" id="bar"><i id="fill"></i></div>
  <div class="statuses" id="statuses"></div>
  <div class="warnline" id="trackwarn"></div>

  <section class="control" aria-label="Blitz run">
    <div class="state"><b id="bstate">Not running</b><small id="bsub"></small></div>
    <button class="primary" id="b-start">Start Blitz Run</button>
    <button id="b-pause" hidden>Pause</button>
    <button id="b-resume" hidden>Resume</button>
    <button id="b-stop" hidden>Stop</button>
    <button class="danger" id="b-force" hidden>Force stop</button>
    <div id="cnote" role="status"></div>
  </section>

  <section class="banner" id="banner" hidden>
    <h2>No confirmation email yet</h2>
    <p id="banner-text"></p>
    <div class="actions" id="actions"></div>
    <div id="note" role="status"></div>
  </section>

  <section class="card" id="card"></section>

  <h3>Runner output</h3>
  <pre id="log"></pre>
</main>
<script>
const SHORT = { wait: "Wait 60s", retry: "Retry in Browser", skip: "Skip as Unconfirmed" };
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text; return n; };
let sending = false, lastAlert = "", audio = null;

// Browsers only allow sound after a click on the page, so the context is made on the first one.
document.addEventListener("click", () => { if (!audio) { try { audio = new AudioContext(); } catch (e) {} } });
function ring() {
  if (!audio) return;
  for (const [at, f] of [[0, 880], [0.25, 660], [0.5, 880]]) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = f; g.gain.value = 0.12; o.connect(g).connect(audio.destination);
    o.start(audio.currentTime + at); o.stop(audio.currentTime + at + 0.18);
  }
}

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) });
  return [r.ok, await r.json().catch(() => ({}))];
}

async function choose(key) {
  if (sending) return;
  sending = true; for (const b of $("actions").querySelectorAll("button")) b.disabled = true;
  try {
    const [ok, d] = await post("api/gate-choice", { choice: key });
    $("note").textContent = ok ? "Sent to the runner: " + SHORT[key] : "Not sent: " + (d.error || "error");
  } catch (e) { $("note").textContent = "Could not reach this server."; }
  sending = false; refresh();
}

async function control(action) {
  if (action === "force-stop" && !confirm("Force stop ends the run immediately, even in the middle of an application. Continue?")) return;
  for (const b of document.querySelectorAll(".control button")) b.disabled = true;
  try {
    const [ok, d] = await post("api/blitz", { action });
    $("cnote").textContent = ok ? "" : "Not done: " + (d.error || "error");
  } catch (e) { $("cnote").textContent = "Could not reach this server."; }
  refresh();
}
for (const [id, action] of [["b-start", "start"], ["b-pause", "pause"], ["b-resume", "resume"],
                            ["b-stop", "stop"], ["b-force", "force-stop"]]) {
  $(id).addEventListener("click", () => control(action));
}

function renderControl(b) {
  const show = (id, on) => { $(id).hidden = !on; $(id).disabled = false; };
  show("b-start", !b.running);
  show("b-pause", b.running && !b.paused && !b.stopping);
  show("b-resume", b.running && b.paused && !b.stopping);
  show("b-stop", b.running && !b.stopping);
  show("b-force", b.running && b.stopping);
  let head = "Not running", sub = b.command;
  if (b.running) {
    head = b.stopping ? "Stopping after the current application" : b.paused ? "Paused between applications" : "Running";
    sub = (b.started ? "since " + b.started + " · " : "") + "pid " + b.pid
      + (b.external ? " · started from a terminal" : "") + " · " + b.command;
  } else if (b.exit_code !== null && b.exit_code !== undefined) {
    head = b.exit_code === 0 ? "Last run finished" : "Last run ended with exit code " + b.exit_code;
  }
  $("bstate").textContent = head; $("bsub").textContent = sub;
}

function renderTracker(t) {
  $("total").textContent = t.total; $("target").textContent = t.target;
  $("left").textContent = t.remaining ? t.remaining + " to go" : "goal reached";
  $("fill").style.width = (t.target ? Math.min(100, 100 * t.total / t.target) : 0) + "%";
  $("bar").setAttribute("aria-valuenow", t.total); $("bar").setAttribute("aria-valuemax", t.target);
  const box = $("statuses"); box.replaceChildren();
  for (const s of t.byStatus || []) {
    const span = el("span"); span.append(el("b", "", s.count), " " + s.status); box.append(span);
  }
  const warn = [];
  if (t.error) warn.push(t.error);
  if (t.pendingWrites) warn.push(t.pendingWrites + " submitted application(s) waiting for Excel to close the workbook");
  if (t.unconfirmed) warn.push(t.unconfirmed + " unconfirmed (on the hold list, not counted)");
  $("trackwarn").textContent = warn.join(" · ");
}

function renderAll(s) {
  renderTracker(s.tracker); renderControl(s.blitz);
  const banner = $("banner");
  if (s.timed_out && s.job) {
    $("banner-text").textContent = s.job.company + " — " + s.job.title + ". " + s.message;
    if (banner.hidden) {
      const box = $("actions"); box.replaceChildren(); $("note").textContent = "";
      for (const c of s.choices) {
        const b = el("button", c.key === "wait" ? "primary" : "", SHORT[c.key] || c.label);
        b.title = c.label; b.addEventListener("click", () => choose(c.key)); box.append(b);
      }
    }
    banner.hidden = false;
  } else { banner.hidden = true; }

  const card = $("card"); card.replaceChildren();
  if (!s.job) { card.append(el("div", "idle", s.message || "The runner is not working on a posting.")); }
  else {
    card.append(el("h2", "", s.job.title || "Application"));
    card.append(el("div", "sub", [s.job.company, s.job.ats].filter(Boolean).join(" · ")));
    const ol = el("ol", "steps");
    for (const st of s.steps) {
      const li = el("li", st.status); li.append(el("span", "dot"), el("span", "", st.label));
      if (st.status === "active") li.setAttribute("aria-current", "step");
      ol.append(li);
    }
    card.append(ol);
    if (s.unconfirmed) card.append(el("div", "msg", "Logged as unconfirmed. Not counted toward the total."));
    else if (s.message && !s.timed_out) card.append(el("div", "msg", s.message));
  }
  $("log").textContent = (s.log || []).join("\n");

  const alert = s.timed_out ? "timeout:" + (s.job && s.job.id) : s.attention;
  if (alert && alert !== lastAlert) ring();
  lastAlert = alert;
}

async function refresh() {
  try {
    const r = await fetch("api/state", { cache: "no-store" });
    if (r.ok) renderAll(await r.json());
  } catch (e) { /* server restarting: keep the last view */ }
}
refresh(); setInterval(refresh, 1500);
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "MissionControl/2"

    def log_message(self, *args) -> None:                  # quiet: the runner owns the terminal
        pass

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; "
                                                    "script-src 'unsafe-inline'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, data: dict) -> None:
        self._send(code, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self) -> None:                              # noqa: N802 - http.server API
        if not host_ok(self.headers.get("Host", "")):
            return self._json(403, {"error": "local requests only"})
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            return self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")
        if path == "/api/state":
            return self._json(200, build_state())
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:                             # noqa: N802
        host = self.headers.get("Host", "")
        if not host_ok(host) or not origin_ok(self.headers.get("Origin", ""), host):
            return self._json(403, {"error": "cross-site request refused"})
        route = {"/api/gate-choice": handle_choice, "/api/blitz": handle_blitz}.get(urlparse(self.path).path)
        if route is None:
            return self._json(404, {"error": "not found"})
        if "application/json" not in (self.headers.get("Content-Type") or "").lower():
            return self._json(415, {"error": "send JSON"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if not 0 < length <= MAX_BODY:
            return self._json(413, {"error": "bad body size"})
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._json(400, {"error": "bad json"})
        self._json(*route(payload))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args(argv)
    try:
        server = ThreadingHTTPServer((HOST, args.port), Handler)
    except OSError as exc:
        print(f"Port {args.port} is in use: Mission Control is probably already running ({exc})", file=sys.stderr)
        return 1
    print(f"Mission Control: http://{HOST}:{args.port}  (close this window to stop it; a blitz run keeps going)",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
