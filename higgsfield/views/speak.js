// Speak: talking avatars synced to a script. Procedural canvas avatars (or an uploaded face photo
// with a positioned mouth region), live preview with speechSynthesis + word-boundary resync,
// and a silent WebM export (optionally with burned-in captions) via canvas.captureStream + MediaRecorder.

import { h, ICON, segmented, thumbOf, download } from '../ui.js';
import {
  VISEME_SHAPES, EMOTION_LIST, emotionOf, buildTrack, visemeAt, mixShapes, wordIndexAt, wordIndexAtChar,
  creditsFor, formatSeconds, captionPages, pageAt, blinkAt, gazeAt, headPose, rand,
} from '../speak-logic.js';

const MAX_CHARS = 1200;
const DEFAULT_SCRIPT = "Hi, I'm your Higgsfield avatar. Type any script, pick a voice, and I'll say it with lip sync timed to every word. Let's make something great!";
const REST = VISEME_SHAPES.rest;
const ASPECTS = { '1:1': [1, 1], '9:16': [9, 16], '16:9': [16, 9] };
const sizeFor = (aspect, short) => {
  const [a, b] = ASPECTS[aspect] ?? ASPECTS['1:1'];
  return a >= b ? [Math.round((short * a) / b / 2) * 2, short] : [short, Math.round((short * b) / a / 2) * 2];
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- avatars

const AVATARS = [
  { id: 'maya', name: 'Maya', skin: '#c98d68', shade: '#9c6345', lip: '#a65450', brow: '#2b1b14', eye: '#4a2f1f',
    hair: '#24160f', hairHi: '#6b4430', hairStyle: 'long', outfit: '#c2643e', outfit2: '#a24f2e', neck: 'turtleneck', bg: ['#f1dccb', '#b98f78'] },
  { id: 'kofi', name: 'Kofi', skin: '#7b4b30', shade: '#55301c', lip: '#6a3428', brow: '#120c09', eye: '#26170e',
    hair: '#141010', hairHi: '#3b302a', hairStyle: 'fade', beard: 'full', outfit: '#22304d', outfit2: '#f1eee8', neck: 'blazer', bg: ['#cfd8e3', '#6f8299'] },
  { id: 'lena', name: 'Lena', skin: '#f0cdb5', shade: '#cf9c80', lip: '#c4676a', brow: '#9a7348', eye: '#557fa6',
    hair: '#c9a466', hairHi: '#f1dca8', hairStyle: 'bob', outfit: '#8ea386', outfit2: '#71866b', neck: 'crew', bg: ['#e9efe4', '#9fb09a'] },
  { id: 'hiro', name: 'Hiro', skin: '#e3b590', shade: '#bf8b66', lip: '#b06a5c', brow: '#17141a', eye: '#2a1c14',
    hair: '#16151a', hairHi: '#45434f', hairStyle: 'textured', glasses: true, outfit: '#3b3e46', outfit2: '#2b2d33', neck: 'hoodie', bg: ['#e2e0ee', '#8c88a8'] },
  { id: 'amara', name: 'Amara', skin: '#5b3524', shade: '#3c2116', lip: '#5a2a20', brow: '#140c09', eye: '#22140c',
    hair: '#17100d', hairHi: '#4a3226', hairStyle: 'afro', earrings: 'hoops', outfit: '#dfa23a', outfit2: '#b8801f', neck: 'scoop', bg: ['#f4e3c4', '#c08d5a'] },
  { id: 'sol', name: 'Sol', skin: '#b98662', shade: '#8f6043', lip: '#94564a', brow: '#2c1d13', eye: '#3d2a1a',
    hair: '#3e2818', hairHi: '#7a5638', hairStyle: 'bun', beard: 'stubble', outfit: '#4f6e93', outfit2: '#3c5778', neck: 'collar', bg: ['#dce6ec', '#7d98aa'] },
];
const avatarById = (id) => AVATARS.find((a) => a.id === id) ?? AVATARS[0];

const BACKGROUNDS = [
  { id: 'studio', name: 'Studio', swatch: 'linear-gradient(135deg,#e9dfd6,#9d8a7c)' },
  { id: 'office', name: 'Office', swatch: 'linear-gradient(135deg,#efece6,#9c9488)' },
  { id: 'sunset', name: 'Sunset', swatch: 'linear-gradient(180deg,#3a1d4a,#e2686b 65%,#f7b267)' },
  { id: 'neon', name: 'Neon', swatch: 'linear-gradient(135deg,#ff2d95,#120f2a 55%,#18e0ff)' },
  { id: 'lime', name: 'Lime', swatch: 'radial-gradient(circle at 50% 35%,#d4ff3f,#0d0f08 70%)' },
  { id: 'green', name: 'Green screen', swatch: '#00b140' },
];

// ---------------------------------------------------------------- colour helpers

function rgbOf(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
const rgba = (hex, a) => { const [r, g, b] = rgbOf(hex); return `rgba(${r},${g},${b},${a})`; };
function tone(hex, amt) {
  const f = (c) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  const [r, g, b] = rgbOf(hex);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
const makeCanvas = (w, hgt) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(hgt)); return c; };
function radial(ctx, x, y, r, color, a) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, a));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

// ---------------------------------------------------------------- backgrounds (cached per size)

const bgCache = new Map();
function bgCanvas(id, W, H, av) {
  const key = `${id}|${W}x${H}|${id === 'studio' ? av.id : ''}`;
  let c = bgCache.get(key);
  if (c) return c;
  if (bgCache.size > 24) bgCache.clear();
  c = makeCanvas(W, H);
  paintBackground(c.getContext('2d'), W, H, id, av);
  bgCache.set(key, c);
  return c;
}

function paintBackground(ctx, W, H, id, av) {
  const S = Math.min(W, H);
  const D = Math.hypot(W, H);
  if (id === 'green') { ctx.fillStyle = '#00b140'; ctx.fillRect(0, 0, W, H); return; }
  if (id === 'studio') {
    const g = ctx.createRadialGradient(W / 2, H * 0.36, S * 0.05, W / 2, H * 0.45, D * 0.62);
    g.addColorStop(0, av.bg[0]);
    g.addColorStop(1, av.bg[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    radial(ctx, W / 2, H * 0.34, S * 0.42, '#ffffff', 0.28);
  } else if (id === 'sunset') {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#22163a');
    g.addColorStop(0.45, '#6e2f5e');
    g.addColorStop(0.78, '#e0676a');
    g.addColorStop(1, '#f6b067');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    radial(ctx, W * 0.74, H * 0.7, S * 0.36, '#ffd59a', 0.85);
    for (let i = 0; i < 18; i++) radial(ctx, rand(i, 4) * W, H * (0.35 + rand(i, 5) * 0.6), S * (0.03 + rand(i, 6) * 0.06), '#ffe0b0', 0.12 + rand(i, 7) * 0.18);
  } else if (id === 'office') {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#e2ddd4');
    g.addColorStop(1, '#9a9184');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const t = makeCanvas(W, H);
    const x = t.getContext('2d');
    x.fillStyle = '#f7f6f1';
    x.fillRect(W * 0.05, H * 0.06, W * 0.36, H * 0.58);
    x.fillStyle = 'rgba(120,130,140,0.25)';
    x.fillRect(W * 0.225, H * 0.06, S * 0.012, H * 0.58);
    x.fillRect(W * 0.05, H * 0.34, W * 0.36, S * 0.012);
    x.fillStyle = 'rgba(80,60,40,0.35)';
    x.fillRect(W * 0.62, H * 0.3, W * 0.36, S * 0.014);
    x.fillRect(W * 0.62, H * 0.52, W * 0.36, S * 0.014);
    for (let i = 0; i < 7; i++) {
      x.fillStyle = ['#7c5c48', '#b39a72', '#5d6b78', '#a65d4a'][i % 4];
      x.fillRect(W * (0.64 + i * 0.04), H * 0.3 - S * (0.06 + rand(i, 9) * 0.05), S * 0.03, S * (0.06 + rand(i, 9) * 0.05));
    }
    for (let i = 0; i < 9; i++) {
      x.fillStyle = i % 2 ? '#3f5f3c' : '#2f4a2f';
      x.beginPath();
      x.ellipse(W * (0.86 + (rand(i, 11) - 0.5) * 0.16), H * (0.62 + (rand(i, 12) - 0.5) * 0.22), S * 0.07, S * 0.035, rand(i, 13) * 3, 0, TAU);
      x.fill();
    }
    ctx.save();
    ctx.filter = `blur(${Math.round(S * 0.014)}px)`;
    ctx.drawImage(t, 0, 0);
    ctx.restore();
    radial(ctx, W * 0.24, H * 0.32, S * 0.6, '#ffffff', 0.35);
  } else if (id === 'neon') {
    ctx.fillStyle = '#0c0a1c';
    ctx.fillRect(0, 0, W, H);
    radial(ctx, W * 0.15, H * 0.22, S * 0.75, '#ff2d95', 0.5);
    radial(ctx, W * 0.88, H * 0.75, S * 0.75, '#18e0ff', 0.4);
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < 5; i++) {
      const x = W * (0.08 + i * 0.21);
      const g = ctx.createLinearGradient(x - S * 0.02, 0, x + S * 0.02, 0);
      const c = i % 2 ? '#18e0ff' : '#ff4fb0';
      g.addColorStop(0, rgba(c, 0));
      g.addColorStop(0.5, rgba(c, 0.55));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - S * 0.02, H * (0.1 + rand(i, 3) * 0.2), S * 0.04, H * 0.5);
    }
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = '#0d0f08';
    ctx.fillRect(0, 0, W, H);
    radial(ctx, W / 2, H * 0.32, S * 0.75, '#d4ff3f', 0.42);
    ctx.strokeStyle = 'rgba(212,255,63,0.05)';
    ctx.lineWidth = S * 0.006;
    for (let x = -H; x < W; x += S * 0.05) { ctx.beginPath(); ctx.moveTo(x, H); ctx.lineTo(x + H, 0); ctx.stroke(); }
  }
  const v = ctx.createRadialGradient(W / 2, H / 2, S * 0.35, W / 2, H / 2, D * 0.62);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.32)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

// ---------------------------------------------------------------- avatar drawing (unit coords)
// The head is drawn in "units": head half-width 16, half-height 20.5, origin at head centre.

const HW = 16;
const HH = 20.5;
const MOUTH_Y = 12.2;
const EYE_X = 6.2;
const EYE_Y = 0.6;

function facePath(ctx, jaw = 0) {
  const b = HH + jaw;
  ctx.beginPath();
  ctx.moveTo(0, -HH);
  ctx.bezierCurveTo(HW * 0.6, -HH, HW, -HH * 0.62, HW, -HH * 0.12);
  ctx.bezierCurveTo(HW, HH * 0.32, HW * 0.86, b * 0.62, HW * 0.5, b * 0.88);
  ctx.bezierCurveTo(HW * 0.28, b * 1.0, -HW * 0.28, b * 1.0, -HW * 0.5, b * 0.88);
  ctx.bezierCurveTo(-HW * 0.86, b * 0.62, -HW, HH * 0.32, -HW, -HH * 0.12);
  ctx.bezierCurveTo(-HW, -HH * 0.62, -HW * 0.6, -HH, 0, -HH);
  ctx.closePath();
}

function hairFill(ctx, av, y0 = -HH - 5, y1 = 22) {
  const g = ctx.createLinearGradient(-8, y0, 6, y1);
  g.addColorStop(0, av.hairHi);
  g.addColorStop(0.35, av.hair);
  g.addColorStop(1, av.hair);
  return g;
}

function strands(ctx, av, n, fn, alpha = 0.22) {
  ctx.strokeStyle = rgba(av.hairHi, alpha);
  ctx.lineWidth = 0.3;
  for (let i = 0; i < n; i++) { ctx.beginPath(); fn(i, n); ctx.stroke(); }
}

function drawHairBack(ctx, av) {
  const s = av.hairStyle;
  ctx.fillStyle = hairFill(ctx, av);
  if (s === 'long') {
    ctx.beginPath();
    ctx.moveTo(0, -HH - 3.4);
    ctx.bezierCurveTo(13, -HH - 3.6, HW + 5, -12, HW + 4.6, 4);
    ctx.bezierCurveTo(HW + 4.4, 16, HW + 7, 28, HW + 5, 38);
    ctx.lineTo(-HW - 5, 38);
    ctx.bezierCurveTo(-HW - 7, 28, -HW - 4.4, 16, -HW - 4.6, 4);
    ctx.bezierCurveTo(-HW - 5, -12, -13, -HH - 3.6, 0, -HH - 3.4);
    ctx.fill();
    ctx.save();
    ctx.clip();
    radial(ctx, 0, 10, 24, '#000000', 0.35);
    ctx.restore();
  } else if (s === 'bob') {
    ctx.beginPath();
    ctx.moveTo(0, -HH - 3.4);
    ctx.bezierCurveTo(12, -HH - 3.4, HW + 4.4, -10, HW + 4, 6);
    ctx.bezierCurveTo(HW + 3.8, 12, HW + 3.4, 15.5, HW + 1.5, 16.8);
    ctx.lineTo(-HW - 1.5, 16.8);
    ctx.bezierCurveTo(-HW - 3.4, 15.5, -HW - 3.8, 12, -HW - 4, 6);
    ctx.bezierCurveTo(-HW - 4.4, -10, -12, -HH - 3.4, 0, -HH - 3.4);
    ctx.fill();
    ctx.save();
    ctx.clip();
    radial(ctx, 0, 8, 20, '#000000', 0.3);
    ctx.restore();
  } else if (s === 'afro') {
    const cy = -7;
    const rx = HW + 8.5;
    const ry = HH + 4.5;
    ctx.beginPath();
    ctx.ellipse(0, cy, rx - 2, ry - 2, 0, 0, TAU);
    ctx.fill();
    for (let i = 0; i < 26; i++) {
      const a = Math.PI * 0.82 + (i / 25) * Math.PI * 1.36;
      const r = 4.6 + rand(i, 21) * 1.6;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * (rx - 2.5), cy + Math.sin(a) * (ry - 2.5), r, 0, TAU);
      ctx.fill();
    }
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    radial(ctx, -9, -24, 18, av.hairHi, 0.45);
    ctx.restore();
    ctx.fillStyle = rgba(av.hairHi, 0.18);
    for (let i = 0; i < 90; i++) {
      const a = rand(i, 31) * TAU;
      const r = Math.sqrt(rand(i, 32));
      ctx.beginPath();
      ctx.arc(Math.cos(a) * rx * 0.95 * r, cy + Math.sin(a) * ry * 0.95 * r, 0.7 + rand(i, 33), 0, TAU);
      ctx.fill();
    }
  } else if (s === 'bun') {
    ctx.beginPath();
    ctx.arc(0, -HH - 4.8, 5.4, 0, TAU);
    ctx.fill();
    strands(ctx, av, 6, (i) => { ctx.arc(0, -HH - 4.8, 1.5 + i * 0.6, Math.PI * (1.1 + i * 0.1), Math.PI * (1.9 + i * 0.1)); });
    ctx.fillStyle = hairFill(ctx, av);
    ctx.beginPath();
    ctx.ellipse(0, -HH - 0.6, 3.4, 1.2, 0, 0, TAU);
    ctx.fill();
  }
}

function drawHairFront(ctx, av) {
  const s = av.hairStyle;
  ctx.save();
  ctx.fillStyle = hairFill(ctx, av);
  ctx.beginPath();
  if (s === 'long') {
    ctx.moveTo(-HW + 1.4, 13);
    ctx.bezierCurveTo(-HW + 0.2, 4, -HW + 0.6, -7, -6.5, -14.8);
    ctx.bezierCurveTo(-1, -14, 6, -12.6, 10.6, -8);
    ctx.bezierCurveTo(13.4, -4.4, 14.4, 4, 14.8, 15);
    ctx.quadraticCurveTo(HW + 1.2, 19.5, HW + 3.2, 21.5);
    ctx.bezierCurveTo(HW + 4.8, 8, HW + 3.4, -14.5, 4, -HH - 3.4);
    ctx.bezierCurveTo(-8, -HH - 3.8, -HW - 3.8, -12, -HW - 3.2, 6);
    ctx.quadraticCurveTo(-HW - 2.6, 16.5, -HW + 1.4, 13);
    ctx.closePath();
    ctx.fill();
    ctx.clip();
    strands(ctx, av, 9, (i, n) => {
      const x = -12 + (i / n) * 26;
      ctx.moveTo(x - 4, -HH - 3);
      ctx.bezierCurveTo(x + 2, -HH + 2, x + 6, -12, x + 8 + (i % 3), 2 + i);
    });
  } else if (s === 'bob') {
    ctx.moveTo(-HW - 3.4, 15.6);
    ctx.bezierCurveTo(-HW - 4.6, 2, -HW - 3.8, -HH - 2, 0, -HH - 3.4);
    ctx.bezierCurveTo(HW + 3.8, -HH - 2, HW + 4.6, 2, HW + 3.4, 15.6);
    ctx.lineTo(HW + 0.2, 16.4);
    ctx.bezierCurveTo(HW - 0.5, 8, HW - 0.7, -3.5, HW - 1.8, -7.6);
    ctx.bezierCurveTo(HW - 5, -6.4, -HW + 5, -6.4, -HW + 1.8, -7.6);
    ctx.bezierCurveTo(-HW + 0.7, -3.5, -HW + 0.5, 8, -HW - 0.2, 16.4);
    ctx.closePath();
    ctx.fill();
    ctx.clip();
    strands(ctx, av, 12, (i, n) => {
      const x = -HW - 2 + (i / (n - 1)) * (HW * 2 + 4);
      ctx.moveTo(x * 0.3, -HH - 3);
      ctx.quadraticCurveTo(x * 0.9, -HH, x, x > -HW + 2 && x < HW - 2 ? -7.4 : 16);
    }, 0.28);
  } else if (s === 'fade') {
    ctx.moveTo(-HW + 0.2, -4);
    ctx.bezierCurveTo(-HW - 0.5, -14, -9, -HH - 1.7, 0, -HH - 1.8);
    ctx.bezierCurveTo(9, -HH - 1.7, HW + 0.5, -14, HW - 0.2, -4);
    ctx.bezierCurveTo(HW - 1.2, -8, HW - 3, -12.8, 8, -13.6);
    ctx.bezierCurveTo(4, -14.4, -4, -14.4, -8, -13.6);
    ctx.bezierCurveTo(-HW + 3, -12.8, -HW + 1.2, -8, -HW + 0.2, -4);
    ctx.closePath();
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = rgba(av.hairHi, 0.35);
    for (let i = 0; i < 140; i++) {
      ctx.beginPath();
      ctx.arc((rand(i, 41) - 0.5) * HW * 2, -HH - 2 + rand(i, 42) * 9, 0.35, 0, TAU);
      ctx.fill();
    }
  } else if (s === 'textured') {
    ctx.moveTo(-HW + 0.3, -3);
    ctx.bezierCurveTo(-HW - 1.2, -10, -HW - 1, -15, -13.5, -18.5);
    const top = [[-11, -HH - 3.2], [-7.5, -HH - 4.6], [-3.6, -HH - 5.4], [0.4, -HH - 5.6], [4.4, -HH - 5.2], [8.2, -HH - 4.2], [11.6, -HH - 2.4], [13.8, -18.2]];
    let qx = -13.5;
    let qy = -18.5;
    for (const [x, y] of top) {
      ctx.quadraticCurveTo((x + qx) / 2, Math.min(y, qy) - 1.3, x, y);
      qx = x; qy = y;
    }
    ctx.bezierCurveTo(HW + 1, -15, HW + 1.2, -10, HW - 0.3, -3);
    const pts = [[HW - 1.4, -8.2], [11.4, -11.6], [9.4, -9.4], [6.8, -12.6], [4.2, -10], [1.5, -13], [-1.2, -10.4], [-4.2, -13.2], [-6.8, -10.6], [-9.8, -12.8], [-12.2, -9.6], [-HW + 1.4, -8.2]];
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      const [px, py] = i ? pts[i - 1] : [HW - 0.3, -3];
      ctx.quadraticCurveTo((x + px) / 2, Math.max(y, py) + 0.6, x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.clip();
    strands(ctx, av, 14, (i) => {
      const x = -13 + i * 2;
      ctx.moveTo(x, -HH - 4);
      ctx.quadraticCurveTo(x + 2.5, -HH + 1, x + 1 + (i % 2) * 2, -11);
    }, 0.3);
  } else if (s === 'afro') {
    ctx.moveTo(-HW + 0.2, -3);
    ctx.bezierCurveTo(-HW - 1.2, -15, -9, -HH - 2.4, 0, -HH - 2.4);
    ctx.bezierCurveTo(9, -HH - 2.4, HW + 1.2, -15, HW - 0.2, -3);
    const n = 9;
    let px = HW - 0.2;
    let py = -3;
    for (let i = 0; i <= n; i++) {
      const a = i / n;
      const x = (HW - 1.2) * Math.cos(Math.PI * a);
      const y = -10.5 - Math.sin(Math.PI * a) * 3.2;
      ctx.quadraticCurveTo((x + px) / 2, Math.max(y, py) + 1.4, x, y);
      px = x; py = y;
    }
    ctx.quadraticCurveTo(-HW + 0.4, -7, -HW + 0.2, -3);
    ctx.closePath();
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = rgba(av.hairHi, 0.25);
    for (let i = 0; i < 60; i++) {
      ctx.beginPath();
      ctx.arc((rand(i, 51) - 0.5) * HW * 2.1, -HH - 2 + rand(i, 52) * 10, 0.6 + rand(i, 53) * 0.5, 0, TAU);
      ctx.fill();
    }
  } else if (s === 'bun') {
    ctx.moveTo(-HW + 0.3, -2);
    ctx.bezierCurveTo(-HW - 1, -14, -10, -HH - 2.4, 0, -HH - 2.4);
    ctx.bezierCurveTo(10, -HH - 2.4, HW + 1, -14, HW - 0.3, -2);
    ctx.bezierCurveTo(HW - 1.5, -9, HW - 4, -12.6, 6, -13.4);
    ctx.quadraticCurveTo(2, -13.2, 0, -14.6);
    ctx.quadraticCurveTo(-2, -13.2, -6, -13.4);
    ctx.bezierCurveTo(-HW + 4, -12.6, -HW + 1.5, -9, -HW + 0.3, -2);
    ctx.closePath();
    ctx.fill();
    ctx.clip();
    strands(ctx, av, 11, (i, n) => {
      const x = -HW + 1 + (i / (n - 1)) * (HW * 2 - 2);
      ctx.moveTo(x, -10 - Math.abs(x) * 0.1 + (Math.abs(x) > 12 ? 6 : 0));
      ctx.quadraticCurveTo(x * 0.8, -HH, x * 0.12, -HH - 2.4);
    }, 0.3);
  }
  ctx.restore();
}

function drawBeard(ctx, av, jaw, shape, kind) {
  ctx.save();
  facePath(ctx, jaw);
  ctx.clip();
  const col = av.hair;
  const mY = MOUTH_Y + shape.open * 1.6;
  ctx.beginPath();
  ctx.moveTo(-HW - 2, 1);
  ctx.bezierCurveTo(-HW + 2, 7.4, -7.5, 9.4, 0, 9.6);
  ctx.bezierCurveTo(7.5, 9.4, HW - 2, 7.4, HW + 2, 1);
  ctx.lineTo(HW + 2, HH + 6);
  ctx.lineTo(-HW - 2, HH + 6);
  ctx.closePath();
  ctx.ellipse(0, mY + 0.4, 5.9 + shape.wide * 0.6, 2.7 + shape.open * 2.2, 0, 0, TAU);
  if (kind === 'stubble') {
    const sg = ctx.createLinearGradient(0, 3, 0, 12);
    sg.addColorStop(0, rgba(col, 0));
    sg.addColorStop(1, rgba(col, 0.2));
    ctx.fillStyle = sg;
  } else ctx.fillStyle = rgba(col, 0.9);
  ctx.fill('evenodd');
  if (kind === 'stubble') { ctx.restore(); return; }
  ctx.fillStyle = rgba(av.hairHi, 0.3);
  for (let i = 0; i < 160; i++) {
    const x = (rand(i, 61) - 0.5) * HW * 2;
    const y = 8 + rand(i, 62) * 14;
    if (Math.abs(x) < 6 && Math.abs(y - mY) < 2.6 + shape.open * 2) continue;
    ctx.fillRect(x, y, 0.28, 0.28);
  }
  ctx.restore();
}

function drawMustache(ctx, av, kind) {
  const y = MOUTH_Y;
  ctx.beginPath();
  ctx.moveTo(-5.6, y + 0.4);
  ctx.quadraticCurveTo(-4.4, y - 2.7, 0, y - 2.5);
  ctx.quadraticCurveTo(4.4, y - 2.7, 5.6, y + 0.4);
  ctx.quadraticCurveTo(3, y - 1.1, 0, y - 1.3);
  ctx.quadraticCurveTo(-3, y - 1.1, -5.6, y + 0.4);
  ctx.fillStyle = kind === 'stubble' ? rgba(av.hair, 0.28) : rgba(av.hair, 0.95);
  ctx.fill();
}

function drawMouth(ctx, av, shape, smile) {
  const y0 = MOUTH_Y;
  const open = clamp(shape.open, 0, 1.2);
  const press = clamp(shape.press, 0, 1);
  const mw = 4.8 * (1 + 0.16 * shape.wide - 0.3 * shape.round + 0.07 * smile);
  const cyc = y0 - smile * 1.0;
  const gap = 4.4 * open;
  const iTop = y0 - gap * 0.25;
  const iBot = y0 + gap * 0.75;
  const upT = 1.15 * (1 + 0.35 * shape.round) * (1 - 0.3 * press);
  const loT = 1.5 * (1 + 0.3 * shape.round) * (1 - 0.25 * press);
  const k = 0.5 + 0.3 * shape.round;
  const cY = (target) => (8 * target - 2 * cyc) / 6;
  const ut = iTop - upT;
  const lb = iBot + loT;

  // shadow under the lower lip
  radial(ctx, 0, lb + 1.1, 3.6, av.shade, 0.35);

  // inner mouth
  if (gap > 0.05) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-mw, cyc);
    ctx.bezierCurveTo(-mw * k, cY(iTop), mw * k, cY(iTop), mw, cyc);
    ctx.bezierCurveTo(mw * k, cY(iBot), -mw * k, cY(iBot), -mw, cyc);
    ctx.closePath();
    ctx.fillStyle = '#2a0c0f';
    ctx.fill();
    ctx.clip();
    radial(ctx, 0, iBot, mw * 1.1, '#5a1c22', 0.7);
    // tongue
    const ty = iBot - 0.2 - shape.tongue * gap * 0.38;
    ctx.fillStyle = '#b6525b';
    ctx.beginPath();
    ctx.ellipse(0, ty + 0.9, mw * 0.58, 1.1 + gap * 0.22, 0, 0, TAU);
    ctx.fill();
    // teeth
    const th = (0.5 + Math.min(1.2, gap * 0.42)) * clamp(shape.teeth + 0.2, 0, 1);
    ctx.fillStyle = '#f2ede4';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-mw * 0.74, iTop - 1.2, mw * 1.48, th + 1.2, [0, 0, 0.8, 0.8]);
    else ctx.rect(-mw * 0.74, iTop - 1.2, mw * 1.48, th + 1.2);
    ctx.fill();
    ctx.fillStyle = 'rgba(120,90,80,0.22)';
    ctx.fillRect(-0.06, iTop - 1, 0.12, th + 1);
    if (open > 0.45) {
      ctx.fillStyle = 'rgba(236,230,220,0.75)';
      ctx.fillRect(-mw * 0.55, iBot - 0.8 * open, mw * 1.1, 0.9 * open);
    }
    ctx.restore();
  }

  // upper lip
  ctx.beginPath();
  ctx.moveTo(-mw, cyc);
  ctx.bezierCurveTo(-mw * k, cY(iTop), mw * k, cY(iTop), mw, cyc);
  ctx.bezierCurveTo(mw * 0.75, cyc - upT * 0.5, 2.6, ut - 0.1, 1.25, ut - 0.05);
  ctx.quadraticCurveTo(0.6, ut - 0.1, 0, ut + 0.35);
  ctx.quadraticCurveTo(-0.6, ut - 0.1, -1.25, ut - 0.05);
  ctx.bezierCurveTo(-2.6, ut - 0.1, -mw * 0.75, cyc - upT * 0.5, -mw, cyc);
  ctx.fillStyle = tone(av.lip, -0.14);
  ctx.fill();

  // lower lip
  ctx.beginPath();
  ctx.moveTo(-mw, cyc);
  ctx.bezierCurveTo(-mw * k, cY(iBot), mw * k, cY(iBot), mw, cyc);
  ctx.bezierCurveTo(mw * 0.6, cY(lb), -mw * 0.6, cY(lb), -mw, cyc);
  ctx.fillStyle = av.lip;
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.beginPath();
  ctx.ellipse(0.5, iBot + loT * 0.42, 1.7, 0.34, 0, 0, TAU);
  ctx.fill();

  // F/V: upper teeth resting on the lower lip
  if (shape.bite > 0.05) {
    ctx.fillStyle = `rgba(242,237,228,${clamp(shape.bite, 0, 1)})`;
    ctx.fillRect(-mw * 0.5, iBot - 0.25, mw, 0.75 * shape.bite);
  }
  // lip line when (nearly) closed
  if (gap < 0.5) {
    ctx.strokeStyle = `rgba(40,10,12,${0.55 * (1 - gap / 0.5) + 0.1 * press})`;
    ctx.lineWidth = 0.3 + press * 0.15;
    ctx.beginPath();
    ctx.moveTo(-mw, cyc);
    ctx.bezierCurveTo(-mw * k, cY(iTop), mw * k, cY(iTop), mw, cyc);
    ctx.stroke();
  }
  // smile creases
  if (smile > 0.2) {
    ctx.strokeStyle = rgba(av.shade, 0.35 * smile);
    ctx.lineWidth = 0.3;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * (mw + 0.3), cyc - 0.9);
      ctx.quadraticCurveTo(s * (mw + 0.9), cyc, s * (mw + 0.3), cyc + 0.9);
      ctx.stroke();
    }
  }
}

function drawEye(ctx, av, side, open, gaze) {
  const x = side * EYE_X;
  const y = EYE_Y;
  const ew = 3.1;
  const eh = 1.7 * open;
  radial(ctx, x, y - 1.4, 5, av.shade, 0.22);
  ctx.strokeStyle = rgba(av.shade, 0.55);
  ctx.lineWidth = 0.3;
  ctx.beginPath();
  ctx.moveTo(x - ew * 0.9, y - 1.6 - eh * 0.4);
  ctx.quadraticCurveTo(x, y - 2.9 - eh * 0.5, x + ew * 0.95, y - 1.4 - eh * 0.4);
  ctx.stroke();
  if (eh < 0.3) {
    ctx.strokeStyle = '#1d1210';
    ctx.lineWidth = 0.45;
    ctx.beginPath();
    ctx.moveTo(x - ew, y);
    ctx.quadraticCurveTo(x, y + 0.9, x + ew, y);
    ctx.stroke();
    return;
  }
  const almond = () => {
    ctx.beginPath();
    ctx.moveTo(x - ew, y);
    ctx.bezierCurveTo(x - ew * 0.5, y - eh * 1.35, x + ew * 0.5, y - eh * 1.35, x + ew, y - eh * 0.08);
    ctx.bezierCurveTo(x + ew * 0.5, y + eh * 1.05, x - ew * 0.5, y + eh * 1.05, x - ew, y);
    ctx.closePath();
  };
  ctx.save();
  almond();
  ctx.fillStyle = '#f5f0ea';
  ctx.fill();
  ctx.clip();
  const ix = x + gaze.x * 1.0;
  const iy = y + gaze.y * 0.5 + 0.1;
  const g = ctx.createRadialGradient(ix, iy, 0.2, ix, iy, 1.6);
  g.addColorStop(0, tone(av.eye, 0.35));
  g.addColorStop(0.7, av.eye);
  g.addColorStop(1, tone(av.eye, -0.4));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(ix, iy, 1.6, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#0b0806';
  ctx.beginPath();
  ctx.arc(ix, iy, 0.72, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(ix + 0.5, iy - 0.55, 0.34, 0, TAU);
  ctx.fill();
  const lid = ctx.createLinearGradient(0, y - eh, 0, y);
  lid.addColorStop(0, 'rgba(60,30,20,0.35)');
  lid.addColorStop(1, 'rgba(60,30,20,0)');
  ctx.fillStyle = lid;
  ctx.fillRect(x - ew, y - eh * 1.4, ew * 2, eh * 1.4);
  ctx.restore();
  // upper lash line
  ctx.strokeStyle = '#1a100d';
  ctx.lineWidth = 0.55;
  ctx.beginPath();
  ctx.moveTo(x - ew, y);
  ctx.bezierCurveTo(x - ew * 0.5, y - eh * 1.35, x + ew * 0.5, y - eh * 1.35, x + ew, y - eh * 0.08);
  ctx.stroke();
  ctx.beginPath();
  const ox = side > 0 ? x + ew : x - ew;
  const oy = side > 0 ? y - eh * 0.08 : y;
  ctx.moveTo(ox - side * 0.3, oy - 0.05);
  ctx.lineTo(ox + side * 0.6, oy - 0.5);
  ctx.stroke();
}

function drawBrow(ctx, av, side, emo, lift) {
  const s = side;
  const by = -4.6 - emo.brow * 1.3 - lift;
  const tilt = emo.browTilt;
  const ix = s * 2.4;
  const iy = by + 0.5 - tilt * 1.2;
  const px = s * 6.0;
  const py = by - 0.9;
  const ox = s * 9.4;
  const oy = by + 0.7 + tilt * 0.3;
  ctx.beginPath();
  ctx.moveTo(ix, iy + 0.55);
  ctx.quadraticCurveTo(ix - s * 0.2, iy - 0.5, ix + s * 0.6, iy - 0.55);
  ctx.quadraticCurveTo(px, py - 0.7, ox, oy);
  ctx.quadraticCurveTo(px, py + 0.45, ix, iy + 0.55);
  ctx.closePath();
  ctx.fillStyle = av.brow;
  ctx.fill();
}

function drawNose(ctx, av) {
  ctx.lineCap = 'round';
  ctx.strokeStyle = rgba(av.shade, 0.32);
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(-1.2, -1.6);
  ctx.quadraticCurveTo(-2.0, 3.4, -2.2, 5.6);
  ctx.stroke();
  ctx.strokeStyle = rgba(av.shade, 0.6);
  ctx.lineWidth = 0.5;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(s * 2.5, 6.1);
    ctx.quadraticCurveTo(s * 2.7, 7.6, s * 1.2, 7.5);
    ctx.stroke();
  }
  ctx.strokeStyle = rgba(av.shade, 0.42);
  ctx.beginPath();
  ctx.moveTo(-1.2, 7.5);
  ctx.quadraticCurveTo(0, 8.1, 1.2, 7.5);
  ctx.stroke();
  radial(ctx, 0.3, 5.0, 1.4, '#ffffff', 0.12);
}

function drawGlasses(ctx) {
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = '#1b1b20';
  for (const s of [-1, 1]) {
    const x = s * EYE_X;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - 3.9, EYE_Y - 2.8, 7.8, 5.6, 2.1); else ctx.rect(x - 3.9, EYE_Y - 2.8, 7.8, 5.6);
    ctx.fillStyle = 'rgba(200,220,255,0.08)';
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 0.3;
    ctx.beginPath();
    ctx.moveTo(x - 2.2, EYE_Y + 1.6);
    ctx.lineTo(x + 0.4, EYE_Y - 1.8);
    ctx.stroke();
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = '#1b1b20';
    ctx.beginPath();
    ctx.moveTo(s * (EYE_X + 3.9), EYE_Y - 1.4);
    ctx.lineTo(s * (HW - 0.2), EYE_Y - 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(-EYE_X + 3.9, EYE_Y - 0.9);
  ctx.quadraticCurveTo(0, EYE_Y - 2.2, EYE_X - 3.9, EYE_Y - 0.9);
  ctx.stroke();
}

function bodyPath(ctx, av, bottom) {
  const depth = { turtleneck: 24, blazer: 28.6, crew: 29, hoodie: 29, scoop: 33.5, collar: 0 }[av.neck] ?? 29;
  ctx.beginPath();
  ctx.moveTo(-7.4, 24);
  ctx.bezierCurveTo(-15, 26.4, -26, 27.4, -34, 31.4);
  ctx.bezierCurveTo(-41, 35, -44, 44, -45, bottom);
  ctx.lineTo(45, bottom);
  ctx.bezierCurveTo(44, 44, 41, 35, 34, 31.4);
  ctx.bezierCurveTo(26, 27.4, 15, 26.4, 7.4, 24);
  if (av.neck === 'collar') ctx.lineTo(0, 35);
  else ctx.quadraticCurveTo(0, depth * 2 - 24, -7.4, 24);
  ctx.closePath();
}

function drawBody(ctx, av, bottom) {
  // hood behind the neck
  if (av.neck === 'hoodie') {
    ctx.fillStyle = tone(av.outfit, -0.25);
    ctx.beginPath();
    ctx.moveTo(-15, 28);
    ctx.bezierCurveTo(-15, 18, -9, 14, 0, 14);
    ctx.bezierCurveTo(9, 14, 15, 18, 15, 28);
    ctx.closePath();
    ctx.fill();
  }
  // neck + upper chest
  ctx.beginPath();
  ctx.moveTo(-5.8, 6);
  ctx.lineTo(-6.2, 22);
  ctx.quadraticCurveTo(-8, 27, -11, 28);
  ctx.lineTo(-11, 42);
  ctx.lineTo(11, 42);
  ctx.lineTo(11, 28);
  ctx.quadraticCurveTo(8, 27, 6.2, 22);
  ctx.lineTo(5.8, 6);
  ctx.closePath();
  ctx.fillStyle = av.skin;
  ctx.fill();
  const ng = ctx.createLinearGradient(0, 10, 0, 34);
  ng.addColorStop(0, rgba(av.shade, 0.9));
  ng.addColorStop(0.5, rgba(av.shade, 0.35));
  ng.addColorStop(1, rgba(av.shade, 0.15));
  ctx.fillStyle = ng;
  ctx.fill();

  // garment
  bodyPath(ctx, av, bottom);
  ctx.fillStyle = av.outfit;
  ctx.fill();
  ctx.save();
  bodyPath(ctx, av, bottom);
  ctx.clip();
  const sh = ctx.createLinearGradient(-45, 0, 45, 0);
  sh.addColorStop(0, 'rgba(255,255,255,0.08)');
  sh.addColorStop(0.5, 'rgba(255,255,255,0)');
  sh.addColorStop(1, 'rgba(0,0,0,0.2)');
  ctx.fillStyle = sh;
  ctx.fillRect(-46, 20, 92, bottom);
  radial(ctx, 0, 25, 14, '#000000', 0.3);
  if (av.neck === 'blazer') {
    ctx.fillStyle = av.outfit2;
    ctx.beginPath();
    ctx.moveTo(-8.6, 24.6); ctx.lineTo(-1.2, bottom); ctx.lineTo(1.2, bottom); ctx.lineTo(8.6, 24.6);
    ctx.quadraticCurveTo(0, 2 * 28.6 - 24, -8.6, 24.6);
    ctx.fill();
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * 8.6, 24.6);
      ctx.lineTo(s * 12.8, 27.4);
      ctx.lineTo(s * 10.8, 37);
      ctx.lineTo(s * 13.6, 39.6);
      ctx.lineTo(s * 4.4, 60);
      ctx.lineTo(s * 1.4, bottom);
      ctx.closePath();
      ctx.fillStyle = tone(av.outfit, 0.1);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.3;
      ctx.stroke();
    }
  } else if (av.neck === 'turtleneck') {
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-7.6, 14.5, 15.2, 13, 3); else ctx.rect(-7.6, 14.5, 15.2, 13);
    ctx.fillStyle = tone(av.outfit, 0.06);
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = 'rgba(0,0,0,0.13)';
    ctx.lineWidth = 0.35;
    for (let x = -7; x <= 7; x += 1.4) { ctx.beginPath(); ctx.moveTo(x, 14); ctx.lineTo(x * 1.06, 28); ctx.stroke(); }
    radial(ctx, 0, 15, 9, '#000000', 0.3);
  } else if (av.neck === 'crew') {
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 0.6;
    for (let x = -44; x <= 44; x += 2.2) { ctx.beginPath(); ctx.moveTo(x, 24); ctx.lineTo(x, bottom); ctx.stroke(); }
  } else if (av.neck === 'collar') {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(-0.15, 35, 0.3, bottom);
    for (let y = 40; y < bottom; y += 7) {
      ctx.fillStyle = tone(av.outfit, 0.5);
      ctx.beginPath(); ctx.arc(0.9, y, 0.5, 0, TAU); ctx.fill();
    }
  }
  ctx.restore();

  // neckline trims
  if (av.neck === 'crew' || av.neck === 'hoodie' || av.neck === 'scoop') {
    const depth = av.neck === 'scoop' ? 33.5 : 29;
    ctx.strokeStyle = av.neck === 'hoodie' ? tone(av.outfit, 0.12) : av.outfit2;
    ctx.lineWidth = av.neck === 'hoodie' ? 2.4 : av.neck === 'scoop' ? 0.9 : 1.6;
    ctx.beginPath();
    ctx.moveTo(-7.4, 24);
    ctx.quadraticCurveTo(0, depth * 2 - 24, 7.4, 24);
    ctx.stroke();
  }
  if (av.neck === 'hoodie') {
    ctx.strokeStyle = '#d8d8dc';
    ctx.lineWidth = 0.55;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * 3.4, 29.5);
      ctx.quadraticCurveTo(s * 3.9, 36, s * 3.5, 43);
      ctx.stroke();
      ctx.fillStyle = '#c5c5cc';
      ctx.fillRect(s * 3.5 - 0.35, 43, 0.7, 1.6);
    }
  }
  if (av.neck === 'scoop') {
    ctx.strokeStyle = '#e8c26a';
    ctx.lineWidth = 0.28;
    ctx.beginPath();
    ctx.moveTo(-6.3, 24.4);
    ctx.quadraticCurveTo(0, 34, 6.3, 24.4);
    ctx.stroke();
    ctx.fillStyle = '#f0cf7a';
    ctx.beginPath(); ctx.arc(0, 29.6, 0.8, 0, TAU); ctx.fill();
  }
  if (av.neck === 'collar') {
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * 7.4, 22.6);
      ctx.lineTo(s * 12.6, 28.2);
      ctx.lineTo(s * 3.2, 34.2);
      ctx.lineTo(s * 6.6, 24.6);
      ctx.closePath();
      ctx.fillStyle = tone(av.outfit, 0.12);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 0.28;
      ctx.stroke();
    }
  }
}

function drawEars(ctx, av) {
  for (const s of [-1, 1]) {
    ctx.fillStyle = av.skin;
    ctx.beginPath();
    ctx.ellipse(s * (HW - 0.6), 1.2, 2.5, 4.1, s * 0.12, 0, TAU);
    ctx.fill();
    ctx.fillStyle = rgba(av.shade, 0.55);
    ctx.beginPath();
    ctx.ellipse(s * (HW - 0.2), 1.2, 1.2, 2.6, s * 0.12, 0, TAU);
    ctx.fill();
    if (av.earrings === 'hoops') {
      ctx.strokeStyle = '#e8c26a';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(s * (HW - 0.2), 7.6, 1.9, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,245,210,0.8)';
      ctx.lineWidth = 0.22;
      ctx.beginPath();
      ctx.arc(s * (HW - 0.2), 7.6, 1.9, Math.PI * 1.1, Math.PI * 1.5);
      ctx.stroke();
    }
  }
}

/** Draw a procedural avatar into ctx (W×H px) for the given motion state. */
function drawAvatar(ctx, W, H, av, st) {
  const U = Math.min(W / 80, H / 100);
  const cx = W / 2;
  const cy = H * (H > W * 1.2 ? 0.4 : 0.43);
  const emo = emotionOf(st.emotion);
  const { shape, pose } = st;
  const bottom = (H - cy) / U + 6;
  const jaw = shape.open * 1.1;
  const headT = () => {
    ctx.translate(cx + pose.x * W, cy + pose.y * H);
    ctx.scale(U * pose.scale, U * pose.scale);
    ctx.translate(0, 26);
    ctx.rotate(pose.rot);
    ctx.translate(0, -26);
  };

  ctx.save(); headT(); drawHairBack(ctx, av); ctx.restore();
  ctx.save();
  ctx.translate(cx + pose.x * W * 0.3, cy + pose.y * H * 0.25);
  ctx.scale(U, U);
  drawBody(ctx, av, bottom);
  ctx.restore();

  ctx.save();
  headT();
  drawEars(ctx, av);
  // face + shading
  ctx.save();
  facePath(ctx, jaw);
  ctx.fillStyle = av.skin;
  ctx.fill();
  ctx.clip();
  const fg = ctx.createRadialGradient(-4, -5, 2, 0, 1, 25);
  fg.addColorStop(0, 'rgba(255,255,255,0.12)');
  fg.addColorStop(0.55, rgba(av.shade, 0));
  fg.addColorStop(1, rgba(av.shade, 0.8));
  ctx.fillStyle = fg;
  ctx.fillRect(-30, -30, 60, 60);
  const tg = ctx.createLinearGradient(0, -HH, 0, -HH + 10);
  tg.addColorStop(0, rgba(av.shade, 0.55));
  tg.addColorStop(1, rgba(av.shade, 0));
  ctx.fillStyle = tg;
  ctx.fillRect(-HW, -HH, HW * 2, 10);
  const smile = emo.smile;
  for (const s of [-1, 1]) radial(ctx, s * 8.8, 7, 4.8, '#e46b6b', 0.14 + Math.max(0, smile) * 0.1);
  ctx.restore();

  const talk = shape.open;
  if (av.beard) drawBeard(ctx, av, jaw, shape, av.beard);
  drawNose(ctx, av);
  drawMouth(ctx, av, shape, smile);
  if (av.beard) drawMustache(ctx, av, av.beard);
  const open = clamp(emo.eyeOpen * (1 - st.blink) - Math.max(0, smile - 0.4) * 0.15, 0, 1.2);
  for (const s of [-1, 1]) drawEye(ctx, av, s, open, st.gaze);
  const lift = talk * 0.45 * emo.energy + (emo.id === 'excited' ? Math.max(0, Math.sin(st.t * 5)) * talk * 0.4 : 0);
  for (const s of [-1, 1]) drawBrow(ctx, av, s, emo, lift);
  drawHairFront(ctx, av);
  if (av.glasses) drawGlasses(ctx);
  ctx.restore();
}

// ---------------------------------------------------------------- overlays

function drawCaptions(ctx, W, H, res, pages, wordIdx, { lift = 0, dim = false } = {}) {
  if (!pages.length) return;
  const p = pageAt(pages, Math.max(0, wordIdx));
  if (p < 0) return;
  const [a, b] = pages[p];
  const S = Math.min(W, H);
  const fs = Math.max(14, Math.round(S * 0.05));
  ctx.save();
  ctx.font = `700 ${fs}px ${getComputedStyleFont()}`;
  ctx.textBaseline = 'middle';
  const space = ctx.measureText(' ').width;
  const maxW = W * 0.84;
  const lines = [[]];
  let lw = 0;
  for (let i = a; i < b; i++) {
    const w = ctx.measureText(capText(res, i)).width;
    if (lines[lines.length - 1].length && lw + space + w > maxW) { lines.push([]); lw = 0; }
    lines[lines.length - 1].push({ i, w });
    lw += (lw ? space : 0) + w;
  }
  const lh = fs * 1.3;
  const padX = fs * 0.6;
  const padY = fs * 0.35;
  const boxH = lines.length * lh + padY * 2;
  const widths = lines.map((l) => l.reduce((s, x) => s + x.w, 0) + space * (l.length - 1));
  const boxW = Math.max(...widths) + padX * 2;
  const by = H - S * 0.06 - lift - boxH;
  ctx.fillStyle = 'rgba(8,8,10,0.62)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(W / 2 - boxW / 2, by, boxW, boxH, fs * 0.4); else ctx.rect(W / 2 - boxW / 2, by, boxW, boxH);
  ctx.fill();
  lines.forEach((line, li) => {
    let x = W / 2 - widths[li] / 2;
    const y = by + padY + lh * (li + 0.5);
    for (const { i, w } of line) {
      ctx.fillStyle = dim ? 'rgba(255,255,255,0.86)' : i === wordIdx ? '#d4ff3f' : i < wordIdx ? '#ffffff' : 'rgba(255,255,255,0.72)';
      ctx.fillText(capText(res, i), x, y);
      x += w + space;
    }
  });
  ctx.restore();
}

// Caption text for word i: the word plus any punctuation glued to it ("Hi," "great!").
function capText(res, i) {
  const w = res.words[i];
  if (!res.script) return w.word;
  const end = i + 1 < res.words.length ? res.words[i + 1].charStart : res.script.length;
  const tail = res.script.slice(w.charEnd, end).match(/^[^\s]*/)[0];
  const head = res.script.slice(i ? res.words[i - 1].charEnd : 0, w.charStart).match(/["“'‘(¿¡]*$/)[0];
  return head + w.word + tail;
}

let fontCache = '';
function getComputedStyleFont() {
  if (!fontCache) fontCache = (getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif');
  return fontCache;
}

function drawWatermark(ctx, W, H) {
  const S = Math.min(W, H);
  const fs = Math.max(11, Math.round(S * 0.028));
  ctx.save();
  ctx.font = `600 ${fs}px ${getComputedStyleFont()}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  const text = 'higgsfield clone';
  const x = W - fs * 0.9;
  const y = H - fs * 0.9;
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = fs * 0.4;
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.fillText(text, x, y);
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(212,255,63,0.9)';
  ctx.fillRect(x - tw - fs * 0.95, y - fs * 0.72, fs * 0.65, fs * 0.65);
  ctx.restore();
}

function drawCover(ctx, img, W, H) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const s = Math.max(W / iw, H / ih);
  const dw = iw * s;
  const dh = ih * s;
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

// ---------------------------------------------------------------- view

export async function mount(root, ctx) {
  const { store, toast } = ctx;
  const synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const S = {
    face: 'avatar',
    avatar: avatarById(ctx.params.get('avatar')).id,
    script: store.getLastPrompt('speak') || DEFAULT_SCRIPT,
    voiceURI: '',
    rate: 1,
    pitch: 1,
    emotion: 'neutral',
    bg: 'studio',
    aspect: '1:1',
    captions: true,
    box: { x: 0.4, y: 0.6, w: 0.2, h: 0.11 },
    editBox: false,
  };
  let photo = null; // HTMLImageElement
  let photoThumbUrl = '';
  const track = () => ({ ...buildTrack(S.script, { rate: S.rate }), script: S.script });
  let res = track();
  let pages = captionPages(res.words);
  let mode = 'idle'; // 'idle' | 'preview' | 'generate'
  let preview = null;
  let job = null;
  let raf = 0;
  let alive = true;
  let dirty = true;
  let voices = [];
  let voicesTimedOut = false;
  let resultUrl = '';
  let shownWord = -2;
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };

  // ------------------------------------------------------------ DOM
  const avatarBtns = new Map();
  const avatarGrid = h('div', { class: 'spk-avatars', role: 'group', 'aria-labelledby': 'spk-avatar-label' });
  for (const av of AVATARS) {
    const c = makeCanvas(192, 192);
    const b = h('button', { type: 'button', class: 'spk-avatar', 'aria-pressed': 'false', 'aria-label': `Avatar ${av.name}`, onclick: () => selectAvatar(av.id) },
      c, h('span', { class: 'spk-avatar-name' }, av.name));
    avatarBtns.set(av.id, b);
    avatarGrid.append(b);
    const g = c.getContext('2d');
    g.drawImage(bgCanvas('studio', 192, 192, av), 0, 0);
    g.translate(96, 74);
    g.scale(1.3, 1.3);
    g.translate(-96, -74);
    drawAvatar(g, 192, 192, av, { t: 0, shape: { ...REST }, emotion: 'happy', blink: 0, gaze: { x: 0, y: 0 }, pose: { x: 0, y: 0, rot: 0, scale: 1 } });
  }
  const photoImg = h('img', { alt: '' });
  const photoBtn = h('button', { type: 'button', class: 'spk-avatar spk-avatar-photo', 'aria-pressed': 'false', 'aria-label': 'Your photo', hidden: true, onclick: () => selectPhoto() },
    photoImg, h('span', { class: 'spk-avatar-name' }, 'Your photo'));
  const fileInput = h('input', { type: 'file', accept: 'image/*', 'aria-label': 'Upload a face photo' });
  const uploadTile = h('label', { class: 'spk-avatar spk-upload dropzone' },
    h('span', { html: ICON.upload }), h('span', { class: 'spk-avatar-name' }, 'Upload face'), fileInput);
  avatarGrid.append(photoBtn, uploadTile);

  const adjustBtn = h('button', { type: 'button', class: 'btn spk-btn-sm', 'aria-pressed': 'false', onclick: () => setEditBox(!S.editBox) }, 'Adjust mouth area');
  const photoTools = h('div', { class: 'spk-photo-tools', hidden: true },
    adjustBtn, h('span', { class: 'field-hint' }, 'Drag the box over the lips; drag its corner to resize.'));
  const avatarHint = h('span', { class: 'field-hint' });

  const scriptEl = h('textarea', { id: 'spk-script', class: 'textarea', maxlength: String(MAX_CHARS), rows: '5', spellcheck: 'true' });
  scriptEl.value = S.script.slice(0, MAX_CHARS);
  const countEl = h('span', { class: 'field-hint', id: 'spk-count' });
  const statsEl = h('div', { class: 'spk-stats', 'aria-live': 'polite' });

  const voiceSel = h('select', { id: 'spk-voice', class: 'select' });
  const voiceHint = h('span', { class: 'field-hint spk-voice-hint' });
  const rateOut = h('output', { for: 'spk-rate', class: 'spk-out' });
  const pitchOut = h('output', { for: 'spk-pitch', class: 'spk-out' });
  const rateEl = h('input', { type: 'range', id: 'spk-rate', min: '0.5', max: '2', step: '0.1', value: '1' });
  const pitchEl = h('input', { type: 'range', id: 'spk-pitch', min: '0', max: '2', step: '0.1', value: '1' });

  const emoChips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Emotion' });
  for (const e of EMOTION_LIST) {
    emoChips.append(h('button', { type: 'button', class: 'chip', 'data-v': e.id, 'aria-pressed': String(e.id === S.emotion), onclick: () => setEmotion(e.id) }, e.name));
  }
  const bgChips = h('div', { class: 'chips spk-bgs', role: 'group', 'aria-label': 'Background' });
  for (const b of BACKGROUNDS) {
    bgChips.append(h('button', { type: 'button', class: 'chip spk-bg-chip', 'data-v': b.id, 'aria-pressed': String(b.id === S.bg), onclick: () => setBg(b.id) },
      h('span', { class: 'spk-swatch', style: { background: b.swatch }, 'aria-hidden': 'true' }), b.name));
  }
  const bgHint = h('span', { class: 'field-hint', hidden: true }, 'Photos keep their own background.');
  const aspectSeg = segmented('Aspect ratio', Object.keys(ASPECTS).map((v) => ({ value: v, label: v })), S.aspect, (v) => { S.aspect = v; resize(); });
  const capSwitch = h('button', { type: 'button', class: 'spk-switch', role: 'switch', 'aria-checked': 'true', 'aria-labelledby': 'spk-cap-label', onclick: () => {
    S.captions = !S.captions;
    capSwitch.setAttribute('aria-checked', String(S.captions));
    dirty = true;
  } }, h('span', { class: 'spk-switch-knob' }));

  const previewBtn = h('button', { type: 'button', class: 'btn spk-preview', onclick: () => (mode === 'preview' ? stopPreview() : startPreview()) });
  const costEl = h('span', { class: 'cost' });
  const genBtn = h('button', { type: 'button', class: 'btn btn-primary spk-generate', onclick: () => generate() }, 'Generate', costEl);
  const alertEl = h('div', { class: 'spk-alert', role: 'alert', hidden: true });
  const wmNote = h('p', { class: 'field-hint spk-wm-note' });

  const panel = h('section', { class: 'panel spk-panel', 'aria-labelledby': 'spk-title' },
    h('div', { class: 'spk-head' },
      h('h1', { id: 'spk-title' }, h('span', { html: ICON.mic }), 'Speak'),
      h('p', { class: 'field-hint' }, 'Turn a script into a talking avatar with lip sync.')),
    h('div', { class: 'field' },
      h('span', { class: 'field-label', id: 'spk-avatar-label' }, 'Avatar', avatarHint),
      avatarGrid, photoTools),
    h('div', { class: 'field' },
      h('label', { for: 'spk-script' }, 'Script', countEl),
      scriptEl, statsEl),
    h('div', { class: 'field' },
      h('label', { for: 'spk-voice' }, 'Voice'),
      voiceSel, voiceHint),
    h('div', { class: 'spk-sliders' },
      h('div', { class: 'field' }, h('label', { for: 'spk-rate' }, 'Speed', rateOut), rateEl),
      h('div', { class: 'field' }, h('label', { for: 'spk-pitch' }, 'Pitch', pitchOut), pitchEl)),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Emotion'), emoChips),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Background', bgHint), bgChips),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Format'), aspectSeg),
    h('div', { class: 'spk-toggle-row' },
      h('span', { id: 'spk-cap-label', class: 'spk-toggle-label' }, 'Burn in captions', h('span', { class: 'field-hint' }, 'Recommended, since exports are silent')),
      capSwitch),
    h('div', { class: 'spk-actions' },
      h('p', { class: 'spk-note' }, h('span', { html: ICON.mic }), 'Video exports silent; voice plays in preview.'),
      h('div', { class: 'spk-btns' }, previewBtn, genBtn),
      alertEl, wmNote));

  // stage
  const canvas = h('canvas', { class: 'spk-canvas', role: 'img', 'aria-label': 'Talking avatar preview' });
  const c2d = canvas.getContext('2d');
  const boxEl = h('div', { class: 'spk-mouthbox', tabindex: '0', role: 'group', hidden: true,
    'aria-label': 'Mouth area. Arrow keys move it, Shift plus arrow keys resize it.' },
  h('span', { class: 'spk-mouthbox-label' }, 'Mouth'), h('span', { class: 'spk-mouthbox-handle', 'aria-hidden': 'true' }));
  const wrap = h('div', { class: 'spk-canvas-wrap' }, canvas, boxEl);
  const liveBadge = h('div', { class: 'spk-live', hidden: true }, h('span', { class: 'spk-dot' }), h('span', {}, 'Live preview'));
  const frame = h('div', { class: 'stage-frame spk-frame' }, wrap, liveBadge);

  const progBar = h('span', {});
  const progPct = h('span', { class: 'spk-progress-pct' }, '0%');
  const progLabel = h('span', { class: 'field-hint' }, 'Rendering in real time…');
  const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => cancelJob() }, 'Cancel');
  const progress = h('div', { class: 'card spk-progress', hidden: true, 'aria-live': 'polite' },
    h('div', { class: 'spk-row' }, h('strong', {}, 'Rendering video'), progPct),
    h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Render progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, progBar),
    h('div', { class: 'spk-row' }, progLabel, cancelBtn));

  const resultVideo = h('video', { class: 'spk-result-video', controls: true, playsinline: true, muted: true, preload: 'metadata' });
  const resultMeta = h('span', { class: 'field-hint' });
  const resultActions = h('div', { class: 'spk-row spk-result-actions' });
  const result = h('div', { class: 'card spk-result', hidden: true },
    h('div', { class: 'spk-row' }, h('strong', {}, 'Your video'), resultMeta),
    resultVideo,
    h('p', { class: 'field-hint' }, 'This video is silent: browsers can’t record synthesized speech. Use “Play with voice” to hear it alongside.'),
    resultActions);

  const wordsEl = h('p', { class: 'spk-words' });
  const karaoke = h('div', { class: 'card spk-karaoke' },
    h('div', { class: 'spk-row' }, h('span', { class: 'eyebrow' }, 'Script'), h('span', { class: 'field-hint' }, 'Words light up as the avatar speaks')),
    wordsEl);

  const stage = h('section', { class: 'stage spk-stage', 'aria-label': 'Avatar stage' }, frame, progress, result, karaoke);
  const studio = h('div', { class: 'studio spk' }, panel, stage);
  root.append(studio);

  // ------------------------------------------------------------ state updates
  function updateStats() {
    const n = scriptEl.value.length;
    countEl.textContent = `${n} / ${MAX_CHARS}`;
    const cost = creditsFor(S.script, { rate: S.rate });
    statsEl.textContent = res.words.length
      ? `${res.words.length} words · ~${formatSeconds(res.duration)} · ${cost} credits`
      : 'Write something for your avatar to say.';
    costEl.innerHTML = `${ICON.bolt}${cost}`;
    costEl.setAttribute('aria-label', `${cost} credits`);
    const free = store.getPlan().id === 'free';
    wmNote.textContent = free ? 'Free plan exports include a small watermark.' : '';
    wmNote.hidden = !free;
    const busy = mode === 'generate';
    scriptEl.readOnly = busy;
    genBtn.disabled = busy || !res.words.length;
    previewBtn.disabled = busy || !res.words.length;
    previewBtn.innerHTML = mode === 'preview'
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/></svg>Stop'
      : `${ICON.play}Preview`;
  }

  function renderWords() {
    wordsEl.replaceChildren();
    if (!res.words.length) { wordsEl.append(h('span', { class: 'muted' }, 'Your script will appear here.')); return; }
    let pos = 0;
    const text = S.script;
    for (const w of res.words) {
      if (w.charStart > pos) wordsEl.append(text.slice(pos, w.charStart));
      wordsEl.append(h('span', { class: 'spk-w', 'data-i': String(w.index) }, text.slice(w.charStart, w.charEnd)));
      pos = w.charEnd;
    }
    if (pos < text.length) wordsEl.append(text.slice(pos));
    shownWord = -2;
  }

  function highlight(i) {
    if (i === shownWord) return;
    shownWord = i;
    const spans = wordsEl.querySelectorAll('.spk-w');
    spans.forEach((s, k) => {
      s.classList.toggle('is-on', k === i);
      s.classList.toggle('is-past', i >= 0 && k < i);
    });
  }

  function onScript() {
    S.script = scriptEl.value;
    store.setLastPrompt('speak', S.script);
    if (mode === 'preview') stopPreview();
    res = track();
    pages = captionPages(res.words);
    renderWords();
    updateStats();
    dirty = true;
  }
  let scriptTimer = 0;
  scriptEl.addEventListener('input', () => {
    countEl.textContent = `${scriptEl.value.length} / ${MAX_CHARS}`;
    clearTimeout(scriptTimer);
    scriptTimer = setTimeout(onScript, 140);
  });

  rateEl.addEventListener('input', () => {
    S.rate = Number(rateEl.value);
    rateOut.textContent = `${S.rate.toFixed(1)}×`;
    if (mode === 'preview') stopPreview();
    res = track();
    pages = captionPages(res.words);
    updateStats();
  });
  pitchEl.addEventListener('input', () => { S.pitch = Number(pitchEl.value); pitchOut.textContent = S.pitch.toFixed(1); });
  rateOut.textContent = '1.0×';
  pitchOut.textContent = '1.0';

  function setPressed(group, v) { for (const b of group.querySelectorAll('[data-v]')) b.setAttribute('aria-pressed', String(b.dataset.v === v)); }
  function setEmotion(id) { S.emotion = id; setPressed(emoChips, id); dirty = true; }
  function setBg(id) {
    if (S.face === 'photo') return;
    S.bg = id;
    setPressed(bgChips, id);
    dirty = true;
  }

  function refreshFaceUI() {
    for (const [id, b] of avatarBtns) b.setAttribute('aria-pressed', String(S.face === 'avatar' && S.avatar === id));
    photoBtn.setAttribute('aria-pressed', String(S.face === 'photo'));
    photoTools.hidden = S.face !== 'photo';
    avatarHint.textContent = S.face === 'photo' ? 'Your photo' : avatarById(S.avatar).name;
    const isPhoto = S.face === 'photo';
    bgHint.hidden = !isPhoto;
    for (const b of bgChips.querySelectorAll('button')) { b.disabled = isPhoto; }
    if (!isPhoto) setEditBox(false);
    dirty = true;
  }
  function selectAvatar(id) { S.face = 'avatar'; S.avatar = id; refreshFaceUI(); }
  function selectPhoto() { if (photo) { S.face = 'photo'; refreshFaceUI(); } }

  async function loadPhoto(src, name = 'photo') {
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
      await img.decode();
      if (!alive) return;
      photo = img;
      photoCache.clear();
      if (photoThumbUrl) URL.revokeObjectURL(photoThumbUrl);
      photoThumbUrl = src.startsWith('blob:') ? src : '';
      photoImg.src = src;
      photoBtn.hidden = false;
      photoBtn.setAttribute('aria-label', `Your photo (${name})`);
      S.face = 'photo';
      S.box = { x: 0.4, y: 0.6, w: 0.2, h: 0.11 };
      refreshFaceUI();
      setEditBox(true);
      toast('Photo loaded. Drag the box over the mouth, then press Preview.', 'good');
    } catch {
      if (src.startsWith('blob:')) URL.revokeObjectURL(src);
      toast('Couldn’t read that image. Try a JPG or PNG.', 'bad');
    }
  }
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast('Please choose an image file.', 'bad'); return; }
    loadPhoto(URL.createObjectURL(f), f.name);
  });
  uploadTile.addEventListener('dragover', (e) => { e.preventDefault(); uploadTile.classList.add('drag'); });
  uploadTile.addEventListener('dragleave', () => uploadTile.classList.remove('drag'));
  uploadTile.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadTile.classList.remove('drag');
    const f = e.dataTransfer?.files?.[0];
    if (f?.type.startsWith('image/')) loadPhoto(URL.createObjectURL(f), f.name);
  });

  // ------------------------------------------------------------ voices
  function voiceLabel(v) { return `${v.name.replace(/^(Microsoft|Google)\s+/, '')} · ${v.lang}`; }
  function populateVoices() {
    if (!synth) {
      voiceSel.replaceChildren(h('option', { value: '' }, 'Not supported in this browser'));
      voiceSel.disabled = true;
      voiceHint.textContent = 'No speech synthesis here, so Preview animates silently.';
      return;
    }
    voices = synth.getVoices().slice();
    if (!voices.length) {
      voiceSel.replaceChildren(h('option', { value: '' }, voicesTimedOut ? 'No voices available' : 'Loading voices…'));
      voiceSel.disabled = true;
      voiceHint.textContent = voicesTimedOut ? 'This device has no speech voices, so Preview animates silently.' : '';
      return;
    }
    const lang = (navigator.language || 'en-US').toLowerCase();
    const base = lang.split('-')[0];
    const score = (v) => {
      const l = v.lang.toLowerCase().replace('_', '-');
      return (l === lang ? 0 : l.startsWith(base) ? 1 : l.startsWith('en') ? 2 : 3) - (v.default ? 0.5 : 0);
    };
    voices.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
    if (!voices.some((v) => v.voiceURI === S.voiceURI)) S.voiceURI = voices[0].voiceURI;
    voiceSel.replaceChildren(...voices.map((v) => h('option', { value: v.voiceURI, selected: v.voiceURI === S.voiceURI }, voiceLabel(v))));
    voiceSel.value = S.voiceURI;
    voiceSel.disabled = false;
    voiceHint.textContent = `${voices.length} voice${voices.length === 1 ? '' : 's'} on this device.`;
  }
  const onVoices = () => populateVoices();
  synth?.addEventListener?.('voiceschanged', onVoices);
  populateVoices();
  later(() => { voicesTimedOut = true; if (!voices.length) populateVoices(); }, 1500);
  voiceSel.addEventListener('change', () => { S.voiceURI = voiceSel.value; });
  const currentVoice = () => voices.find((v) => v.voiceURI === S.voiceURI) ?? null;

  // ------------------------------------------------------------ sizing
  let W = 720;
  let H = 720;
  function resize() {
    [W, H] = sizeFor(S.aspect, 720);
    canvas.width = W;
    canvas.height = H;
    wrap.style.aspectRatio = `${W} / ${H}`;
    wrap.style.setProperty('--spk-ar', String(W / H));
    photoCache.clear();
    dirty = true;
  }

  // ------------------------------------------------------------ photo mode
  const photoCache = new Map();
  function photoBase(w, hh) {
    const key = `base|${w}x${hh}`;
    let c = photoCache.get(key);
    if (!c) {
      c = makeCanvas(w, hh);
      const g = c.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, w, hh);
      drawCover(g, photo, w, hh);
      photoCache.set(key, c);
    }
    return c;
  }
  function photoPatch(w, hh) {
    const { x, y, w: bw0, h: bh0 } = S.box;
    const key = `patch|${w}x${hh}|${x.toFixed(4)},${y.toFixed(4)},${bw0.toFixed(4)},${bh0.toFixed(4)}`;
    let c = photoCache.get(key);
    if (c) return c;
    for (const k of photoCache.keys()) if (k.startsWith(`patch|${w}x${hh}`)) photoCache.delete(k);
    const bx = x * w;
    const bw = bw0 * w;
    const bh = bh0 * hh;
    const lipY = y * hh + bh * 0.5;
    const ph = bh * 0.95;
    c = makeCanvas(bw, ph);
    const g = c.getContext('2d');
    g.drawImage(photoBase(w, hh), bx, lipY, bw, ph, 0, 0, c.width, c.height);
    const m = makeCanvas(c.width, c.height);
    const mg = m.getContext('2d');
    const gy = mg.createLinearGradient(0, 0, 0, c.height);
    gy.addColorStop(0, 'rgba(0,0,0,1)');
    gy.addColorStop(0.45, 'rgba(0,0,0,1)');
    gy.addColorStop(1, 'rgba(0,0,0,0)');
    mg.fillStyle = gy;
    mg.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(m, 0, 0);
    photoCache.set(key, c);
    return c;
  }
  const workCanvases = new Map();
  function drawPhotoFrame(g, w, hh, shape, pose, still) {
    let work = workCanvases.get(`${w}x${hh}`);
    if (!work) { work = makeCanvas(w, hh); workCanvases.set(`${w}x${hh}`, work); }
    const wc = work.getContext('2d');
    wc.drawImage(photoBase(w, hh), 0, 0);
    const bx = S.box.x * w;
    const bw = S.box.w * w;
    const bh = S.box.h * hh;
    const lipY = S.box.y * hh + bh * 0.5;
    const openPx = clamp(shape.open, 0, 1.2) * bh * 0.42;
    if (openPx > 0.4) {
      // Jaw drop: the lower lip + chin slide down column by column along a lens-shaped profile,
      // and the gap is filled with a mouth interior of exactly that shape.
      const narrow = 0.06 + 0.12 * clamp(shape.round, 0, 1) - 0.04 * clamp(shape.wide, 0, 1);
      const x0 = bx + bw * narrow;
      const x1 = bx + bw * (1 - narrow);
      const prof = (x) => { const u = (x - x0) / (x1 - x0); return u <= 0 || u >= 1 ? 0 : Math.sqrt(1 - (2 * u - 1) ** 2); };
      const N = 24;
      wc.save();
      wc.beginPath();
      wc.moveTo(x0, lipY);
      wc.quadraticCurveTo((x0 + x1) / 2, lipY - openPx * 0.12, x1, lipY);
      for (let i = N; i >= 0; i--) { const x = x0 + ((x1 - x0) * i) / N; wc.lineTo(x, lipY + openPx * prof(x) + 1); }
      wc.closePath();
      const cym = lipY + openPx * 0.5;
      const gr = wc.createRadialGradient((x0 + x1) / 2, cym, 0, (x0 + x1) / 2, cym, (x1 - x0) / 2);
      gr.addColorStop(0, '#4a171b');
      gr.addColorStop(1, '#140506');
      wc.fillStyle = gr;
      wc.fill();
      wc.clip();
      if (shape.teeth > 0.05) {
        wc.fillStyle = `rgba(242,237,228,${0.92 * clamp(shape.teeth, 0, 1)})`;
        wc.fillRect(x0 + (x1 - x0) * 0.16, lipY - openPx * 0.2, (x1 - x0) * 0.68, openPx * 0.2 + Math.min(openPx * 0.3, bh * 0.09));
      }
      wc.fillStyle = 'rgba(168,70,80,0.75)';
      wc.beginPath();
      wc.ellipse((x0 + x1) / 2, lipY + openPx * 0.95, (x1 - x0) * 0.28, openPx * 0.3, 0, 0, TAU);
      wc.fill();
      wc.restore();
      const patch = photoPatch(w, hh);
      const sw = patch.width / N;
      for (let i = 0; i < N; i++) {
        const sx = i * sw;
        const off = openPx * prof(bx + sx + sw / 2);
        wc.drawImage(patch, sx, 0, Math.min(sw + 1, patch.width - sx), patch.height, bx + sx, lipY + off, Math.min(sw + 1, patch.width - sx), patch.height);
      }
    }
    g.save();
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, hh);
    if (still) g.drawImage(work, 0, 0);
    else {
      const z = 1.035 * pose.scale;
      g.translate(w / 2 + pose.x * w * 0.6, hh / 2 + pose.y * hh * 0.6);
      g.rotate(pose.rot * 0.35);
      g.scale(z, z);
      g.drawImage(work, -w / 2, -hh / 2);
    }
    g.restore();
  }

  // mouth box dragging
  function placeBox() {
    const b = S.box;
    Object.assign(boxEl.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
  }
  function setBox(nb) {
    const w = clamp(nb.w, 0.06, 0.6);
    const hh = clamp(nb.h, 0.04, 0.4);
    S.box = { w, h: hh, x: clamp(nb.x, 0, 1 - w), y: clamp(nb.y, 0, 1 - hh) };
    placeBox();
    dirty = true;
  }
  function setEditBox(on) {
    S.editBox = !!on && S.face === 'photo';
    boxEl.hidden = !S.editBox;
    adjustBtn.setAttribute('aria-pressed', String(S.editBox));
    adjustBtn.textContent = S.editBox ? 'Done adjusting' : 'Adjust mouth area';
    placeBox();
    dirty = true;
  }
  let drag = null;
  boxEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, box: { ...S.box }, r, resize: e.target.classList.contains('spk-mouthbox-handle') };
    boxEl.setPointerCapture(e.pointerId);
    boxEl.focus({ preventScroll: true });
  });
  boxEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = (e.clientX - drag.sx) / drag.r.width;
    const dy = (e.clientY - drag.sy) / drag.r.height;
    if (drag.resize) setBox({ ...drag.box, w: drag.box.w + dx, h: drag.box.h + dy });
    else setBox({ ...drag.box, x: drag.box.x + dx, y: drag.box.y + dy });
  });
  const endDrag = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
  boxEl.addEventListener('pointerup', endDrag);
  boxEl.addEventListener('pointercancel', endDrag);
  boxEl.addEventListener('keydown', (e) => {
    const step = e.altKey ? 0.002 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) { if (e.key === 'Enter' || e.key === 'Escape') setEditBox(false); return; }
    e.preventDefault();
    const b = S.box;
    if (e.shiftKey) setBox({ ...b, w: b.w + d[0], h: b.h + d[1] });
    else setBox({ ...b, x: b.x + d[0], y: b.y + d[1] });
  });

  // ------------------------------------------------------------ frame rendering
  function drawFrame(g, w, hh, { t, tl, shape, wordIdx, captions, watermark, playing, r = res, pg = pages }) {
    const pose = headPose(t, { emotion: S.emotion, talk: shape.open, seed: 1 });
    if (S.face === 'photo' && photo) {
      drawPhotoFrame(g, w, hh, shape, pose, S.editBox && !playing);
    } else {
      const av = avatarById(S.avatar);
      g.drawImage(bgCanvas(S.bg, w, hh, av), 0, 0);
      const emo = emotionOf(S.emotion);
      drawAvatar(g, w, hh, av, { t, shape, emotion: S.emotion, blink: blinkAt(t, { rate: emo.blinkRate }), gaze: gazeAt(t), pose });
    }
    const wmLift = watermark ? Math.max(11, Math.min(w, hh) * 0.028) * 1.4 : 0;
    if (captions && r.words.length && (!playing || tl < r.duration)) drawCaptions(g, w, hh, r, pg, playing ? wordIdx : 0, { lift: wmLift, dim: !playing });
    if (watermark) drawWatermark(g, w, hh);
  }

  function previewState(now) {
    const p = preview;
    if (p.waiting) {
      if (now - p.requested > 900) p.waiting = false;
      p.t0 = now;
    }
    let tl = (now - p.t0) / 1000 + p.offset;
    let hold = 0;
    const g = p.gate;
    if (g >= 0 && g < res.words.length - 1) {
      const cap = res.words[g + 1].start;
      if (tl > cap) { hold = clamp((tl - cap) / 0.08, 0, 1); tl = cap - 1e-3; }
    }
    const v = visemeAt(res, tl);
    const shape = hold ? mixShapes(v.shape, REST, hold) : v.shape;
    const wordIdx = wordIndexAt(res, tl);
    const done = p.speaking ? p.ended || tl > res.duration * 2.5 + 4 : !p.waiting && tl > res.duration + 0.15;
    return { tl, shape, wordIdx, done };
  }

  function tick(now) {
    raf = 0;
    if (!alive) return;
    const t = now / 1000;
    if (mode === 'generate' && job) {
      renderJobFrame(now);
    } else if (mode === 'preview' && preview) {
      const st = previewState(now);
      drawFrame(c2d, W, H, { t, tl: st.tl, shape: st.shape, wordIdx: st.wordIdx, captions: S.captions, watermark: false, playing: true });
      highlight(st.wordIdx);
      if (st.done) stopPreview();
    } else if (dirty || !reduced?.matches) {
      dirty = false;
      drawFrame(c2d, W, H, { t: reduced?.matches ? 0 : t, tl: 0, shape: REST, wordIdx: -1, captions: S.captions, watermark: false, playing: false });
    }
    raf = requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ preview
  function startPreview() {
    if (!res.words.length) { toast('Write a script first.', 'bad'); return; }
    stopPreview();
    setEditBox(false);
    const p = { t0: performance.now(), requested: performance.now(), offset: 0, gate: -1, waiting: false, speaking: false, ended: false, keepAlive: 0 };
    preview = p;
    mode = 'preview';
    const voice = currentVoice();
    if (synth && voice) {
      try {
        if (synth.speaking || synth.pending) synth.cancel();
        const u = new SpeechSynthesisUtterance(S.script);
        u.voice = voice;
        u.lang = voice.lang;
        u.rate = S.rate;
        u.pitch = S.pitch;
        u.onstart = () => { if (preview !== p) return; p.waiting = false; p.speaking = true; p.t0 = performance.now(); p.offset = 0; p.gate = -1; };
        u.onboundary = (e) => {
          if (preview !== p || (e.name && e.name !== 'word')) return;
          const i = wordIndexAtChar(res.words, e.charIndex);
          if (i < 0) return;
          p.speaking = true;
          p.offset = res.words[i].start - (performance.now() - p.t0) / 1000;
          p.gate = i;
        };
        u.onend = () => { if (preview === p) p.ended = true; };
        u.onerror = (e) => {
          if (preview !== p) return;
          if (e.error === 'interrupted' || e.error === 'canceled') return;
          p.speaking = false;
          p.waiting = false;
          p.gate = -1;
        };
        p.waiting = true;
        synth.speak(u);
        // Chrome stops long utterances on network voices unless nudged.
        if (!voice.localService) p.keepAlive = setInterval(() => { if (synth.speaking && !synth.paused) { synth.pause(); synth.resume(); } }, 10000);
      } catch {
        p.waiting = false;
      }
    } else if (!synth || voicesTimedOut) {
      toast('No voice available here, so the preview is silent.', 'info');
    }
    liveBadge.hidden = false;
    updateStats();
  }

  function stopPreview() {
    const p = preview;
    preview = null;
    if (p) {
      clearInterval(p.keepAlive);
      try { if (synth && (synth.speaking || synth.pending)) synth.cancel(); } catch {}
    }
    if (mode === 'preview') mode = 'idle';
    liveBadge.hidden = true;
    highlight(-1);
    dirty = true;
    updateStats();
  }

  // ------------------------------------------------------------ generate
  function pickMime() {
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];
    return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) ?? '';
  }

  function showAlert(msg, withLink) {
    alertEl.replaceChildren(msg);
    if (withLink) alertEl.append(' ', h('a', { href: '#/pricing' }, 'Get more credits'));
    alertEl.hidden = false;
  }

  function generate() {
    if (mode === 'generate') return;
    alertEl.hidden = true;
    if (!res.words.length) { toast('Write a script first.', 'bad'); return; }
    if (typeof window.MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
      showAlert('This browser can’t record canvas video. Try a recent Chrome, Edge or Firefox.');
      return;
    }
    const cost = creditsFor(S.script, { rate: S.rate });
    if (!store.spendCredits(cost)) {
      toast(`Not enough credits: this needs ${cost}.`, 'bad');
      showAlert(`You need ${cost} credits for this video and have ${store.getCredits()}.`, true);
      return;
    }
    stopPreview();
    setEditBox(false);
    const paid = store.getPlan().id !== 'free';
    const [w, hh] = sizeFor(S.aspect, paid ? 1080 : 720);
    const out = makeCanvas(w, hh);
    const g = out.getContext('2d');
    const mime = pickMime();
    let rec;
    let stream;
    try {
      stream = out.captureStream(30);
      rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: paid ? 8e6 : 5e6 });
    } catch (e) {
      store.addCredits(cost);
      showAlert('Recording failed to start. Your credits were refunded.');
      console.warn(e);
      return;
    }
    const chunks = [];
    const snap = { ...S, box: { ...S.box }, voice: currentVoice()?.name ?? 'none' };
    job = { out, g, w, hh, rec, stream, cost, chunks, total: res.duration + 0.25, t0: 0, cancelled: false, failed: false, stopping: false, snap, res, pages, watermark: !paid };
    const j = job;
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onerror = () => { j.failed = true; try { rec.stop(); } catch {} };
    rec.onstop = () => finishJob(j);
    drawJob(j, 0);
    rec.start(250);
    j.t0 = performance.now();
    mode = 'generate';
    progress.hidden = false;
    result.hidden = true;
    progBar.style.width = '0%';
    progPct.textContent = '0%';
    progLabel.textContent = `Rendering ${formatSeconds(j.total)} in real time…`;
    updateStats();
  }

  function drawJob(j, t) {
    const v = visemeAt(j.res, t);
    drawFrame(j.g, j.w, j.hh, { t, tl: t, shape: v.shape, wordIdx: wordIndexAt(j.res, t), captions: j.snap.captions, watermark: j.watermark, playing: true, r: j.res, pg: j.pages });
  }

  function renderJobFrame(now) {
    const j = job;
    const t = j.t0 ? (now - j.t0) / 1000 : 0;
    if (!j.stopping) {
      drawJob(j, Math.min(t, j.total));
      c2d.drawImage(j.out, 0, 0, W, H);
      highlight(wordIndexAt(j.res, t));
      const pct = Math.min(100, Math.round((t / j.total) * 100));
      progBar.style.width = `${pct}%`;
      progPct.textContent = `${pct}%`;
      progBar.parentElement.setAttribute('aria-valuenow', String(pct));
      if (t >= j.total) { j.stopping = true; progLabel.textContent = 'Finishing…'; try { j.rec.stop(); } catch { finishJob(j); } }
    }
  }

  function cancelJob() {
    const j = job;
    if (!j || j.stopping) return;
    j.cancelled = true;
    j.stopping = true;
    try { j.rec.stop(); } catch { finishJob(j); }
  }

  async function finishJob(j) {
    if (j.finished) return;
    j.finished = true;
    j.stream?.getTracks().forEach((tr) => tr.stop());
    if (job === j) job = null;
    if (mode === 'generate') mode = 'idle';
    progress.hidden = true;
    highlight(-1);
    dirty = true;
    const type = j.rec.mimeType || j.chunks[0]?.type || 'video/webm';
    const blob = new Blob(j.chunks, { type: type.split(';')[0] });
    if (j.cancelled || j.failed || !blob.size) {
      store.addCredits(j.cost);
      if (alive) {
        updateStats();
        toast(j.cancelled ? 'Render cancelled. Credits refunded.' : 'Render failed. Credits refunded.', j.cancelled ? 'info' : 'bad');
      }
      return;
    }
    // poster: a frame mid-word so the mouth is open
    const pw = j.res.words[Math.min(2, j.res.words.length - 1)];
    drawJob(j, pw ? (pw.start + pw.end) / 2 : 0.5);
    const thumb = thumbOf(j.out);
    const s = j.snap;
    let id = null;
    try {
      id = await store.saveAsset({
        type: 'speak',
        prompt: s.script,
        blob,
        thumb,
        meta: {
          avatar: s.face === 'photo' ? 'photo' : s.avatar,
          avatarName: s.face === 'photo' ? 'Your photo' : avatarById(s.avatar).name,
          voice: s.voice,
          duration: Math.round(j.total * 100) / 100,
          emotion: s.emotion,
          background: s.face === 'photo' ? 'photo' : s.bg,
          aspect: s.aspect,
          width: j.w,
          height: j.hh,
          rate: s.rate,
          pitch: s.pitch,
          captions: s.captions,
          watermark: j.watermark,
          mime: blob.type,
          credits: j.cost,
          silent: true,
        },
      });
    } catch (e) {
      console.warn(e);
    }
    if (!alive) return;
    updateStats();
    showResult(blob, thumb, s, j, id);
    toast(id ? 'Video saved to Assets.' : 'Video ready (couldn’t save to Assets).', id ? 'good' : 'info');
  }

  function showResult(blob, thumb, s, j, id) {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(blob);
    resultVideo.poster = thumb;
    resultVideo.src = resultUrl;
    resultVideo.dataset.assetId = id ?? '';
    resultMeta.textContent = `${j.w}×${j.hh} · ${formatSeconds(j.total)} · ${(blob.size / 1024 / 1024).toFixed(1)} MB`;
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    const name = `speak-${s.face === 'photo' ? 'photo' : s.avatar}-${Date.now().toString(36)}.${ext}`;
    const playVoice = h('button', { type: 'button', class: 'btn', onclick: () => {
      resultVideo.currentTime = 0;
      resultVideo.play().catch(() => {});
      const v = voices.find((x) => x.voiceURI === s.voiceURI);
      if (synth && v) {
        try {
          synth.cancel();
          const u = new SpeechSynthesisUtterance(s.script);
          u.voice = v; u.lang = v.lang; u.rate = s.rate; u.pitch = s.pitch;
          synth.speak(u);
        } catch {}
      } else toast('No voice available on this device.', 'info');
    } }, h('span', { html: ICON.play }), 'Play with voice');
    resultActions.replaceChildren(
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => download(blob, name) }, h('span', { html: ICON.download }), 'Download'),
      playVoice,
      h('a', { class: 'btn btn-ghost', href: '#/library' }, 'Open Assets'));
    result.hidden = false;
  }
  // MediaRecorder WebM files lack a duration; seek to the end once so the player's scrubber works.
  resultVideo.addEventListener('loadedmetadata', () => {
    if (resultVideo.duration === Infinity) {
      const fix = () => { resultVideo.removeEventListener('timeupdate', fix); resultVideo.currentTime = 0; };
      resultVideo.addEventListener('timeupdate', fix);
      resultVideo.currentTime = 1e7;
    }
  });
  resultVideo.addEventListener('pause', () => { try { if (synth?.speaking && mode !== 'preview') synth.cancel(); } catch {} });

  const unsubStore = store.onChange(() => updateStats());
  const onMotion = () => { dirty = true; };
  reduced?.addEventListener?.('change', onMotion);

  // start from a library image: #/speak?asset=<id>
  const assetId = ctx.params.get('asset');
  if (assetId) {
    try {
      const rec = await store.getAsset(assetId);
      if (alive && rec?.blob && rec.type === 'image') loadPhoto(URL.createObjectURL(rec.blob), 'library image');
    } catch {}
  }

  resize();
  refreshFaceUI();
  renderWords();
  updateStats();
  raf = requestAnimationFrame(tick);

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    clearTimeout(scriptTimer);
    for (const id of timers) clearTimeout(id);
    timers.clear();
    if (preview) clearInterval(preview.keepAlive);
    preview = null;
    try { synth?.cancel(); } catch {}
    synth?.removeEventListener?.('voiceschanged', onVoices);
    if (job) {
      const j = job;
      j.cancelled = true;
      j.stopping = true;
      try { j.rec.stop(); } catch { finishJob(j); }
    }
    unsubStore();
    reduced?.removeEventListener?.('change', onMotion);
    resultVideo.pause();
    resultVideo.removeAttribute('src');
    resultVideo.load();
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    if (photoThumbUrl) URL.revokeObjectURL(photoThumbUrl);
    photoCache.clear();
    workCanvases.clear();
  };
}
