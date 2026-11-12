import json
from pathlib import Path

import answer_blockers as ab
from answers import AnswerEngine, Context, Question, pattern_for, remember_answers

PROFILE = json.loads((Path(__file__).parent / "fixture_profile.json").read_text())


def scripted(*lines):
    it = iter(lines)
    return lambda prompt: next(it)


def test_profile_fields_are_asked_only_while_null_and_typed():
    profile = json.loads(json.dumps(PROFILE))
    profile["logistics"]["travel_percentage"] = 10                 # already set: must not be asked
    asked = []
    answers = iter(["F-1 student visa", "n", "", "H1B", "maybe", "n", "q"])

    def ask(prompt):
        asked.append(prompt)
        return next(answers)

    try:
        ab.ask_profile_fields(profile, ask, say=lambda *_: None)
    except ab.Quit:
        pass
    wa = profile["work_authorization"]
    assert wa["citizenship_status"] == "F-1 student visa" and wa["us_person"] is False
    assert wa["internship_work_authorization"] is None             # Enter skipped it
    assert wa["future_sponsorship_visa"] == "H1B"
    assert wa["requires_sponsorship_now"] is False                 # "maybe" was rejected, then "n"
    assert not any("travel_percentage" in p for p in asked)


def test_answers_are_stored_and_then_used_by_the_engine():
    blockers = [
        {"label": "Do you have fundamental knowledge of computer architecture and networks?", "kind": "boolean",
         "options": ["Yes", "No"], "count": 2, "companies": ["Acme"], "rule": "no-rule", "profile_key": ""},
        {"label": "Language Skill(s) (Check all that apply)", "kind": "checkbox_group",
         "options": ["English", "Spanish", "Hindi"], "count": 2, "companies": ["Acme"], "rule": "no-rule", "profile_key": ""},
        {"label": "Why do you want to work at Initech?", "kind": "textarea", "options": [], "count": 1,
         "companies": ["Initech"], "rule": "no-rule", "profile_key": ""},
        {"label": "AI Policy for Application", "kind": "boolean", "options": ["Yes", "No"], "count": 2,
         "companies": ["Talos"], "rule": "x-human-only", "profile_key": ""},
        {"label": "Citizenship Status", "kind": "select", "options": ["U.S. Citizen", "Other"], "count": 4,
         "companies": ["Acme"], "rule": "x-citizenship", "profile_key": "work_authorization.citizenship_status"},
        {"label": "Transcript", "kind": "file", "options": [], "count": 3, "companies": ["Acme"], "rule": "file",
         "profile_key": ""},
    ]
    profile = json.loads(json.dumps(PROFILE))
    profile["projects"] = []                                       # no template essay for the Initech question
    custom: list = []
    engine = AnswerEngine(profile, custom)
    shown = []
    added = ab.ask_blockers(blockers, engine, custom, scripted("1", "9", "1,3", "Because of the TPS reports."),
                            say=shown.append)
    assert added == 3
    text = "\n".join(shown)
    assert "AI Policy" not in text and "Citizenship Status" not in text and "Transcript" not in text
    by_pattern = {e["pattern"]: e for e in custom}
    initech = by_pattern[pattern_for("Why do you want to work at Initech?")]
    assert initech["company"] == "^Initech$"

    fresh = AnswerEngine(profile, custom)
    d = fresh.resolve(Question(blockers[0]["label"], "boolean", True, ["Yes", "No"]), Context(company="Other Co"))
    assert (d.action, d.value) == ("fill", "Yes")
    d = fresh.resolve(Question(blockers[1]["label"], "checkbox_group", True, ["English", "Spanish", "Hindi"]), Context())
    assert d.value == ["English", "Hindi"]
    d = fresh.resolve(Question(blockers[2]["label"], "textarea", True), Context(company="Initech"))
    assert d.value == "Because of the TPS reports."
    d = fresh.resolve(Question(blockers[2]["label"], "textarea", True), Context(company="Globex"))
    assert d.action == "unknown"                                   # scoped to the employer it was written for


def test_questions_already_answered_by_the_profile_are_not_asked():
    blockers = [{"label": "Are you 18 years of age or older?", "kind": "select", "options": ["Yes", "No"], "count": 5,
                 "companies": ["Acme"], "rule": "age-18", "profile_key": ""}]
    custom: list = []
    assert ab.ask_blockers(blockers, AnswerEngine(PROFILE, custom), custom, scripted(), say=lambda *_: None) == 0


def test_remember_answers_from_the_browser(tmp_path):
    path = tmp_path / "custom_answers.json"
    items = [
        {"label": "Are you willing and able to work nights and weekends?", "kind": "boolean", "value": "Yes"},
        {"label": "Language Skill(s) (Check all that apply)", "kind": "checkbox_group", "value": ["English", "Hindi"]},
        {"label": "Why do you want to work at Initech?", "kind": "textarea", "value": "Because of the TPS reports."},
        {"label": "AI Policy for Application", "kind": "boolean", "value": "Yes"},      # never remembered
        {"label": "Transcript", "kind": "file", "value": "t.pdf"},                       # never remembered
        {"label": "Anything else?", "kind": "textarea", "value": ""},
    ]
    assert remember_answers(items, "Initech", path) == 3
    stored = json.loads(path.read_text())
    assert not any("ai policy" in e["pattern"] for e in stored)
    eng = AnswerEngine(PROFILE, stored)
    d = eng.resolve(Question("Are you willing and able to work nights and weekends?", "radio", True, ["Yes", "No"]),
                    Context(company="Globex"))
    assert (d.action, d.value) == ("fill", "Yes")
    d = eng.resolve(Question("Why do you want to work at Initech?", "textarea", True), Context(company="Initech"))
    assert d.value == "Because of the TPS reports."
    # answering the same question again replaces the stored answer
    remember_answers([items[0] | {"value": "No"}], "Globex", path)
    again = json.loads(path.read_text())
    assert [e["answer"] for e in again if e["pattern"] == pattern_for(items[0]["label"])] == ["No"]
