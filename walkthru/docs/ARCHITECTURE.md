# Walkthru prototype: architecture

How the code is organized and why. `PLAN.md` has the original plan; this file describes what was built.

## Layers

```
views/*.js ──► core/*.js           pure logic, no DOM, unit tested in Node
    │
    ├──► store.js                  IndexedDB: one state document + photo blobs by hash
    ├──► camera.js, imaging.js     getUserMedia, canvas, downscaling, diff cache
    ├──► records.js                record files: export, check, import, verify all
    ├──► demo.js                   synthetic demo property and photos
    └──► ui.js                     safe HTML templating, formatting, toasts, photo URLs
app.js                             boot, hash router, cleanup between screens
```

Rules the code keeps:

- `core/` never touches the DOM or storage. Anything with a rule in it (hashing, money, dates, which
  inspection is the baseline, what the draft suggests) lives there and has tests.
- Views build markup only through the `html` tagged template in `ui.js`, which escapes every
  interpolated value. Resident names, notes, property names and anything from a record file or URL are
  text, never markup. (The QR SVG is the one `raw()` insert, and it is generated locally.)
- Evidence and judgement are kept apart. Submissions (what residents captured) are sealed and never edited.
  Staff decisions live on the inspection under `review.decisions`, so reviewing can't alter evidence.

## Routes

| Hash | Screen | Module |
| --- | --- | --- |
| `#/` | Home | `views/home.js` |
| `#/about` | How it works | `views/home.js` |
| `#/demo?then=…` | Build the demo property, then go on | `views/home.js` |
| `#/office`, `#/office/p/:pid`, `#/office/u/:uid` | Properties, units, one unit | `views/office.js` |
| `#/office/rates/:pid`, `#/office/qr/:uid[?i=iid]` | Rate sheet, door sign or invite | `views/office.js` |
| `#/office/review/:iid` | Clipboard mode | `views/review.js` |
| `#/office/settle/:iid` | Settlement | `views/settle.js` |
| `#/report/:iid` | Condition report | `views/report.js` |
| `#/door/:payload` → `#/start/:uid[?i=iid]` | QR landing, start | `views/resident.js` |
| `#/capture/:sid[?i=n]`, `#/submit/:sid`, `#/receipt/:sid` | Capture, seal, receipt | `views/resident.js` |
| `#/verify` | Verify and tamper demo | `views/verify.js` |

A view is `(main, params, ctx) => cleanup?`. `ctx` holds the state, `save()`, `go()`, `now()` and
`rerender()`. The capture screen returns a cleanup that stops the camera when you leave.

## Data model (`core/model.js`)

```
state = { version: 1, properties, units, inspections, submissions }   (objects keyed by id)

Property   { id, name, city, state: 'TX', rates: [{ id, label, cents }], demo? }
Unit       { id, propertyId, label, template, residents: [{ id, name, bedroom, depositCents }] }
Inspection { id, unitId, kind: 'move-in' | 'move-out', openedAt, lockAt,
             surrenderDate, forwarding: { residentId: bool },
             review: { decisions: { itemKey: Decision }, finalizedAt } }
Submission { id, inspectionId, unitId, kind, residentId, residentName, bedroom,
             startedAt, submittedAt, entries: [Entry], head, seal }
Entry      { id, key: 'areaId.itemId', condition: 'ok' | 'wear' | 'damage', note,
             photo: { hash, type, width, height, capturedAt, serverTime, source }, prev, hash }
Decision   { action: 'charge' | 'wear' | 'dismiss', rateId?, label?, cents?, responsible?: [residentId], decidedAt }
```

Rules:

- An inspection accepts photos for 48 hours from `openedAt` (`LOCK_HOURS`), matching the 48 to 72 hour
  inventory window in Texas leases. A submission can be sealed only inside that window.
- **Baseline:** an inspection is compared with the most recent earlier inspection of the same unit that has
  at least one sealed submission (`baselineOf`). So the last move-out becomes the next move-in's baseline
  without a pointer to keep in sync.
- Roommates each make a submission. Shared rooms may get several photos; the review compares the earliest
  and lists the rest. Each resident's checklist is the shared rooms plus their own bedroom.
- Units come from templates (`core/templates.js`): studio, 1×1, 2×2 and a 4×2 student suite. Item keys like
  `bedA.carpet` link entries, photos, drafts and decisions.

## Trust layer (`core/integrity.js`)

1. **Photo hash.** SHA-256 of the exact JPEG bytes, computed right after capture. The photo is stored in
   IndexedDB under that hash, so the key is the fingerprint.
2. **Entry hash chain.** At sealing, entries are ordered by capture time and each gets
   `hash = SHA-256(prev + "\n" + canonicalJSON(entry fields))`, starting from 64 zeros. Canonical JSON sorts
   keys so the same data always hashes the same.
3. **Seal.** SHA-256 over the submission's who/what/when and the chain head. One value commits to everything.
4. **Verify** recomputes all three and reports in plain words what broke: an altered photo, a changed entry,
   a removed or reordered entry, or changed submission details.
5. **Clock check.** Each capture also records the web server's clock from the `Date` header of a tiny
   same-origin request, so a phone with a wrong clock stands out. It is a check, not a signed timestamp.

## Change detection (`core/diff.js`, `imaging.js`)

Both photos are shrunk to 192×144 in two smoothed steps (one big jump turns blind slats into moiré), then:

1. grayscale and a 3×3 blur;
2. normalize to zero mean and unit deviation, which cancels lighting changes;
3. search shifts of up to ±5 px for the best alignment, which cancels a slightly different camera position;
4. per pixel, take the best match within a 3×3 neighbourhood of the other photo in both directions, which
   absorbs sub-pixel shifts on thin edges while keeping new marks;
5. average per 8×8 block and flag blocks above `max(0.75, median + 6 × MAD)` of all blocks;
6. join neighbouring flagged blocks into regions, reported as fractions of the image.

`core/draft.js` turns that plus the resident's mark into a suggestion: unchanged, pre-existing damage (no
charge), normal wear (no charge, citing §92.104(b)), or a charge from the item's linked rates, the heavier
rate when the change is large. Staff confirm every line.

Tuning evidence, from `tests/browser-smoke.mjs` on the demo set (31 pairs, every move-out photo with new
light, a shifted camera and grain): planted changes score 1.62 to 4.52; unchanged items peak at 0.52.

## Money and Texas rules

`core/charges.js` works in whole cents. `split()` hands leftover cents to the first residents so parts always
add up. Bedroom items default to that bedroom's resident, shared rooms to everyone; staff can change who pays.
`settle()` caps refunds at zero and shows any excess as owed.

`core/texas.js` holds the cited rules and `refundStatus()`: due 30 days after surrender (§92.103), not due
before a written forwarding address (§92.107), flagged a week ahead and when overdue (§92.109).

## Record file (`core/payload.js`)

```
{ format: 'walkthru-record', version: 1, exportedAt,
  property: { id, name, city, state }, unit: { id, label, template },
  inspection: { id, kind, openedAt, lockAt },
  submission: <sealed submission>,
  photos: { <hash>: 'data:image/jpeg;base64,…' } }
```

`readRecord()` validates every field and accepts only JPEG, PNG or WebP data URLs, keeping strings exactly as
sealed. `records.js` then runs full verification and refuses to import anything that fails, a unit whose
layout differs, or a different submission under an existing id.

The door payload is base64url JSON: property and unit details, plus an optional open inspection
(`iid, ik, io, il`) for invite links.

## Storage (`store.js`)

IndexedDB database `walkthru`, version 1, with stores `state` (one document under `main`) and `photos`
(`{ type, blob }` by hash). If IndexedDB is unavailable, it falls back to memory and the footer says so.
`ghost` overlay opacity is the only `localStorage` value (`walkthru:ghost`).

## Testing

- `node --test 'walkthru/tests/*.test.mjs'`: unit tests for every `core/` module.
- `node walkthru/tests/browser-smoke.mjs`: Playwright run of the gate and both flows with a fake camera
  (setup in the README).
- Checked during the build but not committed: axe-core accessibility scans of every screen in light and dark
  (no WCAG A/AA violations), and decoding the door QR code back to its URL with jsQR.
