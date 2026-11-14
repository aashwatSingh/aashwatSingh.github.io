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
    resume = Path(profile.get("resume_path", ""))
    if not resume.is_absolute():
        resume = BASE / resume
    profile["resume_path"] = str(resume)
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


def load_dotenv(path: Path | None = None) -> None:
    """KEY=value lines from .env (git-ignored) into the environment; existing variables win."""
    path = path or BASE / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip().removeprefix("export ").strip(), value.strip().strip("'\""))


load_dotenv()


def ensure_dirs() -> None:
    for d in (LOG_DIR, MANUAL_REVIEW_DIR, SUBMITTED_DIR, CACHE_DIR):
        d.mkdir(parents=True, exist_ok=True)
