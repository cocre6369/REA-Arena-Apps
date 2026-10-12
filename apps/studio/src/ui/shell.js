// Menubar, tool panel, options bar and status bar.

import { el, qs, qsa, clamp, fmtNum } from '../core/util.js';
import { rgb2css, rgb2hex } from '../core/color.js';
import { TOOLS } from '../tools/index.js';
import '../tools/paint.js';
import { BRAND } from '../brand.js';

// ------------------------------------------------------------------ menubar
export function buildMenubar(app, actions) {
  const bar = qs('#menubar');
  bar.innerHTML = '';
  const title = el('div', { class: 'brand' }, el('span', { class: 'brand-mark' }, '◐'), BRAND.name);
  bar.append(title);

  const closeAll = () => qsa('.menu.open').forEach((m) => m.classList.remove('open'));

  for (const entry of actions.MENU) {
    const [label, items] = entry;
    const menu = el('div', { class: 'menu' });
    const btn = el('button', { class: 'menu-btn' }, label);
    menu.append(btn);

    const buildSub = (list) => {
      const sub = el('div', { class: 'submenu' });
      for (const it of list) {
        if (it === 'sep') { sub.append(el('div', { class: 'sep' })); continue; }
        if (Array.isArray(it[1])) {
          const item = el('div', { class: 'menu-item has-sub' }, el('span', {}, it[0]), el('span', { class: 'arrow' }, '▸'));
          const nested = buildSub(it[1]);
          item.append(nested);
          item.addEventListener('mouseenter', () => nested.classList.add('open'));
          item.addEventListener('mouseleave', () => nested.classList.remove('open'));
          sub.append(item);
          continue;
        }
        const a = actions[it[0]];
        if (!a) continue;
        sub.append(el('button', {
          class: 'menu-item',
          onclick: () => { closeAll(); safe(app, a); },
        }, el('span', { class: 'grow' }, a.label), el('span', { class: 'key' }, a.key || '')));
      }
      return sub;
    };

    menu.append(buildSub(items));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.classList.contains('open');
      closeAll();
      if (!open) menu.classList.add('open');
    });
    btn.addEventListener('mouseenter', () => {
      if (qsa('.menu.open').length) { closeAll(); menu.classList.add('open'); }
    });
    bar.append(menu);
  }
  document.addEventListener('click', closeAll);

  const right = el('div', { class: 'menu-right' },
    el('button', { class: 'btn small', onclick: () => actions['file.save'].run() }, 'Save'),
    el('button', { class: 'btn small', onclick: () => actions['file.exportPSD'].run() }, 'PSD'),
    el('button', { class: 'btn small primary', onclick: () => actions['file.export'].run() }, 'Export'));
  bar.append(right);
}

function safe(app, a) {
  try { Promise.resolve(a.run(app)).catch(e => { console.error(e); app.status(a.label + ' failed: ' + e.message); }); }
  catch (e) { console.error(e); app.status(a.label + ' failed: ' + e.message); }
}
export { safe as runAction };

// ------------------------------------------------------------------ tool panel
const GROUP_ORDER = ['move', 'select', 'crop', 'measure', 'retouch', 'paint', 'heal', 'fill', 'shape', 'type', 'pen', 'view'];
const GROUP_LABEL = {
  move: 'Move', select: 'Select', crop: 'Crop & Slice', measure: 'Measure',
  retouch: 'Retouch', paint: 'Paint', heal: 'Heal', fill: 'Fill',
  shape: 'Shape', type: 'Type', pen: 'Pen & Paths', view: 'View',
};

export function buildToolPanel(app) {
  const box = qs('#toolpanel');
  box.innerHTML = '';
  const groups = new Map();
  for (const t of TOOLS) {
    const g = t.group || 'paint';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  const order = [...GROUP_ORDER.filter((g) => groups.has(g)), ...[...groups.keys()].filter((g) => !GROUP_ORDER.includes(g))];
  const buttons = new Map();
  let currentGroup = null;
  for (const g of order) {
    const row = el('div', { class: 'tool-row' });
    for (const t of groups.get(g)) {
      const b = el('button', {
        class: 'tool', title: `${t.name}${t.key ? ' (' + t.key + ')' : ''}`,
        onclick: () => {
          if (t.flyout) { currentGroup = t; return; }
          app.setActiveTool(t.id);
        },
      });
      b.innerHTML = t.icon || '';
      if (!t.flyout) buttons.set(t.id, b);
      row.append(b);
    }
    box.append(row);
  }
  const fgBg = el('div', { class: 'fgbg' });
  const fg = el('div', { class: 'sw-lg' });
  const bg = el('div', { class: 'sw-lg back' });
  fg.onclick = () => app.actions.colorPickerFG();
  bg.onclick = () => app.actions.colorPickerBG();
  const swap = el('button', { class: 'btn tiny', onclick: () => app.swapColors() }, '⇄');
  const def = el('button', { class: 'btn tiny', onclick: () => app.defaultColors() }, '◐');
  fgBg.append(fg, bg, swap, def);
  box.append(fgBg);

  const sync = () => {
    for (const [id, b] of buttons) b.classList.toggle('active', id === app.tool);
    fg.style.background = rgb2css(...app.fg);
    bg.style.background = rgb2css(...app.bg);
  };
  app.emitter.on('toolbar', sync);
  app.emitter.on('color', sync);
  sync();
  void currentGroup;
}

// ------------------------------------------------------------------ options bar
export function buildOptionsBar(app) {
  const bar = qs('#optionsbar');
  const render = () => {
    if (!app.doc) return;
    const t = TOOLS.find((x) => x.id === app.tool);
    bar.innerHTML = '';
    bar.append(el('div', { class: 'opt-tool' }, el('span', { class: 'opt-icon', html: t?.icon || '' }), el('span', {}, t?.name || '')));
    const opts = t?.options || [];
    const o = app.toolOptions[app.tool] || {};
    for (const def of opts) {
      const v = o[def.key];
      const wrap = el('div', { class: 'opt' });
      if (def.type === 'check') {
        const inp = el('input', { type: 'checkbox' });
        inp.checked = !!v;
        inp.onchange = () => app.setToolOption(def.key, inp.checked);
        wrap.append(el('label', { class: 'chk' }, inp, def.label));
      } else if (def.type === 'range') {
        const inp = el('input', { type: 'range', min: def.min ?? 0, max: def.max ?? 100, step: def.step ?? 1, value: v ?? def.def });
        const num = el('input', { type: 'number', value: v ?? def.def, style: { width: '52px' } });
        inp.oninput = () => { num.value = inp.value; app.setToolOption(def.key, Number(inp.value)); };
        num.oninput = () => { inp.value = num.value; app.setToolOption(def.key, Number(num.value)); };
        wrap.append(el('span', { class: 'opt-label' }, def.label), inp, num, def.suffix ? el('span', { class: 'subtle' }, def.suffix) : null);
      } else if (def.type === 'select') {
        const sel = el('select', {}, ...def.options.map(([val, lab]) => el('option', { value: val, selected: String(val) === String(v ?? def.def) }, lab)));
        sel.onchange = () => app.setToolOption(def.key, sel.value);
        wrap.append(el('span', { class: 'opt-label' }, def.label), sel);
      } else if (def.type === 'color') {
        const inp = el('input', { type: 'color', value: rgb2hex(...(v || [0, 0, 0])) });
        inp.oninput = () => app.setToolOption(def.key, hex2rgbArr(inp.value));
        wrap.append(el('span', { class: 'opt-label' }, def.label), inp);
      } else if (def.type === 'number') {
        const inp = el('input', { type: 'number', value: v ?? def.def, style: { width: '58px' } });
        inp.oninput = () => app.setToolOption(def.key, Number(inp.value));
        wrap.append(el('span', { class: 'opt-label' }, def.label), inp);
      } else if (def.type === 'button') {
        wrap.append(el('button', { class: 'btn small', onclick: () => app.setToolOption(def.key, true) }, def.label));
      }
      bar.append(wrap);
    }
    if (app.transform) {
      bar.append(el('div', { class: 'opt' },
        el('button', { class: 'btn small primary', onclick: () => app.commitFreeTransform() }, '✓ Commit transform'),
        el('button', { class: 'btn small', onclick: () => app.cancelTransform() }, '✕ Cancel')));
    }
    bar.append(el('span', { class: 'grow' }));
    bar.append(el('div', { class: 'opt' },
      el('button', { class: 'btn small', onclick: () => app.actions['edit.preferences'].run() }, 'Preferences')));
  };
  app.emitter.on('toolbar', render);
  app.emitter.on('doc', render);
  render();
}

function hex2rgbArr(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ------------------------------------------------------------------ status bar
export function buildStatusBar(app) {
  const bar = qs('#statusbar');
  const render = () => {
    if (!app.doc) return;
    const doc = app.doc;
    const L = doc.activeLayer;
    const sel = doc.selection;
    const cov = sel.has ? sel.coverage() : 0;
    bar.innerHTML = '';
    bar.append(el('span', { class: 'st' }, `${Math.round(app.view.zoom * 100)}%`));
    bar.append(el('span', { class: 'st' }, `${fmtNum(doc.width)} × ${fmtNum(doc.height)} px`));
    bar.append(el('span', { class: 'st' }, `${doc.flat().length} layer${doc.flat().length === 1 ? '' : 's'}${L ? ' · ' + L.name : ''}`));
    if (sel.has) bar.append(el('span', { class: 'st' }, `selection ${(cov * 100).toFixed(1)}%`));
    bar.append(el('span', { class: 'grow' }));
    bar.append(el('span', { class: 'st subtle' }, app._status || ''));
  };
  app.emitter.on('status', render);
  app.emitter.on('doc', render);
  app.emitter.on('panels', render);
  render();
}

export { clamp, qs, qsa };
