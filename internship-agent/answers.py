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
ESSAY_RULES = {"essay-project", "essay-why-swe", "follow-up", "never-answer"}

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
    if not yes and not no and len(opts) == 2:
        neg = [o for o in opts if NEGATION.search(o)]
        if len(neg) == 1:
            pos = [o for o in opts if o not in neg][0]
            return pos if want_yes else neg[0]
    return None


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

        essay_prompt = bool(ESSAY_PROMPT.search(label))
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
                return Decision("fill", wrap(hit), rule) if hit else unknown(
                    f"wanted {'Yes' if intent.yes else 'No'} but options are {q.options}")
            if q.kind == "text" and re.match(
                    r"(are|do|does|will|would|have|has|can|could|is|did|were)\b", norm(q.label)):
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
            elif q.kind in CHOICE_KINDS:
                intent = Text(str(answer), [re.escape(str(answer))])
            else:
                intent = Text(str(answer))
            d = self._apply(intent, q, "custom")
            if d.action == "fill":
                return d
        return None

    # -- files ------------------------------------------------------------------
    def _file(self, q: Question, label: str) -> Decision:
        if re.search(r"resume|\bcv\b|curriculum", label) and "cover" not in label:
            return Decision("fill", self.p["resume_path"], "resume")
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
            return Skip()

        def sponsorship(q, label, ctx):
            if re.search(r"citizen|u\.?s\.? person|permanent resident|green card|independent contractor", label):
                return Unknown("mixes sponsorship with another status question")
            if q.kind not in CHOICE_KINDS | {"text"}:
                return Skip()
            needs = auth["requires_sponsorship"]
            # Judge polarity on the actual question, not on explanatory text after it.
            first = label.split("?")[0]
            if re.search(r"(authoriz|eligib|able|permitted|right)\w* to work.{0,80}without.{0,40}sponsor", first):
                return YesNo(auth["authorized_to_work_us"] and not needs)   # "...without sponsorship?"
            if re.search(r"(require|need)\w*.{0,80}sponsor|sponsor\w*.{0,30}(required|needed)|"
                         r"require .{0,60}to (sponsor|commence)", first):
                return YesNo(needs)
            return Unknown("could not determine what the sponsorship question asks")

        def work_auth(q, label, ctx):
            if re.search(r"canada|united kingdom|\buk\b|europe|\beu\b|india|germany|australia|"
                         r"ireland|singapore|japan|mexico", label):
                return Unknown("work authorization outside the U.S. is not in the profile")
            return YesNo(auth["authorized_to_work_us"])

        def name(q, label, ctx):
            if re.search(r"native language|pronunc|phonetic|characters", label):
                return Skip()
            core = re.sub(r"[^a-z ]", "", label).strip()
            if core in {"name", "full name", "legal name", "full legal name", "your name",
                        "your full name", "candidate name", "first and last name",
                        "applicant name", "full name first and last"} \
                    or re.search(r"full legal name|signature|e-?sign|(type|enter(ing)?|provide|state) (my |your )"
                                 r"(full )?(legal )?name", label):
                return Text(ident["full_name"])
            return None

        def address(q, label, ctx):
            others = " | ".join(norm(l) for l in ctx.labels)
            if re.search(r"line 1|street", label) or re.search(r"\bcity\b|zip|postal", others.replace(label, "")):
                return Text(addr["line1"])
            return Text(full_addr)

        def location(q, label, ctx):
            if q.kind in CHOICE_KINDS and len(q.options) <= 12:
                return Unknown("location choice needs a human decision")
            return Text(city_state, [rf"^{addr['city']}\b.*\b({addr['state']}|{addr['state_abbr']})\b"])

        def graduation(q, label, ctx):
            year = str(edu["grad_year"])
            if q.kind in CHOICE_KINDS:
                with_year = [o for o in q.options if year in o]
                if len(with_year) == 1:
                    return Text(with_year[0], [re.escape(with_year[0])])
                season = [o for o in with_year if re.search(rf"{grad_month}|spring", o, re.I)]
                if len(season) == 1:
                    return Text(season[0], [re.escape(season[0])])
                if not with_year and "month" in label:
                    return Text(grad_month)
                return Unknown(f"no single option for {grad_month} {year}")
            if re.search(r"\byear\b", label) and "month" not in label:
                return Text(year)
            if "month" in label and "year" not in label:
                return Text(grad_month)
            hint = f"{q.placeholder} {label}"
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
                return Choice([rf"^{month}\b[^-–]*{iso[:4]}$", rf"^{month}$"])
            if re.search(r"\b(end|finish|conclude)", label):
                return Text(f"{_long_date(iso)} – {_long_date(log['latest_end'])}")
            return Text(_fmt_date(iso, q))

        def end_date(q, label, ctx):
            if q.kind in CHOICE_KINDS:
                month = MONTHS[int(log["latest_end"][5:7]) - 1]
                return Choice([rf"^{month}\b"])
            return Text(_fmt_date(log["latest_end"], q))

        def summer_availability(q, label, ctx):
            if q.kind not in CHOICE_KINDS:
                return None
            if re.search(r"post-?internship|after (the|your|this) internship|full[- ]time (role|position|offer)|"
                         r"upon graduation|return offer|6[- ]month|co-?op|part[- ]time|"
                         r"\b(4[1-9]|[5-9]\d)\+? hours", label) or _within_window(label, log) is False:
                return Unknown("availability outside the stated internship window")
            return YesNo(True)

        def onsite(q, label, ctx):
            if q.kind not in CHOICE_KINDS | {"checkbox"}:
                return None
            # a dated or extra-hours commitment is not the same as "willing to work on-site"
            if _within_window(label, log) is False or re.search(r"\b(4[1-9]|[5-9]\d)\+? hours", label):
                return Unknown("on-site question bundles a dated or extra-hours commitment")
            return YesNo(log["onsite"] and log["hybrid"])

        def compensation(q, label, ctx):
            if q.kind == "number":
                return Text(log["desired_hourly_rate"])
            if q.kind in CHOICE_KINDS:
                return Unknown("compensation range choice")
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
            return Unknown("employment with a client/competitor is not in the profile")

        def marketing(q, label, ctx):
            if q.kind == "checkbox" or not q.required:
                return Skip()
            return YesNo(False)

        def degree(q, label, ctx):
            if re.search(r"highest .*(complete|attain|obtain|earn|achiev)|completed", label):
                return Choice([r"bachelor.*(in progress|pursuing|current|enrolled)",
                               r"(pursuing|current|enrolled|working toward).*bachelor", r"some college"])
            return Choice([r"bachelor of science", r"^b\.?s\.?\b", r"bachelor", r"undergrad"],
                          text=edu["degree"], exclude=r"associate|master|doctor|ph\.?d|mba|high school")

        def school(q, label, ctx):
            if re.match(r"(are|do|does|have|has|will|did|is|can|when|where) ", label):
                return None
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

        yes, no = (lambda *_: YesNo(True)), (lambda *_: YesNo(False))
        t = lambda v: (lambda *_: Text(v))
        skip = lambda *_: Skip()
        unk = lambda why: (lambda *_: Unknown(why))

        return [
            # --- conditional follow-ups: never answered unless optional ------
            ("follow-up", r"^if (yes|no|so|other|not|applicable|you (do|did|chose|selected|answered|were|are|have))\b|"
                          r"^if .{0,30}(please|kindly)|please (specify|explain|elaborate|list|describe) if|^other\b|"
                          r"^(please )?(specify|explain)\b", follow_up),

            # --- work authorization -----------------------------------------
            ("sponsorship", r"sponsor", sponsorship),
            ("never-answer", r"citizen|u\.?s\.? person|\bitar\b|export control|\bear\b|green card|"
                             r"permanent resident|visa (status|type|category)|immigration status|"
                             r"(current|type of|which|what) visa|work visa|\bopt\b|\bcpt\b|clearance|"
                             r"country of (birth|citizenship|origin)|national(ity)?\b|date of birth|\bdob\b|"
                             r"social security|\bssn\b|criminal|convicted|felony|background check|drug|"
                             r"accommodation|reasonable adjustment",
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

            ("marketing", r"\bsms\b|text messag|marketing|newsletter|talent (community|network|pool)|"
                          r"future (opportunities|openings|roles|positions)|job alerts|whatsapp", marketing),

            # --- identity ---------------------------------------------------
            ("preferred-name", r"preferred (first |given )?name|nickname|goes? by|name you (go by|prefer)|chosen name",
             t(ident["preferred_name"])),
            ("preferred-last-name", r"preferred (last|family) name", t(ident["last_name"])),
            ("middle-name", r"middle (name|initial)", skip),
            ("first-name", r"^(legal )?first name|given name|^first$", t(ident["first_name"])),
            ("last-name", r"^(legal )?last name|surname|family name|^last$", t(ident["last_name"])),
            ("school", r"\b(school|university|college|institution)\b(?!.{0,30}(year|gpa|email|location|"
                       r"city|state|graduat|start|end|major|degree))", school),
            ("name", r"name|signature|e-?sign", name),
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
             unk("where the candidate lives relative to this office needs a human answer")),
            ("city", r"^(current )?city$|city of residence|^city\b(?!.*state)|which city do you",
             t(addr["city"])),
            ("state", r"^state$|state/province|^province|state of residence|^state\b(?!ment)",
             lambda *_: Text(addr["state"], [rf"^{addr['state_abbr']}$", rf"^{addr['state']}\b"])),
            ("country", r"^country$|country of residence|country (where|in which) you|^country\b",
             lambda *_: Text(addr["country"], [r"^united states( of america)?$", r"^usa?$", r"^united states"])),
            ("location", r"^(current |your )?location|where are you (currently )?(located|based)|"
                         r"city (and|&|/|,) ?state|current city", location),

            # --- links ------------------------------------------------------
            ("link-password", r"password", skip),
            ("linkedin", r"linkedin", t(links["linkedin"])),
            ("github", r"github|git hub", t(links["github"])),
            ("social", r"twitter|\bx\.com|instagram|facebook|tiktok", skip),
            ("portfolio", r"website|portfolio|personal (site|page|url)|other (link|url)|\bblog\b",
             t(links["portfolio"])),

            # --- education --------------------------------------------------
            ("gpa", r"\bgpa\b|grade point", gpa),
            ("degree-and-major", r"degree.{0,25}(field of study|major)|(field of study|major).{0,25}degree(?! program)",
             lambda q, *_: Text(f"{edu['degree_short']} in {edu['major']}") if q.kind in FREE_KINDS else None),
            ("graduation", r"graduat|degree completion|completion date|conferral|degree date", graduation),
            ("minor", r"\bminor\b", skip),
            ("major", r"\bmajor\b|field of study|discipline|area of study|degree program|concentration",
             lambda *_: Text(edu["major"], [r"^computer science\b"])),
            ("class-standing", r"class standing|year in school|current (school |academic )?year|academic "
                               r"(year|level|standing)|what year are you|classification|grade level|"
                               r"year of study|school year", lambda *_: Choice(
                [rf"^{edu['class_standing']}\b", rf"\({edu['class_standing']}\)", r"\b(3rd|third)[- ]year"],
                text=edu["class_standing"], exclude=r"rising")),
            ("edu-start", r"(school|education|degree|university|enrollment) start|start date.*(school|degree)",
             lambda q, *_: Text(_fmt_date(start_edu_iso, q))),
            ("degree", r"degree|level of (study|education)|education level|highest (level of )?education", degree),
            ("returning-to-school", r"return(ing)? to (school|university|college|your (degree|program|studies))|"
                                    r"(semester|quarter|term|year)s? (remaining|left) (of|in|after)|"
                                    r"continu(e|ing) (your |in your )?(education|studies|degree) after",
             lambda *_: YesNo((edu["grad_year"], edu["grad_month"]) > (2027, 8))),
            ("enrolled", r"currently (enrolled|pursuing|a student|attending)|are you (enrolled|a (current )?student)",
             lambda q, label, ctx: None if re.search(r"master|ph\.?d|graduate (program|degree)|mba", label)
             else YesNo(True)),
            ("coursework", r"coursework|relevant courses", t(edu["coursework"])),

            # --- logistics ---------------------------------------------------
            ("end-date", r"end date|latest .{0,20}end|available (until|through)|until when", end_date),
            ("start-date", r"(earliest|available|availability|when (can|could|would) you|able to|month you)"
                           r".{0,40}start|start date|date available|when are you available", start_date),
            ("summer-availability", r"available .{0,60}(summer|full[- ]time|\d+ ?weeks|40 hours|entire|duration)|"
                                    r"commit to .{0,40}(weeks|summer|full)|able to (work|commit) .{0,40}"
                                    r"(summer|\d+ ?weeks|full[- ]time)", summer_availability),
            ("relocate", r"relocat", lambda *_: YesNo(
                log["willing_to_relocate"], [r"^yes\b(?!.*already (live|based|located)).*\brelocat"])),
            ("onsite", r"on-?site|in[- ]office|in[- ]person|\bhybrid\b|commut|days (a|per|each) week|"
                       r"work from (the|our) .{0,30}office|come into (the|our) office", onsite),
            ("remote", r"(willing|able|open|comfortable|prefer|interested).{0,40}\bremote(ly)?\b",
             lambda q, label, ctx: YesNo(log["remote"]) if q.kind in CHOICE_KINDS and _within_window(label, log) is not False
             else None),
            ("compensation", r"salary|compensation|hourly rate|pay (expectation|rate|range)|\bwage", compensation),
            ("heard-about", r"how did you (first )?(hear|find|learn|come across|discover)|where did you "
                            r"(hear|find|learn|see)|how were you referred|referral source|source of", heard),
            ("referral", r"referr|referred by|who referred|employee referral", skip),

            # --- history with the company ------------------------------------
            ("relatives", r"relative|family member|related to (any|an|a)\b|spouse|in-laws|household member",
             lambda *_: YesNo(log["relatives_at_company"])),
            ("third-party-employment", r"client|competitor|partner|vendor|customer|supplier|public official|"
                                       r"government official", third_party_employment),
            ("federal-government", r"federal government|government employee|employed by the (u\.?s\.? )?government|"
                                   r"worked for the (u\.?s\.? )?(federal )?government",
             lambda *_: YesNo(log["worked_for_us_federal_government"])),
            ("applied-before", r"(previously|ever|before|already|in the past|prior).{0,40}appl(y|ied)|"
                               r"appl(y|ied).{0,60}(before|previously|in the past)", applied_before),
            ("worked-before", r"(previously|ever|before|formerly|in the past|prior|currently|current or former)"
                              r".{0,60}(worked|employed|employee|interned|contractor)|former employee|"
                              r"(worked|employed|interned) (by|at|for|with) .{0,50}(before|previously|in the past)|"
                              r"worked (for|at|with) .{0,50}(before|previously|in the past)",
             lambda *_: YesNo(log["previously_worked_or_applied"])),
            ("non-compete", r"non-?compete|restrictive covenant|non-?solicit|prohibited or limited|"
                            r"agreement.{0,60}(restrict|prohibit|limit|prevent)",
             lambda *_: YesNo(log["non_compete"])),

            # --- EEO ---------------------------------------------------------
            ("hispanic", r"hispanic|latin[oax]", hispanic),
            ("race", r"\brace\b|ethnic", race),
            ("veteran", r"veteran|military|armed forces|uniformed service", veteran),
            ("disability", r"disabilit", disability),
            ("orientation", r"sexual orientation|lgbt", orientation),
            ("transgender", r"transgender|trans experience", decline_only),
            ("gender", r"gender|\bsex\b", gender),

            # --- essays the profile actually contains -------------------------
            ("essay-project", r"(challenging|difficult|complex|hardest|proud|toughest|impactful).{0,60}"
                              r"(project|technical problem|thing you('ve| have) built)|"
                              r"(technical |engineering |software )project you('ve| have)? (built|worked on|completed)",
             essay_limit_ok(p["essays"]["challenging_project"])),
            ("essay-why-swe", r"^why (did you choose |do you want to (study|pursue) |are you (pursuing|studying) )?"
                              r"(a career in )?(software engineering|computer science|engineering|technology)\??$|"
                              r"what (drives|motivates|sparked) your (interest|passion) in "
                              r"(technology|engineering|software)[^,]*$",
             lambda q, label, ctx: None if (ctx.company and ctx.company.lower() in label)
             else essay_limit_ok(p["essays"]["why_software_engineering"])(q, label, ctx)),

            # --- acknowledgements (last, and only for genuine notices) -----------
            ("consent", r"privacy|terms (and|&) conditions|data (protection|processing)|\bcertify\b|acknowledg|"
                        r"true,? (complete|correct|and accurate)|accurate to the best|code of conduct|"
                        r"i understand that|i have read|candidate (notice|policy)|non-?disclos|not disclos|\bconsent\b",
             lambda q, label, ctx: None if re.search(
                 r"\bdates?\b|availab|prefer|suitable|relocat|commit|\bqualif|\bexperience\b", label) else Check()),
        ]


# rules that may also fire on a meaningful field id (e.g. id="first_name")
_ID_RULES = {"first-name", "last-name", "preferred-name", "email", "phone", "linkedin", "github",
             "gender", "race", "veteran", "disability", "hispanic"}


def _char_limit(q: Question) -> int | None:
    m = re.search(r"(?:max(?:imum)?|limit|up to)\D{0,12}(\d{2,5})\s*char", f"{q.label} {q.description}", re.I)
    return int(m.group(1)) if m else None


def load_custom_answers(path: Path | None = None) -> list[dict]:
    path = Path(path or config.CUSTOM_ANSWERS_JSON)
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return [e for e in data if isinstance(e, dict) and e.get("pattern")]


def today_iso() -> str:
    return date.today().isoformat()
