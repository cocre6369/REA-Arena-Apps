// Keyboard shortcuts: action accelerators + single-key tool selection.

import { TOOLS } from '../tools/index.js';
import { runAction as safeRun } from './shell.js';

const norm = (e) => {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  else if (k === 'Escape') k = 'Esc';
  else if (k === 'Delete') k = 'Del';
  parts.push(k);
  return parts.join('+');
};

export function installShortcuts(app, actions) {
  const map = new Map();
  for (const a of Object.values(actions)) {
    if (!a || typeof a !== 'object' || !a.key) continue;
    map.set(a.key.replace(/\s/g, ''), a);
  }
  const toolByKey = new Map();
  for (const t of TOOLS) {
    if (!t.key) continue;
    if (!toolByKey.has(t.key)) toolByKey.set(t.key, []);
    toolByKey.get(t.key).push(t.id);
  }
  const cycle = new Map();

  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

    if (e.key === 'Enter' && app.transform) { app.commitFreeTransform(); e.preventDefault(); return; }
    if (e.key === 'Escape') {
      if (app.transform) { app.cancelTransform(); e.preventDefault(); return; }
      if (document.querySelector('.modal-back')) return;
    }
    if (typing) return;

    const k = norm(e);
    const act = map.get(k);
    if (act) { e.preventDefault(); safeRun(app, act); return; }

    // bracket shortcuts for brush size
    if (k === '[' || k === ']') {
      const o = app.toolOptions[app.tool] || {};
      if (typeof o.size === 'number') {
        o.size = Math.max(1, Math.round(o.size * (k === '[' ? 0.8 : 1.25)));
        app.emitter.emit('toolbar');
        app.update({ overlay: true });
        e.preventDefault();
      }
      return;
    }
    // space = temporary hand tool
    if (k === 'Space') {
      if (!app._spacePan) { app._spacePan = app.tool; app.setActiveTool('hand'); }
      e.preventDefault();
      return;
    }
    // single-key tool switching
    const ids = toolByKey.get(e.key.toUpperCase());
    if (ids && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const i = (cycle.get(e.key.toUpperCase()) ?? -1) + 1;
      cycle.set(e.key.toUpperCase(), i);
      app.setActiveTool(ids[i % ids.length]);
      e.preventDefault();
      return;
    }
    if (e.key === 'x' || e.key === 'X') { app.swapColors(); return; }
    if (e.key === 'd' || e.key === 'D') { app.defaultColors(); return; }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === ' ' && app._spacePan) { app.setActiveTool(app._spacePan); app._spacePan = null; }
  });
}

export { norm };
