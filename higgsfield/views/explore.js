// Explore (home): hero reel, camera-preset rail, feature cards and a community feed.
// Presets, renderer and scene painter come from other modules; each import falls back
// to a cheap local stand-in so the page still renders if one fails to load.

import { h, modal, ICON } from '../ui.js';

const MAX_PREVIEWS = 4; // rail + community; the hero adds at most 2 more while crossfading
const REEL_MS = 5200;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ fallbacks

const FALLBACK_CATEGORIES = [
  { id: 'zoom', name: 'Zoom' }, { id: 'orbit', name: 'Orbit' }, { id: 'crane', name: 'Crane' },
  { id: 'pan-tilt', name: 'Pan & tilt' }, { id: 'handheld', name: 'Handheld' }, { id: 'drone', name: 'Drone' }, { id: 'fx', name: 'FX' },
];
const FALLBACK_PRESETS = [
  ['dolly-in', 'Dolly In', 'zoom'], ['dolly-out', 'Dolly Out', 'zoom'], ['crash-zoom', 'Crash Zoom', 'zoom'],
  ['dolly-zoom', 'Dolly Zoom', 'zoom'], ['arc-left', 'Arc Left', 'orbit'], ['360-orbit', '360 Orbit', 'orbit'],
  ['bullet-time', 'Bullet Time', 'orbit'], ['crane-up', 'Crane Up', 'crane'], ['crane-down', 'Crane Down', 'crane'],
  ['pan-left', 'Pan Left', 'pan-tilt'], ['tilt-up', 'Tilt Up', 'pan-tilt'], ['whip-pan', 'Whip Pan', 'pan-tilt'],
  ['handheld', 'Handheld', 'handheld'], ['snorricam', 'Snorricam', 'handheld'], ['fpv-drone', 'FPV Drone', 'drone'],
  ['earth-zoom-out', 'Earth Zoom Out', 'drone'], ['glitch', 'Glitch', 'fx'], ['disintegration', 'Disintegration', 'fx'],
].map(([id, name, category]) => ({ id, name, category, description: '', tags: [] }));
const FALLBACK_STYLES = [
  { id: 'cinematic', name: 'Cinematic' }, { id: 'realistic', name: 'Realistic' }, { id: 'editorial', name: 'Editorial' },
  { id: 'anime', name: 'Anime' }, { id: 'film-noir', name: 'Film noir' }, { id: 'vaporwave', name: 'Vaporwave' },
];

function hash(str) {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) x = Math.imul(x ^ str.charCodeAt(i), 16777619);
  return x >>> 0;
}

/** Gradient-and-horizon placeholder used when scene.js is unavailable. */
function fallbackScene(w, h0, { prompt = '', seed = 1 } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h0;
  const g = c.getContext('2d');
  const x = hash(`${prompt}:${seed}`);
  const hue = x % 360;
  const hue2 = (hue + 30 + ((x >>> 9) % 140)) % 360;
  const sky = g.createLinearGradient(0, 0, 0, h0);
  sky.addColorStop(0, `hsl(${hue} 55% 12%)`);
  sky.addColorStop(0.62, `hsl(${hue2} 70% 42%)`);
  sky.addColorStop(1, `hsl(${hue} 40% 8%)`);
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h0);
  const sx = w * (0.25 + ((x >>> 4) % 50) / 100);
  const glow = g.createRadialGradient(sx, h0 * 0.55, 0, sx, h0 * 0.55, w * 0.5);
  glow.addColorStop(0, `hsl(${(hue2 + 20) % 360} 95% 75% / 0.9)`);
  glow.addColorStop(1, 'transparent');
  g.fillStyle = glow;
  g.fillRect(0, 0, w, h0);
  g.fillStyle = `hsl(${hue} 40% 6%)`;
  g.beginPath();
  g.moveTo(0, h0);
  for (let i = 0; i <= 12; i++) g.lineTo((w / 12) * i, h0 * (0.68 + 0.08 * Math.sin(i * 1.7 + (x % 7))));
  g.lineTo(w, h0);
  g.fill();
  return c;
}

/** Draw `src` covering a w×h box, with optional zoom and offsets (fractions of the box). */
function drawCover(g, src, w, h0, zoom = 1, ox = 0, oy = 0) {
  const sw = src.width, sh = src.height;
  const s = Math.max(w / sw, h0 / sh) * zoom;
  g.drawImage(src, (w - sw * s) / 2 + ox * w, (h0 - sh * s) / 2 + oy * h0, sw * s, sh * s);
}

function fallbackPreview(canvas, source, presetId, { loopMs = 2600 } = {}) {
  const g = canvas.getContext('2d');
  const t0 = performance.now();
  const dir = hash(presetId) % 2 ? 1 : -1;
  let raf = 0;
  const frame = (now) => {
    const t = ((now - t0) % loopMs) / loopMs;
    const e = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
    drawCover(g, source, canvas.width, canvas.height, 1.05 + 0.18 * e, dir * 0.04 * e, 0);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

async function loadDeps() {
  const [presets, render, scene] = await Promise.all([
    import('../presets.js').catch(() => null),
    import('../render.js').catch(() => null),
    import('../scene.js').catch(() => null),
  ]);
  const PRESETS = presets?.PRESETS?.length ? presets.PRESETS : FALLBACK_PRESETS;
  const CATEGORIES = presets?.CATEGORIES?.length ? presets.CATEGORIES : FALLBACK_CATEGORIES;
  const STYLES = scene?.STYLES?.length ? scene.STYLES : FALLBACK_STYLES;
  const byId = (id) => (presets?.presetById?.(id)) ?? PRESETS.find((p) => p.id === id);
  return {
    PRESETS, CATEGORIES, STYLES,
    presetId: (id, i = 0) => (byId(id) ? id : PRESETS[i % PRESETS.length].id),
    presetName: (id) => byId(id)?.name ?? id,
    styleId: (id) => (STYLES.some((s) => s.id === id) ? id : STYLES[0].id),
    styleName: (id) => STYLES.find((s) => s.id === id)?.name ?? id,
    paint(w, h0, opts) {
      if (scene?.sceneCanvas) {
        try { return scene.sceneCanvas(w, h0, opts); } catch (e) { console.warn('sceneCanvas failed', e); }
      }
      return fallbackScene(w, h0, opts);
    },
    preview(canvas, source, presetId, opts) {
      if (render?.startPreview) {
        try { return render.startPreview(canvas, source, presetId, opts); } catch (e) { console.warn('startPreview failed', e); }
      }
      return fallbackPreview(canvas, source, presetId, opts);
    },
    still(canvas, source, presetId, t = 0.5) {
      const g = canvas.getContext('2d');
      if (render?.drawFrame) {
        try { render.drawFrame(g, source, presetId, t, { width: canvas.width, height: canvas.height }); return; } catch {}
      }
      drawCover(g, source, canvas.width, canvas.height);
    },
  };
}

// ------------------------------------------------------------------ content

const HERO_REEL = [
  { prompt: 'neon city street at night in the rain, cyberpunk reflections', preset: 'dolly-in', style: 'cinematic' },
  { prompt: 'golden sunset over ocean waves, warm orange sky', preset: 'crane-up', style: 'cinematic' },
  { prompt: 'snowy mountain peaks at dawn, pink and blue light', preset: 'fpv-drone', style: 'realistic' },
  { prompt: 'galaxy over a desert canyon, purple space nebula', preset: 'crash-zoom', style: 'cinematic' },
];

const SOURCE_PROMPTS = [
  'neon cyberpunk city at night', 'sunset over the ocean beach', 'misty pine forest at dawn',
  'portrait of a woman in red light', 'red sports car on a desert highway', 'snowy mountain range under stars',
  'galaxy and nebula in deep space', 'field of pink flowers at golden hour',
];

const CREATORS = ['@mira.frames', '@kodaklux', '@neonmori', '@studio_ash', '@lensless', '@vhs.dream', '@ollie.makes',
  '@noir_nina', '@driftcam', '@pixelmonk', '@juno.wav', '@theo.cuts'];

// [prompt, style, preset-for-video | null, aspect]
const COMMUNITY = [
  ['rain-soaked neon alley in Tokyo, cyberpunk, magenta and teal', 'cinematic', 'dolly-in', '4:5'],
  ['editorial portrait, woman with silver earrings, soft studio light', 'editorial', null, '3:4'],
  ['lonely lighthouse on a cliff at sunset, crashing ocean waves', 'realistic', null, '16:9'],
  ['astronaut floating above a purple galaxy', '3d-render', 'crash-zoom', '1:1'],
  ['vintage red convertible car on a desert road, 1970s film', 'analog-film', null, '4:3'],
  ['cherry blossom forest in spring, anime sky', 'anime', null, '9:16'],
  ['snowy mountain village at night, warm windows, falling snow', 'cinematic', 'crane-up', '16:9'],
  ['detective in the rain under a street lamp, black and white', 'film-noir', null, '3:4'],
  ['pastel palm trees and a pink sunset grid, retro', 'vaporwave', null, '1:1'],
  ['jungle waterfall with emerald green mist', 'realistic', 'fpv-drone', '4:5'],
  ['chrome butterfly, glossy y2k aesthetic, blue gradient', 'y2k', null, '1:1'],
  ['watercolor lavender fields in Provence', 'watercolor', null, '4:3'],
  ['portrait of a man in neon light, rain on glass', 'cinematic', 'arc-left', '3:4'],
  ['sand dunes at golden hour, long shadows', 'realistic', null, '21:9'],
  ['koi pond with lotus flowers from above', 'editorial', null, '1:1'],
  ['cyberpunk motorcycle racing through a neon tunnel', 'cinematic', 'whip-pan', '16:9'],
  ['foggy pine forest at dawn, sunbeams through trees', 'analog-film', null, '4:5'],
  ['orange tabby cat on a windowsill, cozy morning light', 'realistic', null, '3:4'],
  ['northern lights over a frozen lake, green aurora', 'cinematic', 'dolly-out', '16:9'],
  ['retro diner at midnight, neon sign glow', 'film-noir', null, '4:3'],
  ['floating islands above the clouds, fantasy sky', 'anime', null, '9:16'],
  ['surfer riding a giant blue ocean wave', 'realistic', 'bullet-time', '4:5'],
  ['minimal abstract shapes, coral and cream', '3d-render', null, '1:1'],
  ['city skyline at dusk from a rooftop, purple haze', 'cinematic', '360-orbit', '16:9'],
];

const ASPECT = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '3:4': 3 / 4, '4:3': 4 / 3, '21:9': 21 / 9 };

const FEATURES = [
  { route: 'video', icon: 'camera', title: 'Video', body: 'Turn a photo or prompt into a moving shot with a named camera move.', cta: 'Create video', prompt: 'neon city street at night' },
  { route: 'image', icon: 'image', title: 'Soul Image', body: 'Editorial, cinematic and film-stock looks from one prompt, up to four at a time.', cta: 'Generate image', prompt: 'portrait of a woman in soft golden light' },
  { route: 'speak', icon: 'mic', title: 'Speak', body: 'Give any face a voice: type a script and watch it talk in sync.', cta: 'Make it talk', prompt: 'portrait of a man in studio light' },
  { route: 'library', icon: 'sparkle', title: 'Assets', body: 'Every video, image and voice you make, kept in this browser.', cta: 'Open assets', prompt: 'abstract colorful gradient shapes' },
];

const fmtLikes = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

// ------------------------------------------------------------------ preview pool

/**
 * Caps how many live previews run at once. Hovered items win, then visible ones in
 * registration order. Each item supplies start() -> stop().
 */
function createPool(max) {
  const items = new Map();
  let raf = 0;
  const sync = () => {
    raf = 0;
    const list = [...items.entries()];
    const want = [...list.filter(([, s]) => s.hover), ...list.filter(([, s]) => !s.hover && s.visible && s.auto)].slice(0, max);
    const chosen = new Set(want.map(([el]) => el));
    for (const [el, s] of list) {
      if (!chosen.has(el) && s.stop) { s.stop(); s.stop = null; el.classList.remove('is-playing'); }
    }
    for (const [el, s] of want) {
      if (!s.stop) { s.stop = s.start() ?? (() => {}); el.classList.add('is-playing'); }
    }
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(sync); };
  return {
    add(el, start, auto = false) { items.set(el, { start, auto, visible: false, hover: false, stop: null }); },
    set(el, key, val) {
      const s = items.get(el);
      if (s && s[key] !== val) { s[key] = val; schedule(); }
    },
    remove(el) {
      const s = items.get(el);
      if (s?.stop) s.stop();
      items.delete(el);
    },
    clear() {
      cancelAnimationFrame(raf); raf = 0;
      for (const s of items.values()) s.stop?.();
      items.clear();
    },
  };
}

/** Runs paint jobs one at a time between frames so lazy thumbnails don't jank scrolling. */
function createPaintQueue() {
  const jobs = [];
  let timer = 0;
  let dead = false;
  const idle = window.requestIdleCallback ? (fn) => requestIdleCallback(fn, { timeout: 120 }) : (fn) => setTimeout(fn, 16);
  const run = () => {
    timer = 0;
    if (dead) return;
    const job = jobs.shift();
    if (job) { try { job(); } catch (e) { console.warn(e); } }
    if (jobs.length) timer = idle(run);
  };
  return {
    push(fn, urgent = false) {
      if (urgent) jobs.unshift(fn); else jobs.push(fn);
      if (!timer) timer = idle(run);
    },
    stop() { dead = true; jobs.length = 0; },
  };
}

// ------------------------------------------------------------------ mount

export async function mount(root, ctx) {
  const deps = await loadDeps();
  const pool = createPool(MAX_PREVIEWS);
  const paints = createPaintQueue();
  const cleanups = [];
  let openModal = null;
  const auto = !reducedMotion();

  // Shared, lazily painted source pictures for the preset cards.
  const sources = new Map();
  const sourceFor = (i) => {
    const k = i % SOURCE_PROMPTS.length;
    if (!sources.has(k)) sources.set(k, deps.paint(240, 320, { prompt: SOURCE_PROMPTS[k], seed: k + 3, style: deps.styleId('cinematic') }));
    return sources.get(k);
  };

  // Paint-on-approach observer and play-when-visible observer.
  const lazy = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      lazy.unobserve(e.target);
      const fn = e.target._paint;
      if (fn) paints.push(fn);
    }
  }, { rootMargin: '300px 300px' });
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) pool.set(e.target, 'visible', e.isIntersecting);
  }, { threshold: 0.6 });
  cleanups.push(() => { lazy.disconnect(); seen.disconnect(); });

  const hoverable = (el) => {
    const on = () => pool.set(el, 'hover', true);
    const off = () => pool.set(el, 'hover', false);
    el.addEventListener('pointerenter', on);
    el.addEventListener('pointerleave', off);
    el.addEventListener('focus', on);
    el.addEventListener('blur', off);
  };

  const page = h('div', { class: 'pg-explore' });
  page.append(buildHero(), h('div', { class: 'page pg-explore-body' }, buildPresets(), buildFeatures(), buildCommunity()));
  root.append(page);

  // ---------------------------------------------------------------- hero
  function buildHero() {
    const narrow = innerWidth < 700;
    const [cw, ch] = narrow ? [540, 760] : [1120, 630];
    const slides = HERO_REEL.map((s, i) => ({ ...s, preset: deps.presetId(s.preset, i), style: deps.styleId(s.style) }));
    const reel = h('div', { class: 'pg-reel', 'aria-hidden': 'true' });
    const canvases = slides.map(() => {
      const c = h('canvas', { class: 'pg-reel-frame', width: cw, height: ch });
      reel.append(c);
      return c;
    });
    const srcs = [];
    const getSrc = (i) => (srcs[i] ??= deps.paint(cw, ch, { prompt: slides[i].prompt, seed: 11 + i, style: slides[i].style }));

    const caption = h('span', { class: 'pg-reel-caption' });
    const dots = h('div', { class: 'pg-reel-dots', role: 'group', 'aria-label': 'Hero reel' });
    const dotBtns = slides.map((s, i) => {
      const b = h('button', { type: 'button', class: 'pg-reel-dot', 'aria-label': `Show ${deps.presetName(s.preset)} shot`, 'aria-pressed': 'false', onclick: () => show(i) });
      dots.append(b);
      return b;
    });

    let cur = -1;
    let timer = 0;
    const stops = new Map();
    const stopSlide = (i) => { stops.get(i)?.(); stops.delete(i); };
    function show(i) {
      if (i === cur) return;
      const prev = cur;
      cur = i;
      const c = canvases[i];
      const src = getSrc(i);
      if (auto) { stopSlide(i); stops.set(i, deps.preview(c, src, slides[i].preset, { loopMs: REEL_MS + 400, intensity: 1 })); }
      else deps.still(c, src, slides[i].preset, 0.4);
      canvases.forEach((el, j) => el.classList.toggle('is-active', j === i));
      dotBtns.forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
      caption.replaceChildren(h('span', { class: 'pg-live-dot' }), h('b', {}, deps.presetName(slides[i].preset)), h('span', { class: 'pg-reel-prompt' }, ` · ${slides[i].prompt}`));
      if (prev >= 0) setTimeout(() => { if (cur !== prev) stopSlide(prev); }, 1100);
      // Warm the next picture in the background.
      paints.push(() => getSrc((i + 1) % slides.length));
      clearTimeout(timer);
      if (auto) timer = setTimeout(() => show((cur + 1) % slides.length), REEL_MS);
    }
    show(0);
    cleanups.push(() => { clearTimeout(timer); for (const i of [...stops.keys()]) stopSlide(i); });

    const nPresets = deps.PRESETS.length;
    return h('section', { class: 'pg-hero', 'aria-labelledby': 'pg-hero-title' },
      reel,
      h('div', { class: 'pg-hero-shade' }),
      h('div', { class: 'pg-hero-inner' },
        h('span', { class: 'pg-kicker' }, h('span', { class: 'badge badge-accent' }, 'New'), `${nPresets} camera presets, all in your browser`),
        h('h1', { id: 'pg-hero-title', class: 'pg-hero-title' }, 'Camera control', h('br'), 'for ', h('em', {}, 'AI video')),
        h('p', { class: 'pg-hero-sub' }, 'Crash zooms, crane shots, bullet time, FPV drone dives. Drop in a photo or write a prompt, pick a move, and get a real video file in seconds.'),
        h('div', { class: 'pg-hero-ctas' },
          h('a', { class: 'btn btn-primary btn-lg', href: '#/video' }, h('span', { html: ICON.camera }), 'Create video'),
          h('a', { class: 'btn btn-lg pg-btn-glass', href: '#/image' }, h('span', { html: ICON.image }), 'Generate image')),
        h('dl', { class: 'pg-hero-stats' },
          h('div', {}, h('dt', {}, 'Camera moves'), h('dd', {}, String(nPresets))),
          h('div', {}, h('dt', {}, 'Soul styles'), h('dd', {}, String(deps.STYLES.length))),
          h('div', {}, h('dt', {}, 'Server uploads'), h('dd', {}, '0')))),
      h('div', { class: 'pg-hero-foot' }, caption, dots));
  }

  // ---------------------------------------------------------------- presets rail
  function buildPresets() {
    const rail = h('div', { class: 'pg-rail', role: 'list', 'aria-label': 'Camera presets' });
    const chips = h('div', { class: 'pg-chips', role: 'group', 'aria-label': 'Filter presets by category' });
    const cats = [{ id: 'all', name: 'All' }];
    if (deps.PRESETS.some((p) => p.popular)) cats.push({ id: 'popular', name: 'Popular' });
    for (const c of deps.CATEGORIES) if (deps.PRESETS.some((p) => p.category === c.id)) cats.push(c);
    let filter = 'all';
    const chipBtns = cats.map((c) => {
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(c.id === filter), onclick: () => { filter = c.id; chipBtns.forEach((x) => x.setAttribute('aria-pressed', String(x === b))); fill(); } }, c.name);
      chips.append(b);
      return b;
    });
    const catName = (id) => deps.CATEGORIES.find((c) => c.id === id)?.name ?? id;

    let cards = [];
    function fill() {
      for (const el of cards) { pool.remove(el); lazy.unobserve(el); seen.unobserve(el); }
      const list = deps.PRESETS.filter((p) => filter === 'all' || (filter === 'popular' ? p.popular : p.category === filter));
      cards = list.map((p) => card(p, deps.PRESETS.indexOf(p)));
      rail.replaceChildren(...cards.map((c) => h('div', { role: 'listitem', class: 'pg-rail-item' }, c)));
      rail.scrollLeft = 0;
      updateArrows();
    }
    function card(p, idx) {
      const canvas = h('canvas', { width: 240, height: 320, class: 'pg-preset-canvas' });
      const flag = p.new ? h('span', { class: 'badge badge-accent pg-preset-flag' }, 'New') : p.popular ? h('span', { class: 'badge pg-preset-flag' }, 'Popular') : null;
      const el = h('button', { type: 'button', class: 'pg-preset', title: p.description || p.name, 'aria-label': `${p.name}: open in Video`, onclick: () => ctx.navigate('video', { preset: p.id }) },
        canvas, flag,
        h('span', { class: 'pg-preset-play', html: ICON.play }),
        h('span', { class: 'pg-preset-meta' }, h('span', { class: 'pg-preset-name' }, p.name), h('span', { class: 'pg-preset-cat' }, catName(p.category))));
      el._paint = () => { deps.still(canvas, sourceFor(idx), p.id, 0.5); el.classList.add('is-painted'); };
      pool.add(el, () => deps.preview(canvas, sourceFor(idx), p.id, { loopMs: 2600 }), auto);
      hoverable(el);
      lazy.observe(el);
      seen.observe(el);
      return el;
    }

    const prev = h('button', { type: 'button', class: 'icon-btn pg-rail-arrow pg-rail-prev', 'aria-label': 'Scroll presets left', html: ICON.arrow, onclick: () => rail.scrollBy({ left: -rail.clientWidth * 0.8, behavior: 'smooth' }) });
    const next = h('button', { type: 'button', class: 'icon-btn pg-rail-arrow pg-rail-next', 'aria-label': 'Scroll presets right', html: ICON.arrow, onclick: () => rail.scrollBy({ left: rail.clientWidth * 0.8, behavior: 'smooth' }) });
    function updateArrows() {
      prev.disabled = rail.scrollLeft < 8;
      next.disabled = rail.scrollLeft + rail.clientWidth > rail.scrollWidth - 8;
    }
    rail.addEventListener('scroll', updateArrows, { passive: true });
    fill();
    requestAnimationFrame(updateArrows);

    return h('section', { class: 'section pg-presets', 'aria-labelledby': 'pg-presets-title' },
      h('div', { class: 'section-head' },
        h('div', {}, h('span', { class: 'eyebrow' }, 'Camera presets'), h('h2', { id: 'pg-presets-title' }, 'Direct the shot')),
        h('a', { href: '#/video' }, 'Open the studio →')),
      chips,
      h('div', { class: 'pg-rail-wrap' }, prev, rail, next));
  }

  // ---------------------------------------------------------------- features
  function buildFeatures() {
    const grid = h('div', { class: 'pg-features' });
    FEATURES.forEach((f, i) => {
      const bg = h('canvas', { class: 'pg-feature-bg', width: 480, height: 300, 'aria-hidden': 'true' });
      const el = h('a', { class: 'pg-feature', href: `#/${f.route}` },
        bg,
        h('span', { class: 'pg-feature-icon', html: ICON[f.icon] }),
        h('span', { class: 'pg-feature-text' },
          h('strong', {}, f.title),
          h('span', {}, f.body),
          h('span', { class: 'pg-feature-cta' }, f.cta, h('span', { html: ICON.arrow }))));
      el._paint = () => { drawCover(bg.getContext('2d'), deps.paint(480, 300, { prompt: f.prompt, seed: 40 + i, style: deps.styleId('cinematic') }), 480, 300); el.classList.add('is-painted'); };
      lazy.observe(el);
      grid.append(el);
    });
    return h('section', { class: 'section', 'aria-labelledby': 'pg-tools-title' },
      h('div', { class: 'section-head' }, h('div', {}, h('span', { class: 'eyebrow' }, 'Tools'), h('h2', { id: 'pg-tools-title' }, 'One studio, four tools'))),
      grid);
  }

  // ---------------------------------------------------------------- community
  function buildCommunity() {
    const items = COMMUNITY.map(([prompt, style, preset, aspect], i) => {
      const seed = 100 + i;
      const h0 = hash(prompt);
      return {
        prompt, aspect, seed,
        style: deps.styleId(style),
        preset: preset ? deps.presetId(preset, i) : null,
        creator: CREATORS[h0 % CREATORS.length],
        likes: 120 + (h0 % 9400),
        liked: false,
      };
    });
    const feed = h('div', { class: 'pg-feed' });
    for (const it of items) feed.append(tile(it));

    function tile(it) {
      const ratio = ASPECT[it.aspect] ?? 1;
      const w = 360, hh = Math.round(w / ratio);
      const canvas = h('canvas', { width: w, height: hh, class: 'pg-feed-canvas' });
      const likeCount = h('span', {}, fmtLikes(it.likes));
      it._likeEls = [likeCount];
      const el = h('button', { type: 'button', class: 'pg-feed-item', style: { aspectRatio: `${w} / ${hh}` }, 'aria-label': `${it.preset ? 'Video' : 'Image'} by ${it.creator}: ${it.prompt}`, onclick: () => openPiece(it) },
        canvas,
        it.preset ? h('span', { class: 'pg-feed-kind' }, h('span', { html: ICON.camera }), deps.presetName(it.preset)) : null,
        h('span', { class: 'pg-feed-over' },
          h('span', { class: 'pg-feed-prompt' }, it.prompt),
          h('span', { class: 'pg-feed-by' }, h('span', { class: 'pg-avatar', style: `--h: ${hash(it.creator) % 360}` }, it.creator[1].toUpperCase()), it.creator,
            h('span', { class: 'pg-feed-likes' }, h('span', { html: ICON.heart }), likeCount))));
      el._paint = () => { it.src = deps.paint(w, hh, { prompt: it.prompt, seed: it.seed, style: it.style }); drawCover(canvas.getContext('2d'), it.src, w, hh); el.classList.add('is-painted'); };
      lazy.observe(el);
      if (it.preset) {
        pool.add(el, () => {
          if (!it.src) el._paint();
          return deps.preview(canvas, it.src, it.preset, { loopMs: 3000 });
        }, false);
        hoverable(el);
      }
      return el;
    }

    function openPiece(it) {
      const ratio = ASPECT[it.aspect] ?? 1;
      const big = ratio >= 1 ? [960, Math.round(960 / ratio)] : [Math.round(860 * ratio), 860];
      const canvas = h('canvas', { width: big[0], height: big[1], class: 'pg-piece-canvas' });
      if (it.src) drawCover(canvas.getContext('2d'), it.src, big[0], big[1]);
      let stop = null;
      const likeBtn = h('button', { type: 'button', class: 'btn pg-like', 'aria-pressed': String(it.liked) },
        h('span', { html: ICON.heart }), h('span', {}, fmtLikes(it.likes)));
      likeBtn.addEventListener('click', () => {
        it.liked = !it.liked;
        it.likes += it.liked ? 1 : -1;
        likeBtn.setAttribute('aria-pressed', String(it.liked));
        likeBtn.lastChild.textContent = fmtLikes(it.likes);
        for (const x of it._likeEls) x.textContent = fmtLikes(it.likes);
      });
      const recreate = () => {
        openModal?.close();
        if (it.preset) ctx.navigate('video', { preset: it.preset, prompt: it.prompt });
        else ctx.navigate('image', { prompt: it.prompt, style: it.style });
      };
      const copy = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Copy prompt');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(it.prompt); ctx.toast('Prompt copied', 'good'); } catch { ctx.toast('Could not copy. Select the text instead.', 'bad'); }
      });
      const tags = [
        h('span', { class: 'pg-tag' }, it.preset ? 'Video' : 'Image'),
        it.preset ? h('span', { class: 'pg-tag' }, `Preset · ${deps.presetName(it.preset)}`) : null,
        h('span', { class: 'pg-tag' }, `Style · ${deps.styleName(it.style)}`),
        h('span', { class: 'pg-tag' }, it.aspect),
      ];
      const body = h('div', { class: 'pg-piece' },
        h('div', { class: 'pg-piece-media' }, canvas),
        h('div', { class: 'pg-piece-side' },
          h('div', { class: 'pg-feed-by pg-piece-by' }, h('span', { class: 'pg-avatar', style: `--h: ${hash(it.creator) % 360}` }, it.creator[1].toUpperCase()), h('strong', {}, it.creator)),
          h('h2', { class: 'pg-piece-title' }, 'Prompt'),
          h('p', { class: 'pg-piece-prompt' }, it.prompt),
          h('div', { class: 'pg-tags' }, tags),
          h('div', { class: 'pg-piece-actions' },
            h('button', { type: 'button', class: 'btn btn-primary', onclick: recreate }, h('span', { html: ICON.sparkle }), it.preset ? 'Recreate in Video' : 'Recreate in Image'),
            likeBtn, copy)));
      openModal = modal(body, { label: `${it.preset ? 'Video' : 'Image'} by ${it.creator}`, wide: true, onClose: () => { stop?.(); stop = null; openModal = null; } });
      // Paint at full size after the dialog is on screen.
      setTimeout(() => {
        if (!openModal) return;
        const src = deps.paint(big[0], big[1], { prompt: it.prompt, seed: it.seed, style: it.style });
        if (it.preset) stop = deps.preview(canvas, src, it.preset, { loopMs: 3000 });
        else drawCover(canvas.getContext('2d'), src, big[0], big[1]);
      }, 30);
    }

    return h('section', { class: 'section', 'aria-labelledby': 'pg-community-title' },
      h('div', { class: 'section-head' },
        h('div', {}, h('span', { class: 'eyebrow' }, 'Community'), h('h2', { id: 'pg-community-title' }, 'Made with camera presets')),
        h('span', { class: 'muted pg-small' }, 'Tap any piece to see its prompt and recreate it')),
      feed);
  }

  return () => {
    paints.stop();
    pool.clear();
    for (const fn of cleanups) fn();
    openModal?.close();
  };
}

