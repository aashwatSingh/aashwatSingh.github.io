"""Lockout-proof Workday sign-in (ats/workday_auth.py), in headless Chromium against a mock Workday.

The mock is a page plus the three requests it makes (sign in, create account, e-mail verification),
all answered by Playwright routes: no live site, no network. Gmail is a fake IMAP connection; Discord
is a fake notifier. WORKDAY_PASSWORD below is a test value, and no test needs it anywhere but the form."""
import asyncio
import email
import email.message
import email.policy
import imaplib
import json
import time
from pathlib import Path

import pytest
from playwright.async_api import async_playwright

import config
from ats import workday_auth as wa
from ats.base import MANUAL_REVIEW
from ats.workday import WorkdayAdapter
from phone_notify import DiscordNotifier
from tests.test_assist import home, run                                   # noqa: F401 - fixture

HOST = "acme.wd5.myworkdayjobs.com"
PAGE_URL = f"https://{HOST}/External/job/Austin/SWE-Intern_R1"
VERIFY_URL = f"https://{HOST}/External/verify?token=t0k3n"
ME = "alex.rivera@example.edu"
PASSWORD = "Tr4vel-Light#9"
PROFILE = {"identity": {"email": ME}}
JOB = {"id": "acme-wd", "company": "Acme Robotics", "title": "SWE Intern", "ats": "Workday", "url": PAGE_URL}
STALE_EMAIL, STALE_PASSWORD = "stale.saved@old-login.example", "OldSaved#Pass1"

PAGE = """<!doctype html><html><body>
<div data-automation-id="progressBarActiveStep" id="step">current step 1 of 6 Create Account/Sign In</div>
<div id="auth"></div>
<script>
const STALE = __STALE__;
window.__log = [];
document.addEventListener('input', e => window.__log.push([e.target.getAttribute('data-automation-id'), e.target.value]));
const val = id => document.querySelector(`[data-automation-id="${id}"]`).value;
const field = (id, type) => `<div data-automation-id="formField-${id}"><input data-automation-id="${id}" type="${type}"
  value="${STALE ? (id === 'email' ? '__SE__' : '__SP__') : ''}"></div>`;
function render(mode, error) {
  const banner = error ? `<div data-automation-id="errorMessage">${error}</div>` : '';
  document.getElementById('auth').innerHTML = mode === 'signin'
    ? field('email', 'text') + field('password', 'password') + banner +
      '<button data-automation-id="signInSubmitButton">Sign In</button> ' +
      '<a href="#" data-automation-id="createAccountLink">Create Account</a>'
    : field('email', 'text') + field('password', 'password') + field('verifyPassword', 'password') +
      '<input type="checkbox" data-automation-id="createAccountCheckbox"> I agree' + banner +
      '<button data-automation-id="createAccountSubmitButton">Create Account</button>';
}
function signedIn() {
  document.getElementById('auth').innerHTML = '<div data-automation-id="formField-firstName"><label>First Name</label><input></div>';
  document.getElementById('step').textContent = 'current step 2 of 6 My Information';
}
const api = (path, body) => fetch('/External/api/' + path, {method: 'POST', body: JSON.stringify(body)}).then(r => r.json());
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-automation-id]');
  const id = t && t.getAttribute('data-automation-id');
  if (id === 'createAccountLink') { e.preventDefault(); render('create'); }
  if (id === 'signInSubmitButton') {
    const r = await api('signin', {email: val('email'), password: val('password')});
    r.ok ? signedIn() : render('signin', r.error);
  }
  if (id === 'createAccountSubmitButton') {
    const r = await api('create', {email: val('email'), password: val('password'), verify: val('verifyPassword'),
      agreed: document.querySelector('[data-automation-id="createAccountCheckbox"]').checked});
    if (r.status === 'created') signedIn();
    else if (r.status === 'verify') document.getElementById('auth').innerHTML =
      '<p>Please verify your email. We sent you a link: check your inbox.</p>';
    else render('create', r.error);
  }
});
render('signin');
</script></body></html>"""


class Workday:
    """The mock tenant: the page, and the server side of Sign In / Create Account / the e-mailed link."""

    def __init__(self, *, accounts=None, create="created", hard_lock=False, stale=False):
        self.accounts = dict(accounts or {})        # e-mail -> {"password", "verified"}
        self.create_mode, self.hard_lock, self.stale = create, hard_lock, stale
        self.signins, self.creates, self.verify_hits = [], [], 0

    def page(self):
        return (PAGE.replace("__STALE__", "true" if self.stale else "false")
                .replace("__SE__", STALE_EMAIL).replace("__SP__", STALE_PASSWORD))

    def signin(self, data):
        self.signins.append(data)
        acct = self.accounts.get(data["email"])
        if self.hard_lock:
            return {"ok": False, "error": "Your account has been locked after too many sign-in attempts."}
        if acct and acct["password"] == data["password"] and acct["verified"]:
            return {"ok": True}
        if acct and acct["password"] == data["password"]:
            return {"ok": False, "error": "Please verify your email address before signing in."}
        return {"ok": False, "error": "Wrong email address or password or your account might be locked."}

    def create(self, data):
        self.creates.append(data)
        if not data["agreed"] or data["password"] != data["verify"]:
            return {"status": "error", "error": "Check the agreement box and make both passwords match."}
        if self.create_mode == "exists":
            return {"status": "error", "error": "An account with this email address already exists."}
        verified = self.create_mode == "created"
        self.accounts[data["email"]] = {"password": data["password"], "verified": verified}
        return {"status": "created" if verified else "verify"}

    async def serve(self, route):
        req = route.request
        url = req.url.split("?")[0]
        if req.method == "GET" and url == PAGE_URL:
            return await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=self.page())
        if req.method == "GET" and req.url == VERIFY_URL:
            self.verify_hits += 1
            for acct in self.accounts.values():
                acct["verified"] = True
            return await route.fulfill(status=200, content_type="text/html", body="<p>Your email has been verified.</p>")
        if req.method == "POST" and url.endswith("/External/api/signin"):
            return await route.fulfill(status=200, content_type="application/json", body=json.dumps(self.signin(json.loads(req.post_data))))
        if req.method == "POST" and url.endswith("/External/api/create"):
            return await route.fulfill(status=200, content_type="application/json", body=json.dumps(self.create(json.loads(req.post_data))))
        await route.abort()


class FakeNotifier:
    """A Discord that is on, remembers what it was sent, and answers from a script."""

    enabled = True

    def __init__(self, replies=(), on_poll=None):
        self.sent, self.replies, self.on_poll, self.page, self.polls = [], list(replies), on_poll, None, 0

    def send_message(self, text, photo_bytes=None, ping=True, **kw):
        self.sent.append((text, photo_bytes))
        return "1"

    async def apoll_reply(self):
        self.polls += 1
        if self.on_poll:
            await self.on_poll(self)
        return DiscordNotifier._canonical(self.replies.pop(0)) if self.replies else None


class FakeIMAP:
    """imaplib.IMAP4_SSL with two messages in INBOX: a Workday verification mail and a look-alike elsewhere."""

    instances = []

    def __init__(self, host, port):
        self.host, self.port, self.logged_in, self.logged_out, self.boxes = host, port, None, False, []
        FakeIMAP.instances.append(self)

    @staticmethod
    def mail(subject, link, sender, body="Verify your email to finish creating your Acme Robotics candidate account."):
        m = email.message.EmailMessage()
        m["From"], m["To"], m["Subject"] = sender, ME, subject
        m.set_content(body)
        m.add_alternative(f'<p>{body}</p><a href="{link}">Open</a>', subtype="html")
        return m.as_bytes()

    def login(self, user, password):
        self.logged_in = (user, password)
        return "OK", [b"ok"]

    def select(self, box, readonly=False):
        self.boxes.append(box)
        return ("OK", [b"2"]) if box == "INBOX" else ("NO", [b""])

    def uid(self, cmd, *args):
        if cmd == "search":
            return "OK", [b"1 2"]
        stamp = imaplib.Time2Internaldate(time.time()).encode()
        mails = [self.mail("Verify your email address for Acme Robotics", VERIFY_URL.replace("&", "&amp;"),
                           "no-reply@myworkday.com"),
                 self.mail("Verify your email address", "https://evil.example/verify?token=x", "x@evil.example")]
        out = []
        for n, raw in enumerate(mails, 1):
            out += [(b"%d (UID %d INTERNALDATE %s BODY[] {%d}" % (n, n, stamp, len(raw)), raw), b")"]
        return "OK", out

    def logout(self):
        self.logged_out = True


@pytest.fixture(autouse=True)
def clean(monkeypatch, home):
    wa._sign_in_clicks.clear()
    wa._create_clicks.clear()
    FakeIMAP.instances.clear()
    monkeypatch.setenv("WORKDAY_PASSWORD", PASSWORD)
    monkeypatch.setenv("GMAIL_APP_PASSWORD", "abcd efgh ijkl mnop")
    monkeypatch.setenv("GMAIL_ADDRESS", ME)
    monkeypatch.setattr(imaplib, "IMAP4_SSL", FakeIMAP)
    return home


async def drive(server, *, allow_manual=False, notifier=None, work=None, registry_status=None, profile=PROFILE):
    """Open the mock sign-in page and run ensure_workday_signed_in. -> (result, what the page shows)."""
    if registry_status:
        wa.AccountRegistry().set(HOST, registry_status, ME)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        context = await browser.new_context()
        await context.route("**/*", server.serve)
        page = await context.new_page()
        await page.goto(PAGE_URL)
        if notifier is not None:
            notifier.page = page
        try:
            result = await asyncio.wait_for(wa.ensure_workday_signed_in(
                page, profile, notifier=notifier or FakeNotifier(), allow_manual=allow_manual, company="Acme Robotics",
                poll_ms=50, manual_wait_s=20), 90)
            seen = await page.evaluate("() => ({log: window.__log, step: document.getElementById('step').textContent})")
            if work:
                await work(page)
            return result, seen
        finally:
            await browser.close()


def saved():
    return json.loads((config.BASE / "workday_accounts.json").read_text())


# ---- 1. unknown tenant: Sign In once, refused, Create Account ----------------------------------------- #

def test_unknown_tenant_sign_in_fails_once_then_create_account_succeeds(capsys):
    server = Workday(create="created", stale=True)
    result, seen = run(drive(server))
    assert result.ok and result.status == wa.VERIFIED
    assert len(server.signins) == 1                                # Sign In was clicked once and never retried
    assert len(server.creates) == 1
    made = server.creates[0]
    assert made == {"email": ME, "password": PASSWORD, "verify": PASSWORD, "agreed": True}
    assert "My Information" in seen["step"]
    record = saved()[HOST]
    assert record["status"] == "verified" and record["email"] == ME and record["updated_at"]
    assert PASSWORD not in capsys.readouterr().out                 # and never in the terminal


# ---- 2. Create Account asks to verify: Gmail over IMAP, the link, one sign in -------------------------------- #

def test_create_account_needing_email_verification_reads_gmail_and_signs_in_once():
    server = Workday(create="verify")
    result, seen = run(drive(server))
    assert result.ok and result.status == wa.VERIFIED
    assert server.verify_hits == 1                                 # the link was opened (in a temporary tab)
    assert len(server.signins) == 2                                # the refused one, then exactly one after verifying
    assert server.signins[1] == {"email": ME, "password": PASSWORD}
    assert "My Information" in seen["step"]
    assert saved()[HOST]["status"] == "verified"
    imap = FakeIMAP.instances[0]
    assert imap.logged_in == (ME, "abcdefghijklmnop") and imap.logged_out   # the existing GMAIL_APP_PASSWORD connection


def test_verification_link_is_only_taken_from_a_workday_mail_for_this_tenant():
    mail = lambda subject, link: email.message_from_bytes(FakeIMAP.mail(subject, link, "a@b.example"), policy=email.policy.default)
    good = mail("Verify your email address for Acme Robotics", VERIFY_URL.replace("&", "&amp;"))
    assert wa.find_verification_link(good, HOST, "Acme Robotics") == VERIFY_URL
    assert wa.find_verification_link(mail("Verify", "https://evil.example/verify?token=x"), HOST, "Acme") is None
    other = mail("Verify your email", "https://globex.wd1.myworkdayjobs.com/External/verify?token=z")
    assert wa.find_verification_link(other, HOST, "Acme Robotics") is None      # another company's tenant
    unrelated = FakeIMAP.mail("Your weekly digest", VERIFY_URL, "a@b.example", body="New jobs at Acme Robotics this week.")
    assert wa.find_verification_link(email.message_from_bytes(unrelated, policy=email.policy.default), HOST) is None


# ---- 3. an account exists with another password (Outcome C) --------------------------------------------------- #

def test_existing_account_with_a_different_password_makes_no_extra_sign_in_and_escalates(capsys):
    server = Workday(create="exists", accounts={ME: {"password": "Different#Pass7", "verified": True}})
    phone = FakeNotifier()
    result, _ = run(drive(server, allow_manual=False, notifier=phone))
    assert not result.ok and result.reason == "WORKDAY_LOGIN" and result.status == wa.MANUAL_AUTH
    assert result.detail.startswith("Workday existing account / password mismatch")
    assert len(server.signins) == 1 and len(server.creates) == 1   # ZERO extra Sign In attempts
    assert saved()[HOST]["status"] == "manual_auth"
    assert phone.sent == []                                        # unattended: no waiting, no ping


def test_attended_escalation_rings_pings_discord_with_a_screenshot_and_honors_skip(capsys):
    server = Workday(create="exists")
    phone = FakeNotifier(replies=["!skip"])
    result, _ = run(drive(server, allow_manual=True, notifier=phone))
    assert result.skipped and not result.ok and result.reason == "SKIPPED_FROM_PHONE"
    assert len(server.signins) == 1 and saved()[HOST]["status"] == "manual_auth"
    text, png = phone.sent[0]
    assert text == ("Workday sign-in needs you on Acme Robotics (acme.wd5.myworkdayjobs.com) — account exists with a "
                    "different password or is locked. Sign in / reset password in Chrome, or reply !skip.")
    assert png and png[:4] == b"\x89PNG"
    out = capsys.readouterr().out
    assert "\a[ACTION REQUIRED]" in out and PASSWORD not in out


def test_attended_escalation_resumes_cleanly_when_you_sign_in_yourself():
    server = Workday(create="exists")

    async def you_sign_in(phone):
        if phone.polls == 3:
            await phone.page.evaluate("signedIn()")

    phone = FakeNotifier(on_poll=you_sign_in)
    result, seen = run(drive(server, allow_manual=True, notifier=phone))
    assert result.ok and result.status == wa.MANUAL_AUTH and "My Information" in seen["step"]
    assert len(server.signins) == 1 and saved()[HOST]["status"] == "manual_auth"


def test_manual_auth_and_locked_tenants_are_never_typed_into():
    for status in (wa.MANUAL_AUTH, wa.LOCKED):
        wa._sign_in_clicks.clear()
        server = Workday()
        result, _ = run(drive(server, registry_status=status))
        assert not result.ok and result.reason == "WORKDAY_LOGIN"
        assert server.signins == [] and server.creates == [], status


def test_a_verified_tenant_that_refuses_us_is_not_retried_and_not_recreated():
    server = Workday()                                             # no such account any more
    result, _ = run(drive(server, registry_status=wa.VERIFIED))
    assert not result.ok and result.status == wa.MANUAL_AUTH
    assert len(server.signins) == 1 and server.creates == []
    assert saved()[HOST]["status"] == "manual_auth"


def test_a_hard_lock_banner_marks_the_tenant_locked_and_creates_nothing():
    server = Workday(hard_lock=True)
    result, _ = run(drive(server))
    assert not result.ok and result.status == wa.LOCKED
    assert len(server.signins) == 1 and server.creates == []


# ---- 4. Chrome autofill is cleared before typing ------------------------------------------------------------- #

def test_stale_autofilled_values_are_cleared_before_the_password_is_typed():
    server = Workday(stale=True, accounts={ME: {"password": PASSWORD, "verified": True}})
    result, seen = run(drive(server, registry_status=wa.VERIFIED))
    assert result.ok
    assert server.signins == [{"email": ME, "password": PASSWORD}]  # nothing of the saved login went through
    for field, final in (("email", ME), ("password", PASSWORD)):
        values = [v for f, v in seen["log"] if f == field]
        assert values[0] == "" and values[-1] == final            # Ctrl+A, Backspace emptied it, then the real value
        assert not any(STALE_EMAIL in v or STALE_PASSWORD in v for v in values[1:])


# ---- Rule 0: nothing to do, or nothing safe to do ------------------------------------------------------------- #

def test_already_signed_in_returns_immediately_without_a_click():
    server = Workday()

    async def go():
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            context = await browser.new_context()
            await context.route("**/*", server.serve)
            page = await context.new_page()
            await page.goto(PAGE_URL)
            await page.evaluate("signedIn()")
            try:
                return await wa.ensure_workday_signed_in(page, PROFILE, notifier=FakeNotifier(), allow_manual=False)
            finally:
                await browser.close()
    assert run(go()).ok and server.signins == [] and server.creates == []


@pytest.mark.parametrize("password", ["", "short1!", "alllowercase1!", "ALLUPPERCASE1!", "NoDigitsHere!!", "NoSymbols12345"])
def test_a_missing_or_weak_password_is_never_submitted(password, monkeypatch, capsys):
    monkeypatch.setenv("WORKDAY_PASSWORD", password)
    server = Workday()
    result, _ = run(drive(server))
    assert not result.ok and result.reason == "WORKDAY_LOGIN" and "WORKDAY_PASSWORD" in result.detail
    assert server.signins == [] and server.creates == []
    assert not (config.BASE / "workday_accounts.json").exists()   # nothing was learned about the tenant
    assert (password not in capsys.readouterr().out) or password == ""


def test_password_rules():
    assert wa.password_problem(PASSWORD) == ""
    assert "not set" in wa.password_problem("")
    for weak in ("Sh0rt!a", "nouppercase1!", "NOLOWERCASE1!", "NoDigits!!", "NoSymbol1A"):
        assert wa.password_problem(weak), weak


# ---- 5. the registry never holds a password, and is git-ignored ------------------------------------------------ #

def test_registry_holds_no_password_and_is_git_ignored():
    server = Workday(create="verify")
    run(drive(server))
    main = config.BASE / "workday_accounts.json"
    backup = config.BASE / "workday_accounts.backup.json"
    for path in (main, backup):
        assert path.exists() and PASSWORD not in path.read_text(), path.name
    assert set(saved()[HOST]) == {"status", "email", "updated_at"}
    ignored = (Path(__file__).resolve().parents[1] / ".gitignore").read_text().splitlines()
    assert "workday_accounts.json" in ignored and "workday_accounts.backup.json" in ignored


def test_registry_normalises_hosts_and_falls_back_to_its_backup():
    reg = wa.AccountRegistry()
    reg.set("https://ACME.WD5.myworkdayjobs.com:443/External/job/x", wa.VERIFIED, ME)
    assert reg.get(HOST)["status"] == "verified"
    (config.BASE / "workday_accounts.json").write_text("{ not json")
    assert reg.get(HOST)["status"] == "verified"                   # read from workday_accounts.backup.json
    with pytest.raises(ValueError):
        reg.set(HOST, "whatever", ME)
    (config.BASE / "workday_accounts.json").write_text(json.dumps({HOST: {"status": "verified", "email": ME,
                                                                         "updated_at": "x", "password": PASSWORD}}))
    assert "password" not in wa.AccountRegistry().get(HOST)         # nothing but the three fields is ever read back


# ---- the adapter hook (Rule 4 and the wiring) ------------------------------------------------------------------- #

def adapter_auth(server, *, manual_sign_in):
    async def go():
        a = WorkdayAdapter()
        a.human_wait_s, a.try_sign_in = 0, not manual_sign_in
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            context = await browser.new_context()
            await context.route("**/*", server.serve)
            page = await context.new_page()
            await page.goto(PAGE_URL)
            try:
                return await a._authenticate(page, PROFILE, HOST, False, JOB)
            finally:
                await browser.close()
    return run(go())


def test_the_adapter_signs_in_through_the_new_manager():
    server = Workday(create="created")
    assert adapter_auth(server, manual_sign_in=False) is None
    assert len(server.signins) == 1 and saved()[HOST]["status"] == "verified"


def test_workday_manual_sign_in_flag_still_means_never_type_a_password():
    server = Workday()
    result = adapter_auth(server, manual_sign_in=True)
    assert result.status == MANUAL_REVIEW and result.reason == "WORKDAY_LOGIN"
    assert server.signins == [] and server.creates == []
    assert not (config.BASE / "workday_accounts.json").exists()


# ---- Rule 1 pinned directly: one click per tenant and e-mail ------------------------------------------------------- #

def two_sign_ins(server, *, reload_between=False):
    async def go():
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            context = await browser.new_context()
            await context.route("**/*", server.serve)
            page = await context.new_page()
            await page.goto(PAGE_URL)
            try:
                first = await wa._sign_in_once(page, HOST, ME, PASSWORD)
                if reload_between:
                    await page.reload()
                second = await wa._sign_in_once(page, HOST, ME, PASSWORD)
                return first, second
            finally:
                await browser.close()
    return run(go())


def test_a_refused_sign_in_is_never_clicked_a_second_time():
    server = Workday()
    first, second = two_sign_ins(server)
    assert first[0] == "error" and second == ("blocked", "")
    assert len(server.signins) == 1                                # the second call never touched the page


def test_a_successful_sign_in_frees_the_budget_for_the_next_job_on_that_tenant():
    server = Workday(accounts={ME: {"password": PASSWORD, "verified": True}})
    first, second = two_sign_ins(server, reload_between=True)
    assert first[0] == "ok" and second[0] == "ok" and len(server.signins) == 2
