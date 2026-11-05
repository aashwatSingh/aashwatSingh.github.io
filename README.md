# aashwatsingh.github.io

Source for [aashwatsingh.github.io](https://aashwatsingh.github.io/), the portfolio of **Aashwat Singh**:
Computer Science at UT Dallas (B.S., expected May 2028), software engineering and applied AI/ML, looking for
Summer 2027 internships. [LinkedIn](https://www.linkedin.com/in/aashwat-singh/) ·
[GitHub](https://github.com/aashwatSingh) · [aashwat.singh@utdallas.edu](mailto:aashwat.singh@utdallas.edu)

The portfolio is one static page, [`index.html`](index.html): plain HTML and CSS, no JavaScript, no build step
and no trackers. Each project links to its code and to the evidence behind its claims (an evaluator, a schema,
a status log), and the wording matches the resume.

## Editing the portfolio

- **Preview:** run `python3 -m http.server 8000` in the repo root and open <http://localhost:8000>.
- **Keep it in step with the resume:** project names, one-line descriptions, dates and metrics should read the
  same here, on the resume, on LinkedIn and in the GitHub profile README.
- **Resume link:** save the resume as `resume.pdf` in the repo root, without the phone number (this repo is
  public), and add `<li><a href="resume.pdf">Resume (PDF)</a></li>` to the contact list in `index.html`.
- **Share preview:** `og-image.png` is the card LinkedIn and Slack show for the link. After changing the page
  header, edit the text in `scripts/build_og_image.mjs` and run `node scripts/build_og_image.mjs` (needs
  Playwright).

## Also hosted here

These tools are for my own use. They are not linked from the portfolio, and they ask search engines not to
index them (`noindex`). [`/tools/`](https://aashwatsingh.github.io/tools/) links to all four.

| Path | What it is | Docs |
| --- | --- | --- |
| [`/hq/`](hq/) | Comet HQ: school, the internship hunt and DSA practice in one ranked list, synced from Canvas | [`hq/README.md`](hq/README.md) |
| [`/lockin/`](lockin/) | Lock In: a daily standard, with morning and night emails | [`lockin/README.md`](lockin/README.md) |
| [`/hamza/`](hamza/) | Hamza Lessons: a tracker for the @Hamza97 YouTube channel's lessons, with a nightly video sync | [`hamza/README.md`](hamza/README.md) |
| [`/walkthru/`](walkthru/) | Walkthru: a move-in and move-out inspection prototype | [`walkthru/README.md`](walkthru/README.md) |

Their paths are fixed on purpose: the Comet HQ extension only runs on `https://aashwatsingh.github.io/hq/*`,
the Lock In emails link to `/lockin/`, and home-screen installs open these paths. Moving a tool means
updating those too.

## Tests

```sh
node --test hq/tests/*.test.mjs lockin/logic.test.mjs hamza/insights.test.mjs walkthru/tests/*.test.mjs scripts/lockin_email.test.mjs
python3 -m unittest scripts/test_send_email.py scripts/test_fetch_videos.py
```

The browser smoke tests need Playwright: `node hq/tests/browser-smoke.mjs` and
`node walkthru/tests/browser-smoke.mjs`.

## AI assistance

Much of the code here was written with Claude Code, an AI coding assistant. Commits it co-wrote say so in a
`Co-Authored-By` trailer. The `Sync Hamza video list` commits come from the nightly GitHub Action.
