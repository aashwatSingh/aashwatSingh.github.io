// The condition report: every sealed photo of an inspection, room by room, with fingerprints,
// times and capture checks. Read-only and printable; the "Condition Baseline Report" of the roadmap.

import { html, $, $$, fmtDateTime, CONDITION_LABEL, hydratePhotos, download, slug, toast } from '../ui.js';
import { checklist } from '../core/templates.js';
import { evidenceOf, sealedOf } from '../core/model.js';
import { shortHash } from '../core/integrity.js';
import { getPhoto } from '../store.js';
import { captureWarnings } from '../camera.js';
import { notFound, kindLabel, callout } from './common.js';

export function render(main, { iid }, ctx) {
  const s = ctx.state;
  const insp = s.inspections[iid];
  if (!insp) return notFound(main, 'inspection');
  const unit = s.units[insp.unitId];
  const prop = s.properties[unit.propertyId];
  const subs = sealedOf(s, iid);
  const ev = evidenceOf(s, iid);
  const areas = [];
  for (const c of checklist(unit.template)) {
    let a = areas.find((x) => x.area.id === c.area.id);
    if (!a) areas.push((a = { area: c.area, items: [] }));
    a.items.push({ ...c, shots: ev[c.key] || [] });
  }

  main.innerHTML = String(html`
    <div class="row between no-print">
      <a href="#/office/u/${unit.id}" class="small">← Unit ${unit.label}</a>
      <button class="btn ghost small" id="print">Print report</button>
    </div>
    <div class="eyebrow">${prop.name} · ${prop.city}${prop.city ? ', ' : ''}${prop.state}</div>
    <h1>Unit ${unit.label} ${kindLabel(insp.kind).toLowerCase()} condition report</h1>
    ${subs.length ? '' : callout('note', 'No sealed records', html`<p>Nothing has been sealed for this walkthrough yet.</p>`)}
    <h2>Sealed submissions</h2>
    <div class="table-box"><table>
      <thead><tr><th>Resident</th><th>Submitted</th><th class="num">Photos</th><th>Seal</th></tr></thead>
      <tbody>${subs.map((x) => html`<tr><td>${x.residentName}${x.bedroom ? ` (Bedroom ${x.bedroom})` : ''}</td><td>${fmtDateTime(x.submittedAt)}</td><td class="num">${x.entries.length}</td><td class="mono" title="${x.seal}">${shortHash(x.seal)}</td></tr>`)}</tbody>
    </table></div>
    <p class="small muted">Check any record on the <a href="#/verify">Verify</a> page. Download an original photo below and drop it there to match it to its fingerprint.</p>
    ${areas.map((a) => html`<section>
      <h2>${a.area.label}</h2>
      <div class="thumbs">${a.items.map((c) => c.shots.length ? c.shots.map(({ entry: e, submission: sub }) => html`
        <figure class="thumb" style="margin: 0">
          <img data-photo="${e.photo.hash}" alt="${a.area.label}: ${c.item.label}" loading="lazy">
          <div>
            <b>${c.item.label}</b> <span class="chip ${e.condition}">${CONDITION_LABEL[e.condition]}</span>
            ${e.note ? html`<p style="margin: 4px 0">“${e.note}”</p>` : ''}
            <div class="mono">${shortHash(e.photo.hash)} · ${fmtDateTime(e.photo.capturedAt)}</div>
            <div class="small muted">${sub.residentName}</div>
            ${captureWarnings(e.photo).map((w) => html`<div class="small muted">${w}</div>`)}
            <button class="btn ghost small no-print" style="margin-top: 6px" data-original="${e.photo.hash}" data-name="${slug(`${unit.label} ${a.area.label} ${c.item.label}`)}">Original</button>
          </div>
        </figure>`) : html`<div class="thumb"><div class="photo-missing">No photo</div><div><b>${c.item.label}</b></div></div>`)}</div>
    </section>`)}
  `);
  hydratePhotos(main);
  $('#print').addEventListener('click', () => window.print());
  for (const b of $$('[data-original]', main)) {
    b.addEventListener('click', async () => {
      const rec = await getPhoto(b.dataset.original);
      if (!rec) { toast('That photo is not in this browser.', 'bad'); return; }
      download(rec.blob, `${b.dataset.name}.${rec.type === 'image/png' ? 'png' : 'jpg'}`);
    });
  }
}
