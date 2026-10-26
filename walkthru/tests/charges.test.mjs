import test from 'node:test';
import assert from 'node:assert/strict';
import { split, settle, parseMoney, money, defaultResponsible } from '../js/core/charges.js';

test('split always adds up to the cent', () => {
  assert.deepEqual(split(100, ['a', 'b', 'c']), { a: 34, b: 33, c: 33 });
  assert.deepEqual(split(3500, ['a', 'b']), { a: 1750, b: 1750 });
  assert.deepEqual(split(5, ['a', 'a', 'b']), { a: 3, b: 2 }); // duplicate ids count once
  assert.deepEqual(split(100, []), {});
  for (let cents = 0; cents < 500; cents += 7) {
    for (let n = 1; n <= 4; n++) {
      const ids = ['a', 'b', 'c', 'd'].slice(0, n);
      const parts = Object.values(split(cents, ids));
      assert.equal(parts.reduce((s, v) => s + v, 0), cents);
      assert.ok(Math.max(...parts) - Math.min(...parts) <= 1);
    }
  }
});

test('parseMoney and money', () => {
  assert.equal(parseMoney('$1,234.5'), 123450);
  assert.equal(parseMoney('12'), 1200);
  assert.equal(parseMoney('0.07'), 7);
  assert.equal(parseMoney('-5'), null);
  assert.equal(parseMoney('1.234'), null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(money(123450), '$1,234.50');
});

test('defaultResponsible: bedroom owner, or everyone for shared areas', () => {
  const residents = [{ id: 'r1', bedroom: 'A' }, { id: 'r2', bedroom: 'B' }];
  assert.deepEqual(defaultResponsible({ shared: true }, residents), ['r1', 'r2']);
  assert.deepEqual(defaultResponsible({ shared: false, bedroom: 'B' }, residents), ['r2']);
  assert.deepEqual(defaultResponsible({ shared: false, bedroom: 'C' }, residents), ['r1', 'r2']); // unclaimed room
});

test('settle splits charges, caps refunds at zero and reports what is owed', () => {
  const residents = [
    { id: 'r1', name: 'Sam', depositCents: 50000 },
    { id: 'r2', name: 'Jo', depositCents: 10000 },
  ];
  const charges = [
    { key: 'living.walls', label: 'Paint', cents: 3501, responsible: ['r1', 'r2'] },
    { key: 'bedB.bwalls', label: 'Drywall', cents: 15000, responsible: ['r2'] },
    { key: 'kitchen.stove', label: 'Clean', cents: 4000, responsible: [] }, // nobody named: split all
  ];
  const s = settle(charges, residents);
  assert.equal(s.total, 22501);
  const [sam, jo] = s.rows;
  assert.equal(sam.charged, 1751 + 2000);
  assert.equal(jo.charged, 1750 + 15000 + 2000);
  assert.equal(sam.charged + jo.charged, s.total);
  assert.equal(sam.refund, 50000 - 3751);
  assert.equal(jo.refund, 0);
  assert.equal(jo.owes, 18750 - 10000);
  assert.equal(s.deposits, 60000);
  assert.equal(s.refunds, sam.refund);
  assert.equal(s.owed, jo.owes);
});
