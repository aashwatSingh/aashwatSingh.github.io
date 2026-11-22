"""Start Applying from the browser: the managed runner (RunnerManager), the session token, the pre-flight
checks, the stop sentinel and Shut Down Server. subprocess.Popen is always a fake: no browser, no run."""
import asyncio
import io
import json
import os
import subprocess
import sys
import threading
import time

import pytest

import agent_runner
import app_server
import config
import run_state
from tests.test_dedup import make_tracker

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

RUN_KEYS = {"running", "stop_requested", "pid", "started_at", "last_exit_code", "excel_locked", "paused", "logs"}


class FakeProc:
    """What subprocess.Popen returns: a pid, a poll() that stays None while 'running', and stdout lines."""

    def __init__(self, lines=()):
        self.pid, self.returncode = 4242, None
        self.stdout = io.StringIO("".join(line + "\n" for line in lines))

    def poll(self):
        return self.returncode


class Spawner:
    """Records every Popen call; hands out FakeProcs."""

    def __init__(self, lines=()):
        self.calls, self.lines = [], lines

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        return FakeProc(self.lines)


@pytest.fixture
def home(tmp_path, monkeypatch):
    for name, value in {
        "BASE": tmp_path, "RUN_STATE_JSON": tmp_path / "run_state.json", "LOG_DIR": tmp_path / "logs",
        "UNBLOCK_JSON": tmp_path / "unblock_queue.json", "CUSTOM_ANSWERS_JSON": tmp_path / "custom_answers.json",
        "TRACKER_XLSX": tmp_path / "tracker.xlsx", "QUEUE_JSON": tmp_path / "job_queue.json",
        "UNCONFIRMED_CSV": tmp_path / "unconfirmed.csv", "PENDING_XLSX_JSON": tmp_path / "pending_xlsx.json",
        "LEDGER_CSV": tmp_path / "applied.csv",
    }.items():
        monkeypatch.setattr(config, name, value)
    (tmp_path / "logs" / "applications").mkdir(parents=True)
    make_tracker(tmp_path / "tracker.xlsx", [])
    monkeypatch.setattr(app_server, "tracker", app_server.TrackerCache())
    monkeypatch.setattr(app_server, "excel_locked", lambda path=None: False)
    return tmp_path


@pytest.fixture
def spawner(home, monkeypatch):
    spawn = Spawner(lines=["[10:00:01] starting", "[10:00:02] applying to Acme"])
    kills = []
    monkeypatch.setattr(app_server, "blitz", app_server.RunnerManager(
        popen=spawn, kill=kills.append, preflight=app_server.excel_preflight))
    spawn.kills = kills
    return spawn


def make_client(token=True):
    app = app_server.create_app()
    headers = {app_server.TOKEN_HEADER: app.state.session_token} if token else {}
    return TestClient(app, base_url="http://127.0.0.1:4760", headers=headers)


@pytest.fixture
def client(home, spawner):
    return make_client()


def post(c, path, body=None):
    return c.post(path, content=json.dumps({} if body is None else body), headers={"Content-Type": "application/json"})


def wait_for(predicate, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


# ---- 1. the session token ----------------------------------------------------------------------- #

def test_every_post_needs_the_session_token_and_the_page_carries_it(home, spawner, monkeypatch, tmp_path):
    bare = make_client(token=False)
    for path in ("/api/run/start", "/api/run/stop", "/api/run/force-stop", "/api/shutdown", "/api/blitz"):
        r = post(bare, path, {})
        assert r.status_code == 403 and "token" in r.json()["error"], path
    wrong = TestClient(app_server.create_app(), base_url="http://127.0.0.1:4760", headers={app_server.TOKEN_HEADER: "guess"})
    assert post(wrong, "/api/run/start", {}).status_code == 403
    assert not spawner.calls                                  # nothing was started by any of them
    assert bare.get("/api/run/status").status_code == 200     # reading is not a button press

    ui = tmp_path / "ui"
    ui.mkdir()
    (ui / "index.html").write_text("<!doctype html><html><head><title>x</title></head><body></body></html>")
    monkeypatch.setattr(app_server, "UI_DIR", ui)
    app = app_server.create_app()
    page = TestClient(app, base_url="http://127.0.0.1:4760").get("/")
    assert f'<meta name="mission-token" content="{app.state.session_token}">' in page.text
    assert page.headers["cache-control"] == "no-store"
    assert "access-control-allow-origin" not in page.headers   # CORS stays off


# ---- 2. the command, and the log in the status ------------------------------------------------------ #

def test_start_builds_the_runner_command_and_streams_its_output_into_the_status(client, spawner):
    r = post(client, "/api/run/start", {"limit": 5, "dedup_level": "company", "max_per_company": 2,
                                        "dry_run": True, "ats": "lever"})
    assert r.status_code == 200 and r.json()["running"] is True
    argv, kw = spawner.calls[0]
    assert argv == [sys.executable, "-u", str(app_server.CODE_DIR / "agent_runner.py"), "--local-blitz",
                    "--dedup-level", "company", "--max-per-company", "2", "--limit", "5", "--dry-run", "--ats", "Lever"]
    assert kw["stdout"] == subprocess.PIPE and kw["stderr"] == subprocess.STDOUT and kw["cwd"] == str(app_server.CODE_DIR)
    assert kw.get("shell") is None                            # a list, never a shell string
    if os.name == "nt":                                       # no black console window; Chrome still opens its own
        assert kw["creationflags"] & subprocess.CREATE_NO_WINDOW
    assert wait_for(lambda: len(client.get("/api/run/status").json()["logs"]) == 2)
    status = client.get("/api/run/status").json()
    assert set(status) == RUN_KEYS
    assert status["running"] is True and status["pid"] == 4242 and status["stop_requested"] is False
    assert status["logs"] == ["[10:00:01] starting", "[10:00:02] applying to Acme"]
    assert status["started_at"] and status["last_exit_code"] is None and status["excel_locked"] is False
    # the page's live-log stream reads the same lines from blitz.log
    assert (config.LOG_DIR / "blitz.log").read_text(encoding="utf-8").splitlines() == status["logs"]


def test_defaults_give_the_fixed_blitz_command_and_options_are_validated(client, spawner):
    assert post(client, "/api/run/start", {}).status_code == 200
    assert spawner.calls[0][0][-5:] == app_server.BLITZ_ARGS  # no limit, no dry run, no portal filter
    bad = [{"limit": 501}, {"limit": "ten"}, {"limit": True}, {"dedup_level": "everything"}, {"max_per_company": 0},
           {"max_per_company": 51}, {"max_per_company": True}, {"dry_run": "yes"}, {"ats": "taleo"}, {"ats": "lever; calc"}]
    fresh = app_server.RunnerManager(popen=spawner, kill=lambda pid: None)
    for body in bad:
        params, error = app_server.parse_run_params(body)
        assert params is None and error, body
    assert len(spawner.calls) == 1                            # none of the bad ones got near Popen
    assert fresh.status()["running"] is False
    assert app_server.parse_run_params({"ats": "All", "limit": ""})[0]["ats"] is None


def test_the_log_ring_buffer_is_bounded(home, monkeypatch):
    many = [f"line {i}" for i in range(app_server.LOG_RING + 80)]
    spawn = Spawner(lines=many)
    manager = app_server.RunnerManager(popen=spawn, kill=lambda pid: None)
    assert manager.start(dict(app_server.DEFAULT_RUN))[0] == 200
    assert wait_for(lambda: manager.logs and manager.logs[-1] == many[-1])
    assert len(manager.logs) == app_server.LOG_RING and manager.logs[0] == "line 80"


# ---- 3. one run at a time ------------------------------------------------------------------------- #

def test_a_second_start_while_running_is_refused_with_409(client, spawner):
    assert post(client, "/api/run/start", {"limit": 3}).status_code == 200
    again = post(client, "/api/run/start", {"limit": 3})
    assert again.status_code == 409 and "already" in again.json()["error"]
    assert post(client, "/api/blitz", {"action": "start"}).status_code == 409    # the older route too
    assert len(spawner.calls) == 1


# ---- 4. the tracker open in Excel ------------------------------------------------------------------ #

def test_start_is_refused_with_423_while_the_tracker_is_open_in_excel(client, spawner, monkeypatch):
    monkeypatch.setattr(app_server, "excel_locked", lambda path=None: True)
    assert client.get("/api/run/status").json()["excel_locked"] is True       # the page shows the red banner
    r = post(client, "/api/run/start", {"limit": 5})
    assert r.status_code == 423
    assert r.json()["error"] == "Close internship_tracker.xlsx in Excel first, then click Start Applying."
    assert not spawner.calls and not (config.LOG_DIR / "blitz.log").exists()
    monkeypatch.setattr(app_server, "excel_locked", lambda path=None: False)  # closed it: the same click now works
    assert post(client, "/api/run/start", {"limit": 5}).status_code == 200


def test_excel_lock_check_opens_r_plus_b_without_writing(tmp_path, monkeypatch):
    path = tmp_path / "t.xlsx"
    path.write_bytes(b"PK-stand-in")
    before = (path.read_bytes(), path.stat().st_mtime_ns)
    assert app_server.excel_locked(path) is False
    assert (path.read_bytes(), path.stat().st_mtime_ns) == before
    assert app_server.excel_locked(tmp_path / "missing.xlsx") is False

    real_open = type(path).open

    def locked(self, mode="r", *a, **k):
        if mode == "r+b":
            raise PermissionError(13, "The process cannot access the file because it is being used by another process")
        return real_open(self, mode, *a, **k)
    monkeypatch.setattr(type(path), "open", locked)
    assert app_server.excel_locked(path) is True


# ---- 5. stop after the current job, force stop, shut down ----------------------------------------------- #

def test_stop_leaves_the_sentinel_the_runner_honors_between_jobs_and_cleans_up_on_exit(client, spawner):
    assert post(client, "/api/run/stop").status_code == 409                    # nothing to stop yet
    post(client, "/api/run/start", {"limit": 10})
    assert run_state.read_control()["stop"] is False
    r = post(client, "/api/run/stop")
    assert r.status_code == 200 and run_state.read_control()["stop"] is True
    assert spawner.kills == []                                                 # graceful: nothing was killed
    assert client.get("/api/run/status").json()["stop_requested"] is True
    # the runner checks it between applications, so the one in progress finishes (and logs its receipt) first
    agent_runner._stop = False
    try:
        assert asyncio.run(agent_runner.hold_if_paused(poll_s=0.01)) is True
    finally:
        agent_runner._stop = False
    # and when the runner exits it removes its own flag, so the next run does not start already stopped
    run_state.runner_started([])
    run_state.runner_finished()
    assert run_state.read_control()["stop"] is False and run_state.read_runner() is None


def test_force_stop_ends_the_process_now(client, spawner):
    assert post(client, "/api/run/force-stop").status_code == 409
    post(client, "/api/run/start", {})
    r = post(client, "/api/run/force-stop")
    assert r.status_code == 200 and spawner.kills == [4242]


def test_shut_down_stops_our_runner_then_asks_the_server_to_exit(client, spawner, monkeypatch):
    done = threading.Event()
    monkeypatch.setattr(app_server, "_shutdown_hook", done.set)
    monkeypatch.setattr(app_server, "SHUTDOWN_GRACE_S", 0)
    monkeypatch.setattr(app_server, "_shutting_down", threading.Event())
    post(client, "/api/run/start", {})
    r = post(client, "/api/shutdown")
    assert r.status_code == 200 and r.json() == {"ok": True, "stopping_run": True}
    assert done.wait(5)
    assert spawner.kills == [4242] and run_state.read_control()["stop"] is False


def test_atexit_cleanup_ends_a_runner_that_is_still_going(home):
    kills = []
    manager = app_server.RunnerManager(popen=Spawner(), kill=kills.append)
    assert manager.terminate() is None and kills == []                         # nothing running: nothing to do
    manager.start(dict(app_server.DEFAULT_RUN))
    manager.terminate()
    assert kills == [4242]


# ---- the desktop launcher ---------------------------------------------------------------------------- #

def test_installer_finds_the_desktop_and_builds_a_silent_shortcut(tmp_path):
    import install_launcher as il
    one = tmp_path / "OneDrive" / "Desktop"
    plain = tmp_path / "Desktop"
    plain.mkdir()
    env = {"USERPROFILE": str(tmp_path), "OneDrive": str(tmp_path / "OneDrive")}
    assert il.desktop_dir(env, registry_lookup=lambda: None) == plain
    one.mkdir(parents=True)
    assert il.desktop_dir(env, registry_lookup=lambda: None) == one              # OneDrive\Desktop wins when it exists
    assert il.desktop_dir(env, registry_lookup=lambda: str(plain)) == plain      # the registry is authoritative
    assert il.startup_dir({"APPDATA": r"C:\Users\x\AppData\Roaming"}).name == "Startup"
    vbs = il.shortcut_script(r"C:\Desktop\SWE Internship Agent.lnk", r"C:\a b\Launch_Mission_Control.vbs", "/server-only")
    assert 'CreateShortcut("C:\\Desktop\\SWE Internship Agent.lnk")' in vbs
    assert '.TargetPath = "wscript.exe"' in vbs
    assert '"""C:\\a b\\Launch_Mission_Control.vbs"" /server-only"' in vbs        # quoted path, then the flag
    launcher = (app_server.CODE_DIR / "Launch_Mission_Control.vbs").read_text(encoding="utf-8")
    assert "127.0.0.1" in launcher and "4760" in launcher and "app_server.py" in launcher and "/server-only" in launcher
