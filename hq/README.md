# Comet HQ (`/hq/`)

One page for school, the internship hunt and DSA prep. It pulls your UTD Canvas work and ranks it together
with your own to-dos, internship deadlines and today's practice, so the top of the list is what to do next.

- **Today:** *Top priorities* across everything, *My tasks* (quick add with category, priority and due date),
  the week ahead weighted by how heavy each day is, your interview countdown, Lock In's One Thing, and Canvas
  sync status.
- **School:** each course's current grade and what's next, then all coursework grouped Overdue / Today /
  Tomorrow / This week / Later. Hide courses you don't care about (advising shells, orgs).
- **Internships:** applied, this week, response rate, interviews, offers; a board from Wishlist to Offer with
  each card's next step and deadline; a nudge after 14 quiet days. OAs, interviews and dated next steps feed
  Top priorities.
- **DSA:** the core 150 problems by pattern in learning order, a daily set (reviews due plus new problems),
  spaced repetition (*Solid* comes back in 3 → 7 → 14 → 30 → 60 days, *Shaky* repeats the gap, *Needed help*
  comes back tomorrow), streak, a 26-week heatmap and an interview-readiness score. Add your own problems too.

Try it with **⋯ → Load sample data** before connecting anything.

## How "most important" is decided

Every open item gets a score from 0 to 100:

- **Impact:** the item's estimated share of your final grade, worked out from Canvas's assignment-group weights
  and points (a 20% exam maxes out; a 2% homework doesn't). When there's no weight it falls back on the kind
  of work: exams and interviews highest, then OAs, projects, quizzes, homework, discussions. Work in a class
  where you're under 80% gets a bump.
- **Urgency:** rises as the deadline gets closer, and bigger work starts rising earlier (an exam gets about four
  times the runway of a small homework). Overdue and unsubmitted work is at full urgency for 3 days, then fades.
- **Score** = 100 × urgency × (0.35 + 0.65 × impact). Each row says why: *Due Wed · ~17% of grade · Exam*.

So a 20% exam two days out (≈85) beats a 2% homework due tomorrow (≈50). The maths is in `js/priority.js`; the
reasoning is in `docs/PLAN.md`.

## Connecting Canvas

Canvas doesn't send CORS headers, so a page on `github.io` can't call its API directly. HQ gets around that
in one of two ways.

### 1. The sync bookmark (recommended)

1. Open HQ → **⋯ → Connect Canvas**.
2. Drag **⟳ Sync to HQ** onto your bookmarks bar.
3. Go to UTD's Canvas (eLearning), log in, and click the bookmark on any Canvas page.

It runs on the Canvas page, so it uses the login you already have: no password and no token. It reads your
planner (3 weeks back to 4 months ahead), missing submissions, current grades and assignment-group weights,
then opens HQ with the data packed into the URL fragment (`#canvas=…`). The fragment never reaches a server,
and HQ wipes it from the address bar as soon as it has read it. Click the bookmark whenever you want fresh data;
if HQ is already open in another tab, that tab updates.

On a phone, use **Copy bookmark code**, bookmark any page, and paste the code as the bookmark's address.

### 2. Access token + proxy (syncs every time you open HQ)

1. In Canvas: **Account → Settings → + New access token**. Give it a purpose ("Comet HQ") and an expiry date.
   (If UTD doesn't let students make tokens, use the bookmark.)
2. Deploy the proxy, a free Cloudflare Worker:
   1. At [dash.cloudflare.com](https://dash.cloudflare.com), go to **Workers & Pages → Create → Worker**, name
      it (for example `hq-canvas`) and deploy the starter.
   2. **Edit code**, replace everything with `hq/proxy/worker.js`, and deploy.
   3. **Settings → Variables and secrets**: add `CANVAS_URL` (your Canvas address from the browser bar, like
      `https://elearning.utdallas.edu`) and `ALLOWED_ORIGIN` (`https://aashwatsingh.github.io`).
3. In HQ: **⋯ → Connect Canvas → Access token**, fill in the Canvas address, the Worker's `workers.dev`
   address and the token, then **Save and sync**.

The Worker forwards only `GET /api/v1/*`, only for HQ's address, and stores nothing. The token stays in this
browser (`localStorage`, key `hq:canvas-token`), is never included in exports, and **Forget token** removes it.
A token can do anything you can do in Canvas, so give it an expiry and don't use HQ on a shared computer.

## Privacy and data

Everything lives in your browser under `hq:v1`; the code in this repo stays generic. Marking a Canvas item done
in HQ is local and doesn't change Canvas. Use **⋯ → Export data / Import data** to move between devices (import
replaces what's there). HQ reads Lock In's data (same site) to show your One Thing, but never writes to it.

## Code and tests

| File | What it does |
| --- | --- |
| `js/canvas.js` | Canvas pull (shared by the bookmark and token mode), the bookmarklet, payload packing, cleaning, grade weights, items |
| `js/priority.js` | The score, its reasons, buckets and the week ahead |
| `js/dsa.js`, `js/problems.js` | Spaced repetition, today's set, readiness; the 150 problems |
| `js/pipeline.js` | Internship stages, stats and next-step items |
| `js/store.js` | Loading and checking saved data |
| `js/app.js` | The page |
| `proxy/worker.js` | The Cloudflare Worker for token mode |

```sh
node --test hq/tests/*.test.mjs   # logic, Canvas parsing, the Worker
node hq/tests/browser-smoke.mjs   # needs Playwright; runs the real bookmarklet against a mock Canvas
```

The smoke test starts this site, a mock Canvas (login cookie, `while(1);` JSON prefix, `Link` pagination, no
CORS) and the Worker on three local ports, then checks both sync paths, tasks, applications and DSA practice,
and every tab on a phone and a desktop.

Limits: the grade share ignores drop-lowest rules and extra credit; exams are recognized from titles ("Exam 2",
"Midterm", "Test 3"); nothing is written back to Canvas.
