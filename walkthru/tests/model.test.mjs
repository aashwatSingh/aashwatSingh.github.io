import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState, addProperty, addUnit, upsertResident, openBedrooms, openInspection, isLocked, startSubmission,
  putEntry, coverage, evidenceOf, baselineOf, inspectionStatus, openInspectionFor, comparisonRows, approvedCharges,
  unitsOf, LOCK_HOURS,
} from '../js/core/model.js';
import { sealSubmission } from '../js/core/integrity.js';

const H = (c) => c.repeat(64);
const T0 = Date.parse('2026-08-20T15:00:00Z');
const entry = (key, at, condition = 'ok') => ({
  id: `e_${key.replace('.', '_')}_${at}`, key, condition, note: '',
  photo: { hash: H('a'), type: 'image/jpeg', width: 10, height: 10, capturedAt: new Date(T0 + at * 1000).toISOString(), serverTime: null, source: 'demo' },
});

function setup() {
  const s = emptyState();
  const p = addProperty(s, { name: 'Demo', city: 'Richardson' });
  const u = addUnit(s, { propertyId: p.id, label: '204', template: '2x2' });
  addUnit(s, { propertyId: p.id, label: '1010', template: 'studio' });
  addUnit(s, { propertyId: p.id, label: '33', template: 'studio' });
  return { s, p, u };
}

test('units sort by label, numbers in order', () => {
  const { s, p } = setup();
  assert.deepEqual(unitsOf(s, p.id).map((u) => u.label), ['33', '204', '1010']);
});

test('residents are matched, not duplicated', () => {
  const { u } = setup();
  const a = upsertResident(u, { name: 'Sam Lee', bedroom: 'A' });
  const again = upsertResident(u, { name: '  sam   lee ', bedroom: 'A' });
  assert.equal(a, again);
  upsertResident(u, { name: 'Sam Lee', bedroom: 'B' }); // a different person in another room
  assert.equal(u.residents.length, 2);
  assert.deepEqual(openBedrooms(u), []);
});

test('inspections lock after the window', () => {
  const { s, u } = setup();
  const i = openInspection(s, { unitId: u.id, kind: 'move-in', now: T0 });
  assert.equal(Date.parse(i.lockAt) - T0, LOCK_HOURS * 3600e3);
  assert.equal(isLocked(i, T0 + 1000), false);
  assert.equal(isLocked(i, Date.parse(i.lockAt)), true);
  assert.equal(openInspectionFor(s, u.id, 'move-in', T0 + 1000), i);
  assert.equal(openInspectionFor(s, u.id, 'move-in', Date.parse(i.lockAt) + 1), null);
  assert.equal(inspectionStatus(s, i, T0), 'collecting');
  assert.equal(inspectionStatus(s, i, Date.parse(i.lockAt)), 'locked');
});

test('submissions: coverage, sealing, evidence and baseline', async () => {
  const { s, u } = setup();
  const sam = upsertResident(u, { name: 'Sam', bedroom: 'A' });
  const jo = upsertResident(u, { name: 'Jo', bedroom: 'B' });
  const moveIn = openInspection(s, { unitId: u.id, kind: 'move-in', now: T0 });
  const sub = startSubmission(s, { inspection: moveIn, resident: sam, now: T0 });
  putEntry(sub, entry('living.walls', 1));
  putEntry(sub, entry('living.walls', 2, 'wear')); // a retake replaces the first shot
  putEntry(sub, entry('bedA.bwalls', 3));
  assert.equal(sub.entries.length, 2);
  const cov = coverage(u, sub);
  assert.equal(cov.done, 2);
  assert.ok(cov.missing.every((c) => c.area.id !== 'bedB'));
  assert.equal(inspectionStatus(s, moveIn, T0), 'collecting');

  s.submissions[sub.id] = await sealSubmission(sub, new Date(T0 + 60e3).toISOString());
  assert.throws(() => putEntry(s.submissions[sub.id], entry('kitchen.stove', 9)), /sealed/);
  assert.equal(inspectionStatus(s, moveIn, T0), 'ready');

  const sub2 = startSubmission(s, { inspection: moveIn, resident: jo, now: T0 + 5000 });
  putEntry(sub2, entry('living.walls', 0)); // Jo shot the shared wall first
  s.submissions[sub2.id] = await sealSubmission(sub2, new Date(T0 + 90e3).toISOString());
  const ev = evidenceOf(s, moveIn.id);
  assert.equal(ev['living.walls'].length, 2);
  assert.equal(ev['living.walls'][0].submission.residentName, 'Jo');

  const moveOut = openInspection(s, { unitId: u.id, kind: 'move-out', now: T0 + 86400e3 * 270 });
  assert.equal(baselineOf(s, moveOut), moveIn);
  assert.equal(baselineOf(s, moveIn), null);
  const rows = comparisonRows(s, moveOut);
  const walls = rows.find((r) => r.key === 'living.walls');
  assert.equal(walls.before.submission.residentName, 'Jo');
  assert.equal(walls.after, null);

  // Once the move-out is sealed, it becomes the next move-in's baseline.
  const out = startSubmission(s, { inspection: moveOut, resident: sam, now: T0 + 86400e3 * 270 });
  putEntry(out, entry('living.walls', 86400 * 270 + 10, 'damage'));
  s.submissions[out.id] = await sealSubmission(out, new Date(T0 + 86400e3 * 270 + 60e3).toISOString());
  const next = openInspection(s, { unitId: u.id, kind: 'move-in', now: T0 + 86400e3 * 280 });
  assert.equal(baselineOf(s, next), moveOut);
});

test('approved charges come out in checklist order with area labels', () => {
  const { s, u } = setup();
  const i = openInspection(s, { unitId: u.id, kind: 'move-out', now: T0 });
  i.review.decisions['bedA.bwalls'] = { action: 'charge', label: 'Paint', cents: 3500, responsible: ['r1'] };
  i.review.decisions['living.walls'] = { action: 'charge', label: 'Drywall', cents: 7500, responsible: [] };
  i.review.decisions['kitchen.stove'] = { action: 'wear' };
  const list = approvedCharges(s, i);
  assert.deepEqual(list.map((c) => c.label), ['Living room: Drywall', 'Bedroom A: Paint']);
});
