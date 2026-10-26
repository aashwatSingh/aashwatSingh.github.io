// Local-calendar helpers. Days are 'YYYY-MM-DD' strings in the browser's time zone.

export const HOUR = 36e5;
export const DAY = 864e5;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const pad = (n) => String(n).padStart(2, '0');

/** The local day of a Date or timestamp, as YYYY-MM-DD. */
export function keyOf(t) {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of a YYYY-MM-DD day. */
export function dateOf(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key, n) {
  const d = dateOf(key);
  return keyOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

/** Whole days from `from` to `to`. */
export function daysBetween(from, to) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY);
}

/** A local day plus an optional HH:MM, as a timestamp. No time means the end of that day. */
export function stamp(key, time = '') {
  if (!DAY_RE.test(key || '')) return null;
  const [y, m, d] = key.split('-').map(Number);
  if (TIME_RE.test(time)) {
    const [h, min] = time.split(':').map(Number);
    return new Date(y, m - 1, d, h, min).getTime();
  }
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

// Practice counts toward the day you lived until 4 am, the same rule Lock In uses.
export const DAY_START_HOUR = 4;

/** The practice day for a moment: before 4 am still counts as yesterday. */
export function practiceDay(now = Date.now()) {
  const d = new Date(now);
  const k = keyOf(d);
  return d.getHours() < DAY_START_HOUR ? addDays(k, -1) : k;
}
