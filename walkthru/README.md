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

## Sync: a shared backend (optional)

Turn on sync and phones and office devices share records through your own Supabase project. A resident who
scans a door code sends their sealed record straight to the office; a phone doing a move-out downloads the
move-in photos for the ghost overlay; every office device sees the same units, reviews and settlements. The app
still works fully offline and without sync; records then move as files (next section).

### Set it up (about five minutes)

1. Create a free project at [supabase.com](https://supabase.com).
2. In the project, open **SQL Editor**, paste all of [`supabase/schema.sql`](supabase/schema.sql) and **Run**. It
   only creates `wt_` tables and functions; running it again is safe.
3. Open **Project Settings → API Keys** and copy the **Project URL** and the **publishable** key
   (`sb_publishable_…`). The older `anon` key also works but makes the door QR codes much denser. Never use
   the secret or `service_role` key.
4. In Walkthru, go to **Office → Sync**, paste both, leave *Sync key* empty, and press **Connect**. That creates
   your sync space and uploads your properties (not the demo).
5. Reprint door signs from **Unit → Door QR sign**: they now carry the unit's door code (the sign says *Sync on*).
6. To add another office computer, open the **Add another office device** link from the Sync page on it.

### Who can see what

| Secret | Held by | Can |
| --- | --- | --- |
| Public key | Anyone (it's in every door QR) | Call the Walkthru functions, nothing more. The tables themselves are closed to it. |
| Sync key | Office staff (Sync page, connect link) | Read and change everything in its space. |
| Door code | Anyone who scans that unit's door | Add inspections and sealed records for that one unit, upload photos, and read that unit's records and photos with deposits, staff decisions and settlement dates removed. |

- The server keeps only SHA-256 hashes of sync keys and door codes.
- The server re-hashes every uploaded photo and refuses one that doesn't match its fingerprint, and it never
  lets a sealed record be replaced.
- Devices don't trust the server either: every downloaded photo is checked against its fingerprint and every
  sealed record is verified before use. Anything that fails is refused and listed on the Sync page.
- Trade-offs of having no accounts: a door code is a bearer secret, so anyone who photographs the door sign can
  add records for that unit (they're sealed and named, and staff review them) and can see earlier residents'
  names and photos for that unit. Anyone with the public key can create an empty sync space. Production would
  add sign-in and per-lease access.

### What syncs and how conflicts resolve

Properties (with rate sheets), units (with residents and deposits), inspections (with staff decisions,
forwarding addresses and finalization) and sealed records with their photos. Drafts stay on the phone until
sealed. The demo property never syncs. **Deleting isn't synced**: removing something on one device doesn't
remove it elsewhere.

Devices sync when the app opens, every 30 seconds while it's open, when it comes back to the foreground, a
moment after any change, and from **Sync now**. If two devices change the same record before syncing, lists are
combined (residents, staff decisions per item keeping the later one, forwarding addresses) and single values
take the most recent save that reached the server.

### Try sync without a Supabase account

A local stand-in runs the same schema in PGlite (Postgres compiled to WebAssembly):

```sh
npm install --no-save @electric-sql/pglite
node walkthru/tests/supabase-standin.mjs     # prints a URL and key to paste into Office → Sync
```

Data lives in memory until you stop it.

## How a record moves without a server

Without sync, everything lives in the browser that made it (IndexedDB). Two things carry data between phones
and the office:

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
| Timestamps | Phone clock, checked against the web server's `Date` header | Server-signed time |
| Storage | This browser (IndexedDB), plus optional sync through your own Supabase project | Same, with accounts and per-lease access |
| Auto-draft | Pixel comparison with lighting and alignment correction, plus the resident's marks | Feature matching and a vision model |
| Charges | Rate sheet, roommate split, Texas Ch. 92 deadline | More states, export to AppFolio, Buildium, Yardi |

Capture checks shown to reviewers: photo chosen from the library instead of taken live, phone clock more than
two minutes off the server, server clock not reached.

## Limits to keep in mind

- **Without sync, records live on one device.** Clearing site data erases them; use sync or the record files as
  backups. With sync, see *Who can see what* above for the no-accounts trade-offs.
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
  js/sync.js          Supabase sync client (plain fetch, no SDK)
  js/camera.js  js/imaging.js  js/demo.js  js/records.js  js/qr.js  js/ui.js
  supabase/schema.sql tables and functions to run in your Supabase project
  vendor/qrcode.mjs   qrcode-generator 2.0.4 (MIT), see vendor/README.md
  tests/              *.test.mjs (node --test), browser-smoke.mjs and sync-browser.mjs (Playwright),
                      supabase-standin.mjs (local Supabase stand-in)
  docs/PLAN.md  docs/ARCHITECTURE.md
```

## Tests

```sh
node --test 'walkthru/tests/*.test.mjs'     # unit tests: hashing, chain and seal, change detection, drafts,
                                             # charge splits, Texas dates, payloads, model and sync merge rules
```

The SQL tests in `tests/supabase.test.mjs` run the real schema in PGlite as Supabase's `anon` role. They skip
unless PGlite is installed: `npm install --no-save @electric-sql/pglite`.

The browser smoke test checks the roadmap gate and walks both flows with a simulated camera:

```sh
python3 -m http.server 8123                  # from the repository root, in another terminal
npm install --no-save playwright && npx playwright install chromium   # once
node walkthru/tests/browser-smoke.mjs
node walkthru/tests/sync-browser.mjs         # two phones and two office devices syncing (needs PGlite too)
```

Run locally with any static server from the repository root (camera access needs `localhost` or HTTPS):
`python3 -m http.server 8123`, then open <http://localhost:8123/walkthru/>.

## Next steps (from the roadmap)

- Pilot gate: one unit in under 20 minutes on a real phone, and the comparison catching real planted damage.
- Accounts and per-lease access on top of sync, and server-signed timestamps.
- Swap the heuristic draft for feature matching plus a vision model, keeping staff sign-off.
- Screen-recapture detection and live capture prompts.
- Exports for property-management software; more states' deposit rules.
