"""Greenhouse adapter (job-boards.greenhouse.io hosted + embedded forms)."""
from __future__ import annotations

import asyncio
import os
import re
import time
from urllib.parse import parse_qs, urlparse

import requests
import config
import gmail_tab_otp
import imap_otp
from playwright.async_api import Page, TimeoutError as PWTimeout

from answers import MONTHS, Decision, Question
from urls import host_matches
from ats.base import (MANUAL_REVIEW, SUBMITTED, BaseAdapter, form_still_showing, FormField, SubmitWatch, fetch_json,
                      strip_html, visible_captcha)

EXTRACT_JS = r"""
() => {
  const out = []; let n = 0;
  const tag = el => { const id = 'ia' + (n++); el.setAttribute('data-ia', id); return `[data-ia="${id}"]`; };
  const clean = s => (s || '').replace(/\s+/g, ' ').replace(/\*\s*$/, '').trim();
  const root = document.querySelector('#application-form') || document.body;
  const labelFor = el => {
    const l = el.id && root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return clean(l ? l.innerText : el.getAttribute('aria-label'));
  };
  const req = el => el.getAttribute('aria-required') === 'true' || el.required;
  const desc = el => { const d = el.id && document.getElementById(el.id + '-description'); return clean(d && d.innerText); };

  root.querySelectorAll('input, textarea').forEach(el => {
    if (el.type === 'hidden' || el.getAttribute('aria-hidden') === 'true' || el.disabled) return;
    if (el.closest('.iti__dropdown-content, .iti__country-container')) return;      // phone flag picker
    if (el.id && /^security-input/.test(el.id)) return;
    if (el.type === 'file') {
      const group = el.closest('.file-upload');
      out.push({sel: tag(el), widget: 'file', kind: 'file', id: el.id,
                label: clean(group?.querySelector('.upload-label')?.innerText) || el.id,
                required: group?.getAttribute('aria-required') === 'true', options: []});
      return;
    }
    if (el.type === 'checkbox' || el.type === 'radio') return;                      // handled per fieldset
    if (el.getAttribute('role') === 'combobox' && el.classList.contains('select__input')) {
      const shell = el.closest('.select-shell');
      const multi = !!shell?.querySelector('.select__value-container--is-multi');
      const filled = !!shell?.querySelector('.select__single-value, .select__multi-value');
      out.push({sel: tag(el), widget: 'react-select', kind: multi ? 'multiselect' : 'select', id: el.id,
                label: labelFor(el), required: req(el), options: [], lazy: true, filled, description: desc(el)});
      return;
    }
    if (el.tagName === 'TEXTAREA' && el.name === 'g-recaptcha-response') return;
    if (!el.id) return;
    out.push({sel: tag(el), widget: 'text', id: el.id, label: labelFor(el), required: req(el), options: [],
              kind: el.tagName === 'TEXTAREA' ? 'textarea' : (el.type === 'number' ? 'number' : 'text'),
              placeholder: el.placeholder || '', filled: !!el.value, description: desc(el)});
  });

  root.querySelectorAll('fieldset').forEach(fs => {
    const boxes = [...fs.querySelectorAll('input[type=checkbox], input[type=radio]')];
    if (!boxes.length) return;
    const opts = boxes.map(b => clean(root.querySelector(`label[for="${CSS.escape(b.id)}"]`)?.innerText));
    const legend = clean(fs.querySelector('legend')?.innerText) || clean(fs.getAttribute('aria-label'));
    const required = fs.getAttribute('aria-required') === 'true' || /\*\s*$/.test(fs.querySelector('legend')?.innerText || '');
    const radio = boxes[0].type === 'radio';
    const single = boxes.length === 1 && !radio;
    out.push({sel: tag(fs), widget: 'boxes', id: fs.id || boxes[0].name || legend,
              kind: single ? 'checkbox' : (radio ? 'radio' : 'checkbox_group'),
              label: single && (!legend || legend === opts[0]) ? opts[0] : (legend || opts[0]),
              required, options: single ? [] : opts, filled: boxes.some(b => b.checked)});
  });
  return out;
}
"""

# The security-code inputs: eight one-character boxes (security-input-0..7) or a single field.
CODE_BOXES = 'input[id^="security-input"], input[id*="security-code"], input[autocomplete="one-time-code"]'
CODE_BOXES_FALLBACK = 'input[maxlength="1"]:visible'

# Returns what is currently typed into the security-code boxes; optionally focuses the first.
CODE_STATE_JS = r"""
([selector, focusFirst]) => {
  let boxes = [...document.querySelectorAll(selector)];
  if (!boxes.length) boxes = [...document.querySelectorAll('input[maxlength="1"]')].filter(e => e.offsetParent);
  if (focusFirst && boxes[0]) { boxes[0].scrollIntoView({block: 'center'}); boxes[0].focus(); }
  return boxes.map(e => e.value || '').join('');
}
"""

EDU_DATE = re.compile(r"^(start|end)-(month|year)--\d+$")


SUBMIT_BUTTON = "#application-form button[type=submit], button:has-text('Submit application')"
GMAIL_CODE_SEARCH = "https://mail.google.com/mail/?authuser={email}#search/greenhouse+security+code+newer_than%3A1h"


async def open_code_search(page: Page) -> None:
    """Open the inbox search for the code in the candidate's everyday browser, where they are signed in.

    The automated window is not signed in to Google (and Google refuses sign-in from automated
    browsers), so the search is opened with the system's default browser instead. Only a convenience:
    the candidate reads the code and types it. Used when the code could not be read automatically
    (see retrieve_code).
    """
    import webbrowser
    from urllib.parse import quote
    try:
        email = config.load_profile()["identity"]["email"]
    except Exception:                                      # noqa: BLE001
        email = ""
    url = GMAIL_CODE_SEARCH.format(email=quote(email)) if email else GMAIL_CODE_SEARCH.replace("?authuser={email}", "u/0/")
    print(f"      The code email is open in your browser: {url}", flush=True)
    try:
        webbrowser.open(url, new=2)
        await page.wait_for_timeout(800)
        await page.bring_to_front()                    # back to the form, with the code box focused
    except Exception:                                      # noqa: BLE001 - the printed link still works
        pass


async def typed_code(page: Page, focus: bool = False) -> str:
    return await page.evaluate(CODE_STATE_JS, [CODE_BOXES, focus])


async def enter_code(page: Page, code: str) -> bool:
    """Type the e-mailed code into the security-code boxes. True once the boxes hold exactly the code."""
    boxes = page.locator(CODE_BOXES)
    if not await boxes.count():
        boxes = page.locator(CODE_BOXES_FALLBACK)
    n = await boxes.count()
    if not n:
        return False
    await boxes.first.scroll_into_view_if_needed()
    if n == 1:
        await boxes.first.fill(code)
    else:
        for i in range(n):                                 # anything left from an earlier attempt
            await boxes.nth(i).fill("")
        await boxes.first.click()
        await page.keyboard.type(code, delay=40)           # the boxes advance focus as each character lands
        if await typed_code(page) != code:
            for i, ch in enumerate(code[:n]):
                await boxes.nth(i).fill(ch)
    return await typed_code(page) == code


async def retrieve_code(page: Page, since: float) -> str | None:
    """Read the code Greenhouse e-mailed after `since` from the candidate's own Gmail.

    Method A (GMAIL_APP_PASSWORD in .env): IMAP, see imap_otp.py. Method B (no app password, or
    IMAP could not be opened): a Gmail tab in this browser profile, see gmail_tab_otp.py.
    Returns None when neither produced a code; the candidate then pastes it as before.
    """
    password = os.environ.get("GMAIL_APP_PASSWORD", "").strip()
    try:
        if password:
            try:
                address = os.environ.get("GMAIL_ADDRESS") or config.load_profile()["identity"]["email"]
                print(f"      Reading the Greenhouse code from {address} over IMAP...", flush=True)
                return await asyncio.to_thread(imap_otp.fetch_code_imap, address, password, since)
            except Exception as exc:                       # noqa: BLE001 - bad app password, IMAP blocked
                print(f"      IMAP lookup failed ({type(exc).__name__}: {str(exc)[:100]}); "
                      "trying the Gmail tab", flush=True)
        print("      Reading the Greenhouse code from the Gmail tab...", flush=True)
        return await gmail_tab_otp.fetch_code_gmail_tab(page.context)
    except Exception as exc:                               # noqa: BLE001 - never fail the application on this
        print(f"      Could not read the code automatically ({type(exc).__name__}: {str(exc)[:100]})", flush=True)
        return None
    finally:
        try:
            await page.bring_to_front()
        except Exception:                                  # noqa: BLE001
            pass


class GreenhouseAdapter(BaseAdapter):
    name = "Greenhouse"
    form_ready_selector = "#application-form"

    # ---- URL handling -------------------------------------------------------
    @staticmethod
    def matches(url: str) -> bool:
        if "\\" in url or "@" in urlparse(url).netloc:
            return False
        return host_matches(url, "greenhouse.io") or "gh_jid=" in url

    def form_url(self, job: dict) -> str:
        url = job["url"]
        p = urlparse(url)
        qs = parse_qs(p.query)
        if host_matches(url, "greenhouse.io"):
            m = re.match(r"/([^/]+)/jobs/(\d+)", p.path)
            if m and m.group(1) != "embed":
                host = "job-boards.eu.greenhouse.io" if ".eu." in p.netloc else "job-boards.greenhouse.io"
                return f"https://{host}/{m.group(1)}/jobs/{m.group(2)}"
            return url
        # Form embedded on the company's own site: find the board it belongs to.
        job_id = (qs.get("gh_jid") or [""])[0]
        board = job.get("gh_board") or resolve_board(job_id, job.get("company", ""), p.netloc)
        if not board:
            raise LookupError("could not resolve the Greenhouse board for this company-hosted posting")
        job["gh_board"] = board
        return f"https://job-boards.greenhouse.io/embed/job_app?for={board}&token={job_id}"

    async def job_text(self, page: Page, job: dict) -> str:
        # Hosted pages show the description above the form; embedded forms do not.
        qs = parse_qs(urlparse(page.url).query)
        if "/embed/" in page.url and qs.get("for") and qs.get("token"):
            data = await asyncio.to_thread(
                fetch_json, f"https://boards-api.greenhouse.io/v1/boards/{qs['for'][0]}/jobs/{qs['token'][0]}") or {}
            return f"{data.get('title', '')}\n{strip_html(data.get('content', ''))}"
        return await self.page_text(page)

    # ---- fields -------------------------------------------------------------
    async def extract(self, page: Page, include_filled: bool = False) -> list[FormField]:
        raw = await page.evaluate(EXTRACT_JS)
        fields = []
        for r in raw:
            if r.get("filled") and not include_filled:
                continue
            q = Question(label=r["label"], kind=r["kind"], required=bool(r["required"]),
                         options=r.get("options") or [], field_id=r.get("id") or "",
                         placeholder=r.get("placeholder", ""), description=r.get("description", ""))
            fields.append(FormField(q, r["sel"], r["widget"], {"lazy_options": r.get("lazy", False)}))
        return fields

    def special(self, f: FormField, profile: dict) -> Decision | None:
        fid, edu, addr = f.question.field_id, profile["education"], profile["address"]
        if fid == "candidate-location":
            return Decision("fill", f"{addr['city']}, {addr['state']}", "gh-location")
        if fid == "country":                       # phone country picker
            return Decision("fill", "United States", "gh-phone-country")
        if fid == "phone":
            return Decision("fill", profile["identity"]["phone_digits"], "gh-phone")
        if fid.startswith("school--"):
            return Decision("fill", edu["school"], "gh-school")
        if fid.startswith("degree--"):
            return Decision("fill", edu["degree"], "gh-degree")
        if fid.startswith("discipline--"):
            return Decision("fill", edu["major"], "gh-discipline")
        m = EDU_DATE.match(fid)
        if m:
            which, part = m.groups()
            month = edu[f"{'start' if which == 'start' else 'grad'}_month"]
            year = edu[f"{'start' if which == 'start' else 'grad'}_year"]
            if f.widget == "react-select":
                return Decision("fill", MONTHS[month - 1] if part == "month" else str(year), "gh-edu-date")
            return Decision("fill", f"{month:02d}" if part == "month" else str(year), "gh-edu-date")
        return None

    async def _open_menu(self, page: Page, f: FormField, typed: str | None = None) -> list[str]:
        inp = page.locator(f.sel)
        await inp.scroll_into_view_if_needed()
        await inp.click()
        if typed:
            await inp.fill(typed)
            await page.wait_for_timeout(1400)      # async search debounce
        try:
            await page.wait_for_selector(".select__menu .select__option", timeout=4000)
        except PWTimeout:
            return []
        return [" ".join(t.split()) for t in await page.locator(".select__menu .select__option").all_inner_texts()]

    async def read_options(self, page: Page, f: FormField) -> list[str]:
        options = await self._open_menu(page, f)
        await page.keyboard.press("Escape")
        return options

    async def _choose(self, page: Page, text: str) -> None:
        opts = page.locator(".select__menu .select__option")
        count = await opts.count()
        for i in range(count):
            if " ".join((await opts.nth(i).inner_text()).split()) == text:
                await opts.nth(i).click()
                return
        raise LookupError(f"option {text!r} not in menu")

    async def fill(self, page: Page, f: FormField, value, profile: dict) -> None:
        q, fid = f.question, f.question.field_id
        if f.widget == "file":
            await page.set_input_files(f.sel, value)
            await page.wait_for_timeout(2500)
            return
        if f.widget == "text":
            await page.fill(f.sel, str(value))
            return
        if f.widget == "boxes":
            wanted = [value] if isinstance(value, str) else (None if value is True else list(value))
            boxes = page.locator(f"{f.sel} input[type=checkbox], {f.sel} input[type=radio]")
            for i in range(await boxes.count()):
                box = boxes.nth(i)
                label = " ".join((await page.locator(f'label[for="{await box.get_attribute("id")}"]')
                                  .inner_text()).replace("*", "").split())
                if wanted is None or label in wanted:
                    await box.check(force=True)
            return

        # react-select variants
        edu = profile["education"]
        if fid == "candidate-location":
            options = await self._open_menu(page, f, typed=value)
            addr = profile["address"]
            hit = next((o for o in options if o.lower().startswith(addr["city"].lower())
                        and addr["state"].lower() in o.lower()), None)
            if not hit:
                raise LookupError(f"location {value!r} not offered ({options[:4]})")
            await self._choose(page, hit)
            return
        if fid.startswith("school--"):
            hit = None
            for term in [edu["school"], *edu["school_aliases"]]:
                options = await self._open_menu(page, f, typed=term)
                hit = _pick_school(options, edu)
                if hit:
                    break
                await page.keyboard.press("Escape")
            if not hit:
                raise LookupError("school not found in Greenhouse list")
            await self._choose(page, hit)
            return
        if fid.startswith("degree--"):
            options = await self._open_menu(page, f)
            hit = next((o for o in options if re.search(r"^bachelor of science|^b\.?s\.?$", o, re.I)), None) \
                or next((o for o in options if re.search(r"^bachelor", o, re.I)), None)
            if not hit:
                raise LookupError(f"no bachelor's option in {options[:8]}")
            await self._choose(page, hit)
            return
        if fid.startswith("discipline--"):
            options = await self._open_menu(page, f, typed=str(value))
            hit = next((o for o in options if o.lower() == str(value).lower()), None)
            if not hit:
                raise LookupError(f"discipline {value!r} not offered")
            await self._choose(page, hit)
            return
        if fid == "country":
            options = await self._open_menu(page, f, typed="United States")
            hit = next((o for o in sorted(options, key=len) if o.lower().startswith("united states")), None)
            if not hit:
                raise LookupError("United States not in phone country list")
            await self._choose(page, hit)
            return

        for v in ([value] if isinstance(value, str) else value):
            options = await self._open_menu(page, f)
            if v not in options:
                options = await self._open_menu(page, f, typed=v[:40])
            await self._choose(page, v)
            await page.wait_for_timeout(150)

    # ---- submit ---------------------------------------------------------------
    async def confirmed(self, page: Page) -> str | None:
        if "/confirmation" in page.url:
            return page.url
        body = (await page.inner_text("body")).lower()
        if re.search(r"thank you for applying|application has been (submitted|received)|"
                     r"thanks for applying|we('ve| have) received your application", body) \
                and not await form_still_showing(page, SUBMIT_BUTTON):
            return "confirmation text"
        return None

    async def submit(self, page: Page) -> tuple[str, str, str]:
        button = page.locator(SUBMIT_BUTTON).first
        await button.scroll_into_view_if_needed()
        clicked_at = time.time()                           # the code e-mail is sent on this click
        await button.click()
        watch = SubmitWatch(self, 15)
        focused = auto_tried = False
        sent_code = ""                                     # the code last submitted, so it is pressed once
        auto_grace = 0.0                                   # until then, an auto-entered code is being checked
        while watch.running():
            await page.wait_for_timeout(500)
            url = page.url
            if "/confirmation" in url:
                return SUBMITTED, "confirmation page", url
            body = (await page.inner_text("body")).lower()
            if re.search(r"thank you for applying|application has been (submitted|received)|"
                         r"thanks for applying|we('ve| have) received your application", body) \
                    and not await form_still_showing(page, SUBMIT_BUTTON):
                return SUBMITTED, "confirmation text", url
            # Greenhouse: "enter the 8-character code" e-mailed to the applicant's address.
            if re.search(r"security code|verification code|enter the code|code (we )?sent to", body):
                # Attended runs (--local-blitz / --assist) read the code from the candidate's own
                # mailbox first; unattended runs still send the posting to manual review.
                if self.human_wait_s and not auto_tried:
                    auto_tried = True
                    watch.extend(imap_otp.POLL_TIMEOUT_S + gmail_tab_otp.SIGN_IN_WAIT_S + 90)
                    code = await retrieve_code(page, clicked_at)
                    if code and await enter_code(page, code):
                        imap_otp.mark_used(code)
                        sent_code = code
                        print("      Code entered; submitting.", flush=True)
                        await page.wait_for_timeout(400)
                        await button.click()
                        auto_grace = time.monotonic() + 12
                    watch.deadline = time.monotonic() + 20
                    continue
                if time.monotonic() < auto_grace:
                    continue                               # Greenhouse is still checking the entered code
                done = watch.human_gate("EMAIL_VERIFICATION_CODE",
                                        "Greenhouse emailed a verification code")
                if done:
                    return done
                # Fallback: a person supplies the code; the runner focuses the box and presses Submit after.
                if not focused:
                    await open_code_search(page)
                typed = await typed_code(page, focus=not focused)
                focused = True
                if len(typed) >= imap_otp.CODE_LENGTH and typed != sent_code:
                    sent_code = typed
                    await page.wait_for_timeout(400)
                    await button.click()
                continue
            if await visible_captcha(page):
                done = watch.human_gate("CAPTCHA", "reCAPTCHA challenge shown on submit")
                if done:
                    return done
                continue
            if watch.gate:
                continue
            errors = await page.locator("[id$='-error']:visible, .helper-text--error:visible").all_inner_texts()
            errors = [e.strip() for e in errors if e.strip()]
            if errors:
                return MANUAL_REVIEW, "VALIDATION_ERROR", " | ".join(errors[:5])[:300]
        return watch.timed_out()


def _pick_school(options: list[str], edu: dict) -> str | None:
    names = [edu["school"], *edu["school_aliases"]]
    simple = lambda s: re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()
    wanted = {simple(n) for n in names} | {simple(n).removeprefix("the ") for n in names}
    for o in options:
        if simple(o) in wanted or simple(o).removeprefix("the ") in wanted:
            return o
    return None


_board_cache: dict[str, str | None] = {}


def resolve_board(job_id: str, company: str, host: str) -> str | None:
    """Find the board token for a job id seen on a company-hosted careers page."""
    if not job_id:
        return None
    if job_id in _board_cache:
        return _board_cache[job_id]
    squash = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())
    sld = host.lower().removeprefix("www.").removeprefix("careers.").removeprefix("jobs.").split(".")[0]
    words = re.sub(r"[^a-z0-9 ]", "", company.lower()).split()
    candidates = [squash(company), sld, "".join(words[:2]), words[0] if words else "",
                  squash(company) + "inc", sld + "inc", squash(company) + "careers"]
    board = None
    for token in dict.fromkeys(c for c in candidates if c):
        try:
            r = requests.get(f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{job_id}", timeout=15)
        except requests.RequestException:
            break
        if r.status_code == 200:
            board = token
            break
    _board_cache[job_id] = board
    return board
