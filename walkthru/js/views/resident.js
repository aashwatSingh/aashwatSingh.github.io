// The resident side: what opens from the door QR code. Start → capture each item → seal → send.
// Built for a phone held in one hand: one item per screen, big shutter, no account.

import { html, $, $$, toast, fmtDateTime, countdown, plural, CONDITION_LABEL, hydratePhotos } from '../ui.js';
import { TEMPLATES, bedroomsOf, checklistFor } from '../core/templates.js';
import { decodeDoor } from '../core/payload.js';
import { sha256Hex, shortHash, sealSubmission, verifySubmission } from '../core/integrity.js';
import {
  addProperty, addUnit, upsertResident, openBedrooms, openInspection, openInspectionFor, isLocked, inspectionsOf,
  sealedOf, startSubmission, submissionsOf, putEntry, coverage, baselineOf, evidenceOf, newId,
} from '../core/model.js';
import { putPhoto, getPhotoBytes } from '../store.js';
import { cameraSupported, openCamera, attach, stopCamera, grabFrame, serverTime, captureWarnings } from '../camera.js';
import { normalizeUpload } from '../imaging.js';
import { demoShotFor, demoReport, isDemoUnit } from '../demo.js';
import { exportSubmission, shareOrDownload } from '../records.js';
import { notFound, kindLabel, callout } from './common.js';

const GHOST_KEY = 'walkthru:ghost';
// The ghost overlay's opacity: 30% by default, as in the roadmap; remembered once changed.
const readGhost = () => {
  try {
    const saved = localStorage.getItem(GHOST_KEY);
    const v = saved == null ? NaN : Number(saved);
    return v >= 0 && v <= 0.8 ? v : 0.3;
  } catch {
    return 0.3;
  }
};
const writeGhost = (v) => { try { localStorage.setItem(GHOST_KEY, String(v)); } catch { /* not saved; fine */ } };

// ---------------------------------------------------------------- door QR landing

export async function door(main, { payload }, ctx) {
  const d = decodeDoor(payload);
  if (!d) {
    main.innerHTML = String(html`<h1>This code didn't work</h1><p>The QR code or link is damaged or incomplete. Ask your leasing office for a new one.</p>`);
    return;
  }
  const s = ctx.state;
  if (!s.properties[d.property.id]) addProperty(s, d.property);
  const existing = s.units[d.unit.id];
  if (existing && existing.template !== d.unit.template) {
    main.innerHTML = String(html`<h1>This code doesn't match</h1><p>This phone already has unit ${existing.label} with a different layout. Ask your leasing office for a new code.</p>`);
    return;
  }
  if (!existing) addUnit(s, d.unit);
  let q = '';
  if (d.inspection) {
    if (!s.inspections[d.inspection.id]) {
      const i = openInspection(s, { id: d.inspection.id, unitId: d.unit.id, kind: d.inspection.kind, now: Date.parse(d.inspection.openedAt) });
      i.lockAt = d.inspection.lockAt;
    }
    q = `?i=${encodeURIComponent(d.inspection.id)}`;
  }
  await ctx.save();
  ctx.go(`#/start/${d.unit.id}${q}`);
}

// ---------------------------------------------------------------- start

function suggestedKind(state, unitId) {
  const sealed = inspectionsOf(state, unitId).filter((i) => sealedOf(state, i.id).length);
  return sealed.length && sealed[sealed.length - 1].kind === 'move-in' ? 'move-out' : 'move-in';
}

export function start(main, { uid, query }, ctx) {
  const s = ctx.state;
  const unit = s.units[uid];
  if (!unit) return notFound(main, 'unit');
  const prop = s.properties[unit.propertyId];
  const now = ctx.now();
  const invited = query.get('i') ? s.inspections[query.get('i')] : null;
  const invite = invited && invited.unitId === uid && !isLocked(invited, now) && !invited.review.finalizedAt ? invited : null;
  const bedrooms = bedroomsOf(unit.template);
  const free = openBedrooms(unit);
  let kind = invite?.kind || query.get('kind') || suggestedKind(s, uid);

  const draw = () => {
    const open = invite || openInspectionFor(s, uid, kind, now);
    main.innerHTML = String(html`
      <div class="capture">
        <div class="band">
          <div class="eyebrow" style="color: var(--yellow)">${prop.name}</div>
          <h1 style="margin-bottom: 4px">Unit ${unit.label}</h1>
          <p class="muted" style="margin: 0">${TEMPLATES[unit.template].label}</p>
        </div>
        ${invited && !invite ? callout('caution', 'Link expired', html`<p>That walkthrough link has closed. You can still start a new walkthrough below.</p>`) : ''}
        <form id="start" style="margin-top: 18px">
          ${invite ? html`<p><span class="chip collecting">${kindLabel(invite.kind)}</span> You're joining the walkthrough your leasing office opened. It stays open until ${fmtDateTime(invite.lockAt)}.</p>` : html`
          <fieldset class="seg">
            <legend>What are you doing?</legend>
            ${['move-in', 'move-out'].map((k) => html`<label><input type="radio" name="kind" value="${k}" ${k === kind ? 'checked' : ''}><span>${k === 'move-in' ? "I'm moving in" : "I'm moving out"}</span></label>`)}
          </fieldset>
          ${open ? html`<p class="small muted">Joins the ${kind} walkthrough opened ${fmtDateTime(open.openedAt)}, open until ${fmtDateTime(open.lockAt)}.</p>` : html`<p class="small muted">Starts a new ${kind} walkthrough. It stays open for 48 hours so roommates can add their rooms.</p>`}`}

          ${unit.residents.length ? html`<fieldset class="seg" style="display: grid">
            <legend>Who are you?</legend>
            ${unit.residents.map((r, i) => html`<label><input type="radio" name="who" value="${r.id}" ${i === 0 ? 'checked' : ''}><span>${r.name}${r.bedroom ? ` · Bedroom ${r.bedroom}` : ''}</span></label>`)}
            <label><input type="radio" name="who" value="new" ${unit.residents.length ? '' : 'checked'}><span>Someone else</span></label>
          </fieldset>` : html`<input type="hidden" name="who" value="new">`}
          <div id="new-who" ${unit.residents.length ? 'hidden' : ''}>
            <label class="field"><span>Your name</span><input type="text" name="name" maxlength="60" autocomplete="name"></label>
            ${bedrooms.length ? html`<label class="field"><span>Your bedroom</span>
              <select name="bedroom">${bedrooms.map((b) => html`<option value="${b}" ${free[0] === b ? 'selected' : ''}>Bedroom ${b}${free.includes(b) ? '' : ' (claimed)'}</option>`)}</select>
              <small>You'll shoot your bedroom plus the shared rooms.</small></label>` : ''}
          </div>
          <label class="check" style="margin: 8px 0 18px"><input type="checkbox" name="consent" required>
            <span>I understand each photo is fingerprinted and timestamped, and my record is sealed when I submit it.</span></label>
          <button class="btn primary big" style="width: 100%">Start walkthrough</button>
        </form>
      </div>
    `);
    const form = $('#start');
    for (const r of $$('input[name="kind"]', form)) r.addEventListener('change', () => { kind = r.value; draw(); });
    for (const r of $$('input[name="who"]', form)) r.addEventListener('change', () => { $('#new-who').hidden = form.who.value !== 'new'; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      let resident;
      if (f.get('who') && f.get('who') !== 'new') resident = unit.residents.find((r) => r.id === f.get('who'));
      if (!resident) {
        const name = String(f.get('name') || '').trim();
        if (!name) { toast('Enter your name.', 'bad'); form.name?.focus(); return; }
        resident = upsertResident(unit, { name, bedroom: f.get('bedroom') || null });
      }
      const insp = invite || openInspectionFor(s, uid, kind, ctx.now()) || openInspection(s, { unitId: uid, kind, now: ctx.now() });
      const mine = submissionsOf(s, insp.id).find((x) => x.residentId === resident.id && !x.seal);
      const sub = mine || startSubmission(s, { inspection: insp, resident, now: ctx.now() });
      await ctx.save();
      ctx.go(`#/capture/${sub.id}`);
    });
  };
  draw();
}

// ---------------------------------------------------------------- capture

export function capture(main, { sid, query }, ctx) {
  const s = ctx.state;
  let sub = s.submissions[sid];
  if (!sub) return notFound(main, 'walkthrough');
  if (sub.seal) { ctx.go(`#/receipt/${sid}`); return; }
  const insp = s.inspections[sub.inspectionId];
  const unit = s.units[sub.unitId];
  if (isLocked(insp, ctx.now())) {
    main.innerHTML = String(html`<div class="capture"><h1>This walkthrough has closed</h1>
      <p>The 48-hour window ended ${fmtDateTime(insp.lockAt)}, so no more photos can be added and this draft can't be sealed. Ask your leasing office to open a new one.</p></div>`);
    return;
  }

  const items = checklistFor(unit.template, sub.bedroom);
  const base = baselineOf(s, insp);
  const baseEv = base ? evidenceOf(s, base.id) : {};
  const mates = evidenceOf(s, insp.id); // roommates' sealed shots in this walkthrough
  const demo = isDemoUnit(unit);
  const entryFor = (key) => sub.entries.find((e) => e.key === key);
  const firstMissing = items.findIndex((c) => !entryFor(c.key));
  let index = Math.min(items.length - 1, Math.max(0, Number(query.get('i')) || (firstMissing >= 0 ? firstMissing : 0)));
  let retaking = false;
  let busy = false;
  let ghost = readGhost();
  let stream = null;
  let camState = cameraSupported() ? 'starting' : 'off';
  let disposed = false;

  const draw = () => {
    const c = items[index];
    const entry = entryFor(c.key);
    const basePhoto = baseEv[c.key]?.[0]?.entry.photo || null;
    const showShot = entry && !retaking;
    const cov = coverage(unit, sub);
    const areaItems = items.filter((x) => x.area.id === c.area.id);
    const areaPos = areaItems.indexOf(c) + 1;
    main.innerHTML = String(html`
      <div class="capture">
        <div class="cap-head">
          <span class="cap-area">${c.area.label} · ${areaPos} of ${areaItems.length}</span>
          <span class="small muted">Item ${index + 1} of ${items.length} · locks in ${countdown(insp.lockAt, ctx.now())}</span>
        </div>
        <div class="progressbar" aria-hidden="true"><i style="width: ${Math.round((cov.done / cov.total) * 100)}%"></i></div>
        <h1 class="cap-item">${c.item.label}</h1>
        <p class="muted" style="margin-bottom: 10px">${c.item.hint}${mates[c.key] ? ` A roommate already shot this; add yours if you see something different.` : ''}</p>

        <div class="stage" style="--ghost: ${ghost}">
          ${showShot ? html`
            <img class="shot" data-photo="${entry.photo.hash}" alt="Your photo of ${c.item.label}">
            <span class="hash-badge" title="${entry.photo.hash}">Fingerprint ${shortHash(entry.photo.hash)}</span>
          ` : html`
            ${camState === 'live' ? html`<video autoplay muted playsinline aria-label="Camera preview"></video>` : html`<div class="placeholder"><div>${
              camState === 'starting' ? 'Starting the camera…'
                : camState === 'denied' ? 'Camera access was blocked. Use "Choose photo" below, or allow the camera in your browser settings.'
                  : 'Live camera is not available here. Use "Choose photo" below.'}</div></div>`}
            ${basePhoto && ghost > 0 ? html`<img class="ghost" data-photo="${basePhoto.hash}" alt="">` : ''}
            <div class="corners"></div>
            <span class="rec">${insp.kind === 'move-in' ? 'Move-in' : 'Move-out'}</span>
          `}
        </div>

        <div class="cap-controls">
          <button class="btn ghost" id="prev" ${index === 0 ? 'disabled' : ''}>Back</button>
          ${showShot ? html`<button class="btn ghost" id="retake">Retake</button>`
            : html`<button class="shutter" id="shutter" aria-label="Take photo" ${camState === 'live' && !busy ? '' : 'disabled'}></button>`}
          <button class="btn ${entry ? 'primary' : 'ghost'}" id="next" style="justify-self: end">${index === items.length - 1 ? 'Finish' : 'Next'}</button>
        </div>

        ${!showShot ? html`<div class="row" style="justify-content: center; margin-bottom: 12px">
          <label class="btn ghost small" for="pick">Choose photo</label>
          <input type="file" id="pick" accept="image/*" capture="environment" hidden>
          ${demo ? html`<button class="btn ghost small" id="demo-shot">Use demo photo</button>` : ''}
          ${basePhoto ? html`<span class="ghost-ctl"><label for="ghost">Ghost of last photo</label>
            <input type="range" id="ghost" min="0" max="0.8" step="0.1" value="${ghost}"></span>` : ''}
        </div>` : ''}

        ${entry ? html`<div class="card" style="margin-bottom: 14px">
          <fieldset class="seg cond">
            <legend>Condition</legend>
            ${['ok', 'wear', 'damage'].map((v) => html`<label><input type="radio" name="cond" value="${v}" ${entry.condition === v ? 'checked' : ''}><span>${CONDITION_LABEL[v]}</span></label>`)}
          </fieldset>
          <label class="field" style="margin: 0"><span>Note <small>(optional)</small></span>
            <textarea id="note" maxlength="500" placeholder="e.g. Scuff by the light switch was already here">${entry.note}</textarea></label>
          <p class="small muted" style="margin: 8px 0 0">Taken ${fmtDateTime(entry.photo.capturedAt)}${entry.photo.serverTime ? ', server clock checked' : ''}.</p>
        </div>` : ''}

        <details class="card">
          <summary><b>All items</b> · ${cov.done} of ${cov.total} done</summary>
          <ul class="area-list" style="margin-top: 10px">
            ${items.map((x, i) => html`<li><button type="button" data-go="${i}" ${i === index ? 'aria-current="step"' : ''}>
              <span>${x.area.label}: ${x.item.label}</span>${entryFor(x.key) ? html`<span class="tick">✓ <span class="sr-only">done</span></span>` : mates[x.key] ? html`<span class="small muted">roommate</span>` : ''}
            </button></li>`)}
          </ul>
        </details>
        <a class="btn ${cov.done ? 'dark' : 'ghost'}" style="width: 100%; margin-top: 14px" href="#/submit/${sub.id}">Review and submit</a>
      </div>
    `);
    hydratePhotos(main);
    const video = $('video', main);
    if (video && stream) attach(video, stream);
    wire(c, entry);
  };

  const move = (i) => { index = Math.max(0, Math.min(items.length - 1, i)); retaking = false; draw(); window.scrollTo(0, 0); };

  async function store(c, { blob, width, height }, source, capturedAt, serverAt, report) {
    if (isLocked(insp, ctx.now())) throw new Error('The 48-hour window has closed, so no more photos can be added.');
    const hash = await sha256Hex(new Uint8Array(await blob.arrayBuffer()));
    await putPhoto(hash, { type: blob.type || 'image/jpeg', blob });
    const prev = entryFor(c.key);
    const condition = report?.condition ?? prev?.condition ?? 'ok';
    const note = report?.note ?? prev?.note ?? '';
    putEntry(sub, {
      id: newId('e'), key: c.key, condition, note,
      photo: { hash, type: blob.type || 'image/jpeg', width, height, capturedAt, serverTime: await serverAt, source },
    });
    await ctx.save();
    retaking = false;
    toast(`Photo fingerprinted: ${shortHash(hash)}`);
  }

  async function run(fn) {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (err) { console.error(err); toast(err.message || 'That did not work.', 'bad'); }
    busy = false;
    if (!disposed) draw();
  }

  function wire(c, entry) {
    $('#prev')?.addEventListener('click', () => move(index - 1));
    $('#next').addEventListener('click', () => (index === items.length - 1 ? ctx.go(`#/submit/${sub.id}`) : move(index + 1)));
    $('#retake')?.addEventListener('click', () => { retaking = true; draw(); });
    $('#shutter')?.addEventListener('click', () => run(async () => {
      const capturedAt = new Date().toISOString();
      const serverAt = serverTime();
      const frame = await grabFrame($('video', main));
      await store(c, frame, 'camera', capturedAt, serverAt);
    }));
    $('#pick')?.addEventListener('change', (e) => run(async () => {
      const file = e.target.files[0];
      if (!file) return;
      const capturedAt = new Date().toISOString();
      const serverAt = serverTime();
      await store(c, await normalizeUpload(file), 'upload', capturedAt, serverAt);
    }));
    $('#demo-shot')?.addEventListener('click', () => run(async () => {
      const capturedAt = new Date().toISOString();
      const shot = await demoShotFor(unit, c.key, insp.kind, `resident-${Date.now()}`);
      await store(c, shot, 'demo', capturedAt, Promise.resolve(null), demoReport(unit, c.key, insp.kind));
    }));
    $('#ghost')?.addEventListener('input', (e) => {
      ghost = Number(e.target.value);
      writeGhost(ghost);
      $('.stage', main).style.setProperty('--ghost', ghost);
      const g = $('.ghost', main);
      if (g) g.hidden = ghost === 0;
    });
    for (const r of $$('input[name="cond"]', main)) {
      r.addEventListener('change', async () => { entry.condition = r.value; await ctx.save(); });
    }
    $('#note')?.addEventListener('change', async (e) => { entry.note = e.target.value.slice(0, 500); await ctx.save(); });
    for (const b of $$('[data-go]', main)) b.addEventListener('click', () => move(Number(b.dataset.go)));
  }

  draw();
  if (camState === 'starting') {
    openCamera().then((st) => {
      if (disposed) { stopCamera(st); return; }
      stream = st;
      camState = 'live';
      draw();
    }).catch((err) => {
      console.warn('Camera unavailable', err);
      camState = err?.name === 'NotAllowedError' ? 'denied' : 'off';
      if (!disposed) draw();
    });
  }
  return () => { disposed = true; stopCamera(stream); };
}

// ---------------------------------------------------------------- review and submit

export function submit(main, { sid }, ctx) {
  const s = ctx.state;
  const sub = s.submissions[sid];
  if (!sub) return notFound(main, 'walkthrough');
  if (sub.seal) { ctx.go(`#/receipt/${sid}`); return; }
  const insp = s.inspections[sub.inspectionId];
  const unit = s.units[sub.unitId];
  const cov = coverage(unit, sub);
  const mates = evidenceOf(s, insp.id);
  const missingMine = cov.missing.filter((c) => !mates[c.key]);
  const byRoommate = cov.missing.filter((c) => mates[c.key]);
  const damage = sub.entries.filter((e) => e.condition === 'damage').length;
  const wear = sub.entries.filter((e) => e.condition === 'wear').length;
  const warnings = sub.entries.flatMap((e) => captureWarnings(e.photo).filter((w) => !w.startsWith('Demo photo')).map((w) => w));
  const locked = isLocked(insp, ctx.now());

  main.innerHTML = String(html`
    <div class="capture">
      <div class="eyebrow">${kindLabel(insp.kind)} · Unit ${unit.label}</div>
      <h1>Review and submit</h1>
      <dl class="plate">
        <div><dt>Photos taken</dt><dd>${cov.done} of ${cov.total}</dd></div>
        <div><dt>Marked damage</dt><dd>${damage}</dd></div>
        <div><dt>Marked normal wear</dt><dd>${wear}</dd></div>
        <div><dt>Window closes</dt><dd>${fmtDateTime(insp.lockAt)}</dd></div>
      </dl>
      ${byRoommate.length ? callout('note', 'Covered by roommates', html`<p>${plural(byRoommate.length, 'item')} you skipped ${byRoommate.length === 1 ? 'was' : 'were'} already shot by a roommate.</p>`) : ''}
      ${missingMine.length ? callout('caution', `${plural(missingMine.length, 'item')} not shot`, html`
        <p>Nobody has a photo of these yet. Anything without a photo can't be compared later.</p>
        <ul>${missingMine.slice(0, 8).map((c) => html`<li><a href="#/capture/${sub.id}?i=${checklistFor(unit.template, sub.bedroom).indexOf(c)}">${c.area.label}: ${c.item.label}</a></li>`)}${missingMine.length > 8 ? html`<li>and ${missingMine.length - 8} more</li>` : ''}</ul>`) : ''}
      ${warnings.length ? callout('caution', 'Capture checks', html`<ul>${[...new Set(warnings)].map((w) => html`<li>${w}</li>`)}</ul><p class="small">These are shown to the reviewer next to the photos.</p>`) : ''}
      ${callout('warning', 'Sealing is final', html`<p>Submitting chains every photo fingerprint together and seals the record. After that nothing in it can change, by you or by the office. You keep a copy.</p>`)}
      <div class="row">
        <a class="btn ghost" href="#/capture/${sub.id}">Back to photos</a>
        <span class="spacer"></span>
        <button class="btn primary big" id="seal" ${!cov.done || locked ? 'disabled' : ''}>Seal and submit</button>
      </div>
      ${locked ? html`<p class="small muted">The window has closed, so this draft can no longer be sealed.</p>` : ''}
    </div>
  `);
  $('#seal').addEventListener('click', async (e) => {
    e.target.disabled = true;
    if (isLocked(insp, ctx.now())) { toast('The window has closed.', 'bad'); return; }
    s.submissions[sid] = await sealSubmission(sub, new Date(ctx.now()).toISOString());
    await ctx.save();
    toast('Sealed. Your record is locked.');
    ctx.go(`#/receipt/${sid}`);
  });
}

// ---------------------------------------------------------------- receipt

export function receipt(main, { sid }, ctx) {
  const s = ctx.state;
  const sub = s.submissions[sid];
  if (!sub) return notFound(main, 'record');
  if (!sub.seal) { ctx.go(`#/capture/${sid}`); return; }
  const insp = s.inspections[sub.inspectionId];
  const unit = s.units[sub.unitId];
  const prop = s.properties[unit.propertyId];
  const items = new Map(checklistFor(unit.template, null).map((c) => [c.key, c]));

  main.innerHTML = String(html`
    <div class="capture">
      <div class="band">
        <div class="eyebrow" style="color: var(--yellow)">Sealed ${kindLabel(insp.kind).toLowerCase()} record</div>
        <h1 style="margin-bottom: 4px">Unit ${unit.label}</h1>
        <p class="muted" style="margin: 0">${prop.name} · ${sub.residentName}${sub.bedroom ? ` · Bedroom ${sub.bedroom}` : ''}</p>
      </div>
      <dl class="plate" style="margin-top: 16px">
        <div><dt>Submitted</dt><dd>${fmtDateTime(sub.submittedAt)}</dd></div>
        <div><dt>Photos</dt><dd>${sub.entries.length}</dd></div>
        <div><dt>Seal</dt><dd class="mono">${shortHash(sub.seal)}</dd></div>
      </dl>
      <p class="hashline" style="margin-top: 8px" title="Full seal">${sub.seal}</p>
      <p>Send this record to your leasing office. It's a single file with your photos inside; they check the seal when they open it. Keep a copy for yourself too.</p>
      <div class="row">
        <button class="btn primary" id="send">Send to leasing office</button>
        <button class="btn ghost" id="verify">Check the seal</button>
        <a class="btn ghost" href="#/report/${insp.id}">Full report</a>
      </div>
      <div id="verify-out" aria-live="polite"></div>
      <h2>Your photos</h2>
      <div class="thumbs">${sub.entries.map((e) => {
        const c = items.get(e.key);
        return html`<figure class="thumb" style="margin: 0"><img data-photo="${e.photo.hash}" alt="${c ? `${c.area.label}: ${c.item.label}` : e.key}" loading="lazy">
          <div><b>${c ? `${c.area.label}: ${c.item.label}` : e.key}</b><br><span class="chip ${e.condition}">${CONDITION_LABEL[e.condition]}</span>
          <div class="mono">${shortHash(e.photo.hash)} · ${fmtDateTime(e.photo.capturedAt)}</div></div></figure>`;
      })}</div>
    </div>
  `);
  hydratePhotos(main);
  $('#send').addEventListener('click', async () => {
    try {
      const { blob, filename } = await exportSubmission(s, sid);
      const how = await shareOrDownload(blob, filename, `Walkthru record, unit ${unit.label}`);
      if (how === 'downloaded') toast('Record file downloaded. Email it to your leasing office.');
      if (how === 'shared') toast('Record shared.');
    } catch (err) { toast(err.message, 'bad'); }
  });
  $('#verify').addEventListener('click', async () => {
    const out = $('#verify-out');
    out.innerHTML = '<p class="muted">Checking…</p>';
    const res = await verifySubmission(s.submissions[sid], getPhotoBytes);
    out.innerHTML = String(res.ok
      ? callout('tip', 'Verified', html`<p>All ${sub.entries.length} photos match their fingerprints, and the chain and seal are intact.</p>`)
      : callout('warning', 'Does not verify', html`<ul>${res.problems.map((p) => html`<li>${p}</li>`)}</ul>`));
  });
}

