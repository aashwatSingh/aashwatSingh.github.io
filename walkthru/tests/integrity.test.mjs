import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sha256Hex, canonical, chainEntries, sealSubmission, verifySubmission, GENESIS, shortHash, isHash,
} from '../js/core/integrity.js';

const photo = (hash, at) => ({ hash, type: 'image/jpeg', width: 640, height: 480, capturedAt: at, serverTime: null, source: 'camera' });

async function sampleSubmission() {
  const bytes = { a: new Uint8Array([1, 2, 3]), b: new Uint8Array([4, 5, 6]) };
  const ha = await sha256Hex(bytes.a);
  const hb = await sha256Hex(bytes.b);
  const sub = {
    id: 's_1', inspectionId: 'i_1', unitId: 'u_1', kind: 'move-in', residentId: 'r_1', residentName: 'Sam',
    bedroom: 'A', startedAt: '2026-08-20T15:00:00.000Z', submittedAt: null, head: null, seal: null,
    entries: [
      // Out of order on purpose: the chain sorts by capture time.
      { id: 'e_2', key: 'kitchen.stove', condition: 'ok', note: '', photo: photo(hb, '2026-08-20T15:02:00.000Z') },
      { id: 'e_1', key: 'living.walls', condition: 'wear', note: 'small mark', photo: photo(ha, '2026-08-20T15:01:00.000Z') },
    ],
  };
  const sealed = await sealSubmission(sub, '2026-08-20T15:10:00.000Z');
  const store = { [ha]: bytes.a, [hb]: bytes.b };
  return { sealed, store, ha };
}

test('sha256Hex matches known vectors', async () => {
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex(new Uint8Array([97, 98, 99])), await sha256Hex('abc'));
  assert.ok(isHash(GENESIS));
  assert.equal(shortHash('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'), 'ba78 16bf');
  assert.equal(shortHash('nope'), '—');
});

test('canonical JSON sorts keys and drops undefined', () => {
  assert.equal(canonical({ b: 1, a: { d: [1, undefined, 'x'], c: undefined } }), '{"a":{"d":[1,null,"x"]},"b":1}');
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
  assert.equal(canonical(NaN), 'null');
});

test('chain links entries in capture order', async () => {
  const { sealed } = await sampleSubmission();
  assert.deepEqual(sealed.entries.map((e) => e.id), ['e_1', 'e_2']);
  assert.equal(sealed.entries[0].prev, GENESIS);
  assert.equal(sealed.entries[1].prev, sealed.entries[0].hash);
  assert.equal(sealed.head, sealed.entries[1].hash);
  assert.ok(isHash(sealed.seal));
  const again = await chainEntries(sealed.entries);
  assert.equal(again.head, sealed.head);
});

test('an untouched submission verifies, photos included', async () => {
  const { sealed, store } = await sampleSubmission();
  const res = await verifySubmission(sealed, async (h) => store[h] || null);
  assert.deepEqual(res, { ok: true, problems: [] });
});

test('one changed byte in a photo fails verification', async () => {
  const { sealed, store, ha } = await sampleSubmission();
  const altered = { ...store, [ha]: new Uint8Array([1, 2, 4]) };
  const res = await verifySubmission(sealed, async (h) => altered[h] || null);
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /photo was altered/);
  const missing = await verifySubmission(sealed, async () => null);
  assert.match(missing.problems.join(' '), /photo is missing/);
});

test('edited, removed or reordered entries fail verification', async () => {
  const { sealed } = await sampleSubmission();
  const edited = structuredClone(sealed);
  edited.entries[0].condition = 'ok';
  assert.match((await verifySubmission(edited)).problems.join(' '), /changed after sealing/);

  const removed = structuredClone(sealed);
  removed.entries.shift();
  assert.equal((await verifySubmission(removed)).ok, false);

  const reordered = structuredClone(sealed);
  reordered.entries.reverse();
  assert.match((await verifySubmission(reordered)).problems.join(' '), /chain link is broken/);

  const renamed = structuredClone(sealed);
  renamed.residentName = 'Someone else';
  assert.match((await verifySubmission(renamed)).problems.join(' '), /Seal does not match/);

  assert.equal((await verifySubmission(null)).ok, false);
});
