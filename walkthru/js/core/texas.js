// Texas security-deposit rules (Texas Property Code, Chapter 92, Subchapter C) that the
// settlement screen cites. Summaries only, not legal advice: check the statute text and get
// counsel before relying on any of it.

export const STATUTE_URL = 'https://statutes.capitol.texas.gov/Docs/PR/htm/PR.92.htm';

export const RULES = [
  { id: 'refund-30', cite: '§92.103(a)', text: 'Refund the deposit, or send the written list of deductions, within 30 days after the tenant surrenders the unit.' },
  { id: 'wear-tear', cite: '§92.104(b)', text: 'Nothing may be deducted for normal wear and tear.' },
  { id: 'itemize', cite: '§92.104(c)', text: 'Any deduction needs a written description and an itemized list.' },
  { id: 'forwarding', cite: '§92.107', text: 'The refund and list are not due until the tenant gives a written forwarding address.' },
  { id: 'bad-faith', cite: '§92.109', text: 'Withholding in bad faith can cost $100, three times the amount wrongly withheld, and attorney\'s fees. Missing the 30-day deadline is presumed bad faith.' },
];

export const REFUND_DAYS = 30;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD plus n calendar days. */
export function addDays(day, n) {
  const m = DAY_RE.exec(day);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from, to) {
  const a = DAY_RE.exec(from);
  const b = DAY_RE.exec(to);
  if (!a || !b) return null;
  return Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 864e5);
}

/**
 * Where a deposit stands. `surrender` is the move-out day (YYYY-MM-DD), `today` the current day,
 * `hasAddress` whether a written forwarding address is on file.
 * Returns { due, daysLeft, state: 'no-date' | 'waiting-address' | 'open' | 'due-soon' | 'overdue' }.
 */
export function refundStatus(surrender, today, hasAddress) {
  const due = surrender ? addDays(surrender, REFUND_DAYS) : null;
  if (!due) return { due: null, daysLeft: null, state: 'no-date' };
  const daysLeft = daysBetween(today, due);
  if (!hasAddress) return { due, daysLeft, state: 'waiting-address' };
  if (daysLeft < 0) return { due, daysLeft, state: 'overdue' };
  if (daysLeft <= 7) return { due, daysLeft, state: 'due-soon' };
  return { due, daysLeft, state: 'open' };
}
