// node --test speak.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VISEMES, VISEME_SHAPES, SHAPE_KEYS, EMOTIONS, EMOTION_LIST, emotionOf, numberToWords, pauseFor, tokenize, syllables,
  phonemes, buildTrack, segmentIndexAt, shapeOf, mixShapes, visemeAt, wordIndexAt, wordIndexAtChar, creditsFor,
  estimate, formatSeconds, captionPages, pageAt, rand, blinkAt, gazeAt, headPose,
} from './speak-logic.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const SAMPLE = 'Hello there, welcome to Higgsfield! This avatar speaks your script.\nTry it now.';

test('every viseme has a full shape', () => {
  assert.equal(VISEMES.length, 9);
  for (const v of VISEMES) for (const k of SHAPE_KEYS) assert.equal(typeof VISEME_SHAPES[v][k], 'number', `${v}.${k}`);
  assert.equal(VISEME_SHAPES.MBP.open, 0);
  assert.ok(VISEME_SHAPES.AI.open > VISEME_SHAPES.E.open);
  assert.ok(VISEME_SHAPES.U.round > VISEME_SHAPES.AI.round);
});

test('emotions', () => {
  assert.deepEqual(EMOTION_LIST.map((e) => e.id), ['neutral', 'happy', 'serious', 'excited']);
  assert.equal(emotionOf('nope'), EMOTIONS.neutral);
  assert.ok(EMOTIONS.excited.headAmp > EMOTIONS.serious.headAmp);
});

test('numberToWords', () => {
  assert.equal(numberToWords(0), 'zero');
  assert.equal(numberToWords(15), 'fifteen');
  assert.equal(numberToWords(42), 'forty two');
  assert.equal(numberToWords(300), 'three hundred');
  assert.equal(numberToWords(2026), 'two thousand twenty six');
  assert.equal(numberToWords(1e6), null);
  assert.equal(numberToWords(-1), null);
});

test('pauseFor', () => {
  assert.equal(pauseFor(' '), 0);
  assert.equal(pauseFor('-'), 0); // hyphenated word
  assert.equal(pauseFor(', '), 0.25);
  assert.equal(pauseFor(' — '), 0.25);
  assert.equal(pauseFor('. '), 0.5);
  assert.equal(pauseFor('?!'), 0.5);
  assert.equal(pauseFor('\n'), 0.4);
  assert.equal(pauseFor('.\n\n'), 0.7);
});

test('tokenize keeps offsets and pauses', () => {
  const toks = tokenize(SAMPLE);
  assert.equal(toks[0].text, 'Hello');
  assert.equal(toks[1].text, 'there');
  assert.equal(toks[1].pause, 0.25);
  for (const t of toks) assert.equal(SAMPLE.slice(t.start, t.end), t.text);
  const welcome = toks.find((t) => t.text === 'Higgsfield');
  assert.equal(welcome.pause, 0.5);
  assert.deepEqual(tokenize("Don't stop").map((t) => t.text), ["Don't", 'stop']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize('  ...  '), []);
  assert.deepEqual(tokenize('café über').map((t) => t.text), ['café', 'über']);
});

test('syllables', () => {
  const cases = { cat: 1, hello: 2, beautiful: 3, make: 1, table: 2, the: 1, rhythm: 1, makes: 1, boxes: 2, jumped: 1, wanted: 2, a: 1, avatar: 3 };
  for (const [w, n] of Object.entries(cases)) assert.equal(syllables(w), n, w);
  assert.equal(syllables('42'), 3); // forty two
  assert.ok(syllables('2026') >= 5);
  assert.equal(syllables('你好'), 2);
  assert.ok(syllables('привет') >= 1);
});

test('phonemes map letters and digraphs', () => {
  const vis = (w) => phonemes(w).map((p) => p.viseme);
  assert.deepEqual(vis('mama'), ['MBP', 'AI', 'MBP', 'AI']);
  assert.deepEqual(vis('the'), ['LTH', 'E']);
  assert.deepEqual(vis('food'), ['FV', 'U', 'ETC']);
  assert.ok(vis('phone').includes('FV'));
  assert.ok(!vis('make').includes('E')); // silent e
  assert.deepEqual(vis('ball'), ['MBP', 'AI', 'LTH']); // double l merged
  for (const w of ['', '!!!', '你好', '123']) assert.ok(phonemes(w).length >= 1, w);
  for (const p of phonemes('Higgsfield')) assert.ok(VISEMES.includes(p.viseme));
});

test('buildTrack is contiguous, ordered and covers the duration', () => {
  const res = buildTrack(SAMPLE);
  const { track, words, duration } = res;
  assert.ok(duration > 2 && duration < 10, `duration ${duration}`);
  near(track[0].start, 0);
  near(track[track.length - 1].end, duration);
  for (let i = 1; i < track.length; i++) {
    near(track[i].start, track[i - 1].end, 1e-9);
    assert.ok(track[i].end > track[i].start);
  }
  assert.equal(words.length, tokenize(SAMPLE).length);
  for (const w of words) assert.equal(SAMPLE.slice(w.charStart, w.charEnd), w.word);
  // punctuation inserts rest segments
  const there = words.find((w) => w.word === 'there');
  const after = track[segmentIndexAt(track, there.end + 0.01)];
  assert.equal(after.viseme, 'rest');
  assert.equal(after.wordIndex, -1);
  assert.ok(track.some((s) => s.viseme === 'MBP'));
});

test('buildTrack: rate scales duration, empty script is empty', () => {
  const slow = buildTrack(SAMPLE, { rate: 0.5 }).duration;
  const fast = buildTrack(SAMPLE, { rate: 2 }).duration;
  const norm = buildTrack(SAMPLE).duration;
  assert.ok(slow > norm * 1.6 && fast < norm * 0.7);
  assert.deepEqual(buildTrack('   '), { track: [], words: [], duration: 0 });
  // ~150 words per minute at rate 1 for ordinary prose
  const prose = 'the quick brown fox jumps over the lazy dog and runs into the forest '.repeat(10);
  const { words, duration } = buildTrack(prose);
  const wpm = words.length / (duration / 60);
  assert.ok(wpm > 120 && wpm < 220, `wpm ${wpm}`);
});

test('segmentIndexAt', () => {
  const { track, duration } = buildTrack('one two');
  assert.equal(segmentIndexAt(track, -1), -1);
  assert.equal(segmentIndexAt(track, duration), -1);
  assert.equal(segmentIndexAt(track, 0), 0);
  for (let i = 0; i < track.length; i++) assert.equal(segmentIndexAt(track, (track[i].start + track[i].end) / 2), i);
  assert.equal(segmentIndexAt([], 0), -1);
});

test('visemeAt weights sum to 1 and blend smoothly', () => {
  const res = buildTrack(SAMPLE);
  let prevOpen = null;
  for (let t = -0.2; t < res.duration + 0.2; t += 0.004) {
    const v = visemeAt(res, t);
    const sum = Object.values(v.weights).reduce((a, b) => a + b, 0);
    near(sum, 1, 1e-9);
    assert.ok(VISEMES.includes(v.viseme));
    if (prevOpen != null) assert.ok(Math.abs(v.shape.open - prevOpen) < 0.2, `jump at ${t}`);
    prevOpen = v.shape.open;
  }
  assert.equal(visemeAt(res, -1).viseme, 'rest');
  assert.equal(visemeAt(res, res.duration + 1).weights.rest, 1);
  // at an exact boundary two shapes share the weight
  const i = res.track.findIndex((s, k) => k > 0 && s.viseme !== res.track[k - 1].viseme && s.end - s.start > 0.05 && res.track[k - 1].end - res.track[k - 1].start > 0.05);
  const b = visemeAt(res, res.track[i].start);
  near(b.weights[res.track[i].viseme], 0.5, 1e-6);
  near(b.weights[res.track[i - 1].viseme], 0.5, 1e-6);
  // mid-segment is pure
  const seg = res.track[i];
  if (seg.end - seg.start > 0.15) assert.equal(visemeAt(res, (seg.start + seg.end) / 2).weights[seg.viseme], 1);
  // accepts a plain array too
  assert.deepEqual(visemeAt(res.track, 1).weights, visemeAt(res, 1).weights);
});

test('shapeOf / mixShapes', () => {
  const s = shapeOf({ AI: 0.5, rest: 0.5 });
  near(s.open, VISEME_SHAPES.AI.open / 2);
  const m = mixShapes(VISEME_SHAPES.rest, VISEME_SHAPES.O, 0.5);
  near(m.round, VISEME_SHAPES.O.round / 2);
  assert.deepEqual(mixShapes(VISEME_SHAPES.E, VISEME_SHAPES.U, 0), { ...VISEME_SHAPES.E });
});

test('wordIndexAt follows words and holds through pauses', () => {
  const res = buildTrack(SAMPLE);
  assert.equal(wordIndexAt(res, -1), -1);
  assert.equal(wordIndexAt(res, 0.01), -1); // lead-in
  assert.equal(wordIndexAt(res, res.duration + 0.1), -1);
  for (const w of res.words) assert.equal(wordIndexAt(res, (w.start + w.end) / 2), w.index);
  const there = res.words[1];
  assert.equal(wordIndexAt(res.track, there.end + 0.05), 1); // comma pause keeps "there"
  // monotonic
  let last = -1;
  for (let t = 0; t < res.duration; t += 0.01) {
    const i = wordIndexAt(res, t);
    if (i >= 0) { assert.ok(i >= last); last = i; }
  }
  assert.equal(last, res.words.length - 1);
});

test('wordIndexAtChar maps boundary char offsets to words', () => {
  const { words } = buildTrack(SAMPLE);
  assert.equal(wordIndexAtChar([], 3), -1);
  assert.equal(wordIndexAtChar(words, 0), 0);
  for (const w of words) {
    assert.equal(wordIndexAtChar(words, w.charStart), w.index);
    assert.equal(wordIndexAtChar(words, w.charEnd - 1), w.index);
  }
  assert.equal(wordIndexAtChar(words, 99999), words.length - 1);
});

test('creditsFor: 2 per 10 s, minimum 2', () => {
  assert.equal(creditsFor(''), 2);
  assert.equal(creditsFor('Hi.'), 2);
  const long = 'This is a fairly ordinary sentence for testing credits. '.repeat(8);
  const d = buildTrack(long).duration;
  assert.equal(creditsFor(long), Math.ceil(d / 10) * 2);
  assert.ok(creditsFor(long) >= 4);
  assert.ok(creditsFor(long, { rate: 0.5 }) > creditsFor(long));
  assert.equal(creditsFor(long) % 2, 0);
});

test('estimate and formatSeconds', () => {
  const e = estimate(SAMPLE);
  assert.equal(e.chars, SAMPLE.length);
  assert.equal(e.words, tokenize(SAMPLE).length);
  assert.equal(e.credits, creditsFor(SAMPLE));
  assert.equal(formatSeconds(8.44), '8.4s');
  assert.equal(formatSeconds(65), '1:05');
  assert.equal(formatSeconds(-3), '0.0s');
});

test('captionPages split by length and sentence', () => {
  const { words } = buildTrack(SAMPLE);
  const pages = captionPages(words, 20);
  assert.equal(pages[0][0], 0);
  assert.equal(pages[pages.length - 1][1], words.length);
  for (let i = 1; i < pages.length; i++) assert.equal(pages[i][0], pages[i - 1][1]);
  for (const [a, b] of pages) {
    const text = words.slice(a, b).map((w) => w.word).join(' ');
    assert.ok(text.length <= 20 || b - a === 1, text);
  }
  const hig = words.findIndex((w) => w.word === 'Higgsfield');
  assert.ok(pages.some(([, b]) => b === hig + 1), 'breaks after the sentence end');
  assert.equal(pageAt(pages, 0), 0);
  assert.equal(pageAt(pages, -1), -1);
  assert.deepEqual(captionPages([]), []);
});

test('rand is deterministic and in range', () => {
  for (let k = 0; k < 200; k++) {
    const r = rand(k, 3);
    assert.ok(r >= 0 && r < 1);
    assert.equal(r, rand(k, 3));
  }
});

test('blinkAt blinks periodically and stays in range', () => {
  let blinks = 0;
  let was = false;
  for (let t = 0; t < 30; t += 0.01) {
    const b = blinkAt(t);
    assert.ok(b >= 0 && b <= 1);
    const closed = b > 0.5;
    if (closed && !was) blinks++;
    was = closed;
  }
  assert.ok(blinks >= 5 && blinks <= 15, `blinks ${blinks}`);
  assert.equal(blinkAt(-1), 0);
  assert.equal(blinkAt(NaN), 0);
  assert.equal(blinkAt(12.3, { seed: 2 }), blinkAt(12.3, { seed: 2 }));
});

test('gazeAt is bounded and continuous', () => {
  let p = gazeAt(0);
  for (let t = 0; t < 20; t += 0.005) {
    const g = gazeAt(t);
    assert.ok(Math.abs(g.x) <= 0.7 && Math.abs(g.y) <= 0.4);
    assert.ok(Math.abs(g.x - p.x) < 0.25, `gaze jump at ${t}`);
    p = g;
  }
});

test('headPose is subtle and emotion-scaled', () => {
  const amp = (emotion) => {
    let m = 0;
    for (let t = 0; t < 20; t += 0.05) {
      const p = headPose(t, { emotion });
      assert.ok(Math.abs(p.x) < 0.03 && Math.abs(p.y) < 0.03 && Math.abs(p.rot) < 0.1 && Math.abs(p.scale - 1) < 0.02);
      m = Math.max(m, Math.abs(p.rot));
    }
    return m;
  };
  assert.ok(amp('excited') > amp('neutral') && amp('neutral') > amp('serious'));
  const still = headPose(1, { talk: 0 });
  const talking = headPose(1, { talk: 1 });
  assert.ok(talking.y > still.y);
});
