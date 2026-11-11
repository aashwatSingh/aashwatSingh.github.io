"""Offline audit: replay the answer engine over cached Greenhouse question schemas.

    python coverage_report.py            # summary
    python coverage_report.py --answers  # also list every distinct answer given

Fetch schemas first with:  python agent_runner.py --prefetch
"""
from __future__ import annotations

import argparse
import glob
import json
import re
from collections import Counter

import config
from answers import AnswerEngine, Context, Question

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
                            description=re.sub(r"<[^>]+>", " ", q.get("description") or "")))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--answers", action="store_true")
    args = ap.parse_args()
    engine = AnswerEngine(config.load_profile())
    files = sorted(glob.glob(str(config.CACHE_DIR / "gh" / "*.json")))
    clean, unknown, answers = 0, Counter(), Counter()
    for path in files:
        schema = json.load(open(path))
        qs = questions_from_schema(schema)
        ctx = Context(company=schema.get("company_name", ""), labels=[q.label for q in qs])
        blocked = False
        for q in qs:
            d = engine.resolve(q, ctx)
            if d.action == "unknown":
                blocked = True
                unknown[(q.label[:95], d.rule)] += 1
            elif d.action == "fill":
                answers[(d.rule, q.label[:70], str(d.value)[:60])] += 1
        clean += not blocked
    print(f"{clean}/{len(files)} cached forms fully answerable from the profile")
    print("\nMost common blocking questions:")
    for (label, rule), n in unknown.most_common(40):
        print(f"  {n:3d}  [{rule}] {label}")
    if args.answers:
        print("\nAnswers given:")
        for (rule, label, value), n in sorted(answers.items()):
            print(f"  {n:3d}  [{rule}] {label!r} -> {value!r}")


if __name__ == "__main__":
    main()
