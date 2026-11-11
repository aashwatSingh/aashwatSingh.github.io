import json
from pathlib import Path

import essays

PROFILE = json.loads((Path(__file__).parent / "fixture_profile.json").read_text())
JOB = {"company": "Acme", "title": "Backend Software Engineer Intern"}
JD = "You will build services in Python and TypeScript on PostgreSQL. Docker and Kubernetes are a plus."


def gen(q, **kw):
    return essays.generate(q, JOB, JD, PROFILE, **kw)


def test_why_company_uses_only_profile_facts():
    rule, text = gen("Why do you want to intern at Acme?")
    assert rule == "essay-why_company" and "Acme" in text
    assert "Docker" not in text and "Kubernetes" not in text          # in the posting, not on the resume
    assert "Python" in text or "TypeScript" in text                    # in both
    assert 60 <= len(text.split()) <= 150 and "[" not in text


def test_limits_are_respected():
    _, text = gen("In your own words, what do you want to get out of this program? (50 words max)")
    assert len(text.split()) <= 50
    _, text = gen("In 1-2 sentences describe why you are interested in this internship position?")
    assert text.count(".") <= 2
    _, text = gen("Why Acme?", limit=38)
    assert len(text.split()) <= 38


def test_project_and_achievement_questions():
    assert gen("What is your favorite work project?")[1] == PROFILE["essays"]["challenging_project"]
    rule, text = gen("Please provide a summary highlighting your top two exceptional academic and/or "
                     "professional accomplishments.")
    assert rule == "essay-achievements" and "60%" in text and "40%" in text


def test_questions_a_template_cannot_answer_truthfully_stay_with_the_candidate():
    assert gen("Describe a time messy data led you to a wrong answer, and how you caught it.") is None
    assert gen("SAT Score") is None
    assert gen("Describe your previous experience with robots.") is None


def test_optional_boxes_are_only_filled_for_real_essay_prompts():
    assert gen("Additional information", required=False) is None
    assert gen("Anything else you would like us to know?", required=False) is None
    assert gen("Why Acme?", required=False) is not None


def test_why_questions_about_other_things_are_not_treated_as_why_company():
    assert gen("Why did you choose that piece?") is None
    assert gen("Outside of AI and ML, what is a technology, tool or project that has caught your attention?") is None
    rule, _ = gen("Why did you want to become an engineer in your respective discipline?")
    assert rule == "essay-why_swe"
    assert gen("What excites you about this opportunity?")[0] == "essay-why_company"
    assert gen("Tell us about your proudest accomplishment")[0] == "essay-project"
    assert gen("Please summarise your top two accomplishments.")[1].startswith("First, I built")
