// Verify: check a record file, match a photo to its fingerprint, check everything stored here, and
// a tamper demo that edits one pixel of a sealed photo to show verification catching it.

import { html, $, toast, fmtDateTime, plural, dropPhotoURL } from '../ui.js';
import { sha256Hex, shortHash } from '../core/integrity.js';
import { checklist } from '../core/templates.js';
import { getPhoto, putPhoto } from '../store.js';
import { checkRecordFile, importRecord, verifyAll } from '../records.js';
import { canvasToBlob, decode, clearDiffCache } from '../imaging.js';
import { callout, kindLabel } from './common.js';

// The original bytes of a photo the tamper demo changed, so it can be put back.
let tampered = null;

function itemLabel(state, unitId, key) {
  const u = state.units[unitId];
  const c = u && checklist(u.template).find((x) => x.key === key);
  return c ? `${c.area.label}: ${c.item.label}` : key;
}

export function render(main, params, ctx) {
  const s = ctx.state;
  const demoSub = s.submissions.s_i_demo204_out_r_demo_jordan;
  main.innerHTML = String(html`
    <div class="eyebrow">Trust system</div>
    <h1>Verify</h1>
    <p class="lede">Anyone can check a Walkthru record: the photos must match their SHA-256 fingerprints, and the chain and seal must recompute. Nothing here is uploaded anywhere.</p>

    <div class="grid wide">
      <section class="card">
        <h3>Check a record file</h3>
        <p class="muted small">The file a resident sends after sealing.</p>
        <label class="btn dark small" for="rec-file">Choose record file</label>
        <input type="file" id="rec-file" accept="application/json,.json" hidden>
        <div id="rec-out" aria-live="polite"></div>
      </section>
      <section class="card">
        <h3>Match a photo</h3>
        <p class="muted small">Pick an original photo (from a report's Original button). Even a one-pixel edit changes the fingerprint.</p>
        <label class="btn dark small" for="photo-file">Choose photo</label>
        <input type="file" id="photo-file" accept="image/*" hidden>
        <div id="photo-out" aria-live="polite"></div>
      </section>
    </div>

    <h2>Records in this browser</h2>
    <button class="btn ghost" id="check-all">Check all records</button>
    <div id="all-out" aria-live="polite" style="margin-top: 12px"></div>

    ${demoSub ? html`<h2>Tamper demo</h2>
    <p>Edit one pixel of Jordan's sealed move-out photo of the living room wall, save it back the way a photo editor would, then check the records again.</p>
    <div class="row">
      ${tampered ? html`<button class="btn primary" id="untamper">Put the original back</button>` : html`<button class="btn danger" id="tamper">Change one pixel</button>`}
    </div>
    ${tampered ? callout('caution', 'Photo changed', html`<p>One stored photo is altered right now. Put it back when you're done, or reload the demo property.</p>`) : ''}` : ''}
  `);

  $('#rec-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const out = $('#rec-out');
    out.innerHTML = '<p class="muted">Checking…</p>';
    const res = await checkRecordFile(file);
    if (!res.record) { out.innerHTML = String(callout('warning', 'Not a valid record', html`<p>${res.error}</p>`)); return; }
    const r = res.record;
    const summary = html`<p class="small">${r.submission.residentName}, ${kindLabel(r.inspection.kind).toLowerCase()} of unit ${r.unit.label} at ${r.property.name}. ${plural(r.submission.entries.length, 'photo')}, sealed ${fmtDateTime(r.submission.submittedAt)}. Seal <span class="mono">${shortHash(r.submission.seal)}</span>.</p>`;
    out.innerHTML = String(res.ok
      ? callout('tip', 'Verified', html`${summary}<button class="btn primary small" id="do-import">Import into the office</button>`)
      : callout('warning', 'Does not verify', html`${summary}<ul class="small">${res.problems.map((p) => html`<li>${p}</li>`)}</ul>`));
    $('#do-import')?.addEventListener('click', async () => {
      const done = await importRecord(s, r);
      if (done.ok) await ctx.save();
      toast(done.message, done.ok ? 'info' : 'bad');
      if (done.ok) ctx.go(`#/office/u/${r.unit.id}`);
    });
  });

  $('#photo-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const hash = await sha256Hex(new Uint8Array(await file.arrayBuffer()));
    const hits = [];
    for (const sub of Object.values(s.submissions)) {
      for (const en of sub.entries) if (en.photo.hash === hash) hits.push({ sub, en });
    }
    const out = $('#photo-out');
    out.innerHTML = String(hits.length
      ? callout('tip', 'Match', html`<p class="small">Fingerprint <span class="mono">${shortHash(hash)}</span> matches ${hits.map(({ sub, en }) => html`<b>${itemLabel(s, sub.unitId, en.key)}</b> in unit ${s.units[sub.unitId]?.label}'s ${sub.kind}, taken ${fmtDateTime(en.photo.capturedAt)} by ${sub.residentName}${sub.seal ? '' : ' (not sealed yet)'}`)}.</p>`)
      : callout('caution', 'No match', html`<p class="small">No record here has a photo with fingerprint <span class="mono">${shortHash(hash)}</span>. Either it was never recorded, or it was edited or re-saved after capture.</p>`));
  });

  $('#check-all').addEventListener('click', async () => {
    const out = $('#all-out');
    out.innerHTML = '<p class="muted">Checking every photo…</p>';
    const results = await verifyAll(s);
    if (!results.length) { out.innerHTML = '<p class="muted">No sealed records in this browser.</p>'; return; }
    const bad = results.filter((x) => !x.result.ok).length;
    out.innerHTML = String(html`
      <p><b>${bad ? `${plural(bad, 'record')} failed` : 'Every record verified'}</b> · ${plural(results.length, 'sealed record')} checked.</p>
      <div class="table-box"><table>
        <thead><tr><th>Record</th><th>Seal</th><th>Result</th></tr></thead>
        <tbody>${results.map(({ sub, result }) => html`<tr>
          <td>Unit ${s.units[sub.unitId]?.label || '?'} ${sub.kind}, ${sub.residentName}<br><span class="small muted">${plural(sub.entries.length, 'photo')} · ${fmtDateTime(sub.submittedAt)}</span></td>
          <td class="mono">${shortHash(sub.seal)}</td>
          <td>${result.ok ? html`<span class="chip verified">Verified</span>` : html`<span class="chip bad">Failed</span><ul class="small">${result.problems.map((p) => html`<li>${p}</li>`)}</ul>`}</td>
        </tr>`)}</tbody>
      </table></div>`);
  });

  $('#tamper')?.addEventListener('click', async () => {
    const entry = demoSub.entries.find((x) => x.key === 'living.walls') || demoSub.entries[0];
    const hash = entry.photo.hash;
    const rec = await getPhoto(hash);
    if (!rec) { toast('That demo photo is missing. Reload the demo property.', 'bad'); return; }
    const img = await decode(rec.blob);
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const px = g.getImageData(40, 40, 1, 1);
    px.data[0] = px.data[0] > 127 ? px.data[0] - 60 : px.data[0] + 60;
    g.putImageData(px, 40, 40);
    tampered = { hash, record: rec };
    await putPhoto(hash, { type: rec.type, blob: await canvasToBlob(c) });
    dropPhotoURL(hash);
    clearDiffCache();
    toast('One pixel changed and saved over the original.');
    ctx.rerender();
    setTimeout(() => $('#check-all')?.click(), 50);
  });

  $('#untamper')?.addEventListener('click', async () => {
    await putPhoto(tampered.hash, tampered.record);
    dropPhotoURL(tampered.hash);
    clearDiffCache();
    tampered = null;
    toast('Original photo restored.');
    ctx.rerender();
    setTimeout(() => $('#check-all')?.click(), 50);
  });
}
