# Walkthru prototype (`/walkthru/`)

Move-in and move-out inspections for student housing. Residents film each room from a QR code on the door,
in the phone's browser, with no app and no login. Every photo is SHA-256 fingerprinted the moment it is taken
and the record is sealed when they submit. Staff then review only what changed since the last record, and
charges come from the property's rate sheet, split among roommates, with the Texas refund deadline.

This is the prototype phase of the Walkthru roadmap: room-mapped capture with a timestamp and hash per photo,
stored locally, with no accounts. It follows the product as described in the **Walkthru Owner's Manual**
(Oct 25, 2026), the **Walkthru Road Map** and the **6-Month Startup Roadmap** doc. `docs/PLAN.md` says how those
sources shaped it.

## Try it

Open `/walkthru/` and pick a path on the home page:

| Path | What you do | What it shows |
| --- | --- | --- |
| **Try it as a resident** (best on a phone) | Do Alex's move-out of unit 310 | Live camera, 30% ghost of the move-in photo, condition marks, sealing, the record file |
| **Try it as staff** | Review unit 204's move-out | Clipboard mode: 31 photo pairs, 5 planted changes, drafted charges, settlement |
| **Set up a property** | Add a property, units, residents and deposits | Door QR signs, invite links, your own rate sheet |

The demo property, *Maple Court (demo)*, is generated in your browser when you first open one of the demo
paths (a few seconds). On a computer without a camera, use **Use demo photo** on each capture screen.

A good five-minute tour:

1. **Try it as staff.** Slide the before/after divider on each flagged item. Notice the living-room carpet: the
   resident reported wear, so the draft says *normal wear, no charge*. Press **Accept remaining drafts**, then
   **Settlement**: $360 of charges split between Jordan and Priya against $500 deposits each, with the
   §92.103 deadline per resident.
2. **Try it as a resident** on your phone. Shoot a few items with the camera, use demo photos for the rest,
   then **Seal and submit** and **Send to leasing office**.
3. **Verify.** Press **Change one pixel** in the tamper demo: verification names the altered photo. Put it back
   and everything verifies again. A record file you edit by hand is refused the same way.

## How a record moves without a server

Everything lives in the browser that made it (IndexedDB). Two things carry data between phones and the office:

- **Door QR code / invite link.** The URL carries the unit's details (`#/door/<payload>`). An invite opened
  from the unit page also names one open walkthrough, so every roommate who scans it lands on the same
  record. Printed signs come from **Unit → Door QR sign**.
- **Record file.** After sealing, **Send to leasing office** hands a single JSON file (photos inside) to the
  phone's share sheet, or downloads it. The office opens it with **Unit → Import record** or on **Verify**,
  which checks every photo hash, the chain and the seal before importing. A file that doesn't verify is
  refused.

## What is real and what is stubbed

| Part | Prototype | Production plan |
| --- | --- | --- |
| Capture | `getUserMedia` camera, ghost overlay, file-picker fallback | Same, plus live prompts and screen-recapture detection |
| Fingerprints | Real SHA-256 per photo, hash chain, seal (Web Crypto) | Same, with server-signed timestamps |
| Timestamps | Phone clock, checked against the web server's `Date` header | Server time |
| Storage | This browser only; sealed files move records | Shared cloud record for operator and residents |
| Auto-draft | Pixel comparison with lighting and alignment correction, plus the resident's marks | Feature matching and a vision model |
| Charges | Rate sheet, roommate split, Texas Ch. 92 deadline | More states, export to AppFolio, Buildium, Yardi |

Capture checks shown to reviewers: photo chosen from the library instead of taken live, phone clock more than
two minutes off the server, server clock not reached.

## Limits to keep in mind

- **No server, no sync.** Clearing site data erases the records. Use the record files as backups.
- **The change detector is a heuristic.** It finds "this spot looks different", not "this is a scratch". On
  the demo set it flags all five planted changes and none of the 26 unchanged items (unchanged items peak at
  a score of 0.52, the threshold is 0.75, the weakest planted change scores 1.62). Real photos of a real unit
  will be noisier; that is what the pilot is for.
- **A hash proves a photo wasn't edited after capture, not that it was honest.** Photos of screens are not
  detected yet.
- **Texas only, and not legal advice.** The settlement cites Texas Property Code §§92.103, 92.104, 92.107 and
  92.109 as summaries. Check the statute text and get counsel before relying on them.
- **Rate sheet prices are samples.** Replace them on **Property → Rate sheet**.

## Code

Plain HTML, CSS and ES modules, no build step, like the rest of this site. GitHub Pages serves it as is.
`docs/ARCHITECTURE.md` covers the modules, data model and trust layer.

```
walkthru/
  index.html  styles.css  manifest.webmanifest  icon.svg
  js/app.js           router and boot
  js/core/            pure logic, unit tested (templates, rates, integrity, diff, draft, charges, texas, payload, model)
  js/views/           one module per screen
  js/store.js         IndexedDB
  js/camera.js  js/imaging.js  js/demo.js  js/records.js  js/qr.js  js/ui.js
  vendor/qrcode.mjs   qrcode-generator 2.0.4 (MIT), see vendor/README.md
  tests/              *.test.mjs (node --test) and browser-smoke.mjs (Playwright)
  docs/PLAN.md  docs/ARCHITECTURE.md
```

## Tests

```sh
node --test 'walkthru/tests/*.test.mjs'     # 37 unit tests: hashing, chain and seal, change detection,
                                             # drafts, charge splits, Texas dates, payloads, model rules
```

The browser smoke test checks the roadmap gate and walks both flows with a simulated camera:

```sh
python3 -m http.server 8123                  # from the repository root, in another terminal
npm install --no-save playwright && npx playwright install chromium   # once
node walkthru/tests/browser-smoke.mjs
```

Run locally with any static server from the repository root (camera access needs `localhost` or HTTPS):
`python3 -m http.server 8123`, then open <http://localhost:8123/walkthru/>.

## Next steps (from the roadmap)

- Pilot gate: one unit in under 20 minutes on a real phone, and the comparison catching real planted damage.
- A shared backend so residents and staff see one record, with server-signed timestamps.
- Swap the heuristic draft for feature matching plus a vision model, keeping staff sign-off.
- Screen-recapture detection and live capture prompts.
- Exports for property-management software; more states' deposit rules.
