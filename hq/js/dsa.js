// DSA practice: spaced repetition, today's set, progress per pattern and a readiness score.

import { PATTERNS, PROBLEMS } from './problems.js';
import { addDays, daysBetween } from './dates.js';

/** Days until the next review at each step. Solid moves a step up, Shaky stays, Needed help resets. */
export const INTERVALS = [1, 3, 7, 14, 30, 60];
export const CONFIDENCE = [
  { v: 1, label: 'Needed help', hint: 'Looked at the solution' },
  { v: 2, label: 'Shaky', hint: 'Solved it, slowly or with bugs' },
  { v: 3, label: 'Solid', hint: 'Clean, could explain it' },
];

const MAX_STEP = INTERVALS.length - 1;
const CREDIT = { 0: 0.15, 1: 0.4, 2: 0.7, 3: 1 };
// A pattern counts as covered when about this share of it is solved solidly.
const COVERED = 0.6;

/** The core set plus your own problems, each slotted at the end of its pattern. */
export function allProblems(custom = []) {
  if (!custom.length) return PROBLEMS;
  return PATTERNS.flatMap((p) => [
    ...PROBLEMS.filter((x) => x.pattern === p.id),
    ...custom.filter((x) => x.pattern === p.id).map((x) => ({ premium: false, ...x, custom: true })),
  ]);
}

/**
 * Record practice on a problem. conf 1-3 is a solve at that confidence; 0 is an attempt that
 * didn't get there (try again tomorrow). Practising the same problem twice in a day replaces the
 * first mark instead of stepping twice, and only counts once in the daily log.
 */
export function practice(dsa, slug, conf, today) {
  const prev = dsa.problems[slug] || null;
  const again = prev?.last === today;
  const before = again ? prev.was : prev;
  const base = before?.st === 'solved' ? before.step : 0;
  const step = conf === 3 ? Math.min(base + 1, MAX_STEP) : conf === 2 ? base : 0;
  const next = {
    st: conf > 0 ? 'solved' : 'attempted', conf, step,
    due: addDays(today, conf > 0 ? INTERVALS[step] : 1),
    first: before?.first || today, last: today, n: (before?.n || 0) + 1,
    was: before ? strip(before) : null,
  };
  const log = { ...dsa.log };
  if (!again) log[today] = (log[today] || 0) + 1;
  return { ...dsa, problems: { ...dsa.problems, [slug]: next }, log };
}

const strip = (s) => { const { was, ...rest } = s; return rest; };

/** Undo today's mark (back to how it was this morning), or clear an older one. */
export function undo(dsa, slug, today) {
  const prev = dsa.problems[slug];
  if (!prev) return dsa;
  const problems = { ...dsa.problems };
  const log = { ...dsa.log };
  if (prev.last === today) {
    if (prev.was) problems[slug] = { ...prev.was, was: null };
    else delete problems[slug];
    log[today] = Math.max(0, (log[today] || 0) - 1);
    if (!log[today]) delete log[today];
  } else {
    delete problems[slug];
  }
  return { ...dsa, problems, log };
}

/** Problems due for review (attempts included), oldest first, shakiest first. */
export function dueReviews(problems, states, today) {
  return problems.filter((p) => { const s = states[p.slug]; return s && s.due <= today && s.last !== today; })
    .sort((a, b) => states[a.slug].due.localeCompare(states[b.slug].due) || states[a.slug].conf - states[b.slug].conf);
}

/**
 * The next `n` new problems in learning order. Premium problems are skipped, and a pattern's
 * hard problems wait until two of its mediums are solved.
 */
export function nextNew(problems, states, n) {
  if (n <= 0) return [];
  const out = [];
  for (const pat of PATTERNS) {
    const list = problems.filter((p) => p.pattern === pat.id);
    const mediums = list.filter((p) => p.diff === 'M' && states[p.slug]?.st === 'solved').length;
    for (const p of list) {
      if (states[p.slug] || p.premium) continue;
      if (p.diff === 'H' && mediums < 2) continue;
      out.push(p);
      if (out.length >= n) return out;
    }
  }
  return out;
}

/** Today's reviews and new problems, minus what you've already done today. */
export function todaysSet(dsa, settings, today, problems = PROBLEMS) {
  const states = dsa.problems;
  const doneToday = problems.filter((p) => states[p.slug]?.last === today);
  const newToday = doneToday.filter((p) => states[p.slug].first === today).length;
  const due = dueReviews(problems, states, today);
  const reviews = due.slice(0, Math.max(0, settings.dailyReview - (doneToday.length - newToday)));
  const fresh = nextNew(problems, states, Math.max(0, settings.dailyNew - newToday));
  return { reviews, fresh, dueCount: due.length, doneToday, left: reviews.length + fresh.length };
}

/** Solved / total per pattern, in learning order. */
export function patternProgress(problems, states) {
  return PATTERNS.map((pat) => {
    const list = problems.filter((p) => p.pattern === pat.id);
    const solved = list.filter((p) => states[p.slug]?.st === 'solved');
    return {
      id: pat.id, name: pat.name, total: list.length, solved: solved.length,
      solid: solved.filter((p) => states[p.slug].conf === 3).length,
    };
  });
}

/**
 * 0-100. Each pattern earns credit for its problems (Solid 1, Shaky 0.7, Needed help 0.4,
 * attempted 0.15; reviews more than a week overdue count 15% less) and is full at 60% of its size.
 * Readiness is the average over all patterns, so breadth beats grinding one topic.
 */
export function readiness(problems, states, today) {
  let sum = 0;
  for (const pat of PATTERNS) {
    const list = problems.filter((p) => p.pattern === pat.id);
    if (!list.length) continue;
    let credit = 0;
    for (const p of list) {
      const s = states[p.slug];
      if (!s) continue;
      const stale = daysBetween(s.due, today) > 7 ? 0.85 : 1;
      credit += (CREDIT[s.conf] ?? 0) * stale;
    }
    sum += Math.min(1, credit / (COVERED * list.length));
  }
  return Math.round((sum / PATTERNS.length) * 100);
}

/**
 * Today's practice as a priority item, or null when it's done. Rises when an interview is near.
 * `today` is the calendar day (not the 4 am practice day), so the countdown matches the calendar.
 */
export function dsaItem(set, settings, today) {
  if (!set.left) return null;
  const parts = [];
  if (set.reviews.length) parts.push(`${set.reviews.length} review${set.reviews.length === 1 ? '' : 's'}`);
  if (set.fresh.length) parts.push(`${set.fresh.length} new`);
  const days = settings.interviewDate ? daysBetween(today, settings.interviewDate) : null;
  const soon = days !== null && days >= 0 && days <= 14;
  return {
    key: 'dsa:today', src: 'dsa', kind: 'dsa', title: `DSA practice: ${parts.join(' + ')}`,
    sub: soon ? `Interview in ${days} day${days === 1 ? '' : 's'}` : 'Daily goal', due: null,
    impact: soon ? 0.85 : 0.55, undatedUrgency: 0.5, note: set.doneToday.length ? `${set.doneToday.length} done today` : '',
  };
}
