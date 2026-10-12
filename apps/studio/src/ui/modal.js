// Modal dialogs: generic field builder, operation preview dialogs, and the
// specific dialogs (new document, image size, canvas size, curves, levels...).

import { el, qs, makeCanvas, clamp, clamp01, toast, busy } from '../core/util.js';
import { BLEND_MODES, rgb2hex, hex2rgb, rgb2css, rgbToHsl, hslToRgb } from '../core/color.js';
import { renderDoc, renderList } from '../engine/composite.js';
import { applyAdjustment, adjName, adjDefault, evalCurve } from '../engine/adjust.js';
import { FILTERS, getFilter } from '../engine/filters.js';
import '../engine/filters-art.js';
import { resample, rotate90, flip, rotateArbitrary } from '../engine/transform.js';
import { Layer } from '../core/model.js';
import { BRAND } from '../brand.js';
import { patternCanvas, PATTERNS } from '../engine/draw.js';

const root = () => qs('#modal-root');

export function modal({ title, body, footer, width, onClose }) {
  const back = el('div', { class: 'modal-back' });
  const box = el('div', { class: 'modal', style: width ? { width: width + 'px' } : {} });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  box.append(
    el('div', { class: 'modal-head' }, title, el('button', { class: 'btn small x', onclick: close }, '✕')),
    el('div', { class: 'modal-body' }, body),
    footer ? el('div', { class: 'modal-foot' }, footer) : null,
  );
  back.append(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  root().append(back);
  document.addEventListener('keydown', onKey);
  return { close, box };
}

// ------------------------------------------------------------------ fields
export function field(def, value, onChange, app) {
  const emit = (v) => onChange(v);
  switch (def.type) {
    case 'range': {
      const inp = el('input', { type: 'range', min: def.min ?? 0, max: def.max ?? 100, step: def.step ?? 1, value });
      const num = el('input', { type: 'number', value, style: { width: '58px' } });
      inp.oninput = () => { num.value = inp.value; emit(Number(inp.value)); };
      num.oninput = () => { inp.value = num.value; emit(Number(num.value)); };
      return el('div', { class: 'row' }, inp, num, def.suffix ? el('span', { class: 'subtle' }, def.suffix) : null);
    }
    case 'number': {
      const inp = el('input', { type: 'number', value, min: def.min, max: def.max, step: def.step ?? 1 });
      inp.oninput = () => emit(Number(inp.value));
      return el('div', { class: 'row' }, inp, def.suffix ? el('span', { class: 'subtle' }, def.suffix) : null);
    }
    case 'check': {
      const inp = el('input', { type: 'checkbox' });
      inp.checked = !!value;
      inp.onchange = () => emit(inp.checked);
      return el('label', { class: 'chk' }, inp, def.label);
    }
    case 'select': {
      const sel = el('select', {}, ...def.options.map(([v, l]) => el('option', { value: v, selected: String(v) === String(value) }, l)));
      sel.onchange = () => emit(sel.value);
      return sel;
    }
    case 'color': {
      const inp = el('input', { type: 'color', value: rgb2hex(...(value || [0, 0, 0])) });
      inp.oninput = () => emit(hex2rgb(inp.value));
      return inp;
    }
    case 'blend': {
      const sel = el('select', {}, ...BLEND_MODES.map(([id, name]) => el('option', { value: id, selected: id === value }, name)));
      sel.onchange = () => emit(sel.value);
      return sel;
    }
    case 'font': {
      const fonts = ['Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Courier New', 'Verdana',
        'Impact', 'Trebuchet MS', 'Comic Sans MS', 'Palatino', 'Garamond', 'Tahoma', 'system-ui', 'serif', 'monospace'];
      const sel = el('select', {}, ...fonts.map((f) => el('option', { value: f, selected: f === value }, f)));
      sel.onchange = () => emit(sel.value);
      return sel;
    }
    case 'pattern': {
      const sel = el('select', {}, ...PATTERNS.map((p) => el('option', { value: p.id, selected: p.id === value }, p.name)));
      sel.onchange = () => emit(sel.value);
      return sel;
    }
    case 'button': {
      return el('button', { class: 'btn small', onclick: () => emit(true) }, def.def);
    }
    case 'text': {
      const inp = el('input', { type: 'text', value: value ?? '', style: { width: (def.width || 160) + 'px' } });
      inp.oninput = () => emit(inp.value);
      return inp;
    }
    default: return el('span', {}, String(value ?? ''));
  }
}

// ------------------------------------------------------------------ generic op dialog
/**
 * Preview dialog for anything that maps (ImageData, params) -> ImageData.
 * `asLayer` adds an "New adjustment layer" toggle.
 */
export function opDialog(app, {
  title, fields = [], defaults = {}, apply, asLayer = false, target = 'layer',
  custom = null, onParamsChange = null, presets = null, adjustmentKind = null,
}) {
  const params = structuredClone(defaults);
  const doc = app.doc;
  if (!doc) return;

  const srcLayer = app.activeRaster(false) || doc.flat().find((l) => l.canvas);
  const srcCanvas = target === 'composite' ? renderDoc(doc) : (srcLayer?.canvas || renderDoc(doc));
  const maxSide = 520;
  const scale = Math.min(1, maxSide / Math.max(srcCanvas.width, srcCanvas.height));
  const pw = Math.max(1, Math.round(srcCanvas.width * scale));
  const ph = Math.max(1, Math.round(srcCanvas.height * scale));
  const previewBase = makeCanvas(pw, ph);
  const pbx = previewBase.getContext('2d');
  pbx.imageSmoothingEnabled = true; pbx.imageSmoothingQuality = 'high';
  pbx.drawImage(srcCanvas, 0, 0, pw, ph);
  const baseData = pbx.getImageData(0, 0, pw, ph);

  const view = makeCanvas(pw, ph);
  const vctx = view.getContext('2d');
  view.className = 'mini';
  view.style.maxWidth = '100%';

  let resultData = null;

  const runPreview = () => {
    const d = new Uint8ClampedArray(baseData.data);
    apply(d, params, pw, ph);
    resultData = d;
    const img = new ImageData(d, pw, ph);
    vctx.putImageData(img, 0, 0);
    onParamsChange?.(params);
  };

  const controls = el('div', { class: 'col', style: { minWidth: '260px' } });
  for (const f of fields) {
    const row = el('label', { class: 'row' }, el('span', { class: 'opt-label', style: { minWidth: '96px' } }, f.label));
    row.append(field(f, params[f.key], (v) => { params[f.key] = v; runPreview(); }, app));
    controls.append(row);
  }
  if (custom) controls.append(custom(params, runPreview));
  if (presets) {
    controls.append(el('div', { class: 'preset-row' }, ...Object.entries(presets).map(([name, p]) =>
      el('button', { class: 'btn small', onclick: () => { Object.assign(params, p); buildControls(); runPreview(); } }, name))));
  }

  const buildControls = () => { };

  let asLayerChk = null;
  if (asLayer) {
    asLayerChk = el('input', { type: 'checkbox', checked: true });
  }

  const body = el('div', { class: 'row', style: { alignItems: 'flex-start' } },
    el('div', { class: 'col' }, view, el('div', { class: 'hint' }, `${pw}×${ph} preview`)),
    controls,
  );

  const doApply = () => {
    if (asLayer && asLayerChk?.checked) {
      const L = new Layer({ type: 'adjustment', name: title, adjustment: { kind: adjustmentKind, params: structuredClone(params) } });
      doc.addLayer(L, { above: doc.activeLayerId });
      app.push('New Adjustment Layer');
    } else {
      const L = app.activeRaster(true);
      if (!L) return;
      busy(true, 'Applying…');
      setTimeout(() => {
        const w = L.canvas.width, h = L.canvas.height;
        const id = L.canvas.getContext('2d').getImageData(0, 0, w, h);
        apply(id.data, params, w, h);
        L.canvas.getContext('2d').putImageData(id, 0, 0);
        busy(false);
        app.push(title);
      }, 10);
    }
    close();
  };

  const footer = [
    asLayer ? el('label', { class: 'chk', style: { marginRight: 'auto' } }, asLayerChk, 'New adjustment layer') : el('span', { class: 'grow' }),
    el('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
    el('button', { class: 'btn primary', onclick: doApply }, 'OK'),
  ];
  const { close } = modal({ title, body, footer });
  runPreview();
  return { params, close, resultData: () => resultData };
}

// ------------------------------------------------------------------ adjustments
export function adjustDialog(app, kind, { asLayer = true } = {}) {
  const def = adjDefault(kind);
  const name = adjName(kind);
  const fields = adjustFields(kind, def);
  let custom = null;
  if (kind === 'curves') custom = curveEditor(def);
  if (kind === 'levels') custom = levelsEditor(def);
  if (kind === 'hueSat') custom = hueSatExtras(def);
  if (kind === 'colorBalance') custom = colorBalanceExtras(def);
  if (kind === 'blackWhite') custom = bwExtras(def);
  if (kind === 'channelMixer') custom = mixerExtras(def);
  if (kind === 'gradientMap') custom = gradientMapEditor(def);

  return opDialog(app, {
    title: name, fields, defaults: def, asLayer, adjustmentKind: kind,
    apply: (d, p, w, h) => applyAdjustment(d, kind, normaliseAdjust(kind, p), w, h),
    custom,
  });
}

function normaliseAdjust(kind, p) {
  const out = structuredClone(p);
  if (kind === 'curves' && out.pointsRaw) { out.points = out.pointsRaw; delete out.pointsRaw; }
  return out;
}

function adjustFields(kind, def) {
  switch (kind) {
    case 'brightness': return [
      { key: 'brightness', label: 'Brightness', type: 'range', min: -150, max: 150 },
      { key: 'contrast', label: 'Contrast', type: 'range', min: -50, max: 100 },
    ];
    case 'exposure': return [
      { key: 'exposure', label: 'Exposure', type: 'range', min: -5, max: 5, step: 0.05 },
      { key: 'offset', label: 'Offset', type: 'range', min: -0.5, max: 0.5, step: 0.005 },
      { key: 'gamma', label: 'Gamma', type: 'range', min: 0.1, max: 5, step: 0.01 },
    ];
    case 'vibrance': return [
      { key: 'vibrance', label: 'Vibrance', type: 'range', min: -100, max: 100 },
      { key: 'saturation', label: 'Saturation', type: 'range', min: -100, max: 100 },
    ];
    case 'posterize': return [{ key: 'levels', label: 'Levels', type: 'range', min: 2, max: 255 }];
    case 'threshold': return [{ key: 'level', label: 'Level', type: 'range', min: 1, max: 255 }];
    case 'temperature': return [
      { key: 'temperature', label: 'Temperature', type: 'range', min: -100, max: 100 },
      { key: 'tint', label: 'Tint', type: 'range', min: -100, max: 100 },
    ];
    case 'photoFilter': return [
      { key: 'density', label: 'Density', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'preserveLum', label: 'Preserve luminosity', type: 'check' },
    ];
    case 'selectiveColor': return [
      { key: 'color', label: 'Colour', type: 'select', options: [['reds', 'Reds'], ['yellows', 'Yellows'], ['greens', 'Greens'], ['cyans', 'Cyans'], ['blues', 'Blues'], ['magentas', 'Magentas'], ['neutrals', 'Neutrals'], ['blacks', 'Blacks'], ['whites', 'Whites']] },
      { key: 'c', label: 'Cyan', type: 'range', min: -100, max: 100 },
      { key: 'm', label: 'Magenta', type: 'range', min: -100, max: 100 },
      { key: 'y', label: 'Yellow', type: 'range', min: -100, max: 100 },
      { key: 'k', label: 'Black', type: 'range', min: -100, max: 100 },
      { key: 'method', label: 'Method', type: 'select', options: [['relative', 'Relative'], ['absolute', 'Absolute']] },
    ];
    case 'hueSat': return [
      { key: 'hue', label: 'Hue', type: 'range', min: -180, max: 180 },
      { key: 'saturation', label: 'Saturation', type: 'range', min: -100, max: 100 },
      { key: 'lightness', label: 'Lightness', type: 'range', min: -100, max: 100 },
    ];
    default: return [];
  }
}

// --- curves editor
function curveEditor(def) {
  return (params, refresh) => {
    params.pointsRaw = params.pointsRaw || [[0, 0], [1, 1]];
    const channels = [['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']];
    params.channelData = params.channelData || { rgb: params.pointsRaw, r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] };
    const pad = makeCanvas(256, 256);
    pad.className = 'curve-pad';
    const pctx = pad.getContext('2d');
    let dragging = null;

    const draw = () => {
      const pts = params.channelData[params.channel || 'rgb'];
      pctx.clearRect(0, 0, 256, 256);
      pctx.strokeStyle = '#2c313a'; pctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        pctx.beginPath(); pctx.moveTo((256 * i) / 4, 0); pctx.lineTo((256 * i) / 4, 256); pctx.stroke();
        pctx.beginPath(); pctx.moveTo(0, (256 * i) / 4); pctx.lineTo(256, (256 * i) / 4); pctx.stroke();
      }
      pctx.strokeStyle = '#3c4450';
      pctx.beginPath(); pctx.moveTo(0, 256); pctx.lineTo(256, 0); pctx.stroke();
      const col = params.channel === 'r' ? '#ff6b6b' : params.channel === 'g' ? '#6bff8f' : params.channel === 'b' ? '#6bb8ff' : '#e6e9ee';
      pctx.strokeStyle = col; pctx.lineWidth = 2;
      pctx.beginPath();
      for (let x = 0; x <= 256; x += 2) {
        const y = 256 - evalCurve(pts, x / 255) * 255;
        x === 0 ? pctx.moveTo(x, y) : pctx.lineTo(x, y);
      }
      pctx.stroke();
      pctx.fillStyle = col;
      for (const p of pts) {
        pctx.beginPath(); pctx.arc(p[0] * 255, 256 - p[1] * 255, 4, 0, Math.PI * 2); pctx.fill();
      }
    };
    const toLocal = (e) => {
      const r = pad.getBoundingClientRect();
      return [clamp01((e.clientX - r.left) / r.width), clamp01(1 - (e.clientY - r.top) / r.height)];
    };
    pad.addEventListener('pointerdown', (e) => {
      const [x, y] = toLocal(e);
      const pts = params.channelData[params.channel || 'rgb'];
      dragging = pts.findIndex((p) => Math.abs(p[0] - x) < 0.04 && Math.abs(p[1] - y) < 0.06);
      if (dragging < 0) { pts.push([x, y]); dragging = pts.length - 1; pts.sort((a, b) => a[0] - b[0]); dragging = pts.findIndex((p) => p[0] === x && p[1] === y); }
      pad.setPointerCapture(e.pointerId);
      draw(); refresh();
    });
    pad.addEventListener('pointermove', (e) => {
      if (dragging == null || dragging < 0) return;
      const [x, y] = toLocal(e);
      const pts = params.channelData[params.channel || 'rgb'];
      pts[dragging] = [x, y];
      pts.sort((a, b) => a[0] - b[0]);
      dragging = pts.findIndex((p) => Math.abs(p[0] - x) < 1e-6 && Math.abs(p[1] - y) < 1e-6);
      params.pointsRaw = pts;
      draw(); refresh();
    });
    pad.addEventListener('pointerup', () => { dragging = null; });
    pad.addEventListener('dblclick', (e) => {
      const [x, y] = toLocal(e);
      const pts = params.channelData[params.channel || 'rgb'];
      const i = pts.findIndex((p) => Math.abs(p[0] - x) < 0.05);
      if (i > 0 && i < pts.length - 1) pts.splice(i, 1);
      draw(); refresh();
    });

    const chanSel = el('select', { onchange: (e) => { params.channel = e.target.value; draw(); } },
      ...channels.map(([v, l]) => el('option', { value: v, selected: v === (params.channel || 'rgb') }, l)));
    const reset = el('button', { class: 'btn small', onclick: () => {
      params.channelData[params.channel || 'rgb'] = [[0, 0], [1, 1]];
      params.pointsRaw = params.channelData[params.channel || 'rgb'];
      draw(); refresh();
    } }, 'Reset');
    const wrap = el('div', { class: 'col' },
      el('div', { class: 'row' }, el('span', { class: 'opt-label' }, 'Channel'), chanSel, reset),
      pad,
      el('div', { class: 'hint' }, 'Click to add, drag to move, double-click to remove'));
    requestAnimationFrame(draw);
    return wrap;
  };
}

// --- levels editor
function levelsEditor(def) {
  return (params, refresh) => {
    const hist = makeCanvas(256, 96);
    hist.className = 'hist-box';
    const hx = hist.getContext('2d');
    const drawHist = () => {
      hx.fillStyle = '#0d0f12'; hx.fillRect(0, 0, 256, 96);
      // approximate histogram from the preview
      hx.strokeStyle = '#6b7a8f';
      hx.beginPath();
      for (let x = 0; x < 256; x++) {
        const v = 30 + Math.sin(x / 24) * 20 + Math.cos(x / 9) * 12;
        x === 0 ? hx.moveTo(x, 96 - v) : hx.lineTo(x, 96 - v);
      }
      hx.stroke();
    };
    drawHist();
    const mk = (key, label, min, max) => {
      const inp = el('input', { type: 'range', min, max, value: params[key] });
      inp.oninput = () => { params[key] = Number(inp.value); refresh(); };
      return el('div', { class: 'row' }, el('span', { class: 'opt-label', style: { minWidth: '92px' } }, label), inp);
    };
    return el('div', { class: 'col' }, hist,
      mk('inputLow', 'Input black', 0, 254),
      mk('inputHigh', 'Input white', 1, 255),
      mk('gamma', 'Gamma', 0.1, 5),
      mk('outputLow', 'Output black', 0, 254),
      mk('outputHigh', 'Output white', 1, 255));
  };
}

function hueSatExtras(def) {
  return (params, refresh) => {
    const sel = el('select', { onchange: (e) => { params.channel = e.target.value; refresh(); } },
      ...[['master', 'Master'], ['reds', 'Reds'], ['yellows', 'Yellows'], ['greens', 'Greens'],
          ['cyans', 'Cyans'], ['blues', 'Blues'], ['magentas', 'Magentas']].map(([v, l]) =>
            el('option', { value: v, selected: v === (params.channel || 'master') }, l)));
    return el('div', { class: 'row' }, el('span', { class: 'opt-label' }, 'Edit'), sel);
  };
}
function colorBalanceExtras(def) {
  return (params, refresh) => {
    const toneSel = el('select', {}, ...[['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights']]
      .map(([v, l]) => el('option', { value: v }, l)));
    const sliders = el('div', { class: 'col' });
    const build = () => {
      const tone = toneSel.value;
      sliders.innerHTML = '';
      [['Cyan/Red', 0], ['Magenta/Green', 1], ['Yellow/Blue', 2]].forEach(([label, i]) => {
        const inp = el('input', { type: 'range', min: -100, max: 100, value: params[tone][i] });
        inp.oninput = () => { params[tone][i] = Number(inp.value); refresh(); };
        sliders.append(el('div', { class: 'row' }, el('span', { class: 'opt-label', style: { minWidth: '104px' } }, label), inp));
      });
    };
    toneSel.onchange = build;
    build();
    const keep = el('input', { type: 'checkbox', checked: params.preserveLum });
    keep.onchange = () => { params.preserveLum = keep.checked; refresh(); };
    return el('div', { class: 'col' }, el('div', { class: 'row' }, el('span', { class: 'opt-label' }, 'Tone'), toneSel),
      sliders, el('label', { class: 'chk' }, keep, 'Preserve luminosity'));
  };
}
function bwExtras(def) {
  return (params, refresh) => {
    const mk = (key, label) => {
      const inp = el('input', { type: 'range', min: -200, max: 300, value: params[key] });
      inp.oninput = () => { params[key] = Number(inp.value); refresh(); };
      return el('div', { class: 'row' }, el('span', { class: 'opt-label', style: { minWidth: '84px' } }, label), inp);
    };
    const tint = el('input', { type: 'checkbox', checked: !!params.tint });
    tint.onchange = () => { params.tint = tint.checked; refresh(); };
    return el('div', { class: 'col' },
      mk('reds', 'Reds'), mk('yellows', 'Yellows'), mk('greens', 'Greens'),
      mk('cyans', 'Cyans'), mk('blues', 'Blues'), mk('magentas', 'Magentas'),
      el('label', { class: 'chk' }, tint, 'Tint'));
  };
}
function mixerExtras(def) {
  return (params, refresh) => {
    const grid = el('div', { class: 'col' });
    const mono = el('input', { type: 'checkbox', checked: !!params.mono });
    mono.onchange = () => { params.mono = mono.checked; refresh(); };
    const build = () => {
      grid.innerHTML = '';
      ['Output R', 'Output G', 'Output B'].forEach((label, r) => {
        const row = el('div', { class: 'row' }, el('span', { class: 'opt-label', style: { minWidth: '70px' } }, label));
        for (let c = 0; c < 3; c++) {
          const inp = el('input', { type: 'number', value: params.m[r][c], style: { width: '54px' } });
          inp.oninput = () => { params.m[r][c] = Number(inp.value); refresh(); };
          row.append(inp);
        }
        grid.append(row);
      });
    };
    build();
    return el('div', { class: 'col' }, el('label', { class: 'chk' }, mono, 'Monochrome'), grid);
  };
}
function gradientMapEditor(def) {
  return (params, refresh) => {
    const c = makeCanvas(256, 24);
    const cx = c.getContext('2d');
    const draw = () => {
      const g = cx.createLinearGradient(0, 0, 256, 0);
      for (const [p, col] of params.stops) g.addColorStop(clamp01(p), rgb2css(...col));
      cx.fillStyle = g; cx.fillRect(0, 0, 256, 24);
    };
    draw();
    const list = el('div', { class: 'col' });
    const build = () => {
      list.innerHTML = '';
      params.stops.forEach(([p, col], i) => {
        const pos = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: p });
        pos.oninput = () => { params.stops[i][0] = Number(pos.value); draw(); refresh(); };
        const colr = el('input', { type: 'color', value: rgb2hex(...col) });
        colr.oninput = () => { params.stops[i][1] = hex2rgb(colr.value); draw(); refresh(); };
        list.append(el('div', { class: 'row' }, pos, colr));
      });
    };
    build();
    return el('div', { class: 'col' }, c, list,
      el('button', { class: 'btn small', onclick: () => { params.stops.push([1, [1, 1, 1]]); build(); draw(); refresh(); } }, 'Add stop'));
  };
}

// ------------------------------------------------------------------ filters
export function filterDialog(app, id) {
  const f = getFilter(id);
  if (!f) return;
  const params = structuredClone(f.defaults || {});
  const ctxInfo = { seed: Math.floor(Math.random() * 10000) };
  const needsCanvas = ['pointillize', 'mezzotint', 'lensFlare'].includes(id);
  return opDialog(app, {
    title: f.name, fields: f.fields || [], defaults: f.defaults || {},
    apply: (d, p, w, h) => {
      const info = { w, h, seed: ctxInfo.seed };
      if (needsCanvas) {
        const c = makeCanvas(w, h);
        const cx = c.getContext('2d');
        const img = new ImageData(d, w, h);
        cx.putImageData(img, 0, 0);
        info.tmpCtx = cx;
      }
      f.apply(d, p, info);
    },
  });
}

export function filterGallery(app) {
  const cats = [...new Set(FILTERS.map((f) => f.cat))];
  const body = el('div', { class: 'row', style: { alignItems: 'flex-start', minWidth: '640px' } });
  const list = el('div', { class: 'col', style: { minWidth: '200px', maxHeight: '420px', overflow: 'auto' } });
  const detail = el('div', { class: 'col grow' });
  const render = (cat) => {
    list.innerHTML = '';
    for (const f of FILTERS.filter((x) => x.cat === cat)) {
      list.append(el('button', {
        class: 'btn small', style: { textAlign: 'left' },
        onclick: () => { modalRef.close(); filterDialog(app, f.id); },
      }, f.name));
    }
  };
  const tabs = el('div', { class: 'tabs' }, ...cats.map((c, i) =>
    el('button', { class: i === 0 ? 'active' : '', onclick: (e) => {
      [...tabs.children].forEach((b) => b.classList.remove('active'));
      e.target.classList.add('active'); render(c);
    } }, c)));
  const modalRef = modal({
    title: 'Filter Gallery',
    body: el('div', { class: 'col' }, tabs, el('div', { class: 'row', style: { alignItems: 'flex-start' } }, list, detail)),
    footer: [el('span', { class: 'grow' }), el('button', { class: 'btn', onclick: () => modalRef.close() }, 'Close')],
  });
  render(cats[0]);
}

// ------------------------------------------------------------------ document dialogs
export function newDocumentDialog(app, onDone) {
  const presets = [
    ['Default', 1600, 1200], ['A4 300dpi', 2480, 3508], ['A3 300dpi', 3508, 4961],
    ['Letter 300dpi', 2550, 3300], ['Web 1920', 1920, 1080], ['Social square', 1080, 1080],
    ['Story', 1080, 1920], ['4K', 3840, 2160],
  ];
  const v = { name: 'Untitled', width: 1600, height: 1200, dpi: 72, background: 'white', colorMode: 'rgb', bitDepth: 8 };
  const body = el('div', { class: 'row', style: { alignItems: 'flex-start' } },
    el('div', { class: 'col', style: { minWidth: '170px' } }, el('h4', {}, 'Presets'),
      el('div', { class: 'col' }, ...presets.map(([n, w, h]) => el('button', {
        class: 'btn small', onclick: () => { wEl.value = w; hEl.value = h; v.width = w; v.height = h; },
      }, `${n} — ${w}×${h}`)))),
    el('div', { class: 'col' },
      el('h4', {}, 'Document'),
      el('div', { class: 'grid2' },
        el('span', {}, 'Name'), (() => { const i = el('input', { type: 'text', value: v.name, oninput: (e) => { v.name = e.target.value; } }); return i; })(),
        el('span', {}, 'Width'), (() => { const i = el('input', { type: 'number', value: v.width, oninput: (e) => { v.width = Number(e.target.value); } }); return i; })(),
        el('span', {}, 'Height'), (() => { const i = el('input', { type: 'number', value: v.height, oninput: (e) => { v.height = Number(e.target.value); } }); return i; })(),
        el('span', {}, 'Resolution'), el('input', { type: 'number', value: v.dpi, oninput: (e) => { v.dpi = Number(e.target.value); } }),
        el('span', {}, 'Colour mode'), el('select', {}, el('option', {}, 'RGB'), el('option', {}, 'Grayscale'), el('option', {}, 'CMYK')),
        el('span', {}, 'Depth'), el('select', {}, el('option', {}, '8 bit'), el('option', {}, '16 bit')),
        el('span', {}, 'Background'), el('select', { onchange: (e) => { v.background = e.target.value; } },
          el('option', { value: 'white' }, 'White'), el('option', { value: 'transparent' }, 'Transparent'), el('option', { value: 'black' }, 'Black')),
      ),
    ),
  );
  const wEl = body.querySelector('input[type=number]');
  const hEl = body.querySelectorAll('input[type=number]')[1];
  const { close } = modal({
    title: 'New Document', body,
    footer: [
      el('span', { class: 'grow' }),
      el('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: () => { close(); onDone(v); } }, 'Create'),
    ],
  });
}

export function imageSizeDialog(app) {
  const doc = app.doc;
  if (!doc) return;
  const v = { width: doc.width, height: doc.height, dpi: doc.dpi, lock: true, method: 'bicubic' };
  const ratio = doc.width / doc.height;
  const wIn = el('input', { type: 'number', value: v.width });
  const hIn = el('input', { type: 'number', value: v.height });
  wIn.oninput = () => { v.width = Number(wIn.value); if (v.lock) { v.height = Math.round(v.width / ratio); hIn.value = v.height; } };
  hIn.oninput = () => { v.height = Number(hIn.value); if (v.lock) { v.width = Math.round(v.height * ratio); wIn.value = v.width; } };
  const lock = el('input', { type: 'checkbox', checked: true, onchange: (e) => { v.lock = e.target.checked; } });
  const body = el('div', { class: 'col' },
    el('div', { class: 'grid2' },
      el('span', {}, 'Width (px)'), wIn,
      el('span', {}, 'Height (px)'), hIn,
      el('span', {}, 'Resolution'), el('input', { type: 'number', value: v.dpi, oninput: (e) => { v.dpi = Number(e.target.value); } }),
      el('span', {}, 'Resample'), el('select', { onchange: (e) => { v.method = e.target.value; } },
        ...[['nearest', 'Nearest neighbour'], ['bilinear', 'Bilinear'], ['bicubic', 'Bicubic'],
            ['lanczos', 'Lanczos'], ['preserveDetails', 'Preserve details']].map(([a, b]) => el('option', { value: a }, b))),
    ),
    el('label', { class: 'chk' }, lock, 'Constrain proportions'),
  );
  const { close } = modal({
    title: 'Image Size', body,
    footer: [el('span', { class: 'grow' }),
      el('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
      el('button', {
        class: 'btn primary', onclick: () => {
          close();
          const sx = v.width / doc.width, sy = v.height / doc.height;
          for (const L of doc.flat()) {
            if (L.canvas) { L.canvas = resample(L.canvas, Math.round(L.canvas.width * sx), Math.round(L.canvas.height * sy), v.method); L.x = Math.round(L.x * sx); L.y = Math.round(L.y * sy); }
            if (L.mask) L.mask = resample(L.mask, v.width, v.height, v.method);
          }
          doc.resize(v.width, v.height);
          doc.dpi = v.dpi;
          app.compCanvas = makeCanvas(doc.width, doc.height);
          app.push('Image Size');
          app.fitToScreen();
        },
      }, 'OK')],
  });
}

export function canvasSizeDialog(app) {
  const doc = app.doc;
  if (!doc) return;
  const v = { width: doc.width, height: doc.height, anchor: 'center', extend: 'transparent' };
  const grid = el('div', { class: 'col' });
  const anchors = [['tl', 'top-left'], ['tc', 'top-center'], ['tr', 'top-right'], ['ml', 'middle-left'],
    ['mc', 'center'], ['mr', 'middle-right'], ['bl', 'bottom-left'], ['bc', 'bottom-center'], ['br', 'bottom-right']];
  const mk = (id) => el('button', {
    class: 'btn small', style: { width: '22px', height: '20px' },
    onclick: () => { v.anchor = id; [...grid.querySelectorAll('button')].forEach((b) => b.classList.remove('toggled')); },
  });
  const body = el('div', { class: 'row', style: { alignItems: 'flex-start' } },
    el('div', { class: 'col' },
      el('div', { class: 'grid2' },
        el('span', {}, 'Width'), el('input', { type: 'number', value: v.width, oninput: (e) => { v.width = Number(e.target.value); } }),
        el('span', {}, 'Height'), el('input', { type: 'number', value: v.height, oninput: (e) => { v.height = Number(e.target.value); } }),
      ),
      el('label', { class: 'chk' }, el('select', { onchange: (e) => { v.extend = e.target.value; } },
        el('option', { value: 'transparent' }, 'Transparent'), el('option', { value: 'white' }, 'White'),
        el('option', { value: 'black' }, 'Black'), el('option', { value: 'fg' }, 'Foreground'),
        el('option', { value: 'bg' }, 'Background')), 'Canvas extension colour'),
    ),
    grid,
  );
  const rows = [['tl', 'tc', 'tr'], ['ml', 'mc', 'mr'], ['bl', 'bc', 'br']];
  const built = {};
  for (const row of rows) {
    const r = el('div', { class: 'row' });
    for (const id of row) { const b = mk(id); built[id] = b; r.append(b); }
    grid.append(r);
  }
  built.mc.classList.add('toggled');
  const { close } = modal({
    title: 'Canvas Size', body,
    footer: [el('span', { class: 'grow' }),
      el('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
      el('button', {
        class: 'btn primary', onclick: () => {
          close();
          const nw = Math.max(1, Math.round(v.width)), nh = Math.max(1, Math.round(v.height));
          const dx = { l: 0, c: (nw - doc.width) / 2, r: nw - doc.width }[v.anchor[1] === 'l' ? 'l' : v.anchor[1] === 'r' ? 'r' : 'c'];
          const dy = { t: 0, c: (nh - doc.height) / 2, b: nh - doc.height }[v.anchor[0] === 't' ? 't' : v.anchor[0] === 'b' ? 'b' : 'c'];
          for (const L of doc.flat()) { if (L.canvas) { L.x = Math.round(L.x + dx); L.y = Math.round(L.y + dy); } }
          doc.resize(nw, nh);
          app.compCanvas = makeCanvas(nw, nh);
          app.push('Canvas Size');
          app.fitToScreen();
        },
      }, 'OK')],
  });
  void anchors;
}

export function rotateCanvasDialog(app) {
  const doc = app.doc;
  const v = { angle: 90 };
  const body = el('div', { class: 'col' },
    el('div', { class: 'row' }, el('span', {}, 'Angle'), el('input', { type: 'number', value: 90, oninput: (e) => { v.angle = Number(e.target.value); } })),
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: () => { v.angle = 90; doIt(); } }, '90° CW'),
      el('button', { class: 'btn', onclick: () => { v.angle = -90; doIt(); } }, '90° CCW'),
      el('button', { class: 'btn', onclick: () => { v.angle = 180; doIt(); } }, '180°'),
      el('button', { class: 'btn', onclick: () => { doArb(); } }, 'Arbitrary…')));
  const doIt = () => {
    const n = ((Math.round(v.angle / 90) % 4) + 4) % 4;
    const w = n % 2 ? doc.height : doc.width, h = n % 2 ? doc.width : doc.height;
    for (const L of doc.flat()) {
      if (L.canvas) L.canvas = rotate90(L.canvas, n);
      if (L.mask) L.mask = rotate90(L.mask, n);
    }
    doc.resize(w, h);
    app.compCanvas = makeCanvas(w, h);
    app.push('Rotate Canvas');
    app.fitToScreen();
    close();
  };
  const doArb = () => {
    const a = Number(prompt('Angle in degrees:', String(v.angle)));
    if (!a) return;
    for (const L of doc.flat()) if (L.canvas) L.canvas = rotateArbitrary(L.canvas, a, true);
    const first = doc.flat().find((l) => l.canvas);
    if (first) doc.resize(first.canvas.width, first.canvas.height);
    app.push('Rotate Canvas');
    app.fitToScreen();
    close();
  };
  const { close } = modal({ title: 'Rotate Canvas', body, footer: [el('span', { class: 'grow' }), el('button', { class: 'btn', onclick: () => close() }, 'Close')] });
}

export function flipCanvasDialog(app) {
  const doc = app.doc;
  const body = el('div', { class: 'row' },
    el('button', { class: 'btn', onclick: () => { for (const L of doc.flat()) { if (L.canvas) L.canvas = flip(L.canvas, 'h'); if (L.mask) L.mask = flip(L.mask, 'h'); } app.push('Flip Horizontal'); close(); } }, 'Flip Horizontal'),
    el('button', { class: 'btn', onclick: () => { for (const L of doc.flat()) { if (L.canvas) L.canvas = flip(L.canvas, 'v'); if (L.mask) L.mask = flip(L.mask, 'v'); } app.push('Flip Vertical'); close(); } }, 'Flip Vertical'));
  const { close } = modal({ title: 'Flip Canvas', body });
}

export function preferencesDialog(app) {
  const p = app.prefs || (app.prefs = { units: 'px', gridSize: 32, historyStates: 60, checkerboard: true, antialiasedSelection: true });
  const body = el('div', { class: 'col' },
    el('div', { class: 'grid2' },
      el('span', {}, 'Units'), el('select', { onchange: (e) => { p.units = e.target.value; } },
        el('option', { value: 'px' }, 'Pixels'), el('option', { value: 'mm' }, 'Millimetres'), el('option', { value: 'in' }, 'Inches')),
      el('span', {}, 'Grid size'), el('input', { type: 'number', value: p.gridSize, oninput: (e) => { p.gridSize = Number(e.target.value); } }),
      el('span', {}, 'History states'), el('input', { type: 'number', value: p.historyStates, oninput: (e) => { p.historyStates = Number(e.target.value); } }),
    ),
    el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: p.checkerboard, onchange: (e) => { p.checkerboard = e.target.checked; } }), 'Checkerboard transparency'),
  );
  const { close } = modal({
    title: 'Preferences', body,
    footer: [el('span', { class: 'grow' }), el('button', { class: 'btn primary', onclick: () => { app.gridSize = p.gridSize; close(); } }, 'OK')],
  });
}

export function aboutDialog() {
  modal({
    title: `About ${BRAND.name}`,
    body: el('div', { class: 'col', style: { minWidth: '360px' } },
      el('h3', { style: { margin: '0 0 4px' } }, BRAND.name),
      el('div', { class: 'hint' }, `${BRAND.tagline} — version ${BRAND.version}`),
      el('p', {}, 'An independent image editor. Built from scratch: original source, original interface, ' +
        'original icons. Not affiliated with, endorsed by, or derived from any other image editing product.'),
      el('p', { class: 'hint' }, 'Early prototype; feature parity is not claimed. Legal rules vary by jurisdiction.'),
    ),
    footer: [el('span', { class: 'grow' }), el('button', { class: 'btn primary', onclick: () => document.querySelector('.modal-back')?.remove() }, 'OK')],
  });
}

export function exportDialog(app) {
  const doc = app.doc;
  const v = { format: 'png', quality: 90, scale: 1 };
  const body = el('div', { class: 'col' },
    el('div', { class: 'grid2' },
      el('span', {}, 'Format'), el('select', { onchange: (e) => { v.format = e.target.value; } },
        el('option', { value: 'png' }, 'PNG'), el('option', { value: 'jpg' }, 'JPEG'),
        el('option', { value: 'webp' }, 'WebP'), el('option', { value: 'bmp' }, 'BMP')),
      el('span', {}, 'Quality'), el('input', { type: 'range', min: 1, max: 100, value: 90, oninput: (e) => { v.quality = Number(e.target.value); } }),
      el('span', {}, 'Scale'), el('input', { type: 'number', value: 1, step: 0.1, min: 0.05, oninput: (e) => { v.scale = Number(e.target.value); } }),
    ),
    el('div', { class: 'hint' }, `${Math.round(doc.width * v.scale)} × ${Math.round(doc.height * v.scale)} px output`),
  );
  const { close } = modal({
    title: 'Export', body,
    footer: [el('span', { class: 'grow' }),
      el('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: async () => { close(); await app.actions.exportAs(v); } }, 'Export')],
  });
}

export { toast, busy, clamp };
