"""Summarise the per-application logs into files you can act on.

    python report.py                              # everything in logs/applications
    python report.py --since 2026-11-11T10:30     # only attempts logged at or after this time

ready_to_submit.csv      postings where every required question was answered; they only need the
                         human-verification step (run `python agent_runner.py --local-blitz`).
blocking_questions.csv   required questions that stopped a form, most common first, with the
                         profile key to set when one exists.
blocking_questions.json  the same list with option lists, read by answer_blockers.py.
"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import re
from collections import Counter, defaultdict

import config

HUMAN_GATES = ("CAPTCHA", "EMAIL_VERIFICATION_CODE")
_KEY = re.compile(r"\bset ((?:work_authorization|logistics|education|skills)\.[a-z_]+)")
# Rules whose unanswered questions map to one profile key even though the note does not name it.
RULE_KEYS = {
    "x-citizenship": "work_authorization.citizenship_status",
    "x-prior-internship": "logistics.has_prior_internship",
    "x-prior-internship-count": "logistics.prior_internship_count",
    "x-further-education": "logistics.pursuing_further_education_after_degree",
    "x-travel": "logistics.travel_percentage",
    "x-outside-business": "logistics.outside_business_activities",
    "x-background-check": "logistics.consents_to_background_check",
    "x-interview-recording": "logistics.consents_to_interview_recording",
    "x-arbitration": "logistics.accept_arbitration_agreements",
    "x-hs-graduation": "education.high_school_graduation",
    "x-high-school": "education.high_school_name",
    "x-school-email": "education.school_email",
    "x-alt-email": "education.school_email",
    "x-test-scores": "education.sat_score / act_score",
}
FILE_KEYS = {"transcript": "education.transcript_path (a transcript.pdf file)",
             "cover letter": "logistics.cover_letter_path (a cover letter file)"}


def profile_key(answer: dict) -> str:
    m = _KEY.search(answer.get("note") or "")
    if m:
        return m.group(1)
    if answer.get("rule") == "file":
        low = answer["label"].lower()
        return next((v for k, v in FILE_KEYS.items() if k in low), "")
    return RULE_KEYS.get(answer.get("rule") or "", "")


def load_attempts(since: str | None = None) -> list[dict]:
    out = []
    for path in sorted(glob.glob(str(config.LOG_DIR / "applications" / "*.json"))):
        d = json.load(open(path, encoding="utf-8"))
        if since and d.get("when", "") < since:
            continue
        out.append(d)
    return out


def summarise(attempts: list[dict]) -> dict:
    ready, per_ats = [], defaultdict(Counter)
    blockers: dict[str, dict] = {}
    for d in attempts:
        job, status, reason = d["job"], d["status"], d.get("reason") or ""
        ats = job.get("ats") or "?"
        unknown = [a for a in d.get("answers", []) if a["action"] == "unknown"]
        if status in ("dry_run_ok", "submitted") or (status == "manual_review" and reason in HUMAN_GATES):
            bucket = "auto-filled"
            if status != "submitted":
                ready.append({"Company": job["company"], "Role": job["title"], "ATS_Platform": ats,
                              "Location": "; ".join(job.get("locations") or []), "URL": job["url"],
                              "Needs": "human verification on submit"})
        elif status == "manual_review" and reason == "UNANSWERED_REQUIRED":
            bucket = "needs an answer"
        elif status == "manual_review" and reason in ("US_PERSON_REQUIRED",):
            bucket = "held: U.S.-person posting"
        elif status in ("skipped_ineligible", "closed"):
            bucket = "not eligible / closed"
        else:
            bucket = f"other: {reason or status}"
        per_ats[ats][bucket] += 1
        for a in unknown:
            label = re.sub(r"\s+", " ", a["label"]).strip()
            b = blockers.setdefault(label, {"label": label, "kind": a.get("kind", ""), "options": a.get("options") or [],
                                            "rule": a.get("rule", ""), "note": a.get("note", ""),
                                            "profile_key": profile_key(a), "count": 0, "companies": []})
            b["count"] += 1
            if job["company"] not in b["companies"]:
                b["companies"].append(job["company"])
            if not b["options"] and a.get("options"):
                b["options"] = a["options"]
    return {"ready": ready, "per_ats": per_ats,
            "blockers": sorted(blockers.values(), key=lambda b: (-b["count"], b["label"]))}


def write_files(summary: dict) -> None:
    with (config.BASE / "ready_to_submit.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["Company", "Role", "ATS_Platform", "Location", "URL", "Needs"])
        w.writeheader()
        w.writerows(summary["ready"])
    with (config.BASE / "blocking_questions.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["Postings_blocked", "Question", "Field_type", "Options", "Profile_key", "Example_companies"])
        for b in summary["blockers"]:
            w.writerow([b["count"], b["label"][:300], b["kind"], " | ".join(b["options"][:12]), b["profile_key"],
                        ", ".join(b["companies"][:4])])
    (config.BASE / "blocking_questions.json").write_text(
        json.dumps(summary["blockers"], indent=1, ensure_ascii=False), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since", help="ISO time; ignore attempts logged before it")
    args = ap.parse_args()
    summary = summarise(load_attempts(args.since))
    write_files(summary)

    print(f"{'ATS':<12}{'eligible':>9}{'auto-filled':>13}{'share':>7}   other outcomes")
    for ats, c in sorted(summary["per_ats"].items()):
        eligible = c["auto-filled"] + c["needs an answer"]
        share = f"{100 * c['auto-filled'] / eligible:.0f}%" if eligible else "-"
        rest = ", ".join(f"{k}: {v}" for k, v in c.items() if k not in ("auto-filled", "needs an answer"))
        print(f"{ats:<12}{eligible:>9}{c['auto-filled']:>13}{share:>7}   {rest}")
    keys = Counter()
    for b in summary["blockers"]:
        keys[b["profile_key"] or "(no profile key - use answer_blockers.py)"] += b["count"]
    print("\nblocked answers by what would unlock them:")
    for k, n in keys.most_common():
        print(f"  {n:4d}  {k}")
    print(f"\nready_to_submit.csv: {len(summary['ready'])} postings; "
          f"blocking_questions.csv/.json: {len(summary['blockers'])} distinct questions")


if __name__ == "__main__":
    main()
