"""Regression tests for the answer engine. Every case here came from a real form."""
import json
from pathlib import Path

import pytest

from answers import AnswerEngine, Context, Question

PROFILE = json.loads((Path(__file__).parent / "fixture_profile.json").read_text())
ENGINE = AnswerEngine(PROFILE, custom_answers=[])
YN = ["Yes", "No"]


def ask(label, kind="select", options=None, required=True, company="Acme", **kw):
    q = Question(label=label, kind=kind, required=required,
                 options=YN if options is None and kind == "select" else (options or []), **kw)
    return ENGINE.resolve(q, Context(company=company, labels=[label]))


def filled(label, **kw):
    d = ask(label, **kw)
    assert d.action == "fill", f"{label!r}: {d}"
    return d.value


def blocked(label, **kw):
    d = ask(label, **kw)
    assert d.action == "unknown", f"{label!r} should not be auto-answered, got {d}"


# --- work authorization: polarity must never flip ---------------------------
@pytest.mark.parametrize("label", [
    "Will you now or in the future require sponsorship for employment visa status?",
    "Do you require visa sponsorship now or in the future?",
    "We are not able to facilitate any type of sponsorship at this time. Will you now or in the "
    "future require sponsorship for employment visa status (e.g., H-1B, etc.)?",
    "Will you now or in the future require sponsorship for employment? For instance, an H-1B? Toshiba "
    "will not be providing visa sponsorship. Therefore you must have the ability to work without a "
    "need for current or future visa sponsorship.",
])
def test_requires_sponsorship_is_yes(label):
    assert filled(label) == "Yes"


@pytest.mark.parametrize("label", [
    "Are you authorized to work in the United States without sponsorship?",
    "Are you legally authorized to work in the United States for the duration of this internship "
    "without sponsorship from the firm?",
])
def test_authorized_without_sponsorship_is_no(label):
    assert filled(label) == "No"


def test_authorized_to_work_is_yes():
    assert filled("Are you legally authorized to work in the United States?") == "Yes"


def test_descriptive_sponsorship_options():
    opts = ["Yes, I will require sponsorship now or in the future", "No, I will not require sponsorship"]
    assert filled("Will you now or in the future require employer sponsorship?", options=opts) == opts[0]


@pytest.mark.parametrize("label", [
    "Citizenship Status", "Are you a U.S. citizen?", "What is your current visa status?",
    "Active Security Clearance(s)", "Are you a U.S. person as defined by ITAR?",
    "Do you require any reasonable adjustments or accommodations to participate in the recruitment "
    "process? (Do not include VISA or relocation expectations)",
    "Please note that sponsorship is not allowed for this role. Also, if you are an international "
    "candidate, please confirm that your work authorization allows you to work as an independent "
    "contractor. Please confirm by selecting 'Yes'.",
    "Are you legally authorized to work in Canada?",
])
def test_never_answered(label):
    blocked(label)


def test_ambiguous_authorization_options_are_blocked():
    blocked("Are you legally authorized to work in the United States?", options=[
        "I am authorized to work in the United States for any employer",
        "I am authorized to work in the United States for my present employer only",
        "I require sponsorship to work in the United States",
        "I am not authorized to work in the United States"])


# --- things that must not be answered by keyword accident --------------------
@pytest.mark.parametrize("label,kind", [
    ("Why did you want to become an engineer in your respective discipline?", "textarea"),
    ("Why are you interested in Acme's Software Engineering Internship?", "textarea"),
    ("Is there any other context you'd like to share about your U.S. Immigration sponsorship needs?", "textarea"),
    ("Do you have experience working, studying or collaborating remotely?", "select"),
    ("Will you be available for a full-time role immediately post-internship?", "select"),
    ("Are you able to be onsite in San Carlos, CA from Feb 1st - Feb 5th, 2027?", "select"),
    ("Are you comfortable working onsite 5 days a week and commit to 55 hours per week?", "select"),
    ("Are you local to NYC or the Tri-State area and able to commute in for a Hybrid work schedule?", "select"),
    ("After your review of the job description, do you meet each of the basic qualifications?", "select"),
    ("Do you have experience with Docker?", "select"),
    ("How many years of experience do you have with REST APIs?", "text"),
    ("Are you holding any outstanding offers?", "select"),
    ("Why Acme?", "textarea"),
    ("Based on what is publicly available about Acme, what is a challenging technical problem you think "
     "we face?", "textarea"),
])
def test_not_guessed(label, kind):
    blocked(label, kind=kind)


def test_own_project_essay_is_answered():
    assert filled("Tell us about a technical project you've worked on through a class or research.",
                  kind="textarea") == PROFILE["essays"]["challenging_project"]
    assert filled("Please describe the most impressive and complex project you have worked on.",
                  kind="textarea") == PROFILE["essays"]["challenging_project"]


def test_start_date_does_not_pick_a_range_option():
    blocked("Preferred Internship/Co-Op Start Date",
            options=["Monday, March 1, 2027- May 21,2027", "June 1, 2027 - August 2027"])


def test_ethnicity_does_not_pick_a_mixed_option():
    blocked("What is your ethnicity?", options=["Asian", "White and Asian", "Black", "Other"])
    assert filled("Race", options=["White (Not Hispanic or Latino)", "Asian (Not Hispanic or Latino)",
                                   "Two or More Races"]) == "White (Not Hispanic or Latino)"


def test_heard_about_ignores_lookalike_sources():
    opts = ["SEO Career", "Campus Career Site", "Employee Referral", "LinkedIn"]
    assert filled("How did you hear about this job?", options=opts) == "LinkedIn"
    assert filled("How did you hear about us?", options=["Referral", "Company Website", "Event"]) == "Company Website"


# --- facts straight from the profile -----------------------------------------
def test_gpa_blank_when_optional_and_exact_when_required():
    assert ask("GPA", kind="text", required=False).action == "skip"
    assert filled("GPA", kind="text") == PROFILE["education"]["gpa"]
    assert filled("What is your GPA?", options=["3.5 - 4.0", "3.0 - 3.49", "Below 3.0"]) == "Below 3.0"


def test_graduation():
    assert filled("What is your expected graduation year?", kind="text") == "2028"
    assert filled("Expected graduation", options=["Fall 2027", "Spring 2028", "Fall 2028"]) == "Spring 2028"
    blocked("Will you be graduating before September 2027?")


def test_dated_program_inside_window_is_yes():
    assert filled("Can you commit to attending the full program, starting on June 7, 2027 and "
                  "finishing on August 6, 2027?") == "Yes"
    blocked("Are you available for the full program from June 1 through August 27, 2027?")


def test_typed_name_certification():
    assert filled("I hereby certify that my answers are true and complete. I hereby authorize Acme to verify "
                  "the same. I acknowledge this by entering my full name below.", kind="text") \
        == PROFILE["identity"]["full_name"]


def test_identity_and_misc():
    assert filled("First Name", kind="text") == PROFILE["identity"]["first_name"]
    assert filled("LinkedIn Profile", kind="text") == PROFILE["links"]["linkedin"]
    assert filled("Website", kind="text") == PROFILE["links"]["portfolio"]
    assert filled("Are you 18 years of age or older?") == "Yes"
    assert filled("Gender", options=["Male", "Female", "Decline To Self Identify"]) == "Female"
    assert filled("Veteran Status", options=["I am not a protected veteran", "I identify as a veteran",
                                             "I don't wish to answer"]) == "I am not a protected veteran"
    assert filled("Please indicate which programming languages you are proficient in", kind="multiselect",
                  options=["Go", "Java", "Python", "Rust"]) == ["Java", "Python"]


def test_prior_employment_and_legal_name():
    assert filled("Have you been employed by Acme before?", kind="boolean", options=YN) == "No"
    assert filled("Please state your full legal name:", kind="text") == PROFILE["identity"]["full_name"]
    assert ask("Full Legal Name in Native Language (e.g. Chinese Characters)", kind="text",
               required=False).action == "skip"


def test_sms_consent_is_declined_not_blocked():
    assert filled("SMS Consent: Do you agree to receive mobile messages from us in relation to this job "
                  "application? Message and data rates may apply. Reply STOP to opt out.") == "No"


def test_custom_answers_override():
    eng = AnswerEngine(PROFILE, custom_answers=[{"pattern": "outstanding offers", "answer": False}])
    d = eng.resolve(Question("Are you holding any outstanding offers?", "select", True, YN), Context())
    assert (d.action, d.value) == ("fill", "No")
