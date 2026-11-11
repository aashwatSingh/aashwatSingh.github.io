"""Workday adapter (<tenant>.wdN.myworkdayjobs.com) - EXPERIMENTAL past the login screen.

What has been exercised against a live tenant: opening a posting, reading its description for
eligibility, Apply -> Apply Manually, recognising the sign-in / create-account step, filling the
sign-in form, and reading form fields by Workday's `formField-*` convention.

What has NOT been exercised (no test login was available): everything after signing in - the
My Information / My Experience / Application Questions / Voluntary Disclosures / Self Identify
pages. That code follows the same field convention and is written to fail safe:

* It never clicks the final Submit. At the Review step it stops; in blitz mode it rings and waits
  for you to review and submit, otherwise the posting goes to manual review with the draft saved
  in your Workday candidate account.
* It never creates an account unless you pass --workday-create-accounts.
* It tries your portal password at most once per Workday site per run, so a wrong password
  cannot lock an account through repetition.
* Any page it cannot complete is handed to you (blitz mode) or sent to manual review.
* It only touches inputs inside `formField-*` wrappers, so the hidden honeypot input Workday
  places on its pages is never filled.

Note that stepping through Workday pages saves an in-progress draft in the candidate account even
in --dry-run; nothing is submitted.
"""
from __future__ import annotations

import re
import time
from urllib.parse import urlparse

from playwright.async_api import Page, TimeoutError as PWTimeout

import config
from answers import Decision, Question
from ats.base import (CLOSED, DRY_RUN_OK, MANUAL_REVIEW, SUBMITTED, ApplyResult, BaseAdapter, FormField, FormState,
                      _screenshot)

AID = '[data-automation-id="{}"]'
AUTH_STEP = re.compile(r"sign in|create account|log ?in", re.I)
REVIEW_STEP = re.compile(r"\breview\b", re.I)
_CLOSED_TEXT = re.compile(
    r"page you are looking for (doesn.t|does not) exist|job (is|has been) (no longer|closed|filled)|"
    r"no longer accepting applications|posting (is|has been) (closed|removed)|job is not available", re.I)
_CONFIRMED_TEXT = re.compile(
    r"application (has been |was )?(successfully )?submitted|thank you for applying|"
    r"you(.ve| have) (successfully )?applied|successfully submitted your application", re.I)

# Fields are the visible, outermost [data-automation-id^="formField-"] wrappers. Nothing else is read
# or written, which also keeps the page's hidden honeypot input untouched.
EXTRACT_JS = r"""
() => {
  const out = []; let n = 0;
  const tag = el => { const id = 'ia' + (n++); el.setAttribute('data-ia', id); return `[data-ia="${id}"]`; };
  const clean = s => (s || '').replace(/\s+/g, ' ').replace(/\*\s*$/, '').trim();
  const wrappers = [...document.querySelectorAll('[data-automation-id^="formField-"]')]
    .filter(w => w.offsetParent !== null && !w.parentElement.closest('[data-automation-id^="formField-"]'));
  wrappers.forEach(w => {
    const lab = w.querySelector('label, legend');
    const label = clean(lab ? lab.innerText : (w.getAttribute('aria-label') || ''));
    const id = w.getAttribute('data-automation-id').slice('formField-'.length);
    const required = !!w.querySelector('[aria-required="true"], [required]') || /\*\s*$/.test((lab && lab.innerText) || '');
    const base = {sel: tag(w), label: label || id, required, id, options: []};
    const optLabel = c => clean((c.id && w.querySelector(`label[for="${CSS.escape(c.id)}"]`)?.innerText) || c.closest('label')?.innerText);

    if (w.querySelector('input[type=file]')) { out.push({...base, widget: 'file', kind: 'file'}); return; }
    const radios = [...w.querySelectorAll('input[type=radio]')];
    if (radios.length) {
      out.push({...base, widget: 'boxes', kind: 'radio', options: radios.map(optLabel), filled: radios.some(r => r.checked)});
      return;
    }
    const boxes = [...w.querySelectorAll('input[type=checkbox]')];
    if (boxes.length) {
      const opts = boxes.map(optLabel);
      const single = boxes.length === 1;
      out.push({...base, widget: 'boxes', kind: single ? 'checkbox' : 'checkbox_group',
                label: single && opts[0] && opts[0] !== base.label ? clean(`${base.label} ${opts[0]}`) : base.label,
                options: single ? [] : opts, filled: boxes.some(b => b.checked)});
      return;
    }
    const dd = w.querySelector('button[aria-haspopup="listbox"]');
    if (dd) {
      const shown = clean(dd.innerText);
      out.push({...base, widget: 'dropdown', kind: 'select', lazy: true, filled: !!shown && !/^select( one)?$/i.test(shown)});
      return;
    }
    const dateParts = w.querySelectorAll('[data-automation-id^="dateSection"][data-automation-id$="-input"]');
    if (dateParts.length) {
      out.push({...base, widget: 'date', kind: 'date', filled: [...dateParts].some(d => d.value),
                parts: [...dateParts].map(d => d.getAttribute('data-automation-id'))});
      return;
    }
    const search = w.querySelector('[data-automation-id="multiSelectContainer"] input, input[data-uxi-widget-type="selectinput"]');
    if (search) {
      out.push({...base, widget: 'search', kind: 'text', filled: !!w.querySelector('[data-automation-id="selectedItem"]')});
      return;
    }
    const ta = w.querySelector('textarea');
    if (ta) { out.push({...base, widget: 'text', kind: 'textarea', filled: !!ta.value}); return; }
    const inp = w.querySelector('input:not([type=hidden])');
    if (inp) {
      const kind = inp.type === 'password' ? 'password' : ({number: 'number', email: 'email', tel: 'tel'}[inp.type] || 'text');
      out.push({...base, widget: 'text', kind, filled: !!inp.value, aid: inp.getAttribute('data-automation-id') || ''});
    }
  });
  return out;
}
"""


def step_name(raw: str) -> str:
    """'current step 2 of 6 My Information' -> 'My Information'."""
    return re.sub(r"^\s*current step \d+ of \d+\s*", "", " ".join((raw or "").split()), flags=re.I).strip()


class WorkdayAdapter(BaseAdapter):
    name = "Workday"
    timeout_s = 900                    # a multi-page wizard, far longer than a single-page form
    create_accounts = False            # --workday-create-accounts
    try_sign_in = True                 # one attempt per site per run
    _sign_in_failed: set[str] = set()  # hosts where the portal password was rejected this run

    @staticmethod
    def matches(url: str) -> bool:
        host = urlparse(url).netloc.lower()
        return host.endswith("myworkdayjobs.com") or host.endswith("myworkdaysite.com")

    # ---- small page helpers ---------------------------------------------------
    async def _visible(self, page: Page, aid: str) -> bool:
        loc = page.locator(AID.format(aid)).first
        try:
            return await loc.count() > 0 and await loc.is_visible()
        except Exception:                                  # noqa: BLE001
            return False

    async def _click(self, page: Page, aid: str) -> None:
        # Workday lays a transparent "click_filter" over its buttons; force the click through it.
        await page.locator(AID.format(aid)).first.click(force=True)

    async def current_step(self, page: Page) -> str:
        loc = page.locator(AID.format("progressBarActiveStep")).first
        try:
            return step_name(await loc.inner_text(timeout=1500)) if await loc.count() else ""
        except Exception:                                  # noqa: BLE001
            return ""

    async def _wait_step_change(self, page: Page, previous: str, seconds: float) -> str | None:
        """The new step name once the wizard leaves `previous`, 'DONE' on a confirmation, else None."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            await page.wait_for_timeout(600)
            if await self.confirmed(page):
                return "DONE"
            now = await self.current_step(page)
            if now and now != previous:
                return now
        return None

    async def _errors(self, page: Page) -> str:
        try:
            texts = await page.locator(f'{AID.format("errorMessage")}, [data-automation-id="inputAlert"], '
                                       '[role="alert"]').all_inner_texts()
        except Exception:                                  # noqa: BLE001
            return ""
        return " | ".join(dict.fromkeys(" ".join(t.split()) for t in texts if t.strip()))[:300]

    async def confirmed(self, page: Page) -> str | None:
        try:
            body = await page.inner_text("body", timeout=3000)
        except Exception:                                  # noqa: BLE001
            return None
        m = _CONFIRMED_TEXT.search(body)
        return m.group(0) if m else None

    async def job_text(self, page: Page, job: dict) -> str:
        parts = []
        for aid in ("jobPostingHeader", "jobPostingDescription"):
            loc = page.locator(AID.format(aid)).first
            if await loc.count():
                parts.append(await loc.inner_text())
        return "\n".join(parts)

    # ---- fields -----------------------------------------------------------------
    async def extract(self, page: Page, include_filled: bool = False) -> list[FormField]:
        fields = []
        for r in await page.evaluate(EXTRACT_JS):
            if (r.get("filled") and not include_filled) or r.get("kind") == "password":
                continue
            q = Question(label=r["label"], kind=r["kind"], required=bool(r["required"]),
                         options=r.get("options") or [], field_id=r.get("id") or "")
            fields.append(FormField(q, r["sel"], r["widget"], {"lazy_options": r.get("lazy", False),
                                                               "parts": r.get("parts") or []}))
        return fields

    def special(self, f: FormField, profile: dict) -> Decision | None:
        fid, label = f.question.field_id.lower(), f.question.label.lower()
        ident = profile["identity"]
        if f.widget == "date" and re.search(r"^date$|today|signature date|date signed", label):
            return Decision("fill", time.strftime("%Y-%m-%d"), "wd-today")
        if "phone" in fid and "number" in fid or label in ("phone number", "phone"):
            return Decision("fill", ident["phone_digits"], "wd-phone")
        if "extension" in fid or "phone extension" in label:
            return Decision("skip", rule="wd-phone-extension")
        return None

    async def _options(self, page: Page, f: FormField) -> list[str]:
        await page.locator(f'{f.sel} button[aria-haspopup="listbox"]').first.click(force=True)
        try:
            await page.wait_for_selector('[role="listbox"] [role="option"]', timeout=4000)
        except PWTimeout:
            return []
        return [" ".join(t.split()) for t in await page.locator('[role="listbox"] [role="option"]').all_inner_texts()]

    async def read_options(self, page: Page, f: FormField) -> list[str]:
        options = await self._options(page, f)
        await page.keyboard.press("Escape")
        return [o for o in options if o and not re.fullmatch(r"select( one)?", o, re.I)]

    async def read_value(self, page: Page, f: FormField):
        if f.widget == "dropdown":
            try:
                shown = " ".join((await page.locator(f'{f.sel} button[aria-haspopup="listbox"]').first.inner_text()).split())
            except Exception:                              # noqa: BLE001
                return None
            return None if re.fullmatch(r"select( one)?", shown, re.I) else shown or None
        return await super().read_value(page, f)

    async def fill(self, page: Page, f: FormField, value, profile: dict) -> None:
        if f.widget == "file":
            await page.set_input_files(f"{f.sel} input[type=file]", value)
            await page.wait_for_timeout(4000)
            return
        if f.widget == "text":
            await page.locator(f"{f.sel} textarea, {f.sel} input:not([type=hidden])").first.fill(str(value))
            return
        if f.widget == "dropdown":
            await self._options(page, f)
            opts = page.locator('[role="listbox"] [role="option"]')
            for i in range(await opts.count()):
                if " ".join((await opts.nth(i).inner_text()).split()) == value:
                    await opts.nth(i).click()
                    return
            await page.keyboard.press("Escape")
            raise LookupError(f"option {value!r} not offered")
        if f.widget == "boxes":
            wanted = None if value is True else ([value] if isinstance(value, str) else list(value))
            inputs = page.locator(f"{f.sel} input[type=radio], {f.sel} input[type=checkbox]")
            done = 0
            for i in range(await inputs.count()):
                box = inputs.nth(i)
                box_id = await box.get_attribute("id")
                lab = page.locator(f'{f.sel} label[for="{box_id}"]')
                text = " ".join((await lab.inner_text()).split()) if await lab.count() else ""
                if wanted is None or text in wanted:
                    await box.check(force=True)
                    done += 1
            if not done:
                raise LookupError(f"option {wanted!r} not found")
            return
        if f.widget == "date":
            y, m, d = str(value).split("-") if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(value)) else ("", "", "")
            if not y:
                raise ValueError(f"date value {value!r} is not YYYY-MM-DD")
            for aid, part in (("dateSectionMonth-input", m), ("dateSectionDay-input", d), ("dateSectionYear-input", y)):
                box = page.locator(f'{f.sel} [data-automation-id="{aid}"]')
                if await box.count():
                    await box.first.click(force=True)
                    await page.keyboard.type(part)
            return
        if f.widget == "search":
            box = page.locator(f'{f.sel} input').first
            await box.click(force=True)
            await box.fill(str(value))
            await page.keyboard.press("Enter")
            await page.wait_for_timeout(1800)
            options = page.locator('[data-automation-id="promptOption"]')
            want = str(value).lower()
            for i in range(await options.count()):
                if want in (await options.nth(i).inner_text()).lower():
                    await options.nth(i).click(force=True)
                    await page.keyboard.press("Escape")
                    return
            await page.keyboard.press("Escape")
            raise LookupError(f"{value!r} not found in the search list")
        raise NotImplementedError(f.widget)

    async def _upload_resume(self, page: Page, profile: dict, step: str) -> None:
        """The resume drop zone on 'My Experience' is not always inside a formField wrapper."""
        if not re.search(r"experience|resume", step, re.I):
            return
        try:
            drop = page.locator('input[data-automation-id="file-upload-input-ref"], input[type=file]').first
            already = await page.locator('[data-automation-id="file-upload-item"], '
                                         '[data-automation-id="file-upload-successful"]').count()
            if await drop.count() and not already:
                await drop.set_input_files(profile["resume_path"])
                await page.wait_for_timeout(4000)
        except Exception:                                  # noqa: BLE001 - best effort, the page is handed over if needed
            pass

    # ---- sign in ------------------------------------------------------------------
    async def _authenticate(self, page: Page, profile: dict, host: str, dry_run: bool) -> ApplyResult | None:
        """Get past 'Create Account/Sign In'. None when signed in, else the result to return."""
        step = await self.current_step(page)
        if step and not AUTH_STEP.search(step):
            return None                                        # already signed in (saved browser profile)
        portal = profile.get("portal") or {}
        user, password = portal.get("username") or profile["identity"]["email"], portal.get("password") or ""
        try:                                                   # the step bar appears before the sign-in widgets
            await page.wait_for_selector(f'{AID.format("SignInWithEmailButton")}, {AID.format("email")}',
                                         state="visible", timeout=15000)
        except PWTimeout:
            pass

        async def human(reason: str, what: str) -> ApplyResult | None:
            if not self.human_wait_s:
                return ApplyResult(MANUAL_REVIEW, reason, what)
            wait = max(self.human_wait_s, 240)
            print(f"\a[ACTION REQUIRED] {what} (waiting up to {wait}s)", flush=True)
            moved = await self._wait_step_change(page, step, wait)
            if moved and not AUTH_STEP.search(moved):
                return None
            return ApplyResult(MANUAL_REVIEW, reason, what + " (not completed in time)")

        if not self.try_sign_in or not password or host in self._sign_in_failed:
            return await human("WORKDAY_LOGIN", f"Sign in to {host} in the browser window")

        if await self._visible(page, "SignInWithEmailButton"):
            await self._click(page, "SignInWithEmailButton")
            await page.wait_for_timeout(1500)
        if not await self._visible(page, "email") and await self._visible(page, "signInLink"):
            await self._click(page, "signInLink")              # landed on the create-account form
            await page.wait_for_timeout(1500)
        if not await self._visible(page, "email"):
            return await human("WORKDAY_LOGIN", f"Sign in to {host} in the browser window (unrecognised sign-in page)")
        await page.fill(AID.format("email"), user)
        await page.fill(AID.format("password"), password)
        await self._click(page, "signInSubmitButton")
        moved = await self._wait_step_change(page, step, 12)
        if moved and not AUTH_STEP.search(moved):
            return None
        self._sign_in_failed.add(host)                         # never retry this site in this run
        error = await self._errors(page)

        if self.create_accounts and await self._visible(page, "createAccountLink"):
            await self._click(page, "createAccountLink")
            await page.wait_for_timeout(2000)
            await page.fill(AID.format("email"), user)
            await page.fill(AID.format("password"), password)
            if await self._visible(page, "verifyPassword"):
                await page.fill(AID.format("verifyPassword"), password)
            if await self._visible(page, "createAccountCheckbox"):
                await page.locator(AID.format("createAccountCheckbox")).first.check(force=True)
            await self._click(page, "createAccountSubmitButton")
            moved = await self._wait_step_change(page, step, 15)
            if moved and not AUTH_STEP.search(moved):
                return None
            note = await self._errors(page) or "the site may have e-mailed a verification link"
            return await human("WORKDAY_ACCOUNT", f"Finish creating / verifying your account on {host}: {note[:120]}")
        return await human("WORKDAY_LOGIN",
                           f"Sign in to {host} in the browser window (portal password was not accepted"
                           + (f": {error[:80]}" if error else "") + "; no account was created)")

    # ---- flow ------------------------------------------------------------------------
    async def apply(self, page: Page, job: dict, engine, ctx, *, dry_run: bool, shot_path: str) -> ApplyResult:
        host = urlparse(job["url"]).netloc.lower()
        resp = await page.goto(job["url"], wait_until="domcontentloaded", timeout=config.PAGE_TIMEOUT_S * 1000)
        if resp is not None and resp.status in (404, 410):
            return ApplyResult(CLOSED, "posting not found", f"HTTP {resp.status}")
        try:
            await page.wait_for_selector(f'{AID.format("adventureButton")}, {AID.format("jobPostingHeader")}',
                                         timeout=25000)
        except PWTimeout:
            text = await self.page_text(page)
            if _CLOSED_TEXT.search(text):
                return ApplyResult(CLOSED, "posting closed")
            await _screenshot(page, shot_path)
            return ApplyResult(MANUAL_REVIEW, "FORM_NOT_FOUND", "the Workday posting did not render", screenshot=shot_path)
        await page.wait_for_timeout(1200)
        if _CLOSED_TEXT.search(await self.page_text(page)) or not await self._visible(page, "adventureButton"):
            return ApplyResult(CLOSED, "posting closed or no Apply button")

        text = await self.job_text(page, job)
        blocked = self.check_eligibility(text, engine, job)
        if blocked:
            return blocked
        ctx.job_text = text

        await self._click(page, "adventureButton")
        for _ in range(12):                                    # dialog with "Apply Manually", or straight to the wizard
            await page.wait_for_timeout(700)
            if await self._visible(page, "applyManually"):
                await self._click(page, "applyManually")
                break
            if await self.current_step(page):
                break
        for _ in range(25):
            if await self.current_step(page) or await self._visible(page, "email"):
                break
            await page.wait_for_timeout(700)
        else:
            await _screenshot(page, shot_path)
            return ApplyResult(MANUAL_REVIEW, "FORM_NOT_FOUND", "the application wizard did not open", screenshot=shot_path)

        stopped = await self._authenticate(page, engine.p, host, dry_run)
        if stopped:
            await _screenshot(page, shot_path)
            stopped.screenshot = shot_path
            return stopped

        # ---------------- experimental from here: pages behind the login ----------------
        state, learned = FormState(), []
        for _ in range(14):
            step = await self.current_step(page)
            if not step or REVIEW_STEP.search(step):
                break
            state.handled.clear()
            before = len(state.unknown_fields)
            try:
                answered_before = len(state.answers)
                await self.answer_form(page, job, engine, ctx, text, state)
                if not any(a["kind"] == "file" and a["action"] == "fill" for a in state.answers[answered_before:]):
                    await self._upload_resume(page, engine.p, step)
                page_unknowns = state.unknown_fields[before:]
                problem = "; ".join(f.question.label[:70] for f in page_unknowns[:6])
                moved = None
                if not page_unknowns:
                    for aid in ("bottom-navigation-next-button", "pageFooterNextButton"):
                        if await self._visible(page, aid):
                            await self._click(page, aid)
                            break
                    moved = await self._wait_step_change(page, step, 15)
                    if not moved:
                        problem = await self._errors(page) or "the page did not advance"
            except Exception as exc:                           # noqa: BLE001 - untested territory: hand over
                page_unknowns, moved = [], None
                problem = f"{type(exc).__name__}: {str(exc)[:120]}"
            if moved == "DONE":
                break
            if moved:
                continue
            await _screenshot(page, shot_path)
            if not self.human_wait_s or dry_run:
                return ApplyResult(MANUAL_REVIEW, "UNANSWERED_REQUIRED" if page_unknowns else "WORKDAY_PAGE",
                                   f"[{step}] {problem}"[:300], state.answers, state.unknowns, shot_path)
            wait = max(self.human_wait_s, 240)
            print(f"\a[ACTION REQUIRED] Finish the '{step}' page in the browser and click Save and Continue "
                  f"(waiting up to {wait}s): {problem[:160]}", flush=True)
            deadline, seen = time.monotonic() + wait, {}
            moved = None
            while time.monotonic() < deadline and not moved:
                for f in page_unknowns:
                    value = await self.read_value(page, f)
                    if value and f.widget != "file":
                        seen[f.key] = {"label": f.question.label, "kind": f.question.kind, "value": value}
                moved = await self._wait_step_change(page, step, 1.5)
            learned += list(seen.values())
            if not moved:
                return ApplyResult(MANUAL_REVIEW, "WORKDAY_PAGE", f"[{step}] not completed in time: {problem}"[:300],
                                   state.answers, state.unknowns, shot_path)
            if moved == "DONE":
                break

        await _screenshot(page, shot_path)
        proof = await self.confirmed(page)
        if proof:
            return ApplyResult(SUBMITTED, "completed in the browser", proof, state.answers, state.unknowns,
                               shot_path, learned)
        if not REVIEW_STEP.search(await self.current_step(page)):
            return ApplyResult(MANUAL_REVIEW, "WORKDAY_PAGE", "the wizard ended somewhere unexpected",
                               state.answers, state.unknowns, shot_path)
        if dry_run:
            return ApplyResult(DRY_RUN_OK, "reached the Review step (not submitted; a draft is saved in Workday)",
                               answers=state.answers, screenshot=shot_path)
        if not self.human_wait_s:
            return ApplyResult(MANUAL_REVIEW, "WORKDAY_READY_FOR_REVIEW",
                               "filled through to Review and saved as a draft; open the posting and submit it",
                               state.answers, state.unknowns, shot_path)
        wait = max(self.human_wait_s, 240)
        print(f"\a[ACTION REQUIRED] Review the Workday application in the browser and click Submit "
              f"(waiting up to {wait}s)", flush=True)
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            await page.wait_for_timeout(800)
            proof = await self.confirmed(page)
            if proof:
                return ApplyResult(SUBMITTED, "submitted by the candidate after review", proof, state.answers,
                                   state.unknowns, shot_path, learned)
        return ApplyResult(MANUAL_REVIEW, "WORKDAY_READY_FOR_REVIEW", "left at the Review step (not submitted in time)",
                           state.answers, state.unknowns, shot_path)
