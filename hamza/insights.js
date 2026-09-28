// Pure calculations for the Insights tab. No DOM access, so they can be unit tested in Node.

const DAY = 864e5;

// Local calendar day (YYYY-MM-DD) of an ISO timestamp.
export function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const shiftDay = (key, delta) => {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + delta).toISOString());
};

/** Lessons watched per local day: Map<dayKey, count>. */
export function activityByDay(watchedTimestamps) {
  const days = new Map();
  for (const iso of watchedTimestamps) {
    const k = dayKey(iso);
    if (k) days.set(k, (days.get(k) || 0) + 1);
  }
  return days;
}

/**
 * Current and longest streak of consecutive days with at least one lesson.
 * The current streak survives until the end of today, so it is still alive if
 * you watched yesterday but haven't watched yet today.
 */
export function streaks(days, todayKey) {
  const keys = [...days.keys()].sort();
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const k of keys) {
    run = prev && shiftDay(prev, 1) === k ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = k;
  }
  let current = 0;
  let k = days.has(todayKey) ? todayKey : shiftDay(todayKey, -1);
  while (days.has(k)) {
    current++;
    k = shiftDay(k, -1);
  }
  return { current, longest };
}

/**
 * Grid for a GitHub-style heatmap: `weeks` columns (Sunday first), 7 rows.
 * Cells after today are null. `level` is 0-4, scaled to the busiest day.
 */
export function heatmap(days, todayKey, weeks = 26) {
  const [y, m, d] = todayKey.split('-').map(Number);
  const today = new Date(y, m - 1, d);
  const start = new Date(y, m - 1, d - today.getDay() - (weeks - 1) * 7);
  const max = Math.max(1, ...days.values());
  const columns = [];
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let r = 0; r < 7; r++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + r);
      if (date > today) { col.push(null); continue; }
      const key = dayKey(date.toISOString());
      const count = days.get(key) || 0;
      col.push({ key, count, level: count ? Math.min(4, Math.ceil((count / max) * 4)) : 0 });
    }
    columns.push(col);
  }
  return columns;
}

/** Watched / total per topic, sorted by remaining lessons. */
export function topicProgress(items) {
  const map = new Map();
  for (const { topic, watched } of items) {
    const t = map.get(topic) || { topic, total: 0, watched: 0 };
    t.total++;
    if (watched) t.watched++;
    map.set(topic, t);
  }
  return [...map.values()].sort((a, b) => (b.total - b.watched) - (a.total - a.watched) || a.topic.localeCompare(b.topic));
}

/** Count of ratings 1-5, plus the average (null when nothing is rated). */
export function ratingSpread(ratings) {
  const counts = [0, 0, 0, 0, 0];
  let sum = 0;
  let n = 0;
  for (const r of ratings) {
    if (Number.isInteger(r) && r >= 1 && r <= 5) { counts[r - 1]++; sum += r; n++; }
  }
  return { counts, n, average: n ? sum / n : null };
}

/**
 * Project a finish date from the pace of the last `windowDays` days.
 * Returns null when there's no pace to extrapolate from or nothing left to watch.
 */
export function projection({ remaining, watchedTimestamps, now, windowDays = 28 }) {
  if (remaining <= 0) return null;
  const since = now - windowDays * DAY;
  const recent = watchedTimestamps.map(Date.parse).filter((t) => t >= since && t <= now);
  if (!recent.length) return null;
  const perDay = recent.length / windowDays;
  const daysLeft = Math.ceil(remaining / perDay);
  return { perWeek: perDay * 7, daysLeft, date: new Date(now + daysLeft * DAY) };
}
