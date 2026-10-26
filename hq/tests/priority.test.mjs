import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreItem, rank, impactOf, taskItems, bucketOf, weekAhead, reasonsOf } from '../js/priority.js';

const NOW = new Date(2026, 9, 26, 9, 0).getTime(); // Mon Oct 26, 9 am local
const H = 36e5;
const hw = (hours, extra = {}) => ({ key: `h${hours}`, src: 'canvas', kind: 'assignment', title: 'HW', due: NOW + hours * H, weight: 2, ...extra });
const exam = (hours, extra = {}) => ({ key: `e${hours}`, src: 'canvas', kind: 'exam', title: 'Exam', due: NOW + hours * H, weight: 20, ...extra });

test('an exam worth 20% two days out outranks a 2% homework due tomorrow', () => {
  assert.ok(scoreItem(exam(48), NOW).score > scoreItem(hw(24), NOW).score);
  // The plan's worked examples.
  assert.ok(Math.abs(scoreItem(exam(120), NOW).score - 66) <= 2);
  assert.ok(Math.abs(scoreItem(hw(24), NOW).score - 50) <= 3);
  assert.ok(Math.abs(scoreItem(exam(48), NOW).score - 85) <= 3);
});

test('sooner beats later for the same work, and bigger beats smaller for the same time', () => {
  assert.ok(scoreItem(hw(6), NOW).score > scoreItem(hw(30), NOW).score);
  assert.ok(scoreItem(hw(30, { weight: 8 }), NOW).score > scoreItem(hw(30), NOW).score);
});

test('overdue unsubmitted work is urgent, then fades', () => {
  const fresh = scoreItem(hw(-20, { missing: true }), NOW);
  const old = scoreItem(hw(-24 * 20, { missing: true }), NOW);
  assert.equal(fresh.urgency, 1);
  assert.ok(old.score < fresh.score);
  assert.equal(fresh.reasons[0].t, 'missing');
});

test('a shaky course grade raises its work', () => {
  assert.ok(impactOf(hw(24, { courseScore: 72 })) > impactOf(hw(24, { courseScore: 91 })));
  assert.ok(reasonsOf(hw(24, { courseScore: 72 }), NOW).some((r) => r.t === 'grade' && r.v === 72));
});

test('kind fills in when there is no grade weight', () => {
  assert.ok(impactOf({ kind: 'exam' }) > impactOf({ kind: 'discussion' }));
  assert.equal(impactOf({ kind: 'exam', weight: 1 }), 0.85, 'exams never drop below 0.85');
  assert.equal(impactOf({ kind: 'mystery' }), 0.4);
});

test('rank drops done, past and calendar events, and sorts by score', () => {
  const items = [
    hw(24),
    exam(48),
    hw(5, { key: 'done', done: true }),
    { key: 'ev', src: 'canvas', kind: 'event', title: 'Office hours', due: NOW + 2 * H },
    { key: 'past', src: 'canvas', kind: 'page', title: 'Read', due: NOW - H, past: true },
  ];
  const r = rank(items, NOW);
  assert.deepEqual(r.map((i) => i.key), ['e48', 'h24']);
  assert.ok(r[0].reasons.some((x) => x.t === 'kind' && x.v === 'exam'));
  // Events still show in the week ahead.
  assert.equal(weekAhead(items, NOW)[0].count, 1);
});

test('taskItems: priority sets impact, no date means a steady pull', () => {
  const [p1, p3] = taskItems([
    { id: 'a', title: 'Register', cat: 'school', pri: 1, due: '', time: '', done: '' },
    { id: 'b', title: 'Groceries', cat: 'life', pri: 3, due: '2026-10-27', time: '', done: '' },
    { id: 'c', title: 'Done', cat: 'life', pri: 1, due: '', time: '', done: '2026-10-25T00:00:00Z' },
  ]);
  assert.equal(p1.impact, 0.9);
  assert.equal(p1.due, null);
  assert.equal(p3.due, new Date(2026, 9, 27, 23, 59, 59, 999).getTime());
  assert.equal(p3.sub, 'Life');
  assert.ok(scoreItem(p1, NOW).score > scoreItem({ ...p1, impact: 0.25, undatedUrgency: 0.3 }, NOW).score);
});

test('bucketOf groups by local day', () => {
  assert.equal(bucketOf(null, NOW), 'none');
  assert.equal(bucketOf(NOW - H, NOW), 'overdue');
  assert.equal(bucketOf(NOW + 5 * H, NOW), 'today');
  assert.equal(bucketOf(NOW + 20 * H, NOW), 'tomorrow');
  assert.equal(bucketOf(NOW + 4 * 24 * H, NOW), 'week');
  assert.equal(bucketOf(NOW + 9 * 24 * H, NOW), 'later');
});
