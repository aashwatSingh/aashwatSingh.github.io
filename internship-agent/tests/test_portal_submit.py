"""Ashby, Lever and Workday end to end in headless Chromium, on pages shaped like each portal:
optional unknowns skipped, required unknowns handed over and resumed on blur, a validation error
after Submit / Next recovered, then straight into the confirmation e-mail gate."""
import asyncio
import json

import pytest
from playwright.async_api import async_playwright

import agent_runner
import answers
import config
import run_state
from answers import AnswerEngine, Context, Question, load_custom_answers, remember_answers, save_custom_answers
from ats import adapter_for
from ats.ashby import AshbyAdapter
from ats.base import DRY_RUN_OK, MANUAL_REVIEW, SKIPPED_OPTIONAL, SUBMITTED
from tests.test_assist import PROFILE, Gate, Ledger, by_label, engine, home, run        # noqa: F401 - fixture

UUID = "0b2f7f0e-1111-2222-3333-444455556666"
POSTING = "Software Engineering Intern, Summer 2027. Acme Robotics builds warehouse robots in Austin."

# Server-side check shared by the mock forms: `locker` carries no required marker, yet Submit / Next
# is refused while it is empty.
CHECK_JS = """
window.clicks = 0;
const need = id => { const e = document.getElementById(id); return e && !e.value; };
"""

ASHBY_URL = f"https://jobs.ashbyhq.com/acme/{UUID}"
ASHBY_HTML = f"""<html><body><div id="form">
<ul class="_errors_k2" id="errors" hidden></ul>
<div class="ashby-application-form-field-entry"><label class="_heading_a _required_b" for="_systemfield_name">Name</label>
  <input id="_systemfield_name"></div>
<div class="ashby-application-form-field-entry"><label class="_heading_a _required_b" for="badge">Initech badge number</label>
  <input id="badge"></div>
<div class="ashby-application-form-field-entry"><label class="_heading_a" for="spot">Initech parking spot color</label>
  <input id="spot"></div>
<div class="ashby-application-form-field-entry"><label class="_heading_a" for="locker">Initech locker combination</label>
  <input id="locker"></div>
<button class="ashby-application-form-submit-button">Submit Application</button></div>
<script>{CHECK_JS}
document.querySelector('button').addEventListener('click', () => {{
  window.clicks++;
  const errors = document.getElementById('errors');
  if (need('locker')) {{          // Ashby lists problems above the form, not on the field
    errors.innerHTML = '<li>Missing entry for required field: Initech locker combination</li>'; errors.hidden = false;
    return;
  }}
  document.getElementById('form').outerHTML =
    '<div class="ashby-application-form-success-container">Your application was successfully submitted.</div>';
}});
</script></body></html>"""

LEVER_URL = f"https://jobs.lever.co/acme/{UUID}"


def lever_question(label, field, *, star=False):
    mark = '<span class="required">✱</span>' if star else ""
    return (f'<div class="application-question"><div class="application-label"><div class="text">{label}{mark}</div>'
            f'</div><input name="{field}" id="{field}"></div>')


LEVER_HTML = f"""<html><body><form id="application-form" onsubmit="return false">
{lever_question("Full name", "name", star=True)}
{lever_question("Initech badge number", "badge", star=True)}
{lever_question("Initech parking spot color (optional)", "spot", star=True)}
{lever_question("Initech locker combination", "locker")}
<button id="btn-submit" type="button">Submit application</button></form>
<script>{CHECK_JS}
document.getElementById('btn-submit').addEventListener('click', () => {{
  window.clicks++;
  document.querySelectorAll('.error-message').forEach(e => e.remove());
  if (need('locker')) {{
    const e = document.createElement('div'); e.className = 'error-message'; e.textContent = 'This field is required';
    document.getElementById('locker').after(e);
    return;
  }}
  sessionStorage.setItem('clicks', window.clicks);
  location.href = '{LEVER_URL}/thanks';
}});
</script></body></html>"""
LEVER_THANKS = "<html><body><h1>Application submitted!</h1><script>window.clicks = +sessionStorage.getItem('clicks');</script></body></html>"

WORKDAY_URL = "https://acme.wd5.myworkdayjobs.com/External/job/Austin/SWE-Intern_R1"


def workday_field(fid, label, *, star=False, control=None):
    attrs = ' aria-required="true"' if star else ""
    control = control or f'<input id="{fid}"{attrs}>'
    return (f'<div data-automation-id="formField-{fid}"><label for="{fid}">{label}{"*" if star else ""}</label>'
            f'{control}</div>')


WORKDAY_PAGES = [
    ("My Information", workday_field("firstName", "First Name", star=True)
     + workday_field("badge", "Initech badge number", star=True)
     + workday_field("spot", "Initech parking spot color")),
    ("Application Questions", workday_field("locker", "Initech locker combination")
     + workday_field("mascot", "Initech mascot name (optional)", star=True)),
    ("Review", "<p>First Name, badge and locker as entered above.</p>"),
]
# `review_error`: a banner on the Review page, which must stop the automatic Submit.
WORKDAY_HTML = """<html><body>
<div id="posting"><h2 data-automation-id="jobPostingHeader">SWE Intern</h2>
<div data-automation-id="jobPostingDescription">%(posting)s</div>
<button data-automation-id="adventureButton">Apply</button></div>
<div id="wizard" hidden><div data-automation-id="progressBarActiveStep"></div><div id="body"></div>
<button data-automation-id="bottom-navigation-next-button"></button></div>
<div id="end"></div>
<script>%(check)s
const PAGES = %(pages)s, REVIEW_ERROR = %(review_error)s;
let at = 0; window.submits = 0; window.values = {};
const show = () => {
  document.querySelector('[data-automation-id=progressBarActiveStep]').textContent =
    `current step ${at + 1} of ${PAGES.length} ${PAGES[at][0]}`;
  document.getElementById('body').innerHTML = PAGES[at][1] +
    (at === PAGES.length - 1 && REVIEW_ERROR ? '<div role="alert">Errors found: fix My Information</div>' : '');
  document.querySelector('[data-automation-id=bottom-navigation-next-button]').textContent =
    at === PAGES.length - 1 ? 'Submit' : 'Save and Continue';
};
document.querySelector('[data-automation-id=adventureButton]').addEventListener('click', () => {
  document.getElementById('posting').hidden = true; document.getElementById('wizard').hidden = false; show();
});
document.querySelector('[data-automation-id=bottom-navigation-next-button]').addEventListener('click', () => {
  window.clicks++;
  document.querySelectorAll('[data-automation-id=inputAlert]').forEach(e => e.remove());
  if (at === PAGES.length - 1) {
    window.submits++;
    document.getElementById('wizard').remove();
    document.getElementById('end').textContent = 'Your application has been submitted.';
    return;
  }
  if (need('locker')) {
    const e = document.createElement('div'); e.setAttribute('data-automation-id', 'inputAlert');
    e.textContent = 'Error: The field Initech locker combination is required and must have a value.';
    document.getElementById('locker').after(e);
    return;
  }
  document.querySelectorAll('#body input').forEach(i => window.values[i.id] = i.value);
  at++; show();
});
</script></body></html>"""


def workday_html(review_error=False):
    return WORKDAY_HTML % {"posting": POSTING, "check": CHECK_JS, "pages": json.dumps(WORKDAY_PAGES),
                           "review_error": json.dumps(review_error)}


PORTALS = {
    "Ashby": (ASHBY_URL, {ASHBY_URL + "/application": ASHBY_HTML}),
    "Lever": (LEVER_URL, {LEVER_URL + "/apply": LEVER_HTML, LEVER_URL + "/thanks": LEVER_THANKS}),
    "Workday": (WORKDAY_URL, {WORKDAY_URL: workday_html()}),
}


@pytest.fixture
def portals(monkeypatch):
    """No network: the posting text the adapters fetch from each portal's public API."""
    monkeypatch.setattr(AshbyAdapter, "_boards", {"acme": {"jobs": [{"id": UUID, "title": "SWE Intern",
                                                                      "descriptionPlain": POSTING}]}})
    monkeypatch.setattr("ats.lever.fetch_json", lambda url: {"text": "SWE Intern", "descriptionPlain": POSTING})


def job_for(name, url):
    return {"id": f"acme-{name.lower()}", "company": "Acme Robotics", "title": "SWE Intern", "ats": name, "url": url,
            "locations": ["Austin, TX"]}


async def open_context(pw, pages):
    browser = await pw.chromium.launch()
    context = await browser.new_context()

    async def serve(route):
        body = pages.get(route.request.url.split("?")[0])
        if body is None:
            await route.abort()
        else:
            await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=body)
    await context.route("**/*", serve)
    return browser, context


def prepared(monkeypatch, url, gate, wait=120):
    a = adapter_for(url)
    monkeypatch.setattr(a, "human_wait_s", wait, raising=False)
    monkeypatch.setattr(a, "write_essays", False, raising=False)
    monkeypatch.setattr(a, "receipt_gate", gate, raising=False)
    return a


async def answer(page, field, value):
    """What the candidate does: type into the highlighted field, then click away."""
    await page.wait_for_selector(f"[data-ia-assist] #{field}", timeout=45000)
    clicks = await page.evaluate("() => window.clicks")
    await page.fill(f"#{field}", value)
    await asyncio.sleep(1.2)
    still = await page.evaluate("() => window.clicks")
    await page.dispatch_event(f"#{field}", "blur")
    return clicks, still


@pytest.mark.parametrize("name", list(PORTALS))
def test_portal_runs_hands_free_into_the_email_gate(name, home, portals, monkeypatch):
    url, pages = PORTALS[name]
    job, gate, eng, seen = job_for(name, url), Gate(), engine(), {}
    prepared(monkeypatch, url, gate)

    async def confirm(gate_, context, job_, *, attended, timeout):          # stands in for the Gmail receipt gate
        page = context.pages[-1]
        seen["gate"] = {"steps": list(gate_.steps), "clicks": await page.evaluate("() => window.clicks"),
                        "submits": await page.evaluate("() => window.submits"),
                        "values": await page.evaluate("() => window.values")}
        return agent_runner.CONFIRMED, {"confirmed": True, "subject": "Thank you for applying to Acme Robotics"}

    async def go():
        async with async_playwright() as pw:
            browser, context = await open_context(pw, pages)
            opened = asyncio.get_running_loop().create_future()
            context.on("page", lambda p: opened.done() or opened.set_result(p))
            task = asyncio.create_task(agent_runner.submit_and_confirm(
                context, job, eng, Ledger(), gate, use_llm=False, attended=True, confirm=confirm))
            page = await asyncio.wait_for(opened, 20)
            seen["badge"] = await answer(page, "badge", "4417")           # marked required, not in the profile
            seen["locker"] = await answer(page, "locker", "12-34-56")     # required only by the error after the click
            try:
                return await asyncio.wait_for(task, 120)
            finally:
                await browser.close()

    result, outcome, receipt = run(go())
    assert (result.status, outcome) == (SUBMITTED, agent_runner.CONFIRMED), (result.reason, result.detail)

    # nothing was clicked while a required answer was missing or still being typed
    assert seen["badge"] == (0, 0)
    refused = 2 if name == "Workday" else 1                 # Workday: page 1's Next, then the refused Next
    assert seen["locker"] == (refused, refused)             # the refused click showed the error; none since
    steps = seen["gate"]["steps"]
    assert steps.index(run_state.WAITING_FOR_ANSWER) < steps.index(run_state.SUBMITTING)
    assert steps[-1] == run_state.SUBMITTING                # the gate follows the final click directly

    # optional unknowns were left blank on every page; the marked-required "(optional)" one too
    skipped = {a["label"] for a in result.answers if a.get("status") == SKIPPED_OPTIONAL}
    assert any("parking spot" in label for label in skipped)
    assert not any("badge" in label for label in skipped)
    if name == "Workday":
        assert any("mascot" in label for label in skipped)
        # page 1 Next, refused Next on page 2, accepted Next, then exactly one Submit on Review
        assert (seen["gate"]["clicks"], seen["gate"]["submits"]) == (4, 1)
        assert seen["gate"]["values"] == {"firstName": "Jordan", "badge": "4417", "spot": "",
                                          "locker": "12-34-56", "mascot": ""}
    else:
        assert seen["gate"]["clicks"] == 2

    # both hand-typed answers were learned and now answer the same questions unaided
    assert sorted(e["answer"] for e in load_custom_answers()) == ["12-34-56", "4417"]
    fresh = AnswerEngine(PROFILE)
    for label, value in (("Initech badge number", "4417"), ("Initech locker combination", "12-34-56")):
        d = fresh.resolve(Question(label=label, kind="text", required=True), Context(company="Other Co"))
        assert (d.action, d.value) == ("fill", value)


# ---- Workday's Review page -------------------------------------------------------------------- #

async def workday_apply(html, home, *, dry_run=False, wait=0, known=True):
    a = type(adapter_for(WORKDAY_URL))()
    a.human_wait_s, a.write_essays = wait, False
    gate = Gate()
    gate.start(job_for("Workday", WORKDAY_URL))
    a.receipt_gate = gate
    custom = [{"pattern": "^initech badge number$", "answer": "4417"},
              {"pattern": "^initech locker combination$", "answer": "12-34-56"}] if known else []
    async with async_playwright() as pw:
        browser, context = await open_context(pw, {WORKDAY_URL: html})
        page = await context.new_page()
        try:
            result = await asyncio.wait_for(a.apply(
                page, job_for("Workday", WORKDAY_URL), AnswerEngine(PROFILE, custom_answers=custom),
                Context(company="Acme Robotics", title="SWE Intern"), dry_run=dry_run, shot_path=str(home / "s.png")), 120)
            return result, gate.steps, await page.evaluate("() => [window.clicks, window.submits]")
        finally:
            await browser.close()


def test_workday_unattended_live_run_submits_from_review(home):
    result, steps, (clicks, submits) = run(workday_apply(workday_html(), home))
    assert (result.status, result.reason) == (SUBMITTED, "submitted from the Review page")
    assert (clicks, submits) == (3, 1)
    assert steps == [run_state.SUBMITTING]                  # inbox snapshot taken right before the Submit click


def test_workday_dry_run_stops_at_review_without_clicking_submit(home):
    result, steps, (clicks, submits) = run(workday_apply(workday_html(), home, dry_run=True))
    assert result.status == DRY_RUN_OK and "Review" in result.reason
    assert (clicks, submits, steps) == (2, 0, [])


def test_workday_error_banner_on_review_blocks_the_automatic_submit(home):
    result, steps, (clicks, submits) = run(workday_apply(workday_html(review_error=True), home))
    assert (result.status, result.reason) == (MANUAL_REVIEW, "WORKDAY_REVIEW_ERRORS")
    assert "Errors found" in result.detail
    assert (clicks, submits, steps) == (2, 0, [])


# ---- learned answers survive ------------------------------------------------------------------- #

def test_learned_answers_are_never_tracked_by_git():
    import subprocess
    root = config.Path(__file__).resolve().parents[1]
    names = ["custom_answers.json", "custom_answers.backup.json"]
    ignored = subprocess.run(["git", "check-ignore", *names], cwd=root, capture_output=True, text=True).stdout.split()
    tracked = subprocess.run(["git", "ls-files", *names], cwd=root, capture_output=True, text=True).stdout.split()
    assert ignored == names and tracked == []               # so `git pull` can neither overwrite nor conflict


def test_learned_answers_are_backed_up_and_recovered(home):
    main, backup = config.CUSTOM_ANSWERS_JSON, answers.backup_path(config.CUSTOM_ANSWERS_JSON)
    assert remember_answers([{"label": "Initech badge number", "kind": "text", "value": "4417"}], "Acme") == 1
    assert remember_answers([{"label": "Initech hat size", "kind": "radio", "value": "M"}], "Acme") == 1
    assert json.loads(main.read_text()) == json.loads(backup.read_text()) and len(load_custom_answers()) == 2

    main.write_text('[{"pattern": "^trunc')                 # damaged
    assert [e["answer"] for e in load_custom_answers()] == ["4417", "M"]
    main.unlink()                                           # lost
    assert len(load_custom_answers()) == 2
    remember_answers([{"label": "Initech locker combination", "kind": "text", "value": "12-34-56"}], "Acme")
    assert [e["answer"] for e in json.loads(main.read_text())] == ["4417", "M", "12-34-56"]   # nothing dropped

    save_custom_answers([], main)
    assert load_custom_answers() == []
