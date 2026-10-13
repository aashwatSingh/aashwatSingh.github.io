// Pure calculations for Lock In. No DOM access, so they can be unit tested in Node.
import { dayKey, heatmap } from '../hamza/insights.js';

export { dayKey, heatmap };

export const DEFAULT_COMMITMENTS = [
  { id: 'phone', label: 'Phone-free first hour', kind: 'check',
    full: 'No phone for the first hour awake', min: 'No phone in bed' },
  { id: 'deep', label: 'Deep work', kind: 'focus', full: 50, min: 10, unit: 'min' },
  { id: 'intern', label: 'Internship reps', kind: 'count', full: 3, min: 1, unit: 'apps or problems',
    link: 'https://app.appwing.us' },
];

const RANK = { full: 2, min: 1, miss: 0 };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// A day runs until 4 am, so a 1 am review still closes the day you lived.
export const DAY_START_HOUR = 4;

/** The Lock In day for a moment in time (ms), as YYYY-MM-DD. */
export function todayKey(now = Date.now()) {
  // Use the local wall clock, not "now minus 4 hours", so DST nights still flip at 4 am.
  const d = new Date(now);
  const k = dayKey(d.toISOString());
  return k && d.getHours() < DAY_START_HOUR ? addDays(k, -1) : k;
}

/** The calendar day `n` days after `key` (YYYY-MM-DD). */
export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + n).toISOString());
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. */
export function daysBetween(from, to) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 864e5);
}

/** Monday of the week containing `key`. */
export function weekStart(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return addDays(key, -((dow + 6) % 7));
}

/** The number a count or focus commitment has reached today. */
export function valueOf(c, day) {
  if (!day) return 0;
  if (c.kind === 'focus') return Math.max(0, Number(day.focusMin) || 0);
  if (c.kind === 'count') return Math.max(0, Number(day.counts?.[c.id]) || 0);
  return 0;
}

/**
 * 'full', 'min', 'miss' or null (not marked yet) for one commitment on one day.
 * Count and focus commitments mark themselves from their numbers. A manual mark
 * can raise that (deep work done without the timer) but never lower it.
 */
export function markOf(c, day) {
  if (!day) return null;
  let derived = null;
  if (c.kind === 'focus' || c.kind === 'count') {
    const v = valueOf(c, day);
    if (v >= c.full) derived = 'full';
    else if (v >= c.min && c.min > 0) derived = 'min';
  }
  const manual = RANK[day.marks?.[c.id]] !== undefined ? day.marks[c.id] : null;
  if (derived === null) return manual;
  if (manual === null) return derived;
  return RANK[manual] > RANK[derived] ? manual : derived;
}

/** How many commitments a day met, and whether it was kept (all met at least at minimum). */
export function dayStatus(day, commitments) {
  const total = commitments.length;
  let met = 0;
  let full = 0;
  for (const c of commitments) {
    const m = markOf(c, day);
    if (m === 'full' || m === 'min') met++;
    if (m === 'full') full++;
  }
  return { met, full, total, kept: total > 0 && met === total };
}

/**
 * Never-miss-twice streak, from the start date to today.
 * - One non-kept day between kept days is forgiven: it doesn't add, but doesn't break.
 * - Two non-kept days in a row break the streak.
 * - Today is pending until it's kept or over, so it can only add, never break.
 * `states` maps each day to 'kept', 'slip' (a lone forgiven day), 'missed' (part of a
 * run of two or more) or 'today' (pending). A comeback is a kept day after a miss.
 */
export function streak(days, { today, startDate, commitments }) {
  const out = { current: 0, longest: 0, keptDays: 0, comebacks: 0, missedYesterday: false, atRisk: false, states: new Map() };
  if (!startDate || startDate > today) return out;
  let misses = 0;
  let hadKept = false;
  let run = [];
  const closeRun = () => {
    for (const k of run) out.states.set(k, run.length === 1 ? 'slip' : 'missed');
    run = [];
  };
  for (let k = startDate; k <= today; k = addDays(k, 1)) {
    const kept = dayStatus(days[k], commitments).kept;
    if (kept) {
      closeRun();
      if (misses > 0 && hadKept) out.comebacks++;
      out.current++;
      out.keptDays++;
      out.longest = Math.max(out.longest, out.current);
      misses = 0;
      hadKept = true;
      out.states.set(k, 'kept');
    } else if (k === today) {
      out.states.set(k, 'today');
    } else {
      misses++;
      run.push(k);
      if (misses >= 2) out.current = 0;
    }
  }
  closeRun();
  const yesterday = addDays(today, -1);
  out.missedYesterday = yesterday >= startDate && !dayStatus(days[yesterday], commitments).kept;
  // One more miss (today) would break a live streak.
  out.atRisk = out.missedYesterday && out.current > 0 && out.states.get(today) === 'today';
  return out;
}

/** Share of the last `n` finished days (not today) that were kept, from the start date on. */
export function keptRate(days, { today, startDate, commitments }, n = 30) {
  let kept = 0;
  let counted = 0;
  for (let i = 1; i <= n; i++) {
    const k = addDays(today, -i);
    if (k < startDate) break;
    counted++;
    if (dayStatus(days[k], commitments).kept) kept++;
  }
  return counted ? kept / counted : null;
}

/** Hamza lessons marked watched between two days, inclusive. */
export function lessonsWatched(hamza, from, to) {
  let n = 0;
  for (const p of Object.values(hamza?.videos || {})) {
    const t = p?.watched ? Date.parse(p.watched) : NaN;
    const k = Number.isNaN(t) ? null : todayKey(t);
    if (k && k >= from && k <= to) n++;
  }
  return n;
}

/** Every takeaway line written in the Hamza tracker. */
export function takeaways(hamza) {
  const out = [];
  for (const [id, p] of Object.entries(hamza?.videos || {})) {
    for (const line of String(p?.takeaways || '').split('\n')) {
      const text = line.replace(/^\s*[-*•]\s*/, '').trim();
      if (text) out.push({ id, text });
    }
  }
  return out;
}

/** Totals for the week (Monday to today) that contains `today`. */
export function weekStats(days, { today, startDate, commitments }, hamza) {
  const from = weekStart(today);
  const s = {
    from, weekday: daysBetween(from, today), daysElapsed: 0, keptDays: 0, todayKept: false, focusMin: 0, social: 0, urges: 0,
    counts: Object.fromEntries(commitments.filter((c) => c.kind === 'count').map((c) => [c.id, 0])),
    lessons: lessonsWatched(hamza, from, today),
  };
  for (let k = from; k <= today; k = addDays(k, 1)) {
    if (startDate && k < startDate) continue;
    s.daysElapsed++;
    const day = days[k];
    if (!day) continue;
    if (dayStatus(day, commitments).kept) {
      s.keptDays++;
      if (k === today) s.todayKept = true;
    }
    s.focusMin += Math.max(0, Number(day.focusMin) || 0);
    s.social += Array.isArray(day.social) ? day.social.length : 0;
    s.urges += Math.max(0, Number(day.urges) || 0);
    for (const id of Object.keys(s.counts)) s.counts[id] += Math.max(0, Number(day.counts?.[id]) || 0);
  }
  return s;
}

/** One honest line about the week so far. Today only counts once it's kept. */
export function weeklyVerdict(s, { countTarget = 0, countLabel = 'Internship reps', socialTarget = 0 } = {}) {
  const countDone = Object.values(s.counts)[0] ?? 0;
  const done = s.daysElapsed - (s.todayKept ? 0 : 1);
  if (s.lessons >= 3 && s.lessons > s.keptDays) {
    return `${s.lessons} lessons watched, ${s.keptDays} ${s.keptDays === 1 ? 'day' : 'days'} kept. You don’t need more input this week. Use one.`;
  }
  if (done <= 0) return 'Fresh week. Nothing to judge yet, so go give yourself something to judge.';
  if (s.keptDays === done && done >= 3) {
    return `${s.keptDays} for ${done}. This is what it looks like when you stop negotiating with yourself.`;
  }
  const pace = countTarget ? Math.ceil((countTarget * s.daysElapsed) / 7) : 0;
  if (pace && countDone < pace) {
    const gap = pace - countDone;
    return `${countLabel} ${countLabel.endsWith('s') ? 'are' : 'is'} behind pace: ${countDone} of ${pace} by now. ${gap} more today puts you back on track.`;
  }
  if (done - s.keptDays === 1) return s.todayKept
    ? 'One slip this week, and you came back. That is the skill.'
    : 'One slip so far. Keep today and it stays a blip.';
  if (socialTarget && s.weekday >= 3 && s.social < socialTarget) {
    const when = s.weekday >= 5 ? 'before the week ends' : 'with the weekend ahead';
    return `${s.social} of ${socialTarget} social reps ${when}. Confidence is built from evidence. Go collect some.`;
  }
  if (s.keptDays === done) return `Kept ${s.keptDays} of ${done}. Solid. Keep the floor where it is.`;
  return `Kept ${s.keptDays} of ${done}. Next week is built by what you do today, not by Monday’s promises.`;
}

// Small, stable string hash (djb2), so the same day always shows the same message.
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/** A stable index in [0, length) for a seed string. */
export function pickIndex(length, seed) {
  return length > 0 ? hash(String(seed)) % length : -1;
}

/** Tags only shown in their own moment, never in the everyday rotation. */
export const CONTEXT_TAGS = ['miss', 'streak', 'urge', 'monday'];
export const STREAK_MILESTONES = [7, 14, 21, 30, 50, 75, 100, 150, 200, 365];

/** Which moment today is: 'miss' after a slip, 'streak' on a milestone, 'monday', or null. */
export function truthContext({ missedYesterday, current, dateKey }) {
  if (missedYesterday) return 'miss';
  if (STREAK_MILESTONES.includes(current)) return 'streak';
  const [y, m, d] = dateKey.split('-').map(Number);
  if (new Date(y, m - 1, d).getDay() === 1) return 'monday';
  return null;
}

/**
 * Today's message. A context ('miss', 'streak', 'urge', 'monday') picks from that pool.
 * Otherwise it rotates through messages matching `tags` (your weak spots and ambitions).
 * Deterministic per date, so it doesn't change on every reload.
 */
export function pickTruth(truths, { dateKey, context = null, tags = [], salt = '' }) {
  let pool = context ? truths.filter((t) => t.tags.includes(context)) : [];
  if (!pool.length) {
    const everyday = truths.filter((t) => !t.tags.some((g) => CONTEXT_TAGS.includes(g)));
    pool = tags.length ? everyday.filter((t) => t.tags.some((g) => tags.includes(g))) : [];
    if (!pool.length) pool = everyday;
  }
  if (!pool.length) return null;
  return pool[hash(`${dateKey}|${context || ''}|${salt}`) % pool.length];
}

/** The social rep to try next: the level rises one step every 5 reps logged. */
export function socialSuggestion(ladder, totalReps, seed) {
  const level = Math.min(ladder.length - 1, Math.floor(totalReps / 5));
  const rung = ladder[level];
  return { level: level + 1, name: rung.name, text: rung.reps[hash(`${seed}|${totalReps}`) % rung.reps.length] };
}

/** Merge imported days into local ones, keeping the most recently edited copy of each day. */
export function mergeDays(local, incoming) {
  const merged = { ...local };
  let count = 0;
  for (const [k, day] of Object.entries(incoming || {})) {
    if (!DAY_RE.test(k) || !day || typeof day !== 'object') continue;
    const mine = merged[k];
    if (!mine || String(day.updated || '') > String(mine.updated || '')) {
      merged[k] = day;
      count++;
    }
  }
  return { days: merged, count };
}
