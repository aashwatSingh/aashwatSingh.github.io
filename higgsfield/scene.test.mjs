// node --test scene.test.mjs — pure logic of the procedural painter (no DOM needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { STYLES, SCENES, hashSeed, mulberry32, makeNoise, analyzePrompt, buildPalette, mixHex, hexToRgb, rgbToHex } from './scene.js';

const HEX = /^#[0-9a-f]{6}$/;

test('STYLES has 10+ unique entries including the contract ids', () => {
  assert.ok(STYLES.length >= 10);
  const ids = STYLES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['realistic', 'cinematic', 'editorial', 'anime', 'film-noir', 'vaporwave', 'analog-film', '3d-render', 'watercolor', 'y2k']) {
    assert.ok(ids.includes(id), id);
  }
  for (const s of STYLES) assert.ok(s.name && s.description);
});

test('hashSeed is a deterministic uint32', () => {
  assert.equal(hashSeed('sunset'), hashSeed('sunset'));
  assert.notEqual(hashSeed('sunset'), hashSeed('sunrise'));
  for (const s of ['', 'a', 'hello world', '🌅 unicode']) {
    const h = hashSeed(s);
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, s);
  }
  assert.equal(hashSeed(null), hashSeed(''));
});

test('mulberry32 is deterministic, in [0,1) and roughly uniform', () => {
  const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
  const sa = Array.from({ length: 5 }, a), sb = Array.from({ length: 5 }, b), sc = Array.from({ length: 5 }, c);
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  const r = mulberry32(7);
  let sum = 0;
  for (let i = 0; i < 20000; i++) { const v = r(); assert.ok(v >= 0 && v < 1); sum += v; }
  assert.ok(Math.abs(sum / 20000 - 0.5) < 0.01);
});

test('noise is deterministic and bounded', () => {
  const n = makeNoise(9), m = makeNoise(9), o = makeNoise(10);
  assert.equal(n.fbm(1.3, 2.7), m.fbm(1.3, 2.7));
  assert.notEqual(n.fbm(1.3, 2.7), o.fbm(1.3, 2.7));
  for (let i = 0; i < 500; i++) {
    const x = i * 0.37, y = i * 0.11;
    for (const v of [n.n2(x, y), n.fbm(x, y), n.ridged(x, y)]) assert.ok(v >= 0 && v <= 1);
  }
});

test('colour helpers round-trip and mix', () => {
  assert.deepEqual(hexToRgb('#ff8000'), [255, 128, 0]);
  assert.deepEqual(hexToRgb('#fff'), [255, 255, 255]);
  assert.equal(rgbToHex([255, 128, 0]), '#ff8000');
  assert.equal(rgbToHex([300, -5, 12.4]), '#ff000c');
  assert.equal(mixHex('#000000', '#ffffff', 0), '#000000');
  assert.equal(mixHex('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mixHex('#000000', '#ffffff', 7), '#ffffff');
});

test('analyzePrompt is pure and deterministic', () => {
  const p = 'A red sports car drifting through Tokyo at night';
  assert.deepEqual(analyzePrompt(p), analyzePrompt(p));
  assert.deepEqual(analyzePrompt(p), analyzePrompt(p.toUpperCase()));
});

test('keywords map to scenes', () => {
  const cases = {
    'sunset over the ocean': 'ocean',
    'golden hour sunset': 'sunset',
    'neon city skyline at night': 'city',
    'cyberpunk street in the rain': 'cyberpunk',
    'rainy evening': 'rain',
    'misty pine forest': 'forest',
    'tropical beach with palm trees': 'beach',
    'snowy alps': 'mountain',
    'winter blizzard': 'snow',
    'sand dunes in the sahara': 'desert',
    'spiral galaxy and nebula': 'space',
    'portrait of an old fisherman': 'portrait',
    'a woman with red hair': 'portrait',
    'porsche on a mountain road': 'car',
    'abstract flowing liquid shapes': 'abstract',
    'bouquet of pink roses': 'flower',
  };
  for (const [prompt, scene] of Object.entries(cases)) assert.equal(analyzePrompt(prompt).scene, scene, prompt);
});

test('people in a landscape become a figure, not a portrait', () => {
  const a = analyzePrompt('a lone hiker on a mountain ridge');
  assert.equal(a.scene, 'mountain');
  assert.equal(a.figure, true);
  assert.equal(analyzePrompt('portrait of a hiker').figure, false);
});

test('subjects pick a backdrop from the location words', () => {
  assert.equal(analyzePrompt('vintage car in the desert').backdrop, 'desert');
  assert.equal(analyzePrompt('sports car').backdrop, 'city');
  assert.equal(analyzePrompt('portrait in a neon city').backdrop, 'city');
  assert.equal(analyzePrompt('studio portrait').backdrop, 'studio');
});

test('colour words are extracted and steer the palette', () => {
  const a = analyzePrompt('a teal and gold abstract swirl');
  assert.deepEqual(a.colors, ['teal', 'gold']);
  assert.equal(a.palette[4], '#14b8a6');
  assert.deepEqual(analyzePrompt('golden hour on the lake').colors, []);
  const plain = analyzePrompt('sunset over the ocean').palette;
  const red = analyzePrompt('red sunset over the ocean').palette;
  assert.notDeepEqual(plain, red);
  assert.ok(hexToRgb(red[2])[0] > hexToRgb(red[2])[2]);
});

test('mood, time and weather words are read', () => {
  assert.equal(analyzePrompt('moody harbour').mood, 'dark');
  assert.equal(analyzePrompt('dreamy meadow').mood, 'dreamy');
  assert.equal(analyzePrompt('vibrant reef').mood, 'bright');
  assert.equal(analyzePrompt('forest at night').time, 'night');
  assert.equal(analyzePrompt('desert at dawn').time, 'dawn');
  assert.equal(analyzePrompt('snowy forest').weather, 'snow');
  assert.equal(analyzePrompt('foggy harbour').weather, 'fog');
  const dark = analyzePrompt('dark mountain lake').palette.map(hexToRgb);
  const neutral = analyzePrompt('mountain lake').palette.map(hexToRgb);
  const L = (c) => c[0] + c[1] + c[2];
  assert.ok(dark.reduce((s, c) => s + L(c), 0) < neutral.reduce((s, c) => s + L(c), 0));
});

test('monochrome flag yields a grey palette', () => {
  const a = analyzePrompt('black and white city street');
  assert.equal(a.flags.mono, true);
  for (const hex of a.palette) { const [r, g, b] = hexToRgb(hex); assert.ok(Math.abs(r - g) <= 1 && Math.abs(g - b) <= 1, hex); }
});

test('unknown and empty prompts fall back to a valid, stable scene', () => {
  for (const p of ['xyzzy plugh', '', '   ', '12345', 'qwertyuiop']) {
    const a = analyzePrompt(p);
    assert.ok(SCENES.includes(a.scene), `${p} -> ${a.scene}`);
    assert.equal(a.palette.length, 7);
    for (const c of a.palette) assert.match(c, HEX);
    assert.deepEqual(analyzePrompt(p), a);
  }
});

test('buildPalette returns seven rgb triples', () => {
  const p = buildPalette({ scene: 'city', time: 'neon', colors: ['pink'], flags: { neon: true }, mood: 'epic' });
  assert.equal(p.length, 7);
  for (const c of p) { assert.equal(c.length, 3); for (const v of c) assert.ok(v >= 0 && v <= 255); }
});
