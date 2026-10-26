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
in one of three ways. Set one up once; after that you never repeat it.

### 1. The Comet HQ Sync extension (recommended, syncs every time you open HQ)

A tiny Chrome extension (also Edge, Brave, Arc). Install it once and HQ refreshes from Canvas by itself every
time you open it or come back to the tab, using the Canvas login you already have: no token, no bookmark clicks.

1. Open HQ → **⋯ → Connect Canvas** → **Download the extension**, and unzip it somewhere it can stay.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and choose the
   `comet-hq-sync` folder.
3. Reload HQ. If HQ doesn't know your Canvas address yet, paste it into **Your Canvas address** once.

How it works: the extension's content script runs only on this page (`https://aashwatsingh.github.io/hq/*`)
and passes HQ's "sync" request to its background worker. The worker may read only Canvas hosts
(`*.instructure.com`, `*.utdallas.edu`), sends your Canvas cookie with the request like the Canvas tab would,
and returns the same trimmed data the bookmark produces. It runs HQ's own `js/canvas.js`: the download is
assembled in your browser from this site's files (`hq/extension/` plus `js/canvas.js`), so the extension and
the bookmark can't drift apart. HQ syncs on open unless it synced in the last two minutes. If you're logged
out of Canvas, the Canvas card says so and links you there; log in and come back.

If HQ ever ships a newer extension, the Connect dialog says so; download it, remove the old one in
`chrome://extensions`, and load the new folder.

### 2. The sync bookmark (any browser, one click per sync)

1. Open HQ → **⋯ → Connect Canvas → Other ways to connect**.
2. Drag **⟳ Sync to HQ** onto your bookmarks bar.
3. Go to UTD's Canvas (eLearning), log in, and click the bookmark on any Canvas page.

It runs on the Canvas page, so it uses the login you already have: no password and no token. It reads your
planner (3 weeks back to 4 months ahead), missing submissions, current grades and assignment-group weights,
then opens HQ with the data packed into the URL fragment (`#canvas=…`). The fragment never reaches a server,
and HQ wipes it from the address bar as soon as it has read it. Click the bookmark whenever you want fresh data;
if HQ is already open in another tab, that tab updates.

On a phone, use **Copy bookmark code**, bookmark any page, and paste the code as the bookmark's address.

### 3. Access token + proxy (works on phones, syncs on open)

1. In Canvas: **Account → Settings → + New access token**. Give it a purpose ("Comet HQ") and an expiry date.
   (If UTD doesn't let students make tokens, use the bookmark.)
2. Deploy the proxy, a free Cloudflare Worker:
   1. At [dash.cloudflare.com](https://dash.cloudflare.com), go to **Workers & Pages → Create → Worker**, name
      it (for example `hq-canvas`) and deploy the starter.
   2. **Edit code**, replace everything with `hq/proxy/worker.js`, and deploy.
   3. **Settings → Variables and secrets**: add `CANVAS_URL` (your Canvas address from the browser bar, like
      `https://elearning.utdallas.edu`) and `ALLOWED_ORIGIN` (`https://aashwatsingh.github.io`).
3. In HQ: **⋯ → Connect Canvas**, save your Canvas address, then under **Other ways to connect → Access
   token + proxy** fill in the Worker's `workers.dev` address and the token, and **Save and sync**.

The Worker forwards only `GET /api/v1/*`, only for HQ's address, and stores nothing. The token stays in this
browser (`localStorage`, key `hq:canvas-token`), is never included in exports, and **Forget token** removes it.
A token can do anything you can do in Canvas, so give it an expiry and don't use HQ on a shared computer.

## Motion

The page moves like a native app rather than snapping between states:

- **Springs, not fixed curves.** The timing tokens in `styles.css` are sampled from real spring physics
  (CSS `linear()`, with cubic-bezier fallbacks): a critically damped spring for most movement, a gentle one that
  settles 1% past its target for things that travel (the tab highlight, rows, dialogs), and a bouncier one only
  for the checkmark.
- **Arrivals.** Opening a tab slides the highlight under it, then the blocks rise into place one after another
  and come into focus; bars grow, the heatmap fills in, and headline numbers count up from zero.
- **Changes.** Checking something off fills the ring, draws the tick and strikes the title through; then the
  row slips away and the rest glide up (view transitions: every row has a stable `view-transition-name`).
  Re-ranking after a sync animates the same way.
- **Surfaces.** Glass top bar and menus, a scale-in dialog with a blurred backdrop on desktop, a bottom sheet
  with a grab handle on phones, and a floating toast. Cards lift slightly under the pointer.
- **Respect for settings.** With *Reduce motion* on, all of it is off: changes apply instantly.

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
| `js/bridge.js`, `js/zip.js` | Talking to the extension, and building its download |
| `extension/` | The Comet HQ Sync extension (its `canvas.js` is added from `js/` at download time) |
| `js/app.js` | The page |
| `proxy/worker.js` | The Cloudflare Worker for token mode |

```sh
node --test hq/tests/*.test.mjs   # logic, Canvas parsing, the Worker, the extension package
node hq/tests/browser-smoke.mjs   # needs Playwright and Python; bookmarklet, token mode and extension vs a mock Canvas
```

The smoke test starts this site, a mock Canvas (login cookie, `while(1);` JSON prefix, `Link` pagination, no
CORS) and the Worker on three local ports, then checks the bookmark and token paths, tasks, applications and DSA
practice, and every tab on a phone and a desktop. Finally it downloads the extension from HQ's own button,
loads it into Chromium, connects once, and checks that simply reopening HQ later re-syncs with no clicks.

Limits: the grade share ignores drop-lowest rules and extra credit; exams are recognized from titles ("Exam 2",
"Midterm", "Test 3"); nothing is written back to Canvas. The extension is for Chromium browsers on a laptop;
Safari and phones use the bookmark or token mode.
