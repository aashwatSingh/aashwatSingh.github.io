import test from 'node:test';
import assert from 'node:assert/strict';
import { channelDocs, pendingDocs, mergeDoc, applyDoc, emptyMeta, docKey, docHash } from '../js/core/syncdocs.js';
import { emptyState, addProperty, addUnit, upsertResident, openInspection, startSubmission } from '../js/core/model.js';

const T0 = Date.parse('2027-05-14T15:00:00Z');

function setup() {
  const s = emptyState();
  const p = addProperty(s, { id: 'p_1', name: 'Hall' });
  const u = addUnit(s, { id: 'u_1', propertyId: p.id, label: '1', template: '1x1' });
  const u2 = addUnit(s, { id: 'u_2', propertyId: p.id, label: '2', template: '1x1' });
  const sam = upsertResident(u, { id: 'r_1', name: 'Sam', bedroom: 'A', depositCents: 50000 });
  const insp = openInspection(s, { id: 'i_1', unitId: u.id, kind: 'move-out', now: T0 });
  openInspection(s, { id: 'i_2', unitId: u2.id, kind: 'move-out', now: T0 });
  const draft = startSubmission(s, { id: 's_draft', inspection: insp, resident: sam, now: T0 });
  s.submissions.s_sealed = { ...draft, id: 's_sealed', seal: 'a'.repeat(64), head: 'b'.repeat(64), submittedAt: new Date(T0).toISOString() };
  const demo = addProperty(s, { id: 'p_demo', name: 'Demo', demo: true });
  addUnit(s, { id: 'u_demo', propertyId: demo.id, label: '9', template: 'studio' });
  return s;
}

const ids = (docs) => docs.map((d) => docKey(d.kind, d.id)).sort();

test('the office channel covers real records, sealed only, never the demo', () => {
  const s = setup();
  assert.deepEqual(ids(channelDocs(s, {})), ['inspection:i_1', 'inspection:i_2', 'property:p_1', 'submission:s_sealed', 'unit:u_1', 'unit:u_2']);
});

test('a door-code channel covers one unit\'s inspections and sealed submissions', () => {
  const s = setup();
  assert.deepEqual(ids(channelDocs(s, { unitId: 'u_1' })), ['inspection:i_1', 'submission:s_sealed']);
  assert.deepEqual(ids(channelDocs(s, { unitId: 'u_demo' })), []);
});

test('pendingDocs lists only what changed since the last sync', async () => {
  const s = setup();
  const meta = emptyMeta();
  const first = await pendingDocs(s, {}, meta);
  assert.equal(first.length, 6);
  for (const d of first) meta.synced[docKey(d.kind, d.id)] = d.hash;
  assert.equal((await pendingDocs(s, {}, meta)).length, 0);
  s.units.u_1.residents[0].depositCents = 45000;
  assert.deepEqual(ids(await pendingDocs(s, {}, meta)), ['unit:u_1']);
});

test('merge: residents are unioned and a redacted deposit never wipes a real one', () => {
  const local = { id: 'u_1', label: '1', residents: [{ id: 'r_1', name: 'Sam', depositCents: 50000 }, { id: 'r_2', name: 'Jo', depositCents: 0 }] };
  const remote = { id: 'u_1', label: '1B', residents: [{ id: 'r_1', name: 'Sam L', depositCents: 0 }, { id: 'r_3', name: 'Ali', depositCents: 1 }] };
  const { body } = mergeDoc('unit', local, remote);
  assert.equal(body.label, '1B');
  assert.deepEqual(body.residents.map((r) => [r.id, r.name, r.depositCents]), [['r_1', 'Sam L', 50000], ['r_3', 'Ali', 1], ['r_2', 'Jo', 0]]);
});

test('merge: staff decisions keep the later one per item', () => {
  const local = { id: 'i_1', surrenderDate: '2027-05-15', forwarding: { r_1: true }, review: { decisions: { a: { action: 'charge', decidedAt: '2027-05-20T10:00:00Z' }, b: { action: 'wear', decidedAt: '2027-05-20T10:00:00Z' } }, finalizedAt: null } };
  const remote = { id: 'i_1', surrenderDate: null, forwarding: { r_2: true }, review: { decisions: { a: { action: 'dismiss', decidedAt: '2027-05-20T09:00:00Z' }, c: { action: 'charge', decidedAt: '2027-05-21T00:00:00Z' } }, finalizedAt: '2027-05-22T00:00:00Z' } };
  const { body } = mergeDoc('inspection', local, remote);
  assert.equal(body.review.decisions.a.action, 'charge'); // local was later
  assert.ok(body.review.decisions.b && body.review.decisions.c);
  assert.equal(body.surrenderDate, '2027-05-15');
  assert.deepEqual(body.forwarding, { r_1: true, r_2: true });
  assert.equal(body.review.finalizedAt, '2027-05-22T00:00:00Z');
});

test('merge: a sealed submission with a different seal is a conflict and stays local', () => {
  const local = { id: 's', seal: 'a'.repeat(64) };
  assert.deepEqual(mergeDoc('submission', local, { id: 's', seal: 'b'.repeat(64) }), { body: local, conflict: true });
});

test('applyDoc: add, replace when unchanged here, merge when both changed', async () => {
  const s = setup();
  const meta = emptyMeta();
  // New document.
  const prop = { id: 'p_2', name: 'Annex', city: '', state: 'TX', rates: [] };
  assert.equal(await applyDoc(s, meta, { kind: 'property', id: 'p_2', body: prop }), 'added');
  // Unchanged here since the last sync: the server copy replaces it.
  meta.synced['unit:u_2'] = await docHash(s.units.u_2);
  const held = s.units.u_2; // a screen holding the record
  assert.equal(await applyDoc(s, meta, { kind: 'unit', id: 'u_2', body: { ...s.units.u_2, label: '2B' } }), 'replaced');
  assert.equal(s.units.u_2.label, '2B');
  assert.equal(s.units.u_2, held); // updated in place, not swapped
  // Changed here too: merged, and the merged copy is pending for the next push.
  meta.synced['unit:u_1'] = 'stale';
  const remoteUnit = { ...s.units.u_1, residents: [{ id: 'r_9', name: 'New', bedroom: null, depositCents: 0 }] };
  assert.equal(await applyDoc(s, meta, { kind: 'unit', id: 'u_1', body: remoteUnit }), 'merged');
  assert.equal(s.units.u_1.residents.length, 2);
  assert.ok((await pendingDocs(s, {}, meta)).some((d) => d.id === 'u_1'));
  // Identical: kept.
  assert.equal(await applyDoc(s, meta, { kind: 'property', id: 'p_2', body: prop }), 'kept');
});

test('applyDoc: a pulled submission adds its resident to the unit', async () => {
  const s = setup();
  const sub = { id: 's_new', inspectionId: 'i_2', unitId: 'u_2', kind: 'move-out', residentId: 'r_77', residentName: 'Lee ', bedroom: 'A', seal: 'c'.repeat(64), entries: [] };
  assert.equal(await applyDoc(s, emptyMeta(), { kind: 'submission', id: sub.id, body: sub }), 'added');
  assert.deepEqual(s.units.u_2.residents.map((r) => [r.id, r.name]), [['r_77', 'Lee']]);
});
