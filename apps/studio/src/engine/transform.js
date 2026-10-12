// Resampling, rotation, flipping and free-transform maths.

import { makeCanvas, clamp } from '../core/util.js';

/** Resize with the chosen interpolation. */
export function resample(src, nw, nh, method = 'bicubic') {
  nw = Math.max(1, Math.round(nw)); nh = Math.max(1, Math.round(nh));
  if (src.width === nw && src.height === nh) return copyOf(src);
  const out = makeCanvas(nw, nh);
  const octx = out.getContext('2d');
  if (method === 'nearest') {
    octx.imageSmoothingEnabled = false;
    octx.drawImage(src, 0, 0, nw, nh);
    return out;
  }
  if (method === 'bilinear' || method === 'bicubic' || method === 'bicubicSmoother') {
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = method === 'bilinear' ? 'low' : 'high';
    octx.drawImage(src, 0, 0, nw, nh);
    if (method !== 'bilinear') return out;
    if (nw > src.width || nh > src.height) return out;
    return out;
  }
  if (method === 'lanczos') return lanczos(src, nw, nh, 3);
  if (method === 'preserveDetails') return lanczos(src, nw, nh, 2);
  octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = 'high';
  octx.drawImage(src, 0, 0, nw, nh);
  return out;
}

function copyOf(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

export function lanczos(src, nw, nh, a = 3) {
  const sw = src.width, sh = src.height;
  const sdata = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  const out = makeCanvas(nw, nh);
  const octx = out.getContext('2d');
  const oimg = octx.createImageData(nw, nh);
  const od = oimg.data;
  const ratio = sw / nw;
  const rwidth = Math.ceil(ratio * a * 2);
  const lanc = (x) => {
    if (x === 0) return 1;
    if (x < -a || x > a) return 0;
    const px = Math.PI * x;
    return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
  };
  for (let y = 0; y < nh; y++) {
    const cy = (y + 0.5) * (sh / nh);
    const sy0 = Math.floor(cy);
    for (let x = 0; x < nw; x++) {
      const cx = (x + 0.5) * ratio;
      const sx0 = Math.floor(cx);
      let r = 0, g = 0, b = 0, al = 0, wsum = 0;
      for (let ky = sy0 - a + 1; ky <= sy0 + a; ky++) {
        if (ky < 0 || ky >= sh) continue;
        const wy = lanc(cy - ky);
        if (!wy) continue;
        for (let kx = sx0 - a + 1; kx <= sx0 + a; kx++) {
          if (kx < 0 || kx >= sw) continue;
          const wx = lanc(cx - kx);
          if (!wx) continue;
          const w = wx * wy;
          const i = (ky * sw + kx) * 4;
          const av = sdata[i + 3] / 255;
          r += sdata[i] * w * av; g += sdata[i + 1] * w * av; b += sdata[i + 2] * w * av;
          al += av * w; wsum += w;
        }
      }
      const o = (y * nw + x) * 4;
      if (wsum > 0 && al > 0) {
        od[o] = clamp(r / al, 0, 255);
        od[o + 1] = clamp(g / al, 0, 255);
        od[o + 2] = clamp(b / al, 0, 255);
        od[o + 3] = clamp((al / wsum) * 255, 0, 255);
      }
    }
  }
  octx.putImageData(oimg, 0, 0);
  return out;
}

export function rotate90(src, n) {
  n = ((n % 4) + 4) % 4;
  if (!n) return copyOf(src);
  const w = n % 2 ? src.height : src.width;
  const h = n % 2 ? src.width : src.height;
  const out = makeCanvas(w, h);
  const cx = out.getContext('2d');
  cx.translate(w / 2, h / 2);
  cx.rotate((n * Math.PI) / 2);
  cx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}
export function flip(src, dir) {
  const out = makeCanvas(src.width, src.height);
  const cx = out.getContext('2d');
  cx.translate(dir === 'h' ? src.width : 0, dir === 'v' ? src.height : 0);
  cx.scale(dir === 'h' ? -1 : 1, dir === 'v' ? -1 : 1);
  cx.drawImage(src, 0, 0);
  return out;
}
export function rotateArbitrary(src, degrees, resize = true, bg = null) {
  if (!degrees) return copyOf(src);
  const a = (degrees * Math.PI) / 180;
  const cs = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
  const w = src.width, h = src.height;
  const nw = resize ? Math.ceil(w * cs + h * sn) : w;
  const nh = resize ? Math.ceil(w * sn + h * cs) : h;
  const out = makeCanvas(nw, nh);
  const cx = out.getContext('2d');
  if (bg) { cx.fillStyle = bg; cx.fillRect(0, 0, nw, nh); }
  cx.translate(nw / 2, nh / 2);
  cx.rotate(a);
  cx.drawImage(src, -w / 2, -h / 2);
  return out;
}

/** Draw src through a 3x3 projective transform onto a canvas of (w,h). */
export function projectCanvas(src, w, h, m) {
  const out = makeCanvas(w, h);
  const octx = out.getContext('2d');
  const sdata = src.getContext('2d').getImageData(0, 0, src.width, src.height).data;
  const oimg = octx.createImageData(w, h);
  const od = oimg.data;
  const inv = invert3(m);
  if (!inv) return out;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [sx, sy] = apply3(inv, x + 0.5, y + 0.5);
    if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
    const x0 = Math.floor(sx), y0 = Math.floor(sy);
    const tx = sx - x0, ty = sy - y0;
    const x1 = Math.min(src.width - 1, x0 + 1), y1 = Math.min(src.height - 1, y0 + 1);
    const i00 = (y0 * src.width + x0) * 4, i10 = (y0 * src.width + x1) * 4;
    const i01 = (y1 * src.width + x0) * 4, i11 = (y1 * src.width + x1) * 4;
    const o = (y * w + x) * 4;
    for (let c = 0; c < 4; c++) {
      const a = sdata[i00 + c] * (1 - tx) + sdata[i10 + c] * tx;
      const b = sdata[i01 + c] * (1 - tx) + sdata[i11 + c] * tx;
      od[o + c] = a * (1 - ty) + b * ty;
    }
  }
  octx.putImageData(oimg, 0, 0);
  return out;
}
export function mul3(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += a[r * 3 + k] * b[k * 3 + c];
    o[r * 3 + c] = s;
  }
  return o;
}
export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ];
  return inv.map((v) => v / det);
}
function apply3(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8] || 1;
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/** Build the transform matrix mapping unit square -> quad. */
export function quadToUnit(p0, p1, p2, p3) {
  const [x0, y0] = p0, [x1, y1] = p1, [x2, y2] = p2, [x3, y3] = p3;
  const dx1 = x1 - x2, dx2 = x3 - x2, sx = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, sy = y0 - y1 + y2 - y3;
  let g = 1, h = 1;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) { g = 0; h = 0; }
  else {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const c = x0;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  const f = y0;
  return [a, b, c, d, e, f, g, h, 1];
}

/** Warp: bilinear mesh over an NxN grid of control offsets. */
export function warpCanvas(src, grid, n, outW, outH) {
  const out = makeCanvas(outW || src.width, outH || src.height);
  const octx = out.getContext('2d');
  const sdata = src.getContext('2d').getImageData(0, 0, src.width, src.height).data;
  const oimg = octx.createImageData(out.width, out.height);
  const od = oimg.data;
  const W = out.width, H = out.height;
  const cellW = W / (n - 1), cellH = H / (n - 1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const gx = x / cellW, gy = y / cellH;
    const ix = Math.min(n - 2, Math.floor(gx)), iy = Math.min(n - 2, Math.floor(gy));
    const tx = gx - ix, ty = gy - iy;
    const p = (i, j) => grid[(j * n + i) * 2];
    const dstX = bilinear(p(ix, iy), p(ix + 1, iy), p(ix, iy + 1), p(ix + 1, iy + 1), tx, ty, 0);
    const dstY = bilinear(p(ix, iy), p(ix + 1, iy), p(ix, iy + 1), p(ix + 1, iy + 1), tx, ty, 1);
    const sx = x - (dstX - (ix + tx) * cellW);
    const sy = y - (dstY - (iy + ty) * cellH);
    if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
    const x0 = Math.floor(sx), y0 = Math.floor(sy);
    const fx = sx - x0, fy = sy - y0;
    const x1 = Math.min(src.width - 1, x0 + 1), y1 = Math.min(src.height - 1, y0 + 1);
    const i00 = (y0 * src.width + x0) * 4, i10 = (y0 * src.width + x1) * 4;
    const i01 = (y1 * src.width + x0) * 4, i11 = (y1 * src.width + x1) * 4;
    const o = (y * W + x) * 4;
    for (let c = 0; c < 4; c++) {
      const a = sdata[i00 + c] * (1 - fx) + sdata[i10 + c] * fx;
      const b = sdata[i01 + c] * (1 - fx) + sdata[i11 + c] * fx;
      od[o + c] = a * (1 - fy) + b * fy;
    }
  }
  octx.putImageData(oimg, 0, 0);
  return out;
}
function bilinear(a, b, c, d, tx, ty, off) {
  const top = a[off] * (1 - tx) + b[off] * tx;
  const bot = c[off] * (1 - tx) + d[off] * tx;
  return top * (1 - ty) + bot * ty;
}
