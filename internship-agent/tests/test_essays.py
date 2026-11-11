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


def test_behavioral_questions_map_to_the_prepared_stories():
    b = PROFILE["behavioral"]
    assert gen("Describe a time you had to learn a new skill or tool entirely on your own to complete a project. "
               "What was your strategy?") == ("essay-behavioral_learning", b["learning"])
    assert gen("Tell us about a time you worked on a team to deliver something.")[1] == b["teamwork"]
    assert gen("Describe a time you took initiative on an ambiguous problem.")[1] == b["initiative"]
    assert gen("Tell me about a time you faced a difficult technical problem and how you overcame it.")[1] == b["challenge"]


def test_behavioral_questions_without_a_matching_story_stay_with_the_candidate():
    assert gen("Tell us about a time you failed and what you learned.") is None
    assert gen("Describe a time you disagreed with a teammate.") is None
    assert gen("Tell me an example of excellence you have demonstrated that is NOT on your CV.") is None


def test_multi_part_examples_and_bullets_come_from_projects():
    first = gen("We look for evidence of exceptional ability. Please provide us with 3-4 examples highlighting your "
                "exceptional ability, using quantitative metrics.")
    second, third = gen("Second example:"), gen("Third example:")
    assert first[0] == "essay-example_1" and second[0] == "essay-example_2"
    assert first[1] != second[1] and third is None            # the fixture has only two projects
    rule, text = gen("Please provide 2-3 bullet points showcasing exceptional ability.")
    assert rule == "essay-bullets" and text.count("\n- ") == 1 and text.startswith("- Built ")


def test_experience_summary_and_built_before():
    rule, text = gen("Please share your previous internship, co-curricular, research and/or hands-on engineering "
                     "experience:")
    assert rule == "essay-experience_summary" and "Example Labs" in text
    assert gen("Have you built or worked on any apps before? If yes, tell us briefly about one.")[1].startswith("Yes. ")
    assert gen("Have you built or modified an Android app before? If yes, what tools did you use?") is None
    assert gen("Describe your previous experience with robots.") is None
