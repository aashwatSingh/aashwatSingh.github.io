// Money maths for charges and settlements. Everything is whole cents, so totals add up exactly.

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const money = (cents) => USD.format((Number(cents) || 0) / 100);

/** Parse "$1,234.5" or "12" into cents, or null if it isn't a non-negative amount. */
export function parseMoney(text) {
  const s = String(text ?? '').replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/**
 * Split `cents` evenly among `ids`. Leftover cents go one each to the first ids, so the parts
 * always sum to the total. Returns { id: cents }.
 */
export function split(cents, ids) {
  const out = {};
  const list = [...new Set(ids)];
  if (!list.length) return out;
  const total = Math.max(0, Math.round(cents));
  const base = Math.floor(total / list.length);
  let extra = total - base * list.length;
  for (const id of list) {
    out[id] = base + (extra > 0 ? 1 : 0);
    extra--;
  }
  return out;
}

/** Who is responsible for an area by default: the bedroom's resident, or everyone if shared. */
export function defaultResponsible(area, residents) {
  if (!area || area.shared) return residents.map((r) => r.id);
  const owners = residents.filter((r) => r.bedroom === area.bedroom).map((r) => r.id);
  return owners.length ? owners : residents.map((r) => r.id);
}

/**
 * Totals for a settlement. `charges` are approved charges { cents, responsible: [ids] };
 * residents carry `depositCents`. Returns per-resident rows and grand totals. A resident's refund
 * never goes below zero; anything beyond the deposit shows as `owes`.
 */
export function settle(charges, residents) {
  const rows = residents.map((r) => ({ id: r.id, name: r.name, deposit: Math.max(0, Math.round(r.depositCents || 0)), charged: 0, items: [] }));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  let total = 0;
  for (const c of charges) {
    const who = (c.responsible || []).filter((id) => byId[id]);
    const parts = split(c.cents, who.length ? who : rows.map((r) => r.id));
    for (const [id, part] of Object.entries(parts)) {
      byId[id].charged += part;
      byId[id].items.push({ label: c.label, cents: part, key: c.key });
    }
    total += Math.max(0, Math.round(c.cents));
  }
  for (const r of rows) {
    r.refund = Math.max(0, r.deposit - r.charged);
    r.owes = Math.max(0, r.charged - r.deposit);
  }
  return {
    rows,
    total,
    deposits: rows.reduce((s, r) => s + r.deposit, 0),
    refunds: rows.reduce((s, r) => s + r.refund, 0),
    owed: rows.reduce((s, r) => s + r.owes, 0),
  };
}
