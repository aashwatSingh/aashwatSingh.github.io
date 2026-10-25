// Change detection between a baseline photo and a new photo of the same spot.
//
// Pure functions over ImageData-like objects ({ width, height, data: RGBA bytes }), so it runs in
// Node tests and in the browser alike. The browser downsizes both photos to WORK_W × WORK_H first.
//
// Steps: grayscale → light blur → normalize brightness and contrast (handles lighting changes) →
// search a small shift that best lines the two up (handles a slightly different camera position;
// the ghost overlay keeps the shift small) → mean difference per block → flag blocks that stand out
// from the photo's own noise (each pixel matched within a 3×3 neighbourhood, which absorbs
// sub-pixel shifts) → join neighbouring blocks into regions.
//
// This is a stand-in for the production plan (feature matching plus a vision model). It finds
// "something here looks different", not "this is a scratch".

export const WORK_W = 192;
export const WORK_H = 144;
export const BLOCK = 8;
const MAX_SHIFT = 5;

// A block counts as changed when its mean difference (in standard deviations of the photo) is
// above both a floor and the photo's own noise level. On the demo set, unchanged items peak at
// 0.52 and the weakest planted change scores 1.62; the floor sits between with room both ways.
export const BLOCK_FLOOR = 0.75;
const NOISE_K = 6;

/** RGBA bytes → luminance (0–255) as a Float32Array. */
export function toGray({ width, height, data }) {
  const g = new Float32Array(width * height);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  return g;
}

/** 3×3 box blur with clamped edges. */
export function blur(g, w, h) {
  const out = new Float32Array(g.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy)) * w;
        for (let dx = -1; dx <= 1; dx++) s += g[yy + Math.min(w - 1, Math.max(0, x + dx))];
      }
      out[y * w + x] = s / 9;
    }
  }
  return out;
}

/** Shift to zero mean and unit standard deviation. A flat image stays all zeros. */
export function normalize(g) {
  let mean = 0;
  for (const v of g) mean += v;
  mean /= g.length || 1;
  let varSum = 0;
  for (const v of g) varSum += (v - mean) ** 2;
  const sd = Math.sqrt(varSum / (g.length || 1));
  const out = new Float32Array(g.length);
  if (sd < 1e-6) return out;
  for (let i = 0; i < g.length; i++) out[i] = (g[i] - mean) / sd;
  return out;
}

function prepare(img) {
  return normalize(blur(toGray(img), img.width, img.height));
}

/** The shift (dx, dy) of `b` that best matches `a`, by mean absolute difference over the interior. */
export function bestShift(a, b, w, h, max = MAX_SHIFT) {
  let best = { dx: 0, dy: 0, err: Infinity };
  const step = 2; // sample every other pixel; plenty for a coarse alignment
  for (let dy = -max; dy <= max; dy++) {
    for (let dx = -max; dx <= max; dx++) {
      let err = 0;
      let n = 0;
      for (let y = max; y < h - max; y += step) {
        for (let x = max; x < w - max; x += step) {
          err += Math.abs(a[y * w + x] - b[(y + dy) * w + x + dx]);
          n++;
        }
      }
      err /= n;
      // Prefer no shift on ties so identical photos report (0, 0).
      if (err < best.err - 1e-9 || (Math.abs(err - best.err) < 1e-9 && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy))) {
        best = { dx, dy, err };
      }
    }
  }
  return best;
}

/**
 * Difference at one pixel that forgives sub-pixel misalignment: each image's pixel is matched to
 * the closest value in a 3×3 neighbourhood of the other, and the larger of the two mismatches is
 * kept. A thin edge (a blind slat, a mirror frame) that moved half a pixel finds its match next
 * door; a new mark has nothing like it nearby in the baseline, so it still stands out.
 */
function pixelDiff(a, b, w, h, x, y, dx, dy) {
  const av = a[y * w + x];
  const bx = x + dx, by = y + dy;
  const bv = b[by * w + bx];
  let toB = Infinity, toA = Infinity;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const yb = Math.min(h - 1, Math.max(0, by + j)), xb = Math.min(w - 1, Math.max(0, bx + i));
      const ya = Math.min(h - 1, Math.max(0, y + j)), xa = Math.min(w - 1, Math.max(0, x + i));
      toB = Math.min(toB, Math.abs(av - b[yb * w + xb]));
      toA = Math.min(toA, Math.abs(bv - a[ya * w + xa]));
    }
  }
  return Math.max(toB, toA);
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Compare two same-size images. Returns
 * { changed, score, shift: { dx, dy }, cols, rows, blocks: Float32Array, regions: [{ x, y, w, h, strength }] }
 * with region coordinates as fractions of the image (0–1), so they can be drawn at any size.
 */
export function compare(before, after) {
  const { width: w, height: h } = before;
  if (after.width !== w || after.height !== h) throw new Error('compare() needs two images of the same size');
  const a = prepare(before);
  const b = prepare(after);
  const shift = bestShift(a, b, w, h);

  const cols = Math.floor((w - 2 * MAX_SHIFT) / BLOCK);
  const rows = Math.floor((h - 2 * MAX_SHIFT) / BLOCK);
  const blocks = new Float32Array(cols * rows);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      let s = 0;
      for (let y = 0; y < BLOCK; y++) {
        const yy = MAX_SHIFT + by * BLOCK + y;
        for (let x = 0; x < BLOCK; x++) {
          const xx = MAX_SHIFT + bx * BLOCK + x;
          s += pixelDiff(a, b, w, h, xx, yy, shift.dx, shift.dy);
        }
      }
      blocks[by * cols + bx] = s / (BLOCK * BLOCK);
    }
  }

  // Noise level: median plus a multiple of the median absolute deviation of block scores.
  const scores = Array.from(blocks);
  const med = median(scores);
  const mad = median(scores.map((v) => Math.abs(v - med)));
  const threshold = Math.max(BLOCK_FLOOR, med + NOISE_K * mad);
  const hot = scores.map((v) => v > threshold);

  // Join 4-connected hot blocks into regions.
  const seen = new Uint8Array(hot.length);
  const regions = [];
  for (let i = 0; i < hot.length; i++) {
    if (!hot[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    let x0 = cols, y0 = rows, x1 = -1, y1 = -1, strength = 0;
    while (stack.length) {
      const j = stack.pop();
      const bx = j % cols;
      const by = (j / cols) | 0;
      x0 = Math.min(x0, bx); x1 = Math.max(x1, bx);
      y0 = Math.min(y0, by); y1 = Math.max(y1, by);
      strength = Math.max(strength, blocks[j]);
      for (const [nx, ny] of [[bx - 1, by], [bx + 1, by], [bx, by - 1], [bx, by + 1]]) {
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const k = ny * cols + nx;
        if (hot[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    regions.push({
      x: (MAX_SHIFT + x0 * BLOCK) / w,
      y: (MAX_SHIFT + y0 * BLOCK) / h,
      w: ((x1 - x0 + 1) * BLOCK) / w,
      h: ((y1 - y0 + 1) * BLOCK) / h,
      strength: Math.round(strength * 100) / 100,
    });
  }
  regions.sort((p, q) => q.strength - p.strength);
  const score = regions.length ? regions[0].strength : 0;
  return { changed: regions.length > 0, score, threshold: Math.round(threshold * 100) / 100, shift: { dx: shift.dx, dy: shift.dy }, cols, rows, blocks, regions };
}
