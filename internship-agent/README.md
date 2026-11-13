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
essays.py         open-ended answers assembled from your resume projects (templates)
llm.py            optional: Claude drafts those answers instead when ANTHROPIC_API_KEY is set
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
python agent_runner.py --local-blitz --dedup-level role --max-per-company 3
```

* `--dry-run` fills each form and saves a full-page screenshot to `logs/submitted/` without
  clicking submit. Start here and look at the screenshots.
* `--local-blitz` is the mode that actually gets applications submitted. Run it on your own
  machine: it opens your installed Chrome with a persistent `./chrome_profile` (so sign-ins and
  cookies carry over between forms and runs), fills every field, uploads the resume and clicks
  Submit. If the site then asks for a CAPTCHA or an emailed code, the terminal bell rings with
  `[ACTION REQUIRED] ...` and the runner waits up to 120 seconds for you to do that one step:
  solve the CAPTCHA. The 8-character Greenhouse e-mail code is read from your own Gmail and
  entered for you (see "Greenhouse e-mail code" below); if that fails, the code box is focused
  and Submit is pressed once you paste the code. On confirmation it writes the row to
  `internship_tracker.xlsx` and moves to the next posting. `--assist SECONDS` is the same wait
  with your own timeout; `--browser-channel` picks the browser.
* `--only-ready` restricts a run to the postings in `ready_to_submit.csv` (every required question answered
  in your last `--dry-run` sweep; run `python report.py` after the sweep to write it).
* `--dedup-level role --max-per-company N` allows several roles at one company, capped at N
  counting what is already in the tracker.
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

**It does not get past "confirm you're a human" checks on its own.** Greenhouse answers an automated
submission with *"enter the 8-character code [emailed to you] to confirm you're a human"*; Ashby
raises a reCAPTCHA image challenge on submit; Lever puts hCaptcha on every form. (The first two
were observed on live submissions from a headless cloud browser.) The agent never solves a
CAPTCHA and does not disguise the browser as non-automated. Those steps are the sites asking
for a person, so a person does them (`--local-blitz` makes that a few seconds each), or the
posting goes to the manual-review queue. This is a deliberate difference from the original spec
(steps 4.4 and 6).

**Greenhouse e-mail code.** In an attended run (`--local-blitz` / `--assist`) the 8-character
code Greenhouse e-mails after Submit is read from your own Gmail and typed in for you. Unattended
runs never do this: the posting goes to manual review as before.

* *Method A, IMAP* (`imap_otp.py`): put `GMAIL_APP_PASSWORD=...` in `.env` (Google Account →
  Security → 2-Step Verification → App passwords; `.env` is git-ignored). The runner polls
  `imap.gmail.com` every 3 s for up to 45 s for mail from `greenhouse-mail.io` / `greenhouse.io`
  that arrived after the Submit click. The mailbox is opened read-only; nothing is marked read.
  The address is `identity.email` from the profile, or `GMAIL_ADDRESS` in `.env`.
* *Method B, Gmail tab* (`gmail_tab_otp.py`): with no app password (or if IMAP cannot be opened),
  a second tab in the same `./chrome_profile` opens Gmail. The first time, the bell rings and
  the runner waits up to 4 minutes for you to sign in there; the profile keeps the session. It
  then searches for the newest Greenhouse message and reads the code from it. Google sometimes
  refuses sign-in in an automated browser window; if it does, use Method A.

If neither finds a code, or Greenhouse rejects it, the run falls back to you pasting the code.

**It does not invent answers.** `answers.py` answers a question only from
`candidate_profile.json`: your stated facts and preferences (relocation, office order, salary,
years of experience, preferred language, start date...). "Do you have experience with X?" is Yes
only for skills on the resume and No for named technologies that are not. Open-ended prompts
("Why this company?", "Tell us about a project", "What do you want out of this internship?") are
written by `essays.py` from the `projects`, `experience` and `essays` sections of the profile, or
by Claude under the same grounding rules when an API key is set.

What still stops a form, because the profile does not say and a template cannot know:

| Set this in `candidate_profile.json` | Unlocks questions like |
|---|---|
| `work_authorization.us_person` | ITAR / export-control postings and their status question |
| `logistics.meets_basic_qualifications` | "Do you meet each of the basic qualifications?" |
| `logistics.has_outstanding_offers` | "Do you have any outstanding offers or deadlines?" |
| `logistics.has_prior_internship` | "Do you have prior internship or co-op experience?" |
| `logistics.pursuing_further_education_after_degree` | "Are you considering further education after this degree?" |
| `logistics.accept_arbitration_agreements` | mandatory arbitration acknowledgements |
| `education.sat_score`, `act_score`, `school_email`, `transcript_path` | test scores, .edu address, transcript uploads |

Citizenship status, visa category (F-1 / OPT / CPT), clearance, behavioural stories ("describe a
time when...") and skill self-ratings have no profile field; answer the recurring ones once in
`custom_answers.json` (below). Anything left goes to `manual_review_queue.csv` with the question.

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

## Closing the gap: answer once, then let it learn

```bash
python report.py
```

```bash
python answer_blockers.py
```

`report.py` prints the auto-fill share per portal and what would unlock the rest (`--rescore`
re-answers the logged questions with your current profile and answers, without a browser).
`answer_blockers.py` then asks you, once, for the profile values and the individual questions
that still stop forms. In `--local-blitz`, whatever you type into an unanswered field before
submitting is also remembered in `custom_answers.json` for the next form. Questions that ask you
to attest to authorship or AI use are never auto-answered, never remembered, and stop essay
drafting on that form.

## Where answers live

| File | In git? | Holds |
|---|---|---|
| `candidate_profile.json` | no | identity, contact, address, work authorization, demographics, logistics, and any `custom_answers` that touch those |
| `shared_answers.json` | yes | essays, behavioural stories and preference answers with nothing private in them; loaded automatically |
| `custom_answers.json` | no | answers learned from what you type during `--local-blitz` |

Order of precedence: `custom_answers.json`, then the profile, then `shared_answers.json`, then the built-in rules.
Entries marked `"drafted": true` were written with AI help; they are withheld on any form that asks for answers
written without AI, and the agent never ticks an "I did not use AI" attestation for you.

## Cover letter

```bash
python make_cover_letter.py
```

Builds a reusable one-page `cover_letter.pdf` from the profile (git-ignored). With `logistics.cover_letter_path`
set, it is uploaded only where a form marks the cover letter as required.

## Essays a template cannot write

```bash
python draft_essays.py
```

Drafts every open-ended question that still blocks a form and stores the result in `custom_answers.json` for
that company. It uses `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` when one is set (environment or a git-ignored
`.env` file with `KEY=value` lines); with neither it uses the local templates, which need no network and only
cover the question types they recognise (why this company, its mission, a project, goals, behavioural stories).
`--export` writes the questions and their grounded prompts (resume facts only: no name, contact details or GPA)
to `essay_requests.json`; `--import answers.json` stores answers drafted anywhere else. Forms that ask you to
attest the answers are your own are never drafted. Read `custom_answers.json` before a live run.

## Workday (experimental)

```bash
python agent_runner.py --local-blitz --ats Workday --workday-manual-sign-in
```

Workday is opt-in. Walked end to end on one live tenant in dry-run: account creation
(`--workday-create-accounts`, then you click the verification e-mail), sign-in, Autofill with Resume, My
Information, My Experience (adds your two most recent jobs when the parser finds none), both Application
Questions pages, Voluntary Disclosures, Self Identify, and stop at Review. Other tenants use the same page
types with their own questions, so expect some to stop for an answer. It never clicks the final Submit (you
review and submit), tries at most two of `portal.passwords` per site per run, and creates accounts only with
the flag. Stepping through pages saves a draft in your Workday account even in `--dry-run`; pre-filled
dropdowns in a saved draft are re-checked against your profile. Workday sometimes answers back-to-back
sessions with a "Something went wrong" page: the posting goes to manual review with that note and works on a
later run.

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
| `--local-blitz` / `--assist` human-in-the-loop wait | implemented; needs a machine with a display, so it has not been exercised yet. Expect to tune the first run. |
| Essay templates | exercised offline against cached real questions; Claude drafting (`llm.py`) not yet run against the API |
| Board crawl (`scraper.py --crawl-boards`) | exercised: ~1,080 Greenhouse / Ashby / Lever boards queried through their public APIs |
| `llm.py`, `llm_agent.py` | written against anthropic 2.x and browser-use 1.0; construct and import cleanly, not yet run against the API |
