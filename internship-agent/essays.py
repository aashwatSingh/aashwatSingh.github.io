"""Open-ended answers written from the candidate's own resume material.

Every sentence is assembled from candidate_profile.json (projects, experience,
essays, education) plus the company name, role title and technologies that
appear in BOTH the posting and the profile. Nothing else is asserted, so the
output can be generic about the company but never untrue about the candidate.

Question types handled by templates:
    why_company   "Why do you want to intern at X?", "Why X?", "What makes X attractive?"
    project       "Tell us about a project", "proudest technical accomplishment", "favorite work project"
    achievements  "top two accomplishments", "most impressive thing you've accomplished"
    goals         "What do you want to get out of this internship?", "most excited to work on"
    why_swe       "Which aspect of software engineering excites you?", "Why software engineering?"

Anything else that needs a story the resume does not contain ("describe a time
messy data led you to a wrong answer") is left to llm.py when an API key is
set, and otherwise to the candidate: a template cannot answer it truthfully.
"""
from __future__ import annotations

import re

KINDS = [
    ("skip", r"^(additional|other|any other|anything else).{0,40}(information|comments?|details|share|like us to know)|"
             r"^(additional information|comments?|notes?|values)$|cover letter|is there anything"),
    ("example_1", r"provide .{0,40}(\d\s*(-|–|to)\s*\d|\d|several|a few) examples .{0,80}(exceptional|ability|impact)|"
                  r"^first example"),
    ("example_2", r"^second example"),
    ("example_3", r"^third example"),
    ("example_4", r"^fourth example"),
    ("bullets", r"bullet points? .{0,70}(exceptional|accomplish|achiev|ability|impact)|"
                r"(exceptional|accomplish|achiev).{0,60}bullet points?"),
    ("experience_summary", r"^(please )?(share|describe|list|summari[sz]e|tell us about) your (previous |prior |relevant |"
                           r"past )?(internship|work|research|professional|engineering|technical)"
                           r"[a-z ,/&-]{0,90}experience\.?:?$"),
    ("built_before", r"^have you built (or worked on )?(any |an? )?(apps?|projects?|products?|software|websites?) before"),
    ("achievements", r"(top|two|2|three|3) .{0,90}(accomplishments|achievements)"),
    ("project", r"(project|problem|thing|piece|work) .{0,40}you('ve| have| are|'re)? (built|worked on|solved|shipped|"
                r"completed|made|created|most proud of)|tell us about .{0,40}project|describe .{0,40}project|"
                r"favorite (work )?project|proud(est)? .{0,30}(technical|project|work|accomplishment|achievement)|"
                r"technical (accomplishment|challenge|project)|something you('ve| have)? built|"
                r"most impressive thing you('ve| have)? (ever )?(accomplished|done|built)|work you('re| are) proudest of"),
    ("ai_experience", r"describe your (ai|ml|machine learning|artificial intelligence)( and ml|/ml)? experience"),
    ("goals", r"(want|hope|expect|looking) to (get out of|gain|learn|achieve|accomplish) .{0,60}(intern|program|role|"
              r"experience|position)|get out of (the|this|your) .{0,40}(intern|program)|"
              r"end of (this|the|your) internship.{0,60}hope to|hope to walk away with|"
              r"most excited to (work on|learn|build) .{0,40}intern|goals? for (this|the|your) internship"),
    ("why_swe", r"aspect of software engineering|why (software engineering|computer science|engineering)\b(?!.{0,30}\bat\b)|"
                r"why .{0,30}become an? (software )?engineer|"
                r"(interest|passion) in (technology|software|engineering|computer science)$"),
    # why_company is matched in classify(): it must clearly be about this employer or this role
]
_WHY_ROLE = (r"why .{0,50}(this|the|our) (role|position|internship|company|opportunity|program|team)|"
             r"why .{0,40}\b(intern|work|join) (at|with|for|here)|^why (us|here)\b|why are you applying|"
             r"what (interests|excites|attracts|draws) you (about|to) .{0,40}(this|the|our|interning|working|role|"
             r"opportunity|position|company)|interest(ed)? in (this|the) (role|position|internship|company|opportunity)|"
             r"what makes .{0,40}(attractive|appealing|a good fit)")


# Behavioural ("describe a time when...") prompts map to four prepared stories in profile["behavioral"].
# Prompts about failure, conflict, disagreement or criticism have no prepared story and stay with the candidate.
_BEHAVIORAL = re.compile(
    r"(describe|tell (us|me) about|give (us |me )?(an )?example|share|walk us through|talk about) .{0,40}"
    r"(a time|an example|a situation|an instance|an experience|when you|where you)|\ba time (when|you|where)\b|"
    r"example of (a time|when)")
_NO_STORY = re.compile(r"conflict|disagree|fail|mistake|wrong|criticism|negative feedback|difficult (person|"
                       r"teammate|coworker|manager)|ethical|not on your (cv|resume)|outside of (work|school)")
_STORIES = [
    ("learning", r"learn\w* .{0,60}(new|quick|fast|on your own|yourself)|new (skill|tool|technology|language|domain)|"
                 r"tight deadline|short (time|deadline|timeline)|under (time )?pressure|pick(ed)? up|ramp(ed)? up"),
    ("teamwork", r"\bteam\b|teammates?|collaborat|\bled\b|\blead\b|leadership|worked with others|group project"),
    ("initiative", r"initiative|from scratch|ambigu|on your own|self-?start|ownership|above and beyond|proactive|"
                   r"without (being asked|direction|guidance)|unclear requirements"),
    ("challenge", r"challeng|obstacle|\bbug\b|debug|hard(est)? (technical )?problem|difficult (technical )?problem|"
                  r"technical problem|setback|overc[ao]me|stuck"),
]


def behavioral_kind(question: str) -> str | None:
    q = " ".join(question.lower().replace("’", "'").split())
    if not _BEHAVIORAL.search(q) or _NO_STORY.search(q):
        return None
    for kind, pattern in _STORIES:
        if re.search(pattern, q):
            return kind
    return None


def classify(question: str, company: str = "") -> str | None:
    q = " ".join(question.lower().replace("’", "'").split())
    story = behavioral_kind(q)
    if story:
        return f"behavioral_{story}"
    for kind, pattern in KINDS:
        if re.search(pattern, q):
            return kind
    name = company.lower().strip()
    if re.search(_WHY_ROLE, q):
        return "why_company"
    if name and name in q and re.search(r"^why\b|interest|excite|attract|want to", q):
        return "why_company"
    return None


def word_limit(question: str, description: str = "") -> int | None:
    text = f"{question} {description}".lower()
    m = re.search(r"(\d{2,4})\s*(?:-\s*)?words?\b(?: max| or (?:less|fewer)| limit)?|"
                  r"(?:max(?:imum)?|limit|under|up to|no more than)\D{0,12}(\d{2,4})\s*words", text)
    if m:
        return int(m.group(1) or m.group(2))
    n = sentence_limit(question, description)
    if n:
        return 60 * n
    m = re.search(r"(?:max(?:imum)?|limit|up to)\D{0,12}(\d{3,5})\s*char", text)
    return int(m.group(1)) // 7 if m else None


def sentence_limit(question: str, description: str = "") -> int | None:
    m = re.search(r"(?:\d\s*(?:-|–|to)\s*)?(\d)\s*sentences|(one|two|three) sentences?|in a sentence",
                  f"{question} {description}".lower())
    if not m:
        return None
    return int(m.group(1)) if m.group(1) else {"one": 1, "two": 2, "three": 3}.get(m.group(2), 1)


def fit(text: str, limit: int | None, sentences_max: int | None = None) -> str:
    """Drop whole sentences from the end until the answer is inside the limits."""
    if sentences_max:
        text = " ".join(re.split(r"(?<=[.!?])\s+", text)[:sentences_max])
    if not limit or len(text.split()) <= limit:
        return text
    sentences = re.split(r"(?<=[.!?])\s+", text)
    while len(sentences) > 1 and len(" ".join(sentences).split()) > limit:
        sentences.pop()
    out = " ".join(sentences)
    return out if len(out.split()) <= limit else " ".join(out.split()[:limit]).rstrip(",;") + "."


def _role_focus(title: str, job_text: str) -> str:
    t = f"{title}".lower()
    if re.search(r"machine learning|\bml\b|\bai\b|computer vision|deep learning|nlp|research", t):
        return "ai"
    if re.search(r"\bdata\b|analytics|pipeline", t):
        return "data"
    if re.search(r"back[- ]?end|platform|infrastructure|systems|cloud|database", t):
        return "backend"
    if re.search(r"front[- ]?end|full[- ]?stack|web|mobile|ios|android", t):
        return "fullstack"
    text = job_text.lower()
    ai = len(re.findall(r"machine learning|\bml\b|\bllm|computer vision|pytorch|model", text))
    web = len(re.findall(r"react|typescript|front[- ]?end|full[- ]?stack|postgres|\bapi\b|backend", text))
    return "ai" if ai > web + 1 else "fullstack"


_FOCUS_PHRASE = {"ai": "applied AI and machine learning systems", "data": "data pipelines and infrastructure",
                 "backend": "reliable backend systems", "fullstack": "full-stack product engineering"}


def _pick_project(profile: dict, focus: str) -> dict:
    projects = profile.get("projects") or []
    want = {"ai": {"ai", "ml", "vision", "pipeline"}, "data": {"data", "pipeline", "python"},
            "backend": {"backend", "database"}, "fullstack": {"fullstack", "web"}}[focus]
    return max(projects, key=lambda p: len(want & set(p.get("focus", []))), default=None)


def _shared_tech(profile: dict, job_text: str, project: dict, limit: int = 3) -> list[str]:
    """Technologies named in the posting that the profile also lists; else the project's own stack."""
    skills = [*profile["skills"]["languages"], *profile["skills"]["backend"], *profile["skills"]["tools"]]
    names = [re.sub(r"\s*\(.*\)", "", s) for s in skills]
    banned = {b.lower() for b in profile["skills"].get("never_claim", [])}
    low = job_text.lower()
    hits = [n for n in names if n.lower() not in banned
            and re.search(rf"(?<![a-z0-9+#]){re.escape(n.lower())}(?![a-z0-9+#])", low)]
    return (hits or list(project.get("stack", [])))[:limit]


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + (", and " if len(items) > 2 else " and ") + items[-1]


def template_answer(question: str, job: dict, job_text: str, profile: dict, description: str = "",
                    limit: int | None = None) -> tuple[str, str] | None:
    """(kind, text) for a recognised question type, else None."""
    kind = classify(question, job.get("company", ""))
    if kind in (None, "skip") or not profile.get("projects"):
        return None
    stated = word_limit(question, description)
    limit = min(x for x in (limit, stated) if x) if (limit or stated) else None
    company, title = job.get("company", "your company"), job.get("title", "this internship")
    focus = _role_focus(title, job_text)
    project = _pick_project(profile, focus)
    other = next((p for p in profile["projects"] if p is not project), project)
    tech = _join(_shared_tech(profile, job_text, project))
    school = profile["education"]["school"]

    by_impact = sorted(profile["projects"], key=lambda x: not re.search(r"\d", x.get("summary", "")))
    if kind.startswith("example_"):
        n = int(kind[-1]) - 1
        if n >= len(by_impact):
            return None
        return kind, fit(by_impact[n]["detail"], limit, sentence_limit(question, description))
    if kind == "bullets":
        lines = [f"- Built {x['summary']}." for x in by_impact[:3]]
        return kind, "\n".join(lines)
    if kind == "experience_summary":
        exp = profile.get("experience") or []
        if not exp:
            return None
        lines = [f"{x['title']}, {x['company']} ({x['start']} to {x['end'] or 'present'}): {x['bullets'][0]}"
                 for x in exp[:3] if x.get("bullets")]
        return kind, fit(" ".join(lines), limit)
    if kind == "built_before":
        if re.search(r"android|\bios\b|mobile|game|hardware|robot|embedded|firmware", question.lower()):
            return None
        return kind, fit("Yes. " + profile["essays"]["challenging_project"], limit, sentence_limit(question, description))
    if kind.startswith("behavioral_"):
        story = (profile.get("behavioral") or {}).get(kind.split("_", 1)[1])
        return (kind, fit(story, limit, sentence_limit(question, description))) if story else None
    if kind == "ai_experience":
        ai = [x for x in profile["projects"] if {"ai", "ml", "vision"} & set(x.get("focus", []))]
        exp = [x for x in profile.get("experience") or [] if re.search(r"\bai\b|ml|vision|research", x["title"], re.I)]
        parts = [f"As {x['title']} at {x['company']} I {x['bullets'][-1][0].lower()}{x['bullets'][-1][1:]}" for x in exp[:2]]
        if not ai and not parts:
            return None
        lead = f"I {ai[0]['detail'][0].lower()}{ai[0]['detail'][1:]}" if ai else ""
        return kind, fit(" ".join(x for x in [lead, *parts] if x), limit, sentence_limit(question, description))
    if kind == "why_company":
        text = (f"I am excited to apply for this internship at {company} because of your engineering team's "
                f"focus on {_FOCUS_PHRASE[focus]}. Having built {project['summary']}, I have hands-on experience "
                f"designing and shipping production-ready systems with {tech}. I would love to bring my focus on "
                f"clean architecture, automated testing, and performance optimization to {company}'s engineering "
                f"team next summer. I also built {other['summary']}, which taught me to own a system end to end.")
    elif kind == "project":
        text = profile["essays"]["challenging_project"]
    elif kind == "achievements":
        first, second = (d[0].lower() + d[1:] for d in (project["detail"], other["detail"]))
        text = (f"First, I {first} Second, I {second} Both reflect how I work: find the bottleneck, measure it, "
                f"and ship a tested fix.")
    elif kind == "goals":
        text = (f"I want to ship production code alongside experienced engineers at {company} and deepen my skills "
                f"in {tech}. So far I have built {project['summary']}. An internship is where I can learn how those "
                f"ideas hold up at production scale: code review, testing discipline, and system design across a "
                f"real team. I am most excited to own a scoped project end to end, measure its impact, and bring "
                f"those habits back to my final year at {school}.")
    else:                                   # why_swe
        text = profile["essays"]["why_software_engineering"]
    return kind, fit(text, limit, sentence_limit(question, description))


# Rules that decline on purpose: an essay must never be written into these fields.
NEVER_DRAFT = {"never-answer", "x-human-only", "x-citizenship", "x-clearance", "sponsorship", "x-accommodation",
               "x-test-scores", "x-arbitration", "x-background-check", "x-interview-recording", "work-auth",
               "x-work-auth-detail", "x-offers", "x-school-email", "x-alt-email", "x-hs-graduation", "x-high-school",
               "x-travel", "x-spoken-languages", "gpa", "file", "custom"}
OPEN_RULES = {"no-rule", "experience", "follow-up", "essay-project", "essay-why-swe"}


def may_draft(question: str, job: dict, rule: str) -> bool:
    """Should the essay generator be tried for a question the fact rules did not answer?"""
    if rule in NEVER_DRAFT:
        return False
    if rule in OPEN_RULES:
        return True
    # some other rule matched a keyword inside a long prompt: only a recognised essay type may override it
    return classify(question, job.get("company", "")) not in (None, "skip")


def generate(question: str, job: dict, job_text: str, profile: dict, description: str = "",
             required: bool = True, limit: int | None = None) -> tuple[str, str] | None:
    """Best available answer: Claude (grounded, vetted) when a key is set, else a template.

    Returns (rule_name, text) or None when the question should stay with the candidate.
    Optional free-text boxes are filled only for recognised essay types.
    """
    kind = classify(question, job.get("company", ""))
    if kind == "skip":
        return None
    if not required and kind is None:
        return None
    try:
        import llm
        if llm.available():
            stated = word_limit(question, description)
            cap = min(x for x in (limit, stated) if x) if (limit or stated) else None
            text = llm.open_answer(question, job, job_text, profile, cap)
            if text:
                return f"llm-{kind or 'open'}", text
    except Exception:                       # noqa: BLE001 - the template still stands
        pass
    hit = template_answer(question, job, job_text, profile, description, limit)
    return (f"essay-{hit[0]}", hit[1]) if hit else None
