// Central application state: document, view, tools, history, rendering.

import {
  Emitter, makeCanvas, copyCanvas, clamp, uid, el, qs, toast, busy, rafThrottle, dist,
} from './core/util.js';
import { Doc, Layer, History, snapshotDoc, restoreDoc, scaledCanvas, Selection } from './core/model.js';
import { rgb2hex, hex2rgb, blendOp, needsCustomBlend, customBlend, rgbToHsl, hslToRgb } from './core/color.js';
import { renderDoc, renderList, mergeLayers, layerThumb, maskThumb } from './engine/composite.js';
import { Stroke, shapePath, gradientFill, floodFill, renderText, patternCanvas, snapshotCanvas } from './engine/draw.js';
import { applyAdjustment } from './engine/adjust.js';
import { FILTERS, getFilter } from './engine/filters.js';
import './engine/filters-art.js';
import { resample, rotate90, flip, rotateArbitrary, projectCanvas, quadToUnit, mul3 } from './engine/transform.js';
import { TOOLS, TOOL_BY_ID } from './tools/index.js';
import './tools/paint.js';
import { canvasFromFile, exportCanvas } from './io/formats.js';
import { modal } from './ui/modal.js';

const CURSORS = {
  crosshair: 'crosshair', brush: 'crosshair', move: 'move', grab: 'grab', text: 'text',
  eyedropper: 'crosshair', bucket: 'crosshair', zoom: 'zoom-in', default: 'default',
};

export class App {
  constructor(root) {
    this.root = root;
    this.emitter = new Emitter();
    this.doc = null;
    this.history = new History(60);
    this.tool = 'brush';
    this.prevTool = 'move';
    this.toolOptions = {};
    this.fg = [0, 0, 0];
    this.bg = [1, 1, 1];
    this.view = { zoom: 1, panX: 0, panY: 0, rotation: 0 };
    this.drag = null;
    this.stroke = null;
    this.maskEditingLayerId = null;
    this.strokeMaskMode = null;
    this.cloneSource = null;
    this.measure = null;
    this.ants = 0;
    this.antTimer = null;
    this.compCanvas = null;
    this.showRulers = true;
    this.showGuides = true;
    this.showGrid = false;
    this.gridSize = 32;
    this.snapTo = true;
    this.transform = null;      // active free-transform
    this.lastTransform = null;  // for Transform Again
    this.clipboard = null;
    this.lastFilter = null;
    this.channelPreview = null; // 'r' | 'g' | 'b' | 'mask' | null
    this.lastPointer = { x: 0, y: 0 };
    this.prefs = { units: 'px', gridSize: 32, historyStates: 60, checkerboard: true };
    this._model = { Selection, Doc, Layer, snapshotDoc, restoreDoc, scaledCanvas };
    for (const t of TOOLS) {
      this.toolOptions[t.id] = {};
      for (const o of (t.options || [])) if (o.def !== undefined) this.toolOptions[t.id][o.key] = structuredClone(o.def);
    }
  }

  // ---------------------------------------------------------------- mount
  mount() {
    this.viewport = qs('#viewport');
    this.canvasArea = qs('#canvasarea');
    this.holder = qs('#canvasholder');
    this.viewCanvas = qs('#view');
    this.overlayCanvas = qs('#overlay');
    this.viewCtx = this.viewCanvas.getContext('2d', { willReadFrequently: true });
    this.overlayCtx = this.overlayCanvas.getContext('2d');

    this.viewport.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.viewport.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.viewport.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    this.viewport.addEventListener('contextmenu', (e) => e.preventDefault());

    const dz = qs('#dropzone');
    window.addEventListener('dragover', (e) => { e.preventDefault(); dz.hidden = false; });
    window.addEventListener('dragleave', (e) => { if (e.relatedTarget == null) dz.hidden = true; });
    window.addEventListener('drop', async (e) => {
      e.preventDefault(); dz.hidden = true;
      const f = e.dataTransfer?.files?.[0];
      if (f) await this.openFile(f);
    });

    this.update = rafThrottle((opts = {}) => this._update(opts));
    setInterval(() => this.animateAnts(), 120);
  }

  // ---------------------------------------------------------------- document
  setDoc(doc, label = 'New') {
    this.doc = doc;
    this.maskEditingLayerId = null;
    this.compCanvas = makeCanvas(doc.width, doc.height);
    this.history.reset(snapshotDoc(doc), label);
    this.view = { zoom: 1, panX: 0, panY: 0, rotation: 0 };
    this.fitToScreen();
    this.emitter.emit('doc', doc);
    this.update({ render: true, overlay: true, panels: true, transform: true, status: true });
  }

  get docW() { return this.doc ? this.doc.width : 0; }
  get docH() { return this.doc ? this.doc.height : 0; }

  // ---------------------------------------------------------------- update
  _update(opts = {}) {
    if (!this.doc) return;
    if (opts.transform) this.applyTransform();
    if (opts.render) this.render();
    if (opts.overlay !== false) this.drawOverlay();
    if (opts.panels) this.emitter.emit('panels');
    if (opts.status) this.emitter.emit('status');
    if (opts.toolbar) this.emitter.emit('toolbar');
  }

  applyTransform() {
    const v = this.view;
    this.holder.style.transform = `translate(${v.panX}px,${v.panY}px) scale(${v.zoom}) rotate(${v.rotation}deg)`;
    this.emitter.emit('status');
  }

  render() {
    const doc = this.doc;
    if (!doc) return;
    if (this.compCanvas.width !== doc.width || this.compCanvas.height !== doc.height) {
      this.compCanvas = makeCanvas(doc.width, doc.height);
    }
    const c = renderDoc(doc);
    const cx = this.compCanvas.getContext('2d');
    cx.clearRect(0, 0, doc.width, doc.height);
    cx.drawImage(c, 0, 0);

    this.holder.style.width = doc.width + 'px';
    this.holder.style.height = doc.height + 'px';
    if (this.viewCanvas.width !== doc.width || this.viewCanvas.height !== doc.height) {
      this.viewCanvas.width = doc.width; this.viewCanvas.height = doc.height;
      this.overlayCanvas.width = doc.width; this.overlayCanvas.height = doc.height;
    }
    this.viewCtx.clearRect(0, 0, doc.width, doc.height);
    this.viewCtx.drawImage(this.channelPreview ? this.channelView() : this.compCanvas, 0, 0);

    if (this.stroke) {
      const s = this.stroke;
      this.viewCtx.save();
      this.viewCtx.globalAlpha = (s.o.opacity ?? 100) / 100;
      this.viewCtx.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : (blendOp(s.o.blend) || 'source-over');
      this.viewCtx.drawImage(s.canvas, 0, 0);
      this.viewCtx.restore();
    }
    this.emitter.emit('rendered');
  }

  animateAnts() {
    if (!this.doc?.selection?.has) return;
    this.ants = (this.ants + 1) % 10;
    this.drawOverlay();
  }

  // ---------------------------------------------------------------- overlay
  drawOverlay() {
    const doc = this.doc;
    if (!doc) return;
    const ctx = this.overlayCtx;
    const w = doc.width, h = doc.height;
    ctx.clearRect(0, 0, w, h);
    const z = Math.max(0.05, this.view.zoom);
    const px = 1 / z;

    // grid
    if (this.showGrid) {
      ctx.strokeStyle = 'rgba(120,140,180,0.25)';
      ctx.lineWidth = px;
      ctx.beginPath();
      for (let x = 0; x <= w; x += this.gridSize) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      for (let y = 0; y <= h; y += this.gridSize) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
    }

    // selection marching ants
    if (doc.selection.has) this.drawSelection(ctx, px);

    // guides
    if (this.showGuides) {
      ctx.strokeStyle = 'rgba(80,170,255,0.85)';
      ctx.lineWidth = px;
      for (const g of doc.guides || []) {
        ctx.beginPath();
        if (g.orientation === 'h') { ctx.moveTo(0, g.position); ctx.lineTo(w, g.position); }
        else { ctx.moveTo(g.position, 0); ctx.lineTo(g.position, h); }
        ctx.stroke();
      }
    }

    // samplers
    for (const s of doc.samplers || []) {
      ctx.fillStyle = s.color ? `rgb(${s.color.map((v) => v * 255).join(',')})` : '#fff';
      ctx.strokeStyle = '#000'; ctx.lineWidth = px;
      ctx.beginPath(); ctx.arc(s.x, s.y, 6 * px, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = `${10 * px}px sans-serif`;
      ctx.fillText(`${s.x},${s.y}`, s.x + 9 * px, s.y - 6 * px);
    }
    for (const n of doc.notes || []) {
      ctx.fillStyle = '#ffd85e'; ctx.strokeStyle = '#8a6b00'; ctx.lineWidth = px;
      ctx.fillRect(n.x, n.y, 16 * px, 16 * px); ctx.strokeRect(n.x, n.y, 16 * px, 16 * px);
    }
    for (const c of doc.counts || []) {
      ctx.fillStyle = '#ff5b5b'; ctx.beginPath(); ctx.arc(c.x, c.y, 7 * px, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `${9 * px}px sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(String(c.n), c.x, c.y + 3 * px); ctx.textAlign = 'left';
    }

    // live drag previews
    const d = this.drag;
    if (d) {
      ctx.save();
      ctx.strokeStyle = '#4c8dff'; ctx.lineWidth = px;
      ctx.setLineDash([4 * px, 3 * px]);
      ctx.lineDashOffset = -this.ants;
      if (d.kind === 'marquee') {
        ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      } else if (d.kind === 'freehand' || d.kind === 'poly' || d.kind === 'magnetic' || d.kind === 'patch' || d.kind === 'freePath') {
        const pts = d.pts || [];
        if (pts.length) {
          ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
          for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
          if (d.hover) ctx.lineTo(d.hover[0], d.hover[1]);
          if (d.kind !== 'freePath') ctx.closePath();
          ctx.stroke();
          if (d.kind === 'magnetic' || d.kind === 'poly') {
            ctx.setLineDash([]);
            for (const p of pts) { ctx.beginPath(); ctx.arc(p[0], p[1], 2.5 * px, 0, Math.PI * 2); ctx.fillStyle = '#4c8dff'; ctx.fill(); }
          }
        }
      } else if (d.kind === 'crop') {
        ctx.setLineDash([]);
        const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
        const dw = Math.abs(d.x1 - d.x0), dh = Math.abs(d.y1 - d.y0);
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, 0, w, y); ctx.fillRect(0, y + dh, w, h - y - dh);
        ctx.fillRect(0, y, x, dh); ctx.fillRect(x + dw, y, w - x - dw, dh);
        ctx.strokeStyle = '#fff'; ctx.strokeRect(x, y, dw, dh);
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.beginPath();
        for (let i = 1; i < 3; i++) { ctx.moveTo(x + (dw * i) / 3, y); ctx.lineTo(x + (dw * i) / 3, y + dh); ctx.moveTo(x, y + (dh * i) / 3); ctx.lineTo(x + dw, y + (dh * i) / 3); }
        ctx.stroke();
      } else if (d.kind === 'pcrop') {
        const pts = d.pts;
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
        ctx.stroke();
        for (const p of pts) { ctx.beginPath(); ctx.arc(p[0], p[1], 4 * px, 0, Math.PI * 2); ctx.fillStyle = '#4c8dff'; ctx.fill(); }
      } else if (d.kind === 'shape') {
        ctx.setLineDash([]);
        const o = this.toolOptions[this.tool] || {};
        this.previewShape(ctx, d, o, px);
      } else if (d.kind === 'gradient') {
        ctx.setLineDash([4 * px, 3 * px]);
        ctx.beginPath(); ctx.moveTo(d.x0, d.y0); ctx.lineTo(d.x1, d.y1); ctx.stroke();
      } else if (d.kind === 'ruler') {
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(d.x0, d.y0); ctx.lineTo(d.x1, d.y1); ctx.stroke();
      } else if (d.kind === 'quick') {
        // nothing extra; selection ants show it
      }
      ctx.restore();
    }

    // transform box
    if (this.transform) this.drawTransformBox(ctx, px);

    // paths
    for (const path of doc.paths || []) this.drawPath(ctx, path, px, false);
    if (this.activePath) this.drawPath(ctx, this.activePath, px, true);

    // canvas border
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = px;
    ctx.strokeRect(0, 0, w, h);
  }

  drawSelection(ctx, px) {
    const sel = this.doc.selection;
    const w = sel.canvas.width, h = sel.canvas.height;
    const d = sel.ctx.getImageData(0, 0, w, h).data;
    ctx.save();
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.lineDashOffset = -this.ants * 1.4;
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2 * px;
    this.traceSelection(ctx, d, w, h, px);
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.lineDashOffset = -this.ants * 1.4 + 4 * px;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1 * px;
    this.traceSelection(ctx, d, w, h, px);
    ctx.restore();
  }

  traceSelection(ctx, d, w, h, px) {
    // marching squares on the alpha channel
    const step = Math.max(1, Math.floor(1 / Math.max(0.08, this.view.zoom)));
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[(y * w + x) * 4 + 3] > 127 ? 1 : 0);
    ctx.beginPath();
    for (let y = 0; y < h - step; y += step) {
      for (let x = 0; x < w - step; x += step) {
        const a = at(x, y), b = at(x + step, y), c = at(x + step, y + step), e = at(x, y + step);
        const code = (a << 3) | (b << 2) | (c << 1) | e;
        if (code === 0 || code === 15) continue;
        void px;
        const mid = (p1x, p1y, p2x, p2y) => [(p1x + p2x) / 2, (p1y + p2y) / 2];
        const segs = [];
        if ((a && !b) || (!a && b)) segs.push([mid(x, y, x + step, y), [x + step, y]]);
        if ((b && !c) || (!b && c)) segs.push([mid(x + step, y, x + step, y + step), [x + step, y + step]]);
        if ((c && !e) || (!c && e)) segs.push([mid(x + step, y + step, x, y + step), [x + step, y + step]]);
        if ((e && !a) || (!e && a)) segs.push([mid(x, y + step, x, y), [x, y + step]]);
        for (const [p1, p2] of segs) { ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); }
      }
    }
    ctx.stroke();
  }

  previewShape(ctx, d, o, px) {
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    let w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (d.constrain) { const m = Math.max(w, h); w = h = m; }
    ctx.save();
    shapePath(ctx, d.shape, x, y, w, h, { ...o, radius: o.radius, sides: o.sides, inner: (o.inner ?? 45) / 100 });
    if (o.fill !== 'none') {
      ctx.fillStyle = this.fillStyleFor(o, x, y, w, h);
      ctx.fill();
    }
    if (o.strokeWidth > 0) {
      ctx.strokeStyle = `rgb(${(o.stroke || [0, 0, 0]).map((v) => v * 255).join(',')})`;
      ctx.lineWidth = (o.strokeWidth || 1) * 1;
      ctx.stroke();
    }
    ctx.restore();
    void px;
  }

  fillStyleFor(o, x, y, w, h) {
    if (o.fill === 'gradient') return gradientFill(useCtx(), 'linear', o.stops || [[0, [0, 0, 0], 1], [1, [1, 1, 1], 1]], x, y, x + w, y + h);
    if (o.fill === 'pattern') {
      const p = patternCanvas(o.pattern || 'checks', 32, this.fg);
      const cx = useCtx();
      return cx.createPattern(p, 'repeat');
    }
    return `rgb(${this.fg.map((v) => v * 255).join(',')})`;
  }

  drawPath(ctx, path, px, active) {
    if (!path?.anchors?.length) return;
    ctx.save();
    ctx.strokeStyle = active ? '#4c8dff' : '#8a93a3';
    ctx.lineWidth = px;
    ctx.beginPath();
    const a0 = path.anchors[0];
    ctx.moveTo(a0.x, a0.y);
    for (let i = 1; i < path.anchors.length; i++) {
      const p0 = path.anchors[i - 1], p1 = path.anchors[i];
      if (p0.hOut || p1.hIn) ctx.bezierCurveTo(p0.hOut?.x ?? p0.x, p0.hOut?.y ?? p0.y, p1.hIn?.x ?? p1.x, p1.hIn?.y ?? p1.y, p1.x, p1.y);
      else ctx.lineTo(p1.x, p1.y);
    }
    if (path.closed) {
      const last = path.anchors[path.anchors.length - 1];
      if (last.hOut || a0.hIn) ctx.bezierCurveTo(last.hOut?.x ?? last.x, last.hOut?.y ?? last.y, a0.hIn?.x ?? a0.x, a0.hIn?.y ?? a0.y, a0.x, a0.y);
      else ctx.closePath();
    }
    ctx.stroke();
    if (active) {
      for (const a of path.anchors) {
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#4c8dff';
        ctx.beginPath(); ctx.arc(a.x, a.y, 3.5 * px, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        for (const hd of [a.hIn, a.hOut]) {
          if (!hd) continue;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(hd.x, hd.y); ctx.stroke();
          ctx.beginPath(); ctx.arc(hd.x, hd.y, 2.5 * px, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- view maths
  screenToDoc(clientX, clientY) {
    const r = this.viewCanvas.getBoundingClientRect();
    return {
      x: (clientX - r.left) / r.width * this.doc.width,
      y: (clientY - r.top) / r.height * this.doc.height,
    };
  }
  pointerInfo(e) {
    const p = this.screenToDoc(e.clientX, e.clientY);
    p.sx = e.clientX; p.sy = e.clientY;
    p.shift = e.shiftKey; p.alt = e.altKey; p.ctrl = e.ctrlKey; p.meta = e.metaKey;
    p.button = e.button;
    p.pressure = e.pressure || 1;
    return p;
  }
  zoomAt(sx, sy, factor) {
    const r = this.viewport.getBoundingClientRect();
    const mx = sx - r.left, my = sy - r.top;
    const v = this.view;
    const z0 = v.zoom;
    const z1 = clamp(z0 * factor, 0.02, 64);
    v.panX = mx - ((mx - v.panX) / z0) * z1;
    v.panY = my - ((my - v.panY) / z0) * z1;
    v.zoom = z1;
  }
  fitToScreen() {
    if (!this.doc) return;
    const pad = 40;
    const aw = this.canvasArea.clientWidth - pad, ah = this.canvasArea.clientHeight - pad;
    this.view.zoom = Math.min(aw / this.doc.width, ah / this.doc.height, 1);
    this.view.panX = (this.canvasArea.clientWidth - this.doc.width * this.view.zoom) / 2;
    this.view.panY = (this.canvasArea.clientHeight - this.doc.height * this.view.zoom) / 2;
    this.applyTransform();
  }
  zoomTo(z) {
    const r = this.viewport.getBoundingClientRect();
    const mx = r.width / 2, my = r.height / 2;
    const v = this.view;
    const z0 = v.zoom;
    v.panX = mx - ((mx - v.panX) / z0) * z;
    v.panY = my - ((my - v.panY) / z0) * z;
    v.zoom = z;
    this.update({ transform: true });
  }

  // ---------------------------------------------------------------- pointer
  setActiveTool(id, silent) {
    const t = TOOL_BY_ID.get(id);
    if (!t) return;
    if (this.tool !== id) this.prevTool = this.tool;
    this.tool = id;
    if (this.maskEditingLayerId && !['brush', 'pencil', 'eraser'].includes(id)) this.maskEditingLayerId = null;
    this.drag = null;
    this.viewport.style.cursor = CURSORS[t.cursor] || 'default';
    if (!silent) this.update({ toolbar: true, overlay: true });
  }

  onPointerDown(e) {
    if (!this.doc) return;
    if (e.button === 1) { this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: this.view.panX, oy: this.view.panY }; return; }
    if (e.button === 2) return;
    const t = TOOL_BY_ID.get(this.tool);
    const p = this.pointerInfo(e);
    if (this.transform && this.transformHit(p)) { this.startTransformDrag(p); return; }
    if (p.alt && (t.id === 'cloneStamp' || t.id === 'healBrush')) { this.setCloneSource(p.x, p.y); return; }
    if (p.ctrl || p.meta) {
      // ctrl-click selects the layer under the cursor
      const hit = this.hitTestLayer(p.x, p.y);
      if (hit) { this.doc.activeLayerId = hit.id; this.update({ panels: true }); return; }
    }
    if (t?.onDown2 && t.onDown2(this, p)) return;
    t?.onDown?.(this, p);
  }
  onPointerMove(e) {
    if (!this.doc) return;
    const p = this.pointerInfo(e);
    this.lastPointer = p;
    const t = TOOL_BY_ID.get(this.tool);
    if (this.drag?.kind === 'pan' || this.drag?.kind === 'rotateView') { t?.onMove?.(this, p); return; }
    if (this.drag && this.drag.kind === 'transform') { this.moveTransform(p); return; }
    t?.onMove?.(this, p);
    this.emitter.emit('cursor', p);
  }
  onPointerUp(e) {
    if (!this.doc) return;
    const p = this.pointerInfo(e);
    const t = TOOL_BY_ID.get(this.tool);
    if (this.drag?.kind === 'pan') { this.drag = null; return; }
    if (this.drag?.kind === 'transform') { this.drag = null; return; }
    t?.onUp?.(this, p);
  }
  onDoubleClick(e) {
    const t = TOOL_BY_ID.get(this.tool);
    const p = this.pointerInfo(e);
    if (t?.onDoubleClick) t.onDoubleClick(this, p);
    else if (this.drag) { t?.onCommit?.(this); this.drag = null; }
    else if (t?.onCommit) t.onCommit(this);
    else if (this.tool === 'move') this.beginTransform();
  }
  onWheel(e) {
    if (!this.doc) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    } else if (e.shiftKey) {
      this.view.panX -= e.deltaY;
    } else {
      this.view.panX -= e.deltaX; this.view.panY -= e.deltaY;
    }
    this.update({ transform: true });
  }

  status(msg) { this._status = msg; this.emitter.emit('status'); toast(msg); }

  // ---------------------------------------------------------------- history
  push(label) {
    if (!this.doc) return;
    this.doc.dirty = true;
    this.history.push(label, snapshotDoc(this.doc));
    this.update({ render: true, panels: true, status: true });
  }
  commit(label) {
    this.push(label || 'Edit');
  }
  undo() {
    const e = this.history.undo();
    if (!e) return;
    restoreDoc(this.doc, e.snap);
    if (!this.doc.find(this.maskEditingLayerId)?.mask) this.maskEditingLayerId = null;
    this.afterDocRestore();
    this.status('Undo ' + e.label);
  }
  redo() {
    const e = this.history.redo();
    if (!e) return;
    restoreDoc(this.doc, e.snap);
    if (!this.doc.find(this.maskEditingLayerId)?.mask) this.maskEditingLayerId = null;
    this.afterDocRestore();
    this.status('Redo ' + e.label);
  }
  afterDocRestore() {
    if (this.compCanvas.width !== this.doc.width || this.compCanvas.height !== this.doc.height) {
      this.compCanvas = makeCanvas(this.doc.width, this.doc.height);
    }
    this.update({ render: true, overlay: true, panels: true, status: true, toolbar: true });
  }
  pushSelectionHistory(before, label) {
    // The previous snapshot is already in history.current; record the edited selection.
    this.push(label);
    this.update({ overlay: true });
    void before;
  }

  // ---------------------------------------------------------------- layers
  activeRaster(create = true) {
    const doc = this.doc;
    let L = doc.activeLayer;
    if (L && (L.type === 'raster' || L.type === 'text' || L.type === 'shape')) return L;
    if (!create) return null;
    const base = doc.flat().find((l) => l.type === 'raster');
    if (base) { doc.activeLayerId = base.id; return base; }
    L = new Layer({ name: doc.uniqueName('Layer'), canvas: makeCanvas(doc.width, doc.height) });
    doc.addLayer(L);
    return L;
  }
  addLayer(opts = {}) {
    const doc = this.doc;
    const L = new Layer({ name: doc.uniqueName(opts.name || 'Layer'), ...opts });
    if (!L.canvas) L.canvas = makeCanvas(doc.width, doc.height);
    doc.addLayer(L, { above: doc.activeLayerId, into: opts.into });
    this.push(opts.label || 'New Layer');
    return L;
  }
  duplicateLayer() {
    const doc = this.doc;
    const L = doc.activeLayer;
    if (!L) return;
    const copy = new Layer({
      type: L.type, name: doc.uniqueName(L.name + ' copy'), opacity: L.opacity, blend: L.blend,
      clipped: L.clipped, x: L.x, y: L.y, adjustment: L.adjustment ? structuredClone(L.adjustment) : null,
      props: structuredClone(L.props || {}),
    });
    copy.canvas = L.canvas ? copyCanvas(L.canvas) : null;
    copy.mask = L.mask ? copyCanvas(L.mask) : null;
    if (L.children) copy.children = L.children.map(() => null).filter(Boolean);
    doc.addLayer(copy, { above: L.id });
    this.push('Duplicate Layer');
  }
  deleteLayer() {
    const doc = this.doc;
    const L = doc.activeLayer;
    if (!L) return;
    doc.removeLayer(L.id);
    this.push('Delete Layer');
  }
  mergeDown() {
    const doc = this.doc;
    const L = doc.activeLayer;
    if (!L) return;
    const sib = doc.siblings(L.id);
    const i = sib.findIndex((l) => l.id === L.id);
    if (i <= 0) { this.status('No layer below'); return; }
    const below = sib[i - 1];
    const merged = mergeLayers(doc, [below, L]);
    below.canvas = merged;
    below.mask = null;
    doc.activeLayerId = below.id;
    doc.removeLayer(L.id);
    this.push('Merge Down');
  }
  mergeVisible() {
    const doc = this.doc;
    const flat = renderDoc(doc);
    doc.layers = [new Layer({ name: 'Merged', canvas: flat })];
    doc.activeLayerId = doc.layers[0].id;
    this.push('Merge Visible');
  }
  flatten() {
    const doc = this.doc;
    const flat = renderDoc(doc);
    const bg = new Layer({ name: 'Background', canvas: flat });
    bg.canvas = this.bakeBackground(bg.canvas);
    doc.layers = [bg];
    doc.activeLayerId = bg.id;
    this.push('Flatten Image');
  }
  bakeBackground(c) {
    if (this.doc.background === 'white') {
      const o = makeCanvas(c.width, c.height);
      const cx = o.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      cx.drawImage(c, 0, 0);
      return o;
    }
    return c;
  }
  newGroupFromLayers() {
    const doc = this.doc;
    const L = doc.activeLayer;
    if (!L) return;
    const g = new Layer({ type: 'group', name: doc.uniqueName('Group'), children: [] });
    const sib = doc.siblings(L.id);
    const i = sib.findIndex((l) => l.id === L.id);
    sib.splice(i, 1);
    g.children.push(L);
    sib.splice(i, 0, g);
    doc.activeLayerId = g.id;
    this.push('Group Layers');
  }
  addMask(kind = 'reveal') {
    const doc = this.doc;
    const L = doc.activeLayer;
    if (!L || L.type === 'group' && false) return;
    const m = makeCanvas(doc.width, doc.height);
    const cx = m.getContext('2d');
    if (kind === 'reveal') { cx.fillStyle = '#fff'; cx.fillRect(0, 0, doc.width, doc.height); }
    else if (kind === 'hide') { /* transparent */ }
    else if (kind === 'fromSelection' && doc.selection.has) cx.drawImage(doc.selection.canvas, 0, 0);
    L.mask = m; L.maskEnabled = true;
    this.maskEditingLayerId = L.id;
    this.push('Add Layer Mask');
  }
  editMask() {
    const L = this.doc.activeLayer;
    if (!L?.mask) { this.status('Select a layer with a mask first'); return; }
    this.maskEditingLayerId = this.maskEditingLayerId === L.id ? null : L.id;
    this.channelPreview = null;
    this.setActiveTool('brush');
    this.status(this.maskEditingLayerId ? 'Editing mask: Brush reveals, Eraser hides; click the layer thumbnail to edit pixels' : 'Editing layer pixels');
    this.update({ panels: true, status: true });
  }
  invertMask() {
    const L = this.doc.activeLayer;
    if (!L?.mask) return;
    const c = L.mask.getContext('2d');
    const id = c.getImageData(0, 0, L.mask.width, L.mask.height);
    for (let i = 0; i < id.data.length; i += 4) {
      id.data[i] = id.data[i + 1] = id.data[i + 2] = 255;
      id.data[i + 3] = 255 - id.data[i + 3];
    }
    c.putImageData(id, 0, 0);
    // The mask is stored as actual alpha pixels, never as a stale cached preview.
    this.push('Invert Layer Mask');
  }
  maskFromTransparency() {
    const L = this.doc.activeLayer;
    if (!L?.canvas) return;
    const mask = makeCanvas(this.doc.width, this.doc.height);
    const mc = mask.getContext('2d');
    mc.drawImage(L.canvas, L.x, L.y);
    const id = mc.getImageData(0, 0, mask.width, mask.height);
    for (let i = 0; i < id.data.length; i += 4) id.data[i] = id.data[i + 1] = id.data[i + 2] = 255;
    mc.putImageData(id, 0, 0);
    L.mask = mask;
    L.maskEnabled = true;
    this.maskEditingLayerId = L.id;
    this.push('Mask from Transparency');
  }
  maskToSelection() {
    const L = this.doc.activeLayer;
    if (!L?.mask) return;
    const sel = this.doc.selection;
    sel.none();
    sel.ctx.drawImage(L.mask, 0, 0);
    if (L.maskInverted) sel.invert();
    sel.has = true;
    this.push('Selection from Mask');
  }
  featherMask(radius) {
    const L = this.doc.activeLayer;
    if (!L?.mask || radius <= 0) return;
    const sel = new Selection(L.mask.width, L.mask.height);
    sel._c = copyCanvas(L.mask);
    sel.feather(Math.min(100, radius));
    L.mask = sel.canvas;
    this.push('Feather Layer Mask');
  }
  deleteMask(apply = false) {
    const L = this.doc.activeLayer;
    if (!L?.mask) return;
    if (apply && !L.canvas) { this.status('Rasterize this layer before applying its mask'); return; }
    if (apply && L.canvas) {
      const c = L.canvas.getContext('2d');
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(L.mask, 0, 0);
      c.globalCompositeOperation = 'source-over';
    }
    L.mask = null;
    if (this.maskEditingLayerId === L.id) this.maskEditingLayerId = null;
    this.push(apply ? 'Apply Layer Mask' : 'Delete Layer Mask');
  }
  hitTestLayer(x, y) {
    const doc = this.doc;
    const flat = doc.flat().filter((l) => l.visible && l.canvas);
    for (let i = flat.length - 1; i >= 0; i--) {
      const L = flat[i];
      if (L.locked) continue;
      const lx = Math.round(x - L.x), ly = Math.round(y - L.y);
      if (lx < 0 || ly < 0 || lx >= L.canvas.width || ly >= L.canvas.height) continue;
      const a = L.canvas.getContext('2d').getImageData(lx, ly, 1, 1).data[3];
      if (a > 8) return L;
    }
    return null;
  }

  // ---------------------------------------------------------------- strokes
  beginStroke(mode, opts) {
    const doc = this.doc;
    const mask = this.maskEditingLayerId === doc.activeLayerId && doc.activeLayer?.mask;
    this.strokeMaskMode = null;
    if (mask) {
      if (mode !== 'paint' && mode !== 'erase') { this.status('Use Brush to reveal or Eraser to hide the selected mask'); return; }
      const L = doc.activeLayer;
      this.strokeMaskMode = mode === 'erase' ? 'hide' : 'reveal';
      this.stroke = new Stroke(doc, L, 'paint', { ...opts, color: [1, 1, 1], blend: 'normal' });
      this.strokeLayer = L;
      return;
    }
    let L = this.activeRaster(true);
    if (!L) { this.status('Create a layer first'); return; }
    if (L.type === 'text' || L.type === 'shape') {
      L = this.rasterizeLayer(L, true);
    }
    const sel = doc.selection.has ? doc.selection : null;
    const o = Object.assign({ color: this.fg, selection: sel }, opts);
    if (mode === 'clone' && !this.cloneSource) {
      this.status('Alt-click to set the source point first');
      return;
    }
    if (mode === 'clone' || mode === 'heal') o.source = this.cloneSource;
    this.stroke = new Stroke(doc, L, mode, o);
    this.strokeLayer = L;
    doc.selection.has && (this.strokeHadSel = true);
  }
  strokeMove(x, y, pressure) {
    if (!this.stroke) return;
    if (this.stroke.pts.length === 0) {
      if (this.stroke.o.source) this.updateCloneDelta(x, y);
      this.stroke.begin(x, y, pressure);
    }
    else this.stroke.move(x, y, pressure);
    this.update({ render: true, overlay: false });
  }
  endStroke(label) {
    const s = this.stroke;
    this.stroke = null;
    if (!s) return;
    const L = this.strokeLayer;
    let src = s.canvas;
    if (this.doc.selection.has) {
      const masked = makeCanvas(src.width, src.height);
      const mc = masked.getContext('2d');
      mc.drawImage(src, 0, 0);
      mc.globalCompositeOperation = 'destination-in';
      mc.drawImage(this.doc.selection.canvas, 0, 0);
      src = masked;
    }
    const editingMask = !!this.strokeMaskMode;
    const lc = (editingMask ? L.mask : L.canvas).getContext('2d');
    lc.save();
    lc.globalAlpha = (s.o.opacity ?? 100) / 100;
    if (editingMask) lc.globalCompositeOperation = this.strokeMaskMode === 'hide' ? 'destination-out' : 'source-over';
    else if (s.mode === 'erase') lc.globalCompositeOperation = 'destination-out';
    else {
      const op = blendOp(s.o.blend || 'normal');
      lc.globalCompositeOperation = needsCustomBlend(s.o.blend) ? 'source-over' : op;
    }
    if (!editingMask && needsCustomBlend(s.o.blend) && s.mode !== 'erase') {
      const A = lc.getImageData(0, 0, L.canvas.width, L.canvas.height);
      const B = src.getContext('2d').getImageData(0, 0, L.canvas.width, L.canvas.height);
      customBlend(A.data, B.data, s.o.blend, (s.o.opacity ?? 100) / 100);
      lc.putImageData(A, 0, 0);
    } else {
      lc.drawImage(src, 0, 0);
    }
    lc.restore();
    this.strokeMaskMode = null;
    this.push(editingMask ? 'Paint Layer Mask' : label || 'Stroke');
  }
  setCloneSource(x, y) {
    const L = this.activeRaster(false) || this.doc.flat().find((l) => l.canvas);
    if (!L) { this.status('No layer to sample'); return; }
    this.cloneSource = { canvas: copyCanvas(L.canvas), x, y, dx: 0, dy: 0 };
    this.status('Clone source set');
  }
  updateCloneDelta(x, y) {
    if (this.cloneSource) { this.cloneSource.dx = x - this.cloneSource.x; this.cloneSource.dy = y - this.cloneSource.y; }
  }

  // ---------------------------------------------------------------- selection
  selectAll() { this.doc.selection.all(); this.push('Select All'); this.update({ overlay: true, panels: true }); }
  deselect() { this.doc.selection.none(); this.push('Deselect'); this.update({ overlay: true, panels: true }); }
  invertSelection() { this.doc.selection.invert(); this.push('Invert Selection'); this.update({ overlay: true, panels: true }); }
  featherSelection(r) { this.doc.selection.feather(r); this.update({ overlay: true, panels: true }); }
  growSelection(n) { this.doc.selection.grow(n); this.update({ overlay: true }); }
  shrinkSelection(n) { this.doc.selection.shrink(n); this.update({ overlay: true }); }

  selectByColor(base, x, y, tol, contiguous, mode) {
    const sel = this.doc.selection;
    const w = base.width, h = base.height;
    const d = base.getContext('2d').getImageData(0, 0, w, h);
    const idx = (Math.round(y) * w + Math.round(x)) * 4;
    const tr = d.data[idx], tg = d.data[idx + 1], tb = d.data[idx + 2], ta = d.data[idx + 3];
    const fill = new Uint8Array(w * h);
    const match = (i) => Math.abs(d.data[i] - tr) <= tol && Math.abs(d.data[i + 1] - tg) <= tol &&
                          Math.abs(d.data[i + 2] - tb) <= tol && Math.abs(d.data[i + 3] - ta) <= tol;
    if (!contiguous) {
      for (let i = 0, p = 0; i < d.data.length; i += 4, p++) if (match(i)) fill[p] = 255;
    } else {
      const stack = [Math.round(x), Math.round(y)];
      const seen = new Uint8Array(w * h);
      seen[Math.round(y) * w + Math.round(x)] = 1;
      while (stack.length) {
        const yy = stack.pop(), xx = stack.pop();
        let xl = xx;
        while (xl > 0 && match((yy * w + xl - 1) * 4) && !seen[yy * w + xl - 1]) xl--;
        let xr = xx;
        while (xr < w - 1 && match((yy * w + xr + 1) * 4) && !seen[yy * w + xr + 1]) xr++;
        for (let i = xl; i <= xr; i++) {
          const p = yy * w + i;
          if (seen[p]) continue;
          seen[p] = 1;
          if (match(p * 4)) {
            fill[p] = 255;
            if (yy > 0 && !seen[p - w]) stack.push(i, yy - 1);
            if (yy < h - 1 && !seen[p + w]) stack.push(i, yy + 1);
          }
        }
      }
    }
    const target = makeCanvas(w, h);
    const tc = target.getContext('2d');
    const ti = tc.createImageData(w, h);
    for (let p = 0; p < fill.length; p++) {
      ti.data[p * 4] = ti.data[p * 4 + 1] = ti.data[p * 4 + 2] = 255;
      ti.data[p * 4 + 3] = fill[p];
    }
    tc.putImageData(ti, 0, 0);
    const sc = sel.ctx;
    sc.save();
    if (mode === 'replace' || mode === 'add') sc.globalCompositeOperation = 'source-over';
    else if (mode === 'subtract') sc.globalCompositeOperation = 'destination-out';
    else if (mode === 'intersect') sc.globalCompositeOperation = 'destination-in';
    if (mode === 'replace') sel.none();
    sc.drawImage(target, 0, 0);
    sc.restore();
    sel.has = true;
  }

  quickSelectAt(x, y, mode) {
    const o = this.toolOptions.quickSelect;
    const size = o.size || 30;
    const base = this.drag?.base || this.flattenedSnapshot();
    const sel = this.doc.selection;
    const w = sel.canvas.width, h = sel.canvas.height;
    const d = base.getContext('2d').getImageData(0, 0, w, h).data;
    const r = Math.round(size / 2);
    const t = makeCanvas(w, h);
    const tc = t.getContext('2d');
    tc.fillStyle = '#fff';
    tc.beginPath();
    tc.arc(x, y, r, 0, Math.PI * 2);
    tc.fill();
    // refine: only keep pixels similar to those already selected (or to the seed colour)
    const ti = tc.getImageData(0, 0, w, h);
    const selData = sel.ctx.getImageData(0, 0, w, h).data;
    for (let p = 0; p < w * h; p++) {
      if (!ti.data[p * 4 + 3]) continue;
      if (mode === 'add' && o.autoEnhance && selData[p * 4 + 3] > 128) continue;
      ti.data[p * 4] = ti.data[p * 4 + 1] = ti.data[p * 4 + 2] = 255;
      ti.data[p * 4 + 3] = 255;
    }
    tc.putImageData(ti, 0, 0);
    const sc = sel.ctx;
    sc.save();
    sc.globalCompositeOperation = mode === 'subtract' ? 'destination-out' : 'source-over';
    sc.drawImage(t, 0, 0);
    sc.restore();
    sel.has = true;
    void d;
  }

  selectFromPath(path) {
    const sel = this.doc.selection;
    sel.none();
    const c = sel.ctx;
    c.fillStyle = '#fff';
    c.beginPath();
    const a0 = path.anchors[0];
    c.moveTo(a0.x, a0.y);
    for (let i = 1; i < path.anchors.length; i++) {
      const p0 = path.anchors[i - 1], p1 = path.anchors[i];
      if (p0.hOut || p1.hIn) c.bezierCurveTo(p0.hOut?.x ?? p0.x, p0.hOut?.y ?? p0.y, p1.hIn?.x ?? p1.x, p1.hIn?.y ?? p1.y, p1.x, p1.y);
      else c.lineTo(p1.x, p1.y);
    }
    c.closePath();
    c.fill();
    sel.has = true;
    this.update({ overlay: true, panels: true });
  }

  // ---------------------------------------------------------------- sampling
  flattenedSnapshot() { return renderDoc(this.doc); }
  sampleColor(x, y, all) {
    let src;
    if (all) src = this.flattenedSnapshot();
    else {
      const L = this.activeRaster(false);
      if (!L) return null;
      const lx = Math.round(x - L.x), ly = Math.round(y - L.y);
      if (lx < 0 || ly < 0 || lx >= L.canvas.width || ly >= L.canvas.height) return null;
      src = L.canvas;
      x = lx; y = ly;
    }
    const size = this.toolOptions.eyedropper?.size || 'point';
    const ctx = src.getContext('2d');
    const n = size === '3x3' ? 1 : size === '5x5' ? 2 : 0;
    let r = 0, g = 0, b = 0, c = 0;
    for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) {
      const px = clamp(Math.round(x) + dx, 0, src.width - 1);
      const py = clamp(Math.round(y) + dy, 0, src.height - 1);
      const d = ctx.getImageData(px, py, 1, 1).data;
      r += d[0]; g += d[1]; b += d[2]; c++;
    }
    return [r / c / 255, g / c / 255, b / c / 255];
  }
  setForeground(c) { if (c) { this.fg = c; this.emitter.emit('color'); this.emitter.emit('panels'); } }
  setBackground(c) { if (c) { this.bg = c; this.emitter.emit('color'); this.emitter.emit('panels'); } }
  swapColors() { [this.fg, this.bg] = [this.bg, this.fg]; this.emitter.emit('color'); this.emitter.emit('panels'); }
  defaultColors() { this.fg = [0, 0, 0]; this.bg = [1, 1, 1]; this.emitter.emit('color'); this.emitter.emit('panels'); }

  snapToEdge(base, x, y, width) {
    const w = base.width, h = base.height;
    const ctx = base.getContext('2d');
    const cx = Math.round(x), cy = Math.round(y);
    const r = Math.max(1, Math.round(width));
    const lum = (px, py) => {
      px = clamp(px, 0, w - 1); py = clamp(py, 0, h - 1);
      const d = ctx.getImageData(px, py, 1, 1).data;
      return 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2];
    };
    let best = [cx, cy], bestV = -1;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const dd = Math.hypot(dx, dy);
      if (dd > r) continue;
      const v = Math.abs(lum(cx + dx + 1, cy + dy) - lum(cx + dx - 1, cy + dy)) +
                Math.abs(lum(cx + dx, cy + dy + 1) - lum(cx + dx, cy + dy - 1));
      const score = v / (1 + dd * 0.6);
      if (score > bestV) { bestV = score; best = [cx + dx, cy + dy]; }
    }
    return best;
  }

  // ---------------------------------------------------------------- fills & shapes
  commitGradient(d, o) {
    const L = this.activeRaster(true);
    if (!L) return;
    const t = makeCanvas(this.doc.width, this.doc.height);
    const tc = t.getContext('2d');
    let stops = o.stops || [[0, [0, 0, 0], 1], [1, [1, 1, 1], 1]];
    if (o.reverse) stops = stops.map(([p, c, a]) => [1 - p, c, a]).reverse();
    tc.fillStyle = gradientFill(tc, o.type, stops, d.x0, d.y0, d.x1, d.y1);
    tc.globalAlpha = (o.opacity ?? 100) / 100;
    tc.fillRect(0, 0, t.width, t.height);
    this.compositeOnto(L, t, o.blend || 'normal', 1);
    this.push('Gradient');
  }

  fillBucket(x, y, o) {
    const L = this.activeRaster(true);
    if (!L) return;
    const w = L.canvas.width, h = L.canvas.height;
    const id = L.canvas.getContext('2d').getImageData(0, 0, w, h);
    const mask = this.doc.selection.has ? this.doc.selection.ctx.getImageData(0, 0, w, h).data : null;
    let rgb;
    if (o.fill === 'pattern') {
      const p = patternCanvas(o.pattern, 32, this.fg);
      const t = makeCanvas(w, h);
      const tc = t.getContext('2d');
      tc.fillStyle = tc.createPattern(p, 'repeat');
      tc.fillRect(0, 0, w, h);
      const tid = tc.getImageData(0, 0, w, h);
      const target = makeCanvas(w, h);
      target.getContext('2d').putImageData(tid, 0, 0);
      // restrict flood fill area, then draw pattern clipped
      const area = makeCanvas(w, h);
      const ac = area.getContext('2d');
      const aid = ac.getImageData(0, 0, w, h);
      aid.data.set(id.data);
      floodFill(aid, w, h, x, y, [255, 255, 255], o.tolerance, o.contiguous, o.antiAlias, mask);
      ac.putImageData(aid, 0, 0);
      const out = makeCanvas(w, h);
      const oc = out.getContext('2d');
      oc.drawImage(target, 0, 0);
      oc.globalCompositeOperation = 'destination-in';
      oc.drawImage(area, 0, 0);
      this.compositeOnto(L, out, o.blend || 'normal', (o.opacity ?? 100) / 100);
      this.push('Paint Bucket');
      return;
    }
    rgb = this.fg.map((v) => Math.round(v * 255));
    const ok = floodFill(id, w, h, x, y, rgb, o.tolerance, o.contiguous, o.antiAlias, mask);
    if (!ok) return;
    const t = makeCanvas(w, h);
    t.getContext('2d').putImageData(id, 0, 0);
    const lc = L.canvas.getContext('2d');
    lc.clearRect(0, 0, w, h);
    lc.globalAlpha = (o.opacity ?? 100) / 100;
    lc.globalCompositeOperation = blendOp(o.blend || 'normal');
    lc.drawImage(t, 0, 0);
    lc.globalAlpha = 1;
    lc.globalCompositeOperation = 'source-over';
    this.push('Paint Bucket');
  }

  commitShape(d, o) {
    const L = new Layer({ name: this.doc.uniqueName('Shape'), type: 'shape' });
    const t = makeCanvas(this.doc.width, this.doc.height);
    const tc = t.getContext('2d');
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    let w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (d.constrain) { const m = Math.max(w, h); w = h = m; }
    L.props = { shape: d.shape, x, y, w, h, ...o };
    tc.save();
    shapePath(tc, d.shape, x, y, w, h, { radius: o.radius, sides: o.sides, inner: (o.inner ?? 45) / 100, arrowEnd: o.arrowEnd, arrowStart: o.arrowStart, strokeWidth: o.strokeWidth });
    if (o.fill === 'gradient') tc.fillStyle = gradientFill(tc, 'linear', o.stops || [[0, [0, 0, 0], 1], [1, [1, 1, 1], 1]], x, y, x + w, y + h);
    else if (o.fill === 'pattern') tc.fillStyle = tc.createPattern(patternCanvas(o.pattern || 'checks', 32, this.fg), 'repeat');
    else if (o.fill !== 'none') tc.fillStyle = `rgb(${this.fg.map((v) => v * 255).join(',')})`;
    if (o.fill !== 'none') tc.fill();
    if (o.strokeWidth > 0) {
      tc.strokeStyle = `rgb(${(o.stroke || [0, 0, 0]).map((v) => v * 255).join(',')})`;
      tc.lineWidth = o.strokeWidth;
      tc.stroke();
    }
    tc.restore();
    L.canvas = t;
    L.opacity = (o.opacity ?? 100) / 100;
    this.doc.addLayer(L);
    this.push('Shape');
  }

  compositeOnto(L, src, blend, alpha) {
    const lc = L.canvas.getContext('2d');
    if (needsCustomBlend(blend)) {
      const A = lc.getImageData(0, 0, L.canvas.width, L.canvas.height);
      const B = src.getContext('2d').getImageData(0, 0, L.canvas.width, L.canvas.height);
      customBlend(A.data, B.data, blend, alpha);
      lc.putImageData(A, 0, 0);
    } else {
      lc.save();
      lc.globalAlpha = alpha;
      lc.globalCompositeOperation = blendOp(blend);
      lc.drawImage(src, 0, 0);
      lc.restore();
    }
  }

  // ---------------------------------------------------------------- retouch
  commitPatch(d) {
    const mode = this.toolOptions.patch?.mode || 'source';
    const L = this.activeRaster(true);
    if (!L) return;
    const sel = this.doc.selection;
    sel.none();
    const c = sel.ctx;
    c.fillStyle = '#fff';
    c.beginPath(); c.moveTo(d.pts[0][0], d.pts[0][1]);
    for (const [x, y] of d.pts.slice(1)) c.lineTo(x, y);
    c.closePath(); c.fill();
    sel.has = true;
    sel.feather(3);
    const b = sel.bounds();
    if (!b) return;
    const src = d.base;
    const patch = makeCanvas(b.w, b.h);
    const pc = patch.getContext('2d');
    const off = { dx: Math.round(b.w * 0.4), dy: 0 };
    pc.drawImage(src, b.x + (mode === 'source' ? off.dx : -off.dx), b.y, b.w, b.h, 0, 0, b.w, b.h);
    const t = makeCanvas(this.doc.width, this.doc.height);
    const tc = t.getContext('2d');
    tc.drawImage(patch, b.x, b.y);
    tc.globalCompositeOperation = 'destination-in';
    tc.drawImage(sel.canvas, 0, 0);
    this.compositeOnto(L, t, 'normal', 1);
    sel.none();
    this.push('Patch');
  }

  removeRedEye(x, y, o) {
    const L = this.activeRaster(true);
    if (!L) return;
    const r = Math.max(4, (o.pupil || 50) * 0.6);
    const ctx = L.canvas.getContext('2d');
    const x0 = Math.max(0, Math.round(x - r)), y0 = Math.max(0, Math.round(y - r));
    const w = Math.min(L.canvas.width - x0, Math.round(r * 2)), h = Math.min(L.canvas.height - y0, Math.round(r * 2));
    if (w <= 0 || h <= 0) return;
    const id = ctx.getImageData(x0, y0, w, h);
    for (let i = 0; i < id.data.length; i += 4) {
      const [hh, s] = rgbToHsl(id.data[i] / 255, id.data[i + 1] / 255, id.data[i + 2] / 255);
      const hue = hh;
      const isRed = (hue < 25 || hue > 340) && s > 0.2;
      if (!isRed) continue;
      const [, , l] = rgbToHsl(id.data[i] / 255, id.data[i + 1] / 255, id.data[i + 2] / 255);
      const nl = l * (1 - (o.darken || 50) / 100);
      const c = hslToRgb(hue, s * 0.25, nl);
      id.data[i] = c[0] * 255; id.data[i + 1] = c[1] * 255; id.data[i + 2] = c[2] * 255;
    }
    ctx.putImageData(id, x0, y0);
    this.push('Red Eye Removal');
  }

  // ---------------------------------------------------------------- crop
  applyCropRatio(d) {
    const ratio = this.toolOptions.crop?.ratio || 'free';
    if (ratio === 'free') return;
    let rw = 1, rh = 1;
    if (ratio === 'orig') { rw = this.doc.width; rh = this.doc.height; }
    else { const [a, b] = ratio.split(':').map(Number); rw = a; rh = b; }
    let w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    h = (w * rh) / rw;
    d.y1 = d.y0 + Math.sign(d.y1 - d.y0 || 1) * h;
  }
  commitCrop(r) {
    const doc = this.doc;
    const nw = Math.max(1, Math.round(r.w)), nh = Math.max(1, Math.round(r.h));
    const canvas = makeCanvas(nw, nh);
    const cx = canvas.getContext('2d');
    cx.drawImage(renderDoc(doc), -Math.round(r.x), -Math.round(r.y));
    doc.width = nw; doc.height = nh;
    doc.selection = new Selection(nw, nh);
    doc.layers = [new Layer({ name: 'Background', canvas })];
    doc.activeLayerId = doc.layers[0].id;
    this.compCanvas = makeCanvas(nw, nh);
    this.push('Crop');
    this.fitToScreen();
  }
  commitPerspectiveCrop(pts) {
    const doc = this.doc;
    const src = renderDoc(doc);
    const w = doc.width, h = doc.height;
    const m = quadToUnit([0, 0], [w, 0], [w, h], [0, h]);
    // map source rect through quad: build inverse mapping from dst quad to src rect
    const inv = quadToUnit(pts[0], pts[1], pts[2], pts[3]);
    const out = projectCanvas(src, w, h, inv);
    const trimmed = this.trimToContent(out);
    doc.layers = [new Layer({ name: 'Background', canvas: trimmed })];
    doc.activeLayerId = doc.layers[0].id;
    doc.width = trimmed.width; doc.height = trimmed.height;
    doc.selection = new Selection(trimmed.width, trimmed.height);
    this.compCanvas = makeCanvas(trimmed.width, trimmed.height);
    this.push('Perspective Crop');
    this.fitToScreen();
    void m;
  }
  trimToContent(src) {
    const w = src.width, h = src.height;
    const d = src.getContext('2d').getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 0) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return src;
    const out = makeCanvas(x1 - x0 + 1, y1 - y0 + 1);
    out.getContext('2d').drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  // ---------------------------------------------------------------- paths
  penDown(x, y, shift) {
    if (!this.activePath) { this.activePath = { anchors: [], closed: false, id: uid('path') }; }
    const last = this.activePath.anchors[this.activePath.anchors.length - 1];
    if (last && dist(last.x, last.y, x, y) < 4) { this.activePath.closed = true; this.commitPath(); return; }
    this.activePath.anchors.push({ x, y, hIn: null, hOut: null });
    this.drag = { kind: 'penDrag', x, y, cx: x, cy: y, index: this.activePath.anchors.length - 1, shift };
  }
  penUp(x, y) {
    const d = this.drag;
    this.drag = null;
    if (!d || d.kind !== 'penDrag' || !this.activePath) return;
    const a = this.activePath.anchors[d.index];
    if (!a) return;
    const dx = d.cx - x, dy = d.cy - y;
    if (Math.hypot(dx, dy) > 4) {
      a.hOut = { x: a.x - dx, y: a.y - dy };
      a.hIn = { x: a.x + dx, y: a.y + dy };
    }
    this.update({ overlay: true, panels: true });
  }
  commitPath() {
    if (!this.activePath || this.activePath.anchors.length < 2) { this.activePath = null; return; }
    const o = this.toolOptions.pen || {};
    if (o.mode === 'shape') {
      const L = new Layer({ name: this.doc.uniqueName('Shape'), type: 'shape' });
      const t = makeCanvas(this.doc.width, this.doc.height);
      const tc = t.getContext('2d');
      this.tracePathOn(tc, this.activePath);
      if (o.fill !== 'none') { tc.fillStyle = `rgb(${this.fg.map((v) => v * 255).join(',')})`; tc.fill(); }
      if (o.strokeWidth > 0) {
        tc.strokeStyle = `rgb(${(o.stroke || [0, 0, 0]).map((v) => v * 255).join(',')})`;
        tc.lineWidth = o.strokeWidth; tc.stroke();
      }
      L.canvas = t;
      this.doc.addLayer(L);
      this.push('Shape from Path');
    }
    this.doc.paths = this.doc.paths || [];
    this.doc.paths.push(this.activePath);
    this.activePath = null;
    this.update({ overlay: true, panels: true });
  }
  tracePathOn(c, path) {
    c.beginPath();
    const a0 = path.anchors[0];
    c.moveTo(a0.x, a0.y);
    for (let i = 1; i < path.anchors.length; i++) {
      const p0 = path.anchors[i - 1], p1 = path.anchors[i];
      if (p0.hOut || p1.hIn) c.bezierCurveTo(p0.hOut?.x ?? p0.x, p0.hOut?.y ?? p0.y, p1.hIn?.x ?? p1.x, p1.hIn?.y ?? p1.y, p1.x, p1.y);
      else c.lineTo(p1.x, p1.y);
    }
    if (path.closed) c.closePath();
  }
  commitFreePath(pts) {
    this.activePath = { anchors: pts.map(([x, y]) => ({ x, y, hIn: null, hOut: null })), closed: true, id: uid('path') };
    this.commitPath();
  }
  addAnchor(x, y) {
    const path = this.pathNear(x, y);
    if (!path) return;
    // insert into the nearest segment
    let best = 1, bd = 1e9;
    for (let i = 1; i < path.anchors.length; i++) {
      const a = path.anchors[i - 1], b = path.anchors[i];
      const d = pointSegDist(x, y, a.x, a.y, b.x, b.y);
      if (d < bd) { bd = d; best = i; }
    }
    path.anchors.splice(best, 0, { x, y, hIn: null, hOut: null });
    this.update({ overlay: true, panels: true });
  }
  deleteAnchor(x, y) {
    const path = this.activePath || this.pathNear(x, y);
    if (!path) return;
    const i = path.anchors.findIndex((a) => dist(a.x, a.y, x, y) < 10);
    if (i >= 0) path.anchors.splice(i, 1);
    this.update({ overlay: true, panels: true });
  }
  convertAnchor(x, y) {
    const path = this.activePath || this.pathNear(x, y);
    if (!path) return;
    const a = path.anchors.find((an) => dist(an.x, an.y, x, y) < 12);
    if (!a) return;
    if (a.hIn || a.hOut) { a.hIn = a.hOut = null; } else {
      a.hOut = { x: a.x + 20, y: a.y }; a.hIn = { x: a.x - 20, y: a.y };
    }
    this.update({ overlay: true, panels: true });
  }
  pathNear(x, y) {
    const all = [...(this.doc.paths || []), this.activePath].filter(Boolean);
    let best = null, bd = 1e9;
    for (const p of all) for (const a of p.anchors) {
      const d = dist(a.x, a.y, x, y);
      if (d < bd) { bd = d; best = p; }
    }
    return bd < 40 ? best : this.activePath;
  }
  pathSelectDown(x, y) {
    const p = this.pathNear(x, y);
    if (!p) return;
    this.activePath = p;
    this.drag = { kind: 'movePath', sx: x, sy: y, anchors: p.anchors.map((a) => ({ x: a.x, y: a.y })) };
  }
  pathMove(x, y) {
    const d = this.drag; if (!d || d.kind !== 'movePath' || !this.activePath) return;
    const dx = x - d.sx, dy = y - d.sy;
    this.activePath.anchors.forEach((a, i) => {
      a.x = d.anchors[i].x + dx; a.y = d.anchors[i].y + dy;
      if (a.hIn) { a.hIn.x = d.anchors[i].x + dx + (a.hIn.x - a.x); a.hIn.y = d.anchors[i].y + dy + (a.hIn.y - a.y); }
      if (a.hOut) { a.hOut.x = d.anchors[i].x + dx + (a.hOut.x - a.x); a.hOut.y = d.anchors[i].y + dy + (a.hOut.y - a.y); }
    });
  }
  directSelectDown(x, y) {
    const p = this.activePath || this.pathNear(x, y);
    if (!p) return;
    this.activePath = p;
    for (const a of p.anchors) {
      for (const h of ['hIn', 'hOut']) {
        if (a[h] && dist(a[h].x, a[h].y, x, y) < 10) { this.drag = { kind: 'moveHandle', a, h }; return; }
      }
      if (dist(a.x, a.y, x, y) < 10) { this.drag = { kind: 'moveAnchor', a }; return; }
    }
  }
  anchorMove(x, y) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'moveAnchor') { d.a.x = x; d.a.y = y; }
    else if (d.kind === 'moveHandle') { d.a[d.h] = { x, y }; }
  }

  // ---------------------------------------------------------------- text
  createTextLayer(x, y, o) {
    if (o.text == null) { textDialog(this, x, y, o); return; }
    this._createTextLayer(x, y, o);
  }

  _createTextLayer(x, y, o) {
    const text = o.text;
    if (text == null) return;
    const props = {
      text, family: o.family || 'Arial', size: o.size || 64, weight: o.weight || '400',
      style: o.style || '', align: o.align || 'left', tracking: o.tracking || 0,
      leading: o.leading || 0, color: o.color || this.fg, underline: !!o.underline,
      vertical: !!o.vertical, warp: o.warp || 'none', warpAmount: o.warpAmount ?? 30,
    };
    if (props.leading <= 0) props.leading = (props.size || 64) * 1.2;
    let c = renderText(props);
    if (props.warp !== 'none') c = this.applyWarp(c, props.warp, props.warpAmount / 100);
    if (o.mask) {
      const sel = this.doc.selection;
      sel.none();
      const sc = sel.ctx;
      sc.fillStyle = '#fff';
      const tmp = makeCanvas(this.doc.width, this.doc.height);
      tmp.getContext('2d').drawImage(c, x, y);
      const id = tmp.getContext('2d').getImageData(0, 0, this.doc.width, this.doc.height);
      const od = sc.createImageData(this.doc.width, this.doc.height);
      for (let i = 0; i < id.data.length; i += 4) {
        od.data[i] = od.data[i + 1] = od.data[i + 2] = 255;
        od.data[i + 3] = id.data[i + 3];
      }
      sc.putImageData(od, 0, 0);
      sel.has = true;
      this.update({ overlay: true, panels: true });
      return;
    }
    const L = new Layer({ type: 'text', name: this.doc.uniqueName('Text'), props });
    const t = makeCanvas(this.doc.width, this.doc.height);
    t.getContext('2d').drawImage(c, Math.round(x), Math.round(y));
    L.canvas = t;
    // The canvas is already document-sized and contains the position.
    L.x = 0; L.y = 0;
    this.doc.addLayer(L);
    this.push('Text Layer');
  }
  applyWarp(src, kind, amount) {
    const w = src.width, h = src.height;
    const n = 8;
    const grid = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const u = i / (n - 1), v = j / (n - 1);
      let x = u * w, y = v * h;
      const cx = u - 0.5, cy = v - 0.5;
      switch (kind) {
        case 'arc': y -= Math.cos(cx * Math.PI) * amount * h * 0.4; break;
        case 'arcLower': y += Math.cos(cx * Math.PI) * amount * h * 0.4; break;
        case 'flag': x -= Math.sin(v * Math.PI) * amount * w * 0.25; y += Math.sin(u * Math.PI) * amount * h * 0.1; break;
        case 'wave': y += Math.sin(u * Math.PI * 2) * amount * h * 0.25; break;
        case 'fish': x += cx * cy * amount * w * 0.6; y -= cy * cy * amount * h * 0.4; break;
        case 'rise': y -= (1 - v) * amount * h * 0.35; break;
        case 'bulge': { const r = Math.hypot(cx, cy); const k = 1 + amount * (1 - r * 2) * 0.5; x = w * (0.5 + cx * k); y = h * (0.5 + cy * k); break; }
        case 'squeeze': { const r = Math.hypot(cx, cy); const k = 1 - amount * (1 - r * 2) * 0.4; x = w * (0.5 + cx * k); y = h * (0.5 + cy * k); break; }
        case 'twist': {
          const a = amount * cx * 1.6;
          const nx = cx * Math.cos(a) - cy * Math.sin(a), ny = cx * Math.sin(a) + cy * Math.cos(a);
          x = w * (0.5 + nx); y = h * (0.5 + ny);
          break;
        }
        default: break;
      }
      grid[(j * n + i) * 2] = x;
      grid[(j * n + i) * 2 + 1] = y;
    }
    return warpCanvasLocal(src, grid, n, w, h);
  }
  rasterizeLayer(L, keepOriginal) {
    const n = new Layer({ type: 'raster', name: L.name, opacity: L.opacity, blend: L.blend });
    n.canvas = copyCanvas(L.canvas);
    const sib = this.doc.siblings(L.id);
    const i = sib.findIndex((l) => l.id === L.id);
    if (keepOriginal) { L.visible = false; sib.splice(i + 1, 0, n); }
    else sib.splice(i, 1, n);
    this.doc.activeLayerId = n.id;
    return n;
  }

  // ---------------------------------------------------------------- free transform
  beginTransform(selectionOnly = false) {
    if (!this.doc) return;
    const L = this.activeRaster(false);
    if (!L || !L.canvas) { toast('Select a pixel layer first'); return; }
    const sel = this.doc.selection;
    let b = (selectionOnly && sel.has) ? sel.bounds()
      : { x: L.x, y: L.y, w: L.canvas.width, h: L.canvas.height };
    if (!b || b.w < 1 || b.h < 1) return;
    const sub = makeCanvas(Math.max(1, Math.round(b.w)), Math.max(1, Math.round(b.h)));
    sub.getContext('2d').drawImage(L.canvas, b.x - L.x, b.y - L.y, b.w, b.h, 0, 0, b.w, b.h);
    if (selectionOnly && sel.has) {
      const m = makeCanvas(sub.width, sub.height);
      m.getContext('2d').drawImage(sel.canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
      const sc = sub.getContext('2d');
      sc.globalCompositeOperation = 'destination-in';
      sc.drawImage(m, 0, 0);
    }
    this.transform = {
      layerId: L.id, selectionOnly, src: sub, rect: b,
      q: [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]],
    };
    this.update({ overlay: true, toolbar: true });
  }

  drawTransformBox(ctx, px) {
    const t = this.transform;
    const q = t.q;
    ctx.save();
    ctx.strokeStyle = '#4c8dff'; ctx.lineWidth = px * 1.5;
    ctx.beginPath();
    ctx.moveTo(q[0][0], q[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(q[i][0], q[i][1]);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.rect(q[i][0] - 3 * px, q[i][1] - 3 * px, 6 * px, 6 * px);
      ctx.fill(); ctx.stroke();
    }
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const mx = (q[i][0] + q[j][0]) / 2, my = (q[i][1] + q[j][1]) / 2;
      ctx.beginPath(); ctx.arc(mx, my, 2.5 * px, 0, Math.PI * 2);
      ctx.fillStyle = '#4c8dff'; ctx.fill();
    }
    ctx.restore();
  }

  transformHit(p) {
    const t = this.transform;
    if (!t) return null;
    const tol = 9 / this.view.zoom;
    const q = t.q;
    const names = ['nw', 'ne', 'se', 'sw'];
    for (let i = 0; i < 4; i++) if (dist(p.x, p.y, q[i][0], q[i][1]) <= tol * 1.6) return names[i];
    const edges = [['n', 0, 1], ['e', 1, 2], ['s', 2, 3], ['w', 3, 0]];
    for (const [n, i, j] of edges) {
      if (pointSegDist(p.x, p.y, q[i][0], q[i][1], q[j][0], q[j][1]) <= tol) return n;
    }
    if (pointInQuad(p.x, p.y, q)) return 'move';
    const c = quadCenter(q);
    const r = Math.max(...q.map((a) => dist(a[0], a[1], c[0], c[1])));
    if (dist(p.x, p.y, c[0], c[1]) <= r * 2.2) return 'rotate';
    return null;
  }

  startTransformDrag(p) {
    const handle = this.transformHit(p);
    if (!handle) return;
    this.drag = { kind: 'transform', handle, p0: { x: p.x, y: p.y }, q0: structuredClone(this.transform.q) };
  }

  moveTransform(p) {
    const d = this.drag, t = this.transform;
    if (!d || !t || d.kind !== 'transform') return;
    const dx = p.x - d.p0.x, dy = p.y - d.p0.y;
    const q0 = d.q0;
    const q = structuredClone(q0);
    const w = dist(q0[0][0], q0[0][1], q0[1][0], q0[1][1]);
    const h = dist(q0[0][0], q0[0][1], q0[3][0], q0[3][1]);
    switch (d.handle) {
      case 'move':
        for (let i = 0; i < 4; i++) { q[i][0] += dx; q[i][1] += dy; }
        break;
      case 'rotate': {
        const c = quadCenter(q0);
        const a0 = Math.atan2(d.p0.y - c[1], d.p0.x - c[0]);
        const a1 = Math.atan2(p.y - c[1], p.x - c[0]);
        let a = a1 - a0;
        if (p.shift) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
        const cs = Math.cos(a), sn = Math.sin(a);
        for (let i = 0; i < 4; i++) {
          const rx = q0[i][0] - c[0], ry = q0[i][1] - c[1];
          q[i][0] = c[0] + rx * cs - ry * sn;
          q[i][1] = c[1] + rx * sn + ry * cs;
        }
        break;
      }
      case 'n': q[0][1] += dy; q[1][1] += dy; break;
      case 's': q[2][1] += dy; q[3][1] += dy; break;
      case 'w': q[0][0] += dx; q[3][0] += dx; break;
      case 'e': q[1][0] += dx; q[2][0] += dx; break;
      case 'nw': q[0][0] += dx; q[0][1] += dy; if (p.shift) { const k = 1 - dy / h; q[0][0] = q[1][0] - w * k; } break;
      case 'ne': q[1][0] += dx; q[1][1] += dy; if (p.shift) { const k = 1 - dy / h; q[1][0] = q[0][0] + w * k; } break;
      case 'se': q[2][0] += dx; q[2][1] += dy; if (p.shift) { const k = 1 + dy / h; q[2][0] = q[3][0] + w * k; } break;
      case 'sw': q[3][0] += dx; q[3][1] += dy; if (p.shift) { const k = 1 + dy / h; q[3][0] = q[0][0] - w * k; } break;
      default: break;
    }
    t.q = q;
    this.update({ overlay: true });
  }

  commitFreeTransform() {
    const t = this.transform;
    if (!t) return;
    const L = this.doc.flat().find((l) => l.id === t.layerId);
    if (!L) { this.transform = null; return; }
    if (!this._applyQuad(L, t.src, t.q, t.selectionOnly)) return;
    this.lastTransform = { q: structuredClone(t.q), rect: t.rect, src: t.src, selectionOnly: t.selectionOnly };
    this.transform = null;
    this.push('Free Transform');
    this.emitter.emit('toolbar');
  }

  cancelTransform() {
    if (!this.transform) return;
    this.transform = null;
    this.update({ overlay: true, toolbar: true });
  }

  repeatTransform() {
    const lt = this.lastTransform;
    if (!lt) { toast('No transform to repeat'); return; }
    const L = this.activeRaster(false);
    if (!L) return;
    // re-apply the same quad geometry relative to the current content box
    const r = lt.rect;
    const src = makeCanvas(Math.max(1, Math.round(r.w)), Math.max(1, Math.round(r.h)));
    src.getContext('2d').drawImage(L.canvas, 0, 0, r.w, r.h, 0, 0, r.w, r.h);
    const dq = lt.q.map(([x, y]) => [x + (L.x - r.x), y + (L.y - r.y)]);
    this._applyQuad(L, src, dq, lt.selectionOnly);
    this.push('Transform Again');
  }

  _applyQuad(L, src, q, selectionOnly) {
    const A = quadToUnit(q[0], q[1], q[2], q[3]);
    const S = [1 / src.width, 0, 0, 0, 1 / src.height, 0, 0, 0, 1];
    const M = mul3(A, S);
    const out = projectCanvas(src, this.doc.width, this.doc.height, M);
    const lc = L.canvas.getContext('2d');
    if (selectionOnly && this.doc.selection.has) {
      lc.save();
      lc.globalCompositeOperation = 'destination-out';
      lc.drawImage(this.doc.selection.canvas, 0, 0);
      lc.restore();
    } else {
      lc.clearRect(0, 0, L.canvas.width, L.canvas.height);
    }
    if (L.canvas.width !== this.doc.width || L.canvas.height !== this.doc.height || L.x || L.y) {
      const nc = makeCanvas(this.doc.width, this.doc.height);
      nc.getContext('2d').drawImage(L.canvas, L.x, L.y);
      L.canvas = nc; L.x = 0; L.y = 0;
    }
    L.canvas.getContext('2d').drawImage(out, 0, 0);
    return true;
  }

  // ---------------------------------------------------------------- channels / paths
  channelView() {
    const c = makeCanvas(this.doc.width, this.doc.height);
    const cx = c.getContext('2d');
    const src = this.channelPreview === 'mask' ? (this.doc.activeLayer?.mask || this.compCanvas) : this.compCanvas;
    const d = src.getContext('2d').getImageData(0, 0, c.width, c.height);
    const o = cx.createImageData(c.width, c.height);
    const ch = { r: 0, g: 1, b: 2, mask: 3 }[this.channelPreview] ?? 0;
    for (let p = 0; p < o.data.length; p += 4) {
      const v = d.data[p + ch];
      o.data[p] = o.data[p + 1] = o.data[p + 2] = v;
      o.data[p + 3] = 255;
    }
    cx.putImageData(o, 0, 0);
    return c;
  }

  selectionFromChannel() {
    const L = this.doc.activeLayer;
    const src = L?.mask || this.compCanvas;
    if (!src) return;
    const d = src.getContext('2d').getImageData(0, 0, src.width, src.height);
    const sel = this.doc.selection;
    if (sel.canvas.width !== this.doc.width || sel.canvas.height !== this.doc.height) sel.resize(this.doc.width, this.doc.height);
    const o = sel.ctx.createImageData(src.width, src.height);
    for (let p = 0; p < o.data.length; p += 4) o.data[p + 3] = d.data[p + 3] || d.data[p];
    sel.ctx.putImageData(o, 0, 0);
    sel.has = true;
    this.update({ overlay: true, panels: true });
    this.push('Load Selection');
  }

  pathToSelection(params = {}) {
    const path = this.activePath || (this.doc.paths || [])[0];
    if (!path || !path.anchors.length) { toast('No path'); return; }
    this.selectFromPath(path);
  }

  strokePath(opts = {}) {
    const path = this.activePath || (this.doc.paths || [])[0];
    if (!path) { toast('No path'); return; }
    const L = this.activeRaster(true);
    if (!L) return;
    const t = makeCanvas(this.doc.width, this.doc.height);
    const tc = t.getContext('2d');
    this.tracePathOn(tc, path);
    tc.strokeStyle = `rgb(${this.fg.map((v) => Math.round(v * 255)).join(',')})`;
    tc.lineWidth = opts.width || 3;
    tc.stroke();
    this.compositeOnto(L, t, opts.blend || 'normal', (opts.opacity ?? 100) / 100);
    this.push('Stroke Path');
  }

  fillPath(opts = {}) {
    const path = this.activePath || (this.doc.paths || [])[0];
    if (!path) { toast('No path'); return; }
    const L = this.activeRaster(true);
    if (!L) return;
    const t = makeCanvas(this.doc.width, this.doc.height);
    const tc = t.getContext('2d');
    this.tracePathOn(tc, path);
    tc.fillStyle = `rgb(${this.fg.map((v) => Math.round(v * 255)).join(',')})`;
    tc.fill();
    this.compositeOnto(L, t, opts.blend || 'normal', (opts.opacity ?? 100) / 100);
    this.push('Fill Path');
  }

  setToolOption(key, value) {
    const o = (this.toolOptions[this.tool] = this.toolOptions[this.tool] || {});
    o[key] = value;
    this.update({ overlay: true });
  }
}

function textDialog(app, x, y, o) {
  const v = { text: 'Type here', size: o.size || 64, family: o.family || 'Arial', color: o.color || app.fg };
  const ta = el('textarea', { rows: 4, style: { width: '100%', resize: 'vertical' }, oninput: (e) => { v.text = e.target.value; } });
  ta.value = v.text;
  const body = el('div', { class: 'col', style: { minWidth: '420px' } },
    ta,
    el('div', { class: 'grid2' },
      el('span', {}, 'Font'), (() => {
        const fonts = ['Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Courier New', 'Verdana', 'Impact', 'Trebuchet MS', 'system-ui', 'serif', 'monospace'];
        const s = el('select', {}, ...fonts.map((f) => el('option', { value: f, selected: f === v.family }, f)));
        s.onchange = () => { v.family = s.value; };
        return s;
      })(),
      el('span', {}, 'Size'), (() => { const i = el('input', { type: 'number', value: v.size }); i.oninput = () => { v.size = Number(i.value); }; return i; })(),
      el('span', {}, 'Colour'), el('input', { type: 'color', value: rgb2hex(...v.color), oninput: (e) => { v.color = hex2rgb(e.target.value); } }),
    ),
  );
  const { close } = modal({
    title: 'Text', body, width: 460,
    footer: [el('span', { class: 'grow' }),
      el('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: () => { close(); app._createTextLayer(x, y, { ...o, ...v }); } }, 'OK')],
  });
  setTimeout(() => { ta.focus(); ta.select(); }, 30);
}

function quadCenter(q) {
  return [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
}

function pointInQuad(x, y, q) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi)) inside = !inside;
  }
  return inside;
}

function warpCanvasLocal(src, grid, n, w, h) {
  // local reimplementation to avoid a circular import in the hot path
  const out = makeCanvas(w, h);
  const octx = out.getContext('2d');
  const sdata = src.getContext('2d').getImageData(0, 0, w, h).data;
  const oimg = octx.createImageData(w, h);
  const od = oimg.data;
  const cellW = w / (n - 1), cellH = h / (n - 1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = x / cellW, gy = y / cellH;
    const ix = Math.min(n - 2, Math.floor(gx)), iy = Math.min(n - 2, Math.floor(gy));
    const tx = gx - ix, ty = gy - iy;
    const p = (i, j, off) => grid[(j * n + i) * 2 + off];
    const bl = (a, b, c, d, u, v) => (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
    const dstX = bl(p(ix, iy, 0), p(ix + 1, iy, 0), p(ix, iy + 1, 0), p(ix + 1, iy + 1, 0), tx, ty);
    const dstY = bl(p(ix, iy, 1), p(ix + 1, iy, 1), p(ix, iy + 1, 1), p(ix + 1, iy + 1, 1), tx, ty);
    const sx = x - (dstX - (ix + tx) * cellW);
    const sy = y - (dstY - (iy + ty) * cellH);
    if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) continue;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x0 + 1) * 4;
    const i01 = ((y0 + 1) * w + x0) * 4, i11 = ((y0 + 1) * w + x0 + 1) * 4;
    const o = (y * w + x) * 4;
    for (let c = 0; c < 4; c++) {
      const a = sdata[i00 + c] * (1 - fx) + sdata[i10 + c] * fx;
      const b = sdata[i01 + c] * (1 - fx) + sdata[i11 + c] * fx;
      od[o + c] = a * (1 - fy) + b * fy;
    }
  }
  octx.putImageData(oimg, 0, 0);
  return out;
}

function pointSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (!l2) return dist(px, py, x1, y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = clamp(t, 0, 1);
  return dist(px, py, x1 + t * dx, y1 + t * dy);
}

let _ctx = null;
function useCtx() { return _ctx || (_ctx = makeCanvas(2, 2).getContext('2d')); }

export { rgb2hex, hex2rgb, canvasFromFile, exportCanvas, FILTERS, getFilter, applyAdjustment,
         resample, rotate90, flip, rotateArbitrary, layerThumb, maskThumb, snapshotCanvas,
         scaledCanvas, renderList, Selection, Layer, Doc };
