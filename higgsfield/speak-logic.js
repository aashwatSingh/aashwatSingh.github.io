// Speak: pure, DOM-free helpers that turn a script into a timed mouth-shape (viseme) track,
// blend between shapes, and drive blinks / gaze / head motion. Tested in speak.test.mjs.

export const VISEMES = ['rest', 'AI', 'E', 'O', 'U', 'MBP', 'FV', 'LTH', 'ETC'];

// Mouth parameters per viseme, all roughly 0..1 (wide is -1..1: negative = narrower).
// open: jaw/lip gap, wide: corner spread, round: pucker, teeth: upper teeth shown,
// tongue: tongue raised, bite: upper teeth on lower lip (F/V), press: lips pressed (M/B/P).
export const VISEME_SHAPES = {
  rest: { open: 0, wide: 0, round: 0, teeth: 0, tongue: 0, bite: 0, press: 0 },
  AI: { open: 0.82, wide: 0.15, round: 0, teeth: 0.55, tongue: 0.15, bite: 0, press: 0 },
  E: { open: 0.4, wide: 0.6, round: 0, teeth: 0.9, tongue: 0.1, bite: 0, press: 0 },
  O: { open: 0.62, wide: -0.25, round: 0.75, teeth: 0.1, tongue: 0.05, bite: 0, press: 0 },
  U: { open: 0.22, wide: -0.35, round: 1, teeth: 0, tongue: 0, bite: 0, press: 0 },
  MBP: { open: 0, wide: 0.02, round: 0, teeth: 0, tongue: 0, bite: 0, press: 1 },
  FV: { open: 0.14, wide: 0.12, round: 0, teeth: 1, tongue: 0, bite: 1, press: 0 },
  LTH: { open: 0.34, wide: 0.2, round: 0, teeth: 0.7, tongue: 1, bite: 0, press: 0 },
  ETC: { open: 0.3, wide: 0.3, round: 0, teeth: 0.8, tongue: 0.2, bite: 0, press: 0 },
};
export const SHAPE_KEYS = ['open', 'wide', 'round', 'teeth', 'tongue', 'bite', 'press'];

// Emotion presets change face and motion, not timing.
export const EMOTIONS = {
  neutral: { id: 'neutral', name: 'Neutral', smile: 0.12, brow: 0, browTilt: 0, eyeOpen: 1, headAmp: 1, nod: 1, blinkRate: 1, energy: 1 },
  happy: { id: 'happy', name: 'Happy', smile: 0.6, brow: 0.3, browTilt: 0.15, eyeOpen: 0.86, headAmp: 1.3, nod: 1.2, blinkRate: 1.1, energy: 1.1 },
  serious: { id: 'serious', name: 'Serious', smile: -0.08, brow: -0.25, browTilt: -0.45, eyeOpen: 0.93, headAmp: 0.55, nod: 0.6, blinkRate: 0.8, energy: 0.9 },
  excited: { id: 'excited', name: 'Excited', smile: 0.75, brow: 0.6, browTilt: 0.2, eyeOpen: 1.12, headAmp: 1.9, nod: 1.6, blinkRate: 1.3, energy: 1.25 },
};
export const EMOTION_LIST = Object.values(EMOTIONS);
export const emotionOf = (id) => EMOTIONS[id] ?? EMOTIONS.neutral;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (u) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };

// ---------------------------------------------------------------- text

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** English words for 0..999999 (null outside that range). */
export function numberToWords(n) {
  if (!Number.isInteger(n) || n < 0 || n > 999999) return null;
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToWords(n % 100)}` : ''}`;
  return `${numberToWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberToWords(n % 1000)}` : ''}`;
}

/** Digits as they'd be read aloud: "2026" → "two thousand twenty six", "007" → "zero zero seven". */
function spellDigits(d) {
  const n = Number(d);
  if (d.length > 1 && d[0] === '0') return [...d].map((c) => ONES[+c]).join(' ');
  return numberToWords(n) ?? [...d].map((c) => ONES[+c]).join(' ');
}

/** Lowercase latin letters (diacritics stripped), digits expanded to words. Non-latin letters kept. */
function normalizeWord(word) {
  return String(word).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\d+/g, (d) => ` ${spellDigits(d)} `).replace(/['’]/g, '').trim();
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** Pause (seconds at rate 1) implied by the text between two words. */
export function pauseFor(gap) {
  const g = String(gap ?? '');
  let p = 0;
  if (/\n\s*\n/.test(g)) p = 0.7;
  else if (/\n/.test(g)) p = 0.4;
  if (/[.!?…。！？]/.test(g)) p = Math.max(p, 0.5);
  if (/[,;:，；：–—]|\s-\s|\(|\)/.test(g)) p = Math.max(p, 0.25);
  return p;
}

/** Split a script into words with character offsets and the pause that follows each. */
export function tokenize(text) {
  const s = String(text ?? '');
  const out = [];
  for (const m of s.matchAll(WORD_RE)) out.push({ text: m[0], start: m.index, end: m.index + m[0].length, pause: 0 });
  for (let i = 0; i < out.length; i++) {
    out[i].pause = pauseFor(s.slice(out[i].end, i + 1 < out.length ? out[i + 1].start : s.length));
  }
  return out;
}

const isCJK = (c) => /[぀-ヿ㐀-鿿가-힯]/.test(c);

/** Estimated syllables in a word (>= 1). */
export function syllables(word) {
  const w = normalizeWord(word);
  let total = 0;
  for (const part of w.split(/\s+/)) {
    if (!part) continue;
    const latin = part.replace(/[^a-z]/g, '');
    const other = [...part.replace(/[a-z]/g, '')].filter((c) => /\p{L}/u.test(c));
    if (latin) {
      let n = (latin.match(/[aeiouy]+/g) || []).length;
      if (n > 1 && latin.length > 2 && /[^aeiouy]e$/.test(latin) && !/[^aeiouy]le$/.test(latin)) n--;
      if (n > 1 && (/[^aeiouyslzcxgh]es$/.test(latin) || /[^aeiouytd]ed$/.test(latin))) n--;
      total += Math.max(1, n);
    }
    if (other.length) {
      const cjk = other.filter(isCJK).length;
      total += cjk + Math.max(other.length > cjk ? 1 : 0, Math.round((other.length - cjk) / 2.5));
    }
  }
  return Math.max(1, total);
}

const LETTER = {
  a: 'AI', e: 'E', i: 'AI', o: 'O', u: 'U', y: 'E',
  b: 'MBP', m: 'MBP', p: 'MBP', f: 'FV', v: 'FV', l: 'LTH', w: 'U',
};
const MULTI = [
  ['igh', 'AI'], ['tch', 'ETC'],
  ['th', 'LTH'], ['sh', 'ETC'], ['ch', 'ETC'], ['ph', 'FV'], ['wh', 'U'], ['qu', 'U'], ['oo', 'U'], ['ew', 'U'],
  ['ou', 'O'], ['ow', 'O'], ['oa', 'O'], ['oe', 'O'], ['ee', 'E'], ['ea', 'E'], ['ey', 'E'], ['ai', 'AI'],
  ['ay', 'AI'], ['ck', 'ETC'], ['ng', 'ETC'], ['gh', ''],
];
const VOWEL_VIS = new Set(['AI', 'E', 'O', 'U']);
const weightOf = (v) => (VOWEL_VIS.has(v) ? 1 : v === 'MBP' || v === 'FV' ? 0.7 : 0.5);
const OTHER_CYCLE = ['AI', 'ETC', 'O', 'E', 'MBP', 'AI', 'LTH', 'U'];

/** Mouth shapes for one word: [{ viseme, weight }] (adjacent duplicates merged). */
export function phonemes(word) {
  const w = normalizeWord(word);
  const out = [];
  const push = (v) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last && last.viseme === v) last.weight += weightOf(v) * 0.5;
    else out.push({ viseme: v, weight: weightOf(v) });
  };
  for (const part of w.split(/\s+/)) {
    let s = part;
    if (/^[a-z]{3,}$/.test(s) && /[^aeiouy]e$/.test(s) && /[aeiouy]/.test(s.slice(0, -1))) s = s.slice(0, -1); // silent e
    for (let i = 0; i < s.length;) {
      const c = s[i];
      if (c >= 'a' && c <= 'z') {
        const m = MULTI.find(([k]) => s.startsWith(k, i));
        if (m) { push(m[1]); i += m[0].length; continue; }
        if (c === s[i - 1]) { i++; continue; } // double letters
        if (c === 'h' && i > 0) { i++; continue; }
        push(LETTER[c] ?? 'ETC');
        i++;
      } else {
        if (/\p{L}/u.test(c)) {
          const cp = c.codePointAt(0);
          push(OTHER_CYCLE[cp % OTHER_CYCLE.length]);
          if (isCJK(c)) push(cp % 3 ? 'AI' : 'E');
        }
        i++;
      }
    }
  }
  if (!out.length) out.push({ viseme: 'ETC', weight: 0.5 });
  return out;
}

// ---------------------------------------------------------------- track

/**
 * Build a timed viseme track for a script.
 * @returns {{ track: {start,end,viseme,word,wordIndex}[], words: {index,word,start,end,charStart,charEnd,pause}[], duration }}
 */
export function buildTrack(script, { wpm = 165, rate = 1, lead = 0.12, tail = 0.3 } = {}) {
  const r = clamp(Number(rate) || 1, 0.25, 4);
  const tokens = tokenize(script);
  const track = [];
  const words = [];
  if (!tokens.length) return { track, words, duration: 0 };
  const secPerSyl = 60 / (wpm * r * 1.45);
  let t = 0;
  const rest = (d) => { if (d > 0) { track.push({ start: t, end: t + d, viseme: 'rest', word: null, wordIndex: -1 }); t += d; } };
  rest(lead);
  tokens.forEach((tok, i) => {
    const dur = syllables(tok.text) * secPerSyl + 0.05 / r;
    const ph = phonemes(tok.text);
    const total = ph.reduce((a, p) => a + p.weight, 0);
    const start = t;
    let s = t;
    ph.forEach((p, k) => {
      const e = k === ph.length - 1 ? start + dur : s + (dur * p.weight) / total;
      track.push({ start: s, end: e, viseme: p.viseme, word: tok.text, wordIndex: i });
      s = e;
    });
    t = start + dur;
    words.push({ index: i, word: tok.text, start, end: t, charStart: tok.start, charEnd: tok.end, pause: tok.pause });
    if (i < tokens.length - 1) rest(tok.pause / r);
  });
  rest(tail);
  return { track, words, duration: t };
}

const trackOf = (x) => (Array.isArray(x) ? x : x?.track ?? []);

/** Index of the track segment containing t, or -1 outside the track. */
export function segmentIndexAt(trackOrResult, t) {
  const track = trackOf(trackOrResult);
  if (!track.length || !(t >= track[0].start) || t >= track[track.length - 1].end) return -1;
  let lo = 0;
  let hi = track.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (track[mid].start <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Weighted sum of viseme shapes. */
export function shapeOf(weights) {
  const out = { open: 0, wide: 0, round: 0, teeth: 0, tongue: 0, bite: 0, press: 0 };
  for (const [v, w] of Object.entries(weights)) {
    if (!w) continue;
    const s = VISEME_SHAPES[v];
    if (s) for (const k of SHAPE_KEYS) out[k] += s[k] * w;
  }
  return out;
}

/** Linear mix of two shapes (k = 0 → a, 1 → b). */
export function mixShapes(a, b, k) {
  const out = {};
  for (const key of SHAPE_KEYS) out[key] = (a[key] ?? 0) + ((b[key] ?? 0) - (a[key] ?? 0)) * k;
  return out;
}

/**
 * Viseme at time t with smooth crossfades of `blend` seconds around each boundary.
 * @returns {{ viseme, weights: Record<viseme, number>, shape, index }} weights sum to 1.
 */
export function visemeAt(trackOrResult, t, { blend = 0.06 } = {}) {
  const track = trackOf(trackOrResult);
  const weights = Object.fromEntries(VISEMES.map((v) => [v, 0]));
  const i = segmentIndexAt(track, t);
  if (i < 0) {
    weights.rest = 1;
    return { viseme: 'rest', weights, shape: shapeOf(weights), index: -1 };
  }
  const seg = track[i];
  const len = seg.end - seg.start;
  const prev = track[i - 1];
  const next = track[i + 1];
  const hStart = Math.min(blend, len / 2, prev ? (prev.end - prev.start) / 2 : blend);
  const hEnd = Math.min(blend, len / 2, next ? (next.end - next.start) / 2 : blend);
  const ds = t - seg.start;
  const de = seg.end - t;
  let cur = 1;
  if (hStart > 0 && ds < hStart) {
    cur = smooth((ds + hStart) / (2 * hStart));
    weights[prev ? prev.viseme : 'rest'] += 1 - cur;
  } else if (hEnd > 0 && de < hEnd) {
    cur = 1 - smooth((hEnd - de) / (2 * hEnd));
    weights[next ? next.viseme : 'rest'] += 1 - cur;
  }
  weights[seg.viseme] += cur;
  let viseme = seg.viseme;
  for (const v of VISEMES) if (weights[v] > weights[viseme]) viseme = v;
  return { viseme, weights, shape: shapeOf(weights), index: i };
}

/** Word being spoken at t (pauses keep the previous word); -1 before the first word or after the end. */
export function wordIndexAt(trackOrResult, t) {
  const track = trackOf(trackOrResult);
  let i = segmentIndexAt(track, t);
  for (; i >= 0; i--) if (track[i].wordIndex >= 0) return track[i].wordIndex;
  return -1;
}

/** Word containing (or just before) a character offset, e.g. from SpeechSynthesisUtterance boundary events. */
export function wordIndexAtChar(words, charIndex) {
  if (!words?.length) return -1;
  let lo = 0;
  let hi = words.length - 1;
  if (charIndex < words[0].charStart) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (words[mid].charStart <= charIndex) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Credits for a script: 2 per started 10 s of estimated speech, minimum 2. */
export function creditsFor(script, { rate = 1 } = {}) {
  const { duration } = buildTrack(script, { rate });
  return Math.max(2, Math.ceil(duration / 10 - 1e-9) * 2);
}

/** Short stats for the UI. */
export function estimate(script, { rate = 1 } = {}) {
  const res = buildTrack(script, { rate });
  return { duration: res.duration, words: res.words.length, chars: String(script ?? '').length, credits: creditsFor(script, { rate }) };
}

/** "8.4s" under a minute, "1:05" above. */
export function formatSeconds(s) {
  const v = Math.max(0, Number(s) || 0);
  if (v < 60) return `${v.toFixed(1)}s`;
  const m = Math.floor(v / 60);
  return `${m}:${String(Math.round(v - m * 60)).padStart(2, '0')}`;
}

/**
 * Group words into caption pages of at most `maxChars` characters, breaking after sentence ends.
 * @returns {[start, end][]} half-open word index ranges.
 */
export function captionPages(words, maxChars = 34) {
  const pages = [];
  let start = 0;
  let len = 0;
  (words ?? []).forEach((w, i) => {
    const add = w.word.length + (i > start ? 1 : 0);
    if (i > start && len + add > maxChars) { pages.push([start, i]); start = i; len = w.word.length; } else len += add;
    if (w.pause >= 0.5 && i < words.length - 1) { pages.push([start, i + 1]); start = i + 1; len = 0; }
  });
  if (words?.length && start < words.length) pages.push([start, words.length]);
  return pages;
}

/** Page index that contains word `wordIndex` (-1 if none). */
export function pageAt(pages, wordIndex) {
  return pages.findIndex(([a, b]) => wordIndex >= a && wordIndex < b);
}

// ---------------------------------------------------------------- idle motion

/** Deterministic pseudo-random in [0, 1). */
export function rand(k, seed = 0) {
  const x = Math.sin(k * 127.1 + seed * 311.7 + 0.5) * 43758.5453;
  return x - Math.floor(x);
}

const BLINK = 0.17;

/** Eyelid closure 0 (open) .. 1 (closed) at time t. Blinks every ~2–5 s, scaled by rate. */
export function blinkAt(t, { rate = 1, seed = 0 } = {}) {
  if (!(t >= 0)) return 0;
  const r = clamp(rate, 0.2, 4);
  let start = 0.9 + rand(0, seed) * 1.4;
  let k = 0;
  while (start + BLINK < t && k < 1e5) { k++; start += (2.1 + rand(k, seed) * 3.1) / r; }
  if (t < start) return 0;
  return Math.sin(Math.PI * clamp((t - start) / BLINK, 0, 1));
}

/** Small eye saccades: { x, y } in -1..1 (x) / -0.6..0.6 (y). */
export function gazeAt(t, { seed = 0 } = {}) {
  if (!(t >= 0)) return { x: 0, y: 0 };
  let start = 0;
  let k = 0;
  let len = 1.2 + rand(1000, seed) * 1.8;
  while (start + len < t && k < 1e5) { start += len; k++; len = 1.2 + rand(1000 + k, seed) * 1.8; }
  const target = (j) => (j % 3 === 0 ? { x: 0, y: 0 } : { x: (rand(j * 2, seed) - 0.5) * 1.4, y: (rand(j * 2 + 1, seed) - 0.5) * 0.8 });
  const a = target(k - 1 < 0 ? 0 : k - 1);
  const b = target(k);
  const u = smooth((t - start) / 0.09);
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

/**
 * Head pose: x/y offset as a fraction of frame size, roll in radians, scale ~1.
 * `talk` (0..1, usually mouth openness) adds a little speech nod.
 */
export function headPose(t, { emotion = 'neutral', talk = 0, seed = 0 } = {}) {
  const e = emotionOf(emotion);
  const a = e.headAmp;
  const tk = clamp(talk, 0, 1);
  const p = seed * 1.7;
  return {
    x: a * (0.006 * Math.sin(0.63 * t + p) + 0.003 * Math.sin(1.71 * t + 2.1)),
    y: a * 0.004 * Math.sin(0.9 * t + 1.3 + p) + tk * 0.005 * e.nod,
    rot: a * (0.016 * Math.sin(0.52 * t + 0.7 + p) + 0.007 * Math.sin(1.37 * t + p)) + tk * 0.012 * e.nod * Math.sin(3.1 * t),
    scale: 1 + a * 0.004 * Math.sin(0.41 * t + p),
  };
}
