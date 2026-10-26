// Clipboard mode: staff see only what changed since the baseline, with a before/after slider,
// the spots the comparison flagged, and a drafted line for each. Every charge needs a person.

import { html, $, $$, toast, fmtDateTime, plural, CONDITION_LABEL, hydratePhotos } from '../ui.js';
import { comparisonRows, baselineOf, sealedOf } from '../core/model.js';
import { draftItem } from '../core/draft.js';
import { money, parseMoney, defaultResponsible } from '../core/charges.js';
import { rateById } from '../core/rates.js';
import { diffPhotos } from '../imaging.js';
import { captureWarnings } from '../camera.js';
import { notFound, kindLabel, crumbs, callout } from './common.js';

const ACTION_LABEL = { charge: 'Charge', wear: 'Normal wear, no charge', dismiss: 'No change, dismissed' };

/** Compute drafts for every row. Exported for the settlement screen and tests in the browser. */
export async function draftsFor(state, insp, onProgress = () => {}) {
  const rows = comparisonRows(state, insp);
  const rates = state.properties[state.units[insp.unitId].propertyId].rates;
  let done = 0;
  for (const r of rows) {
    r.diff = r.before && r.after ? await diffPhotos(r.before.entry.photo.hash, r.after.entry.photo.hash) : null;
    r.draft = draftItem({ item: r.item, before: r.before?.entry, after: r.after?.entry, diff: r.diff, rates });
    onProgress(++done, rows.length);
  }
  return rows;
}

export async function render(main, { iid, query }, ctx) {
  const s = ctx.state;
  const insp = s.inspections[iid];
  if (!insp) return notFound(main, 'inspection');
  const unit = s.units[insp.unitId];
  const prop = s.properties[unit.propertyId];
  const base = baselineOf(s, insp);
  const head = html`
    ${crumbs([['Office', '#/office'], [prop.name, `#/office/p/${prop.id}`], [`Unit ${unit.label}`, `#/office/u/${unit.id}`]])}
    <div class="eyebrow">Clipboard mode · ${kindLabel(insp.kind)}</div>
    <h1>Unit ${unit.label}: what changed</h1>`;

  if (!sealedOf(s, iid).length) {
    main.innerHTML = String(html`${head}${callout('note', 'Nothing to review yet', html`<p>No resident has sealed a record for this walkthrough.</p>`)}`);
    return;
  }
  if (!base) {
    main.innerHTML = String(html`${head}${callout('note', 'No baseline', html`<p>This is the unit's first record, so there is nothing to compare with. It becomes the baseline for the next walkthrough. <a href="#/report/${iid}">Open the condition report</a>.</p>`)}`);
    return;
  }

  main.innerHTML = String(html`${head}<p class="muted">Comparing photos…</p><div class="progressbar"><i></i></div>`);
  const rows = await draftsFor(s, insp, (d, t) => { const bar = $('.progressbar i', main); if (bar) bar.style.width = `${Math.round((d / t) * 100)}%`; });
  const finalized = Boolean(insp.review.finalizedAt);
  let showAll = query.get('all') === '1';

  const draw = () => {
    const decisions = insp.review.decisions;
    const flagged = rows.filter((r) => r.draft.flagged);
    const visible = showAll ? rows : flagged;
    const decided = flagged.filter((r) => decisions[r.key]).length;
    const total = Object.values(decisions).filter((d) => d.action === 'charge').reduce((t, d) => t + d.cents, 0);
    const compared = rows.filter((r) => r.diff).length;
    const missing = rows.filter((r) => !r.after).length;

    main.innerHTML = String(html`
      ${head}
      <p class="lede">Compared with the ${kindLabel(base.kind).toLowerCase()} of ${fmtDateTime(base.openedAt)}. ${plural(compared, 'photo pair')} checked; <b>${plural(flagged.length, 'item')}</b> need a look.</p>
      <div class="grid stats">
        <div class="stat"><b>${flagged.length}</b><span>flagged of ${rows.length} items</span></div>
        <div class="stat"><b>${decided}/${flagged.length}</b><span>decided</span></div>
        <div class="stat"><b>${money(total)}</b><span>approved charges</span></div>
        <div class="stat ${missing ? 'alert' : ''}"><b>${missing}</b><span>items with no new photo</span></div>
      </div>
      ${finalized ? callout('note', 'Finalized', html`<p>This review was finalized ${fmtDateTime(insp.review.finalizedAt)}. Reopen it from the settlement page to change anything.</p>`) : ''}
      <div class="row no-print" style="margin: 18px 0 4px">
        <fieldset class="seg" style="margin: 0">
          <legend class="sr-only">Show</legend>
          <label><input type="radio" name="show" value="changed" ${showAll ? '' : 'checked'}><span>Changes only (${flagged.length})</span></label>
          <label><input type="radio" name="show" value="all" ${showAll ? 'checked' : ''}><span>All items (${rows.length})</span></label>
        </fieldset>
        <span class="spacer"></span>
        ${!finalized && flagged.some((r) => !decisions[r.key]) ? html`<button class="btn ghost" id="accept-all">Accept remaining drafts</button>` : ''}
        <a class="btn primary" href="#/office/settle/${iid}">Settlement</a>
      </div>
      ${visible.length ? visible.map((r) => itemBlock(r, decisions[r.key], unit, prop, finalized)) : callout('tip', 'No changes found', html`<p>Every photo matches its baseline. Nothing to charge.</p>`)}
    `);
    hydratePhotos(main);
    wire();
  };

  function itemBlock(r, d, unitRef, propRef, locked) {
    const after = r.after?.entry;
    const before = r.before?.entry;
    const sugg = r.draft.suggestion;
    const warn = after ? captureWarnings(after.photo).filter((w) => !w.startsWith('Demo photo')) : [];
    return html`<article class="review-item" id="item-${r.key.replace('.', '-')}">
      <div>
        ${before && after ? html`<div class="compare" data-compare>
          <img data-photo="${before.photo.hash}" alt="Before: ${r.item.label}">
          <img class="after" data-photo="${after.photo.hash}" alt="After: ${r.item.label}">
          ${(r.diff?.regions || []).map((g) => html`<div class="box" style="left: ${(g.x * 100).toFixed(1)}%; top: ${(g.y * 100).toFixed(1)}%; width: ${(g.w * 100).toFixed(1)}%; height: ${(g.h * 100).toFixed(1)}%"></div>`)}
          <div class="divider"></div>
          <span class="tag l">Before</span><span class="tag r">After</span>
          <input type="range" min="0" max="100" value="50" aria-label="Slide between before and after photos of ${r.item.label}">
        </div>
        <div class="row small" style="margin-top: 6px">
          <label class="check"><input type="checkbox" data-boxes checked> <span>Show flagged spots</span></label>
          <span class="muted">Before ${fmtDateTime(before.photo.capturedAt)} · After ${fmtDateTime(after.photo.capturedAt)}</span>
        </div>` : html`<div class="photo-missing">${after ? 'No baseline photo for this item.' : 'No new photo for this item.'}</div>`}
      </div>
      <div>
        <div class="eyebrow">${r.area.label}</div>
        <h3>${r.item.label}</h3>
        <div class="row small">
          ${before ? html`<span>Before: <span class="chip ${before.condition}">${CONDITION_LABEL[before.condition]}</span></span>` : ''}
          ${after ? html`<span>After: <span class="chip ${after.condition}">${CONDITION_LABEL[after.condition]}</span></span>` : ''}
          ${r.draft.confidence ? html`<span class="chip ${r.draft.confidence}">${r.draft.confidence} confidence</span>` : ''}
        </div>
        <ul class="why small">${r.draft.why.map((w) => html`<li>${w}</li>`)}${warn.map((w) => html`<li><b>Capture check:</b> ${w}</li>`)}</ul>
        ${r.extra.length ? html`<p class="small muted">${plural(r.extra.length, 'more photo')} from roommates in the condition report.</p>` : ''}
        ${r.draft.flagged || d ? decisionBox(r, d, unitRef, propRef, sugg, locked) : ''}
      </div>
    </article>`;
  }

  function decisionBox(r, d, unitRef, propRef, sugg, locked) {
    const residents = unitRef.residents;
    if (d) {
      return html`<div class="decision ${d.action === 'charge' ? 'charged' : d.action === 'wear' ? 'wear' : 'dismissed'}">
        <b>${ACTION_LABEL[d.action]}${d.action === 'charge' ? html`: ${d.label}, ${money(d.cents)}` : ''}</b>
        ${d.action === 'charge' ? html`<p class="small muted" style="margin: 4px 0 0">Split among ${(d.responsible || []).map((id) => residents.find((x) => x.id === id)?.name || 'unknown').join(', ') || 'everyone'}.</p>` : ''}
        ${locked ? '' : html`<div class="row" style="margin-top: 8px"><button class="btn ghost small" data-undo="${r.key}">Change</button></div>`}
      </div>`;
    }
    if (locked) return '';
    const rates = propRef.rates;
    const pre = sugg.kind === 'charge' ? sugg : null;
    const who = defaultResponsible(r.area, residents);
    return html`<form class="decision" data-decide="${r.key}">
      <p style="margin-bottom: 8px"><b>Draft:</b> ${sugg.kind === 'charge' ? html`${sugg.label}, ${money(sugg.cents)}` : sugg.kind === 'wear' ? 'Normal wear and tear, no charge' : 'No charge suggested'}</p>
      <div class="row" style="align-items: flex-end">
        <label class="field" style="flex: 2 1 180px; margin: 0"><span class="small">Charge</span>
          <select name="rate">${rates.map((x) => html`<option value="${x.id}" ${pre?.rateId === x.id ? 'selected' : ''}>${x.label} (${money(x.cents)})</option>`)}</select></label>
        <label class="field" style="flex: 1 1 90px; margin: 0"><span class="small">Amount</span>
          <input type="text" name="amount" inputmode="decimal" value="${((pre ? pre.cents : rates[0]?.cents || 0) / 100).toFixed(2)}"></label>
      </div>
      ${residents.length ? html`<fieldset class="who" style="border: 0; padding: 0; margin: 10px 0 0"><legend class="small" style="padding: 0; margin-bottom: 4px">Who pays</legend>
        ${residents.map((x) => html`<label class="check small"><input type="checkbox" name="who" value="${x.id}" ${who.includes(x.id) ? 'checked' : ''}><span>${x.name}${x.bedroom ? ` (${x.bedroom})` : ''}</span></label>`)}</fieldset>` : ''}
      <div class="row" style="margin-top: 10px">
        <button class="btn ${sugg.kind === 'charge' ? 'primary' : 'ghost'} small" name="act" value="charge">Approve charge</button>
        <button class="btn ${sugg.kind === 'wear' ? 'primary' : 'ghost'} small" name="act" value="wear">Normal wear</button>
        <button class="btn ghost small" name="act" value="dismiss">No change</button>
      </div>
    </form>`;
  }

  function decide(key, action, form) {
    const r = rows.find((x) => x.key === key);
    if (action !== 'charge') {
      insp.review.decisions[key] = { action, decidedAt: new Date(ctx.now()).toISOString() };
      return true;
    }
    const rate = rateById(prop.rates, form.rate.value);
    const cents = parseMoney(form.amount.value);
    if (!rate || cents == null) { toast('Pick a charge and enter an amount like 35 or 35.00', 'bad'); return false; }
    const who = $$('input[name="who"]:checked', form).map((x) => x.value);
    insp.review.decisions[key] = {
      action, rateId: rate.id, label: rate.label, cents, responsible: who.length ? who : defaultResponsible(r.area, unit.residents),
      decidedAt: new Date(ctx.now()).toISOString(),
    };
    return true;
  }

  function wire() {
    for (const r of $$('input[name="show"]', main)) r.addEventListener('change', () => { showAll = r.value === 'all'; draw(); });
    for (const box of $$('[data-compare]', main)) {
      const range = $('input[type="range"]', box);
      range.addEventListener('input', () => box.style.setProperty('--pos', `${range.value}%`));
    }
    for (const cb of $$('[data-boxes]', main)) {
      cb.addEventListener('change', () => cb.closest('.review-item').querySelector('.compare')?.classList.toggle('hide-boxes', !cb.checked));
    }
    for (const form of $$('[data-decide]', main)) {
      const rateSel = form.rate;
      rateSel.addEventListener('change', () => { const x = rateById(prop.rates, rateSel.value); if (x) form.amount.value = (x.cents / 100).toFixed(2); });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const action = e.submitter?.value || 'charge';
        if (!decide(form.dataset.decide, action, form)) return;
        await ctx.save();
        const y = window.scrollY;
        draw();
        window.scrollTo(0, y);
      });
    }
    for (const b of $$('[data-undo]', main)) {
      b.addEventListener('click', async () => {
        delete insp.review.decisions[b.dataset.undo];
        await ctx.save();
        const y = window.scrollY;
        draw();
        window.scrollTo(0, y);
      });
    }
    $('#accept-all')?.addEventListener('click', async () => {
      let n = 0;
      for (const r of rows) {
        if (!r.draft.flagged || insp.review.decisions[r.key]) continue;
        const sugg = r.draft.suggestion;
        const now = new Date(ctx.now()).toISOString();
        insp.review.decisions[r.key] = sugg.kind === 'charge'
          ? { action: 'charge', rateId: sugg.rateId, label: sugg.label, cents: sugg.cents, responsible: defaultResponsible(r.area, unit.residents), decidedAt: now }
          : { action: sugg.kind === 'wear' ? 'wear' : 'dismiss', decidedAt: now };
        n++;
      }
      await ctx.save();
      toast(`Accepted ${plural(n, 'draft')}. Check them before settling.`);
      draw();
    });
  }

  draw();
}
