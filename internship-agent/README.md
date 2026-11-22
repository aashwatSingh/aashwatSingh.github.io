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

**CAPTCHAs** (`ats/captcha_solver.py`). When a reCAPTCHA, hCaptcha or Turnstile checkbox is on the
page, the runner ticks it once in the browser window you are looking at, before Submit, on the
Workday Review page, and when Submit raises one. If the site accepts that, the form continues. If it
shows an image puzzle or does not accept the click, the widget is outlined in purple, the bell rings
once, and the runner continues the moment you solve it (an unattended run goes to manual review as
before). At most two attempts per page, and it never clicks Submit a second time once the page
shows a confirmation. It does not use a solving service or hide that the browser is automated, and
there is no setting for either. Mission Control shows "Solving CAPTCHA..." and how many were
cleared on the current posting.

Other portals: when Ashby, Lever or Workday (sign-in, Next, or the final Submit) asks for an
e-mailed code, in the application's tab or in a tab it opened, the runner finds the code boxes in
whichever tab shows them, reads the newest code from an ATS sender over IMAP (the length the page
asks for, usually 6), enters it, presses Verify / Continue, and returns to the application tab
(`ats/otp.py`). Without `GMAIL_APP_PASSWORD` you type it in that tab. Fields such as "ZIP code",
"Promo code" or "code of conduct" are never mistaken for a code prompt.

**How "total applications" is counted.** One number, everywhere (the runner's log, Mission Control,
`tracker_sync.py` and Internship Hunter): the rows of `internship_tracker.xlsx` between the header row
and the row whose Company is "Summary", whose Company is not blank. One row is one application
whatever its status ("Application incomplete" and "Unverified / Needs Check" included), which is also
what the sheet's own `=COUNTA(...)` in the Summary block shows. Columns are found by header name and
nothing is hard-coded to a row number or range (`tracker_rows.py`). The title, subtitle and header
rows, blank rows, and the whole Summary block are never counted; neither are e-mails or
`applied_tracker.csv` (a duplicate-check index and crash-safety copy, not a second count).
Two rows with the same Company and Role are possible duplicates: they stay in the total and are
named in the run's log and Mission Control. A submission that is waiting to be written because
Excel had the file open is shown as "waiting", and joins the total once it is a row.

`python verify_tracker_count.py [--xlsx PATH] [--expect 249]` prints the independent count, the
automation's count and the Summary cell recalculated by LibreOffice on a temporary copy, plus the
per-status breakdown, duplicates, CSV rows the tracker lacks, and Summary formulas whose range no
longer matches the data (a `COUNTA(A5:A262)` that runs past the last row also counts the Summary
labels). It never changes your workbook.

**Confirmation e-mail gate.** On a live run, a submission counts only once its confirmation e-mail
("Thank you for applying to ...") is in your Gmail inbox. The browser's confirmation page is not
enough: until the e-mail arrives the runner does not write `internship_tracker.xlsx`, does not
count the application, and does not open the next posting.

* Right before the final Submit click (and again right before the Greenhouse code is submitted)
  the runner notes the highest message UID in `INBOX`. Afterwards it reads only newer messages,
  every 4 s for up to 120 s (`email_receipt_verifier.py`). It uses IMAP with `GMAIL_APP_PASSWORD`,
  and the Gmail tab (`gmail_tab_otp.py`) when there is no app password or IMAP cannot be opened.
  The mailbox is opened read-only; nothing is marked read.
* A message passes when it has confirmation wording ("thank you for applying", "application
  received", "successfully submitted", ...) and either names the company or comes from a known
  ATS domain (Greenhouse, Ashby, Lever, Workday).
* A security-code or account e-mail never passes ("security code", "verification code", "verify
  your email", "activate your account", "confirm you're a human"), so the Greenhouse code e-mail
  cannot be mistaken for the receipt. A rejection for an earlier application does not pass either.
* The tracker row is written from the e-mail itself: `Next Step / Notes` reads "Application
  confirmation received via <ATS> (<date>); verified by Gmail receipt." and `Source Email Subject`
  holds the exact subject.

If no e-mail arrives in time (`RECEIPT_TIMEOUT_S` in `.env`, 30-600 s, default 120; or
`--receipt-timeout N`), the application is **not** counted:

* it gets a row in `internship_tracker.xlsx` with status `Unverified / Needs Check`, which Mission
  Control and `tracker_sync.py` leave out of the total, and a line in `unconfirmed_applications.csv`;
* it goes to Mission Control's Unblock Queue with **Confirm submitted** (you checked; the row becomes
  an application) and **Retry** (the row is removed and the posting is queued again);
* the batch moves on to the next posting.

Set `RECEIPT_ON_TIMEOUT=ask` in `.env` to pause the batch instead and choose in the terminal or
Mission Control: wait another 60 s, check the browser and retry, or log it as unconfirmed.
A `--dry-run` never submits, so the gate does not apply.

### Phone assist (Discord)

When a run needs you (a question the profile cannot answer, a CAPTCHA, a missing confirmation
e-mail, or a page that has made no progress for 120 s) it posts to a private Discord channel and
pings you, with the posting, the question, numbered choices and a screenshot. Reply from the
Discord app: the answer is filled in, saved to `custom_answers.json`, and the run carries on.
Whichever comes first wins: answering on the laptop works exactly as before, and the phone is told
"Answered on laptop — continuing". It uses only Discord's REST API over outgoing HTTPS (`requests`),
polled at most every 2 s: no extra packages, no gateway connection, no open port.

Set it up once (about five minutes):

1. https://discord.com/developers/applications -> New Application -> **Bot** -> Reset Token (copy it).
   On the same page switch on **Message Content Intent**, or the bot is sent empty message text.
2. Create a private server or channel just for this. Invite the bot with the link from
   OAuth2 -> URL Generator (scope `bot`; permissions View Channel, Send Messages, Read Message
   History, Attach Files). In Discord: Settings -> Advanced -> Developer Mode, then right-click the
   channel and yourself -> Copy ID.
3. Add to `.env` (git-ignored; never share it):
```
DISCORD_BOT_TOKEN=...
DISCORD_CHANNEL_ID=...
DISCORD_USER_ID=...
```
4. `python agent_runner.py --test-phone` pings the channel and echoes your reply back within 30 s.
   Mission Control's header then shows **Phone Assist: Connected**; without all three settings it
   shows **Off** and nothing changes.

Only messages from `DISCORD_USER_ID` in `DISCORD_CHANNEL_ID` are ever read, and a message sent before
a prompt can never answer it. Reply with a number or text for choices (`1, 3` for several), or:
`/status` (where the run is), `/pause` and `/resume` (hold the queue between applications), `/skip`
(give up on this posting: manual review as `SKIPPED_FROM_PHONE`), `/retry`. `!skip` works too.
A reply that matches none of a dropdown's choices is answered with "Didn't match options 1-N" and
the run keeps waiting. A file upload cannot be sent from the phone. The missing-receipt question
(1 wait 60 s, 2 retry in the browser, 3 skip as unconfirmed) also goes to the phone, and gives up
(flags it Unverified, moves on) after `PHONE_ASK_WAIT_S` seconds, default 600. `/retry` on a frozen
page restarts the posting only if Submit was not clicked yet; after Submit a retry could apply
twice, so it becomes a skip. `FREEZE_STALL_S` (default 120) sets how long a stall must last.

### Mission Control

Double-click **`Launch_Mission_Control.bat`** (or run it from any terminal). It finds Python,
installs FastAPI / uvicorn the first time, starts `app_server.py` in a minimized window and opens
http://127.0.0.1:4760. Closing that window stops the page, not a running batch.

* **Goal**: applied / 500 with a progress bar, e-mail verified, still in the queue, needs action,
  failed, remaining; and the last 15 results.
* **Batch**: choose how many applications, then Start, Pause / Resume (between applications),
  Stop (after the current one) or Force stop. It runs
  `agent_runner.py --local-blitz --dedup-level role --max-per-company 3 --limit N`.
* **Now**: the posting being worked on and its step (submitting, e-mailed code, waiting for the
  receipt, confirmed), and which question it is waiting on in the browser.
* **Unblock Queue** (`unblock_queue.json`): every posting that stopped on a CAPTCHA, a login wall,
  a question the profile cannot answer, an empty required field before Submit, or a missing
  receipt. Type answers into the form and press **Save answers & retry** (they go to
  `custom_answers.json` and are reused on later forms), **Resume after manual fix**, **Confirm
  submitted**, or **Dismiss**. A retried posting runs next in the current batch, or first in the next.
* **Live log**: the runner's output as it is written.

The page is React + TypeScript in `mission_control_ui/`, prebuilt into `mission_control_ui/dist`,
so Node.js is only needed to change it (`npm --prefix mission_control_ui install`, then
`run build`, `run lint`, or `run dev` for a hot-reloading copy on port 5173). The server listens on
127.0.0.1 only, refuses requests addressed to any other host name and cross-site POSTs, and never
sends `.env` values to the page.

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
| `logistics.internship_dates_text` | answer to "internship dates" / "dates of the internship" text questions, e.g. `06/07/2027 - 08/19/2027` (defaults to `preferred_start` - `preferred_end` as MM/DD/YYYY). `availability_dates_text` answers "dates you are available" |
| `work_authorization.country_of_citizenship`, `citizenship_obtained` | "list your countries of citizenship" gets the country; when the question also asks when the status was obtained ("when obtained", "date acquired", "since when") the answer is combined, e.g. `India (citizen since birth)`. If `citizenship_obtained` is unset, or still a template like `[citizen since birth / date obtained]`, you are asked instead and nothing is sent |
| `education.school_on_forms` | the school name as most forms list it (e.g. `University of Texas - Dallas`). Used first for every school / university field; if a list does not offer it, `school`, `school_aliases` and their other spellings ("X at Y", "X, Y", with / without "The") are tried in turn. `school` stays the name used in essays and the cover letter |

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
that still stop forms. Questions that ask you to attest to authorship or AI use are never
auto-answered, never remembered, and stop essay drafting on that form.

**Questions the profile cannot answer** (all four adapters, `ats/assist.py`):

* *Optional ones never stop a form.* A question is required only when the page marks it: the
  `required` attribute, `aria-required="true"`, a required class or `data-required="true"`, or an
  asterisk on its label / legend. One whose label, placeholder or helper text says "optional" is
  optional whatever else is marked ("Optional Practical Training" does not count as saying so).
  An optional question with no known answer is left blank and logged as `SKIPPED_OPTIONAL`.
* *Required ones are handed to you without the terminal* (`--local-blitz` / `--assist`). The bell
  rings, the first such field is scrolled to the middle of the window and outlined in purple with
  a "Fill & click outside to auto-continue" label. Type the answer and click or tab away (a radio,
  single checkbox, dropdown or upload counts as soon as the choice has settled for 0.8 s). The
  outline moves to the next one, and after the last the runner presses Submit (Save and Continue
  on a Workday page) and carries on with the e-mail code, the confirmation e-mail and the tracker
  as usual. Mission Control shows which question it is waiting on. If nothing is entered for
  `--assist` seconds (minimum 180), the posting goes to manual review.
* *Checked again before Submit.* Right before the click, the page is scanned once more for a
  required field that is still empty (one that appeared late, or that the page cleared) and for
  any error message already showing. Attended runs hand those to you the same way; unattended
  runs and dry runs report `PRESUBMIT_CHECK` instead of clicking.
* *Required but unmarked.* When Submit / Next is refused with a validation error, only the fields
  carrying the error are treated as required: answered from the profile if it can, otherwise
  highlighted for you, then the click is repeated (up to three times).
* *Learned.* Each answer you give this way is saved to `custom_answers.json` the moment you leave
  the field, so the same question is filled automatically on later forms. Uploads are not learned.

On a live run Workday's Review page is submitted for you too: the adapter checks that the page
shows no error banner and that its button says Submit, notes the inbox position, clicks, and
waits for Workday's confirmation before the e-mail gate. If Review shows an error, the posting
is handed to you (blitz) or goes to manual review with the draft saved. `--dry-run` always
stops at Review.

Answers you teach it live in `custom_answers.json`, with an identical copy in
`custom_answers.backup.json` that is used if the main file is lost or damaged. Both are
git-ignored and have never been tracked, so `git pull` cannot overwrite or conflict with them.

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

Lever specifics (`ats/lever.py`): after the résumé upload it waits for Lever's `/parseResume` answer and for the
fields the parser writes to stop changing (up to 20 s); a parse that errors or times out is logged as a warning and the
form is filled anyway, and a parse that lands late is corrected before Submit (name, e-mail, phone, links, and "Current
company", which is kept empty unless the profile lists a current job there). The parser's location is kept only when
it is your city and state; otherwise it is cleared, typed with real key presses (Lever loads suggestions on key
events), the matching suggestion is picked, and `selectedLocation` is checked: location is never reported as filled
unless it is. If the hCaptcha script does not load, a `--local-blitz` run retries, then rings the bell, tells your
phone, and waits for the script to load or for you to submit; an unattended run goes to manual review.

Workday is opt-in. Walked end to end on one live tenant in dry-run: account creation
(`--workday-create-accounts`, then you click the verification e-mail), sign-in, Autofill with Resume, My
Information, My Experience (adds your two most recent jobs when the parser finds none), both Application
Questions pages, Voluntary Disclosures, Self Identify, and stop at Review. Other tenants use the same page
types with their own questions, so expect some to stop for an answer. On a live run it clicks the final Submit
on Review once that page shows no error (the click itself has only been exercised on a mock wizard, not a
live tenant); in `--dry-run` it stops at Review. It tries at most two of `portal.passwords` per site per run, and creates accounts only with
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
