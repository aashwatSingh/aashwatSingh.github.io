"""What the runner is doing right now, for the dashboard (app_server.py), and the dashboard's answer.

Two small git-ignored files next to the code:

* run_state.json   written by the runner: the active posting and which step it is on.
* gate_choice.json written by the dashboard when the candidate presses a button after a
                   confirmation e-mail timed out; the runner reads it once and deletes it.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import config

SUBMITTING = "SUBMITTING_FORM"
ENTERING_OTP = "ENTERING_OTP"
AWAITING_EMAIL = "AWAITING_EMAIL_CONFIRMATION"
CONFIRMED = "CONFIRMED"
UNCONFIRMED = "UNCONFIRMED"

STEPS = [
    (SUBMITTING, "Submitting Form"),
    (ENTERING_OTP, "Entering OTP Code"),
    (AWAITING_EMAIL, "Verifying Receipt Email in Gmail (polling...)"),
    (CONFIRMED, "Confirmed"),
]

WAIT, RETRY, SKIP = "wait", "retry", "skip"
CHOICES = {
    WAIT: "Wait another 60s",
    RETRY: "Check browser & retry submit",
    SKIP: 'Log as "Application incomplete / Unconfirmed" & move on',
}


def choice_path() -> Path:
    return config.BASE / "gate_choice.json"


def _write(path: Path, data: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def update(job: dict | None, step: str = "", message: str = "", **extra) -> dict:
    """Record the active posting and step. Never raises: a dashboard file must not stop an application."""
    state = {
        "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "step": step,
        "message": message,
        "job": ({k: job.get(k) for k in ("id", "company", "title", "ats", "url")} if job else None),
        "timed_out": False,
        "subject": "",
        **extra,
    }
    try:
        _write(config.RUN_STATE_JSON, state)
    except OSError:
        pass
    return state


def read() -> dict:
    try:
        data = json.loads(config.RUN_STATE_JSON.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def post_choice(choice: str, job_id: str = "") -> bool:
    """Dashboard side: leave an answer for the runner. False for anything that is not one of the three."""
    if choice not in CHOICES:
        return False
    _write(choice_path(), {"choice": choice, "job_id": str(job_id or ""), "at": time.time()})
    return True


def take_choice(job_id: str = "") -> str | None:
    """Runner side: the pending answer for this posting, consumed. A stale or foreign file is discarded."""
    path = choice_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    try:
        path.unlink()
    except OSError:
        pass
    if not isinstance(data, dict) or data.get("choice") not in CHOICES:
        return None
    if job_id and data.get("job_id") and data["job_id"] != str(job_id):
        return None                                        # pressed for an earlier posting
    return data["choice"]


def clear_choice() -> None:
    try:
        choice_path().unlink()
    except OSError:
        pass


# ---- blitz control (Mission Control's Start / Pause / Stop) -------------------------------- #
# control.json is written by Mission Control and read by the runner between applications;
# runner.json is written by the runner while it is alive. Both are git-ignored.

def control_path() -> Path:
    return config.BASE / "run_control.json"


def runner_path() -> Path:
    return config.BASE / "runner.json"


def read_control() -> dict:
    try:
        data = json.loads(control_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"paused": False, "stop": False}
    return {"paused": bool(data.get("paused")), "stop": bool(data.get("stop"))}


def set_control(*, paused: bool | None = None, stop: bool | None = None) -> dict:
    data = read_control()
    if paused is not None:
        data["paused"] = paused
    if stop is not None:
        data["stop"] = stop
    _write(control_path(), data)
    return data


def clear_control() -> None:
    try:
        control_path().unlink()
    except OSError:
        pass


def runner_started(args: list[str]) -> None:
    try:
        _write(runner_path(), {"pid": os.getpid(), "started": time.strftime("%Y-%m-%d %H:%M:%S"), "args": args})
    except OSError:
        pass


def runner_finished() -> None:
    try:
        data = json.loads(runner_path().read_text(encoding="utf-8"))
        if data.get("pid") != os.getpid():
            return                                         # another runner took over the file
        runner_path().unlink()
    except (OSError, ValueError):
        pass


def pid_alive(pid) -> bool:
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        try:
            ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return bool(ok) and code.value == 259          # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def read_runner() -> dict | None:
    """The live runner's {pid, started, args}, or None. A file left by a crashed runner is ignored."""
    try:
        data = json.loads(runner_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and pid_alive(data.get("pid")) else None
