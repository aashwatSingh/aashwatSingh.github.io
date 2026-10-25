// The default rate sheet. These are sample prices for the prototype, not quotes or market data:
// each property edits its own sheet on the Rate sheet screen. Amounts are in cents.

export const DEFAULT_RATES = [
  { id: 'paint-touchup', label: 'Wall touch-up and paint', cents: 3500 },
  { id: 'drywall-small', label: 'Drywall patch, small hole', cents: 7500 },
  { id: 'drywall-large', label: 'Drywall patch, large hole', cents: 15000 },
  { id: 'carpet-clean', label: 'Carpet spot clean', cents: 6000 },
  { id: 'carpet-patch', label: 'Carpet patch or section replace', cents: 20000 },
  { id: 'blind-replace', label: 'Replace blind', cents: 2500 },
  { id: 'door-repair', label: 'Door or closet door repair', cents: 15000 },
  { id: 'smoke-detector', label: 'Smoke detector replace', cents: 5000 },
  { id: 'appliance-clean', label: 'Appliance or fixture deep clean', cents: 4000 },
  { id: 'drip-pans', label: 'Replace stove drip pans', cents: 2000 },
  { id: 'counter-repair', label: 'Countertop or vanity repair', cents: 12000 },
  { id: 'recaulk', label: 'Re-caulk tub or regrout', cents: 4500 },
  { id: 'mirror-replace', label: 'Replace mirror', cents: 8000 },
  { id: 'furniture-repair', label: 'Furniture repair', cents: 10000 },
];

/** A rate by id from a sheet, or null. */
export function rateById(rates, id) {
  return rates.find((r) => r.id === id) || null;
}

/**
 * Clean a rate sheet edited by hand or read from storage: keep well-formed rows, clamp prices to
 * $0–$10,000 and whole cents, and drop duplicate ids.
 */
export function cleanRates(rows) {
  if (!Array.isArray(rows)) return DEFAULT_RATES.map((r) => ({ ...r }));
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || typeof r.id !== 'string' || !/^[\w-]{1,40}$/.test(r.id) || seen.has(r.id)) continue;
    const label = typeof r.label === 'string' ? r.label.trim().slice(0, 80) : '';
    const cents = Math.round(Number(r.cents));
    if (!label || !Number.isFinite(cents)) continue;
    seen.add(r.id);
    out.push({ id: r.id, label, cents: Math.min(1_000_000, Math.max(0, cents)) });
  }
  return out;
}
