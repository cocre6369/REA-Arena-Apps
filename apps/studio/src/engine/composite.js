// Layer compositor: document -> canvas.

import { makeCanvas, copyCanvas, uid } from '../core/util.js';
import { blendOp, needsCustomBlend, customBlend } from '../core/color.js';
import { applyAdjustment } from './adjust.js';

const scratchPool = [];
function scratch(w, h) {
  for (let i = scratchPool.length - 1; i >= 0; i--) {
    if (scratchPool[i].width === w && scratchPool[i].height === h) return scratchPool.splice(i, 1)[0];
  }
  return makeCanvas(w, h);
}
function releaseScratch(c) { c.getContext('2d').clearRect(0, 0, c.width, c.height); if (scratchPool.length < 8) scratchPool.push(c); }

function drawImageOn(canvas, src, x, y) {
  const c = canvas.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.drawImage(src, Math.round(x), Math.round(y));
}

function maskedCopy(src, mask, w, h) {
  const out = scratch(w, h);
  const c = out.getContext('2d');
  c.drawImage(src, 0, 0);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(mask, 0, 0);
  c.globalCompositeOperation = 'source-over';
  return out;
}

/** Composite `src` onto `dst` honouring blend mode, opacity and mask of layer L. */
export function blendOnto(dst, src, L, doc, opacityOverride) {
  const w = dst.width, h = dst.height;
  let s = src;
  let scratchUsed = null;

  if (L && L.maskEnabled && L.mask) {
    const m = L.maskInverted ? invertMask(L.mask) : L.mask;
    scratchUsed = maskedCopy(src, m, w, h);
    s = scratchUsed;
  }
  const ctx = dst.getContext('2d');
  const op = opacityOverride ?? (L ? L.opacity : 1);
  const mode = L ? L.blend : 'normal';

  if (needsCustomBlend(mode)) {
    const A = ctx.getImageData(0, 0, w, h);
    const B = s.getContext('2d').getImageData(0, 0, w, h);
    customBlend(A.data, B.data, mode, op);
    ctx.putImageData(A, 0, 0);
  } else {
    ctx.save();
    ctx.globalAlpha = op;
    ctx.globalCompositeOperation = blendOp(mode);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(s, 0, 0);
    ctx.restore();
  }
  if (scratchUsed) releaseScratch(scratchUsed);
}

function invertMask(mask) {
  const c = makeCanvas(mask.width, mask.height);
  const cx = c.getContext('2d');
  cx.drawImage(mask, 0, 0);
  const id = cx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < id.data.length; i += 4) {
    id.data[i] = id.data[i + 1] = id.data[i + 2] = 255;
    id.data[i + 3] = 255 - id.data[i + 3];
  }
  cx.putImageData(id, 0, 0);
  return c;
}

/** Render a layer (or group) alone into a doc-sized canvas. */
export function renderLayerAlone(doc, L) {
  const out = makeCanvas(doc.width, doc.height);
  if (L.type === 'group') {
    renderList(doc, L.children, out);
  } else if (L.type === 'adjustment') {
    // an adjustment alone is a no-op pass-through of transparent
  } else if (L.canvas) {
    drawImageOn(out, L.canvas, L.x, L.y);
  }
  if (L.maskEnabled && L.mask) {
    const c = out.getContext('2d');
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(L.mask, 0, 0);
    c.globalCompositeOperation = 'source-over';
  }
  return out;
}

export function renderList(doc, layers, out, opts = {}) {
  const w = doc.width, h = doc.height;
  let i = 0;
  while (i < layers.length) {
    const L = layers[i];
    if (!L.visible) { i++; continue; }

    // gather a clipped run: this layer plus any following layers flagged clipped
    const run = [L];
    let j = i + 1;
    while (j < layers.length && layers[j].clipped) { run.push(layers[j]); j++; }

    if (L.type === 'group') {
      const g = scratch(w, h);
      renderList(doc, L.children, g, opts);
      blendOnto(out, g, L, doc);
      releaseScratch(g);
    } else if (L.type === 'adjustment') {
      applyAdjustmentLayer(doc, out, L);
    } else if (L.canvas) {
      const s = (L.x || L.y) ? offsetCanvas(L, doc) : L.canvas;
      blendOnto(out, s, L, doc);
      if (s !== L.canvas) releaseScratch(s);
    }

    // clipped layers: clip each to the alpha of the run base
    for (let k = 1; k < run.length; k++) {
      const C = run[k];
      if (!C.visible) continue;
      const base = renderLayerAlone(doc, L);
      let s;
      if (C.type === 'group') { s = scratch(w, h); renderList(doc, C.children, s, opts); }
      else if (C.canvas) s = (C.x || C.y) ? offsetCanvas(C, doc) : C.canvas;
      if (s) {
        const cx = s.getContext('2d');
        cx.globalCompositeOperation = 'destination-in';
        cx.drawImage(base, 0, 0);
        cx.globalCompositeOperation = 'source-over';
        blendOnto(out, s, C, doc);
        if (s !== C.canvas) releaseScratch(s);
      }
    }
    i = j;
  }
  return out;
}

function offsetCanvas(L, doc) {
  const s = scratch(doc.width, doc.height);
  drawImageOn(s, L.canvas, L.x, L.y);
  return s;
}

function applyAdjustmentLayer(doc, out, L) {
  const w = doc.width, h = doc.height;
  const tmp = scratch(w, h);
  tmp.getContext('2d').drawImage(out, 0, 0);
  const id = tmp.getContext('2d').getImageData(0, 0, w, h);
  applyAdjustment(id.data, L.adjustment.kind, L.adjustment.params, w, h);
  tmp.getContext('2d').putImageData(id, 0, 0);
  blendOnto(out, tmp, L, doc);
  releaseScratch(tmp);
}

/** Render the whole document (visible layers). */
export function renderDoc(doc) {
  const out = makeCanvas(doc.width, doc.height);
  const ctx = out.getContext('2d');
  if (doc.background === 'white') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height); }
  else if (doc.background === 'black') { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, out.width, out.height); }
  renderList(doc, doc.layers, out);
  return out;
}

/** Flattened copy of the document (no selection). */
export function flattenDoc(doc) { return renderDoc(doc); }

/** Merge a list of layers (contiguous siblings) into one raster layer canvas. */
export function mergeLayers(doc, layers) {
  const out = makeCanvas(doc.width, doc.height);
  renderList(doc, layers, out);
  return out;
}

export function layerThumb(doc, L, size = 26) {
  const c = makeCanvas(size, size);
  const cx = c.getContext('2d');
  if (L.type === 'group') {
    const g = makeCanvas(doc.width, doc.height);
    renderList(doc, L.children, g);
    drawContain(cx, g, size);
  } else if (L.type === 'adjustment') {
    cx.fillStyle = '#3a414d'; cx.fillRect(0, 0, size, size);
    cx.fillStyle = '#c9d2e0'; cx.font = `${Math.round(size * 0.62)}px sans-serif`;
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.fillText((L.adjustment?.kind || 'A')[0].toUpperCase(), size / 2, size / 2 + 1);
  } else if (L.canvas) {
    drawContain(cx, L.canvas, size);
  }
  return c;
}

export function maskThumb(mask, size = 22) {
  const c = makeCanvas(size, size);
  const cx = c.getContext('2d');
  cx.fillStyle = '#000'; cx.fillRect(0, 0, size, size);
  const t = makeCanvas(size, size);
  const tc = t.getContext('2d');
  tc.drawImage(mask, 0, 0, size, size);
  const id = tc.getImageData(0, 0, size, size);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = id.data[i + 3];
    id.data[i] = id.data[i + 1] = id.data[i + 2] = 255;
    id.data[i + 3] = v;
  }
  tc.putImageData(id, 0, 0);
  cx.drawImage(t, 0, 0);
  return c;
}

function drawContain(cx, src, size) {
  const s = Math.min(size / src.width, size / src.height, 1);
  const w = src.width * s, h = src.height * s;
  cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
  cx.drawImage(src, (size - w) / 2, (size - h) / 2, w, h);
}

export { scratch, releaseScratch };
