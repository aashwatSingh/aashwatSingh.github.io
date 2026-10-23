// Video studio (#/video): source image or prompt -> camera preset -> model/duration/aspect -> real WebM.

import { h, ICON, modal, segmented, thumbOf, download, plural } from '../ui.js';
import { PRESETS, CATEGORIES, presetById } from '../presets.js';
import { sizeFor, startPreview, renderVideo, drawFrame, videoFilename } from '../render.js';

const MODELS = [
  { id: 'lite', name: 'Lite', rate: 2, short: 480, samples: 1 },
  { id: 'standard', name: 'Standard', rate: 3, short: 720, samples: 2 },
  { id: 'turbo', name: 'Turbo', rate: 5, short: 1080, samples: 4 },
];
const DURATIONS = [3, 5, 8];
const ASPECT_LIST = ['16:9', '9:16', '1:1', '4:5', '21:9'];
const PREFS_KEY = 'higgsfield-clone:video-prefs';
const DEMO_PROMPT = 'cinematic portrait at golden hour, city lights behind';
const IDEAS = [
  'rain-soaked neon street at night, reflections, cyberpunk',
  'lone surfer on a giant turquoise wave at sunset',
  'snowy mountain cabin at dawn, warm windows, pink sky',
  'astronaut standing on a purple alien desert, galaxy above',
  'editorial portrait in soft studio light, silver earrings',
  'misty pine forest with god rays at sunrise',
  'vintage red sports car on a desert highway, 1970s film',
  'koi pond with lotus flowers, top-down, morning light',
];
const MAX_UPLOAD = 30 * 1024 * 1024;

// Generations from this visit (survive route changes, not reloads).
const sessionHistory = [];

let scenePromise = null;
const loadScene = () => (scenePromise ??= import('../scene.js').catch(() => null));

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const id = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(id); reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
});

function readPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; }
}
function writePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {}
}

function hashStr(s) {
  let x = 2166136261;
  for (const ch of String(s)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619);
  return x >>> 0;
}

/** Scaled copy of an image/bitmap whose long side is at most `max`. */
function scaled(src, max) {
  const w = src.naturalWidth || src.width, hh = src.naturalHeight || src.height;
  const k = Math.min(1, max / Math.max(w, hh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(hh * k));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch {}
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}

/** Simple procedural landscape used when scene.js is unavailable. */
function fallbackScene(W, H, prompt) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const seed = hashStr(prompt || DEMO_PROMPT);
  const r = (i) => { const x = Math.sin(seed * 0.0001 + i * 91.7) * 43758.5; return x - Math.floor(x); };
  const hue = Math.floor(r(1) * 360);
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, `hsl(${hue} 55% 14%)`);
  sky.addColorStop(0.55, `hsl(${(hue + 30) % 360} 70% 45%)`);
  sky.addColorStop(1, `hsl(${(hue + 50) % 360} 85% 70%)`);
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(255,255,255,${0.2 + 0.6 * r(i + 10)})`;
    g.fillRect(r(i + 200) * W, r(i + 400) * H * 0.45, 1.5, 1.5);
  }
  const sx = W * (0.3 + 0.4 * r(2)), sy = H * 0.58, sr = Math.min(W, H) * 0.12;
  const sun = g.createRadialGradient(sx, sy, 0, sx, sy, sr * 3);
  sun.addColorStop(0, 'rgba(255,240,210,1)');
  sun.addColorStop(0.3, 'rgba(255,200,140,0.6)');
  sun.addColorStop(1, 'rgba(255,160,100,0)');
  g.fillStyle = sun;
  g.fillRect(0, 0, W, H);
  for (let layer = 0; layer < 4; layer++) {
    const base = H * (0.62 + layer * 0.1);
    g.fillStyle = `hsl(${(hue + 250) % 360} 35% ${22 - layer * 5}%)`;
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += W / 40) {
      const y = base - (Math.sin(x / W * (3 + layer) * Math.PI + r(layer + 5) * 6) * 0.5 + 0.5) * H * (0.12 - layer * 0.02);
      g.lineTo(x, y);
    }
    g.lineTo(W, H);
    g.closePath();
    g.fill();
  }
  return c;
}

async function paintPromptScene(W, H, prompt) {
  const mod = await loadScene();
  if (mod?.sceneCanvas) {
    try { return mod.sceneCanvas(W, H, { prompt: prompt || DEMO_PROMPT, seed: 1, style: 'cinematic' }); } catch (e) { console.warn('scene failed', e); }
  }
  return fallbackScene(W, H, prompt);
}

export async function mount(root, ctx) {
  const { store, toast, params } = ctx;
  const prefs = readPrefs();
  const pickPreset = (id) => presetById(id)?.id;
  const state = {
    preset: pickPreset(params.get('preset')) ?? pickPreset(prefs.preset) ?? 'dolly-in',
    model: MODELS.some((m) => m.id === prefs.model) ? prefs.model : 'standard',
    duration: DURATIONS.includes(prefs.duration) ? prefs.duration : 5,
    aspect: ASPECT_LIST.includes(prefs.aspect) ? prefs.aspect : '16:9',
    intensity: Number.isFinite(prefs.intensity) ? Math.min(1.5, Math.max(0.25, prefs.intensity)) : 1,
    prompt: params.get('prompt') ?? store.getLastPrompt('video'),
    upload: null, // { name, full, mid, small, url, from }
    scene: null, // { key, canvas, small }
    busy: false,
    abort: null,
    shown: null, // history entry in the player
    tab: 'preview',
  };
  let mounted = true;
  let stopStage = null, stopCard = null, browser = null, sceneTimer = 0;
  const urls = new Set();
  const cleanups = [];
  const savePrefs = () => writePrefs({ preset: state.preset, model: state.model, duration: state.duration, aspect: state.aspect, intensity: state.intensity });
  const model = () => MODELS.find((m) => m.id === state.model);
  const isPaid = () => store.getPlan()?.id !== 'free';
  const outShort = () => Math.min(model().short, isPaid() ? 1080 : 720);
  const cost = () => model().rate * state.duration;
  const preset = () => presetById(state.preset);
  const catName = (id) => CATEGORIES.find((c) => c.id === id)?.name ?? id;

  // ---------------------------------------------------------------- panel: source
  const fileInput = h('input', { type: 'file', accept: 'image/*', 'aria-label': 'Upload a start image' });
  const dropzone = h('div', { class: 'dropzone vid-drop' },
    fileInput,
    h('span', { class: 'vid-drop-icon', html: ICON.upload }),
    h('strong', {}, 'Drop an image or click to upload'),
    h('span', { class: 'field-hint' }, 'JPG, PNG or WebP. You can also paste one.'));
  const srcThumb = h('img', { class: 'vid-src-img', alt: '' });
  const srcName = h('span', { class: 'vid-src-name' });
  const srcDims = h('span', { class: 'vid-src-dims' });
  const srcCard = h('div', { class: 'vid-src', hidden: true },
    srcThumb,
    h('span', { class: 'vid-src-info' }, srcName, srcDims),
    h('button', { type: 'button', class: 'icon-btn vid-src-remove', 'aria-label': 'Remove image', html: ICON.trash, onclick: () => clearUpload() }));

  fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; fileInput.value = ''; if (f) useFile(f); });
  for (const ev of ['dragenter', 'dragover']) dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
  for (const ev of ['dragleave', 'drop']) dropzone.addEventListener(ev, () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/'));
    if (f) useFile(f); else toast('Drop an image file', 'bad');
  });
  const onPaste = (e) => {
    if (e.target?.closest?.('textarea, input')) return;
    const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); useFile(f, 'Pasted image'); }
  };
  document.addEventListener('paste', onPaste);
  cleanups.push(() => document.removeEventListener('paste', onPaste));

  async function useFile(file, name = file.name) {
    if (!file.type.startsWith('image/')) { toast('That file is not an image', 'bad'); return; }
    if (file.size > MAX_UPLOAD) { toast('Images up to 30 MB, please', 'bad'); return; }
    await setUploadFromBlob(file, name, 'upload');
  }

  async function setUploadFromBlob(blob, name, from) {
    let img;
    try { img = await decodeImage(blob); } catch { toast('Could not read that image', 'bad'); return false; }
    if (!mounted) return false;
    const full = scaled(img, 2400), mid = scaled(img, 1024), small = scaled(img, 400);
    img.close?.();
    if (state.upload?.url) { URL.revokeObjectURL(state.upload.url); urls.delete(state.upload.url); }
    const url = URL.createObjectURL(blob);
    urls.add(url);
    state.upload = { name, full, mid, small, url, from };
    srcThumb.src = url;
    srcName.textContent = from === 'asset' ? `From Assets · ${name}` : name;
    srcDims.textContent = `${full.width} × ${full.height}`;
    srcCard.hidden = false;
    dropzone.hidden = true;
    promptHint.textContent = 'optional';
    sourceChanged();
    return true;
  }

  function clearUpload() {
    if (state.upload?.url) { URL.revokeObjectURL(state.upload.url); urls.delete(state.upload.url); }
    state.upload = null;
    srcThumb.removeAttribute('src');
    srcCard.hidden = true;
    dropzone.hidden = false;
    promptHint.textContent = 'paints the scene';
    refreshScene(true);
  }

  // ---------------------------------------------------------------- panel: prompt
  const promptHint = h('span', { class: 'field-hint' }, 'paints the scene');
  const promptEl = h('textarea', { id: 'vid-prompt', class: 'textarea vid-prompt', rows: 3, maxlength: 600, placeholder: 'Describe the shot, e.g. neon city street at night in the rain' });
  promptEl.value = state.prompt;
  promptEl.addEventListener('input', () => {
    state.prompt = promptEl.value;
    store.setLastPrompt('video', state.prompt);
    if (!state.upload) { clearTimeout(sceneTimer); sceneTimer = setTimeout(() => refreshScene(), 450); }
  });
  const dice = h('button', { type: 'button', class: 'btn btn-ghost vid-dice', 'aria-label': 'Random prompt idea', title: 'Random idea', html: ICON.dice });
  dice.addEventListener('click', () => {
    const pool = IDEAS.filter((p) => p !== promptEl.value);
    promptEl.value = pool[Math.floor(Math.random() * pool.length)];
    promptEl.dispatchEvent(new Event('input'));
  });

  // ---------------------------------------------------------------- panel: camera preset
  const cardCanvas = h('canvas', { class: 'vid-current-canvas', width: 240, height: 150, 'aria-hidden': 'true' });
  const curCat = h('span', { class: 'vid-current-cat' });
  const curName = h('strong', { class: 'vid-current-name' });
  const curDesc = h('span', { class: 'vid-current-desc' });
  const currentBtn = h('button', { type: 'button', class: 'vid-current', 'aria-haspopup': 'dialog', onclick: () => openBrowser() },
    h('span', { class: 'vid-current-media' }, cardCanvas),
    h('span', { class: 'vid-current-info' }, curCat, curName, curDesc,
      h('span', { class: 'vid-current-change' }, 'Change preset', h('span', { html: ICON.arrow }))));
  const quick = h('div', { class: 'chips vid-quick', role: 'group', 'aria-label': 'Popular presets' });
  const quickIds = PRESETS.filter((p) => p.popular).slice(0, 8).map((p) => p.id);
  const paintQuick = () => {
    const ids = quickIds.includes(state.preset) ? quickIds : [state.preset, ...quickIds.slice(0, 7)];
    quick.replaceChildren(...ids.map((id) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(id === state.preset), onclick: () => setPreset(id) }, presetById(id).name)));
  };

  // ---------------------------------------------------------------- panel: settings
  const mixOut = h('output', { class: 'vid-mix-out', for: 'vid-mix' });
  const mix = h('input', { id: 'vid-mix', type: 'range', min: 25, max: 150, step: 5, value: Math.round(state.intensity * 100) });
  const paintMix = () => { mixOut.textContent = `${Math.round(state.intensity * 100)}%`; };
  mix.addEventListener('input', () => { state.intensity = +mix.value / 100; paintMix(); savePrefs(); restartPreviews(); });

  const modelHint = h('p', { class: 'field-hint vid-model-hint' });
  const modelSeg = segmented('Model', MODELS.map((m) => ({ value: m.id, label: m.name })), state.model, (v) => { state.model = v; savePrefs(); paintCost(); });
  const durSeg = segmented('Duration', DURATIONS.map((d) => ({ value: String(d), label: `${d}s` })), String(state.duration), (v) => { state.duration = +v; savePrefs(); paintCost(); });
  const aspSeg = segmented('Aspect ratio', ASPECT_LIST.map((a) => ({ value: a, label: a })), state.aspect, (v) => { state.aspect = v; savePrefs(); paintCost(); paintScreen(); refreshScene(); });

  const genCost = h('span', { class: 'cost' }, h('span', { html: ICON.bolt }), h('span', {}, '0'));
  const genLabel = h('span', {}, 'Generate');
  const genBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg btn-block vid-generate', onclick: () => generate() }, h('span', { html: ICON.sparkle }), genLabel, genCost);
  const balance = h('p', { class: 'vid-balance' });
  const alertBox = h('div', { class: 'vid-alert', role: 'alert', hidden: true });

  function paintCost() {
    const m = model();
    const [w, hh] = sizeFor(state.aspect, outShort());
    genCost.lastChild.textContent = String(cost());
    genBtn.setAttribute('aria-label', `Generate video for ${plural(cost(), 'credit')}`);
    const capped = !isPaid() && m.short > 720;
    modelHint.textContent = `${w}×${hh}${capped ? ' (1080p on paid plans)' : ''} · ${m.samples > 1 ? `${m.samples}× motion blur` : 'no motion blur'} · ${m.rate} credits/s`;
    balance.textContent = `${plural(cost(), 'credit')} · you have ${store.getCredits().toLocaleString()}`;
    stageInfo.textContent = `${w}×${hh} · ${state.duration}s · ${m.name}`;
  }
  cleanups.push(store.onChange(() => paintCost()));

  const field = (label, control, { hint, id, extra } = {}) => h('div', { class: 'field' },
    h(id ? 'label' : 'span', { class: id ? null : 'field-label', for: id ?? null }, h('span', {}, label), extra ?? (hint ? h('span', { class: 'field-hint' }, hint) : null)),
    control);

  const panel = h('aside', { class: 'panel vid-panel', 'aria-label': 'Video settings' },
    h('div', { class: 'vid-panel-head' }, h('h1', {}, h('span', { class: 'vid-h1-icon', html: ICON.camera }), 'Create video'), h('span', { class: 'badge' }, `${PRESETS.length} moves`)),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, h('span', {}, 'Start image'), h('span', { class: 'field-hint' }, 'optional')), dropzone, srcCard),
    h('div', { class: 'field' },
      h('label', { for: 'vid-prompt' }, h('span', {}, 'Prompt'), promptHint),
      h('div', { class: 'vid-prompt-wrap' }, promptEl, dice)),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, h('span', {}, 'Camera'), h('button', { type: 'button', class: 'vid-link', onclick: () => openBrowser() }, `Browse all ${PRESETS.length}`)), currentBtn, quick),
    field('Mix', mix, { id: 'vid-mix', extra: mixOut }),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Model'), modelSeg, modelHint),
    h('div', { class: 'vid-row' },
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Duration'), durSeg)),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Aspect ratio'), aspSeg),
    alertBox,
    h('div', { class: 'vid-gen' }, genBtn, balance));

  // ---------------------------------------------------------------- stage
  const stageInfo = h('span', { class: 'vid-stage-info' });
  const tabs = segmented('Stage view', [{ value: 'preview', label: 'Live preview' }, { value: 'result', label: 'Result' }], 'preview', (v) => showTab(v));
  tabs.classList.add('vid-tabs');
  const resultTab = tabs.querySelector('[data-value="result"]');
  resultTab.disabled = true;

  const liveCanvas = h('canvas', { class: 'vid-live', 'aria-label': 'Live camera preview' });
  const renderCanvas = h('canvas', { class: 'vid-rendering', hidden: true, 'aria-hidden': 'true' });
  const player = h('video', { class: 'vid-player', controls: true, loop: true, muted: true, playsinline: true, hidden: true, preload: 'auto' });
  player.muted = true;
  const badgeName = h('b', {});
  const badgeKind = h('span', {}, 'Live');
  const badge = h('div', { class: 'vid-badge' }, h('span', { class: 'vid-dot' }), badgeKind, badgeName);

  const steps = ['Queued', 'Rendering frames', 'Encoding'].map((s) => h('li', { 'data-state': 'todo' }, s));
  const bar = h('span', {});
  const pct = h('span', { class: 'vid-pct' }, '0%');
  const eta = h('span', { class: 'vid-eta' });
  const cancelBtn = h('button', { type: 'button', class: 'btn vid-cancel', onclick: () => state.abort?.abort() }, h('span', { html: ICON.close }), 'Cancel');
  const progressEl = h('div', { class: 'vid-progress', hidden: true, role: 'status', 'aria-live': 'polite' },
    h('ol', { class: 'vid-steps' }, steps),
    h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Render progress', 'aria-valuemin': 0, 'aria-valuemax': 100 }, bar),
    h('div', { class: 'vid-progress-row' }, h('span', {}, pct, eta), cancelBtn));
  const screen = h('div', { class: 'vid-screen' }, liveCanvas, renderCanvas, player, badge, progressEl);
  const frame = h('div', { class: 'stage-frame vid-frame' }, screen);

  const resTitle = h('p', { class: 'vid-res-title' });
  const resMeta = h('div', { class: 'vid-res-meta' });
  const dlBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => downloadShown() }, h('span', { html: ICON.download }), 'Download');
  const resultBar = h('div', { class: 'vid-result card', hidden: true },
    h('div', { class: 'vid-res-text' }, resTitle, resMeta),
    h('div', { class: 'vid-res-actions' }, dlBtn, h('a', { class: 'btn', href: '#/library' }, 'Open Assets')));

  const strip = h('div', { class: 'vid-strip', role: 'list' });
  const histEmpty = h('p', { class: 'muted vid-hist-empty' }, 'Your generations from this visit show up here. Each one is also saved to Assets.');
  const histCount = h('span', { class: 'muted vid-hist-count' });
  const history = h('section', { class: 'vid-history', 'aria-labelledby': 'vid-hist-title' },
    h('div', { class: 'vid-hist-head' }, h('h2', { id: 'vid-hist-title' }, 'This session'), histCount),
    histEmpty, strip);

  const stage = h('section', { class: 'stage vid-stage', 'aria-label': 'Preview and result' },
    h('div', { class: 'vid-stage-bar' }, tabs, stageInfo), frame, resultBar, history);

  root.append(h('div', { class: 'studio vid-studio' }, panel, stage));

  // ---------------------------------------------------------------- previews
  function previewSource(size = 'mid') {
    if (state.upload) return state.upload[size];
    if (state.scene) return size === 'small' ? state.scene.small : state.scene.canvas;
    return null;
  }

  function paintScreen() {
    const [aw, ah] = state.aspect.split(':').map(Number);
    screen.style.setProperty('--arw', aw);
    screen.style.setProperty('--arh', ah);
    const [w, hh] = sizeFor(state.aspect, 540);
    if (liveCanvas.width !== w || liveCanvas.height !== hh) { liveCanvas.width = w; liveCanvas.height = hh; }
    restartPreviews();
  }

  function restartPreviews() {
    stopStage?.();
    stopCard?.();
    stopStage = stopCard = null;
    if (!mounted) return;
    const src = previewSource('mid');
    const p = state.preset;
    stopCard = startPreview(cardCanvas, previewSource('small'), p, { intensity: state.intensity, loopMs: 2400 });
    if (state.tab === 'preview' && !state.busy) stopStage = startPreview(liveCanvas, src, p, { intensity: state.intensity, loopMs: state.duration * 1000, grain: true });
  }

  async function refreshScene(force = false) {
    if (state.upload) return;
    const prompt = state.prompt.trim() || DEMO_PROMPT;
    const key = `${prompt}|${state.aspect}`;
    if (!force && state.scene?.key === key) return;
    const [w, hh] = sizeFor(state.aspect, 540);
    const canvas = await paintPromptScene(w, hh, prompt);
    if (!mounted || state.upload) return;
    state.scene = { key, canvas, small: scaled(canvas, 400) };
    restartPreviews();
  }

  function sourceChanged() {
    if (state.tab !== 'preview') showTab('preview');
    else restartPreviews();
  }

  function paintPreset() {
    const p = preset();
    curCat.textContent = catName(p.category);
    curName.textContent = p.name;
    curDesc.textContent = p.description;
    badgeName.textContent = p.name;
    paintQuick();
  }

  function setPreset(id) {
    const p = presetById(id);
    if (!p) return;
    state.preset = p.id;
    savePrefs();
    paintPreset();
    sourceChanged();
  }

  function showTab(v) {
    state.tab = v;
    for (const b of tabs.children) b.setAttribute('aria-checked', String(b.dataset.value === v));
    tabs.value = v;
    const result = v === 'result' && state.shown;
    liveCanvas.hidden = !!result || state.busy;
    player.hidden = !result;
    badgeKind.textContent = result ? 'Result' : 'Live';
    badge.classList.toggle('is-result', !!result);
    badgeName.textContent = result ? state.shown.presetName : preset().name;
    if (result) { player.play?.().catch(() => {}); } else player.pause?.();
    restartPreviews();
  }

  // ---------------------------------------------------------------- preset browser
  function openBrowser() {
    if (browser) return;
    const src = previewSource('small');
    const reduce = reducedMotion();
    const running = new Map();
    const visible = new Set();
    const drawn = new WeakSet();
    let filter = 'all';
    let query = '';
    const MAX_LIVE = 16;

    const start = (card) => {
      if (running.has(card)) return;
      if (running.size >= MAX_LIVE) { still(card); return; }
      running.set(card, startPreview(card._canvas, src, card._id, { intensity: state.intensity, loopMs: 2400 }));
    };
    const stop = (card) => { running.get(card)?.(); running.delete(card); };
    const still = (card) => {
      if (drawn.has(card)) return;
      drawn.add(card);
      drawFrame(card._canvas.getContext('2d'), src, card._id, 0.6, { width: 256, height: 160, intensity: state.intensity, grain: false });
    };

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const card = e.target;
        if (e.isIntersecting) { visible.add(card); if (reduce) still(card); else start(card); }
        else { visible.delete(card); stop(card); }
      }
    }, { threshold: 0.15 });

    const cards = PRESETS.map((p) => {
      const canvas = h('canvas', { width: 256, height: 160, 'aria-hidden': 'true' });
      const flag = p.new ? h('span', { class: 'badge badge-accent' }, 'New') : p.popular ? h('span', { class: 'badge' }, 'Popular') : null;
      const card = h('button', { type: 'button', class: 'vid-card', role: 'listitem', 'aria-pressed': String(p.id === state.preset), title: p.description, onclick: () => { setPreset(p.id); browser?.close(); } },
        h('span', { class: 'vid-card-media' }, canvas, flag),
        h('span', { class: 'vid-card-name' }, p.name),
        h('span', { class: 'vid-card-desc' }, p.description));
      card._canvas = canvas;
      card._id = p.id;
      card._p = p;
      const hoverOn = () => { if (reduce || running.size >= MAX_LIVE) { stop(card); running.set(card, startPreview(canvas, src, p.id, { intensity: state.intensity, loopMs: 2400 })); } };
      const hoverOff = () => { if (reduce || !visible.has(card)) { stop(card); drawn.delete(card); still(card); } };
      card.addEventListener('pointerenter', hoverOn);
      card.addEventListener('focus', hoverOn);
      card.addEventListener('pointerleave', hoverOff);
      card.addEventListener('blur', hoverOff);
      return card;
    });

    const grid = h('div', { class: 'vid-grid', role: 'list', 'aria-label': 'Camera presets' }, cards);
    const empty = h('p', { class: 'muted vid-grid-empty', hidden: true }, 'No camera moves match that search.');
    const count = h('span', { class: 'muted vid-browser-count' });
    const tabDefs = [{ id: 'all', name: 'All' }, { id: 'popular', name: 'Popular' }, { id: 'new', name: 'New' }, ...CATEGORIES];
    const cats = h('div', { class: 'chips vid-cats', role: 'group', 'aria-label': 'Preset categories' },
      tabDefs.map((c) => h('button', { type: 'button', class: 'chip', 'data-cat': c.id, 'aria-pressed': String(c.id === filter), onclick: () => { filter = c.id; apply(); } }, c.name)));
    const search = h('input', { type: 'search', class: 'input vid-search-input', placeholder: 'Search camera moves', 'aria-label': 'Search camera presets' });
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); apply(); });

    function apply() {
      let n = 0;
      for (const b of cats.children) b.setAttribute('aria-pressed', String(b.dataset.cat === filter));
      for (const card of cards) {
        const p = card._p;
        const inCat = filter === 'all' || (filter === 'popular' ? p.popular : filter === 'new' ? p.new : p.category === filter);
        const hay = `${p.name} ${p.description} ${p.tags.join(' ')} ${catName(p.category)}`.toLowerCase();
        const ok = inCat && (!query || query.split(/\s+/).every((w) => hay.includes(w)));
        card.hidden = !ok;
        if (ok) n++;
      }
      empty.hidden = n > 0;
      count.textContent = plural(n, 'move');
      grid.scrollTop = 0;
    }

    const content = h('div', { class: 'vid-browser' },
      h('div', { class: 'vid-browser-head' },
        h('h2', {}, 'Camera presets'), count),
      h('div', { class: 'vid-search' }, h('span', { html: ICON.search }), search),
      cats, grid, empty);
    apply();
    browser = modal(content, {
      label: 'Camera presets',
      wide: true,
      onClose: () => {
        io.disconnect();
        for (const s of running.values()) s();
        running.clear();
        browser = null;
        currentBtn.focus?.();
      },
    });
    for (const c of cards) io.observe(c);
    const sel = cards.find((c) => c._id === state.preset);
    requestAnimationFrame(() => { sel?.scrollIntoView?.({ block: 'nearest' }); search.focus(); });
  }

  // ---------------------------------------------------------------- generation
  function setProgress(stepIdx, p) {
    steps.forEach((li, i) => li.setAttribute('data-state', i < stepIdx ? 'done' : i === stepIdx ? 'active' : 'todo'));
    const v = Math.round(Math.max(0, Math.min(1, p)) * 100);
    bar.style.width = `${v}%`;
    bar.parentElement.setAttribute('aria-valuenow', v);
    pct.textContent = `${steps[stepIdx].textContent} · ${v}%`;
  }

  function setBusy(on) {
    state.busy = on;
    genBtn.disabled = on;
    genLabel.textContent = on ? 'Generating…' : 'Generate';
    progressEl.hidden = !on;
    renderCanvas.hidden = !on;
    frame.classList.toggle('is-busy', on);
    for (const el of [modelSeg, durSeg, aspSeg]) for (const b of el.children) b.disabled = on;
    if (on) { liveCanvas.hidden = true; player.hidden = true; badgeKind.textContent = 'Rendering'; badgeName.textContent = preset().name; }
  }

  function showNoCredits() {
    alertBox.replaceChildren(
      h('span', {}, `This shot needs ${plural(cost(), 'credit')} and you have ${store.getCredits()}.`),
      h('a', { href: '#/pricing', class: 'btn btn-primary' }, 'Get credits'));
    alertBox.hidden = false;
  }

  async function renderSource(W, H) {
    if (state.upload) return state.upload.full;
    return paintPromptScene(W, H, state.prompt.trim() || DEMO_PROMPT);
  }

  async function generate() {
    if (state.busy) return;
    const m = model();
    const price = cost();
    const p = preset();
    const [W, H] = sizeFor(state.aspect, outShort());
    if (!store.spendCredits(price)) {
      showNoCredits();
      toast('Not enough credits for this shot', 'bad');
      return;
    }
    alertBox.hidden = true;
    let refunded = false;
    const refund = () => { if (!refunded) { refunded = true; store.addCredits(price); } };
    const ac = new AbortController();
    state.abort = ac;
    stopStage?.();
    stopStage = null;
    renderCanvas.width = W;
    renderCanvas.height = H;
    const prompt = state.prompt.trim();
    const g = renderCanvas.getContext('2d');
    drawFrame(g, previewSource('mid'), p.id, 0, { width: W, height: H, intensity: state.intensity });
    setBusy(true);
    if (state.tab !== 'preview') { state.tab = 'preview'; for (const b of tabs.children) b.setAttribute('aria-checked', String(b.dataset.value === 'preview')); }
    if (innerWidth <= 900) frame.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    setProgress(0, 0);
    eta.textContent = '';
    const started = performance.now();
    try {
      const [source] = await Promise.all([renderSource(W, H), sleep(650 + Math.random() * 500, ac.signal)]);
      if (ac.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      setProgress(1, 0);
      const frames = state.duration * 30;
      const res = await renderVideo({
        source, presetId: p.id, duration: state.duration, fps: 30, width: W, height: H, intensity: state.intensity,
        watermark: !isPaid(), samples: m.samples, seed: (Date.now() % 100000) + 1, canvas: renderCanvas, signal: ac.signal,
        onProgress: (v) => {
          if (v < 0.92) { setProgress(1, v / 0.92); eta.textContent = ` · frame ${Math.min(frames, Math.round((v / 0.92) * frames))}/${frames}`; }
          else { setProgress(2, (v - 0.92) / 0.08); eta.textContent = ''; }
        },
      });
      if (!res.blob) {
        refund();
        toast('This browser cannot record video, so no credits were used', 'bad');
        return;
      }
      const entry = {
        blob: res.blob, mime: res.mime, url: null, thumb: thumbOf(res.poster), prompt: prompt || `${p.name} shot`,
        preset: p.id, presetName: p.name, model: m.name, duration: state.duration, aspect: state.aspect,
        width: res.width, height: res.height, ms: Math.round(performance.now() - started), assetId: null,
      };
      try {
        entry.assetId = await store.saveAsset({
          type: 'video', prompt: entry.prompt, blob: res.blob, thumb: entry.thumb,
          meta: { presetName: p.name, preset: p.id, model: m.name, duration: state.duration, aspect: state.aspect, resolution: `${res.width}×${res.height}`, intensity: `${Math.round(state.intensity * 100)}%` },
        });
      } catch (e) { console.warn('save failed', e); }
      sessionHistory.unshift(entry);
      if (!mounted) return;
      paintHistory();
      setBusy(false);
      showEntry(entry);
      toast(entry.assetId ? 'Video ready and saved to Assets' : 'Video ready', 'good');
    } catch (e) {
      refund();
      if (e?.name === 'AbortError') toast('Generation cancelled. Credits refunded.');
      else { console.error(e); toast('Rendering failed. Credits refunded.', 'bad'); }
    } finally {
      state.abort = null;
      if (mounted && state.busy) { setBusy(false); showTab(state.tab); }
    }
  }

  function urlFor(entry) {
    if (!entry.url) { entry.url = URL.createObjectURL(entry.blob); urls.add(entry.url); }
    return entry.url;
  }

  function showEntry(entry) {
    state.shown = entry;
    resultTab.disabled = false;
    player.src = urlFor(entry);
    player.poster = entry.thumb;
    resTitle.textContent = entry.prompt;
    resMeta.replaceChildren(...[entry.presetName, entry.model, `${entry.duration}s`, entry.aspect, `${entry.width}×${entry.height}`]
      .map((t) => h('span', { class: 'vid-chip' }, t)));
    resultBar.hidden = false;
    for (const b of strip.children) b.setAttribute('aria-pressed', String(b._entry === entry));
    showTab('result');
  }

  function downloadShown() {
    const e = state.shown;
    if (e?.blob) download(e.blob, videoFilename(e.prompt, e.preset, e.mime));
  }

  function paintHistory() {
    histEmpty.hidden = sessionHistory.length > 0;
    histCount.textContent = sessionHistory.length ? plural(sessionHistory.length, 'clip') : '';
    strip.replaceChildren(...sessionHistory.map((e) => {
      const b = h('button', { type: 'button', class: 'vid-hist-item', role: 'listitem', 'aria-pressed': String(state.shown === e), 'aria-label': `Play ${e.presetName}: ${e.prompt}`, onclick: () => showEntry(e) },
        h('img', { src: e.thumb, alt: '' }),
        h('span', { class: 'vid-hist-play', html: ICON.play }),
        h('span', { class: 'vid-hist-meta' }, h('b', {}, e.presetName), h('span', {}, `${e.duration}s · ${e.aspect}`)));
      b._entry = e;
      return b;
    }));
  }

  // ---------------------------------------------------------------- start up
  paintMix();
  paintPreset();
  paintCost();
  paintHistory();
  paintScreen();

  const assetId = params.get('asset');
  if (assetId) {
    try {
      const rec = await store.getAsset(assetId);
      const blob = rec?.type === 'image' ? rec.blob : null;
      let ok = false;
      if (blob) ok = await setUploadFromBlob(blob, rec.prompt || 'Library image', 'asset');
      else if (rec?.thumb) ok = await setUploadFromBlob(await (await fetch(rec.thumb)).blob(), rec.prompt || 'Library asset', 'asset');
      if (!ok && mounted) toast('That asset could not be loaded', 'bad');
      if (ok && rec.prompt && !promptEl.value.trim()) { promptEl.value = rec.prompt; state.prompt = rec.prompt; }
    } catch (e) { console.warn(e); if (mounted) toast('That asset could not be loaded', 'bad'); }
  }
  if (!state.upload) refreshScene(true);

  return function unmount() {
    mounted = false;
    clearTimeout(sceneTimer);
    state.abort?.abort();
    stopStage?.();
    stopCard?.();
    browser?.close();
    for (const fn of cleanups) { try { fn(); } catch {} }
    player.pause();
    player.removeAttribute('src');
    player.load();
    for (const u of urls) URL.revokeObjectURL(u);
    urls.clear();
    for (const e of sessionHistory) e.url = null;
  };
}
