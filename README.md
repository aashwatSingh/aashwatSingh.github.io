# aashwatsingh.github.io

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

Run the sync tests locally with `python -m unittest scripts/test_fetch_videos.py`.

## Free Pitch (`/pitch/`)

A tool for pitching your music only to outlets that **never charge**: streaming editors (Spotify,
Amazon, Audiomack, Pandora, TIDAL), free playlist-submission sites, blogs, college and public radio,
and free showcases. It starts with hip-hop-friendly outlets.

- **Kit:** fill in your artist profile once, then add each release (date, private or public link,
  hook, story). Every pitch is built from it.
- **Curators:** each card shows how to submit, the outlet's guidelines, and a **Pitch by** date worked
  out from your release date. Outlets that only take unreleased music are marked closed once the
  release is out. Region-locked outlets (BBC Introducing, triple j Unearthed) are flagged if your
  country doesn't match. Add your own curators with **Add curator**; hide any you don't want, or mark
  one as **Now charges a fee**.
- **Pitch:** opens a ready-made pitch for that kind of outlet. Edit it, then **Open in email app**,
  **Open in Gmail**, or copy it into the outlet's form (with a character counter where the form has
  a limit). **Mark as sent** starts a 10-day follow-up reminder.
- **Pitches:** a tracker for each release (sent, followed up, replied, added, declined, no response),
  with a reply rate and a list of follow-ups that are due.
- **Your data** stays in your browser (`localStorage`). Use the **⋯** menu to export it to a JSON file
  and import it on another device; an import keeps the most recently edited version of everything.
  Nothing costs money: no accounts, no API keys, no paid services.

**The directory** lives in `pitch/data/curators.json`. An outlet only goes in if its own submission
page says it's free (or lists no fee) and it sells no credits, premium tier, priority review or
placements. That rules out SubmitHub, Groover, Playlist Push, Musosoup, DailyPlaylists, SubmitLink
and outlets that sell promotion. Each entry records the page that shows it's free (`free_proof`) and
when it was checked. `checked_via: "search"` means it was confirmed through search results because
the site couldn't be opened directly when it was added.

To add or remove an outlet, edit the JSON and run `python -m unittest scripts/test_curators.py`. The
**Check curators** GitHub Action runs those tests on every change and checks every link once a month
(`scripts/check_curator_links.py`). A dead link fails the run, so GitHub emails you.
