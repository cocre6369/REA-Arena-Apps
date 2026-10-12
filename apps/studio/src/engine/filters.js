// Filter library part 1: convolution core, blur, sharpen, noise, "other".
// Each filter: { id, name, cat, defaults, apply(data, p, ctx) }  data = RGBA Uint8ClampedArray.

import { clamp, clamp01, lerp, mulberry32, fbm } from '../core/util.js';
import { luminance } from '../core/color.js';

export const FILTERS = [];
export const FILTER_BY_ID = new Map();
export function registerFilter(f) { FILTERS.push(f); FILTER_BY_ID.set(f.id, f); return f; }
export function getFilter(id) { return FILTER_BY_ID.get(id); }
export const filtersByCat = (cat) => FILTERS.filter((f) => f.cat === cat);

// ------------------------------------------------------------------ helpers
export function edges(extend) {
  return extend === 'wrap' ? wrapIdx : extend === 'mirror' ? mirrorIdx : clampIdx;
}
const clampIdx = (i, n) => (i < 0 ? 0 : i >= n ? n - 1 : i);
const wrapIdx = (i, n) => ((i % n) + n) % n;
const mirrorIdx = (i, n) => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
const idxFns = { clamp: clampIdx, wrap: wrapIdx, mirror: mirrorIdx };

/** Generic 2D convolution. kernel: Float array, size k (odd). */
export function convolve(data, w, h, kernel, k, divisor = 1, offset = 0, extend = 'clamp', preserveAlpha = true) {
  const half = (k - 1) / 2;
  const src = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) src[i] = data[i];
  const out = new Float32Array(data.length);
  const ix = idxFns[extend] || clampIdx;
  const div = divisor || kernel.reduce((a, b) => a + b, 0) || 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = 0; ky < k; ky++) {
        const yy = ix(y + ky - half, h);
        for (let kx = 0; kx < k; kx++) {
          const xx = ix(x + kx - half, w);
          const kv = kernel[ky * k + kx];
          if (!kv) continue;
          const i = (yy * w + xx) * 4;
          r += src[i] * kv; g += src[i + 1] * kv; b += src[i + 2] * kv;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / div + offset; out[o + 1] = g / div + offset; out[o + 2] = b / div + offset;
      out[o + 3] = src[o + 3];
    }
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp(out[i], 0, 255); data[i + 1] = clamp(out[i + 1], 0, 255); data[i + 2] = clamp(out[i + 2], 0, 255);
    if (!preserveAlpha) data[i + 3] = clamp(out[i + 3], 0, 255);
  }
  return data;
}

/** Fast gaussian via 3 box passes (approximation, error < 3%). */
export function boxPass(data, w, h, r, horizontal) {
  const len = horizontal ? w : h;
  const other = horizontal ? h : w;
  const tmp = new Float32Array(data.length);
  const win = r * 2 + 1;
  for (let o = 0; o < other; o++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) {
        const i = horizontal ? (o * w + clampIdx(k, w)) * 4 + c : (clampIdx(k, h) * w + o) * 4 + c;
        sum += data[i];
      }
      for (let p = 0; p < len; p++) {
        const i = horizontal ? (o * w + p) * 4 + c : (p * w + o) * 4 + c;
        tmp[i] = sum / win;
        const outI = horizontal ? (o * w + clampIdx(p - r, w)) * 4 + c : (clampIdx(p - r, h) * w + o) * 4 + c;
        const inI = horizontal ? (o * w + clampIdx(p + r + 1, w)) * 4 + c : (clampIdx(p + r + 1, h) * w + o) * 4 + c;
        sum += data[inI] - data[outI];
      }
    }
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp(tmp[i], 0, 255); data[i + 1] = clamp(tmp[i + 1], 0, 255); data[i + 2] = clamp(tmp[i + 2], 0, 255);
  }
  return data;
}
function boxesForGauss(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  return { wl, wu, m };
}
export function gaussianBlurRGBA(data, w, h, sigma) {
  if (sigma <= 0.05) return data;
  const n = 3;
  const { wl, wu, m } = boxesForGauss(sigma, n);
  const f = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) { f[i] = data[i]; f[i + 1] = data[i + 1]; f[i + 2] = data[i + 2]; f[i + 3] = data[i + 3]; }
  const copy = new Float32Array(f);
  const run = (srcF, r) => {
    const d = new Uint8ClampedArray(srcF.length);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = srcF[i]; d[i + 1] = srcF[i + 1]; d[i + 2] = srcF[i + 2]; d[i + 3] = srcF[i + 3];
    }
    boxPass(d, w, h, r, true);
    boxPass(d, w, h, r, false);
    for (let i = 0; i < d.length; i += 4) {
      srcF[i] = d[i]; srcF[i + 1] = d[i + 1]; srcF[i + 2] = d[i + 2];
    }
  };
  // three weighted box passes
  const acc = new Float32Array(f.length);
  const stage = (r, weight) => {
    const s = new Float32Array(f);
    run(s, r);
    for (let i = 0; i < acc.length; i += 4) {
      acc[i] += s[i] * weight; acc[i + 1] += s[i + 1] * weight; acc[i + 2] += s[i + 2] * weight;
    }
  };
  const wsum = m + (n - m);
  stage((wl - 1) / 2, m / wsum);
  stage((wu - 1) / 2, (n - m) / wsum);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i] = clamp(acc[i], 0, 255);
    data[i + 1] = clamp(acc[i + 1], 0, 255);
    data[i + 2] = clamp(acc[i + 2], 0, 255);
  }
  return data;
}

function copyRGBAtoF(data) {
  const f = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) f[i] = data[i];
  return f;
}
function writeFtoRGBA(f, data) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i] = clamp(f[i], 0, 255); data[i + 1] = clamp(f[i + 1], 0, 255); data[i + 2] = clamp(f[i + 2], 0, 255);
  }
}

// ------------------------------------------------------------------ blur
registerFilter({
  id: 'gaussianBlur', name: 'Gaussian Blur…', cat: 'Blur',
  defaults: { radius: 5 },
  fields: [{ key: 'radius', label: 'Radius', type: 'range', min: 0.1, max: 250, step: 0.1 }],
  apply: (d, p, c) => gaussianBlurRGBA(d, c.w, c.h, p.radius / 2),
});
registerFilter({
  id: 'boxBlur', name: 'Box Blur…', cat: 'Blur',
  defaults: { radius: 5 },
  fields: [{ key: 'radius', label: 'Radius', type: 'range', min: 1, max: 100, step: 1 }],
  apply: (d, p, c) => { boxPass(d, c.w, c.h, Math.max(1, Math.round(p.radius)), true); boxPass(d, c.w, c.h, Math.max(1, Math.round(p.radius)), false); return d; },
});
registerFilter({
  id: 'motionBlur', name: 'Motion Blur…', cat: 'Blur',
  defaults: { angle: 0, distance: 16 },
  fields: [{ key: 'angle', label: 'Angle', type: 'range', min: -90, max: 90, step: 1 },
           { key: 'distance', label: 'Distance', type: 'range', min: 1, max: 200, step: 1 }],
  apply: (d, p, c) => motionBlur(d, c.w, c.h, p.angle, p.distance),
});
registerFilter({
  id: 'radialBlur', name: 'Radial Blur…', cat: 'Blur',
  defaults: { amount: 20, mode: 'zoom', cx: 0.5, cy: 0.5 },
  fields: [{ key: 'amount', label: 'Amount', type: 'range', min: 1, max: 100, step: 1 },
           { key: 'mode', label: 'Method', type: 'select', options: [['zoom', 'Zoom'], ['spin', 'Spin']] }],
  apply: (d, p, c) => radialBlur(d, c.w, c.h, p.amount, p.mode, p.cx * c.w, p.cy * c.h),
});
registerFilter({
  id: 'surfaceBlur', name: 'Surface Blur…', cat: 'Blur',
  defaults: { radius: 6, threshold: 20 },
  fields: [{ key: 'radius', label: 'Radius', type: 'range', min: 1, max: 30, step: 1 },
           { key: 'threshold', label: 'Threshold', type: 'range', min: 1, max: 100, step: 1 }],
  apply: (d, p, c) => surfaceBlur(d, c.w, c.h, p.radius, p.threshold),
});
registerFilter({
  id: 'lensBlur', name: 'Lens Blur…', cat: 'Blur',
  defaults: { radius: 12, threshold: 200 },
  fields: [{ key: 'radius', label: 'Radius', type: 'range', min: 1, max: 60, step: 1 },
           { key: 'threshold', label: 'Brightness threshold', type: 'range', min: 0, max: 255, step: 1 }],
  apply: (d, p, c) => lensBlur(d, c.w, c.h, p.radius, p.threshold),
});
registerFilter({
  id: 'averageBlur', name: 'Average', cat: 'Blur', defaults: {},
  fields: [], apply: (d, p, c) => averageBlur(d, c.w, c.h),
});

export function motionBlur(d, w, h, angle, distance) {
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const len = Math.max(1, Math.round(distance));
  const src = copyRGBAtoF(d);
  const out = new Float32Array(d.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let t = 0; t < len; t++) {
      const xx = clamp(Math.round(x - dx * t), 0, w - 1), yy = clamp(Math.round(y - dy * t), 0, h - 1);
      const i = (yy * w + xx) * 4;
      r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
    }
    const o = (y * w + x) * 4;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
  }
  for (let i = 0; i < d.length; i += 4) { d[i] = out[i]; d[i + 1] = out[i + 1]; d[i + 2] = out[i + 2]; d[i + 3] = out[i + 3]; }
  return d;
}
export function radialBlur(d, w, h, amount, mode, cx, cy) {
  const src = copyRGBAtoF(d);
  const out = new Float32Array(d.length);
  const samples = clamp(Math.round(amount), 1, 100);
  cx = cx ?? w / 2; cy = cy ?? h / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - cx, dy = y - cy;
    const r0 = Math.hypot(dx, dy), a0 = Math.atan2(dy, dx);
    let r = 0, g = 0, b = 0, n = 0;
    for (let s = 0; s < samples; s++) {
      const t = (s / (samples - 1 || 1)) - 0.5;
      let xx, yy;
      if (mode === 'spin') {
        const a = a0 + t * (amount / 100) * 1.2;
        xx = cx + Math.cos(a) * r0; yy = cy + Math.sin(a) * r0;
      } else {
        const rr = r0 * (1 + t * (amount / 100) * 0.5);
        xx = cx + Math.cos(a0) * rr; yy = cy + Math.sin(a0) * rr;
      }
      xx = clamp(Math.round(xx), 0, w - 1); yy = clamp(Math.round(yy), 0, h - 1);
      const i = (yy * w + xx) * 4;
      r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
    }
    const o = (y * w + x) * 4;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = src[o + 3];
  }
  writeFtoRGBA(out, d);
  for (let i = 3; i < d.length; i += 4) d[i] = src[i];
  return d;
}
export function surfaceBlur(d, w, h, radius, threshold) {
  const src = copyRGBAtoF(d);
  const out = new Float32Array(d.length);
  const r = Math.max(1, Math.round(radius)), thr = threshold * 2;
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) lum[p] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = lum[y * w + x];
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const xx = clamp(x + dx, 0, w - 1), yy = clamp(y + dy, 0, h - 1);
      if (Math.abs(lum[yy * w + xx] - c) > thr) continue;
      const i = (yy * w + xx) * 4;
      sr += src[i]; sg += src[i + 1]; sb += src[i + 2]; n++;
    }
    const o = (y * w + x) * 4;
    if (n) { out[o] = sr / n; out[o + 1] = sg / n; out[o + 2] = sb / n; }
    else { out[o] = src[o]; out[o + 1] = src[o + 1]; out[o + 2] = src[o + 2]; }
    out[o + 3] = src[o + 3];
  }
  for (let i = 0; i < d.length; i += 4) { d[i] = out[i]; d[i + 1] = out[i + 1]; d[i + 2] = out[i + 2]; d[i + 3] = out[i + 3]; }
  return d;
}
export function lensBlur(d, w, h, radius, threshold) {
  const src = copyRGBAtoF(d);
  const out = new Float32Array(d.length);
  const r = Math.max(1, Math.round(radius));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i0 = (y * w + x) * 4;
    const l0 = 0.299 * src[i0] + 0.587 * src[i0 + 1] + 0.114 * src[i0 + 2];
    const spread = l0 >= threshold ? r * 1.6 : r * 0.35;
    let sr = 0, sg = 0, sb = 0, n = 0, wsum = 0;
    const rr = Math.ceil(spread);
    for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
      const dd = Math.hypot(dx, dy);
      if (dd > spread) continue;
      const xx = clamp(x + dx, 0, w - 1), yy = clamp(y + dy, 0, h - 1);
      const wt = 1 - dd / (spread + 1e-6) * 0.5;
      const i = (yy * w + xx) * 4;
      sr += src[i] * wt; sg += src[i + 1] * wt; sb += src[i + 2] * wt; wsum += wt; n++;
    }
    const o = i0;
    out[o] = wsum ? sr / wsum : src[o];
    out[o + 1] = wsum ? sg / wsum : src[o + 1];
    out[o + 2] = wsum ? sb / wsum : src[o + 2];
    out[o + 3] = src[o + 3];
  }
  for (let i = 0; i < d.length; i += 4) { d[i] = out[i]; d[i + 1] = out[i + 1]; d[i + 2] = out[i + 2]; d[i + 3] = out[i + 3]; }
  return d;
}
export function averageBlur(d, w, h) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  if (!n) return d;
  r /= n; g /= n; b /= n;
  for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue; d[i] = r; d[i + 1] = g; d[i + 2] = b; }
  return d;
}

// ------------------------------------------------------------------ sharpen
const K_SHARPEN = [0, -1, 0, -1, 5, -1, 0, -1, 0];
const K_SHARPEN_MORE = [-1, -1, -1, -1, 9, -1, -1, -1, -1];
const K_EDGES = [0, 1, 0, 1, -4, 1, 0, 1, 0];
const K_EMBOSS = [-2, -1, 0, -1, 1, 1, 0, 1, 2];

registerFilter({ id: 'sharpen', name: 'Sharpen', cat: 'Sharpen', defaults: {}, fields: [],
  apply: (d, p, c) => convolve(d, c.w, c.h, K_SHARPEN, 3) });
registerFilter({ id: 'sharpenMore', name: 'Sharpen More', cat: 'Sharpen', defaults: {}, fields: [],
  apply: (d, p, c) => convolve(d, c.w, c.h, K_SHARPEN_MORE, 3) });
registerFilter({ id: 'sharpenEdges', name: 'Sharpen Edges', cat: 'Sharpen', defaults: {}, fields: [],
  apply: (d, p, c) => convolve(d, c.w, c.h, K_EDGES, 3, 1, 128) });
registerFilter({
  id: 'unsharpMask', name: 'Unsharp Mask…', cat: 'Sharpen',
  defaults: { amount: 80, radius: 2, threshold: 2 },
  fields: [{ key: 'amount', label: 'Amount', type: 'range', min: 1, max: 500, step: 1 },
           { key: 'radius', label: 'Radius', type: 'range', min: 0.1, max: 100, step: 0.1 },
           { key: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 128, step: 1 }],
  apply: (d, p, c) => unsharpMask(d, c.w, c.h, p.amount / 100, p.radius, p.threshold),
});
export function unsharpMask(d, w, h, amount, radius, threshold) {
  const blur = new Uint8ClampedArray(d);
  gaussianBlurRGBA(blur, w, h, radius);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    for (let k = 0; k < 3; k++) {
      const diff = d[i + k] - blur[i + k];
      if (Math.abs(diff) > threshold) d[i + k] = clamp(d[i + k] + diff * amount, 0, 255);
    }
  }
  return d;
}

// ------------------------------------------------------------------ noise
registerFilter({
  id: 'addNoise', name: 'Add Noise…', cat: 'Noise',
  defaults: { amount: 12, distribution: 'uniform', mono: false },
  fields: [{ key: 'amount', label: 'Amount', type: 'range', min: 1, max: 200, step: 1 },
           { key: 'distribution', label: 'Distribution', type: 'select', options: [['uniform', 'Uniform'], ['gaussian', 'Gaussian']] },
           { key: 'mono', label: 'Monochromatic', type: 'check' }],
  apply: (d, p, c) => addNoise(d, c.w, c.h, p.amount, p.distribution, p.mono, c.seed || 1),
});
registerFilter({ id: 'despeckle', name: 'Despeckle', cat: 'Noise', defaults: {}, fields: [],
  apply: (d, p, c) => medianFilter(d, c.w, c.h, 1) });
registerFilter({
  id: 'median', name: 'Median…', cat: 'Noise',
  defaults: { radius: 2 },
  fields: [{ key: 'radius', label: 'Radius', type: 'range', min: 1, max: 12, step: 1 }],
  apply: (d, p, c) => medianFilter(d, c.w, c.h, p.radius),
});
registerFilter({
  id: 'dustScratches', name: 'Dust & Scratches…', cat: 'Noise',
  defaults: { radius: 4, threshold: 16 },
  fields: [{ key: 'radius', label: 'Radius', type: 'range', min: 1, max: 16, step: 1 },
           { key: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 128, step: 1 }],
  apply: (d, p, c) => dustScratches(d, c.w, c.h, p.radius, p.threshold),
});
registerFilter({
  id: 'reduceNoise', name: 'Reduce Noise…', cat: 'Noise',
  defaults: { strength: 6, preserve: 40, sharpen: 25 },
  fields: [{ key: 'strength', label: 'Strength', type: 'range', min: 0, max: 10, step: 1 },
           { key: 'preserve', label: 'Preserve detail', type: 'range', min: 0, max: 100, step: 1 },
           { key: 'sharpen', label: 'Sharpen detail', type: 'range', min: 0, max: 100, step: 1 }],
  apply: (d, p, c) => reduceNoise(d, c.w, c.h, p.strength, p.preserve, p.sharpen),
});

export function addNoise(d, w, h, amount, dist, mono, seed) {
  const rnd = mulberry32(seed);
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const gen = () => (dist === 'gaussian' ? gauss() * 0.35 : rnd() - 0.5) * amount * 2.55;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    if (mono) { const n = gen(); d[i] = clamp(d[i] + n, 0, 255); d[i + 1] = clamp(d[i + 1] + n, 0, 255); d[i + 2] = clamp(d[i + 2] + n, 0, 255); }
    else { d[i] = clamp(d[i] + gen(), 0, 255); d[i + 1] = clamp(d[i + 1] + gen(), 0, 255); d[i + 2] = clamp(d[i + 2] + gen(), 0, 255); }
  }
  return d;
}
export function medianFilter(d, w, h, radius) {
  const src = new Uint8ClampedArray(d);
  const r = Math.max(1, Math.round(radius));
  const buf = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      buf.length = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r + r) continue;
        const i = (clamp(y + dy, 0, h - 1) * w + clamp(x + dx, 0, w - 1)) * 4;
        buf.push(src[i + c]);
      }
      buf.sort((a, b) => a - b);
      d[(y * w + x) * 4 + c] = buf[buf.length >> 1];
    }
  }
  return d;
}
export function dustScratches(d, w, h, radius, threshold) {
  const src = new Uint8ClampedArray(d);
  const r = Math.max(1, Math.round(radius));
  const buf = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      const pv = src[o + c];
      buf.length = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r + r) continue;
        const i = (clamp(y + dy, 0, h - 1) * w + clamp(x + dx, 0, w - 1)) * 4;
        buf.push(src[i + c]);
      }
      buf.sort((a, b) => a - b);
      const med = buf[buf.length >> 1];
      d[o + c] = Math.abs(pv - med) > threshold ? med : pv;
    }
  }
  return d;
}
export function reduceNoise(d, w, h, strength, preserve, sharpen) {
  const src = copyRGBAtoF(d);
  const out = new Float32Array(d.length);
  const sS = strength * 0.6 + 0.4, sR = (100 - preserve) / 100 * 60 + 5;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    let sr = 0, sg = 0, sb = 0, wsum = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = clamp(x + dx, 0, w - 1), yy = clamp(y + dy, 0, h - 1);
      const i = (yy * w + xx) * 4;
      const cd = Math.hypot(src[i] - src[o], src[i + 1] - src[o + 1], src[i + 2] - src[o + 2]);
      const wg = Math.exp(-(cd * cd) / (2 * sR * sR)) * Math.exp(-(dx * dx + dy * dy) / (2 * sS * sS));
      sr += src[i] * wg; sg += src[i + 1] * wg; sb += src[i + 2] * wg; wsum += wg;
    }
    out[o] = wsum ? sr / wsum : src[o];
    out[o + 1] = wsum ? sg / wsum : src[o + 1];
    out[o + 2] = wsum ? sb / wsum : src[o + 2];
    out[o + 3] = src[o + 3];
  }
  if (sharpen > 0) for (let i = 0; i < out.length; i += 4) {
    const amt = (sharpen / 100) * 0.5;
    for (let k = 0; k < 3; k++) out[i + k] = clamp(src[i + k] + (src[i + k] - out[i + k]) * amt, 0, 255);
  }
  for (let i = 0; i < d.length; i += 4) { d[i] = out[i]; d[i + 1] = out[i + 1]; d[i + 2] = out[i + 2]; }
  return d;
}

// ------------------------------------------------------------------ other
registerFilter({
  id: 'highPass', name: 'High Pass…', cat: 'Other',
  defaults: { radius: 6 },
  fields: [{ key: 'radius', label: 'Radius', type: 'range', min: 0.1, max: 200, step: 0.1 }],
  apply: (d, p, c) => highPass(d, c.w, c.h, p.radius),
});
export function highPass(d, w, h, radius) {
  const blur = new Uint8ClampedArray(d);
  gaussianBlurRGBA(blur, w, h, radius);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    d[i] = clamp(d[i] - blur[i] + 128, 0, 255);
    d[i + 1] = clamp(d[i + 1] - blur[i + 1] + 128, 0, 255);
    d[i + 2] = clamp(d[i + 2] - blur[i + 2] + 128, 0, 255);
  }
  return d;
}
registerFilter({
  id: 'offset', name: 'Offset…', cat: 'Other',
  defaults: { dx: 20, dy: 20, wrap: true },
  fields: [{ key: 'dx', label: 'Horizontal', type: 'number' },
           { key: 'dy', label: 'Vertical', type: 'number' },
           { key: 'wrap', label: 'Wrap around', type: 'check' }],
  apply: (d, p, c) => offsetFilter(d, c.w, c.h, p.dx, p.dy, p.wrap),
});
export function offsetFilter(d, w, h, dx, dy, wrap) {
  const src = new Uint8ClampedArray(d);
  const ix = wrap ? ((i, n) => ((i % n) + n) % n) : (i, n) => (i < 0 || i >= n ? -1 : i);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = ix(x - dx, w), sy = ix(y - dy, h);
    const o = (y * w + x) * 4;
    if (sx < 0 || sy < 0) { d[o] = d[o + 1] = d[o + 2] = d[o + 3] = 0; continue; }
    const i = (sy * w + sx) * 4;
    d[o] = src[i]; d[o + 1] = src[i + 1]; d[o + 2] = src[i + 2]; d[o + 3] = src[i + 3];
  }
  return d;
}
function morph(d, w, h, radius, isMax) {
  const src = new Uint8ClampedArray(d);
  const r = Math.max(1, Math.round(radius));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      let v = src[o + c];
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const i = (clamp(y + dy, 0, h - 1) * w + clamp(x + dx, 0, w - 1)) * 4;
        if (isMax) { if (src[i + c] > v) v = src[i + c]; } else if (src[i + c] < v) v = src[i + c];
      }
      d[o + c] = v;
    }
  }
  return d;
}
registerFilter({ id: 'maximum', name: 'Maximum…', cat: 'Other', defaults: { radius: 2 },
  fields: [{ key: 'radius', label: 'Radius', type: 'range', min: 1, max: 12, step: 1 }],
  apply: (d, p, c) => morph(d, c.w, c.h, p.radius, true) });
registerFilter({ id: 'minimum', name: 'Minimum…', cat: 'Other', defaults: { radius: 2 },
  fields: [{ key: 'radius', label: 'Radius', type: 'range', min: 1, max: 12, step: 1 }],
  apply: (d, p, c) => morph(d, c.w, c.h, p.radius, false) });
registerFilter({
  id: 'custom', name: 'Custom…', cat: 'Other',
  defaults: { k: [0, 0, 0, 0, 1, 0, 0, 0, 0], scale: 1, offset: 0 },
  fields: [{ key: 'matrix', label: 'Kernel (5×5)', type: 'matrix', size: 5 }],
  apply: (d, p, c) => {
    const m = p.matrix || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    return convolve(d, c.w, c.h, m, 5, p.scale || 1, p.offset || 0);
  },
});
