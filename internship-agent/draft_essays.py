"""Draft the open-ended questions that still block forms, with any model, and feed the answers back.

    python draft_essays.py                       # draft what can be drafted and store it (see below)
    python draft_essays.py --export              # essay_requests.json: every blocking essay question + its prompt
    python draft_essays.py --import answers.json # store answers drafted elsewhere

With no flag it uses GEMINI_API_KEY or ANTHROPIC_API_KEY when one is set (in the environment or in .env),
and otherwise the local templates in essays.py, which need no key and no network: they name the company and
answer from your resume projects, for the question types they recognise. Anything else stays with you.

answers.json is a list of {"company", "question", "answer"}. Every answer is vetted (length, nothing from
skills.never_claim, no placeholders) and stored in custom_answers.json for that company only, so the next
run fills it in. Forms that ask you to attest the answers are your own / written without AI are never
exported. Read custom_answers.json before a live run: these go out under your name.
"""
from __future__ import annotations

import argparse
import json
import re

import config
import llm
import report
from answers import AI_POLICY, remember_answers

# Questions only the candidate can answer (facts, links, logistics): not essay material.
NOT_ESSAY = re.compile(
    r"^(company name|title|name|location|city)$|\blink\b|\burl\b|loom|availability|interviewing|offer|deadline|"
    r"publications?|time off|start (month|date)|salary|compensation|referr|how did you hear|"
    r"^(what did you contribute to it|why did you choose that piece|if you had more time)", re.I)


def requests_from_logs() -> list[dict]:
    profile = config.load_profile()
    out, seen = [], set()
    for d in report.rescore(report.load_attempts()):
        if d["status"] != "manual_review" or d.get("reason") != "UNANSWERED_REQUIRED":
            continue
        if any(AI_POLICY.search(a["label"]) for a in d["answers"]):
            continue                                       # the employer asked for the candidate's own words
        job = d["job"]
        for a in d["answers"]:
            label = re.sub(r"\s+", " ", a["label"]).strip()
            if a["action"] != "unknown" or a["kind"] not in ("textarea", "text") or a.get("rule") != "no-rule":
                continue
            if NOT_ESSAY.search(label) or len(label) < 25 or (job["company"], label) in seen:
                continue
            seen.add((job["company"], label))
            limit = 40 if a["kind"] == "text" or re.search(r"1-2 sentences|one sentence|briefly", label, re.I) else None
            out.append({"company": job["company"], "role": job.get("title", ""), "question": label, "kind": a["kind"],
                        "word_limit": limit, "system": llm.SYSTEM,
                        "prompt": llm.build_prompt(label, job, "", profile, limit)})
    return out


def store(answers: list[dict]) -> tuple[int, list[str]]:
    profile = config.load_profile()
    kept, rejected = 0, []
    for a in answers:
        text = re.sub(r"\s+", " ", str(a.get("answer") or "")).strip()
        limit = a.get("word_limit")
        if not llm.acceptable(text, profile, limit):
            rejected.append(f"{a.get('company')}: {str(a.get('question'))[:70]}")
            continue
        kept += remember_answers([{"label": a["question"], "kind": "textarea", "value": text}], a["company"])
    return kept, rejected


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--export", action="store_true")
    ap.add_argument("--import", dest="import_file")
    args = ap.parse_args()
    if args.import_file:
        kept, rejected = store(json.load(open(args.import_file, encoding="utf-8")))
        print(f"stored {kept} answers in {config.CUSTOM_ANSWERS_JSON.name}; rejected {len(rejected)}")
        for r in rejected:
            print("  rejected:", r)
        return
    reqs = requests_from_logs()
    if not args.export:
        import essays
        profile = config.load_profile()
        source = "a model (API key found)" if llm.available() else "local templates (no API key set)"
        done = []
        for r in reqs:
            job = {"company": r["company"], "title": r["role"]}
            hit = essays.generate(r["question"], job, "", profile, "", True, r["word_limit"])
            if hit:
                done.append({**r, "answer": hit[1], "word_limit": None})
        kept, rejected = store(done)
        print(f"{len(reqs)} blocking essay questions; {kept} drafted with {source} and stored in "
              f"{config.CUSTOM_ANSWERS_JSON.name}; {len(reqs) - kept} left for you:")
        stored = {(d["company"], d["question"]) for d in done}
        for r in reqs:
            if (r["company"], r["question"]) not in stored:
                print(f"  {r['company']}: {r['question'][:100]}")
        return
    (config.BASE / "essay_requests.json").write_text(json.dumps(reqs, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"essay_requests.json: {len(reqs)} questions")
    for r in reqs:
        print(f"  {r['company']}: {r['question'][:100]}")


if __name__ == "__main__":
    main()
