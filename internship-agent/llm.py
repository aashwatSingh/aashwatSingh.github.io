"""Optional Claude-written "Why do you want to intern at <company>?" answers.

Only used when ANTHROPIC_API_KEY (or another Anthropic credential) is set, and
only for that one question type, following the template in section 8.2 of the
agent prompt. The draft is rejected (and the posting sent to manual review)
unless it passes the zero-fabrication checks below.
"""
from __future__ import annotations

import json
import os
import re

WHY_COMPANY = re.compile(
    r"^why (do you want|are you interested|would you like|did you apply|us\b|.{1,40}\?$)|"
    r"why .{0,40}(intern|work|join) (at|with|for)|what (interests|excites|attracts|draws) you (about|to)", re.I)

MODEL = "claude-opus-5-5"

SYSTEM = """You write one short answer to an internship application question on behalf of a candidate.

Rules that are never broken:
- Use only facts from the candidate profile JSON you are given. Never add a skill, tool, employer, \
metric, award or experience that is not in it.
- Never mention any item in the profile's skills.never_claim list.
- Mention the company by name and one specific product, system or team taken from the job description.
- Pick the single most relevant experience or project from the profile and cite its real numbers.
- 75 to 140 words, first person, plain text, one paragraph, no bullet points, no markdown.
- If the job description gives you nothing specific to reference, reply with exactly: INSUFFICIENT"""


def available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def why_company_answer(question: str, job: dict, job_text: str, profile: dict) -> str | None:
    """Return a vetted answer, or None when it should go to a human instead."""
    if not available() or not WHY_COMPANY.search(question.strip()):
        return None
    import anthropic

    facts = {k: profile[k] for k in ("education", "skills", "experience", "essays") if k in profile}
    facts["projects_note"] = "Projects are described inside essays and experience; use nothing else."
    client = anthropic.Anthropic()
    try:
        response = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            output_config={"effort": "medium"},
            # If a safety classifier declines, let the API retry on its default fallback model.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=SYSTEM,
            messages=[{"role": "user", "content": (
                f"Company: {job['company']}\nRole: {job['title']}\n\n"
                f"Application question: {question}\n\n"
                f"Candidate profile (JSON):\n{json.dumps(facts, ensure_ascii=False)}\n\n"
                f"Job description:\n{job_text[:12000]}")}],
        )
    except anthropic.RateLimitError:
        return None
    except anthropic.APIStatusError:
        return None
    except anthropic.APIConnectionError:
        return None
    if response.stop_reason in ("refusal", "max_tokens"):
        return None
    text = " ".join(b.text for b in response.content if b.type == "text").strip()
    return text if _acceptable(text, job, profile) else None


def _acceptable(text: str, job: dict, profile: dict) -> bool:
    if not text or text.startswith("INSUFFICIENT"):
        return False
    words = len(text.split())
    if not 60 <= words <= 150:
        return False
    low = text.lower()
    if job["company"].lower() not in low:
        return False
    for banned in profile.get("skills", {}).get("never_claim", []):
        if re.search(rf"\b{re.escape(banned.lower().rstrip('s'))}", low):
            return False
    return "[" not in text and "**" not in text
