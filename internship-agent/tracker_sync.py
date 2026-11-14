"""internship_tracker.xlsx as the one count: what Mission Control and Internship Hunter both show.

    python tracker_sync.py summary                 # JSON: total, status breakdown, remaining, rows
    python tracker_sync.py append --company X --role Y [--date YYYY-MM-DD] [--url U] [--note N]
    python tracker_sync.py remove --url U          # only a row that append wrote
    python tracker_sync.py remove --company X --role Y

The workbook stays the source of truth. Internship Hunter (Node) calls this script instead of
keeping its own count, so its progress bar and Mission Control's always agree. Every command
prints one JSON object; failures are {"ok": false, "error": ...} with exit code 1.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import date, datetime

import config
import dedup

HUNTER_MARK = "Logged in Internship Hunter"

# The workbook's own status names, in the order its summary block lists them.
STATUS_ORDER = [
    config.XLSX_APPLIED_STATUS,
    "Assessment invited / Awaiting completion",
    "Assessment submitted / Awaiting result",
    "Assessments expired / Inactive",
    "Application incomplete",
    "Rejected",
]


def _text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (datetime, date)):
        return value.strftime("%Y-%m-%d")
    return str(value).strip()


def _count_lines(path) -> int:
    try:
        with open(path, encoding="utf-8") as fh:
            return max(sum(1 for line in fh if line.strip()) - 1, 0)
    except OSError:
        return 0


def summary(path=None, target: int = config.TARGET_TOTAL) -> dict:
    """Every application row, the total, the status breakdown and how many are left to the target."""
    path = path or config.TRACKER_XLSX
    raw = dedup.load_tracker_rows(path)
    rows = []
    for r in raw:
        company = _text(r.get("Company"))
        if not company:
            continue
        rows.append({
            "company": company,
            "role": _text(r.get("Role")),
            "dateApplied": _text(r.get("Date Applied")),
            "status": _text(r.get("Current Status")) or "Unknown",
            "statusDate": _text(r.get("Status Date")),
            "ref": _text(r.get("Application ID / Ref")),
            "notes": _text(r.get("Next Step / Notes")),
            "subject": _text(r.get("Source Email Subject")),
            "url": dedup._first_url(_text(r.get("Next Step / Notes"))),
        })
    counts = Counter(r["status"] for r in rows)
    ordered = [s for s in STATUS_ORDER if counts[s]] + sorted(s for s in counts if s not in STATUS_ORDER)
    try:
        modified = datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")
    except OSError:
        modified = ""
    pending = Pending.count()
    return {
        "ok": True,
        "source": str(path),
        "modified": modified,
        "total": len(rows),
        "target": target,
        "remaining": max(target - len(rows), 0),
        "byStatus": [{"status": s, "count": counts[s]} for s in ordered],
        "pendingWrites": pending,
        "unconfirmed": _count_lines(config.UNCONFIRMED_CSV),
        "rows": rows,
    }


class Pending:
    @staticmethod
    def count() -> int:
        try:
            data = json.loads(config.PENDING_XLSX_JSON.read_text(encoding="utf-8"))
            return len(data) if isinstance(data, list) else 0
        except (OSError, ValueError):
            return 0


def append(company: str, role: str, when: str = "", url: str = "", note: str = "", path=None) -> dict:
    """Add one application the candidate filled outside the runner. Refuses an exact repeat."""
    path = path or config.TRACKER_XLSX
    company, role = company.strip()[:120], (role or "").strip()[:160]
    url = (url or "").strip()[:600]
    if not company:
        return {"ok": False, "error": "company required"}
    if url and not url.lower().startswith(("http://", "https://")):
        return {"ok": False, "error": "url must start with http:// or https://"}
    try:
        day = datetime.strptime(when, "%Y-%m-%d").strftime("%Y-%m-%d") if when else date.today().isoformat()
    except ValueError:
        return {"ok": False, "error": "date must be YYYY-MM-DD"}
    key = (dedup.normalize_company(company), dedup.normalize_role(role))
    for r in dedup.load_tracker_rows(path):
        same_url = url and dedup.canonical_url(url) == dedup.canonical_url(dedup._first_url(_text(r.get("Next Step / Notes"))))
        same_role = role and (dedup.normalize_company(_text(r.get("Company"))),
                              dedup.normalize_role(_text(r.get("Role")))) == key
        if same_url or same_role:
            return {"ok": False, "error": "already in the tracker"}
    notes = HUNTER_MARK + (f" — {note.strip()[:200]}" if note.strip() else "") + (f" — {url}" if url else "")
    row = dedup.append_to_tracker_xlsx({
        "Company": company, "Role": role or None, "Cycle": "Summer 2027",
        "Date Applied": day, "Current Status": config.XLSX_APPLIED_STATUS, "Status Date": day,
        "Application ID / Ref": None, "Next Step / Notes": notes, "Source Email Subject": None,
    }, path)
    return {"ok": True, "row": row}


def remove(url: str = "", company: str = "", role: str = "", path=None) -> dict:
    """Undo an append: only a row this script wrote (marked in its notes), matched by its URL, or by
    company + role when it was logged without one. Rows the runner or the candidate wrote are never touched."""
    path = path or config.TRACKER_XLSX
    target = dedup.canonical_url(url or "")
    key = (dedup.normalize_company(company), dedup.normalize_role(role))
    if not target and not key[0]:
        return {"ok": False, "error": "url or company required"}

    def match(row: dict) -> bool:
        notes = _text(row.get("Next Step / Notes"))
        if not notes.startswith(HUNTER_MARK):
            return False
        if target:
            return dedup.canonical_url(dedup._first_url(notes)) == target
        return (dedup.normalize_company(_text(row.get("Company"))),
                dedup.normalize_role(_text(row.get("Role")))) == key
    return {"ok": True, "removed": dedup.delete_from_tracker_xlsx(match, path, limit=1)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("summary")
    a = sub.add_parser("append")
    a.add_argument("--company", required=True)
    a.add_argument("--role", default="")
    a.add_argument("--date", default="")
    a.add_argument("--url", default="")
    a.add_argument("--note", default="")
    r = sub.add_parser("remove")
    r.add_argument("--url", default="")
    r.add_argument("--company", default="")
    r.add_argument("--role", default="")
    args = ap.parse_args(argv)
    try:
        if args.cmd == "summary":
            out = summary()
        elif args.cmd == "append":
            out = append(args.company, args.role, args.date, args.url, args.note)
        else:
            out = remove(args.url, args.company, args.role)
    except OSError as exc:                                 # Excel has the workbook open, or another writer
        out = {"ok": False, "error": f"{config.TRACKER_XLSX.name} is locked ({type(exc).__name__}); close it in Excel"}
    except ValueError as exc:
        out = {"ok": False, "error": str(exc)[:200]}
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
