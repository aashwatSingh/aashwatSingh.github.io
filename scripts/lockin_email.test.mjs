import test from 'node:test';
import assert from 'node:assert/strict';
import { FOCUS, SITE, centralTime, composeEmail } from './lockin_email.mjs';
import { TRUTHS } from '../lockin/truths.js';

const utc = (iso) => new Date(`${iso}Z`);
const addDays = (key, n) => new Date(Date.parse(`${key}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

test('centralTime follows daylight saving', () => {
  assert.deepEqual(centralTime(utc('2026-10-23T12:43:00')), { dateKey: '2026-10-23', hour: 7 }); // CDT
  assert.deepEqual(centralTime(utc('2026-12-01T12:43:00')), { dateKey: '2026-12-01', hour: 6 }); // CST
  assert.deepEqual(centralTime(utc('2026-10-24T03:13:00')), { dateKey: '2026-10-23', hour: 22 });
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
