"""Ashby adapter (jobs.ashbyhq.com/<org>/<posting-id>/application)."""
from __future__ import annotations

import asyncio
import re
from urllib.parse import urlparse

from playwright.async_api import Page, TimeoutError as PWTimeout

from answers import Decision, Question
from urls import host_matches
from ats.base import (MANUAL_REVIEW, SUBMITTED, BaseAdapter, FormField, SubmitWatch, fetch_json,
                      visible_captcha)

EXTRACT_JS = r"""
() => {
  const out = []; let n = 0;
  const tag = el => { const id = 'ia' + (n++); el.setAttribute('data-ia', id); return `[data-ia="${id}"]`; };
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  // Plain fields are div.ashby-application-form-field-entry; radio, checkbox and dropdown groups are
  // <fieldset class="..._fieldEntry_...">. Match both, outermost only.
  const entries = [...document.querySelectorAll('.ashby-application-form-field-entry, [class*="_fieldEntry_"]')]
    .filter(e => !e.parentElement.closest('.ashby-application-form-field-entry, [class*="_fieldEntry_"]'));
  entries.forEach(entry => {
    const title = entry.querySelector(':scope > label, :scope > div > label[class*="_heading_"], label[class*="_heading_"]');
    if (!title) return;
    const label = clean(title.innerText);
    const required = /_required_/.test(title.className);
    const description = clean(entry.querySelector('[class*="question-descri"]')?.innerText);
    const fid = title.getAttribute('for') || '';
    const base = {sel: tag(entry), label, required, description, id: fid, options: []};
    const optLabel = i => clean(entry.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.innerText);

    const tel = entry.querySelector('input[type=tel]');
    if (tel) {      // phone inputs can carry an SMS / WhatsApp consent radio group in the same entry
      out.push({...base, widget: 'text', kind: 'tel', placeholder: tel.placeholder || '', filled: !!tel.value,
                consent: !!entry.querySelector('input[type=radio][value="notGiven"]')});
      return;
    }
    const file = entry.querySelector('input[type=file]');
    if (file) { out.push({...base, widget: 'file', kind: 'file', filled: false}); return; }
    const radios = [...entry.querySelectorAll('input[type=radio]')];
    if (radios.length) {
      out.push({...base, widget: 'boxes', kind: 'radio', options: radios.map(optLabel), filled: radios.some(r => r.checked)});
      return;
    }
    const yesno = entry.querySelector('[class*="_yesno_"]');
    if (yesno) {
      const btns = [...yesno.querySelectorAll('button')];
      out.push({...base, widget: 'yesno', kind: 'boolean', options: btns.map(b => clean(b.innerText)),
                filled: btns.some(b => b.getAttribute('aria-pressed') === 'true' || /_active_/.test(b.className))});
      return;
    }
    const boxes = [...entry.querySelectorAll('input[type=checkbox]')];
    if (boxes.length) {
      const opts = boxes.map(optLabel);
      const single = boxes.length === 1;
      out.push({...base, widget: 'boxes', kind: single ? 'checkbox' : 'checkbox_group',
                label: single && opts[0] && opts[0] !== label ? `${label} ${opts[0]}` : label,
                options: single ? [] : opts, filled: boxes.some(b => b.checked)});
      return;
    }
    const combo = entry.querySelector('input[role=combobox]');
    if (combo) { out.push({...base, widget: 'combobox', kind: 'select', lazy: true, filled: !!combo.value}); return; }
    const sel = entry.querySelector('select');
    if (sel) {
      out.push({...base, widget: 'select', kind: 'select', filled: !!sel.value,
                options: [...sel.options].map(o => clean(o.text)).filter(Boolean)});
      return;
    }
    const ta = entry.querySelector('textarea');
    if (ta) { out.push({...base, widget: 'text', kind: 'textarea', filled: !!ta.value, placeholder: ta.placeholder}); return; }
    const inp = entry.querySelector('input:not([type=hidden])');
    if (inp) {
      const kind = {number: 'number', date: 'date', email: 'email', tel: 'tel'}[inp.type] || 'text';
      out.push({...base, widget: 'text', kind, placeholder: inp.placeholder || '',
                filled: !!inp.value && inp.value !== 'undefined'});
    }
  });
  return out;
}
"""


class AshbyAdapter(BaseAdapter):
    name = "Ashby"
    form_ready_selector = ".ashby-application-form-field-entry, [class*='_fieldEntry_']"
    _boards: dict[str, dict] = {}

    @staticmethod
    def matches(url: str) -> bool:
        return host_matches(url, "ashbyhq.com")

    def form_url(self, job: dict) -> str:
        p = urlparse(job["url"])
        m = re.match(r"/([^/]+)/([0-9a-f-]{36})", p.path)
        if not m:
            return job["url"]
        return f"https://jobs.ashbyhq.com/{m.group(1)}/{m.group(2)}/application"

    async def job_text(self, page: Page, job: dict) -> str:
        # The /application tab has no description; the public job-board API does.
        m = re.match(r"/([^/]+)/([0-9a-f-]{36})", urlparse(job["url"]).path)
        if not m:
            return ""
        org, posting = m.groups()
        if org not in self._boards:
            self._boards[org] = await asyncio.to_thread(
                fetch_json, f"https://api.ashbyhq.com/posting-api/job-board/{org}") or {}
        for j in self._boards[org].get("jobs", []):
            if j.get("id") == posting or posting in (j.get("jobUrl") or ""):
                return f"{j.get('title', '')}\n{j.get('descriptionPlain') or ''}"
        return ""

    async def extract(self, page: Page, include_filled: bool = False) -> list[FormField]:
        fields = []
        for r in await page.evaluate(EXTRACT_JS):
            if r.get("filled") and not include_filled:
                continue
            q = Question(label=r["label"], kind=r["kind"], required=bool(r["required"]),
                         options=r.get("options") or [], field_id=r.get("id") or "",
                         placeholder=r.get("placeholder", ""), description=r.get("description", ""))
            fields.append(FormField(q, r["sel"], r["widget"], {"lazy_options": r.get("lazy", False),
                                                               "consent": r.get("consent", False)}))
        return fields

    def special(self, f: FormField, profile: dict) -> Decision | None:
        fid, addr = f.question.field_id, profile["address"]
        if fid == "_systemfield_location" or (f.widget == "combobox" and re.search(
                r"^(current )?location|where are you (currently )?(located|based)", f.question.label, re.I)):
            return Decision("fill", f"{addr['city']}, {addr['state']}", "ashby-location")
        if fid == "_systemfield_name":
            return Decision("fill", profile["identity"]["full_name"], "ashby-name")
        return None

    async def _options(self, page: Page, f: FormField, typed: str | None = None) -> list[str]:
        inp = page.locator(f"{f.sel} input[role=combobox]")
        await inp.scroll_into_view_if_needed()
        await inp.click()
        if typed is not None:
            await inp.fill(typed)
            await page.wait_for_timeout(1500)
        try:
            await page.wait_for_selector("[role=option]", timeout=1500 if typed is None else 4000)
        except PWTimeout:
            # Dropdown-style fields open from their toggle button (or the arrow key), not a click on the input.
            toggle = page.locator(f"{f.sel} button").first
            try:
                if await toggle.count():
                    await toggle.click()
                else:
                    await inp.press("ArrowDown")
                await page.wait_for_selector("[role=option]", timeout=3000)
            except PWTimeout:
                return []
        return [" ".join(t.split()) for t in await page.locator("[role=option]").all_inner_texts()]

    async def read_options(self, page: Page, f: FormField) -> list[str]:
        options = await self._options(page, f)
        await page.keyboard.press("Escape")
        return options

    async def fill(self, page: Page, f: FormField, value, profile: dict) -> None:
        if f.widget == "file":
            await page.set_input_files(f"{f.sel} input[type=file]", value)
            await page.wait_for_timeout(3000)
            return
        if f.widget == "text":
            target = page.locator(f"{f.sel} textarea, {f.sel} input:not([type=hidden]):not([type=radio])").first
            await target.fill(str(value))
            if f.extra.get("consent"):                  # decline optional SMS / WhatsApp recruiting texts
                declines = page.locator(f'{f.sel} input[type=radio][value="notGiven"]')
                for i in range(await declines.count()):
                    await declines.nth(i).check(force=True)
            return
        if f.widget == "select":
            await page.select_option(f"{f.sel} select", label=str(value))
            return
        if f.widget == "yesno":
            button = page.locator(f"{f.sel} button", has_text=re.compile(rf"^\s*{re.escape(str(value))}\s*$")).first
            try:
                await button.click(timeout=5000)
            except Exception:                               # noqa: BLE001 - covered by a sticky header or overlay
                await button.evaluate("e => e.click()")
            return
        if f.widget == "boxes":
            wanted = None if value is True else ([value] if isinstance(value, str) else list(value))
            inputs = page.locator(f"{f.sel} input[type=checkbox], {f.sel} input[type=radio]")
            done = 0
            for i in range(await inputs.count()):
                box = inputs.nth(i)
                box_id = await box.get_attribute("id")
                lab = page.locator(f'{f.sel} label[for="{box_id}"]')
                text = " ".join((await lab.inner_text()).split()) if await lab.count() else ""
                if wanted is None or text in wanted:
                    await (lab if await lab.count() else box).click()
                    done += 1
            if not done:
                raise LookupError(f"option {wanted!r} not found")
            return
        if f.widget == "combobox":
            if f.question.field_id == "_systemfield_location" or "ashby-location" in str(f.extra.get("rule", "")) \
                    or re.search(r"location|located|based", f.question.label, re.I):
                addr = profile["address"]
                options = await self._options(page, f, typed=f"{addr['city']}, {addr['state_abbr']}")
                hit = next((o for o in options if o.lower().startswith(addr["city"].lower())
                            and re.search(rf"\b({addr['state']}|{addr['state_abbr']})\b", o)), None)
                if not hit:
                    raise LookupError(f"location not offered ({options[:4]})")
            else:
                options = await self._options(page, f)
                hit = value if value in options else None
                if not hit:
                    options = await self._options(page, f, typed=str(value)[:30])
                    hit = value if value in options else None
                if not hit:
                    raise LookupError(f"option {value!r} not offered")
            opts = page.locator("[role=option]")
            for i in range(await opts.count()):
                if " ".join((await opts.nth(i).inner_text()).split()) == hit:
                    await opts.nth(i).click()
                    return
            raise LookupError(f"option {hit!r} vanished")
        raise NotImplementedError(f.widget)

    async def confirmed(self, page: Page) -> str | None:
        if await page.locator(".ashby-application-form-success-container").count():
            return "success panel"
        body = (await page.inner_text("body")).lower()
        if re.search(r"application (was|has been) (successfully )?(submitted|received)|"
                     r"thanks? for (applying|your application)|thank you for applying", body):
            return "confirmation text"
        return None

    async def submit(self, page: Page) -> tuple[str, str, str]:
        button = page.locator("button.ashby-application-form-submit-button, button:has-text('Submit Application')").first
        await button.scroll_into_view_if_needed()
        await button.click()
        watch = SubmitWatch(self, 20)                           # uploads finalise on submit
        while watch.running():
            await page.wait_for_timeout(500)
            if await page.locator(".ashby-application-form-success-container").count():
                return SUBMITTED, "success panel", page.url
            body = (await page.inner_text("body")).lower()
            if re.search(r"application (was|has been) (successfully )?(submitted|received)|"
                         r"thanks? for (applying|your application)|thank you for applying", body):
                return SUBMITTED, "confirmation text", page.url
            if re.search(r"flagged as (possible )?spam|couldn.t submit your application|unable to submit", body):
                return MANUAL_REVIEW, "REJECTED_BY_ATS", "Ashby refused the automated submission (spam/bot check)"
            if await visible_captcha(page):
                done = watch.human_gate("CAPTCHA", "challenge shown on submit")
                if done:
                    return done
                continue
            if watch.gate:
                continue
            errs = await page.locator(".ashby-application-form-failure-container, [class*='_errors_'] li, "
                                      "[class*='_error_']:visible").all_inner_texts()
            errs = [" ".join(e.split()) for e in errs if e.strip()]
            if errs:
                return MANUAL_REVIEW, "VALIDATION_ERROR", " | ".join(errs[:5])[:300]
        return watch.timed_out()
