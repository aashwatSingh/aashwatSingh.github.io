# Internship application agent

Finds Summer 2027 software / AI-ML internship postings, skips everything already
applied to, fills each application from a single candidate profile, and keeps
the tracker in sync.

```
scraper.py        listing sources  ->  job_queue.json   (pre-qualified, sorted)
dedup.py          internship_tracker.xlsx + applied_tracker.csv  ->  "already applied?" ledger
agent_runner.py   the loop: dedup -> open -> pre-qualify -> fill -> submit -> record
answers.py        question -> answer engine (profile facts only, never guesses)
ats/              form adapters: Greenhouse, Ashby, Lever
llm.py            optional: Claude-drafted "Why this company?" answers
llm_agent.py      optional: browser-use agent for portals without an adapter
coverage_report.py  offline audit of what the engine would answer
report.py         ready_to_submit.csv + blocking_questions.csv from the run logs
```

## Setup

```bash
pip install -r requirements.txt
```

```bash
playwright install chromium
```

Put these next to the scripts (all git-ignored — this repo is published by GitHub Pages, so
nothing personal is ever committed):

| File | What |
|---|---|
| `candidate_profile.json` | copy of `candidate_profile.example.json`, filled in |
| the resume PDF | path set by `resume_path` in the profile |
| `internship_tracker.xlsx` | your existing tracker (header row starting with `Company`) |
| `swe_internship_agent_prompt.md` | only needed for the optional LLM agent |

## Run

```bash
python scraper.py
```

```bash
python dedup.py sync
```

```bash
python agent_runner.py --dry-run --limit 10
```

```bash
python agent_runner.py --assist
```

* `--dry-run` fills each form and saves a full-page screenshot to `logs/submitted/` without
  clicking submit. Start here and look at the screenshots.
* `--assist` opens a visible browser. When a site asks to confirm you are human, the runner
  beeps and waits (5 minutes by default) for you to do that one step; everything else is already
  filled. This is the mode that actually gets applications submitted — see the next section.
* Without `--assist` the runner is fully unattended: anything needing a human goes to
  `manual_review_queue.csv` with a screenshot in `logs/manual_review/`.
* `--dedup-level company` (default) never applies to a company twice; `--dedup-level role` only
  skips the same role or posting.
* `--ats all` (with `ANTHROPIC_API_KEY` set and `pip install browser-use anthropic`) also hands
  Workday / iCIMS / other portals to the browser-use agent in `llm_agent.py`.
* Ctrl-C finishes the current application and stops cleanly. State is saved after every posting.

Every attempt writes `logs/applications/<id>.json` with each question, the answer given and
the rule that produced it, so any submission can be audited afterwards.

## What it will not do

**It does not get past "confirm you're a human" checks.** Greenhouse answers an automated
submission with *"enter the 8-character code [emailed to you] to confirm you're a human"*; Ashby
raises a reCAPTCHA image challenge on submit; Lever puts hCaptcha on every form. (The first two
were observed on live submissions from a headless cloud browser.) The agent never solves a
CAPTCHA and never fetches or types a verification code. Those steps are the sites asking for a
person, so a person does them (`--assist`), or the posting goes to the manual-review queue. This
is a deliberate difference from the original spec (steps 4.4 and 6).

**It does not invent answers.** `answers.py` answers a question only when
`candidate_profile.json` states the fact. Citizenship, visa type, clearance, test scores, skill
ratings, years of experience, "do you meet the qualifications", and company-specific essays are
never guessed: if such a question is required, the form is not submitted and the question is
listed in `manual_review_queue.csv`.

**It does not apply where the posting rules the candidate out.** Before filling a form it reads
the job description (from the page, or the ATS's public posting API) and skips postings that
require U.S. citizenship or a clearance, are for graduate students only, or say the employer will
not sponsor a visa while the profile says sponsorship is needed (`apply_when_no_sponsorship`
overrides this). ITAR / "U.S. person" postings follow `work_authorization.us_person` in the
profile; while that is `null` they go to manual review.

To unlock more postings, answer the recurring blockers once in `custom_answers.json`:

```json
[
  {"pattern": "outstanding offers", "answer": false},
  {"pattern": "^sat score", "answer": "1450"},
  {"pattern": "why do you want to (work|intern) at", "company": "Acme", "answer": "…"}
]
```

`pattern` is a case-insensitive regex on the question; `answer` is `true`/`false` for yes-no
questions, otherwise text (matched against the options of a dropdown). `company` is optional.

```bash
python agent_runner.py --prefetch
```

```bash
python coverage_report.py --answers
```

These two list the most common blocking questions across the queued Greenhouse postings and
every answer the engine would give, without opening a browser.

```bash
python report.py
```

After a `--dry-run` sweep this writes `ready_to_submit.csv` (forms that are completely filled and
only need the human step) and `blocking_questions.csv` (what stopped the rest, most common first).

## Files it writes

| File | Contents |
|---|---|
| `job_queue.json` | every listing seen, with status (`pending`, `applied`, `manual_review`, `duplicate`, `skipped_ineligible`, `closed`) |
| `applied_tracker.csv` | `Timestamp, Company, Role, Location, ATS_Platform, URL, Status` — tracker rows plus new applications |
| `internship_tracker.xlsx` | one row appended per submitted application (a timestamped backup is taken before each live run) |
| `manual_review_queue.csv` | postings to finish by hand, with the reason and unanswered questions |
| `logs/` | runner log, per-application answer logs, screenshots |

## Tests

```bash
python -m pytest tests -q
```

The answer-engine tests are regression cases taken from real application forms (sponsorship
polarity, look-alike dropdown options, dated commitments) and run against a fictional profile.

## Status of each part

| Part | State |
|---|---|
| Scraper, dedup, tracker sync | exercised against the live lists and a real tracker |
| Greenhouse / Ashby / Lever form filling | exercised against live forms in dry-run |
| Submission | no application has been submitted by this code yet: unattended runs stop at each site's human-verification step (see above) |
| `--assist` human-in-the-loop wait | implemented; needs a machine with a display, not yet exercised |
| `llm.py`, `llm_agent.py` | written against anthropic 2.x and browser-use 1.0; construct and import cleanly, not yet run against the API |
