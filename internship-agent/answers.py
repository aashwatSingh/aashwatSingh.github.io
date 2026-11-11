"""Question -> answer engine driven only by candidate_profile.json.

Zero-fabrication contract
-------------------------
``resolve()`` returns one of three decisions for every form question:

* ``fill``    – the profile (or custom_answers.json) states the answer.
* ``skip``    – the field is optional and should stay blank.
* ``unknown`` – the question is required and the profile does not answer it.

The runner never submits a form that has an ``unknown``; it sends the posting
to the manual-review queue with the unanswered questions listed. Nothing is
ever guessed: citizenship, visa type, clearance, skill ratings, years of
experience and company-specific essays are all ``unknown`` unless you add an
answer to custom_answers.json.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import config

FREE_KINDS = {"text", "textarea", "number", "date", "email", "tel", "url"}
CHOICE_KINDS = {"select", "radio", "multiselect", "boolean", "checkbox_group"}

MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]

# Open-ended prompts: only the essay rules may answer these, never a fact rule
# that happens to share a keyword ("...in your respective discipline?").
ESSAY_PROMPT = re.compile(
    r"^(why\b|describe\b|tell (us|me)\b|explain\b|share\b|in your own words|"
    r"what (excites|interests|motivates|drives|do you (hope|want|expect)|are you (most|looking)|would you)|"
    r"please (describe|share|tell|explain|provide a (summary|description|brief)))", re.I)
ESSAY_RULES = {"essay-project", "essay-why-swe", "follow-up", "never-answer", "x-school-confirm",
               "x-legal-name", "x-top-courses"}

# Attestations about AI use or authorship. A person must answer these, and the runner writes no
# essays on a form that carries one.
AI_POLICY = re.compile(
    r"\bai policy|use of (generative )?ai\b|ai[- ]generated|chatgpt|\bmy own (work|words|thinking|writing)|"
    r"reflects my own|written by (me|you)\b|without (the )?(use|help|assistance) of (generative )?ai|"
    r"(ai|llm) (tools?|assistance) (in|for|on|during|to complete) (this|the|your) application|"
    r"if (this is|you are|you're) (a |an )?(bot|ai\b|llm|language model|automated)", re.I)

US_CITY = (r"san francisco|bay area|new york|\bnyc\b|seattle|austin|boston|chicago|los angeles|dallas|houston|denver|"
           r"atlanta|palo alto|mountain view|sunnyvale|san jose|san mateo|menlo park|santa clara|redwood city|"
           r"san diego|pittsburgh|philadelphia|miami|washington,? d\.?c|bellevue|redmond|boulder|raleigh|durham|"
           r"salt lake city|portland|phoenix|detroit|minneapolis|nashville|el segundo|irvine|santa monica|oakland|"
           r"brooklyn|plano|frisco|richardson|irving|san antonio|columbus|charlotte|st\.? louis|kansas city")

DECLINE = re.compile(
    r"decline|prefer not|do not wish|don'?t wish|choose not|rather not|"
    r"not (to|wish to) (say|disclose|answer|identify|specify|self)|no answer", re.I)
NEGATION = re.compile(r"\bnot\b|n['’]t\b|\bno\b|\bnever\b|\bwithout\b", re.I)


@dataclass
class Question:
    label: str
    kind: str = "text"            # see FREE_KINDS / CHOICE_KINDS, plus "checkbox", "file"
    required: bool = False
    options: list[str] = field(default_factory=list)
    description: str = ""
    field_id: str = ""            # ATS field id / name, when it carries meaning
    placeholder: str = ""


@dataclass
class Decision:
    action: str                   # "fill" | "skip" | "unknown"
    value: object = None          # str, list[str] (multi), or True (checkbox)
    rule: str = ""
    note: str = ""

    @property
    def ok(self) -> bool:
        return self.action != "unknown"


@dataclass
class Context:
    company: str = ""
    title: str = ""
    applied_before: bool = False              # company already in the ledger
    labels: list[str] = field(default_factory=list)   # every label on the form
    locations: list[str] = field(default_factory=list)   # the posting's listed locations
    picked: list[str] = field(default_factory=list)      # office options already chosen on this form
    job_text: str = ""                                   # the posting's description, when the runner has it


# ----- intents returned by rules -------------------------------------------- #

@dataclass
class Text:
    value: str
    option_patterns: list[str] = field(default_factory=list)   # for choice fields


@dataclass
class YesNo:
    yes: bool
    option_patterns: list[str] = field(default_factory=list)   # non yes/no phrasing


@dataclass
class Choice:
    patterns: list[str]
    text: str | None = None       # value for free-text fields
    exclude: str | None = None


@dataclass
class Multi:                      # every option that equals one of these values
    values: list[str]
    text: str | None = None


class Skip:                       # leave blank (unknown when required)
    pass


@dataclass
class Unknown:
    reason: str = "not in the candidate profile"


@dataclass
class Check:                      # tick a consent checkbox / pick the affirmative option
    pass


# ----- helpers ---------------------------------------------------------------- #

def norm(text: str) -> str:
    text = (text or "").replace("’", "'").replace("✱", " ").replace("*", " ")
    text = re.sub(r"\((required|optional)\)", " ", text, flags=re.I)
    return " ".join(text.split()).strip().lower()


def _simple(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", norm(text)).strip()


def match_option(options: list[str], value: str) -> str | None:
    """Exact, then prefix, then containment match of a profile value against options."""
    want = _simple(value)
    if not want:
        return None
    simple = [(_simple(o), o) for o in options]
    for test in (lambda s: s == want,
                 lambda s: s.startswith(want + " ") or want.startswith(s + " "),
                 lambda s: f" {want} " in f" {s} "):
        hits = [o for s, o in simple if s and test(s)]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            return None
    return None


def pick_pattern(options: list[str], patterns: list[str], exclude: str | None = None) -> str | None:
    """First pattern (in priority order) that selects exactly one option."""
    pool = [o for o in options if not (exclude and re.search(exclude, o, re.I))]
    for pat in patterns:
        hits = [o for o in pool if re.search(pat, o.strip(), re.I)]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            # several match: prefer an exact / shortest unambiguous one
            hits.sort(key=len)
            if len(hits[0]) < len(hits[1]):
                return hits[0]
            return None
    return None


def pick_yes_no(options: list[str], want_yes: bool) -> str | None:
    """Pick the Yes/No-meaning option; None unless the mapping is unambiguous."""
    opts = [o for o in options if o.strip() and not DECLINE.search(o)]
    yes = [o for o in opts if re.match(r"\s*(yes|true|y)\b", o, re.I)]
    no = [o for o in opts if re.match(r"\s*(no|false|n)\b", o, re.I)]
    if len(yes) == 1 and len(no) == 1:
        return yes[0] if want_yes else no[0]
    # several qualified variants ("Yes", "Yes, but ..."): only the bare one is unambiguous
    bare = [o for o in (yes if want_yes else no) if re.fullmatch(r"\s*(yes|no|true|false|y|n)\.?\s*", o, re.I)]
    if len(bare) == 1 and (yes and no):
        return bare[0]
    if not want_yes and len(no) == 1 and yes:
        return no[0]                         # one "No", many kinds of "Yes - I was a ..."
    if not want_yes and not yes and not no and len(opts) >= 2:
        neg = [o for o in opts if NEGATION.search(o)]
        if len(neg) == 1:
            return neg[0]                    # "I have never worked for ..." among "I am a current ..." options
    if not yes and not no and len(opts) == 2:
        neg = [o for o in opts if NEGATION.search(o)]
        if len(neg) == 1:
            pos = [o for o in opts if o not in neg][0]
            return pos if want_yes else neg[0]
    return None


def money_option(options: list[str], annual: float | None, hourly: float | None) -> str | None:
    """Pick the pay bucket that contains the stated figure ('76-80k', '$35 - $40/hr', 'less than 25k')."""
    def numbers(text: str) -> list[float]:
        t = text.lower().replace("$", "").replace(",", "")
        t = re.sub(r"(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*k\b",
                   lambda m: f"{float(m.group(1)) * 1000:.0f} - {float(m.group(2)) * 1000:.0f}", t)
        t = re.sub(r"(\d+(?:\.\d+)?)\s*k\b", lambda m: f"{float(m.group(1)) * 1000:.0f}", t)
        return [float(x) for x in re.findall(r"\d+(?:\.\d+)?", t)]
    parsed = [(o, numbers(o)) for o in options]
    top = max((max(n) for _, n in parsed if n), default=0)
    value = annual if top >= 1000 else hourly if 0 < top <= 250 else None
    if not value:
        return None
    hits = []
    for o, nums in parsed:
        low = o.lower()
        if not nums:
            continue
        if len(nums) >= 2:
            ok = min(nums[:2]) <= value <= max(nums[:2])
        elif re.search(r"less than|under|below|up to|<", low):
            ok = value < nums[0]
        elif re.search(r"more than|over|above|at least|\+|>", low):
            ok = value >= nums[0]
        else:
            ok = value == nums[0]
        if ok:
            hits.append(o)
    return hits[0] if len(hits) == 1 else None


def gpa_option(options: list[str], gpa: float) -> str | None:
    hits = []
    for o in options:
        nums = [float(x) for x in re.findall(r"\d\.\d+|\d(?=\s*(?:\+|or|and|-|–|to)\b)|\b\d\b", o)]
        low = o.lower()
        if not nums:
            continue
        if len(nums) >= 2:
            ok = min(nums[:2]) <= gpa <= max(nums[:2])
        elif re.search(r"below|under|less than|lower than|<", low):
            ok = gpa < nums[0]
        elif re.search(r"above|over|greater|higher|at least|or (above|higher|more)|\+|>", low):
            ok = gpa >= nums[0]
        else:
            ok = abs(gpa - nums[0]) < 1e-9
        if ok:
            hits.append(o)
    return hits[0] if len(hits) == 1 else None


_MONTH_NUM = {m[:3].lower(): i + 1 for i, m in enumerate(MONTHS)}


def _long_date(iso: str) -> str:
    y, m, d = (int(x) for x in iso.split("-"))
    return f"{MONTHS[m - 1]} {d}, {y}"


def _within_window(label: str, logistics: dict) -> bool | None:
    """Do the dates a question mentions fall inside the stated availability?

    None  – the question names no dates (a general willingness question).
    True  – every date/month named is inside earliest_start..latest_end.
    False – something named is outside it (or in another year/season).
    """
    start, end = date.fromisoformat(logistics["earliest_start"]), date.fromisoformat(logistics["latest_end"])
    if re.search(r"\b(fall|autumn|winter|spring)\b", label):
        return False
    years = {int(y) for y in re.findall(r"\b(20\d\d)\b", label)}
    if years - {start.year}:
        return False
    found = False
    month_re = "|".join(m.lower() for m in MONTHS) + "|" + "|".join(_MONTH_NUM)
    for m in re.finditer(rf"\b({month_re})\.?(?:\s+(\d{{1,2}})(?:st|nd|rd|th)?\b)?", label):
        month = _MONTH_NUM[m.group(1)[:3]]
        if m.group(1) == "may" and not m.group(2) and not re.search(r"\bmay\b.{0,3}(-|–|to|through|\d|,)", label[m.start():]):
            continue                                   # the verb "may", not the month
        found = True
        if m.group(2):
            d = date(start.year, month, int(m.group(2)))
            if not start <= d <= end:
                return False
        elif not start.month <= month <= end.month:
            return False
    for m in re.finditer(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b", label):
        found = True
        try:
            d = date(start.year, int(m.group(1)), int(m.group(2)))
        except ValueError:
            return False
        if not start <= d <= end:
            return False
    return True if found else None


def _fmt_date(iso: str, q: Question) -> str:
    """Format YYYY-MM-DD for the field: ISO for date inputs, else follow the mask."""
    y, m, d = iso.split("-")
    if q.kind == "date":
        return iso
    hint = f"{q.placeholder} {q.label}".lower()
    if re.search(r"mm\s*/\s*yyyy|mm-yyyy", hint) and "dd" not in hint:
        return f"{m}/{y}"
    if "yyyy-mm-dd" in hint:
        return iso
    return f"{m}/{d}/{y}"


# ----- engine ---------------------------------------------------------------- #

class AnswerEngine:
    def __init__(self, profile: dict, custom_answers: list[dict] | None = None):
        self.p = profile
        self.custom = custom_answers if custom_answers is not None else load_custom_answers()

    # -- public ------------------------------------------------------------
    def resolve(self, q: Question, ctx: Context | None = None) -> Decision:
        ctx = ctx or Context()
        label = norm(q.label)

        custom = self._custom(q, label, ctx)
        if custom is not None:
            return custom

        if q.kind == "file":
            return self._file(q, label)

        essay_prompt = bool(ESSAY_PROMPT.search(label)) and q.kind not in CHOICE_KINDS | {"checkbox"}
        for name, pattern, handler in self._rules():
            if essay_prompt and name not in ESSAY_RULES:
                continue
            if pattern.search(label) or (q.field_id and pattern.search(norm(q.field_id.replace("_", " ")))
                                         and name in _ID_RULES):
                intent = handler(q, label, ctx)
                if intent is None:
                    continue
                return self._apply(intent, q, name)
        return self._apply(Skip(), q, "no-rule")

    # -- applying an intent to a concrete field -----------------------------
    def _apply(self, intent, q: Question, rule: str) -> Decision:
        def unknown(note: str) -> Decision:
            if not q.required:
                return Decision("skip", rule=rule, note=note)
            return Decision("unknown", rule=rule, note=note)

        if isinstance(intent, Unknown):
            return unknown(intent.reason)
        if isinstance(intent, Skip):
            return unknown("no answer in the candidate profile")

        is_choice = q.kind in CHOICE_KINDS
        multi = q.kind in ("multiselect", "checkbox_group")
        wrap = (lambda v: [v]) if multi else (lambda v: v)

        if isinstance(intent, Check):
            if q.kind == "checkbox":
                return Decision("fill", True, rule)
            if is_choice:
                real = [o for o in q.options if o.strip()]
                if len(real) == 1:
                    return Decision("fill", wrap(real[0]), rule)
                hit = pick_pattern(q.options, [
                    r"^(i )?(acknowledge|agree|accept|consent|confirm|certify|understand|have read)",
                    r"^yes\b", r"acknowledge|agree|accept|consent|confirm"],
                    exclude=r"\b(do not|don't|disagree|decline)\b")
                return Decision("fill", wrap(hit), rule) if hit else unknown("no affirmative option found")
            return unknown("acknowledgement expects typed text")

        if isinstance(intent, YesNo):
            if q.kind == "checkbox":
                return Decision("fill", True, rule) if intent.yes else Decision("skip", rule=rule)
            if is_choice:
                hit = pick_yes_no(q.options, intent.yes) or pick_pattern(q.options, intent.option_patterns)
                real = [o for o in q.options if o.strip()]
                if not hit and intent.yes and (len(real) == 1 or not pick_yes_no(q.options, False)):
                    hit = pick_pattern(real, [r"^(i )?(understand|acknowledge|agree|confirm|accept)\b", r"^yes\b"],
                                       exclude=r"\b(do not|don't|cannot|unable|disagree)\b")
                return Decision("fill", wrap(hit), rule) if hit else unknown(
                    f"wanted {'Yes' if intent.yes else 'No'} but options are {q.options}")
            if q.kind in ("text", "textarea") and (re.match(
                    r"(are|do|does|will|would|have|has|can|could|is|did|were)\b", norm(q.label)) or re.search(
                    r"\b(are|do|will|would|can|could) you\b[^.?]*\?\s*$", norm(q.label))):
                return Decision("fill", "Yes" if intent.yes else "No", rule)
            return unknown("yes/no answer does not fit this field type")

        if isinstance(intent, Choice):
            if is_choice:
                hit = pick_pattern(q.options, intent.patterns, intent.exclude)
                return Decision("fill", wrap(hit), rule) if hit else unknown(
                    f"no matching option among {q.options}")
            if intent.text is not None:
                return Decision("fill", intent.text, rule)
            return unknown("free-text field with no stated answer")

        if isinstance(intent, Multi):
            if is_choice:
                wanted = {_simple(v) for v in intent.values}
                hits = [o for o in q.options if _simple(o) in wanted]
                if not hits and multi:
                    def mentions(option: str, value: str) -> bool:
                        return bool(re.search(rf"(?<![a-z0-9+#]){re.escape(value.lower())}(?![a-z0-9+#]| native)",
                                              option.lower()))
                    hits = [o for o in q.options if any(mentions(o, v) for v in intent.values if len(v) > 1)]
                if not hits:
                    return unknown(f"none of {intent.values} among {q.options}")
                return Decision("fill", hits if multi else hits[0], rule) if (multi or len(hits) == 1) \
                    else unknown("several profile values match a single-choice question")
            return Decision("fill", intent.text or ", ".join(intent.values), rule)

        if isinstance(intent, Text):
            if not intent.value:
                return unknown("empty in profile")
            if is_choice:
                hit = match_option(q.options, intent.value) or pick_pattern(q.options, intent.option_patterns)
                return Decision("fill", wrap(hit), rule) if hit else unknown(
                    f"'{intent.value}' not among {q.options}")
            if q.kind == "checkbox":
                return unknown("text answer for a checkbox")
            limit = _char_limit(q)
            if limit and len(intent.value) > limit:
                return unknown(f"answer exceeds the field's {limit} limit")
            return Decision("fill", intent.value, rule)

        raise TypeError(f"unhandled intent {intent!r}")

    # -- custom answers -------------------------------------------------------
    def _custom(self, q: Question, label: str, ctx: Context) -> Decision | None:
        for entry in self.custom:
            try:
                if not re.search(entry["pattern"], label, re.I):
                    continue
                if entry.get("company") and not re.search(entry["company"], ctx.company, re.I):
                    continue
            except re.error:
                continue
            answer = entry.get("answer")
            if answer is None:
                continue
            if isinstance(answer, bool):
                intent = YesNo(answer)
            elif isinstance(answer, list):
                intent = Multi([str(a) for a in answer])
            elif q.kind in CHOICE_KINDS:
                intent = Text(str(answer), [rf"^{re.escape(str(answer))}$", re.escape(str(answer))])
            else:
                intent = Text(str(answer))
            d = self._apply(intent, q, "custom")
            if d.action == "fill":
                return d
        return None

    # -- files ------------------------------------------------------------------
    def _file(self, q: Question, label: str) -> Decision:
        both = re.search(r"resume.{0,12}(or|/|and/or).{0,12}transcript|transcript.{0,12}(or|/).{0,12}resume", label)
        if re.search(r"resume|\bcv\b|curriculum", label) and "cover" not in label and not (
                "transcript" in label and not both):
            return Decision("fill", self.p["resume_path"], "resume")
        for word, key in (("transcript", "transcript_path"), ("cover letter", "cover_letter_path")):
            if word in label:
                path = existing_file(self.p["education" if key == "transcript_path" else "logistics"].get(key))
                if path:
                    return Decision("fill", path, word.split()[0])
                if both and q.required:
                    return Decision("fill", self.p["resume_path"], "resume-or-transcript")
        if q.required:
            return Decision("unknown", rule="file", note=f"required upload not on file: {q.label}")
        return Decision("skip", rule="file")

    # -- rules --------------------------------------------------------------------
    def _rules(self):
        if not hasattr(self, "_compiled"):
            self._compiled = [(n, re.compile(p, re.I), h) for n, p, h in self._rule_table()]
        return self._compiled

    def _rule_table(self):
        p = self.p
        ident, addr, edu = p["identity"], p["address"], p["education"]
        auth, log, eeo, links = p["work_authorization"], p["logistics"], p["eeo"], p["links"]
        grad_iso = f"{edu['grad_year']}-{edu['grad_month']:02d}-01"
        start_edu_iso = f"{edu['start_year']}-{edu['start_month']:02d}-01"
        grad_month = MONTHS[edu["grad_month"] - 1]
        full_addr = f"{addr['line1']}, {addr['city']}, {addr['state_abbr']} {addr['postal_code']}"
        city_state = f"{addr['city']}, {addr['state_abbr']}"

        # --- handlers that need logic --------------------------------------
        def follow_up(q, label, ctx):
            if q.kind in CHOICE_KINDS | {"checkbox"}:
                return None                                  # a conditional choice is still a question
            if re.search(r"\b(are|will|would|do|does|can) you\b.*\?", label):
                return None                                  # a real question behind an "If ..." preamble
            if re.search(r"zip|postal", label):
                return Text(addr["postal_code"])
            if re.search(r"other.{0,30}(school|college|university|education)|other,? please specify which one", label) \
                    and not re.search(r"referral|event|fair|organization", label) \
                    and any(re.search(r"school|college|university", norm(l)) for l in ctx.labels):
                return Text(edu["school"])
            if q.required and q.kind in ("text", "textarea"):
                return Text("N/A")                           # conditional that does not apply
            return Skip()

        def sponsorship(q, label, ctx):
            needs = auth["requires_sponsorship"]
            # Judge polarity on the actual question, not on explanatory text after it.
            first = label.split("?")[0]
            if q.kind in CHOICE_KINDS and re.search(
                    r"(permitted|authoriz\w*|eligible|able|right) to (live and )?work.{0,90}"
                    r"without (needing|requiring|the need for|need of)?.{0,30}sponsor", first):
                return YesNo(auth["authorized_to_work_us"] and not needs)
            if re.search(r"citizen|u\.?s\.? person|permanent resident|green card|independent contractor", label):
                return Unknown("mixes sponsorship with another status question")
            if q.kind not in CHOICE_KINDS | {"text", "textarea"}:
                return Skip()
            if q.kind in CHOICE_KINDS and pick_yes_no(q.options, True) is None:
                # options name visa categories or timing rather than Yes / No
                now_q = re.search(r"this (specific )?internship|currently|at this time|\bnow\b", first) \
                    and "future" not in first
                if sum(bool(re.match(r"\s*(yes|no)\b", o, re.I)) for o in q.options) >= 2:
                    # "Yes ... now" / "Yes ... in the future" / "No"
                    if needs and auth.get("requires_sponsorship_now") is not None:
                        hit = pick_pattern(q.options, [r"^yes\b.{0,70}\bnow\b"] if auth["requires_sponsorship_now"]
                                           else [r"^yes\b.{0,70}\bfuture\b"])
                        if hit:
                            return Text(hit, [rf"^{re.escape(hit)}$"])
                    return Unknown("options ask when sponsorship is needed: set work_authorization.requires_sponsorship_now")
                key = "internship_work_authorization" if now_q else "future_sponsorship_visa"
                value = auth.get(key)
                if value:
                    return Text(value, [rf"^{re.escape(value)}\b", rf"\b{re.escape(value)}\b"])
                return Unknown(f"options are visa categories: set work_authorization.{key}")
            if re.search(r"(authoriz|eligib|able|permitted|right)\w* to work.{0,80}without.{0,40}sponsor", first):
                return YesNo(auth["authorized_to_work_us"] and not needs)   # "...without sponsorship?"
            if re.search(r"(require|need)\w*.{0,80}sponsor|sponsor\w*.{0,30}(required|needed)|"
                         r"require .{0,60}to (sponsor|commence)|"
                         r"(require|need)\w*.{0,140}\bfil(e|ing) (a |an )?(petition|application)|"
                         r"employment eligibility status", first):
                if q.kind == "textarea":
                    extra = f" ({auth['citizenship_status']})" if needs and auth.get("citizenship_status") else ""
                    return Text(("Yes" if needs else "No") + extra)
                return YesNo(needs)
            return Unknown("could not determine what the sponsorship question asks")

        def work_auth(q, label, ctx):
            mentions_us = re.search(r"united states|\bu\.?s\.?a?\b", label)
            if re.search(r"canada|united kingdom|\buk\b|europe|\beu\b|india|germany|australia|"
                         r"ireland|singapore|japan|mexico", label) and not mentions_us:
                return Unknown("work authorization outside the U.S. is not in the profile")
            if re.search(r"\bopt\b|\bcpt\b|h-?1b", label) and not re.search(r"e\.g\.|such as|for example", label):
                return Unknown("asks about a specific visa category")
            return YesNo(auth["authorized_to_work_us"])

        def name(q, label, ctx):
            if re.search(r"native language|pronunc|phonetic|characters", label):
                return Skip()
            if q.kind == "textarea" and not re.search(r"\bsignature\b|full legal name", label):
                return None                                  # a name never belongs in an essay box
            core = re.sub(r"[^a-z ]", "", label).strip()
            if core in {"name", "full name", "legal name", "full legal name", "your name", "what is your legal name",
                        "what is your full name", "what is your name", "what is your full legal name",
                        "your full name", "candidate name", "first and last name",
                        "applicant name", "full name first and last"} \
                    or re.search(r"full legal name|\bsignature\b|\be-?sign(ature)?\b|"
                                 r"(type|enter(ing)?|provide|state) (my |your )(full )?(legal )?name", label):
                return Text(ident["full_name"])
            return None

        def address(q, label, ctx):
            others = " | ".join(norm(l) for l in ctx.labels)
            if re.search(r"line 1|street", label) or re.search(r"\bcity\b|zip|postal", others.replace(label, "")):
                return Text(addr["line1"])
            return Text(full_addr)

        def location(q, label, ctx):
            if q.kind in CHOICE_KINDS and len(q.options) <= 40:
                return office(q, label, ctx)
            return Text(city_state, [rf"^{addr['city']}\b.*\b({addr['state']}|{addr['state_abbr']})\b"])

        def grad_option(options):
            """The one option whose month/season window (or 'after X') contains the graduation date."""
            hits = []
            for o in options:
                low = norm(o)
                if re.search(r"already graduated|\bi graduated\b|not pursuing|^n/?a\b", low):
                    continue
                ends = _grad_endpoints(low)
                if not ends:
                    continue
                if len(ends) >= 2 and not re.search(r"\bor\b", low):
                    ok = ends[0][0] <= grad <= ends[-1][1]
                elif re.search(r"\bafter\b|or later", low):
                    ok = grad > ends[0][1]
                elif re.search(r"\bbefore\b|prior to|or earlier", low):
                    ok = grad < ends[0][0]
                else:
                    ok = any(lo <= grad <= hi for lo, hi in ends)
                if ok:
                    hits.append(o)
            if len(hits) == 1:
                return hits[0]
            # relative phrasing: "expected graduation is between 1-2 years from now"
            months_left = (grad[0] - date.today().year) * 12 + grad[1] - date.today().month
            rel = []
            for o in options:
                low = norm(o)
                if months_left <= 0 or not re.search(r"not yet graduated|expected graduation|will graduate|from now", low):
                    continue
                unit = 1 if re.search(r"\d\+? ?months?", low) else 12
                m = re.search(r"between (\d+)\s*(?:-|–|and|to)\s*(\d+)", low) or re.search(r"(\d+)\s*(?:-|–|to)\s*(\d+) (?:year|month)", low)
                if m:
                    ok = int(m.group(1)) * unit <= months_left <= int(m.group(2)) * unit
                elif (m := re.search(r"(?:more than|over|greater than) (\d+)", low)):
                    ok = months_left > int(m.group(1)) * unit
                elif (m := re.search(r"(?:less than|under|within) (\d+)", low)):
                    ok = months_left < int(m.group(1)) * unit
                else:
                    continue
                if ok:
                    rel.append(o)
            return rel[0] if len(rel) == 1 else None

        def graduation(q, label, ctx):
            year = str(edu["grad_year"])
            if q.kind in CHOICE_KINDS:
                windowed = grad_option(q.options)
                if windowed:
                    return Text(windowed, [rf"^{re.escape(windowed)}$"])
                with_year = [o for o in q.options if year in o]
                if len(with_year) == 1:
                    return Text(with_year[0], [re.escape(with_year[0])])
                season = [o for o in with_year if re.search(rf"{grad_month}|spring", o, re.I)]
                if len(season) == 1:
                    return Text(season[0], [re.escape(season[0])])
                if not with_year and "month" in label:
                    return Text(grad_month)
                return Unknown(f"no single option for {grad_month} {year}")
            if re.search(r"\b(do|will|are|have|did|would|can) you\b", label) and not re.search(
                    r"^(when|what|which)\b", label):
                return None                                  # a yes/no question that merely mentions graduating
            if re.search(r"\byear\b", label) and "month" not in label:
                return Text(year)
            if "month" in label and "year" not in label:
                return Text(grad_month)
            hint = f"{q.placeholder} {label}".lower()
            if re.search(r"mm\s*/\s*yyyy", hint) and "dd" not in hint:
                return Text(f"{edu['grad_month']:02d}/{edu['grad_year']}")
            if q.kind == "date" or re.search(r"mm\s*/|yyyy-mm", hint):
                return Text(_fmt_date(grad_iso, q))
            return Text(f"{grad_month} {year}")

        def gpa(q, label, ctx):
            if not q.required:
                return Skip()                      # spec: blank whenever optional
            if q.kind in CHOICE_KINDS:
                hit = gpa_option(q.options, float(edu["gpa"]))
                return Text(hit, [re.escape(hit)]) if hit else Unknown("no GPA range matches")
            return Text(edu["gpa"])

        def start_date(q, label, ctx):
            iso = log["earliest_start"]
            month = MONTHS[int(iso[5:7]) - 1]
            if q.kind in CHOICE_KINDS:
                return Choice([rf"^{month}\b[^-–]*{iso[:4]}$", rf"^{month}$", r"summer.{0,6}2027", r"^summer\b"],
                              exclude=r"2026|2028|spring|fall|winter")
            if re.search(r"\b(end|finish|conclude)", label):
                return Text(f"{_long_date(iso)} – {_long_date(log['latest_end'])}")
            return Text(_fmt_date(iso, q))

        def end_date(q, label, ctx):
            if q.kind in CHOICE_KINDS:
                month = MONTHS[int(log["latest_end"][5:7]) - 1]
                return Choice([rf"^{month}\b"])
            return Text(_fmt_date(log["latest_end"], q))

        def summer_availability(q, label, ctx):
            if q.kind not in CHOICE_KINDS | {"checkbox"}:
                return None
            if re.search(r"post-?internship|after (the|your|this) internship|full[- ]time (role|position|offer)|"
                         r"upon graduation|return offer|6[- ]month|co-?op|part[- ]time|"
                         r"\b(4[1-9]|[5-9]\d)\+? hours", label) or _within_window(label, log) is False:
                return Unknown("availability outside the stated internship window")
            return YesNo(True)

        def onsite(q, label, ctx):
            if q.kind not in CHOICE_KINDS | {"checkbox", "text"}:
                return None
            # a dated or extra-hours commitment is not the same as "willing to work on-site"
            if _within_window(label, log) is False or re.search(r"\b(4[1-9]|[5-9]\d)\+? hours", label):
                return Unknown("on-site question bundles a dated or extra-hours commitment")
            if q.kind in CHOICE_KINDS and not re.search(home, label, re.I):
                moving = pick_pattern(q.options, [r"^yes\b.{0,30}(relocat|move)"])
                if moving and log["willing_to_relocate"]:
                    return Text(moving, [rf"^{re.escape(moving)}$"])     # truthful for someone not yet local
            return YesNo(log["onsite"] and log["hybrid"])

        def compensation(q, label, ctx):
            annual = re.search(r"annual|per year|yearly|base salary|\bsalary\b", label) \
                and not re.search(r"hour|/ ?hr", label)
            number = log.get("desired_annual_salary") if annual and log.get("desired_annual_salary") \
                else log["desired_hourly_rate"]
            if q.kind == "number" or re.search(r"numbers? only|numeric|digits only", f"{label} {q.placeholder}".lower()):
                return Text(number)
            if q.kind in CHOICE_KINDS:
                to_num = lambda v: float(v) if v else None
                bucket = money_option(q.options, to_num(log.get("desired_annual_salary")),
                                      to_num(log.get("desired_hourly_rate")))
                return Text(bucket, [rf"^{re.escape(bucket)}$"]) if bucket else Unknown("no pay bucket matches")
            return Text(log["desired_compensation_text"])

        def heard(q, label, ctx):
            co = re.escape(ctx.company) if ctx.company else "company"
            return Choice([
                r"^(company|corporate|careers?|our) ?(web)?site$|careers? (page|site)|company (careers|website)",
                rf"{co}.{{0,12}}(website|careers|career site|job board)|"
                r"\b(website|careers? (site|page|website))\b",
                r"job board", r"linkedin", r"^other\b"],
                text=log["heard_about"][0],
                exclude=r"employee|referr|recruiter|event|fair|campus|school|university|college|"
                        r"handshake|\bseo\b|office|cent(er|re)|professor|club|friend")

        def applied_before(q, label, ctx):
            return YesNo(bool(ctx.applied_before) or log["previously_worked_or_applied"])

        def third_party_employment(q, label, ctx):
            if re.search(r"government|public official", label):
                flag = log.get("government_official")
            else:
                flag = log.get("client_or_competitor_employment")
            return Unknown("not stated in the profile") if flag is None else YesNo(bool(flag))

        def marketing(q, label, ctx):
            if q.kind == "checkbox" or not q.required:
                return Skip()
            return YesNo(False)

        def degree(q, label, ctx):
            if re.search(r"highest .*(complete|attain|obtain|earn|achiev)|completed", label) \
                    and "pursuing" not in label:
                return Choice([r"bachelor.*(in progress|pursuing|current|enrolled)",
                               r"(pursuing|current|enrolled|working toward).*bachelor", r"some college"])
            return Choice([r"bachelor of science", r"^b\.?s\.?\b", r"bachelor", r"undergrad"],
                          text=edu["degree"], exclude=r"associate|master|doctor|ph\.?d|mba|high school")

        def school(q, label, ctx):
            if re.match(r"(are|do|does|have|has|will|did|is|can|when|where) ", label):
                return None
            if q.kind == "textarea" or re.search(r"accomplish|achiev|project|experience|internship|describe|tell|"
                                                 r"grading|\bscale\b|\bgpa\b|e-?mail|address", label):
                return None                                  # a prompt that merely mentions school
            pats = [rf"^{re.escape(a)}$" for a in [edu["school"], *edu["school_aliases"]]]
            pats += [r"university of texas.{0,6}dallas|ut dallas", r"^other\b"]
            return Text(edu["school"], pats)

        def race(q, label, ctx):
            pats = [rf"^{re.escape(v)}\b" for v in (eeo.get("race_subcategory"), eeo["race"]) if v]
            return Choice(pats,
                          exclude=r"native hawaiian|east asian|southeast|two or more|\band\b|/|mixed|multi")

        def hispanic(q, label, ctx):
            return YesNo(eeo["hispanic_or_latino"], [r"^not hispanic|^non-?hispanic"]
                         if not eeo["hispanic_or_latino"] else [r"^hispanic"])

        def veteran(q, label, ctx):
            if eeo["veteran"]:
                return Unknown("veteran category needs a human choice")
            return Choice([r"^i am not a (protected )?veteran", r"not a (protected )?veteran",
                           r"^no\b", r"never served|have not served|no military"],
                          exclude=r"decline|prefer not|don'?t wish")

        def disability(q, label, ctx):
            if eeo["disability"]:
                return Unknown("disability answer needs a human choice")
            return Choice([r"^no,? i (do not|don'?t) have a disability", r"^no\b",
                           r"(do not|don'?t) have a disability"])

        def gender(q, label, ctx):
            g = eeo["gender"]
            pats = {"Male": [r"^(male|man)$", r"^(cis(gender)? )?(male|man)\b"],
                    "Female": [r"^(female|woman)$", r"^(cis(gender)? )?(female|woman)\b"]}.get(g, [])
            return Choice(pats, exclude=r"trans|non-?binary") if pats else Unknown("gender option")

        def decline_only(q, label, ctx):
            return Choice([DECLINE.pattern])

        def orientation(q, label, ctx):
            return Choice([r"heterosexual|straight", DECLINE.pattern])

        def essay_limit_ok(text):
            def h(q, label, ctx):
                m = re.search(r"(\d{2,4})\s*(?:-\s*)?words?(?: max| or (?:less|fewer)| limit)?|"
                              r"(?:max(?:imum)?|limit|under|up to)\D{0,12}(\d{2,4})\s*words", label)
                if m:
                    cap = int(m.group(1) or m.group(2))
                    if len(text.split()) > cap:
                        return Unknown(f"saved essay is longer than the {cap}-word limit")
                return Text(text)
            return h

        # ---------------- extended coverage (answers the candidate has stated) ----------------
        order = log.get("preferred_office_order") or []
        _REGIONS = {
            "TX": r"texas|\btx\b|austin|dallas|houston|frisco|plano|irving|richardson|san antonio|fort worth",
            "CA": r"california|\bca\b|san francisco|\bsf\b|bay area|los angeles|san jose|palo alto|mountain view|"
                  r"san diego|sunnyvale|san mateo|santa clara|menlo park|irvine|oakland|el segundo|santa monica",
            "WA": r"washington\b(?! ?,? ?d\.?c)|\bwa\b|seattle|bellevue|redmond|kirkland",
            "NY": r"new york|\bny\b|\bnyc\b|manhattan|brooklyn",
            "Remote": r"\bremote\b|anywhere in the (u\.?s|united states)",
        }
        _US_OPTION = re.compile(rf",\s*[A-Z]{{2}}\b|united states|\busa?\b|\bu\.s\.|{US_CITY}", re.I)

        def office(q, label, ctx):
            """Pick an office: the stated region order first, then any other U.S. option."""
            if q.kind not in CHOICE_KINDS:
                locs = [l for l in ctx.locations if l not in ctx.picked]
                for code in order:
                    hit = next((l for l in locs if re.search(_REGIONS.get(code, "$^"), l, re.I)), None)
                    if hit:
                        ctx.picked.append(hit)
                        return Text(hit)
                if locs:
                    ctx.picked.append(locs[0])
                    return Text(locs[0])
                return Unknown("posting lists no locations to choose from")
            pool = [o for o in q.options if o.strip() and o not in ctx.picked
                    and not re.search(r"^(select|choose|--|none|n/a|no preference)", o.strip(), re.I)]
            for code in order:
                hit = next((o for o in pool if re.search(_REGIONS.get(code, "$^"), o, re.I)), None)
                if hit:
                    ctx.picked.append(hit)
                    return Text(hit, [rf"^{re.escape(hit)}$"])
            hit = next((o for o in pool if _US_OPTION.search(o)), None)
            if hit:
                ctx.picked.append(hit)
                return Text(hit, [rf"^{re.escape(hit)}$"])
            return Unknown("no U.S. office among the options")

        home = rf"{addr['city']}|{addr['state']}|\b{addr['state_abbr']}\b|dallas|\bdfw\b"

        def local_resident(q, label, ctx):
            """'Are you located in X?' answered from the address; relocation options win."""
            if q.kind not in CHOICE_KINDS | {"text"}:
                return None
            moving = pick_pattern(q.options, [r"relocat|will move|willing to move"],
                                  exclude=r"\b(not|unable|cannot|can't|won't)\b")
            if re.search(r"united states|\bu\.?s\.?a?\b", label) and not re.search(
                    r",\s*[a-z]{2}\b|area|city|office", label):
                return YesNo(addr["country"].lower().startswith("united states"))
            if re.search(home, label, re.I):
                return YesNo(True)
            if re.search(r"^will you be\b", label) and log["willing_to_relocate"] \
                    and _within_window(label, log) is not False:
                return YesNo(True)                           # "will you be local for the summer?"
            if moving and log["willing_to_relocate"]:
                return Text(moving, [rf"^{re.escape(moving)}$"])
            if re.search(r"relocat|willing to (move|commute)", label) and log["willing_to_relocate"]:
                return YesNo(True)
            return YesNo(False)                              # does not live there: say so

        grad = (edu["grad_year"], edu["grad_month"])
        _SEASON = {"spring": (1, 6), "summer": (6, 8), "fall": (8, 12), "autumn": (8, 12), "winter": (12, 12)}

        def _month_year(text):
            out = []
            for m in re.finditer(rf"\b({'|'.join(mm.lower() for mm in MONTHS)}|"
                                 rf"{'|'.join(_MONTH_NUM)})\w*\.? (20\d\d)\b", text):
                out.append((int(m.group(2)), _MONTH_NUM[m.group(1)[:3]]))
            return out

        def _grad_endpoints(text):
            """[(start, end)] windows named in the text, in order: 'May 2028', 'May/June 2028', 'Spring 2028'."""
            months = "|".join(mm.lower() for mm in MONTHS) + "|" + "|".join(_MONTH_NUM)
            found = []
            for m in re.finditer(rf"\b(?:({months})\w*\.?\s*/\s*)?({months})\w*\.?(?: \d{{1,2}}(?:st|nd|rd|th)?)?,? "
                                 rf"(20\d\d)\b", text):
                hi = _MONTH_NUM[m.group(2)[:3]]
                lo = _MONTH_NUM[m.group(1)[:3]] if m.group(1) else hi
                found.append((m.start(), ((int(m.group(3)), lo), (int(m.group(3)), hi))))
            for m in re.finditer(r"\b(spring|summer|fall|autumn|winter) (20\d\d)\b", text):
                lo, hi = _SEASON[m.group(1)]
                found.append((m.start(), ((int(m.group(2)), lo), (int(m.group(2)), hi))))
            return [w for _, w in sorted(found)]

        def graduation_check(q, label, ctx):
            """Yes/no and checkbox questions that test the graduation date against a window."""
            if q.kind not in CHOICE_KINDS | {"checkbox"}:
                return None
            if q.kind in CHOICE_KINDS and pick_yes_no(q.options, True) is None:
                return None
            if not re.search(r"graduat|complete (my|your) degree|degree|class of", label):
                return None
            ends = _grad_endpoints(label)
            verdict = None
            if len(ends) >= 2 and re.search(r"between|\bfrom\b|through|\bto\b|20\d\d ?[-–] ?\w", label) \
                    and not re.search(r"\bor\b", label):
                verdict = ends[0][0] <= grad <= ends[-1][1]
            elif ends and re.search(r"\bbefore\b|prior to", label):
                verdict = grad < ends[0][0]
            elif ends and re.search(r"no later than|\bby\b|on or before", label):
                verdict = grad <= ends[0][1]
            elif ends and re.search(r"\bafter\b|or later", label):
                verdict = grad >= ends[0][0]
            elif ends:
                verdict = any(lo <= grad <= hi for lo, hi in ends)
            else:
                years = [int(y) for y in re.findall(r"\b(20\d\d)\b", label)]
                if years and re.search(r"class of|graduat\w* in|graduation year", label):
                    verdict = grad[0] in years
            if verdict is None:
                return None
            if q.kind == "checkbox":
                return Check() if verdict else Unknown("statement about graduation is not true for this profile")
            return YesNo(verdict)

        def student_at(q, label, ctx):
            """'Are you a current <University> student?'"""
            if q.kind not in CHOICE_KINDS or "high school" in label:
                return None
            if not re.search(r"University of [A-Z]\w+|[A-Z]\w+ (University|College|Institute)|\b[A-Z]{2,5}\b student",
                             q.label):
                return None                                  # no particular school named
            names = [edu["school"], *edu["school_aliases"]]
            mine = any(_simple(n) in _simple(label) for n in names)
            return YesNo(mine and _within_window(label, log) is not False)

        skills_all = [*p["skills"]["languages"], *p["skills"]["backend"], *p["skills"]["tools"]]
        skill_terms = {re.sub(r"\s*\(.*\)", "", x).lower() for x in skills_all}
        skill_terms |= {"node", "postgres", "llm", "large language model"}
        never = [x.lower().rstrip("s") for x in p["skills"].get("never_claim", [])]
        _OTHER_TECH = (r"android|jetpack|flutter|react native|\bios\b|"
                       r"docker|kubernetes|\bk8s\b|\baws\b|\bgcp\b|azure|terraform|\bgo(lang)?\b|rust|swift|"
                       r"kotlin|\bc#|ruby|scala|spark|kafka|graphql|redis|\brest(ful)?\b|angular|vue|django|"
                       r"flask|spring boot|\.net|\bphp\b|matlab|verilog|\bros\b|unity|unreal|salesforce|"
                       r"tableau|power ?bi|snowflake|hadoop|objective-c|\bperl\b|haskell|\bcuda\b")
        _GENERIC_YES = (r"programming language|object[- ]oriented|relational database|version control|"
                        r"software development|personal project|"
                        r"machine learning|computer vision|web development|full[- ]stack|unit test|"
                        r"\bsql\b|back ?end|front ?end|data structures|algorithms")

        def skill_yes_no(q, label, ctx):
            """'Do you have experience with X?' - Yes only for skills on the resume, No for named others."""
            if q.kind == "text" and not re.match(r"(do|have|are|did|can) you\b", label):
                return None
            if q.kind not in CHOICE_KINDS | {"text"} or (q.kind in CHOICE_KINDS and pick_yes_no(q.options, True) is None):
                return None
            if not re.search(r"experience|proficien|familiar|knowledge of|worked with|used|comfortable|built|using",
                             label) or re.search(r"\bindustry\b|professional", label):
                return None
            if any(re.search(rf"\b{re.escape(n)}", label) for n in never):
                return YesNo(False)
            if any(re.search(rf"(?<![a-z0-9+#]){re.escape(t)}(?![a-z0-9+#])", label) for t in skill_terms):
                return YesNo(True)
            if re.search(_OTHER_TECH, label):
                return YesNo(False)
            if re.search(_GENERIC_YES, label) and not re.search(r"\d+\+? years|professional|industry", label):
                return YesNo(True)
            return None

        def years_experience(q, label, ctx):
            full_time = re.search(r"full[- ]time|professional|post[- ]?grad|industry", label)
            named_other = any(re.search(rf"\b{re.escape(n)}", label) for n in never) or (
                re.search(_OTHER_TECH, label)
                and not any(re.search(rf"(?<![a-z0-9+#]){re.escape(t)}(?![a-z0-9+#])", label) for t in skill_terms))
            if named_other:                                   # a technology that is not on the resume
                return Text("0") if q.kind not in CHOICE_KINDS else Choice([r"^0\b|^none|^no experience|less than 1"])
            value = p["skills"].get("years_experience_full_time" if full_time else "years_experience_internship")
            if not value:
                return Unknown("years of experience not stated in the profile")
            if q.kind in CHOICE_KINDS and any(re.search(r"month|week", o, re.I) for o in q.options):
                return Unknown("experience options are in months")
            if q.kind in CHOICE_KINDS:
                hit = gpa_option(q.options, float(value)) or pick_pattern(
                    q.options, [rf"^{value}\b", r"^(less than|under|<) ?1\b|^0\s*-\s*1\b|^none$"] if value in ("0", "1")
                    else [rf"^{value}\b"])
                return Text(hit, [rf"^{re.escape(hit)}$"]) if hit else Unknown("no matching experience range")
            return Text(value)

        status = (auth.get("citizenship_status") or "").lower()
        is_citizen = bool(re.search(r"\bcitizen\b", status)) and "non" not in status
        is_pr = bool(re.search(r"permanent resident|green card|\blpr\b", status))
        status_patterns = ([r"u\.?s\.? citizen|^citizen"] if is_citizen else
                           [r"permanent resident|green card"] if is_pr else
                           [r"f-?1|student visa|\bopt\b|\bcpt\b"] if re.search(r"f-?1|student", status) else
                           [re.escape(status)] if status else [])

        def citizenship(q, label, ctx):
            """Answered only when work_authorization.citizenship_status is set in the profile."""
            if not status:
                return Unknown("set work_authorization.citizenship_status in the profile")
            if re.search(r"north korea|syria|iran|cuba", label):
                return YesNo(bool(re.search(r"north korea|syria|iran|cuba", status)))
            if q.kind in CHOICE_KINDS and pick_yes_no(q.options, True):
                wants_citizen = re.search(r"citizen", label)
                wants_pr = re.search(r"permanent resident|green card|u\.?s\.? person|lawful", label)
                if wants_citizen or wants_pr:
                    return YesNo((is_citizen and bool(wants_citizen)) or ((is_citizen or is_pr) and bool(wants_pr)))
                return None
            if re.search(r"eligibility .{0,40}based on a? ?(work )?visa", label) and q.kind in CHOICE_KINDS:
                return YesNo(not (is_citizen or is_pr))
            if q.kind in CHOICE_KINDS:
                return Choice(status_patterns) if status_patterns else None
            return Text(auth["citizenship_status"]) if q.kind == "text" else None

        def clearance(q, label, ctx):
            has = auth.get("has_security_clearance")
            if has is None:
                return Unknown("set work_authorization.has_security_clearance in the profile")
            if re.search(r"eligib|able to obtain|obtain and maintain|willing to (obtain|undergo)", label):
                return YesNo(True) if is_citizen else Unknown("clearance eligibility depends on citizenship status")
            if has:
                return Unknown("clearance level needs a human answer")
            if q.kind in CHOICE_KINDS:
                return YesNo(False, [r"^none\b|^no clearance|^n/?a\b|not applicable|do not (have|hold)|^no active"])
            return Text("None") if q.kind == "text" and q.required else Skip()

        def test_score(q, label, ctx):
            key = "act_score" if re.search(r"\bact\b", label) and "sat" not in label else "sat_score"
            if edu.get(key) and not re.search(r"type", label):
                return Text(str(edu[key]))
            if not q.required:
                return Skip()                                   # blank whenever optional
            if q.kind in CHOICE_KINDS:
                return Choice([r"prefer not|decline|rather not", r"^n/?a\b|not applicable|^none\b",
                               r"did not take|didn't take|not taken|(don't|do not) have|no (sat|act|score)",
                               *([r"^other$"] if "type" in label else [])])
            return Text("N/A")

        def work_auth_detail(q, label, ctx):
            """Descriptive option lists: pick the one that states both facts from the profile."""
            if q.kind not in CHOICE_KINDS:
                return None
            if auth["authorized_to_work_us"] and auth["requires_sponsorship"]:
                hit = pick_pattern(q.options, [r"^yes\b.{0,30}(need|require)s? .{0,20}sponsor"])
                if hit:
                    return Text(hit, [rf"^{re.escape(hit)}$"])
            if pick_yes_no(q.options, True) is None and re.search(
                    r"citizen|permanent resident|green card|visa|sponsor", " ".join(q.options).lower()):
                if not status:
                    return Unknown("options ask how you are authorized: set work_authorization.citizenship_status")
                hit = pick_pattern(q.options, status_patterns + ([r"non-?immigrant visa"] if not (is_citizen or is_pr) else []))
                return Text(hit, [rf"^{re.escape(hit)}$"]) if hit else Unknown("no option matches the citizenship status")
            return None

        def accommodation(q, label, ctx):
            """Only a question that itself asks about needing accommodations is left alone."""
            last = re.split(r"(?<=[.?!])\s+", label.strip())[-1]
            if re.search(r"accommodation|adjustment", last) or not label.strip().endswith("?"):
                return Unknown("accommodation needs are not in the profile")
            return None                                   # mentioned in passing: let the real question be answered

        def student_orgs(q, label, ctx):
            mine = p.get("student_organizations") or []
            if q.kind in FREE_KINDS:
                return Text("; ".join(mine)) if mine else None
            if q.kind not in CHOICE_KINDS:
                return None
            words = [w for name in mine for w in re.findall(r"[A-Za-z0-9]{4,}", name)]
            hits = [o for o in q.options if any(re.search(rf"\b{re.escape(w)}\b", o, re.I) for w in words)]
            if hits:
                return Multi(hits)
            none = pick_pattern(q.options, [r"none of the above|^none\b|not applicable|^n/?a$"])
            return Text(none, [rf"^{re.escape(none)}$"]) if none else Unknown("your organizations are not among the options")

        def rank_skill(q, label, ctx):
            """A 1-10 self-rating is answered only for a technology that is not on the resume (the minimum)."""
            named_other = any(re.search(rf"\b{re.escape(n)}", label) for n in never) or re.search(_OTHER_TECH, label)
            on_resume = any(re.search(rf"(?<![a-z0-9+#]){re.escape(t)}(?![a-z0-9+#])", label) for t in skill_terms)
            scale = re.search(r"(\d+)\s*(?:-|–|to)\s*(\d+)", label)
            if named_other and not on_resume and scale and q.kind in FREE_KINDS:
                return Text(str(min(int(scale.group(1)), int(scale.group(2)))))
            return Unknown("skill self-ratings are yours to give")

        def flag(key, why):
            def h(q, label, ctx):
                v = log.get(key)
                return Unknown(f"{why} (set logistics.{key} in the profile)") if v is None else YesNo(bool(v))
            return h

        def employer(q, label, ctx):
            if re.match(r"(have|has|are|do|does|did|is|will|would|can)\b", label) or len(label) > 90:
                return None                                  # a question that mentions an employer, not a field
            exp = p.get("experience") or []
            if not exp:
                return Unknown("no experience entries in the profile")
            recent = exp[0]
            if re.search(r"title|role|position", label):
                if re.search(r"most recent|previous|last|prior", label):
                    return Text(recent["title"])
                return Text("Student") if q.required and q.kind in FREE_KINDS else Skip()
            if re.search(r"most recent|previous|last|prior", label):
                return Text(recent["company"])
            if q.required and q.kind in FREE_KINDS:
                return Text(f"Student, {edu['school']}")      # not currently employed
            return Skip()

        def season(q, label, ctx):
            if q.kind not in CHOICE_KINDS:
                return Text("Summer 2027")
            return Choice([r"summer.{0,6}2027", r"^summer\b(?!.*(co-?op|spring|fall|both))", r"\bsummer\b"],
                          exclude=r"2026|2028|spring|fall|winter|both")

        def interest_area(q, label, ctx):
            if q.kind not in CHOICE_KINDS:
                return Text(ctx.title) if ctx.title and re.search(r"which (specific )?(role|position)", label) else None
            return Choice([r"^(either|both|any|no preference|open to (any|all))\b",
                           r"software (engineer|develop)", r"software", r"back[- ]?end|full[- ]?stack|platform",
                           r"\bai\b|machine learning|\bml\b", r"\bdata\b", r"engineering|technology",
                           r"^intern(ship)?\b"], exclude=r"hardware|mechanical|electrical|sales|marketing|finance")

        def position_type(q, label, ctx):
            return Choice([r"^intern(ship)?$", r"summer intern", r"\bintern(ship)?\b"],
                          exclude=r"co-?op|full[- ]time|part[- ]time|contract") if q.kind in CHOICE_KINDS else None

        def post_internship(q, label, ctx):
            if q.kind not in CHOICE_KINDS:
                return None
            return YesNo(grad <= (2027, 9))        # still in school after Summer 2027 -> not available

        def na_fallback(q, label, ctx):
            return Text("N/A") if q.required and q.kind in ("text", "textarea") else None

        yes, no = (lambda *_: YesNo(True)), (lambda *_: YesNo(False))
        t = lambda v: (lambda *_: Text(v))
        skip = lambda *_: Skip()
        unk = lambda why: (lambda *_: Unknown(why))

        return [
            # --- conditional follow-ups: never answered unless optional ------
            ("follow-up", r"^if (yes|no|so|other|not|applicable)\b|^if you (do|did|chose|selected|answered|"
                          r"were referred|were previously|are related|are based|are not|have (a|an|any|been|ever))\b|"
                          r"^if .{0,30}(please|kindly)|please (specify|explain|elaborate|list|describe) if|^other\b|"
                          r"^(please )?(specify|explain)\b", follow_up),

            # --- recruiting text / marketing opt-ins: declined -----------------
            ("marketing", r"\bsms\b|text messag|mobile messag|marketing|newsletter|talent (community|network|pool)|"
                          r"future (opportunities|openings|roles|positions)|job alerts|whatsapp", marketing),

            # --- extended coverage: checked before the general rules ---------------
            ("x-high-school", r"high school", lambda q, label, ctx: YesNo(False)
             if re.search(r"(enrolled|student|attend)", label) and q.kind in CHOICE_KINDS | {"checkbox"}
             and "graduat" not in label else Unknown("high-school question")),
            ("x-housing", r"(secure|arrange|have|find|obtain) .{0,40}(accommodations?|housing) in\b",
             lambda q, label, ctx: None if q.kind not in CHOICE_KINDS
             else YesNo(log["willing_to_relocate"]) if re.search(r"able to|can you|secure|arrange|find|obtain", label)
             else YesNo(bool(re.search(home, label, re.I)))),
            ("x-school-email", r"(university|school|student|college|\.edu) e-?mail", lambda q, *_: Text(
                edu["school_email"]) if edu.get("school_email") else Unknown("school e-mail not in the profile")),
            ("x-human-only", AI_POLICY.pattern, unk("an AI-use or authorship attestation: answer it yourself")),
            ("x-accommodation", r"accommodations?\b|reasonable adjustments?", lambda q, label, ctx:
             None if re.search(r"(secure|arrange|find|obtain|have) .{0,40}accommodations? in\b|housing", label)
             else accommodation(q, label, ctx)),
            ("x-demographic", r"household|parents? or guardians?|free school meals|socio-?economic|first[- ]generation|"
                              r"religio|marital|caring responsibilit|neurodiver|social mobility|age (range|group)",
             lambda q, *_: Choice([DECLINE.pattern]) if q.kind in CHOICE_KINDS else Skip()),
            ("x-degree-after-graduation", r"level of education .{0,60}(once|when|after|upon) .{0,25}graduat|"
                                          r"degree (will you|you will) (have|hold|earn|receive)",
             lambda q, *_: Choice([r"bachelor", r"undergrad", r"^b\.?s\.?\b"], text=edu["degree"],
                                  exclude=r"associate|master|doctor|ph\.?d|mba|high school")),
            ("x-rising-senior", r"completed your junior year|entering your senior year|rising senior",
             lambda q, *_: YesNo((2028, 1) <= (edu["grad_year"], edu["grad_month"]) <= (2028, 8))
             if q.kind in CHOICE_KINDS else None),
            ("x-returning", r"return(ing)? to (school|university|college|your (degree|program|studies)|"
                            r"an? degree[- ]seeking program)",
             lambda q, *_: YesNo((edu["grad_year"], edu["grad_month"]) > (2027, 8)) if q.kind in CHOICE_KINDS else None),
            ("x-major-in-posting", r"degree in (one of )?the (majors?|fields?|disciplines?) listed",
             lambda q, label, ctx: YesNo(True) if q.kind in CHOICE_KINDS and edu["major"].lower() in ctx.job_text.lower()
             else Unknown("could not confirm the posting lists your major")),
            ("x-coop-count", r"how many .{0,50}co-?op (rotations?|terms?|blocks?) .{0,30}completed",
             lambda q, *_: Choice([r"^0\b", r"^none\b", r"^no\b"]) if q.kind in CHOICE_KINDS and not re.search(
                 r"co-?op", " ".join(x["title"] for x in p.get("experience") or []).lower()) else None),
            ("x-rank-skill", r"(rank|rate) your (proficiency|skills?|experience|comfort|knowledge|familiarity)\w* "
                             r"(in|with|of|level)", rank_skill),
            ("x-skills-multi", r"experience (in|with) the following|which of the following .{0,60}"
                               r"(experience|used|familiar|skills|technologies|tools)",
             lambda q, *_: Multi([re.sub(r"\s*\(.*\)", "", x) for x in skills_all])
             if q.kind in ("multiselect", "checkbox_group") else None),
            ("x-alt-email", r"(alternate|secondary|other|backup) e-?mail", lambda q, *_: Text(edu["school_email"])
             if edu.get("school_email") else (Unknown("set education.school_email") if q.required else Skip())),
            ("x-look-at", r"^what can we look at", t(links["portfolio"])),
            ("x-defense-work", r"(military|defen[cs]e|government|warfighter|dod\b|national security).{0,260}"
                               r"(comfortable|willing|agree|support|contribut|objection|aligned|ok with)|"
                               r"(comfortable|willing).{0,80}(military|defen[cs]e|government) (customers?|projects?|work)",
             lambda q, *_: flag("comfortable_with_defense_work", "not stated")(q, "", None)
             if q.kind in CHOICE_KINDS | {"checkbox"} else None),
            ("x-clearance", r"(hold|have|possess|held|maintain)\w* .{0,40}clearance|active .{0,40}clearance|"
                            r"clearance\(s\)|clearance (level|status|eligibility)|eligible to obtain .{0,40}clearance",
             clearance),
            ("x-test-scores", r"\bsat\b|\bact\b (score|result)|\bact score|standardized test|\bgre\b score",
             test_score),
            ("x-essential-functions", r"perform the (essential|duties|functions)|essential functions|"
                                      r"reason why you would not be able to perform",
             lambda q, label, ctx: Unknown("set logistics.can_perform_essential_functions")
             if log.get("can_perform_essential_functions") is None or q.kind not in CHOICE_KINDS
             else YesNo(not log["can_perform_essential_functions"]) if re.search(r"reason why you would not|unable", label)
             else YesNo(log["can_perform_essential_functions"])),
            ("x-interviewed-before", r"(previously|ever|before|in the past).{0,40}interview(ed)?|interview(ed)? with us",
             lambda q, label, ctx: YesNo(bool(ctx.applied_before)) if q.kind in CHOICE_KINDS else None),
            ("x-other-opportunities", r"consider(ed)? (me )?for other (job |open )?(opportunities|roles|positions)",
             lambda q, *_: YesNo(True) if q.kind in CHOICE_KINDS | {"checkbox"} else None),
            ("x-salary-aligned", r"(salary|pay|compensation) .{0,40}(align|meet|match|acceptable|within) .{0,20}expectation|"
                                 r"comfortable with (the|this) (salary|compensation|pay)",
             lambda q, *_: YesNo(True) if q.kind in CHOICE_KINDS else None),
            ("x-fulltime-after-graduation", r"interested in full[- ]time .{0,50}(upon|after) graduation",
             lambda q, *_: YesNo(True) if q.kind in CHOICE_KINDS else None),
            ("x-enrolled-program", r"enrolled in an? (undergraduate|bachelor)|current program type|still (a )?student",
             lambda q, *_: Check() if q.kind == "checkbox" else YesNo(True, [r"^undergrad|bachelor"])
             if q.kind in CHOICE_KINDS else None),
            ("x-relocate-ok", r"\b(okay|ok|comfortable|fine) (with )?(spending|living|relocating|being based|working) .{0,60}"
                              r"\bin [a-z]", lambda q, *_: YesNo(log["willing_to_relocate"])
             if q.kind in CHOICE_KINDS | {"text"} else None),
            ("x-prop-trading", r"internship experience at an? (proprietary trading|prop trading|trading|hedge fund|quant)",
             lambda q, *_: YesNo(False) if q.kind in CHOICE_KINDS and not re.search(
                 r"trading|hedge|quant", " ".join(x["company"] for x in p.get("experience") or []).lower()) else None),
            ("x-ai-tools", r"ai[- ]specific technologies|ai (tools|technologies|frameworks) .{0,30}(comfortable|used|familiar)",
             lambda q, *_: Multi([x for x in skills_all if re.search(r"pytorch|opencv|llamaindex|claude|gemini|tensorflow", x, re.I)])),
            ("x-frameworks", r"frameworks? .{0,50}(experience|used|familiar|comfortable)",
             lambda q, *_: Multi([re.sub(r"\s*\(.*\)", "", x) for x in skills_all],
                                 text=", ".join(x for x in ("React", "Node.js", "PyTorch") if x in skills_all) or None)),
            ("x-student-orgs", r"student organizations?|clubs?,? or competition teams|extracurricular (activities|groups)",
             student_orgs),
            ("x-prior-internship-count", r"how many (prior|previous) .{0,20}internships",
             lambda q, *_: Unknown("set logistics.prior_internship_count") if log.get("prior_internship_count") is None
             else Text(str(log["prior_internship_count"]), [rf"^{log['prior_internship_count']}\b"])),
            ("x-travel", r"percentage of (the )?time .{0,30}travel|willing to travel",
             lambda q, *_: Unknown("set logistics.travel_percentage") if log.get("travel_percentage") is None
             else Text(str(log["travel_percentage"]), [rf"\b{log['travel_percentage']}\b"])),
            ("x-background-check", r"background (check|screen|investigation)",
             flag("consents_to_background_check", "consent needs your decision")),
            ("x-interview-recording", r"(record|transcri|ai note ?tak)\w* .{0,60}interview|"
                                      r"interview.{0,60}(recorded|notetak)|interview recording",
             flag("consents_to_interview_recording", "consent needs your decision")),
            ("x-outside-business", r"own, operate, or provide services to any other business|outside business",
             flag("outside_business_activities", "not stated")),
            ("x-hs-graduation", r"graduate from high school|high school graduation",
             lambda q, *_: Text(edu["high_school_graduation"]) if edu.get("high_school_graduation")
             else Unknown("set education.high_school_graduation")),
            ("x-citizenship", r"citizen|u\.?s\.? person|permanent residen|green card|work authorization status|"
                              r"\bitar\b|export (control|license)", lambda q, label, ctx:
             None if re.search(r"sponsor", label) and not re.search(r"citizen|person|residen", label)
             else citizenship(q, label, ctx)),
            ("x-arbitration", r"arbitration", flag("accept_arbitration_agreements", "legal agreement needs your decision")),
            ("x-qualifications", r"meet (each|all|the) .{0,30}(basic |minimum |required )?(qualifications|requirements)|"
                                 r"demonstrated experience in the specified discipline",
             flag("meets_basic_qualifications", "self-assessment against the posting")),
            ("x-offers", r"(outstanding|competing|other|active|current(ly)? have any) offers?\b|offer deadline|"
                         r"recruiting-process deadline", lambda q, label, ctx:
             Text("N/A") if log.get("has_outstanding_offers") is False and q.kind in ("text", "textarea")
             else flag("has_outstanding_offers", "offer status not stated")(q, label, ctx)),
            ("x-further-education", r"further education|graduate school (immediately )?after|"
                                    r"(plan|intend|expect) to pursue an? (master|graduate|ph\.?d|doctor)|"
                                    r"pursue .{0,30}(master'?s|graduate|ph\.?d) (program|degree) after",
             flag("pursuing_further_education_after_degree", "post-degree plans not stated")),
            ("x-notice-period", r"notice period|restrictions on your availability to start",
             flag("notice_period_or_start_restrictions", "not stated")),
            ("x-licenses", r"licenses? or registrations?|series 7|\bfinra\b|security licenses?|actively maintaining",
             lambda q, *_: YesNo(bool(log.get("professional_licenses"))) if q.kind in CHOICE_KINDS else None),
            ("x-graduation-check", r"\bgradu\w*t(ion|ing|e[sd]?)\b|complete (my|your) degree|degree .{0,40}between|"
                                   r"class of 20",
             graduation_check),
            ("x-student-at", r"(current|enrolled) .{0,60}\bstudent\b|student at\b", lambda q, label, ctx:
             student_at(q, label, ctx) if re.search(r"universit|college|institute", label) else None),
            ("x-degree-start", r"when did you (begin|start|enroll)|(began|started) (your )?(current )?(degree|program|studies)|"
                               r"(degree|program|enrollment|college|university) start (date|month|year)",
             lambda q, *_: Text(f"{edu['start_month']:02d}/{edu['start_year']}"
                                if re.search(r"mm/yyyy", f"{q.label} {q.placeholder}".lower()) or q.kind != "date"
                                else start_edu_iso) if q.kind in FREE_KINDS else None),
            ("x-degree-end", r"when do you expect to (complete|finish|graduate)|expect(ed)? to (complete|finish) "
                             r"(your )?(current )?(degree|program|studies)|"
                             r"(intend|plan) to (complete|finish) your degree", graduation),
            ("x-has-degree", r"(have|pursuing),? .{0,40}(college|bachelor'?s?|undergraduate|university) degree",
             lambda q, *_: YesNo(True) if q.kind in CHOICE_KINDS and pick_yes_no(q.options, True) else None),
            ("x-completed-education", r"most recent(ly)? completed .{0,20}(education|degree)|"
                                      r"highest (level of )?education (you have )?completed",
             lambda q, *_: Choice([r"high school|secondary", r"some college"]) if q.kind in CHOICE_KINDS else None),
            ("x-class-next-fall", r"class (year|standing) .{0,40}(entering|be) .{0,12}fall 2027|"
                                  r"(entering|be) .{0,20}fall 2027 as an?",
             lambda q, *_: Choice([r"^senior\b", r"\b(4th|fourth)[- ]year"], text="Senior")
             if (edu["grad_year"], edu["grad_month"]) in ((2028, 5), (2028, 6)) else None),
            ("x-fulltime-ready-year", r"ready for full[- ]time employment in (20\d\d)",
             lambda q, label, ctx: YesNo(edu["grad_year"] <= int(re.search(r"in (20\d\d)", label).group(1)))
             if q.kind in CHOICE_KINDS else None),
            ("x-us-residence", r"primary residence .{0,40}(united states|u\.s\.)",
             lambda q, *_: None if q.kind not in CHOICE_KINDS | {"checkbox"}
             else Text(addr["state"], [rf"^{addr['state']}$", rf"^{addr['state_abbr']}$"])
             if match_option(q.options, addr["state"]) or match_option(q.options, addr["state_abbr"])
             else YesNo(addr["country"].lower().startswith("united states"))),
            ("x-prior-internship", r"(prior|previous|any|professional) .{0,25}(internship|co-?op).{0,25}experience|"
                                   r"completed .{0,25}(previous|prior) internship",
             flag("has_prior_internship", "whether earlier roles count as internships is your call")),
            ("x-grading-scale", r"grading scale|gpa scale", lambda q, *_: Choice(
                [rf"^{re.escape(edu.get('gpa_scale') or '4.0')}\b", r"\b4\.0\b"], text=edu.get("gpa_scale") or "4.0")),
            ("x-school-confirm", r"(re-?confirm|share|name of|provide) .{0,25}(university|school|college)(?!.{0,15}e-?mail)",
             school),
            ("x-legal-name", r"^what is your (full )?legal name|^legal name$", t(ident["full_name"])),
            ("x-post-internship", r"full[- ]time (role|position|employment) .{0,30}(post|after|following)[- ]?"
                                  r"(the |your )?internship|immediately post-?internship", post_internship),
            ("x-season", r"season you are applying|which (term|season|semester)|intern(ship)? season|"
                         r"academic terms? .{0,40}available|"
                         r"season .{0,20}interested|"
                         r"spring co-?op,? summer internship|internship (term|season)", season),
            ("x-position-type", r"type of (position|role|employment) are you (applying|seeking|looking)|"
                                r"type of opportunit(y|ies) .{0,30}interested",
             position_type),
            ("x-preferred-language", r"(which|what|preferred|favorite|primary|strongest) .{0,25}(programming |coding )?"
                                     r"language.{0,40}(prefer|like to (work|use)|most comfortable|strongest|primary)|"
                                     r"preferred (programming |coding )?language",
             lambda *_: Text(p["skills"].get("preferred_language") or p["skills"]["languages"][0],
                             [rf"^{re.escape(x)}\b" for x in ([p["skills"].get("preferred_language")] if
                              p["skills"].get("preferred_language") else []) + p["skills"]["languages"]])),
            ("x-years-experience", r"years? of .{0,50}experience|how (many|much) .{0,30}experience", years_experience),
            ("x-skill-yes-no", r"experience|proficien|familiar|knowledge of|worked with|comfortable|built .{0,30}using",
             skill_yes_no),
            ("x-office", r"location preference|preferred (work |office )?location|(which|what) .{0,20}(office|location)|"
                         r"office preference|where would you (like|prefer) to work|location.{0,20}(apply|interested)|"
                         r"work location", office),
            ("x-interest-area", r"(areas?|teams?|service lines?|tracks?|disciplines?|functions?) .{0,40}interest|"
                                r"which team (best )?(fits|interests|matches)|type of (engineering|intern) role|"
                                r"which (specific )?(role|position|team) .{0,40}interest", interest_area),
            ("x-employer", r"(current|most recent|previous|last|prior) .{0,25}(employer|company|job title|"
                           r"position title|role title)\b|^candidate'?s company$|^(company|employer|organization)$",
             employer),
            ("x-enrollment", r"enrollment status|student status", lambda q, *_: Text(
                edu.get("enrollment_status") or "", [r"bachelor|undergrad", r"full[- ]time"])
             if q.kind not in CHOICE_KINDS else Choice([r"bachelor|undergrad", r"full[- ]time"],
                                                       exclude=r"graduate degree|master|ph\.?d|not enrolled|part")),
            ("x-availability-text", r"^(internship )?(availability|duration)$|how long .{0,30}available|"
                                    r"dates? (are you|you are) available", lambda q, *_: Choice(
                [r"summer", r"\b1[02] ?weeks|10 ?[-–] ?12", r"^3 months$"], text=log.get("availability_text") or None)
                if (q.kind in CHOICE_KINDS or log.get("availability_text")) else None),
            ("x-top-courses", r"(top|favorite|favourite|best) .{0,20}(computer science |cs )?courses",
             lambda q, *_: Text(" and ".join(c.strip() for c in edu["coursework"].split(",")[:2]))
             if q.kind in FREE_KINDS else None),

            # --- work authorization -----------------------------------------
            ("x-work-auth-detail", r"authoriz(ed|ation) to (lawfully |legally )?work|legally authorized", work_auth_detail),
            ("work-auth-us", r"authoriz(ed|ation) to (lawfully |legally )?work|valid authorization to work|"
                             r"legally (permitted|authorized) to .{0,20}work", lambda q, label, ctx:
             work_auth(q, label, ctx) if not re.search(r"sponsor|citizen(?!.{0,40}e\.g)|permanent basis", label)
             and q.kind in CHOICE_KINDS and pick_yes_no(q.options, True) else None),
            ("sponsorship", r"sponsor|\bfil(e|ing) (a |an )?petition|employment[- ]?based immigration|"
                            r"employment eligibility status", sponsorship),
            ("never-answer", r"citizen|u\.?s\.? person|\bitar\b|export control|\bear\b|green card|"
                             r"permanent resident|visa (status|type|category)|immigration status|"
                             r"(current|type of|which|what) visa|work visa|\bopt\b(?! ?-?(in|out))|\bcpt\b|clearance|"
                             r"country of (birth|citizenship|origin)|national(ity)?\b|date of birth|\bdob\b|"
                             r"social security|\bssn\b|criminal|convicted|felony|background check|drug|"
                             r"civil action|lawsuit|litigation|pending investigation|regulatory (action|proceeding)|"
                             r"disciplinary|bankrupt|arrest|charged with|sanction(s|ed)\b|terminated|dismissed from",
             unk("citizenship / visa / clearance / legal history is not in the profile")),
            ("age-18", r"\b18\b.{0,25}(years|older|age)|age of 18|legal age", lambda *_: YesNo(auth["over_18"])),
            ("languages", r"(programming|coding) languages",
             lambda *_: Multi(p["skills"]["languages"])),
            ("experience", r"\bexperience\b|years of (experience|work|professional)|have you (ever )?(used|built|written|programmed|shipped)|"
                           r"proficien|familiar(ity)? with|\brate your|\brank your|how (comfortable|strong|skilled)",
             unk("experience and skill self-assessments are never auto-answered")),
            ("work-auth", r"authoriz(ed|ation) to (lawfully |legally )?work|work authorization|"
                          r"eligible to work|legally (able|permitted|entitled|allowed) to work|"
                          r"right to work|authorized to work", work_auth),

            # --- identity ---------------------------------------------------
            ("preferred-name", r"preferred (first |given )?name|nickname|goes? by|name you (go by|prefer)|chosen name",
             t(ident["preferred_name"])),
            ("preferred-last-name", r"preferred (last|family) name", t(ident["last_name"])),
            ("middle-name", r"middle (name|initial)",
             lambda q, *_: Text(ident["middle_name"]) if ident.get("middle_name")
             else (Text("N/A") if q.required and q.kind in ("text", "textarea") else Skip())),
            ("first-name", r"^(legal )?first name|given name|^first$", t(ident["first_name"])),
            ("last-name", r"^(legal )?last name|surname|family name|^last$", t(ident["last_name"])),
            ("school", r"\b(school|university|college|institution)\b(?!.{0,30}\b(year|gpa|email|location|"
                       r"city|state|graduat\w*|start|end|major|degree)\b)", school),
            ("name", r"\bname\b|\bsignature\b|\be-?sign(ature)?\b", name),
            ("pronouns", r"pronoun", decline_only),
            ("email", r"^e-?mail|e-?mail address", t(ident["email"])),
            ("phone-type", r"phone (device )?type", t(ident["phone_type"])),
            ("phone-country", r"country (calling )?code|phone country", lambda *_: Choice(
                [r"united states.*\+1|\+1.*united states", r"^united states", r"^\+1$"], text=ident["country_code"])),
            ("phone", r"phone|mobile( number)?$|cell", t(ident["phone_formatted"])),

            # --- address ----------------------------------------------------
            ("address-2", r"address (line )?2|apt|apartment|suite|unit\b", skip),
            ("address", r"address", address),
            ("zip", r"\bzip\b|postal", t(addr["postal_code"])),
            ("residence-country", r"^(what|which|please select).{0,25}country.{0,30}(resid|live|located|based)",
             lambda *_: Text(addr["country"], [r"^united states( of america)?$", r"^usa?$", r"^united states"])),
            ("residence-state", r"^(what|which|please select).{0,25}state\b.{0,40}(resid|live|located|based)",
             lambda *_: Text(addr["state"], [rf"^{addr['state_abbr']}$", rf"^{addr['state']}\b"])),
            ("local-resident", r"^(are you|do you|will you).{0,20}(local|located|based|living|residing|live|reside)\b|"
                               r"local to",
             local_resident),
            ("state-and-country", r"state and country .{0,30}(resid|live|located|based)",
             lambda q, *_: Text(f"{addr['state']}, {addr['country']}") if q.kind in FREE_KINDS else None),
            ("city", r"^(current )?city$|city of residence|^city\b(?!.*state)|which city do you|"
                     r"^what city .{0,30}(resid|live|located|based)",
             t(addr["city"])),
            ("state", r"^(current |home )?state$|state/province|^province|state of residence|^state\b(?!ment)|"
                      r"state .{0,40}work(ing)? (remotely )?from",
             lambda *_: Text(addr["state"], [rf"^{addr['state_abbr']}$", rf"^{addr['state']}\b"])),
            ("country", r"^country$|country of residence|country (where|in which) you|^country\b|"
                        r"country .{0,30}(located|based|live|reside)",
             lambda *_: Text(addr["country"], [r"^united states( of america)?$", r"^usa?$", r"^united states"])),
            ("location", r"^(your )?(current )?location|where are you (currently )?(located|based)|"
                         r"city (and|&|/|,) ?state|current city", location),

            # --- links ------------------------------------------------------
            ("link-password", r"password", skip),
            ("linkedin", r"linkedin", t(links["linkedin"])),
            ("github", r"github|git hub", lambda q, label, ctx: Text(
                links["github"].rstrip("/").rsplit("/", 1)[-1] if re.search(r"username|handle|user ?name", label)
                else links["github"])),
            ("social", r"twitter|\bx\.com|instagram|facebook|tiktok", skip),
            ("portfolio", r"website|portfolio|personal (site|page|url)|other (link|url)|\bblog\b",
             t(links["portfolio"])),

            # --- education --------------------------------------------------
            ("gpa", r"\bgpa\b|grade point", gpa),
            ("degree-and-major", r"degree.{0,25}(field of study|major)|(field of study|major).{0,25}degree(?! program)",
             lambda q, *_: Text(f"{edu['degree_short']} in {edu['major']}") if q.kind in FREE_KINDS else None),
            ("graduation", r"\bgradu\w*t(ion|ing|e[sd]?)\b(?! (student|degree|program|school|studies|level))|"
                           r"degree completion|completion date|conferral|degree date", graduation),
            ("minor", r"\bminor\b", skip),
            ("major", r"\bmajor\b|fields? of study|discipline|area of study|degree program|concentration",
             lambda q, label, ctx: (Choice([r"^n/?a\b|not applicable|^none\b"]) if q.kind in CHOICE_KINDS else Skip())
             if re.search(r"postgraduate|(?<![a-z])graduate (degree|program|school)|master|ph\.?d|second major", label)
             else Text(edu["major"], [r"^computer science\b"])),
            ("class-standing", r"class standing|year in school|current (school |academic )?year|academic "
                               r"(year|level|standing)|what year are you|classification|grade level|"
                               r"year of study|school year", lambda *_: Choice(
                [rf"^{edu['class_standing']}\b", rf"\({edu['class_standing']}\)", r"\b(3rd|third)[- ]year"],
                text=edu["class_standing"], exclude=r"rising")),
            ("edu-start", r"(school|education|degree|university|enrollment) start|start date.*(school|degree)",
             lambda q, *_: Text(_fmt_date(start_edu_iso, q))),
            ("degree", r"degree|level of (study|education)|education level|highest (level of )?education", degree),
            ("returning-to-school", r"return(ing)? to (school|university|college|your (degree|program|studies)|"
                                    r"an? degree[- ]seeking program)|"
                                    r"(semester|quarter|term|year)s? (remaining|left) (of|in|after)|"
                                    r"continu(e|ing) (your |in your )?(education|studies|degree) after",
             lambda *_: YesNo((edu["grad_year"], edu["grad_month"]) > (2027, 8))),
            ("enrolled", r"currently (enrolled|pursuing|a student|attending)|are you (enrolled|a (current )?student)|"
                         r"(be|are you) an? (active|current) (college |university )?student|actively enrolled",
             lambda q, label, ctx: YesNo(False) if "high school" in label
             else None if re.search(r"master|ph\.?d|graduate (program|degree)|mba", label) else YesNo(True)),
            ("coursework", r"coursework|relevant courses", t(edu["coursework"])),

            # --- logistics ---------------------------------------------------
            ("end-date", r"end date|latest .{0,20}end|available (until|through)|until when|"
                         r"plan(ning)? (on|to) end(ing)?|when .{0,30}end(ing)? your internship", end_date),
            ("start-date", r"(earliest|available|availability|when (can|could|would) you|able to|month you)"
                           r".{0,40}start|start date|date available|when are you available|"
                           r"when (are|will) you (be )?able to join|when can you join", start_date),
            ("summer-availability", r"available .{0,60}(summer|full[- ]time|\d+[- ]?weeks?|40 hours|entire|duration)|"
                                    r"commit to .{0,40}(weeks|summer|full)|able to (work|commit) .{0,40}"
                                    r"(summer|\d+ ?weeks|full[- ]time|40 hours)|availability for an? summer|"
                                    r"looking for an? summer intern", summer_availability),
            ("relocate", r"relocat", lambda q, label, ctx: office(q, label, ctx)
             if q.kind in CHOICE_KINDS and pick_yes_no(q.options, True) is None
             and not pick_pattern(q.options, [r"^yes\b(?!.*already (live|based|located)).*\brelocat"])
             and re.search(r"office|location|where|which", label)
             else YesNo(log["willing_to_relocate"], [r"^yes\b(?!.*already (live|based|located)).*\brelocat"])),
            ("onsite", r"on-?site|in[- ]office|in[- ]person|\bhybrid\b|commut|days (a|per|each) week|"
                       r"work from (the|our) .{0,30}office|come into (the|our) office", onsite),
            ("remote", r"(willing|able|open|comfortable|prefer|interested).{0,40}\bremote(ly)?\b",
             lambda q, label, ctx: YesNo(log["remote"]) if q.kind in CHOICE_KINDS and _within_window(label, log) is not False
             else None),
            ("compensation", r"salary|compensation|hourly rate|pay (expectation|rate|range)|\bwage", compensation),
            ("heard-about", r"(how|where) (did )?you (first )?(hear|heard|find|found|learn|learned|come across|"
                            r"discover|see)|how were you referred|referral source|source of", heard),
            ("referral", r"referr|referred by|who referred|employee referral",
             lambda q, *_: YesNo(False) if q.kind in CHOICE_KINDS
             else (Text("N/A") if q.required and q.kind in ("text", "textarea") else Skip())),

            # --- history with the company ------------------------------------
            ("non-compete", r"non-?compet|restrictive covenant|non-?solicit|prohibited or limited|"
                            r"post-employment obligations|agreement.{0,60}(restrict|prohibit|limit|prevent)",
             lambda *_: YesNo(log["non_compete"])),
            ("relatives", r"relative|family member|related to (any|an|a)\b|spouse|in-laws|household member",
             lambda *_: YesNo(log["relatives_at_company"])),
            ("third-party-employment", r"client|competitor|partner|vendor|customer|supplier|public official|"
                                       r"government official", third_party_employment),
            ("federal-government", r"federal government|government employee|employed by the (u\.?s\.? )?government|"
                                   r"(u\.?s\.? )?government employment|"
                                   r"worked for the (u\.?s\.? )?(federal )?government",
             lambda *_: YesNo(log["worked_for_us_federal_government"])),
            ("applied-before", r"(previously|ever|before|already|in the past|prior).{0,40}appl(y|ied)|"
                               r"appl(y|ied).{0,60}(before|previously|in the past)", applied_before),
            ("worked-before", r"(previously|ever|before|formerly|in the past|prior|currently|current or former)"
                              r".{0,60}(worked|employed|employee|interned|contractor)|former employee|"
                              r"(worked|employed|interned) (by|at|for|with) .{0,50}(before|previously|in the past)|"
                              r"worked (for|at|with) .{0,50}(before|previously|in the past)|"
                              r"worked (with|for) us\b|currently working (as|with|at|for)|"
                              r"engaged to perform services",
             lambda *_: YesNo(log["previously_worked_or_applied"])),
            ("non-compete", r"non-?compete|restrictive covenant|non-?solicit|prohibited or limited|"
                            r"agreement.{0,60}(restrict|prohibit|limit|prevent)",
             lambda *_: YesNo(log["non_compete"])),

            # --- EEO ---------------------------------------------------------
            ("hispanic", r"hispanic|latin[oax]", hispanic),
            ("race", r"\brace\b|ethnic", race),
            ("veteran", r"veteran|(served|service|serving) in the .{0,30}(military|armed forces|uniformed services)|"
                        r"military (status|service)$", veteran),
            ("disability", r"disabilit", disability),
            ("orientation", r"sexual orientation|lgbt", orientation),
            ("transgender", r"transgender|trans experience", decline_only),
            ("gender", r"gender|\bsex\b", gender),

            # --- essays the profile actually contains -------------------------
            ("essay-project", r"(challenging|difficult|complex|hardest|proud|toughest|impactful|impressive).{0,60}"
                              r"(project|problem|thing) (that )?you('ve| have)? (built|worked on|solved|faced|tackled|"
                              r"completed|encountered|shipped)|"
                              r"(technical |engineering |software )project you('ve| have)? (built|worked on|completed)",
             lambda q, label, ctx: None if (ctx.company and ctx.company.lower() in label)
             or re.search(r"publicly available|our (product|company|team|mission)|we (face|are facing)", label)
             else essay_limit_ok(p["essays"]["challenging_project"])(q, label, ctx)),
            ("essay-why-swe", r"^why (did you choose |do you want to (study|pursue) |are you (pursuing|studying) )?"
                              r"(a career in )?(software engineering|computer science|engineering|technology)\??$|"
                              r"what (drives|motivates|sparked) your (interest|passion) in "
                              r"(technology|engineering|software)[^,]*$",
             lambda q, label, ctx: None if (ctx.company and ctx.company.lower() in label)
             else essay_limit_ok(p["essays"]["why_software_engineering"])(q, label, ctx)),

            # --- acknowledgements (last, and only for genuine notices) -----------
            ("consent", r"privacy|terms (and|&) conditions|data (protection|processing)|\bcertify\b|acknowledg|"
                        r"true,? (complete|correct|and accurate)|true and (correct|complete|accurate)|"
                        r"accurate to the best|code of conduct|"
                        r"i understand that|i have read|candidate (notice|policy)|non-?disclos|not disclos|\bconsent\b",
             lambda q, label, ctx: Check() if re.search(
                 r"true,? (and )?(complete|correct|accurate)|\bcertify\b.{0,80}(true|accurate|complete)|"
                 r"information (i|you) provide.{0,40}true", label) else None if re.search(
                 r"\bdates?\b|availab|prefer|suitable|relocat|commit|\bqualif|\bexperience\b|background check|"
                 r"record(ed|ing)|arbitration|release", label) else Check()),
            ("x-na-fallback", r"(enter|type|write|put|state|answer) [\"'“]?n/?a\b|n/a if (not applicable|none)",
             na_fallback),
        ]


# rules that may also fire on a meaningful field id (e.g. id="first_name")
_ID_RULES = {"first-name", "last-name", "preferred-name", "email", "phone", "linkedin", "github",
             "gender", "race", "veteran", "disability", "hispanic"}


def _char_limit(q: Question) -> int | None:
    m = re.search(r"(?:max(?:imum)?|limit|up to)\D{0,12}(\d{2,5})\s*char", f"{q.label} {q.description}", re.I)
    return int(m.group(1)) if m else None


def pattern_for(label: str) -> str:
    """The custom_answers.json pattern that matches exactly this question."""
    return "^" + re.escape(norm(label)) + "$"


def remember_answers(items: list[dict], company: str, path: Path | None = None) -> int:
    """Store answers the candidate gave in the browser so the same question is answered next time.

    items: {"label", "kind", "value"} as read back from the form. Not remembered: uploads, empty
    values, and AI-use / authorship attestations (those are answered by the person every time).
    Essays and questions that name the employer are stored for that employer only.
    """
    path = Path(path or config.CUSTOM_ANSWERS_JSON)
    custom = load_custom_answers(path)
    added = 0
    for item in items:
        label, value, kind = item.get("label") or "", item.get("value"), item.get("kind") or "text"
        if not label.strip() or not value or kind == "file" or AI_POLICY.search(label):
            continue
        entry = {"pattern": pattern_for(label), "answer": value, "learned_from": company}
        essay = isinstance(value, str) and (kind == "textarea" or len(value) > 120)
        if company and (company.lower() in label.lower() or essay):
            entry["company"] = "^" + re.escape(company) + "$"
        custom = [e for e in custom if not (e.get("pattern") == entry["pattern"]
                                            and e.get("company") == entry.get("company"))]
        custom.append(entry)
        added += 1
    if added:
        path.write_text(json.dumps(custom, indent=1, ensure_ascii=False), encoding="utf-8")
    return added


def existing_file(path: str | None) -> str | None:
    """Absolute path of an optional profile file (transcript, cover letter) if it is really there."""
    if not path:
        return None
    p = Path(path)
    if not p.is_absolute():
        p = config.BASE / p
    return str(p) if p.is_file() else None


def load_custom_answers(path: Path | None = None) -> list[dict]:
    path = Path(path or config.CUSTOM_ANSWERS_JSON)
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return [e for e in data if isinstance(e, dict) and e.get("pattern")]


def today_iso() -> str:
    return date.today().isoformat()
