// Office screens: properties, a property's units, one unit, the rate sheet and door signs.

import { html, raw, $, $$, toast, fmtDate, fmtDateTime, plural, confirmBox, countdown, localDay } from '../ui.js';
import { TEMPLATES, bedroomsOf } from '../core/templates.js';
import { DEFAULT_RATES, cleanRates } from '../core/rates.js';
import { money, parseMoney } from '../core/charges.js';
import { shortHash } from '../core/integrity.js';
import { encodeDoor } from '../core/payload.js';
import { refundStatus } from '../core/texas.js';
import {
  addProperty, addUnit, unitsOf, upsertResident, inspectionsOf, inspectionStatus, submissionsOf, openInspection,
  openInspectionFor, isLocked, baselineOf, newId,
} from '../core/model.js';
import { clearAll } from '../store.js';
import { DEMO_PROPERTY_ID, removeDemo } from '../demo.js';
import { checkRecordFile, importRecord } from '../records.js';
import { qrSvg } from '../qr.js';
import { notFound, statusChip, latestOf, kindLabel, crumbs, callout } from './common.js';

const appBase = () => `${location.origin}${location.pathname}`;

// ---------------------------------------------------------------- dashboard

export function dashboard(main, params, ctx) {
  const props = Object.values(ctx.state.properties).sort((a, b) => a.name.localeCompare(b.name));
  main.innerHTML = String(html`
    <div class="eyebrow">Office</div>
    <h1>Properties</h1>
    ${props.length ? html`<div class="grid">${props.map((p) => {
      const units = unitsOf(ctx.state, p.id);
      const ready = units.filter((u) => latestOf(ctx.state, u, ctx.now())?.status === 'ready').length;
      return html`<a class="card-link" href="#/office/p/${p.id}"><div class="card">
        <h3>${p.name}</h3>
        <p class="muted">${p.city}${p.city ? ', ' : ''}${p.state} · ${plural(units.length, 'unit')}</p>
        ${ready ? html`<span class="chip ready">${plural(ready, 'unit')} to review</span>` : html`<span class="chip">Nothing to review</span>`}
      </div></a>`;
    })}</div>` : callout('note', 'No properties yet', html`<p>Load the demo property to see a finished move-in and move-out, or add your own below.</p>`)}

    <div class="row" style="margin-top: 16px">
      <a class="btn primary" href="#/demo">${ctx.state.properties[DEMO_PROPERTY_ID] ? 'Reset the demo property' : 'Load the demo property'}</a>
    </div>

    <h2>Add a property</h2>
    <form id="add-prop" class="card" style="max-width: 560px">
      <label class="field"><span>Name</span><input type="text" name="name" required maxlength="80" placeholder="e.g. The Quad at Campbell"></label>
      <label class="field"><span>City</span><input type="text" name="city" maxlength="60" placeholder="e.g. Richardson"></label>
      <p class="small muted">State: Texas. The prototype only knows Texas deposit rules.</p>
      <button class="btn dark">Add property</button>
    </form>

    <h2>This browser</h2>
    <p class="muted">Walkthru keeps everything here, on this device. Erasing removes every property, record and photo.</p>
    <button class="btn danger" id="erase">Erase all Walkthru data</button>
  `);

  $('#add-prop').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const name = String(f.get('name') || '').trim();
    if (!name) return;
    const p = addProperty(ctx.state, { name, city: String(f.get('city') || '').trim() });
    await ctx.save();
    ctx.go(`#/office/p/${p.id}`);
  });
  $('#erase').addEventListener('click', async () => {
    if (!(await confirmBox('Erase every property, record and photo stored by Walkthru in this browser? This cannot be undone.', 'Erase'))) return;
    await clearAll();
    for (const k of ['properties', 'units', 'inspections', 'submissions']) ctx.state[k] = {};
    await ctx.save();
    toast('All Walkthru data erased.');
    ctx.rerender();
  });
}

// ---------------------------------------------------------------- one property

export function property(main, { pid }, ctx) {
  const p = ctx.state.properties[pid];
  if (!p) return notFound(main, 'property');
  const now = ctx.now();
  const units = unitsOf(ctx.state, pid);
  const latest = units.map((u) => ({ u, l: latestOf(ctx.state, u, now) }));
  const ready = latest.filter((x) => x.l?.status === 'ready').length;
  const collecting = latest.filter((x) => x.l?.status === 'collecting').length;
  const dueSoon = latest.filter((x) => {
    const i = x.l?.insp;
    if (!i || i.kind !== 'move-out' || i.review.finalizedAt || !i.surrenderDate) return false;
    return refundStatus(i.surrenderDate, localDay(now), true).daysLeft <= 14;
  }).length;

  main.innerHTML = String(html`
    ${crumbs([['Office', '#/office']])}
    <div class="band">
      <div class="eyebrow" style="color: var(--yellow)">Property</div>
      <h1>${p.name}</h1>
      <p class="muted" style="margin: 0">${p.city}${p.city ? ', ' : ''}${p.state}${p.demo ? ' · demo data' : ''}</p>
    </div>

    <div class="grid" style="margin-top: 16px">
      <div class="stat"><b>${units.length}</b><span>units</span></div>
      <div class="stat"><b>${ready}</b><span>ready to review</span></div>
      <div class="stat"><b>${collecting}</b><span>walkthroughs open</span></div>
      <div class="stat ${dueSoon ? 'alert' : ''}"><b>${dueSoon}</b><span>deposit deadlines in 14 days</span></div>
    </div>

    <div class="row between" style="margin-top: 24px">
      <h2 style="margin: 0">Units</h2>
      <a class="btn ghost small" href="#/office/rates/${p.id}">Rate sheet</a>
    </div>
    <div class="card" style="padding: 0; margin-top: 12px">
      ${units.length ? latest.map(({ u, l }) => html`
        <div class="unit-row">
          <div class="unit-no">${u.label}</div>
          <div>
            <div><b>${TEMPLATES[u.template].label}</b></div>
            <div class="muted small">${u.residents.length ? u.residents.map((r) => r.name).join(', ') : 'No residents yet'}</div>
            ${l ? html`<div class="row small" style="margin-top: 4px">${statusChip(l.status)}<span class="muted">${kindLabel(l.insp.kind)} opened ${fmtDate(l.insp.openedAt)}</span></div>` : ''}
          </div>
          <div class="row end">
            ${l?.status === 'ready' && l.insp.kind === 'move-out' ? html`<a class="btn primary small" href="#/office/review/${l.insp.id}">Review</a>` : ''}
            <a class="btn ghost small" href="#/office/u/${u.id}">Open</a>
          </div>
        </div>`) : html`<p class="muted" style="padding: 16px; margin: 0">No units yet. Add one below.</p>`}
    </div>

    <h2>Add a unit</h2>
    <form id="add-unit" class="card" style="max-width: 560px">
      <label class="field"><span>Unit number</span><input type="text" name="label" required maxlength="20" placeholder="e.g. 204"></label>
      <label class="field"><span>Layout</span>
        <select name="template">${Object.values(TEMPLATES).map((t) => html`<option value="${t.id}">${t.label}</option>`)}</select>
      </label>
      <button class="btn dark">Add unit</button>
    </form>
    ${p.demo ? html`<p style="margin-top: 24px"><button class="btn danger small" id="remove-demo">Remove the demo property</button></p>` : ''}
  `);

  $('#add-unit').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const label = String(f.get('label') || '').trim();
    if (!label) return;
    if (units.some((u) => u.label.toLowerCase() === label.toLowerCase())) { toast(`Unit ${label} already exists.`, 'bad'); return; }
    const u = addUnit(ctx.state, { propertyId: pid, label, template: String(f.get('template')) });
    await ctx.save();
    ctx.go(`#/office/u/${u.id}`);
  });
  $('#remove-demo')?.addEventListener('click', async () => {
    if (!(await confirmBox('Remove the demo property and its records from this browser?', 'Remove'))) return;
    removeDemo(ctx.state);
    await ctx.save();
    ctx.go('#/office');
  });
}

// ---------------------------------------------------------------- one unit

export function unit(main, { uid }, ctx) {
  const u = ctx.state.units[uid];
  if (!u) return notFound(main, 'unit');
  const p = ctx.state.properties[u.propertyId];
  const now = ctx.now();
  const list = inspectionsOf(ctx.state, uid).reverse();
  const bedrooms = bedroomsOf(u.template);

  main.innerHTML = String(html`
    ${crumbs([['Office', '#/office'], [p.name, `#/office/p/${p.id}`]])}
    <div class="row between">
      <div>
        <div class="eyebrow">${TEMPLATES[u.template].label}</div>
        <h1>Unit ${u.label}</h1>
      </div>
      <div class="row">
        <a class="btn ghost" href="#/office/qr/${u.id}">Door QR sign</a>
        <label class="btn ghost" for="import-file">Import record</label>
        <input type="file" id="import-file" accept="application/json,.json" hidden>
      </div>
    </div>

    <div class="grid wide">
      <section class="card">
        <h3>Residents and deposits</h3>
        ${u.residents.length ? html`<div class="table-box"><table>
          <thead><tr><th>Name</th><th>Bedroom</th><th class="num">Deposit</th></tr></thead>
          <tbody>${u.residents.map((r) => html`<tr>
            <td>${r.name}</td><td>${r.bedroom || '—'}</td>
            <td class="num"><label class="sr-only" for="dep-${r.id}">Deposit for ${r.name}</label>
              <input type="text" inputmode="decimal" id="dep-${r.id}" data-deposit="${r.id}" value="${(r.depositCents / 100).toFixed(2)}" style="max-width: 120px; text-align: right"></td>
          </tr>`)}</tbody></table></div>` : html`<p class="muted">Residents are added when they start a walkthrough, or here.</p>`}
        <form id="add-res" class="row" style="margin-top: 12px; align-items: flex-end">
          <label class="field" style="flex: 2 1 160px; margin: 0"><span>Name</span><input type="text" name="name" required maxlength="60"></label>
          ${bedrooms.length ? html`<label class="field" style="flex: 1 1 90px; margin: 0"><span>Bedroom</span><select name="bedroom">${bedrooms.map((b) => html`<option>${b}</option>`)}</select></label>` : ''}
          <label class="field" style="flex: 1 1 100px; margin: 0"><span>Deposit</span><input type="text" name="deposit" inputmode="decimal" placeholder="500"></label>
          <button class="btn dark small">Add</button>
        </form>
      </section>

      <section class="card">
        <h3>Open a walkthrough</h3>
        <p class="muted">Opening one gives residents a 48-hour window and a link or QR code that puts every roommate on the same record. The door sign also works on its own.</p>
        <div class="row">
          <button class="btn dark small" data-open="move-in">Open move-in</button>
          <button class="btn dark small" data-open="move-out">Open move-out</button>
        </div>
        <p class="small muted" style="margin-top: 12px">Testing on this device? <a href="#/start/${u.id}">Open the resident view</a>.</p>
      </section>
    </div>

    <h2>Inspection history</h2>
    ${list.length ? html`<ol class="timeline">${list.map((i) => {
      const status = inspectionStatus(ctx.state, i, now);
      const subs = submissionsOf(ctx.state, i.id);
      const base = baselineOf(ctx.state, i);
      return html`<li>
        <div class="row"><h3 style="margin: 0">${kindLabel(i.kind)}</h3>${statusChip(status)}</div>
        <p class="muted small">Opened ${fmtDateTime(i.openedAt)} · ${isLocked(i, now) ? `locked ${fmtDateTime(i.lockAt)}` : `locks in ${countdown(i.lockAt, now)}`}${base ? ` · compared with the ${kindLabel(base.kind).toLowerCase()} of ${fmtDate(base.openedAt)}` : ' · first record, nothing to compare with'}</p>
        ${subs.length ? html`<ul class="small">${subs.map((s) => html`<li>${s.residentName}${s.bedroom ? ` (Bedroom ${s.bedroom})` : ''}: ${plural(s.entries.length, 'photo')}, ${s.seal ? html`sealed <span class="mono">${shortHash(s.seal)}</span>` : 'not submitted yet'}</li>`)}</ul>` : html`<p class="small muted">No submissions yet.</p>`}
        <div class="row">
          ${status !== 'collecting' && status !== 'locked' && base ? html`<a class="btn ${status === 'ready' ? 'primary' : 'ghost'} small" href="#/office/review/${i.id}">Review changes</a>` : ''}
          ${i.kind === 'move-out' && subs.some((s) => s.seal) ? html`<a class="btn ghost small" href="#/office/settle/${i.id}">Settlement</a>` : ''}
          ${subs.some((s) => s.seal) ? html`<a class="btn ghost small" href="#/report/${i.id}">Condition report</a>` : ''}
          ${!isLocked(i, now) && !i.review.finalizedAt ? html`<a class="btn ghost small" href="#/office/qr/${u.id}?i=${i.id}">Invite QR</a>` : ''}
        </div>
      </li>`;
    })}</ol>` : html`<p class="muted">No inspections yet.</p>`}
  `);

  for (const input of $$('[data-deposit]', main)) {
    input.addEventListener('change', async () => {
      const cents = parseMoney(input.value);
      const r = u.residents.find((x) => x.id === input.dataset.deposit);
      if (cents == null) { toast('Enter an amount like 500 or 450.00', 'bad'); input.value = (r.depositCents / 100).toFixed(2); return; }
      r.depositCents = cents;
      input.value = (cents / 100).toFixed(2);
      await ctx.save();
      toast(`Deposit for ${r.name} saved.`);
    });
  }
  $('#add-res').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const name = String(f.get('name') || '').trim();
    if (!name) return;
    const cents = parseMoney(f.get('deposit') || '0');
    upsertResident(u, { name, bedroom: f.get('bedroom') || null, depositCents: cents ?? 0 });
    await ctx.save();
    ctx.rerender();
  });
  for (const b of $$('[data-open]', main)) {
    b.addEventListener('click', async () => {
      const kind = b.dataset.open;
      const existing = openInspectionFor(ctx.state, uid, kind, ctx.now());
      const i = existing || openInspection(ctx.state, { unitId: uid, kind, now: ctx.now() });
      await ctx.save();
      if (existing) toast(`A ${kind} walkthrough is already open.`);
      ctx.go(`#/office/qr/${uid}?i=${i.id}`);
    });
  }
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const checked = await checkRecordFile(file);
    if (!checked.ok) {
      toast(checked.error, 'bad');
      if (checked.problems?.length) console.warn('Record problems:', checked.problems);
      return;
    }
    if (checked.record.unit.id !== uid && !(await confirmBox(`This record is for unit ${checked.record.unit.label} at ${checked.record.property.name}, not this unit. Import it there?`, 'Import'))) return;
    const res = await importRecord(ctx.state, checked.record);
    if (res.ok) await ctx.save();
    toast(res.message, res.ok ? 'info' : 'bad');
    if (res.ok) ctx.go(`#/office/u/${checked.record.unit.id}`);
  });
}

// ---------------------------------------------------------------- rate sheet

export function rates(main, { pid }, ctx) {
  const p = ctx.state.properties[pid];
  if (!p) return notFound(main, 'property');
  const draw = () => {
    main.innerHTML = String(html`
      ${crumbs([['Office', '#/office'], [p.name, `#/office/p/${p.id}`]])}
      <h1>Rate sheet</h1>
      <p class="lede">The prices the auto-draft uses for charges. These sample prices are placeholders: replace them with your property's own sheet.</p>
      <form id="rates">
        <div class="table-box"><table>
          <thead><tr><th>Charge</th><th class="num">Price</th><th><span class="sr-only">Remove</span></th></tr></thead>
          <tbody>${p.rates.map((r, i) => html`<tr>
            <td><label class="sr-only" for="rl-${i}">Charge name</label><input type="text" id="rl-${i}" name="label-${i}" value="${r.label}" maxlength="80" required></td>
            <td class="num"><label class="sr-only" for="rc-${i}">Price for ${r.label}</label><input type="text" inputmode="decimal" id="rc-${i}" name="cents-${i}" value="${(r.cents / 100).toFixed(2)}" style="max-width: 120px; text-align: right"></td>
            <td><button type="button" class="btn ghost small" data-del="${i}" aria-label="Remove ${r.label}">Remove</button></td>
          </tr>`)}</tbody>
        </table></div>
        <div class="row" style="margin-top: 12px">
          <button type="button" class="btn ghost small" id="add-rate">Add a charge</button>
          <span class="spacer"></span>
          <button type="button" class="btn ghost small" id="reset-rates">Reset to sample prices</button>
          <button class="btn primary">Save rate sheet</button>
        </div>
      </form>
      <p class="small muted">Checklist items point at charges by their built-in id, so renaming a charge keeps it linked. Removing one means the draft won't suggest it.</p>
    `);
    const read = () => p.rates.map((r, i) => ({ id: r.id, label: $(`#rl-${i}`).value, cents: parseMoney($(`#rc-${i}`).value) ?? r.cents }));
    $('#add-rate').addEventListener('click', () => { p.rates = [...read(), { id: newId('rate'), label: 'New charge', cents: 0 }]; draw(); });
    for (const b of $$('[data-del]', main)) b.addEventListener('click', () => { const rows = read(); rows.splice(Number(b.dataset.del), 1); p.rates = rows; draw(); });
    $('#reset-rates').addEventListener('click', async () => {
      if (!(await confirmBox('Replace this rate sheet with the sample prices?', 'Reset'))) return;
      p.rates = DEFAULT_RATES.map((r) => ({ ...r }));
      await ctx.save();
      draw();
    });
    $('#rates').addEventListener('submit', async (e) => {
      e.preventDefault();
      p.rates = cleanRates(read());
      await ctx.save();
      toast('Rate sheet saved.');
      draw();
    });
  };
  draw();
}

// ---------------------------------------------------------------- door sign

export function doorSign(main, { uid, query }, ctx) {
  const u = ctx.state.units[uid];
  if (!u) return notFound(main, 'unit');
  const p = ctx.state.properties[u.propertyId];
  const insp = query.get('i') ? ctx.state.inspections[query.get('i')] : null;
  const live = insp && insp.unitId === uid && !isLocked(insp, ctx.now()) ? insp : null;
  const url = `${appBase()}#/door/${encodeDoor({ property: p, unit: u, inspection: live })}`;
  main.innerHTML = String(html`
    <div class="no-print">
      ${crumbs([['Office', '#/office'], [p.name, `#/office/p/${p.id}`], [`Unit ${u.label}`, `#/office/u/${u.id}`]])}
      <h1>${live ? `${kindLabel(live.kind)} invite` : 'Door QR sign'}</h1>
      <p class="lede">${live
        ? `Share this with every resident of unit ${u.label}. It joins them to the same ${live.kind} record, open until ${fmtDateTime(live.lockAt)}.`
        : 'Print this and put it on the inside of the door. Residents scan it to start a move-in or move-out walkthrough.'}</p>
    </div>
    <div class="door-sign">
      <div class="stripe"></div>
      <div class="inner">
        <h2>${live ? `${kindLabel(live.kind)} walkthrough` : 'Move-in · Move-out'}</h2>
        <div class="unit">${u.label}</div>
        <div class="muted" style="color: #4A5568">${p.name}</div>
        ${raw(qrSvg(url, { label: `QR code for unit ${u.label}` }))}
        <p><b>Scan with your phone camera.</b> No app, no login.</p>
        ${live ? html`<p class="small" style="margin-top: 6px">Open until ${fmtDateTime(live.lockAt)}</p>` : ''}
      </div>
      <div class="stripe"></div>
    </div>
    <div class="row no-print" style="justify-content: center; margin-top: 16px">
      <button class="btn primary" id="print">Print</button>
      <button class="btn ghost" id="copy">Copy link</button>
      <a class="btn ghost" href="${url}">Open link here</a>
    </div>
    <p class="small muted no-print hashline" style="margin-top: 12px">${url}</p>
  `);
  $('#print').addEventListener('click', () => window.print());
  $('#copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(url); toast('Link copied.'); } catch { toast('Copy failed. Select the link below instead.', 'bad'); }
  });
}
