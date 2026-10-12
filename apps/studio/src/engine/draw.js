// Brush engine, gradients, flood fill, shape + text rendering.

import { clamp, clamp01, lerp, makeCanvas, TAU, dist, mulberry32 } from '../core/util.js';
import { rgbToHsl, hslToRgb, rgb2css, hex2rgb } from '../core/color.js';
import { gaussianBlurRGBA, convolve } from './filters.js';

// ---------------------------------------------------------------- brush tip
const tipCache = new Map();
export function brushTip(size, hardness, angle = 0, roundness = 1) {
  const s = Math.max(1, Math.round(size));
  const key = `${s}|${Math.round(hardness)}|${Math.round(angle)}|${Math.round(roundness * 100)}`;
  if (tipCache.has(key)) return tipCache.get(key);
  const c = makeCanvas(s, s);
  const cx = c.getContext('2d');
  const r = s / 2;
  const h = clamp01(hardness / 100);
  const g = cx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(clamp(h * 0.98, 0, 0.98), 'rgba(255,255,255,1)');
  g.addColorStop(clamp(h + (1 - h) * 0.6, 0.001, 0.999), 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  cx.save();
  if (roundness !== 1 || angle) {
    cx.translate(r, r);
    if (angle) cx.rotate((angle * Math.PI) / 180);
    cx.scale(1, Math.max(0.05, roundness));
    cx.translate(-r, -r);
  }
  cx.fillStyle = g;
  cx.beginPath(); cx.arc(r, r, r, 0, TAU); cx.fill();
  cx.restore();
  if (tipCache.size > 200) tipCache.clear();
  tipCache.set(key, c);
  return c;
}

/** A live stroke: paints into its own canvas, which the app previews over the layer. */
export class Stroke {
  constructor(doc, layer, mode, opts = {}) {
    this.doc = doc;
    this.layer = layer;
    this.mode = mode;                  // paint | erase | clone | heal | smudge | blur | sharpen | dodge | burn | sponge
    this.o = Object.assign({
      color: [0, 0, 0], size: 24, hardness: 70, opacity: 100, flow: 100,
      spacing: 25, angle: 0, roundness: 1, smoothing: 12, blend: 'normal',
      pressureSize: false, source: null, strength: 50, selection: null,
    }, opts);
    this.canvas = makeCanvas(doc.width, doc.height);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.pts = [];
    this.smooth = [];
    this.lastDab = null;
    this.accum = 0;
    this.snapshot = (mode === 'smudge' || mode === 'blur' || mode === 'sharpen' ||
                     mode === 'dodge' || mode === 'burn' || mode === 'sponge')
      ? snapshotCanvas(layer.canvas) : null;
  }

  begin(x, y, pressure = 1) {
    this.pts = [{ x, y, p: pressure }];
    this.smooth = [{ x, y }];
    this._dab(x, y, pressure);
  }

  move(x, y, pressure = 1) {
    const last = this.pts[this.pts.length - 1];
    const sm = this.o.smoothing;
    if (sm > 0) {
      this.smooth.push({ x, y });
      if (this.smooth.length > sm) this.smooth.shift();
      const avg = this.smooth.reduce((a, p) => ({ x: a.x + p.x / this.smooth.length, y: a.y + p.y / this.smooth.length }), { x: 0, y: 0 });
      x = avg.x; y = avg.y;
    }
    const d = dist(last.x, last.y, x, y);
    const size = this._size(pressure);
    const step = Math.max(0.4, size * (this.o.spacing / 100));
    if (d < step) return;
    const steps = Math.min(400, Math.ceil(d / step));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this._dab(lerp(last.x, x, t), lerp(last.y, y, t), lerp(last.p ?? 1, pressure, t));
    }
    this.pts.push({ x, y, p: pressure });
  }

  end() {
    // nothing to finalise here; app composites this.canvas onto the layer
    return this.canvas;
  }

  _size(p) {
    return this.o.pressureSize ? Math.max(1, this.o.size * p) : this.o.size;
  }

  _dab(x, y, p) {
    const o = this.o;
    const size = this._size(p);
    const tip = brushTip(size, o.hardness, o.angle, o.roundness);
    const half = size / 2;
    const alpha = clamp01((o.flow / 100) * (this.mode === 'smudge' ? 1 : 1));
    this.ctx.save();
    this.ctx.globalAlpha = alpha;

    switch (this.mode) {
      case 'paint': {
        this.ctx.globalCompositeOperation = 'source-over';
        this.ctx.drawImage(tintTip(tip, o.color), x - half, y - half, size, size);
        break;
      }
      case 'erase': {
        // Accumulate an alpha mask; the destination-out blend is applied to the layer at stroke end.
        this.ctx.globalCompositeOperation = 'source-over';
        this.ctx.drawImage(tip, x - half, y - half, size, size);
        break;
      }
      case 'clone':
      case 'heal': {
        const src = o.source;
        if (!src || !src.canvas) break;
        const patch = makeCanvas(size, size);
        const pc = patch.getContext('2d');
        pc.drawImage(src.canvas, x - half - src.dx, y - half - src.dy, size, size);
        if (this.mode === 'heal') matchLuminance(patch, this.snapshot || this.layer.canvas, x - half, y - half);
        pc.globalCompositeOperation = 'destination-in';
        pc.drawImage(tip, 0, 0, size, size);
        this.ctx.globalCompositeOperation = 'source-over';
        this.ctx.drawImage(patch, x - half, y - half);
        break;
      }
      case 'smudge': {
        const snap = this.snapshot;
        if (!snap) break;
        const patch = makeCanvas(size, size);
        const pc = patch.getContext('2d');
        const prev = this.lastDab;
        const sx = prev ? lerp(x, prev.x, 0.85) : x, sy = prev ? lerp(y, prev.y, 0.85) : y;
        pc.drawImage(snap, sx - half, sy - half, size, size);
        pc.globalCompositeOperation = 'destination-in';
        pc.drawImage(tip, 0, 0, size, size);
        this.ctx.globalCompositeOperation = 'source-over';
        this.ctx.globalAlpha = clamp01((o.strength / 100) * 0.6);
        this.ctx.drawImage(patch, x - half, y - half);
        break;
      }
      case 'blur':
      case 'sharpen':
      case 'dodge':
      case 'burn':
      case 'sponge': {
        const snap = this.snapshot;
        if (!snap) break;
        const patch = makeCanvas(size, size);
        const pc = patch.getContext('2d');
        pc.drawImage(snap, x - half, y - half, size, size);
        const id = pc.getImageData(0, 0, size, size);
        const strength = o.strength / 100;
        if (this.mode === 'blur') gaussianBlurRGBA(id.data, size, size, 1 + strength * 5);
        else if (this.mode === 'sharpen') convolve(id.data, size, size, [0, -1, 0, -1, 1 + strength * 8, -1, 0, -1, 0], 3, 1, 0);
        else if (this.mode === 'dodge') shade(id.data, strength * 0.6, 'dodge');
        else if (this.mode === 'burn') shade(id.data, strength * 0.6, 'burn');
        else if (this.mode === 'sponge') sponge(id.data, strength);
        pc.putImageData(id, 0, 0);
        pc.globalCompositeOperation = 'destination-in';
        pc.drawImage(tip, 0, 0, size, size);
        this.ctx.globalCompositeOperation = 'source-over';
        this.ctx.drawImage(patch, x - half, y - half);
        break;
      }
      default: break;
    }
    this.ctx.restore();
    this.lastDab = { x, y };
  }
}

function tintTip(tip, color) {
  const c = makeCanvas(tip.width, tip.height);
  const cx = c.getContext('2d');
  cx.drawImage(tip, 0, 0);
  cx.globalCompositeOperation = 'source-in';
  cx.fillStyle = rgb2css(color[0], color[1], color[2]);
  cx.fillRect(0, 0, c.width, c.height);
  return c;
}

function matchLuminance(patch, dest, dx, dy) {
  const pc = patch.getContext('2d');
  const a = pc.getImageData(0, 0, patch.width, patch.height);
  const b = dest.getContext('2d').getImageData(
    clamp(Math.round(dx), 0, Math.max(0, dest.width - patch.width)),
    clamp(Math.round(dy), 0, Math.max(0, dest.height - patch.height)),
    patch.width, patch.height);
  for (let i = 0; i < a.data.length; i += 4) {
    if (!a.data[i + 3]) continue;
    const [h, s, l] = rgbToHsl(a.data[i] / 255, a.data[i + 1] / 255, a.data[i + 2] / 255);
    let [, , dl] = rgbToHsl(b.data[i] / 255, b.data[i + 1] / 255, b.data[i + 2] / 255);
    if (!b.data[i + 3]) dl = l;
    const c = hslToRgb(h, s, lerp(l, dl, 0.85));
    a.data[i] = c[0] * 255; a.data[i + 1] = c[1] * 255; a.data[i + 2] = c[2] * 255;
  }
  pc.putImageData(a, 0, 0);
}
function shade(d, amt, kind) {
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    for (let k = 0; k < 3; k++) {
      const v = d[i + k] / 255;
      const n = kind === 'dodge' ? clamp01(v + amt * (1 - v) * 0.8) : clamp01(v - amt * v * 0.8);
      d[i + k] = n * 255;
    }
  }
}
function sponge(d, amt) {
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const [h, s, l] = rgbToHsl(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
    const ns = clamp01(s - amt * (amt > 0 ? s : (1 - s)) * 2);
    const c = hslToRgb(h, ns, l);
    d[i] = c[0] * 255; d[i + 1] = c[1] * 255; d[i + 2] = c[2] * 255;
  }
}

export function snapshotCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

// ---------------------------------------------------------------- gradient
export function gradientFill(ctx, type, stops, x0, y0, x1, y1) {
  const sorted = stops.slice().sort((a, b) => a[0] - b[0]);
  let g;
  const r = Math.hypot(x1 - x0, y1 - y0);
  if (type === 'linear') g = ctx.createLinearGradient(x0, y0, x1, y1);
  else if (type === 'radial') g = ctx.createRadialGradient(x0, y0, 0, x0, y0, r);
  else if (type === 'angle') g = ctx.createLinearGradient(x0, y0, x1, y1);
  else if (type === 'reflected') g = ctx.createLinearGradient(x0, y0, x1, y1);
  else if (type === 'diamond') g = ctx.createRadialGradient(x0, y0, 0, x0, y0, r);
  else g = ctx.createLinearGradient(x0, y0, x1, y1);

  const N = 24;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    let col = [0, 0, 0], al = 1;
    const st = sampleStops(sorted, type === 'reflected' ? (t < 0.5 ? t * 2 : (1 - t) * 2) : t);
    col = st.color; al = st.alpha;
    if (type === 'angle') {
      // angular sweep: approximate with a conic-like multi-stop linear interpolation
      g.addColorStop(t, `rgba(${col[0]},${col[1]},${col[2]},${al})`);
    } else {
      g.addColorStop(t, `rgba(${col[0]},${col[1]},${col[2]},${al})`);
    }
  }
  return g;
}

export function sampleStops(stops, t) {
  if (!stops.length) return { color: [0, 0, 0], alpha: 1 };
  if (t <= stops[0][0]) return { color: stops[0][1], alpha: stops[0][2] ?? 1 };
  if (t >= stops[stops.length - 1][0]) {
    const s = stops[stops.length - 1]; return { color: s[1], alpha: s[2] ?? 1 };
  }
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (t >= a[0] && t <= b[0]) {
      const k = (t - a[0]) / ((b[0] - a[0]) || 1e-6);
      return {
        color: [lerp(a[1][0], b[1][0], k), lerp(a[1][1], b[1][1], k), lerp(a[1][2], b[1][2], k)],
        alpha: lerp(a[2] ?? 1, b[2] ?? 1, k),
      };
    }
  }
  return { color: stops[0][1], alpha: 1 };
}

// ---------------------------------------------------------------- flood fill
export function floodFill(imageData, w, h, sx, sy, rgb, tolerance, contiguous, antiAlias, mask) {
  const d = imageData.data;
  sx = Math.round(sx); sy = Math.round(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return false;
  const si = (sy * w + sx) * 4;
  const tr = d[si], tg = d[si + 1], tb = d[si + 2], ta = d[si + 3];
  const tol = tolerance;
  const match = (i) => {
    if (mask && mask[i + 3] < 128) return false;
    return Math.abs(d[i] - tr) <= tol && Math.abs(d[i + 1] - tg) <= tol &&
           Math.abs(d[i + 2] - tb) <= tol && Math.abs(d[i + 3] - ta) <= tol;
  };
  const filled = new Uint8Array(w * h);
  const out = new Uint8ClampedArray(d);
  const put = (i) => {
    out[i] = rgb[0]; out[i + 1] = rgb[1]; out[i + 2] = rgb[2]; out[i + 3] = 255;
  };
  if (!contiguous) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (match(i)) put(i);
    }
  } else {
    const stack = [sx, sy];
    filled[sy * w + sx] = 1;
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      let xl = x;
      while (xl > 0 && match(((y * w + xl - 1) * 4)) && !filled[y * w + xl - 1]) xl--;
      let xr = x;
      while (xr < w - 1 && match(((y * w + xr + 1) * 4)) && !filled[y * w + xr + 1]) xr++;
      for (let xx = xl; xx <= xr; xx++) {
        const p = y * w + xx;
        if (filled[p]) continue;
        filled[p] = 1;
        put(p * 4);
        if (y > 0 && !filled[p - w] && match(((p - w) * 4))) stack.push(xx, y - 1);
        if (y < h - 1 && !filled[p + w] && match(((p + w) * 4))) stack.push(xx, y + 1);
      }
    }
  }
  if (antiAlias) {
    const tmp = new Uint8ClampedArray(out);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      if (tmp[i + 3] !== 255) continue;
      let edge = 0;
      if (out[((y) * w + x - 1) * 4 + 3] !== 255) edge++;
      if (out[((y) * w + x + 1) * 4 + 3] !== 255) edge++;
      if (out[((y - 1) * w + x) * 4 + 3] !== 255) edge++;
      if (out[((y + 1) * w + x) * 4 + 3] !== 255) edge++;
      if (edge) {
        d[i] = lerp(d[i], out[i], 0.65);
        d[i + 1] = lerp(d[i + 1], out[i + 1], 0.65);
        d[i + 2] = lerp(d[i + 2], out[i + 2], 0.65);
      }
    }
  }
  d.set(out);
  return true;
}

// ---------------------------------------------------------------- shapes
export function shapePath(ctx, kind, x, y, w, h, p = {}) {
  ctx.beginPath();
  switch (kind) {
    case 'rect': ctx.rect(x, y, w, h); break;
    case 'roundrect': {
      const r = clamp(p.radius ?? 8, 0, Math.min(Math.abs(w), Math.abs(h)) / 2);
      ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
      break;
    }
    case 'ellipse': ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, TAU); break;
    case 'polygon':
    case 'star': {
      const n = Math.max(3, p.sides ?? (kind === 'star' ? 5 : 6));
      const cx = x + w / 2, cy = y + h / 2;
      const rx = Math.abs(w / 2), ry = Math.abs(h / 2);
      const inner = kind === 'star' ? (p.inner ?? 0.45) : 1;
      for (let i = 0; i < n * 2; i++) {
        const rad = i % 2 === 0 ? 1 : inner;
        const a = (i / (n * 2)) * TAU - Math.PI / 2;
        const px = cx + Math.cos(a) * rx * rad, py = cy + Math.sin(a) * ry * rad;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'line': {
      ctx.moveTo(x, y);
      if (p.arrowEnd) { arrowHead(ctx, x, y, x + w, y + h, p.strokeWidth || 2); }
      ctx.lineTo(x + w, y + h);
      break;
    }
    case 'heart': {
      const cx = x + w / 2, cy = y + h / 2, s = Math.min(w, h);
      ctx.moveTo(cx, cy + s * 0.35);
      ctx.bezierCurveTo(cx - s * 0.6, cy - s * 0.1, cx - s * 0.25, cy - s * 0.6, cx, cy - s * 0.2);
      ctx.bezierCurveTo(cx + s * 0.25, cy - s * 0.6, cx + s * 0.6, cy - s * 0.1, cx, cy + s * 0.35);
      ctx.closePath();
      break;
    }
    default: ctx.rect(x, y, w, h);
  }
}
function arrowHead(ctx, x0, y0, x1, y1, sw) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  const len = Math.max(6, sw * 4);
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - Math.cos(a - 0.4) * len, y1 - Math.sin(a - 0.4) * len);
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - Math.cos(a + 0.4) * len, y1 - Math.sin(a + 0.4) * len);
}

// ---------------------------------------------------------------- text
export function measureText(props) {
  const lines = String(props.text || '').split('\n');
  const c = makeCanvas(8, 8);
  const cx = c.getContext('2d');
  const size = props.size || 48;
  cx.font = fontString(props);
  let w = 0;
  for (const ln of lines) {
    let lw = 0;
    for (const ch of ln) lw += cx.measureText(ch).width + (props.tracking || 0);
    w = Math.max(w, lw);
  }
  const leading = (props.leading || size * 1.2);
  return { w: Math.ceil(w) + 4, h: Math.ceil(lines.length * leading) + 4, lines, leading };
}
export const fontString = (p) =>
  `${p.style || ''} ${p.weight || 400} ${p.size || 48}px ${p.family || 'Arial'}`;

export function renderText(props) {
  const m = measureText(props);
  const pad = Math.ceil((props.size || 48) * 0.3);
  const c = makeCanvas(Math.max(1, m.w + pad * 2), Math.max(1, m.h + pad * 2));
  const cx = c.getContext('2d');
  cx.font = fontString(props);
  cx.textBaseline = 'top';
  const [r, g, b] = props.color || [0, 0, 0];
  cx.fillStyle = `rgba(${r * 255},${g * 255},${b * 255},${props.opacity ?? 1})`;
  const size = props.size || 48;
  m.lines.forEach((ln, i) => {
    let x = pad;
    let lw = 0;
    for (const ch of ln) lw += cx.measureText(ch).width + (props.tracking || 0);
    if (props.align === 'center') x = (c.width - lw) / 2;
    else if (props.align === 'right') x = c.width - lw - pad;
    let cxPos = x;
    for (const ch of ln) {
      cx.fillText(ch, cxPos, pad + i * m.leading);
      cxPos += cx.measureText(ch).width + (props.tracking || 0);
    }
    if (props.underline) {
      cx.fillRect(x, pad + i * m.leading + size * 1.05, lw, Math.max(1, size * 0.06));
    }
  });
  void size;
  return c;
}

// ---------------------------------------------------------------- patterns
export const PATTERNS = [
  { id: 'solid', name: 'Solid' },
  { id: 'checks', name: 'Checks' },
  { id: 'dots', name: 'Dots' },
  { id: 'lines', name: 'Lines' },
  { id: 'crosshatch', name: 'Crosshatch' },
  { id: 'noise', name: 'Noise' },
  { id: 'bricks', name: 'Bricks' },
  { id: 'waves', name: 'Waves' },
];
export function patternCanvas(id, size = 32, color = [0, 0, 0]) {
  const c = makeCanvas(size, size);
  const cx = c.getContext('2d');
  const col = `rgb(${color[0] * 255},${color[1] * 255},${color[2] * 255})`;
  cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, size, size);
  cx.fillStyle = col; cx.strokeStyle = col;
  switch (id) {
    case 'checks': cx.fillRect(0, 0, size / 2, size / 2); cx.fillRect(size / 2, size / 2, size / 2, size / 2); break;
    case 'dots': cx.beginPath(); cx.arc(size / 2, size / 2, size / 6, 0, TAU); cx.fill(); break;
    case 'lines': cx.fillRect(0, 0, size, size / 4); break;
    case 'crosshatch': cx.lineWidth = 1; cx.beginPath(); cx.moveTo(0, 0); cx.lineTo(size, size); cx.moveTo(size, 0); cx.lineTo(0, size); cx.stroke(); break;
    case 'noise': {
      const rnd = mulberry32(99);
      const id2 = cx.getImageData(0, 0, size, size);
      for (let i = 0; i < id2.data.length; i += 4) {
        const v = rnd() > 0.5 ? 255 : 0;
        id2.data[i] = id2.data[i + 1] = id2.data[i + 2] = v; id2.data[i + 3] = 255;
      }
      cx.putImageData(id2, 0, 0);
      break;
    }
    case 'bricks':
      cx.fillRect(0, 0, size, size / 2 - 1);
      cx.fillRect(-size / 4, size / 2, size / 2 - 1, size / 2);
      cx.fillRect(size / 4 + 1, size / 2, size / 2 - 1, size / 2);
      break;
    case 'waves':
      cx.lineWidth = 1.5; cx.beginPath();
      for (let x = 0; x <= size; x++) cx.lineTo(x, size / 2 + Math.sin((x / size) * TAU * 2) * size / 5);
      cx.stroke();
      break;
    default: break;
  }
  return c;
}
