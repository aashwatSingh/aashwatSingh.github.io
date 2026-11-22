"""Mission Control (FastAPI), the Unblock Queue, Unverified tracker rows, the receipt timeout and
concurrent writers to the shared files."""
import asyncio
import json
import threading

import pytest

import agent_runner
import app_server
import config
import dedup
import email_receipt_verifier as erv
import run_state
import tracker_sync
import unblock
from answers import load_custom_answers, remember_answers
from ats.base import MANUAL_REVIEW, ApplyResult
from dedup import Ledger, load_tracker_rows
from tests.test_dedup import make_tracker

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

JOB = {"id": "acme-1", "company": "Acme Robotics", "title": "SWE Intern", "ats": "Greenhouse",
       "url": "https://job-boards.greenhouse.io/acme/jobs/1", "locations": ["Austin, TX"]}
OTHER = [["Globex Corp", "Intern", "Summer 2027", "2026-09-03", "Rejected", None, None, None, None]]


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
    make_tracker(tmp_path / "tracker.xlsx", OTHER)
    monkeypatch.setattr(app_server, "tracker", app_server.TrackerCache())
    return tmp_path


@pytest.fixture
def client(home):
    app = app_server.create_app()
    # Every POST /api/* needs the session token the served page carries.
    return TestClient(app, base_url="http://127.0.0.1:4760", headers={app_server.TOKEN_HEADER: app.state.session_token})


def post(client, path, body, **headers):
    return client.post(path, content=json.dumps(body), headers={"Content-Type": "application/json", **headers})


# ---- the API -------------------------------------------------------------------------------- #

def test_state_has_the_goal_numbers_queue_and_activity(client, home):
    config.QUEUE_JSON.write_text(json.dumps([{"id": "a", "status": "pending"}, {"id": "b", "status": "pending"},
                                             {"id": "c", "status": "error"}, {"id": "d", "status": "applied"}]))
    (home / "logs" / "applications" / "x.json").write_text(json.dumps(
        {"when": "2026-11-20T10:00:00", "job": JOB, "status": "submitted", "reason": "confirmation page"}))
    unblock.add(JOB, "CAPTCHA", "challenge")
    r = client.get("/api/state")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    m = r.json()["metrics"]
    assert (m["applied"], m["inProgress"], m["failed"], m["blocked"], m["remaining"], m["target"]) == (1, 2, 1, 1, 499, 500)
    data = r.json()
    assert data["activity"][0]["company"] == "Acme Robotics" and data["unblock"][0]["kind"] == "captcha"


def test_guards_host_origin_content_type_and_size(client):
    assert client.get("/api/state", headers={"Host": "evil.example"}).status_code == 403
    assert client.post("/api/blitz", content="x").status_code == 415
    assert post(client, "/api/blitz", {"action": "pause"}, Origin="http://evil.example").status_code == 403
    big = {"action": "pause", "pad": "x" * (app_server.MAX_BODY + 10)}
    assert post(client, "/api/blitz", big).status_code == 413
    r = client.get("/")
    assert r.status_code == 200 and "default-src 'self'" in r.headers["content-security-policy"]
    assert client.get("/assets/..%2fcandidate_profile.json").status_code == 404


def test_batch_size_is_validated_and_passed_to_the_runner(client, home, monkeypatch):
    started = []

    class Proc:
        pid, returncode = 4242, None

        def poll(self):
            return self.returncode
    monkeypatch.setattr(app_server, "blitz_log_path", lambda: home / "logs" / "blitz.log")
    monkeypatch.setattr(app_server, "blitz", app_server.Blitz(popen=lambda a, **kw: started.append(a) or Proc(),
                                                              kill=lambda pid: None))
    for bad in (501, -1, "ten", 2.5, True, [5]):
        assert post(client, "/api/blitz", {"action": "start", "limit": bad}).status_code == 400, bad
    assert not started
    r = post(client, "/api/blitz", {"action": "start", "limit": 25})
    assert r.status_code == 200 and started[0][-7:] == [*app_server.BLITZ_ARGS, "--limit", "25"]
    assert client.get("/api/state").json()["blitz"]["limit"] == 25
    assert post(client, "/api/blitz", {"action": "pause"}).status_code == 200 and run_state.read_control()["paused"]
    assert post(client, "/api/blitz", {"action": "resume"}).status_code == 200 and not run_state.read_control()["paused"]


def test_log_stream_sends_the_recent_lines(client, home):
    (home / "logs" / "runner.log").write_text("[10:00] one\n\a[10:01] [ACTION REQUIRED] two\n", encoding="utf-8")
    with client.stream("GET", "/api/logs/stream?follow=0") as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        body = "".join(r.iter_text())
    assert [json.loads(l[6:]) for l in body.split("\n") if l.startswith("data: ")] == \
        ["[10:00] one", "[10:01] [ACTION REQUIRED] two"]


def test_log_stream_follows_new_lines_and_a_new_run(home):
    log = home / "logs" / "runner.log"
    log.write_text("old\n", encoding="utf-8")

    async def go():
        got = []
        stream = app_server.log_events(poll_s=0.01)
        async for event in stream:
            if event.startswith("data: ") and event != "data: {}\n\n":
                got.append(json.loads(event[6:].strip()))
            if event.startswith("event: ready"):
                with log.open("a", encoding="utf-8") as fh:
                    fh.write("new 1\nnew ")
                    fh.flush()
                    fh.write("2\n")
            if len(got) == 3:
                log.write_text("run 2\n", encoding="utf-8")          # truncated: a new run
            if len(got) == 4:
                break
        await stream.aclose()
        return got
    assert asyncio.run(asyncio.wait_for(go(), 10)) == ["old", "new 1", "new 2", "run 2"]


# ---- the Unblock Queue ------------------------------------------------------------------------ #

def test_one_open_item_per_posting_and_retry_runs_it_once(client, home):
    first = unblock.add(JOB, "UNANSWERED_REQUIRED", "Badge", ["Initech badge number"])
    again = unblock.add(JOB, "CAPTCHA", "challenge")
    assert again["id"] == first["id"] and len(unblock.items()) == 1 and unblock.items()[0]["kind"] == "captcha"
    assert post(client, f"/api/unblock/{first['id']}", {"action": "retry"}).status_code == 200
    assert post(client, f"/api/unblock/{first['id']}", {"action": "retry"}).status_code == 409
    taken = unblock.take_requeued()
    assert [t["job"]["id"] for t in taken] == ["acme-1"] and unblock.take_requeued() == []
    assert post(client, "/api/unblock/nothex", {"action": "retry"}).status_code == 400
    assert post(client, f"/api/unblock/{'0' * 12}", {"action": "retry"}).status_code == 404
    assert post(client, f"/api/unblock/{first['id']}", {"action": "rm"}).status_code == 400


def test_answers_typed_in_the_dashboard_are_learned_and_the_posting_retried(client, home):
    item = unblock.add(JOB, "UNANSWERED_REQUIRED", "", ["Initech badge number", "Initech hat size"])
    assert post(client, f"/api/unblock/{item['id']}", {"action": "resume", "answers": {}}).status_code == 400
    assert post(client, f"/api/unblock/{item['id']}",
                {"action": "resume", "answers": {"Not a question on this item": "x"}}).status_code == 400
    r = post(client, f"/api/unblock/{item['id']}",
             {"action": "resume", "answers": {"Initech badge number": " 4417 ", "Initech hat size": ""}})
    assert r.status_code == 200 and r.json()["learned"] == 1
    assert [(e["pattern"], e["answer"]) for e in load_custom_answers()] == [(r"^initech\ badge\ number$", "4417")]
    assert unblock.items()[0]["status"] == unblock.REQUEUED


def test_missing_receipt_flags_the_tracker_then_confirm_or_retry(client, home):
    ledger = Ledger(config.TRACKER_XLSX, config.LEDGER_CSV)
    assert ledger.record_unverified(JOB, "confirmation page")
    rows = load_tracker_rows(config.TRACKER_XLSX)
    assert rows[-1]["Current Status"] == config.UNVERIFIED_STATUS and JOB["url"] in rows[-1]["Next Step / Notes"]
    s = tracker_sync.summary(config.TRACKER_XLSX)
    assert (s["total"], s["unverified"], s["remaining"]) == (2, 1, 498)       # a row is a row: counted, and flagged
    assert Ledger(config.TRACKER_XLSX, config.LEDGER_CSV).duplicate_reason(JOB, "role") is None   # can be retried

    item = unblock.add(JOB, "UNCONFIRMED", "no e-mail")
    other = unblock.add({**JOB, "id": "q"}, "CAPTCHA")
    assert post(client, f"/api/unblock/{other['id']}", {"action": "confirm"}).status_code == 409
    assert post(client, f"/api/unblock/{item['id']}", {"action": "confirm"}).status_code == 200
    row = load_tracker_rows(config.TRACKER_XLSX)[-1]
    assert row["Current Status"] == config.XLSX_APPLIED_STATUS and "Confirmed submitted" in row["Next Step / Notes"]
    assert len(load_tracker_rows(config.TRACKER_XLSX)) == 2
    assert tracker_sync.summary(config.TRACKER_XLSX)["total"] == 2

    job2 = {**JOB, "id": "acme-2", "url": "https://job-boards.greenhouse.io/acme/jobs/2", "title": "Data Intern"}
    ledger.record_unverified(job2)
    item2 = unblock.add(job2, "UNCONFIRMED")
    assert post(client, f"/api/unblock/{item2['id']}", {"action": "retry"}).status_code == 200
    assert [r["Current Status"] for r in load_tracker_rows(config.TRACKER_XLSX)] == \
        ["Rejected", config.XLSX_APPLIED_STATUS]                              # its Unverified row is gone


def test_confirm_adds_a_row_when_the_unverified_one_was_never_written(home):
    unblock.confirm_in_tracker(JOB)
    row = load_tracker_rows(config.TRACKER_XLSX)[-1]
    assert (row["Company"], row["Current Status"]) == ("Acme Robotics", config.XLSX_APPLIED_STATUS)


def test_a_locked_workbook_is_reported_not_swallowed(client, home, monkeypatch):
    item = unblock.add(JOB, "UNCONFIRMED")

    def locked(job):
        raise TimeoutError("busy")
    monkeypatch.setattr(unblock, "confirm_in_tracker", locked)
    r = post(client, f"/api/unblock/{item['id']}", {"action": "confirm"})
    assert r.status_code == 423 and "Excel" in r.json()["error"] and unblock.items()[0]["status"] == unblock.OPEN


# ---- the runner side ------------------------------------------------------------------------- #

def test_runner_pushes_blockers_with_only_the_questions_still_open(home):
    result = ApplyResult(MANUAL_REVIEW, "UNANSWERED_REQUIRED", "x", unknowns=["Badge", "Hat", "Badge"],
                         learned=[{"label": "Hat", "value": "M"}])
    agent_runner.push_blocker(JOB, result)
    agent_runner.push_blocker({**JOB, "id": "z"}, ApplyResult(MANUAL_REVIEW, "UNSUPPORTED_ATS", "x"))
    assert [(i["job"]["id"], i["questions"]) for i in unblock.items()] == [("acme-1", ["Badge"])]


def test_requeued_postings_become_pending_again(home):
    queue = [dict(JOB, status="manual_review"), {"id": "b", "status": "pending"}]
    item = unblock.add(JOB, "CAPTCHA")
    unblock.resolve(item["id"], "retry")
    back = agent_runner.apply_requeued(queue, unblock.take_requeued())
    assert back == [queue[0]] and queue[0]["status"] == "pending"
    unblock.finished("acme-1")
    assert unblock.items() == []


def test_receipt_timeout_flags_and_moves_on_by_default(home):
    class Gate:
        otp = False

        def step(self, step, message="", **extra):
            run_state.update(JOB, step, message, **extra)

        async def wait(self, context, company, timeout):
            return dict(erv.NOT_CONFIRMED)

    async def nobody(job):
        raise AssertionError("queue mode does not stop the batch to ask")
    out = asyncio.run(agent_runner.confirm_receipt(Gate(), None, JOB, attended=True, ask=nobody, timeout=90))
    assert out == (agent_runner.UNCONFIRMED, {})
    state = run_state.read()
    assert state["step"] == run_state.UNCONFIRMED and "Unblock Queue" in state["message"]


@pytest.mark.parametrize("value, expected", [(None, 120), ("90", 90), ("5", 30), ("9999", 600), ("abc", 120)])
def test_receipt_timeout_comes_from_env_and_is_clamped(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv("RECEIPT_TIMEOUT_S", raising=False)
    else:
        monkeypatch.setenv("RECEIPT_TIMEOUT_S", value)
    assert config.receipt_timeout_s() == expected


# ---- concurrent writers ---------------------------------------------------------------------- #

def _together(fn, n):
    threads = [threading.Thread(target=fn, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


def test_concurrent_learned_answers_are_all_kept(home):
    _together(lambda i: remember_answers([{"label": f"Question {i}", "kind": "text", "value": str(i)}], "Acme"), 12)
    assert sorted(int(e["answer"]) for e in load_custom_answers()) == list(range(12))
    assert json.loads((home / "custom_answers.backup.json").read_text())        # the copy is valid JSON too


def test_concurrent_unblock_items_are_all_kept(home):
    _together(lambda i: unblock.add({**JOB, "id": f"job-{i}"}, "CAPTCHA"), 12)
    assert len(unblock.items()) == 12


def test_concurrent_tracker_writes_lose_no_row(home):
    _together(lambda i: dedup.append_to_tracker_xlsx(
        {"Company": f"Co {i}", "Role": "Intern", "Current Status": config.XLSX_APPLIED_STATUS}, config.TRACKER_XLSX), 6)
    names = [r["Company"] for r in load_tracker_rows(config.TRACKER_XLSX)]
    assert sorted(names[1:]) == sorted(f"Co {i}" for i in range(6)) and names[0] == "Globex Corp"
    assert not list(home.glob("*.lock")) and not list(home.glob("*.tmp*"))
