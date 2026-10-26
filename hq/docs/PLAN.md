# Comet HQ: build plan

Written before any code, on Oct 26, 2026. It records what HQ is, why it is shaped this way, and the
order it is built in.

## 1. The ask

> A to-do list app that connects to my UTD Canvas account and displays what my most important tasks
> are. Also some DSA interview prep. A dashboard for all my school and internship hunt stuff.

So HQ has one job: **open it and know what to do next**, across four sources:

| Source | What it adds |
| --- | --- |
| Canvas (UTD eLearning) | Assignments, quizzes, discussions, exams on the calendar, submission state, current grades and assignment-group weights |
| Your own to-dos | Anything Canvas doesn't know: forms, office hours, errands, career-fair prep |
| Internship pipeline | Applications by stage, with the next step and its deadline (OA due, interview date) |
| DSA practice | A 150-problem core set by pattern, spaced-repetition reviews, a daily goal, an interview countdown |

## 2. Connecting to Canvas

A page on `aashwatsingh.github.io` cannot call the Canvas API directly: Canvas sends no CORS
headers for other sites, so the browser blocks the response. That leaves three ways in, and HQ
supports the first two:

1. **Sync bookmarklet (default, nothing to set up).** You click a bookmark while on any Canvas page.
   The script runs *on Canvas*, so it calls the API with the login you already have (no token), strips
   Canvas's `while(1);` JSON prefix, follows `Link` pagination, keeps only the fields HQ needs, and
   opens HQ with the data in the URL fragment (`#canvas=…`). The fragment never reaches a server.
   HQ saves it and wipes the fragment from the address bar and history entry.
2. **Access token + tiny proxy (auto-sync).** For syncing on open, including on a phone: a Canvas
   access token (Account → Settings → New access token) and a 40-line Cloudflare Worker
   (`hq/proxy/worker.js`) that forwards `GET /api/v1/*` to your Canvas host and adds CORS headers
   for this site only. The token stays in this browser and is never exported.
3. A server-side sync (GitHub Action) is **rejected**: this repo is public, so its Pages files and
   Action logs would publish your assignments and grades.

Both paths share one function, `pullCanvas(get, now, origin)`. It has no outside references, so the
bookmarklet embeds its source with `Function.prototype.toString` and node tests run the same code.

Calls (all `GET`, per_page=100, paginated):

- `/api/v1/users/self` for your name
- `/api/v1/courses?enrollment_state=active&include[]=total_scores&include[]=term` for courses
  and current grades (courses whose term ended more than 2 weeks ago are dropped)
- `/api/v1/planner/items?start_date=−21d&end_date=+120d` for everything with a date, plus
  submission state and your Canvas "mark complete"
- `/api/v1/users/self/missing_submissions` for overdue work older than the planner window
- `/api/v1/courses/:id/assignment_groups?include[]=assignments` per course, for group weights and
  points, so HQ can estimate **what share of your final grade** each assignment is

## 3. "Most important": the score

Every open item (Canvas, to-do, internship step, DSA goal) gets a 0–100 score:

```
impact   0–1   from the share of the final grade when Canvas weights are known
               (≈ 0.15 + weight% / 10, so 8.5%+ maxes it), otherwise from the kind:
               exam/interview 1, OA 0.9, project 0.75, quiz 0.55, assignment 0.45 …
               +0.1 when the course grade is under 80%
lead     1–4   = 1 + 3 × impact. Big things deserve more runway, so time is divided by it
urgency  0–1   = exp(−(hours left / lead) / 72); overdue and unsubmitted = 1 (fades after 3 and 10 days)
               no due date = 0.3
score    = 100 × urgency × (0.35 + 0.65 × impact)
```

Worked examples: an exam worth 20% in 5 days scores ~66 and beats a 2% homework due tomorrow (~50);
two days out the exam is ~85. Each row says why it ranked: *Due in 14 h · ~8% of grade · Exam*.

Done means submitted, excused, graded, marked complete or dismissed in Canvas, or checked off in HQ.

## 4. Screens

- **Today:** greeting and a one-line summary; *Top priorities* (ranked, every source); *My tasks*
  (quick add with category, priority, due date); this week at a glance; Lock In's One Thing (read
  only, from the same origin); interview countdown.
- **School:** Canvas connection and sync; course cards with current grade and what's next; every
  upcoming item grouped Overdue / Today / Tomorrow / This week / Later, filterable by course.
- **Internships:** pipeline stats (applied, this week, response rate, interviews, offers); a board by
  stage (Wishlist → Applied → OA → Interview → Offer, plus Closed); next step and deadline per card;
  a nudge to follow up after 14 quiet days; a link to AppWing.
- **DSA:** today's set (reviews due + new problems up to the daily goal); progress per pattern;
  every problem with difficulty, confidence and next review; streak and a 26-week heatmap; readiness.

Spaced repetition: mark a problem *Needed help* (1), *Shaky* (2) or *Solid* (3). Solid moves it a
step along 1 → 3 → 7 → 14 → 30 → 60 days, Shaky repeats the step, Needed help resets it to 1 day.

## 5. Out of scope

- No writing back to Canvas (marking done in HQ is local).
- No accounts or cloud sync. Data lives in this browser (`localStorage`, key `hq:v1`); export and
  import move it between devices, same as Lock In and Hamza Lessons.
- No auto-import from AppWing or Gmail; the pipeline is entered by hand.

## 6. Tech and structure

Same stack as the rest of the repo: vanilla HTML, CSS and ES modules, no build step, the Lock In
palette, `node --test` for pure modules and a Playwright smoke script for the browser.

```
hq/
  index.html, styles.css, manifest.webmanifest, icon.svg, README.md
  js/
    app.js        boot, tabs, rendering, events
    store.js      load / clean / save / export / import
    dates.js      local-day helpers
    canvas.js     pullCanvas, transport, bookmarklet source, clean + normalize, grade weights
    priority.js   the score and its reasons, the week strip
    dsa.js        spaced repetition, today's set, pattern progress, readiness
    problems.js   the 150-problem core set
    pipeline.js   internship stages, stats, follow-up nudges
    sample.js     sample data so HQ is useful before Canvas is connected
  proxy/worker.js Cloudflare Worker for token mode
  tests/          *.test.mjs (node) and browser-smoke.mjs (Playwright + a mock Canvas server)
```

## 7. Build order and acceptance

1. Plan (this file).
2. Pure modules and their tests: canvas, priority, dsa, pipeline.
3. App shell and the four tabs, with sample data.
4. Browser smoke test against a **mock Canvas server** that adds the `while(1);` prefix and paginates
   with `Link` headers: run the real bookmarklet on it, land in HQ, and see the items ranked.
5. Proxy worker and its test, README, home-page link.

Done when: all node tests pass; the bookmarklet round trip works against the mock; every tab works
at 390 px and 1280 px wide in light and dark with no console errors; an exam worth 20% due in 2
days outranks a 2% homework due tomorrow.
