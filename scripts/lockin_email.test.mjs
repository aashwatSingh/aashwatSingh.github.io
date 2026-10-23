import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FOCUS, SITE, centralTime, composeEmail, slotForSchedule } from './lockin_email.mjs';
import { TRUTHS } from '../lockin/truths.js';

const utc = (iso) => new Date(`${iso}Z`);
const addDays = (key, n) => new Date(Date.parse(`${key}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const CRONS = [...readFileSync(new URL('../.github/workflows/lockin-email.yml', import.meta.url), 'utf8')
  .matchAll(/cron: '([^']+)'/g)].map((m) => m[1]);

test('centralTime follows daylight saving', () => {
  assert.deepEqual(centralTime(utc('2026-10-23T12:43:00')), { dateKey: '2026-10-23', hour: 7 }); // CDT
  assert.deepEqual(centralTime(utc('2026-12-01T12:43:00')), { dateKey: '2026-12-01', hour: 6 }); // CST
  assert.deepEqual(centralTime(utc('2026-10-24T03:13:00')), { dateKey: '2026-10-23', hour: 22 });
});

test('slotForSchedule: exactly one cron per email sends each day, all year', () => {
  assert.equal(CRONS.length, 4);
  // Every day for a year, including both DST changes, started 20 minutes late as GitHub often does.
  for (let d = 0; d < 366; d++) {
    const day = new Date(Date.UTC(2026, 0, 1) + d * 864e5);
    const sent = { morning: [], night: [] };
    for (const cron of CRONS) {
      const [m, h] = cron.split(' ').map(Number);
      const started = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m + 20));
      const due = slotForSchedule(cron, started);
      if (due) sent[due.slot].push(due.dateKey);
    }
    assert.equal(sent.morning.length, 1, `one morning email on UTC day ${day.toISOString().slice(0, 10)}`);
    assert.equal(sent.night.length, 1, `one night email on UTC day ${day.toISOString().slice(0, 10)}`);
  }
});

test('slotForSchedule: picks the right offset and the Central date', () => {
  assert.deepEqual(slotForSchedule('43 12 * * *', utc('2026-10-23T12:50:00')), { slot: 'morning', dateKey: '2026-10-23' });
  assert.equal(slotForSchedule('43 13 * * *', utc('2026-10-23T13:50:00')), null); // 8:43 am in CDT
  assert.deepEqual(slotForSchedule('43 13 * * *', utc('2026-12-01T13:50:00')), { slot: 'morning', dateKey: '2026-12-01' });
  // The night email belongs to the Central evening, the UTC day before.
  assert.deepEqual(slotForSchedule('13 3 * * *', utc('2026-10-24T03:20:00')), { slot: 'night', dateKey: '2026-10-23' });
  assert.deepEqual(slotForSchedule('13 4 * * *', utc('2026-12-02T04:20:00')), { slot: 'night', dateKey: '2026-12-01' });
  // Delayed past midnight UTC, it still counts from when it was due.
  assert.deepEqual(slotForSchedule('43 12 * * *', utc('2026-10-24T00:10:00')), { slot: 'morning', dateKey: '2026-10-23' });
  assert.throws(() => slotForSchedule('@daily', new Date()), /Unrecognised/);
});

test('morning email: weekday focus, a message, a challenge and the links', () => {
  const e = composeEmail('morning', '2026-10-13'); // a Tuesday
  assert.equal(e.subject, 'Lock In · Tuesday: The phone');
  const truth = e.text.split('\n\n')[1];
  assert.ok(TRUTHS.some((t) => t.text === truth && t.tags.includes('phone')), truth);
  assert.match(e.text, /\nToday’s challenge: \S/);
  assert.ok(e.text.endsWith(`Open Lock In: ${SITE}\nAbout to slip? ${SITE}#slip`));
  assert.match(composeEmail('morning', '2026-10-18').text, /Open Lock In: \S+#progress/); // Sunday
  assert.deepEqual(composeEmail('morning', '2026-10-13'), e, 'the same date always gives the same email');
});

test('morning email: every weekday has its own focus and enough to say', () => {
  const subjects = new Set();
  for (let d = 12; d <= 18; d++) subjects.add(composeEmail('morning', `2026-10-${d}`).subject);
  assert.equal(subjects.size, 7);
  for (const f of FOCUS) {
    assert.ok(TRUTHS.some((t) => t.tags.includes(f.tag)), `messages tagged ${f.tag}`);
    assert.ok(f.challenges.length >= 4, `${f.name} has at least 4 challenges`);
  }
});

test('morning email: a weekday rotates through its messages before repeating', () => {
  const pool = TRUTHS.filter((t) => t.tags.includes('phone')).length;
  const tuesdays = Array.from({ length: pool }, (_, i) => composeEmail('morning', addDays('2026-10-13', 7 * i)));
  assert.equal(new Set(tuesdays.map((e) => e.text.split('\n\n')[1])).size, pool);
});

test('night email: review steps and a link to the review', () => {
  const e = composeEmail('night', '2026-10-23');
  assert.equal(e.subject, 'Lock In · Friday night: close the day');
  assert.match(e.text, /One win/);
  assert.match(e.text, /Tomorrow’s One Thing/);
  assert.ok(e.text.endsWith(`Close the day: ${SITE}#review`));
  assert.notEqual(composeEmail('night', '2026-10-24').text, e.text);
  assert.throws(() => composeEmail('noon', '2026-10-23'), /Unknown email/);
});
