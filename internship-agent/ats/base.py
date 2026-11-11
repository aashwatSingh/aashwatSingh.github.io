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
    (r"(must be|currently) (enrolled in|pursuing|working towards?) an? (ph\.?d|doctoral|master'?s|m\.?s\.?|mba)\b"
     r"(?!.{0,60}(bachelor|undergrad|b\.?s\.?\b|or\b))",
     "open to graduate students only"),
]
_CLOSED = re.compile(
    r"no longer (accepting|available|open)|position (has been|is) (filled|closed)|job (posting )?(has )?(expired|closed)|"
    r"this job is (closed|no longer)|page (not found|you.re looking for)|job not found|"
    r"the job you are looking for|not accepting applications|posting is closed", re.I)


def prequalify_text(text: str) -> str | None:
    low = " ".join(text.lower().split())
    for pattern, reason in _DISQUALIFIERS:
        if re.search(pattern, low):
            return reason
    return None


class BaseAdapter:
    name = "base"
    form_ready_selector = "form"
    # Seconds to wait for the candidate to clear a human-verification step
    # (CAPTCHA, emailed code) in a visible browser. 0 = unattended: such
    # postings go straight to manual review. Set by the runner (--assist).
    human_wait_s = 0
    # Optional callable(question, job, page_text, profile) -> str | None for
    # "Why this company?" essays (llm.why_company_answer). None = never drafted.
    essay_writer = None

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

    async def job_text(self, page: Page) -> str:
        try:
            return await page.inner_text("body", timeout=5000)
        except PWTimeout:
            return ""

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
            text = await self.job_text(page)
            if _CLOSED.search(text):
                return ApplyResult(CLOSED, "posting closed")
            return ApplyResult(MANUAL_REVIEW, "FORM_NOT_FOUND", "application form did not render")
        await page.wait_for_timeout(1500)

        text = await self.job_text(page)
        if _CLOSED.search(text[:3000]):
            return ApplyResult(CLOSED, "posting closed")
        reason = prequalify_text(text)
        if reason:
            return ApplyResult(SKIPPED_INELIGIBLE, reason)

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
                if decision.action == "unknown" and q.kind == "textarea" and self.essay_writer:
                    draft = await asyncio.to_thread(self.essay_writer, q.label, job, text, engine.p)
                    if draft:
                        decision = Decision("fill", draft, "llm-why-company")
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
            print(f"\a  >> {reason}: complete it in the browser window and submit "
                  f"(waiting up to {wait}s; the form is already filled)", flush=True)
        return None

    def timed_out(self) -> tuple[str, str, str]:
        if self.gate:
            return MANUAL_REVIEW, self.gate[0], self.gate[1] + " (not completed in time)"
        return MANUAL_REVIEW, "NO_CONFIRMATION", "no confirmation after clicking submit"


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
