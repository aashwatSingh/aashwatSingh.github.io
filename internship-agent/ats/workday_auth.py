"""Lockout-proof Workday sign-in.

Workday locks an account after a few wrong passwords, and the same "wrong email address or password
or your account might be locked" banner covers "no such account", "different password" and "locked".
So this module never guesses and never repeats:

* One Sign In click per tenant and per set of credentials (counted *before* the click). A second try
  is never made, in this run or, because every failure is saved, in the next.
* Each tenant (its normalised hostname) is remembered in workday_accounts.json (git-ignored, written
  atomically with a .backup copy like custom_answers.json): verified / needs_verify / manual_auth /
  locked, plus the e-mail used and when. Passwords are never written there, nor logged, nor typed
  from anywhere but .env (WORKDAY_PASSWORD).
* Unknown tenant: Sign In once. Refused -> Create Account once, with the same e-mail and password:
    A. created and signed in           -> verified
    B. "verify your e-mail"            -> needs_verify; the verification link is read from Gmail over IMAP
                                          (GMAIL_APP_PASSWORD, as for Greenhouse), opened in a temporary
                                          tab -> verified; Sign In once
    C. "account already exists"        -> manual_auth: an account exists with a password we do not have
* manual_auth / locked, a refused sign-in on a verified tenant, or Outcome C: nothing more is typed.
  Attended (allow_manual): terminal bell, Discord ping with a screenshot, wait for you to sign in or
  reset the password in Chrome, or for `!skip`. Unattended: straight to manual review.
* A missing or weak WORKDAY_PASSWORD is never submitted: the sign-in is handed to you.
* Fields are cleared (click, Ctrl+A, Backspace) before typing so Chrome's saved logins cannot leak in.

`ensure_workday_signed_in()` is the only entry point; ats/workday.py calls it from _authenticate.
"""
from __future__ import annotations

import asyncio
import email
import email.policy
import html
import imaplib
import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import config
import imap_otp
import phone_notify
from fileutil import atomic_write_text, file_lock, read_json
from urls import host_matches

AID = '[data-automation-id="{}"]'
WORKDAY_HOSTS = ("myworkdayjobs.com", "myworkdaysite.com")
LINK_HOSTS = WORKDAY_HOSTS + ("myworkday.com", "workday.com")        # where a verification link may point

VERIFIED, NEEDS_VERIFY, MANUAL_AUTH, LOCKED = "verified", "needs_verify", "manual_auth", "locked"
STATUSES = (VERIFIED, NEEDS_VERIFY, MANUAL_AUTH, LOCKED)

REASON = "WORKDAY_LOGIN"                    # the Unblock Queue shows this as a sign-in blocker (unblock.KINDS)
MISMATCH = "Workday existing account / password mismatch"
VERIFY_WAIT_S = 60                          # how long to look for the verification e-mail
SIGN_IN_WAIT_S = 12
CREATE_WAIT_S = 15

AUTH_STEP = re.compile(r"sign in|create account|log ?in", re.I)
_BANNER = ('[data-automation-id="errorMessage"], [data-automation-id="inputAlert"], '
           '[data-automation-id="errorBanner"], [role="alert"]')
_HARD_LOCK = re.compile(r"account (has been|is) (temporarily )?(locked|disabled|suspended)|too many (failed )?"
                        r"(sign.?in |log.?in )?attempts|locked out", re.I)
_UNVERIFIED = re.compile(r"verify your e-?mail|e-?mail (address )?(has not|hasn.t|is not) (been )?verified|"
                         r"not (yet )?verified|activate your account", re.I)
_EXISTS = re.compile(r"already exists|already in use|already registered|associated with an existing account|"
                     r"account with (this|that|the same) e-?mail", re.I)
_VERIFY = re.compile(r"verify your e-?mail|check your (inbox|e-?mail)|verification (e-?mail|link)|"
                     r"we.ve sent (you )?(an )?e-?mail|sent (you )?(an )?e-?mail", re.I)
_VERIFY_MAIL = re.compile(r"verif|confirm|activat", re.I)
_LINK_HINT = re.compile(r"verif|activat|confirm|token|key=|uuid|account", re.I)
_STALE_FIELDS = re.compile(r"^formField-(email|password|verifyPassword|username)$", re.I)


# ---- the per-tenant registry (workday_accounts.json) --------------------------------------------- #

def accounts_path() -> Path:
    return config.BASE / "workday_accounts.json"


def backup_path(path: Path) -> Path:
    return path.with_name(path.stem + ".backup" + path.suffix)


def normalize_host(url_or_host: str) -> str:
    """'https://Acme.WD5.myworkdayjobs.com:443/x/job/y' -> 'acme.wd5.myworkdayjobs.com'."""
    value = str(url_or_host or "").strip()
    return (urlparse(value if "//" in value else "//" + value).hostname or "").lower().rstrip(".")


def _clean(data) -> dict:
    """Only well-formed entries, and only the three fields: nothing else (never a password) is kept."""
    out = {}
    for host, rec in (data.items() if isinstance(data, dict) else []):
        if isinstance(rec, dict) and rec.get("status") in STATUSES:
            out[str(host)] = {"status": rec["status"], "email": str(rec.get("email") or ""),
                              "updated_at": str(rec.get("updated_at") or "")}
    return out


class AccountRegistry:
    """{tenant_host: {status, email, updated_at}}. Atomic writes, plus a .backup copy to fall back on."""

    def __init__(self, path: Path | None = None):
        self._path = Path(path) if path else None

    @property
    def path(self) -> Path:
        return self._path or accounts_path()

    def load(self) -> dict:
        for candidate in (self.path, backup_path(self.path)):
            data = read_json(candidate)
            if isinstance(data, dict):
                return _clean(data)
        return {}

    def get(self, host: str) -> dict | None:
        return self.load().get(normalize_host(host))

    def set(self, host: str, status: str, email_address: str = "") -> dict:
        if status not in STATUSES:
            raise ValueError(f"unknown Workday account status: {status}")
        host = normalize_host(host)
        record = {"status": status, "email": email_address, "updated_at": time.strftime("%Y-%m-%d %H:%M:%S")}
        with file_lock(self.path):
            data = self.load()
            data[host] = record
            text = json.dumps(data, indent=1, ensure_ascii=False)
            for target in (self.path, backup_path(self.path)):
                try:
                    atomic_write_text(target, text)
                except OSError:
                    if target == self.path:
                        raise                       # the backup is best effort; the record is not
        return record


# ---- the password (.env only) -------------------------------------------------------------------- #

def workday_password() -> str:
    return os.environ.get("WORKDAY_PASSWORD", "").strip()


def password_problem(password: str) -> str:
    """'' when `password` meets Workday's usual rules; else what is wrong (never the password itself)."""
    if not password:
        return "WORKDAY_PASSWORD is not set in .env"
    if (len(password) < 8 or not re.search(r"[a-z]", password) or not re.search(r"[A-Z]", password)
            or not re.search(r"\d", password) or not re.search(r"[^A-Za-z0-9]", password)):
        return ("WORKDAY_PASSWORD in .env is too weak for Workday (8+ characters with an upper-case letter, "
                "a lower-case letter, a digit and a symbol)")
    return ""


# ---- page helpers ---------------------------------------------------------------------------------- #

async def _visible(page, aid: str) -> bool:
    loc = page.locator(AID.format(aid)).first
    try:
        return await loc.count() > 0 and await loc.is_visible()
    except Exception:                                      # noqa: BLE001
        return False


async def _click_aid(page, aid: str) -> None:
    """Workday lays a transparent "click_filter" over some buttons and the overlay carries the handler:
    click what a person would hit, and only force the button underneath as a last resort."""
    el = page.locator(AID.format(aid)).first
    try:
        await el.click(timeout=2500)
        return
    except Exception:                                      # noqa: BLE001
        pass
    try:
        label = " ".join((await el.inner_text(timeout=1500)).split())
    except Exception:                                      # noqa: BLE001
        label = ""
    overlay = page.locator(f'[data-automation-id="click_filter"][aria-label="{label}"]') if label else None
    if overlay is not None and await overlay.count():
        await overlay.first.hover()
        await overlay.first.click(timeout=5000)
    else:
        await el.click(force=True)


async def _type_clean(page, aid: str, value: str) -> None:
    """Clear whatever Chrome autofilled or a previous try left (click, Ctrl+A, Backspace), then type."""
    loc = page.locator(AID.format(aid)).first
    await loc.click()
    await page.keyboard.press("Control+A")
    await page.keyboard.press("Backspace")
    await loc.fill(value)


async def _step(page) -> str:
    loc = page.locator(AID.format("progressBarActiveStep")).first
    try:
        raw = await loc.inner_text(timeout=1500) if await loc.count() else ""
    except Exception:                                      # noqa: BLE001
        return ""
    return re.sub(r"^\s*current step \d+ of \d+\s*", "", " ".join(raw.split()), flags=re.I).strip()


async def is_past_auth(page) -> bool:
    """Signed in: no sign-in / create-account form, and either the step bar has moved on, a Sign Out /
    user menu is showing, or an application form is."""
    for aid in ("signInSubmitButton", "createAccountSubmitButton", "SignInWithEmailButton"):
        if await _visible(page, aid):
            return False
    step = await _step(page)
    if step:
        return not AUTH_STEP.search(step)
    try:
        if await page.locator(f'{AID.format("utilityButtonSignOut")}, {AID.format("utilityMenuButton")}, '
                              'button:has-text("Sign Out"), a:has-text("Sign Out")').count():
            return True
        return bool(await page.evaluate(
            """(skip) => [...document.querySelectorAll('[data-automation-id^="formField-"]')].some(
                 w => w.offsetParent !== null && !new RegExp(skip, 'i').test(w.getAttribute('data-automation-id')))""",
            _STALE_FIELDS.pattern))
    except Exception:                                      # noqa: BLE001 - page navigating
        return False


async def _banner(page) -> str:
    try:
        texts = await page.locator(_BANNER).all_inner_texts()
    except Exception:                                      # noqa: BLE001
        return ""
    return " | ".join(dict.fromkeys(" ".join(t.split()) for t in texts if t.strip()))[:300]


async def _body(page) -> str:
    try:
        return " ".join((await page.inner_text("body", timeout=3000)).split())
    except Exception:                                      # noqa: BLE001
        return ""


# ---- Sign In: at most one click per tenant and credentials ------------------------------------------- #

_sign_in_clicks: dict[tuple[str, str], int] = {}           # clicks since this account last changed state


def _budget(host: str, email_address: str) -> tuple[str, str]:
    return normalize_host(host), email_address.strip().lower()


async def _open_sign_in_form(page) -> bool:
    if await _visible(page, "SignInWithEmailButton"):
        await _click_aid(page, "SignInWithEmailButton")
        await page.wait_for_timeout(1500)
    if not await _visible(page, "signInSubmitButton") and await _visible(page, "signInLink"):
        await _click_aid(page, "signInLink")               # landed on the create-account form
        await page.wait_for_timeout(1500)
    return await _visible(page, "email") and await _visible(page, "signInSubmitButton")


async def _auth_result(page, clicked_at: float, seconds: float, code_step=None) -> tuple[str, str]:
    """After a Sign In click: ('ok', '') | ('locked' | 'unverified' | 'error', banner text) | ('unclear', '')."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        await page.wait_for_timeout(400)
        if await is_past_auth(page):
            return "ok", ""
        text = await _banner(page)
        if text:
            kind = "locked" if _HARD_LOCK.search(text) else "unverified" if _UNVERIFIED.search(text) else "error"
            return kind, text
    if code_step is not None:                              # an e-mailed sign-in code, entered from Gmail
        try:
            if await code_step(page, clicked_at) == "entered":
                return await _auth_result(page, clicked_at, 20)
        except Exception:                                  # noqa: BLE001 - never fail the sign-in on this
            pass
    return "unclear", ""


async def _sign_in_once(page, host: str, email_address: str, password: str, code_step=None) -> tuple[str, str]:
    """Click Sign In once. 'blocked' when this tenant and e-mail already used their one click; 'no_form'
    when no click was made because the sign-in form was not recognised."""
    key = _budget(host, email_address)
    if _sign_in_clicks.get(key, 0) >= 1:
        return "blocked", ""
    if not await _open_sign_in_form(page):
        return "no_form", ""
    await _type_clean(page, "email", email_address)
    await _type_clean(page, "password", password)
    _sign_in_clicks[key] = 1                               # counted before the click: a crash cannot buy a retry
    clicked_at = time.time()
    await _click_aid(page, "signInSubmitButton")
    result = await _auth_result(page, clicked_at, SIGN_IN_WAIT_S, code_step)
    if result[0] == "ok":
        _sign_in_clicks.pop(key, None)                     # these credentials work: signing in again is safe
    return result


# ---- Create Account ---------------------------------------------------------------------------------- #

_create_clicks: dict[str, int] = {}


async def _create_account(page, host: str, email_address: str, password: str) -> str:
    """'created' | 'needs_verify' | 'exists' | 'unclear' | 'no_form'."""
    host = normalize_host(host)
    if _create_clicks.get(host, 0) >= 1:
        return "no_form"
    link = page.locator(f'{AID.format("createAccountLink")}, a:has-text("Create Account"), '
                        'button:has-text("Create Account")').first
    try:
        if await link.count() == 0 or not await link.is_visible():
            return "no_form"
        await link.click(timeout=4000)
        await page.wait_for_selector(AID.format("verifyPassword"), state="visible", timeout=8000)
    except Exception:                                      # noqa: BLE001
        return "no_form"
    await _type_clean(page, "email", email_address)
    await _type_clean(page, "password", password)
    await _type_clean(page, "verifyPassword", password)
    if await _visible(page, "createAccountCheckbox"):
        await page.locator(AID.format("createAccountCheckbox")).first.check(force=True)
    _create_clicks[host] = 1
    await _click_aid(page, "createAccountSubmitButton")
    deadline = time.monotonic() + CREATE_WAIT_S
    while time.monotonic() < deadline:
        await page.wait_for_timeout(500)
        if await is_past_auth(page):
            return "created"
        text = (await _banner(page)) + " " + (await _body(page))
        if _EXISTS.search(text):
            return "exists"
        if _VERIFY.search(text):
            return "needs_verify"
    return "unclear"


# ---- the verification e-mail (IMAP, the same Gmail connection as imap_otp.py) ---------------------------- #

def find_verification_link(msg, host: str, company: str = "") -> str | None:
    """The e-mail's verification link, if this is a Workday verification mail for this tenant/company.
    Only links on Workday's own domains are ever returned."""
    bodies = imap_otp.message_bodies(msg)
    subject = str(msg.get("Subject", ""))
    text = " ".join(imap_otp.to_text(b) for b in bodies)
    if not _VERIFY_MAIL.search(subject + " " + text):
        return None
    slug = normalize_host(host).split(".")[0]
    names = [n for n in (slug, re.sub(r"[^a-z0-9]", "", company.lower())) if len(n) >= 3]
    haystack = re.sub(r"[^a-z0-9]", "", (subject + " " + text).lower())
    links = []
    for body in bodies:
        for url in re.findall(r"https?://[^\s\"'<>)]+", html.unescape(body)):
            url = url.rstrip(".,;")
            if host_matches(url, *LINK_HOSTS) and _LINK_HINT.search(url):
                links.append(url)
    shared = host_matches(host, "myworkdaysite.com")        # one host, many tenants: the name must match too
    for url in links:
        named = any(n in url.lower() or n in haystack for n in names)
        if host_matches(url, *WORKDAY_HOSTS):               # a tenant's own host: it must be this tenant's
            relevant = normalize_host(url) == normalize_host(host) and (named or not shared)
        else:                                               # myworkday.com / workday.com serve every tenant
            relevant = named
        if relevant:
            return url
    return None


def _newest_link(conn, since: float, host: str, company: str) -> str | None:
    for box in imap_otp.MAILBOXES:
        try:
            typ, _ = conn.select(box, readonly=True)
        except imaplib.IMAP4.error:
            continue
        if typ != "OK":
            continue
        typ, data = conn.uid("search", None, "SINCE", imap_otp._imap_date(since - 86400))
        uids = data[0].split()[-25:] if typ == "OK" and data and data[0] else []
        if not uids:
            continue
        typ, data = conn.uid("fetch", b",".join(uids), "(INTERNALDATE BODY.PEEK[])")
        found = []
        for item in (data or []) if typ == "OK" else []:
            if not isinstance(item, tuple):
                continue
            when = imaplib.Internaldate2tuple(item[0])
            if not when or time.mktime(when) < since - imap_otp.CLOCK_SLACK_S:
                continue
            found.append((time.mktime(when), item[1]))
        for _, raw in sorted(found, key=lambda f: f[0], reverse=True):
            link = find_verification_link(email.message_from_bytes(raw, policy=email.policy.default), host, company)
            if link:
                return link
    return None


def fetch_verification_link(address: str, app_password: str, since: float, host: str, company: str = "", *,
                            timeout: float = VERIFY_WAIT_S, interval: float = imap_otp.POLL_INTERVAL_S,
                            connect=None, sleep=time.sleep) -> str | None:
    """Poll Gmail (read-only, BODY.PEEK) for the verification link mailed after `since`. Blocking:
    run it with asyncio.to_thread. Raises on IMAP errors; None when nothing arrived within `timeout`."""
    conn = (connect or imaplib.IMAP4_SSL)(imap_otp.IMAP_HOST, imap_otp.IMAP_PORT)
    try:
        conn.login(address, app_password.replace(" ", ""))
        deadline = time.monotonic() + timeout
        while True:
            link = _newest_link(conn, since, host, company)
            if link or time.monotonic() + interval > deadline:
                return link
            sleep(interval)
    finally:
        try:
            conn.logout()
        except Exception:                                  # noqa: BLE001
            pass


async def _verify_by_mail(page, profile: dict, host: str, company: str, since: float, fetch_link) -> bool:
    """Read the verification link from Gmail and open it in a temporary tab. True when it was opened."""
    app_password = os.environ.get("GMAIL_APP_PASSWORD", "").strip()
    if not app_password and fetch_link is None:
        return False
    address = os.environ.get("GMAIL_ADDRESS") or (profile.get("identity") or {}).get("email", "")
    try:
        link = await asyncio.to_thread(fetch_link or fetch_verification_link, address, app_password, since, host, company)
    except Exception as exc:                               # noqa: BLE001 - bad app password, IMAP blocked
        print(f"      Could not read the Workday verification e-mail ({type(exc).__name__})", flush=True)
        return False
    if not link or not host_matches(link, *LINK_HOSTS):
        return False
    temp = await page.context.new_page()
    try:
        await temp.goto(link, wait_until="domcontentloaded", timeout=30000)
        await temp.wait_for_timeout(2500)
    except Exception as exc:                               # noqa: BLE001
        print(f"      The verification link did not open cleanly ({type(exc).__name__})", flush=True)
    finally:
        await temp.close()
    return True


# ---- the human / Discord hand-over --------------------------------------------------------------------- #

@dataclass
class AuthResult:
    ok: bool
    reason: str = ""            # ApplyResult.reason when not ok
    detail: str = ""
    status: str = ""            # the tenant's status in workday_accounts.json afterwards ("" = untouched)
    skipped: bool = False       # `!skip` from the phone


async def _blank_password_fields(page) -> None:
    try:
        await page.evaluate("""() => document.querySelectorAll('input[type=password]').forEach(i => { i.value = ''; })""")
    except Exception:                                      # noqa: BLE001
        pass


async def _hand_over(page, host: str, email_address: str, registry: AccountRegistry, *, status: str | None,
                     terminal: str, phone: str, notifier, allow_manual: bool, wait_s: float, poll_ms: int,
                     reason: str = REASON) -> AuthResult:
    """Stop typing. Save `status` first (so even a crash cannot make the next run try again), then wait
    for the candidate: signed in by hand (-> manual_auth), `!skip`, or time out."""
    if status:
        registry.set(host, status, email_address)
    if not allow_manual:
        return AuthResult(False, reason, terminal, status or "")
    print(f"\a[ACTION REQUIRED] {terminal} (waiting up to {int(wait_s)}s)", flush=True)
    if getattr(notifier, "enabled", False):
        await _blank_password_fields(page)                 # no password can be in the picture
        try:
            png = await page.screenshot(type="png")
        except Exception:                                  # noqa: BLE001
            png = None
        try:
            await asyncio.to_thread(notifier.send_message, phone, png)
        except Exception:                                  # noqa: BLE001 - the phone is a bonus, never a blocker
            pass
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        await page.wait_for_timeout(poll_ms)
        if await is_past_auth(page):
            if status:                                     # signed in by hand on an account we cannot type into
                registry.set(host, MANUAL_AUTH, email_address)
            return AuthResult(True, status=MANUAL_AUTH if status else "")
        if getattr(notifier, "enabled", False):
            try:
                reply = await notifier.apoll_reply()
            except Exception:                              # noqa: BLE001
                reply = None
            if reply == "/skip":
                return AuthResult(False, "SKIPPED_FROM_PHONE", "Workday sign-in skipped from the phone",
                                  status or "", skipped=True)
    return AuthResult(False, reason, terminal + " (not completed in time)", status or "")


# ---- the state machine -------------------------------------------------------------------------------------- #

async def ensure_workday_signed_in(page, profile: dict, *, notifier=None, allow_manual: bool = True,
                                   company: str = "", registry: AccountRegistry | None = None, code_step=None,
                                   fetch_link=None, manual_wait_s: float = 240, poll_ms: int = 800) -> AuthResult:
    """Get past Workday's Create Account / Sign In with at most one Sign In click and one Create Account
    click per tenant. See the module docstring. Never raises for an ordinary page problem: the result says
    what to do (ok, or a manual-review reason)."""
    if await is_past_auth(page):                           # Rule 0: nothing to do (saved session, or signed in)
        return AuthResult(True)
    host = normalize_host(page.url)
    if not host_matches(page.url, *WORKDAY_HOSTS):         # never type a password off Workday's own domains
        return AuthResult(False, REASON, f"sign-in page is not on a Workday domain ({host[:60]})")
    registry = registry or AccountRegistry()
    notifier = notifier if notifier is not None else phone_notify.notifier()
    identity = (profile.get("portal") or {}).get("username") or (profile.get("identity") or {}).get("email") or ""
    email_address = str(identity).strip()
    company = company or host.split(".")[0]
    password = workday_password()

    def hand_over(status, terminal, phone):
        return _hand_over(page, host, email_address, registry, status=status, terminal=terminal, phone=phone,
                          notifier=notifier, allow_manual=allow_manual, wait_s=manual_wait_s, poll_ms=poll_ms)

    def existing_account(why):
        """Rule 3: an account exists here that we cannot sign in to. Nothing more is typed."""
        return hand_over(
            why, f"{MISMATCH}: sign in to {company} ({host}) in the browser, or reset its password",
            f"Workday sign-in needs you on {company} ({host}) — account exists with a different password or is "
            "locked. Sign in / reset password in Chrome, or reply !skip.")

    problem = password_problem(password) if email_address else "no e-mail address in the profile"
    if problem:                                            # never submit garbage
        return await hand_over(None, f"{problem}. Sign in to {host} in the browser window",
                               f"Workday sign-in needs you on {company} ({host}) — {problem}. Sign in in Chrome, "
                               "or reply !skip.")

    status = (registry.get(host) or {}).get("status")
    if status in (MANUAL_AUTH, LOCKED):
        return await existing_account(status)

    async def finish_verification(since: float) -> AuthResult | None:
        """needs_verify: Gmail -> link -> verified -> one Sign In. None means: hand it to the candidate."""
        registry.set(host, NEEDS_VERIFY, email_address)
        if not await _verify_by_mail(page, profile, host, company, since, fetch_link):
            return None
        registry.set(host, VERIFIED, email_address)
        _sign_in_clicks.pop(_budget(host, email_address), None)    # the account changed: its first sign-in is fresh
        if not await is_past_auth(page):
            if not await _visible(page, "signInSubmitButton"):
                try:
                    await page.reload(wait_until="domcontentloaded")
                except Exception:                          # noqa: BLE001
                    pass
            outcome, _ = await _sign_in_once(page, host, email_address, password, code_step)
            if outcome != "ok":
                return await existing_account(MANUAL_AUTH)
        return AuthResult(True, status=VERIFIED)

    if status == NEEDS_VERIFY:                             # an earlier run created the account and stopped
        done = await finish_verification(time.time() - 1800)
        if done is not None:
            return done
        return await hand_over(
            MANUAL_AUTH, f"Verify your e-mail for {company} ({host}) from the Workday message in Gmail, then sign in",
            f"Workday needs you on {company} ({host}) — verify the account from the e-mail Workday sent, then sign "
            "in in Chrome, or reply !skip.")

    outcome, text = await _sign_in_once(page, host, email_address, password, code_step)
    if outcome == "ok":
        registry.set(host, VERIFIED, email_address)
        return AuthResult(True, status=VERIFIED)
    if outcome == "no_form":                               # nothing was clicked, nothing was learned
        return await hand_over(None, f"Sign in to {host} in the browser window (unrecognised sign-in page)",
                               f"Workday sign-in needs you on {company} ({host}) — unrecognised sign-in page. "
                               "Sign in in Chrome, or reply !skip.")
    if outcome == "unclear":                               # clicked, no answer: do not click again
        return await hand_over(None, f"Sign in to {host} in the browser window (no answer after one sign-in try)",
                               f"Workday sign-in needs you on {company} ({host}) — no answer after one sign-in "
                               "try. Sign in in Chrome, or reply !skip.")
    if outcome == "locked" or status == VERIFIED or outcome == "blocked":
        return await existing_account(LOCKED if outcome == "locked" else MANUAL_AUTH)
    if outcome == "unverified":
        done = await finish_verification(time.time() - 1800)
        return done if done is not None else await hand_over(
            MANUAL_AUTH, f"Verify your e-mail for {company} ({host}) from the Workday message in Gmail, then sign in",
            f"Workday needs you on {company} ({host}) — verify the account from the e-mail Workday sent, then sign "
            "in in Chrome, or reply !skip.")

    # Unknown tenant, Sign In refused once: never retry it. Create the account instead.
    since = time.time() - imap_otp.CLOCK_SLACK_S
    created = await _create_account(page, host, email_address, password)
    _sign_in_clicks.pop(_budget(host, email_address), None)  # a new account: its first sign-in is fresh
    if created == "created":                               # Outcome A
        registry.set(host, VERIFIED, email_address)
        return AuthResult(True, status=VERIFIED)
    if created == "needs_verify":                          # Outcome B
        done = await finish_verification(since)
        if done is not None:
            return done
        return await hand_over(
            MANUAL_AUTH, f"Verify your e-mail for {company} ({host}) from the Workday message in Gmail, then sign in",
            f"Workday needs you on {company} ({host}) — verify the account from the e-mail Workday sent, then sign "
            "in in Chrome, or reply !skip.")
    return await existing_account(MANUAL_AUTH)             # Outcome C (and anything unrecognised): hands off
