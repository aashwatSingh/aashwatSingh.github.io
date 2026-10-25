import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeDoor, decodeDoor, buildRecord, readRecord, bytesToBase64, base64ToBytes } from '../js/core/payload.js';
import { sealSubmission, sha256Hex, verifySubmission } from '../js/core/integrity.js';

const property = { id: 'p_demo', name: 'Maple Court (demo)', city: 'Richardson', state: 'TX' };
const unit = { id: 'u_204', label: '204', template: '2x2' };

test('door payload round-trips and rejects junk', () => {
  const s = encodeDoor({ property, unit });
  assert.match(s, /^[\w-]+$/);
  const d = decodeDoor(s);
  assert.equal(d.property.name, 'Maple Court (demo)');
  assert.equal(d.unit.template, '2x2');
  assert.equal(d.unit.propertyId, 'p_demo');
  assert.equal(decodeDoor('not base64!'), null);
  assert.equal(decodeDoor('e30'), null); // {}
  const bad = Buffer.from(JSON.stringify({ v: 1, pid: 'p', pn: 'x', uid: 'u', ul: '1', t: 'castle' })).toString('base64url');
  assert.equal(decodeDoor(bad), null);
  assert.equal(decodeDoor(123), null);
});

test('base64 helpers handle large binary', () => {
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});

async function sealed() {
  const jpg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const hash = await sha256Hex(jpg);
  const sub = await sealSubmission({
    id: 's_1', inspectionId: 'i_1', unitId: unit.id, kind: 'move-out', residentId: 'r_1', residentName: 'Sam ',
    bedroom: 'A', startedAt: '2027-05-14T15:00:00.000Z', submittedAt: null, head: null, seal: null,
    entries: [{ id: 'e_1', key: 'living.walls', condition: 'damage', note: ' scuff ', photo: { hash, type: 'image/jpeg', width: 640, height: 480, capturedAt: '2027-05-14T15:01:00.000Z', serverTime: '2027-05-14T15:01:01.000Z', source: 'camera' } }],
  }, '2027-05-14T15:05:00.000Z');
  const inspection = { id: 'i_1', kind: 'move-out', openedAt: '2027-05-14T14:00:00.000Z', lockAt: '2027-05-16T14:00:00.000Z' };
  return { sub, jpg, hash, inspection };
}

test('a record file round-trips through JSON and still verifies', async () => {
  const { sub, jpg, hash, inspection } = await sealed();
  const file = JSON.parse(JSON.stringify(buildRecord({ property, unit, inspection, submission: sub, photos: { [hash]: { type: 'image/jpeg', bytes: jpg } }, exportedAt: '2027-05-14T15:06:00.000Z' })));
  const res = readRecord(file);
  assert.equal(res.ok, true, res.error);
  const r = res.record;
  assert.equal(r.submission.residentName, 'Sam '); // exact strings are kept: the seal covers them
  assert.deepEqual(r.photos[hash].bytes, jpg);
  const v = await verifySubmission(r.submission, async (h) => r.photos[h]?.bytes || null);
  assert.deepEqual(v, { ok: true, problems: [] });
});

test('readRecord rejects malformed or tampered files', async () => {
  const { sub, jpg, hash, inspection } = await sealed();
  const good = () => JSON.parse(JSON.stringify(buildRecord({ property, unit, inspection, submission: sub, photos: { [hash]: { type: 'image/jpeg', bytes: jpg } }, exportedAt: '2027-05-14T15:06:00.000Z' })));
  assert.equal(readRecord(null).ok, false);
  assert.equal(readRecord({ format: 'other' }).ok, false);

  const html = good();
  html.photos[hash] = 'data:text/html;base64,PHNjcmlwdD4=';
  assert.equal(readRecord(html).ok, false);

  const wrongUnit = good();
  wrongUnit.submission.unitId = 'u_other';
  assert.equal(readRecord(wrongUnit).ok, false);

  const badEntry = good();
  badEntry.submission.entries[0].condition = 'great';
  assert.equal(readRecord(badEntry).ok, false);

  // Shape is fine but the photo was swapped: readRecord accepts it, verification catches it.
  const swapped = good();
  swapped.photos[hash] = `data:image/jpeg;base64,${bytesToBase64(new Uint8Array([0xff, 0xd8, 9, 9, 9, 0xff, 0xd9]))}`;
  const res = readRecord(swapped);
  assert.equal(res.ok, true);
  const v = await verifySubmission(res.record.submission, async (h) => res.record.photos[h]?.bytes || null);
  assert.equal(v.ok, false);
});
