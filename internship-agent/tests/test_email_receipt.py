"""The confirmation gate: what counts as a receipt, the IMAP poll, and the runner's blocking logic."""
import asyncio
import imaplib
import time
from email.message import EmailMessage

import pytest

import agent_runner
import app_server
import config
import email_receipt_verifier as erv
import gmail_tab_otp
import run_state
from ats.base import MANUAL_REVIEW, SUBMITTED, ApplyResult
from dedup import Ledger, load_tracker_rows
from receipt_gate import ReceiptGate
from tests.test_dedup import make_tracker

GH = "no-reply@us.greenhouse-mail.io"
OTP_SUBJECT = "Security code for your application to Acme Robotics"
OTP_BODY = ("Copy and paste this code into the security code field on your application: xK7mP2qR "
            "After you enter the code, resubmit your application.")
THANKS_SUBJECT = "Thank you for applying to Acme Robotics"
THANKS_BODY = ("Jordan, Thanks for applying to Acme Robotics. Your application has been received and we will "
               "review it right away.")


# ---- the matcher ------------------------------------------------------------------ #

def test_greenhouse_code_email_is_rejected_and_the_thank_you_passes():
    # Same sender, same company, and the code e-mail even says "your application to".
    assert not erv.is_confirmation("Acme Robotics", GH, OTP_SUBJECT, OTP_BODY)
    assert erv.is_confirmation("Acme Robotics", GH, THANKS_SUBJECT, THANKS_BODY)


@pytest.mark.parametrize("phrase", [
    "Thank you for applying", "Thanks for applying", "Thank you for your application",
    "Thanks for your application", "Application received", "We received your application",
    "We have received your application", "Application Confirmation", "Your application to Acme Robotics",
    "Your application was successfully submitted", "THANK YOU FOR APPLYING",
])
def test_every_confirmation_phrase_is_accepted_in_subject_or_body(phrase):
    assert erv.is_confirmation("Acme Robotics", "careers@acmerobotics.com", phrase, "Hello Jordan.")
    assert erv.is_confirmation("Acme Robotics", "careers@acmerobotics.com", "Acme Robotics careers", phrase)


@pytest.mark.parametrize("subject, body", [
    ("Your security code", "Thank you for applying. Use this code to continue."),
    ("Thank you for applying to Acme Robotics", "Enter this verification code: 48201937"),
    ("Acme Robotics", "Please confirm you’re a human to finish. Thank you for applying."),
    ("Verify your email", "Thank you for applying to Acme Robotics."),
    ("Verify your e-mail to continue", "Application received."),
    ("Activate your account", "Thank you for your application to Acme Robotics."),
    ("Acme Robotics candidate home", "Activate your account to see your application received status."),
])
def test_code_and_account_emails_never_count_even_with_confirmation_wording(subject, body):
    assert erv.is_code_or_account_email(subject, body)
    assert not erv.is_confirmation("Acme Robotics", GH, subject, body)


@pytest.mark.parametrize("subject, body", [
    ("Update regarding your application to Globex", "We have decided to move forward with other candidates."),
    ("Your application to Globex", "Unfortunately, we will not be moving forward with your candidacy."),
    ("Thank you for your interest in Globex", "We regret to inform you that you have not been selected."),
])
def test_a_rejection_for_an_earlier_application_does_not_confirm_this_one(subject, body):
    assert not erv.is_confirmation("Acme Robotics", GH, subject, body)
    assert not erv.is_confirmation("Globex", GH, subject, body)


def test_the_sender_must_be_a_known_ats_or_the_mail_must_name_the_company():
    thanks = "Thank you for applying"
    assert erv.is_confirmation("Acme Robotics", "Acme <jobs@acmerobotics.com>", thanks, "We got it.")
    assert erv.is_confirmation("Burns Engineering, Inc.", "hr@example.org", "Thank you for applying to Burns Engineering",
                               "")
    # An ATS sender is enough when the e-mail spells the company differently from the queue.
    assert erv.is_confirmation("NISC", "no-reply@ashbyhq.com", thanks, "National Information Solutions Cooperative")
    assert not erv.is_confirmation("Acme Robotics", "news@shop.example.com", thanks + " for our store card", "Hi.")
    assert not erv.is_confirmation("Acme Robotics", GH, "Your weekly job alert", "New roles for you.")
    # Two-letter names are too short to match on; they need the ATS sender.
    assert not erv.is_confirmation("HP", "news@shop.example.com", thanks, "Shipping update for your laptop")


@pytest.mark.parametrize("sender, ats", [
    ("no-reply@us.greenhouse-mail.io", "Greenhouse"), ("x@greenhouse.io", "Greenhouse"),
    ("Subtotal Hiring Team <no-reply@ashbyhq.com>", "Ashby"), ("no-reply@hire.lever.co", "Lever"),
    ("nvidia@myworkday.com", "Workday"), ("x@acme.wd1.myworkdayjobs.com", "Workday"),
    ("x@notgreenhouse.io", ""), ("x@greenhouse.io.evil.example", ""), ("x@lever.co", ""), ("", ""),
])
def test_ats_domains_match_on_a_label_boundary_only(sender, ats):
    assert erv.ats_of(sender) == ats


def test_company_slug():
    assert erv.company_slug("Burns Engineering, Inc.") == "burnsengineering"
    assert erv.company_slug("The Voleon Group LLC") == "voleon"
    assert erv.company_slug("Qube Research & Technologies (QRT)") == "quberesearchtechnologies"


# ---- IMAP poll --------------------------------------------------------------------- #

def _mail(sender=GH, subject=THANKS_SUBJECT, body=THANKS_BODY, date="Fri, 13 Nov 2026 14:20:05 -0600"):
    msg = EmailMessage()
    msg["From"], msg["Subject"], msg["Date"] = sender, subject, date
    msg.set_content(body)
    return msg


class FakeInbox:
    """INBOX only. `arrivals` are delivered one per re-select, the way new mail shows up between polls."""

    def __init__(self, messages, arrivals=(), password="abcdabcdabcdabcd"):
        self.messages = dict(messages)                      # uid -> EmailMessage
        self.arrivals = list(arrivals)
        self.password = password
        self.selects = 0
        self.readonly = []
        self.fetched = []
        self.logged_out = False

    def __call__(self, host, port):
        assert (host, port) == ("imap.gmail.com", 993)
        return self

    def login(self, address, password):
        if password != self.password:
            raise imaplib.IMAP4.error("[AUTHENTICATIONFAILED] Invalid credentials")

    def status(self, box, what):
        assert box == "INBOX"
        nxt = (max(self.messages) + 1) if self.messages else 1
        return "OK", [f'"INBOX" (UIDNEXT {nxt})'.encode()]

    def select(self, box, readonly=False):
        assert box == "INBOX"
        self.readonly.append(readonly)
        self.selects += 1
        if self.selects > 1 and self.arrivals:
            uid, msg = self.arrivals.pop(0)
            self.messages[uid] = msg
        return "OK", [b"1"]

    def uid(self, command, *args):
        if command == "search":
            m = __import__("re").fullmatch(r"UID (\d+):\*", args[1])
            assert m, args
            low = int(m.group(1))
            uids = sorted(self.messages)
            hits = [u for u in uids if u >= low] or uids[-1:]   # n:* always returns the newest message
            return "OK", [" ".join(map(str, hits)).encode()]
        assert command == "fetch" and "BODY.PEEK[]" in args[1], args    # PEEK: never marks mail read
        uid = int(args[0])
        self.fetched.append(uid)
        raw = self.messages[uid].as_bytes()
        stamp = imaplib.Time2Internaldate(time.time())
        return "OK", [(f"1 (UID {uid} INTERNALDATE {stamp} BODY[] {{{len(raw)}}}".encode(), raw), b")"]

    def logout(self):
        self.logged_out = True


def verify(fake, pre_uid, company="Acme Robotics", **kw):
    kw.setdefault("sleep", lambda s: None)
    return erv.verify_submission_email(company, pre_uid, address="jordan@example.com",
                                       password="abcd abcd abcd abcd", connect=fake, **kw)


def test_snapshot_is_the_highest_uid_before_submit():
    assert erv.snapshot_uid("j@example.com", "abcdabcdabcdabcd", connect=FakeInbox({7: _mail(), 41: _mail()})) == 41
    assert erv.snapshot_uid("j@example.com", "abcdabcdabcdabcd", connect=FakeInbox({})) == 0


def test_the_code_email_arrives_first_and_only_the_thank_you_confirms():
    fake = FakeInbox({40: _mail(subject="Thank you for applying to Older Co", body="Older application.")},
                     arrivals=[(41, _mail(subject=OTP_SUBJECT, body=OTP_BODY)), (42, _mail())])
    result = verify(fake, 40)
    assert result == {"confirmed": True, "subject": THANKS_SUBJECT, "sender": GH,
                      "received_at": result["received_at"], "ats": "Greenhouse"}
    assert result["received_at"].startswith("2026-11-13")
    assert fake.fetched == [41, 42]                         # the older confirmation (UID 40) was never read
    assert all(fake.readonly) and fake.logged_out


def test_mail_from_before_the_snapshot_never_confirms():
    # An identical-looking confirmation is already in the inbox; nothing new arrives.
    fake = FakeInbox({40: _mail()})
    assert verify(fake, 40, timeout=8, interval=4, clock=iter(range(0, 100, 4)).__next__) == erv.NOT_CONFIRMED
    assert fake.fetched == []


def test_polls_every_interval_until_the_timeout_then_reports_unconfirmed():
    ticks = iter(range(0, 1000, 4))                         # each clock read is 4 s later
    slept = []
    fake = FakeInbox({1: _mail()}, arrivals=[(2, _mail(sender="deals@shop.example.com", subject="50% off", body="Sale"))])
    result = verify(fake, 1, timeout=120, interval=4, clock=ticks.__next__, sleep=slept.append)
    assert result["confirmed"] is False
    assert set(slept) == {4} and 10 <= len(slept) <= 30
    assert fake.fetched == [2]                              # read once, not on every poll


def test_wait_another_60s_does_not_reread_mail_already_seen():
    seen = set()
    fake = FakeInbox({1: _mail()}, arrivals=[(2, _mail(subject=OTP_SUBJECT, body=OTP_BODY))])
    assert verify(fake, 1, timeout=8, interval=4, clock=iter(range(0, 100, 4)).__next__, seen=seen)["confirmed"] is False
    fake2 = FakeInbox({1: _mail(), 2: _mail(subject=OTP_SUBJECT, body=OTP_BODY)}, arrivals=[(3, _mail())])
    assert verify(fake2, 1, timeout=60, seen=seen)["confirmed"] is True
    assert fake2.fetched == [3]


def test_bad_app_password_raises_so_the_gmail_tab_can_take_over():
    with pytest.raises(imaplib.IMAP4.error):
        erv.verify_submission_email("Acme", 1, address="j@example.com", password="wrong", connect=FakeInbox({}))


# ---- Gmail tab fallback ------------------------------------------------------------- #

def test_gmail_tab_rows_only_new_threads_and_only_real_confirmations():
    rows = [
        {"id": "t9", "sender": f"Greenhouse <{GH}>", "subject": OTP_SUBJECT, "snippet": OTP_BODY, "received_at": "now"},
        {"id": "t8", "sender": f"Greenhouse <{GH}>", "subject": THANKS_SUBJECT, "snippet": "Older one", "received_at": "old"},
        {"id": "t10", "sender": f"Greenhouse <{GH}>", "subject": "Thank you  for applying to Acme Robotics",
         "snippet": THANKS_BODY, "received_at": "Fri, Nov 13, 2026, 2:20 PM"},
    ]
    assert gmail_tab_otp.receipt_from_rows(rows[:2], {"t8"}, "Acme Robotics") is None
    hit = gmail_tab_otp.receipt_from_rows(rows, {"t8"}, "Acme Robotics")
    assert hit["confirmed"] and hit["subject"] == THANKS_SUBJECT and hit["ats"] == "Greenhouse"


# ---- runner: the blocking gate -------------------------------------------------------- #

@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "BASE", tmp_path)
    monkeypatch.setattr(config, "RUN_STATE_JSON", tmp_path / "run_state.json")
    monkeypatch.setattr(config, "UNCONFIRMED_CSV", tmp_path / "unconfirmed_applications.csv")
    monkeypatch.setattr(config, "LEDGER_CSV", tmp_path / "applied.csv")
    monkeypatch.setattr(config, "LOG_DIR", tmp_path / "logs")
    (tmp_path / "logs").mkdir()
    return tmp_path


JOB = {"id": "acme-1", "company": "Acme Robotics", "title": "SWE Intern", "ats": "Greenhouse",
       "url": "https://job-boards.greenhouse.io/acme/jobs/1", "locations": ["Austin, TX"]}
RECEIPT = {"confirmed": True, "subject": THANKS_SUBJECT, "sender": GH, "received_at": "2026-11-13 14:20:05",
           "ats": "Greenhouse"}


class FakeGate(ReceiptGate):
    """wait() answers from a script and records the timeout it was given."""

    def __init__(self, answers):
        super().__init__(log=lambda m: None, credentials=lambda: ("", ""))
        self.answers = list(answers)
        self.timeouts = []
        self.snapshots = 0

    async def snapshot(self, context):
        self.snapshots += 1
        return "imap"

    async def wait(self, context, company, timeout=120, interval=4):
        self.timeouts.append(timeout)
        return dict(self.answers.pop(0))


def run(coro):
    return asyncio.run(coro)


def asker(*choices):
    asked = []
    queue = list(choices)

    async def ask(job):
        asked.append(run_state.read())
        return queue.pop(0)
    return ask, asked


def test_confirmed_receipt_passes_the_gate_and_shows_the_subject(home):
    gate = FakeGate([RECEIPT])
    gate.start(JOB)
    ask, asked = asker()
    assert run(agent_runner.confirm_receipt(gate, None, JOB, attended=True, ask=ask)) == ("confirmed", RECEIPT)
    assert asked == [] and gate.timeouts == [120]
    state = run_state.read()
    assert state["step"] == run_state.CONFIRMED and state["subject"] == THANKS_SUBJECT


def test_timeout_pauses_and_wait_60s_keeps_polling(home):
    gate = FakeGate([erv.NOT_CONFIRMED, erv.NOT_CONFIRMED, RECEIPT])
    gate.start(JOB)
    ask, asked = asker(run_state.WAIT, run_state.WAIT)
    outcome, receipt = run(agent_runner.confirm_receipt(gate, None, JOB, attended=True, ask=ask))
    assert outcome == "confirmed" and receipt == RECEIPT
    assert gate.timeouts == [120, 60, 60]
    # While the question was open the state said so, which is what puts the buttons on the dashboard.
    assert all(s["timed_out"] and s["step"] == run_state.AWAITING_EMAIL for s in asked)


def test_skip_and_retry_choices(home):
    for choice, expected in ((run_state.SKIP, "unconfirmed"), (run_state.RETRY, "retry")):
        gate = FakeGate([erv.NOT_CONFIRMED])
        gate.start(JOB)
        ask, _ = asker(choice)
        assert run(agent_runner.confirm_receipt(gate, None, JOB, attended=True, ask=ask)) == (expected, {})


def test_unattended_timeout_goes_to_the_hold_list_without_asking(home):
    gate = FakeGate([erv.NOT_CONFIRMED])
    gate.start(JOB)

    async def nobody(job):
        raise AssertionError("an unattended run has nobody to ask")
    assert run(agent_runner.confirm_receipt(gate, None, JOB, attended=False, ask=nobody)) == ("unconfirmed", {})
    assert run_state.read()["step"] == run_state.UNCONFIRMED


class FakePage:
    def __init__(self):
        self.closed = self.fronted = False

    def is_closed(self):
        return self.closed

    async def close(self):
        self.closed = True

    async def bring_to_front(self):
        self.fronted = True


def _apply_factory(results):
    calls = []

    async def apply(context, job, engine, ledger, *, dry_run, use_llm, keep_open=False):
        assert keep_open and not dry_run
        calls.append(job["id"])
        return results.pop(0)
    return apply, calls


def _confirm_factory(outcomes):
    seen_timeouts = []

    async def confirm(gate, context, job, *, attended, timeout):
        seen_timeouts.append(timeout)
        return outcomes.pop(0)
    return confirm, seen_timeouts


def test_a_form_that_did_not_submit_never_reaches_the_gate(home):
    gate = FakeGate([])
    apply, calls = _apply_factory([ApplyResult(MANUAL_REVIEW, "CAPTCHA", "challenge")])

    async def confirm(*a, **k):
        raise AssertionError("nothing was submitted")
    result, outcome, receipt = run(agent_runner.submit_and_confirm(
        None, JOB, None, None, gate, use_llm=False, attended=True, apply=apply, confirm=confirm))
    assert (result.status, outcome, receipt) == (MANUAL_REVIEW, "", {})
    assert gate.snapshots == 1


def test_retry_does_not_resubmit_when_the_browser_already_shows_a_confirmation(home, monkeypatch):
    page = FakePage()

    class Adapter:
        async def confirmed(self, p):
            return "https://job-boards.greenhouse.io/acme/jobs/1/confirmation"
    monkeypatch.setattr(agent_runner, "adapter_for", lambda url: Adapter())
    monkeypatch.setattr(agent_runner, "log", lambda m: None)
    apply, calls = _apply_factory([ApplyResult(SUBMITTED, "confirmation page", page=page)])
    confirm, timeouts = _confirm_factory([("retry", {}), ("confirmed", RECEIPT)])
    result, outcome, receipt = run(agent_runner.submit_and_confirm(
        None, JOB, None, None, FakeGate([]), use_llm=False, attended=True, apply=apply, confirm=confirm))
    assert calls == ["acme-1"]                              # one submission only
    assert (outcome, receipt) == ("confirmed", RECEIPT) and timeouts == [120, 60]
    assert page.fronted and page.closed


def test_retry_reopens_the_form_when_the_browser_shows_no_confirmation(home, monkeypatch):
    first, second = FakePage(), FakePage()

    class Adapter:
        async def confirmed(self, p):
            return None
    monkeypatch.setattr(agent_runner, "adapter_for", lambda url: Adapter())
    monkeypatch.setattr(agent_runner, "log", lambda m: None)
    apply, calls = _apply_factory([ApplyResult(SUBMITTED, "thanks", page=first),
                                   ApplyResult(SUBMITTED, "thanks", page=second)])
    confirm, timeouts = _confirm_factory([("retry", {}), ("unconfirmed", {})])
    gate = FakeGate([])
    result, outcome, _ = run(agent_runner.submit_and_confirm(
        None, JOB, None, None, gate, use_llm=False, attended=True, apply=apply, confirm=confirm))
    assert calls == ["acme-1", "acme-1"] and outcome == "unconfirmed"
    assert first.closed and second.closed and timeouts == [120, 120]
    assert gate.snapshots == 2                              # a fresh snapshot for the second attempt


def test_gate_without_any_snapshot_reports_unconfirmed_rather_than_guessing(home):
    gate = ReceiptGate(log=lambda m: None, credentials=lambda: ("", ""))
    gate.start(JOB)
    assert run(gate.wait(None, "Acme Robotics", timeout=1))["confirmed"] is False


# ---- tracker write-back ---------------------------------------------------------------- #

def test_confirmed_application_is_written_with_the_receipt_subject(tmp_path):
    xlsx = tmp_path / "tracker.xlsx"
    make_tracker(xlsx, [["Globex Corp", "Intern", "Summer 2027", "2026-09-03",
                         "Application submitted / Awaiting response", None, None, None, None]])
    ledger = Ledger(xlsx, tmp_path / "applied.csv")
    before = ledger.total
    ledger.record_application(JOB, receipt=RECEIPT)
    row = load_tracker_rows(xlsx)[-1]
    assert row["Company"] == "Acme Robotics"
    assert row["Current Status"] == "Application submitted / Awaiting response"
    assert row["Next Step / Notes"].startswith(
        "Application confirmation received via Greenhouse (2026-11-13); verified by Gmail receipt.")
    assert row["Source Email Subject"] == THANKS_SUBJECT
    assert ledger.total == before + 1


def test_a_formula_looking_subject_is_stored_as_text(tmp_path):
    xlsx = tmp_path / "tracker.xlsx"
    make_tracker(xlsx, [["Globex Corp", "Intern", "Summer 2027", "2026-09-03", "Rejected", None, None, None, None]])
    Ledger(xlsx, tmp_path / "applied.csv").record_application(
        JOB, receipt={**RECEIPT, "subject": '=HYPERLINK("http://x.example","Thank you for applying")'})
    assert load_tracker_rows(xlsx)[-1]["Source Email Subject"].startswith("'=")


def test_unconfirmed_goes_to_the_hold_list_and_is_not_counted(tmp_path):
    xlsx = tmp_path / "tracker.xlsx"
    make_tracker(xlsx, [["Globex Corp", "Intern", "Summer 2027", "2026-09-03", "Rejected", None, None, None, None]])
    ledger = Ledger(xlsx, tmp_path / "applied.csv")
    before, rows_before = ledger.total, len(load_tracker_rows(xlsx))
    hold = tmp_path / "unconfirmed.csv"
    ledger.record_unconfirmed(JOB, "confirmation page", path=hold)
    ledger.record_unconfirmed({**JOB, "company": "=cmd"}, path=hold)
    lines = hold.read_text(encoding="utf-8").splitlines()
    assert lines[0].split(",")[:3] == ["Timestamp", "Company", "Role"] and len(lines) == 3
    assert "Application incomplete / Unconfirmed" in lines[1] and "'=cmd" in lines[2]
    assert ledger.total == before and len(load_tracker_rows(xlsx)) == rows_before
    assert not ledger.has_company("Acme Robotics")


# ---- dashboard --------------------------------------------------------------------------- #

def _statuses(state):
    return {s["key"]: s["status"] for s in state["steps"]}


def test_dashboard_steps_follow_the_runner(home):
    gate = ReceiptGate(log=lambda m: None, credentials=lambda: ("", ""))
    gate.start(JOB)
    gate.step(run_state.SUBMITTING)
    assert _statuses(app_server.build_state())[run_state.SUBMITTING] == "active"
    gate.step(run_state.ENTERING_OTP)
    gate.step(run_state.AWAITING_EMAIL, "Waiting for confirmation email in Gmail...")
    state = app_server.build_state()
    assert _statuses(state) == {run_state.SUBMITTING: "done", run_state.ENTERING_OTP: "done",
                                run_state.AWAITING_EMAIL: "active", run_state.CONFIRMED: "todo"}
    assert state["steps"][2]["label"] == "Verifying Receipt Email in Gmail (polling...)"
    gate.step(run_state.CONFIRMED, subject=THANKS_SUBJECT)
    state = app_server.build_state()
    assert state["steps"][3] == {"key": run_state.CONFIRMED, "status": "done",
                                 "label": f'Confirmed: "{THANKS_SUBJECT}"'}


def test_dashboard_marks_the_code_step_skipped_when_no_code_was_asked_for(home):
    gate = ReceiptGate(log=lambda m: None, credentials=lambda: ("", ""))
    gate.start({**JOB, "ats": "Ashby"})
    gate.step(run_state.SUBMITTING)
    gate.step(run_state.AWAITING_EMAIL)
    assert _statuses(app_server.build_state())[run_state.ENTERING_OTP] == "skipped"


def test_dashboard_counts_confirmed_and_held_separately(home):
    (home / "applied.csv").write_text("Timestamp,Company\n1,A\n2,B\n", encoding="utf-8")
    (home / "unconfirmed_applications.csv").write_text("Timestamp,Company\n1,C\n", encoding="utf-8")
    state = app_server.build_state()
    assert (state["confirmed_total"], state["unconfirmed_total"], state["target"]) == (2, 1, 500)
    assert state["job"] is None and state["timed_out"] is False


def test_choice_buttons_only_work_while_the_runner_is_waiting(home):
    gate = ReceiptGate(log=lambda m: None, credentials=lambda: ("", ""))
    gate.start(JOB)
    gate.step(run_state.AWAITING_EMAIL)
    assert app_server.handle_choice({"choice": "wait"})[0] == 409
    gate.step(run_state.AWAITING_EMAIL, "Queue paused.", timed_out=True)
    for bad in (None, [], {}, {"choice": "delete"}, {"choice": "__class__"}, {"choice": 3}):
        assert app_server.handle_choice(bad)[0] == 400
    assert run_state.take_choice("acme-1") is None
    assert app_server.handle_choice({"choice": "skip"}) == (200, {"ok": True, "choice": "skip"})
    assert run_state.take_choice("acme-1") == "skip"
    assert run_state.take_choice("acme-1") is None           # consumed: one press, one answer


def test_a_choice_left_for_an_earlier_posting_is_discarded(home):
    run_state.post_choice("skip", "older-job")
    assert run_state.take_choice("acme-1") is None
    assert not run_state.choice_path().exists()
    assert run_state.post_choice("nonsense") is False


@pytest.mark.parametrize("host, ok", [
    ("127.0.0.1:4760", True), ("localhost:4760", True), ("localhost", True), ("[::1]:4760", True),
    ("evil.example:4760", False), ("127.0.0.1.evil.example", False), ("", False),
])
def test_dashboard_answers_local_hosts_only(host, ok):
    assert app_server.host_ok(host) is ok


def test_dashboard_refuses_cross_site_posts():
    assert app_server.origin_ok("", "127.0.0.1:4760")
    assert app_server.origin_ok("http://127.0.0.1:4760", "127.0.0.1:4760")
    assert not app_server.origin_ok("http://evil.example", "127.0.0.1:4760")
    assert not app_server.origin_ok("http://127.0.0.1:9999", "127.0.0.1:4760")


def test_ask_gate_choice_takes_the_dashboard_answer(home, monkeypatch, capsys):
    monkeypatch.setattr(agent_runner, "_start_stdin_reader", lambda: None)

    async def scenario():
        task = asyncio.create_task(agent_runner.ask_gate_choice(JOB, poll_s=0.01))
        await asyncio.sleep(0.05)
        assert not task.done()                              # blocked: the queue is paused
        run_state.post_choice("wait", "acme-1")
        return await asyncio.wait_for(task, 2)
    assert run(scenario()) == "wait"
    out = capsys.readouterr().out
    assert "\a" in out and "1)" in out and "2)" in out and "3)" in out


def test_ask_gate_choice_takes_a_typed_answer(home, monkeypatch):
    monkeypatch.setattr(agent_runner, "_start_stdin_reader", lambda: None)

    async def scenario():
        task = asyncio.create_task(agent_runner.ask_gate_choice(JOB, poll_s=0.01))
        await asyncio.sleep(0.03)
        agent_runner._typed.put("banana")
        agent_runner._typed.put("3")
        return await asyncio.wait_for(task, 2)
    assert run(scenario()) == "skip"
