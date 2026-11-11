"""Shared apply loop for deterministic ATS adapters.

An adapter only knows how to (a) turn its form into FormField objects and
(b) put a value into one of them. Everything that decides *what* to answer
lives in answers.AnswerEngine; everything about *whether* to submit lives here:

    open -> prequalify page text -> extract -> answer -> fill -> (re-extract for
    conditional fields) -> stop if any required question is unanswered -> submit
"""
from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field

from playwright.async_api import Page, TimeoutError as PWTimeout

import config
import essays
from answers import AnswerEngine, Context, Decision, Question

SUBMITTED = "submitted"
DRY_RUN_OK = "dry_run_ok"
MANUAL_REVIEW = "manual_review"
SKIPPED_INELIGIBLE = "skipped_ineligible"
CLOSED = "closed"
ERROR = "error"


@dataclass
class FormField:
    question: Question
    sel: str                      # unique CSS selector of the control (or its container)
    widget: str                   # adapter-specific widget name
    extra: dict = field(default_factory=dict)

    @property
    def key(self) -> str:
        return f"{self.widget}|{self.question.field_id or self.question.label}"


@dataclass
class ApplyResult:
    status: str
    reason: str = ""
    detail: str = ""
    answers: list[dict] = field(default_factory=list)
    unknowns: list[str] = field(default_factory=list)
    screenshot: str = ""


class FillError(RuntimeError):
    pass


# Hard disqualifiers stated in the posting itself (spec step 3). Deliberately
# narrow: EEO boilerplate mentions citizenship and veterans on every page.
_DISQUALIFIERS = [
    (r"u\.?s\.? citizenship (is )?(a )?(required|requirement|mandatory)|"
     r"(must|required to|need to|shall) (be|hold|have|possess)\b.{0,30}u\.?s\.? citizen(ship)?\b(?!.{0,40}"
     r"(or|permanent resident|green card|authoriz))|only u\.?s\.? citizens",
     "requires U.S. citizenship"),
    (r"(must|required to|need to|ability to|able to) (hold|have|possess|obtain|maintain)\b.{0,40}"
     r"(security )?clearance|active (top )?secret|\bts/sci\b|clearance (is )?required",
     "requires a security clearance"),
    (r"(currently|must be) (enrolled in|attending|a) (a )?high school|high school (students?|juniors?|seniors?) "
     r"(only|who|are)|for high school students", "for high-school students"),
    (r"(must be|currently) (enrolled in|pursuing|working towards?) an? (ph\.?d|doctoral|master'?s|m\.?s\.?|mba)\b"
     r"(?!.{0,60}(bachelor|undergrad|b\.?s\.?\b|or\b))",
     "open to graduate students only"),
]
_CLOSED = re.compile(
    r"no longer (accepting|available|open)|position (has been|is) (filled|closed)|job (posting )?(has )?(expired|closed)|"
    r"this job is (closed|no longer)|page (not found|you.re looking for)|job not found|"
    r"the job you are looking for|not accepting applications|posting is closed", re.I)


_US_PERSON = re.compile(
    r"must be an? u\.?s\.? person|u\.?s\.? person(s)? (status|is required|are required|only)|"
    r"requires? .{0,60}u\.?s\.? person|limited to u\.?s\.? persons?|itar requirements?|"
    r"(subject to|governed by|comply with|compliance with) .{0,40}(itar|international traffic in arms|"
    r"export administration)|export[- ]controlled (information|items|technology|data)")
_NO_SPONSORSHIP = re.compile(
    r"(do not|don.t|does not|doesn.t|cannot|can.t|unable to|will not|won.t|not able to|are not able to) "
    r"(currently )?(offer |provide |facilitate )?(any )?(visa |immigration |employment |work )?sponsor|"
    r"no (visa |immigration |work )?sponsorship|sponsorship (is|will) not (be )?(available|offered|provided)|"
    r"not (eligible|available) for (visa |immigration )?sponsorship|"
    r"without (the )?(need for )?(current or future )?(visa |employer |immigration )?sponsorship")


def prequalify_text(text: str, profile: dict | None = None, job: dict | None = None) -> tuple[str, str] | None:
    """Check the posting text for hard blockers. Returns (status, reason) or None if eligible."""
    low = " ".join(text.lower().replace("’", "'").split())
    for pattern, reason in _DISQUALIFIERS:
        if re.search(pattern, low):
            return SKIPPED_INELIGIBLE, reason
    auth = (profile or {}).get("work_authorization", {})
    if _US_PERSON.search(low):
        us_person = auth.get("us_person")           # true / false / null (not stated)
        if us_person is False:
            return SKIPPED_INELIGIBLE, "restricted to U.S. persons (ITAR / export control)"
        if us_person is None:
            return MANUAL_REVIEW, "US_PERSON_REQUIRED"
    listed_no = (job or {}).get("sponsorship") == "Does Not Offer Sponsorship"
    if auth.get("requires_sponsorship") and not auth.get("apply_when_no_sponsorship") \
            and (listed_no or _NO_SPONSORSHIP.search(low)):
        return SKIPPED_INELIGIBLE, "employer states it does not sponsor work visas"
    return None


class BaseAdapter:
    name = "base"
    form_ready_selector = "form"
    # Seconds to wait for the candidate to clear a human-verification step
    # (CAPTCHA, emailed code) in a visible browser. 0 = unattended: such
    # postings go straight to manual review. Set by the runner (--assist).
    human_wait_s = 0
    # Open-ended questions the fact rules cannot answer are drafted from the
    # resume by essays.generate (templates, or Claude when a key is set).
    write_essays = True

    # ---- adapter hooks ----------------------------------------------------
    def form_url(self, job: dict) -> str:
        return job["url"]

    async def extract(self, page: Page) -> list[FormField]:
        raise NotImplementedError

    async def read_options(self, page: Page, f: FormField) -> list[str]:
        return f.question.options

    async def fill(self, page: Page, f: FormField, value, profile: dict) -> None:
        raise NotImplementedError

    def special(self, f: FormField, profile: dict) -> Decision | None:
        """Adapter-owned fields that should bypass the generic engine."""
        return None

    async def submit(self, page: Page) -> tuple[str, str, str]:
        """Click submit. Returns (status, reason, detail)."""
        raise NotImplementedError

    async def page_text(self, page: Page) -> str:
        try:
            return await page.inner_text("body", timeout=5000)
        except PWTimeout:
            return ""

    async def job_text(self, page: Page, job: dict) -> str:
        """Posting description used for pre-qualification. Adapters whose form page
        does not show the description fetch it from the ATS's public posting API."""
        return await self.page_text(page)

    # ---- shared flow ------------------------------------------------------
    async def apply(self, page: Page, job: dict, engine: AnswerEngine, ctx: Context,
                    *, dry_run: bool, shot_path: str) -> ApplyResult:
        resp = await page.goto(self.form_url(job), wait_until="domcontentloaded",
                               timeout=config.PAGE_TIMEOUT_S * 1000)
        if resp is not None and resp.status in (404, 410):
            return ApplyResult(CLOSED, "posting not found", f"HTTP {resp.status}")
        try:
            await page.wait_for_selector(self.form_ready_selector, timeout=20000)
        except PWTimeout:
            text = await self.page_text(page)
            if _CLOSED.search(text):
                return ApplyResult(CLOSED, "posting closed")
            return ApplyResult(MANUAL_REVIEW, "FORM_NOT_FOUND", "application form did not render")
        await page.wait_for_timeout(1500)

        if _CLOSED.search((await self.page_text(page))[:3000]):
            return ApplyResult(CLOSED, "posting closed")
        text = await self.job_text(page, job)
        if not text.strip():
            return ApplyResult(MANUAL_REVIEW, "NO_JOB_DESCRIPTION",
                               "could not read the posting text to check eligibility")
        if job.get("term_unverified") and not re.search(r"2027|\bsummer\b", text, re.I):
            return ApplyResult(SKIPPED_INELIGIBLE, "posting does not mention Summer or 2027")
        blocked = prequalify_text(text, engine.p, job)
        if blocked:
            status, reason = blocked
            detail = ("the posting is limited to U.S. persons (ITAR / export control); set "
                      "work_authorization.us_person in the profile") if reason == "US_PERSON_REQUIRED" else ""
            return ApplyResult(status, reason, detail)

        answers: list[dict] = []
        unknowns: list[str] = []
        handled: set[str] = set()
        for _ in range(4):                       # re-extract: answers can reveal new fields
            fields = await self.extract(page)
            fresh = [f for f in fields if f.key not in handled]
            if not fresh:
                break
            ctx.labels = [f.question.label for f in fields]
            for f in fresh:
                handled.add(f.key)
                q = f.question
                decision = self.special(f, engine.p)
                if decision is None:
                    if f.extra.get("lazy_options") and not q.options:
                        try:
                            q.options = await self.read_options(page, f)
                        except Exception as exc:          # noqa: BLE001 - widget quirks
                            q.options = []
                            f.extra["options_error"] = str(exc)[:120]
                    decision = engine.resolve(q, ctx)
                if decision.action != "fill" and q.kind in ("textarea", "text") and self.write_essays \
                        and decision.rule in ("no-rule", "experience", "follow-up", "essay-project", "essay-why-swe"):
                    draft = await asyncio.to_thread(
                        essays.generate, q.label, job, text, engine.p, q.description, q.required,
                        38 if q.kind == "text" else None)        # single-line inputs: keep it short
                    if draft:
                        decision = Decision("fill", draft[1], draft[0])
                if decision.action == "fill":
                    try:
                        await self.fill(page, f, decision.value, engine.p)
                    except Exception as exc:              # noqa: BLE001
                        note = f"could not fill: {type(exc).__name__}: {str(exc)[:140]}"
                        decision = Decision("unknown" if q.required else "skip", rule=decision.rule, note=note)
                answers.append({"label": q.label, "kind": q.kind, "required": q.required,
                                "action": decision.action, "value": _loggable(decision.value),
                                "rule": decision.rule, "note": decision.note})
                if decision.action == "unknown":
                    unknowns.append(q.label)
            await page.wait_for_timeout(400)

        if not answers:
            return ApplyResult(MANUAL_REVIEW, "FORM_NOT_FOUND", "no form fields detected")
        await _screenshot(page, shot_path)
        if unknowns:
            return ApplyResult(MANUAL_REVIEW, "UNANSWERED_REQUIRED",
                               " | ".join(u[:90] for u in unknowns[:8]), answers, unknowns, shot_path)
        if dry_run:
            return ApplyResult(DRY_RUN_OK, "all required questions answered (not submitted)",
                               answers=answers, screenshot=shot_path)

        status, reason, detail = await self.submit(page)
        if status != SUBMITTED:
            await _screenshot(page, shot_path)
        return ApplyResult(status, reason, detail, answers, unknowns, shot_path)


class SubmitWatch:
    """Polls after the submit click; optionally waits on a human for verification steps."""

    def __init__(self, adapter: BaseAdapter, seconds: float):
        self.adapter = adapter
        self.deadline = time.monotonic() + seconds
        self.gate: tuple[str, str] | None = None

    def running(self) -> bool:
        return time.monotonic() < self.deadline

    def human_gate(self, reason: str, detail: str) -> tuple[str, str, str] | None:
        """A human-verification step is showing. Returns a final result, or None to keep waiting."""
        wait = self.adapter.human_wait_s
        if not wait:
            return MANUAL_REVIEW, reason, detail
        if self.gate is None:
            self.gate = (reason, detail)
            self.deadline = time.monotonic() + wait
            what = ("Paste the 8-character code from your email into the browser window "
                    "(it is submitted for you once entered)" if reason == "EMAIL_VERIFICATION_CODE"
                    else "Solve CAPTCHA in browser window and click Submit")
            print(f"\a[ACTION REQUIRED] {what}... (waiting up to {wait}s; the form is already filled)",
                  flush=True)
        return None

    def timed_out(self) -> tuple[str, str, str]:
        if self.gate:
            return MANUAL_REVIEW, self.gate[0], self.gate[1] + " (not completed in time)"
        return MANUAL_REVIEW, "NO_CONFIRMATION", "no confirmation after clicking submit"


def fetch_json(url: str):
    """Small synchronous GET for public posting APIs (run via asyncio.to_thread)."""
    import requests
    try:
        r = requests.get(url, timeout=20)
        return r.json() if r.ok else None
    except (requests.RequestException, ValueError):
        return None


def strip_html(text: str) -> str:
    import html
    return " ".join(re.sub(r"<[^>]+>", " ", html.unescape(html.unescape(text or ""))).split())


def _loggable(value):
    if isinstance(value, str) and len(value) > 160:
        return value[:157] + "..."
    return value


async def _screenshot(page: Page, path: str) -> None:
    try:
        await page.screenshot(path=path, full_page=True, timeout=15000)
    except Exception:                                     # noqa: BLE001 - never fail on a screenshot
        pass


# ---- small helpers shared by adapters ----------------------------------- #

CAPTCHA_FRAME = re.compile(r"recaptcha/(api2|enterprise)/bframe|hcaptcha\.com/.*(challenge|frame)|"
                           r"challenges\.cloudflare\.com|arkoselabs|funcaptcha", re.I)


async def visible_captcha(page: Page) -> bool:
    """A challenge the candidate must solve by hand is on screen (never auto-solved)."""
    for frame in page.frames:
        if not CAPTCHA_FRAME.search(frame.url or ""):
            continue
        try:
            el = await frame.frame_element()
            box = await el.bounding_box()
            if box and box["width"] > 100 and box["height"] > 100 and await el.is_visible():
                return True
        except Exception:                                 # noqa: BLE001
            continue
    return False


def phone_for(profile: dict, national_only: bool = False) -> str:
    ident = profile["identity"]
    return ident["phone_digits"] if national_only else ident["phone_formatted"]
