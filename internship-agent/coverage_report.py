"""Offline audit: replay the whole decision path over cached Greenhouse postings.

For each cached posting this runs the same steps the runner does - eligibility
check on the description, the answer engine, then the essay generator - but
without a browser, so it finishes in seconds.

    python agent_runner.py --prefetch     # cache question schemas (no browser)
    python coverage_report.py             # summary + most common blockers
    python coverage_report.py --answers   # also list every distinct answer given
"""
from __future__ import annotations

import argparse
import glob
import json
import re
from collections import Counter

import config
import essays
from answers import AnswerEngine, Context, Question
from ats.base import prequalify_text, strip_html

KIND = {"input_text": "text", "textarea": "textarea", "multi_value_single_select": "select",
        "multi_value_multi_select": "multiselect", "input_file": "file"}


def questions_from_schema(schema: dict) -> list[Question]:
    out = []
    for q in (schema.get("questions") or []) + (schema.get("location_questions") or []):
        fields = [f for f in q["fields"] if f["type"] != "input_hidden"]
        if not fields:
            continue
        f = fields[0]
        label = re.sub(r"\s+", " ", q["label"]).strip()
        out.append(Question(label=label, kind=KIND.get(f["type"], "text"), required=bool(q["required"]),
                            options=[v["label"] for v in f.get("values") or []], field_id=f.get("name", ""),
                            description=strip_html(q.get("description") or "")))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--answers", action="store_true")
    args = ap.parse_args()
    profile = config.load_profile()
    engine = AnswerEngine(profile)
    files = sorted(glob.glob(str(config.CACHE_DIR / "gh" / "*.json")))
    outcome, unknown, answers = Counter(), Counter(), Counter()
    for path in files:
        schema = json.load(open(path, encoding="utf-8"))
        text = f"{schema.get('title', '')}\n{strip_html(schema.get('content', ''))}"
        job = {"company": schema.get("company_name", ""), "title": schema.get("title", ""),
               "locations": [(schema.get("location") or {}).get("name", "")]}
        blocked = prequalify_text(text, profile, job)
        if blocked:
            outcome[f"not eligible / held: {blocked[1]}"] += 1
            continue
        qs = questions_from_schema(schema)
        ctx = Context(company=job["company"], title=job["title"], locations=job["locations"],
                      labels=[q.label for q in qs])
        stuck = False
        for q in qs:
            d = engine.resolve(q, ctx)
            rule, value = d.rule, d.value
            if d.action != "fill" and q.kind in ("textarea", "text") \
                    and d.rule in ("no-rule", "experience", "follow-up", "essay-project", "essay-why-swe"):
                draft = essays.generate(q.label, job, text, profile, q.description, q.required,
                                        38 if q.kind == "text" else None)
                if draft:
                    rule, value, d.action = draft[0], draft[1], "fill"
            if d.action == "unknown":
                stuck = True
                unknown[(q.label[:110], rule)] += 1
            elif d.action == "fill":
                answers[(rule, q.label[:70], str(value)[:60])] += 1
        outcome["needs a human answer" if stuck else "fully auto-fillable"] += 1
    eligible = outcome["needs a human answer"] + outcome["fully auto-fillable"]
    print(f"{len(files)} cached Greenhouse postings")
    for k, n in outcome.most_common():
        print(f"  {n:4d}  {k}")
    if eligible:
        print(f"auto-fillable share of eligible postings: {outcome['fully auto-fillable']}/{eligible} "
              f"= {100 * outcome['fully auto-fillable'] / eligible:.0f}%")
    print("\nMost common blocking questions:")
    for (label, rule), n in unknown.most_common(45):
        print(f"  {n:3d}  [{rule}] {label}")
    if args.answers:
        print("\nAnswers given:")
        for (rule, label, value), n in sorted(answers.items()):
            print(f"  {n:3d}  [{rule}] {label!r} -> {value!r}")


if __name__ == "__main__":
    main()
