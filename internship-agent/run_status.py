"""Where did the last runs stop? A read-only report built from the files the runner leaves behind.

    python run_status.py                  # the last 50 postings, counts by stopping point, queue health
    python run_status.py --last 100
    python run_status.py --csv out.csv    # the per-posting table as a CSV as well

It reads logs/applications/*.json (one per posting attempted), unconfirmed_applications.csv,
unblock_queue.json, job_queue.json, workday_accounts.json and runner.log. Nothing is written except the
optional --csv file, and nothing secret is printed: for .env it only says which keys are set.

Stopping points:
  submitted          submitted and its confirmation e-mail was found
  submitted, no e-mail  submitted in the browser, but no confirmation e-mail: Unverified, not counted
  dry run ok         filled completely in a dry run (nothing sent)
  filtered out       ineligible (citizenship, degree, term...) or the posting is closed
  form error         a question it could not answer, a field the page flagged, a form it could not read
  stuck waiting      CAPTCHA, e-mailed code, sign-in, or a wait on you that ran out
  skipped by you     /skip from the phone
  crashed            an exception (page failed to load, browser error)
Postings skipped as duplicates are never opened, so they have no log file: they are counted from
job_queue.json under "Queue".
"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import sys
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

import config

FORM_ERRORS = {"UNANSWERED_REQUIRED", "PRESUBMIT_CHECK", "VALIDATION_ERROR", "FORM_NOT_FOUND", "NO_JOB_DESCRIPTION",
               "UNRESOLVED_URL", "UNSUPPORTED_ATS", "REJECTED_BY_ATS", "LLM_NO_RESULT", "US_PERSON_REQUIRED",
               "WORKDAY_PAGE", "WORKDAY_REVIEW_ERRORS", "WORKDAY_RETURNED", "WORKDAY_READY_FOR_REVIEW",
               "NO_CONFIRMATION"}
WAITS = {"CAPTCHA", "EMAIL_VERIFICATION_CODE", "TIMEOUT", "FROZEN", "WORKDAY_LOGIN", "WORKDAY_ACCOUNT",
         "UNCONFIRMED"}
ORDER = ["submitted", "submitted, no e-mail", "dry run ok", "filtered out", "form error", "stuck waiting",
         "skipped by you", "crashed"]
ENV_KEYS = ("GMAIL_ADDRESS", "GMAIL_APP_PASSWORD", "WORKDAY_PASSWORD", "DISCORD_BOT_TOKEN", "DISCORD_CHANNEL_ID",
            "DISCORD_USER_ID", "ANTHROPIC_API_KEY", "RESUME_PDF")


def stopping_point(status: str, reason: str, unconfirmed: bool = False) -> str:
    code = (reason or "").split(":")[0].strip()
    if status == "submitted":
        return "submitted, no e-mail" if unconfirmed else "submitted"
    if status == "dry_run_ok":
        return "dry run ok"
    if status in ("skipped_ineligible", "closed"):
        return "filtered out"
    if status == "error":
        return "crashed"
    if code == "SKIPPED_FROM_PHONE":
        return "skipped by you"
    if code in WAITS or code.startswith("WORKDAY_LOGIN"):
        return "stuck waiting"
    if code in FORM_ERRORS or status == "manual_review":
        return "form error"
    return "crashed"


def _read_csv(path: Path) -> list[dict]:
    try:
        with path.open(newline="", encoding="utf-8") as fh:
            return list(csv.DictReader(fh))
    except OSError:
        return []


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def attempts(base: Path | None = None, last: int = 50) -> list[dict]:
    """The last `last` postings attempted, newest first, each with its stopping point."""
    base = Path(base or config.BASE)
    import dedup
    unconfirmed = {dedup.canonical_url(r.get("URL")) for r in _read_csv(base / config.UNCONFIRMED_CSV.name)}
    rows = []
    for path in glob.glob(str(base / "logs" / "applications" / "*.json")):
        data = _read_json(Path(path), None)
        if not isinstance(data, dict):
            continue
        job = data.get("job") or {}
        status, reason = str(data.get("status") or ""), str(data.get("reason") or "")
        outcome = data.get("outcome") or ""
        uncon = outcome == "unconfirmed" or (status == "submitted" and dedup.canonical_url(job.get("url")) in unconfirmed)
        rows.append({"when": str(data.get("when") or ""), "ats": job.get("ats") or "", "company": job.get("company") or "",
                     "title": job.get("title") or "", "stopped": stopping_point(status, reason, uncon),
                     "reason": reason, "detail": " ".join(str(data.get("detail") or "").split())[:160],
                     "url": job.get("url") or ""})
    rows.sort(key=lambda r: r["when"], reverse=True)
    return rows[:last]


def queue_health(base: Path | None = None, ats: str = "Greenhouse,Ashby,Lever") -> dict:
    base = Path(base or config.BASE)
    path = base / config.QUEUE_JSON.name
    queue = _read_json(path, [])
    wanted = {a.strip().lower() for a in ats.split(",")}
    mine = [j for j in queue if str(j.get("ats", "")).lower() in wanted]
    newest = max((int(j.get("date_posted") or 0) for j in queue), default=0)
    return {
        "path": str(path), "exists": path.exists(),
        "refreshed": datetime.fromtimestamp(path.stat().st_mtime) if path.exists() else None,
        "newest_posting": datetime.fromtimestamp(newest) if newest else None,
        "total": len(queue),
        "by_status": Counter(j.get("status", "pending") for j in mine),
        "pending_by_ats": Counter(j["ats"] for j in mine if j.get("status", "pending") == "pending"),
        "duplicate_reasons": Counter(str(j.get("status_detail", "")).split(" (")[0] for j in mine
                                     if j.get("status") == "duplicate"),
    }


def run_starts(base: Path | None = None, n: int = 12) -> list[str]:
    log = Path(base or config.BASE) / "logs" / "runner.log"
    try:
        lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    keep = [l for l in lines if "] ledger: " in l or "] done: " in l or "refreshing job_queue" in l
            or "] queue: " in l or "Resume not found" in l]
    return keep[-n:]


def report(base: Path | None = None, last: int = 50, ats: str = "Greenhouse,Ashby,Lever", out=print) -> list[dict]:
    base = Path(base or config.BASE)
    rows = attempts(base, last)
    out(f"Last {len(rows)} postings attempted (newest first)")
    out(f"{'when':<19}  {'ATS':<10}  {'company':<24}  {'stopped at':<20}  reason")
    for r in rows:
        out(f"{r['when'][:19]:<19}  {r['ats'][:10]:<10}  {r['company'][:24]:<24}  {r['stopped']:<20}  "
            f"{r['reason'][:40]}{': ' + r['detail'][:90] if r['detail'] else ''}")
    counts = Counter(r["stopped"] for r in rows)
    out("\nCounts by stopping point")
    for k in ORDER:
        if counts.get(k):
            out(f"  {counts[k]:>4}  {k}")
    reasons = Counter((r["stopped"], r["reason"].split(":")[0]) for r in rows if r["stopped"] not in ("submitted",))
    if reasons:
        out("Most common reasons")
        for (stop, code), n in reasons.most_common(12):
            out(f"  {n:>4}  {stop}: {code}")

    q = queue_health(base, ats)
    out(f"\nQueue ({Path(q['path']).name}, portals {ats})")
    if not q["exists"]:
        out("  job_queue.json not found: the next run scrapes the listing sources")
    else:
        age = (datetime.now() - q["refreshed"]).days if q["refreshed"] else None
        out(f"  last written {q['refreshed']:%Y-%m-%d %H:%M}; newest posting in it: "
            f"{q['newest_posting']:%Y-%m-%d}" if q["newest_posting"] else f"  last written {q['refreshed']}")
        out(f"  pending (will be tried): {sum(q['pending_by_ats'].values())}  "
            + ", ".join(f"{a} {n}" for a, n in q["pending_by_ats"].most_common()))
        out("  by status: " + ", ".join(f"{s} {n}" for s, n in q["by_status"].most_common()))
        for reason, n in q["duplicate_reasons"].most_common(5):
            out(f"    duplicate: {n} x {reason}")
        if q["newest_posting"] and (datetime.now() - q["newest_posting"]).days >= 3:
            out(f"  ! no posting newer than {(datetime.now() - q['newest_posting']).days} days: the queue is stale")
        if age is not None and age >= 3:
            out(f"  ! job_queue.json has not been rewritten in {age} days")

    unblock = _read_json(base / config.UNBLOCK_JSON.name, [])
    open_items = [i for i in unblock if isinstance(i, dict) and i.get("state", "open") == "open"]
    if open_items:
        out(f"\nUnblock Queue: {len(open_items)} open")
        for kind, n in Counter(i.get("kind") or i.get("reason") for i in open_items).most_common():
            out(f"  {n:>4}  {kind}")

    accounts = _read_json(base / "workday_accounts.json", {})
    if isinstance(accounts, dict) and accounts:
        out("\nWorkday tenants: " + ", ".join(f"{s} {n}" for s, n in
                                             Counter(v.get("status") for v in accounts.values()
                                                     if isinstance(v, dict)).most_common()))

    env = config.read_dotenv(base / ".env")
    out("\n.env: " + ", ".join(f"{k} {'set' if (env.get(k) or os.environ.get(k)) else 'MISSING'}" for k in ENV_KEYS))
    try:
        profile = config.load_profile(base / config.PROFILE_PATH.name)
        resume = profile["resume_path"]
        out(f"resume attached: {Path(resume).name} ({'found' if os.path.exists(resume) else 'NOT FOUND'})")
    except Exception as exc:                                       # noqa: BLE001 - a report, never a crash
        out(f"profile: {type(exc).__name__}: {str(exc)[:120]}")

    starts = run_starts(base)
    if starts:
        out("\nrunner.log (run starts and ends)")
        for line in starts:
            out("  " + line[:200])
    return rows


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--last", type=int, default=50)
    ap.add_argument("--ats", default="Greenhouse,Ashby,Lever")
    ap.add_argument("--csv", help="also write the per-posting table here")
    args = ap.parse_args(argv)
    rows = report(last=args.last, ats=args.ats)
    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0]) if rows else ["when"])
            w.writeheader()
            w.writerows(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
