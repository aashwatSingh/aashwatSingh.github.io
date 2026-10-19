// Procedural "AI" painter. Deterministic: same (prompt, seed, style) -> same picture.
// The top half (hashing, PRNG, noise, palettes, prompt analysis) is pure and runs in Node.
// Painting draws in normalised units (short side = 1) so composition is resolution independent.

export const STYLES = [
  { id: 'cinematic', name: 'Cinematic', description: 'Teal-and-orange grade, soft bloom and film grain' },
  { id: 'realistic', name: 'Realistic', description: 'Natural colour with gentle contrast' },
  { id: 'editorial', name: 'Editorial', description: 'Muted magazine tones with lifted blacks' },
  { id: 'anime', name: 'Anime', description: 'Cel-shaded colour with ink outlines' },
  { id: 'film-noir', name: 'Film Noir', description: 'High-contrast black and white' },
  { id: 'vaporwave', name: 'Vaporwave', description: 'Pink-cyan grade, scanlines, RGB split' },
  { id: 'analog-film', name: 'Analog Film', description: 'Faded 35mm with light leaks and date stamp' },
  { id: '3d-render', name: '3D Render', description: 'Glossy, saturated, tilt-shift depth' },
  { id: 'watercolor', name: 'Watercolor', description: 'Paper texture and pigment bleed' },
  { id: 'y2k', name: 'Y2K', description: 'Chrome halftone, sparkles and RGB split' },
  { id: 'ethereal', name: 'Ethereal', description: 'Dreamy haze and pastel glow' },
  { id: 'pixel', name: 'Pixel Art', description: 'Chunky pixels on a reduced palette' },
];

export const SCENES = ['sunset', 'city', 'cyberpunk', 'rain', 'forest', 'ocean', 'beach', 'mountain', 'snow',
  'desert', 'space', 'portrait', 'car', 'abstract', 'flower'];

// ---------------------------------------------------------------- hashing, PRNG, noise

/** FNV-1a with a murmur finaliser. Returns a uint32. */
export function hashSeed(str) {
  const s = String(str ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Seeded PRNG: returns a function yielding floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lattice(s, x, y) {
  let h = (s ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 2D value noise in [0, 1] with fbm and ridged variants. */
export function makeNoise(seed) {
  const s = seed >>> 0;
  const n2 = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const a = lattice(s, xi, yi), b = lattice(s, xi + 1, yi);
    const c = lattice(s, xi, yi + 1), d = lattice(s, xi + 1, yi + 1);
    const top = a + (b - a) * u;
    return top + (c + (d - c) * u - top) * v;
  };
  const fbm = (x, y, oct = 5) => {
    let sum = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { sum += amp * n2(x * f + i * 17.3, y * f - i * 9.1); norm += amp; amp *= 0.5; f *= 2.03; }
    return sum / norm;
  };
  const ridged = (x, y, oct = 5) => {
    let sum = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      const v = 1 - Math.abs(n2(x * f + i * 31.7, y * f + i * 5.3) * 2 - 1);
      sum += amp * v * v; norm += amp; amp *= 0.5; f *= 2.1;
    }
    return sum / norm;
  };
  return { n2, fbm, ridged };
}

// ---------------------------------------------------------------- colour

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2;
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

export function hexToRgb(hex) {
  let s = String(hex).replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex(c) {
  return '#' + c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
}
const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
/** Mix two hex colours: t=0 -> a, t=1 -> b. */
export function mixHex(a, b, t) { return rgbToHex(mixc(hexToRgb(a), hexToRgb(b), clamp(t))); }
const mul = (c, k) => [clamp(c[0] * k, 0, 255), clamp(c[1] * k, 0, 255), clamp(c[2] * k, 0, 255)];
const lum = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
const saturate = (c, k) => { const l = lum(c); return c.map((v) => clamp(l + (v - l) * k, 0, 255)); };
const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a < 0 ? 0 : a > 1 ? 1 : a})`;

// Palette roles: sky top, sky mid, horizon glow, light source, accent, shadow, land.
const ROLES = ['top', 'mid', 'hor', 'light', 'accent', 'shadow', 'land'];
const TIMES = {
  sunset: ['#1b1546', '#7b2f6c', '#ff7b47', '#ffd47e', '#ff4d6d', '#150b22', '#2b1731'],
  golden: ['#2c3f78', '#c47c5e', '#ffb45e', '#fff0c4', '#ff8f3f', '#1f1626', '#3b2b2b'],
  dawn: ['#273863', '#9b80b2', '#ffc3a2', '#fff3d8', '#ff9eb5', '#1b2236', '#2f3b4c'],
  day: ['#1d5cc0', '#6ea8e8', '#d8ecf8', '#fffaf0', '#ffc65c', '#1b2a36', '#3a5a3f'],
  dusk: ['#0e1434', '#3b3578', '#c56b9b', '#ffd2b9', '#7a6cff', '#0a0c1e', '#1b1a34'],
  night: ['#030612', '#0b1a3a', '#26446f', '#eef3ff', '#5cc8ff', '#02040b', '#0a1222'],
  neon: ['#090222', '#2d0b54', '#ff2e88', '#ffd6f5', '#00e5ff', '#05010d', '#0d0619'],
  space: ['#010109', '#100b31', '#4d1e7b', '#ffe2b8', '#38d0ff', '#000004', '#0b0b18'],
  winter: ['#567db8', '#a9c5e8', '#e9f2fb', '#ffffff', '#7fc8ff', '#26344d', '#dfe9f5'],
  storm: ['#161c25', '#384451', '#7c8791', '#d9dee3', '#9fd3ff', '#0b0e12', '#1c2228'],
  studio: ['#0b0b10', '#1d1a2c', '#3c3052', '#ffe6cc', '#ff5e8a', '#050507', '#14121c'],
  vivid: ['#0c0632', '#3d0f7c', '#ff3d81', '#ffd166', '#21d4fd', '#07031a', '#150830'],
};
const SCENE_LAND = { forest: '#16341f', desert: '#cf8c4c', beach: '#e3c08a', snow: '#e2ebf5', flower: '#2f5a32', mountain: '#26324a' };

const COLORS = {
  red: '#ff3b3b', crimson: '#dc143c', scarlet: '#ff2a12', ruby: '#e0115f', burgundy: '#8c1c3a', orange: '#ff8a2b',
  amber: '#ffb000', gold: '#ffc23d', golden: '#ffbf40', yellow: '#ffe14d', lime: '#b6ff3b', green: '#34d27b',
  emerald: '#10b981', mint: '#8ff0c8', olive: '#8a9a3b', teal: '#14b8a6', turquoise: '#2dd4cf', cyan: '#22d3ee',
  aqua: '#3fe0ff', blue: '#3b82f6', azure: '#3fa9ff', cobalt: '#1f4fd8', navy: '#1e2a6e', indigo: '#5b4bdb',
  purple: '#9b5cf6', violet: '#8b5cf6', lavender: '#b9a4ff', lilac: '#c8a2c8', magenta: '#ff2ec4', pink: '#ff6fae',
  coral: '#ff7f6b', peach: '#ffb38a', salmon: '#fa8072', brown: '#8b5a3c', copper: '#c8733a', bronze: '#b0804b',
  silver: '#c9ced6', white: '#f4f6fb', black: '#0b0b0f', sepia: '#a47c48', beige: '#e8d5b0', ivory: '#fff6e0',
};
const NEUTRAL_COLORS = new Set(['white', 'black', 'silver', 'ivory', 'beige']);

// ---------------------------------------------------------------- prompt analysis

const LEX = {
  portraitStrong: ['portrait', 'face', 'headshot', 'selfie', 'close-up', 'closeup', 'close up', 'bust', 'beauty shot'],
  person: ['woman', 'man', 'girl', 'boy', 'person', 'lady', 'guy', 'model', 'actress', 'actor', 'warrior', 'samurai',
    'queen', 'king', 'princess', 'prince', 'knight', 'dancer', 'singer', 'child', 'kid', 'character', 'businessman',
    'detective', 'wizard', 'witch', 'elf', 'cowboy', 'ninja', 'monk', 'hero', 'figure', 'silhouette', 'traveler',
    'traveller', 'hiker', 'explorer', 'couple', 'people', 'stranger', 'soldier', 'pilot', 'surfer', 'skater'],
  car: ['car', 'sports car', 'supercar', 'hypercar', 'vehicle', 'porsche', 'ferrari', 'lamborghini', 'mustang', 'racing',
    'race car', 'drift', 'drifting', 'muscle car', 'convertible', 'sedan', 'coupe', 'roadster', 'tesla', 'bmw', 'audi',
    'jeep', 'taxi', 'motorsport', 'road trip', 'driving'],
  cyberpunk: ['cyberpunk', 'blade runner', 'cyber', 'synthwave', 'hologram', 'holographic', 'dystopian', 'futuristic city',
    'sci-fi city', 'megacity', 'neo tokyo'],
  city: ['city', 'skyline', 'downtown', 'street', 'tokyo', 'new york', 'manhattan', 'skyscraper', 'urban', 'metropolis',
    'alley', 'rooftop', 'building', 'highway', 'bridge', 'paris', 'london', 'hong kong', 'shanghai', 'seoul', 'traffic',
    'cityscape', 'times square', 'chicago', 'dubai'],
  space: ['space', 'galaxy', 'nebula', 'planet', 'cosmos', 'cosmic', 'universe', 'saturn', 'jupiter', 'mars',
    'outer space', 'astronaut', 'spaceship', 'starfield', 'star field', 'black hole', 'supernova', 'orbit', 'exoplanet', 'moon surface'],
  beach: ['beach', 'tropical', 'palm', 'island', 'shore', 'surf', 'lagoon', 'paradise', 'seaside', 'coconut', 'maldives', 'hawaii'],
  ocean: ['ocean', 'sea', 'wave', 'seascape', 'sail', 'sailboat', 'boat', 'lighthouse', 'harbor', 'harbour', 'coast',
    'coastline', 'pier', 'marina', 'bay', 'yacht', 'ship'],
  forest: ['forest', 'woods', 'woodland', 'tree', 'jungle', 'pine', 'redwood', 'grove', 'enchanted', 'rainforest',
    'cabin', 'autumn', 'taiga', 'treehouse', 'fairy forest', 'misty woods'],
  mountain: ['mountain', 'peak', 'alps', 'himalaya', 'valley', 'hill', 'landscape', 'highlands', 'volcano', 'fjord',
    'lake', 'glacier', 'everest', 'ridge', 'summit', 'cliff', 'castle', 'patagonia', 'yosemite', 'scenery'],
  desert: ['desert', 'dune', 'sahara', 'sand', 'arid', 'canyon', 'mesa', 'cactus', 'oasis', 'camel', 'wasteland', 'dunes', 'arizona'],
  flower: ['flower', 'rose', 'tulip', 'daisy', 'sunflower', 'blossom', 'cherry blossom', 'sakura', 'bouquet', 'garden',
    'floral', 'petal', 'lotus', 'orchid', 'bloom', 'lavender', 'poppy', 'lily', 'peony', 'botanical', 'meadow', 'wildflower'],
  abstract: ['abstract', 'fluid', 'flowing', 'swirl', 'shapes', 'geometric', 'pattern', 'liquid', 'silk', 'gradient',
    'ribbon', 'fractal', 'marble', 'ink', 'smoke', 'energy', 'aura', 'psychedelic', 'kaleidoscope', 'wallpaper',
    'iridescent', 'rainbow', 'waves of color', 'chromatic', 'flow'],
  snow: ['snow', 'snowy', 'winter', 'blizzard', 'frozen', 'ice', 'icy', 'arctic', 'snowfall', 'christmas', 'frost', 'frosty', 'snowflake'],
  rain: ['rain', 'rainy', 'raining', 'downpour', 'drizzle', 'monsoon', 'thunderstorm', 'wet', 'puddle', 'umbrella'],
  fog: ['fog', 'foggy', 'mist', 'misty', 'haze', 'hazy', 'smoky'],
};
const TIME_LEX = {
  golden: ['golden hour', 'warm light', 'late afternoon'],
  sunset: ['sunset', 'sundown', 'evening', 'afterglow'],
  dawn: ['dawn', 'sunrise', 'morning', 'daybreak'],
  dusk: ['dusk', 'twilight', 'blue hour'],
  day: ['daytime', 'noon', 'sunny', 'midday', 'summer', 'afternoon', 'blue sky', 'clear sky', 'sunshine', 'day'],
  night: ['night', 'midnight', 'moon', 'moonlit', 'moonlight', 'starry', 'stars', 'nocturnal', 'milky way', 'nighttime'],
  storm: ['storm', 'stormy', 'thunder', 'overcast', 'cloudy', 'lightning'],
};
const MOOD_LEX = {
  dark: ['dark', 'moody', 'gloomy', 'ominous', 'noir', 'grim', 'sinister', 'melancholic', 'melancholy', 'eerie',
    'haunted', 'gothic', 'shadowy', 'horror', 'brooding', 'mysterious'],
  dreamy: ['dreamy', 'ethereal', 'soft', 'whimsical', 'magical', 'fairy', 'fantasy', 'serene', 'calm',
    'peaceful', 'gentle', 'dreamlike', 'heavenly', 'tranquil', 'romantic'],
  bright: ['bright', 'vibrant', 'cheerful', 'colorful', 'colourful', 'vivid', 'happy', 'radiant', 'luminous', 'joyful', 'playful', 'pop'],
  epic: ['epic', 'dramatic', 'cinematic', 'majestic', 'grand', 'powerful', 'intense', 'heroic', 'massive', 'awe'],
};
const FLAG_LEX = {
  neon: ['neon', 'glowing', 'fluorescent', 'synthwave', 'glow'],
  pastel: ['pastel', 'soft colors', 'soft colours', 'candy'],
  mono: ['monochrome', 'black and white', 'black & white', 'b&w', 'grayscale', 'greyscale', 'noir'],
  sepia: ['sepia', 'vintage', 'antique'],
};
const PROP_LEX = {
  lighthouse: ['lighthouse'], boat: ['boat', 'sailboat', 'sail', 'yacht', 'ship'], cabin: ['cabin', 'cottage', 'house', 'hut'],
  castle: ['castle', 'palace', 'fortress'], cactus: ['cactus', 'cacti'], birds: ['bird', 'birds', 'seagull', 'flock'],
  palm: ['palm', 'tropical', 'island', 'coconut'], moon: ['moon', 'moonlit', 'moonlight', 'full moon'], lake: ['lake', 'reflection', 'mirror'],
  galaxy: ['galaxy', 'milky way', 'spiral'], rings: ['saturn', 'rings', 'ringed'], umbrella: ['umbrella'],
  sakura: ['cherry blossom', 'sakura', 'cherry'], rose: ['rose', 'roses', 'peony'], daisy: ['daisy', 'sunflower', 'sunflowers'],
  tulip: ['tulip', 'tulips'],
};
const DEFAULT_TIME = {
  sunset: 'sunset', city: 'night', cyberpunk: 'neon', rain: 'night', snow: 'winter', forest: 'dawn', ocean: 'sunset',
  beach: 'day', mountain: 'golden', desert: 'golden', space: 'space', abstract: 'vivid', flower: 'dawn', studio: 'studio',
};
const FALLBACK = ['sunset', 'mountain', 'abstract', 'ocean', 'space', 'forest', 'city', 'desert'];

const reCache = new Map();
function wordRe(w) {
  let re = reCache.get(w);
  if (!re) {
    const e = w.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&').replace(/ /g, '[\\s-]+');
    re = new RegExp(`(^|[^a-z0-9])${e}(s|es)?(?=$|[^a-z0-9])`, 'g');
    reCache.set(w, re);
  }
  re.lastIndex = 0;
  return re;
}
/** All matches of `list` in `text` as [{ word, index }], earliest first. */
function find(text, list) {
  const out = [];
  for (const w of list) {
    const re = wordRe(w);
    const m = re.exec(text);
    if (m) out.push({ word: w, index: m.index + m[1].length });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Read a prompt into painting directions. Pure and deterministic.
 * @returns {{scene:string, palette:string[], mood:string, keywords:string[], time:string, weather:string|null,
 *   colors:string[], flags:object, props:string[], figure:boolean, backdrop:string|null}}
 */
export function analyzePrompt(prompt) {
  const text = String(prompt ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const hits = {};
  const kw = [];
  const note = (arr) => { for (const m of arr) kw.push(m); return arr; };
  for (const k of Object.keys(LEX)) hits[k] = note(find(text, LEX[k]));
  const first = (arr) => (arr.length ? arr[0].index : Infinity);

  const locations = ['cyberpunk', 'city', 'space', 'beach', 'ocean', 'forest', 'mountain', 'desert', 'flower', 'abstract'];
  let loc = null, best = 0, bestIdx = Infinity;
  for (const l of locations) {
    const score = hits[l].length * (l === 'cyberpunk' ? 2 : 1);
    if (score > best || (score === best && score > 0 && first(hits[l]) < bestIdx)) { loc = l; best = score; bestIdx = first(hits[l]); }
  }
  const flagsHits = {};
  for (const k of Object.keys(FLAG_LEX)) flagsHits[k] = note(find(text, FLAG_LEX[k]));
  const flags = { neon: flagsHits.neon.length > 0, pastel: flagsHits.pastel.length > 0, mono: flagsHits.mono.length > 0, sepia: flagsHits.sepia.length > 0 };
  if (!loc && flags.neon) loc = 'city';

  const strongPortrait = hits.portraitStrong.length > 0;
  const person = hits.person.length > 0;
  let scene;
  let backdrop = null;
  if (strongPortrait || (person && !loc && !hits.car.length)) scene = 'portrait';
  else if (hits.car.length) scene = 'car';
  else if (loc) scene = loc;
  else if (hits.snow.length) scene = 'snow';
  else if (hits.rain.length) scene = 'rain';
  else if (find(text, TIME_LEX.sunset).length || find(text, TIME_LEX.golden).length || find(text, TIME_LEX.dawn).length) scene = 'sunset';
  else if (find(text, TIME_LEX.night).length) scene = 'mountain';
  else scene = FALLBACK[hashSeed(text) % FALLBACK.length];

  if (scene === 'portrait' || scene === 'car') {
    backdrop = loc || (hits.snow.length ? 'snow' : hits.rain.length ? 'rain' : null);
    if (!backdrop) backdrop = scene === 'car' ? 'city' : 'studio';
    if (backdrop === 'abstract' && scene === 'car') backdrop = 'city';
  }

  // time of day
  let time = null, tIdx = Infinity;
  for (const [t, words] of Object.entries(TIME_LEX)) {
    const m = note(find(text, words));
    if (m.length && m[0].index < tIdx) { time = t; tIdx = m[0].index; }
  }
  const ref = backdrop || scene;
  if (flags.neon && ['city', 'cyberpunk', 'portrait', 'car', 'rain', 'studio'].includes(ref) && (!time || time === 'night')) time = 'neon';
  if (!time) time = scene === 'car' && ref === 'city' ? 'dusk' : DEFAULT_TIME[ref] || 'sunset';
  if (ref === 'space') time = 'space';

  // weather
  let weather = null;
  if (hits.snow.length || scene === 'snow') weather = 'snow';
  else if (hits.rain.length || scene === 'rain' || time === 'storm') weather = 'rain';
  else if (hits.fog.length) weather = 'fog';
  if (weather === 'snow' && tIdx === Infinity) time = 'winter';
  if (weather === 'rain' && tIdx === Infinity && !['city', 'cyberpunk', 'rain'].includes(ref)) time = 'storm';

  // mood
  let mood = 'neutral', mIdx = Infinity;
  for (const [m, words] of Object.entries(MOOD_LEX)) {
    const f = note(find(text, words));
    if (f.length && f[0].index < mIdx) { mood = m; mIdx = f[0].index; }
  }

  const colorHits = note(find(text.replace(/golden hour/g, ''), Object.keys(COLORS)));
  const colors = colorHits.map((m) => m.word).filter((c, i, a) => a.indexOf(c) === i);
  const props = [];
  for (const [p, words] of Object.entries(PROP_LEX)) if (find(text, words).length) props.push(p);

  const keywords = kw.sort((a, b) => a.index - b.index).map((m) => m.word).filter((w, i, a) => a.indexOf(w) === i);
  const a = { scene, time, weather, mood, colors, flags, props, figure: person && scene !== 'portrait', backdrop, keywords };
  a.palette = buildPalette(a).map(rgbToHex);
  return a;
}

/** Palette (7 rgb arrays) for an analysis: time of day, then scene land, colour words, flags and mood. */
export function buildPalette({ scene, time, colors = [], flags = {}, mood = 'neutral', backdrop = null }) {
  let p = (TIMES[time] || TIMES.sunset).map(hexToRgb);
  const landKey = SCENE_LAND[scene] ? scene : SCENE_LAND[backdrop] ? backdrop : null;
  if (landKey) p[6] = mixc(hexToRgb(SCENE_LAND[landKey]), p[6], time === 'night' || time === 'neon' ? 0.65 : 0.3);
  const vivid = colors.filter((c) => !NEUTRAL_COLORS.has(c));
  if (vivid.length) {
    const c1 = hexToRgb(COLORS[vivid[0]]);
    const c2 = vivid[1] ? hexToRgb(COLORS[vivid[1]]) : c1;
    p[4] = c1;
    p[2] = mixc(p[2], c1, 0.6);
    p[3] = mixc(p[3], mixc(c1, WHITE, 0.65), 0.45);
    p[1] = mixc(p[1], c2, vivid[1] ? 0.5 : 0.28);
    p[0] = mixc(p[0], mul(c2, 0.32), vivid[1] ? 0.4 : 0.18);
    p[5] = mixc(p[5], mul(c2, 0.18), 0.35);
    p[6] = mixc(p[6], c1, 0.14);
  } else if (colors.includes('white')) {
    p = p.map((c, i) => (i === 5 || i === 0 ? c : mixc(c, WHITE, 0.2)));
  }
  if (flags.neon) p = p.map((c, i) => (i === 5 ? c : saturate(c, 1.35)));
  if (flags.pastel) p = p.map((c, i) => mixc(saturate(c, 0.85), [255, 238, 248], i === 5 ? 0.25 : 0.38));
  if (mood === 'dark') p = p.map((c, i) => saturate(mul(c, i === 3 || i === 4 ? 0.88 : 0.6), 0.78));
  else if (mood === 'dreamy') p = p.map((c, i) => mixc(saturate(c, 0.9), [255, 236, 246], i === 5 ? 0.15 : 0.24));
  else if (mood === 'bright') p = p.map((c) => saturate(mixc(c, WHITE, 0.07), 1.18));
  else if (mood === 'epic') p = p.map((c, i) => (i === 0 || i === 5 ? mul(c, 0.78) : i === 2 || i === 3 ? mixc(c, WHITE, 0.08) : c));
  if (flags.mono) p = p.map((c) => saturate(c, 0));
  else if (flags.sepia) p = p.map((c) => mixc(c, mul([164, 124, 72], lum(c) / 128), 0.55));
  return p;
}

// ---------------------------------------------------------------- canvas helpers

function makeCanvas(w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function grad(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(clamp(o), c);
  return g;
}
function rgrad(ctx, x, y, r, stops, r0 = 0) {
  const g = ctx.createRadialGradient(x, y, r0, x, y, Math.max(1e-6, r));
  for (const [o, c] of stops) g.addColorStop(clamp(o), c);
  return g;
}
/** Low-res RGBA texture from fn(u, v, out[4]); upscaled later, which gives free softness. */
function texture(tw, th, fn) {
  tw = Math.max(2, Math.round(tw)); th = Math.max(2, Math.round(th));
  const c = makeCanvas(tw, th);
  const x = c.getContext('2d');
  const img = x.createImageData(tw, th);
  const d = img.data;
  const out = [0, 0, 0, 0];
  for (let j = 0; j < th; j++) {
    for (let i = 0; i < tw; i++) {
      fn(i / (tw - 1), j / (th - 1), out);
      const k = (j * tw + i) * 4;
      d[k] = out[0]; d[k + 1] = out[1]; d[k + 2] = out[2]; d[k + 3] = out[3];
    }
  }
  x.putImageData(img, 0, 0);
  return c;
}
function glowDot(ctx, x, y, r, c, a) {
  ctx.fillStyle = rgrad(ctx, x, y, r, [[0, css(c, a)], [0.25, css(c, a * 0.45)], [1, css(c, 0)]]);
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}
const isNight = (a) => a.time === 'night' || a.time === 'neon' || a.time === 'space';
const has = (a, p) => a.props.includes(p);

/** Mirror everything above yN into the area below it, sliced with sine ripples (water / wet street). */
function reflect(S, yN, { alpha = 0.55, ripple = 1, freq = 1 } = {}) {
  const { ctx, w, h, U } = S;
  const hp = Math.round(yN * U);
  if (hp <= 2 || hp >= h) return;
  const copy = makeCanvas(w, hp);
  copy.getContext('2d').drawImage(ctx.canvas, 0, 0, w, hp, 0, 0, w, hp);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = alpha;
  const sl = Math.max(1, Math.round(h / 420));
  for (let y = hp; y < h; y += sl) {
    const d = y - hp;
    const sy = hp - d - sl;
    if (sy < 0) break;
    const k = d / U;
    const off = Math.sin(k * 140 * freq + Math.sin(k * 31) * 2.4) * ripple * U * (0.0015 + k * 0.016);
    ctx.drawImage(copy, 0, sy, w, sl, off, y, w, sl);
  }
  ctx.restore();
}

/** Blur a region by drawing it through a small canvas. */
function softCopy(S, div) {
  const { ctx, w, h } = S;
  const c = makeCanvas(w / div, h / div);
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, c.width, c.height);
  return c;
}

// ---------------------------------------------------------------- sky pieces

function sky(S, hz) {
  const { ctx, W, H, P } = S;
  ctx.fillStyle = grad(ctx, 0, 0, 0, hz, [[0, css(P.top)], [0.42, css(mixc(P.top, P.mid, 0.78))],
    [0.78, css(mixc(P.mid, P.hor, 0.55))], [1, css(P.hor)]]);
  ctx.fillRect(0, 0, W, H);
}

function sun(S, x, y, r, { moon = false, glow = 1 } = {}) {
  const { ctx, P } = S;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const halo = moon ? mixc(P.mid, P.light, 0.3) : P.hor;
  ctx.fillStyle = rgrad(ctx, x, y, r * 16, [[0, css(halo, 0.5 * glow)], [0.22, css(halo, 0.22 * glow)], [0.6, css(halo, 0.06 * glow)], [1, css(halo, 0)]]);
  ctx.fillRect(x - r * 16, y - r * 16, r * 32, r * 32);
  ctx.fillStyle = rgrad(ctx, x, y, r * 4, [[0, css(P.light, 0.85 * glow)], [0.3, css(P.light, 0.3 * glow)], [1, css(P.light, 0)]]);
  ctx.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);
  ctx.restore();
  const core = mixc(P.light, WHITE, moon ? 0.4 : 0.45);
  ctx.fillStyle = rgrad(ctx, x, y, r, [[0, css(core)], [0.8, css(mixc(core, P.light, 0.5))], [0.96, css(P.light, 0.95)], [1, css(P.light, 0)]]);
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  if (moon) {
    const rr = S.rng('moon');
    for (let i = 0; i < 7; i++) {
      const a = rr() * TAU, d = rr() * r * 0.65, cr = r * (0.08 + rr() * 0.18);
      ctx.fillStyle = css(mixc(P.mid, P.light, 0.5), 0.22);
      ctx.beginPath(); ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, cr, 0, TAU); ctx.fill();
    }
  }
}

function clouds(S, y0, y1, { cover = 0.5, sx = S.W / 2, key = 'cl', sy = 9, sxScale = 2.4, alpha = 1, day = false } = {}) {
  const { ctx, W, P } = S;
  if (y1 - y0 < 0.01) return;
  const N = S.noise(key);
  const tw = 200, th = Math.max(6, Math.round(200 * (y1 - y0) / W));
  const L = day ? mixc(P.light, WHITE, 0.4) : mixc(P.hor, P.light, 0.4);
  const D = day ? mixc(P.mid, mixc(P.top, WHITE, 0.4), 0.5) : mixc(P.mid, P.top, 0.45);
  const thr = 0.62 - cover * 0.24;
  const tex = texture(tw, th, (u, v, out) => {
    const x = u * W * sxScale, y = v * (y1 - y0) * sy;
    const wx = x + 1.6 * N.fbm(x * 0.5, y * 0.5, 3);
    const d = N.fbm(wx, y + N.n2(x, y) * 0.4, 5);
    const fade = smooth(0, 0.25, v) * smooth(1, 0.72, v);
    const al = smooth(thr, thr + 0.2, d) * fade;
    const prox = 1 - Math.min(1, Math.abs(u * W - sx) / (W * 0.65));
    const t = clamp((day ? 1 - v * 0.5 : v * 0.75) + prox * 0.38 - (d - thr) * 0.9);
    const c = mixc(D, L, t);
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = al * 255 * alpha;
  });
  ctx.drawImage(tex, 0, y0, W, y1 - y0);
}

function stars(S, n, y1, key = 'st') {
  const { ctx, W, P } = S;
  const r = S.rng(key);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < n; i++) {
    const x = r() * W, y = Math.pow(r(), 1.25) * y1, b = Math.pow(r(), 4);
    const sz = 0.0009 + b * 0.0028;
    const al = (0.35 + 0.65 * r()) * (1 - smooth(y1 * 0.55, y1, y) * 0.85);
    const c = mixc(WHITE, r() < 0.5 ? P.light : P.accent, r() * 0.45);
    ctx.fillStyle = css(c, al);
    ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
    if (b > 0.82) {
      glowDot(ctx, x, y, sz * 6, c, al * 0.45);
      ctx.fillStyle = css(c, al * 0.6);
      ctx.fillRect(x - sz * 6, y - sz * 0.15, sz * 12, sz * 0.3);
      ctx.fillRect(x - sz * 0.15, y - sz * 6, sz * 0.3, sz * 12);
    }
  }
  ctx.restore();
}

function milkyWay(S, cy) {
  const { ctx, W, H, P } = S;
  const r = S.rng('mw');
  const N = S.noise('mw');
  const L = Math.hypot(W, H) * 1.1;
  const tex = texture(260, 64, (u, v, out) => {
    const band = Math.exp(-Math.pow((v - 0.5) * 3.4, 2));
    const n = N.fbm(u * 9, v * 3, 5);
    const dust = N.fbm(u * 14 + 5, v * 5, 4);
    const al = band * smooth(0.3, 0.75, n) * (1 - 0.75 * smooth(0.5, 0.68, dust));
    const c = mixc(mixc(P.light, WHITE, 0.4), P.accent, clamp((n - 0.4) * 2));
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = al * 200;
  });
  ctx.save();
  ctx.translate(W * (0.35 + r() * 0.3), cy);
  ctx.rotate(-0.7 + r() * 0.5);
  ctx.globalCompositeOperation = 'screen';
  ctx.drawImage(tex, -L / 2, -0.17, L, 0.34);
  for (let i = 0; i < 420; i++) {
    const x = (r() - 0.5) * L, y = (r() + r() + r() - 1.5) * 0.09;
    ctx.fillStyle = css(WHITE, 0.3 + r() * 0.6);
    const s = 0.0008 + r() * 0.0014;
    ctx.fillRect(x, y, s, s);
  }
  ctx.restore();
}

function rays(S, x, y, n, len, alpha = 0.16) {
  const { ctx, P } = S;
  const r = S.rng('rays');
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 2 + (r() - 0.5) * 2.2, wa = 0.012 + r() * 0.04;
    const l = len * (0.6 + r() * 0.5);
    ctx.fillStyle = grad(ctx, x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, [[0, css(P.light, alpha * (0.5 + r()))], [1, css(P.light, 0)]]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a - wa) * l, y + Math.sin(a - wa) * l);
    ctx.lineTo(x + Math.cos(a + wa) * l, y + Math.sin(a + wa) * l);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function fogBand(S, y, hgt, c, a) {
  const { ctx, W } = S;
  ctx.fillStyle = grad(ctx, 0, y - hgt, 0, y + hgt * 0.35, [[0, css(c, 0)], [0.75, css(c, a)], [1, css(c, a * 0.6)]]);
  ctx.fillRect(0, y - hgt, W, hgt * 1.35);
}

function fogLayer(S, y0, y1, a = 0.5, key = 'fog') {
  const { ctx, W, P } = S;
  const N = S.noise(key);
  const c = mixc(P.light, P.hor, 0.35);
  const tex = texture(160, Math.max(8, 160 * (y1 - y0) / W), (u, v, out) => {
    const n = N.fbm(u * W * 3, v * (y1 - y0) * 9, 4);
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
    out[3] = 255 * a * smooth(0.35, 0.7, n) * smooth(0, 0.35, v) * smooth(1, 0.7, v);
  });
  ctx.drawImage(tex, 0, y0, W, y1 - y0);
}

// ---------------------------------------------------------------- terrain

function ridgeYs(S, { base, amp, freq, sharp = 0.5, key, oct = 6 }) {
  const N = S.noise(key);
  const n = 220;
  const raw = new Float32Array(n + 1);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * S.W * freq;
    const v = lerp(N.fbm(x, 0.5, oct), N.ridged(x * 0.8, 3.1, oct), sharp);
    raw[i] = v; if (v < lo) lo = v; if (v > hi) hi = v;
  }
  const ys = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) ys[i] = base - amp * ((raw[i] - lo) / (hi - lo || 1));
  return ys;
}
const ridgeX = (S, ys, i) => (i / (ys.length - 1)) * S.W;

function ridgePath(S, ys) {
  const { ctx, H, W } = S;
  ctx.beginPath();
  ctx.moveTo(-0.01, H + 0.01);
  for (let i = 0; i < ys.length; i++) ctx.lineTo(ridgeX(S, ys, i), ys[i]);
  ctx.lineTo(W + 0.01, H + 0.01);
  ctx.closePath();
}

function fillRidge(S, ys, col, { sx = S.W / 2, light = 0.15, snowy = false, rim = 0.25 } = {}) {
  const { ctx, W, H, P } = S;
  let top = Infinity, bot = -Infinity;
  for (const y of ys) { if (y < top) top = y; if (y > bot) bot = y; }
  ridgePath(S, ys);
  ctx.fillStyle = grad(ctx, 0, top, 0, bot + 0.15, [[0, css(mixc(col, P.light, light))], [0.6, css(col)], [1, css(mul(col, 0.7))]]);
  ctx.fill();
  ctx.fillStyle = grad(ctx, sx - W * 0.7, 0, sx + W * 0.7, 0, [[0, css(P.shadow, 0.18)], [0.5, css(P.light, light * 0.6)], [1, css(P.shadow, 0.18)]]);
  ctx.fill();
  if (snowy) {
    const N = S.noise('snow' + top.toFixed(3));
    const line = top + (bot - top) * 0.42;
    ctx.beginPath();
    ctx.moveTo(0, ys[0]);
    for (let i = 0; i < ys.length; i++) ctx.lineTo(ridgeX(S, ys, i), ys[i]);
    for (let i = ys.length - 1; i >= 0; i--) {
      const y = ys[i];
      const d = y < line ? (line - y) * (0.35 + 0.75 * N.fbm(i * 0.21, 1, 3)) : 0;
      ctx.lineTo(ridgeX(S, ys, i), y + d);
    }
    ctx.closePath();
    const snow = mixc(WHITE, P.light, 0.35);
    ctx.fillStyle = grad(ctx, 0, top, 0, line + 0.05, [[0, css(snow, 0.95)], [1, css(mixc(snow, col, 0.45), 0.85)]]);
    ctx.fill();
    ctx.fillStyle = grad(ctx, sx - W * 0.5, 0, sx + W * 0.5, 0, [[0, css(P.mid, 0.35)], [0.5, css(P.mid, 0)], [1, css(P.mid, 0.35)]]);
    ctx.fill();
  }
  if (rim > 0) {
    ctx.beginPath();
    for (let i = 0; i < ys.length; i++) ctx.lineTo(ridgeX(S, ys, i), ys[i]);
    ctx.strokeStyle = css(mixc(P.light, P.hor, 0.4), rim);
    ctx.lineWidth = 0.0018;
    ctx.stroke();
  }
  return { top, bot };
}

function pine(ctx, x, base, ht, r) {
  const wb = ht * (0.24 + r() * 0.1);
  const tiers = 6 + ((r() * 5) | 0);
  const pts = [];
  for (let i = 1; i <= tiers; i++) {
    const t = i / tiers;
    const y = base - ht + ht * t * 0.9;
    const wd = (wb * t * (0.8 + r() * 0.35)) / 2;
    pts.push([wd, y, wd * (0.45 + r() * 0.2), y + ht * 0.015]);
  }
  ctx.moveTo(x, base - ht);
  for (const [wd, y, wi, y2] of pts) { ctx.lineTo(x + wd, y); ctx.lineTo(x + wi, y2); }
  ctx.lineTo(x + ht * 0.025, base + 0.002); ctx.lineTo(x - ht * 0.025, base + 0.002);
  for (let i = pts.length - 1; i >= 0; i--) { const [wd, y, wi, y2] = pts[i]; ctx.lineTo(x - wi * 1.05, y2); ctx.lineTo(x - wd * 1.05, y); }
  ctx.closePath();
}

function roundTree(ctx, x, base, ht, r) {
  const rad = ht * 0.32;
  ctx.moveTo(x + ht * 0.03, base);
  ctx.rect(x - ht * 0.025, base - ht * 0.5, ht * 0.05, ht * 0.5);
  for (let i = 0; i < 6; i++) {
    const a = r() * TAU, d = r() * rad * 0.6;
    const cx = x + Math.cos(a) * d, cy = base - ht + rad + Math.sin(a) * d * 0.7;
    const cr = rad * (0.55 + r() * 0.45);
    ctx.moveTo(cx + cr, cy);
    ctx.arc(cx, cy, cr, 0, TAU);
  }
}

function treeLine(S, base, { hMin, hMax, gap, col, key, round = 0, snow = false, clear = 0 }) {
  const { ctx, W, P } = S;
  const r = S.rng(key);
  const N = S.noise(key);
  ctx.fillStyle = css(col);
  ctx.beginPath();
  let x = -0.03;
  const tips = [];
  while (x < W + 0.03) {
    const b = base + (N.fbm(x * 3, 0.3, 3) - 0.5) * 0.04;
    const ht = hMin + (hMax - hMin) * Math.pow(r(), 0.8);
    const skip = clear && Math.abs(x - W / 2) < (clear * W) / 2;
    if (skip) r();
    else if (r() < round) roundTree(ctx, x, b, ht, r); else { pine(ctx, x, b, ht, r); tips.push([x, b, ht]); }
    x += gap * (0.45 + r() * 0.9);
  }
  ctx.fill();
  if (!clear) ctx.fillRect(-0.01, base, W + 0.02, S.H - base + 0.01);
  if (snow && false) {
    ctx.fillStyle = css(mixc(WHITE, P.light, 0.3), 0.75);
    ctx.beginPath();
    for (const [tx, b, ht] of tips) {
      for (let k = 1; k < 5; k++) {
        const y = b - ht + ht * k * 0.2;
        const wd = ht * 0.12 * k * 0.3;
        ctx.moveTo(tx - wd, y + ht * 0.02);
        ctx.quadraticCurveTo(tx, y - ht * 0.03, tx + wd, y + ht * 0.02);
      }
    }
    ctx.fill();
  }
}

// ---------------------------------------------------------------- props

function person(ctx, x, gy, hh, col) {
  ctx.fillStyle = css(col);
  ctx.beginPath();
  ctx.ellipse(x, gy - hh * 0.91, hh * 0.06, hh * 0.072, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - hh * 0.035, gy - hh * 0.85);
  ctx.quadraticCurveTo(x - hh * 0.11, gy - hh * 0.84, x - hh * 0.12, gy - hh * 0.77);
  ctx.lineTo(x - hh * 0.14, gy - hh * 0.32);
  ctx.lineTo(x - hh * 0.06, gy - hh * 0.3);
  ctx.lineTo(x - hh * 0.055, gy);
  ctx.lineTo(x - hh * 0.015, gy);
  ctx.lineTo(x, gy - hh * 0.27);
  ctx.lineTo(x + hh * 0.015, gy);
  ctx.lineTo(x + hh * 0.055, gy);
  ctx.lineTo(x + hh * 0.06, gy - hh * 0.3);
  ctx.lineTo(x + hh * 0.14, gy - hh * 0.32);
  ctx.lineTo(x + hh * 0.12, gy - hh * 0.77);
  ctx.quadraticCurveTo(x + hh * 0.11, gy - hh * 0.84, x + hh * 0.035, gy - hh * 0.85);
  ctx.closePath();
  ctx.fill();
}

function umbrella(ctx, x, gy, hh, col) {
  ctx.fillStyle = css(col);
  ctx.beginPath();
  ctx.moveTo(x - hh * 0.32, gy - hh * 1.02);
  ctx.quadraticCurveTo(x, gy - hh * 1.42, x + hh * 0.32, gy - hh * 1.02);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(x - hh * 0.006, gy - hh * 1.2, hh * 0.012, hh * 0.45);
}

function palm(ctx, x, gy, hh, lean, r, col) {
  const tx = x + lean * hh, ty = gy - hh;
  const w0 = hh * 0.034, w1 = hh * 0.014;
  ctx.fillStyle = css(col);
  ctx.strokeStyle = css(col);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - w0, gy);
  ctx.quadraticCurveTo(x + lean * hh * 0.15 - w0, gy - hh * 0.55, tx - w1, ty);
  ctx.lineTo(tx + w1, ty);
  ctx.quadraticCurveTo(x + lean * hh * 0.15 + w0, gy - hh * 0.55, x + w0, gy);
  ctx.fill();
  const n = 9 + ((r() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const ang = -Math.PI / 2 + (i / (n - 1) - 0.5) * 3.6 + (r() - 0.5) * 0.3;
    const len = hh * (0.32 + r() * 0.16);
    const ex = tx + Math.cos(ang) * len, ey = ty + Math.sin(ang) * len * 0.35 + len * 0.42;
    const qx = tx + Math.cos(ang) * len * 0.6, qy = ty + Math.sin(ang) * len * 0.55 - len * 0.12;
    // frond: tapered blade with saw-tooth leaflets drooping under gravity
    const steps = 26, left = [], right = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps, u = 1 - t;
      const px = u * u * tx + 2 * u * t * qx + t * t * ex, py = u * u * ty + 2 * u * t * qy + t * t * ey;
      const dx = 2 * u * (qx - tx) + 2 * t * (ex - qx), dy = 2 * u * (qy - ty) + 2 * t * (ey - qy);
      const dl = Math.hypot(dx, dy) || 1;
      const nx = -dy / dl, ny = dx / dl;
      const wd = hh * 0.085 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.92 + 0.08)), 0.8) * (k % 2 ? 0.3 : 1);
      const droop = wd * 0.55;
      left.push([px + nx * wd + (dx / dl) * wd * 0.4, py + ny * wd + droop]);
      right.push([px - nx * wd + (dx / dl) * wd * 0.4, py - ny * wd + droop]);
    }
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    for (const [px, py] of left) ctx.lineTo(px, py);
    for (let k = right.length - 1; k >= 0; k--) ctx.lineTo(right[k][0], right[k][1]);
    ctx.closePath();
    ctx.fill();
  }
  ctx.beginPath();
  for (let k = 0; k < 3; k++) { ctx.moveTo(tx + hh * 0.03, ty + hh * 0.02); ctx.arc(tx + (k - 1) * hh * 0.022, ty + hh * 0.025, hh * 0.016, 0, TAU); }
  ctx.fill();
}

function birds(S, x0, y0, n, size) {
  const { ctx, P } = S;
  const r = S.rng('birds');
  ctx.strokeStyle = css(mul(P.shadow, 0.9), 0.85);
  ctx.lineWidth = size * 0.16;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = x0 + (r() - 0.3) * 0.25, y = y0 + (r() - 0.5) * 0.1, s = size * (0.5 + r() * 0.6);
    const flap = (r() - 0.5) * 0.6;
    ctx.moveTo(x - s, y - s * (0.3 + flap));
    ctx.quadraticCurveTo(x - s * 0.4, y - s * 0.55, x, y);
    ctx.quadraticCurveTo(x + s * 0.4, y - s * 0.55, x + s, y - s * (0.3 - flap));
  }
  ctx.stroke();
}

function lighthouse(S, x, gy, hh) {
  const { ctx, P, W } = S;
  const dark = mixc(P.shadow, P.mid, 0.2);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const lx = x, ly = gy - hh * 0.95;
  for (const dir of [-1, 1]) {
    ctx.fillStyle = grad(ctx, lx, ly, lx + dir * W * 0.6, ly, [[0, css(P.light, 0.45)], [1, css(P.light, 0)]]);
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + dir * W * 0.7, ly - hh * 0.35); ctx.lineTo(lx + dir * W * 0.7, ly + hh * 0.15); ctx.closePath(); ctx.fill();
  }
  glowDot(ctx, lx, ly, hh * 0.35, mixc(P.light, WHITE, 0.4), 0.9);
  ctx.restore();
  ctx.fillStyle = css(dark);
  ctx.beginPath();
  ctx.moveTo(x - hh * 0.07, gy); ctx.lineTo(x - hh * 0.045, gy - hh * 0.86); ctx.lineTo(x + hh * 0.045, gy - hh * 0.86); ctx.lineTo(x + hh * 0.07, gy); ctx.fill();
  ctx.fillStyle = css(mixc(dark, [180, 40, 40], 0.35));
  for (let k = 0; k < 3; k++) ctx.fillRect(x - hh * 0.065 + k * hh * 0.008, gy - hh * (0.2 + k * 0.25), hh * (0.13 - k * 0.016), hh * 0.09);
  ctx.fillStyle = css(mixc(P.light, WHITE, 0.6));
  ctx.fillRect(x - hh * 0.035, gy - hh * 0.99, hh * 0.07, hh * 0.1);
  ctx.fillStyle = css(dark);
  ctx.beginPath(); ctx.moveTo(x - hh * 0.06, gy - hh * 0.99); ctx.lineTo(x, gy - hh * 1.08); ctx.lineTo(x + hh * 0.06, gy - hh * 0.99); ctx.fill();
}

function boat(S, x, y, s) {
  const { ctx, P } = S;
  ctx.fillStyle = css(mul(P.shadow, 1.1), 0.92);
  ctx.beginPath();
  ctx.moveTo(x - s * 0.5, y); ctx.lineTo(x + s * 0.5, y); ctx.lineTo(x + s * 0.38, y + s * 0.12); ctx.lineTo(x - s * 0.4, y + s * 0.12); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x, y - s * 1.1); ctx.lineTo(x + s * 0.42, y - s * 0.06); ctx.lineTo(x, y - s * 0.06); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x - s * 0.03, y - s * 0.95); ctx.lineTo(x - s * 0.38, y - s * 0.06); ctx.lineTo(x - s * 0.03, y - s * 0.06); ctx.fill();
}

function cabin(S, x, gy, s, col) {
  const { ctx, P } = S;
  ctx.fillStyle = css(col);
  ctx.beginPath();
  ctx.moveTo(x - s * 0.55, gy); ctx.lineTo(x - s * 0.55, gy - s * 0.45); ctx.lineTo(x - s * 0.65, gy - s * 0.45);
  ctx.lineTo(x, gy - s * 0.95); ctx.lineTo(x + s * 0.65, gy - s * 0.45); ctx.lineTo(x + s * 0.55, gy - s * 0.45); ctx.lineTo(x + s * 0.55, gy);
  ctx.fill();
  ctx.fillRect(x + s * 0.25, gy - s * 0.95, s * 0.12, s * 0.3);
  const warm = [255, 196, 110];
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  glowDot(ctx, x - s * 0.2, gy - s * 0.25, s * 0.9, warm, 0.45);
  ctx.restore();
  ctx.fillStyle = css(warm);
  ctx.fillRect(x - s * 0.32, gy - s * 0.36, s * 0.22, s * 0.2);
  ctx.fillRect(x + s * 0.1, gy - s * 0.36, s * 0.2, s * 0.2);
  void P;
}

function castle(S, x, gy, s, col) {
  const { ctx } = S;
  const r = S.rng('castle');
  ctx.fillStyle = css(col);
  ctx.beginPath();
  ctx.rect(x - s * 0.5, gy - s * 0.4, s, s * 0.4);
  const towers = [[-0.5, 0.75, 0.12], [-0.18, 1.05, 0.14], [0.2, 0.85, 0.12], [0.5, 0.65, 0.1]];
  for (const [tx, th, tw] of towers) {
    const cx = x + tx * s;
    ctx.rect(cx - tw * s / 2, gy - th * s, tw * s, th * s);
    ctx.moveTo(cx - tw * s * 0.65, gy - th * s);
    ctx.lineTo(cx, gy - th * s - s * (0.22 + r() * 0.12));
    ctx.lineTo(cx + tw * s * 0.65, gy - th * s);
  }
  ctx.fill();
  ctx.fillStyle = 'rgba(255,200,120,0.9)';
  for (let i = 0; i < 9; i++) ctx.fillRect(x + (r() - 0.5) * s * 0.9, gy - s * (0.15 + r() * 0.6), s * 0.018, s * 0.035);
}

function cactus(S, x, gy, hh, col) {
  const { ctx } = S;
  ctx.fillStyle = css(col);
  const w = hh * 0.11;
  const pill = (x0, y0, ww, hgt) => { ctx.beginPath(); ctx.roundRect(x0, y0, ww, hgt, ww / 2); ctx.fill(); };
  pill(x - w / 2, gy - hh, w, hh);
  pill(x - w * 2.1, gy - hh * 0.7, w * 0.8, hh * 0.35);
  ctx.fillRect(x - w * 2.1 + w * 0.2, gy - hh * 0.42, w * 1.8, w * 0.6);
  pill(x + w * 1.3, gy - hh * 0.82, w * 0.8, hh * 0.38);
  ctx.fillRect(x, gy - hh * 0.5, w * 1.8, w * 0.6);
}

// ---------------------------------------------------------------- scenes

function water(S, hz, sx, { glitter = 1, tint = null } = {}) {
  const { ctx, W, H, P, a } = S;
  const r = S.rng('water');
  const wc = tint || mixc(P.mid, P.hor, 0.35);
  ctx.fillStyle = grad(ctx, 0, hz, 0, H, [[0, css(mixc(P.hor, P.light, 0.2))], [0.2, css(wc)], [1, css(mixc(P.top, P.shadow, 0.4))]]);
  ctx.fillRect(0, hz, W, H - hz);
  reflect(S, hz, { alpha: 0.62, ripple: 1 });
  ctx.fillStyle = grad(ctx, 0, hz, 0, H, [[0, css(P.shadow, 0)], [1, css(P.shadow, 0.5)]]);
  ctx.fillRect(0, hz, W, H - hz);
  for (let i = 0; i < 80; i++) {
    const t = (i + r()) / 80, y = hz + (H - hz) * t * t;
    const lw = 0.0007 + t * t * 0.006;
    const lite = i % 2 === 0;
    ctx.fillStyle = css(lite ? mixc(P.light, P.hor, 0.4) : P.shadow, lite ? 0.04 + 0.1 * (1 - t) : 0.16 * t + 0.03);
    let x = -r() * 0.1;
    while (x < W) { const len = 0.03 + r() * 0.25 * (0.3 + t); ctx.fillRect(x, y, len, lw); x += len + 0.01 + r() * 0.1; }
  }
  if (glitter > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const day = a.time === 'day';
    for (let i = 0; i < 420; i++) {
      const t = Math.pow(r(), 1.3), y = hz + 0.002 + (H - hz) * t * t;
      const spread = 0.012 + t * (day ? 0.5 : 0.2);
      const x = sx + (r() + r() + r() - 1.5) * spread;
      const len = 0.004 + r() * (0.01 + t * 0.07), th = 0.001 + t * 0.004;
      ctx.fillStyle = css(mixc(P.light, WHITE, 0.35), (0.25 + r() * 0.7) * (1 - t * 0.5) * glitter);
      ctx.fillRect(x - len / 2, y, len, th);
    }
    ctx.restore();
  }
}

function island(S, hz, r, side) {
  const { ctx, W, P } = S;
  const N = S.noise('isl');
  const x0 = side < 0 ? -0.05 : W * (0.45 + r() * 0.2), x1 = side < 0 ? W * (0.3 + r() * 0.25) : W + 0.05;
  const amp = 0.012 + r() * 0.03;
  ctx.fillStyle = css(mixc(mixc(P.shadow, P.mid, 0.5), P.hor, 0.2));
  ctx.beginPath();
  ctx.moveTo(x0, hz + 0.002);
  for (let i = 0; i <= 60; i++) {
    const t = i / 60, x = lerp(x0, x1, t);
    const env = Math.min(1, Math.sin(Math.PI * t) * 3);
    ctx.lineTo(x, hz - amp * env * (0.3 + 1.2 * N.ridged(x * 7, 0, 5)));
  }
  ctx.lineTo(x1, hz + 0.002);
  ctx.fill();
}

function sceneSea(S, o = {}) {
  const { ctx, W, H, P, a } = S;
  const r = S.rng('sea');
  const beach = o.beach ?? (a.scene === 'beach' || (a.scene !== 'sunset' && has(a, 'palm')));
  const hz = o.horizon ?? H * (beach ? 0.5 : 0.58);
  const night = isNight(a);
  const day = a.time === 'day';
  sky(S, hz);
  if (night) { stars(S, 520, hz); if (r() < 0.6) milkyWay(S, hz * 0.4); }
  const sx = W * (0.3 + r() * 0.4);
  const sr = night ? 0.045 : 0.06;
  const sy = night ? hz * 0.32 : day ? hz * 0.25 : hz - sr * 0.3;
  sun(S, sx, sy, sr, { moon: night, glow: day ? 0.6 : 1.1 });
  clouds(S, H * 0.02, hz * 0.62, { cover: 0.4 + r() * 0.3, sx, key: 'c1', day });
  clouds(S, hz * 0.68, hz + 0.004, { cover: 0.35, sx, key: 'c2', sy: 26, day, alpha: 0.85 });
  if (r() < 0.75) island(S, hz, r, r() < 0.5 ? -1 : 1);
  if (has(a, 'boat')) boat(S, sx + (r() < 0.5 ? -1 : 1) * W * 0.15, hz - 0.002, 0.045);
  water(S, hz, sx, { tint: beach && day ? mixc(P.hor, [40, 200, 200], 0.6) : null });
  const sil = mixc(P.shadow, P.land, 0.25);
  if (beach) {
    const N = S.noise('shore');
    const shore = (x) => H * 0.8 + Math.sin(x * 3 + r() * 0) * 0.02 + (N.fbm(x * 2, 0, 3) - 0.5) * 0.08;
    const sand = mixc(P.land, P.light, day ? 0.2 : 0.05);
    for (let k = 0; k < 3; k++) {
      ctx.strokeStyle = css(mixc(WHITE, P.light, 0.3), 0.45 - k * 0.12);
      ctx.lineWidth = 0.004 - k * 0.001;
      ctx.beginPath();
      for (let i = 0; i <= 80; i++) { const x = (i / 80) * W; ctx.lineTo(x, shore(x) - 0.012 - k * 0.025 + Math.sin(i * 0.9 + k) * 0.003); }
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(0, H + 0.01);
    for (let i = 0; i <= 80; i++) { const x = (i / 80) * W; ctx.lineTo(x, shore(x)); }
    ctx.lineTo(W, H + 0.01);
    ctx.fillStyle = grad(ctx, 0, H * 0.75, 0, H, [[0, css(mixc(sand, P.hor, 0.25))], [0.25, css(sand)], [1, css(mul(sand, night ? 0.3 : 0.7))]]);
    ctx.fill();
    ctx.fillStyle = grad(ctx, 0, H * 0.78, 0, H * 0.86, [[0, css(P.light, 0.22)], [1, css(P.light, 0)]]);
    ctx.fill();
    const side = r() < 0.5 ? -1 : 1;
    const px = side < 0 ? W * 0.08 : W * 0.92;
    palm(ctx, px, H * 0.92, H * 0.62, -side * 0.18, r, sil);
    if (r() < 0.7) palm(ctx, px - side * W * 0.12, H * 0.95, H * 0.45, -side * 0.3, r, sil);
    if (a.figure) person(ctx, W * (0.4 + r() * 0.2), H * 0.86, H * 0.12, sil);
  } else {
    const cliff = r() < 0.5 || has(a, 'lighthouse');
    if (cliff) {
      const side = r() < 0.5 ? -1 : 1;
      const N = S.noise('cliff');
      const cw = W * (0.25 + r() * 0.15);
      const x0 = side < 0 ? -0.02 : W + 0.02, x1 = side < 0 ? cw : W - cw;
      const top = hz - H * (0.06 + r() * 0.06);
      ctx.fillStyle = css(sil);
      ctx.beginPath();
      ctx.moveTo(x0, H + 0.01);
      ctx.lineTo(x0, top);
      for (let i = 0; i <= 40; i++) {
        const t = i / 40, x = lerp(x0, x1, t);
        ctx.lineTo(x, top + Math.pow(t, 3) * (hz + 0.06 - top) + (N.fbm(x * 12, 0, 4) - 0.5) * 0.03);
      }
      ctx.lineTo(x1, H + 0.01);
      ctx.fill();
      if (has(a, 'lighthouse')) lighthouse(S, lerp(x0, x1, 0.35), top + 0.005, H * 0.2);
      else if (a.figure) person(ctx, lerp(x0, x1, 0.45), top + 0.004, H * 0.07, sil);
    }
  }
  if (!night && (has(a, 'birds') || r() < 0.4)) birds(S, sx - 0.1, hz * 0.45, 5 + ((r() * 5) | 0), 0.018);
}

function sceneMountain(S, o = {}) {
  const { ctx, W, H, P, a } = S;
  const r = S.rng('mtn');
  const hz = o.horizon ?? H * 0.6;
  const night = isNight(a);
  const day = a.time === 'day';
  const snowy = a.weather === 'snow' || a.time === 'winter' || /alps|himalaya|glacier|everest|peak|summit/.test(a.keywords.join(' ')) || r() < 0.3;
  sky(S, hz);
  if (night) { stars(S, 650, hz); milkyWay(S, hz * 0.38); }
  const sx = W * (0.25 + r() * 0.5);
  const sy = night ? hz * 0.3 : day ? hz * 0.28 : hz - H * 0.08;
  sun(S, sx, sy, night ? 0.04 : 0.05, { moon: night, glow: day ? 0.5 : 1 });
  if (!night || a.weather) clouds(S, H * 0.02, hz * 0.7, { cover: a.weather ? 0.8 : 0.3 + r() * 0.35, sx, key: 'mc', day });
  const lake = has(a, 'lake') || (!o.noLake && r() < 0.35);
  const fog = mixc(P.hor, P.light, 0.3);
  const near = mixc(P.shadow, P.land, 0.4);
  let base = hz + 0.02, amp = H * 0.42, freq = 1.15;
  const layers = lake ? 3 : 5;
  let lastYs = null;
  for (let k = 0; k < layers; k++) {
    const t = k / 4;
    const col = mixc(mixc(P.hor, P.mid, 0.5), near, Math.min(1, 0.12 + Math.pow(t, 0.8) * 0.9));
    const ys = ridgeYs(S, { base, amp, freq, sharp: 0.7 - t * 0.35, key: 'r' + k });
    fillRidge(S, ys, col, { sx, snowy: snowy && k < 2, light: 0.22 * (1 - t) + 0.04, rim: 0.3 * (1 - t) });
    if (k === 1 && has(a, 'castle')) {
      const i = Math.round(ys.length * (0.3 + r() * 0.4));
      castle(S, ridgeX(S, ys, i), ys[i] + 0.01, H * 0.12, mul(col, 0.7));
    }
    fogBand(S, base, amp * 0.55, fog, a.weather === 'fog' ? 0.6 : 0.32 * (1 - t) + 0.08);
    lastYs = ys;
    base += H * 0.055 + k * 0.012; amp *= 0.6; freq *= 1.6;
  }
  if (lake) {
    const ly = base - H * 0.03;
    water(S, ly, sx, { glitter: 0.5 });
    const sil = mixc(P.shadow, P.land, 0.3);
    treeLine(S, H * 0.97, { hMin: H * 0.08, hMax: H * 0.2, gap: 0.03, col: sil, key: 'lt', snow: snowy, clear: a.figure ? 0.3 : 0 });
    if (a.figure) {
      ctx.fillStyle = css(sil);
      ctx.fillRect(0, H * 0.965, W, H);
      person(ctx, W / 2 + (r() - 0.5) * 0.1, H * 0.97, H * 0.13, sil);
    }
  } else {
    const sil = mixc(P.shadow, P.land, 0.3);
    if (r() < 0.6 || snowy) treeLine(S, H * 0.95, { hMin: H * 0.05, hMax: H * 0.16, gap: 0.028, col: sil, key: 'mt', snow: snowy });
    if (has(a, 'cabin')) cabin(S, W * (0.6 + r() * 0.25), H * 0.955, H * 0.07, sil);
    if (a.figure) {
      const i = Math.round(lastYs.length * (0.3 + r() * 0.4));
      person(ctx, ridgeX(S, lastYs, i), lastYs[i] + 0.004, H * 0.08, sil);
    }
  }
  if (!night && (has(a, 'birds') || r() < 0.25)) birds(S, sx, hz * 0.4, 4 + ((r() * 4) | 0), 0.014);
  void ctx;
}

function sceneForest(S, o = {}) {
  const { W, H, P, a } = S;
  const r = S.rng('forest');
  const hz = o.horizon ?? H * 0.55;
  const night = isNight(a);
  const snow = a.weather === 'snow';
  sky(S, hz);
  if (night) stars(S, 380, hz);
  const sx = W * (0.3 + r() * 0.4), sy = night ? hz * 0.35 : hz - H * 0.06;
  sun(S, sx, sy, night ? 0.035 : 0.05, { moon: night, glow: 1.2 });
  clouds(S, H * 0.02, hz * 0.6, { cover: 0.3 + r() * 0.3, sx, key: 'fc', day: a.time === 'day', alpha: 0.8 });
  const fog = mixc(P.light, P.hor, 0.45);
  const far = mixc(P.hor, P.mid, 0.4);
  for (let k = 0; k < 2; k++) {
    const ys = ridgeYs(S, { base: hz + 0.01 + k * 0.03, amp: H * (0.16 - k * 0.05), freq: 1.4 + k, sharp: 0.3, key: 'fr' + k });
    fillRidge(S, ys, mixc(far, P.land, 0.15 + k * 0.15), { sx, light: 0.1, rim: 0.15 });
    fogBand(S, hz + 0.02 + k * 0.03, H * 0.08, fog, 0.4);
  }
  const deep = mixc(mixc(P.shadow, P.land, 0.5), BLACK, 0.15);
  const round = /autumn|oak|jungle|rainforest/.test(a.keywords.join(' ')) ? 0.5 : 0;
  const foggy = a.weather === 'fog' ? 0.62 : 0.5;
  const layers = [
    { base: 0.05, hMin: 0.07, hMax: 0.15, gap: 0.016, mix: 0.18 },
    { base: 0.12, hMin: 0.1, hMax: 0.22, gap: 0.024, mix: 0.4 },
    { base: 0.21, hMin: 0.16, hMax: 0.34, gap: 0.04, mix: 0.62 },
    { base: 0.33, hMin: 0.3, hMax: 0.62, gap: 0.07, mix: 0.92, clear: 0.42 },
  ];
  layers.forEach((L, k) => {
    const base = hz + H * L.base;
    const col = mixc(mixc(fog, P.land, 0.3), deep, L.mix);
    if (k === 3) {
      const gy = Math.min(H - 0.01, base);
      S.ctx.fillStyle = grad(S.ctx, 0, gy - 0.1, 0, H, [[0, css(mixc(col, fog, 0.3))], [1, css(col)]]);
      S.ctx.fillRect(0, gy - 0.06, W, H);
      if (has(a, 'cabin')) cabin(S, W * (0.35 + r() * 0.3), gy - 0.04, H * 0.08, mul(deep, 0.9));
      if (a.figure) person(S.ctx, W * (0.4 + r() * 0.2), gy - 0.02, H * 0.14, mul(deep, 0.8));
    }
    treeLine(S, base, { hMin: H * L.hMin, hMax: H * L.hMax, gap: L.gap, col, key: 'tl' + k, round, snow, clear: L.clear || 0 });
    if (k === 1) rays(S, sx, sy, 11, H * 1.2, night ? 0.07 : 0.18);
    if (k < 3) fogBand(S, base + 0.005, H * (0.1 + k * 0.03), fog, foggy - k * 0.1);
  });
}

function sceneDesert(S, o = {}) {
  const { ctx, W, H, P, a } = S;
  const r = S.rng('desert');
  const hz = o.horizon ?? H * 0.6;
  const night = isNight(a);
  sky(S, hz);
  if (night) { stars(S, 600, hz); milkyWay(S, hz * 0.4); }
  const sx = W * (0.25 + r() * 0.5), sy = night ? hz * 0.3 : a.time === 'day' ? hz * 0.25 : hz - H * 0.07;
  sun(S, sx, sy, night ? 0.04 : 0.07, { moon: night, glow: 1.2 });
  clouds(S, H * 0.04, hz * 0.55, { cover: 0.2 + r() * 0.25, sx, key: 'dc', day: a.time === 'day', alpha: 0.7 });
  ctx.fillStyle = grad(ctx, 0, hz - 0.06, 0, hz + 0.02, [[0, css(P.hor, 0)], [1, css(mixc(P.hor, P.light, 0.3), 0.6)]]);
  ctx.fillRect(0, hz - 0.06, W, 0.08);
  // mesas
  const mesaCol = mixc(mixc(P.hor, P.mid, 0.45), P.land, 0.25);
  ctx.fillStyle = css(mesaCol);
  ctx.beginPath();
  let x = -0.05;
  while (x < W) {
    const mw = 0.06 + r() * 0.2, mh = H * (0.03 + r() * 0.1);
    if (r() < 0.55) {
      ctx.moveTo(x, hz + 0.01); ctx.lineTo(x + mw * 0.12, hz - mh); ctx.lineTo(x + mw * 0.88, hz - mh * (0.95 + r() * 0.1)); ctx.lineTo(x + mw, hz + 0.01);
    }
    x += mw + r() * 0.12;
  }
  ctx.fill();
  const sand = P.land;
  for (let k = 0; k < 4; k++) {
    const t = k / 3;
    const base = hz + 0.02 + Math.pow(t, 1.3) * (H - hz) * 0.75;
    const amp = H * (0.04 + t * 0.12);
    const N = S.noise('dune' + k);
    const n = 160;
    const ys = new Float32Array(n + 1);
    const ph = r() * 10, fq = (2.2 - t * 0.9) * 2;
    for (let i = 0; i <= n; i++) {
      const xx = (i / n) * W;
      const v = 0.5 + 0.35 * Math.sin(xx * fq + ph + N.fbm(xx * 1.5, 0, 3) * 3) + 0.3 * (N.fbm(xx * 3, 1, 3) - 0.5);
      ys[i] = base - amp * Math.pow(clamp(v), 1.3);
    }
    const lit = mixc(mixc(sand, P.light, 0.38), P.hor, 0.35 * (1 - t));
    const dark = mixc(mixc(sand, P.shadow, 0.3 + t * 0.15), P.mid, 0.3 * (1 - t));
    let top = Infinity; for (const y of ys) top = Math.min(top, y);
    ridgePath(S, ys);
    ctx.fillStyle = grad(ctx, 0, top, 0, base + 0.15, [[0, css(lit)], [1, css(dark)]]);
    ctx.fill();
    // lee-side shadow
    const sunLeft = sx < W / 2;
    const dx = W / n;
    const slope = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) {
      let acc = 0, c = 0;
      for (let k = -6; k <= 6; k++) { const j = Math.min(n, Math.max(0, i + k)); acc += ys[Math.min(n, j + 1)] - ys[Math.max(0, j - 1)]; c++; }
      slope[i] = (acc / c / (2 * dx)) * (sunLeft ? 1 : -1);
    }
    ctx.save();
    ridgePath(S, ys);
    ctx.clip();
    ctx.beginPath();
    for (let i = 0; i <= n; i++) ctx.lineTo(i * dx, ys[i] - 0.002);
    for (let i = n; i >= 0; i--) ctx.lineTo(i * dx, ys[i] + smooth(0, 0.35, slope[i]) * amp * 0.9);
    ctx.fillStyle = css(mixc(mul(dark, 0.7), P.mid, 0.25), 0.7);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = css(mixc(P.light, WHITE, 0.3), 0.35 * (1 - t * 0.5));
    ctx.lineWidth = 0.0015;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) ctx.lineTo(i * dx, ys[i]);
    ctx.stroke();
    if (k === 1 && a.figure) {
      const i = Math.round(n * (0.3 + r() * 0.4));
      person(ctx, i * dx, ys[i] + 0.003, H * 0.05, mul(dark, 0.4));
    }
    if (k === 3) {
      ctx.strokeStyle = css(mul(dark, 0.7), 0.18);
      ctx.lineWidth = 0.002;
      for (let j = 0; j < 14; j++) {
        const yy = base + 0.02 + j * 0.012;
        ctx.beginPath();
        for (let i = 0; i <= 40; i++) ctx.lineTo((i / 40) * W, yy + Math.sin(i * 0.6 + j) * 0.006);
        ctx.stroke();
      }
    }
  }
  if (has(a, 'cactus') || r() < 0.3) cactus(S, W * (r() < 0.5 ? 0.15 : 0.85), H * 0.97, H * 0.28, mixc(P.shadow, P.land, 0.15));
}

function skyline(S, { base, hMin, hMax, wMin, wMax, col, win = 0, litP = 0.3, winSize = 0.006, neon = 0, key, cyber = false }) {
  const { ctx, W, P } = S;
  const r = S.rng(key);
  const warm = [255, 206, 140], cool = [170, 215, 255];
  const edge = mixc(P.hor, P.light, 0.3);
  let x = -r() * 0.05;
  while (x < W + 0.02) {
    const bw = wMin + r() * (wMax - wMin);
    const bh = hMin + (hMax - hMin) * Math.pow(r(), 1.3);
    const top = base - bh;
    ctx.fillStyle = grad(ctx, 0, top, 0, base, [[0, css(mixc(col, P.hor, 0.12))], [1, css(mul(col, 0.8))]]);
    ctx.fillRect(x, top, bw, bh + 0.01);
    const rt = r();
    if (rt < 0.25) {
      const sw = bw * (0.4 + r() * 0.4), sh = bh * (0.05 + r() * 0.1);
      ctx.fillRect(x + (bw - sw) / 2, top - sh, sw, sh + 0.001);
      if (r() < 0.6) {
        const ax = x + bw / 2, ah = bh * (0.08 + r() * 0.12);
        ctx.fillRect(ax - 0.0012, top - sh - ah, 0.0024, ah);
        ctx.save(); ctx.globalCompositeOperation = 'screen';
        glowDot(ctx, ax, top - sh - ah, 0.012, [255, 60, 60], 0.9);
        ctx.restore();
      }
    } else if (rt < 0.35) {
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x + bw / 2, top - bh * (0.15 + r() * 0.2)); ctx.lineTo(x + bw, top); ctx.fill();
    } else if (rt < 0.45) {
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x + bw, top - bw * 0.5); ctx.lineTo(x + bw, top); ctx.fill();
    }
    ctx.fillStyle = css(edge, 0.12 + (win ? 0.08 : 0));
    ctx.fillRect(x, top, bw * 0.05, bh);
    if (win) {
      const gx = winSize * 1.9, gy = winSize * 2.3;
      const cols = Math.max(1, Math.floor((bw * 0.88) / gx)), rows = Math.max(1, Math.floor((bh * 0.96) / gy));
      const ox = x + (bw - cols * gx) / 2 + gx * 0.2;
      const band = r() * 3;
      for (let j = 0; j < rows; j++) {
        const floorLit = 0.4 + 1.2 * Math.abs(Math.sin(j * 0.7 + band));
        for (let i = 0; i < cols; i++) {
          const v = r();
          if (v > litP * floorLit) continue;
          const wc = v < litP * 0.08 ? P.accent : v < litP * 0.55 ? warm : cool;
          ctx.fillStyle = css(wc, (0.35 + r() * 0.65) * win);
          ctx.fillRect(ox + i * gx, top + bh * 0.03 + j * gy, gx * 0.6, winSize);
        }
      }
    }
    if (neon && r() < neon) {
      const c = r() < 0.5 ? P.accent : P.hor;
      const nx = x + bw * (r() < 0.5 ? 0.12 : 0.72), ny = top + bh * (0.08 + r() * 0.35);
      const nw = 0.008 + r() * 0.01, nh = 0.05 + r() * 0.12;
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = grad(ctx, nx - 0.04, 0, nx + nw + 0.04, 0, [[0, css(c, 0)], [0.5, css(c, 0.35)], [1, css(c, 0)]]);
      ctx.fillRect(nx - 0.04, ny - 0.02, nw + 0.08, nh + 0.04);
      ctx.restore();
      ctx.fillStyle = css(mixc(c, WHITE, 0.45));
      ctx.fillRect(nx, ny, nw, nh);
      ctx.fillStyle = css(mul(c, 0.35));
      for (let g = 0; g < 4; g++) ctx.fillRect(nx + nw * 0.2, ny + nh * (0.1 + g * 0.22), nw * 0.6, nh * 0.06);
    }
    if (cyber && r() < 0.12 && bw > 0.05) {
      const c = r() < 0.5 ? P.accent : P.hor;
      const bx = x + bw * 0.1, by = top + bh * (0.1 + r() * 0.2), bwd = bw * 0.8, bhh = Math.min(bh * 0.3, bwd * 1.3);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      glowDot(ctx, bx + bwd / 2, by + bhh / 2, bwd * 1.6, c, 0.4);
      ctx.fillStyle = grad(ctx, 0, by, 0, by + bhh, [[0, css(c, 0.85)], [1, css(mixc(c, P.accent, 0.5), 0.55)]]);
      ctx.fillRect(bx, by, bwd, bhh);
      ctx.fillStyle = css(WHITE, 0.25);
      for (let g = 0; g < 7; g++) ctx.fillRect(bx + bwd * 0.1, by + bhh * (0.1 + g * 0.12), bwd * (0.3 + r() * 0.5), bhh * 0.04);
      ctx.restore();
    }
    x += bw + r() * 0.01;
  }
}

function trails(S, y0, y1) {
  const { ctx, W } = S;
  const r = S.rng('trails');
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    const y = lerp(y0, y1, r());
    const red = r() < 0.5;
    const c = red ? [255, 50, 40] : [255, 225, 170];
    ctx.strokeStyle = css(c, 0.25 + r() * 0.5);
    ctx.lineWidth = 0.0012 + r() * 0.003;
    ctx.beginPath();
    ctx.moveTo(-0.05, y);
    ctx.bezierCurveTo(W * 0.3, y + (r() - 0.5) * 0.01, W * 0.7, y + (r() - 0.5) * 0.01, W + 0.05, y + (r() - 0.5) * 0.02);
    ctx.stroke();
  }
  ctx.restore();
}

function sceneCity(S, o = {}) {
  const { ctx, W, H, P, a } = S;
  const r = S.rng('city');
  const cyber = o.cyber ?? a.scene === 'cyberpunk';
  const rainy = a.weather === 'rain';
  const hz = o.horizon ?? H * 0.7;
  const night = isNight(a) || a.time === 'dusk' || a.time === 'storm';
  sky(S, hz);
  if (night && !rainy && !cyber) stars(S, 220, hz * 0.6);
  const sx = W * (0.25 + r() * 0.5);
  if (night) {
    if (has(a, 'moon') || (!rainy && r() < 0.5)) sun(S, sx, hz * 0.28, 0.045, { moon: true, glow: 0.8 });
  } else {
    sun(S, sx, a.time === 'day' ? hz * 0.25 : hz - H * 0.12, 0.06, { glow: 1.1 });
  }
  clouds(S, H * 0.02, hz * 0.6, { cover: rainy ? 0.85 : 0.3 + r() * 0.3, sx, key: 'cc', day: a.time === 'day', alpha: night ? 0.55 : 0.85 });
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = grad(ctx, 0, hz - H * 0.4, 0, hz, [[0, css(P.hor, 0)], [1, css(P.hor, night ? 0.45 : 0.25)]]);
  ctx.fillRect(0, hz - H * 0.4, W, H * 0.4);
  ctx.restore();
  const haze = mixc(P.hor, P.mid, 0.4);
  const winA = night ? 1 : 0.35;
  skyline(S, { base: hz, hMin: H * 0.12, hMax: H * 0.42, wMin: 0.025, wMax: 0.06, col: mixc(haze, P.shadow, 0.45), win: winA * 0.5, litP: 0.25, winSize: 0.0035, key: 'b0' });
  fogBand(S, hz, H * 0.25, haze, 0.35);
  skyline(S, { base: hz, hMin: H * 0.1, hMax: H * 0.5, wMin: 0.04, wMax: 0.09, col: mixc(P.mid, P.shadow, 0.72), win: winA * 0.8, litP: 0.3, winSize: 0.005, neon: cyber ? 0.25 : night ? 0.08 : 0, key: 'b1', cyber });
  fogBand(S, hz, H * 0.12, haze, cyber ? 0.35 : 0.2);
  skyline(S, { base: hz, hMin: H * 0.06, hMax: H * 0.3, wMin: 0.06, wMax: 0.14, col: mixc(P.shadow, P.mid, 0.12), win: winA, litP: 0.35, winSize: 0.007, neon: cyber ? 0.5 : night ? 0.25 : 0, key: 'b2', cyber });
  if (cyber) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 9; i++) {
      const x = r() * W, y = hz * (0.2 + r() * 0.5), c = r() < 0.5 ? P.accent : [255, 240, 230];
      glowDot(ctx, x, y, 0.01, c, 0.9);
      ctx.fillStyle = grad(ctx, x - 0.08, 0, x, 0, [[0, css(c, 0)], [1, css(c, 0.5)]]);
      ctx.fillRect(x - 0.08, y - 0.0012, 0.08, 0.0024);
    }
    ctx.restore();
  }
  // street
  ctx.fillStyle = grad(ctx, 0, hz, 0, H, [[0, css(mul(P.shadow, 1.2))], [1, css(mul(P.shadow, 0.6))]]);
  ctx.fillRect(0, hz, W, H - hz);
  reflect(S, hz, { alpha: rainy || cyber ? 0.7 : 0.5, ripple: rainy ? 1.8 : 0.8, freq: 1.4 });
  if (night) trails(S, hz + 0.004, hz + (H - hz) * 0.15);
  ctx.fillStyle = grad(ctx, 0, hz, 0, H, [[0, css(P.shadow, 0)], [1, css(P.shadow, 0.6)]]);
  ctx.fillRect(0, hz, W, H - hz);
  if (a.figure) {
    const fx = W * (0.3 + r() * 0.4), fy = hz + (H - hz) * 0.7, fh = H * 0.24;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.translate(fx, fy - fh * 0.5); ctx.scale(1, 1.6);
    glowDot(ctx, 0, 0, fh * 0.9, mixc(P.hor, P.light, 0.3), 0.55);
    ctx.restore();
    ctx.fillStyle = rgrad(ctx, fx, fy, fh * 0.5, [[0, css(mixc(P.hor, P.light, 0.5), 0.5)], [1, css(P.hor, 0)]]);
    ctx.fillRect(fx - fh * 0.5, fy - fh * 0.1, fh, fh * 0.2);
    person(ctx, fx, fy, fh, mul(P.shadow, 0.5));
    if (rainy || has(a, 'umbrella')) umbrella(ctx, fx, fy, fh, mul(P.shadow, 0.5));
  }
  if (cyber || a.weather === 'fog') fogLayer(S, hz - H * 0.15, hz + H * 0.08, 0.35, 'cfog');
}

function sceneSpace(S) {
  const { ctx, W, H, P, a } = S;
  const r = S.rng('space');
  ctx.fillStyle = css(P.top);
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = rgrad(ctx, W * (0.3 + r() * 0.4), H * (0.3 + r() * 0.4), Math.max(W, H) * 0.9, [[0, css(P.mid, 0.9)], [1, css(P.mid, 0)]]);
  ctx.fillRect(0, 0, W, H);
  const N = S.noise('neb');
  const N2 = S.noise('neb2');
  const tw = 220, th = Math.round(220 * H / W);
  const c1 = P.hor, c2 = P.accent, c3 = mixc(P.light, WHITE, 0.3);
  const off = r() * 10;
  const tex = texture(tw, th, (u, v, out) => {
    const x = u * W * 2.2 + off, y = v * H * 2.2;
    const qx = N.fbm(x, y, 4), qy = N.fbm(x + 5.2, y + 1.3, 4);
    const n = N.fbm(x + qx * 2.2, y + qy * 2.2, 5);
    const m = N2.fbm(x * 1.4 + qy * 2, y * 1.4 + qx * 2, 4);
    const al = smooth(0.42, 0.78, n);
    const c = mixc(mixc(c1, c2, smooth(0.35, 0.7, m)), c3, smooth(0.62, 0.85, n) * 0.7);
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = al * 235;
  });
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.drawImage(tex, 0, 0, W, H);
  ctx.globalAlpha = 0.5;
  ctx.drawImage(tex, -W * 0.02, -H * 0.02, W * 1.04, H * 1.04);
  ctx.restore();
  stars(S, 1100, H * 1.3, 'sst');
  const galaxy = has(a, 'galaxy') || (!has(a, 'rings') && !/planet|saturn|jupiter|mars|moon/.test(a.keywords.join(' ')) && r() < 0.35);
  if (galaxy) {
    const gx = W * (0.4 + r() * 0.2), gy = H * (0.4 + r() * 0.2), gr = Math.min(W, H) * 0.42, tilt = 0.35 + r() * 0.3, rot = r() * TAU;
    ctx.save();
    ctx.translate(gx, gy);
    ctx.rotate(rot);
    ctx.scale(1, tilt);
    ctx.globalCompositeOperation = 'screen';
    glowDot(ctx, 0, 0, gr * 0.9, mixc(P.hor, P.mid, 0.5), 0.5);
    for (let i = 0; i < 4200; i++) {
      const arm = i % 3;
      const t = Math.pow(r(), 0.75);
      const ang = t * 7 + (arm * TAU) / 3 + (r() - 0.5) * (0.7 - t * 0.3);
      const d = gr * (0.03 + t) + (r() - 0.5) * gr * 0.08;
      const c = mixc(mixc(WHITE, P.light, 0.5), r() < 0.5 ? P.accent : P.hor, Math.min(1, t * 1.4));
      ctx.fillStyle = css(c, 0.2 + r() * 0.5);
      const s = gr * (0.003 + r() * 0.006);
      ctx.fillRect(Math.cos(ang) * d, Math.sin(ang) * d, s, s / tilt);
    }
    glowDot(ctx, 0, 0, gr * 0.35, mixc(P.light, WHITE, 0.5), 0.95);
    ctx.restore();
  } else {
    const pr = Math.min(W, H) * (0.24 + r() * 0.2);
    const px = r() < 0.5 ? W * (0.2 + r() * 0.15) : W * (0.65 + r() * 0.15), py = H * (0.55 + r() * 0.2);
    const pc = mixc(P.accent, P.hor, r());
    const lx = px + (W / 2 - px > 0 ? 1 : -1) * pr * 0.7, ly = py - pr * 0.5;
    const ringed = has(a, 'rings') || r() < 0.45;
    const tilt = 0.22 + r() * 0.12, rrot = (r() - 0.5) * 0.6;
    const ring = (front) => {
      ctx.save();
      ctx.translate(px, py); ctx.rotate(rrot); ctx.scale(1, tilt);
      for (let k = 0; k < 26; k++) {
        const rad = pr * (1.35 + k * 0.035);
        ctx.strokeStyle = css(mixc(pc, P.light, 0.5 + (k % 3) * 0.15), (0.12 + ((k * 7) % 5) * 0.06) * (front ? 1 : 0.7));
        ctx.lineWidth = pr * 0.03;
        ctx.beginPath();
        ctx.arc(0, 0, rad, front ? 0 : Math.PI, front ? Math.PI : TAU);
        ctx.stroke();
      }
      ctx.restore();
    };
    ctx.save(); ctx.globalCompositeOperation = 'screen';
    glowDot(ctx, px, py, pr * 1.6, mixc(pc, P.light, 0.4), 0.45);
    ctx.restore();
    if (ringed) ring(false);
    ctx.save();
    ctx.beginPath(); ctx.arc(px, py, pr, 0, TAU); ctx.clip();
    ctx.fillStyle = css(pc); ctx.fillRect(px - pr, py - pr, pr * 2, pr * 2);
    const B = S.noise('bands');
    for (let i = 0; i < 90; i++) {
      const y = py - pr + (i / 90) * pr * 2;
      const v = B.fbm(i * 0.09, 0, 4);
      ctx.fillStyle = css(v > 0.5 ? mixc(pc, P.light, 0.45) : mul(pc, 0.55), Math.abs(v - 0.5) * 1.6);
      ctx.fillRect(px - pr, y, pr * 2, pr * 0.025);
    }
    ctx.fillStyle = rgrad(ctx, lx, ly, pr * 2.1, [[0, css(WHITE, 0.25)], [0.35, css(BLACK, 0)], [0.62, css(BLACK, 0.7)], [1, css(BLACK, 0.95)]]);
    ctx.fillRect(px - pr, py - pr, pr * 2, pr * 2);
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.strokeStyle = css(mixc(pc, WHITE, 0.4), 0.55);
    ctx.lineWidth = pr * 0.025;
    const la = Math.atan2(ly - py, lx - px);
    ctx.beginPath(); ctx.arc(px, py, pr * 0.99, la - 1.3, la + 1.3); ctx.stroke();
    ctx.restore();
    if (ringed) ring(true);
    if (r() < 0.6) {
      const mr = pr * 0.12, mx = px + (px > W / 2 ? -1 : 1) * pr * (1.9 + r()), my = py - pr * (0.8 + r() * 0.6);
      ctx.fillStyle = rgrad(ctx, mx - mr * 0.4, my - mr * 0.4, mr * 1.6, [[0, css(mixc(P.light, WHITE, 0.3))], [0.6, css(mul(P.mid, 0.8))], [1, css(BLACK)]]);
      ctx.beginPath(); ctx.arc(mx, my, mr, 0, TAU); ctx.fill();
    }
  }
}

// --- portrait

function backdropPainter(name) {
  return { city: sceneCity, cyberpunk: (S, o) => sceneCity(S, { ...o, cyber: true }), rain: sceneCity, forest: sceneForest,
    ocean: sceneSea, beach: (S, o) => sceneSea(S, { ...o, beach: true }), sunset: sceneSea, mountain: sceneMountain,
    snow: sceneMountain, desert: sceneDesert, space: sceneSpace, flower: sceneFlowerBg, abstract: sceneAbstract }[name];
}

function subState(S, w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  const U = Math.min(c.width, c.height);
  ctx.setTransform(U, 0, 0, U, 0, 0);
  ctx.imageSmoothingQuality = 'medium';
  return { c, S2: { ...S, ctx, w: c.width, h: c.height, U, W: c.width / U, H: c.height / U } };
}

function bokeh(S, n, key = 'bokeh') {
  const { ctx, W, H, P } = S;
  const r = S.rng(key);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < n; i++) {
    const x = r() * W, y = r() * H * 0.8, rad = 0.015 + Math.pow(r(), 2) * 0.07;
    const c = [P.accent, P.light, P.hor][(r() * 3) | 0];
    const al = 0.08 + r() * 0.3;
    ctx.fillStyle = rgrad(ctx, x, y, rad, [[0, css(c, al * 0.6)], [0.85, css(c, al)], [1, css(c, 0)]]);
    ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

function figurePaths(S, cx, s, r) {
  const { H } = S;
  const cy = H - s * 0.7, rx = s * 0.15, ry = s * 0.19;
  const body = new Path2D();
  body.moveTo(cx - s * 0.066, cy + ry * 0.5);
  body.lineTo(cx - s * 0.072, H - s * 0.3);
  body.bezierCurveTo(cx - s * 0.16, H - s * 0.27, cx - s * 0.42, H - s * 0.25, cx - s * 0.52, H - s * 0.13);
  body.bezierCurveTo(cx - s * 0.58, H - s * 0.07, cx - s * 0.6, H - s * 0.02, cx - s * 0.63, H + 0.02);
  body.lineTo(cx + s * 0.63, H + 0.02);
  body.bezierCurveTo(cx + s * 0.6, H - s * 0.02, cx + s * 0.58, H - s * 0.07, cx + s * 0.52, H - s * 0.13);
  body.bezierCurveTo(cx + s * 0.42, H - s * 0.25, cx + s * 0.16, H - s * 0.27, cx + s * 0.072, H - s * 0.3);
  body.lineTo(cx + s * 0.066, cy + ry * 0.5);
  body.closePath();
  const head = new Path2D();
  head.moveTo(cx, cy - ry);
  head.bezierCurveTo(cx + rx * 1.08, cy - ry, cx + rx * 1.1, cy + ry * 0.1, cx + rx * 0.93, cy + ry * 0.45);
  head.bezierCurveTo(cx + rx * 0.78, cy + ry * 0.82, cx + rx * 0.4, cy + ry * 1.04, cx, cy + ry * 1.05);
  head.bezierCurveTo(cx - rx * 0.4, cy + ry * 1.04, cx - rx * 0.78, cy + ry * 0.82, cx - rx * 0.93, cy + ry * 0.45);
  head.bezierCurveTo(cx - rx * 1.1, cy + ry * 0.1, cx - rx * 1.08, cy - ry, cx, cy - ry);
  head.closePath();
  head.ellipse(cx + rx * 0.97, cy + ry * 0.12, rx * 0.13, ry * 0.2, 0, 0, TAU);
  head.ellipse(cx - rx * 0.97, cy + ry * 0.12, rx * 0.13, ry * 0.2, 0, 0, TAU);
  const hair = new Path2D();
  const kind = r() < 0.7 ? 'long' : r() < 0.5 ? 'short' : 'bun';
  if (kind === 'long') {
    const fall = H - s * (0.12 + r() * 0.12);
    hair.moveTo(cx, cy - ry * 1.22);
    hair.bezierCurveTo(cx + rx * 1.5, cy - ry * 1.2, cx + rx * 1.45, cy + ry * 0.2, cx + rx * 1.45, cy + ry * 0.9);
    hair.bezierCurveTo(cx + rx * 1.5, fall - s * 0.1, cx + rx * 1.9, fall, cx + rx * 1.7, fall);
    hair.lineTo(cx + rx * 0.95, fall - s * 0.02);
    hair.bezierCurveTo(cx + rx * 0.9, cy + ry * 0.6, cx + rx * 1.0, cy - ry * 0.3, cx + rx * 0.3, cy - ry * 0.62);
    hair.bezierCurveTo(cx - rx * 0.2, cy - ry * 0.5, cx - rx * 0.85, cy - ry * 0.3, cx - rx * 0.95, cy + ry * 0.1);
    hair.bezierCurveTo(cx - rx * 1.0, cy + ry * 0.6, cx - rx * 0.9, fall - s * 0.05, cx - rx * 1.0, fall - s * 0.02);
    hair.lineTo(cx - rx * 1.7, fall);
    hair.bezierCurveTo(cx - rx * 1.9, fall, cx - rx * 1.5, fall - s * 0.1, cx - rx * 1.45, cy + ry * 0.9);
    hair.bezierCurveTo(cx - rx * 1.45, cy + ry * 0.2, cx - rx * 1.5, cy - ry * 1.2, cx, cy - ry * 1.22);
  } else {
    hair.moveTo(cx - rx * 1.02, cy + ry * 0.05);
    hair.bezierCurveTo(cx - rx * 1.25, cy - ry * 1.05, cx - rx * 0.4, cy - ry * 1.32, cx + rx * 0.2, cy - ry * 1.26);
    hair.bezierCurveTo(cx + rx * 1.2, cy - ry * 1.2, cx + rx * 1.25, cy - ry * 0.4, cx + rx * 1.02, cy + ry * 0.05);
    hair.bezierCurveTo(cx + rx * 0.9, cy - ry * 0.5, cx + rx * 0.4, cy - ry * 0.65, cx - rx * 0.1, cy - ry * 0.6);
    hair.bezierCurveTo(cx - rx * 0.6, cy - ry * 0.55, cx - rx * 0.95, cy - ry * 0.4, cx - rx * 1.02, cy + ry * 0.05);
    if (kind === 'bun') hair.ellipse(cx + rx * 0.1, cy - ry * 1.3, rx * 0.5, ry * 0.36, 0, 0, TAU);
  }
  return { body, head, hair, cx, cy, rx, ry };
}

function scenePortrait(S) {
  const { ctx, w, h, W, H, P, a } = S;
  const r = S.rng('portrait');
  const bd = a.backdrop && a.backdrop !== 'studio' ? backdropPainter(a.backdrop) : null;
  if (bd) {
    const { c, S2 } = subState(S, W * 140, H * 140);
    bd(S2, { horizon: S2.H * 0.72, noLake: true });
    ctx.drawImage(c, 0, 0, W, H);
    ctx.fillStyle = css(P.shadow, 0.25);
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = css(P.top);
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = rgrad(ctx, W * (0.35 + r() * 0.3), H * 0.4, Math.max(W, H) * 0.75, [[0, css(mixc(P.mid, P.hor, 0.5))], [0.55, css(P.mid, 0.6)], [1, css(P.top, 0)]]);
    ctx.fillRect(0, 0, W, H);
  }
  bokeh(S, 26);
  const s = Math.min(W * 0.95, H * 0.82);
  const cx = W / 2 + (r() - 0.5) * W * 0.14;
  const F = figurePaths(S, cx, s, r);
  const rimL = mixc(P.accent, WHITE, 0.15), rimR = mixc(P.hor, P.light, 0.35);
  const bodyC = mixc(P.shadow, P.mid, 0.18);
  const skin = mixc(mixc([205, 150, 120], P.shadow, 0.8), P.mid, 0.08);
  const hairC = mul(P.shadow, 0.6);
  // mask of the whole silhouette in pixel space
  const mw = Math.ceil(w / 2), mh = Math.ceil(h / 2), mU = S.U / 2;
  const mask = makeCanvas(mw, mh);
  const m = mask.getContext('2d');
  m.setTransform(mU, 0, 0, mU, 0, 0);
  m.fillStyle = '#fff';
  m.fill(F.body); m.fill(F.head); m.fill(F.hair);
  const rimBand = (d) => {
    const dp = d * mU;
    const inner = makeCanvas(mw, mh);
    const ic = inner.getContext('2d');
    ic.drawImage(mask, dp, 0);
    ic.globalCompositeOperation = 'destination-in'; ic.drawImage(mask, -dp, 0);
    ic.drawImage(mask, 0, dp * 0.8);
    const band = makeCanvas(mw, mh);
    const bc = band.getContext('2d');
    bc.fillStyle = grad(bc, 0, 0, mw, 0, [[0, css(rimL)], [0.44, css(rimL)], [0.56, css(rimR)], [1, css(rimR)]]);
    bc.fillRect(0, 0, mw, mh);
    bc.globalCompositeOperation = 'destination-in'; bc.drawImage(mask, 0, 0);
    bc.globalCompositeOperation = 'destination-out'; bc.drawImage(inner, 0, 0);
    return band;
  };
  // halo behind
  const glow = makeCanvas(w / 16, h / 16);
  const gc = glow.getContext('2d');
  gc.fillStyle = grad(gc, 0, 0, glow.width, 0, [[0, css(rimL)], [0.5, css(mixc(rimL, rimR, 0.5))], [1, css(rimR)]]);
  gc.fillRect(0, 0, glow.width, glow.height);
  gc.globalCompositeOperation = 'destination-in';
  gc.drawImage(mask, 0, 0, glow.width, glow.height);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.55;
  ctx.drawImage(glow, -W * 0.03, -H * 0.03, W * 1.06, H * 1.06);
  ctx.restore();
  // figure
  ctx.fillStyle = grad(ctx, 0, H - s * 0.3, 0, H, [[0, css(mixc(bodyC, P.mid, 0.2))], [1, css(mul(bodyC, 0.6))]]);
  ctx.fill(F.body);
  ctx.fillStyle = css(skin);
  ctx.fill(F.head);
  ctx.save();
  ctx.clip(F.head);
  ctx.fillStyle = rgrad(ctx, F.cx - F.rx * 0.9, F.cy - F.ry * 0.1, F.rx * 1.6, [[0, css(mixc(skin, rimL, 0.5), 0.55)], [1, css(rimL, 0)]]);
  ctx.fillRect(F.cx - F.rx * 2, F.cy - F.ry * 2, F.rx * 4, F.ry * 4);
  ctx.fillStyle = rgrad(ctx, F.cx + F.rx * 0.9, F.cy, F.rx * 1.2, [[0, css(mixc(skin, rimR, 0.5), 0.4)], [1, css(rimR, 0)]]);
  ctx.fillRect(F.cx - F.rx * 2, F.cy - F.ry * 2, F.rx * 4, F.ry * 4);
  ctx.restore();
  ctx.fillStyle = grad(ctx, F.cx - F.rx * 2, 0, F.cx + F.rx * 2, 0, [[0, css(mixc(hairC, rimL, 0.18))], [0.5, css(hairC)], [1, css(mixc(hairC, rimR, 0.15))]]);
  ctx.fill(F.hair);
  // rims
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 0.35;
  ctx.drawImage(rimBand(0.02), 0, 0, w, h);
  ctx.globalAlpha = 1;
  ctx.drawImage(rimBand(0.006), 0, 0, w, h);
  ctx.restore();
  // dust in the light
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 70; i++) {
    const x = r() * W, y = r() * H, rr = 0.001 + r() * 0.003;
    glowDot(ctx, x, y, rr * 3, r() < 0.5 ? rimL : rimR, 0.2 + r() * 0.4);
  }
  ctx.restore();
}

// --- car

function carPath(X, Y, L) {
  const p = new Path2D();
  p.moveTo(X(0.035), Y(0.05));
  p.lineTo(X(0.012), Y(0.1));
  p.quadraticCurveTo(X(0), Y(0.16), X(0.04), Y(0.178));
  p.bezierCurveTo(X(0.14), Y(0.19), X(0.22), Y(0.205), X(0.3), Y(0.215));
  p.bezierCurveTo(X(0.37), Y(0.29), X(0.46), Y(0.305), X(0.54), Y(0.3));
  p.bezierCurveTo(X(0.61), Y(0.296), X(0.66), Y(0.262), X(0.72), Y(0.205));
  p.bezierCurveTo(X(0.82), Y(0.19), X(0.92), Y(0.168), X(0.985), Y(0.132));
  p.quadraticCurveTo(X(1.006), Y(0.1), X(0.99), Y(0.068));
  p.lineTo(X(0.965), Y(0.045));
  p.lineTo(X(0.89), Y(0.045));
  p.arc(X(0.8), Y(0.075), L * 0.088, -0.35, Math.PI + 0.35, true);
  p.lineTo(X(0.29), Y(0.045));
  p.arc(X(0.2), Y(0.075), L * 0.088, -0.35, Math.PI + 0.35, true);
  p.lineTo(X(0.035), Y(0.05));
  p.closePath();
  return p;
}

function drawCar(S, x0, gy, L, paint, { reflection = false } = {}) {
  const { ctx, P } = S;
  const X = (u) => x0 + u * L, Y = (v) => gy - v * L;
  const body = carPath(X, Y, L);
  ctx.fillStyle = grad(ctx, 0, Y(0.31), 0, Y(0.04), [[0, css(mixc(paint, P.hor, 0.5))], [0.3, css(mixc(paint, P.light, 0.15))],
    [0.5, css(paint)], [0.6, css(mul(paint, 0.45))], [0.64, css(mixc(paint, P.light, 0.45))], [0.7, css(mul(paint, 0.7))], [1, css(mul(paint, 0.18))]]);
  ctx.fill(body);
  ctx.save();
  ctx.clip(body);
  ctx.fillStyle = grad(ctx, X(0), 0, X(1), 0, [[0, css(BLACK, 0.35)], [0.45, css(P.hor, 0.15)], [0.7, css(WHITE, 0.08)], [1, css(BLACK, 0.3)]]);
  ctx.fill(body);
  ctx.restore();
  if (reflection) return;
  const win = new Path2D();
  win.moveTo(X(0.335), Y(0.212));
  win.bezierCurveTo(X(0.385), Y(0.275), X(0.46), Y(0.288), X(0.54), Y(0.285));
  win.bezierCurveTo(X(0.6), Y(0.282), X(0.64), Y(0.255), X(0.69), Y(0.208));
  win.closePath();
  ctx.fillStyle = grad(ctx, 0, Y(0.29), 0, Y(0.21), [[0, css(mixc(P.hor, P.light, 0.3), 0.9)], [0.45, css(mixc(P.mid, P.shadow, 0.5))], [1, css(mul(P.shadow, 0.5))]]);
  ctx.fill(win);
  ctx.strokeStyle = css(mul(paint, 0.25));
  ctx.lineWidth = L * 0.008;
  ctx.beginPath(); ctx.moveTo(X(0.56), Y(0.29)); ctx.lineTo(X(0.555), Y(0.208)); ctx.stroke();
  ctx.lineWidth = L * 0.0025;
  ctx.beginPath(); ctx.moveTo(X(0.565), Y(0.205)); ctx.quadraticCurveTo(X(0.58), Y(0.12), X(0.6), Y(0.06)); ctx.stroke();
  ctx.fillStyle = css(mul(paint, 0.2));
  ctx.beginPath(); ctx.moveTo(X(0.3), Y(0.13)); ctx.lineTo(X(0.4), Y(0.14)); ctx.lineTo(X(0.38), Y(0.1)); ctx.lineTo(X(0.31), Y(0.095)); ctx.fill();
  // roofline highlight
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.strokeStyle = grad(ctx, X(0.1), 0, X(0.95), 0, [[0, css(P.light, 0)], [0.45, css(mixc(P.light, WHITE, 0.4), 0.85)], [1, css(P.light, 0.1)]]);
  ctx.lineWidth = L * 0.004;
  ctx.beginPath();
  ctx.moveTo(X(0.15), Y(0.196)); ctx.bezierCurveTo(X(0.22), Y(0.205), X(0.26), Y(0.21), X(0.3), Y(0.215));
  ctx.bezierCurveTo(X(0.37), Y(0.29), X(0.46), Y(0.305), X(0.54), Y(0.3));
  ctx.bezierCurveTo(X(0.61), Y(0.296), X(0.66), Y(0.262), X(0.72), Y(0.205));
  ctx.bezierCurveTo(X(0.82), Y(0.19), X(0.92), Y(0.168), X(0.985), Y(0.132));
  ctx.stroke();
  ctx.lineWidth = L * 0.0022;
  ctx.beginPath(); ctx.moveTo(X(0.06), Y(0.125)); ctx.bezierCurveTo(X(0.4), Y(0.14), X(0.7), Y(0.135), X(0.97), Y(0.11)); ctx.stroke();
  ctx.restore();
  // wheels
  for (const wx of [0.2, 0.8]) {
    const cx = X(wx), cy = Y(0.075), rr = L * 0.075;
    ctx.fillStyle = '#09090b';
    ctx.beginPath(); ctx.arc(cx, cy, rr, 0, TAU); ctx.fill();
    ctx.fillStyle = rgrad(ctx, cx - rr * 0.2, cy - rr * 0.3, rr * 0.75, [[0, css(mixc([170, 172, 180], P.light, 0.3))], [0.5, css([70, 72, 80])], [1, css([20, 20, 24])]]);
    ctx.beginPath(); ctx.arc(cx, cy, rr * 0.68, 0, TAU); ctx.fill();
    ctx.strokeStyle = css([25, 25, 30], 0.8);
    ctx.lineWidth = rr * 0.09;
    ctx.beginPath();
    for (let k = 0; k < 5; k++) { const an = k * TAU / 5 + wx; ctx.moveTo(cx + Math.cos(an) * rr * 0.15, cy + Math.sin(an) * rr * 0.15); ctx.lineTo(cx + Math.cos(an) * rr * 0.62, cy + Math.sin(an) * rr * 0.62); }
    ctx.stroke();
    ctx.strokeStyle = css([190, 30, 30], 0.85);
    ctx.lineWidth = rr * 0.1;
    ctx.beginPath(); ctx.arc(cx, cy, rr * 0.5, -2.3, -1.5); ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(cx, cy, rr * 0.12, 0, TAU); ctx.fill();
  }
  // lights
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const hl = mixc(WHITE, P.accent, 0.25);
  glowDot(ctx, X(0.975), Y(0.12), L * 0.14, hl, 0.8);
  ctx.fillStyle = grad(ctx, X(0.975) - S.W, 0, X(0.975) + S.W, 0, [[0, css(hl, 0)], [0.5, css(hl, 0.7)], [1, css(hl, 0)]]);
  ctx.fillRect(X(0.975) - S.W, Y(0.12) - L * 0.002, S.W * 2, L * 0.004);
  glowDot(ctx, X(0.012), Y(0.14), L * 0.08, [255, 40, 50], 0.9);
  ctx.restore();
  ctx.fillStyle = css(mixc(WHITE, hl, 0.3));
  ctx.beginPath(); ctx.ellipse(X(0.965), Y(0.123), L * 0.022, L * 0.008, -0.25, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgb(255,60,60)';
  ctx.fillRect(X(0.004), Y(0.152), L * 0.02, L * 0.018);
}

function sceneCar(S) {
  const { ctx, w, h, W, H, P, a } = S;
  const r = S.rng('car');
  const hz = H * 0.66;
  const bd = backdropPainter(a.backdrop || 'city') || sceneCity;
  bd(S, { horizon: hz, noLake: true });
  // horizontal motion blur on the backdrop
  const copy = makeCanvas(w, h);
  copy.getContext('2d').drawImage(ctx.canvas, 0, 0, w, h, 0, 0, w, h);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (let i = 1; i <= 4; i++) { ctx.globalAlpha = 0.35 / i + 0.05; ctx.drawImage(copy, (i % 2 ? 1 : -1) * i * S.U * 0.0035, 0); }
  ctx.restore();
  const roadY = hz + (H - hz) * 0.12;
  ctx.fillStyle = grad(ctx, 0, roadY, 0, H, [[0, css(mixc(P.shadow, P.mid, 0.25))], [1, css(mul(P.shadow, 0.5))]]);
  ctx.fillRect(0, roadY, W, H - roadY);
  ctx.fillStyle = css(mixc(P.hor, P.light, 0.3), 0.45);
  ctx.fillRect(0, roadY, W, 0.0025);
  const L = Math.min(W * 0.84, H * 1.25);
  const x0 = (W - L) / 2 + (r() - 0.5) * W * 0.04;
  const gy = roadY + (H - roadY) * 0.55;
  const named = a.colors.find((c) => COLORS[c]);
  const paint = named ? hexToRgb(COLORS[named]) : [[200, 20, 30], [20, 20, 24], [230, 232, 236], [150, 155, 165], P.accent, [255, 140, 20]][(r() * 6) | 0];
  // reflection on the wet road
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.translate(0, gy * 2);
  ctx.scale(1, -1);
  drawCar(S, x0, gy, L, paint, { reflection: true });
  ctx.restore();
  ctx.fillStyle = grad(ctx, 0, gy, 0, H, [[0, css(P.shadow, 0.2)], [1, css(P.shadow, 0.7)]]);
  ctx.fillRect(0, gy, W, H - gy);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 6; i++) {
    const y = gy + (H - gy) * (0.25 + i * 0.12);
    ctx.fillStyle = css(mixc(P.light, WHITE, 0.3), 0.18 - i * 0.02);
    ctx.fillRect(-0.05 + r() * 0.05, y, W * (0.25 + r() * 0.3), 0.003 + i * 0.001);
    ctx.fillRect(W * (0.6 + r() * 0.2), y + 0.004, W * 0.4, 0.002 + i * 0.001);
  }
  ctx.restore();
  ctx.fillStyle = rgrad(ctx, x0 + L / 2, gy, L * 0.55, [[0, css(BLACK, 0.85)], [0.7, css(BLACK, 0.4)], [1, css(BLACK, 0)]]);
  ctx.save(); ctx.translate(x0 + L / 2, gy); ctx.scale(1, 0.06); ctx.translate(-(x0 + L / 2), -gy);
  ctx.beginPath(); ctx.arc(x0 + L / 2, gy, L * 0.55, 0, TAU); ctx.fill();
  ctx.restore();
  drawCar(S, x0, gy, L, paint);
}

// --- abstract

function sceneAbstract(S) {
  const { ctx, W, H, P } = S;
  const r = S.rng('abs');
  ctx.fillStyle = grad(ctx, 0, 0, W, H, [[0, css(mul(P.top, 0.8))], [0.55, css(mixc(P.mid, P.shadow, 0.65))], [1, css(mul(P.shadow, 0.8))]]);
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 5; i++) {
    const c = [P.accent, P.hor, P.mid, P.light][i % 4];
    glowDot(ctx, r() * W, r() * H, 0.3 + r() * 0.5, c, 0.18 + r() * 0.16);
  }
  ctx.globalCompositeOperation = 'lighter';
  const ribbons = 3 + ((r() * 2) | 0);
  for (let k = 0; k < ribbons; k++) {
    const cy = H * (0.2 + r() * 0.6), A = H * (0.1 + r() * 0.25), f = 1.5 + r() * 3, ph = r() * TAU;
    const A2 = H * (0.03 + r() * 0.08), f2 = 4 + r() * 5, ph2 = r() * TAU;
    const thick = 0.06 + r() * 0.14, twist = 1 + r() * 3, tph = r() * TAU;
    const cols = [P.accent, P.hor, P.light, mixc(P.accent, P.mid, 0.5)];
    const ci = (r() * 4) | 0, ca = cols[ci], cb = cols[(ci + 1 + ((r() * 3) | 0)) % 4];
    ctx.strokeStyle = grad(ctx, 0, 0, W, 0, [[0, css(ca, 0.02)], [0.3, css(ca, 0.13)], [0.65, css(cb, 0.15)], [1, css(cb, 0.03)]]);
    ctx.lineWidth = 0.0018;
    const strands = 56;
    for (let j = 0; j < strands; j++) {
      const o = j / (strands - 1) - 0.5;
      ctx.beginPath();
      for (let i = 0; i <= 90; i++) {
        const t = i / 90, x = -0.05 + t * (W + 0.1);
        const tw = Math.cos(t * twist * TAU * 0.5 + tph);
        const y = cy + A * Math.sin(t * f + ph) + A2 * Math.sin(t * f2 + ph2) + o * thick * (0.25 + 0.75 * Math.abs(tw)) * Math.sign(tw || 1);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
  }
  for (let i = 0; i < 160; i++) glowDot(ctx, r() * W, r() * H, 0.002 + r() * 0.008, mixc(P.light, WHITE, 0.4), 0.2 + r() * 0.6);
  ctx.restore();
  if (r() < 0.6) {
    for (let i = 0; i < 3; i++) {
      const x = r() * W, y = r() * H, rr = 0.04 + r() * 0.12, c = [P.accent, P.hor, P.light][i];
      ctx.fillStyle = rgrad(ctx, x - rr * 0.35, y - rr * 0.4, rr * 1.4, [[0, css(mixc(c, WHITE, 0.7))], [0.35, css(c)], [0.8, css(mul(c, 0.35))], [1, css(mul(c, 0.2))]]);
      ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.fill();
      ctx.save(); ctx.globalCompositeOperation = 'screen';
      glowDot(ctx, x, y, rr * 2.2, c, 0.3);
      ctx.restore();
    }
  }
}

// --- flowers

function petal(ctx, len, wid) {
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(wid, len * 0.25, wid * 0.95, len * 0.85, 0, len);
  ctx.bezierCurveTo(-wid * 0.95, len * 0.85, -wid, len * 0.25, 0, 0);
}

function blossom(S, x, y, R, col, kind, r) {
  const { ctx, P } = S;
  const deep = mul(col, 0.45), tip = mixc(col, WHITE, 0.38);
  const petalFill = (len) => rgrad(ctx, 0, 0, len, [[0, css(deep)], [0.45, css(col)], [1, css(tip)]]);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(r() * TAU);
  ctx.scale(1, 0.82 + r() * 0.18);
  if (kind === 'daisy') {
    const n = 22 + ((r() * 10) | 0);
    for (let ring = 0; ring < 2; ring++) {
      for (let i = 0; i < n; i++) {
        ctx.save(); ctx.rotate(((i + ring * 0.5) / n) * TAU);
        ctx.beginPath(); petal(ctx, R * (1 - ring * 0.12), R * 0.12); ctx.fillStyle = petalFill(R); ctx.fill();
        ctx.restore();
      }
    }
    ctx.fillStyle = rgrad(ctx, 0, 0, R * 0.36, [[0, css([90, 50, 20])], [1, css([50, 28, 12])]]);
    ctx.beginPath(); ctx.arc(0, 0, R * 0.36, 0, TAU); ctx.fill();
    ctx.fillStyle = css([200, 140, 40], 0.8);
    for (let i = 0; i < 140; i++) { const d = Math.sqrt(i / 140) * R * 0.33, an = i * 2.39996; ctx.fillRect(Math.cos(an) * d, Math.sin(an) * d, R * 0.018, R * 0.018); }
  } else if (kind === 'rose') {
    for (let ring = 0; ring < 5; ring++) {
      const n = 5 + (ring < 2 ? 1 : 0), len = R * (1 - ring * 0.17), wid = len * 0.8;
      for (let i = 0; i < n; i++) {
        ctx.save(); ctx.rotate((i / n) * TAU + ring * 0.7);
        ctx.beginPath(); petal(ctx, len, wid);
        ctx.fillStyle = rgrad(ctx, 0, 0, len, [[0, css(mul(col, 0.22 + ring * 0.06))], [0.55, css(mul(col, 0.8 + ring * 0.04))], [0.9, css(col)], [1, css(mixc(col, WHITE, 0.35))]]);
        ctx.fill();
        ctx.strokeStyle = css(mul(col, 0.45), 0.55);
        ctx.lineWidth = R * 0.01;
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.strokeStyle = css(mul(col, 0.3), 0.8);
    ctx.lineWidth = R * 0.02;
    ctx.beginPath();
    for (let i = 0; i < 40; i++) { const t = i / 40, an = t * 7, d = t * R * 0.16; i ? ctx.lineTo(Math.cos(an) * d, Math.sin(an) * d) : ctx.moveTo(0, 0); }
    ctx.stroke();
  } else {
    const n = kind === 'sakura' ? 5 : 6 + ((r() * 3) | 0);
    for (let ring = 0; ring < (kind === 'sakura' ? 1 : 2); ring++) {
      for (let i = 0; i < n; i++) {
        ctx.save(); ctx.rotate(((i + ring * 0.5) / n) * TAU);
        const len = R * (1 - ring * 0.32);
        ctx.beginPath(); petal(ctx, len, len * (kind === 'sakura' ? 0.62 : 0.55));
        ctx.fillStyle = petalFill(len); ctx.fill();
        ctx.strokeStyle = css(tip, 0.35); ctx.lineWidth = R * 0.01; ctx.stroke();
        ctx.restore();
      }
    }
    ctx.fillStyle = rgrad(ctx, 0, 0, R * 0.22, [[0, css([255, 230, 120])], [1, css([220, 140, 40])]]);
    ctx.beginPath(); ctx.arc(0, 0, R * 0.16, 0, TAU); ctx.fill();
    ctx.fillStyle = css([255, 220, 120], 0.9);
    for (let i = 0; i < 14; i++) { const an = r() * TAU, d = R * (0.18 + r() * 0.14); ctx.beginPath(); ctx.arc(Math.cos(an) * d, Math.sin(an) * d, R * 0.025, 0, TAU); ctx.fill(); }
  }
  ctx.restore();
  void P;
}

function leaf(ctx, x, y, len, ang, col) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(ang);
  ctx.beginPath(); petal(ctx, len, len * 0.32);
  ctx.fillStyle = grad(ctx, -len * 0.3, 0, len * 0.3, 0, [[0, css(mul(col, 0.6))], [0.5, css(col)], [1, css(mixc(col, WHITE, 0.15))]]);
  ctx.fill();
  ctx.strokeStyle = css(mixc(col, WHITE, 0.3), 0.5);
  ctx.lineWidth = len * 0.02;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, len * 0.95); ctx.stroke();
  ctx.restore();
}

function flowerKind(a, r) {
  if (has(a, 'sakura')) return 'sakura';
  if (has(a, 'rose')) return 'rose';
  if (has(a, 'daisy')) return 'daisy';
  return ['bloom', 'rose', 'daisy', 'bloom'][(r() * 4) | 0];
}

function flowerColor(S, kind, r) {
  const { a, P } = S;
  const named = a.colors.find((c) => !NEUTRAL_COLORS.has(c));
  if (named) return hexToRgb(COLORS[named]);
  if (kind === 'sakura') return [255, 182, 206];
  if (kind === 'daisy') return r() < 0.5 ? [255, 200, 40] : [250, 246, 240];
  return mixc(P.accent, [255, 80, 120], 0.3);
}

function sceneFlowerBg(S) {
  const { ctx, W, H, P } = S;
  const r = S.rng('fbg');
  const green = mixc(P.land, [60, 120, 60], 0.4);
  ctx.fillStyle = grad(ctx, 0, 0, 0, H, [[0, css(mixc(P.mid, P.light, 0.3))], [0.5, css(mixc(P.hor, green, 0.45))], [1, css(mul(green, 0.55))]]);
  ctx.fillRect(0, 0, W, H);
  const { c, S2 } = subState(S, W * 36, H * 36);
  const g = S2.ctx;
  for (let i = 0; i < 46; i++) {
    const x = r() * W, y = H * (0.25 + r() * 0.8), rad = 0.06 + r() * 0.16;
    const col = r() < 0.7 ? mixc(green, P.light, r() * 0.45) : mixc(P.accent, P.light, 0.3);
    g.fillStyle = css(r() < 0.5 ? col : mul(col, 0.6), 0.35 + r() * 0.4);
    g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill();
  }
  ctx.drawImage(c, 0, 0, W, H);
  bokeh(S, 22, 'fbok');
}

function sceneFlower(S) {
  const { ctx, W, H, P } = S;
  const r = S.rng('flower');
  const a = S.a;
  const kind = flowerKind(a, r);
  const col = flowerColor(S, kind, r);
  if (kind === 'sakura') {
    sky(S, H);
    sun(S, W * (0.2 + r() * 0.6), H * 0.3, 0.06, { glow: 0.8 });
    clouds(S, 0.02, H * 0.55, { cover: 0.35, key: 'sk', day: true, alpha: 0.6 });
  } else {
    sceneFlowerBg(S);
  }
  // blurred background blooms
  const { c, S2 } = subState(S, W * 90, H * 90);
  const rb = S.rng('fback');
  for (let i = 0; i < 14; i++) blossom(S2, rb() * W, H * (0.2 + rb() * 0.75), 0.05 + rb() * 0.06, mixc(col, P.light, rb() * 0.3), kind === 'sakura' ? 'sakura' : kind, rb);
  ctx.globalAlpha = 0.75;
  ctx.drawImage(c, 0, 0, W, H);
  ctx.globalAlpha = 1;
  if (kind === 'sakura') {
    const bark = mul(mixc(P.shadow, [70, 40, 40], 0.5), 0.8);
    ctx.strokeStyle = css(bark);
    ctx.lineCap = 'round';
    const tips = [];
    const branch = (x, y, ang, len, wd, depth) => {
      const ex = x + Math.cos(ang) * len, ey = y + Math.sin(ang) * len;
      ctx.lineWidth = wd;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + Math.cos(ang + 0.3) * len * 0.5, y + Math.sin(ang + 0.3) * len * 0.5, ex, ey); ctx.stroke();
      tips.push([ex, ey]);
      if (depth > 0) {
        branch(ex, ey, ang - 0.3 - r() * 0.4, len * 0.72, wd * 0.62, depth - 1);
        if (r() < 0.8) branch(ex, ey, ang + 0.25 + r() * 0.4, len * 0.62, wd * 0.6, depth - 1);
      }
    };
    const left = r() < 0.5;
    branch(left ? -0.02 : W + 0.02, H * (0.15 + r() * 0.3), left ? 0.15 : Math.PI - 0.15, W * 0.32, 0.035, 5);
    for (const [tx, ty] of tips) {
      for (let k = 0; k < 3; k++) blossom(S, tx + (r() - 0.5) * 0.06, ty + (r() - 0.5) * 0.05, 0.016 + r() * 0.018, col, 'sakura', r);
    }
    ctx.fillStyle = css(col, 0.85);
    for (let i = 0; i < 40; i++) { ctx.save(); ctx.translate(r() * W, r() * H); ctx.rotate(r() * TAU); ctx.beginPath(); ctx.ellipse(0, 0, 0.007, 0.004, 0, 0, TAU); ctx.fill(); ctx.restore(); }
    return;
  }
  const green = mixc(mixc(P.land, [50, 130, 60], 0.5), P.shadow, 0.15);
  const n = 2 + ((r() * 3) | 0);
  const heads = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    heads.push([W * (0.2 + t * 0.6) + (r() - 0.5) * 0.08, H * (0.3 + r() * 0.35), Math.min(W, H) * (0.12 + r() * 0.08) * (i === 1 ? 1.25 : 1)]);
  }
  for (const [x, y, R] of heads) {
    ctx.strokeStyle = grad(ctx, x, y, x, H, [[0, css(mixc(green, P.light, 0.2))], [1, css(mul(green, 0.6))]]);
    ctx.lineWidth = R * 0.07;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + (r() - 0.5) * 0.2, y + (H - y) * 0.5, x + (r() - 0.5) * 0.1, H + 0.02); ctx.stroke();
    leaf(ctx, x, y + (H - y) * 0.45, R * 1.1, -0.9 - r() * 0.4, green);
    leaf(ctx, x, y + (H - y) * 0.6, R * 1.0, 0.9 + r() * 0.4, green);
  }
  heads.sort((p, q) => p[2] - q[2]);
  for (const [x, y, R] of heads) {
    ctx.save(); ctx.globalCompositeOperation = 'screen';
    glowDot(ctx, x, y, R * 1.8, mixc(col, P.light, 0.4), 0.25);
    ctx.restore();
    blossom(S, x, y, R, col, kind, r);
  }
}

// ---------------------------------------------------------------- weather overlays

function snowfall(S) {
  const { ctx, W, H } = S;
  const r = S.rng('snowfall');
  ctx.save();
  for (let i = 0; i < 650; i++) {
    const depth = Math.pow(r(), 2.2), x = r() * W, y = r() * H;
    const s = 0.0012 + depth * 0.011;
    const al = 0.55 + r() * 0.4;
    if (depth > 0.55) glowDot(ctx, x, y, s * 1.6, WHITE, al * 0.7);
    else { ctx.fillStyle = css(WHITE, al); ctx.beginPath(); ctx.arc(x, y, s * 0.5, 0, TAU); ctx.fill(); }
  }
  ctx.restore();
}

function rainfall(S) {
  const { ctx, W, H, P } = S;
  const r = S.rng('rainfall');
  ctx.save();
  ctx.lineCap = 'round';
  const slant = 0.12 + r() * 0.1;
  for (let b = 0; b < 4; b++) {
    ctx.strokeStyle = css(mixc(P.light, WHITE, 0.4), 0.1 + b * 0.07);
    ctx.lineWidth = 0.0007 + b * 0.0007;
    ctx.beginPath();
    for (let i = 0; i < 260; i++) {
      const x = r() * (W + 0.2) - 0.1, y = r() * H, len = 0.02 + b * 0.025 + r() * 0.02;
      ctx.moveTo(x, y); ctx.lineTo(x - slant * len, y + len);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- post-processing looks

const LOOKS = {
  realistic: { contrast: 1.06, sat: 1.04, grain: 0.016, vignette: 0.3, bloom: 0.14 },
  cinematic: { contrast: 1.12, sat: 1.06, shadows: [-14, 6, 18], highs: [18, 5, -14], grain: 0.022, vignette: 0.5, bloom: 0.34 },
  editorial: { contrast: 0.95, sat: 0.78, lift: 16, highs: [10, 4, -4], shadows: [4, 0, 6], grain: 0.02, vignette: 0.22, bloom: 0.1 },
  anime: { contrast: 1.08, sat: 1.38, gamma: 0.9, posterize: 9, ink: 0.85, inkT: 44, vignette: 0.08, bloom: 0.25 },
  'film-noir': { mono: true, contrast: 1.45, gamma: 0.95, levels: 1, grain: 0.05, vignette: 0.6, blinds: true, bloom: 0.2 },
  vaporwave: { contrast: 1.04, sat: 1.2, shadows: [34, -8, 46], highs: [24, -6, 22], scan: 0.16, chroma: 3, grain: 0.012, vignette: 0.3, overlay: 'vapor', bloom: 0.3 },
  'analog-film': { contrast: 0.9, sat: 0.86, lift: 22, shadows: [6, 4, -4], highs: [20, 8, -20], grain: 0.06, vignette: 0.45, leaks: true, stamp: true, bloom: 0.22 },
  '3d-render': { contrast: 1.1, sat: 1.24, gamma: 0.95, vignette: 0.2, bloom: 0.36, tilt: true },
  watercolor: { contrast: 0.9, sat: 0.88, lift: 30, posterize: 14, paper: true, ink: 0.3, inkT: 18, bleed: true, highs: [8, 4, -6] },
  y2k: { contrast: 1.22, sat: 1.26, highs: [-8, 10, 26], shadows: [10, 0, 20], halftone: 0.5, chroma: 2, sparkle: true, bloom: 0.3, vignette: 0.25 },
  ethereal: { contrast: 0.86, sat: 0.84, lift: 26, highs: [10, 6, 14], bloom: 0.6, bloomThr: 0.45, vignette: 0.15, haze: true, grain: 0.008 },
  pixel: { pixel: 112, posterize: 6, sat: 1.18, contrast: 1.1 },
};

function boxBlur(d, w, h, rad) {
  const tmp = new Float32Array(w * h * 3);
  for (let pass = 0; pass < 2; pass++) {
    const horiz = pass === 0;
    const len = horiz ? w : h, lines = horiz ? h : w;
    for (let L = 0; L < lines; L++) {
      for (let i = 0; i < len; i++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let k = -rad; k <= rad; k++) {
          const j = i + k;
          if (j < 0 || j >= len) continue;
          const idx = horiz ? (L * w + j) * 4 : (j * w + L) * 4;
          r += d[idx]; g += d[idx + 1]; b += d[idx + 2]; n++;
        }
        const o = (horiz ? L * w + i : i * w + L) * 3;
        tmp[o] = r / n; tmp[o + 1] = g / n; tmp[o + 2] = b / n;
      }
    }
    for (let p = 0; p < w * h; p++) { d[p * 4] = tmp[p * 3]; d[p * 4 + 1] = tmp[p * 3 + 1]; d[p * 4 + 2] = tmp[p * 3 + 2]; }
  }
}

function bloom(S, amt, thr) {
  const { ctx, w, h } = S;
  const c = makeCanvas(Math.max(4, w / 10), Math.max(4, h / 10));
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, c.width, c.height);
  const img = x.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
    const k = Math.max(0, (l - thr) / (1 - thr));
    d[i] *= k; d[i + 1] *= k; d[i + 2] *= k; d[i + 3] = 255;
  }
  boxBlur(d, c.width, c.height, 2);
  boxBlur(d, c.width, c.height, 2);
  x.putImageData(img, 0, 0);
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = amt;
  ctx.drawImage(c, 0, 0, w, h);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function preLook(S, L, r) {
  const { ctx, w, h, U, P, a } = S;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  if (L.pixel) {
    const k = Math.max(1, U / L.pixel);
    const small = makeCanvas(w / k, h / k);
    small.getContext('2d').drawImage(ctx.canvas, 0, 0, w, h, 0, 0, small.width, small.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
  }
  if (L.bleed) {
    const soft = softCopy(S, 5);
    ctx.globalAlpha = 0.5; ctx.drawImage(soft, 0, 0, w, h);
    ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = 0.25; ctx.drawImage(soft, U * 0.006, U * 0.004, w, h);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    const N = S.noise('paper');
    const tex = texture(90, 90 * h / w, (u, v, out) => {
      const n = N.fbm(u * 6, v * 6 * h / w, 4);
      out[0] = 255; out[1] = 248; out[2] = 236; out[3] = 255 * smooth(0.45, 0.75, n) * 0.35;
    });
    ctx.globalCompositeOperation = 'soft-light';
    ctx.drawImage(tex, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }
  if (L.tilt) {
    const soft = softCopy(S, 7);
    const t = makeCanvas(w, h);
    const tc = t.getContext('2d');
    tc.drawImage(soft, 0, 0, w, h);
    tc.globalCompositeOperation = 'destination-in';
    tc.fillStyle = grad(tc, 0, 0, 0, h, [[0, 'rgba(0,0,0,1)'], [0.3, 'rgba(0,0,0,0)'], [0.68, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,1)']]);
    tc.fillRect(0, 0, w, h);
    ctx.drawImage(t, 0, 0);
  }
  if (L.haze) {
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = grad(ctx, 0, 0, 0, h, [[0, css(P.light, 0.18)], [1, css(P.hor, 0.1)]]);
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }
  if (L.bloom) bloom(S, L.bloom, L.bloomThr ?? 0.55);
  if (L.leaks) {
    ctx.globalCompositeOperation = 'screen';
    const cols = [[255, 120, 40], [255, 60, 80], [255, 200, 90]];
    for (let i = 0; i < 3; i++) {
      const edge = r() < 0.5 ? 0 : w;
      const y = r() * h, rad = U * (0.35 + r() * 0.5);
      ctx.fillStyle = rgrad(ctx, edge, y, rad, [[0, css(cols[i], 0.55)], [0.5, css(cols[i], 0.18)], [1, css(cols[i], 0)]]);
      ctx.fillRect(edge - rad, y - rad, rad * 2, rad * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  if (L.blinds && (a.scene === 'portrait' || a.scene === 'city' || a.scene === 'rain')) {
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-0.42);
    const D = Math.hypot(w, h), per = U * 0.085;
    for (let y = -D / 2; y < D / 2; y += per) {
      ctx.fillStyle = grad(ctx, 0, y, 0, y + per, [[0, 'rgba(0,0,0,0)'], [0.12, 'rgba(0,0,0,0.55)'], [0.48, 'rgba(0,0,0,0.55)'], [0.6, 'rgba(0,0,0,0)']]);
      ctx.fillRect(-D / 2, y, D, per);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  if (L.overlay === 'vapor') {
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = grad(ctx, 0, 0, 0, h, [[0, 'rgba(255,90,200,0.55)'], [0.5, 'rgba(160,90,255,0.3)'], [1, 'rgba(40,230,255,0.5)']]);
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
}

function grade(S, L) {
  const { ctx, w, h, U } = S;
  let img;
  try { img = ctx.getImageData(0, 0, w, h); } catch { return; }
  const d = img.data;
  const contrast = L.contrast ?? 1, sat = L.sat ?? 1, lift = (L.lift ?? 0) / 255, gamma = L.gamma ?? 1;
  // auto levels: stretch the 1st..99th luma percentile (blended by L.levels) so dark scenes still read
  const hist = new Uint32Array(256);
  let cnt = 0;
  for (let i = 0; i < d.length; i += 4 * 13) { hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++; cnt++; }
  let lo = 0, top = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > cnt * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > cnt * 0.01) { top = v; break; } }
  if (top - lo < 90) { const mid = (top + lo) / 2; lo = Math.max(0, mid - 45); top = Math.min(255, mid + 45); }
  const lv = L.levels ?? 0.45;
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    let x = lerp(v / 255, clamp((v - lo) / (top - lo)), lv);
    if (gamma !== 1) x = Math.pow(x, gamma);
    x = (x - 0.5) * contrast + 0.5;
    lut[v] = clamp(lift + x * (1 - lift)) * 255;
  }
  let post = null;
  if (L.posterize) {
    post = new Uint8Array(256);
    const n = L.posterize - 1;
    for (let v = 0; v < 256; v++) post[v] = Math.round((Math.round((v / 255) * n) / n) * 255);
  }
  const sh = L.shadows || [0, 0, 0], hi = L.highs || [0, 0, 0];
  const tint = !!(L.shadows || L.highs);
  const vig = L.vignette ?? 0;
  const vx = new Float32Array(w), vy = new Float32Array(h);
  for (let x = 0; x < w; x++) vx[x] = Math.pow(((x + 0.5) / w) * 2 - 1, 2);
  for (let y = 0; y < h; y++) vy[y] = Math.pow(((y + 0.5) / h) * 2 - 1, 2);
  const grain = Math.max(L.pixel || L.posterize ? 0 : 5, (L.grain ?? 0) * 255 * 2);
  const paper = !!L.paper;
  let seed = (S.base | 1) >>> 0;
  const chroma = L.chroma ? Math.max(1, Math.round((L.chroma * U) / 900)) : 0;
  const src = chroma ? new Uint8ClampedArray(d) : null;
  const ink = L.ink ?? 0, inkT = L.inkT ?? 28;
  let lumA = null;
  if (ink) {
    lumA = new Uint8Array(w * h);
    for (let p = 0, i = 0; p < w * h; p++, i += 4) lumA[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  }
  const scan = L.scan ?? 0, scanP = Math.max(2, Math.round(U / 280));
  const half = L.halftone ?? 0, cell = Math.max(3, U / 140);
  const mono = !!L.mono || !!S.a.flags.mono;
  for (let y = 0; y < h; y++) {
    const scanK = scan && y % scanP < scanP / 2 ? 1 - scan : 1;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = row + x, i = p * 4;
      let R, G, B;
      if (chroma) {
        R = src[(row + Math.min(w - 1, x + chroma)) * 4];
        G = src[i + 1];
        B = src[(row + Math.max(0, x - chroma)) * 4 + 2];
      } else { R = d[i]; G = d[i + 1]; B = d[i + 2]; }
      const l = R * 0.299 + G * 0.587 + B * 0.114;
      if (mono) { R = G = B = l; } else if (sat !== 1) { R = l + (R - l) * sat; G = l + (G - l) * sat; B = l + (B - l) * sat; }
      if (tint && !mono) {
        const t = l / 255, u = (1 - t) * (1 - t), v = t * t;
        R += sh[0] * u + hi[0] * v; G += sh[1] * u + hi[1] * v; B += sh[2] * u + hi[2] * v;
      }
      R = lut[R < 0 ? 0 : R > 255 ? 255 : R | 0]; G = lut[G < 0 ? 0 : G > 255 ? 255 : G | 0]; B = lut[B < 0 ? 0 : B > 255 ? 255 : B | 0];
      if (post) { R = post[R | 0]; G = post[G | 0]; B = post[B | 0]; }
      if (ink && x > 0 && x < w - 1 && y > 0 && y < h - 1) {
        const e = Math.abs(lumA[p + 1] - lumA[p - 1]) + Math.abs(lumA[p + w] - lumA[p - w]);
        if (e > inkT) { const f = 1 - ink * Math.min(1, (e - inkT) / 50); R *= f; G *= f; B *= f; }
      }
      if (half) {
        const u = ((x + y) * 0.7071) / cell, v = ((x - y) * 0.7071) / cell;
        const fu = u - Math.floor(u) - 0.5, fv = v - Math.floor(v) - 0.5;
        const rad = 0.7 * Math.sqrt(1 - l / 255);
        const f = fu * fu + fv * fv < rad * rad ? 1 - half * 0.45 : 1 + half * 0.12;
        R *= f; G *= f; B *= f;
      }
      if (scanK !== 1) { R *= scanK; G *= scanK; B *= scanK; }
      if (vig) {
        const rr = (vx[x] + vy[y]) * 0.5;
        const f = 1 - vig * rr * (0.35 + 0.65 * rr);
        R *= f; G *= f; B *= f;
      }
      if (grain || paper) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        const n = (seed >>> 0) / 4294967296 - 0.5;
        if (paper) { const f = 0.94 + n * 0.1; R = R * f + 8; G = G * f + 6; B = B * f + 2; }
        else { const g = n * grain; R += g; G += g; B += g; }
      }
      d[i] = R; d[i + 1] = G; d[i + 2] = B; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function postLook(S, L, r) {
  const { ctx, w, h, U } = S;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (L.sparkle) {
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 7; i++) {
      const x = r() * w, y = r() * h, s = U * (0.015 + r() * 0.035);
      glowDot(ctx, x, y, s * 0.8, [200, 230, 255], 0.6);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.moveTo(x, y - s); ctx.quadraticCurveTo(x, y, x + s * 0.7, y); ctx.quadraticCurveTo(x, y, x, y + s);
      ctx.quadraticCurveTo(x, y, x - s * 0.7, y); ctx.quadraticCurveTo(x, y, x, y - s);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  if (L.stamp) {
    const yy = String(90 + ((r() * 10) | 0)), mm = String(1 + ((r() * 12) | 0)).padStart(2, '0'), dd = String(1 + ((r() * 28) | 0)).padStart(2, '0');
    const fs = Math.max(8, Math.round(U * 0.038));
    ctx.font = `600 ${fs}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textBaseline = 'bottom';
    ctx.shadowColor = 'rgba(255,120,30,0.9)';
    ctx.shadowBlur = fs * 0.5;
    ctx.fillStyle = 'rgba(255,170,70,0.92)';
    ctx.fillText(`'${yy} ${mm} ${dd}`, U * 0.05, h - U * 0.045);
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}

/** Small "higgsfield clone" mark bottom-right (used for free-plan exports). */
export function drawWatermark(ctx, w, h) {
  const fs = Math.max(10, Math.round(Math.min(w, h) * 0.026));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `600 ${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = fs * 0.4;
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.fillText('higgsfield clone', w - fs * 0.9, h - fs * 0.7);
  ctx.restore();
}

// ---------------------------------------------------------------- entry points

const PAINTERS = {
  sunset: sceneSea, ocean: sceneSea, beach: (S) => sceneSea(S, { beach: true }), city: sceneCity, rain: sceneCity,
  cyberpunk: (S) => sceneCity(S, { cyber: true }), forest: sceneForest, mountain: sceneMountain, snow: sceneMountain,
  desert: sceneDesert, space: sceneSpace, portrait: scenePortrait, car: sceneCar, abstract: sceneAbstract, flower: sceneFlower,
};

/**
 * Paint a picture for `prompt` into ctx2d over (0, 0, width, height). Ignores and restores the current transform.
 * Same (prompt, seed, style) always yields the same image; the composition is the same at any resolution.
 */
export function paintScene(ctx, width, height, { prompt = '', seed = 1, style = 'cinematic' } = {}) {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  const a = analyzePrompt(prompt);
  const U = Math.min(w, h);
  const base = (hashSeed(String(prompt).trim().toLowerCase()) ^ Math.imul((seed >>> 0) + 1, 0x9e3779b1)) >>> 0;
  const pal = buildPalette(a);
  const P = {};
  ROLES.forEach((k, i) => { P[k] = pal[i]; });
  const S = { ctx, w, h, U, W: w / U, H: h / U, a, P, base,
    rng: (k) => mulberry32(hashSeed(k) ^ base), noise: (k) => makeNoise(hashSeed('n:' + k) ^ base) };
  const look = LOOKS[style] || LOOKS.cinematic;
  ctx.save();
  ctx.setTransform(U, 0, 0, U, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  ctx.beginPath();
  ctx.rect(0, 0, S.W, S.H);
  ctx.clip();
  (PAINTERS[a.scene] || sceneSea)(S, {});
  if (a.weather === 'snow') snowfall(S);
  else if (a.weather === 'rain' || (a.scene === 'cyberpunk' && !a.weather)) rainfall(S);
  else if (a.weather === 'fog' && !['city', 'mountain', 'forest'].includes(a.scene)) fogLayer(S, S.H * 0.45, S.H, 0.45);
  ctx.restore();
  const r = S.rng('post:' + style);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
  preLook(S, look, r);
  grade(S, look);
  postLook(S, look, r);
  ctx.restore();
}

/** Convenience: a new canvas with the scene painted in. */
export function sceneCanvas(width, height, opts = {}) {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  let c;
  if (typeof document !== 'undefined') { c = document.createElement('canvas'); c.width = w; c.height = h; }
  else c = new OffscreenCanvas(w, h);
  paintScene(c.getContext('2d', { willReadFrequently: true }), w, h, opts);
  return c;
}
