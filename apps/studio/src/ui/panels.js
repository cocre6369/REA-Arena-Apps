// Right-hand dock panels: layers, channels, paths, adjustments, history,
// navigator, histogram, colour, swatches, info, properties.

import { el, qs, makeCanvas, clamp, debounce } from '../core/util.js';
import { BLEND_MODES, blendName, rgb2hex, hex2rgb, rgb2css, rgbToHsl, hslToRgb, rgbToHsv, hsvToRgb } from '../core/color.js';
import { layerThumb, maskThumb, renderDoc } from '../engine/composite.js';
import { histogram } from '../engine/adjust.js';
import { Layer } from '../core/model.js';
import { adjustDialog } from './modal.js';
import { BRAND } from '../brand.js';

export const PANEL_DEFS = [
  ['navigator', 'Navigator', true],
  ['histogram', 'Histogram', false],
  ['info', 'Info', false],
  ['adjustments', 'Adjustments', true],
  ['layers', 'Layers', true],
  ['channels', 'Channels', false],
  ['paths', 'Paths', false],
  ['history', 'History', false],
  ['color', 'Colour', true],
  ['swatches', 'Swatches', false],
];

export function buildPanels(app, dock) {
  const panels = {};
  dock.innerHTML = '';
  for (const [id, title, open] of PANEL_DEFS) {
    const body = el('div', { class: 'panel-body' });
    const head = el('div', { class: 'panel-head' },
      el('span', { class: 'caret' }, '▼'), title, el('span', { class: 'sp' }));
    const panel = el('div', { class: 'panel' + (open ? '' : ' collapsed') }, head, body);
    head.onclick = (e) => {
      if (e.target.closest('button')) return;
      panel.classList.toggle('collapsed');
    };
    dock.append(panel);
    panels[id] = { body, panel, refresh: () => RENDERERS[id]?.(app, body) };
  }
  app.panels = panels;
  return panels;
}

export function refreshPanels(app) {
  if (!app.panels) return;
  for (const id of Object.keys(app.panels)) {
    const p = app.panels[id];
    if (p.panel.classList.contains('collapsed')) continue;
    p.refresh();
  }
}

// ------------------------------------------------------------------ layers
function layersPanel(app, box) {
  const doc = app.doc;
  if (!doc) return;
  box.innerHTML = '';
  const bar = el('div', { class: 'row wrap', style: { marginBottom: '6px' } },
    el('button', { class: 'btn small', onclick: () => app.actions.layerNew() }, '+ Layer'),
    el('button', { class: 'btn small', onclick: () => app.actions.layerNewAdjustment() }, 'Adj'),
    el('button', { class: 'btn small', onclick: () => app.actions.layerGroup() }, 'Group'),
    el('button', { class: 'btn small', onclick: () => app.actions.addMask('reveal') }, 'Mask'),
    el('button', { class: 'btn small', onclick: () => app.actions.layerDuplicate() }, 'Dup'),
    el('button', { class: 'btn small', onclick: () => app.actions.layerDelete() }, 'Del'),
  );
  const blendBar = el('div', { class: 'layer-blendbar' });
  const L = doc.activeLayer;
  if (L) {
    const sel = el('select', { onchange: (e) => { L.blend = e.target.value; app.update({ render: true, panels: true }); app.push('Blend Mode'); } },
      ...BLEND_MODES.map(([id, name]) => el('option', { value: id, selected: id === L.blend }, name)));
    const op = el('input', { type: 'number', min: 0, max: 100, value: Math.round(L.opacity * 100), style: { width: '54px' },
      oninput: (e) => { L.opacity = clamp(Number(e.target.value) / 100, 0, 1); app.update({ render: true }); } });
    blendBar.append(sel, el('span', { class: 'subtle' }, 'Opacity'), op);
    if (L.mask) blendBar.append(el('span', { class: 'subtle' }, app.maskEditingLayerId === L.id ? 'Mask selected' : 'Pixels selected'));
  }
  box.append(bar, blendBar);
  if (L?.mask) box.append(el('div', { class: 'row wrap', style: { margin: '5px 0' } },
    el('button', { class: 'btn small', onclick: () => app.editMask() }, app.maskEditingLayerId === L.id ? 'Edit pixels' : 'Edit mask'),
    el('button', { class: 'btn small', onclick: () => app.maskToSelection() }, 'To selection'),
    el('button', { class: 'btn small', onclick: () => app.invertMask() }, 'Invert mask'),
    el('button', { class: 'btn small', onclick: () => app.deleteMask(true) }, 'Apply mask')));

  const list = el('div', { class: 'layer-list' });
  const renderRow = (layer, depth) => {
    const row = el('div', {
      class: 'layer-row' + (layer.id === doc.activeLayerId ? ' sel' : ''),
      style: { paddingLeft: 4 + depth * 10 + 'px' },
      draggable: true,
    });
    const thumb = el('div', { class: 'layer-thumb' });
    thumb.style.backgroundImage = `url(${layerThumb(doc, layer, 26).toDataURL()})`;
    if (layer.isGroup) thumb.style.outline = '1px solid #4c8dff';

    const vis = el('button', { class: 'layer-vis', onclick: (e) => { e.stopPropagation(); layer.visible = !layer.visible; app.update({ render: true, panels: true }); app.push('Toggle Visibility'); } },
      layer.visible ? '◉' : '○');
    const name = el('div', { class: 'layer-name' }, layer.name);
    name.ondblclick = (e) => {
      e.stopPropagation();
      const inp = el('input', { type: 'text', value: layer.name });
      name.innerHTML = ''; name.append(inp); inp.focus(); inp.select();
      const done = () => { layer.name = inp.value || layer.name; app.update({ panels: true }); app.push('Rename Layer'); };
      inp.onblur = done;
      inp.onkeydown = (ev) => { if (ev.key === 'Enter') done(); };
    };
    thumb.title = 'Click to edit layer pixels';
    thumb.onclick = (e) => { e.stopPropagation(); doc.activeLayerId = layer.id; app.maskEditingLayerId = null; app.update({ panels: true }); };
    row.append(thumb, vis, name);
    if (layer.hasMask) {
      const mt = el('div', { class: 'layer-mask' });
      mt.style.backgroundImage = `url(${maskThumb(layer.mask, 22).toDataURL()})`;
      if (app.maskEditingLayerId === layer.id) mt.classList.add('editing');
      if (!layer.maskEnabled) mt.classList.add('disabled');
      mt.onclick = (e) => {
        e.stopPropagation(); doc.activeLayerId = layer.id;
        if (e.altKey) { layer.maskEnabled = !layer.maskEnabled; app.push('Toggle Layer Mask'); }
        else { app.maskEditingLayerId = layer.id; app.channelPreview = null; app.setActiveTool('brush'); app.update({ panels: true, status: true }); }
      };
      mt.title = 'Click to edit mask (Brush reveals, Eraser hides). Alt-click to enable/disable';
      row.append(mt);
    }
    if (layer.type !== 'raster') row.append(el('span', { class: 'kind' }, layer.type[0].toUpperCase()));
    if (layer.clipped) row.append(el('span', { class: 'kind' }, '⤵'));

    row.onclick = () => { doc.activeLayerId = layer.id; app.maskEditingLayerId = null; app.update({ panels: true }); };
    row.ondragstart = (e) => { e.dataTransfer.setData('text/plain', layer.id); app._dragLayer = layer.id; };
    row.ondragover = (e) => { e.preventDefault(); row.classList.add('drop-above'); };
    row.ondragleave = () => row.classList.remove('drop-above');
    row.ondrop = (e) => {
      e.preventDefault(); row.classList.remove('drop-above');
      const src = e.dataTransfer.getData('text/plain');
      if (src && src !== layer.id) { doc.moveLayer(src, layer.id, 'above'); app.update({ render: true, panels: true }); app.push('Reorder Layers'); }
    };
    list.append(row);
    if (layer.isGroup && layer.expanded) for (const c of layer.children) renderRow(c, depth + 1);
  };
  for (const l of doc.layers.slice().reverse()) renderRow(l, 0);
  box.append(list);

  box.append(el('div', { class: 'row wrap', style: { marginTop: '6px' } },
    el('button', { class: 'btn small', onclick: () => app.actions.mergeDown() }, 'Merge Down'),
    el('button', { class: 'btn small', onclick: () => app.actions.mergeVisible() }, 'Merge Visible'),
    el('button', { class: 'btn small', onclick: () => app.actions.flatten() }, 'Flatten')));
}

// ------------------------------------------------------------------ channels
function channelsPanel(app, box) {
  const doc = app.doc;
  const comp = renderDoc(doc);
  box.innerHTML = '';
  const mk = (label, canvas, key) => {
    const t = makeCanvas(20, 20);
    t.getContext('2d').drawImage(canvas, 0, 0, 20, 20);
    const row = el('div', { class: 'chan-row' },
      el('span', { class: 'sw', style: { background: `url(${t.toDataURL()}) center/cover` } }),
      el('span', { class: 'grow' }, label));
    row.onclick = () => { app.channelPreview = key; app.update({ render: true }); };
    return row;
  };
  box.append(mk('RGB', comp, 'rgb'));
  const d = comp.getContext('2d').getImageData(0, 0, comp.width, comp.height);
  for (const [i, name] of [[0, 'Red'], [1, 'Green'], [2, 'Blue']]) {
    const c = makeCanvas(comp.width, comp.height);
    const id = c.getContext('2d').createImageData(comp.width, comp.height);
    for (let p = 0; p < id.data.length; p += 4) {
      id.data[p] = id.data[p + 1] = id.data[p + 2] = d.data[p + i];
      id.data[p + 3] = 255;
    }
    c.getContext('2d').putImageData(id, 0, 0);
    box.append(mk(name, c, name.toLowerCase()));
  }
  const L = doc.activeLayer;
  if (L?.mask) box.append(mk('Layer mask', L.mask, 'mask'));
  box.append(el('div', { class: 'row wrap' },
    el('button', { class: 'btn small', onclick: () => app.actions.selectionFromChannel() }, 'Load channel as selection'),
    el('button', { class: 'btn small', onclick: () => { app.channelPreview = null; app.update({ render: true }); } }, 'Show all')));
}

// ------------------------------------------------------------------ paths
function pathsPanel(app, box) {
  const doc = app.doc;
  box.innerHTML = '';
  const list = el('div', { class: 'layer-list' });
  for (const path of doc.paths || []) {
    const row = el('div', { class: 'layer-row' + (path === app.activePath ? ' sel' : '') },
      el('div', { class: 'layer-name' }, `Path (${path.anchors.length} pts)${path.closed ? ' closed' : ''}`));
    row.onclick = () => { app.activePath = path; app.update({ overlay: true, panels: true }); };
    list.append(row);
  }
  if (app.activePath && !(doc.paths || []).includes(app.activePath)) {
    const row = el('div', { class: 'layer-row sel' },
      el('div', { class: 'layer-name' }, `Work path (${app.activePath.anchors.length} pts)`));
    list.append(row);
  }
  box.append(list);
  box.append(el('div', { class: 'row wrap' },
    el('button', { class: 'btn small', onclick: () => app.actions.pathToSelection() }, 'Make selection'),
    el('button', { class: 'btn small', onclick: () => app.actions.strokePath() }, 'Stroke path'),
    el('button', { class: 'btn small', onclick: () => app.actions.fillPath() }, 'Fill path'),
    el('button', { class: 'btn small', onclick: () => { app.activePath = null; app.update({ overlay: true, panels: true }); } }, 'Clear')));
}

// ------------------------------------------------------------------ adjustments
function adjustmentsPanel(app, box) {
  box.innerHTML = '';
  const list = [
    ['brightness', 'Brightness/Contrast'], ['levels', 'Levels'], ['curves', 'Curves'],
    ['exposure', 'Exposure'], ['vibrance', 'Vibrance'], ['hueSat', 'Hue/Saturation'],
    ['colorBalance', 'Color Balance'], ['blackWhite', 'Black & White'], ['photoFilter', 'Photo Filter'],
    ['channelMixer', 'Channel Mixer'], ['selectiveColor', 'Selective Colour'],
    ['temperature', 'Temperature'], ['gradientMap', 'Gradient Map'],
    ['posterize', 'Posterize'], ['threshold', 'Threshold'], ['invert', 'Invert'],
    ['desaturate', 'Desaturate'], ['autoTone', 'Auto Tone'],
  ];
  const grid = el('div', { class: 'preset-row' });
  for (const [id, name] of list) {
    grid.append(el('button', { class: 'btn small', onclick: () => adjustDialog(app, id, { asLayer: true }) }, name));
  }
  box.append(grid);
  const L = app.doc.activeLayer;
  if (L?.type === 'adjustment') {
    box.append(el('div', { class: 'hint', style: { marginTop: '6px' } },
      `Editing: ${L.name} — ${JSON.stringify(L.adjustment?.params || {}).slice(0, 120)}`));
    box.append(el('button', { class: 'btn small', onclick: () => adjustDialog(app, L.adjustment.kind, { asLayer: false }) }, 'Edit properties'));
  }
}

// ------------------------------------------------------------------ history
function historyPanel(app, box) {
  box.innerHTML = '';
  const list = el('div', { class: 'layer-list' });
  const entries = app.history.entries;
  const last = entries.length - 1;
  entries.forEach((e, i) => {
    const row = el('div', { class: 'layer-row hist-row' + (e.state === 'current' ? ' sel' : '') + (e.state === 'future' ? ' future' : '') },
      el('span', { class: 'ic' }, e.state === 'future' ? '↷' : '↶'),
      el('div', { class: 'layer-name' }, `${i}. ${e.label}`));
    row.onclick = () => {
      let guard = 0;
      while (app.history.entries.findIndex((x) => x.state === 'current') > i && guard++ < 200) app.undo();
      guard = 0;
      while (app.history.entries.findIndex((x) => x.state === 'current') < i && guard++ < 200) app.redo();
    };
    list.append(row);
  });
  box.append(list);
  box.append(el('div', { class: 'row wrap' },
    el('button', { class: 'btn small', onclick: () => app.undo() }, 'Undo'),
    el('button', { class: 'btn small', onclick: () => app.redo() }, 'Redo'),
    el('button', { class: 'btn small', onclick: () => { app.history.push('Snapshot', snapshotNow(app)); app.update({ panels: true }); } }, 'Snapshot')));
  void last;
}
function snapshotNow(app) {
  const { snapshotDoc } = app._model;
  return snapshotDoc(app.doc);
}

// ------------------------------------------------------------------ navigator
function navigatorPanel(app, box) {
  box.innerHTML = '';
  const doc = app.doc;
  const w = 240, h = Math.round((240 * doc.height) / doc.width) || 100;
  const c = makeCanvas(Math.min(240, doc.width), Math.round((Math.min(240, doc.width) * doc.height) / doc.width));
  c.className = 'mini';
  const cx = c.getContext('2d');
  cx.drawImage(app.compCanvas && app.compCanvas.width === doc.width ? app.compCanvas : renderDoc(doc), 0, 0, c.width, c.height);
  box.append(c);
  const zIn = el('input', { type: 'range', min: 1, max: 6400, value: Math.round(app.view.zoom * 100) });
  zIn.oninput = () => { app.zoomTo(Number(zIn.value) / 100); };
  box.append(el('div', { class: 'row' }, el('span', { class: 'subtle' }, '1%'), zIn, el('span', { class: 'subtle' }, '6400%')));
  box.append(el('div', { class: 'row wrap' },
    el('button', { class: 'btn small', onclick: () => app.fitToScreen() }, 'Fit'),
    el('button', { class: 'btn small', onclick: () => app.zoomTo(1) }, '100%'),
    el('button', { class: 'btn small', onclick: () => app.zoomTo(app.view.zoom * 2) }, '+'),
    el('button', { class: 'btn small', onclick: () => app.zoomTo(app.view.zoom / 2) }, '−')));
  void w; void h;
}

// ------------------------------------------------------------------ histogram
function histogramPanel(app, box) {
  box.innerHTML = '';
  const c = makeCanvas(256, 96);
  c.className = 'mini';
  const cx = c.getContext('2d');
  const hist = histogram((app.compCanvas && app.compCanvas.width === app.doc.width ? app.compCanvas : renderDoc(app.doc))
    .getContext('2d').getImageData(0, 0, app.doc.width, app.doc.height));
  cx.fillStyle = '#0d0f12'; cx.fillRect(0, 0, 256, 96);
  const max = Math.max(...hist.l, 1);
  for (const [arr, col] of [[hist.r, 'rgba(255,80,80,.6)'], [hist.g, 'rgba(80,255,120,.6)'], [hist.b, 'rgba(90,150,255,.6)']]) {
    cx.strokeStyle = col; cx.beginPath();
    for (let x = 0; x < 256; x++) {
      const y = 96 - (arr[x] / max) * 92;
      x === 0 ? cx.moveTo(x, y) : cx.lineTo(x, y);
    }
    cx.stroke();
  }
  box.append(c);
  const ch = el('select', {}, ...[['l', 'Luminosity'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']].map(([v, l]) => el('option', { value: v }, l)));
  box.append(el('div', { class: 'row' }, el('span', { class: 'opt-label' }, 'Channel'), ch));
}

// ------------------------------------------------------------------ info
function infoPanel(app, box) {
  box.innerHTML = '';
  const p = app.lastPointer || { x: 0, y: 0 };
  const c = app.sampleColor(p.x, p.y, true) || [0, 0, 0];
  const sw = el('div', { style: { width: '100%', height: '28px', background: rgb2css(...c), border: '1px solid #3a414d', borderRadius: '3px' } });
  box.append(sw);
  box.append(el('div', { class: 'grid2' },
    el('span', { class: 'subtle' }, 'X'), el('span', {}, String(Math.round(p.x))),
    el('span', { class: 'subtle' }, 'Y'), el('span', {}, String(Math.round(p.y))),
    el('span', { class: 'subtle' }, 'R'), el('span', {}, String(Math.round(c[0] * 255))),
    el('span', { class: 'subtle' }, 'G'), el('span', {}, String(Math.round(c[1] * 255))),
    el('span', { class: 'subtle' }, 'B'), el('span', {}, String(Math.round(c[2] * 255))),
    el('span', { class: 'subtle' }, 'Hex'), el('span', {}, rgb2hex(...c)),
  ));
  if (app.measure) {
    const m = app.measure;
    const a = Math.atan2(m.y1 - m.y0, m.x1 - m.x0) * 180 / Math.PI;
    box.append(el('div', { class: 'grid2' },
      el('span', { class: 'subtle' }, 'W'), el('span', {}, String(Math.round(m.x1 - m.x0))),
      el('span', { class: 'subtle' }, 'H'), el('span', {}, String(Math.round(m.y1 - m.y0))),
      el('span', { class: 'subtle' }, 'A'), el('span', {}, a.toFixed(1) + '°'),
      el('span', { class: 'subtle' }, 'D'), el('span', {}, Math.round(Math.hypot(m.x1 - m.x0, m.y1 - m.y0)) + ' px')));
  }
}

// ------------------------------------------------------------------ colour
function colorPanel(app, box) {
  box.innerHTML = '';
  const col = app.fg;
  const [h, s, v] = rgbToHsv(...col);
  const state = { h: h, s: s * 100, v: v * 100, r: Math.round(col[0] * 255), g: Math.round(col[1] * 255), b: Math.round(col[2] * 255) };

  const ramp = makeCanvas(240, 90);
  ramp.className = 'color-ramp';
  const rctx = ramp.getContext('2d');
  const hueBar = makeCanvas(240, 14);
  hueBar.className = 'mini';
  const hctx = hueBar.getContext('2d');
  const drawRamp = () => {
    const g1 = rctx.createLinearGradient(0, 0, ramp.width, 0);
    g1.addColorStop(0, '#fff'); g1.addColorStop(1, `hsl(${state.h},100%,50%)`);
    rctx.fillStyle = g1; rctx.fillRect(0, 0, ramp.width, ramp.height);
    const g2 = rctx.createLinearGradient(0, 0, 0, ramp.height);
    g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, '#000');
    rctx.fillStyle = g2; rctx.fillRect(0, 0, ramp.width, ramp.height);
    rctx.strokeStyle = '#fff'; rctx.lineWidth = 2;
    rctx.beginPath();
    rctx.arc((state.s / 100) * ramp.width, (1 - state.v / 100) * ramp.height, 6, 0, Math.PI * 2);
    rctx.stroke();
  };
  const drawHue = () => {
    const g = hctx.createLinearGradient(0, 0, hueBar.width, 0);
    for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
    hctx.fillStyle = g; hctx.fillRect(0, 0, hueBar.width, hueBar.height);
    hctx.strokeStyle = '#fff';
    hctx.beginPath(); hctx.moveTo((state.h / 360) * hueBar.width, 0); hctx.lineTo((state.h / 360) * hueBar.width, hueBar.height); hctx.stroke();
  };
  const commit = () => {
    const c = hsvToRgb(state.h, state.s / 100, state.v / 100);
    app.setForeground([c[0], c[1], c[2]]);
    state.r = Math.round(c[0] * 255); state.g = Math.round(c[1] * 255); state.b = Math.round(c[2] * 255);
    rIn.value = state.r; gIn.value = state.g; bIn.value = state.b;
    hexIn.value = rgb2hex(...c);
    drawRamp();
  };
  const pick = (e) => {
    const r = ramp.getBoundingClientRect();
    state.s = clamp((e.clientX - r.left) / r.width, 0, 1) * 100;
    state.v = (1 - clamp((e.clientY - r.top) / r.height, 0, 1)) * 100;
    commit();
  };
  ramp.addEventListener('pointerdown', (e) => { ramp.setPointerCapture(e.pointerId); pick(e); });
  ramp.addEventListener('pointermove', (e) => { if (e.buttons) pick(e); });
  hueBar.addEventListener('pointerdown', (e) => {
    const r = hueBar.getBoundingClientRect();
    state.h = clamp((e.clientX - r.left) / r.width, 0, 1) * 360;
    drawHue(); commit();
  });

  const hexIn = el('input', { type: 'text', value: rgb2hex(...col), style: { width: '84px' } });
  hexIn.oninput = () => { const c = hex2rgb(hexIn.value); const [hh, ss, vv] = rgbToHsv(...c); state.h = hh; state.s = ss * 100; state.v = vv * 100; drawHue(); commit(); };
  const mkNum = (key, label) => {
    const i = el('input', { type: 'number', min: 0, max: 255, value: state[key], style: { width: '56px' } });
    i.oninput = () => {
      state[key] = Number(i.value);
      const c = [state.r / 255, state.g / 255, state.b / 255];
      const [hh, ss, vv] = rgbToHsv(...c);
      state.h = hh; state.s = ss * 100; state.v = vv * 100;
      drawHue(); commit();
    };
    return el('div', { class: 'row' }, el('span', { class: 'opt-label', style: { width: '14px' } }, label), i);
  };
  const rIn = mkNum('r', 'R').querySelector('input');
  const gIn = mkNum('g', 'G').querySelector('input');
  const bIn = mkNum('b', 'B').querySelector('input');

  const preview = el('div', { style: { display: 'flex', height: '34px', border: '1px solid #3a414d', borderRadius: '3px', overflow: 'hidden' } },
    el('div', { style: { flex: 1, background: rgb2css(...app.fg) }, onclick: () => { app.actions.colorPickerFG(); } }),
    el('div', { style: { flex: 1, background: rgb2css(...app.bg) }, onclick: () => { app.actions.colorPickerBG(); } }));

  box.append(preview, ramp, hueBar,
    el('div', { class: 'row' }, el('span', { class: 'opt-label' }, 'Hex'), hexIn),
    el('div', { class: 'row wrap' }, rIn.parentElement, gIn.parentElement, bIn.parentElement),
    el('div', { class: 'row wrap' },
      el('button', { class: 'btn small', onclick: () => app.swapColors() }, 'Swap'),
      el('button', { class: 'btn small', onclick: () => app.defaultColors() }, 'Default')));
  drawRamp(); drawHue();
}

// ------------------------------------------------------------------ swatches
function swatchesPanel(app, box) {
  box.innerHTML = '';
  const cols = ['#000000', '#ffffff', '#c0c0c0', '#808080', '#404040', '#ff0000', '#800000', '#ffff00',
    '#808000', '#00ff00', '#008000', '#00ffff', '#008080', '#0000ff', '#000080', '#ff00ff',
    '#800080', '#ff8040', '#804000', '#4080ff', '#40ff80', '#ff4080', '#80ff40', '#4080ff',
    '#f5deb3', '#deb887', '#a0522d', '#8b4513', '#2f4f4f', '#708090', '#778899', '#b0c4de',
    '#ffe4e1', '#fffacd', '#e6e6fa', '#d3d3d3', '#d2691e', '#cd5c5c', '#6495ed', '#3cb371'];
  const grid = el('div', { class: 'swatch-grid' });
  for (const hex of cols) {
    grid.append(el('button', {
      style: { background: hex }, title: hex,
      onclick: () => app.setForeground(hex2rgb(hex)),
      oncontextmenu: (e) => { e.preventDefault(); app.setBackground(hex2rgb(hex)); },
    }));
  }
  box.append(grid);
  box.append(el('div', { class: 'row wrap' },
    el('button', { class: 'btn small', onclick: () => { app.setForeground(app.sampleColor(app.lastPointer?.x || 0, app.lastPointer?.y || 0, true) || app.fg); } }, 'Sample cursor')));
}

const RENDERERS = {
  layers: layersPanel, channels: channelsPanel, paths: pathsPanel,
  adjustments: adjustmentsPanel, history: historyPanel, navigator: navigatorPanel,
  histogram: histogramPanel, info: infoPanel, color: colorPanel, swatches: swatchesPanel,
};

export { RENDERERS };
export const refresh = debounce(refreshPanels, 30);
export { BRAND, Layer, qs };
