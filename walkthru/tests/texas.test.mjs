import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, daysBetween, refundStatus, RULES } from '../js/core/texas.js';

test('date maths crosses months and leap days', () => {
  assert.equal(addDays('2027-05-15', 30), '2027-06-14');
  assert.equal(addDays('2028-02-15', 30), '2028-03-16'); // 2028 is a leap year
  assert.equal(addDays('bad', 1), null);
  assert.equal(daysBetween('2027-05-15', '2027-06-14'), 30);
  assert.equal(daysBetween('2027-06-14', '2027-05-15'), -30);
});

test('refundStatus follows §92.103 and §92.107', () => {
  assert.deepEqual(refundStatus(null, '2027-05-20', true), { due: null, daysLeft: null, state: 'no-date' });
  assert.equal(refundStatus('2027-05-15', '2027-05-20', false).state, 'waiting-address');
  assert.deepEqual(refundStatus('2027-05-15', '2027-05-20', true), { due: '2027-06-14', daysLeft: 25, state: 'open' });
  assert.equal(refundStatus('2027-05-15', '2027-06-08', true).state, 'due-soon');
  assert.equal(refundStatus('2027-05-15', '2027-06-14', true).state, 'due-soon');
  assert.equal(refundStatus('2027-05-15', '2027-06-15', true).state, 'overdue');
});

test('every rule cites a section', () => {
  for (const r of RULES) assert.match(r.cite, /^§92\.\d{3}/);
});
