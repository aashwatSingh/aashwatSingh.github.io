"""Regression tests for one batch of verified bugs:

1. human waits are exempt from FreezeWatchdog, and a cancelled posting closes its confirmation tab
2. Workday read_value for search and date widgets
3. Ashby: only the candidate's own location uses the home-address lookup
4. fresh .env per run, the "Now" box after a dry run, the moved screenshot in the Unblock Queue
5. Workday auth tightening, lazy dropdown options on the phone, Lever's per-page parse state
"""
import argparse
import asyncio
import json
import os
import time
import types
from pathlib import Path

import pytest
from playwright.async_api import async_playwright

import agent_runner
import app_server
import config
import phone_notify
import run_state
import unblock
from answers import Question
from ats import workday_auth as wa
from ats.ashby import AshbyAdapter
from ats.base import MANUAL_REVIEW, SUBMITTED, ApplyResult, FormField, SubmitWatch
from ats.greenhouse import GreenhouseAdapter
from ats.lever import LeverAdapter
from ats.workday import WorkdayAdapter
from phone_notify import FreezeWatchdog
from tests.test_assist import PROFILE, home, run                                       # noqa: F401 - fixture
from tests.test_captcha_solver import TOKEN, page_of, quick_waits, widget, with_page    # noqa: F401 - fixture
from tests.test_portal_submit import workday_apply, workday_html
from tests.test_workday_auth import (ME, HOST, PAGE_URL, VERIFY_URL, FakeNotifier, Workday, clean,   # noqa: F401
                                     drive, saved)

JOB = {"id": "acme-1", "company": "Acme Robotics", "title": "SWE Intern", "ats": "Greenhouse",
       "url": "https://job-boards.greenhouse.io/acme/jobs/1", "locations": ["Austin, TX"]}


def watchdog_is_out_of_the_way() -> bool:
    state = run_state.read()
    return FreezeWatchdog.exempt(state) and str(state.get("message", "")).startswith("Waiting for you")


# ---- 1. human waits keep FreezeWatchdog out of the way -------------------------------------------- #

def test_waiting_for_you_exempts_the_watchdog_and_keeps_the_rest_of_the_state(home):
    run_state.update(JOB, run_state.SUBMITTING, "Filling the form", otp=True, captchas=2)
    assert not FreezeWatchdog.exempt(run_state.read())
    run_state.waiting_for_you("Solve the CAPTCHA")
    state = run_state.read()
    assert state["message"] == "Waiting for you: Solve the CAPTCHA" and FreezeWatchdog.exempt(state)
    assert state["step"] == run_state.SUBMITTING and state["job"]["id"] == "acme-1"
    assert state["otp"] is True and state["captchas"] == 2
    run_state.waiting_for_you("Waiting for you to solve the CAPTCHA")
    assert run_state.read()["message"] == "Waiting for you to solve the CAPTCHA"      # no doubled prefix


def test_submit_watch_human_gate_marks_the_wait(home):
    attended = SubmitWatch(types.SimpleNamespace(human_wait_s=60), 30)
    run_state.update(JOB, run_state.SUBMITTING, "Submitting")
    assert attended.human_gate("CAPTCHA", "a CAPTCHA is showing") is None
    assert watchdog_is_out_of_the_way()
    run_state.update(JOB, run_state.SUBMITTING, "Submitting")
    unattended = SubmitWatch(types.SimpleNamespace(human_wait_s=0), 30)
    assert unattended.human_gate("CAPTCHA", "x")[0] == MANUAL_REVIEW             # no one to wait for
    assert not FreezeWatchdog.exempt(run_state.read())


def test_the_captcha_manual_wait_marks_itself(home):
    async def go(page):
        from ats import captcha_solver as cs
        run_state.update(JOB, run_state.SUBMITTING, "Submitting")
        task = asyncio.create_task(cs.detect_and_solve_captcha(page, manual_timeout_s=30))      # no on_status wired
        await page.wait_for_selector("#ia-captcha-badge", timeout=10000)
        exempt = watchdog_is_out_of_the_way()
        await page.evaluate(f"document.querySelector('[name=g-recaptcha-response]').value = '{TOKEN}'")
        await asyncio.wait_for(task, 5)
        return exempt
    assert with_page(page_of(widget(accept=False, challenge=True)), go) is True


def test_the_workday_hand_over_marks_the_wait_before_it_polls_discord(home):
    seen = []

    async def on_poll(phone):
        seen.append(watchdog_is_out_of_the_way())

    phone = FakeNotifier(replies=["!skip"], on_poll=on_poll)
    result, _ = run(drive(Workday(create="exists"), allow_manual=True, notifier=phone))
    assert result.skipped and seen and all(seen)


def test_the_workday_manual_sign_in_wait_marks_itself(home):
    seen = []

    async def go():
        a = WorkdayAdapter()
        a.human_wait_s, a.try_sign_in = 5, False

        async def moved(page, previous, seconds, stop_on_errors=False):
            seen.append(watchdog_is_out_of_the_way())
            return "My Information"
        a._wait_step_change = moved
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            context = await browser.new_context()
            await context.route("**/*", Workday().serve)
            page = await context.new_page()
            await page.goto(PAGE_URL)
            try:
                return await a._authenticate(page, {"identity": {"email": ME}}, HOST, False, JOB)
            finally:
                await browser.close()
    assert run(go()) is None and seen == [True]


def test_the_workday_review_wait_marks_itself(home, monkeypatch):
    heard, real = [], WorkdayAdapter.confirmed
    orig = run_state.waiting_for_you
    monkeypatch.setattr(run_state, "waiting_for_you", lambda m: (heard.append(m), orig(m)))

    async def confirmed(self, page):                      # the candidate clicks Submit once the wait has started
        return "thank you for applying" if any("click Submit" in m for m in heard) else await real(self, page)
    monkeypatch.setattr(WorkdayAdapter, "confirmed", confirmed)
    result, _, _ = run(workday_apply(workday_html(review_error=True), home, wait=1))
    assert result.status == SUBMITTED and result.reason == "submitted by the candidate after review"
    assert any("click Submit" in m for m in heard)


class Tab:
    def __init__(self):
        self.closed = False

    def is_closed(self):
        return self.closed

    async def close(self):
        self.closed = True


class Gate:
    def start(self, job):
        pass

    async def snapshot(self, context):
        return ""


def test_a_posting_cancelled_by_the_watchdog_closes_its_confirmation_tab(home):
    tab = Tab()

    async def apply(context, job, engine, ledger, **kw):
        return ApplyResult(SUBMITTED, "ok", page=tab)

    async def confirm(gate, context, job, *, attended, timeout):     # waiting for the e-mail; the watchdog cancels
        await asyncio.sleep(60)

    async def go():
        task = asyncio.create_task(agent_runner.submit_and_confirm(
            None, JOB, None, None, Gate(), use_llm=False, attended=False, apply=apply, confirm=confirm))
        await asyncio.sleep(0.2)
        assert not tab.closed
        task.cancel()                                                # what FreezeWatchdog.guard does
        with pytest.raises(asyncio.CancelledError):
            await task
    run(go())
    assert tab.closed


def test_submit_and_confirm_still_returns_normally_and_leaves_one_closed_tab(home):
    tab = Tab()

    async def apply(context, job, engine, ledger, **kw):
        return ApplyResult(SUBMITTED, "ok", page=tab)

    async def confirm(gate, context, job, *, attended, timeout):
        return agent_runner.CONFIRMED, {"confirmed": True}
    result, outcome, _ = run(agent_runner.submit_and_confirm(
        None, JOB, None, None, Gate(), use_llm=False, attended=False, apply=apply, confirm=confirm))
    assert outcome == agent_runner.CONFIRMED and tab.closed


# ---- 2. Workday read_value: search and date widgets ------------------------------------------------------------ #

DATE_HTML = """
<div id="when" data-automation-id="formField-startDate">
  <input id="m" data-automation-id="dateSectionMonth-input"><input id="d" data-automation-id="dateSectionDay-input">
  <input id="y" data-automation-id="dateSectionYear-input"></div>
<div id="monthyear" data-automation-id="formField-from">
  <input id="m2" data-automation-id="dateSectionMonth-input"><input id="y2" data-automation-id="dateSectionYear-input"></div>
<div id="school" data-automation-id="formField-school"><div data-automation-id="multiSelectContainer"><input></div>
  <div data-automation-id="selectedItem">University of Texas at Dallas</div>
  <div data-automation-id="selectedItem" style="display:none">A hidden chip</div></div>
<div id="skills" data-automation-id="formField-skills">
  <div data-automation-id="selectedItem">Python</div><div data-automation-id="selectedItem">SQL</div></div>
<div id="empty" data-automation-id="formField-empty"><div data-automation-id="multiSelectContainer"><input></div></div>
"""


def read(page_fn):
    async def go():
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            page = await browser.new_page()
            await page.set_content(DATE_HTML)
            try:
                return await page_fn(WorkdayAdapter(), page)
            finally:
                await browser.close()
    return run(go())


def field(sel, widget):
    return FormField(Question(label=sel.strip("#"), kind="text"), sel, widget, {})


def test_workday_date_is_read_as_iso_only_once_every_box_is_filled():
    async def go(a, page):
        f, out = field("#when", "date"), []
        out.append(await a.read_value(page, f))                       # nothing typed
        await page.fill("#m", "6")
        out.append(await a.read_value(page, f))                       # a month only: not a date yet
        await page.fill("#d", "15")
        out.append(await a.read_value(page, f))                       # still no year
        await page.fill("#y", "20")
        out.append(await a.read_value(page, f))                       # a year being typed
        await page.fill("#y", "2026")
        out.append(await a.read_value(page, f))
        await page.fill("#m", "06")
        out.append(await a.read_value(page, f))                       # "6" and "06" are the same month
        await page.fill("#m2", "3")
        await page.fill("#y2", "2027")
        out.append(await a.read_value(page, field("#monthyear", "date")))   # a month/year widget has no day box
        return out
    assert read(go) == [None, None, None, None, "2026-06-15", "2026-06-15", "2027-03"]


def test_workday_search_widget_is_read_from_its_selected_item():
    async def go(a, page):
        return [await a.read_value(page, field(sel, "search")) for sel in ("#school", "#skills", "#empty")]
    assert read(go) == ["University of Texas at Dallas", ["Python", "SQL"], None]      # hidden chips never count


# ---- 3. Ashby: office preference is an ordinary dropdown ------------------------------------------------------ #

class Option:
    def __init__(self, bag, text):
        self.bag, self.text = bag, text

    async def inner_text(self):
        return self.text

    async def click(self):
        self.bag.clicked = self.text


class Options:
    def __init__(self):
        self.texts, self.clicked = [], None

    async def count(self):
        return len(self.texts)

    def nth(self, i):
        return Option(self, self.texts[i])


ADDRESS = {"address": {"city": "Frisco", "state": "Texas", "state_abbr": "TX"}}


def ashby_pick(label, value, *, field_id="", offered=None):
    a, bag, typed_calls = AshbyAdapter(), Options(), []

    async def options(page, f, typed=None):
        typed_calls.append(typed)
        bag.texts = offered(typed) if offered else []
        return bag.texts
    a._options = options
    page = types.SimpleNamespace(locator=lambda sel: bag)
    f = FormField(Question(label=label, kind="select", field_id=field_id), "#x", "combobox", {})
    run(a.fill(page, f, value, ADDRESS))
    return bag.clicked, typed_calls


def test_ashby_office_preference_selects_the_given_value_not_the_home_address():
    offices = lambda typed: ["Austin Office", "Dallas Office"]
    for label in ("Preferred office location?", "Which office location would you prefer?",
                  "Based on your skills, which location do you want?"):
        clicked, typed = ashby_pick(label, "Dallas Office", offered=offices)
        assert clicked == "Dallas Office" and typed == [None], label            # no "Frisco, TX" lookup


def test_ashby_candidates_own_location_still_uses_the_home_address_lookup():
    cities = lambda typed: ["Frisco, Texas, United States"] if typed else []
    for label, fid in (("Location", ""), ("Current location", ""), ("Where are you currently located?", ""),
                       ("Where are you based?", ""), ("Anything at all", "_systemfield_location")):
        clicked, typed = ashby_pick(label, "ignored", field_id=fid, offered=cities)
        assert clicked == "Frisco, Texas, United States" and typed == ["Frisco, TX"], label


# ---- 4. a fresh .env per run, the "Now" box, the moved screenshot ----------------------------------------------- #

def test_read_dotenv_reads_fresh_and_load_dotenv_still_lets_the_environment_win(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("# comment\nWORKDAY_PASSWORD='Fresh#Pass1'\nexport DISCORD_BOT_TOKEN=abc\n\nbad line\nEMPTY=\n")
    assert config.read_dotenv(env) == {"WORKDAY_PASSWORD": "Fresh#Pass1", "DISCORD_BOT_TOKEN": "abc", "EMPTY": ""}
    assert config.read_dotenv(tmp_path / "missing") == {}
    monkeypatch.setenv("WORKDAY_PASSWORD", "from-the-shell")
    monkeypatch.delenv("DISCORD_BOT_TOKEN", raising=False)
    config.load_dotenv(env)
    assert os.environ["WORKDAY_PASSWORD"] == "from-the-shell" and os.environ["DISCORD_BOT_TOKEN"] == "abc"
    monkeypatch.delenv("DISCORD_BOT_TOKEN", raising=False)


def test_each_run_starts_with_the_current_env_file_even_though_the_server_did_not_restart(tmp_path, monkeypatch):
    for name, value in {"BASE": tmp_path, "RUN_STATE_JSON": tmp_path / "run_state.json", "LOG_DIR": tmp_path / "logs"}.items():
        monkeypatch.setattr(config, name, value)
    monkeypatch.setenv("WORKDAY_PASSWORD", "Stale#Pass1")                # what the long-running server started with
    monkeypatch.setenv("UNRELATED_SETTING", "kept")
    envs = []

    class Proc:
        pid, returncode, stdout = 4242, None, None

        def poll(self):
            return self.returncode
    manager = app_server.RunnerManager(popen=lambda argv, **kw: envs.append(kw["env"]) or Proc(), kill=lambda pid: None)
    (tmp_path / ".env").write_text("WORKDAY_PASSWORD=Fresh#Pass1\nDISCORD_BOT_TOKEN=tok1\n")
    assert manager.start(dict(app_server.DEFAULT_RUN))[0] == 200
    assert envs[0]["WORKDAY_PASSWORD"] == "Fresh#Pass1" and envs[0]["DISCORD_BOT_TOKEN"] == "tok1"
    assert envs[0]["UNRELATED_SETTING"] == "kept" and envs[0]["PYTHONUNBUFFERED"] == "1"
    manager.proc.returncode = 0                                          # that run ended
    (tmp_path / ".env").write_text("WORKDAY_PASSWORD=Newest#Pass2\n")
    assert manager.start(dict(app_server.DEFAULT_RUN))[0] == 200
    assert envs[1]["WORKDAY_PASSWORD"] == "Newest#Pass2"                 # edited between runs: picked up


class FakeLedger:
    total, pending_xlsx = 0, []

    def __init__(self):
        self.unconfirmed = []

    def write_csv(self):
        pass

    def duplicate_reason(self, job, level):
        return None

    def reconcile_xlsx(self):
        return 0

    def flush_pending_xlsx(self):
        pass

    def record_unconfirmed(self, job, detail):
        self.unconfirmed.append(detail)

    def record_unverified(self, job, detail):
        return True


class FakeBrowser:
    pages = []

    def set_default_timeout(self, ms):
        pass

    async def close(self):
        pass


class FakePlaywright:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def run_the_runner(tmp_path, monkeypatch, *, dry_run, jobs, outcome=None):
    """agent_runner.run() with no browser, no network and no real tracker."""
    for name, value in {"BASE": tmp_path, "RUN_STATE_JSON": tmp_path / "run_state.json", "LOG_DIR": tmp_path / "logs",
                        "MANUAL_REVIEW_DIR": tmp_path / "review", "SUBMITTED_DIR": tmp_path / "submitted",
                        "CACHE_DIR": tmp_path / "cache", "UNBLOCK_JSON": tmp_path / "unblock.json",
                        "CUSTOM_ANSWERS_JSON": tmp_path / "custom.json", "QUEUE_JSON": tmp_path / "queue.json"}.items():
        monkeypatch.setattr(config, name, value)
    resume = tmp_path / "resume.pdf"
    resume.write_bytes(b"%PDF")
    monkeypatch.setattr(config, "load_profile", lambda: dict(PROFILE, resume_path=str(resume)))
    monkeypatch.setattr(phone_notify, "_shared", phone_notify.DiscordNotifier("", "", ""))
    ledger = FakeLedger()
    monkeypatch.setattr(agent_runner.dedup, "Ledger", lambda: ledger)
    queue = [dict(j) for j in jobs] or [dict(JOB, id="not-selected")]       # a non-empty queue: no listing refresh
    monkeypatch.setattr(agent_runner.dedup, "load_queue", lambda: queue)
    monkeypatch.setattr(agent_runner.dedup, "filter_queue", lambda q, *a: (q, None))
    monkeypatch.setattr(agent_runner.dedup, "save_queue", lambda q: None)
    monkeypatch.setattr(agent_runner.dedup, "backup_tracker", lambda: None)
    monkeypatch.setattr(agent_runner, "select_jobs", lambda q, args: list(q) if jobs else [])

    def no_network(*a, **kw):
        raise AssertionError("the runner tried to scrape the listing sources")
    monkeypatch.setattr(agent_runner.scraper, "scrape", no_network)
    monkeypatch.setattr(agent_runner, "log_tracker_report", lambda l: None)
    monkeypatch.setattr(agent_runner, "tracker_writable", lambda path=None: True)
    monkeypatch.setattr(agent_runner, "async_playwright", FakePlaywright)

    async def launch(pw, args):
        return FakeBrowser()
    monkeypatch.setattr(agent_runner, "launch_browser", launch)
    if outcome:
        async def submit(*a, **kw):
            return outcome
        monkeypatch.setattr(agent_runner, "submit_and_confirm", submit)
    for adapter in agent_runner.ADAPTERS.values():             # run() flips these on the shared adapters: restore them
        for attr in ("human_wait_s", "write_essays", "receipt_gate", "try_sign_in", "create_accounts"):
            monkeypatch.setattr(adapter, attr, getattr(adapter, attr, None), raising=False)
    args = argparse.Namespace(
        dry_run=dry_run, rescrape=False, crawl_boards=False, dedup_level="role", max_per_company=3, ats="Greenhouse",
        assist=0, no_essays=False, workday_create_accounts=False, workday_manual_sign_in=False, headed=False,
        target=500, max_minutes=0, profile_dir=str(tmp_path / "profile"), limit=0, only_url=None)
    monkeypatch.setattr(agent_runner, "_stop", False)
    run_state.update(None, "", "Blitz run starting (whole queue)...")
    assert run(agent_runner.run(args)) == 0
    return ledger


@pytest.mark.parametrize("dry_run, final", [(True, "Dry run finished"), (False, "Runner stopped")])
def test_the_now_box_never_stays_on_blitz_run_starting(tmp_path, monkeypatch, dry_run, final):
    run_the_runner(tmp_path, monkeypatch, dry_run=dry_run, jobs=[], )
    state = run_state.read()
    assert state["message"] == final and state["job"] is None and state["step"] == ""


def test_an_unconfirmed_submission_reaches_the_unblock_queue_with_the_moved_screenshot(tmp_path, monkeypatch):
    shot = tmp_path / "shots" / "acme-1.png"
    shot.parent.mkdir()
    shot.write_bytes(b"png")
    result = ApplyResult(SUBMITTED, "confirmation page", "thanks", screenshot=str(shot))
    ledger = run_the_runner(tmp_path, monkeypatch, dry_run=False, jobs=[JOB],
                            outcome=(result, agent_runner.UNCONFIRMED, {}))
    moved = tmp_path / "submitted" / "acme-1.png"
    assert moved.exists() and not shot.exists()                     # the file was moved out of the old place
    items = [i for i in unblock.items() if i.get("kind") == "receipt"]
    assert len(items) == 1 and items[0]["screenshot"] == str(moved)  # and the queue points at where it is now
    assert Path(items[0]["screenshot"]).exists() and ledger.unconfirmed


# ---- 5. Workday auth tightening ---------------------------------------------------------------------------------- #

class TempTab:
    def __init__(self, fail):
        self.fail, self.closed = fail, False

    async def goto(self, url, **kw):
        if self.fail:
            raise RuntimeError("net::ERR_CONNECTION_RESET")

    async def wait_for_timeout(self, ms):
        pass

    async def close(self):
        self.closed = True


def test_a_verification_link_that_does_not_open_is_not_a_verification():
    for fail, expected in ((True, False), (False, True)):
        tab = TempTab(fail)
        page = types.SimpleNamespace(context=types.SimpleNamespace(new_page=lambda tab=tab: asyncio.sleep(0, tab)))
        ok = run(wa._verify_by_mail(page, {"identity": {"email": ME}}, HOST, "Acme", time.time(),
                                    fetch_link=lambda *a: VERIFY_URL))
        assert ok is expected and tab.closed


class RefusesTheLink(Workday):
    async def serve(self, route):
        if route.request.url == VERIFY_URL:
            return await route.abort()
        return await super().serve(route)


def test_a_verification_link_that_fails_never_marks_the_tenant_verified(monkeypatch):
    server = RefusesTheLink(create="verify")
    result, _ = run(drive(server))
    assert not result.ok and server.verify_hits == 0
    assert saved()[HOST]["status"] != "verified"


class PolicyRejection(Workday):
    def create(self, data):
        self.creates.append(data)
        return {"status": "error", "error": "Password must not contain your name or e-mail."}


class NoCreateLink(Workday):
    def page(self):
        return super().page().replace('<a href="#" data-automation-id="createAccountLink">Create Account</a>', "")


@pytest.mark.parametrize("server_cls", [PolicyRejection, NoCreateLink])
def test_an_unclear_create_account_hands_over_without_marking_the_tenant(server_cls, monkeypatch):
    monkeypatch.setattr(wa, "CREATE_WAIT_S", 1.5)
    server = server_cls()
    result, _ = run(drive(server))
    assert not result.ok and result.reason == "WORKDAY_ACCOUNT" and result.status == ""
    assert len(server.signins) == 1                                  # still exactly one Sign In
    assert not (config.BASE / "workday_accounts.json").exists()      # nothing says an account exists here


def test_an_account_that_already_exists_still_marks_the_tenant_manual_auth():
    result, _ = run(drive(Workday(create="exists")))
    assert result.status == wa.MANUAL_AUTH and saved()[HOST]["status"] == "manual_auth"


# ---- 5. lazy dropdown options reach the phone --------------------------------------------------------------------- #

class AskingPhone:
    def __init__(self):
        self.asked = []

    def ask_question(self, company, role, ats, info, shot):
        self.asked.append(info)


class NoHighlight:
    async def screenshot(self, **kw):
        raise RuntimeError("no highlighted field")


class ShotPage:
    def locator(self, sel):
        return types.SimpleNamespace(first=NoHighlight())

    async def screenshot(self, **kw):
        return b"png"


def ask(lazy, options, reader):
    a = GreenhouseAdapter()
    a.read_options = reader
    f = FormField(Question(label="Which office?", kind="select", options=options), "#x", "select", {"lazy_options": lazy})
    phone = AskingPhone()
    run(a._phone_ask(ShotPage(), phone, JOB, f))
    return phone.asked[0], f


def test_a_lazy_dropdown_shows_numbered_choices_on_the_phone():
    async def offices(page, f):
        return ["Austin", "Dallas"]
    info, f = ask(True, [], offices)
    assert info["options"] == ["Austin", "Dallas"] and f.question.options == ["Austin", "Dallas"]


def test_lazy_options_are_not_read_when_known_or_not_lazy_and_a_failure_is_harmless():
    async def boom(page, f):
        raise RuntimeError("widget quirk")
    assert ask(True, [], boom)[0]["options"] == []                    # still asks, without a list
    assert ask(True, ["Yes", "No"], boom)[0]["options"] == ["Yes", "No"]
    assert ask(False, [], boom)[0]["options"] == []


# ---- 5. Lever: per-page parser state ------------------------------------------------------------------------------- #

class UploadPage:
    def __init__(self):
        self.handlers, self.uploads = [], []

    def on(self, event, handler):
        self.handlers.append(event)

    async def set_input_files(self, sel, value):
        self.uploads.append((sel, value))


def test_lever_forgets_page_state_for_a_new_posting():
    a = LeverAdapter()
    a._st(UploadPage())["intended"]["name"] = "x"
    assert a.__dict__["_lever_pages"]
    a.reset_captchas()
    assert a.__dict__["_lever_pages"] == {}


def test_a_second_upload_on_the_same_page_keeps_the_parse_watch_and_the_intended_values():
    a, page, calls = LeverAdapter(), UploadPage(), []

    async def await_parse(p, st):
        calls.append("parse")

    async def clear_org(p, st):
        calls.append("org")
    a._await_parse, a._clear_org = await_parse, clear_org
    resume = FormField(Question(label="Resume/CV", kind="file"), "#resume", "file", {})
    cover = FormField(Question(label="Cover letter", kind="file"), "#cover", "file", {})
    run(a.fill(page, resume, "resume.pdf", PROFILE))
    st = a._st(page)
    watch = st["watch"]
    st["intended"]["email"] = "me@example.edu"                       # what the form filler decided after the parse
    run(a.fill(page, cover, "cover.pdf", PROFILE))
    assert a._st(page) is st and st["watch"] is watch and st["intended"] == {"email": "me@example.edu"}
    assert len(page.handlers) == 3                                   # one ParseWatch (request / response / failed)
    assert calls == ["parse", "org"]                                 # the parse is awaited for the resume only
    assert [u[1] for u in page.uploads] == ["resume.pdf", "cover.pdf"]
