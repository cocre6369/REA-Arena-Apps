// Filter library part 2: distort, stylize, pixelate, render.

import { clamp, clamp01, lerp, mulberry32, fbm, hashSeed, TAU } from '../core/util.js';
import { luminance, rgbToHsl, hslToRgb, rgbToHsv, hsvToRgb } from '../core/color.js';
import { registerFilter, convolve, gaussianBlurRGBA } from './filters.js';

const clampI = (v, a, b) => (v < a ? a : v > b ? b : v);

// generic remap: fn(x,y) -> [sx,sy] in source space, bilinear sample
function remap(d, w, h, fn) {
  const src = new Uint8ClampedArray(d);
  const sample = (fx, fy, c) => {
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const xa = clampI(x0, 0, w - 1), xb = clampI(x0 + 1, 0, w - 1);
    const ya = clampI(y0, 0, h - 1), yb = clampI(y0 + 1, 0, h - 1);
    const p00 = src[(ya * w + xa) * 4 + c], p10 = src[(ya * w + xb) * 4 + c];
    const p01 = src[(yb * w + xa) * 4 + c], p11 = src[(yb * w + xb) * 4 + c];
    return lerp(lerp(p00, p10, tx), lerp(p01, p11, tx), ty);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [sx, sy] = fn(x, y);
    const o = (y * w + x) * 4;
    d[o] = sample(sx, sy, 0); d[o + 1] = sample(sx, sy, 1); d[o + 2] = sample(sx, sy, 2);
  }
  return d;
}

// ------------------------------------------------------------------ distort
registerFilter({
  id: 'wave', name: 'Wave…', cat: 'Distort',
  defaults: { generators: 3, waveLength: 40, amplitude: 20, scale: 100, type: 'sine' },
  fields: [{ key: 'generators', label: 'Generators', type: 'range', min: 1, max: 20, step: 1 },
           { key: 'waveLength', label: 'Wavelength', type: 'range', min: 1, max: 200, step: 1 },
           { key: 'amplitude', label: 'Amplitude', type: 'range', min: 0, max: 200, step: 1 },
           { key: 'scale', label: 'Scale', type: 'range', min: 0, max: 200, step: 1 },
           { key: 'type', label: 'Type', type: 'select', options: [['sine', 'Sine'], ['triangle', 'Triangle'], ['square', 'Square']] }],
  apply: (d, p, c) => {
    const { w, h } = c;
    const seed = c.seed || 1;
    const rnd = mulberry32(hashSeed('wave' + seed));
    const gens = [];
    const wl = Math.max(1, p.waveLength), amp = p.amplitude, sc = p.scale / 100;
    for (let i = 0; i < p.generators; i++) {
      gens.push({ wl: wl * (0.5 + rnd()), amp: amp * (0.4 + rnd() * 0.8), sc: sc, phase: rnd() * TAU, dir: rnd() > 0.5 ? 1 : 0 });
    }
    const waveFn = (t, type) => {
      t = t / TAU;
      if (type === 'triangle') { const f = ((t % 1) + 1) % 1; return f < 0.5 ? f * 4 - 1 : 3 - f * 4; }
      if (type === 'square') { const f = ((t % 1) + 1) % 1; return f < 0.5 ? 1 : -1; }
      return Math.sin(t * TAU);
    };
    return remap(d, w, h, (x, y) => {
      let dx = 0, dy = 0;
      for (const g of gens) {
        const wlX = g.wl * g.sc * 2, wlY = g.wl * g.sc * 2;
        if (g.dir) dx += waveFn((x / (wlX || 1)) * TAU + g.phase, p.type) * g.amp;
        else dy += waveFn((y / (wlY || 1)) * TAU + g.phase, p.type) * g.amp;
      }
      return [x - dx, y - dy];
    });
  },
});
registerFilter({
  id: 'ripple', name: 'Ripple…', cat: 'Distort',
  defaults: { amount: 30, size: 'medium' },
  fields: [{ key: 'amount', label: 'Amount', type: 'range', min: -300, max: 300, step: 1 },
           { key: 'size', label: 'Size', type: 'select', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] }],
  apply: (d, p, c) => {
    const sizeN = p.size === 'small' ? 12 : p.size === 'large' ? 40 : 24;
    const { w, h } = c;
    return remap(d, w, h, (x, y) => {
      const dx = x - w / 2, dy = y - h / 2;
      const r = Math.hypot(dx, dy);
      const t = Math.sin((r / sizeN) * TAU);
      const k = (p.amount / 100) * sizeN * 0.5 * t / (1 + r * 0.02);
      return [x + (dx / (r || 1)) * k, y + (dy / (r || 1)) * k];
    });
  },
});
registerFilter({
  id: 'pinch', name: 'Pinch…', cat: 'Distort',
  defaults: { amount: 50 },
  fields: [{ key: 'amount', label: 'Amount', type: 'range', min: -100, max: 100, step: 1 }],
  apply: (d, p, c) => {
    const { w, h } = c, cx = w / 2, cy = h / 2, a = p.amount / 100;
    const maxR = Math.hypot(cx, cy);
    return remap(d, w, h, (x, y) => {
      const dx = (x - cx) / cx, dy = (y - cy) / cy;
      const r = Math.hypot(dx, dy);
      if (r < 1e-6) return [x, y];
      const k = Math.pow(r, 1 + a) / r;
      return [cx + dx * cx * k, cy + dy * cy * k];
    });
  },
});
registerFilter({
  id: 'spherize', name: 'Spherize…', cat: 'Distort',
  defaults: { amount: 100 },
  fields: [{ key: 'amount', label: 'Amount', type: 'range', min: -100, max: 100, step: 1 }],
  apply: (d, p, c) => {
    const { w, h } = c, cx = w / 2, cy = h / 2, a = p.amount / 100;
    const rmax = Math.min(cx, cy);
    return remap(d, w, h, (x, y) => {
      const dx = x - cx, dy = y - cy;
      const r = Math.hypot(dx, dy);
      if (r > rmax || r < 1e-6) return [x, y];
      const theta = Math.asin(r / rmax);
      const nr = Math.sin(theta * (1 - a * 0.999)) * rmax;
      const k = nr / r;
      return [cx + dx * k, cy + dy * k];
    });
  },
});
registerFilter({
  id: 'twirl', name: 'Twirl…', cat: 'Distort',
  defaults: { angle: 120 },
  fields: [{ key: 'angle', label: 'Angle', type: 'range', min: -999, max: 999, step: 1 }],
  apply: (d, p, c) => {
    const { w, h } = c, cx = w / 2, cy = h / 2;
    const ang = (p.angle * Math.PI) / 180;
    const rmax = Math.hypot(cx, cy);
    return remap(d, w, h, (x, y) => {
      const dx = x - cx, dy = y - cy;
      const r = Math.hypot(dx, dy);
      const theta = Math.atan2(dy, dx);
      const t = 1 - r / rmax;
      const nt = theta + ang * t * t;
      return [cx + Math.cos(nt) * r, cy + Math.sin(nt) * r];
    });
  },
});
registerFilter({
  id: 'zigzag', name: 'ZigZag…', cat: 'Distort',
  defaults: { amount: 30, ridges: 8, style: 'around' },
  fields: [{ key: 'amount', label: 'Amount', type: 'range', min: -100, max: 100, step: 1 },
           { key: 'ridges', label: 'Ridges', type: 'range', min: 1, max: 20, step: 1 },
           { key: 'style', label: 'Style', type: 'select', options: [['around', 'Around center'], ['out', 'Out from center'], ['pond', 'Pond ripples']] }],
  apply: (d, p, c) => {
    const { w, h } = c, cx = w / 2, cy = h / 2, ridges = Math.max(1, p.ridges), amt = p.amount / 100;
    const rmax = Math.hypot(cx, cy);
    return remap(d, w, h, (x, y) => {
      const dx = x - cx, dy = y - cy;
      const r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
      let nr = r, na = a;
      if (p.style === 'around') {
        na = a + Math.sin((r / rmax) * TAU * ridges) * amt;
      } else if (p.style === 'out') {
        nr = r * (1 + Math.sin(a * ridges) * amt * 0.5);
      } else {
        nr = r + Math.sin((r / rmax) * TAU * ridges) * amt * rmax * 0.08;
      }
      return [cx + Math.cos(na) * nr, cy + Math.sin(na) * nr];
    });
  },
});
registerFilter({
  id: 'polar', name: 'Polar Coordinates…', cat: 'Distort',
  defaults: { mode: 'rectToPolar' },
  fields: [{ key: 'mode', label: 'Mode', type: 'select', options: [['rectToPolar', 'Rectangular to Polar'], ['polarToRect', 'Polar to Rectangular']] }],
  apply: (d, p, c) => {
    const { w, h } = c, cx = w / 2, cy = h / 2, rmax = Math.hypot(cx, cy);
    return remap(d, w, h, (x, y) => {
      if (p.mode === 'rectToPolar') {
        const nx = (x / w), ny = (y / h);
        const r = ny * rmax, a = nx * TAU - Math.PI;
        return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
      }
      const dx = x - cx, dy = y - cy;
      const r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
      return [((a + Math.PI) / TAU) * w, (r / rmax) * h];
    });
  },
});
registerFilter({
  id: 'shear', name: 'Shear…', cat: 'Distort',
  defaults: { x: 10, y: 0, wrap: true },
  fields: [{ key: 'x', label: 'Horizontal', type: 'range', min: -100, max: 100, step: 1 },
           { key: 'y', label: 'Vertical', type: 'range', min: -100, max: 100, step: 1 },
           { key: 'wrap', label: 'Wrap around', type: 'check' }],
  apply: (d, p, c) => {
    const { w, h } = c;
    const ix = p.wrap ? (i, n) => ((i % n) + n) % n : (i, n) => i;
    return remap(d, w, h, (x, y) => [ix(x - (p.x / 100) * (y / h) * w, w), ix(y - (p.y / 100) * (x / w) * h, h)]);
  },
});

// ------------------------------------------------------------------ stylize
registerFilter({
  id: 'emboss', name: 'Emboss…', cat: 'Stylize',
  defaults: { angle: 135, height: 3, amount: 100 },
  fields: [{ key: 'angle', label: 'Angle', type: 'range', min: -180, max: 180, step: 1 },
           { key: 'height', label: 'Height', type: 'range', min: 1, max: 10, step: 1 },
           { key: 'amount', label: 'Amount', type: 'range', min: 1, max: 500, step: 1 }],
  apply: (d, p, c) => {
    const a = (p.angle * Math.PI) / 180;
    const dx = Math.cos(a) * p.height, dy = Math.sin(a) * p.height;
    const src = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) src[i] = d[i];
    const amt = p.amount / 100;
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const i = (y * c.w + x) * 4;
      const sx = clampI(Math.round(x - dx), 0, c.w - 1), sy = clampI(Math.round(y - dy), 0, c.h - 1);
      const j = (sy * c.w + sx) * 4;
      const v = (src[i] - src[j]) * amt + 128;
      d[i] = d[i + 1] = d[i + 2] = clamp(v, 0, 255);
    }
    return d;
  },
});
registerFilter({ id: 'findEdges', name: 'Find Edges', cat: 'Stylize', defaults: {}, fields: [],
  apply: (d, p, c) => {
    const src = new Float32Array(d.length);
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      src[i] = src[i + 1] = src[i + 2] = g;
    }
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const i = (y * c.w + x) * 4;
      const l = src[(y * c.w + clampI(x - 1, 0, c.w - 1)) * 4];
      const r = src[(y * c.w + clampI(x + 1, 0, c.w - 1)) * 4];
      const u = src[(clampI(y - 1, 0, c.h - 1) * c.w + x) * 4];
      const dn = src[(clampI(y + 1, 0, c.h - 1) * c.w + x) * 4];
      const v = clamp(255 - Math.min(255, (Math.abs(r - l) + Math.abs(dn - u)) * 1.2), 0, 255);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    return d;
  } });
registerFilter({ id: 'solarize', name: 'Solarize', cat: 'Stylize', defaults: {}, fields: [],
  apply: (d) => {
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      for (let k = 0; k < 3; k++) d[i + k] = d[i + k] < 128 ? 255 - d[i + k] : d[i + k];
    }
    return d;
  } });
registerFilter({
  id: 'glowingEdges', name: 'Glowing Edges…', cat: 'Stylize',
  defaults: { width: 3, brightness: 8, smoothness: 5 },
  fields: [{ key: 'width', label: 'Edge width', type: 'range', min: 1, max: 14, step: 1 },
           { key: 'brightness', label: 'Edge brightness', type: 'range', min: 0, max: 20, step: 1 },
           { key: 'smoothness', label: 'Smoothness', type: 'range', min: 0, max: 15, step: 1 }],
  apply: (d, p, c) => {
    // edge magnitude
    const mag = new Float32Array(c.w * c.h);
    const src = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) src[i] = d[i];
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const i = (y * c.w + x) * 4;
      const l = src[(y * c.w + clampI(x - 1, 0, c.w - 1)) * 4], r = src[(y * c.w + clampI(x + 1, 0, c.w - 1)) * 4];
      const u = src[(clampI(y - 1, 0, c.h - 1) * c.w + x) * 4], dn = src[(clampI(y + 1, 0, c.h - 1) * c.w + x) * 4];
      mag[y * c.w + x] = Math.min(255, (Math.abs(r - l) + Math.abs(dn - u)));
    }
    // dilate
    const w2 = Math.max(1, Math.round(p.width));
    const dil = new Float32Array(mag);
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      let m = 0;
      for (let dy = -w2; dy <= w2; dy++) for (let dx = -w2; dx <= w2; dx++) {
        const v = mag[clampI(y + dy, 0, c.h - 1) * c.w + clampI(x + dx, 0, c.w - 1)];
        if (v > m) m = v;
      }
      dil[y * c.w + x] = m;
    }
    for (let i = 0; i < dil.length; i++) dil[i] = Math.min(255, dil[i] * (p.brightness / 5));
    // invert + glow on black
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const o = (y * c.w + x) * 4;
      const v = 255 - clamp(dil[y * c.w + x], 0, 255);
      const hue = 200 + (1 - v / 255) * 60;
      const rgb = hslToRgb(hue, 1, (v / 255) * 0.6);
      d[o] = rgb[0] * 255; d[o + 1] = rgb[1] * 255; d[o + 2] = rgb[2] * 255;
    }
    if (p.smoothness > 0) gaussianBlurRGBA(d, c.w, c.h, p.smoothness * 0.4);
    return d;
  },
});
registerFilter({
  id: 'neonGlow', name: 'Neon Glow…', cat: 'Stylize',
  defaults: { glow: 8, brightness: 15, hue: 300, saturation: 100 },
  fields: [{ key: 'glow', label: 'Glow size', type: 'range', min: -24, max: 24, step: 1 },
           { key: 'brightness', label: 'Glow brightness', type: 'range', min: 0, max: 50, step: 1 },
           { key: 'hue', label: 'Glow colour hue', type: 'range', min: 0, max: 360, step: 1 },
           { key: 'saturation', label: 'Glow saturation', type: 'range', min: 0, max: 100, step: 1 }],
  apply: (d, p, c) => {
    const mag = new Float32Array(c.w * c.h);
    const src = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) src[i] = d[i];
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const i = (y * c.w + x) * 4;
      const l = src[(y * c.w + clampI(x - 1, 0, c.w - 1)) * 4], r = src[(y * c.w + clampI(x + 1, 0, c.w - 1)) * 4];
      const u = src[(clampI(y - 1, 0, c.h - 1) * c.w + x) * 4], dn = src[(clampI(y + 1, 0, c.h - 1) * c.w + x) * 4];
      mag[y * c.w + x] = Math.min(255, Math.abs(r - l) + Math.abs(dn - u));
    }
    const glowRGB = hslToRgb(p.hue, p.saturation / 100, 0.5);
    const amount = p.brightness / 20;
    const spread = Math.abs(p.glow);
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const o = (y * c.w + x) * 4;
      if (!d[o + 3]) continue;
      let m = 0;
      for (let dy = -spread; dy <= spread; dy++) for (let dx = -spread; dx <= spread; dx++) {
        const v = mag[clampI(y + dy, 0, c.h - 1) * c.w + clampI(x + dx, 0, c.w - 1)];
        if (v > m) m = v;
      }
      const g = (m / 255) * amount;
      if (p.glow > 0) {
        d[o] = clamp(lerp(d[o], glowRGB[0] * 255, g * 0.85), 0, 255);
        d[o + 1] = clamp(lerp(d[o + 1], glowRGB[1] * 255, g * 0.85), 0, 255);
        d[o + 2] = clamp(lerp(d[o + 2], glowRGB[2] * 255, g * 0.85), 0, 255);
      } else {
        d[o] = clamp(d[o] * (1 - g * 0.6) + glowRGB[0] * 255 * g * 0.4, 0, 255);
        d[o + 1] = clamp(d[o + 1] * (1 - g * 0.6) + glowRGB[1] * 255 * g * 0.4, 0, 255);
        d[o + 2] = clamp(d[o + 2] * (1 - g * 0.6) + glowRGB[2] * 255 * g * 0.4, 0, 255);
      }
    }
    return d;
  },
});
registerFilter({
  id: 'oilPaint', name: 'Oil Paint…', cat: 'Stylize',
  defaults: { stylization: 4, cleanliness: 4, scale: 2, detail: 2 },
  fields: [{ key: 'stylization', label: 'Stylization', type: 'range', min: 1, max: 10, step: 1 },
           { key: 'cleanliness', label: 'Cleanliness', type: 'range', min: 1, max: 10, step: 1 },
           { key: 'scale', label: 'Scale', type: 'range', min: 1, max: 6, step: 1 },
           { key: 'detail', label: 'Bristle detail', type: 'range', min: 1, max: 6, step: 1 }],
  apply: (d, p, c) => {
    const radius = p.stylization * p.scale;
    const bins = Math.max(3, Math.round(p.cleanliness * 5));
    const src = new Uint8ClampedArray(d);
    const out = new Uint8ClampedArray(d);
    const r = Math.max(1, Math.round(radius));
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const o = (y * c.w + x) * 4;
      if (!src[o + 3]) continue;
      const inten = new Int32Array(bins);
      const sr = new Float32Array(bins), sg = new Float32Array(bins), sb = new Float32Array(bins), cnt = new Int32Array(bins);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const xx = clampI(x + dx, 0, c.w - 1), yy = clampI(y + dy, 0, c.h - 1);
        const i = (yy * c.w + xx) * 4;
        const lum = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
        const b = Math.min(bins - 1, Math.floor((lum / 256) * bins));
        inten[b]++; sr[b] += src[i]; sg[b] += src[i + 1]; sb[b] += src[i + 2]; cnt[b]++;
      }
      let best = 0;
      for (let b = 1; b < bins; b++) if (inten[b] > inten[best]) best = b;
      if (cnt[best]) {
        out[o] = sr[best] / cnt[best]; out[o + 1] = sg[best] / cnt[best]; out[o + 2] = sb[best] / cnt[best]; out[o + 3] = src[o + 3];
      }
    }
    d.set(out);
    if (p.detail > 1) {
      // subtle edge restoration
      const s2 = new Uint8ClampedArray(d);
      for (let y = 1; y < c.h - 1; y++) for (let x = 1; x < c.w - 1; x++) {
        const o = (y * c.w + x) * 4;
        for (let k = 0; k < 3; k++) {
          const g = Math.abs(s2[o + 4 + k] - s2[o + k]) + Math.abs(s2[o + c.w * 4 + k] - s2[o + k]);
          d[o + k] = clamp(d[o + k] + g * (p.detail - 1) * 0.25, 0, 255);
        }
      }
    }
    return d;
  },
});
registerFilter({
  id: 'diffuse', name: 'Diffuse…', cat: 'Stylize',
  defaults: { mode: 'normal', amount: 6 },
  fields: [{ key: 'mode', label: 'Mode', type: 'select', options: [['normal', 'Normal'], ['anisotropic', 'Anisotropic'], ['darken', 'Darken only'], ['lighten', 'Lighten only']] },
           { key: 'amount', label: 'Amount', type: 'range', min: 1, max: 30, step: 1 }],
  apply: (d, p, c) => {
    const rnd = mulberry32(c.seed || 7);
    const src = new Uint8ClampedArray(d);
    const a = p.amount;
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const o = (y * c.w + x) * 4;
      if (!src[o + 3]) continue;
      let nx, ny;
      if (p.mode === 'anisotropic') { nx = x + Math.round((rnd() - 0.5) * a * 2); ny = y; }
      else { nx = x + Math.round((rnd() - 0.5) * a * 2); ny = y + Math.round((rnd() - 0.5) * a * 2); }
      const i = (clampI(ny, 0, c.h - 1) * c.w + clampI(nx, 0, c.w - 1)) * 4;
      if (p.mode === 'darken') { for (let k = 0; k < 3; k++) d[o + k] = Math.min(d[o + k], src[i + k]); }
      else if (p.mode === 'lighten') { for (let k = 0; k < 3; k++) d[o + k] = Math.max(d[o + k], src[i + k]); }
      else { for (let k = 0; k < 3; k++) d[o + k] = src[i + k]; }
    }
    return d;
  },
});

// ------------------------------------------------------------------ pixelate
function cellProcess(d, w, h, size, fn) {
  const src = new Uint8ClampedArray(d);
  const s = Math.max(1, Math.round(size));
  for (let cy = 0; cy < h; cy += s) for (let cx = 0; cx < w; cx += s) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    const y1 = Math.min(h, cy + s), x1 = Math.min(w, cx + s);
    for (let y = cy; y < y1; y++) for (let x = cx; x < x1; x++) {
      const i = (y * w + x) * 4;
      r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
    }
    r /= n; g /= n; b /= n; a /= n;
    fn(d, src, w, cx, cy, x1, y1, [r, g, b, a], s);
  }
  return d;
}
registerFilter({ id: 'mosaic', name: 'Mosaic…', cat: 'Pixelate', defaults: { size: 12 },
  fields: [{ key: 'size', label: 'Cell size', type: 'range', min: 2, max: 100, step: 1 }],
  apply: (d, p, c) => cellProcess(d, c.w, c.h, p.size, (d2, src, w, cx, cy, x1, y1, avg) => {
    for (let y = cy; y < y1; y++) for (let x = cx; x < x1; x++) {
      const i = (y * w + x) * 4;
      d2[i] = avg[0]; d2[i + 1] = avg[1]; d2[i + 2] = avg[2]; d2[i + 3] = src[i + 3];
    }
  }) });
registerFilter({ id: 'crystallize', name: 'Crystallize…', cat: 'Pixelate', defaults: { size: 14 },
  fields: [{ key: 'size', label: 'Cell size', type: 'range', min: 3, max: 100, step: 1 }],
  apply: (d, p, c) => {
    const s = Math.max(3, p.size);
    const rnd = mulberry32(c.seed || 3);
    const cols = Math.ceil(c.w / s) + 1, rows = Math.ceil(c.h / s) + 1;
    const px = new Float32Array(cols * rows), py = new Float32Array(cols * rows);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      px[j * cols + i] = (i + rnd()) * s - s / 2;
      py[j * cols + i] = (j + rnd()) * s - s / 2;
    }
    const src = new Uint8ClampedArray(d);
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      let bd = 1e9, bx = 0, by = 0;
      const ci = Math.floor(x / s), cj = Math.floor(y / s);
      for (let j = Math.max(0, cj - 1); j <= Math.min(rows - 1, cj + 1); j++)
        for (let i = Math.max(0, ci - 1); i <= Math.min(cols - 1, ci + 1); i++) {
          const dx = x - px[j * cols + i], dy = y - py[j * cols + i];
          const dd = dx * dx + dy * dy;
          if (dd < bd) { bd = dd; bx = px[j * cols + i]; by = py[j * cols + i]; }
        }
      const si = (clampI(Math.round(by), 0, c.h - 1) * c.w + clampI(Math.round(bx), 0, c.w - 1)) * 4;
      const o = (y * c.w + x) * 4;
      d[o] = src[si]; d[o + 1] = src[si + 1]; d[o + 2] = src[si + 2]; d[o + 3] = src[o + 3];
    }
    return d;
  } });
registerFilter({ id: 'pointillize', name: 'Pointillize…', cat: 'Pixelate', defaults: { size: 8, bg: 'white' },
  fields: [{ key: 'size', label: 'Cell size', type: 'range', min: 3, max: 100, step: 1 },
           { key: 'bg', label: 'Background', type: 'select', options: [['white', 'White'], ['black', 'Black'], ['transparent', 'Transparent']] }],
  apply: (d, p, c) => {
    const src = new Uint8ClampedArray(d);
    const bg = p.bg === 'black' ? [0, 0, 0, 255] : p.bg === 'transparent' ? [0, 0, 0, 0] : [255, 255, 255, 255];
    for (let i = 0; i < d.length; i += 4) { d[i] = bg[0]; d[i + 1] = bg[1]; d[i + 2] = bg[2]; d[i + 3] = bg[3]; }
    const s = Math.max(3, p.size);
    const rnd = mulberry32(c.seed || 11);
    for (let cy = 0; cy < c.h; cy += s) for (let cx = 0; cx < c.w; cx += s) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const y1 = Math.min(c.h, cy + s), x1 = Math.min(c.w, cx + s);
      for (let y = cy; y < y1; y++) for (let x = cx; x < x1; x++) {
        const i = (y * c.w + x) * 4;
        r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
      }
      if (a / n < 8) continue;
      const px = cx + s / 2 + (rnd() - 0.5) * s * 0.3;
      const py = cy + s / 2 + (rnd() - 0.5) * s * 0.3;
      const rad = s * 0.42;
      const ctx = c.tmpCtx;
      if (ctx) {
        ctx.fillStyle = `rgb(${r / n},${g / n},${b / n})`;
        ctx.beginPath(); ctx.arc(px, py, rad, 0, TAU); ctx.fill();
      }
    }
    if (c.tmpCtx) {
      const id = c.tmpCtx.getImageData(0, 0, c.w, c.h);
      d.set(id.data);
    }
    return d;
  } });
registerFilter({ id: 'mezzotint', name: 'Mezzotint…', cat: 'Pixelate', defaults: { type: 'dots' },
  fields: [{ key: 'type', label: 'Type', type: 'select', options: [['dots', 'Coarse dots'], ['lines', 'Short lines'], ['strokes', 'Long strokes']] }],
  apply: (d, p, c) => {
    const rnd = mulberry32(c.seed || 5);
    const size = 4;
    const src = new Uint8ClampedArray(d);
    const ctx = c.tmpCtx;
    if (!ctx) return d;
    ctx.clearRect(0, 0, c.w, c.h);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.w, c.h);
    ctx.fillStyle = '#fff';
    for (let y = 0; y < c.h; y += size) for (let x = 0; x < c.w; x += size) {
      let sum = 0, n = 0;
      for (let yy = y; yy < Math.min(c.h, y + size); yy++) for (let xx = x; xx < Math.min(c.w, x + size); xx++) {
        const i = (yy * c.w + xx) * 4;
        sum += 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]; n++;
      }
      const v = (sum / n) / 255;
      if (p.type === 'dots') {
        ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, (size / 2) * v, 0, TAU); ctx.fill();
      } else if (p.type === 'lines') {
        ctx.fillRect(x, y + size / 2 - 0.5, size * v, 1);
      } else {
        ctx.fillRect(x, y, size, Math.max(0.5, size * v * 0.6));
      }
      void rnd;
    }
    const id = ctx.getImageData(0, 0, c.w, c.h);
    d.set(id.data);
    return d;
  } });
registerFilter({ id: 'colorHalftone', name: 'Colour Halftone…', cat: 'Pixelate',
  defaults: { radius: 6, a1: 108, a2: 162, a3: 90, a4: 45 },
  fields: [{ key: 'radius', label: 'Max radius', type: 'range', min: 1, max: 24, step: 1 },
           { key: 'a1', label: 'Channel 1', type: 'range', min: 0, max: 360, step: 1 },
           { key: 'a2', label: 'Channel 2', type: 'range', min: 0, max: 360, step: 1 },
           { key: 'a3', label: 'Channel 3', type: 'range', min: 0, max: 360, step: 1 },
           { key: 'a4', label: 'Channel 4', type: 'range', min: 0, max: 360, step: 1 }],
  apply: (d, p, c) => {
    const src = new Uint8ClampedArray(d);
    const R = Math.max(1, p.radius);
    const angles = [p.a1, p.a2, p.a3, p.a4].map((a) => (a * Math.PI) / 180);
    const out = new Uint8ClampedArray(d.length);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    for (let ch = 0; ch < 4; ch++) {
      const ca = Math.cos(angles[ch]), sa = Math.sin(angles[ch]);
      const diag = Math.hypot(c.w, c.h);
      for (let gy = -diag; gy < diag; gy += R * 2) for (let gx = -diag; gx < diag; gx += R * 2) {
        const cx = c.w / 2 + gx * ca - gy * sa;
        const cy = c.h / 2 + gx * sa + gy * ca;
        if (cx < -R || cy < -R || cx > c.w + R || cy > c.h + R) continue;
        // sample average channel value in cell
        let sum = 0, n = 0;
        const rr = Math.ceil(R);
        for (let dy = -rr; dy <= rr; dy += 2) for (let dx = -rr; dx <= rr; dx += 2) {
          const xx = Math.round(cx + dx), yy = Math.round(cy + dy);
          if (xx < 0 || yy < 0 || xx >= c.w || yy >= c.h) continue;
          const i = (yy * c.w + xx) * 4;
          const v = ch === 3 ? 255 - (0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2])
            : src[i + ch] ;
          sum += v; n++;
        }
        if (!n) continue;
        const avg = sum / n;
        const lum = avg / 255;
        const rad = R * Math.sqrt(1 - lum);
        const px = Math.round(cx), py = Math.round(cy);
        for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
          const dd = Math.hypot(dx, dy);
          if (dd > rad) continue;
          const xx = px + dx, yy = py + dy;
          if (xx < 0 || yy < 0 || xx >= c.w || yy >= c.h) continue;
          const i = (yy * c.w + xx) * 4;
          if (ch === 0) out[i] = 255;
          else if (ch === 1) out[i + 1] = 255;
          else if (ch === 2) out[i + 2] = 255;
          else if (ch === 3) { if (out[i] === 0 && out[i + 1] === 0 && out[i + 2] === 0) { out[i] = out[i + 1] = out[i + 2] = 60; } }
        }
      }
    }
    for (let i = 0; i < d.length; i += 4) {
      d[i] = out[i]; d[i + 1] = out[i + 1]; d[i + 2] = out[i + 2];
    }
    return d;
  } });

// ------------------------------------------------------------------ render
function fillNoise(d, w, h, seed, detail, mode) {
  const n1 = fbm(w, h, Math.max(1, Math.round(detail)), seed, 3, 0.55, 2.1);
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const base = new Float32Array(w * h);
  for (let i = 0; i < base.length; i++) base[i] = n1[i];
  if (mode === 'difference') {
    const n2 = fbm(w, h, Math.max(1, Math.round(detail)), seed + 101, 3, 0.55, 2.1);
    for (let i = 0; i < base.length; i++) base[i] = Math.abs(base[i] - n2[i]) * 2;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const fg = clamp01(((base[y * w + x] * 1.6) % 1) + rnd() * 0.02);
    const v = fg * 255;
    d[o] = d[o + 1] = d[o + 2] = v;
    d[o + 3] = 255;
  }
  return d;
}
registerFilter({ id: 'clouds', name: 'Clouds', cat: 'Render', defaults: { detail: 5 },
  fields: [{ key: 'detail', label: 'Detail', type: 'range', min: 1, max: 10, step: 1 }],
  apply: (d, p, c) => fillNoise(d, c.w, c.h, c.seed || 1, p.detail, 'normal') });
registerFilter({ id: 'differenceClouds', name: 'Difference Clouds', cat: 'Render', defaults: { detail: 5 },
  fields: [{ key: 'detail', label: 'Detail', type: 'range', min: 1, max: 10, step: 1 }],
  apply: (d, p, c) => fillNoise(d, c.w, c.h, c.seed || 1, p.detail, 'difference') });
registerFilter({ id: 'checkerboard', name: 'Checkerboard…', cat: 'Render', defaults: { size: 32 },
  fields: [{ key: 'size', label: 'Square size', type: 'range', min: 2, max: 256, step: 1 }],
  apply: (d, p, c) => {
    const s = Math.max(1, Math.round(p.size));
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const o = (y * c.w + x) * 4;
      const on = ((Math.floor(x / s) + Math.floor(y / s)) % 2) === 0;
      const v = on ? 255 : 0;
      d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255;
    }
    return d;
  } });
registerFilter({ id: 'fibers', name: 'Fibers…', cat: 'Render', defaults: { variance: 16, strength: 8 },
  fields: [{ key: 'variance', label: 'Variance', type: 'range', min: 1, max: 64, step: 1 },
           { key: 'strength', label: 'Strength', type: 'range', min: 1, max: 64, step: 1 }],
  apply: (d, p, c) => {
    const rnd = mulberry32(c.seed || 2);
    const rnd2 = mulberry32((c.seed || 2) + 777);
    for (let y = 0; y < c.h; y++) {
      const rowOffset = (rnd() - 0.5) * p.variance;
      for (let x = 0; x < c.w; x++) {
        const o = (y * c.w + x) * 4;
        const v = clamp(128 + Math.sin((x + rowOffset) / (p.strength * 0.6)) * 127 * (0.4 + rnd2() * 0.6), 0, 255);
        d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255;
      }
    }
    return d;
  } });
registerFilter({ id: 'lensFlare', name: 'Lens Flare…', cat: 'Render',
  defaults: { brightness: 100, cx: 0.5, cy: 0.5, hue: 30 },
  fields: [{ key: 'brightness', label: 'Brightness', type: 'range', min: 10, max: 300, step: 1 },
           { key: 'cx', label: 'Flare X %', type: 'range', min: 0, max: 100, step: 1 },
           { key: 'cy', label: 'Flare Y %', type: 'range', min: 0, max: 100, step: 1 }],
  apply: (d, p, c) => {
    const ctx = c.tmpCtx;
    if (!ctx) return d;
    const FX = p.cx * c.w, FY = p.cy * c.h;
    const b = p.brightness / 100;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(FX, FY, 0, FX, FY, Math.max(c.w, c.h) * 0.35);
    glow.addColorStop(0, `rgba(255,250,230,${0.85 * b})`);
    glow.addColorStop(0.25, `rgba(255,190,90,${0.28 * b})`);
    glow.addColorStop(1, 'rgba(255,150,60,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, c.w, c.h);
    // ghosts along the line to centre
    const cx = c.w / 2, cy = c.h / 2;
    for (let i = 1; i <= 6; i++) {
      const t = i / 6;
      const gx = lerp(FX, cx, t * 2 % 1), gy = lerp(FY, cy, t * 2 % 1);
      const r = (0.02 + (i % 3) * 0.035) * Math.max(c.w, c.h) * b;
      const gg = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
      const hue = (p.hue + i * 40) % 360;
      gg.addColorStop(0, `hsla(${hue},100%,70%,${0.22 * b})`);
      gg.addColorStop(1, 'hsla(0,0%,0%,0)');
      ctx.fillStyle = gg;
      ctx.beginPath(); ctx.arc(gx, gy, r, 0, TAU); ctx.fill();
    }
    ctx.restore();
    const id = ctx.getImageData(0, 0, c.w, c.h);
    d.set(id.data);
    return d;
  } });
