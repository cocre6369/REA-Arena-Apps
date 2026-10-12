// Colour-space conversions and the blend-mode table.

import { clamp01, lerp } from './util.js';

export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}
export function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}
export function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2, d = max - min;
  let h = 0, s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d) + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}
export function rgbToCmyk(r, g, b) {
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return [0, 0, 0, 1];
  return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k];
}
export function cmykToRgb(c, m, y, k) {
  return [1 - Math.min(1, c * (1 - k) + k), 1 - Math.min(1, m * (1 - k) + k), 1 - Math.min(1, y * (1 - k) + k)];
}
const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
export function rgbToLab(r, g, b) {
  const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b);
  let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  let Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  X = f(X); Y = f(Y); Z = f(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
export function labToRgb(L, a, bb) {
  let Y = (L + 16) / 116, X = Y + a / 500, Z = Y - bb / 200;
  const fi = (t) => (t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
  X = fi(X) * 0.95047; Y = fi(Y); Z = fi(Z) * 1.08883;
  const R = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
  const G = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
  const B = X * 0.0557 + Y * -0.2040 + Z * 1.0570;
  return [clamp01(linToSrgb(R)), clamp01(linToSrgb(G)), clamp01(linToSrgb(B))];
}

export const hex2rgb = (hex) => {
  let h = String(hex).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
export const rgb2hex = (r, g, b) =>
  '#' + [r, g, b].map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');
export const rgb2css = (r, g, b) =>
  `rgb(${Math.round(clamp01(r) * 255)},${Math.round(clamp01(g) * 255)},${Math.round(clamp01(b) * 255)})`;

export function parseColor(s) {
  if (Array.isArray(s)) return s.slice(0, 3);
  s = String(s).trim().toLowerCase();
  if (s.startsWith('#')) return hex2rgb(s);
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0] / 255, p[1] / 255, p[2] / 255];
  }
  return hex2rgb(s);
}
export const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const grayOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

export const BLEND_MODES = [
  ['normal', 'Normal', 'source-over'],
  ['dissolve', 'Dissolve', null],
  ['darken', 'Darken', 'darken'],
  ['multiply', 'Multiply', 'multiply'],
  ['colorburn', 'Color Burn', 'color-burn'],
  ['linearburn', 'Linear Burn', null],
  ['darkercolor', 'Darker Color', null],
  ['lighten', 'Lighten', 'lighten'],
  ['screen', 'Screen', 'screen'],
  ['colordodge', 'Color Dodge', 'color-dodge'],
  ['lineardodge', 'Linear Dodge (Add)', null],
  ['lightercolor', 'Lighter Color', null],
  ['overlay', 'Overlay', 'overlay'],
  ['softlight', 'Soft Light', 'soft-light'],
  ['hardlight', 'Hard Light', 'hard-light'],
  ['vividlight', 'Vivid Light', null],
  ['linearlight', 'Linear Light', null],
  ['pinlight', 'Pin Light', null],
  ['hardmix', 'Hard Mix', null],
  ['difference', 'Difference', 'difference'],
  ['exclusion', 'Exclusion', 'exclusion'],
  ['subtract', 'Subtract', null],
  ['divide', 'Divide', null],
  ['hue', 'Hue', 'hue'],
  ['saturation', 'Saturation', 'saturation'],
  ['color', 'Color', 'color'],
  ['luminosity', 'Luminosity', 'luminosity'],
];
export const BLEND_BY_ID = new Map(BLEND_MODES.map(([id, name, op]) => [id, { id, name, op }]));
export const blendName = (id) => BLEND_BY_ID.get(id)?.name || 'Normal';
export function blendOp(id) { return BLEND_BY_ID.get(id)?.op || 'source-over'; }
export const needsCustomBlend = (id) => BLEND_BY_ID.get(id)?.op == null;

const lumOf = (c) => luminance(c[0], c[1], c[2]);
const satOf = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setLum(c, l) {
  const d = l - lumOf(c);
  return [clamp01(c[0] + d), clamp01(c[1] + d), clamp01(c[2] + d)];
}
function setSat(c, s) {
  const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
  if (mx <= mn) return [0, 0, 0];
  const q = s / (mx - mn);
  return c.map((v) => (v === mx ? s : v === mn ? 0 : clamp01((v - mn) * q)));
}
function nonSep(mode, cb, cs) {
  switch (mode) {
    case 'hue': return setLum(setSat(cs, satOf(cb)), lumOf(cb));
    case 'saturation': return setLum(setSat(cb, satOf(cs)), lumOf(cb));
    case 'color': return setLum(cs, lumOf(cb));
    case 'luminosity': return setLum(cb, lumOf(cs));
    case 'darkercolor': return lumOf(cb) <= lumOf(cs) ? cb : cs;
    case 'lightercolor': return lumOf(cb) >= lumOf(cs) ? cb : cs;
    default: return cs;
  }
}
function sep(mode, b, s) {
  switch (mode) {
    case 'linearburn': return clamp01(b + s - 1);
    case 'lineardodge': return clamp01(b + s);
    case 'subtract': return clamp01(b - s);
    case 'divide': return clamp01(s <= 0 ? 1 : b / s);
    case 'vividlight': return s <= 0.5 ? (b >= 1 ? 1 : clamp01(1 - (1 - b) / (2 * s || 1e-6))) : clamp01(b / (2 * (1 - s) || 1e-6));
    case 'linearlight': return clamp01(b + 2 * s - 1);
    case 'pinlight': return clamp01(s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1));
    case 'hardmix': return b + s >= 1 ? 1 : 0;
    default: return s;
  }
}

/** Blend src RGBA over dst RGBA in place, for modes the canvas can't do natively. */
export function customBlend(dst, src, mode, opacity, rnd) {
  const nonsep = ['hue', 'saturation', 'color', 'luminosity', 'darkercolor', 'lightercolor'].includes(mode);
  const cb = [0, 0, 0], cs = [0, 0, 0];
  for (let i = 0; i < dst.length; i += 4) {
    const sa = src[i + 3] / 255;
    if (sa <= 0) continue;
    let a = sa * opacity;
    if (mode === 'dissolve') { if ((rnd ? rnd() : Math.random()) > a) continue; a = 1; }
    if (a <= 0) continue;
    const ba = dst[i + 3] / 255;
    cs[0] = src[i] / 255; cs[1] = src[i + 1] / 255; cs[2] = src[i + 2] / 255;
    cb[0] = dst[i] / 255; cb[1] = dst[i + 1] / 255; cb[2] = dst[i + 2] / 255;
    let rr, rg, rb;
    if (nonsep) {
      const c = nonSep(mode, cb, cs); rr = c[0]; rg = c[1]; rb = c[2];
    } else {
      rr = sep(mode, cb[0], cs[0]); rg = sep(mode, cb[1], cs[1]); rb = sep(mode, cb[2], cs[2]);
    }
    const oa = a + ba * (1 - a);
    if (oa <= 0) { dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0; continue; }
    dst[i] = ((rr * a + cb[0] * ba * (1 - a)) / oa) * 255;
    dst[i + 1] = ((rg * a + cb[1] * ba * (1 - a)) / oa) * 255;
    dst[i + 2] = ((rb * a + cb[2] * ba * (1 - a)) / oa) * 255;
    dst[i + 3] = oa * 255;
  }
}

export function buildLut(fn, n = 256) {
  const lut = new Uint8Array(n);
  for (let i = 0; i < n; i++) lut[i] = Math.round(clamp01(fn(i / (n - 1))) * 255);
  return lut;
}
export function applyLut(data, lutR, lutG = lutR, lutB = lutR) {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lutR[data[i]];
    data[i + 1] = lutG[data[i + 1]];
    data[i + 2] = lutB[data[i + 2]];
  }
}
export function applyRGBfn(data, fn) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const c = fn(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
    data[i] = c[0] * 255; data[i + 1] = c[1] * 255; data[i + 2] = c[2] * 255;
  }
}
export const clampV = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
export const lerpV = lerp;
