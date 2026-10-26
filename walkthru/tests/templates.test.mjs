import test from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, ROOM_ITEMS, checklist, checklistFor, bedroomsOf, itemByKey } from '../js/core/templates.js';
import { DEFAULT_RATES, cleanRates, rateById } from '../js/core/rates.js';

test('every template expands to unique item keys', () => {
  for (const id of Object.keys(TEMPLATES)) {
    const keys = checklist(id).map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length, id);
    for (const k of keys) assert.match(k, /^[\w-]+\.[\w-]+$/);
  }
  assert.deepEqual(checklist('nope'), []);
});

test('bedrooms and per-resident checklists', () => {
  assert.deepEqual(bedroomsOf('4x2'), ['A', 'B', 'C', 'D']);
  assert.deepEqual(bedroomsOf('studio'), []);
  const mine = checklistFor('2x2', 'A');
  assert.ok(mine.some((c) => c.area.id === 'bedA'));
  assert.ok(!mine.some((c) => c.area.id === 'bedB'));
  assert.ok(mine.some((c) => c.area.id === 'kitchen'));
  assert.equal(checklistFor('2x2', null).length, checklist('2x2').length);
  assert.equal(itemByKey('2x2', 'bath2.mirror').item.label, 'Mirror');
  assert.equal(itemByKey('2x2', 'bath9.mirror'), null);
});

test('every item points at rates that exist', () => {
  for (const items of Object.values(ROOM_ITEMS)) {
    for (const item of items) {
      assert.ok(item.rates.length, item.id);
      for (const r of item.rates) assert.ok(rateById(DEFAULT_RATES, r), `${item.id} → ${r}`);
    }
  }
});

test('cleanRates keeps valid rows only', () => {
  const out = cleanRates([
    { id: 'a', label: ' Paint ', cents: 1234.4 },
    { id: 'a', label: 'Dup', cents: 1 },
    { id: 'bad id!', label: 'x', cents: 1 },
    { id: 'b', label: '', cents: 1 },
    { id: 'c', label: 'Huge', cents: 9e9 },
    { id: 'd', label: 'Negative', cents: -5 },
    null,
  ]);
  assert.deepEqual(out, [
    { id: 'a', label: 'Paint', cents: 1234 },
    { id: 'c', label: 'Huge', cents: 1_000_000 },
    { id: 'd', label: 'Negative', cents: 0 },
  ]);
  assert.equal(cleanRates('nope').length, DEFAULT_RATES.length);
});
