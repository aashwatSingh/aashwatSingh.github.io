"""ats/captcha_solver.py in headless Chromium, against mock widgets. No network, no solving service."""
import asyncio
import html
import time

import pytest
from playwright.async_api import async_playwright

import run_state
from ats import captcha_solver as cs
from ats.base import MANUAL_REVIEW, SUBMITTED
from ats.greenhouse import GreenhouseAdapter
from tests.test_assist import EMAIL, FIRST, adapter, apply, form, home, run     # noqa: F401 - fixture

WIDGETS = {      # kind: (iframe src, token field, wrapper class, checkbox id)
    "recaptcha": ("https://site.test/recaptcha/api2/anchor?k=sitekey", "g-recaptcha-response", "g-recaptcha", "recaptcha-anchor"),
    "hcaptcha": ("https://site.test/hcaptcha/captcha/v1/x/static/hcaptcha.html#frame=checkbox", "h-captcha-response",
                 "h-captcha", "checkbox"),
    "turnstile": ("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/x", "cf-turnstile-response",
                  "cf-turnstile", "cf-box"),
}
TOKEN = "tok-" + "x" * 30


def widget(kind="recaptcha", *, accept=True, token=True, prefilled=False, challenge=False) -> str:
    """A widget as the real ones are built: an iframe holding the checkbox, and a response field in the page.
    The iframe is srcdoc (same origin as the page) so the mock can fill the page's token like the real one does."""
    src, name, cls, box = WIDGETS[kind]
    on_click = "window.parent.__clicks = (window.parent.__clicks || 0) + 1;"
    if accept:
        on_click += " this.setAttribute('aria-checked', 'true');"
        if token:
            on_click += f" window.parent.document.querySelector('[name={name}]').value = '{TOKEN}';"
    doc = (f'<body style="margin:0"><div id="{box}" role="checkbox" aria-checked="false" onclick="{on_click}" '
           'style="position:absolute;left:14px;top:25px;width:28px;height:28px;border:2px solid #888"></div></body>')
    out = (f'<div class="{cls}"><iframe src="{src}" srcdoc="{html.escape(doc)}" width="304" height="78" '
           f'style="border:0"></iframe></div>'
           f'<textarea name="{name}" style="display:none">{TOKEN if prefilled else ""}</textarea>')
    if challenge:
        out += ('<iframe src="https://site.test/recaptcha/api2/bframe" srcdoc="&lt;p&gt;pick all the buses&lt;/p&gt;" '
                'width="400" height="580"></iframe>')
    return out


def page_of(body: str) -> str:
    return f"<html><body><h1>Apply</h1><div style='height:40px'></div>{body}<p>footer</p></body></html>"


def with_page(html_text, fn):
    async def go():
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            page = await browser.new_page()
            await page.set_content(html_text)
            try:
                return await fn(page)
            finally:
                await browser.close()
    return run(go())


@pytest.fixture(autouse=True)
def quick_waits(monkeypatch):
    monkeypatch.setattr(cs, "CHECKBOX_WAIT_S", 1.5)


# ---- 1. nothing to do ---------------------------------------------------------------------- #

def test_a_page_without_a_captcha_costs_milliseconds():
    async def go(page):
        t = time.monotonic()
        r = await cs.detect_and_solve_captcha(page)
        return r, time.monotonic() - t
    r, took = with_page("<html><body><form><input id=a></form></body></html>", go)
    assert (r.detected, r.solved, r.kind, r.method, r.error) == (False, False, None, "", None) and took < 1.0


# ---- 2. detached, missing and cross-origin frames never raise -------------------------------- #

def test_a_frame_that_is_removed_or_unreachable_never_raises():
    async def go(page):
        removed = widget()
        await page.set_content(page_of(removed))
        await page.evaluate("document.querySelector('iframe').remove()")      # detached before the probe
        a = await cs.detect_and_solve_captcha(page, allow_manual_fallback=False)
        await page.set_content(page_of('<div class="g-recaptcha"><iframe src="https://unreachable.invalid/recaptcha/api2/'
                                       'anchor" width="304" height="78"></iframe></div>'
                                       '<textarea name="g-recaptcha-response"></textarea>'))
        b = await cs.detect_and_solve_captcha(page, allow_manual_fallback=False)
        await page.set_content(page_of(widget(accept=False)))
        c = await cs.detect_and_solve_captcha(page, allow_manual_fallback=False)
        return a, b, c
    a, b, c = with_page("<html></html>", go)
    assert (a.detected, a.visible, a.solved) == (True, False, False)       # a response field is left, nothing to click
    assert b.detected and not b.solved and b.error
    assert c.detected and not c.solved and "needs a person" in c.error


def test_a_page_that_navigates_during_the_probe_is_not_an_error():
    async def go(page):
        await page.set_content(page_of(widget()))
        task = asyncio.create_task(cs.detect_and_solve_captcha(page, allow_manual_fallback=False))
        await page.goto("about:blank")
        return await task
    r = with_page("<html></html>", go)
    assert isinstance(r, cs.CaptchaResult)                                  # whatever it found, no exception


# ---- 3. the checkbox click -------------------------------------------------------------------- #

@pytest.mark.parametrize("kind", list(WIDGETS))
def test_clicking_the_checkbox_fills_the_token(kind):
    async def go(page):
        statuses = []
        r = await cs.detect_and_solve_captcha(page, allow_manual_fallback=False, on_status=statuses.append)
        return r, statuses, await page.evaluate("window.__clicks"), await page.evaluate(
            f"document.querySelector('[name={WIDGETS[kind][1]}]').value")
    r, statuses, clicks, value = with_page(page_of(widget(kind)), go)
    assert (r.detected, r.solved, r.kind, r.method, r.visible) == (True, True, kind, "checkbox", True)
    assert clicks == 1 and value == TOKEN
    assert statuses[0] == "Solving CAPTCHA..." and statuses[-1].startswith("Solved")


def test_a_ticked_checkbox_without_a_token_counts_too():
    async def go(page):
        return await cs.detect_and_solve_captcha(page, allow_manual_fallback=False)
    r = with_page(page_of(widget(token=False)), go)
    assert (r.solved, r.method) == (True, "checkbox")


def test_an_already_solved_widget_is_not_clicked():
    async def go(page):
        r = await cs.detect_and_solve_captcha(page)
        return r, await page.evaluate("window.__clicks || 0")
    r, clicks = with_page(page_of(widget(prefilled=True)), go)
    assert (r.detected, r.solved, r.method) == (True, True, "already_solved") and clicks == 0


def test_an_invisible_widget_is_detected_and_left_alone():
    invisible = ('<div class="g-recaptcha" data-size="invisible"></div>'
                 '<textarea name="g-recaptcha-response" style="display:none"></textarea>')

    async def go(page):
        return await cs.detect_and_solve_captcha(page)
    r = with_page(page_of(invisible), go)
    assert (r.detected, r.visible, r.solved, r.method) == (True, False, False, "")


# ---- 4. hand-over to the candidate ----------------------------------------------------------------- #

def test_unattended_returns_unsolved_without_waiting():
    async def go(page):
        t = time.monotonic()
        r = await cs.detect_and_solve_captcha(page, allow_manual_fallback=False)
        return r, time.monotonic() - t
    r, took = with_page(page_of(widget(accept=False, challenge=True)), go)
    assert not r.solved and "needs a person" in r.error and took < 3


def test_manual_wait_highlights_then_resumes_as_soon_as_the_token_appears(capsys):
    async def go(page):
        task = asyncio.create_task(cs.detect_and_solve_captcha(page, manual_timeout_s=30))
        await page.wait_for_selector("#ia-captcha-badge", timeout=10000)
        seen = await page.evaluate("document.querySelector('iframe[src*=bframe]').style.outline")
        await asyncio.sleep(0.7)
        done_before = task.done()
        t = time.monotonic()
        await page.evaluate(f"document.querySelector('[name=g-recaptcha-response]').value = '{TOKEN}'")
        r = await asyncio.wait_for(task, 5)
        return (r, seen, done_before, time.monotonic() - t,
                await page.evaluate("!!document.getElementById('ia-captcha-badge')"),
                await page.evaluate("document.querySelector('iframe[src*=bframe]').style.outline"))
    r, outline, done_before, resumed_in, badge_left, outline_after = with_page(page_of(widget(accept=False, challenge=True)), go)
    assert (r.solved, r.method, done_before) == (True, "manual", False)
    assert "3px" in outline and "168, 85, 247" in outline                  # the same purple as ats/assist.py
    assert resumed_in < 2 and not badge_left and "168" not in outline_after
    assert capsys.readouterr().out.count("\a[ACTION REQUIRED]") == 1       # the bell rings once


def test_manual_wait_ends_when_the_widget_goes_away_or_time_runs_out():
    async def go(page):
        gone = asyncio.create_task(cs.detect_and_solve_captcha(page, manual_timeout_s=30))
        await page.wait_for_selector("#ia-captcha-badge", timeout=10000)
        await page.evaluate("document.querySelectorAll('iframe, textarea, .g-recaptcha').forEach(e => e.remove())")
        a = await asyncio.wait_for(gone, 5)
        await page.set_content(page_of(widget(accept=False, challenge=True)))
        b = await cs.detect_and_solve_captcha(page, manual_timeout_s=1.2)
        return a, b, await page.evaluate("!!document.getElementById('ia-captcha-badge')")
    a, b, badge = with_page(page_of(widget(accept=False, challenge=True)), go)
    assert (a.solved, a.method) == (False, "gone")
    assert (b.solved, b.method, b.error) == (False, "", "not solved in time") and not badge


# ---- 5. wired into the apply flow: never a second Submit ----------------------------------------------- #

def _with_widget(w, *fields):
    return form(*fields).replace('<form id="application-form"', w + '<form id="application-form"')


async def _run(a, html_text, home):
    return await apply(a, html_text, home, drive=_widget_clicks)


async def _widget_clicks(page, task):
    await asyncio.wait_for(task, 60)
    return await page.evaluate("window.__clicks || 0")


def test_a_checkbox_captcha_on_the_form_is_ticked_once_before_the_single_submit(home):
    result, widget_clicks, submit_clicks = run(_run(adapter(wait=0), _with_widget(widget(), FIRST, EMAIL), home))
    assert (result.status, widget_clicks, submit_clicks) == (SUBMITTED, 1, 1)


def test_a_widget_that_never_clears_costs_no_extra_submit(home):
    result, widget_clicks, submit_clicks = run(_run(adapter(wait=0), _with_widget(widget(accept=False), FIRST, EMAIL), home))
    assert submit_clicks == 1 and widget_clicks <= 2                        # the form's own confirmation ended it
    assert result.status == SUBMITTED


def test_the_hook_stops_after_two_attempts_per_page():
    async def go(page):
        a = GreenhouseAdapter()
        a.human_wait_s = 0
        results = [await a.captcha_step(page) for _ in range(4)]
        return results, await page.evaluate("window.__clicks")
    results, clicks = with_page(page_of(widget(accept=False)), go)
    assert results == [False] * 4 and clicks == 2                           # two clicks in all, then it leaves the page alone


def test_a_cleared_captcha_is_counted_for_mission_control(home):
    async def go(page):
        a = GreenhouseAdapter()
        a.human_wait_s = 0
        class Gate:
            def step(self, step, message="", **extra):
                run_state.update({"id": "j", "company": "Acme"}, step, message, **extra)
        a.receipt_gate = Gate()
        a.reset_captchas()
        return await a.captcha_step(page)
    assert with_page(page_of(widget()), go) is True
    state = run_state.read()
    assert state["captchas"] == 1 and state["message"] == "Solved 1 CAPTCHA"


def test_mission_control_state_carries_the_captcha_count(home):
    import app_server
    run_state.update({"id": "j", "company": "Acme"}, run_state.SUBMITTING, "Solving CAPTCHA...", captchas=2)
    state = app_server.build_state()
    assert (state["captchas"], state["message"]) == (2, "Solving CAPTCHA...")
    assert "GMAIL_APP_PASSWORD" not in str(state)


# ---- the Excel check before a live run ------------------------------------------------------------------ #

def test_tracker_writable(tmp_path):
    import agent_runner
    assert agent_runner.tracker_writable(tmp_path / "missing.xlsx") is True
    (tmp_path / "t.xlsx").write_bytes(b"x")
    assert agent_runner.tracker_writable(tmp_path / "t.xlsx") is True
    (tmp_path / "locked").mkdir()
    assert agent_runner.tracker_writable(tmp_path / "locked") is False      # cannot be opened for writing
