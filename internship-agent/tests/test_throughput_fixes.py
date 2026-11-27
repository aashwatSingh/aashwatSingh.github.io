"""Why the runner stopped submitting after Nov 20, and the fixes. Each test reproduces one cause and was
confirmed to fail on the code before the fix (commit bf9f9e4).

1. The queue was never refreshed: job_queue.json is only rebuilt with --rescrape or when it is empty, so
   every run drew from the same, shrinking list of postings scraped on Nov 11.
2. The resume path lived in candidate_profile.json; it is now one config value (RESUME_PDF).
3. Workday: a per-tenant, per-day cap of 2 Sign In clicks (and 1 Create Account) that survives restarts;
   a verification link that could not be read or opened leaves the tenant needs_verify, not manual_auth.
4. Answers: "current contractor for <company>?" and "current student ... or graduated within 12 months?".
5. A stale profile lock whose PID Windows has handed to another process no longer blocks every run.
6. The application log says when a submission had no confirmation e-mail.
7. A dry run names the Submit button it would click and the page it is on.
8. Wrong answers seen in the dry run of Nov 27: "highest education completed", a summer-availability question
   answered with the degree start date, "city and state of residence" answered with the school, and an
   "If no, ..." follow-up filled with an essay.
"""
import argparse
import json
import os
import time
from datetime import datetime, timedelta

import pytest

import agent_runner
import config
import dedup
import phone_notify
import run_state
from answers import AnswerEngine, Context, Question
from ats import workday_auth as wa
from ats.base import DRY_RUN_OK, SUBMITTED, ApplyResult
from tests.test_assist import PROFILE, run                                      # noqa: F401
from tests.test_fix_batch import FakeBrowser, FakeLedger, FakePlaywright
from tests.test_workday_auth import (HOST, ME, PASSWORD, Workday, clean, drive, home, saved)  # noqa: F401 - fixtures


# ---- 1. the queue is refreshed when it is stale or running dry ---------------------------------------------------- #

def job(n, status="pending", ats="Greenhouse", company=None):
    url = f"https://boards.greenhouse.io/acme{n}/jobs/{1000 + n}"
    return {"id": f"j{n}", "company": company or f"Acme {n}", "title": "Software Engineer Intern", "url": url,
            "ats": ats, "ats_job_id": str(1000 + n), "terms": ["Summer 2027"], "locations": ["Remote"],
            "status": status, "date_posted": 1_700_000_000 + n}


class EmptyLedger(FakeLedger):
    rows = []                                                           # nothing applied yet: dedup filters nothing


def drive_runner(tmp_path, monkeypatch, *, queue, scraped=None, scrape_error=None, refreshed_at=None, **overrides):
    """agent_runner.run() in dry-run mode, no browser: -> (postings attempted, times scrape() was called)."""
    for name, value in {"BASE": tmp_path, "RUN_STATE_JSON": tmp_path / "run_state.json", "LOG_DIR": tmp_path / "logs",
                        "MANUAL_REVIEW_DIR": tmp_path / "review", "SUBMITTED_DIR": tmp_path / "submitted",
                        "CACHE_DIR": tmp_path / "cache", "UNBLOCK_JSON": tmp_path / "unblock.json",
                        "CUSTOM_ANSWERS_JSON": tmp_path / "custom.json", "QUEUE_JSON": tmp_path / "queue.json"}.items():
        monkeypatch.setattr(config, name, value)
    resume = tmp_path / "resume.pdf"
    resume.write_bytes(b"%PDF")
    monkeypatch.setattr(config, "load_profile", lambda: dict(PROFILE, resume_path=str(resume)))
    monkeypatch.setattr(phone_notify, "_shared", phone_notify.DiscordNotifier("", "", ""))
    monkeypatch.setattr(agent_runner.dedup, "Ledger", lambda: EmptyLedger())
    monkeypatch.setattr(agent_runner.dedup, "backup_tracker", lambda: None)
    dedup.save_queue(queue, config.QUEUE_JSON)
    if refreshed_at is not None:
        config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
        os.makedirs(config.CACHE_DIR, exist_ok=True)
        (config.CACHE_DIR / "queue_refreshed.json").write_text(json.dumps({"at": refreshed_at}))
    calls = []

    def scrape(crawl=False):
        calls.append(crawl)
        if scrape_error:
            raise scrape_error
        return [dict(j) for j in (scraped or [])]
    monkeypatch.setattr(agent_runner.scraper, "scrape", scrape)
    monkeypatch.setattr(agent_runner, "log_tracker_report", lambda l: None)
    monkeypatch.setattr(agent_runner, "async_playwright", FakePlaywright)

    async def launch(pw, args):
        return FakeBrowser()
    monkeypatch.setattr(agent_runner, "launch_browser", launch)
    attempted = []

    async def apply_one(context, j, engine, ledger, **kw):
        attempted.append(j["id"])
        return ApplyResult(DRY_RUN_OK, "all required questions answered (not submitted)")
    monkeypatch.setattr(agent_runner, "apply_one", apply_one)
    for adapter in agent_runner.ADAPTERS.values():
        for attr in ("human_wait_s", "write_essays", "receipt_gate", "try_sign_in", "create_accounts"):
            monkeypatch.setattr(adapter, attr, getattr(adapter, attr, None), raising=False)
    args = dict(dry_run=True, rescrape=False, no_rescrape=False, crawl_boards=False, dedup_level="role",
                max_per_company=3, ats="Greenhouse,Ashby,Lever", assist=0, no_essays=False,
                workday_create_accounts=False, workday_manual_sign_in=False, headed=False, target=500, max_minutes=0,
                profile_dir=str(tmp_path / "profile"), limit=10, only_url=None, retry_manual=False,
                skip_logged_since=None, only_ready=False)
    args.update(overrides)
    monkeypatch.setattr(agent_runner, "_stop", False)
    assert run(agent_runner.run(argparse.Namespace(**args))) == 0
    return attempted, calls


def test_a_queue_scraped_long_ago_and_used_up_is_refreshed_and_the_new_postings_are_tried(tmp_path, monkeypatch):
    used_up = [job(n, status) for n, status in enumerate(["manual_review", "applied", "error", "closed"])]
    fresh = [job(50), job(51)]
    attempted, calls = drive_runner(tmp_path, monkeypatch, queue=used_up, scraped=fresh)   # never refreshed before
    assert calls == [False]                                             # the listing sources were read
    assert attempted == ["j51", "j50"]                                   # and the new postings tried, newest first
    saved_queue = {j["id"]: j["status"] for j in dedup.load_queue(config.QUEUE_JSON)}
    assert saved_queue["j0"] == "manual_review"                         # old statuses kept, nothing resurrected
    assert json.loads((config.CACHE_DIR / "queue_refreshed.json").read_text())["at"] > time.time() - 60


def test_a_recently_refreshed_queue_with_enough_postings_is_not_scraped_again(tmp_path, monkeypatch):
    queue = [job(n) for n in range(20)]
    attempted, calls = drive_runner(tmp_path, monkeypatch, queue=queue, refreshed_at=time.time() - 600)
    assert calls == [] and len(attempted) == 10


def test_a_recent_queue_that_has_fewer_postings_than_the_run_wants_is_topped_up(tmp_path, monkeypatch):
    queue = [job(1)]
    attempted, calls = drive_runner(tmp_path, monkeypatch, queue=queue, scraped=[job(70)], refreshed_at=time.time() - 600)
    assert calls == [False] and set(attempted) == {"j1", "j70"}


def test_a_failed_refresh_never_stops_the_run(tmp_path, monkeypatch):
    queue = [job(1), job(2)]
    attempted, calls = drive_runner(tmp_path, monkeypatch, queue=queue, scrape_error=OSError("network down"))
    assert calls == [False] and set(attempted) == {"j1", "j2"}           # the old queue is used
    assert not (config.CACHE_DIR / "queue_refreshed.json").exists()      # and the next run tries again


def test_no_rescrape_keeps_the_queue_as_it_is(tmp_path, monkeypatch):
    attempted, calls = drive_runner(tmp_path, monkeypatch, queue=[job(1)], scraped=[job(9)], no_rescrape=True)
    assert calls == [] and attempted == ["j1"]


def test_queue_refresh_is_on_by_default_on_the_command_line():
    parser_args = []
    real = agent_runner.asyncio.run
    try:
        agent_runner.asyncio.run = lambda coro: (parser_args.append(coro.cr_frame.f_locals["args"]), coro.close(), 0)[2]
        agent_runner.main(["--dry-run", "--limit", "1"])
    finally:
        agent_runner.asyncio.run = real
    assert parser_args[0].no_rescrape is False and parser_args[0].rescrape is False


# ---- 2. one config value for the resume ------------------------------------------------------------------------------- #

def test_the_resume_is_one_config_value_and_defaults_to_the_ats_resume(tmp_path, monkeypatch):
    monkeypatch.delenv("RESUME_PDF", raising=False)
    monkeypatch.setattr(config, "BASE", tmp_path)
    (tmp_path / "candidate_profile.json").write_text(json.dumps({"resume_path": "./Aashwat_Singh_SWE_Resume.pdf"}))
    assert config.RESUME_PDF_DEFAULT == "Aashwat_Singh_SWE_Resume_ATS.pdf"
    profile = config.load_profile(tmp_path / "candidate_profile.json")
    assert profile["resume_path"] == str(tmp_path / "Aashwat_Singh_SWE_Resume_ATS.pdf")   # not the profile's old file


def test_resume_pdf_in_env_overrides_the_default(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "BASE", tmp_path)
    monkeypatch.setenv("RESUME_PDF", "Other.pdf")
    (tmp_path / "candidate_profile.json").write_text("{}")
    assert config.load_profile(tmp_path / "candidate_profile.json")["resume_path"] == str(tmp_path / "Other.pdf")


def test_a_missing_resume_stops_the_run_and_names_the_file(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(config, "BASE", tmp_path)
    monkeypatch.delenv("RESUME_PDF", raising=False)
    monkeypatch.setattr(config, "PROFILE_PATH", tmp_path / "candidate_profile.json")
    (tmp_path / "candidate_profile.json").write_text("{}")
    args = argparse.Namespace(dry_run=True)
    assert run(agent_runner.run(args)) == 2
    err = capsys.readouterr().err
    assert "Aashwat_Singh_SWE_Resume_ATS.pdf" in err and "RESUME_PDF" in err


# ---- 3. Workday: attempts per tenant per day, and a failed verification is not manual_auth --------------------------- #

class NoAnswer(Workday):
    """Sign In gets no answer at all (no banner, no next page): nothing is learned, so nothing is marked."""

    def signin(self, data):
        self.signins.append(data)
        return {"ok": False, "error": ""}


def test_sign_in_is_clicked_at_most_twice_per_tenant_per_day_across_runs(monkeypatch):
    monkeypatch.setattr(wa, "SIGN_IN_WAIT_S", 1.5)
    server = NoAnswer()
    for _ in range(3):                                                  # three runs the same day
        wa._sign_in_clicks.clear()
        wa._create_clicks.clear()
        result, _ = run(drive(server))
        assert not result.ok
    assert len(server.signins) == 2
    log = json.loads((config.BASE / "workday_attempts.json").read_text())
    assert log[HOST]["sign_in"] == 2 and log[HOST]["date"] == datetime.now().strftime("%Y-%m-%d")


def test_the_daily_cap_resets_the_next_day():
    path = config.BASE / "workday_attempts.json"
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    path.write_text(json.dumps({HOST: {"date": yesterday, "sign_in": 2, "create": 1}}))
    server = Workday(create="created")
    result, _ = run(drive(server))
    assert result.ok and len(server.signins) == 1 and len(server.creates) == 1


class PolicyRejection(Workday):
    def create(self, data):
        self.creates.append(data)
        return {"status": "error", "error": "Password must not contain your name or e-mail."}


def test_an_unclear_create_account_is_not_retried_every_run(monkeypatch):
    monkeypatch.setattr(wa, "CREATE_WAIT_S", 1.5)
    server = PolicyRejection()
    for _ in range(3):
        wa._sign_in_clicks.clear()
        wa._create_clicks.clear()
        result, _ = run(drive(server))
        assert not result.ok
    assert len(server.creates) == 1 and len(server.signins) == 2
    assert not (config.BASE / "workday_accounts.json").exists()        # still nothing says an account exists


class LinkNeverArrives(Workday):
    pass


def test_a_verification_link_that_cannot_be_read_leaves_the_tenant_needs_verify(monkeypatch):
    monkeypatch.delenv("GMAIL_APP_PASSWORD", raising=False)              # no Gmail: the link cannot be read
    result, _ = run(drive(LinkNeverArrives(create="verify")))
    assert not result.ok
    assert saved()[HOST]["status"] == wa.NEEDS_VERIFY                    # not manual_auth: the next run tries again


def test_a_needs_verify_tenant_is_picked_up_again_with_the_original_mail(monkeypatch):
    server = Workday(create="verify")
    server.accounts[ME] = {"password": PASSWORD, "verified": False}
    wa.AccountRegistry().set(HOST, wa.NEEDS_VERIFY, ME)
    result, _ = run(drive(server))
    assert result.ok and server.verify_hits == 1 and saved()[HOST]["status"] == wa.VERIFIED


# ---- 4. answers ------------------------------------------------------------------------------------------------------- #

ENGINE = AnswerEngine(PROFILE, custom_answers=[])


@pytest.mark.parametrize("label", [
    "Are you a current contractor for Lucid, or any of its entities?",
    "Are you a current employee of Acme or any of its subsidiaries?",
])
def test_current_contractor_or_employee_of_the_company_is_no(label):
    d = ENGINE.resolve(Question(label=label, kind="select", required=True, options=["Yes", "No"]),
                       Context(company="Lucid Motors", labels=[label]))
    assert (d.action, d.value) == ("fill", "No")


def test_current_student_or_recent_graduate_is_yes_not_a_graduation_month():
    label = ("Are you a current student enrolled in a college/university program or have graduated within the past "
             "12 months? Undergraduate, postgraduate, or associate programs all qualify.")
    d = ENGINE.resolve(Question(label=label, kind="select", required=True, options=["Yes", "No"]),
                       Context(company="OpenSesame", labels=[label]))
    assert (d.action, d.value) == ("fill", "Yes")


# ---- 5. a stale profile lock whose PID now belongs to another process ------------------------------------------------- #

def test_a_lock_whose_pid_was_reused_by_a_newer_process_is_taken_over(tmp_path):
    profile = tmp_path / "chrome_profile"
    lock = tmp_path / "chrome_profile.runner.lock"
    written = time.time() - 3600
    lock.write_text(f"999999 {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(written))} {written:.0f}")
    newer_process = lambda pid: written + 600                              # started 10 minutes after the lock
    taken = agent_runner.ProfileLock(profile, pid_alive=lambda pid: True, process_started=newer_process).acquire()
    assert taken.held and lock.read_text().split()[0] == str(os.getpid())
    taken.release()


def test_a_lock_held_by_the_process_that_wrote_it_still_blocks(tmp_path):
    profile = tmp_path / "chrome_profile"
    lock = tmp_path / "chrome_profile.runner.lock"
    written = time.time() - 60
    lock.write_text(f"999999 {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(written))} {written:.0f}")
    with pytest.raises(agent_runner.ProfileBusy):
        agent_runner.ProfileLock(profile, pid_alive=lambda pid: True, process_started=lambda pid: written - 5).acquire()


# ---- 6. the application log records a missing confirmation e-mail -------------------------------------------------- #

def test_the_application_log_says_when_the_confirmation_email_never_came(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "LOG_DIR", tmp_path)
    j = job(3)
    agent_runner.write_application_log(j, ApplyResult(SUBMITTED, "confirmation page"), outcome=agent_runner.UNCONFIRMED)
    data = json.loads((tmp_path / "applications" / "j3.json").read_text())
    assert data["outcome"] == "unconfirmed"
    import run_status
    assert run_status.stopping_point(data["status"], data["reason"], data["outcome"] == "unconfirmed") \
        == "submitted, no e-mail"


# ---- 7. a dry run says where it would submit -------------------------------------------------------------------------- #

def test_a_dry_run_names_the_submit_button_it_would_click_and_the_page(home):
    from tests.test_assist import EMAIL, FIRST, URL, adapter, apply, form
    result, _, clicks = run(apply(adapter(), form(FIRST, EMAIL), home, dry_run=True))
    assert result.status == DRY_RUN_OK and clicks == 0                   # nothing was clicked
    assert result.detail == f"would click 'Submit application' on {URL}"


# ---- 8. wrong answers the dry run of Nov 27 showed (each would have been submitted) ----------------------------------- #

def resolve(label, kind="text", options=(), company="Acme", required=True):
    return ENGINE.resolve(Question(label=label, kind=kind, required=required, options=list(options)),
                          Context(company=company, labels=[label]))


def test_highest_education_completed_is_the_diploma_not_some_high_school():
    d = resolve("What is your highest level of education completed?", "select",
                ["Some High School", "High School Diploma/GED", "Bachelors Degree", "Masters Degree", "PHD"],
                company="Lucid Motors")
    assert (d.action, d.value) == ("fill", "High School Diploma/GED")


def test_summer_availability_is_never_answered_with_the_degree_start_date():
    d = resolve("What is your availability for Summer 2027? This is a full-time internship at 40 hours per week. "
                "Please include your earliest possible start date and the date you'll need to return to school for "
                "Fall 2027.", "textarea", company="OpenSesame")
    assert d.rule != "edu-start" and "2024" not in str(d.value)


def test_city_and_state_of_residence_is_not_the_school_name():
    d = resolve("What is your exact city and state of residence (where you are attending school)?", company="Amperity")
    assert d.rule != "school" and "University" not in str(d.value or "")
    assert d.action == "fill" and ", " in d.value                       # "City, State", not just the state


def test_an_if_no_follow_up_is_never_filled_with_an_essay():
    import essays
    q = "If no, please provide additional context on why these dates do not work with your schedule."
    assert essays.may_draft(q, {"company": "Airbnb"}, "follow-up") is False
    assert essays.may_draft("Please describe a project you are proud of.", {"company": "Airbnb"}, "no-rule") is True
