"""The Unblock Queue: postings that stopped on something only the candidate can clear.

The runner adds an item whenever an application ends without a confirmed submission it could not
finish by itself (an unanswered required question, a CAPTCHA, a login wall, a page error, or a
submission whose confirmation e-mail never came). Mission Control lists them and resolves them:

    retry    put the posting back in the queue (the runner picks it up between applications,
             or at the start of the next run)
    resume   the same, after saving the answers typed into the dashboard to custom_answers.json
    confirm  "Confirm Submitted": for a missing receipt only; the tracker row becomes an application
    dismiss  drop it from the list

Mission Control never edits job_queue.json itself (the runner holds it in memory and rewrites it);
a retried item is marked "requeued" here and the runner consumes it with take_requeued().
Every change goes through fileutil.file_lock, so the two processes never lose each other's writes.
"""
from __future__ import annotations

import re
import time
import uuid
from datetime import date
from pathlib import Path

import config
from fileutil import atomic_write_json, file_lock, read_json

OPEN, REQUEUED, TAKEN, CONFIRMED, DISMISSED = "open", "requeued", "taken", "confirmed", "dismissed"
ACTIONS = ("retry", "resume", "confirm", "dismiss")
MAX_ITEMS = 400                                         # resolved items are trimmed oldest first

KINDS = {
    "question": ("UNANSWERED_REQUIRED", "VALIDATION_ERROR", "PRESUBMIT_CHECK"),
    "captcha": ("CAPTCHA", "REJECTED_BY_ATS"),
    "login": ("WORKDAY_LOGIN", "WORKDAY_ACCOUNT"),
    "code": ("EMAIL_VERIFICATION_CODE",),
    "receipt": ("UNCONFIRMED", "NO_CONFIRMATION"),
}
# Results that are not blockers: nothing for the candidate to do.
NOT_BLOCKERS = {"UNSUPPORTED_ATS", "UNRESOLVED_URL"}


def kind_of(reason: str) -> str:
    for kind, reasons in KINDS.items():
        if reason in reasons:
            return kind
    if reason.startswith("WORKDAY_"):
        return "workday"
    return "other"


def _path() -> Path:
    return Path(config.UNBLOCK_JSON)


def _load() -> list[dict]:
    data = read_json(_path(), [])
    return [i for i in data if isinstance(i, dict) and i.get("id")] if isinstance(data, list) else []


def _save(items: list[dict]) -> None:
    done = [i for i in items if i.get("status") not in (OPEN, REQUEUED)]
    if len(items) > MAX_ITEMS and done:
        drop = {i["id"] for i in done[: len(items) - MAX_ITEMS]}
        items = [i for i in items if i["id"] not in drop]
    atomic_write_json(_path(), items)


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _job_view(job: dict) -> dict:
    return {k: job.get(k) or "" for k in ("id", "company", "title", "url", "ats")}


def add(job: dict, reason: str, detail: str = "", questions: list[str] | None = None,
        screenshot: str = "") -> dict:
    """Add (or refresh) the open item for this posting. One open item per posting."""
    item = {
        "id": uuid.uuid4().hex[:12],
        "job": _job_view(job),
        "kind": kind_of(reason),
        "reason": reason,
        "detail": (detail or "")[:400],
        "questions": [q[:300] for q in (questions or []) if q and q.strip()][:12],
        "screenshot": screenshot,
        "status": OPEN,
        "created": _now(),
        "updated": _now(),
    }
    with file_lock(_path()):
        items = _load()
        for old in items:
            if old["job"].get("id") == item["job"]["id"] and old.get("status") in (OPEN, REQUEUED, TAKEN):
                item["id"], item["created"] = old["id"], old["created"]
                old.update(item)
                _save(items)
                return old
        items.append(item)
        _save(items)
    return item


def items(open_only: bool = True) -> list[dict]:
    rows = _load()
    if open_only:
        rows = [i for i in rows if i.get("status") in (OPEN, REQUEUED)]
    return sorted(rows, key=lambda i: i.get("updated", ""), reverse=True)


def count_open() -> int:
    return sum(1 for i in _load() if i.get("status") == OPEN)


def take_requeued() -> list[dict]:
    """Runner side: the postings Mission Control asked to retry, marked taken so they run once."""
    path = _path()
    if not path.exists():
        return []
    with file_lock(path):
        rows = _load()
        taken = [i for i in rows if i.get("status") == REQUEUED]
        for i in taken:
            i["status"], i["updated"] = TAKEN, _now()
        if taken:
            _save(rows)
    return taken


def finished(job_id: str) -> None:
    """Runner side: a retried posting went through; its item is closed."""
    path = _path()
    if not path.exists():
        return
    with file_lock(path):
        rows = _load()
        hit = False
        for i in rows:
            if i["job"].get("id") == job_id and i.get("status") in (OPEN, REQUEUED, TAKEN):
                i["status"], i["updated"] = CONFIRMED, _now()
                hit = True
        if hit:
            _save(rows)


def resolve(item_id: str, action: str, answers: dict | None = None, *, remember=None,
            confirm=None, unflag=None) -> tuple[int, dict]:
    """Mission Control's buttons. `answers` maps question label -> typed answer (action "resume").

    remember(items, company), confirm(job) and unflag(job) are injectable for tests; by default they
    write custom_answers.json and internship_tracker.xlsx.
    """
    if action not in ACTIONS:
        return 400, {"error": "action must be one of: " + ", ".join(ACTIONS)}
    if not isinstance(item_id, str) or not re.fullmatch(r"[0-9a-f]{12}", item_id):
        return 400, {"error": "bad item id"}
    with file_lock(_path()):
        rows = _load()
        item = next((i for i in rows if i["id"] == item_id), None)
        if item is None:
            return 404, {"error": "no such item"}
        if item.get("status") not in (OPEN, REQUEUED):
            return 409, {"error": f"already {item.get('status')}"}
        if item.get("status") == REQUEUED and action != "dismiss":   # a queued retry can still be cancelled
            return 409, {"error": "already queued for retry"}
        job = item["job"]
        learned = 0
        if action == "confirm":
            if item["kind"] != "receipt":
                return 409, {"error": "Confirm Submitted is only for a submission whose e-mail did not arrive"}
            try:
                (confirm or confirm_in_tracker)(job)
            except OSError as exc:
                return 423, {"error": f"{config.TRACKER_XLSX.name} is locked ({type(exc).__name__}); close it in Excel"}
            item["status"] = CONFIRMED
        elif action == "dismiss":
            item["status"] = DISMISSED
        else:
            if action == "resume":
                typed = [{"label": q, "kind": "text", "value": str(v).strip()[:2000]}
                         for q, v in (answers or {}).items()
                         if isinstance(q, str) and q in item["questions"] and str(v or "").strip()]
                if not typed:
                    return 400, {"error": "type an answer for at least one question"}
                learned = (remember or _remember)(typed, job.get("company", ""))
            if item["kind"] == "receipt":
                try:
                    (unflag or unflag_in_tracker)(job)        # its Unverified row goes; a new one follows the retry
                except OSError as exc:
                    return 423, {"error": f"{config.TRACKER_XLSX.name} is locked ({type(exc).__name__}); close it in Excel"}
            item["status"] = REQUEUED
        item["updated"] = _now()
        _save(rows)
    return 200, {"ok": True, "item": item, "learned": learned}


def _remember(typed: list[dict], company: str) -> int:
    from answers import remember_answers
    return remember_answers(typed, company)


# ---- the tracker side of a missing receipt -------------------------------------------------- #

def _unverified_match(job: dict):
    import dedup
    url = dedup.canonical_url(job.get("url"))
    company, role = dedup.normalize_company(job.get("company")), dedup.normalize_role(job.get("title"))

    def match(row: dict) -> bool:
        if str(row.get("Current Status") or "").strip() != config.UNVERIFIED_STATUS:
            return False
        notes = str(row.get("Next Step / Notes") or "")
        if url and dedup.canonical_url(dedup._first_url(notes)) == url:
            return True
        return (dedup.normalize_company(row.get("Company")), dedup.normalize_role(row.get("Role"))) == (company, role)
    return match


def confirm_in_tracker(job: dict, path: Path | None = None) -> None:
    """The candidate checked: it was submitted. The Unverified row becomes an application
    (or one is added, if the workbook was locked when the row should have been written)."""
    import dedup
    path = Path(path or config.TRACKER_XLSX)
    today = date.today().isoformat()
    changed = dedup.update_tracker_rows(_unverified_match(job), {
        "Current Status": config.XLSX_APPLIED_STATUS, "Status Date": today,
        "Next Step / Notes": f"Confirmed submitted by the candidate in Mission Control ({today}); "
                             f"no confirmation e-mail was found. {job.get('url', '')}",
    }, path)
    if not changed:
        dedup.append_to_tracker_xlsx({
            "Company": job.get("company"), "Role": job.get("title") or None, "Cycle": "Summer 2027",
            "Date Applied": today, "Current Status": config.XLSX_APPLIED_STATUS, "Status Date": today,
            "Application ID / Ref": None, "Source Email Subject": None,
            "Next Step / Notes": f"Confirmed submitted by the candidate in Mission Control ({today}). "
                                 f"{job.get('url', '')}",
        }, path)


def unflag_in_tracker(job: dict, path: Path | None = None) -> int:
    import dedup
    path = Path(path or config.TRACKER_XLSX)
    if not path.exists():
        return 0
    return dedup.delete_from_tracker_xlsx(_unverified_match(job), path, limit=1)
