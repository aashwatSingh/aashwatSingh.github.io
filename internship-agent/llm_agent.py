"""Optional browser-use fallback for portals without a deterministic adapter
(Workday, iCIMS, SmartRecruiters, Taleo, ...). Requires:

    pip install browser-use anthropic
    export ANTHROPIC_API_KEY=...
    python agent_runner.py --ats all

The agent gets swe_internship_agent_prompt.md as background, but the rules in
GUARDRAILS below are appended last and win: one posting per run, no invented
answers, and no bypassing of CAPTCHAs or "confirm you're a human" codes.

NOTE: written against browser-use 1.0.x. It has not been exercised end to end
(that needs an API key and network access to the portals); treat the first runs
as supervised and use --dry-run first.
"""
from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel

import config
from ats.base import CLOSED, DRY_RUN_OK, ERROR, MANUAL_REVIEW, SKIPPED_INELIGIBLE, SUBMITTED, ApplyResult

MODEL = "claude-opus-5-5"

GUARDRAILS = """
OVERRIDING RULES FOR THIS RUN (they replace anything above that conflicts):
1. Handle exactly ONE posting: the URL in the task. Do not look for other jobs and do not loop.
2. Answer only from the candidate profile JSON in the task. If a REQUIRED question is not answered by
   it (citizenship, visa type, clearance, test scores, skill ratings, years of experience, anything
   company-specific you would have to make up), do not guess: stop and report manual_review with the
   question text in `unanswered`. Leave optional questions you cannot answer blank.
3. Never claim experience with anything in skills.never_claim.
4. Never solve, bypass or work around a CAPTCHA, and never enter an emailed or texted verification
   code or any other "confirm you are human" step. If one appears, stop and report manual_review.
5. Leave GPA blank unless the field is required.
6. If the posting is closed, report closed. If it requires U.S. citizenship, a security clearance, or
   is only for graduate students, report skipped_ineligible.
7. Type the portal password only with type_secret('portal_password').
"""


class Outcome(BaseModel):
    status: Literal["submitted", "ready_not_submitted", "manual_review", "skipped_ineligible", "closed"]
    reason: str
    unanswered: list[str] = []
    confirmation_text: str = ""


_STATUS = {"submitted": SUBMITTED, "ready_not_submitted": DRY_RUN_OK, "manual_review": MANUAL_REVIEW,
           "skipped_ineligible": SKIPPED_INELIGIBLE, "closed": CLOSED}


def _system_prompt(password: str) -> str:
    text = config.PROMPT_PATH.read_text(encoding="utf-8") if config.PROMPT_PATH.exists() else ""
    if password:
        text = text.replace(password, "<secret:portal_password>")   # never send the password as prompt text
    return text + "\n" + GUARDRAILS


async def apply(context, job: dict, profile: dict, *, dry_run: bool, shot_path: str,
                headless: bool = True) -> ApplyResult:
    from browser_use import Agent, Browser, ChatAnthropic

    password = profile.get("portal", {}).get("password", "")
    public = {k: v for k, v in profile.items() if k != "portal"}
    public["portal"] = {"username": profile.get("portal", {}).get("username", "")}
    finish = ("Fill the whole application but DO NOT click the final submit button; report "
              "ready_not_submitted." if dry_run else
              "Submit the application and wait for the confirmation; report submitted only if you saw it.")
    task = (f"Apply to this internship posting: {job['url']}\n"
            f"Company: {job['company']}\nRole: {job['title']}\n"
            f"Resume file to upload: {profile['resume_path']}\n{finish}\n\n"
            f"Candidate profile (JSON):\n{json.dumps(public, ensure_ascii=False)}")

    # A local Chromium: browser-use's CAPTCHA solver only exists on its cloud browser, which is not used.
    browser = Browser("chromium", headless=headless, user_data_dir=str(config.BASE / ".browser_profile_llm"))
    agent = Agent(task, ChatAnthropic(MODEL), browser=browser, output_model_schema=Outcome,
                  sensitive_data={"portal_password": password} if password else None,
                  extend_system_message=_system_prompt(password))
    try:
        history = await agent.run(max_steps=80, timeout=900)
    except Exception as exc:                                   # noqa: BLE001 - keep the loop alive
        return ApplyResult(ERROR, type(exc).__name__, str(exc)[:300])
    outcome = history.structured_output
    if outcome is None:
        return ApplyResult(MANUAL_REVIEW, "LLM_NO_RESULT", str(history.final_result())[:300])
    if isinstance(outcome, dict):
        outcome = Outcome(**outcome)
    status = _STATUS[outcome.status]
    if status == SUBMITTED and not outcome.confirmation_text:
        status = MANUAL_REVIEW                                  # no evidence of a confirmation page
    return ApplyResult(status, outcome.reason[:200], " | ".join(outcome.unanswered)[:300],
                       unknowns=outcome.unanswered)
