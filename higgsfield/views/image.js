// Soul image studio (#/image): prompt -> style -> aspect/batch/quality/seed -> procedural images saved to Assets.

import { h, ICON, modal, segmented, thumbOf, download, plural } from '../ui.js';
import { STYLES, paintScene, analyzePrompt, drawWatermark, hashSeed } from '../scene.js';

const ASPECTS = { '1:1': [1, 1], '4:5': [4, 5], '3:4': [3, 4], '16:9': [16, 9], '9:16': [9, 16] };
const QUALITY = { draft: { name: 'Draft', short: 768 }, hd: { name: 'HD', short: 1536 } };
const MAX_SIDE = 4096;
const PREFS_KEY = 'higgsfield-clone:image-prefs';
const THUMB_PROMPT = 'golden hour over misty mountains and a lake';
const IDEAS = [
  'rain-soaked neon street in Tokyo at night, reflections on wet asphalt',
  'lone hiker on a mountain ridge at sunset, epic clouds',
  'editorial portrait of a woman, pink and teal rim light, city bokeh',
  'misty pine forest at dawn with god rays',
  'red vintage sports car on a desert highway at golden hour',
  'ringed gas giant rising over a violet nebula',
  'tropical beach with palm trees, turquoise water, midday',
  'snowy alps under the milky way, frozen lake',
  'cherry blossom branch against a pastel sky',
  'abstract flowing silk ribbons in gold and magenta',
  'lighthouse on a cliff in a stormy sea, moody',
  'sand dunes in the sahara under a blazing sunset',
  'cyberpunk megacity with holographic billboards in the rain',
  'bouquet of crimson roses, soft studio light',
  'dreamy lavender sunflowers in a summer meadow',
  'cabin in a snowy forest at night, warm windows',
  'astronaut standing in a crater, spiral galaxy overhead',
  'portrait of a detective in a dark alley, film noir',
  'sailboat on a calm sea at dusk, birds overhead',
  'silver supercar in a neon city at night',
];
const BASE_ENH = ['cinematic lighting', 'volumetric light', 'shallow depth of field', 'shot on 35mm', 'ultra detailed', 'atmospheric haze', 'rich colour grade', '8k'];
const SCENE_ENH = {
  portrait: ['soft rim light', 'editorial fashion photography', '85mm lens', 'catchlights'],
  car: ['glossy reflections', 'low angle tracking shot', 'anamorphic lens flare', 'wet asphalt'],
  city: ['neon reflections on wet asphalt', 'long exposure light trails', 'blade runner mood'],
  cyberpunk: ['holographic signage', 'neon fog', 'rain-slick streets'],
  rain: ['puddle reflections', 'moody neon glow', 'rain streaks'],
  forest: ['god rays through the trees', 'morning mist', 'layered depth'],
  mountain: ['alpenglow', 'layered ridgelines', 'epic scale'],
  snow: ['crisp winter air', 'drifting snowflakes', 'blue hour'],
  ocean: ['golden sun glitter on the water', 'long exposure sea', 'wide horizon'],
  beach: ['turquoise shallows', 'soft sea breeze', 'postcard composition'],
  sunset: ['golden sun glitter on the water', 'fiery clouds', 'silhouettes'],
  desert: ['heat haze', 'sculpted dune shadows', 'warm sunlight'],
  space: ['cosmic dust', 'glowing nebula', 'NASA-grade detail'],
  abstract: ['iridescent sheen', 'flowing motion', 'studio render'],
  flower: ['macro photography', 'dewdrops', 'creamy bokeh'],
};
const UPSCALE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/></svg>';
const VARY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>';
const LOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const randomSeed = () => Math.floor(Math.random() * 999_999_999) + 1;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const styleName = (id) => STYLES.find((s) => s.id === id)?.name ?? id;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';

/** Pixel size for an aspect ratio with the given short side (even numbers). */
export function sizeFor(aspect, short) {
  const [a, b] = ASPECTS[aspect] ?? [1, 1];
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  return a >= b ? [even((short * a) / b), even(short)] : [even(short), even((short * b) / a)];
}

/** Append cinematic descriptors that fit the prompt's scene; null when nothing new to add. */
export function enhancePrompt(text) {
  const t = String(text ?? '').trim();
  const lower = t.toLowerCase();
  const scene = analyzePrompt(t).scene;
  const base = [...BASE_ENH];
  const k = hashSeed(lower) % base.length;
  const pool = [...(SCENE_ENH[scene] ?? []), ...base.slice(k), ...base.slice(0, k)];
  const add = pool.filter((d) => !lower.includes(d.toLowerCase())).slice(0, 4);
  if (!add.length) return null;
  return t ? `${t.replace(/[\s,.]+$/, '')}, ${add.join(', ')}` : add.join(', ');
}

function readPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; }
}
function writePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {}
}

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

let noiseTile = null;
function noise() {
  if (noiseTile) return noiseTile;
  noiseTile = newCanvas(128, 128);
  const g = noiseTile.getContext('2d');
  const img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = v * (0.6 + Math.random() * 0.4); img.data[i + 1] = v * (0.6 + Math.random() * 0.4); img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return noiseTile;
}

export async function mount(root, ctx) {
  const { store, toast, params, navigate } = ctx;
  const prefs = readPrefs();
  const pStyle = params.get('style');
  const state = {
    prompt: params.get('prompt') ?? store.getLastPrompt('image') ?? '',
    style: STYLES.some((s) => s.id === pStyle) ? pStyle : STYLES.some((s) => s.id === prefs.style) ? prefs.style : 'cinematic',
    aspect: ASPECTS[prefs.aspect] ? prefs.aspect : '1:1',
    batch: [1, 2, 3, 4].includes(prefs.batch) ? prefs.batch : 4,
    quality: QUALITY[prefs.quality] ? prefs.quality : 'draft',
    seed: Number.isFinite(Number(params.get('seed'))) && params.get('seed') ? Number(params.get('seed')) : randomSeed(),
    locked: false,
    negative: '',
    busy: false,
  };
  if (params.get('prompt')) store.setLastPrompt('image', state.prompt);
  let alive = true;
  const urls = new Set();
  const frames = new Set();
  const timers = new Set();
  let lightbox = null;
  const items = []; // { id, prompt, meta, blob, url, full?, el }
  const savePrefs = () => writePrefs({ style: state.style, aspect: state.aspect, batch: state.batch, quality: state.quality });
  const isFree = () => store.getPlan()?.id === 'free';
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
  const blobUrl = (blob) => { const u = URL.createObjectURL(blob); urls.add(u); return u; };

  // ---------------------------------------------------------------- panel
  const promptEl = h('textarea', { id: 'img-prompt', class: 'textarea img-prompt', rows: 4, maxlength: 1000, placeholder: 'Describe the image: a subject, a place, light, colours, mood…' });
  promptEl.value = state.prompt;
  const charCount = h('span', { class: 'field-hint' });
  const enhanceBtn = h('button', { type: 'button', class: 'btn btn-ghost img-mini' }, h('span', { html: ICON.sparkle }), 'Enhance prompt');
  const diceBtn = h('button', { type: 'button', class: 'btn btn-ghost img-mini' }, h('span', { html: ICON.dice }), 'Surprise me');

  const styleGrid = h('div', { class: 'img-styles', role: 'radiogroup', 'aria-label': 'Style' });
  const styleHint = h('span', { class: 'field-hint' });
  const styleCards = STYLES.map((s) => {
    const cv = newCanvas(120, 120);
    const b = h('button', { type: 'button', class: 'img-style', role: 'radio', 'aria-checked': String(s.id === state.style), title: s.description, 'data-style': s.id },
      h('span', { class: 'img-style-thumb' }, cv), h('span', { class: 'img-style-name' }, s.name));
    b.addEventListener('click', () => pickStyle(s.id));
    styleGrid.append(b);
    return { s, b, cv };
  });
  function pickStyle(id) {
    state.style = id;
    for (const c of styleCards) c.b.setAttribute('aria-checked', String(c.s.id === id));
    styleHint.textContent = STYLES.find((s) => s.id === id)?.description ?? '';
    savePrefs();
  }
  styleGrid.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const i = STYLES.findIndex((s) => s.id === state.style);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const n = (i + step + STYLES.length) % STYLES.length;
    pickStyle(STYLES[n].id);
    styleCards[n].b.focus();
    e.preventDefault();
  });

  let thumbJob = 0;
  function paintThumbs() {
    const job = ++thumbJob;
    const prompt = promptEl.value.trim() || THUMB_PROMPT;
    let i = 0;
    const step = () => {
      if (!alive || job !== thumbJob || i >= styleCards.length) return;
      const { s, cv } = styleCards[i++];
      try { paintScene(cv.getContext('2d', { willReadFrequently: true }), cv.width, cv.height, { prompt, seed: 7, style: s.id }); } catch (e) { console.warn(e); }
      const id = requestAnimationFrame(() => { frames.delete(id); step(); });
      frames.add(id);
    };
    step();
  }

  const aspectSeg = segmented('Aspect ratio', Object.keys(ASPECTS).map((a) => ({ value: a, label: a })), state.aspect, (v) => { state.aspect = v; savePrefs(); });
  const batchSeg = segmented('Number of images', [1, 2, 3, 4].map((n) => ({ value: n, label: String(n) })), state.batch, (v) => { state.batch = v; savePrefs(); syncCost(); });
  const qualitySeg = segmented('Quality', Object.entries(QUALITY).map(([value, q]) => ({ value, label: `${q.name} · ${q.short}px` })), state.quality, (v) => { state.quality = v; savePrefs(); });

  const seedEl = h('input', { id: 'img-seed', class: 'input img-seed-input', type: 'number', min: 1, max: 999999999, step: 1, inputmode: 'numeric' });
  seedEl.value = String(state.seed);
  const lockBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-pressed': 'false', 'aria-label': 'Lock seed', title: 'Lock seed: reuse it for every generation', html: LOCK_ICON });
  const seedDice = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Random seed', title: 'Random seed', html: ICON.dice });
  const negEl = h('input', { id: 'img-neg', class: 'input', type: 'text', maxlength: 300, placeholder: 'blurry, extra fingers, watermark…' });

  const genCost = h('span', { class: 'cost' });
  const genLabel = h('span', {}, 'Generate');
  const genBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg btn-block' }, h('span', { html: ICON.sparkle }), genLabel, genCost);
  const creditNote = h('p', { class: 'img-note' });
  const alertBox = h('div', { class: 'img-alert', role: 'alert', hidden: true });

  const panel = h('section', { class: 'panel img-panel', 'aria-label': 'Image settings' },
    h('div', { class: 'img-head' },
      h('h1', {}, h('span', { class: 'img-mark', html: ICON.image }), 'Soul'),
      h('span', { class: 'badge badge-accent' }, 'Image')),
    h('div', { class: 'field' },
      h('label', { for: 'img-prompt' }, 'Prompt', charCount),
      promptEl,
      h('div', { class: 'img-prompt-tools' }, enhanceBtn, diceBtn)),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Style', styleHint), styleGrid),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Aspect ratio'), aspectSeg),
    h('div', { class: 'img-row' },
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Images'), batchSeg),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Quality'), qualitySeg)),
    h('div', { class: 'field' },
      h('label', { for: 'img-seed' }, 'Seed', h('span', { class: 'field-hint' }, 'Same seed + prompt = same image')),
      h('div', { class: 'img-seed' }, seedEl, lockBtn, seedDice)),
    h('div', { class: 'field' }, h('label', { for: 'img-neg' }, 'Negative prompt', h('span', { class: 'field-hint' }, 'Optional')), negEl),
    alertBox,
    genBtn,
    creditNote);

  // ---------------------------------------------------------------- stage
  const countEl = h('span', { class: 'muted img-count' });
  const grid = h('div', { class: 'img-grid', 'aria-live': 'polite' });
  const ideas = h('div', { class: 'chips img-ideas' });
  const empty = h('div', { class: 'img-empty' },
    h('div', { class: 'img-empty-art', 'aria-hidden': 'true' }),
    h('h2', {}, 'Paint something'),
    h('p', { class: 'muted' }, 'Describe a scene, pick a Soul style and hit Generate. Every image is painted on your device and saved to Assets.'),
    ideas);
  for (const idea of IDEAS.slice(0, 5)) {
    ideas.append(h('button', { type: 'button', class: 'chip', onclick: () => { setPrompt(idea); promptEl.focus(); } }, idea));
  }
  const stage = h('section', { class: 'stage img-stage', 'aria-label': 'Generations' },
    h('div', { class: 'img-stage-head' }, h('h2', {}, 'Generations'), countEl),
    empty,
    grid);
  root.append(h('div', { class: 'studio img-studio' }, panel, stage));

  // ---------------------------------------------------------------- wiring
  function syncCount() {
    const n = items.length;
    countEl.textContent = n ? plural(n, 'image') : '';
    empty.hidden = n > 0;
  }
  function syncCost() {
    genCost.innerHTML = `${ICON.bolt}${state.batch}`;
    genBtn.setAttribute('aria-label', `Generate ${plural(state.batch, 'image')} for ${plural(state.batch, 'credit')}`);
    creditNote.textContent = `1 credit per image · ${store.getCredits().toLocaleString()} left${isFree() ? ' · Free plan downloads are watermarked' : ''}`;
    genBtn.disabled = state.busy;
    genLabel.textContent = state.busy ? 'Generating…' : 'Generate';
  }
  function syncChars() { charCount.textContent = `${promptEl.value.length}/1000`; }
  let thumbTimer = 0;
  function setPrompt(text) {
    promptEl.value = text;
    state.prompt = text;
    store.setLastPrompt('image', text);
    syncChars();
    clearTimeout(thumbTimer);
    timers.delete(thumbTimer);
    thumbTimer = later(paintThumbs, 450);
  }
  promptEl.addEventListener('input', () => setPrompt(promptEl.value));
  promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onGenerate(); }
  });
  enhanceBtn.addEventListener('click', () => {
    const next = enhancePrompt(promptEl.value);
    if (!next) { toast('Prompt is already fully enhanced'); return; }
    setPrompt(next.slice(0, 1000));
    toast('Added cinematic detail to your prompt', 'good');
  });
  diceBtn.addEventListener('click', () => {
    const pool = IDEAS.filter((i) => i !== promptEl.value);
    setPrompt(pool[Math.floor(Math.random() * pool.length)]);
  });
  lockBtn.addEventListener('click', () => {
    state.locked = !state.locked;
    lockBtn.setAttribute('aria-pressed', String(state.locked));
    lockBtn.setAttribute('aria-label', state.locked ? 'Unlock seed' : 'Lock seed');
  });
  seedDice.addEventListener('click', () => { seedEl.value = String(randomSeed()); });
  genBtn.addEventListener('click', () => onGenerate());
  const unsub = store.onChange(syncCost);

  function showAlert(need) {
    alertBox.replaceChildren(
      h('span', {}, `You need ${plural(need, 'credit')} but have ${store.getCredits()}. `),
      h('a', { href: '#/pricing' }, 'Get more credits'));
    alertBox.hidden = false;
    later(() => { alertBox.hidden = true; }, 8000);
  }

  function readSeed() {
    const v = Math.floor(Number(seedEl.value));
    return Number.isFinite(v) && v > 0 ? Math.min(v, 999_999_999) : randomSeed();
  }

  function onGenerate() {
    const prompt = promptEl.value.trim();
    if (!prompt) { toast('Write a prompt first, or roll the dice', 'bad'); promptEl.focus(); return; }
    let base = state.locked ? readSeed() : randomSeed();
    if (!state.locked) seedEl.value = String(base);
    const seeds = Array.from({ length: state.batch }, (_, i) => base + i);
    generate({ prompt, style: state.style, aspect: state.aspect, quality: state.quality, negative: negEl.value.trim(), seeds });
  }

  // ---------------------------------------------------------------- tiles
  function tileFor(item, pending) {
    const { width, height } = item.meta;
    const media = h('button', { type: 'button', class: 'img-open', 'aria-label': `Open image: ${item.prompt}`, disabled: pending });
    const status = h('div', { class: 'img-status', hidden: !pending }, h('span', { class: 'img-status-dot' }), h('span', { class: 'img-status-text' }, 'Queued'));
    const badges = h('div', { class: 'img-badges' },
      h('span', { class: 'badge' }, styleName(item.meta.style)),
      item.meta.quality === 'hd' ? h('span', { class: 'badge' }, 'HD') : null,
      item.meta.quality === 'upscaled' ? h('span', { class: 'badge badge-accent' }, '2×') : null);
    const act = (label, icon, fn) => h('button', { type: 'button', class: 'icon-btn img-act', 'aria-label': label, title: label, html: icon, onclick: (e) => { e.stopPropagation(); fn(); } });
    const actions = h('div', { class: 'img-actions', hidden: pending },
      act('Download PNG', ICON.download, () => downloadItem(item)),
      act('Animate with a camera move', ICON.camera, () => animateItem(item)),
      act('Upscale ×2 (1 credit)', UPSCALE_ICON, () => upscaleItem(item)),
      act('Variations', VARY_ICON, () => varyItem(item)));
    const el = h('article', { class: `img-tile${pending ? ' is-pending' : ''}`, style: { aspectRatio: `${width} / ${height}` } }, media, badges, status, actions);
    media.addEventListener('click', () => openLightbox(item));
    item.el = el; item.media = media; item.status = status; item.actions = actions;
    return el;
  }

  function setMedia(item) {
    const fresh = !item.media.firstChild;
    const img = h('img', { src: item.url || item.thumb, alt: item.prompt, loading: fresh ? 'lazy' : 'eager', decoding: 'async' });
    if (fresh) { item.media.replaceChildren(img); return; }
    // keep the revealed canvas until the PNG has decoded, so the tile never flashes empty
    img.decode().then(() => { if (alive) item.media.replaceChildren(img); }, () => {});
  }

  function setStatus(item, text) {
    const t = item.status.querySelector('.img-status-text');
    if (t) t.textContent = text;
  }

  /** Noise -> blur -> sharp "diffusion" reveal of `src` into the tile. */
  function reveal(item, src, ms) {
    return new Promise((resolve) => {
      const box = item.media.getBoundingClientRect();
      const dpr = Math.min(2, devicePixelRatio || 1);
      const dw = Math.max(64, Math.min(900, Math.round((box.width || 300) * dpr)));
      const dh = Math.max(64, Math.round((dw * src.height) / src.width));
      const disp = newCanvas(dw, dh);
      const g = disp.getContext('2d');
      const small = newCanvas(dw, dh);
      small.getContext('2d').drawImage(src, 0, 0, dw, dh);
      const tmp = newCanvas(dw, dh);
      const tg = tmp.getContext('2d');
      item.media.replaceChildren(disp);
      item.el.classList.remove('is-pending');
      item.el.classList.add('is-revealing');
      const pat = g.createPattern(noise(), 'repeat');
      const steps = 30;
      const t0 = performance.now();
      const frame = (now) => {
        if (!alive) return resolve();
        const t = Math.min(1, (now - t0) / ms);
        const e = 1 - Math.pow(1 - t, 2);
        if (t >= 1) {
          g.drawImage(small, 0, 0);
          item.el.classList.remove('is-revealing');
          return resolve();
        }
        const s = Math.max(4, Math.round(4 + Math.pow(e, 2.6) * dw));
        const sh = Math.max(4, Math.round((s * dh) / dw));
        tg.clearRect(0, 0, dw, dh);
        tg.drawImage(small, 0, 0, s, sh);
        g.imageSmoothingEnabled = true;
        g.drawImage(tmp, 0, 0, s, sh, 0, 0, dw, dh);
        g.save();
        g.globalAlpha = Math.pow(1 - e, 1.4) * 0.9;
        g.translate(-Math.random() * 128, -Math.random() * 128);
        g.scale(dpr, dpr);
        g.fillStyle = pat;
        g.fillRect(0, 0, dw + 256, dh + 256);
        g.restore();
        setStatus(item, `Denoising · step ${Math.min(steps, 1 + Math.floor(e * steps))}/${steps}`);
        const id = requestAnimationFrame((ts) => { frames.delete(id); frame(ts); });
        frames.add(id);
      };
      const id = requestAnimationFrame((ts) => { frames.delete(id); frame(ts); });
      frames.add(id);
    });
  }

  async function finish(item, canvas) {
    item.full = canvas;
    item.status.hidden = true;
    item.actions.hidden = false;
    item.media.disabled = false;
    try {
      item.blob = await canvasToBlob(canvas);
      if (!alive) return;
      item.thumb = thumbOf(canvas);
      if (item.blob) {
        item.url = blobUrl(item.blob);
        item.id = await store.saveAsset({ type: 'image', prompt: item.prompt, blob: item.blob, thumb: item.thumb, meta: item.meta });
      }
    } catch (e) { console.warn('save failed', e); }
    if (!alive) return;
    if (item.url) setMedia(item);
  }

  function noCredits(need) {
    toast(`Not enough credits: ${plural(need, 'credit')} needed`, 'bad');
    showAlert(need);
  }

  async function generate({ prompt, style, aspect, quality, negative, seeds, upscaleFrom = null }) {
    if (state.busy) { toast('Hang on, still painting the last batch'); return; }
    const cost = seeds.length;
    if (!store.spendCredits(cost)) { noCredits(cost); return; }
    alertBox.hidden = true;
    state.busy = true;
    syncCost();
    let [w, hgt] = sizeFor(aspect, QUALITY[quality]?.short ?? 768);
    if (upscaleFrom) {
      const k = Math.min(2, MAX_SIDE / Math.max(upscaleFrom.width, upscaleFrom.height));
      w = Math.round((upscaleFrom.width * k) / 2) * 2; hgt = Math.round((upscaleFrom.height * k) / 2) * 2;
    }
    const scene = analyzePrompt(prompt).scene;
    const batch = seeds.map((seed) => ({
      prompt, id: null, blob: null, url: null,
      meta: { style, aspect, seed, quality: upscaleFrom ? 'upscaled' : quality, negative, width: w, height: hgt, scene, ...(upscaleFrom ? { upscaledFrom: upscaleFrom.id ?? null } : {}) },
    }));
    for (let i = batch.length - 1; i >= 0; i--) { items.unshift(batch[i]); }
    grid.prepend(...batch.map((it) => tileFor(it, true)));
    syncCount();
    stage.scrollIntoView?.({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    let painted = 0;
    try {
      const canvases = [];
      for (const it of batch) {
        setStatus(it, upscaleFrom ? 'Upscaling…' : 'Sampling noise…');
        await nextFrame();
        await nextFrame();
        if (!alive) return;
        const c = newCanvas(w, hgt);
        paintScene(c.getContext('2d', { willReadFrequently: true }), w, hgt, { prompt, seed: it.meta.seed, style });
        canvases.push(c);
        painted++;
      }
      const base = upscaleFrom ? 500 : reducedMotion() ? 600 : 1300;
      await Promise.all(batch.map((it, i) => reveal(it, canvases[i], base + i * 160)));
      if (!alive) return;
      await Promise.all(batch.map((it, i) => finish(it, canvases[i])));
      if (!alive) return;
      toast(upscaleFrom ? `Upscaled to ${w}×${hgt} and saved to Assets` : `${plural(batch.length, 'image')} saved to Assets`, 'good');
    } catch (e) {
      console.error(e);
      const refund = cost - painted;
      if (refund > 0) store.addCredits(refund);
      for (const it of batch.slice(painted)) { it.el?.remove(); items.splice(items.indexOf(it), 1); }
      syncCount();
      if (alive) toast('Something went wrong while painting. Unused credits were refunded.', 'bad');
    } finally {
      state.busy = false;
      if (alive) syncCost();
    }
  }

  async function sourceCanvas(item) {
    if (item.full) return item.full;
    if (!item.blob) return null;
    const bmp = await createImageBitmap(item.blob);
    const c = newCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    return c;
  }

  async function downloadItem(item) {
    const name = `higgsfield-${slug(item.prompt)}-${item.meta.seed ?? 'img'}.png`;
    try {
      if (!isFree() && item.blob) { download(item.blob, name); return; }
      const src = await sourceCanvas(item);
      if (!src) { toast('That image is not available any more', 'bad'); return; }
      const c = newCanvas(src.width, src.height);
      const g = c.getContext('2d');
      g.drawImage(src, 0, 0);
      if (isFree()) drawWatermark(g, c.width, c.height);
      const blob = await canvasToBlob(c);
      if (blob) download(blob, name);
    } catch (e) { console.warn(e); toast('Download failed', 'bad'); }
  }

  function animateItem(item) {
    if (!item.id) { toast('Still saving that image, try again in a moment'); return; }
    lightbox?.close();
    navigate('video', { asset: item.id });
  }

  const canRepaint = (item) => item.meta?.style && Number.isFinite(item.meta?.seed) && ASPECTS[item.meta?.aspect];

  function upscaleItem(item) {
    if (!canRepaint(item)) { toast('This image cannot be upscaled', 'bad'); return; }
    const { width, height } = item.meta;
    if (Math.max(width, height) >= MAX_SIDE) { toast('Already at the maximum size'); return; }
    lightbox?.close();
    generate({ prompt: item.prompt, style: item.meta.style, aspect: item.meta.aspect, quality: item.meta.quality === 'hd' ? 'hd' : 'draft',
      negative: item.meta.negative || '', seeds: [item.meta.seed], upscaleFrom: { width: width || 768, height: height || 768, id: item.id } });
  }

  function varyItem(item) {
    if (!canRepaint(item)) { toast('This image has no settings to vary', 'bad'); return; }
    lightbox?.close();
    const base = randomSeed();
    generate({ prompt: item.prompt, style: item.meta.style, aspect: item.meta.aspect, quality: item.meta.quality === 'hd' ? 'hd' : 'draft',
      negative: item.meta.negative || '', seeds: Array.from({ length: state.batch }, (_, i) => base + i) });
  }

  function reuse(item) {
    setPrompt(item.prompt);
    if (STYLES.some((s) => s.id === item.meta.style)) pickStyle(item.meta.style);
    if (ASPECTS[item.meta.aspect]) {
      state.aspect = item.meta.aspect;
      aspectSeg.value = state.aspect;
      for (const b of aspectSeg.children) b.setAttribute('aria-checked', String(b.dataset.value === state.aspect));
    }
    if (Number.isFinite(item.meta.seed)) {
      seedEl.value = String(item.meta.seed);
      if (!state.locked) lockBtn.click();
    }
    negEl.value = item.meta.negative || '';
    lightbox?.close();
    promptEl.focus();
    toast('Settings loaded: prompt, style, aspect and seed');
  }

  function openLightbox(item) {
    if (!item.url && !item.thumb && !item.full) return;
    const m = item.meta;
    const img = item.url || item.thumb ? h('img', { src: item.url || item.thumb, alt: item.prompt }) : item.full;
    const copyBtn = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Copy prompt');
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(item.prompt); toast('Prompt copied', 'good'); } catch { toast('Copy failed', 'bad'); }
    });
    const can = canRepaint(item);
    const row = (k, v) => (v ? h('div', {}, h('dt', {}, k), h('dd', {}, v)) : null);
    const body = h('div', { class: 'img-lb' },
      h('figure', { class: 'img-lb-media' }, img),
      h('div', { class: 'img-lb-side' },
        h('span', { class: 'eyebrow' }, `${styleName(m.style)} · Soul`),
        h('p', { class: 'img-lb-prompt' }, item.prompt),
        h('dl', { class: 'img-lb-meta' },
          row('Size', m.width ? `${m.width}×${m.height}` : ''),
          row('Aspect', m.aspect),
          row('Seed', m.seed != null ? String(m.seed) : ''),
          row('Quality', m.quality === 'upscaled' ? 'Upscaled 2×' : QUALITY[m.quality]?.name),
          row('Negative', m.negative)),
        h('div', { class: 'img-lb-actions' },
          h('button', { type: 'button', class: 'btn btn-primary', onclick: () => downloadItem(item) }, h('span', { html: ICON.download }), isFree() ? 'Download PNG (watermarked)' : 'Download PNG'),
          h('button', { type: 'button', class: 'btn', onclick: () => animateItem(item) }, h('span', { html: ICON.camera }), 'Animate'),
          h('button', { type: 'button', class: 'btn', disabled: !can, onclick: () => upscaleItem(item) }, h('span', { html: UPSCALE_ICON }), 'Upscale ×2', h('span', { class: 'cost' }, h('span', { html: ICON.bolt }), '1')),
          h('button', { type: 'button', class: 'btn', disabled: !can, onclick: () => varyItem(item) }, h('span', { html: VARY_ICON }), 'Variations', h('span', { class: 'cost' }, h('span', { html: ICON.bolt }), String(state.batch))),
          h('button', { type: 'button', class: 'btn btn-ghost', disabled: !can, onclick: () => reuse(item) }, 'Reuse settings'),
          copyBtn)));
    lightbox = modal(body, { label: 'Image preview', wide: true, onClose: () => { lightbox = null; } });
  }

  // ---------------------------------------------------------------- init
  pickStyle(state.style);
  syncChars();
  syncCost();
  syncCount();
  paintThumbs();
  try {
    const recs = (await store.listAssets()).filter((r) => r.type === 'image').slice(0, 40);
    if (!alive) return () => {};
    for (const rec of recs) {
      const item = { id: rec.id, prompt: rec.prompt, blob: rec.blob ?? null, thumb: rec.thumb, url: rec.blob ? blobUrl(rec.blob) : null,
        meta: { width: 1, height: 1, ...(rec.meta || {}) } };
      if (!item.url && !item.thumb) continue;
      items.push(item);
      grid.append(tileFor(item, false));
      setMedia(item);
    }
    syncCount();
  } catch (e) { console.warn(e); }

  return function unmount() {
    alive = false;
    thumbJob++;
    for (const id of frames) cancelAnimationFrame(id);
    for (const id of timers) clearTimeout(id);
    clearTimeout(thumbTimer);
    unsub();
    lightbox?.close();
    for (const u of urls) URL.revokeObjectURL(u);
  };
}
