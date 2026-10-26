# Walkthru prototype: build plan

Written before any code, on Oct 25, 2026. It records what the prototype is, why it is shaped this
way, and the order it was built in. `ARCHITECTURE.md` describes the code as it ended up.

## 1. Sources

The prototype is built from Aashwat's Y Combinator material on Walkthru:

| Source | Date | What it contributes |
| --- | --- | --- |
| Google Doc "Walkthru – 6-Month Startup Roadmap" | Oct 18 | Room checklist templates and high-dispute zones, SHA-256 per photo, baseline report, roommate co-capture, 48-hour lock window, ghost-overlay camera, before/after slider, Texas Property Code Ch. 92 rules |
| Artifact "Walkthru Road Map" | Oct 19 | The prototype phase itself: "room-mapped capture with a timestamp and SHA-256 hash per photo. Store locally, with no accounts." Gate: "the comparison flags all five planted changes in the test set." |
| Artifact "Walkthru Owner's Manual" | Oct 25 (latest) | The current product: a **web tool for student housing operators**. Residents scan a QR code on the door, film each room in the phone browser (no app, no login), an auto-draft flags changes since the last report, photos are hashed and timestamped, staff review only what changed ("clipboard mode"), charges come from a rate sheet and split among roommates, and the last move-out becomes the next move-in baseline. |

Where the sources disagree (renter-first in the Google Doc, operator-first in the Owner's Manual),
the prototype follows the newest one, the Owner's Manual, and keeps the renter-protective parts of
the older ones (sealed records the resident keeps, wear-and-tear guard, Texas deadlines).

## 2. What the prototype must show

The five steps from the Owner's Manual, end to end, in one browser:

1. **Scan.** A door QR code opens the capture page for that unit. No app, no login.
2. **Film.** Guided room-by-room capture from the phone camera, one checklist item at a time, with
   a 30% ghost overlay of the baseline photo so the move-out angle matches the move-in angle.
3. **Draft.** Compare every move-out photo with the baseline photo, flag what changed, and draft
   charges from the rate sheet. In the prototype this is a pixel-comparison change detector, not a
   vision model, and the UI says so.
4. **Lock.** Each photo is SHA-256 hashed the moment it is captured. Entries form a hash chain and
   each submission is sealed. Change one pixel and verification fails.
5. **Charge.** Staff approve, edit or waive each drafted charge, split it among roommates, and get
   an itemized statement with the Texas deadline.

Acceptance criteria (checked in the browser before shipping):

- A full demo walkthrough (load demo → resident capture → staff review → settlement) works on a
  phone-sized and a desktop-sized screen with no console errors.
- The demo move-out has **five planted changes** plus lighting and camera-shift noise on every
  photo. The change detector must flag all five and no unchanged item (the Road Map's gate).
- Altering one pixel of a stored photo makes verification fail; the untouched record verifies.
- All charge splits add up to the cent.

## 3. Out of scope (said plainly in the README)

- No server: no accounts, no sync, no server-signed timestamps. Data lives in the browser
  (IndexedDB). Records move between phone and office as a sealed file (share sheet or download).
- No vision model. The draft is a heuristic over pixel differences and the resident's own marks.
- No screen-recapture detection. Capture checks are limited to "live camera vs uploaded file" and a
  clock check against the web server's `Date` header.
- Texas only, and not legal advice. Statute summaries cite sections and say to check the text.

## 4. Tech stack

Same as the rest of this repo, so it deploys with GitHub Pages and nothing to install:

| Concern | Choice | Why |
| --- | --- | --- |
| UI | Vanilla HTML, CSS and ES modules, hash router | Matches `lockin/` and `hamza/`; no build step |
| Storage | IndexedDB (records + photo blobs keyed by their hash) | Photos are too big for `localStorage`; content addressing makes tampering visible |
| Hashing | Web Crypto `crypto.subtle.digest('SHA-256')` | Built into browsers and Node 22, so it is unit-testable |
| Camera | `getUserMedia` with a file-input fallback | Works in the phone browser with no app |
| Change detection | Plain JS over `ImageData` (normalize, align, block diff) | Pure function, testable in Node |
| QR codes | `qrcode-generator` 2.0.4 (MIT), vendored in `walkthru/vendor/` | Proven encoder; no CDN at runtime |
| Fonts | Barlow and Barlow Condensed (Google Fonts) with system fallbacks | The Owner's Manual brand |
| Tests | `node --test` for pure modules; a Playwright smoke script for the browser | Same runner as the other apps |

## 5. Structure

```
walkthru/
  index.html, styles.css, manifest.webmanifest, icon.svg
  js/
    app.js          boot, hash router, layout
    ui.js           escaping, formatting, toasts, small DOM helpers
    store.js        IndexedDB: state document + photo blobs
    camera.js       live camera, frame grab, file fallback
    imaging.js      blob ↔ canvas, downscale to ImageData
    demo.js         synthetic demo property and photos (five planted changes)
    qr.js           QR code → SVG via the vendored encoder
    core/           pure logic, no DOM, all unit tested
      templates.js  unit layouts and checklist items (high-dispute zones)
      rates.js      default rate sheet
      integrity.js  SHA-256, canonical JSON, hash chain, seals, verification
      diff.js       image change detection
      draft.js      change → suggested charge, wear-and-tear guard
      charges.js    cents, roommate split, settlement totals
      texas.js      Tex. Prop. Code Ch. 92 deadlines and citations
      payload.js    QR payload and record-file encode/validate
      model.js      create/derive properties, units, inspections, submissions
    views/          one module per screen
  vendor/qrcode.mjs
  tests/*.test.mjs
  docs/PLAN.md, docs/ARCHITECTURE.md
  README.md
```

## 6. Data model

```
Property   { id, name, city, state, rates[] }
Unit       { id, propertyId, label, template, residents[{id, name, bedroom, depositCents}], baselineId }
Inspection { id, unitId, kind: move-in|move-out, openedAt, lockAt (+48h), surrenderDate,
             submissions[], review{ decisions{} , reviewedAt } }
Submission { id, inspectionId, residentId, residentName, startedAt, submittedAt,
             entries[], head, seal }
Entry      { id, areaId, itemId, condition: ok|wear|damage, note,
             photo{ hash, type, width, height, capturedAt, serverTime, source }, prev, hash }
```

Rules: a submission is editable until it is sealed or the inspection's 48-hour window closes. A
sealed move-in or move-out becomes the unit's baseline. Review decisions live beside the evidence,
never inside it, so staff can't alter what residents captured.

## 7. Build order

1. This plan (commit).
2. Pure core modules with tests: integrity, charges, texas, templates/rates, payload, model, diff,
   draft. `node --test walkthru/tests/` green before any UI.
3. Shell: `index.html`, styles, router, store, UI helpers.
4. Demo generator: canvas-drawn room photos, move-out set with noise and five planted changes.
5. Office: dashboard, unit page, rate sheet, door QR sign.
6. Resident: scan, start, guided capture with ghost overlay, submit and seal, receipt, send file.
7. Review (clipboard mode): changes-only list, before/after slider, change boxes, drafted charges.
8. Settlement: per-resident split, deposits, Texas deadline, print and CSV.
9. Verify: check a record file or photo, tamper demo.
10. Docs: `walkthru/README.md`, `ARCHITECTURE.md`, root README and home page link.
11. Browser verification (Playwright, phone and desktop), fix, review the diff, commit, push.

## 8. Changes to existing code

Only two existing files change: the home page gets a Walkthru link and the root README gets a
Walkthru section. Lock In and Hamza Lessons are not touched, so nothing there needs refactoring.
