import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, normalize, bestShift, WORK_W, WORK_H } from '../js/core/diff.js';
import { draftItem } from '../js/core/draft.js';
import { DEFAULT_RATES } from '../js/core/rates.js';

// A deterministic pseudo-random generator so the noise is the same on every run.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * A synthetic "room photo": a wall gradient, a floor, a window and a door, with sensor noise.
 * Options: light (gain), offset, shift (dx, dy in pixels), noise seed, and damage rectangles
 * [{ x, y, w, h, v }] painted after everything else.
 */
function scene({ light = 1, offset = 0, dx = 0, dy = 0, seed = 1, damage = [] } = {}) {
  const w = WORK_W, h = WORK_H;
  const data = new Uint8ClampedArray(w * h * 4);
  const rand = rng(seed);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x - dx, sy = y - dy; // sample the scene shifted
      let v = 170 + (sx / w) * 30; // wall
      if (sy > h * 0.72) v = 110 + ((sx + sy) % 9); // carpet texture
      if (sy > h * 0.69 && sy <= h * 0.72) v = 235; // baseboard
      if (sx > w * 0.15 && sx < w * 0.4 && sy > h * 0.15 && sy < h * 0.5) v = 215 - (Math.floor(sy) % 6 < 2 ? 40 : 0); // blinds
      if (sx > w * 0.62 && sx < w * 0.82 && sy > h * 0.1 && sy < h * 0.69) v = 140; // door
      if (sx > w * 0.78 && sx < w * 0.8 && sy > h * 0.38 && sy < h * 0.42) v = 60; // handle
      for (const d of damage) if (sx >= d.x && sx < d.x + d.w && sy >= d.y && sy < d.y + d.h) v = d.v;
      v = v * light + offset + (rand() - 0.5) * 6;
      const p = (y * w + x) * 4;
      data[p] = v; data[p + 1] = v * 0.98; data[p + 2] = v * 0.95; data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const contains = (r, x, y) => x >= r.x * WORK_W && x <= (r.x + r.w) * WORK_W && y >= r.y * WORK_H && y <= (r.y + r.h) * WORK_H;

test('normalize and bestShift basics', () => {
  assert.deepEqual(Array.from(normalize(new Float32Array([5, 5, 5]))), [0, 0, 0]);
  const n = normalize(new Float32Array([1, 2, 3]));
  assert.ok(Math.abs(n[0] + n[2]) < 1e-6 && Math.abs(n[1]) < 1e-6);
  const a = scene();
  assert.deepEqual(bestShift(normalize(new Float32Array(a.data.length / 4).map((_, i) => a.data[i * 4])), normalize(new Float32Array(a.data.length / 4).map((_, i) => a.data[i * 4])), WORK_W, WORK_H).dx, 0);
});

test('the same scene with different noise is unchanged', () => {
  const r = compare(scene({ seed: 1 }), scene({ seed: 2 }));
  assert.equal(r.changed, false, JSON.stringify(r.regions));
  assert.deepEqual(r.shift, { dx: 0, dy: 0 });
});

test('a lighting change alone is not a change', () => {
  const r = compare(scene(), scene({ light: 0.82, offset: 14, seed: 3 }));
  assert.equal(r.changed, false, JSON.stringify(r.regions));
});

test('a small camera shift is aligned away', () => {
  const r = compare(scene(), scene({ dx: 3, dy: -2, seed: 4 }));
  assert.deepEqual(r.shift, { dx: 3, dy: -2 });
  assert.equal(r.changed, false, JSON.stringify(r.regions));
});

test('a hole in the wall is found where it is', () => {
  const r = compare(scene(), scene({ seed: 5, light: 0.9, dx: 2, dy: 1, damage: [{ x: 100, y: 40, w: 10, h: 8, v: 45 }] }));
  assert.equal(r.changed, true);
  assert.ok(r.regions.some((reg) => contains(reg, 105 + 2, 44 + 1)), JSON.stringify(r.regions));
});

test('a thin scuff and a carpet stain are found', () => {
  const scuff = compare(scene(), scene({ seed: 6, damage: [{ x: 60, y: 70, w: 22, h: 3, v: 95 }] }));
  assert.equal(scuff.changed, true, 'scuff');
  const stain = compare(scene(), scene({ seed: 7, light: 1.08, damage: [{ x: 40, y: 115, w: 14, h: 9, v: 70 }] }));
  assert.equal(stain.changed, true, 'stain');
  assert.ok(stain.regions.some((reg) => contains(reg, 47, 119)));
});

test('compare rejects images of different sizes', () => {
  assert.throws(() => compare(scene(), { width: 10, height: 10, data: new Uint8ClampedArray(400) }));
});

// ---------------------------------------------------------------- the auto-draft

const wallItem = { label: 'Walls and paint', rates: ['paint-touchup', 'drywall-small'] };
const changed = (score, area = 0.01) => ({ changed: true, score, regions: [{ x: 0, y: 0, w: area, h: 1, strength: score }] });
const same = { changed: false, score: 0, regions: [] };

test('draft: unchanged, missing and no-baseline items', () => {
  assert.equal(draftItem({ item: wallItem, before: null, after: null, diff: null, rates: DEFAULT_RATES }).status, 'missing');
  const nb = draftItem({ item: wallItem, before: null, after: { condition: 'damage' }, diff: null, rates: DEFAULT_RATES });
  assert.equal(nb.status, 'no-baseline');
  assert.equal(nb.flagged, true);
  const ok = draftItem({ item: wallItem, before: { condition: 'ok' }, after: { condition: 'ok' }, diff: same, rates: DEFAULT_RATES });
  assert.equal(ok.status, 'unchanged');
  assert.equal(ok.flagged, false);
});

test('draft: pre-existing damage is not charged again', () => {
  const d = draftItem({ item: wallItem, before: { condition: 'damage' }, after: { condition: 'damage' }, diff: same, rates: DEFAULT_RATES });
  assert.equal(d.status, 'unchanged');
  assert.equal(d.suggestion.kind, 'none');
});

test('draft: minor change uses the first rate, major the second', () => {
  const minor = draftItem({ item: wallItem, before: { condition: 'ok' }, after: { condition: 'damage' }, diff: changed(0.9), rates: DEFAULT_RATES });
  assert.equal(minor.suggestion.rateId, 'paint-touchup');
  assert.equal(minor.confidence, 'high');
  const major = draftItem({ item: wallItem, before: { condition: 'ok' }, after: { condition: 'ok' }, diff: changed(3.4), rates: DEFAULT_RATES });
  assert.equal(major.suggestion.rateId, 'drywall-small');
  assert.equal(major.suggestion.cents, 7500);
  assert.equal(major.confidence, 'medium');
  // A strong but small mark (a scuff) stays minor; a large one is major.
  assert.equal(draftItem({ item: wallItem, before: { condition: 'ok' }, after: { condition: 'damage' }, diff: changed(2.2), rates: DEFAULT_RATES }).severity, 'minor');
  assert.equal(draftItem({ item: wallItem, before: { condition: 'ok' }, after: { condition: 'damage' }, diff: changed(1, 0.08), rates: DEFAULT_RATES }).severity, 'major');
});

test('draft: reported wear with a faint change is wear and tear, not a charge', () => {
  const d = draftItem({ item: wallItem, before: { condition: 'ok' }, after: { condition: 'wear', note: 'scuffs' }, diff: changed(0.8), rates: DEFAULT_RATES });
  assert.equal(d.suggestion.kind, 'wear');
  assert.match(d.why.join(' '), /§92\.104/);
});
