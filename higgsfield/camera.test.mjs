import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, CATEGORIES, presetById, cameraAt } from './presets.js';
import { ASPECTS, sizeFor, cameraMatrix, shakeNoise, shotAt, pickMime, videoFilename, fixWebmDuration } from './render.js';

const KEYS = ['zoom', 'x', 'y', 'rotate', 'tiltX', 'tiltY', 'blur', 'shake', 'fxAmount'];
const TS = Array.from({ length: 121 }, (_, i) => i / 120);

test('60+ presets with unique kebab-case ids and known categories', () => {
  assert.ok(PRESETS.length >= 60, `only ${PRESETS.length} presets`);
  const ids = new Set();
  const cats = new Set(CATEGORIES.map((c) => c.id));
  for (const p of PRESETS) {
    assert.match(p.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, p.id);
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
    assert.ok(cats.has(p.category), `${p.id} has unknown category ${p.category}`);
    assert.equal(typeof p.name, 'string');
    assert.ok(p.description.length > 10, `${p.id} needs a description`);
    assert.ok(Array.isArray(p.tags));
    assert.equal(typeof p.fn, 'undefined', 'motion functions stay private');
  }
  for (const c of CATEGORIES) assert.ok(PRESETS.some((p) => p.category === c.id), `empty category ${c.id}`);
  assert.ok(PRESETS.some((p) => p.popular) && PRESETS.some((p) => p.new));
});

test('presetById finds every preset, common aliases, and nothing else', () => {
  for (const p of PRESETS) assert.equal(presetById(p.id), p);
  assert.equal(presetById('360-orbit')?.id, 'orbit-360');
  assert.equal(presetById('crash-zoom')?.id, 'crash-zoom');
  assert.equal(presetById('VERTIGO')?.id, 'dolly-zoom');
  assert.equal(presetById('nope'), undefined);
  assert.equal(presetById(undefined), undefined);
});

test('cameraAt returns finite, in-range numbers for every preset and intensity', () => {
  for (const p of PRESETS) {
    for (const intensity of [0, 0.25, 1, 1.5, 2]) {
      for (const t of TS) {
        const c = cameraAt(p.id, t, { intensity });
        for (const k of KEYS) assert.ok(Number.isFinite(c[k]), `${p.id} ${k} at t=${t}`);
        assert.ok(c.zoom >= 1, `${p.id} zoom ${c.zoom} < 1 at t=${t}`);
        assert.ok(c.blur >= 0 && c.shake >= 0 && c.shake <= 1 && c.fxAmount >= 0 && c.fxAmount <= 1, p.id);
        assert.ok(Math.abs(c.x) <= 0.5 && Math.abs(c.y) <= 0.5, p.id);
        assert.ok(c.fx === null || typeof c.fx === 'string');
      }
    }
  }
});

test('cameraAt is deterministic, clamps t, and tolerates junk input', () => {
  assert.deepEqual(cameraAt('dolly-in', 0.37), cameraAt('dolly-in', 0.37));
  assert.deepEqual(cameraAt('dolly-in', -3), cameraAt('dolly-in', 0));
  assert.deepEqual(cameraAt('dolly-in', 9), cameraAt('dolly-in', 1));
  assert.deepEqual(cameraAt('dolly-in', NaN), cameraAt('dolly-in', 0));
  const c = cameraAt('not-a-preset', 0.5);
  assert.equal(c.zoom, 1);
  assert.equal(c.x, 0);
  assert.equal(c.fx, null);
  assert.equal(cameraAt('handheld', 0.5, { intensity: 0 }).shake, 0);
});

test('presets actually move, and the intended moves go the right way', () => {
  const differs = (a, b) => KEYS.some((k) => Math.abs(a[k] - b[k]) > 1e-3);
  for (const p of PRESETS) {
    if (p.id === 'static') continue;
    const c0 = cameraAt(p.id, 0);
    assert.ok(TS.some((t) => differs(c0, cameraAt(p.id, t)) || cameraAt(p.id, t).shake > 0.05), `${p.id} never moves`);
  }
  assert.ok(cameraAt('dolly-in', 1).zoom > cameraAt('dolly-in', 0).zoom + 0.2);
  assert.ok(cameraAt('dolly-out', 1).zoom < cameraAt('dolly-out', 0).zoom - 0.2);
  assert.ok(cameraAt('pan-left', 1).x < cameraAt('pan-left', 0).x);
  assert.ok(cameraAt('crane-up', 1).y < cameraAt('crane-up', 0).y);
  assert.ok(cameraAt('earth-zoom-out', 0).zoom > 3);
  assert.ok(cameraAt('whip-pan', 0.49).blur > 10, 'whip pan blurs mid-move');
  assert.ok(cameraAt('rack-focus', 0).fx === 'rackfocus');
  assert.equal(cameraAt('dolly-zoom', 0.5).fx, 'vertigo');
  assert.ok(cameraAt('disintegration', 1).fxAmount > 0.99);
  const a = cameraAt('orbit-360', 0), b = cameraAt('orbit-360', 1);
  for (const k of KEYS) assert.ok(Math.abs(a[k] - b[k]) < 1e-6, `orbit-360 loops (${k})`);
});

test('renderer coverage: every frame corner lands inside the source (never empty edges)', () => {
  const sources = [[3000, 2000], [1200, 1800], [1024, 1024], [640, 360], [400, 1400]];
  const frames = Object.keys(ASPECTS).map((a) => sizeFor(a, 360));
  for (const p of PRESETS) {
    for (const t of TS.filter((_, i) => i % 4 === 0)) {
      for (const seed of [1, 99]) {
        const cam = shotAt(p.id, t, { seed, duration: 5, intensity: 1.5 });
        for (const [W, H] of frames) {
          for (const [sw, sh] of sources) {
            for (const margin of [0, 12]) {
              const m = cameraMatrix(cam, W, H, sw, sh, margin);
              const det = m.a * m.d - m.b * m.c;
              assert.ok(Number.isFinite(det) && Math.abs(det) > 0, `${p.id} singular`);
              assert.ok(m.zoom >= cam.zoom - 1e-9, 'zoom is never lowered');
              for (const [qx, qy] of [[-margin, -margin], [W + margin, -margin], [-margin, H + margin], [W + margin, H + margin]]) {
                const X = qx - m.e, Y = qy - m.f;
                const sx = (m.d * X - m.c * Y) / det, sy = (-m.b * X + m.a * Y) / det;
                const eps = 1e-6 * Math.max(sw, sh);
                assert.ok(sx >= -eps && sx <= sw + eps && sy >= -eps && sy <= sh + eps,
                  `${p.id} t=${t} ${W}x${H} src ${sw}x${sh}: corner -> (${sx.toFixed(1)}, ${sy.toFixed(1)})`);
              }
            }
          }
        }
      }
    }
  }
});

test('cameraMatrix at rest is a plain centred cover-fit', () => {
  const m = cameraMatrix(cameraAt('none', 0), 1280, 720, 1920, 1080);
  assert.ok(Math.abs(m.a - 2 / 3) < 1e-9 && Math.abs(m.d - 2 / 3) < 1e-9 && Math.abs(m.b) < 1e-12 && Math.abs(m.c) < 1e-12);
  assert.ok(Math.abs(m.e) < 1e-6 && Math.abs(m.f) < 1e-6);
  const tall = cameraMatrix(cameraAt('none', 0), 720, 1280, 1920, 1080); // landscape photo in a portrait frame
  assert.ok(Math.abs(tall.a - 1280 / 1080) < 1e-9);
  assert.ok(Math.abs(tall.e - (720 - 1920 * (1280 / 1080)) / 2) < 1e-6);
});

test('sizeFor gives even sizes with the right ratio', () => {
  assert.deepEqual(sizeFor('16:9', 720), [1280, 720]);
  assert.deepEqual(sizeFor('9:16', 720), [720, 1280]);
  assert.deepEqual(sizeFor('1:1', 480), [480, 480]);
  assert.deepEqual(sizeFor('4:5', 720), [720, 900]);
  assert.deepEqual(sizeFor('21:9', 720), [1680, 720]);
  assert.deepEqual(sizeFor('bogus', 720), [1280, 720]);
  for (const a of Object.keys(ASPECTS)) {
    for (const s of [360, 480, 541, 1080]) {
      const [w, h] = sizeFor(a, s);
      assert.ok(w % 2 === 0 && h % 2 === 0, `${a} ${s}`);
      const [aw, ah] = ASPECTS[a];
      assert.ok(Math.abs(w / h - aw / ah) < 0.01, `${a} ratio`);
    }
  }
});

test('shakeNoise is smooth, bounded and seeded', () => {
  let prev = shakeNoise(7, 0);
  for (let s = 0.01; s < 6; s += 0.01) {
    const n = shakeNoise(7, s);
    for (const k of ['x', 'y', 'r']) {
      assert.ok(Math.abs(n[k]) <= 1, 'bounded');
      assert.ok(Math.abs(n[k] - prev[k]) < 0.5, 'smooth');
    }
    prev = n;
  }
  assert.deepEqual(shakeNoise(3, 1.25), shakeNoise(3, 1.25));
  assert.notDeepEqual(shakeNoise(3, 1.25), shakeNoise(4, 1.25));
  const still = shotAt('dolly-in', 0.5, { seed: 5 });
  assert.deepEqual(still, cameraAt('dolly-in', 0.5), 'no shake means no noise');
});

test('pickMime prefers vp9, then falls back', () => {
  assert.equal(pickMime(() => true), 'video/webm;codecs=vp9');
  assert.equal(pickMime((m) => m === 'video/webm'), 'video/webm');
  assert.equal(pickMime((m) => m.startsWith('video/mp4')), 'video/mp4;codecs=avc1');
  assert.equal(pickMime(() => false), '');
  assert.equal(pickMime(() => { throw new Error('x'); }), '');
});

test('videoFilename slugs the prompt and preset', () => {
  assert.equal(videoFilename('Neon city at night!', 'dolly-in'), 'neon-city-at-night-dolly-in.webm');
  assert.equal(videoFilename('', 'crash-zoom', 'video/mp4'), 'higgsfield-video-crash-zoom.mp4');
  assert.ok(videoFilename('x'.repeat(200), 'glitch').length < 80);
});

// ---- minimal WebM builder for the duration fix
const vint8 = (n) => { const b = [0x01]; for (let i = 6; i >= 0; i--) b.push(Math.floor(n / 256 ** i) % 256); return b; };
const el = (id, payload, size = null) => [...id, ...(size ?? [0x80 | payload.length]), ...payload];

function readInfoDuration(u8) {
  for (let i = 0; i < u8.length - 10; i++) {
    if (u8[i] === 0x44 && u8[i + 1] === 0x89 && u8[i + 2] === 0x88) return new DataView(u8.buffer, u8.byteOffset + i + 3, 8).getFloat64(0);
  }
  return null;
}

test('fixWebmDuration inserts a Duration into Segment > Info', () => {
  const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x86], [0x81]));
  const info = el([0x15, 0x49, 0xa9, 0x66], [...el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), ...el([0x4d, 0x80], [...Buffer.from('test')])]);
  const cluster = el([0x1f, 0x43, 0xb6, 0x75], el([0xe7], [0x00]));
  const unknownSeg = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  const file = new Uint8Array([...header, ...unknownSeg, ...info, ...cluster]);
  const out = new Uint8Array(fixWebmDuration(file.buffer, 5000));
  assert.equal(out.length, file.length + 11 + 7, 'Info size re-encoded as 8 bytes plus an 11-byte Duration');
  assert.equal(readInfoDuration(out), 5000);
  // Cluster bytes are untouched at the end.
  assert.deepEqual([...out.slice(-cluster.length)], cluster);
  // Running it again is a no-op (Duration already present).
  assert.equal(fixWebmDuration(out.buffer, 5000).byteLength, out.length);

  // Known-size segment gets its size bumped.
  const body = [...info, ...cluster];
  const knownSeg = [0x18, 0x53, 0x80, 0x67, ...vint8(body.length)];
  const file2 = new Uint8Array([...header, ...knownSeg, ...body]);
  const out2 = new Uint8Array(fixWebmDuration(file2.buffer, 3000));
  assert.equal(readInfoDuration(out2), 3000);
  const segSizeAt = header.length + 4;
  let size = 0;
  for (let i = 1; i < 8; i++) size = size * 256 + out2[segSizeAt + i];
  assert.equal(size, out2.length - (segSizeAt + 8));

  // Not a WebM: returned unchanged.
  const junk = new Uint8Array([1, 2, 3, 4]).buffer;
  assert.equal(fixWebmDuration(junk, 1000), junk);
});
