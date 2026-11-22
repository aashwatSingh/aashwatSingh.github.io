"""Lever adapter (jobs.lever.co/<org>/<posting-id>/apply).

Lever gates every submission behind hCaptcha. It is never auto-solved: when a
challenge appears (or the widget cannot load) the filled form is screenshotted
and the posting goes to the manual-review queue.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from urllib.parse import urlparse

from playwright.async_api import Page

import phone_notify
import run_state
from answers import Decision, Question
from urls import host_matches
from ats.base import (MANUAL_REVIEW, SUBMITTED, BaseAdapter, FormField, SubmitWatch, fetch_json,
                      strip_html, visible_captcha)

EXTRACT_JS = r"""
() => {
  const out = []; let n = 0;
  const tag = el => { const id = 'ia' + (n++); el.setAttribute('data-ia', id); return `[data-ia="${id}"]`; };
  const clean = s => (s || '').replace(/\s+/g, ' ').replace(/✱/g, '').trim();
  document.querySelectorAll('.application-question, .application-additional').forEach(entry => {
    const lab = entry.querySelector('.application-label');
    if (!lab) return;
    const titleEl = lab.querySelector('.text') || lab;
    const label = clean(titleEl.innerText);
    const required = !!lab.querySelector('.required') || !!entry.querySelector('[required]');
    const base = {sel: tag(entry), label, required, options: []};
    const file = entry.querySelector('input[type=file]');
    if (file) { out.push({...base, widget: 'file', kind: 'file', label: label || 'Resume/CV', id: file.name}); return; }
    const picks = [...entry.querySelectorAll('input[type=radio], input[type=checkbox]')];
    if (picks.length) {
      const radio = picks[0].type === 'radio';
      out.push({...base, widget: 'boxes', kind: radio ? 'radio' : (picks.length === 1 ? 'checkbox' : 'checkbox_group'),
                id: picks[0].name, filled: picks.some(p => p.checked),
                options: picks.length === 1 && !radio ? [] : picks.map(p => clean(p.closest('label')?.innerText || p.value))});
      return;
    }
    const sel = entry.querySelector('select');
    if (sel) {
      out.push({...base, widget: 'select', kind: 'select', id: sel.name, filled: !!sel.value,
                options: [...sel.options].filter(o => o.value).map(o => clean(o.text))});
      return;
    }
    const ta = entry.querySelector('textarea');
    if (ta) { out.push({...base, widget: 'text', kind: 'textarea', id: ta.name, filled: !!ta.value}); return; }
    const inp = entry.querySelector('input:not([type=hidden])');
    if (inp) out.push({...base, widget: 'text', kind: 'text', id: inp.name, filled: !!inp.value, placeholder: inp.placeholder || ''});
  });
  return out;
}
"""


# ---- the resume parser, the location widget and the hCaptcha script ------------------------------- #

PARSE_CAP_S = 20.0               # most we wait for /parseResume and the fields it writes
PARSE_SETTLE_S = 0.8             # the parser's fields must stay unchanged this long
PARSE_LATE_S = 10.0              # a parse still running when the form is filled: wait this long for it
LOCATION_SUGGESTIONS_S = 6.0
HCAPTCHA_LOAD_RETRY_S = 10.0     # how long to give js.hcaptcha.com before calling it "not loaded"
HCAPTCHA_MIN_WAIT_S = 180        # attended: at least this long for you to unblock it or submit yourself
CORE_FIELD = re.compile(r"^(name|email|phone|urls\[.+\])$")      # what the parser writes and we answer
POLL_PARSED_JS = """() => [...document.querySelectorAll('input[name], textarea[name]')]
  .filter(e => /^(name|email|phone|org|location|selectedLocation|urls\\[.+\\])$/.test(e.name))
  .map(e => e.name + '=' + e.value).join('|')"""


def warn(message: str) -> None:
    print(f"      ! Lever: {message}", flush=True)


class ParseWatch:
    """Lever's POST /parseResume: has it started, has it answered, and when. The answer arrives before the
    parser has written its fields into the form, so callers also wait for those fields to settle."""

    def __init__(self, page: Page):
        self.started = self.done = False
        self.status: int | None = None
        self.failure = ""
        self.done_at = 0.0
        page.on("request", self._request)
        page.on("response", self._response)
        page.on("requestfailed", self._failed)

    @staticmethod
    def _is_parse(url: str) -> bool:
        return url.split("?")[0].endswith("/parseResume")

    def _request(self, r) -> None:
        if self._is_parse(r.url):
            self.started, self.done = True, False

    def _response(self, r) -> None:
        if self._is_parse(r.url):
            self.status, self.done, self.done_at = r.status, True, time.monotonic()

    def _failed(self, r) -> None:
        if self._is_parse(r.url):
            self.failure, self.done, self.done_at = (r.failure or "request failed")[:60], True, time.monotonic()

    @property
    def ok(self) -> bool:
        return self.done and not self.failure and (self.status or 0) < 400


def place_matches(name: str, city: str, states: set[str]) -> bool:
    """'Frisco, TX, USA' is Frisco in Texas: the city leads and the state (abbreviated or in full) is named."""
    low = " ".join(str(name).lower().split())
    return low.startswith(city.lower()) and any(re.search(rf"\b{re.escape(s.lower())}\b", low) for s in states if s)


def wanted_place(profile: dict) -> tuple[str, set[str]]:
    addr = profile.get("address") or {}
    if not addr.get("city"):
        raise LookupError("no city in the profile's address")
    return addr["city"], {addr.get("state_abbr", ""), addr.get("state", "")}


class LeverAdapter(BaseAdapter):
    name = "Lever"
    form_ready_selector = "#application-form, form .application-question"

    @staticmethod
    def matches(url: str) -> bool:
        return host_matches(url, "lever.co")

    def form_url(self, job: dict) -> str:
        p = urlparse(job["url"])
        m = re.match(r"/([^/]+)/([0-9a-f-]{36})", p.path)
        return f"https://{p.netloc}/{m.group(1)}/{m.group(2)}/apply" if m else job["url"]

    async def job_text(self, page: Page, job: dict) -> str:
        # The /apply page has no description; the public postings API does.
        p = urlparse(job["url"])
        m = re.match(r"/([^/]+)/([0-9a-f-]{36})", p.path)
        if not m:
            return ""
        api = "api.eu.lever.co" if ".eu." in p.netloc else "api.lever.co"
        data = await asyncio.to_thread(fetch_json, f"https://{api}/v0/postings/{m.group(1)}/{m.group(2)}") or {}
        lists = " ".join(f"{l.get('text', '')} {strip_html(l.get('content', ''))}" for l in data.get("lists", []))
        return " ".join([data.get("text", ""), data.get("descriptionPlain") or "", lists,
                         data.get("additionalPlain") or ""]).strip()

    async def extract(self, page: Page, include_filled: bool = False) -> list[FormField]:
        fields = []
        for r in await page.evaluate(EXTRACT_JS):
            if r.get("filled") and not include_filled:
                continue
            q = Question(label=r["label"], kind=r["kind"], required=bool(r["required"]),
                         options=r.get("options") or [], field_id=r.get("id") or "",
                         placeholder=r.get("placeholder", ""))
            fields.append(FormField(q, r["sel"], r["widget"]))
        return fields

    def special(self, f: FormField, profile: dict) -> Decision | None:
        fid, ident, addr = f.question.field_id, profile["identity"], profile["address"]
        if fid == "name":
            return Decision("fill", ident["full_name"], "lever-name")
        if fid == "location":
            return Decision("fill", f"{addr['city']}, {addr['state_abbr']}", "lever-location")
        if fid == "org":                                    # "Current company": student, leave blank
            return Decision("skip", rule="lever-current-company")
        return None

    # ---- the resume parser ------------------------------------------------------------------------
    def _st(self, page: Page, reset: bool = False) -> dict:
        """Per-page state: the parse watch and the values we intend for the fields the parser also writes."""
        pages = self.__dict__.setdefault("_lever_pages", {})
        if reset or id(page) not in pages:
            pages[id(page)] = {"watch": None, "intended": {}, "filled_at": {}, "location": None, "profile": {},
                               "settled": False, "org_checked_at": 0.0}
        return pages[id(page)]

    async def _settle(self, page: Page, deadline: float) -> None:
        """Until the fields the parser fills have stopped changing (or the deadline)."""
        last, since = None, time.monotonic()
        while time.monotonic() < deadline:
            try:
                now = await page.evaluate(POLL_PARSED_JS)
            except Exception:                              # noqa: BLE001 - navigating
                return
            if now != last:
                last, since = now, time.monotonic()
            elif time.monotonic() - since >= PARSE_SETTLE_S:
                return
            await page.wait_for_timeout(150)

    async def _await_parse(self, page: Page, st: dict) -> None:
        """Wait for /parseResume and for the fields it writes, up to PARSE_CAP_S. A parse that errors,
        never starts or times out is logged and the form is filled normally: it never fails the run."""
        watch, start = st["watch"], time.monotonic()
        deadline = start + PARSE_CAP_S
        while not watch.done and time.monotonic() < deadline:
            if not watch.started and time.monotonic() - start > 3:
                warn("no /parseResume request was seen after the upload; filling the form without it")
                return
            await page.wait_for_timeout(150)
        if not watch.done:
            warn(f"/parseResume did not answer within {PARSE_CAP_S:g}s; filling now (a late parse is corrected afterwards)")
            return
        if not watch.ok:
            warn(f"/parseResume failed ({watch.failure or watch.status}); filling the form without it")
            return
        await self._settle(page, deadline)
        st["settled"] = True

    async def _clear_org(self, page: Page, st: dict) -> bool:
        """The parser copies the most recent employer into "Current company": keep it only when the profile
        really lists a current job there. True when it was cleared."""
        org = page.locator('input[name="org"]')
        st["org_checked_at"] = time.monotonic()
        if not await org.count():
            return False
        parsed = (await org.input_value()).strip().lower()
        current = [x["company"].lower() for x in (st["profile"].get("experience") or []) if x.get("current")]
        if parsed and not any(parsed in c or c in parsed for c in current):
            await org.fill("")
            return True
        return False

    async def _recheck(self, page: Page) -> None:
        """After the fields are filled (and again right before Submit): a resume parse that landed late must
        not have overwritten them or brought "Current company" back. A parse still running is waited for."""
        st = self._st(page)
        watch = st["watch"]
        if watch is None or not watch.started:
            return
        if not watch.done:
            warn(f"the resume parse is still running; waiting up to {PARSE_LATE_S:g}s before the final check")
            end = time.monotonic() + PARSE_LATE_S
            while not watch.done and time.monotonic() < end:
                await page.wait_for_timeout(150)
        if watch.ok and (not st["settled"] or watch.done_at > st["org_checked_at"]):
            await self._settle(page, time.monotonic() + PARSE_LATE_S)
            st["settled"] = True
        fixed = []
        for name, want in st["intended"].items():
            el = page.locator(f'[name="{name}"]')
            if not await el.count():
                continue
            cur = await el.input_value()
            if cur != want and (cur == "" or watch.done_at > st["filled_at"].get(name, 0)):
                await el.fill(want)                        # what the parser wrote after we filled it
                fixed.append(name)
        if watch.done_at > st["org_checked_at"] and await self._clear_org(page, st):
            fixed.append("org")
        if st["location"]:
            try:
                await self._set_location(page, st["location"], st["profile"])
            except LookupError as exc:
                warn(f"location: {exc}")
        if fixed:
            warn("re-applied after the resume parse: " + ", ".join(fixed))

    async def answer_form(self, page: Page, job: dict, engine, ctx, text: str, state) -> None:
        await super().answer_form(page, job, engine, ctx, text, state)
        await self._recheck(page)

    # ---- the location widget ---------------------------------------------------------------------------
    async def _location_chosen(self, page: Page, city: str, states: set[str]) -> bool:
        """The hidden selectedLocation holds a place that is the wanted one (the visible text alone is not
        enough: Lever clears both when the text was typed but no suggestion was picked)."""
        sel = page.locator('input[name="selectedLocation"]')
        inp = page.locator('input[name="location"]')
        if not await sel.count() or not (await inp.input_value()).strip():
            return False
        raw = (await sel.input_value()).strip()
        if not raw:
            return False
        try:
            name = json.loads(raw).get("name", "")
        except (ValueError, AttributeError):
            name = raw
        return place_matches(name, city, states)

    async def _clear_location(self, page: Page) -> None:
        """Empty the visible text AND the hidden selectedLocation: a stale hidden place (the parser's, or a
        half-chosen one) would otherwise be submitted for text that is no longer there."""
        await page.locator('input[name="location"]').fill("")
        await page.evaluate("""() => { const h = document.querySelector('[name="selectedLocation"]');
            if (h) { h.value = ''; h.dispatchEvent(new Event('change', {bubbles: true})); } }""")

    async def _set_location(self, page: Page, value: str, profile: dict) -> None:
        """Keep the parser's location only if it is the profile's city and state; otherwise clear it, type
        with real key presses (Lever fetches suggestions on key events, not on fill), pick the matching
        suggestion and verify selectedLocation is set. Raises LookupError instead of reporting a
        location that is not there."""
        city, states = wanted_place(profile)
        inp = page.locator('input[name="location"]')
        if not await inp.count():
            raise LookupError("this form has no location field")
        if await self._location_chosen(page, city, states):
            return
        await inp.click()
        await self._clear_location(page)                   # whatever is there (a different parsed place)
        await inp.press_sequentially(value, delay=60)
        end, index = time.monotonic() + LOCATION_SUGGESTIONS_S, None
        suggestions = page.locator(".dropdown-location:visible")
        while time.monotonic() < end and index is None:
            await page.wait_for_timeout(250)
            texts = await suggestions.all_inner_texts()
            index = next((i for i, t in enumerate(texts) if place_matches(t, city, states)), None)
        if index is None:
            await self._clear_location(page)               # never leave text Lever will discard on blur
            raise LookupError(f"Lever offered no suggestion matching {city}, {sorted(s for s in states if s)[0]}")
        await suggestions.nth(index).click()
        await page.wait_for_timeout(400)
        if not await self._location_chosen(page, city, states):
            await self._clear_location(page)
            raise LookupError("selectedLocation stayed empty after picking the suggestion")
        self._st(page)["profile"] = profile

    async def fill(self, page: Page, f: FormField, value, profile: dict) -> None:
        if f.widget == "file":
            st = self._st(page, reset=True)                # a new application form: forget the last one
            st["profile"], st["watch"] = profile, ParseWatch(page)
            await page.set_input_files(f"{f.sel} input[type=file]", value)
            await self._await_parse(page, st)
            await self._clear_org(page, st)
            return
        if f.widget == "text":
            st = self._st(page)
            st["profile"] = st["profile"] or profile
            if f.question.field_id == "location":
                await self._set_location(page, str(value), profile)
                st["location"] = str(value)
                return
            target = page.locator(f"{f.sel} textarea, {f.sel} input:not([type=hidden])").first
            await target.fill(str(value))
            name = await target.get_attribute("name") or ""
            if CORE_FIELD.match(name):                     # the parser writes these too: remember what we meant
                st["intended"][name], st["filled_at"][name] = str(value), time.monotonic()
            return
        if f.widget == "select":
            await page.select_option(f"{f.sel} select", label=str(value))
            return
        if f.widget == "boxes":
            wanted = None if value is True else ([value] if isinstance(value, str) else list(value))
            inputs = page.locator(f"{f.sel} input[type=radio], {f.sel} input[type=checkbox]")
            done = 0
            for i in range(await inputs.count()):
                box = inputs.nth(i)
                text = " ".join((await box.locator("xpath=ancestor::label[1]").inner_text()).split())
                if wanted is None or text in wanted:
                    try:                                    # styled inputs are hidden: click their label
                        await box.locator("xpath=ancestor::label[1]").click(timeout=4000)
                    except Exception:                       # noqa: BLE001
                        await box.evaluate("e => e.click()")
                    done += 1
            if not done:
                raise LookupError(f"option {wanted!r} not found")
            return
        raise NotImplementedError(f.widget)

    async def confirmed(self, page: Page) -> str | None:
        return page.url if "/thanks" in page.url else None

    async def _hcaptcha_ready(self, page: Page) -> tuple[str, str, str] | None:
        """None when Submit can be pressed. When the page has an hCaptcha widget but its script has not
        loaded: retry for a few seconds; then (attended) tell the candidate by bell, terminal and phone and
        wait for the script to load or for them to submit, or (unattended) go to manual review."""
        loaded = lambda: page.evaluate("() => typeof window.hcaptcha !== 'undefined'")
        if not await page.locator("#h-captcha, .h-captcha").count() or await loaded():
            return None
        end = time.monotonic() + HCAPTCHA_LOAD_RETRY_S
        while time.monotonic() < end:
            await page.wait_for_timeout(500)
            if await loaded():
                return None
        why = "hCaptcha's script (js.hcaptcha.com) did not load: an ad blocker or the network is blocking it"
        if not self.human_wait_s:
            return MANUAL_REVIEW, "CAPTCHA", why + "; submit by hand"
        wait = max(self.human_wait_s, HCAPTCHA_MIN_WAIT_S)
        job = run_state.read().get("job") or {}
        who = f"{job.get('company', 'this posting')} ({job.get('title', '')})".replace(" ()", "")
        print(f"\a[ACTION REQUIRED] {who}: {why}. Allow js.hcaptcha.com for jobs.lever.co, or solve and press "
              f"Submit yourself in the browser window (waiting up to {wait}s).", flush=True)
        self._captcha_status("Waiting for you: hCaptcha did not load")
        phone = phone_notify.notifier()
        if phone.enabled:
            try:
                shot = await page.screenshot(timeout=3000)
            except Exception:                              # noqa: BLE001
                shot = None
            await asyncio.to_thread(phone.ask_choice, f"**🧩 hCaptcha did not load** on {who}. Allow js.hcaptcha.com "
                                    "or submit it yourself in the browser, or reply `/skip`", shot)
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            await page.wait_for_timeout(1000)
            if "/thanks" in page.url:
                return SUBMITTED, "submitted by the candidate in the browser", page.url
            if await loaded():
                print("      hCaptcha loaded: continuing", flush=True)
                return None
            if phone.enabled and (await phone.apoll_reply()) == "/skip":
                return MANUAL_REVIEW, "SKIPPED_FROM_PHONE", "hCaptcha script did not load; skipped from the phone"
        return MANUAL_REVIEW, "CAPTCHA", why + " (not completed in time)"

    async def submit(self, page: Page) -> tuple[str, str, str]:
        await self._recheck(page)                          # a late resume parse must not have changed the form
        blocked = await self._hcaptcha_ready(page)
        if blocked:
            return blocked
        clicked_at = time.time()
        await page.locator("#btn-submit").click()
        watch = SubmitWatch(self, 12)
        while watch.running():
            await page.wait_for_timeout(500)
            if "/thanks" in page.url:
                return SUBMITTED, "thanks page", page.url
            code = await self.code_step(page, clicked_at)
            if code == "entered":
                watch.extend(30)
                continue
            if code == "manual":
                done = watch.human_gate("EMAIL_VERIFICATION_CODE", "Lever e-mailed a verification code")
                if done:
                    return done
                continue
            if await visible_captcha(page):
                if await self.captcha_step(page, watch=watch):
                    continue
                done = watch.human_gate("CAPTCHA", "hCaptcha challenge shown on submit")
                if done:
                    return done
                continue
            if watch.gate:
                continue
            errs = await page.locator(".error-message:visible").all_inner_texts()
            errs = [e.strip() for e in errs if e.strip()]
            if errs:
                return MANUAL_REVIEW, "VALIDATION_ERROR", " | ".join(errs[:5])[:300]
        return watch.timed_out()
