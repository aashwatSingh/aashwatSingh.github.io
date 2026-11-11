"""Summarise the per-application logs into two CSVs you can act on.

    python report.py

ready_to_submit.csv     postings where every required question was answered from the
                        profile; they only need the human-verification step
                        (run `python agent_runner.py --assist`, or open the link).
blocking_questions.csv  required questions the profile could not answer, most common
                        first. Answer the recurring ones once in custom_answers.json.
"""
from __future__ import annotations

import csv
import glob
import json
import re
from collections import Counter, defaultdict

import config


def main() -> None:
    ready, by_status = [], Counter()
    blockers: Counter = Counter()
    examples: dict[str, list[str]] = defaultdict(list)
    reasons: Counter = Counter()
    for path in sorted(glob.glob(str(config.LOG_DIR / "applications" / "*.json"))):
        d = json.load(open(path, encoding="utf-8"))
        job, status = d["job"], d["status"]
        by_status[status] += 1
        unknown = [a for a in d.get("answers", []) if a["action"] == "unknown"]
        human_only = status == "manual_review" and d.get("reason") in ("CAPTCHA", "EMAIL_VERIFICATION_CODE")
        if status == "dry_run_ok" or human_only:
            ready.append({"Company": job["company"], "Role": job["title"], "ATS_Platform": job["ats"],
                          "Location": "; ".join(job.get("locations") or []), "URL": job["url"],
                          "Needs": "human verification on submit"})
        elif status != "submitted":
            reasons[d.get("reason") or status] += 1
        for a in unknown:
            key = re.sub(r"\s+", " ", a["label"]).strip()[:160]
            blockers[key] += 1
            if len(examples[key]) < 4 and job["company"] not in examples[key]:
                examples[key].append(job["company"])

    with (config.BASE / "ready_to_submit.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["Company", "Role", "ATS_Platform", "Location", "URL", "Needs"])
        w.writeheader()
        w.writerows(ready)
    with (config.BASE / "blocking_questions.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["Postings_blocked", "Question", "Example_companies"])
        for q, n in blockers.most_common():
            w.writerow([n, q, ", ".join(examples[q])])

    print("attempts by status:", dict(by_status))
    print("not-ready reasons:", dict(reasons.most_common()))
    print(f"ready_to_submit.csv: {len(ready)} postings; blocking_questions.csv: {len(blockers)} distinct questions")


if __name__ == "__main__":
    main()
