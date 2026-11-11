import json
from pathlib import Path

from ats.base import MANUAL_REVIEW, SKIPPED_INELIGIBLE, prequalify_text

PROFILE = json.loads((Path(__file__).parent / "fixture_profile.json").read_text())


def check(text, **auth):
    profile = {**PROFILE, "work_authorization": {**PROFILE["work_authorization"], **auth}}
    return prequalify_text(text, profile, {})


def test_plain_posting_is_eligible():
    assert check("Build backend services in Python. We are an equal opportunity employer and do not "
                 "discriminate on the basis of citizenship, veteran status or disability.") is None
    assert check("10 to 12 weeks between May and August 2027. We sponsor US visas.") is None


def test_hard_disqualifiers():
    assert check("U.S. citizenship is required for this role.")[0] == SKIPPED_INELIGIBLE
    assert check("Candidates must be able to obtain a Secret security clearance.")[0] == SKIPPED_INELIGIBLE
    assert check("Must be currently pursuing a PhD in computer science.")[0] == SKIPPED_INELIGIBLE


def test_us_person_roles_follow_the_profile():
    text = "Must be a U.S. Person due to required access to export controlled information."
    assert check(text, us_person=None) == (MANUAL_REVIEW, "US_PERSON_REQUIRED")
    assert check(text, us_person=False)[0] == SKIPPED_INELIGIBLE
    assert check(text, us_person=True, requires_sponsorship=False) is None
    assert check("ITAR REQUIREMENTS To conform to U.S. Government export regulations...",
                 us_person=None)[0] == MANUAL_REVIEW


def test_no_sponsorship_postings():
    text = "We don\u2019t sponsor visas for internships, and the application asks you to confirm this."
    assert check(text)[0] == SKIPPED_INELIGIBLE
    assert check(text, apply_when_no_sponsorship=True) is None
    assert check(text, requires_sponsorship=False) is None
    assert check("We are unable to provide visa sponsorship for this position.")[0] == SKIPPED_INELIGIBLE
