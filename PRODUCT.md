# Product

<!-- impeccable:product-schema 1 -->

This record covers the site root and the three personal tools: Comet HQ (`/hq/`), Lock In (`/lockin/`) and
Hamza Lessons (`/hamza/`). Walkthru (`/walkthru/`) is a separate startup product with its own record in
`walkthru/PRODUCT.md`; nothing here applies to it.

## Platform

web

## Users

One person: Aashwat, a UTD student who is also hunting for an internship. Nobody else is expected to use
these tools. They are built around his own Canvas account, routine and habits, and he opens them on a
laptop and on his phone (Lock In and Comet HQ are added to the home screen and open full screen).

- **Comet HQ:** opened to decide what to do next across coursework, to-dos, internship applications and
  DSA practice.
- **Lock In:** opened every morning to set the day and every night (from 6 pm) to review it.
- **Hamza Lessons:** opened to log, rate and take notes on lessons from the @Hamza97 YouTube channel.
- **Root page:** a personal launcher that jumps to the apps. It is not a public portfolio and isn't
  written for recruiters or other visitors.

## Product Purpose

The tools turn school, the internship hunt and self-improvement into one daily practice with a clear next
action.

- **Comet HQ:** "Open it and know what to do next." It ranks Canvas work together with his own to-dos,
  internship next steps and the day's DSA practice, and each row says why it ranks where it does.
- **Lock In:** a daily standard, built on the idea that watching and planning are not the work and that
  one bad day shouldn't turn into a lost week.
- **Hamza Lessons:** a record of every lesson watched, with takeaways collected into a journal.

Success means each tool gets used every day and does its job in seconds.

## Positioning

These are tools built for one person, around his real data and rules.

- **Comet HQ** ranks by grade impact: it estimates each assignment's share of the final grade from
  Canvas assignment-group weights, so an exam worth 20% two days out outranks a 2% homework due
  tomorrow, and it explains every ranking.
- **Lock In** gives each commitment a full and a minimum version. A day is kept when every minimum is
  hit, and the streak follows "never miss twice": one slip between kept days doesn't break it, two in a
  row do.
- **Hamza Lessons** is paired with Lock In: lessons are the reward, not the work. When today isn't kept,
  it shows a banner saying so.

## Operating Context

- **Canvas (UTD eLearning):** the Comet HQ Sync browser extension re-syncs each time HQ opens, using the
  existing Canvas login. A Sync to HQ bookmarklet and a token mode through a small Cloudflare Worker
  (`hq/proxy/worker.js`) are the fallbacks.
- **Daily rhythm:** Lock In's day runs until 4 am, and its night review opens at 6 pm. Claude scheduled
  tasks send a morning email (7:43 am Central) and a night email (10:13 pm Central) through Gmail, using
  `scripts/lockin_email.mjs`.
- **Hamza video list:** refreshed every night by the Sync videos GitHub Action (`scripts/fetch_videos.py`,
  using yt-dlp).
- **Between devices:** each app's ⋯ menu exports and imports a JSON file.

## Capabilities and Constraints

- **Static site on GitHub Pages:** vanilla HTML, CSS and ES modules, with no build step and no
  framework. New work keeps to that unless that choice is reopened deliberately.
- **Public repository:** nothing personal may be committed or published. Grades, assignments, the
  *why*, weak spots and history stay in the browser (`localStorage` keys `hq:v1`, `lockin:v1`, and
  Hamza's own key). A server-side Canvas sync was rejected for this reason. The Canvas token is stored
  separately and is never exported. The code stays generic: personal content lives only in the
  browser.
- **Comet HQ tabs:** Today, School, Internships, DSA (150 problems by pattern, spaced-repetition reviews,
  streak, heatmap, readiness).
- **Lock In surfaces:** Today (Day N, a daily message, One Thing with a 2-minute first step, the daily
  standard), About to slip? (a 20-second breathing pause and three swaps), Progress, and Night review.
  Messages live in `lockin/truths.js`.
- **Hamza Lessons surfaces:** the video list, lesson view, Journal (exports Markdown), Insights, and a
  sample-data demo at `/hamza/demo/` that has to be rebuilt with `node scripts/build_demo.mjs` after
  `insights.js` changes.
- **Tests:** core logic is covered by `node --test`; Comet HQ also has a Playwright smoke test against a
  mock Canvas (`hq/tests/browser-smoke.mjs`).
- **Terminology:** "One Thing", "kept" day, "full" and "minimum" versions, "never miss twice", "proof
  file", "lesson".

## Brand Commitments

- **Names:** Comet HQ (after UTD's Comets), Lock In, Hamza Lessons.
- **Voice:** plain and direct, with short sentences that say what to do next. Lock In's messages are
  personal and blunt about the gap between planning and doing.
- **One site:** the three tools are meant to feel like one site.

## Evidence on Hand

- **Real data:** his own Canvas data, history and notes, all stored in the browser and never in the repo.
- **Hamza Lessons:** the full video list in `hamza/data/videos.json`.
- **Sample data:** the Hamza Insights demo at `/hamza/demo/` and HQ's sample data (`hq/js/sample.js`).
- **Lock In messages:** `lockin/truths.js`.

## Product Principles

1. **The next action comes first.** Every screen opens on what to do now, and rankings explain
   themselves.
2. **Doing beats watching and planning.** Rewards (lessons, stats) come after the work.
3. **Forgive one slip, not two.** Recovery is built in: minimum versions, "never miss twice", the
   About to slip? flow.
4. **Private by construction.** Personal data stays in the browser, the code stays generic, and the
   public repo never holds anything personal.
5. **Zero friction to open.** No logins, no build, instant on phone and laptop, with sync that runs
   without being asked.

## Accessibility & Inclusion

No product-specific requirement has been established. The current practice is to support reduced motion
in every app, aim for AA text contrast in light and dark themes, use visible focus rings, and follow the
system light or dark setting with a manual override.
