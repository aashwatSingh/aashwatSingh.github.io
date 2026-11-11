"""Lever adapter (jobs.lever.co/<org>/<posting-id>/apply).

Lever gates every submission behind hCaptcha. It is never auto-solved: when a
challenge appears (or the widget cannot load) the filled form is screenshotted
and the posting goes to the manual-review queue.
"""
from __future__ import annotations

import re
from urllib.parse import urlparse

from playwright.async_api import Page

from answers import Decision, Question
from ats.base import MANUAL_REVIEW, SUBMITTED, BaseAdapter, FormField, SubmitWatch, visible_captcha

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


class LeverAdapter(BaseAdapter):
    name = "Lever"
    form_ready_selector = "#application-form, form .application-question"

    @staticmethod
    def matches(url: str) -> bool:
        return urlparse(url).netloc.endswith("lever.co")

    def form_url(self, job: dict) -> str:
        p = urlparse(job["url"])
        m = re.match(r"/([^/]+)/([0-9a-f-]{36})", p.path)
        return f"https://{p.netloc}/{m.group(1)}/{m.group(2)}/apply" if m else job["url"]

    async def extract(self, page: Page) -> list[FormField]:
        fields = []
        for r in await page.evaluate(EXTRACT_JS):
            if r.get("filled"):
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

    async def fill(self, page: Page, f: FormField, value, profile: dict) -> None:
        if f.widget == "file":
            await page.set_input_files(f"{f.sel} input[type=file]", value)
            await page.wait_for_timeout(4000)               # Lever parses the resume before continuing
            return
        if f.widget == "text":
            target = page.locator(f"{f.sel} textarea, {f.sel} input:not([type=hidden])").first
            await target.fill(str(value))
            if f.question.field_id == "location":           # optional autocomplete; free text is accepted
                await page.wait_for_timeout(1200)
                suggestion = page.locator(".dropdown-location:visible, .dropdown-results div:visible").first
                if await suggestion.count():
                    await suggestion.click()
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
                    await box.check(force=True)
                    done += 1
            if not done:
                raise LookupError(f"option {wanted!r} not found")
            return
        raise NotImplementedError(f.widget)

    async def submit(self, page: Page) -> tuple[str, str, str]:
        has_widget = await page.evaluate("() => typeof window.hcaptcha !== 'undefined'")
        if not has_widget and await page.locator("#h-captcha, .h-captcha").count():
            return MANUAL_REVIEW, "CAPTCHA", "hCaptcha could not load in this environment; submit by hand"
        await page.locator("#btn-submit").click()
        watch = SubmitWatch(self, 12)
        while watch.running():
            await page.wait_for_timeout(500)
            if "/thanks" in page.url:
                return SUBMITTED, "thanks page", page.url
            if await visible_captcha(page):
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
