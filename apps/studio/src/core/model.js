// Document / layer / selection / history model.

import { uid, makeCanvas, copyCanvas, clamp, Emitter, nextName } from './util.js';

export class Selection {
  constructor(w, h) { this.resize(w, h); }
  get canvas() { return this._c; }
  resize(w, h) {
    const old = this._c;
    this._c = makeCanvas(Math.max(1, w), Math.max(1, h));
    if (old) this._c.getContext('2d').drawImage(old, 0, 0);
  }
  get ctx() { return this._c.getContext('2d', { willReadFrequently: true }); }
  get has() { return !!this._has; }
  set has(v) { this._has = v; }

  fillRect(x, y, w, h, mode = 'replace') {
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = mode === 'subtract' ? 'destination-out'
      : mode === 'add' ? 'source-over' : 'source-over';
    if (mode === 'replace' || mode === 'add') {
      c.fillStyle = '#fff';
      c.fillRect(x, y, w, h);
    } else if (mode === 'subtract') {
      c.globalCompositeOperation = 'destination-out';
      c.fillStyle = '#fff';
      c.fillRect(x, y, w, h);
    } else if (mode === 'intersect') {
      const t = makeCanvas(this._c.width, this._c.height);
      const tc = t.getContext('2d');
      tc.fillStyle = '#fff'; tc.fillRect(x, y, w, h);
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(t, 0, 0);
    }
    c.restore();
    this.has = true;
  }
  drawPath(pathFn, mode = 'replace') {
    const c = this.ctx;
    c.save();
    if (mode === 'subtract') c.globalCompositeOperation = 'destination-out';
    else if (mode === 'intersect') c.globalCompositeOperation = 'destination-in';
    c.fillStyle = '#fff';
    c.beginPath(); pathFn(c); c.fill();
    c.restore();
    this.has = true;
  }
  paintCanvas(src, x, y, mode = 'add') {
    const c = this.ctx;
    c.save();
    if (mode === 'subtract') c.globalCompositeOperation = 'destination-out';
    c.drawImage(src, x, y);
    c.restore();
    this.has = true;
  }
  all() { this.none(); this.fillRect(0, 0, this._c.width, this._c.height, 'replace'); }
  none() { this.ctx.clearRect(0, 0, this._c.width, this._c.height); this.has = false; }
  invert() {
    const d = this.ctx.getImageData(0, 0, this._c.width, this._c.height);
    for (let i = 0; i < d.data.length; i += 4) d.data[i + 3] = 255 - d.data[i + 3];
    this.ctx.putImageData(d, 0, 0);
    this.has = true;
  }
  feather(radius) {
    if (radius <= 0) return;
    const { width: w, height: h } = this._c;
    const src = this.ctx.getImageData(0, 0, w, h);
    const out = boxBlurAlpha(new Float32Array(src.data.length / 4).map((_, i) => src.data[i * 4 + 3]), w, h, radius);
    for (let i = 0; i < out.length; i++) src.data[i * 4 + 3] = out[i];
    this.ctx.putImageData(src, 0, 0);
  }
  grow(n) { this._expand(n); }
  shrink(n) { this._expand(-n); }
  _expand(n) {
    const { width: w, height: h } = this._c;
    const src = this.ctx.getImageData(0, 0, w, h);
    const a = new Float32Array(src.data.length / 4);
    for (let i = 0; i < a.length; i++) a[i] = src.data[i * 4 + 3] / 255;
    const r = Math.abs(Math.round(n));
    const out = new Float32Array(a.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let best = n > 0 ? 0 : 1;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy));
        const v = a[yy * w + xx];
        if (n > 0) { if (v > best) best = v; } else if (v < best) best = v;
      }
      out[y * w + x] = best;
    }
    for (let i = 0; i < out.length; i++) src.data[i * 4 + 3] = out[i] * 255;
    this.ctx.putImageData(src, 0, 0);
  }
  smooth(n = 1) { this.feather(n); }
  bounds() {
    const { width: w, height: h } = this._c;
    const d = this.ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  clone() { const s = new Selection(1, 1); s._c = copyCanvas(this._c); s._has = this._has; return s; }
  alphaAt(x, y) {
    if (x < 0 || y < 0 || x >= this._c.width || y >= this._c.height) return 0;
    return this.ctx.getImageData(x | 0, y | 0, 1, 1).data[3];
  }
  coverage() {
    const d = this.ctx.getImageData(0, 0, this._c.width, this._c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n / (this._c.width * this._c.height);
  }
}

export function boxBlurAlpha(a, w, h, r) {
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  const rr = Math.max(1, Math.round(r));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let k = -rr; k <= rr; k++) { const xx = Math.min(w - 1, Math.max(0, x + k)); s += a[y * w + xx]; n++; }
    tmp[y * w + x] = s / n;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let k = -rr; k <= rr; k++) { const yy = Math.min(h - 1, Math.max(0, y + k)); s += tmp[yy * w + x]; n++; }
    out[y * w + x] = s / n;
  }
  return out;
}

let _layerSeq = 0;
export class Layer {
  constructor(opts = {}) {
    this.id = opts.id || uid('L');
    this.type = opts.type || 'raster';      // raster | group | adjustment | text | shape
    this.name = opts.name || `Layer ${++_layerSeq}`;
    this.visible = opts.visible !== false;
    this.opacity = opts.opacity ?? 1;
    this.blend = opts.blend || 'normal';
    this.locked = !!opts.locked;
    this.alphaLocked = !!opts.alphaLocked;
    this.clipped = !!opts.clipped;          // clipping mask onto the layer below
    this.x = opts.x || 0; this.y = opts.y || 0;
    this.mask = null;                        // canvas (grayscale) or null
    this.maskEnabled = true;
    this.maskLinked = true;
    this.canvas = opts.canvas || null;
    this.children = this.type === 'group' ? (opts.children || []) : null;
    this.expanded = true;
    this.adjustment = opts.adjustment || null;   // {kind, params}
    this.props = opts.props || {};               // text/shape params
    this.fx = opts.fx || null;                   // layer effects (phase 2)
    this.thumbs = null;
  }
  get isGroup() { return this.type === 'group'; }
  get hasMask() { return !!this.mask; }
}

export class Doc {
  constructor(w, h, opts = {}) {
    this.id = uid('doc');
    this.width = Math.max(1, Math.round(w));
    this.height = Math.max(1, Math.round(h));
    this.dpi = opts.dpi || 72;
    this.name = opts.name || 'Untitled';
    this.colorMode = opts.colorMode || 'rgb';
    this.bitDepth = opts.bitDepth || 8;
    this.background = opts.background || 'transparent'; // transparent | white | black
    this.layers = [];
    this.selection = new Selection(this.width, this.height);
    this.guides = [];
    this.paths = [];
    this.activeLayerId = null;
    this.emitter = new Emitter();
    this.dirty = false;
  }
  emit(...a) { this.emitter.emit(...a); }

  // ---- tree helpers
  find(id, list = this.layers) {
    for (const l of list) {
      if (l.id === id) return l;
      if (l.children) { const f = this.find(id, l.children); if (f) return f; }
    }
    return null;
  }
  parentOf(id, list = this.layers, parent = null) {
    for (const l of list) {
      if (l.id === id) return parent;
      if (l.children) { const p = this.parentOf(id, l.children, l); if (p !== undefined && p !== null) return p; }
    }
    return null;
  }
  siblings(id) {
    const p = this.parentOf(id);
    return p ? p.children : this.layers;
  }
  flat(list = this.layers, out = []) {
    for (const l of list) { out.push(l); if (l.children) this.flat(l.children, out); }
    return out;
  }
  get activeLayer() { return this.find(this.activeLayerId); }
  set activeLayer(l) { this.activeLayerId = l ? l.id : null; }
  visibleLayers(list = this.layers, out = []) {
    for (const l of list) {
      if (!l.visible) continue;
      out.push(l);
      if (l.children) this.visibleLayers(l.children, out);
    }
    return out;
  }
  indexIn(list, id) { return list.findIndex((l) => l.id === id); }

  // ---- structure edits
  addLayer(layer, { above = null, into = null, select = true } = {}) {
    const list = into ? into.children : this.layers;
    if (above) {
      const i = list.findIndex((l) => l.id === above);
      list.splice(i < 0 ? list.length : i + 1, 0, layer);
    } else {
      list.push(layer); // storage order is bottom to top (renderList iterates forward)
    }
    if (select) this.activeLayerId = layer.id;
    this.dirty = true;
    return layer;
  }
  removeLayer(id) {
    const list = this.siblings(id);
    const i = list.findIndex((l) => l.id === id);
    if (i >= 0) {
      const [gone] = list.splice(i, 1);
      if (this.activeLayerId === id) {
        const all = this.flat().filter((l) => l.type !== 'group' || l.children.length === 0);
        this.activeLayerId = (all[Math.max(0, Math.min(all.length - 1, i))] || this.layers[this.layers.length - 1] || null)?.id || null;
      }
      this.dirty = true;
      return gone;
    }
    return null;
  }
  moveLayer(id, targetId, position /* 'above'|'below'|'into' */) {
    if (id === targetId) return false;
    const layer = this.find(id);
    if (!layer) return false;
    // prevent moving a group into itself
    if (position === 'into' && this.flat([layer]).some((l) => l.id === targetId)) return false;
    const from = this.siblings(id);
    const fi = from.findIndex((l) => l.id === id);
    from.splice(fi, 1);
    if (position === 'into') {
      const t = this.find(targetId);
      t.children.unshift(layer); t.expanded = true;
    } else {
      const target = this.find(targetId);
      const to = this.siblings(targetId);
      const ti = to.findIndex((l) => l.id === targetId);
      to.splice(position === 'above' ? ti + 1 : ti, 0, layer);
    }
    this.dirty = true;
    return true;
  }
  uniqueName(base) {
    const names = new Set(this.flat().map((l) => l.name));
    return nextName(base, names);
  }
  resize(w, h, { scale = false } = {}) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    this.selection.resize(w, h);
    if (scale) {
      const sx = w / this.width, sy = h / this.height;
      for (const l of this.flat()) {
        if (l.canvas) { l.canvas = scaledCanvas(l.canvas, sx, sy); l.x = Math.round(l.x * sx); l.y = Math.round(l.y * sy); }
        if (l.mask) l.mask = scaledCanvas(l.mask, sx, sy);
      }
    }
    this.width = w; this.height = h; this.dirty = true;
  }
}

export function scaledCanvas(src, sx, sy) {
  const c = makeCanvas(Math.max(1, Math.round(src.width * sx)), Math.max(1, Math.round(src.height * sy)));
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
  cx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// ------------------------------------------------------------------ history
export class History {
  constructor(limit = 50) {
    this.limit = limit;
    this.past = [];
    this.future = [];
    this.current = null;
  }
  reset(snapshot, label = 'Open') {
    this.past = [];
    this.future = [];
    this.current = snapshot;
    this._label = label;
  }
  push(label, snapshot) {
    if (this.current) this.past.push({ label: this._label ?? 'Edit', snap: this.current });
    if (this.past.length > this.limit) this.past.shift();
    this.current = snapshot;
    this._label = label;
    this.future = [];
  }
  undo() {
    if (!this.past.length) return null;
    const entry = this.past.pop();
    if (this.current) this.future.unshift({ label: this._label || 'Edit', snap: this.current });
    this.current = entry.snap;
    this._label = entry.label;
    return entry;
  }
  redo() {
    if (!this.future.length) return null;
    const entry = this.future.shift();
    if (this.current) this.past.push({ label: this._label || 'Edit', snap: this.current });
    this.current = entry.snap;
    this._label = entry.label;
    return entry;
  }
  get entries() {
    const out = this.past.map((p, i) => ({ label: p.label, index: i, state: 'past' }));
    if (this.current) out.push({ label: this._label || 'Edit', index: this.past.length, state: 'current' });
    out.push(...this.future.map((f, i) => ({ label: f.label, index: this.past.length + 1 + i, state: 'future' })));
    return out;
  }
}

export function snapshotDoc(doc) {
  const cloneLayer = (l) => {
    const n = new Layer({
      id: l.id, type: l.type, name: l.name, visible: l.visible, opacity: l.opacity,
      blend: l.blend, locked: l.locked, alphaLocked: l.alphaLocked, clipped: l.clipped,
      x: l.x, y: l.y,
    });
    n.maskEnabled = l.maskEnabled; n.maskLinked = l.maskLinked; n.expanded = l.expanded;
    n.canvas = l.canvas ? copyCanvas(l.canvas) : null;
    n.mask = l.mask ? copyCanvas(l.mask) : null;
    n.adjustment = l.adjustment ? { kind: l.adjustment.kind, params: structuredClone(l.adjustment.params) } : null;
    n.props = structuredClone(l.props || {});
    n.fx = l.fx ? structuredClone(l.fx) : null;
    if (l.children) n.children = l.children.map(cloneLayer);
    return n;
  };
  const snap = {
    width: doc.width, height: doc.height, dpi: doc.dpi, name: doc.name,
    background: doc.background, colorMode: doc.colorMode, bitDepth: doc.bitDepth,
    activeLayerId: doc.activeLayerId,
    layers: doc.layers.map(cloneLayer),
    selection: { canvas: copyCanvas(doc.selection.canvas), has: doc.selection.has },
    guides: structuredClone(doc.guides),
    paths: structuredClone(doc.paths),
  };
  return snap;
}

export function restoreDoc(doc, snap) {
  doc.width = snap.width; doc.height = snap.height; doc.dpi = snap.dpi; doc.name = snap.name;
  doc.background = snap.background; doc.colorMode = snap.colorMode; doc.bitDepth = snap.bitDepth;
  doc.activeLayerId = snap.activeLayerId;
  const rebuild = (list) => list.map((s) => {
    const n = new Layer({
      id: s.id, type: s.type, name: s.name, visible: s.visible, opacity: s.opacity,
      blend: s.blend, locked: s.locked, alphaLocked: s.alphaLocked, clipped: s.clipped,
      x: s.x, y: s.y,
    });
    n.maskEnabled = s.maskEnabled; n.maskLinked = s.maskLinked; n.expanded = s.expanded;
    n.canvas = s.canvas ? copyCanvas(s.canvas) : null;
    n.mask = s.mask ? copyCanvas(s.mask) : null;
    n.adjustment = s.adjustment ? { kind: s.adjustment.kind, params: structuredClone(s.adjustment.params) } : null;
    n.props = structuredClone(s.props || {});
    n.fx = s.fx ? structuredClone(s.fx) : null;
    if (s.children) n.children = rebuild(s.children);
    return n;
  });
  doc.layers = rebuild(snap.layers);
  doc.selection = new Selection(snap.selection.canvas.width, snap.selection.canvas.height);
  doc.selection._c = copyCanvas(snap.selection.canvas);
  doc.selection.has = snap.selection.has;
  doc.guides = structuredClone(snap.guides);
  doc.paths = structuredClone(snap.paths);
  doc.dirty = true;
}

export const clampPct = (v) => clamp(v, 0, 100);
