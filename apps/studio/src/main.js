// Entry point: wire the document model, the tools, and the UI together.

import { el, qs, makeCanvas, toast, busy } from './core/util.js';
import { Doc, Layer } from './core/model.js';
import { App } from './app.js';
import { createActions } from './actions.js';
import { buildPanels, refreshPanels } from './ui/panels.js';
import { buildMenubar, buildToolPanel, buildOptionsBar, buildStatusBar } from './ui/shell.js';
import { installShortcuts } from './ui/shortcuts.js';
import { BRAND } from './brand.js';

const app = new App(qs('#app'));

function pickColor(which) {
  const inp = el('input', { type: 'color' });
  inp.value = '#' + (which === 'fg' ? rgbHex(app.fg) : rgbHex(app.bg));
  inp.oninput = () => {
    const n = parseInt(inp.value.slice(1), 16);
    const c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    which === 'fg' ? app.setForeground(c) : app.setBackground(c);
  };
  inp.click();
}
const rgbHex = (c) => c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

function boot() {
  app.mount();
  const actions = createActions(app);
  app.actions = actions;
  app.openFile = actions.openFile;
  if (window.chroma?.onOpenFile) window.chroma.onOpenFile(async (filePath) => {
    try {
      const base64 = await window.chroma.readFile(filePath);
      const binary = atob(base64);
      const data = Uint8Array.from(binary, c => c.charCodeAt(0));
      const name = filePath.split(/[\\/]/).pop();
      await actions.openFile(new File([data], name));
    } catch (e) { console.error(e); toast('Could not open file: ' + e.message); }
  });
  actions.colorPickerFG = () => pickColor('fg');
  actions.colorPickerBG = () => pickColor('bg');

  buildToolPanel(app);
  buildOptionsBar(app);
  buildStatusBar(app);
  buildPanels(app, qs('#rightdock'));
  buildMenubar(app, actions);
  installShortcuts(app, actions);

  app.emitter.on('panels', () => refreshPanels(app));

  // a fresh blank document
  const w = 1280, h = 900;
  const doc = new Doc(w, h, { name: 'Untitled-1', background: 'white' });
  const bg = new Layer({ name: 'Background', canvas: makeCanvas(w, h) });
  const bc = bg.canvas.getContext('2d');
  bc.fillStyle = '#ffffff';
  bc.fillRect(0, 0, w, h);
  doc.addLayer(bg);
  app.setDoc(doc, 'New');

  document.title = `${BRAND.name} — image editor`;
  window.app = app;
  toast(`${BRAND.name} ready — press B for the brush, or drop an image in`);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

export { app, el, busy };
