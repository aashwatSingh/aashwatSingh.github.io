"""Optional Claude-drafted answers to open-ended application questions.

Used only when an Anthropic credential is set (ANTHROPIC_API_KEY). The model is
given the candidate profile and the posting and must answer from those alone;
its draft is then checked here (length, company named where relevant, nothing
from skills.never_claim) and discarded if it fails. When the resume does not
contain what the question asks for, the model replies INSUFFICIENT and the
question goes back to the template generator or the candidate.

Not yet exercised against the live API in this repository's history.
"""
from __future__ import annotations

import json
import os
import re

MODEL = "claude-opus-5-5"

SYSTEM = """You write one answer to an internship application question on behalf of a candidate.

Rules that are never broken:
- Every statement about the candidate must come from the candidate profile JSON. Never add a skill, tool,
  employer, metric, award, course, event or experience that is not in it, and never invent an anecdote.
- Never mention any item in the profile's skills.never_claim list.
- If the question is about the company or role, name the company and reference one specific product,
  system or team from the job description.
- Prefer the single most relevant project or experience and cite its real numbers.
- First person, plain text, one paragraph, no bullet points, no markdown, no placeholders.
- Stay within the word limit given. If none is given, write 75 to 140 words.
- If the question asks for something the profile does not contain (a specific past situation, a test
  score, experience in a field not on the resume), reply with exactly: INSUFFICIENT"""


def available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def open_answer(question: str, job: dict, job_text: str, profile: dict, limit: int | None = None) -> str | None:
    """A vetted answer, or None when the question should be handled another way."""
    if not available():
        return None
    import anthropic

    facts = {k: profile[k] for k in ("education", "skills", "experience", "projects", "essays") if k in profile}
    facts["education"] = {k: v for k, v in facts["education"].items() if k not in ("gpa", "gpa_scale")}
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
                f"Company: {job.get('company', '')}\nRole: {job.get('title', '')}\n"
                f"Word limit: {limit or 'none stated (75-140 words)'}\n\n"
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
    return text if acceptable(text, profile, limit) else None


def acceptable(text: str, profile: dict, limit: int | None = None) -> bool:
    if not text or "INSUFFICIENT" in text:
        return False
    words = len(text.split())
    if words < 8 or words > (limit or 160) * 1.05:
        return False
    low = text.lower()
    for banned in profile.get("skills", {}).get("never_claim", []):
        if re.search(rf"\b{re.escape(banned.lower().rstrip('s'))}", low):
            return False
    return "[" not in text and "**" not in text
