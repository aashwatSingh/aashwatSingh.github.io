# Product

<!-- impeccable:product-schema 1 -->

Walkthru is a startup product, and this folder holds its working prototype. It is separate from the
personal tools described in the root `PRODUCT.md`; none of that context applies here.

## Platform

web

## Users

- **Student housing operators (leasing office staff):** the paying customer in the current product
  definition (Walkthru Owner's Manual, Oct 25, 2026). They review move-out records, approve or edit
  drafted charges, and settle deposits.
- **Residents (students):** scan a QR code on the unit door and film each room in the phone's browser,
  with no app and no login, at move-in and move-out. They keep a sealed copy of their record.
- **Roommates:** share a unit. Charges are split among them, and each has their own deposit and
  deadline.

The prototype is also shown to evaluators of the startup (it is built from Aashwat's Y Combinator
material). Who evaluates it beyond that, and whether any operator has piloted it, isn't recorded in the
repo.

## Product Purpose

Walkthru makes move-in and move-out inspections fast and hard to dispute: the resident does the filming,
the record is tamper-evident, staff review only what changed, and charges come out itemized with the
legal deadline attached. The last move-out becomes the next move-in baseline.

The prototype's own gate (from the Walkthru Road Map) is that the comparison flags all five planted
changes in the demo set and no unchanged item.

## Positioning

- **The resident does the filming:** from a door QR code, in the phone browser, with no app and no
  login, guided item by item with a 30% ghost overlay of the baseline photo so the angles match.
- **Tamper-evident records:** every photo is SHA-256 fingerprinted the moment it is taken, the entries
  form a hash chain, and the record is sealed on submit. Changing one pixel makes verification name the
  altered photo.
- **Staff review only the changes:** "clipboard mode" shows before and after pairs for flagged items,
  with charges drafted from the property's rate sheet, split among roommates, and the Texas Property
  Code §92.103 refund deadline per resident.
- **Fair to residents:** wear the resident reported is drafted as normal wear with no charge.

## Operating Context

- **Resident:** stands in an empty unit on a phone, often with poor lighting, working through the
  room-by-room checklist.
- **Staff:** work in the leasing office on a desktop, going through 31 photo pairs per unit.
- **Moving records:** with no server, records move between the phone and the office as a sealed file
  (share sheet or download).
- **Physical artifacts:** door QR code signs, invite links, a rate sheet.
- **Demo property:** *Maple Court (demo)* is generated in the browser, and unit 204's move-out has five
  planted changes plus lighting and camera-shift noise. The demo paths are Try it as a resident, Try it
  as staff, and Set up a property.

## Capabilities and Constraints

- **Prototype phase:** no server, accounts, sync, or server-signed timestamps. Data lives in IndexedDB,
  with photo blobs keyed by their hash.
- **No vision model:** the change draft is a pixel-difference heuristic plus the resident's own marks,
  and the UI says so.
- **Capture checks:** limited to live camera vs uploaded file and a clock check against the web server's
  `Date` header. There is no screen-recapture detection.
- **Texas only, and not legal advice:** statute summaries cite their sections and say to check the text.
- **Stack:** vanilla HTML, CSS and ES modules with a hash router and no build step, deployed on GitHub
  Pages with the rest of the repo.
- **Acceptance:** the full demo works on phone-sized and desktop-sized screens with no console errors,
  and charge splits add up to the cent.
- **Docs:** design in `docs/ARCHITECTURE.md`, plan and sources in `docs/PLAN.md`, tour in `README.md`.

## Brand Commitments

- **Name:** Walkthru.
- **Owner's Manual brand:** navy, safety yellow and Barlow Condensed (recorded in `styles.css`). The
  Owner's Manual is the source of truth for the brand. It isn't in this repo.
- **Terminology:** "sealed" record, "baseline", "clipboard mode", "rate sheet", "settlement".

## Evidence on Hand

- **Demo only:** the Maple Court data generated in the browser, a tamper demo ("Change one pixel") and a
  sample settlement ($360 of charges split between Jordan and Priya against $500 deposits each).
- **Nothing real yet:** there are no customer names, pilots, testimonials, metrics or pricing in the
  repo. Future work must not invent any.

## Product Principles

1. **A record you can trust:** every capture is fingerprinted and sealed, and tampering is visible.
2. **Review the difference, not the unit:** staff time goes only to what changed.
3. **Fair to residents:** guard normal wear and tear, give residents their own sealed copy, and state
   the deadlines.
4. **No app, no login:** a QR code and a phone browser are enough.
5. **Say what the prototype can't do:** its limits (no vision model, Texas only, not legal advice) are
   stated in the product, not hidden.

## Accessibility & Inclusion

No product-specific requirement has been established. The current practice includes a skip link, 3px
focus rings, and support for reduced motion and dark mode. Capture happens one-handed on a phone,
often in poor light.
