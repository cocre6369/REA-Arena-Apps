// PSD read/write (8-bit RGB, RLE compressed) for interchange with other editors.
// The format is documented publicly; this is an independent implementation.

import { makeCanvas } from '../core/util.js';

const BLEND_KEY = {
  normal: 'norm', multiply: 'mul ', screen: 'scrn', overlay: 'over', darken: 'dark',
  lighten: 'lite', colordodge: 'div ', colorburn: 'idiv', hardlight: 'hLit',
  softlight: 'sLit', difference: 'diff', exclusion: 'smud', hue: 'hue ',
  saturation: 'sat ', color: 'colr', luminosity: 'lum ', lineardodge: 'lddg',
  linearburn: 'lgbr', vividlight: 'vLit', linearlight: 'lLit', pinlight: 'pLit',
  hardmix: 'hMix', darkercolor: 'dkCl', lightercolor: 'lgCl', subtract: 'fsub',
  divide: 'fdiv', dissolve: 'diss',
};
const KEY_BLEND = Object.fromEntries(Object.entries(BLEND_KEY).map(([k, v]) => [v, k]));

class Reader {
  constructor(buf) { this.v = new DataView(buf); this.p = 0; this.len = buf.byteLength; }
  u8() { return this.v.getUint8(this.p++); }
  u16() { const v = this.v.getUint16(this.p); this.p += 2; return v; }
  i16() { const v = this.v.getInt16(this.p); this.p += 2; return v; }
  u32() { const v = this.v.getUint32(this.p); this.p += 4; return v; }
  i32() { const v = this.v.getInt32(this.p); this.p += 4; return v; }
  bytes(n) { const s = new Uint8Array(this.v.buffer, this.v.byteOffset + this.p, n); this.p += n; return s; }
  skip(n) { this.p += n; }
  str(n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8()); return s; }
}

function packBitsDecode(src, offset, expected) {
  const out = new Uint8Array(expected);
  let o = 0, p = offset;
  const end = src.length;
  while (o < expected && p < end) {
    const n = src[p++];
    if (n === 128) continue;
    if (n < 128) {
      const count = n + 1;
      for (let i = 0; i < count && o < expected && p < end; i++) out[o++] = src[p++];
    } else {
      const count = 257 - n;
      if (p >= end) break;
      const val = src[p++];
      for (let i = 0; i < count && o < expected; i++) out[o++] = val;
    }
  }
  return { data: out, offset: p };
}

function packBitsEncode(row) {
  const out = [];
  const n = row.length;
  let i = 0;
  while (i < n) {
    let runLen = 1;
    while (i + runLen < n && row[i + runLen] === row[i] && runLen < 128) runLen++;
    if (runLen >= 3) { out.push(257 - runLen, row[i]); i += runLen; continue; }
    let litStart = i;
    const lit = [];
    while (i < n && lit.length < 128) {
      let r = 1;
      while (i + r < n && row[i + r] === row[i] && r < 3) r++;
      if (r >= 3) break;
      lit.push(row[i]); i++;
    }
    out.push(lit.length - 1, ...lit);
    void litStart;
  }
  return out;
}

function rleEncodeChannel(chan, width, height) {
  const counts = [];
  const body = [];
  for (let y = 0; y < height; y++) {
    const row = chan.subarray(y * width, (y + 1) * width);
    const enc = packBitsEncode(row);
    counts.push(enc.length);
    for (const b of enc) body.push(b);
  }
  return { counts, body };
}

// ------------------------------------------------------------------ read
export function parsePSD(arrayBuffer) {
  const r = new Reader(arrayBuffer);
  if (r.str(4) !== '8BPS') throw new Error('Not a PSD file');
  const version = r.u16();
  if (version !== 1) throw new Error('Unsupported PSD version ' + version);
  r.skip(6);
  const channels = r.u16();
  const height = r.u32();
  const width = r.u32();
  const depth = r.u16();
  const mode = r.u16();
  if (depth !== 8) throw new Error('Only 8-bit PSD is supported (found ' + depth + '-bit)');
  if (mode !== 3 && mode !== 1 && mode !== 4) throw new Error('Only RGB/Greyscale/CMYK PSD is supported');

  const colorModeLen = r.u32(); r.skip(colorModeLen);
  const imgResLen = r.u32(); r.skip(imgResLen);
  const lmLen = r.u32();
  const lmEnd = r.p + lmLen;
  const layerInfoLen = r.u32();
  let layerCount = 0;
  const layerRecords = [];
  if (layerInfoLen > 0) {
    layerCount = r.i16();
    for (let i = 0; i < Math.abs(layerCount); i++) {
      const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
      const nch = r.u16();
      const chans = [];
      for (let c = 0; c < nch; c++) chans.push({ id: r.i16(), len: r.u32() });
      const sig = r.str(4);
      if (sig !== '8BIM') throw new Error('Bad blend signature in layer record');
      const key = r.str(4);
      const opacity = r.u8();
      const clipping = r.u8();
      const flags = r.u8();
      r.skip(1);
      const extraLen = r.u32();
      const extraStart = r.p;
      const maskLen = r.u32();
      let maskData = null;
      if (maskLen > 0) {
        maskData = { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32(), defaultColor: r.u8(), flags: r.u8() };
        if (maskLen >= 36) r.skip(2 + 8 + 8 + 1 + 1); // padding + params
        if (r.p < extraStart + maskLen) r.skip(extraStart + maskLen - r.p);
      }
      const blendRangeLen = r.u32(); r.skip(blendRangeLen);
      const nameLen = r.u8();
      const name = r.str(nameLen);
      const padTo4 = (4 - ((1 + nameLen) % 4)) % 4;
      r.skip(padTo4);
      while (r.p < extraStart + extraLen) {
        const s2 = r.str(4);
        if (s2 !== '8BIM') break;
        r.skip(4);
        const sz = r.u32();
        r.skip(sz + (sz % 2));
      }
      r.p = extraStart + extraLen;
      layerRecords.push({
        top, left, bottom, right, w: right - left, h: bottom - top,
        chans, blend: KEY_BLEND[key] || 'normal', opacity: opacity / 255,
        clipping: clipping === 1, visible: !(flags & 2), name, maskData,
      });
    }
    // channel pixel data
    for (const L of layerRecords) {
      for (const ch of L.chans) {
        const comp = r.u16();
        const start = r.p;
        const dataLen = ch.len - 2;
        let raw;
        if (comp === 1) {
          const counts = [];
          for (let y = 0; y < L.h; y++) counts.push(r.u16());
          raw = new Uint8Array(L.w * L.h);
          const src = new Uint8Array(arrayBuffer, r.p);
          let off = 0;
          for (let y = 0; y < L.h; y++) {
            const res = packBitsDecode(src.subarray(off, off + counts[y]), 0, L.w);
            raw.set(res.data, y * L.w);
            off += counts[y];
          }
        } else {
          raw = new Uint8Array(arrayBuffer, r.p, Math.min(dataLen, arrayBuffer.byteLength - r.p)).slice(0, L.w * L.h);
        }
        ch.data = raw;
        r.p = start + dataLen;
      }
    }
  }
  r.p = lmEnd;

  // composite
  const comp = r.u16();
  const compChannels = mode === 3 ? 3 : mode === 1 ? 1 : 4;
  let composite = null;
  try {
    const rows = [];
    if (comp === 1) {
      const counts = [];
      for (let i = 0; i < height * compChannels; i++) counts.push(r.u16());
      const src = new Uint8Array(arrayBuffer, r.p);
      let off = 0;
      for (let c = 0; c < compChannels; c++) {
        const pl = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
          const count = counts[c * height + y] ?? 0;
          const res = packBitsDecode(src.subarray(off, off + count), 0, width);
          pl.set(res.data, y * width);
          off += count;
        }
        rows.push(pl);
      }
    } else {
      for (let c = 0; c < compChannels; c++) rows.push(new Uint8Array(arrayBuffer, r.p + c * width * height, width * height).slice());
    }
    composite = rowsToCanvas(rows, width, height, mode);
  } catch (e) {
    composite = null;
  }

  const layers = layerRecords.map((L) => layerRecordToCanvas(L, mode));
  return { width, height, depth, mode, channels, layers: layers.reverse(), composite };
}

function rowsToCanvas(rows, w, h, mode) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {
    if (mode === 3) {
      d[i * 4] = rows[0][i]; d[i * 4 + 1] = rows[1][i]; d[i * 4 + 2] = rows[2][i]; d[i * 4 + 3] = 255;
    } else if (mode === 1) {
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = rows[0][i]; d[i * 4 + 3] = 255;
    } else {
      const [cc, mm, yy, kk] = [rows[0][i], rows[1][i], rows[2][i], rows[3][i]];
      d[i * 4] = 255 - Math.min(255, cc + kk);
      d[i * 4 + 1] = 255 - Math.min(255, mm + kk);
      d[i * 4 + 2] = 255 - Math.min(255, yy + kk);
      d[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function layerRecordToCanvas(L, mode) {
  const w = Math.max(1, L.w), h = Math.max(1, L.h);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const byId = {};
  for (const ch of L.chans) byId[ch.id] = ch.data;
  const R = byId[0], G = byId[1], B = byId[2], A = byId[-1];
  const chCount = mode === 3 ? 3 : mode === 1 ? 1 : 4;
  for (let i = 0; i < w * h; i++) {
    if (chCount >= 3) {
      d[i * 4] = R ? R[i] : 0;
      d[i * 4 + 1] = G ? G[i] : 0;
      d[i * 4 + 2] = B ? B[i] : 0;
    } else {
      const v = R ? R[i] : 0;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    }
    d[i * 4 + 3] = A ? A[i] : 255;
  }
  ctx.putImageData(img, 0, 0);
  let mask = null;
  const mc = byId[-2];
  if (mc) {
    mask = makeCanvas(w, h);
    const mctx = mask.getContext('2d');
    const mi = mctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      mi.data[i * 4] = mi.data[i * 4 + 1] = mi.data[i * 4 + 2] = 255;
      mi.data[i * 4 + 3] = mc[i];
    }
    mctx.putImageData(mi, 0, 0);
  }
  return {
    name: L.name, canvas: c, mask, opacity: L.opacity, blend: L.blend,
    visible: L.visible, clipped: L.clipping, left: L.left, top: L.top,
  };
}

// ------------------------------------------------------------------ write
export function writePSD(doc, composite) {
  const w = doc.width, h = doc.height;
  const parts = [];
  const pushU16 = (v) => parts.push([(v >> 8) & 255, v & 255]);
  const pushI16 = (v) => { v = v & 0xffff; parts.push([(v >> 8) & 255, v & 255]); };
  const pushU32 = (v) => parts.push([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  const pushI32 = (v) => { const u = v >>> 0; parts.push([(u >>> 24) & 255, (u >>> 16) & 255, (u >>> 8) & 255, u & 255]); };
  const pushStr = (s) => parts.push([...s].map((c) => c.charCodeAt(0)));

  // ---- header
  pushStr('8BPS'); pushU16(1); parts.push([0, 0, 0, 0, 0, 0]);
  pushU16(3); pushU32(h); pushU32(w); pushU16(8); pushU16(3);
  pushU32(0); // colour mode data
  pushU32(0); // image resources

  // ---- build layer info
  const flat = doc.flat().filter((l) => l.type !== 'adjustment');
  const ordered = flat.slice().reverse();       // first record = topmost
  const liParts = [];
  const liPush = (b) => liParts.push(b);
  const liU16 = (v) => liPush([(v >> 8) & 255, v & 255]);
  const liI16 = (v) => { const u = v & 0xffff; liPush([(u >> 8) & 255, u & 255]); };
  const liU32 = (v) => liPush([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  const liI32 = (v) => { const u = v >>> 0; liPush([(u >>> 24) & 255, (u >>> 16) & 255, (u >>> 8) & 255, u & 255]); };
  const liStr = (s) => liPush([...s].map((c) => c.charCodeAt(0)));

  liU16(flat.length);
  const chanDataParts = [];
  for (const L of ordered) {
    const px = layerPixels(L, w, h);
    const chans = [];
    const defs = [
      [0, px.r], [1, px.g], [2, px.b],
    ];
    if (L.mask && L.maskEnabled) defs.push([-2, maskPixels(L.mask, w, h)]);
    defs.push([-1, px.a]);
    const encs = defs.map(([id, planeData]) => ({ id, enc: rleEncodeChannel(planeData, w, h) }));
    liI32(L.y); liI32(L.x); liI32(L.y + h); liI32(L.x + w);
    liU16(encs.length);
    for (const e of encs) { liI16(e.id); liU32(2 + e.enc.counts.length * 2 + e.enc.body.length); }
    liStr('8BIM');
    liStr(BLEND_KEY[L.blend] || 'norm');
    liPush([Math.round(L.opacity * 255), L.clipped ? 1 : 0, L.visible ? 0 : 2, 0]);
    // extra data: mask(0) + blending ranges + name
    const name = (L.name || 'Layer').slice(0, 255);
    const nameBytes = [name.length, ...[...name].map((c) => c.charCodeAt(0))];
    const namePad = (4 - (nameBytes.length % 4)) % 4;
    const extraBody = [...liU32Bytes(0), ...liU32Bytes(40), ...new Array(40).fill(0), ...nameBytes, ...new Array(namePad).fill(0)];
    liU32(extraBody.length);
    liPush(extraBody);
    for (const e of encs) chanDataParts.push([...liU16Bytes(1), ...e.enc.counts.flatMap(liU16Bytes), ...e.enc.body]);
  }

  const liBody = [...liParts.flat(), ...chanDataParts.flat()];
  const liLen = liBody.length;
  const lmBody = [...liU32Bytes(liLen >>> 0), ...liBody, ...liU32Bytes(0)];
  pushU32(lmBody.length);
  parts.push(lmBody);

  // ---- composite image data
  pushU16(1);
  const comp = composite.getContext('2d').getImageData(0, 0, w, h).data;
  const planes = [new Uint8Array(w * h), new Uint8Array(w * h), new Uint8Array(w * h)];
  for (let i = 0; i < w * h; i++) {
    planes[0][i] = comp[i * 4]; planes[1][i] = comp[i * 4 + 1]; planes[2][i] = comp[i * 4 + 2];
  }
  const counts = [];
  const bodies = [];
  for (const p of planes) {
    const enc = rleEncodeChannel(p, w, h);
    counts.push(...enc.counts);
    bodies.push(...enc.body);
  }
  for (const c of counts) pushU16(c);
  parts.push(bodies);

  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out.buffer;
}

function liU32Bytes(v) { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }
function liU16Bytes(v) { return [(v >> 8) & 255, v & 255]; }

function layerPixels(L, w, h) {
  const r = new Uint8Array(w * h), g = new Uint8Array(w * h), b = new Uint8Array(w * h), a = new Uint8Array(w * h);
  if (!L.canvas) return { r, g, b, a };
  const src = L.canvas;
  const sw = Math.min(w, src.width), sh = Math.min(h, src.height);
  if (!sw || !sh) return { r, g, b, a };
  const d = src.getContext('2d').getImageData(0, 0, src.width, src.height).data;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const si = (y * src.width + x) * 4;
    const di = y * w + x;
    r[di] = d[si]; g[di] = d[si + 1]; b[di] = d[si + 2]; a[di] = d[si + 3];
  }
  return { r, g, b, a };
}
function maskPixels(mask, w, h) {
  const out = new Uint8Array(w * h);
  const mw = Math.min(w, mask.width), mh = Math.min(h, mask.height);
  const d = mask.getContext('2d').getImageData(0, 0, mask.width, mask.height).data;
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    out[y * w + x] = d[(y * mask.width + x) * 4 + 3];
  }
  return out;
}

export function downloadPSD(doc, composite, filename) {
  const buf = writePSD(doc, composite);
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename.endsWith('.psd') ? filename : filename + '.psd';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
