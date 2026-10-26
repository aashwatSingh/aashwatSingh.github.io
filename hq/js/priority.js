// What matters most: one 0-100 score for every open item, whatever it came from.
// See docs/PLAN.md §3 for the reasoning behind the numbers.

import { HOUR, keyOf, addDays, stamp } from './dates.js';

/** How much a kind of work matters when there's no grade weight to go on (0-1). */
export const KIND_IMPACT = {
  exam: 1, interview: 1, offer: 1, oa: 0.9, project: 0.75, quiz: 0.55, dsa: 0.55, application: 0.5,
  assignment: 0.45, note: 0.4, review: 0.35, discussion: 0.3, event: 0.3, followup: 0.3, page: 0.2,
};

export const TASK_IMPACT = { 1: 0.9, 2: 0.55, 3: 0.25 };

export const CATEGORIES = [
  { id: 'school', label: 'School' },
  { id: 'intern', label: 'Internship' },
  { id: 'dsa', label: 'DSA' },
  { id: 'life', label: 'Life' },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Hours of runway, divided by lead time, at which urgency falls to 1/e.
const TAU_HOURS = 72;

/** 0-1: how much finishing this changes your outcomes. */
export function impactOf(item) {
  let impact;
  if (typeof item.impact === 'number') impact = item.impact;
  else if (item.weight > 0) impact = clamp(0.15 + item.weight / 10, 0.15, 1);
  else impact = KIND_IMPACT[item.kind] ?? 0.4;
  if (item.kind === 'exam') impact = Math.max(impact, 0.85);
  if (typeof item.courseScore === 'number' && item.courseScore < 80) impact = Math.min(1, impact + 0.1);
  return impact;
}

/** 0-1: how soon it needs attention. Big work gets a longer runway, so it rises earlier. */
export function urgencyOf(item, impact, now) {
  if (item.due == null) return item.undatedUrgency ?? 0.3;
  const hours = (item.due - now) / HOUR;
  if (hours < 0) {
    const days = -hours / 24;
    return days <= 3 ? 1 : days <= 10 ? 0.75 : 0.45;
  }
  const lead = 1 + 3 * impact;
  return Math.exp(-hours / lead / TAU_HOURS);
}

/** Why an item ranked where it did, as structured reasons the page turns into words. */
export function reasonsOf(item, now) {
  const out = [];
  if (item.due != null && item.due < now) out.push({ t: item.missing ? 'missing' : 'overdue', ms: now - item.due });
  else if (item.due != null) out.push({ t: 'due', at: item.due });
  else if (item.missing) out.push({ t: 'missing', ms: null });
  if (item.weight > 0) out.push({ t: 'weight', v: item.weight });
  if (['exam', 'interview', 'oa', 'project', 'offer'].includes(item.kind)) out.push({ t: 'kind', v: item.kind });
  if (typeof item.courseScore === 'number' && item.courseScore < 80) out.push({ t: 'grade', v: item.courseScore });
  if (item.src === 'task' && item.pri === 1) out.push({ t: 'pri', v: 1 });
  if (item.note) out.push({ t: 'note', v: item.note });
  return out;
}

export function scoreItem(item, now) {
  const impact = impactOf(item);
  const urgency = urgencyOf(item, impact, now);
  return { score: Math.round(100 * urgency * (0.35 + 0.65 * impact)), impact, urgency, reasons: reasonsOf(item, now) };
}

/** True when an item still needs doing. */
export const isOpen = (item) => !item.done && !item.past;

/** Open and something you act on. Calendar events (office hours, lectures) are schedule, not tasks. */
export const isActionable = (item) => isOpen(item) && item.kind !== 'event';

/** Actionable items with their scores, most important first (ties: sooner first). */
export function rank(items, now) {
  return items.filter(isActionable)
    .map((item) => ({ ...item, ...scoreItem(item, now) }))
    .sort((a, b) => b.score - a.score || (a.due ?? Infinity) - (b.due ?? Infinity) || a.title.localeCompare(b.title));
}

/** Your own to-dos as items. */
export function taskItems(tasks) {
  const label = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));
  return tasks.filter((t) => !t.done).map((t) => ({
    key: `t:${t.id}`, src: 'task', kind: 'task', cat: t.cat, title: t.title, sub: label[t.cat] || '',
    due: t.due ? stamp(t.due, t.time) : null, impact: TASK_IMPACT[t.pri] ?? 0.55,
    undatedUrgency: t.pri === 1 ? 0.45 : 0.3, pri: t.pri, taskId: t.id,
  }));
}

/** Where a due time falls relative to now, for grouping lists. */
export function bucketOf(due, now) {
  if (due == null) return 'none';
  if (due < now) return 'overdue';
  const today = keyOf(now);
  const day = keyOf(due);
  if (day === today) return 'today';
  if (day === addDays(today, 1)) return 'tomorrow';
  if (day <= addDays(today, 6)) return 'week';
  return 'later';
}

export const BUCKETS = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Today' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'week', label: 'This week' },
  { id: 'later', label: 'Later' },
  { id: 'none', label: 'No date' },
];

/** The next `days` days with what's due on each and how heavy it is (sum of impact). */
export function weekAhead(items, now, days = 7) {
  const today = keyOf(now);
  const out = [];
  for (let i = 0; i < days; i++) {
    const key = addDays(today, i);
    const due = items.filter((it) => isOpen(it) && it.due != null && it.due >= now && keyOf(it.due) === key);
    out.push({ key, count: due.length, load: due.reduce((s, it) => s + impactOf(it), 0), items: due });
  }
  return out;
}
