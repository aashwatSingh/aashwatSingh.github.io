"""Optional questions never stop a form; a required one the profile cannot answer is highlighted and
the form continues by itself once it is filled and focus has left it (headless Chromium)."""
import asyncio
import json
from pathlib import Path

import pytest
from playwright.async_api import async_playwright

import agent_runner
import app_server
import config
import run_state
from answers import AnswerEngine, Context, Question, load_custom_answers
from ats import adapter_for, assist
from ats.base import DRY_RUN_OK, MANUAL_REVIEW, SKIPPED_OPTIONAL, SUBMITTED, BaseAdapter, FormField
from ats.greenhouse import GreenhouseAdapter

PROFILE = json.loads((Path(__file__).parent / "fixture_profile.json").read_text())
URL = "https://job-boards.greenhouse.io/acme/jobs/1"
JOB = {"id": "acme-1", "company": "Acme Robotics", "title": "SWE Intern", "ats": "Greenhouse", "url": URL,
       "locations": ["Austin, TX"]}

FIRST = '<label for="first_name">First Name*</label><input id="first_name" aria-required="true">'
EMAIL = '<label for="email">Email*</label><input id="email" aria-required="true">'
ICE_CREAM = '<label for="ice">Favorite ice cream flavor</label><input id="ice">'
NICKNAME = ('<label for="nick">Initech parking spot color (optional)*</label>'
            '<input id="nick" aria-required="true" required>')
BADGE = '<label for="badge">Initech badge number*</label><input id="badge" aria-required="true">'
HAT = ('<fieldset id="hat" aria-required="true"><legend>Initech hat size*</legend>'
       + "".join(f'<input type="radio" name="hat" id="hat{s}" value="{s}"><label for="hat{s}">{s}</label>'
                 for s in "SML") + "</fieldset>")
LOCKER = '<label for="locker">Initech locker combination</label><input id="locker">'      # required, but unmarked


def form(*fields, must=()):
    """A Greenhouse-shaped page. `must`: ids the server-side check insists on (shown only after Submit)."""
    rows = "".join(f'<div class="field-wrapper">{f}</div>' for f in fields)
    return f"""<html><body><h1>Software Engineering Intern, Summer 2027</h1>
<p>Acme Robotics builds warehouse robots. Join us for a twelve week internship in Austin.</p>
<form id="application-form" onsubmit="return false">{rows}
<button type="submit">Submit application</button></form><div id="done"></div>
<script>
window.clicks = 0;
document.querySelector('button[type=submit]').addEventListener('click', () => {{
  window.clicks++;
  document.querySelectorAll('.helper-text--error').forEach(e => e.remove());
  const missing = {json.dumps(list(must))}.filter(id => !document.getElementById(id).value);
  missing.forEach(id => {{
    const e = document.createElement('div'); e.id = id + '-error'; e.className = 'helper-text--error';
    e.textContent = 'This field is required.'; document.getElementById(id).after(e);
  }});
  if (missing.length) return;
  document.getElementById('application-form').remove();
  document.getElementById('done').textContent = 'Thank you for applying to Acme Robotics.';
}});
</script></body></html>"""


def run(coro):
    return asyncio.run(coro)


async def browser_context(pw, html):
    browser = await pw.chromium.launch()
    context = await browser.new_context()

    async def serve(route):
        await route.fulfill(status=200, content_type="text/html", body=html)
    await context.route(URL, serve)
    return browser, context


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "BASE", tmp_path)
    monkeypatch.setattr(config, "RUN_STATE_JSON", tmp_path / "run_state.json")
    monkeypatch.setattr(config, "CUSTOM_ANSWERS_JSON", tmp_path / "custom_answers.json")
    monkeypatch.setattr(config, "MANUAL_REVIEW_DIR", tmp_path)
    monkeypatch.setattr(config, "LOG_DIR", tmp_path)
    return tmp_path


def adapter(wait=0):
    a = GreenhouseAdapter()
    a.human_wait_s, a.write_essays = wait, False
    return a


def engine():
    return AnswerEngine(PROFILE, custom_answers=[])


async def apply(a, html, home, *, dry_run=False, drive=None, eng=None):
    async with async_playwright() as pw:
        browser, context = await browser_context(pw, html)
        page = await context.new_page()
        task = asyncio.create_task(a.apply(page, JOB, eng or engine(), Context(company=JOB["company"], title=JOB["title"]),
                                           dry_run=dry_run, shot_path=str(home / "shot.png")))
        try:
            extra = await drive(page, task) if drive else None
            result = await asyncio.wait_for(task, 60)
            return result, extra, await page.evaluate("() => window.clicks")
        finally:
            await browser.close()


def by_label(result, text):
    return next(a for a in result.answers if text in a["label"])


# ---- unit: what "optional" and "finished" mean -------------------------------------------- #

def test_optional_wording():
    assert assist.says_optional("Hallway nickname (optional)", "", "")
    assert assist.says_optional("Website", "Optional", "")
    assert assist.says_optional("Cover letter", "", "Uploading one is OPTIONAL.")
    assert not assist.says_optional("Are you on Optional Practical Training (OPT)?")
    assert not assist.says_optional("Which options apply to you?")


def test_typed_fields_wait_for_blur_and_single_choices_do_not():
    assert assist.needs_blur("text", "text") and assist.needs_blur("textarea", "text")
    assert assist.needs_blur("select", "react-select") and assist.needs_blur("select", "combobox")
    assert assist.needs_blur("checkbox_group", "boxes") and assist.needs_blur("multiselect", "react-select")
    for kind, widget in [("radio", "boxes"), ("checkbox", "boxes"), ("file", "file"), ("select", "select"),
                         ("select", "dropdown"), ("boolean", "yesno")]:
        assert not assist.needs_blur(kind, widget)


MARKERS = {
    "attr": ('<label for="a">A</label><input id="a" required>', True),
    "aria": ('<label for="a">A</label><input id="a" aria-required="true">', True),
    "class": ('<label for="a">A <span class="required">✱</span></label><input id="a">', True),
    "wrapper-class": ('<div class="required"><label for="a">A</label><input id="a"></div>', True),
    "data": ('<div data-required="true"><label for="a">A</label><input id="a"></div>', True),
    "label-star": ('<label for="a">A *</label><input id="a">', True),
    "legend-star": ('<fieldset><legend>A*</legend><input id="a"></fieldset>', True),
    "hashed-class": ('<label class="_heading_x1 _required_9f" for="a">A</label><input id="a">', True),
    "nothing": ('<label for="a">A</label><input id="a">', False),
    "optional-label": ('<label for="a">A (Optional) *</label><input id="a" required aria-required="true">', False),
    "optional-placeholder": ('<label for="a">A*</label><input id="a" required placeholder="optional">', False),
    "optional-helper": ('<label for="a">A*</label><input id="a" required><small>This is optional.</small>', False),
    "opt-visa": ('<label for="a">Are you on Optional Practical Training?*</label><input id="a" required>', True),
    "sibling-star": ('<fieldset><div><label for="b">B*</label><input id="b" required></div>'
                     '<div><label for="a">A</label><input id="a"></div></fieldset>', False),
}


def test_required_only_with_a_dom_marker_and_never_when_called_optional():
    async def go():
        got = {}
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            page = await browser.new_page()
            for name, (html, _) in MARKERS.items():
                await page.set_content(f'<form><div class="field-wrapper">{html}</div></form>')
                f = FormField(Question(label="A", required=False), "#a", "text")
                await BaseAdapter().refine_required(page, [f])
                got[name] = f.question.required
            await browser.close()
        return got
    assert run(go()) == {name: want for name, (_, want) in MARKERS.items()}


# ---- (a) optional unknowns are skipped without pausing ---------------------------------------- #

def test_optional_unknown_questions_are_left_blank_and_the_form_is_submitted(home, capsys):
    a = adapter(wait=120)                                  # attended: a pause here would wait two minutes

    async def drive(page, task):
        await page.wait_for_selector("#done:has-text('Thank you')", timeout=30000)
        return await page.locator("#ia-assist-badge").count()

    result, badges, clicks = run(apply(a, form(FIRST, EMAIL, ICE_CREAM, NICKNAME), home, drive=drive))
    assert (result.status, clicks, badges) == (SUBMITTED, 1, 0)
    for label in ("ice cream", "parking spot"):
        answer = by_label(result, label)
        assert (answer["action"], answer["status"], answer["required"]) == ("skip", SKIPPED_OPTIONAL, False)
    assert by_label(result, "First Name")["action"] == "fill"
    out = capsys.readouterr().out
    assert "SKIPPED_OPTIONAL: 2" in out and "ACTION REQUIRED" not in out
    assert not result.unknowns


def test_dry_run_reports_ready_with_optional_unknowns(home):
    result, _, clicks = run(apply(adapter(), form(FIRST, ICE_CREAM), home, dry_run=True))
    assert (result.status, clicks) == (DRY_RUN_OK, 0)


def test_unattended_required_unknown_goes_to_manual_review_without_waiting(home):
    result, _, clicks = run(apply(adapter(wait=0), form(FIRST, BADGE), home))
    assert (result.status, result.reason, clicks) == (MANUAL_REVIEW, "UNANSWERED_REQUIRED", 0)
    assert "badge number" in result.detail


# ---- (b) fill + blur resumes by itself ------------------------------------------------------- #

class Gate:
    """Records the steps the dashboard would show; no mailbox."""

    def __init__(self):
        self.steps = []

    def start(self, job):
        self.job = job

    async def snapshot(self, context):
        return "imap"

    def step(self, step, message="", **extra):
        self.steps.append(step)
        run_state.update(self.job, step, message, **extra)

    async def before_submit(self, context, step=run_state.SUBMITTING):
        self.step(step)


class Ledger:
    def has_company(self, company):
        return False


def test_typing_then_blur_submits_and_reaches_the_email_gate(home, monkeypatch):
    a = adapter_for(URL)
    gate = Gate()
    monkeypatch.setattr(a, "human_wait_s", 120, raising=False)
    monkeypatch.setattr(a, "write_essays", False, raising=False)
    monkeypatch.setattr(a, "receipt_gate", gate, raising=False)
    eng, seen = engine(), {}

    async def confirm(gate_, context, job, *, attended, timeout):          # the Gmail receipt gate
        seen["gate"] = (job["id"], attended, list(gate_.steps))
        return agent_runner.CONFIRMED, {"confirmed": True, "subject": "Thank you for applying to Acme Robotics"}

    async def go():
        async with async_playwright() as pw:
            browser, context = await browser_context(pw, form(FIRST, BADGE, ICE_CREAM, HAT))
            opened = asyncio.get_running_loop().create_future()
            context.on("page", lambda p: opened.done() or opened.set_result(p))
            task = asyncio.create_task(agent_runner.submit_and_confirm(
                context, JOB, eng, Ledger(), gate, use_llm=False, attended=True, confirm=confirm))
            page = await asyncio.wait_for(opened, 20)

            # the first unknown required field is outlined, badged and scrolled to
            await page.wait_for_selector("#ia-assist-badge", timeout=30000)
            seen["badge"] = await page.inner_text("#ia-assist-badge")
            seen["first"] = await page.evaluate(
                "() => { const w = document.querySelector('[data-ia-assist]');"
                " return [!!w.querySelector('#badge'), w.style.outline, !!w.querySelector('#ice')]; }")
            seen["dashboard"] = app_server.build_state()["waiting"]

            await page.fill("#badge", "4417")
            await asyncio.sleep(1.6)                       # typed but still focused: nothing may happen yet
            seen["while_focused"] = (task.done(), await page.evaluate("() => window.clicks"),
                                     await page.evaluate("() => !!document.querySelector('[data-ia-assist] #badge')"))
            await page.dispatch_event("#badge", "blur")

            # the highlight moves to the next unknown required question by itself
            await page.wait_for_selector("fieldset#hat[data-ia-assist]", timeout=10000)
            seen["moved"] = await page.evaluate("() => document.querySelectorAll('[data-ia-assist]').length")
            await page.check("#hatM")

            result, outcome, receipt = await asyncio.wait_for(task, 60)
            seen["after"] = (await page.evaluate("() => window.clicks") if not page.is_closed() else "closed")
            await browser.close()
            return result, outcome, receipt

    result, outcome, receipt = run(go())
    assert seen["badge"] == assist.BADGE_TEXT
    in_badge_field, outline, holds_other_field = seen["first"]
    assert in_badge_field and not holds_other_field
    assert "3px" in outline and "solid" in outline and "168, 85, 247" in outline          # #a855f7
    assert seen["dashboard"]["field"].startswith("Initech badge number") and seen["dashboard"]["remaining"] == 2
    assert seen["while_focused"] == (False, 0, True)
    assert seen["moved"] == 1
    assert (result.status, outcome) == (SUBMITTED, agent_runner.CONFIRMED)
    assert receipt["subject"].startswith("Thank you for applying")
    job_id, attended, steps = seen["gate"]
    assert job_id == "acme-1" and attended
    assert steps.index(run_state.WAITING_FOR_ANSWER) < steps.index(run_state.SUBMITTING)
    assert by_label(result, "ice cream")["status"] == SKIPPED_OPTIONAL

    # both answers are remembered, and the same question is now answered without a pause
    learned = {e["learned_from"] for e in load_custom_answers()}
    assert learned == {"Acme Robotics"} and len(load_custom_answers()) == 2
    for fresh in (eng, AnswerEngine(PROFILE)):
        d = fresh.resolve(Question(label="Initech badge number", kind="text", required=True), Context(company="Other Co"))
        assert (d.action, d.value) == ("fill", "4417")
        d = fresh.resolve(Question(label="Initech hat size", kind="radio", required=True, options=["S", "M", "L"]),
                          Context(company="Other Co"))
        assert (d.action, d.value) == ("fill", "M")


def test_learned_answer_fills_the_next_form_without_a_pause(home):
    config.CUSTOM_ANSWERS_JSON.write_text(json.dumps(
        [{"pattern": "^initech badge number$", "answer": "4417", "learned_from": "Acme Robotics"}]))
    result, _, clicks = run(apply(adapter(wait=120), form(FIRST, BADGE), home, eng=AnswerEngine(PROFILE)))
    assert (result.status, clicks) == (SUBMITTED, 1)
    assert by_label(result, "badge number")["value"] == "4417"


# ---- post-submit safety net: required, but only the error says so --------------------------- #

def test_field_flagged_only_after_submit_is_highlighted_then_resubmitted(home):
    a = adapter(wait=120)

    async def drive(page, task):
        await page.wait_for_selector("#ia-assist-badge", timeout=30000)
        first_clicks = await page.evaluate("() => window.clicks")
        target = await page.evaluate("() => [!!document.querySelector('[data-ia-assist] #locker'),"
                                     " !!document.querySelector('[data-ia-assist] #ice')]")
        await page.fill("#locker", "12-34-56")
        await page.dispatch_event("#locker", "blur")
        return first_clicks, target

    result, (first_clicks, target), clicks = run(apply(a, form(FIRST, ICE_CREAM, LOCKER, must=["locker"]), home,
                                                       drive=drive))
    assert first_clicks == 1 and target == [True, False]   # only the flagged field, not the other blank one
    assert (result.status, clicks) == (SUBMITTED, 2)
    assert by_label(result, "ice cream")["status"] == SKIPPED_OPTIONAL
    assert [e["answer"] for e in load_custom_answers()] == ["12-34-56"]


def test_unattended_validation_error_still_goes_to_manual_review(home):
    result, _, clicks = run(apply(adapter(wait=0), form(FIRST, LOCKER, must=["locker"]), home))
    assert (result.status, result.reason, clicks) == (MANUAL_REVIEW, "VALIDATION_ERROR", 1)


# ---- Mission Control ------------------------------------------------------------------------ #

def test_dashboard_shows_the_waiting_field_only_while_waiting(home):
    run_state.update(JOB, run_state.WAITING_FOR_ANSWER, "Waiting for your answer: Badge",
                     waiting={"field": "Badge", "remaining": 1, "of": 2})
    assert app_server.build_state()["waiting"] == {"field": "Badge", "remaining": 1, "of": 2}
    run_state.update(JOB, run_state.SUBMITTING, "Submitting the form")
    assert app_server.build_state()["waiting"] is None


# ---- the same hand-over on the other portals' field shapes ------------------------------------- #

ASHBY = """<div class="ashby-application-form-field-entry"><label class="_heading_a _required_b" for="q1">Initech badge number</label>
<input id="q1"></div>
<div class="ashby-application-form-field-entry"><label class="_heading_a" for="q2">Initech parking spot color</label>
<input id="q2"></div>"""
LEVER = """<div class="application-question"><div class="application-label"><div class="text">Initech badge number
<span class="required">✱</span></div></div><input name="q1" id="q1"></div>
<div class="application-question"><div class="application-label"><div class="text">Initech parking spot color (optional)
<span class="required">✱</span></div></div><input name="q2" id="q2" required></div>"""
WORKDAY = """<div data-automation-id="formField-badge"><label for="q1">Initech badge number*</label>
<input id="q1" aria-required="true"></div>
<div data-automation-id="formField-spot"><label for="q2">Initech parking spot color</label><input id="q2"></div>"""


@pytest.mark.parametrize("url, html", [
    ("https://jobs.ashbyhq.com/acme/0b2f7f0e-1111-2222-3333-444455556666", ASHBY),
    ("https://jobs.lever.co/acme/0b2f7f0e-1111-2222-3333-444455556666", LEVER),
    ("https://acme.wd5.myworkdayjobs.com/External/job/Austin/SWE-Intern_R1", WORKDAY),
])
def test_other_portals_skip_the_optional_field_and_resume_on_blur(home, url, html):
    a = type(adapter_for(url))()
    a.human_wait_s = 120

    async def go():
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            page = await browser.new_page()
            await page.set_content(f"<form>{html}</form>")
            fields = await a.extract(page)
            await a.refine_required(page, fields)
            decisions = {f.question.label: engine().resolve(f.question, Context(company="Acme")).action for f in fields}
            unknown = [f for f in fields if decisions[f.question.label] == "unknown"]
            task = asyncio.create_task(a.wait_for_answers(page, unknown, JOB, engine()))
            await page.wait_for_selector("#ia-assist-badge")
            await page.fill("#q1", "4417")
            await asyncio.sleep(1.3)
            early = task.done()
            await page.dispatch_event("#q1", "blur")
            outcome = await asyncio.wait_for(task, 20)
            left = await page.locator("[data-ia-assist], #ia-assist-badge").count()
            await browser.close()
            return decisions, early, outcome, left

    decisions, early, outcome, left = run(go())
    assert sorted(decisions.values()) == ["skip", "unknown"]
    assert decisions[next(k for k in decisions if "badge" in k)] == "unknown"
    assert (early, outcome, left) == (False, "filled", 0)
    assert [e["answer"] for e in load_custom_answers()] == ["4417"]
