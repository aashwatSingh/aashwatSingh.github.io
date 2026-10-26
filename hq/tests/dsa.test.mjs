import test from 'node:test';
import assert from 'node:assert/strict';
import { PATTERNS, PROBLEMS } from '../js/problems.js';
import { practice, undo, nextNew, todaysSet, dueReviews, readiness, patternProgress, dsaItem, allProblems, INTERVALS } from '../js/dsa.js';
import { addDays } from '../js/dates.js';

const D0 = '2026-10-01';
const empty = () => ({ problems: {}, log: {}, custom: [] });

test('the core set: 150 unique problems, every pattern filled, valid difficulty', () => {
  assert.equal(PROBLEMS.length, 150);
  assert.equal(new Set(PROBLEMS.map((p) => p.slug)).size, 150);
  for (const p of PROBLEMS) {
    assert.match(p.slug, /^[a-z0-9-]+$/);
    assert.ok(['E', 'M', 'H'].includes(p.diff), p.slug);
    assert.equal(p.url, `https://leetcode.com/problems/${p.slug}/`);
  }
  for (const pat of PATTERNS) assert.ok(pat.problems.length > 0, pat.id);
});

test('Solid steps up the intervals, Shaky holds, Needed help resets', () => {
  let d = practice(empty(), 'two-sum', 3, D0);
  assert.equal(d.problems['two-sum'].due, addDays(D0, INTERVALS[1]), 'a first clean solve comes back in 3 days');
  let day = d.problems['two-sum'].due;
  d = practice(d, 'two-sum', 3, day);
  assert.equal(d.problems['two-sum'].due, addDays(day, 7));
  day = d.problems['two-sum'].due;
  d = practice(d, 'two-sum', 2, day);
  assert.equal(d.problems['two-sum'].due, addDays(day, 7), 'shaky repeats the step');
  day = d.problems['two-sum'].due;
  d = practice(d, 'two-sum', 1, day);
  assert.equal(d.problems['two-sum'].due, addDays(day, 1), 'needed help resets');
  assert.equal(d.problems['two-sum'].n, 4);
  assert.equal(d.problems['two-sum'].first, D0);
  assert.equal(Object.values(d.log).reduce((a, b) => a + b, 0), 4);
});

test('a second mark on the same day replaces the first instead of stepping twice', () => {
  let d = practice(empty(), 'two-sum', 3, D0);
  const day = d.problems['two-sum'].due;
  d = practice(d, 'two-sum', 3, day);
  d = practice(d, 'two-sum', 3, day);
  d = practice(d, 'two-sum', 3, day);
  assert.equal(d.problems['two-sum'].due, addDays(day, 7));
  assert.equal(d.log[day], 1);
  d = practice(d, 'two-sum', 1, day);
  assert.equal(d.problems['two-sum'].due, addDays(day, 1));
  assert.equal(d.problems['two-sum'].n, 2);
});

test('undo goes back to this morning, or clears an older mark', () => {
  let d = practice(empty(), 'two-sum', 2, D0);
  const back = undo(d, 'two-sum', D0);
  assert.deepEqual(back.problems, {});
  assert.deepEqual(back.log, {});
  const day = d.problems['two-sum'].due;
  const before = d.problems['two-sum'];
  d = practice(d, 'two-sum', 3, day);
  const restored = undo(d, 'two-sum', day);
  assert.equal(restored.problems['two-sum'].due, before.due);
  assert.equal(restored.problems['two-sum'].last, D0);
  assert.equal(restored.log[day], undefined);
  assert.deepEqual(undo(practice(empty(), 'two-sum', 3, D0), 'two-sum', '2026-12-01').problems, {});
});

test('nextNew follows learning order, skips premium and holds hards back', () => {
  assert.deepEqual(nextNew(PROBLEMS, {}, 3).map((p) => p.slug), ['contains-duplicate', 'valid-anagram', 'two-sum']);
  const states = {};
  for (const p of PATTERNS[0].problems) states[p[0]] = { st: 'solved', conf: 3, due: '2030-01-01' };
  const picks = nextNew(PROBLEMS, states, 5).map((p) => p.slug);
  assert.ok(!picks.includes('trapping-rain-water'), 'no hard before two mediums in its pattern');
  assert.ok(!PROBLEMS.filter((p) => picks.includes(p.slug)).some((p) => p.premium));
  assert.ok(!nextNew(PROBLEMS, {}, 20).some((p) => p.slug === 'encode-and-decode-strings'));
});

test("today's set: due reviews plus new problems, minus what's done", () => {
  let d = empty();
  for (const slug of ['contains-duplicate', 'valid-anagram', 'two-sum', 'group-anagrams']) d = practice(d, slug, 2, D0);
  const tomorrow = addDays(D0, 1);
  const settings = { dailyNew: 2, dailyReview: 3 };
  let set = todaysSet(d, settings, tomorrow);
  assert.equal(set.dueCount, 4);
  assert.equal(set.reviews.length, 3);
  assert.equal(set.fresh.length, 2);
  d = practice(d, set.reviews[0].slug, 3, tomorrow);
  d = practice(d, set.fresh[0].slug, 3, tomorrow);
  set = todaysSet(d, settings, tomorrow);
  assert.equal(set.reviews.length, 2);
  assert.equal(set.fresh.length, 1);
  assert.equal(set.doneToday.length, 2);
  assert.equal(dueReviews(PROBLEMS, d.problems, tomorrow).length, 3);
});

test('readiness rewards breadth: 0 empty, 100 when every pattern is covered', () => {
  assert.equal(readiness(PROBLEMS, {}, D0), 0);
  const all = Object.fromEntries(PROBLEMS.map((p) => [p.slug, { st: 'solved', conf: 3, due: D0 }]));
  assert.equal(readiness(PROBLEMS, all, D0), 100);
  const oneTopic = Object.fromEntries(PROBLEMS.filter((p) => p.pattern === 'arrays').map((p) => [p.slug, { st: 'solved', conf: 3, due: D0 }]));
  assert.equal(readiness(PROBLEMS, oneTopic, D0), Math.round(100 / PATTERNS.length));
  const prog = patternProgress(PROBLEMS, oneTopic);
  assert.deepEqual(prog[0], { id: 'arrays', name: 'Arrays & Hashing', total: 9, solved: 9, solid: 9 });
});

test('dsaItem rises when an interview is close', () => {
  const set = { reviews: [{}], fresh: [{}, {}], doneToday: [], left: 3 };
  const calm = dsaItem(set, { interviewDate: '' }, D0);
  const close = dsaItem(set, { interviewDate: addDays(D0, 3) }, D0);
  assert.equal(calm.title, 'DSA practice: 1 review + 2 new');
  assert.ok(close.impact > calm.impact);
  assert.equal(close.sub, 'Interview in 3 days');
  assert.equal(dsaItem({ ...set, left: 0 }, {}, D0), null);
});

test('custom problems slot in at the end of their pattern', () => {
  const list = allProblems([{ slug: 'my-one', title: 'Mine', diff: 'M', pattern: 'arrays', url: '' }]);
  assert.equal(list.length, 151);
  assert.equal(list[9].slug, 'my-one');
  assert.equal(list[10].pattern, 'two-pointers');
});
