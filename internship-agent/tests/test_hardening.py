"""Runner hardening in headless Chromium: the pre-submit check, e-mailed codes in another tab, and a
Workday Submit that bounces back to an earlier page."""
import asyncio

import pytest

from playwright.async_api import async_playwright

import agent_runner
import run_state
from ats import otp
from ats.base import MANUAL_REVIEW, SUBMITTED
from tests.test_assist import EMAIL, FIRST, ICE_CREAM, adapter, apply, form, home, run   # noqa: F401 - fixture
from tests.test_portal_submit import (LEVER_HTML, LEVER_THANKS, LEVER_URL, Gate, Ledger, engine, job_for,  # noqa: F401
                                      open_context, portals, prepared, workday_apply, workday_html)

# ---- pre-submit safety net -------------------------------------------------------------------- #

ADD_LATE = """() => {   // a required question the page adds after the others are filled
  const w = document.createElement('div'); w.className = 'field-wrapper';
  w.innerHTML = '<label for="late">Initech employee ID*</label><input id="late" aria-required="true">';
  document.querySelector('#application-form button[type=submit]').before(w);
}"""


@pytest.fixture
def late_field(monkeypatch):
    """The field appears between filling and Submit (right after the form screenshot), every time."""
    import ats.base
    real = ats.base._screenshot

    async def shot_then_add(page, path):
        await real(page, path)
        if not await page.locator("#late").count():
            await page.evaluate(ADD_LATE)
    monkeypatch.setattr(ats.base, "_screenshot", shot_then_add)


ERROR_SHOWN = """<script>
document.getElementById('email').addEventListener('input', () => {
  const e = document.createElement('div'); e.id = 'email-error'; e.className = 'helper-text--error';
  e.textContent = 'Use your school e-mail address.'; document.getElementById('email').after(e);
}, {once: true});
</script>"""


def test_a_required_field_that_appears_late_stops_the_submit(home, late_field):
    result, _, clicks = run(apply(adapter(wait=0), form(FIRST, EMAIL, ICE_CREAM), home))
    assert (result.status, result.reason, clicks) == (MANUAL_REVIEW, "PRESUBMIT_CHECK", 0)
    assert "Initech employee ID" in result.detail and "Initech employee ID" in result.unknowns


def test_an_error_already_on_the_page_stops_the_submit(home):
    result, _, clicks = run(apply(adapter(wait=0), form(FIRST, EMAIL).replace("</body>", ERROR_SHOWN + "</body>"), home))
    assert (result.status, result.reason, clicks) == (MANUAL_REVIEW, "PRESUBMIT_CHECK", 0)
    assert "Email" in result.detail


def test_dry_run_reports_the_late_field_instead_of_ready(home, late_field):
    result, _, clicks = run(apply(adapter(wait=0), form(FIRST, EMAIL), home, dry_run=True))
    assert (result.status, result.reason, clicks) == (MANUAL_REVIEW, "PRESUBMIT_CHECK", 0)


def test_attended_late_field_is_handed_over_then_submitted(home, late_field):
    async def drive(page, task):
        await page.wait_for_selector("[data-ia-assist] #late", timeout=30000)
        await page.fill("#late", "E-77")
        await page.dispatch_event("#late", "blur")

    result, _, clicks = run(apply(adapter(wait=120), form(FIRST, EMAIL), home, drive=drive))
    assert (result.status, clicks) == (SUBMITTED, 1)


# ---- e-mailed codes in another tab ---------------------------------------------------------------- #

CODE = "482913"
CODE_PAGE = f"""<html><body><h1>Verify your e-mail</h1>
<p>Enter the 6-digit code we sent to your e-mail address.</p>
<form id="verify" onsubmit="return false"><div class="boxes">
{''.join(f'<input maxlength="1" inputmode="numeric" id="d{i}">' for i in range(6))}</div>
<button type="submit">Verify</button></form>
<script>
const boxes = [...document.querySelectorAll('.boxes input')];
boxes.forEach((b, i) => b.addEventListener('input', () => {{ if (b.value && boxes[i + 1]) boxes[i + 1].focus(); }}));
document.querySelector('#verify button').addEventListener('click', () => {{
  if (boxes.map(b => b.value).join('') === '{CODE}') {{ window.opener.location.href = '{LEVER_URL}/thanks'; window.close(); }}
  else document.body.insertAdjacentHTML('beforeend', '<p>Wrong code</p>');
}});
</script></body></html>"""
# Lever, but Submit opens the code check in a new tab instead of going straight to /thanks.
LEVER_WITH_CODE = LEVER_HTML.replace(
    "sessionStorage.setItem('clicks', window.clicks);\n  location.href = '" + LEVER_URL + "/thanks';",
    "sessionStorage.setItem('clicks', window.clicks);\n  window.open('" + LEVER_URL + "/verify', '_blank');")
NOT_PROMPTS = """<html><body><p>Read our code of conduct. Enter a promo code if you have one.</p>
<label for="z">ZIP code</label><input id="z"><label for="c">Have you read the code of conduct?</label><input id="c">
<label for="p">Promo code</label><input id="p"></body></html>"""


def test_ordinary_code_fields_are_not_mistaken_for_a_prompt():
    async def go():
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            context = await browser.new_context()
            page = await context.new_page()
            await page.set_content(NOT_PROMPTS)
            none = await otp.find_code_prompt(context)
            second = await context.new_page()
            await second.set_content(CODE_PAGE.replace("window.opener.location.href", "void 0; //"))
            found = await otp.find_code_prompt(context)
            await browser.close()
            return none, found[0] is second, found[1]
    none, in_second_tab, info = run(go())
    assert none is None and in_second_tab and (info["boxes"], info["length"]) == (6, 6)


def test_lever_code_in_a_new_tab_is_read_from_gmail_and_entered(home, portals, monkeypatch):
    assert LEVER_WITH_CODE != LEVER_HTML
    asked = []

    async def fake_fetch(since, length):
        asked.append(length)
        return CODE
    monkeypatch.setattr(otp, "fetch_code", fake_fetch)
    gate, seen = Gate(), {}
    job = job_for("Lever", LEVER_URL)
    prepared(monkeypatch, LEVER_URL, gate)
    custom = [{"pattern": "^initech badge number$", "answer": "4417"},
              {"pattern": "^initech locker combination$", "answer": "12-34-56"}]

    async def confirm(gate_, context, job_, *, attended, timeout):
        seen["steps"] = list(gate_.steps)
        return agent_runner.CONFIRMED, {"confirmed": True, "subject": "Thanks for applying"}

    async def go():
        async with async_playwright() as pw:
            browser, context = await open_context(pw, {LEVER_URL + "/apply": LEVER_WITH_CODE, LEVER_URL + "/verify": CODE_PAGE,
                                                       LEVER_URL + "/thanks": LEVER_THANKS})
            eng = engine()
            eng.custom = custom
            try:
                return await asyncio.wait_for(agent_runner.submit_and_confirm(
                    context, job, eng, Ledger(), gate, use_llm=False, attended=True, confirm=confirm), 90)
            finally:
                await browser.close()

    result, outcome, _ = run(go())
    assert (result.status, outcome) == (SUBMITTED, agent_runner.CONFIRMED), (result.reason, result.detail)
    assert asked == [6]
    assert run_state.ENTERING_OTP in seen["steps"]


def test_unattended_code_prompt_goes_to_review(home, portals, monkeypatch):
    async def must_not(*a):
        raise AssertionError("an unattended run never reads mail for a code")
    monkeypatch.setattr(otp, "fetch_code", must_not)
    a = prepared(monkeypatch, LEVER_URL, None, wait=0)
    custom = [{"pattern": "^initech badge number$", "answer": "4417"},
              {"pattern": "^initech locker combination$", "answer": "12-34-56"}]

    async def go():
        async with async_playwright() as pw:
            browser, context = await open_context(pw, {LEVER_URL + "/apply": LEVER_WITH_CODE, LEVER_URL + "/verify": CODE_PAGE})
            page = await context.new_page()
            eng = engine()
            eng.custom = custom
            from answers import Context
            try:
                return await asyncio.wait_for(a.apply(page, job_for("Lever", LEVER_URL), eng,
                                                      Context(company="Acme Robotics"), dry_run=False,
                                                      shot_path=str(home / "s.png")), 60)
            finally:
                await browser.close()
    result = run(go())
    assert (result.status, result.reason) == (MANUAL_REVIEW, "EMAIL_VERIFICATION_CODE")


# ---- Workday: Submit that goes back to an earlier page ------------------------------------------- #

def test_workday_submit_bouncing_back_is_reported_not_looped(home):
    html = workday_html().replace(
        "window.submits++;\n    document.getElementById('wizard').remove();",
        "window.submits++;\n    if (window.submits === 1) { at = 0; show(); return; }\n"
        "    document.getElementById('wizard').remove();")
    assert html != workday_html()
    result, steps, (clicks, submits) = run(workday_apply(html, home))
    assert (result.status, result.reason) == (MANUAL_REVIEW, "WORKDAY_RETURNED")
    assert "My Information" in result.detail and submits == 1          # clicked once, never walked the pages again
