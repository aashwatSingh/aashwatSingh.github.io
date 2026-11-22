"""Lever: the resume-parse race, the location widget, the hCaptcha script wait, and the citizenship answer.
Mock page reproduces what the live Zoox form does: Lever fetches location suggestions on key events (not on
fill), clears typed-but-unpicked text on blur, and its parser writes the fields some seconds after upload."""
import asyncio
import json
import time

import pytest
from playwright.async_api import async_playwright

import phone_notify
from answers import AnswerEngine, Context, Question
from ats import lever
from ats.base import DRY_RUN_OK, MANUAL_REVIEW, SUBMITTED
from ats.lever import LeverAdapter
from tests.test_assist import PROFILE, home, run                          # noqa: F401 - fixture
from tests.test_phone_notify import FakeDiscord, TOKEN, CHANNEL, USER      # noqa: F401
from tests.test_portal_submit import portals                               # noqa: F401 - patches the posting text fetch

UUID = "0b2f7f0e-1111-2222-3333-444455556666"
BASE = f"https://jobs.lever.co/acme/{UUID}"
JOB = {"id": "acme-lever", "company": "Acme", "title": "SWE Intern", "ats": "Lever", "url": BASE + "/apply",
       "locations": ["Frisco, TX"]}

FRISCO = json.loads(json.dumps(PROFILE))
FRISCO["address"].update(city="Frisco", state="Texas", state_abbr="TX")
FRISCO["links"]["linkedin"] = "https://www.linkedin.com/in/jordan-rivera"


def q(label, name, *, star=False, kind="text"):
    mark = '<span class="required">✱</span>' if star else ""
    return (f'<div class="application-question"><div class="application-label"><div class="text">{label}{mark}</div></div>'
            f'<input name="{name}"></div>')


APPLY = f"""<html><body><form id="application-form" onsubmit="return false">
<div class="application-question"><div class="application-label"><div class="text">Resume/CV<span class="required">✱</span></div></div>
  <input type="file" name="resume" id="resume"></div>
{q("Full name", "name", star=True)}{q("Email", "email", star=True)}{q("Phone", "phone", star=True)}
<div class="application-question"><div class="application-label"><div class="text">Current location</div></div>
  <div class="application-field"><input name="location" id="location-input" class="location-input" autocomplete="off">
  <input type="hidden" name="selectedLocation" value="">
  <div class="dropdown-container" hidden><div class="dropdown-results"></div></div></div></div>
{q("Current company", "org")}{q("LinkedIn URL", "urls[LinkedIn]")}
<div id="h-captcha" class="h-captcha" data-sitekey="x"></div>
<button id="btn-submit" type="button">Submit application</button></form>
<script>
const $ = n => document.querySelector(`[name="${{n}}"]`);
const box = document.querySelector('.dropdown-container'), results = document.querySelector('.dropdown-results');
window.searches = 0;
document.getElementById('resume').addEventListener('change', async () => {{
  const r = await fetch('/parseResume', {{method: 'POST'}});
  if (!r.ok) return;
  const d = await r.json();
  $('name').value = 'Parsed Name'; $('email').value = 'parsed@example.com'; $('phone').value = '5550100199';
  $('org').value = 'Outamation'; $('urls[LinkedIn]').value = 'http://linkedin.com/in/parsed';
  $('location').value = d.location; $('selectedLocation').value = JSON.stringify({{name: d.location, id: 'p1'}});
}});
const loc = $('location');
loc.addEventListener('keyup', async () => {{                         // suggestions come from key events only
  window.searches++;
  const r = await fetch('/searchLocations?text=' + encodeURIComponent(loc.value));
  const items = await r.json();
  results.innerHTML = items.map(t => `<div class="break-word dropdown-location width-full py1 px2">${{t}}</div>`).join('');
  box.hidden = !items.length;
}});
results.addEventListener('mousedown', e => e.preventDefault());
results.addEventListener('click', e => {{
  const t = e.target.closest('.dropdown-location'); if (!t) return;
  loc.value = t.textContent; $('selectedLocation').value = JSON.stringify({{name: t.textContent, id: 'x1'}}); box.hidden = true;
}});
loc.addEventListener('blur', () => setTimeout(() => {{             // Lever discards text that was not picked
  if (!$('selectedLocation').value) loc.value = '';
}}, 50));
document.getElementById('btn-submit').addEventListener('click', () => {{
  sessionStorage.setItem('clicks', (+sessionStorage.getItem('clicks') || 0) + 1);
  location.href = '{BASE}/thanks';
}});
</script></body></html>"""
HCAPTCHA_LATE = "<script>setTimeout(() => { window.hcaptcha = {}; }, %d);</script>"
THANKS = "<html><body>Application submitted. clicks=<span id=c></span><script>c.textContent = sessionStorage.getItem('clicks') || 0</script></body></html>"


class Mock:
    def __init__(self, *, parse_delay=0.3, parse_status=200, parse_location="Frisco, TX, USA", suggestions=None,
                 html=APPLY):
        self.parse_delay, self.parse_status, self.parse_location = parse_delay, parse_status, parse_location
        self.suggestions = ["Frisco, CO, USA", "Frisco, TX, USA"] if suggestions is None else suggestions
        self.html, self.calls = html, {"parse": 0, "search": 0}

    async def handle(self, route):
        url = route.request.url
        if url.endswith("/parseResume"):
            self.calls["parse"] += 1
            await asyncio.sleep(self.parse_delay)
            await route.fulfill(status=self.parse_status, content_type="application/json",
                                body=json.dumps({"location": self.parse_location}))
        elif "/searchLocations" in url:
            self.calls["search"] += 1
            await route.fulfill(status=200, content_type="application/json", body=json.dumps(self.suggestions))
        elif url.split("?")[0] == BASE + "/apply":
            await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=self.html)
        elif url.split("?")[0] == BASE + "/thanks":
            await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=THANKS)
        else:
            await route.abort()


VALUES = """() => Object.fromEntries(['name', 'email', 'phone', 'org', 'location', 'urls[LinkedIn]'].map(n =>
  [n, document.querySelector(`[name="${n}"]`).value]).concat([['selected', (document.querySelector('[name=selectedLocation]').value
  ? JSON.parse(document.querySelector('[name=selectedLocation]').value).name : '')], ['searches', window.searches]]))"""


@pytest.fixture
def adapter(monkeypatch):
    a = LeverAdapter()
    a.human_wait_s, a.write_essays = 0, False
    monkeypatch.setattr(lever, "PARSE_SETTLE_S", 0.4)
    return a


def dry_run(adapter, mock, home, *, after=None):
    async def go():
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            context = await browser.new_context()
            await context.route("**/*", mock.handle)
            page = await context.new_page()
            t = time.monotonic()
            resume = home / "resume.pdf"
            resume.write_bytes(b"%PDF-1.4 test resume")
            profile = json.loads(json.dumps(FRISCO))
            profile["resume_path"] = str(resume)
            try:
                result = await asyncio.wait_for(adapter.apply(
                    page, JOB, AnswerEngine(profile, custom_answers=[]), Context(company="Acme", title="SWE Intern"),
                    dry_run=True, shot_path=str(home / "s.png")), 90)
                took = time.monotonic() - t
                if after:
                    await after(page)
                return result, await page.evaluate(VALUES), took
            finally:
                await browser.close()
    return run(go())


def answer_for(result, label):
    return next(a for a in result.answers if a["label"].startswith(label))


# ---- 3. the resume parse ---------------------------------------------------------------------------- #

def test_a_parse_slower_than_the_old_fixed_4s_wait_cannot_overwrite_the_filled_fields(adapter, home, portals):
    mock = Mock(parse_delay=5.5, parse_location="Dallas, TX, USA")
    result, v, took = dry_run(adapter, mock, home)
    assert result.status == DRY_RUN_OK and took >= 5.5                          # it waited for the parse
    assert (v["name"], v["email"], v["phone"]) == ("Jordan Rivera", "jordan@example.com", "(555) 010-0199")
    assert v["urls[LinkedIn]"] == "https://www.linkedin.com/in/jordan-rivera"
    assert v["org"] == ""                                                       # "Current company" stays cleared


def test_a_parse_error_is_a_warning_and_the_form_is_still_filled(adapter, home, portals, capsys):
    result, v, _ = dry_run(adapter, Mock(parse_status=500), home)
    out = capsys.readouterr().out
    assert result.status == DRY_RUN_OK and "/parseResume failed (500)" in out
    assert (v["name"], v["phone"]) == ("Jordan Rivera", "(555) 010-0199") and v["selected"] == "Frisco, TX, USA"


def test_a_parse_that_times_out_is_warned_about_and_its_late_result_is_corrected(adapter, home, portals, capsys, monkeypatch):
    monkeypatch.setattr(lever, "PARSE_CAP_S", 1.0)
    monkeypatch.setattr(lever, "PARSE_LATE_S", 8.0)
    result, v, took = dry_run(adapter, Mock(parse_delay=3.0, parse_location="Dallas, TX, USA"), home)
    out = capsys.readouterr().out
    assert "did not answer within 1s" in out and "re-applied after the resume parse" in out
    assert result.status == DRY_RUN_OK
    assert (v["name"], v["email"], v["phone"], v["org"]) == ("Jordan Rivera", "jordan@example.com", "(555) 010-0199", "")
    assert v["urls[LinkedIn]"] == "https://www.linkedin.com/in/jordan-rivera"
    assert (v["location"], v["selected"]) == ("Frisco, TX, USA", "Frisco, TX, USA")      # the late Dallas was replaced


def test_no_parse_request_at_all_is_a_warning_not_a_hang(adapter, home, portals, capsys):
    html = APPLY.replace("const r = await fetch('/parseResume', {method: 'POST'});\n  if (!r.ok) return;\n  const d = await r.json();",
                         "return;")
    assert html != APPLY
    result, v, took = dry_run(adapter, Mock(html=html), home)
    assert result.status == DRY_RUN_OK and "no /parseResume request was seen" in capsys.readouterr().out and took < 15
    assert v["name"] == "Jordan Rivera"


# ---- 2. the location widget --------------------------------------------------------------------------- #

def test_a_parsed_location_that_is_the_profiles_city_and_state_is_kept_without_typing(adapter, home, portals):
    result, v, _ = dry_run(adapter, Mock(parse_location="Frisco, TX, USA"), home)
    assert (v["location"], v["selected"], v["searches"]) == ("Frisco, TX, USA", "Frisco, TX, USA", 0)


@pytest.mark.parametrize("parsed", ["Dallas, TX, USA", "Frisco, CO, USA"])           # another city, or another state
def test_any_other_parsed_location_is_cleared_and_the_matching_suggestion_picked(adapter, home, portals, parsed):
    mock = Mock(parse_location=parsed)
    result, v, _ = dry_run(adapter, mock, home)
    assert (v["location"], v["selected"]) == ("Frisco, TX, USA", "Frisco, TX, USA")  # not the CO suggestion listed first
    assert v["searches"] >= 1 and mock.calls["search"] >= 1                           # it really typed
    assert answer_for(result, "Current location")["action"] == "fill"


def test_with_no_matching_suggestion_the_field_is_left_empty_and_is_not_reported_as_filled(adapter, home, portals,
                                                                                         monkeypatch):
    monkeypatch.setattr(lever, "LOCATION_SUGGESTIONS_S", 1.5)
    result, v, _ = dry_run(adapter, Mock(parse_location="Dallas, TX, USA", suggestions=["Frisco, CO, USA"]), home)
    assert (v["location"], v["selected"]) == ("", "")
    a = answer_for(result, "Current location")
    assert a["action"] == "skip" and "no suggestion matching Frisco" in a["note"]     # optional: skipped, never "filled"
    assert result.status == DRY_RUN_OK


def test_place_matching_needs_the_city_first_and_the_state():
    assert lever.place_matches("Frisco, TX, USA", "Frisco", {"TX", "Texas"})
    assert lever.place_matches("Frisco, Texas, United States", "Frisco", {"TX", "Texas"})
    assert not lever.place_matches("Frisco, CO, USA", "Frisco", {"TX", "Texas"})
    assert not lever.place_matches("Dallas, TX, USA", "Frisco", {"TX", "Texas"})
    assert not lever.place_matches("New Frisco, TX, USA", "Frisco", {"TX", "Texas"})


# ---- 4. the hCaptcha script -------------------------------------------------------------------------------- #

def submit_page(extra_script=""):
    return APPLY.replace("</body>", extra_script + "</body>")


def run_submit(adapter, mock, *, fixture_phone=None):
    async def go():
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            context = await browser.new_context()
            await context.route("**/*", mock.handle)
            page = await context.new_page()
            await page.goto(BASE + "/apply")
            try:
                out = await asyncio.wait_for(adapter.submit(page), 60)
                clicks = await page.evaluate("sessionStorage.getItem('clicks')")
                return out, clicks
            finally:
                await browser.close()
    return run(go())


@pytest.fixture
def quick(monkeypatch):
    monkeypatch.setattr(lever, "HCAPTCHA_LOAD_RETRY_S", 1.0)
    monkeypatch.setattr(lever, "HCAPTCHA_MIN_WAIT_S", 8)
    monkeypatch.setattr(phone_notify, "MIN_POLL_S", 0.05)
    phone_notify.use(None)
    yield
    phone_notify.use(None)


def test_unattended_with_no_hcaptcha_script_goes_to_manual_review_after_the_retry(adapter, home, quick):
    t = time.monotonic()
    (status, reason, detail), clicks = run_submit(adapter, Mock(html=APPLY))
    assert (status, reason) == (MANUAL_REVIEW, "CAPTCHA") and "did not load" in detail and clicks is None
    assert time.monotonic() - t < 15


def test_a_script_that_is_only_slow_is_waited_for_and_then_submit_is_pressed_once(adapter, home, quick):
    adapter.human_wait_s = 30
    (status, reason, detail), clicks = run_submit(adapter, Mock(html=submit_page(HCAPTCHA_LATE % 0)))
    assert (status, clicks) == (SUBMITTED, "1")
    adapter2 = LeverAdapter()
    adapter2.human_wait_s = 30
    (status, reason, detail), clicks = run_submit(adapter2, Mock(html=submit_page(HCAPTCHA_LATE % 3000)))     # after the retry
    assert (status, clicks) == (SUBMITTED, "1")


def test_attended_rings_the_bell_and_resumes_when_the_script_finally_loads(adapter, home, quick, capsys):
    adapter.human_wait_s = 30
    (status, _, _), clicks = run_submit(adapter, Mock(html=submit_page(HCAPTCHA_LATE % 4000)))
    out = capsys.readouterr().out
    assert "\a[ACTION REQUIRED]" in out and "js.hcaptcha.com" in out and "hCaptcha loaded: continuing" in out
    assert (status, clicks) == (SUBMITTED, "1")


def test_attended_and_you_submit_yourself_in_the_browser(adapter, home, quick, capsys):
    adapter.human_wait_s = 30
    manual = f"<script>setTimeout(() => {{ location.href = '{BASE}/thanks'; }}, 3500);</script>"
    (status, reason, _), clicks = run_submit(adapter, Mock(html=submit_page(manual)))
    assert (status, reason) == (SUBMITTED, "submitted by the candidate in the browser") and clicks is None
    assert "\a[ACTION REQUIRED]" in capsys.readouterr().out


def test_attended_that_never_loads_times_out_cleanly_with_a_clear_prompt(adapter, home, quick, capsys):
    adapter.human_wait_s = 1                               # below the floor: the floor (8s here) is what applies
    (status, reason, detail), clicks = run_submit(adapter, Mock(html=APPLY))
    assert (status, reason) == (MANUAL_REVIEW, "CAPTCHA") and "not completed in time" in detail and clicks is None
    assert "waiting up to 8s" in capsys.readouterr().out                      # it said how long, so it never looks hung


def test_the_phone_is_told_and_skip_ends_the_wait(adapter, home, quick):
    fake = FakeDiscord()
    phone_notify.use(phone_notify.DiscordNotifier(TOKEN, CHANNEL, USER, http=fake))
    adapter.human_wait_s = 30

    async def go():
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            context = await browser.new_context()
            await context.route("**/*", Mock(html=APPLY).handle)
            page = await context.new_page()
            await page.goto(BASE + "/apply")
            task = asyncio.create_task(adapter.submit(page))
            await fake.wait_for("hCaptcha did not load")
            fake.user_says("/skip")
            try:
                return await asyncio.wait_for(task, 20)
            finally:
                await browser.close()
    assert run(go())[:2] == (MANUAL_REVIEW, "SKIPPED_FROM_PHONE")


# ---- 1. the Export Control answer ------------------------------------------------------------------------------ #

def citizen(label, obtained="citizen since birth", country="India", kind="textarea"):
    profile = json.loads(json.dumps(PROFILE))
    profile["work_authorization"].update(country_of_citizenship=country, citizenship_obtained=obtained)
    return AnswerEngine(profile, custom_answers=[]).resolve(Question(label=label, kind=kind, required=True),
                                                            Context(company="Zoox", labels=[label]))


ZOOX = ("Export Control & Compliance: for the sole purpose of determining export licensing requirements, please list "
        "any countries of which you are a citizen or legal permanent resident, and when you obtained such status.")


@pytest.mark.parametrize("label", [
    ZOOX,
    "List the countries of your citizenship and the date acquired.",
    "Country of citizenship (since when?)",
    "Please state your country of citizenship and when acquired",
    "What countries are you a citizen of, and what date did you obtain citizenship?",
    "Provide the country of citizenship and year you became a citizen",
])
def test_a_question_that_asks_when_gets_the_combined_answer(label):
    d = citizen(label)
    assert (d.action, d.value) == ("fill", "India (citizen since birth)"), label


@pytest.mark.parametrize("label", ["List all countries of citizenship", "What is your country of citizenship?",
                                   "Please list any countries of which you are a citizen or national"])
def test_a_question_that_does_not_ask_when_gets_just_the_country(label):
    d = citizen(label)
    assert (d.action, d.value) == ("fill", "India")


@pytest.mark.parametrize("obtained, expected", [
    ("citizen since birth", "India (citizen since birth)"), ("Since birth", "India (since birth)"),
    ("by birth", "India (by birth)"), ("May 2019", "India (citizen since May 2019)"),
    ("2019-05-01", "India (citizen since 2019-05-01)"), ("  citizen since birth  ", "India (citizen since birth)")])
def test_the_status_phrase_is_cleaned_into_one_combined_answer(obtained, expected):
    assert citizen(ZOOX, obtained).value == expected


@pytest.mark.parametrize("obtained", [None, "", "[citizen since birth / date obtained]", "date obtained", "<fill in>", "TBD"])
def test_an_unset_or_placeholder_status_is_never_sent_the_candidate_is_asked_instead(obtained):
    d = citizen(ZOOX, obtained)
    assert d.action == "unknown" and "citizenship_obtained" in d.note
    assert citizen("List all countries of citizenship", obtained).value == "India"        # no "when": country is enough
