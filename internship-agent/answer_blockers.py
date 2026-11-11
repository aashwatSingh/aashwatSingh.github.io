"""Answer, once, the questions that still stop forms.

    python agent_runner.py --dry-run --dedup-level role     # collect what is still unanswered
    python report.py                                        # writes blocking_questions.json
    python answer_blockers.py                               # this tool

Part 1 asks for the profile values that unlock whole groups of questions (citizenship status,
consents, ...) and saves them to candidate_profile.json.
Part 2 walks through the remaining blocking questions, most common first, and saves your answers
to custom_answers.json, where the answer engine looks before anything else.

Press Enter to skip a question, type q to stop. Everything answered so far is saved either way.
Questions that ask you to attest to authorship or AI use are never offered here: those are
answered by you, on the form, each time.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Callable, Iterable

import config
import report
from answers import AI_POLICY, CHOICE_KINDS, AnswerEngine, Context, Question, load_custom_answers, pattern_for

# (profile path, type, question) - asked only while the value is still null
PROFILE_FIELDS = [
    ("work_authorization.citizenship_status", "text",
     "Citizenship / immigration status as you would state it on a form "
     "(e.g. 'U.S. Citizen', 'Permanent Resident', 'F-1 student visa')"),
    ("work_authorization.us_person", "bool",
     "Are you a 'U.S. person' for export-control (ITAR/EAR) purposes: citizen, green-card holder, refugee or asylee?"),
    ("work_authorization.internship_work_authorization", "text",
     "When a form lists categories for THIS internship (e.g. J1 / F1 / None), which applies to you?"),
    ("work_authorization.future_sponsorship_visa", "text",
     "When a form lists visas you may need sponsored LATER (e.g. OPT / H1B / TN / None), which applies?"),
    ("work_authorization.requires_sponsorship_now", "bool",
     "Do you need employer sponsorship right now (answer n if only in the future)?"),
    ("logistics.has_prior_internship", "bool", "Do your earlier roles count as prior internship / co-op experience?"),
    ("logistics.prior_internship_count", "int", "How many prior internships have you had? (a number)"),
    ("logistics.pursuing_further_education_after_degree", "bool",
     "Are you planning further education immediately after this degree?"),
    ("logistics.travel_percentage", "int", "What percentage of the time are you willing to travel? (a number)"),
    ("logistics.outside_business_activities", "bool",
     "Do you own, operate or provide services to any other business or organization?"),
    ("logistics.consents_to_background_check", "bool", "Do you consent to a background check when a form asks?"),
    ("logistics.consents_to_interview_recording", "bool",
     "Do you consent to interviews being recorded or transcribed by an AI note-taker?"),
    ("logistics.accept_arbitration_agreements", "bool",
     "Do you accept a mandatory arbitration agreement when a form requires one?"),
    ("education.high_school_name", "text", "High school name"),
    ("education.high_school_graduation", "text", "High school graduation (e.g. 05/2024)"),
    ("education.school_email", "text", "University e-mail address"),
    ("education.sat_score", "text", "SAT score (Enter keeps answering N/A)"),
    ("education.act_score", "text", "ACT score (Enter keeps answering N/A)"),
    ("spoken_languages", "list", "Languages you speak, comma separated"),
]


class Quit(Exception):
    pass


def _get(profile: dict, path: str):
    node = profile
    for part in path.split("."):
        node = node.get(part) if isinstance(node, dict) else None
    return node


def _set(profile: dict, path: str, value) -> None:
    parts = path.split(".")
    node = profile
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = value


def _parse(kind: str, raw: str):
    raw = raw.strip()
    if kind == "bool":
        if raw.lower() in ("y", "yes", "true"):
            return True
        if raw.lower() in ("n", "no", "false"):
            return False
        raise ValueError("answer y or n")
    if kind == "int":
        return int(raw)
    if kind == "list":
        return [x.strip() for x in raw.split(",") if x.strip()]
    return raw


def ask_profile_fields(profile: dict, ask: Callable[[str], str], say=print) -> int:
    changed = 0
    for path, kind, question in PROFILE_FIELDS:
        if _get(profile, path) is not None:
            continue
        hint = {"bool": " [y/n]", "int": " [number]", "list": "", "text": ""}[kind]
        while True:
            raw = ask(f"\n{question}{hint}\n  ({path}) > ")
            if raw.strip().lower() == "q":
                raise Quit
            if not raw.strip():
                break
            try:
                _set(profile, path, _parse(kind, raw))
                changed += 1
                break
            except ValueError as exc:
                say(f"  {exc}")
    return changed


def company_scope(blocker: dict) -> str | None:
    """Answers that only make sense for one employer are stored for that employer only."""
    label = blocker["label"].lower()
    named = [c for c in blocker.get("companies", []) if len(c) > 2 and c.lower() in label]
    if named:
        return "^" + re.escape(named[0]) + "$"
    if len(blocker.get("companies", [])) == 1 and blocker.get("kind") == "textarea":
        return "^" + re.escape(blocker["companies"][0]) + "$"
    return None


def askable(blocker: dict) -> bool:
    return not (blocker.get("kind") == "file" or blocker.get("profile_key") or AI_POLICY.search(blocker["label"])
                or blocker.get("rule") == "x-human-only" or not blocker["label"].strip())


def ask_blockers(blockers: Iterable[dict], engine: AnswerEngine, custom: list[dict],
                 ask: Callable[[str], str], say=print) -> int:
    added = 0
    for b in blockers:
        if not askable(b):
            continue
        q = Question(label=b["label"], kind=b.get("kind") or "text", required=True, options=b.get("options") or [])
        company = (b.get("companies") or [""])[0]
        if engine.resolve(q, Context(company=company)).action != "unknown":
            continue                                    # already answered by the profile or an earlier answer
        multi = q.kind in ("multiselect", "checkbox_group")
        say(f"\n[{b['count']} posting(s): {', '.join(b.get('companies', [])[:3])}]\n{b['label'][:600]}")
        if q.kind in CHOICE_KINDS and q.options:
            for i, o in enumerate(q.options, 1):
                say(f"   {i}. {o}")
            prompt = "  numbers separated by commas > " if multi else "  number > "
        elif q.kind in CHOICE_KINDS:
            prompt = "  the option text exactly as it appears on the form > "
        else:
            prompt = "  your answer > "
        while True:
            raw = ask(prompt).strip()
            if raw.lower() == "q":
                raise Quit
            if not raw:
                break
            try:
                if q.kind in CHOICE_KINDS and q.options:
                    picks = [q.options[int(x) - 1] for x in re.split(r"[,\s]+", raw) if x]
                    if any(int(x) < 1 for x in re.split(r"[,\s]+", raw) if x) or (len(picks) != 1 and not multi):
                        raise ValueError
                    answer = picks if multi else picks[0]
                else:
                    answer = raw
            except (ValueError, IndexError):
                say("  enter the number of an option (or Enter to skip)")
                continue
            entry = {"pattern": pattern_for(b["label"]), "answer": answer}
            scope = company_scope(b)
            if scope:
                entry["company"] = scope
            custom[:] = [e for e in custom if not (e.get("pattern") == entry["pattern"]
                                                   and e.get("company") == entry.get("company"))]
            custom.append(entry)
            engine.custom = custom
            added += 1
            break
    return added


def save(profile: dict, custom: list[dict], profile_path: Path, custom_path: Path) -> None:
    profile_path.write_text(json.dumps(profile, indent=2, ensure_ascii=False), encoding="utf-8")
    custom_path.write_text(json.dumps(custom, indent=1, ensure_ascii=False), encoding="utf-8")


def main(ask: Callable[[str], str] = input, say=print) -> int:
    profile_path, custom_path = config.PROFILE_PATH, config.CUSTOM_ANSWERS_JSON
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    custom = load_custom_answers(custom_path)
    path = config.BASE / "blocking_questions.json"
    blockers = json.loads(path.read_text(encoding="utf-8")) if path.exists() \
        else report.summarise(report.load_attempts())["blockers"]
    say(f"{len(blockers)} blocking questions on record. Enter skips, q stops and saves.")
    changed = added = 0
    try:
        say("\n== Part 1: profile values that unlock groups of questions ==")
        changed = ask_profile_fields(profile, ask, say)
        engine = AnswerEngine(_with_paths(profile), custom)
        say("\n== Part 2: individual questions ==")
        added = ask_blockers(blockers, engine, custom, ask, say)
    except (Quit, EOFError):
        say("\nstopping early")
    save(profile, custom, profile_path, custom_path)
    say(f"\nsaved {changed} profile value(s) to {profile_path.name} and {added} answer(s) to {custom_path.name}")
    return 0


def _with_paths(profile: dict) -> dict:
    """The engine expects resume_path resolved, as config.load_profile() does."""
    p = json.loads(json.dumps(profile))
    resume = Path(p.get("resume_path", ""))
    p["resume_path"] = str(resume if resume.is_absolute() else config.BASE / resume)
    return p


if __name__ == "__main__":
    sys.exit(main())
