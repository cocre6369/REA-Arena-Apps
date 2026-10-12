// Colour adjustments: levels, curves, exposure, hue/sat, and the rest.
// Every function operates on a flat RGBA Uint8ClampedArray in place.

import { clamp, clamp01, lerp } from '../core/util.js';
import {
  rgbToHsl, hslToRgb, rgbToHsv, hsvToRgb, rgbToCmyk, cmykToRgb,
  rgbToLab, labToRgb, buildLut, luminance,
} from '../core/color.js';

// ---------------------------------------------------------------- curves
/** Monotone cubic interpolation through sorted control points [x,y] in 0..1. */
export function evalCurve(points, x) {
  const p = points.slice().sort((a, b) => a[0] - b[0]);
  const n = p.length;
  if (n === 0) return x;
  if (x <= p[0][0]) return p[0][1];
  if (x >= p[n - 1][0]) return p[n - 1][1];
  // slopes (Fritsch-Carlson)
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0] || 1e-6; dy[i] = p[i + 1][1] - p[i][1]; m[i] = dy[i] / dx[i]; }
  const t = new Array(n);
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) t[i] = 0;
    else t[i] = (m[i - 1] + m[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; }
    else {
      const a = t[i] / m[i], b = t[i + 1] / m[i];
      const s = a * a + b * b;
      if (s > 9) { const tau = 3 / Math.sqrt(s); t[i] = tau * a * m[i]; t[i + 1] = tau * b * m[i]; }
    }
  }
  let i = 0;
  while (i < n - 2 && x > p[i + 1][0]) i++;
  const h = dx[i], tt = (x - p[i][0]) / h;
  const h00 = 2 * tt * tt * tt - 3 * tt * tt + 1;
  const h10 = tt * tt * tt - 2 * tt * tt + tt;
  const h01 = -2 * tt * tt * tt + 3 * tt * tt;
  const h11 = tt * tt * tt - tt * tt;
  return clamp01(h00 * p[i][1] + h10 * h * t[i] + h01 * p[i + 1][1] + h11 * h * t[i + 1]);
}
export function curveLut(points) { return buildLut((x) => evalCurve(points, x)); }

// ---------------------------------------------------------------- presets
export const ADJUSTMENTS = [
  ['brightness', 'Brightness / Contrast', { brightness: 0, contrast: 0 }],
  ['levels', 'Levels', { inputLow: 0, inputHigh: 255, gamma: 1, outputLow: 0, outputHigh: 255, channel: 'rgb' }],
  ['curves', 'Curves', { channel: 'rgb', points: [[0, 0], [1, 1]] }],
  ['exposure', 'Exposure', { exposure: 0, offset: 0, gamma: 1 }],
  ['vibrance', 'Vibrance', { vibrance: 0, saturation: 0 }],
  ['hueSat', 'Hue / Saturation', { hue: 0, saturation: 0, lightness: 0, channel: 'master' }],
  ['colorBalance', 'Color Balance', { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLum: true }],
  ['blackWhite', 'Black & White', { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintHue: 40 }],
  ['photoFilter', 'Photo Filter', { color: [1, 0.65, 0.25], density: 0.5, preserveLum: true }],
  ['channelMixer', 'Channel Mixer', { mono: false, m: [[100, 0, 0], [0, 100, 0], [0, 0, 100]], constant: 0 }],
  ['selectiveColor', 'Selective Colour', { color: 'reds', c: 0, m: 0, y: 0, k: 0, method: 'relative' }],
  ['temperature', 'Temperature', { temperature: 0, tint: 0 }],
  ['gradientMap', 'Gradient Map', { stops: [[0, [0.05, 0.05, 0.15]], [0.5, [0.55, 0.2, 0.35]], [1, [1, 0.92, 0.7]]] }],
  ['posterize', 'Posterize', { levels: 6 }],
  ['threshold', 'Threshold', { level: 128 }],
  ['invert', 'Invert', {}],
  ['desaturate', 'Desaturate', {}],
  ['autoTone', 'Auto Tone', {}],
];
export const ADJ_BY_ID = new Map(ADJUSTMENTS.map(([id, name, def]) => [id, { id, name, def }]));
export const adjDefault = (id) => structuredClone(ADJ_BY_ID.get(id)?.def || {});
export const adjName = (id) => ADJ_BY_ID.get(id)?.name || id;

export function applyAdjustment(data, kind, params, w = 0, h = 0) {
  switch (kind) {
    case 'brightness': return adjBrightness(data, params);
    case 'levels': return adjLevels(data, params);
    case 'curves': return adjCurves(data, params);
    case 'exposure': return adjExposure(data, params);
    case 'vibrance': return adjVibrance(data, params);
    case 'hueSat': return adjHueSat(data, params);
    case 'colorBalance': return adjColorBalance(data, params);
    case 'blackWhite': return adjBlackWhite(data, params);
    case 'photoFilter': return adjPhotoFilter(data, params);
    case 'channelMixer': return adjChannelMixer(data, params);
    case 'selectiveColor': return adjSelectiveColor(data, params);
    case 'temperature': return adjTemperature(data, params);
    case 'gradientMap': return adjGradientMap(data, params);
    case 'posterize': return adjPosterize(data, params);
    case 'threshold': return adjThreshold(data, params);
    case 'invert': return adjInvert(data);
    case 'desaturate': return adjDesaturate(data);
    case 'autoTone': return adjAutoTone(data);
    default: return data;
  }
}

// ---------------------------------------------------------------- impls
function adjBrightness(d, p) {
  const b = p.brightness / 255, c = p.contrast / 100;
  const lut = buildLut((x) => clamp01((x - 0.5) * (1 + c) + 0.5 + b));
  applyLut3(d, lut); return d;
}
function adjLevels(d, p) {
  const inL = p.inputLow / 255, inH = Math.max(p.inputLow / 255 + 1e-4, p.inputHigh / 255);
  const g = p.gamma || 1, oL = p.outputLow / 255, oH = p.outputHigh / 255;
  const lut = buildLut((x) => {
    let v = (x - inL) / (inH - inL);
    v = clamp01(v);
    if (g !== 1) v = Math.pow(v, 1 / g);
    return clamp01(oL + v * (oH - oL));
  });
  const ch = p.channel || 'rgb';
  for (let i = 0; i < d.length; i += 4) {
    if (ch === 'rgb' || ch === 'r') d[i] = lut[d[i]];
    if (ch === 'rgb' || ch === 'g') d[i + 1] = lut[d[i + 1]];
    if (ch === 'rgb' || ch === 'b') d[i + 2] = lut[d[i + 2]];
  }
  return d;
}
function adjCurves(d, p) {
  const ch = p.channel || 'rgb';
  const lut = curveLut(p.points || [[0, 0], [1, 1]]);
  for (let i = 0; i < d.length; i += 4) {
    if (ch === 'rgb' || ch === 'r') d[i] = lut[d[i]];
    if (ch === 'rgb' || ch === 'g') d[i + 1] = lut[d[i + 1]];
    if (ch === 'rgb' || ch === 'b') d[i + 2] = lut[d[i + 2]];
  }
  return d;
}
function adjExposure(d, p) {
  const e = Math.pow(2, p.exposure), off = p.offset, g = 1 / (p.gamma || 1);
  const lut = buildLut((x) => clamp01(Math.pow(clamp01(x * e + off), g)));
  applyLut3(d, lut); return d;
}
function adjVibrance(d, p) {
  const v = p.vibrance / 100, s = p.saturation / 100;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx - mn;
    const amt = v * (1 - sat) + s;
    if (amt === 0) continue;
    const l = (r + g + b) / 3;
    d[i] = clamp01(lerp(l, r, 1 + amt)) * 255;
    d[i + 1] = clamp01(lerp(l, g, 1 + amt)) * 255;
    d[i + 2] = clamp01(lerp(l, b, 1 + amt)) * 255;
  }
  return d;
}
const HUE_RANGES = {
  reds: [345, 15], yellows: [45, 75], greens: [75, 165], cyans: [165, 195],
  blues: [195, 255], magentas: [255, 345], master: null,
};
function inRange(h, range) {
  if (!range) return 1;
  const [a, b] = range;
  if (a <= b) return (h >= a && h <= b) ? 1 : 0;
  return (h >= a || h <= b) ? 1 : 0;
}
function rangeWeight(h, range) {
  if (!range) return 1;
  const [a, b] = range;
  let lo, hi;
  if (a <= b) { lo = a; hi = b; } else { lo = a; hi = b + 360; }
  let hh = h; if (hh < lo) hh += 360;
  if (hh > hi) return 0;
  const mid = (lo + hi) / 2, half = (hi - lo) / 2;
  const t = Math.abs(hh - mid) / half;
  return Math.max(0, 1 - t * t);
}
function adjHueSat(d, p) {
  const hs = (p.hue || 0), ss = (p.saturation || 0) / 100, ls = (p.lightness || 0) / 100;
  const range = HUE_RANGES[p.channel || 'master'];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    let [h, s, l] = rgbToHsl(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
    const wgt = rangeWeight(h, range);
    if (wgt <= 0) continue;
    if (hs) h = ((h + hs * wgt) % 360 + 360) % 360;
    if (ss) s = clamp01(s + ss * wgt * (ss > 0 ? (1 - s) : s));
    if (ls) l = clamp01(l + ls * wgt * (ls > 0 ? (1 - l) : l));
    const c = hslToRgb(h, s, l);
    d[i] = c[0] * 255; d[i + 1] = c[1] * 255; d[i + 2] = c[2] * 255;
  }
  return d;
}
function adjColorBalance(d, p) {
  const sh = p.shadows, mi = p.midtones, hi = p.highlights, keep = p.preserveLum;
  const mk = (arr) => buildLut((x, ch) => clamp01(x + (arr[ch] / 100) * (ch === 0 ? 1 : ch === 1 ? 1 : 1) * 0.5));
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const l = luminance(r, g, b);
    const ws = Math.max(0, 1 - l * 2), wh = Math.max(0, l * 2 - 1), wm = 1 - ws - wh;
    const ar = (sh[0] * ws + mi[0] * wm + hi[0] * wh) / 100 * 0.5;
    const ag = (sh[1] * ws + mi[1] * wm + hi[1] * wh) / 100 * 0.5;
    const ab = (sh[2] * ws + mi[2] * wm + hi[2] * wh) / 100 * 0.5;
    let nr = clamp01(r + ar), ng = clamp01(g + ag), nb = clamp01(b + ab);
    if (keep) {
      const nl = luminance(nr, ng, nb);
      const k = nl > 0 ? l / nl : 1;
      nr = clamp01(nr * k); ng = clamp01(ng * k); nb = clamp01(nb * k);
    }
    d[i] = nr * 255; d[i + 1] = ng * 255; d[i + 2] = nb * 255;
  }
  return d;
}
function adjBlackWhite(d, p) {
  const w = {
    r: (p.reds ?? 40) / 100, y: (p.yellows ?? 60) / 100, g: (p.greens ?? 40) / 100,
    c: (p.cyans ?? 60) / 100, b: (p.blues ?? 20) / 100, m: (p.magentas ?? 80) / 100,
  };
  const tot = Math.max(1e-4, w.r + w.y + w.g + w.c + w.b + w.m);
  for (const k in w) w[k] /= tot;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    let [h, s] = rgbToHsv(r, g, b);
    let k;
    if (h < 60) k = lerp(w.r, w.y, h / 60);
    else if (h < 120) k = lerp(w.y, w.g, (h - 60) / 60);
    else if (h < 180) k = lerp(w.g, w.c, (h - 120) / 60);
    else if (h < 240) k = lerp(w.c, w.b, (h - 180) / 60);
    else if (h < 300) k = lerp(w.b, w.m, (h - 240) / 60);
    else k = lerp(w.m, w.r, (h - 300) / 60);
    let v = 0.299 * r + 0.587 * g + 0.114 * b;
    v = clamp01(v * (k * 3) + v * 0.0 + (v - 0.5) * 0);
    v = clamp01(v);
    if (p.tint) {
      const tc = hslToRgb(p.tintHue || 40, 0.35, 0.5);
      const t = 0.25;
      d[i] = clamp01(lerp(v, tc[0], t)) * 255;
      d[i + 1] = clamp01(lerp(v, tc[1], t)) * 255;
      d[i + 2] = clamp01(lerp(v, tc[2], t)) * 255;
    } else {
      d[i] = d[i + 1] = d[i + 2] = v * 255;
    }
  }
  return d;
}
function adjPhotoFilter(d, p) {
  const [cr, cg, cb] = p.color || [1, 0.65, 0.25];
  const dens = clamp01(p.density);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    let nr = clamp01(lerp(r, r * cr * 1.6, dens));
    let ng = clamp01(lerp(g, g * cg * 1.6, dens));
    let nb = clamp01(lerp(b, b * cb * 1.6, dens));
    if (p.preserveLum) {
      const l = luminance(r, g, b), nl = luminance(nr, ng, nb);
      const k = nl > 0 ? l / nl : 1;
      nr = clamp01(nr * k); ng = clamp01(ng * k); nb = clamp01(nb * k);
    }
    d[i] = nr * 255; d[i + 1] = ng * 255; d[i + 2] = nb * 255;
  }
  return d;
}
function adjChannelMixer(d, p) {
  const m = p.m || [[100, 0, 0], [0, 100, 0], [0, 0, 100]];
  const cst = (p.constant || 0) / 100;
  const M = m.map((row) => row.map((v) => v / 100));
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    let nr = M[0][0] * r + M[0][1] * g + M[0][2] * b + cst;
    let ng = M[1][0] * r + M[1][1] * g + M[1][2] * b + cst;
    let nb = M[2][0] * r + M[2][1] * g + M[2][2] * b + cst;
    if (p.mono) { const v = clamp01(nr); d[i] = d[i + 1] = d[i + 2] = v * 255; }
    else { d[i] = clamp01(nr) * 255; d[i + 1] = clamp01(ng) * 255; d[i + 2] = clamp01(nb) * 255; }
  }
  return d;
}
function adjSelectiveColor(d, p) {
  const range = HUE_RANGES[p.color || 'reds'];
  const rel = (p.method || 'relative') === 'relative';
  const amt = [p.c / 100, p.m / 100, p.y / 100, p.k / 100];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    let [h] = rgbToHsv(r, g, b);
    const wgt = rangeWeight(h, range);
    if (wgt <= 0) continue;
    let c = rgbToCmyk(r, g, b);
    if (rel) {
      c[0] = clamp01(c[0] + amt[0] * wgt * (1 - c[0]));
      c[1] = clamp01(c[1] + amt[1] * wgt * (1 - c[1]));
      c[2] = clamp01(c[2] + amt[2] * wgt * (1 - c[2]));
      c[3] = clamp01(c[3] + amt[3] * wgt * (1 - c[3]));
    } else {
      c = c.map((v, k) => clamp01(v + amt[k] * wgt));
    }
    const rgb = cmykToRgb(c[0], c[1], c[2], c[3]);
    d[i] = rgb[0] * 255; d[i + 1] = rgb[1] * 255; d[i + 2] = rgb[2] * 255;
  }
  return d;
}
function adjTemperature(d, p) {
  const t = (p.temperature || 0) / 100, tint = (p.tint || 0) / 100;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    r = clamp01(r + t * 0.25);
    b = clamp01(b - t * 0.25);
    g = clamp01(g + tint * 0.2);
    d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255;
  }
  return d;
}
function adjGradientMap(d, p) {
  const stops = (p.stops || []).slice().sort((a, b) => a[0] - b[0]);
  if (stops.length < 2) return d;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    let a = stops[0], b = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) {
      if (v >= stops[k][0] && v <= stops[k + 1][0]) { a = stops[k]; b = stops[k + 1]; break; }
    }
    const t = (v - a[0]) / ((b[0] - a[0]) || 1e-6);
    d[i] = lerp(a[1][0], b[1][0], t) * 255;
    d[i + 1] = lerp(a[1][1], b[1][1], t) * 255;
    d[i + 2] = lerp(a[1][2], b[1][2], t) * 255;
  }
  return d;
}
function adjPosterize(d, p) {
  const n = Math.max(2, Math.min(255, p.levels | 0));
  const lut = buildLut((x) => Math.round(x * (n - 1)) / (n - 1));
  applyLut3(d, lut); return d;
}
function adjThreshold(d, p) {
  const t = p.level;
  for (let i = 0; i < d.length; i += 4) {
    const v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) >= t ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  return d;
}
function adjInvert(d) {
  for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
  return d;
}
function adjDesaturate(d) {
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  return d;
}
function adjAutoTone(d) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) if (d[i + 3]) hist[Math.round(luminance(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255) * 255)]++;
  const total = d.length / 4;
  const cut = total * 0.005;
  let acc = 0, lo = 0, hi = 255;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > cut) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > cut) { hi = i; break; } }
  if (hi <= lo) return d;
  return adjLevels(d, { inputLow: lo, inputHigh: hi, gamma: 1, outputLow: 0, outputHigh: 255, channel: 'rgb' });
}

function applyLut3(d, lut) {
  for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
}

// ---------------------------------------------------------------- histogram
export function histogram(imageData) {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    r[d[i]]++; g[d[i + 1]]++; b[d[i + 2]]++;
    l[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
  }
  return { r, g, b, l };
}
