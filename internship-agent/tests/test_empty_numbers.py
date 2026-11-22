"""Regression: `ValueError: could not convert string to float: ''` crashed a live Lever run.
Empty or non-numeric profile values (GPA, pay, years of experience) must never raise: the question is left
unknown or skipped instead."""
import copy
import json

import pytest

import answers
from answers import AnswerEngine, Context, Question, safe_float
from tests.test_assist import PROFILE


@pytest.mark.parametrize("value, expected", [
    ("", None), ("   ", None), (None, None), ("n/a", None), ("3.5/4.0", None), ("k", None), ("$", None),
    (True, None), ("nan", None), ("inf", None),
    ("3.5", 3.5), (" 3.5 ", 3.5), (4, 4.0), (3.9, 3.9), ("$1,200", 1200.0), ("76k", 76000.0), ("85%", 85.0)])
def test_safe_float_never_raises(value, expected):
    assert safe_float(value) == expected


def test_safe_float_default():
    assert safe_float("", 0.0) == 0.0 and safe_float("x", -1.0) == -1.0 and safe_float("2") == 2.0


def engine(**changes):
    profile = copy.deepcopy(PROFILE)
    for path, value in changes.items():
        node = profile
        *keys, last = path.split("__")
        for k in keys:
            node = node[k]
        node[last] = value
    return AnswerEngine(profile, custom_answers=[])


GPA_OPTIONS = ["Below 3.0", "3.0 - 3.49", "3.5 - 4.0"]


@pytest.mark.parametrize("gpa", ["", " ", "n/a", "3.5/4.0"])
@pytest.mark.parametrize("kind, options", [("select", GPA_OPTIONS), ("text", [])])
def test_gpa_question_with_an_empty_or_odd_gpa_does_not_crash(gpa, kind, options):
    eng = engine(education__gpa=gpa)
    d = eng.resolve(Question(label="What is your GPA?", kind=kind, required=True, options=options),
                    Context(company="CesiumAstro", labels=["What is your GPA?"]))
    assert d.action in ("fill", "skip", "unknown")
    if kind == "select":
        assert d.action == "unknown"


@pytest.mark.parametrize("pay", ["", "  ", "negotiable"])
def test_pay_bucket_with_empty_salary_figures_does_not_crash(pay):
    eng = engine(logistics__desired_annual_salary=pay, logistics__desired_hourly_rate=pay)
    d = eng.resolve(Question(label="Desired annual salary", kind="select", required=True,
                             options=["Less than 25k", "25-50k", "50-80k"]),
                    Context(company="CesiumAstro", labels=["Desired annual salary"]))
    assert d.action in ("fill", "skip", "unknown")


@pytest.mark.parametrize("years", ["", " ", "n/a", "3+"])
def test_years_of_experience_with_an_empty_or_odd_value_does_not_crash(years):
    eng = engine(skills__years_experience_internship=years, skills__years_experience_full_time=years)
    d = eng.resolve(Question(label="Years of Python experience", kind="select", required=True,
                             options=["0", "1", "2", "3", "4+"]),
                    Context(company="CesiumAstro", labels=["Years of Python experience"]))
    assert d.action in ("fill", "skip", "unknown")


def test_no_bare_float_calls_on_profile_values_remain():
    import re
    src = open(answers.__file__, encoding="utf-8").read()
    body = src.split("def safe_float", 1)[1].split("FREE_KINDS", 1)[1]        # everything after the helper itself
    left = [l.strip() for l in body.splitlines() if re.search(r"(?<![\w.])float\((edu|value|v|log|p)\b", l)]
    assert left == []
