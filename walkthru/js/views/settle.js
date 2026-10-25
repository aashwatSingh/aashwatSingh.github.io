// Settlement: approved charges split among roommates, set against each deposit, with the Texas
// deadline. Prints as an itemized statement and exports as CSV.

import { html, $, $$, toast, fmtDate, fmtDateTime, localDay, download, slug, plural } from '../ui.js';
import { approvedCharges, sealedOf } from '../core/model.js';
import { settle, money } from '../core/charges.js';
import { RULES, STATUTE_URL, refundStatus } from '../core/texas.js';
import { notFound, crumbs, callout, kindLabel } from './common.js';

const STATE_TEXT = {
  'no-date': 'Enter the move-out (surrender) date to start the 30-day clock.',
  'waiting-address': 'No written forwarding address yet. The refund and list are not due until one is given (§92.107).',
  open: 'On track.',
  'due-soon': 'Due within a week.',
  overdue: 'Past the 30-day deadline. Missing it is presumed bad faith (§92.109).',
};

const csvCell = (v) => {
  const s = String(v ?? '');
  // Quote everything, and defuse spreadsheet formulas in text cells.
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

export function render(main, { iid }, ctx) {
  const s = ctx.state;
  const insp = s.inspections[iid];
  if (!insp) return notFound(main, 'inspection');
  const unit = s.units[insp.unitId];
  const prop = s.properties[unit.propertyId];

  const draw = () => {
    const charges = approvedCharges(s, insp);
    const result = settle(charges, unit.residents);
    const today = localDay(ctx.now());
    const finalized = Boolean(insp.review.finalizedAt);
    const noRecords = !sealedOf(s, iid).length;

    main.innerHTML = String(html`
      ${crumbs([['Office', '#/office'], [prop.name, `#/office/p/${prop.id}`], [`Unit ${unit.label}`, `#/office/u/${unit.id}`], ['Review', `#/office/review/${iid}`]])}
      <div class="print-only"><p class="small">${prop.name} · ${prop.city}, ${prop.state} · printed ${fmtDate(today)}</p></div>
      <div class="eyebrow">${kindLabel(insp.kind)} settlement</div>
      <h1>Unit ${unit.label}: deposit statement</h1>
      ${noRecords ? callout('note', 'No records', html`<p>No sealed records yet for this walkthrough.</p>`) : ''}
      ${finalized ? callout('tip', 'Finalized', html`<p>Finalized ${fmtDateTime(insp.review.finalizedAt)}. The charges below are fixed until reopened.</p>`) : ''}

      <section class="card no-print" style="margin-bottom: 16px">
        <h3>Move-out details</h3>
        <div class="row" style="align-items: flex-end">
          <label class="field" style="margin: 0; flex: 0 1 220px"><span>Surrender date</span>
            <input type="date" id="surrender" value="${insp.surrenderDate || ''}" ${finalized ? 'disabled' : ''}></label>
        </div>
      </section>

      <h2>Per resident</h2>
      ${unit.residents.length ? html`<div class="table-box"><table>
        <thead><tr><th>Resident</th><th class="num">Deposit</th><th class="num">Charges</th><th class="num">Refund due</th><th class="num">Still owes</th><th>Forwarding address</th><th>Texas deadline</th></tr></thead>
        <tbody>${result.rows.map((row) => {
          const st = refundStatus(insp.surrenderDate, today, Boolean(insp.forwarding?.[row.id]));
          return html`<tr>
            <td><b>${row.name}</b></td>
            <td class="num">${money(row.deposit)}</td>
            <td class="num">${money(row.charged)}</td>
            <td class="num"><b>${money(row.refund)}</b></td>
            <td class="num">${row.owes ? money(row.owes) : '—'}</td>
            <td><label class="check small"><input type="checkbox" data-fwd="${row.id}" ${insp.forwarding?.[row.id] ? 'checked' : ''} ${finalized ? 'disabled' : ''}><span>Received in writing</span></label></td>
            <td class="small">${st.due ? html`<b>${fmtDate(st.due)}</b>${st.state === 'overdue' ? html` <span class="chip overdue">overdue</span>` : st.state === 'due-soon' ? html` <span class="chip ready">${plural(st.daysLeft, 'day')} left</span>` : st.state === 'open' ? html` <span class="muted">${plural(st.daysLeft, 'day')} left</span>` : ''}<br>` : ''}<span class="muted">${STATE_TEXT[st.state]}</span></td>
          </tr>`;
        })}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${money(result.deposits)}</td><td class="num">${money(result.total)}</td><td class="num">${money(result.refunds)}</td><td class="num">${result.owed ? money(result.owed) : '—'}</td><td colspan="2"></td></tr></tfoot>
      </table></div>
      <p class="small muted no-print">Deposits are set on the <a href="#/office/u/${unit.id}">unit page</a>.</p>` : html`<p class="muted">No residents on this unit.</p>`}

      <h2>Itemized deductions</h2>
      ${charges.length ? html`<div class="table-box"><table>
        <thead><tr><th>Item</th><th>Split</th><th class="num">Amount</th></tr></thead>
        <tbody>${charges.map((c) => html`<tr><td>${c.label}</td><td class="small">${result.rows.filter((r) => r.items.some((i) => i.key === c.key)).map((r) => `${r.name} ${money(r.items.find((i) => i.key === c.key).cents)}`).join(' · ')}</td><td class="num">${money(c.cents)}</td></tr>`)}</tbody>
        <tfoot><tr><td colspan="2">Total deductions</td><td class="num">${money(result.total)}</td></tr></tfoot>
      </table></div>
      <p class="small">Each line has before and after photos in the <a href="#/report/${iid}">condition report</a> and in <a href="#/office/review/${iid}">clipboard mode</a>.</p>` : html`<p class="muted">No charges approved. ${finalized ? '' : html`<a href="#/office/review/${iid}">Review the changes</a> first.`}</p>`}

      <h2>Texas rules this statement follows</h2>
      <ul class="small">${RULES.map((r) => html`<li><b>${r.cite}</b> ${r.text}</li>`)}</ul>
      ${callout('caution', 'Not legal advice', html`<p class="small">These are summaries of Texas Property Code Chapter 92. Check the <a href="${STATUTE_URL}" target="_blank" rel="noopener">statute text</a> and your lease, and get counsel before relying on them.</p>`)}

      <div class="row no-print" style="margin-top: 16px">
        <button class="btn ghost" id="print">Print statement</button>
        <button class="btn ghost" id="csv">Download CSV</button>
        <span class="spacer"></span>
        ${finalized ? html`<button class="btn ghost" id="reopen">Reopen</button>` : html`<button class="btn primary" id="finalize">Finalize</button>`}
      </div>
    `);
    wire(result, charges);
  };

  function wire(result, charges) {
    $('#surrender')?.addEventListener('change', async (e) => {
      insp.surrenderDate = /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) ? e.target.value : null;
      await ctx.save();
      draw();
    });
    for (const cb of $$('[data-fwd]', main)) {
      cb.addEventListener('change', async () => {
        insp.forwarding = { ...(insp.forwarding || {}), [cb.dataset.fwd]: cb.checked };
        await ctx.save();
        draw();
      });
    }
    $('#print').addEventListener('click', () => window.print());
    $('#csv').addEventListener('click', () => {
      const lines = [['Section', 'Name', 'Item', 'Amount (USD)']];
      for (const c of charges) lines.push(['Deduction', '', c.label, (c.cents / 100).toFixed(2)]);
      for (const r of result.rows) {
        for (const i of r.items) lines.push(['Split', r.name, i.label, (i.cents / 100).toFixed(2)]);
        lines.push(['Deposit', r.name, 'Deposit held', (r.deposit / 100).toFixed(2)]);
        lines.push(['Refund', r.name, 'Refund due', (r.refund / 100).toFixed(2)]);
        if (r.owes) lines.push(['Owes', r.name, 'Charges beyond deposit', (r.owes / 100).toFixed(2)]);
      }
      const csv = lines.map((l) => l.map(csvCell).join(',')).join('\r\n');
      download(new Blob([csv], { type: 'text/csv' }), `walkthru-${slug(`${prop.name} ${unit.label} settlement`)}.csv`);
    });
    $('#finalize')?.addEventListener('click', async () => {
      if (!insp.surrenderDate) { toast('Enter the surrender date first.', 'bad'); $('#surrender').focus(); return; }
      insp.review.finalizedAt = new Date(ctx.now()).toISOString();
      await ctx.save();
      toast('Settlement finalized.');
      draw();
    });
    $('#reopen')?.addEventListener('click', async () => {
      insp.review.finalizedAt = null;
      await ctx.save();
      draw();
    });
  }

  draw();
}

