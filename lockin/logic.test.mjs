import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COMMITMENTS, todayKey, pickIndex, addDays, daysBetween, weekStart, markOf, dayStatus, streak, keptRate,
  lessonsWatched, takeaways, weekStats, weeklyVerdict, truthContext, pickTruth, socialSuggestion, mergeDays,
} from './logic.js';
import { TRUTHS, SOCIAL_LADDER } from './truths.js';

const C = DEFAULT_COMMITMENTS;
const KEPT = { marks: { phone: 'min' }, focusMin: 10, counts: { intern: 1 } };
const PARTIAL = { marks: { phone: 'full' }, focusMin: 0, counts: { intern: 0 } };
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();

test('date helpers', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-10-12', '2027-05-15'), 215);
  assert.equal(weekStart('2026-10-12'), '2026-10-12'); // a Monday
  assert.equal(weekStart('2026-10-18'), '2026-10-12'); // Sunday belongs to the week before
});

test('todayKey: the day runs until 4 am', () => {
  assert.equal(todayKey(new Date(2026, 9, 13, 1, 30).getTime()), '2026-10-12');
  assert.equal(todayKey(new Date(2026, 9, 13, 4, 0).getTime()), '2026-10-13');
  assert.equal(pickIndex(5, 'x'), pickIndex(5, 'x'));
  assert.ok(pickIndex(5, 'x') >= 0 && pickIndex(5, 'x') < 5);
  assert.equal(pickIndex(0, 'x'), -1);
});

test('markOf: check, count and focus kinds', () => {
  const [phone, deep, intern] = C;
  assert.equal(markOf(phone, undefined), null);
  assert.equal(markOf(phone, { marks: { phone: 'full' } }), 'full');
  assert.equal(markOf(phone, { marks: { phone: 'miss' } }), 'miss');
  assert.equal(markOf(deep, { focusMin: 9 }), null);
  assert.equal(markOf(deep, { focusMin: 10 }), 'min');
  assert.equal(markOf(deep, { focusMin: 55 }), 'full');
  assert.equal(markOf(intern, { counts: { intern: 2 } }), 'min');
  assert.equal(markOf(intern, { counts: { intern: 3 } }), 'full');
  // A manual mark can raise a derived one, never lower it.
  assert.equal(markOf(deep, { focusMin: 0, marks: { deep: 'full' } }), 'full');
  assert.equal(markOf(deep, { focusMin: 12, marks: { deep: 'miss' } }), 'min');
});

test('dayStatus: kept only when every commitment is at least minimum', () => {
  assert.deepEqual(dayStatus(KEPT, C), { met: 3, full: 0, total: 3, kept: true });
  assert.deepEqual(dayStatus(PARTIAL, C), { met: 1, full: 1, total: 3, kept: false });
  assert.equal(dayStatus(undefined, C).kept, false);
  assert.equal(dayStatus(KEPT, []).kept, false);
});

const opts = (today, startDate = '2026-10-01') => ({ today, startDate, commitments: C });

test('streak: one miss is forgiven, two in a row break it', () => {
  const days = {
    '2026-10-01': KEPT, '2026-10-02': KEPT, '2026-10-03': PARTIAL, // single slip
    '2026-10-04': KEPT, '2026-10-05': KEPT,
  };
  let s = streak(days, opts('2026-10-05'));
  assert.equal(s.current, 4);
  assert.equal(s.keptDays, 4);
  assert.equal(s.comebacks, 1);
  assert.equal(s.states.get('2026-10-03'), 'slip');

  // 6th and 7th missed: broken. 8th kept starts again at 1.
  days['2026-10-08'] = KEPT;
  s = streak(days, opts('2026-10-08'));
  assert.equal(s.current, 1);
  assert.equal(s.longest, 4);
  assert.equal(s.comebacks, 2);
  assert.equal(s.states.get('2026-10-06'), 'missed');
  assert.equal(s.states.get('2026-10-07'), 'missed');
});

test('streak: today is pending, and a slip yesterday puts the streak at risk', () => {
  const days = { '2026-10-01': KEPT, '2026-10-02': KEPT };
  let s = streak(days, opts('2026-10-03'));
  assert.equal(s.current, 2);
  assert.equal(s.states.get('2026-10-03'), 'today');
  assert.equal(s.missedYesterday, false);

  s = streak(days, opts('2026-10-04'));
  assert.equal(s.current, 2);
  assert.equal(s.missedYesterday, true);
  assert.equal(s.atRisk, true);

  s = streak(days, opts('2026-10-05'));
  assert.equal(s.current, 0);
  assert.equal(s.atRisk, false);
});

test('streak: days before the start date are ignored', () => {
  const days = { '2026-09-28': KEPT, '2026-10-01': KEPT };
  const s = streak(days, opts('2026-10-01'));
  assert.equal(s.current, 1);
  assert.equal(s.keptDays, 1);
  assert.equal(s.missedYesterday, false); // yesterday was before the start
  assert.deepEqual(streak(days, opts('2026-09-30')), { ...streak({}, opts('2026-09-30')) });
  assert.equal(streak(days, opts('2026-09-30')).current, 0);
});

test('keptRate counts finished days since the start', () => {
  const days = { '2026-10-01': KEPT, '2026-10-02': PARTIAL, '2026-10-03': KEPT };
  assert.equal(keptRate(days, opts('2026-10-04')), 2 / 3);
  assert.equal(keptRate(days, opts('2026-10-01')), null);
});

const hamza = {
  version: 1,
  videos: {
    a: { watched: at(2026, 10, 12), takeaways: 'Discipline is trained\n- Lock in first\n' },
    b: { watched: at(2026, 10, 13), takeaways: '' },
    c: { watched: at(2026, 10, 5), takeaways: '  ' },
    d: { watched: null, takeaways: '• Ship it' },
  },
};

test('Hamza store: lessons watched in range and takeaway lines', () => {
  assert.equal(lessonsWatched(hamza, '2026-10-12', '2026-10-18'), 2);
  assert.equal(lessonsWatched(undefined, '2026-10-12', '2026-10-18'), 0);
  assert.deepEqual(takeaways(hamza).map((t) => t.text), ['Discipline is trained', 'Lock in first', 'Ship it']);
});

test('weekStats and weeklyVerdict', () => {
  const days = {
    '2026-10-12': { ...KEPT, counts: { intern: 3 }, focusMin: 50, urges: 2, social: [{ note: 'hi' }] },
    '2026-10-13': PARTIAL,
  };
  const s = weekStats(days, opts('2026-10-14'), hamza);
  assert.equal(s.from, '2026-10-12');
  assert.equal(s.daysElapsed, 3);
  assert.equal(s.keptDays, 1);
  assert.equal(s.focusMin, 50);
  assert.equal(s.urges, 2);
  assert.equal(s.social, 1);
  assert.deepEqual(s.counts, { intern: 3 });
  assert.equal(s.lessons, 2);
  assert.match(weeklyVerdict(s, { countTarget: 15 }), /behind pace: 3 of 7/);
  assert.match(weeklyVerdict({ ...s, lessons: 4 }), /^4 lessons watched, 1 day kept/);
  assert.match(weeklyVerdict({ ...s, keptDays: 3, todayKept: true }), /^3 for 3/);
});

test('weeklyVerdict: today is pending, not a slip', () => {
  const days = { '2026-10-12': { ...KEPT, counts: { intern: 3 } } };
  const tue = weekStats(days, opts('2026-10-13'), null);
  assert.equal(tue.todayKept, false);
  assert.doesNotMatch(weeklyVerdict(tue, { countTarget: 15 }), /slip/);
  const mon = weekStats({}, opts('2026-10-12'), null);
  assert.match(weeklyVerdict(mon, { countTarget: 15 }), /^Fresh week/);
  const wed = weekStats({ ...days, '2026-10-13': PARTIAL }, opts('2026-10-14'), null);
  assert.match(weeklyVerdict(wed), /^One slip so far/);
});

test('truthContext and pickTruth', () => {
  assert.equal(truthContext({ missedYesterday: true, current: 7, dateKey: '2026-10-13' }), 'miss');
  assert.equal(truthContext({ missedYesterday: false, current: 7, dateKey: '2026-10-13' }), 'streak');
  assert.equal(truthContext({ missedYesterday: false, current: 3, dateKey: '2026-10-12' }), 'monday');
  assert.equal(truthContext({ missedYesterday: false, current: 3, dateKey: '2026-10-13' }), null);

  const a = pickTruth(TRUTHS, { dateKey: '2026-10-13', tags: ['phone'] });
  assert.equal(a, pickTruth(TRUTHS, { dateKey: '2026-10-13', tags: ['phone'] }), 'same day, same message');
  assert.ok(a.tags.includes('phone'));
  assert.ok(pickTruth(TRUTHS, { dateKey: '2026-10-13', context: 'miss' }).tags.includes('miss'));
  // Context-only messages never leak into the everyday rotation.
  for (let i = 1; i <= 28; i++) {
    const t = pickTruth(TRUTHS, { dateKey: `2026-11-${String(i).padStart(2, '0')}` });
    assert.ok(!t.tags.some((g) => ['miss', 'streak', 'urge', 'monday'].includes(g)));
  }
  assert.equal(pickTruth([], { dateKey: '2026-10-13' }), null);
});

test('socialSuggestion climbs a rung every 5 reps and tops out', () => {
  assert.equal(socialSuggestion(SOCIAL_LADDER, 0, 'w').level, 1);
  assert.equal(socialSuggestion(SOCIAL_LADDER, 5, 'w').level, 2);
  assert.equal(socialSuggestion(SOCIAL_LADDER, 99, 'w').level, SOCIAL_LADDER.length);
  assert.ok(SOCIAL_LADDER[0].reps.includes(socialSuggestion(SOCIAL_LADDER, 2, 'w').text));
});

test('mergeDays keeps the newer copy and skips junk', () => {
  const local = { '2026-10-01': { win: 'old', updated: '2026-10-01T10:00:00Z' }, '2026-10-02': { win: 'mine', updated: '2026-10-02T10:00:00Z' } };
  const incoming = {
    '2026-10-01': { win: 'new', updated: '2026-10-01T12:00:00Z' },
    '2026-10-02': { win: 'stale', updated: '2026-10-02T09:00:00Z' },
    '2026-10-03': { win: 'added', updated: '2026-10-03T09:00:00Z' },
    'nope': { win: 'x' },
    '2026-10-04': null,
  };
  const { days, count } = mergeDays(local, incoming);
  assert.equal(count, 2);
  assert.equal(days['2026-10-01'].win, 'new');
  assert.equal(days['2026-10-02'].win, 'mine');
  assert.equal(days['2026-10-03'].win, 'added');
  assert.equal(days.nope, undefined);
});

test('review fixes: DST-safe day boundary, lessons by Lock In day, honest verdict wording', () => {
  // Wall-clock 4 am rule (these hold in any timezone, including DST nights).
  assert.equal(todayKey(new Date(2026, 10, 1, 3, 15).getTime()), '2026-10-31');
  assert.equal(todayKey(new Date(2026, 2, 8, 4, 30).getTime()), '2026-03-08');
  assert.equal(todayKey(new Date(2026, 2, 8, 3, 59).getTime()), '2026-03-07');

  // A lesson watched at 1:30 am Monday belongs to Sunday's Lock In day.
  const late = { videos: { x: { watched: new Date(2026, 9, 19, 1, 30).toISOString() } } };
  assert.equal(lessonsWatched(late, '2026-10-12', '2026-10-18'), 1);
  assert.equal(lessonsWatched(late, '2026-10-19', '2026-10-25'), 0);

  // Pace verdict names the real commitment and the real gap.
  const gym = [{ id: 'phone', label: 'P', kind: 'check' }, { id: 'gym', label: 'Gym sets', kind: 'count', full: 4, min: 1 }];
  const w = weekStats({ '2026-10-12': { counts: { gym: 1 } } }, { today: '2026-10-14', startDate: '2026-10-01', commitments: gym }, null);
  assert.equal(weeklyVerdict(w, { countTarget: 20, countLabel: 'Gym sets' }),
    'Gym sets are behind pace: 1 of 9 by now. 8 more today puts you back on track.');

  // Social line never says "weekend ahead" on the weekend.
  const sun = { from: '2026-10-12', weekday: 6, daysElapsed: 7, keptDays: 4, todayKept: false, counts: {}, lessons: 0, social: 0 };
  assert.match(weeklyVerdict(sun, { socialTarget: 3 }), /before the week ends/);
  assert.match(weeklyVerdict({ ...sun, weekday: 3, daysElapsed: 4, keptDays: 1 }, { socialTarget: 3 }), /weekend ahead/);
});
