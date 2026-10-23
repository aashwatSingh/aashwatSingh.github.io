// Turns a camera preset into pixels: one frame (drawFrame), a looping preview (startPreview) or a
// real video file (renderVideo, via canvas.captureStream + MediaRecorder). Nothing here touches the
// DOM at import time, so the pure helpers (cameraMatrix, sizeFor, shakeNoise, fixWebmDuration...)
// are tested under node --test.

import { cameraAt } from './presets.js';

export const ASPECTS = { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5], '21:9': [21, 9] };

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Pixel size for an aspect at a given short side, both sides even (encoders like that). */
export function sizeFor(aspect, shortSide = 720) {
  const [aw, ah] = ASPECTS[aspect] ?? ASPECTS['16:9'];
  const s = Math.max(2, +shortSide || 720);
  return aw >= ah ? [even((s * aw) / ah), even(s)] : [even(s), even((s * ah) / aw)];
}

// ---------------------------------------------------------------- pure camera geometry

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const fract = (x) => x - Math.floor(x);
/** Deterministic 0..1 hash of up to three numbers. */
export const rnd = (a, b = 0, c = 0) => fract(Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453);

/** Linear part of the camera (roll + fake perspective), without zoom. [[a, c], [b, d]] as {a,b,c,d}. */
function lensMatrix(cam) {
  const cr = Math.cos(cam.rotate), sr = Math.sin(cam.rotate);
  // Fake perspective: yaw squeezes x and skews y, pitch squeezes y and skews x.
  const t00 = Math.sqrt(Math.cos(cam.tiltY)), t11 = Math.sqrt(Math.cos(cam.tiltX));
  const t01 = 0.18 * Math.sin(cam.tiltX), t10 = 0.22 * Math.sin(cam.tiltY);
  return { a: cr * t00 - sr * t10, c: cr * t01 - sr * t11, b: sr * t00 + cr * t10, d: sr * t01 + cr * t11 };
}

/**
 * The canvas transform that draws a source of sw×sh pixels into a W×H frame for `cam`.
 * The source is cover-fitted, then the zoom is raised (never lowered) until every frame corner,
 * pushed out by `margin` px, lands inside the source: the frame can never show empty edges.
 * Returns { a, b, c, d, e, f } for ctx.setTransform plus the zoom actually used.
 */
export function cameraMatrix(cam, W, H, sw, sh, margin = 0) {
  const s = Math.max(W / sw, H / sh);
  const hw = (s * sw) / 2, hh = (s * sh) / 2; // half extents of the cover-fitted source, frame px
  const cx = clamp(cam.x * W, -0.35 * 2 * hw, 0.35 * 2 * hw);
  const cy = clamp(cam.y * H, -0.35 * 2 * hh, 0.35 * 2 * hh);
  const A = lensMatrix(cam);
  const det = A.a * A.d - A.b * A.c || 1e-9;
  let z = Math.max(1, cam.zoom || 1);
  const qx = W / 2 + margin, qy = H / 2 + margin;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const X = sx * qx, Y = sy * qy;
    const ux = (A.d * X - A.c * Y) / det, uy = (-A.b * X + A.a * Y) / det;
    // need -hw <= ux/z + cx <= hw (same for y)
    if (ux > 0) z = Math.max(z, ux / (hw - cx)); else if (ux < 0) z = Math.max(z, -ux / (hw + cx));
    if (uy > 0) z = Math.max(z, uy / (hh - cy)); else if (uy < 0) z = Math.max(z, -uy / (hh + cy));
  }
  const L = { a: A.a * z * s, b: A.b * z * s, c: A.c * z * s, d: A.d * z * s };
  const px = (s * sw) / 2 + cx, py = (s * sh) / 2 + cy; // camera target in scaled-source px
  return {
    a: L.a, b: L.b, c: L.c, d: L.d,
    e: W / 2 - (A.a * z * px + A.c * z * py),
    f: H / 2 - (A.b * z * px + A.d * z * py),
    zoom: z,
  };
}

/** Smooth, deterministic handheld noise in -1..1 for seed and time in seconds. */
export function shakeNoise(seed, sec) {
  const ch = (k) => {
    let v = 0;
    const F = [0.9, 2.3, 5.1], A = [0.55, 0.3, 0.15];
    for (let i = 0; i < 3; i++) {
      const f = F[i] * (0.85 + 0.3 * rnd(seed, k, i + 7));
      v += A[i] * Math.sin(TAU * (f * sec + rnd(seed, k, i)));
    }
    return v;
  };
  return { x: ch(1), y: ch(2), r: ch(3) };
}

/** cameraAt plus deterministic handheld shake added into x / y / roll. */
export function shotAt(presetId, t, { intensity = 1, seed = 1, duration = 4 } = {}) {
  const cam = cameraAt(presetId, t, { intensity });
  if (cam.shake > 0) {
    const n = shakeNoise(seed, t * duration);
    cam.x += cam.shake * 0.014 * n.x;
    cam.y += cam.shake * 0.014 * n.y;
    cam.rotate += cam.shake * 0.012 * n.r;
  }
  return cam;
}

/** First MediaRecorder type the browser supports ('' lets the browser choose). */
export function pickMime(isSupported) {
  const list = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];
  for (const m of list) { try { if (isSupported(m)) return m; } catch {} }
  return '';
}

/** Download name like "neon-city-at-night-dolly-in.webm". */
export function videoFilename(prompt, presetId, mime = 'video/webm') {
  const slug = (s, n) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, n).replace(/-+$/, '');
  const ext = /mp4/.test(mime) ? 'mp4' : 'webm';
  return `${[slug(prompt, 40) || 'higgsfield-video', slug(presetId, 30)].filter(Boolean).join('-')}.${ext}`;
}

// ---------------------------------------------------------------- WebM duration fix
// MediaRecorder writes WebM without a Duration, so players can't show length or seek.
// Insert one into Segment > Info. Returns the input unchanged when the layout is unfamiliar.

function readId(u8, p) {
  const b = u8[p];
  if (b === undefined) return null;
  let len = 1, mask = 0x80;
  while (len <= 4 && !(b & mask)) { len++; mask >>= 1; }
  if (len > 4 || p + len > u8.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + u8[p + i];
  return { id, len };
}

function readSize(u8, p) {
  const b = u8[p];
  if (b === undefined) return null;
  let len = 1, mask = 0x80;
  while (len <= 8 && !(b & mask)) { len++; mask >>= 1; }
  if (len > 8 || p + len > u8.length) return null;
  let value = b & (mask - 1);
  let unknown = value === mask - 1;
  for (let i = 1; i < len; i++) { value = value * 256 + u8[p + i]; if (u8[p + i] !== 0xff) unknown = false; }
  return { value, len, unknown };
}

const size8 = (n) => { const out = new Uint8Array(8); out[0] = 0x01; for (let i = 7, v = n; i >= 1; i--, v = Math.floor(v / 256)) out[i] = v % 256; return out; };

function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function fixWebmDuration(buffer, durationMs) {
  const u8 = new Uint8Array(buffer);
  const ebml = readId(u8, 0);
  if (!ebml || ebml.id !== 0x1a45dfa3 || !(durationMs > 0)) return buffer;
  const es = readSize(u8, ebml.len);
  if (!es) return buffer;
  const segPos = ebml.len + es.len + es.value;
  const seg = readId(u8, segPos);
  if (!seg || seg.id !== 0x18538067) return buffer;
  const ss = readSize(u8, segPos + seg.len);
  if (!ss) return buffer;
  const segStart = segPos + seg.len + ss.len;
  const segEnd = ss.unknown ? u8.length : Math.min(u8.length, segStart + ss.value);
  for (let p = segStart; p < segEnd;) {
    const id = readId(u8, p);
    const sz = id && readSize(u8, p + id.len);
    if (!sz) return buffer;
    // Inserting bytes would break SeekHead/Cues offsets; Clusters mean Info never came.
    if (id.id === 0x114d9b74 || id.id === 0x1f43b675 || id.id === 0x1c53bb6b) return buffer;
    if (id.id === 0x1549a966) {
      if (sz.unknown) return buffer;
      const start = p + id.len + sz.len, end = start + sz.value;
      let scale = 1e6;
      for (let q = start; q < end;) {
        const e = readId(u8, q);
        const n = e && readSize(u8, q + e.len);
        if (!n) return buffer;
        const d = q + e.len + n.len;
        if (e.id === 0x4489) return buffer; // already has a Duration
        if (e.id === 0x2ad7b1) { scale = 0; for (let i = 0; i < n.value; i++) scale = scale * 256 + u8[d + i]; }
        q = d + n.value;
      }
      const dur = new Uint8Array(11);
      dur.set([0x44, 0x89, 0x88]);
      new DataView(dur.buffer).setFloat64(3, (durationMs * 1e6) / (scale || 1e6));
      const infoHead = concat([u8.subarray(p, p + id.len), size8(sz.value + 11)]);
      const grow = infoHead.length + 11 - (id.len + sz.len);
      const segHead = ss.unknown ? u8.subarray(segPos, segStart) : concat([u8.subarray(segPos, segPos + seg.len), size8(ss.value + grow)]);
      return concat([u8.subarray(0, segPos), segHead, u8.subarray(segStart, p), infoHead, u8.subarray(start, end), dur, u8.subarray(end)]).buffer;
    }
    p += id.len + sz.len + sz.value;
  }
  return buffer;
}

// ---------------------------------------------------------------- canvas plumbing

const scratchMap = new WeakMap();
function makeCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}
/** A reusable offscreen canvas owned by `ctx`. */
function scratch(ctx, name, w, h) {
  let m = scratchMap.get(ctx);
  if (!m) scratchMap.set(ctx, (m = new Map()));
  let c = m.get(name);
  if (!c) m.set(name, (c = makeCanvas(w, h)));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}
const ctxOf = (c) => c.getContext('2d');
const reset = (g) => { g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; if (FILTER) g.filter = 'none'; };

let FILTER;
function filterSupported() {
  if (FILTER === undefined) FILTER = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;
  return FILTER;
}

function sourceSize(src) {
  const w = src?.naturalWidth || src?.videoWidth || src?.width || 0;
  const h = src?.naturalHeight || src?.videoHeight || src?.height || 0;
  return [w, h];
}

/** Copy the frame into a scratch canvas so effects can read it while drawing over it. */
function snapshot(ctx, W, H, name = 'copy') {
  const c = scratch(ctx, name, W, H);
  const g = ctxOf(c);
  reset(g);
  g.drawImage(ctx.canvas, 0, 0, W, H, 0, 0, W, H);
  return c;
}

/** Draw the source through `cam`, with optional focus/motion blur. */
function drawLayer(ctx, src, sw, sh, cam, W, H, alpha, px) {
  const blur = cam.blur * px;
  const m = cameraMatrix(cam, W, H, sw, sh, blur > 0.3 ? blur * 2.5 + 2 : 2);
  ctx.globalAlpha = alpha;
  if (blur > 0.3 && !filterSupported()) {
    // No ctx.filter (older Safari): blur by rendering small and scaling back up.
    const k = Math.min(10, 1 + blur / 2);
    const lo = scratch(ctx, 'lowres', Math.ceil(W / k), Math.ceil(H / k));
    const g = ctxOf(lo);
    g.setTransform(m.a / k, m.b / k, m.c / k, m.d / k, m.e / k, m.f / k);
    g.drawImage(src, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(lo, 0, 0, lo.width, lo.height, 0, 0, W, H);
  } else {
    if (blur > 0.3) ctx.filter = `blur(${blur.toFixed(2)}px)`;
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(src, 0, 0);
    if (blur > 0.3) ctx.filter = 'none';
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- effects

/** Same image again through a second camera, kept only inside a soft ellipse around the subject. */
function subjectLayer(ctx, src, sw, sh, cam, W, H, px, core = 0.5, size = 0.42) {
  const c = scratch(ctx, 'subject', W, H);
  const g = ctxOf(c);
  reset(g);
  g.clearRect(0, 0, W, H);
  drawLayer(g, src, sw, sh, cam, W, H, 1, px);
  g.globalCompositeOperation = 'destination-in';
  const rx = Math.min(W, H * 0.9) * size, ry = H * (size + 0.05);
  g.setTransform(rx, 0, 0, ry, W / 2, H * 0.47);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
  grad.addColorStop(0, '#000');
  grad.addColorStop(core, '#000');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(-20, -20, 40, 40);
  reset(g);
  ctx.drawImage(c, 0, 0);
}

/** Subject camera for the depth effects. Vertigo holds the subject at the shot's largest zoom so the
 * background's own copy of the subject always stays smaller and hidden underneath it. */
function subjectCam(fx, a, cam, cam0, cam1) {
  if (fx === 'vertigo') return { ...cam, zoom: Math.exp(lerp(Math.log(cam.zoom), Math.log(Math.max(cam0.zoom, cam1.zoom)), a)), blur: 0 };
  // snorricam / head tracking: the rig moves with the subject, so it stays put while the world swings.
  return { ...cam, x: lerp(cam.x, cam0.x, a), y: lerp(cam.y, cam0.y, a), rotate: lerp(cam.rotate, 0, a), tiltY: lerp(cam.tiltY, 0, a) };
}

function radialBlur(ctx, W, H, a) {
  if (a < 0.02) return;
  const c = snapshot(ctx, W, H);
  for (let i = 1; i <= 5; i++) {
    const s = 1 + a * 0.032 * i;
    ctx.globalAlpha = 0.55 / (i + 0.5);
    ctx.drawImage(c, (W - W * s) / 2, (H - H * s) / 2, W * s, H * s);
  }
  ctx.globalAlpha = 1;
}

function glitch(ctx, W, H, a, t, seed, duration) {
  if (a < 0.04) return;
  const q = Math.floor(t * duration * 14);
  const c = snapshot(ctx, W, H);
  // RGB split: keep green/blue in place, add a displaced red channel.
  const red = scratch(ctx, 'red', W, H);
  const g = ctxOf(red);
  reset(g);
  g.drawImage(c, 0, 0);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = '#f00';
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';
  const dx = Math.round((3 + 22 * a) * (W / 1280) * (rnd(q, seed) > 0.5 ? 1 : -1)) || 1;
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = '#0ff';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(red, dx, 0);
  if (dx > 0) ctx.drawImage(red, 0, 0, dx, H, 0, 0, dx, H);
  else ctx.drawImage(red, W + dx, 0, -dx, H, W + dx, 0, -dx, H);
  ctx.globalCompositeOperation = 'source-over';
  // Slice tears.
  const n = 1 + Math.floor(a * 9);
  for (let i = 0; i < n; i++) {
    const y = Math.floor(rnd(q, i, seed) * H);
    const h = Math.max(2, Math.floor((0.01 + 0.07 * rnd(i, q, 3)) * H));
    const off = Math.round((rnd(i, seed, q) - 0.5) * a * W * 0.16);
    ctx.drawImage(c, 0, y, W, h, off, y, W, h);
    if (off > 0) ctx.drawImage(c, W - off, y, off, h, 0, y, off, h);
    else if (off < 0) ctx.drawImage(c, 0, y, -off, h, W + off, y, -off, h);
  }
  // A blocky colour fault now and then, plus scanlines.
  if (a > 0.5 && rnd(q, 9) > 0.5) {
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = rnd(q, 2) > 0.5 ? 'rgba(0,255,200,0.5)' : 'rgba(255,0,180,0.5)';
    ctx.fillRect(rnd(q, 4) * W * 0.8, rnd(q, 5) * H * 0.9, W * (0.05 + 0.2 * rnd(q, 6)), H * 0.04);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.fillStyle = `rgba(0,0,0,${0.18 * a})`;
  const step = Math.max(3, Math.round(H / 180));
  for (let y = 0; y < H; y += step) ctx.fillRect(0, y, W, 1);
}

function disintegrate(ctx, W, H, a, seed) {
  if (a <= 0) return;
  const c = snapshot(ctx, W, H);
  const back = scratch(ctx, 'ash', W, H);
  const g = ctxOf(back);
  reset(g);
  g.fillStyle = '#060608';
  g.fillRect(0, 0, W, H);
  g.globalAlpha = 0.28;
  if (filterSupported()) g.filter = `blur(${Math.round(W / 90)}px) grayscale(0.6)`;
  g.drawImage(c, 0, 0);
  reset(g);
  const cols = clamp(Math.round(W / 14), 24, 96), rows = Math.max(8, Math.round((cols * H) / W));
  const cw = W / cols, ch = H / rows;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const r = rnd(i, j, seed);
      const d = 0.06 + 0.74 * ((i / cols) * 0.7 + (1 - j / rows) * 0.1 + r * 0.2);
      const p = (a * 1.18 - d) / 0.32;
      if (p <= 0) continue;
      const x = Math.floor(i * cw), y = Math.floor(j * ch), w = Math.ceil(cw) + 1, h = Math.ceil(ch) + 1;
      ctx.drawImage(back, x, y, w, h, x, y, w, h);
      if (p >= 1) continue;
      const e = p ** 1.4;
      const dx = x + e * W * (0.18 + 0.3 * rnd(j, i, 2)) + Math.sin(p * 6 + r * 9) * cw;
      const dy = y - e * H * (0.06 + 0.3 * rnd(i, j, 5));
      const sz = Math.max(1, 1 - 0.75 * p);
      ctx.globalAlpha = 1 - p;
      ctx.drawImage(c, x, y, cw, ch, dx, dy, cw * sz, ch * sz);
      if (p < 0.18) {
        ctx.fillStyle = 'rgba(255,196,140,0.8)';
        ctx.fillRect(x + cw * rnd(i, j, 7), y + ch * rnd(i, j, 8), Math.max(1, cw * 0.18), Math.max(1, cw * 0.18));
      }
      ctx.globalAlpha = 1;
    }
  }
}

function explode(ctx, W, H, a, seed) {
  if (a <= 0) return;
  const c = snapshot(ctx, W, H);
  const R = Math.hypot(W, H);
  const e = 1 - (1 - a) ** 3;
  ctx.fillStyle = '#050304';
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.35 * (1 - a);
  ctx.drawImage(c, 0, 0);
  ctx.globalAlpha = 1;
  const fire = Math.max(0, 1 - a * 0.8);
  const gr = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, R * (0.15 + 0.6 * e));
  gr.addColorStop(0, `rgba(255,244,214,${fire})`);
  gr.addColorStop(0.22, `rgba(255,170,50,${fire})`);
  gr.addColorStop(0.55, `rgba(210,50,12,${0.75 * fire})`);
  gr.addColorStop(1, 'rgba(30,4,0,0)');
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, W, H);
  // Shards: each grid cell split into two triangles that fly outward and spin.
  const cols = 9, rows = Math.max(4, Math.round((cols * H) / W));
  const cw = W / cols, ch = H / rows;
  const fade = 1 - smooth(clamp((a - 0.62) / 0.38, 0, 1));
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      for (let k = 0; k < 2; k++) {
        const r1 = rnd(i, j, k + seed), r2 = rnd(j, i, k + 3), r3 = rnd(i + k, j, 9);
        const x = i * cw, y = j * ch;
        const mx = x + cw * (k ? 0.66 : 0.33), my = y + ch * (k ? 0.66 : 0.33);
        const dx = (mx - W / 2) / (W / 2) + (r1 - 0.5) * 0.7, dy = (my - H / 2) / (H / 2) + (r2 - 0.5) * 0.7;
        const sp = 0.5 + r3;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(mx + dx * e * W * 0.6 * sp, my + dy * e * H * 0.6 * sp + a * a * H * 0.25);
        ctx.rotate((r1 - 0.5) * 5 * e);
        ctx.scale(1 - 0.3 * e, 1 - 0.3 * e);
        ctx.translate(-mx, -my);
        ctx.beginPath();
        if (k) { ctx.moveTo(x + cw, y); ctx.lineTo(x + cw, y + ch); ctx.lineTo(x, y + ch); } else { ctx.moveTo(x, y); ctx.lineTo(x + cw, y); ctx.lineTo(x, y + ch); }
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(c, x - 1, y - 1, cw + 2, ch + 2, x - 1, y - 1, cw + 2, ch + 2);
        ctx.restore();
      }
    }
  }
  // Embers.
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 70; i++) {
    const ang = rnd(i, seed) * TAU, sp = 0.2 + 0.8 * rnd(i, 4);
    const d = e * R * 0.55 * sp;
    ctx.globalAlpha = (1 - a) * (0.5 + 0.5 * rnd(i, 5));
    ctx.fillStyle = rnd(i, 6) > 0.5 ? '#ffb347' : '#ff6a2a';
    const s = Math.max(1.5, (W / 640) * (1 + 2 * rnd(i, 7)));
    ctx.fillRect(W / 2 + Math.cos(ang) * d, H / 2 + Math.sin(ang) * d + a * a * H * 0.2, s, s);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  const flash = Math.max(0, 1 - a * 7);
  if (flash > 0) { ctx.fillStyle = `rgba(255,248,230,${flash})`; ctx.fillRect(0, 0, W, H); }
}

const TIMELAPSE = [[0, [255, 255, 255, 0]], [0.3, [255, 150, 60, 0.32]], [0.55, [220, 70, 140, 0.34]], [0.78, [30, 40, 120, 0.55]], [1, [20, 30, 90, 0.6]]];
function timelapse(ctx, W, H, a, t, duration) {
  let i = 1;
  while (i < TIMELAPSE.length - 1 && a > TIMELAPSE[i][0]) i++;
  const [t0, c0] = TIMELAPSE[i - 1], [t1, c1] = TIMELAPSE[i];
  const k = smooth(clamp((a - t0) / (t1 - t0), 0, 1));
  const c = c0.map((v, j) => lerp(v, c1[j], k));
  ctx.globalCompositeOperation = 'soft-light';
  ctx.fillStyle = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.min(1, c[3] * 1.6)})`;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${c[3] * 0.5})`;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';
  // Shutter flicker of a real timelapse.
  ctx.fillStyle = `rgba(255,255,255,${0.035 * rnd(Math.floor(t * duration * 10))})`;
  ctx.fillRect(0, 0, W, H);
}

function lightLeak(ctx, W, H, a, t) {
  if (a < 0.02) return;
  ctx.globalCompositeOperation = 'screen';
  const leak = (x, y, r, rgb, al) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${al})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  const R = Math.max(W, H);
  leak(W * (-0.1 + 0.5 * t), H * 0.18, R * 0.6, '255,120,40', 0.6 * a);
  leak(W * (1.05 - 0.35 * t), H * 0.9, R * 0.5, '255,50,110', 0.4 * a);
  ctx.globalCompositeOperation = 'source-over';
}

// ---------------------------------------------------------------- grade

let grainTile = null;
const grainPatterns = new WeakMap();
const vignettes = new WeakMap();

function grain(ctx, W, H, t, seed) {
  if (!grainTile) {
    grainTile = makeCanvas(160, 160);
    const g = ctxOf(grainTile);
    const img = g.createImageData(160, 160);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 128 + (rnd(i, 3.1) - 0.5) * 200;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  let pat = grainPatterns.get(ctx);
  if (!pat) grainPatterns.set(ctx, (pat = ctx.createPattern(grainTile, 'repeat')));
  const q = Math.floor(t * 997);
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = pat;
  ctx.translate(-Math.floor(rnd(q, seed) * 160), -Math.floor(rnd(seed, q) * 160));
  ctx.fillRect(0, 0, W + 160, H + 160);
  reset(ctx);
}

function vignette(ctx, W, H) {
  let v = vignettes.get(ctx);
  if (!v || v.width !== W || v.height !== H) {
    v = makeCanvas(W, H);
    const g = ctxOf(v);
    const r = Math.hypot(W, H) / 2;
    const gr = g.createRadialGradient(W / 2, H / 2, r * 0.45, W / 2, H / 2, r);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, 'rgba(0,0,0,0.5)');
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
    vignettes.set(ctx, v);
  }
  ctx.drawImage(v, 0, 0);
}

function watermarkMark(ctx, W, H) {
  const fs = Math.max(10, Math.round(Math.min(W, H) * 0.028));
  const pad = Math.round(fs * 0.9);
  ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  const text = 'higgsfield clone';
  const tw = ctx.measureText(text).width;
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = fs * 0.4;
  ctx.globalAlpha = 0.78;
  ctx.fillStyle = '#d4ff3f';
  const s = fs * 0.95;
  ctx.fillRect(W - pad - tw - s - fs * 0.4, H - pad - s * 0.88, s, s);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, W - pad, H - pad);
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- public API

/**
 * Draw one frame of `presetId` at t (0..1) into ctx2d.
 * Extra options: duration (s, sets handheld-noise speed), samples (motion-blur sub-frames),
 * shutter (t-span the samples cover), grain / vignette (default on), hq (high smoothing).
 */
export function drawFrame(ctx, source, presetId, t, opts = {}) {
  const { width, height, intensity = 1, seed = 1, watermark = false, duration = 4, samples = 1,
    shutter = 1 / 120, grain: useGrain = true, vignette: useVignette = true, hq = false } = opts;
  const W = Math.round(width || ctx.canvas.width), H = Math.round(height || ctx.canvas.height);
  filterSupported();
  ctx.save();
  reset(ctx);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = hq ? 'high' : 'medium';
  ctx.fillStyle = '#0b0b0d';
  ctx.fillRect(0, 0, W, H);
  const [sw, sh] = sourceSize(source);
  if (!sw || !sh) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#1e1e21');
    g.addColorStop(1, '#0b0b0d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    return;
  }
  const tt = clamp(Number.isFinite(t) ? t : 0, 0, 1);
  const shot = { intensity, seed, duration };
  const px = Math.max(W, H) / 1280; // blur values are authored at 1280 px
  const cam = shotAt(presetId, tt, shot);
  const fx = cam.fx;
  const a = cam.fxAmount;
  const focus = fx === 'rackfocus' ? 7 : 0;

  // Base layer; on higher models accumulate sub-frames across the shutter for real motion blur.
  const n = Math.max(1, Math.min(8, samples | 0));
  if (n === 1) drawLayer(ctx, source, sw, sh, { ...cam, blur: cam.blur + focus * a }, W, H, 1, px);
  else {
    for (let k = 0; k < n; k++) {
      const ck = shotAt(presetId, clamp(tt + shutter * ((k + 0.5) / n - 0.5), 0, 1), shot);
      drawLayer(ctx, source, sw, sh, { ...ck, blur: ck.blur + focus * a }, W, H, 1 / (k + 1), px);
    }
  }

  if (fx === 'rackfocus') subjectLayer(ctx, source, sw, sh, { ...cam, blur: cam.blur + focus * (1 - a) }, W, H, px);
  else if ((fx === 'vertigo' || fx === 'snorricam') && a > 0) {
    const sub = subjectCam(fx, a, cam, shotAt(presetId, 0, shot), shotAt(presetId, 1, shot));
    if (fx === 'vertigo') subjectLayer(ctx, source, sw, sh, sub, W, H, px, 0.55, 0.42);
    else subjectLayer(ctx, source, sw, sh, sub, W, H, px, 0.68, 0.5);
  }
  if (fx === 'vertigo') radialBlur(ctx, W, H, 0.35 * Math.abs(Math.sin(Math.PI * tt)));
  else if (fx === 'radial') radialBlur(ctx, W, H, a);
  else if (fx === 'glitch') glitch(ctx, W, H, a, tt, seed, duration);
  else if (fx === 'disintegrate') disintegrate(ctx, W, H, a, seed);
  else if (fx === 'explode') explode(ctx, W, H, a, seed);
  else if (fx === 'timelapse') timelapse(ctx, W, H, a, tt, duration);
  else if (fx === 'lightleak') lightLeak(ctx, W, H, a, tt);
  reset(ctx);

  if (useVignette) vignette(ctx, W, H);
  if (useGrain) grain(ctx, W, H, tt, seed);
  if (fx === 'flash' && a > 0.01) { ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.fillRect(0, 0, W, H); }
  if (watermark) watermarkMark(ctx, W, H);
  ctx.restore();
}

/** Loop the preset into `canvas` until the returned stop() is called. */
export function startPreview(canvas, source, presetId, { loopMs = 2600, intensity = 1, holdMs = 450, ...rest } = {}) {
  const ctx = canvas.getContext('2d');
  let raf = 0, stopped = false;
  const t0 = performance.now();
  const opts = { intensity, duration: loopMs / 1000, grain: false, ...rest };
  const paint = (now) => {
    const t = Math.min(1, ((now - t0) % (loopMs + holdMs)) / loopMs);
    drawFrame(ctx, source, presetId, t, { ...opts, width: canvas.width, height: canvas.height });
  };
  const loop = (now) => {
    if (stopped) return;
    try { paint(now); } catch (e) { stopped = true; console.warn('preview stopped', e); return; }
    raf = requestAnimationFrame(loop);
  };
  paint(t0);
  raf = requestAnimationFrame(loop);
  return () => { stopped = true; cancelAnimationFrame(raf); };
}

const abortError = () => (typeof DOMException !== 'undefined' ? new DOMException('Render cancelled', 'AbortError') : Object.assign(new Error('Render cancelled'), { name: 'AbortError' }));

/**
 * Render a real video in real time. Optional extras: samples (motion blur), seed, and `canvas`
 * to render into a visible canvas so the user watches frames being made.
 */
export async function renderVideo({ source, presetId, duration = 5, fps = 30, width = 1280, height = 720, intensity = 1,
  watermark = false, onProgress, signal, samples = 1, seed = 1, canvas } = {}) {
  if (signal?.aborted) throw abortError();
  const cv = canvas ?? makeCanvas(width, height);
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d', { alpha: false }) ?? cv.getContext('2d');
  const opts = { width, height, intensity, seed, watermark, duration, samples, shutter: 1 / (duration * fps), hq: true };
  const poster = makeCanvas(width, height);
  drawFrame(ctxOf(poster), source, presetId, 0.4, opts);
  const progress = (p) => { try { onProgress?.(p); } catch {} };

  const canRecord = typeof MediaRecorder !== 'undefined' && typeof cv.captureStream === 'function';
  if (!canRecord) {
    drawFrame(ctx, source, presetId, 0.4, opts);
    progress(1);
    return { blob: null, mime: null, poster, width, height };
  }

  const mime = pickMime((m) => MediaRecorder.isTypeSupported(m));
  const stream = cv.captureStream(fps);
  const bits = Math.round(clamp(width * height * fps * 0.11, 1.5e6, 12e6));
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: bits } : { videoBitsPerSecond: bits });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve, reject) => {
    rec.onstop = resolve;
    rec.onerror = (e) => reject(e.error ?? new Error('Recording failed'));
  });
  const cleanup = () => { for (const tr of stream.getTracks()) tr.stop(); };
  let raf = 0, timer = 0, onAbort = null;

  try {
    drawFrame(ctx, source, presetId, 0, opts);
    rec.start(1000);
    const durMs = duration * 1000;
    await new Promise((resolve, reject) => {
      let t0 = null;
      onAbort = () => { cancelAnimationFrame(raf); clearTimeout(timer); reject(abortError()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      // rAF while visible; the timeout keeps a hidden tab moving (slowly) instead of stalling.
      const schedule = () => { raf = requestAnimationFrame(run); timer = setTimeout(run, 100); };
      const run = () => {
        cancelAnimationFrame(raf);
        clearTimeout(timer);
        if (signal?.aborted) return;
        const now = performance.now();
        if (t0 === null) t0 = now;
        const t = Math.min(1, (now - t0) / durMs);
        try { drawFrame(ctx, source, presetId, t, opts); } catch (e) { reject(e); return; }
        progress(t * 0.92);
        if (t >= 1) resolve(); else schedule();
      };
      schedule();
    });
    signal?.removeEventListener('abort', onAbort);
    await new Promise((r) => setTimeout(r, 1000 / fps * 3)); // let the last frame reach the encoder
    if (signal?.aborted) throw abortError();
    progress(0.94);
    rec.stop();
    await stopped;
    cleanup();
    if (!chunks.length) throw new Error('The browser recorded no video data');
    const type = (mime || rec.mimeType || 'video/webm').split(';')[0];
    let blob = new Blob(chunks, { type });
    if (type === 'video/webm') {
      try { blob = new Blob([fixWebmDuration(await blob.arrayBuffer(), durMs)], { type }); } catch {}
    }
    progress(1);
    return { blob, mime: type, poster, width, height };
  } catch (e) {
    signal?.removeEventListener('abort', onAbort);
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    try { if (rec.state !== 'inactive') rec.stop(); } catch {}
    cleanup();
    throw e;
  }
}
