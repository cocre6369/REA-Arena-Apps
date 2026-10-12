// File I/O: raster import/export and the native project format.

import { makeCanvas, loadImage, fileToDataURL, fileToBuffer, downloadBlob, dataURLToBlob } from '../core/util.js';
import { Doc, Layer, restoreDoc } from '../core/model.js';
import { BRAND } from '../brand.js';
import { blendName } from '../core/color.js';

export const RASTER_FORMATS = [
  ['image/png', 'PNG', 'png'],
  ['image/jpeg', 'JPEG', 'jpg'],
  ['image/webp', 'WebP', 'webp'],
  ['image/bmp', 'BMP', 'bmp'],
  ['image/gif', 'GIF', 'gif'],
];
export const EXPORT_FORMATS = [
  ['png', 'PNG (*.png)', 'image/png'],
  ['jpg', 'JPEG (*.jpg)', 'image/jpeg'],
  ['webp', 'WebP (*.webp)', 'image/webp'],
  ['bmp', 'BMP (*.bmp)', 'image/bmp'],
];

export async function canvasFromFile(file) {
  const url = await fileToDataURL(file);
  const img = await loadImage(url);
  const c = makeCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

export function canvasFromImage(img) {
  const c = makeCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

export function exportCanvas(canvas, mime = 'image/png', quality = 0.92) {
  if (mime === 'image/bmp') return Promise.resolve(encodeBmp(canvas));
  return new Promise((res, rej) => canvas.toBlob((b) => b ? res(b) : rej(new Error('Image export failed')), mime, quality));
}

/** 24-bit RGB BMP; transparency is flattened onto white. */
function encodeBmp(canvas) {
  const w = canvas.width, h = canvas.height;
  const stride = (w * 3 + 3) & ~3;
  const bytes = new ArrayBuffer(54 + stride * h);
  const view = new DataView(bytes);
  view.setUint16(0, 0x4d42, true);
  view.setUint32(2, bytes.byteLength, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, w, true);
  view.setInt32(22, h, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, stride * h, true);
  const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const out = new Uint8Array(bytes);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, o = 54 + (h - 1 - y) * stride + x * 3;
    const a = rgba[i + 3] / 255;
    out[o] = Math.round(rgba[i + 2] * a + 255 * (1 - a));
    out[o + 1] = Math.round(rgba[i + 1] * a + 255 * (1 - a));
    out[o + 2] = Math.round(rgba[i] * a + 255 * (1 - a));
  }
  return new Blob([bytes], { type: 'image/bmp' });
}

export async function saveCanvasAs(canvas, filename, mime = 'image/png', quality = 0.92) {
  const blob = await exportCanvas(canvas, mime, quality);
  downloadBlob(blob, filename);
}

export function dataURLFromCanvas(canvas, mime = 'image/png', q = 0.92) {
  return canvas.toDataURL(mime, q);
}
export async function canvasFromDataURL(url) {
  const img = await loadImage(url);
  return canvasFromImage(img);
}

// ------------------------------------------------------------------ native project
export async function serializeProject(doc, extra = {}) {
  const enc = (canvas) => (canvas ? canvas.toDataURL('image/png') : null);
  const ser = (l) => ({
    id: l.id, type: l.type, name: l.name, visible: l.visible, opacity: l.opacity,
    blend: l.blend, locked: l.locked, alphaLocked: l.alphaLocked, clipped: l.clipped,
    x: l.x, y: l.y, maskEnabled: l.maskEnabled, maskInverted: !!l.maskInverted,
    expanded: l.expanded, adjustment: l.adjustment, props: l.props, fx: l.fx,
    image: enc(l.canvas), mask: enc(l.mask),
    children: l.children ? l.children.map(ser) : null,
  });
  const payload = {
    magic: BRAND.magic,
    app: BRAND.name,
    version: BRAND.version,
    savedAt: new Date().toISOString(),
    doc: {
      width: doc.width, height: doc.height, dpi: doc.dpi, name: doc.name,
      background: doc.background, colorMode: doc.colorMode, bitDepth: doc.bitDepth,
      activeLayerId: doc.activeLayerId,
      layers: doc.layers.map(ser),
      selection: enc(doc.selection.canvas),
      selectionActive: doc.selection.has,
      guides: doc.guides, paths: doc.paths,
    },
    ...extra,
  };
  return JSON.stringify(payload);
}

export async function saveProject(doc, filename) {
  const json = await serializeProject(doc);
  downloadBlob(new Blob([json], { type: 'application/json' }), filename);
}

export async function deserializeProject(text) {
  const payload = JSON.parse(text);
  if (payload.magic !== BRAND.magic) throw new Error('Not a ' + BRAND.name + ' project file');
  const d = payload.doc;
  const doc = new Doc(d.width, d.height, { dpi: d.dpi, name: d.name, background: d.background });
  doc.guides = d.guides || [];
  doc.paths = d.paths || [];
  const build = async (s) => {
    const l = new Layer({
      id: s.id, type: s.type, name: s.name, visible: s.visible, opacity: s.opacity,
      blend: s.blend, locked: s.locked, alphaLocked: s.alphaLocked, clipped: s.clipped,
      x: s.x, y: s.y,
    });
    l.maskEnabled = s.maskEnabled; l.maskInverted = s.maskInverted; l.expanded = s.expanded;
    l.adjustment = s.adjustment; l.props = s.props || {}; l.fx = s.fx || null;
    if (s.image) l.canvas = await canvasFromDataURL(s.image);
    if (s.mask) l.mask = await canvasFromDataURL(s.mask);
    if (s.children) l.children = await Promise.all(s.children.map(build));
    return l;
  };
  doc.layers = await Promise.all(d.layers.map(build));
  doc.activeLayerId = d.activeLayerId;
  if (d.selection) {
    doc.selection = new (Object.getPrototypeOf(doc.selection).constructor)(d.width, d.height);
    doc.selection._c = await canvasFromDataURL(d.selection);
    doc.selection.has = !!d.selectionActive;
  }
  return doc;
}

export async function loadProject(file) {
  const buf = await fileToBuffer(file);
  const text = new TextDecoder().decode(buf);
  return deserializeProject(text);
}

/** Quick "Save for Web" style export with scaling. */
export async function exportForWeb(canvas, { format = 'png', quality = 80, scale = 1, filename = 'export' }) {
  let c = canvas;
  if (scale !== 1) {
    const t = makeCanvas(Math.round(canvas.width * scale), Math.round(canvas.height * scale));
    const cx = t.getContext('2d');
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
    cx.drawImage(canvas, 0, 0, t.width, t.height);
    c = t;
  }
  const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp' }[format] || 'image/png';
  const blob = await exportCanvas(c, mime, quality / 100);
  downloadBlob(blob, `${filename}.${format}`);
  return blob;
}

export function blobFromDataURL(u) { return dataURLToBlob(u); }
export { blendName };
