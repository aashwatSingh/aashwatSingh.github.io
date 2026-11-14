"""Mission Control: a local page showing what the runner is doing, with the confirmation-gate buttons.

    python app_server.py            # http://127.0.0.1:4760

Reads run_state.json (written by agent_runner.py) and the ledgers; the only thing it writes is
gate_choice.json, the candidate's answer when a confirmation e-mail timed out. It binds to
127.0.0.1, answers only requests addressed to localhost, and refuses cross-site POSTs.
No dependencies beyond the standard library.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import config
import run_state

HOST, PORT = "127.0.0.1", 4760
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
MAX_BODY = 4096


def _count_rows(path) -> int:
    try:
        with open(path, newline="", encoding="utf-8") as fh:
            return max(sum(1 for _ in csv.reader(fh)) - 1, 0)
    except OSError:
        return 0


def _log_tail(lines: int = 12) -> list[str]:
    try:
        text = (config.LOG_DIR / "runner.log").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return text.splitlines()[-lines:]


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
    return {
        "job": state.get("job"),
        "step": step,
        "message": state.get("message") or "",
        "updated": state.get("updated") or "",
        "timed_out": bool(state.get("timed_out")),
        "unconfirmed": step == run_state.UNCONFIRMED,
        "steps": steps,
        "choices": [{"key": k, "label": v} for k, v in run_state.CHOICES.items()],
        "confirmed_total": _count_rows(config.LEDGER_CSV),
        "target": config.TARGET_TOTAL,
        "unconfirmed_total": _count_rows(config.UNCONFIRMED_CSV),
        "log": _log_tail(),
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
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: oklch(19% 0.015 260); --card: oklch(23% 0.018 260); --ink: oklch(93% 0.01 85);
      --dim: oklch(70% 0.02 260); --line: oklch(33% 0.02 260); --accent: oklch(74% 0.13 262);
      --ok: oklch(76% 0.13 155); --warn: oklch(80% 0.13 70); --warn-bg: oklch(30% 0.05 60);
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
  .track { height: 6px; background: var(--line); border-radius: 3px; margin: 12px 0 24px; overflow: hidden; }
  .track i { display: block; height: 100%; width: 0; background: var(--accent); }
  .banner { background: var(--warn-bg); border: 1px solid var(--warn); border-radius: 10px;
    padding: 16px 18px; margin-bottom: 18px; }
  .banner h2 { font-size: 15px; font-weight: 600; margin: 0 0 4px; color: var(--warn); }
  .banner p { margin: 0 0 12px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  button { font: inherit; font-weight: 500; padding: 8px 14px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--ink); background: var(--card); color: var(--ink); }
  button.primary { background: var(--ink); color: var(--paper); }
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
  #note { min-height: 1.5em; margin-top: 10px; color: var(--dim); }
</style>
</head>
<body>
<main>
  <header>
    <h1>Mission Control</h1>
    <div class="count"><b id="total">0</b> / <span id="target">500</span> confirmed
      <span id="held"></span></div>
  </header>
  <div class="track" role="progressbar" aria-label="Confirmed applications" id="bar"><i id="fill"></i></div>

  <section class="banner" id="banner" hidden>
    <h2>No confirmation email yet</h2>
    <p id="banner-text"></p>
    <div class="actions" id="actions"></div>
    <div id="note" role="status"></div>
  </section>

  <section class="card" id="card"></section>

  <h3>Runner log</h3>
  <pre id="log"></pre>
</main>
<script>
const SHORT = { wait: "Wait 60s", retry: "Retry in Browser", skip: "Skip as Unconfirmed" };
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text; return n; };
let sending = false;

async function choose(key) {
  if (sending) return;
  sending = true; render.buttons(true);
  try {
    const r = await fetch("api/gate-choice", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choice: key }) });
    const d = await r.json().catch(() => ({}));
    $("note").textContent = r.ok ? "Sent to the runner: " + SHORT[key] : "Not sent: " + (d.error || r.status);
  } catch (e) { $("note").textContent = "Could not reach this server."; }
  sending = false; refresh();
}

const render = {
  buttons(disabled) { for (const b of $("actions").querySelectorAll("button")) b.disabled = disabled; },
  all(s) {
    $("total").textContent = s.confirmed_total; $("target").textContent = s.target;
    $("held").textContent = s.unconfirmed_total ? "· " + s.unconfirmed_total + " unconfirmed (not counted)" : "";
    const pct = s.target ? Math.min(100, 100 * s.confirmed_total / s.target) : 0;
    $("fill").style.width = pct + "%";
    $("bar").setAttribute("aria-valuenow", s.confirmed_total); $("bar").setAttribute("aria-valuemax", s.target);

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
  }
};

async function refresh() {
  try {
    const r = await fetch("api/state", { cache: "no-store" });
    if (r.ok) render.all(await r.json());
  } catch (e) { /* server restarting: keep the last view */ }
}
refresh(); setInterval(refresh, 1500);
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "MissionControl/1"

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
        if urlparse(self.path).path != "/api/gate-choice":
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
        self._json(*handle_choice(payload))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args(argv)
    server = ThreadingHTTPServer((HOST, args.port), Handler)
    print(f"Mission Control: http://{HOST}:{args.port}  (Ctrl-C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
