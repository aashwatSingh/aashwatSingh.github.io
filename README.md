# aashwatsingh.github.io

## Comet HQ (`/hq/`)

A dashboard for school and the internship hunt. It syncs your UTD Canvas work (assignments, quizzes, exams,
grades and assignment-group weights) and ranks it together with your own to-dos, internship next steps and
today's DSA practice, so the top of the list is what to do next. An exam worth 20% of the grade two days out
outranks a 2% homework due tomorrow, and each row says why.

- **Canvas:** install the small **Comet HQ Sync** extension once (⋯ → Connect Canvas → Download the extension)
  and HQ re-syncs from Canvas by itself every time you open it, using your existing login, with no token.
  Without it, a **Sync to HQ** bookmark or a token mode through a small Cloudflare Worker (`hq/proxy/worker.js`)
  also work.
- **Tabs:** Today (priorities, tasks, the week ahead, interview countdown, Lock In's One Thing), School
  (grades and coursework by due date), Internships (pipeline board and stats), DSA (150 problems by pattern
  with spaced-repetition reviews, streak, heatmap and readiness).
- **Privacy:** data stays in your browser (`localStorage`, key `hq:v1`); the Canvas token is stored separately
  and never exported. Export and import from the **⋯** menu.

Setup, the scoring, the motion and the code: `hq/README.md`. Run its tests with `node --test hq/tests/*.test.mjs`, and the
browser test (Playwright, mock Canvas) with `node hq/tests/browser-smoke.mjs`.

## Lock In (`/lockin/`)

A daily standard you open every morning and close every night. It's built around one idea: watching and
planning are not the work, and one bad day shouldn't turn into a lost week.

- **Today:** a "Day N" counter, one message picked for your weak spots (the same one all day), your One Thing
  with a 2-minute first step, and your daily standard. Each commitment has a **full** and a **minimum**
  version; hit at least the minimum on all of them and the day is **kept**. Deep work is logged by the focus
  timer and internship reps by a counter. Kept days unlock "Your lesson" on Hamza Lessons.
- **About to slip?** opens a 20-second breathing pause, your *why* and your note from future you, then
  three swaps (10 minutes on your first step, one application, a walk without your phone).
- **Never miss twice:** one slip between kept days doesn't break the streak; two in a row do. Progress shows
  the streak, comebacks, a heatmap, this week's totals (including Hamza lessons watched vs days kept) and a
  proof file of every win.
- **Night review** (opens at 6 pm): one win, one lesson, tomorrow's One Thing. A day runs until 4 am.
- **Privacy:** your why, weak spots and history live only in your browser (`localStorage`, key `lockin:v1`).
  The code here stays generic. Use the **⋯** menu to export and import between devices.
- **Messages** live in `lockin/truths.js`; add your own. The maths lives in `lockin/logic.js`; run its tests
  with `node --test lockin/logic.test.mjs`.
- Add it to your phone's home screen (Share → Add to Home Screen); it has its own icon and opens full screen.
- **Daily emails:** the **Lock In email** GitHub Action (`.github/workflows/lockin-email.yml`) sends a morning
  email at 7:43 am Central (the weekday's focus, a message from `truths.js` and one challenge) and a night-review
  nudge at 10:13 pm. GitHub often starts scheduled runs 5 to 30 minutes late. `scripts/lockin_email.mjs` writes
  the email and `scripts/send_email.py` sends it through Gmail. It needs two repository secrets (**Settings →
  Secrets and variables → Actions**): `LOCKIN_GMAIL_ADDRESS`, and `LOCKIN_GMAIL_APP_PASSWORD`, a
  [Google app password](https://myaccount.google.com/apppasswords) rather than your normal password. It mails that
  same address unless a `LOCKIN_EMAIL_TO` secret says otherwise. To send one now: **Actions → Lock In email → Run
  workflow**. Run its tests with `node --test scripts/lockin_email.test.mjs` and
  `python -m unittest scripts/test_send_email.py`.

When Lock In is set up and today isn't kept yet, Hamza Lessons shows a banner: lessons are the reward, not the work.

## Hamza Lessons (`/hamza/`)

A tracker for every lesson on the [@Hamza97](https://www.youtube.com/@Hamza97) YouTube channel.
Every upload is a lesson: mark it watched, star it, rate it, set its topic, and write down your
key takeaways and notes. The **Journal** tab collects every takeaway you've written, grouped by
topic, and can copy them all out as Markdown.

- **Video list:** `hamza/data/videos.json`. The **Sync videos** GitHub Action
  (`.github/workflows/sync-videos.yml`) refreshes it every night at 06:17 UTC by running
  `scripts/fetch_videos.py`, which uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) to read the
  channel's Videos, Shorts and Live tabs. No API key needed. To sync right away:
  **Actions → Sync videos → Run workflow**.
- **Your progress** is stored in your browser (`localStorage`). Use the **⋯** menu to export it
  to a JSON file and import it on another device. An import merges entries and keeps the most
  recently edited version of each lesson.
- **Topics** are guessed from titles using the keyword rules in `hamza/topics.js`. Override any
  video's topic from its lesson view.
- **Upload dates** are approximate for older videos because YouTube's channel listings only
  say things like "2 years ago". The order is still exact. Videos found by the nightly sync get
  day-accurate dates.

- **Insights tab:** streaks, a 26-week activity heatmap, per-topic progress, your rating spread and a
  finish-date projection from your last 4 weeks of pace. The maths lives in `hamza/insights.js`; run
  its tests with `node --test hamza/insights.test.mjs`. A standalone sample-data demo lives at
  `/hamza/demo/`; rebuild it with `node scripts/build_demo.mjs` after changing `insights.js`.

Run the sync tests locally with `python -m unittest scripts/test_fetch_videos.py`.

## Walkthru (`/walkthru/`)

A working prototype of Walkthru, the move-in and move-out inspection startup. Residents scan a QR code on the
door and film each room in the phone's browser (no app, no login); every photo is SHA-256 fingerprinted and the
record is sealed on submit. Staff review only what changed since the last record, and charges come from a rate
sheet, split among roommates, with the Texas deposit deadline. A demo property with five planted changes is
built in the browser so it can be tried without a real apartment. Data stays in the browser (IndexedDB).

Details, the demo tour and limits: `walkthru/README.md`. Design: `walkthru/docs/ARCHITECTURE.md`. Run its tests
with `node --test 'walkthru/tests/*.test.mjs'`.
