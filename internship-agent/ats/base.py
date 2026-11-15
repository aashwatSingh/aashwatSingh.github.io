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
import run_state
from answers import (AI_POLICY, AnswerEngine, Context, Decision, Question, load_custom_answers, pattern_for,
                     remember_answers)
from ats import assist

SKIPPED_OPTIONAL = "SKIPPED_OPTIONAL"     # an optional question the profile does not answer: left blank
FILLED, SUBMITTED_BY_CANDIDATE = "filled", "submitted_by_candidate"     # wait_for_answers outcomes
ASSIST_TOTAL_S = 1500                     # most time one form may spend waiting on the candidate's answers

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
        return f"{self.widget}|{self.extra.get('group', '')}|{self.question.field_id or self.question.label}"


@dataclass
class ApplyResult:
    status: str
    reason: str = ""
    detail: str = ""
    answers: list[dict] = field(default_factory=list)
    unknowns: list[str] = field(default_factory=list)
    screenshot: str = ""
    learned: list[dict] = field(default_factory=list)     # answers the candidate typed in the browser
    page: object = None           # left open after a submission, until the confirmation e-mail is in


@dataclass
class FormState:
    """What has been decided on a form so far (shared across the pages of a multi-step portal)."""
    answers: list[dict] = field(default_factory=list)
    unknowns: list[str] = field(default_factory=list)
    unknown_fields: list[FormField] = field(default_factory=list)
    handled: set[str] = field(default_factory=set)
    own_words_only: bool = False      # the form carries an AI-use / authorship attestation
    resolved: set[str] = field(default_factory=set)       # unknown fields the candidate has since filled in
    forced: set[str] = field(default_factory=set)         # fields a validation error showed to be required
    learned: list[dict] = field(default_factory=list)     # what the candidate entered, for ApplyResult.learned

    def pending(self) -> list[FormField]:
        """Required questions nobody has answered yet."""
        return [f for f in self.unknown_fields if f.key not in self.resolved]


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
    # Set by the runner on a live run: notes the inbox position right before the final Submit
    # click, so the confirmation e-mail can be told apart from older mail (receipt_gate.py).
    receipt_gate = None

    async def before_submit(self, page: Page, step: str = "SUBMITTING_FORM") -> None:
        if self.receipt_gate is not None:
            await self.receipt_gate.before_submit(page.context, step)

    # ---- adapter hooks ----------------------------------------------------
    def form_url(self, job: dict) -> str:
        return job["url"]

    async def extract(self, page: Page, include_filled: bool = False) -> list[FormField]:
        raise NotImplementedError

    async def read_value(self, page: Page, f: FormField):
        """What is currently entered in a field: text, the chosen option, or a list of ticked options."""
        try:
            return await page.evaluate(READ_VALUE_JS, [f.sel, f.widget])
        except Exception:                                  # noqa: BLE001 - page navigating / field gone
            return None

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

    async def confirmed(self, page: Page) -> str | None:
        """Evidence that the application went through (a URL or phrase), else None."""
        return None

    # ---- required vs optional ------------------------------------------------
    async def refine_required(self, page: Page, fields: list[FormField], state: FormState | None = None) -> None:
        """Settle each field's `required` from the DOM, the same way for every portal.

        Required: the `required` attribute, aria-required="true", a required class or
        data-required="true", or an asterisk on its label / legend. A field whose own label,
        placeholder or helper text says "optional" is optional whatever else is marked, and one
        that a validation error has flagged after Submit / Next is required whatever is marked.
        """
        if not fields:
            return
        try:
            probes = await page.evaluate(assist.PROBE_JS, [f.sel for f in fields])
        except Exception:                                  # noqa: BLE001 - page navigating: keep the adapter's view
            probes = [None] * len(fields)
        for f, probe in zip(fields, probes):
            q = f.question
            if state is not None and f.key in state.forced:
                q.required = True
            elif f.extra.get("required_locked"):
                continue
            elif (probe and probe.get("optional")) or assist.says_optional(q.label, q.placeholder, q.description):
                q.required = False
            elif probe and probe.get("required"):
                q.required = True

    # ---- the candidate answers what the profile cannot --------------------------
    def _show_step(self, step: str, message: str, **extra) -> None:
        if self.receipt_gate is not None:
            try:
                self.receipt_gate.step(step, message, **extra)
            except Exception:                              # noqa: BLE001 - the dashboard never stops a form
                pass

    def learn(self, job: dict, engine: AnswerEngine | None, f: FormField, value) -> bool:
        """Remember an answer the candidate gave so the same question is filled automatically next time."""
        item = {"label": f.question.label, "kind": f.question.kind, "value": value}
        try:
            if not remember_answers([item], job.get("company", "")):
                return False
            if engine is not None:                         # usable for the rest of this run, ahead of older entries
                pattern = pattern_for(f.question.label)
                fresh = [e for e in load_custom_answers() if e.get("pattern") == pattern]
                engine.custom = fresh + [e for e in engine.custom if e.get("pattern") != pattern]
        except Exception as exc:                           # noqa: BLE001 - a locked file must not stop the form
            print(f"      could not save the answer ({type(exc).__name__}: {str(exc)[:80]})", flush=True)
            return False
        print(f"      learned: {f.question.label[:70]} -> {str(value)[:50]}", flush=True)
        return True

    async def wait_for_answers(self, page: Page, fields: list[FormField], job: dict,
                               engine: AnswerEngine | None = None, state: FormState | None = None) -> str:
        """Hands-free hand-over: highlight each unanswered field in turn and return as soon as the
        last one has a value and focus has left it. No terminal input is involved.

        Returns FILLED, SUBMITTED_BY_CANDIDATE (they pressed Submit themselves and the confirmation
        is showing) or "" when the answers did not come in time.
        """
        per_field = max(self.human_wait_s, 180)
        started = time.monotonic()
        deadline = started + per_field
        print(f"\a[ACTION REQUIRED] {len(fields)} required question(s) need your answer in the browser. "
              "Fill the highlighted field and click outside it; the form continues by itself:", flush=True)
        for f in fields[:8]:
            print(f"      - {f.question.label[:110]}", flush=True)

        initial = [await self._entered(page, f, {}) for f in fields]    # a flagged field may hold a bad value
        stable: list[tuple[object, float]] = [(None, 0.0)] * len(fields)
        saved: dict[str, object] = {}
        current = -2

        async def install() -> None:
            await page.evaluate(assist.ASSIST_JS)
            if not await page.evaluate("n => window.__iaAssist.items.length === n", len(fields)):
                await page.evaluate("sels => window.__iaAssist.start(sels)", [f.sel for f in fields])

        while time.monotonic() < min(deadline, started + ASSIST_TOTAL_S):
            try:
                await install()
                states = await page.evaluate("() => window.__iaAssist.state()")
            except Exception:                              # noqa: BLE001 - page navigating
                states, current = None, -2
            if states is None or len(states) != len(fields):
                await page.wait_for_timeout(300)
                try:
                    if await self.confirmed(page):
                        return SUBMITTED_BY_CANDIDATE
                except Exception:                          # noqa: BLE001
                    pass
                continue
            now = time.monotonic()
            done = []
            for i, (f, st) in enumerate(zip(fields, states)):
                value = await self._entered(page, f, st)
                changed = bool(value) and value != initial[i]
                if stable[i][0] != value:
                    stable[i] = (value, now)
                    if value:
                        deadline = now + per_field            # still at it: keep waiting
                settled = (now - stable[i][1]) * 1000 >= assist.BLUR_SETTLE_MS
                if assist.needs_blur(f.question.kind, f.widget):
                    ok = changed and not st["open"] and st["awayMs"] >= assist.BLUR_SETTLE_MS
                else:
                    ok = changed and not st["open"] and settled
                done.append(ok)
                if ok and f.widget != "file" and saved.get(f.key) != value:
                    saved[f.key] = value
                    self.learn(job, engine, f, value)
                    if state is not None:
                        state.learned = [x for x in state.learned if x["label"] != f.question.label] + [
                            {"label": f.question.label, "kind": f.question.kind, "value": value}]
            target = next((i for i, ok in enumerate(done) if not ok), -1)
            if target == -1:
                await self._clear_highlight(page)
                return FILLED
            if target != current:
                current = target
                deadline = max(deadline, now + per_field)
                label = fields[target].question.label
                try:
                    await page.evaluate("([i, text, color]) => window.__iaAssist.highlight(i, text, color)",
                                        [target, assist.BADGE_TEXT, assist.HIGHLIGHT_COLOR])
                except Exception:                          # noqa: BLE001
                    current = -2
                self._show_step(run_state.WAITING_FOR_ANSWER, f"Waiting for your answer: {label[:120]}",
                                waiting={"field": label, "remaining": done.count(False), "of": len(fields)})
            try:
                if await self.confirmed(page):
                    await self._clear_highlight(page)
                    return SUBMITTED_BY_CANDIDATE
            except Exception:                              # noqa: BLE001
                pass
            await page.wait_for_timeout(250)
        await self._clear_highlight(page)
        return ""

    async def _entered(self, page: Page, f: FormField, st: dict):
        """What the field holds right now (None when empty)."""
        if f.widget == "file":
            return "file" if st.get("files") else (await self.read_value(page, f) or None)
        return await self.read_value(page, f) or None

    @staticmethod
    async def _clear_highlight(page: Page) -> None:
        try:
            await page.evaluate("() => window.__iaAssist && window.__iaAssist.clear()")
        except Exception:                                  # noqa: BLE001
            pass

    async def flagged_fields(self, page: Page, detail: str = "") -> list[FormField]:
        """Fields showing a validation error after a Submit / Next click, each marked required.

        Falls back to the fields a form-level error names ("Missing entry for required field: X").
        """
        fields = await self.extract(page, include_filled=True)
        if not fields:
            return []
        try:
            errors = await page.evaluate(assist.FLAGGED_JS, [f.sel for f in fields])
        except Exception:                                  # noqa: BLE001
            return []
        flagged = [f for f, err in zip(fields, errors) if err]
        if not flagged and detail:
            squash = lambda t: re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()
            said = squash(detail)
            flagged = [f for f in fields if len(squash(f.question.label)) > 3 and squash(f.question.label) in said]
        for f in flagged:
            f.question.required = True
            f.extra["had_value"] = bool(await self.read_value(page, f))
        return flagged

    async def complete_form(self, page: Page, job: dict, engine: AnswerEngine, ctx: Context, text: str,
                            state: FormState, attended: bool) -> str:
        """Fill the page; hand each unanswerable required question to the candidate; repeat while
        answers reveal further questions. Returns "" (ready), "blocked" or SUBMITTED_BY_CANDIDATE."""
        for _ in range(8):
            await self.answer_form(page, job, engine, ctx, text, state)
            pending = state.pending()
            if not pending:
                return ""
            if not attended:
                return "blocked"
            outcome = await self.wait_for_answers(page, pending, job, engine, state)
            if outcome == SUBMITTED_BY_CANDIDATE:
                return outcome
            if outcome != FILLED:
                return "blocked"
            state.resolved.update(f.key for f in pending)
        return "blocked" if state.pending() else ""

    async def recover_from_validation(self, page: Page, job: dict, engine: AnswerEngine, ctx: Context, text: str,
                                      state: FormState, attended: bool, detail: str = "") -> bool:
        """Submit / Next was refused. Treat exactly the flagged fields as required: answer them from the
        profile where it can, hand the rest to the candidate. True when the click is worth repeating."""
        flagged = await self.flagged_fields(page, detail)
        if not flagged:
            return False
        keys = {f.key for f in flagged}
        state.forced |= keys
        state.handled -= keys
        state.resolved -= keys
        state.unknown_fields = [f for f in state.unknown_fields if f.key not in keys]
        filled_before = sum(a["action"] == "fill" for a in state.answers)
        await self.answer_form(page, job, engine, ctx, text, state)
        progress = sum(a["action"] == "fill" for a in state.answers) - filled_before
        todo = {f.key: f for f in flagged if f.extra.get("had_value")}       # holds a value the site rejected
        todo.update({f.key: f for f in state.pending()})
        if not todo:
            return progress > 0
        if not attended:
            return False
        outcome = await self.wait_for_answers(page, list(todo.values()), job, engine, state)
        if outcome != FILLED:
            return False
        state.resolved.update(todo)
        return True

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
    def check_eligibility(self, text: str, engine: AnswerEngine, job: dict) -> ApplyResult | None:
        """Posting-level blockers read from the description; None when the posting is eligible."""
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
        return None

    async def answer_form(self, page: Page, job: dict, engine: AnswerEngine, ctx: Context, text: str,
                          state: FormState) -> None:
        """Answer and fill every field currently on the page, re-reading it as answers reveal new fields."""
        for _ in range(4):
            fields = await self.extract(page)
            await self.refine_required(page, fields, state)
            fresh = [f for f in fields if f.key not in state.handled]
            if not fresh:
                break
            ctx.labels = [f.question.label for f in fields]
            state.own_words_only = state.own_words_only or any(AI_POLICY.search(f.question.label) for f in fields)
            for f in fresh:
                state.handled.add(f.key)
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
                        and not state.own_words_only and essays.may_draft(q.label, job, decision.rule):
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
                state.answers.append({"label": q.label, "kind": q.kind, "required": q.required,
                                      "options": [o[:80] for o in q.options[:250]],
                                      "action": decision.action, "value": _loggable(decision.value),
                                      "rule": decision.rule, "note": decision.note,
                                      "status": SKIPPED_OPTIONAL if decision.action == "skip" and not q.required
                                      else ""})
                if decision.action == "unknown":
                    state.unknowns.append(q.label)
                    state.unknown_fields.append(f)
            await page.wait_for_timeout(400)

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
        blocked = self.check_eligibility(text, engine, job)
        if blocked:
            return blocked

        ctx.job_text = text
        state = FormState()
        attended = bool(self.human_wait_s) and not dry_run
        blocked = await self.complete_form(page, job, engine, ctx, text, state, attended)
        answers, unknowns = state.answers, state.unknowns

        if not answers:
            return ApplyResult(MANUAL_REVIEW, "FORM_NOT_FOUND", "no form fields detected")
        skipped = [a["label"] for a in answers if a.get("status") == SKIPPED_OPTIONAL]
        if skipped:
            print(f"      {SKIPPED_OPTIONAL}: {len(skipped)} optional question(s) left blank", flush=True)
        await _screenshot(page, shot_path)
        if blocked == SUBMITTED_BY_CANDIDATE:
            return ApplyResult(SUBMITTED, "completed by the candidate in the browser",
                               str(await self.confirmed(page) or ""), answers, unknowns, shot_path, state.learned)
        if blocked:
            return ApplyResult(MANUAL_REVIEW, "UNANSWERED_REQUIRED",
                               " | ".join(f.question.label[:90] for f in state.pending()[:8]),
                               answers, unknowns, shot_path, state.learned)
        if dry_run:
            return ApplyResult(DRY_RUN_OK, "all required questions answered (not submitted)",
                               answers=answers, screenshot=shot_path)

        for attempt in range(4):
            await self.before_submit(page)
            status, reason, detail = await self.submit(page)
            # A form that hides its required markers only says so now: fix just the flagged fields, resubmit.
            if reason != "VALIDATION_ERROR" or attempt == 3 or not await self.recover_from_validation(
                    page, job, engine, ctx, text, state, attended, detail):
                break
        if status != SUBMITTED:
            await _screenshot(page, shot_path)
        return ApplyResult(status, reason, detail, state.answers, state.unknowns, shot_path, state.learned)


class SubmitWatch:
    """Polls after the submit click; optionally waits on a human for verification steps."""

    def __init__(self, adapter: BaseAdapter, seconds: float):
        self.adapter = adapter
        self.deadline = time.monotonic() + seconds
        self.gate: tuple[str, str] | None = None

    def running(self) -> bool:
        return time.monotonic() < self.deadline

    def extend(self, seconds: float) -> None:
        """Keep watching for at least this much longer (an automatic step is in progress)."""
        self.deadline = max(self.deadline, time.monotonic() + seconds)

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


async def form_still_showing(page: Page, submit_selector: str) -> bool:
    """A 'thank you for applying' phrase only proves submission once the form itself is gone:
    the same words can appear in a job description that shares the page with the form."""
    try:
        button = page.locator(submit_selector).first
        return await button.count() > 0 and await button.is_visible()
    except Exception:                                      # noqa: BLE001 - page navigating
        return True


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


# Reads back what a person entered. `sel` is either the control itself or the question's container;
# `widget` is the adapter's name for the control, so the right part of a composite field is read.
READ_VALUE_JS = r"""
([sel, widget]) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const clean = s => (s || '').replace(/\s+/g, ' ').replace(/\*\s*$/, '').trim();
  const textOf = box => (box && box.value && box.value !== 'undefined') ? box.value : null;
  const isSelectInput = el.matches('input.select__input, input[role=combobox]');
  if (el.matches('input, textarea') && !isSelectInput) return textOf(el);            // a plain text control
  const root = el.matches('input, select')
    ? (el.closest('.select-shell, fieldset, .application-question, [class*="_fieldEntry_"]') || el.parentElement) : el;
  if (widget === 'text')
    return textOf(root.querySelector('textarea, input:not([type=hidden]):not([type=file]):not([type=radio]):not([type=checkbox])'));
  const pressed = root.querySelector('[class*="_yesno_"] button[aria-pressed="true"], [class*="_yesno_"] button[class*="_active_"]');
  if (widget === 'yesno' || pressed) return pressed ? clean(pressed.innerText) : null;
  const labelOf = c => clean((c.id && document.querySelector(`label[for="${CSS.escape(c.id)}"]`)?.innerText)
                             || c.closest('label')?.innerText || c.value);
  const ticked = [...root.querySelectorAll('input[type=radio]:checked, input[type=checkbox]:checked')];
  if (ticked.length) {
    const labels = ticked.map(labelOf).filter(Boolean);
    return ticked[0].type === 'radio' ? (labels[0] || null) : labels;
  }
  const multi = [...root.querySelectorAll('.select__multi-value__label')].map(e => clean(e.innerText));
  if (multi.length) return multi;
  const single = root.querySelector('.select__single-value');
  if (single) return clean(single.innerText);
  const dropdown = el.matches('select') ? el : root.querySelector('select');
  if (dropdown && dropdown.value) return clean(dropdown.options[dropdown.selectedIndex].text);
  return textOf(root.querySelector('textarea, input:not([type=hidden]):not([type=file]):not([type=radio]):not([type=checkbox])'));
}
"""


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
