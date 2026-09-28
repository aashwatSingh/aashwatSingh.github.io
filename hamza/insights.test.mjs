import test from 'node:test';
import assert from 'node:assert/strict';
import { activityByDay, streaks, heatmap, topicProgress, ratingSpread, projection, dayKey } from './insights.js';

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();

test('activityByDay groups by local day and ignores junk', () => {
  const days = activityByDay([at(2026, 9, 1, 8), at(2026, 9, 1, 20), at(2026, 9, 2), 'nope']);
  assert.equal(days.get('2026-09-01'), 2);
  assert.equal(days.get('2026-09-02'), 1);
  assert.equal(days.size, 2);
});

test('streaks: current survives until today ends, longest is tracked', () => {
  const days = activityByDay([at(2026, 9, 1), at(2026, 9, 2), at(2026, 9, 3), at(2026, 9, 10), at(2026, 9, 11)]);
  assert.deepEqual(streaks(days, '2026-09-11'), { current: 2, longest: 3 });
  assert.deepEqual(streaks(days, '2026-09-12'), { current: 2, longest: 3 }); // not watched yet today
  assert.deepEqual(streaks(days, '2026-09-13'), { current: 0, longest: 3 }); // missed a day
  assert.deepEqual(streaks(new Map(), '2026-09-13'), { current: 0, longest: 0 });
});

test('streaks cross month and year boundaries', () => {
  const days = activityByDay([at(2025, 12, 31), at(2026, 1, 1)]);
  assert.equal(streaks(days, '2026-01-01').current, 2);
});

test('heatmap shape, future cells and levels', () => {
  const days = activityByDay([at(2026, 9, 28), at(2026, 9, 28), at(2026, 9, 27)]); // Mon, Sun
  const cols = heatmap(days, '2026-09-28', 4);
  assert.equal(cols.length, 4);
  assert.ok(cols.every((c) => c.length === 7));
  const last = cols[3];
  assert.equal(last[0].key, '2026-09-27');
  assert.equal(last[1].key, '2026-09-28');
  assert.equal(last[1].level, 4);
  assert.equal(last[0].level, 2);
  assert.equal(last[2], null); // Tuesday is in the future
  assert.equal(cols[0][0].count, 0);
});

test('topicProgress sorts by lessons remaining', () => {
  const rows = topicProgress([
    { topic: 'A', watched: true }, { topic: 'A', watched: true },
    { topic: 'B', watched: false }, { topic: 'B', watched: true }, { topic: 'B', watched: false },
  ]);
  assert.deepEqual(rows.map((r) => r.topic), ['B', 'A']);
  assert.deepEqual(rows[0], { topic: 'B', total: 3, watched: 1 });
});

test('ratingSpread ignores unrated and invalid values', () => {
  const s = ratingSpread([5, 5, 3, 0, undefined, 9, 1.5]);
  assert.deepEqual(s.counts, [0, 0, 1, 0, 2]);
  assert.equal(s.n, 3);
  assert.ok(Math.abs(s.average - 13 / 3) < 1e-9);
  assert.equal(ratingSpread([]).average, null);
});

test('projection extrapolates recent pace', () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  const ts = Array.from({ length: 14 }, (_, i) => new Date(now - i * 2 * 864e5).toISOString()); // 14 in 28 days
  const p = projection({ remaining: 50, watchedTimestamps: ts, now });
  assert.equal(p.perWeek, 3.5);
  assert.equal(p.daysLeft, 100);
  assert.equal(projection({ remaining: 0, watchedTimestamps: ts, now }), null);
  assert.equal(projection({ remaining: 5, watchedTimestamps: [], now }), null);
  assert.equal(dayKey('garbage'), null);
});
