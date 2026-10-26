// Browser-side image plumbing: decode photos, shrink them for comparison, re-encode uploads,
// and cache comparison results.

import { compare, WORK_W, WORK_H } from './core/diff.js';
import { getPhoto } from './store.js';

export const MAX_SIDE = 1280;
export const JPEG_QUALITY = 0.85;

/** Decode a Blob into something drawImage accepts. */
export async function decode(blob) {
  if ('createImageBitmap' in window) return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = JPEG_QUALITY) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the photo'))), type, quality));
}

/** Scale (w, h) down so the longer side is at most `max`. */
export function fit(w, h, max = MAX_SIDE) {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

/** Re-encode an uploaded file as a JPEG no larger than MAX_SIDE. Returns { blob, width, height }. */
export async function normalizeUpload(file) {
  const img = await decode(file);
  const { w, h } = fit(img.width, img.height);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  img.close?.();
  return { blob: await canvasToBlob(c), width: w, height: h };
}

/**
 * A photo shrunk to the comparison size, as ImageData. It shrinks in two smoothed steps: one big
 * jump aliases fine repeating detail (blind slats, tile grout) into moiré that moves with the
 * camera and looks like change.
 */
async function workData(hash) {
  const rec = await getPhoto(hash);
  if (!rec) return null;
  const img = await decode(rec.blob);
  const mid = document.createElement('canvas');
  mid.width = WORK_W * 2;
  mid.height = WORK_H * 2;
  const m = mid.getContext('2d');
  m.imageSmoothingQuality = 'high';
  m.drawImage(img, 0, 0, mid.width, mid.height);
  img.close?.();
  const c = document.createElement('canvas');
  c.width = WORK_W;
  c.height = WORK_H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mid, 0, 0, WORK_W, WORK_H);
  return ctx.getImageData(0, 0, WORK_W, WORK_H);
}

const diffCache = new Map();

/** compare() for two stored photos, cached by the pair of hashes. Null if either is missing. */
export async function diffPhotos(beforeHash, afterHash) {
  const key = `${beforeHash}:${afterHash}`;
  if (diffCache.has(key)) return diffCache.get(key);
  const [a, b] = await Promise.all([workData(beforeHash), workData(afterHash)]);
  const result = a && b ? compare(a, b) : null;
  diffCache.set(key, result);
  return result;
}

export function clearDiffCache() {
  diffCache.clear();
}
