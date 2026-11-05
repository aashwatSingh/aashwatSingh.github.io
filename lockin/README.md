# Lock In (`/lockin/`)

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
- **Daily emails:** two Claude scheduled tasks send them through your Gmail connector: **Lock In morning email**
  at 7:43 am Central (the weekday's focus, a message from `truths.js` and one challenge) and **Lock In night
  email** at 10:13 pm (the night-review nudge). Each run starts a fresh session that clones this repo, runs
  `node scripts/lockin_email.mjs morning` (or `night`) and sends exactly what it prints. The schedules are set in
  Central time, so daylight saving needs nothing, and each run checks Sent first so a retry never mails twice.
  Gmail has to be turned on in each task's connectors. They replaced a GitHub Actions schedule that GitHub
  started 3.5 to 6 hours late. **Actions → Lock In email → Run workflow** still sends one by hand through
  `scripts/send_email.py`, which needs two repository secrets (**Settings → Secrets and variables → Actions**):
  `LOCKIN_GMAIL_ADDRESS`, and `LOCKIN_GMAIL_APP_PASSWORD`, a
  [Google app password](https://myaccount.google.com/apppasswords) rather than your normal password (it mails
  that same address unless a `LOCKIN_EMAIL_TO` secret says otherwise). Run the tests with
  `node --test scripts/lockin_email.test.mjs` and `python -m unittest scripts/test_send_email.py`.
