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
