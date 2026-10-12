// Small utilities shared across the editor.

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);
export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;

let _idc = 0;
export const uid = (p = 'id') => `${p}_${(++_idc).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) { (this._h.get(ev) || this._h.set(ev, new Set()).get(ev)).add(fn); return () => this.off(ev, fn); }
  off(ev, fn) { const s = this._h.get(ev); if (s) s.delete(fn); }
  emit(ev, ...a) { const s = this._h.get(ev); if (s) for (const fn of [...s]) { try { fn(...a); } catch (e) { console.error(e); } } }
}

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat(4)) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

export const qs = (s, r = document) => r.querySelector(s);
export const qsa = (s, r = document) => [...r.querySelectorAll(s)];

export function debounce(fn, ms = 100) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function rafThrottle(fn) {
  let queued = false, lastArgs = null;
  return (...a) => {
    lastArgs = a;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...lastArgs); });
  };
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
export const ctx2d = (c, opts) => c.getContext('2d', opts || { willReadFrequently: true });

export function copyCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  if (src.width && src.height) c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

export function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not load image'));
    img.src = src;
  });
}

export function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}
export function fileToBuffer(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsArrayBuffer(file);
  });
}
export function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
export function dataURLToBlob(u) {
  const [head, b64] = u.split(',');
  const mime = /:(.*?);/.exec(head)?.[1] || 'application/octet-stream';
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

export async function downloadBlob(blob, name) {
  if (window.chroma?.desktop) {
    const saved = await window.chroma.saveBuffer(await blob.arrayBuffer(), name, []);
    if (saved) toast('Saved ' + saved);
    return saved;
  }
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
export async function downloadCanvas(canvas, name, type = 'image/png', quality) {
  const blob = await new Promise((r) => canvas.toBlob(r, type, quality));
  downloadBlob(blob, name);
}

export function pickFiles(accept = 'image/*', multiple = false) {
  return new Promise((res) => {
    const inp = el('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    inp.addEventListener('change', () => res([...inp.files]), { once: true });
    document.body.append(inp);
    inp.click();
    setTimeout(() => inp.remove(), 1000);
  });
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB'];
  let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}
export const fmtNum = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

// deterministic PRNG (for render filters: clouds, noise, fibres)
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// value noise with bilinear interpolation, used by clouds / fibres / textures
export function valueNoise(w, h, cells, seed) {
  const rnd = mulberry32(seed);
  const gw = Math.max(2, Math.ceil(cells) + 1), gh = gw;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = (y / h) * cells, y0 = Math.floor(fy), ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < w; x++) {
      const fx = (x / w) * cells, x0 = Math.floor(fx), tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const a = grid[(y0 % gh) * gw + (x0 % gw)];
      const b = grid[(y0 % gh) * gw + ((x0 + 1) % gw)];
      const c = grid[((y0 + 1) % gh) * gw + (x0 % gw)];
      const d = grid[((y0 + 1) % gh) * gw + ((x0 + 1) % gw)];
      out[y * w + x] = lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
    }
  }
  return out;
}
export function fbm(w, h, octaves = 5, seed = 1, baseCells = 3, gain = 0.5, lac = 2) {
  const out = new Float32Array(w * h);
  let amp = 1, tot = 0, cells = baseCells;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(w, h, cells, seed + o * 7919);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    tot += amp; amp *= gain; cells *= lac;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}

// run fn(y0,y1) over rows in chunks, yielding to the browser so the UI stays alive
export async function chunkedRows(height, fn, onProgress, chunk = 64) {
  for (let y = 0; y < height; y += chunk) {
    const y1 = Math.min(height, y + chunk);
    fn(y, y1);
    if (onProgress) onProgress(y1 / height);
    if (y + chunk < height) await new Promise((r) => setTimeout(r, 0));
  }
}

export function busy(on, label = 'Working…') {
  const b = document.getElementById('busy');
  if (!b) return;
  document.getElementById('busy-label').textContent = label;
  b.hidden = !on;
}

export function toast(msg, ms = 2600) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const t = el('div', { class: 'toast', html: String(msg) });
  root.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 250); }, ms);
}

export function mod(n, m) { return ((n % m) + m) % m; }
export function roundTo(v, step) { return step ? Math.round(v / step) * step : v; }
export function nextName(base, existing) {
  let i = 1, n;
  do { n = `${base} ${i++}`; } while (existing.has(n));
  return n;
}
