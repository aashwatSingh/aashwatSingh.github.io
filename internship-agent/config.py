"""Shared paths, constants and the candidate profile loader.

Everything personal (profile, resume, tracker, ledgers, logs) lives next to
this file but is git-ignored: this repository is published by GitHub Pages.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

BASE = Path(os.environ.get("INTERNSHIP_AGENT_HOME", Path(__file__).resolve().parent))

PROFILE_PATH = BASE / "candidate_profile.json"
PROFILE_EXAMPLE_PATH = BASE / "candidate_profile.example.json"
PROMPT_PATH = BASE / "swe_internship_agent_prompt.md"
TRACKER_XLSX = BASE / "internship_tracker.xlsx"
LEDGER_CSV = BASE / "applied_tracker.csv"
QUEUE_JSON = BASE / "job_queue.json"
MANUAL_REVIEW_CSV = BASE / "manual_review_queue.csv"
UNCONFIRMED_CSV = BASE / "unconfirmed_applications.csv"
# Submitted applications whose workbook row could not be written yet (Excel had it open),
# with the confirmation e-mail that proved them, so the late row still carries its subject.
PENDING_XLSX_JSON = BASE / "pending_xlsx.json"
CUSTOM_ANSWERS_JSON = BASE / "custom_answers.json"
RUN_STATE_JSON = BASE / "run_state.json"
LOG_DIR = BASE / "logs"
MANUAL_REVIEW_DIR = LOG_DIR / "manual_review"
SUBMITTED_DIR = LOG_DIR / "submitted"
BROWSER_PROFILE_DIR = BASE / ".browser_profile"
CACHE_DIR = BASE / ".cache"

TARGET_TOTAL = 500
PAGE_TIMEOUT_S = 90          # spec: give up on a listing after 90 s
CONFIRM_TIMEOUT_S = 10       # spec: wait up to 10 s for a confirmation

LEDGER_COLUMNS = ["Timestamp", "Company", "Role", "Location", "ATS_Platform", "URL", "Status"]
MANUAL_REVIEW_COLUMNS = ["Timestamp", "Company", "Role", "ATS_Platform", "URL", "Reason", "Detail", "Screenshot"]

# Status the tracker workbook already uses for a fresh application; its
# summary COUNTIF formulas key off this exact string.
XLSX_APPLIED_STATUS = "Application submitted / Awaiting response"
LEDGER_APPLIED_STATUS = "Applied"
# Submitted in the browser, but no confirmation e-mail arrived: kept on a hold list
# (UNCONFIRMED_CSV) and never counted toward TARGET_TOTAL.
UNCONFIRMED_STATUS = "Application incomplete / Unconfirmed"
UNCONFIRMED_COLUMNS = ["Timestamp", "Company", "Role", "ATS_Platform", "URL", "Status", "Detail"]
# The same submission, as it appears in internship_tracker.xlsx: a row with this status is visible
# in the workbook but is not an application yet. Mission Control's "Confirm Submitted" turns it into
# XLSX_APPLIED_STATUS; "Retry" removes it and puts the posting back in the queue.
UNVERIFIED_STATUS = "Unverified / Needs Check"

# Postings that stopped on something only the candidate can clear (Mission Control's Unblock Queue).
UNBLOCK_JSON = BASE / "unblock_queue.json"

RECEIPT_TIMEOUT_DEFAULT_S = 120

# The one resume every application attaches. RESUME_PDF in .env overrides it (a file name next to this folder,
# or a full path). candidate_profile.json's old "resume_path" is ignored, so there is one place to change it.
RESUME_PDF_DEFAULT = "Aashwat_Singh_SWE_Resume_ATS.pdf"


def resume_pdf() -> Path:
    name = os.environ.get("RESUME_PDF", "").strip().strip("'\"") or RESUME_PDF_DEFAULT
    path = Path(name)
    return path if path.is_absolute() else BASE / path


def queue_refresh_hours() -> float:
    """job_queue.json is re-read from the listing sources at the start of a run when it was last refreshed this
    many hours ago or more (QUEUE_REFRESH_HOURS in .env, 1-168, default 6)."""
    return float(_env_seconds("QUEUE_REFRESH_HOURS", 6, 1, 168))


def receipt_timeout_s() -> int:
    """How long the confirmation gate waits for the receipt e-mail: RECEIPT_TIMEOUT_S in .env (30-600)."""
    try:
        value = int(float(os.environ.get("RECEIPT_TIMEOUT_S", RECEIPT_TIMEOUT_DEFAULT_S)))
    except ValueError:
        value = RECEIPT_TIMEOUT_DEFAULT_S
    return max(30, min(600, value))


def _env_seconds(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(float(os.environ.get(name, default)))
    except ValueError:
        value = default
    return max(low, min(high, value))


def phone_ask_wait_s() -> int:
    """With phone assist on, how long a missing-receipt question waits for your reply before the posting is
    flagged Unverified and the batch moves on. PHONE_ASK_WAIT_S in .env (60-3600, default 600)."""
    return _env_seconds("PHONE_ASK_WAIT_S", 600, 60, 3600)


def freeze_stall_s() -> int:
    """No progress for this long = "appears stuck" on the phone. FREEZE_STALL_S in .env (30-1800, default 120)."""
    return _env_seconds("FREEZE_STALL_S", 120, 30, 1800)


def receipt_on_timeout() -> str:
    """'queue' (default): flag Unverified, add to the Unblock Queue and move on.
    'ask': pause the batch and ask (terminal or Mission Control) what to do. RECEIPT_ON_TIMEOUT in .env."""
    value = os.environ.get("RECEIPT_ON_TIMEOUT", "queue").strip().lower()
    return value if value in ("queue", "ask") else "queue"

USER_AGENT_NOTE = "internship-agent"


class ProfileError(RuntimeError):
    pass


def load_profile(path: Path | None = None) -> dict:
    path = Path(path or PROFILE_PATH)
    if not path.exists():
        raise ProfileError(
            f"{path.name} not found. Copy {PROFILE_EXAMPLE_PATH.name} to {path.name} "
            "and fill in your details (it is git-ignored)."
        )
    profile = json.loads(path.read_text(encoding="utf-8"))
    profile["resume_path"] = str(resume_pdf())         # always the one configured resume (RESUME_PDF)
    # Essays and behavioural stories can live in the git-tracked shared_answers.json; the profile wins.
    shared = BASE / "shared_answers.json"
    if shared.exists():
        try:
            data = json.loads(shared.read_text(encoding="utf-8"))
        except ValueError:
            data = {}
        for block in ("essays", "behavioral"):
            merged = dict(data.get(block) or {})
            merged.update(profile.get(block) or {})
            if merged:
                profile[block] = merged
    # Password may come from the environment instead of the file.
    env_pw = os.environ.get("ATS_PORTAL_PASSWORD")
    if env_pw:
        profile.setdefault("portal", {})["password"] = env_pw
    return profile


def read_dotenv(path: Path | None = None) -> dict[str, str]:
    """KEY=value lines from .env (git-ignored), read fresh from disk. {} when there is no .env."""
    path = path or BASE / ".env"
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for line in lines:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip().removeprefix("export ").strip()] = value.strip().strip("'\"")
    return values


def load_dotenv(path: Path | None = None) -> None:
    """.env into the environment; variables already set in the environment win."""
    for key, value in read_dotenv(path).items():
        os.environ.setdefault(key, value)


load_dotenv()


def ensure_dirs() -> None:
    for d in (LOG_DIR, MANUAL_REVIEW_DIR, SUBMITTED_DIR, CACHE_DIR):
        d.mkdir(parents=True, exist_ok=True)
