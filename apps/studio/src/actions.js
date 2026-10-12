// Every command in the app. Menus, shortcuts and panels all dispatch here.

import { el, makeCanvas, copyCanvas, toast, busy, downloadBlob, pickFiles, qs } from './core/util.js';
import { Layer, Doc, Selection, snapshotDoc } from './core/model.js';
import { BLEND_MODES } from './core/color.js';
import { renderDoc, mergeLayers } from './engine/composite.js';
import { applyAdjustment, ADJUSTMENTS } from './engine/adjust.js';
import { FILTERS, getFilter } from './engine/filters.js';
import './engine/filters-art.js';
import { resample, rotate90, flip, rotateArbitrary } from './engine/transform.js';
import { gradientFill, patternCanvas, shapePath, snapshotCanvas } from './engine/draw.js';
import { ADJ_BY_ID, adjDefault } from './engine/adjust.js';
import {
  newDocumentDialog, imageSizeDialog, canvasSizeDialog, rotateCanvasDialog,
  flipCanvasDialog, preferencesDialog, aboutDialog, exportDialog, filterDialog,
  filterGallery, adjustDialog, modal, field,
} from './ui/modal.js';
import { canvasFromFile, exportCanvas, saveProject, loadProject, serializeProject, exportForWeb } from './io/formats.js';
import { downloadPSD } from './io/psd.js';
import { parsePSD } from './io/psd.js';
import { BRAND } from './brand.js';

export function createActions(app) {
  const A = {};
  const def = (id, label, key, run, enabled) => { A[id] = { id, label, key, run, enabled }; };

  const doc = () => app.doc;
  const need = () => !!app.doc;

  // ---------------------------------------------------------------- File
  def('file.new', 'New…', 'Ctrl+N', () => newDocumentDialog(app, (v) => {
    const d = new Doc(v.width, v.height, { name: v.name, dpi: v.dpi, background: v.background });
    const bg = new Layer({ name: 'Background', canvas: makeCanvas(v.width, v.height) });
    if (v.background === 'white') { const cx = bg.canvas.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, v.width, v.height); }
    if (v.background === 'black') { const cx = bg.canvas.getContext('2d'); cx.fillStyle = '#000'; cx.fillRect(0, 0, v.width, v.height); }
    d.addLayer(bg);
    app.setDoc(d, 'New Document');
  }));
  def('file.open', 'Open…', 'Ctrl+O', async () => {
    const files = await pickFiles('image/*,application/octet-stream,.psd,.csp', false);
    if (files?.[0]) await app.actions.openFile(files[0]);
  });
  A.openFile = async (file) => {
    busy(true, 'Opening…');
    try {
      const name = file.name.toLowerCase();
      if (name.endsWith('.psd')) {
        const buf = await file.arrayBuffer();
        const psd = parsePSD(buf);
        const d = new Doc(psd.width, psd.height, { name: file.name.replace(/\.psd$/i, '') });
        for (const L of psd.layers) {
          const l = new Layer({ name: L.name, opacity: L.opacity, blend: L.blend, visible: L.visible, clipped: L.clipped });
          const c = makeCanvas(psd.width, psd.height);
          c.getContext('2d').drawImage(L.canvas, L.left || 0, L.top || 0);
          l.canvas = c;
          if (L.mask) { const m = makeCanvas(psd.width, psd.height); m.getContext('2d').drawImage(L.mask, L.left || 0, L.top || 0); l.mask = m; }
          d.addLayer(l);
        }
        if (!d.layers.length) {
          const l = new Layer({ name: 'Background', canvas: psd.composite || makeCanvas(psd.width, psd.height) });
          d.addLayer(l);
        }
        app.setDoc(d, 'Open');
        toast('PSD imported');
      } else if (name.endsWith('.csp')) {
        const d = await loadProject(file);
        app.setDoc(d, 'Open');
      } else {
        const c = await canvasFromFile(file);
        const d = new Doc(c.width, c.height, { name: file.name.replace(/\.[^.]+$/, '') });
        d.addLayer(new Layer({ name: 'Background', canvas: c }));
        app.setDoc(d, 'Open');
      }
    } catch (e) {
      toast('Could not open: ' + e.message);
      console.error(e);
    } finally { busy(false); }
  };
  def('file.place', 'Place Image as Layer…', 'Ctrl+Alt+O', async () => {
    if (!need()) return;
    const files = await pickFiles('image/*', false);
    if (!files?.[0]) return;
    try {
      const c = await canvasFromFile(files[0]);
      const L = new Layer({ name: doc().uniqueName(files[0].name.replace(/\.[^.]+$/, '')), canvas: c,
        x: Math.round((doc().width - c.width) / 2), y: Math.round((doc().height - c.height) / 2) });
      doc().addLayer(L, { above: doc().activeLayerId });
      app.push('Place Image');
    } catch (e) { toast('Could not place image: ' + e.message); }
  });
  def('file.save', 'Save (native project)', 'Ctrl+S', async () => {
    if (!need()) return;
    await saveProject(doc(), (doc().name || 'untitled') + '.' + BRAND.fileExt);
    toast('Project saved');
  });
  def('file.export', 'Export…', 'Ctrl+Shift+E', () => need() && exportDialog(app));
  A.exportAs = async (v) => {
    const c = renderDoc(doc());
    await exportForWeb(c, { format: v.format, quality: v.quality, scale: v.scale, filename: doc().name || 'image' });
    toast('Exported');
  };
  def('file.exportPSD', 'Export as PSD…', '', () => {
    if (!need()) return;
    downloadPSD(doc(), renderDoc(doc()), (doc().name || 'image') + '.psd');
    toast('PSD exported');
  });
  def('file.close', 'Close', 'Ctrl+W', () => { app.setDoc(new Doc(800, 600, { name: 'Untitled' }), 'New'); });

  // ---------------------------------------------------------------- Edit
  def('edit.undo', 'Undo', 'Ctrl+Z', () => need() && app.undo());
  def('edit.redo', 'Redo', 'Ctrl+Shift+Z', () => need() && app.redo());
  def('edit.cut', 'Cut', 'Ctrl+X', () => { A['edit.copy'].run(); A['edit.clear'].run(); });
  def('edit.copy', 'Copy', 'Ctrl+C', async () => {
    if (!need()) return;
    const L = app.activeRaster(false);
    if (!L) return;
    let src = copyCanvas(L.canvas);
    const b = doc().selection.bounds();
    if (b) {
      const t = makeCanvas(b.w, b.h);
      t.getContext('2d').drawImage(L.canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
      const m = makeCanvas(b.w, b.h);
      m.getContext('2d').drawImage(doc().selection.canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
      const tc = t.getContext('2d');
      tc.globalCompositeOperation = 'destination-in';
      tc.drawImage(m, 0, 0);
      src = t;
    }
    app.clipboard = src;
    toast('Copied');
  });
  def('edit.copyMerged', 'Copy Merged', 'Ctrl+Shift+C', () => {
    if (!need()) return;
    let src = renderDoc(doc());
    const b = doc().selection.bounds();
    if (b) {
      const t = makeCanvas(b.w, b.h);
      const tc = t.getContext('2d');
      tc.drawImage(src, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
      tc.globalCompositeOperation = 'destination-in';
      tc.drawImage(doc().selection.canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
      src = t;
    }
    app.clipboard = src;
  });
  def('edit.paste', 'Paste', 'Ctrl+V', () => {
    if (!need() || !app.clipboard) return;
    const L = new Layer({ name: doc().uniqueName('Pasted'), canvas: copyCanvas(app.clipboard) });
    L.x = Math.round((doc().width - L.canvas.width) / 2);
    L.y = Math.round((doc().height - L.canvas.height) / 2);
    doc().addLayer(L);
    app.push('Paste');
  });
  def('edit.clear', 'Clear', 'Del', () => {
    if (!need()) return;
    const L = app.activeRaster(false);
    if (!L) return;
    const lc = L.canvas.getContext('2d');
    lc.save();
    lc.globalCompositeOperation = 'destination-out';
    if (doc().selection.has) lc.drawImage(doc().selection.canvas, 0, 0);
    else lc.fillRect(0, 0, L.canvas.width, L.canvas.height);
    lc.restore();
    app.push('Clear');
  });
  def('edit.fill', 'Fill…', 'Shift+F5', () => {
    if (!need()) return;
    const v = { use: 'foreground', opacity: 100, blend: 'normal' };
    const body = el('div', { class: 'col' },
      el('div', { class: 'grid2' },
        el('span', {}, 'Contents'), el('select', { onchange: (e) => { v.use = e.target.value; } },
          el('option', { value: 'foreground' }, 'Foreground colour'),
          el('option', { value: 'background' }, 'Background colour'),
          el('option', { value: 'white' }, 'White'), el('option', { value: 'black' }, 'Black'),
          el('option', { value: 'gray' }, '50% grey'), el('option', { value: 'pattern' }, 'Pattern')),
        el('span', {}, 'Blending mode'), el('select', { onchange: (e) => { v.blend = e.target.value; } },
          ...BLEND_MODES.map(([id, name]) => el('option', { value: id, selected: id === 'normal' }, name))),
        el('span', {}, 'Opacity'), el('input', { type: 'number', value: 100, oninput: (e) => { v.opacity = Number(e.target.value); } })),
    );
    const { close } = modal({
      title: 'Fill', body,
      footer: [el('span', { class: 'grow' }),
        el('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        el('button', {
          class: 'btn primary', onclick: () => {
            close();
            const L = app.activeRaster(true);
            const t = makeCanvas(doc().width, doc().height);
            const tc = t.getContext('2d');
            const col = v.use === 'foreground' ? app.fg : v.use === 'background' ? app.bg
              : v.use === 'white' ? [1, 1, 1] : v.use === 'black' ? [0, 0, 0] : [0.5, 0.5, 0.5];
            if (v.use === 'pattern') tc.fillStyle = tc.createPattern(patternCanvas('checks', 32, app.fg), 'repeat');
            else tc.fillStyle = `rgb(${col.map((x) => x * 255).join(',')})`;
            tc.fillRect(0, 0, t.width, t.height);
            app.compositeOnto(L, t, v.blend, v.opacity / 100);
            app.push('Fill');
          },
        }, 'OK')],
    });
  });
  def('edit.stroke', 'Stroke…', '', () => {
    if (!need()) return;
    const v = { width: 3, color: app.fg, inside: true, opacity: 100 };
    const body = el('div', { class: 'grid2' },
      el('span', {}, 'Width'), el('input', { type: 'number', value: 3, oninput: (e) => { v.width = Number(e.target.value); } }),
      el('span', {}, 'Colour'), el('input', { type: 'color', value: '#000000', oninput: (e) => { v.color = hexToRgbArr(e.target.value); } }),
      el('span', {}, 'Location'), el('select', { onchange: (e) => { v.inside = e.target.value === 'inside'; } },
        el('option', { value: 'inside' }, 'Inside'), el('option', { value: 'center' }, 'Centre'), el('option', { value: 'outside' }, 'Outside')));
    const { close } = modal({
      title: 'Stroke', body,
      footer: [el('span', { class: 'grow' }),
        el('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        el('button', {
          class: 'btn primary', onclick: () => {
            close();
            const L = app.activeRaster(true);
            const sel = doc().selection;
            const t = makeCanvas(doc().width, doc().height);
            const tc = t.getContext('2d');
            if (sel.has) tc.drawImage(sel.canvas, 0, 0);
            else tc.fillRect(0, 0, t.width, t.height);
            tc.globalCompositeOperation = 'destination-out';
            if (sel.has) {
              const shrunk = makeCanvas(doc().width, doc().height);
              const sc = shrunk.getContext('2d');
              sc.drawImage(sel.canvas, 0, 0);
              sc.globalCompositeOperation = 'destination-out';
              const grow = makeCanvas(doc().width, doc().height);
              grow.getContext('2d').drawImage(sel.canvas, 0, 0);
              for (let i = 0; i < v.width; i++) { sc.drawImage(grow, -i - 1, 0); sc.drawImage(grow, i + 1, 0); sc.drawImage(grow, 0, -i - 1); sc.drawImage(grow, 0, i + 1); }
              tc.drawImage(shrunk, 0, 0);
            } else {
              tc.fillRect(v.width, v.width, t.width - v.width * 2, t.height - v.width * 2);
            }
            tc.globalCompositeOperation = 'source-in';
            tc.fillStyle = `rgb(${v.color.map((x) => x * 255).join(',')})`;
            tc.fillRect(0, 0, t.width, t.height);
            app.compositeOnto(L, t, 'normal', v.opacity / 100);
            app.push('Stroke');
          },
        }, 'OK')],
    });
  });
  def('edit.freeTransform', 'Free Transform', 'Ctrl+T', () => need() && app.beginTransform());
  def('edit.transformAgain', 'Transform Again', 'Ctrl+Shift+T', () => need() && app.repeatTransform());
  def('edit.preferences', 'Preferences…', 'Ctrl+K', () => preferencesDialog(app));

  // ---------------------------------------------------------------- Image
  const adjMenu = ADJUSTMENTS.map(([id, name]) =>
    ['image.adjust.' + id, name, '', () => need() && adjustDialog(app, id, { asLayer: true })]);
  def('image.autoTone', 'Auto Tone', 'Ctrl+Shift+L', () => need() && applyDirect(app, 'autoTone'));
  def('image.autoContrast', 'Auto Contrast', 'Ctrl+Alt+Shift+L', () => need() && applyDirect(app, 'autoTone'));
  def('image.autoColor', 'Auto Colour', 'Ctrl+Shift+B', () => need() && applyDirect(app, 'autoTone'));
  def('image.imageSize', 'Image Size…', 'Ctrl+Alt+I', () => need() && imageSizeDialog(app));
  def('image.canvasSize', 'Canvas Size…', 'Ctrl+Alt+C', () => need() && canvasSizeDialog(app));
  def('image.rotate90cw', 'Rotate 90° CW', '', () => need() && rotateCanvas(app, 1));
  def('image.rotate90ccw', 'Rotate 90° CCW', '', () => need() && rotateCanvas(app, 3));
  def('image.rotate180', 'Rotate 180°', '', () => need() && rotateCanvas(app, 2));
  def('image.rotateArb', 'Rotate Arbitrary…', '', () => need() && rotateCanvasDialog(app));
  def('image.flipH', 'Flip Horizontal', '', () => need() && flipCanvas(app, 'h'));
  def('image.flipV', 'Flip Vertical', '', () => need() && flipCanvas(app, 'v'));
  def('image.crop', 'Crop', '', () => {
    if (!need()) return;
    const b = doc().selection.bounds();
    if (!b) { toast('Make a selection first'); return; }
    app.commitCrop(b);
  });
  def('image.trim', 'Trim…', '', () => {
    if (!need()) return;
    const flat = renderDoc(doc());
    const t = app.trimToContent(flat);
    if (t.width === doc().width && t.height === doc().height) { toast('Nothing to trim'); return; }
    doc().layers = [new Layer({ name: 'Background', canvas: t })];
    doc().activeLayerId = doc().layers[0].id;
    doc().resize(t.width, t.height);
    app.compCanvas = makeCanvas(t.width, t.height);
    app.push('Trim');
    app.fitToScreen();
  });
  def('image.duplicate', 'Duplicate…', '', () => {
    if (!need()) return;
    const d = new Doc(doc().width, doc().height, { name: doc().name + ' copy', dpi: doc().dpi, background: doc().background });
    const snap = snapshotDoc(doc());
    const { restoreDoc } = app._model;
    restoreDoc(d, snap);
    app.setDoc(d, 'Duplicate');
  });

  // ---------------------------------------------------------------- Layer
  def('layer.new', 'New Layer', 'Ctrl+Shift+N', () => {
    if (!need()) return;
    const L = new Layer({ name: doc().uniqueName('Layer'), canvas: makeCanvas(doc().width, doc().height) });
    doc().addLayer(L, { above: doc().activeLayerId });
    app.push('New Layer');
  });
  def('layer.newViaCopy', 'Layer via Copy', 'Ctrl+J', () => {
    if (!need()) return;
    const L = app.activeRaster(false);
    if (!L) return;
    const c = copyCanvas(L.canvas);
    if (doc().selection.has) {
      const cc = c.getContext('2d');
      cc.globalCompositeOperation = 'destination-in';
      cc.drawImage(doc().selection.canvas, 0, 0);
    }
    const n = new Layer({ name: doc().uniqueName(L.name + ' copy'), canvas: c, x: L.x, y: L.y });
    doc().addLayer(n, { above: L.id });
    app.push('Layer via Copy');
  });
  def('layer.newViaCut', 'Layer via Cut', 'Ctrl+Shift+J', () => {
    A['layer.newViaCopy'].run();
    A['edit.clear'].run();
  });
  def('layer.duplicate', 'Duplicate Layer', '', () => need() && app.duplicateLayer());
  def('layer.delete', 'Delete Layer', '', () => need() && app.deleteLayer());
  def('layer.rename', 'Rename…', '', () => {
    if (!need()) return;
    const L = doc().activeLayer;
    if (!L) return;
    const n = prompt('Layer name:', L.name);
    if (n) { L.name = n; app.push('Rename'); app.update({ panels: true }); }
  });
  def('layer.newFillSolid', 'Solid Colour…', '', () => {
    if (!need()) return;
    const L = new Layer({ name: 'Colour Fill', canvas: makeCanvas(doc().width, doc().height) });
    const c = L.canvas.getContext('2d');
    c.fillStyle = `rgb(${app.fg.map((v) => v * 255).join(',')})`;
    c.fillRect(0, 0, L.canvas.width, L.canvas.height);
    doc().addLayer(L);
    app.push('Solid Fill');
  });
  def('layer.newFillGradient', 'Gradient…', '', () => {
    if (!need()) return;
    const L = new Layer({ name: 'Gradient Fill', canvas: makeCanvas(doc().width, doc().height) });
    const c = L.canvas.getContext('2d');
    c.fillStyle = gradientFill(c, 'linear', [[0, app.fg, 1], [1, app.bg, 1]], 0, 0, doc().width, doc().height);
    c.fillRect(0, 0, L.canvas.width, L.canvas.height);
    doc().addLayer(L);
    app.push('Gradient Fill');
  });
  def('layer.newFillPattern', 'Pattern…', '', () => {
    if (!need()) return;
    const L = new Layer({ name: 'Pattern Fill', canvas: makeCanvas(doc().width, doc().height) });
    const c = L.canvas.getContext('2d');
    c.fillStyle = c.createPattern(patternCanvas('checks', 32, app.fg), 'repeat');
    c.fillRect(0, 0, L.canvas.width, L.canvas.height);
    doc().addLayer(L);
    app.push('Pattern Fill');
  });
  const adjLayerMenu = ADJUSTMENTS.map(([id, name]) =>
    ['layer.adjust.' + id, name, '', () => {
      if (!need()) return;
      const L = new Layer({ type: 'adjustment', name, adjustment: { kind: id, params: adjDefault(id) } });
      doc().addLayer(L);
      app.push('New Adjustment Layer');
      setTimeout(() => adjustDialog(app, id, { asLayer: false }), 0);
    }]);
  def('layer.maskRevealAll', 'Reveal All', '', () => need() && app.addMask('reveal'));
  def('layer.maskHideAll', 'Hide All', '', () => need() && app.addMask('hide'));
  def('layer.maskFromSelection', 'From Selection', '', () => need() && app.addMask('fromSelection'));
  def('layer.maskEdit', 'Edit Layer Mask', 'Ctrl+Alt+M', () => need() && app.editMask());
  def('layer.maskInvert', 'Invert Mask', '', () => need() && app.invertMask());
  def('layer.maskFromAlpha', 'Mask from Layer Transparency', '', () => need() && app.maskFromTransparency());
  def('layer.maskToSelection', 'Load Mask as Selection', '', () => need() && app.maskToSelection());
  def('layer.maskFeather', 'Feather Mask…', '', () => {
    if (!need() || !doc().activeLayer?.mask) return;
    const n = Number(prompt('Feather mask radius (px):', '4'));
    if (Number.isFinite(n) && n > 0) app.featherMask(n);
  });
  def('layer.maskDelete', 'Delete Mask', '', () => need() && app.deleteMask(false));
  def('layer.maskApply', 'Apply Mask', '', () => need() && app.deleteMask(true));
  def('layer.maskDisable', 'Enable/Disable Mask', '', () => {
    if (!need()) return;
    const L = doc().activeLayer;
    if (!L?.mask) return;
    L.maskEnabled = !L.maskEnabled;
    app.push('Toggle Layer Mask');
  });
  def('layer.clipMask', 'Create Clipping Mask', 'Ctrl+Alt+G', () => {
    if (!need()) return;
    const L = doc().activeLayer;
    if (!L) return;
    L.clipped = !L.clipped;
    app.push('Clipping Mask');
  });
  def('layer.group', 'Group Layers', 'Ctrl+G', () => need() && app.newGroupFromLayers());
  def('layer.ungroup', 'Ungroup', 'Ctrl+Shift+G', () => {
    if (!need()) return;
    const L = doc().activeLayer;
    if (!L?.isGroup) return;
    const sib = doc().siblings(L.id);
    const i = sib.findIndex((l) => l.id === L.id);
    sib.splice(i, 1, ...L.children);
    app.push('Ungroup');
  });
  const arrange = (dir) => () => {
    if (!need()) return;
    const L = doc().activeLayer;
    if (!L) return;
    const sib = doc().siblings(L.id);
    const i = sib.findIndex((l) => l.id === L.id);
    let j = i;
    if (dir === 'front') j = sib.length - 1;
    else if (dir === 'back') j = 0;
    else if (dir === 'forward') j = Math.min(sib.length - 1, i + 1);
    else j = Math.max(0, i - 1);
    if (i === j) return;
    sib.splice(i, 1); sib.splice(j, 0, L);
    app.push('Arrange');
  };
  def('layer.bringFront', 'Bring to Front', 'Ctrl+Shift+]', arrange('front'));
  def('layer.forward', 'Bring Forward', 'Ctrl+]', arrange('forward'));
  def('layer.backward', 'Send Backward', 'Ctrl+[', arrange('backward'));
  def('layer.sendBack', 'Send to Back', 'Ctrl+Shift+[', arrange('back'));
  def('layer.mergeDown', 'Merge Down', 'Ctrl+E', () => need() && app.mergeDown());
  def('layer.mergeVisible', 'Merge Visible', 'Ctrl+Alt+Shift+E', () => need() && app.mergeVisible());
  def('layer.flatten', 'Flatten Image', '', () => need() && app.flatten());
  def('layer.rasterize', 'Rasterize Layer', '', () => {
    if (!need()) return;
    const L = doc().activeLayer;
    if (!L) return;
    app.rasterizeLayer(L, false);
    app.push('Rasterize');
  });

  // ---------------------------------------------------------------- Select
  def('select.layerAlpha', 'Load Layer Transparency', '', () => {
    if (!need()) return;
    const L = doc().activeLayer;
    if (!L?.canvas) return;
    const s = doc().selection; s.none();
    s.ctx.drawImage(L.canvas, L.x, L.y); s.has = true;
    app.push('Select Layer Transparency');
  });
  def('select.all', 'All', 'Ctrl+A', () => need() && app.selectAll());
  def('select.none', 'Deselect', 'Ctrl+D', () => need() && app.deselect());
  def('select.inverse', 'Inverse', 'Ctrl+Shift+I', () => need() && app.invertSelection());
  def('select.feather', 'Feather…', 'Shift+F6', () => {
    if (!need()) return;
    const r = Number(prompt('Feather radius (px):', '4'));
    if (r) app.featherSelection(r);
  });
  def('select.grow', 'Grow…', '', () => {
    const n = Number(prompt('Grow by (px):', '4'));
    if (n) app.growSelection(n);
  });
  def('select.shrink', 'Shrink…', '', () => {
    const n = Number(prompt('Shrink by (px):', '4'));
    if (n) app.shrinkSelection(n);
  });
  def('select.smooth', 'Smooth…', '', () => {
    const n = Number(prompt('Smooth radius:', '2'));
    if (n) { doc().selection.smooth(n); app.update({ overlay: true }); }
  });
  def('select.transform', 'Transform Selection', '', () => need() && app.beginTransform(true));
  def('select.save', 'Save Selection…', '', () => {
    if (!need()) return;
    doc().savedSelections = doc().savedSelections || {};
    const name = prompt('Channel name:', 'Alpha 1');
    if (name) { doc().savedSelections[name] = copyCanvas(doc().selection.canvas); toast('Saved'); }
  });
  def('select.load', 'Load Selection…', '', () => {
    if (!need()) return;
    const keys = Object.keys(doc().savedSelections || {});
    if (!keys.length) { toast('No saved selections'); return; }
    const name = prompt('Load channel:', keys[0]);
    if (name && doc().savedSelections[name]) {
      doc().selection._c = copyCanvas(doc().savedSelections[name]);
      doc().selection.has = true;
      app.update({ overlay: true, panels: true });
    }
  });

  // ---------------------------------------------------------------- Filter
  def('filter.gallery', 'Filter Gallery…', '', () => need() && filterGallery(app));
  def('filter.last', 'Last Filter', 'Ctrl+F', () => {
    if (app.lastFilter) filterDialog(app, app.lastFilter);
  });
  const catMenus = {};
  for (const f of FILTERS) {
    (catMenus[f.cat] = catMenus[f.cat] || []).push(['filter.' + f.id, f.name, '', () => {
      if (!need()) return;
      app.lastFilter = f.id;
      if (!f.fields || !f.fields.length) {
        // no-parameter filter: run immediately
        busy(true, f.name);
        setTimeout(() => {
          const L = app.activeRaster(true);
          if (L) {
            const w = L.canvas.width, h = L.canvas.height;
            const id = L.canvas.getContext('2d').getImageData(0, 0, w, h);
            f.apply(id.data, f.defaults, { w, h, seed: 1 });
            L.canvas.getContext('2d').putImageData(id, 0, 0);
          }
          busy(false);
          app.push(f.name);
        }, 10);
      } else filterDialog(app, f.id);
    }]);
  }

  // ---------------------------------------------------------------- View
  def('view.zoomIn', 'Zoom In', 'Ctrl+=', () => need() && app.zoomTo(app.view.zoom * 1.25));
  def('view.zoomOut', 'Zoom Out', 'Ctrl+-', () => need() && app.zoomTo(app.view.zoom / 1.25));
  def('view.fit', 'Fit on Screen', 'Ctrl+0', () => need() && app.fitToScreen());
  def('view.actual', '100%', 'Ctrl+1', () => need() && app.zoomTo(1));
  def('view.grid', 'Show Grid', "Ctrl+'", () => { app.showGrid = !app.showGrid; app.update({ overlay: true }); });
  def('view.guides', 'Show Guides', 'Ctrl+;', () => { app.showGuides = !app.showGuides; app.update({ overlay: true }); });
  def('view.rulers', 'Show Rulers', 'Ctrl+R', () => { app.showRulers = !app.showRulers; app.update({ status: true }); toast('Rulers ' + (app.showRulers ? 'on' : 'off')); });
  def('view.snap', 'Snap', 'Ctrl+Shift+;', () => { app.snapTo = !app.snapTo; toast('Snap ' + (app.snapTo ? 'on' : 'off')); });
  def('view.clearGuides', 'Clear Guides', '', () => { doc().guides = []; app.update({ overlay: true }); });
  def('view.newGuide', 'New Guide…', '', () => {
    if (!need()) return;
    const v = { orientation: 'h', position: Math.round(doc().height / 2) };
    const body = el('div', { class: 'grid2' },
      el('span', {}, 'Orientation'), el('select', { onchange: (e) => { v.orientation = e.target.value; } },
        el('option', { value: 'h' }, 'Horizontal'), el('option', { value: 'v' }, 'Vertical')),
      el('span', {}, 'Position'), el('input', { type: 'number', value: v.position, oninput: (e) => { v.position = Number(e.target.value); } }));
    const { close } = modal({
      title: 'New Guide', body,
      footer: [el('span', { class: 'grow' }),
        el('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: () => { close(); doc().guides.push({ orientation: v.orientation, position: v.position }); app.update({ overlay: true }); } }, 'OK')],
    });
  });

  // ---------------------------------------------------------------- Window / Help
  def('help.about', 'About ' + BRAND.name, '', () => aboutDialog());
  def('help.shortcuts', 'Keyboard Shortcuts', '', () => {
    const rows = Object.values(A).filter((a) => a.key);
    const body = el('div', { class: 'col', style: { maxHeight: '60vh', overflow: 'auto', minWidth: '420px' } },
      ...rows.map((a) => el('div', { class: 'row' },
        el('span', { class: 'grow' }, a.label),
        el('span', { class: 'kbd' }, a.key))));
    const { close } = modal({ title: 'Keyboard Shortcuts', body, footer: [el('span', { class: 'grow' }), el('button', { class: 'btn primary', onclick: () => close() }, 'OK')] });
  });
  def('help.methodology', 'How this was built', '', () => {
    modal({
      title: 'How this was built',
      body: el('div', { class: 'col', style: { maxWidth: '520px' } },
        el('p', {}, `${BRAND.name} is an independent image editor. It does not include another product's ` +
          'source, artwork, icons, bundled assets, copy or branding. Legal rules vary by jurisdiction.'),
        el('p', {}, 'This early prototype uses an original interface and original icons. Its features are partial ' +
          'and many are simplified; it does not claim parity with another product.'),
        el('p', { class: 'hint' }, 'Wire formats (PSD, PNG) are implemented for interoperability — that is ' +
          'a limited 8-bit implementation provided for interoperability.')),
      footer: [el('span', { class: 'grow' }), el('button', { class: 'btn primary', onclick: () => document.querySelector('.modal-back')?.remove() }, 'OK')],
    });
  });

  // ---------------------------------------------------------------- menu tree
  const MENU = [
    ['File', [
      ['file.new'], ['file.open'], ['file.place'], 'sep',
      ['file.save'], ['file.export'], ['file.exportPSD'], 'sep', ['file.close'],
    ]],
    ['Edit', [
      ['edit.undo'], ['edit.redo'], 'sep',
      ['edit.cut'], ['edit.copy'], ['edit.copyMerged'], ['edit.paste'], ['edit.clear'], 'sep',
      ['edit.fill'], ['edit.stroke'], 'sep',
      ['edit.freeTransform'], ['edit.transformAgain'], 'sep',
      ['edit.preferences'],
    ]],
    ['Image', [
      ['image.autoTone'], ['image.autoContrast'], ['image.autoColor'],
      ['Adjustments', adjMenu.map((a) => [a[0]])], 'sep',
      ['image.imageSize'], ['image.canvasSize'], 'sep',
      ['image.rotate90cw'], ['image.rotate90ccw'], ['image.rotate180'], ['image.rotateArb'],
      ['image.flipH'], ['image.flipV'], 'sep',
      ['image.crop'], ['image.trim'], ['image.duplicate'],
    ]],
    ['Layer', [
      ['layer.new'], ['layer.newViaCopy'], ['layer.newViaCut'], ['layer.duplicate'], ['layer.delete'], ['layer.rename'], 'sep',
      ['New Fill Layer', [['layer.newFillSolid'], ['layer.newFillGradient'], ['layer.newFillPattern']]],
      ['New Adjustment Layer', adjLayerMenu.map((a) => [a[0]])], 'sep',
      ['Layer Mask', [['layer.maskRevealAll'], ['layer.maskHideAll'], ['layer.maskFromSelection'], ['layer.maskFromAlpha'], 'sep', ['layer.maskEdit'], ['layer.maskInvert'], ['layer.maskFeather'], ['layer.maskToSelection'], 'sep', ['layer.maskApply'], ['layer.maskDelete'], ['layer.maskDisable']]],
      ['layer.clipMask'], 'sep',
      ['layer.group'], ['layer.ungroup'], 'sep',
      ['Arrange', [['layer.bringFront'], ['layer.forward'], ['layer.backward'], ['layer.sendBack']]], 'sep',
      ['layer.mergeDown'], ['layer.mergeVisible'], ['layer.flatten'], ['layer.rasterize'],
    ]],
    ['Select', [
      ['select.all'], ['select.none'], ['select.inverse'], ['select.layerAlpha'], 'sep',
      ['select.feather'], ['select.grow'], ['select.shrink'], ['select.smooth'], 'sep',
      ['select.transform'], ['select.save'], ['select.load'],
    ]],
    ['Filter', [
      ['filter.last'], ['filter.gallery'], 'sep',
      ...Object.entries(catMenus).map(([cat, items]) => [cat, items.map((i) => [i[0]])]),
    ]],
    ['View', [
      ['view.zoomIn'], ['view.zoomOut'], ['view.fit'], ['view.actual'], 'sep',
      ['view.grid'], ['view.guides'], ['view.rulers'], ['view.snap'], 'sep',
      ['view.newGuide'], ['view.clearGuides'],
    ]],
    ['Help', [['help.about'], ['help.shortcuts'], ['help.methodology']]],
  ];

  for (const a of adjMenu) if (!A[a[0]]) A[a[0]] = { id: a[0], label: a[1], key: a[2], run: a[3] };
  for (const a of adjLayerMenu) if (!A[a[0]]) A[a[0]] = { id: a[0], label: a[1], key: a[2], run: a[3] };
  for (const items of Object.values(catMenus)) for (const a of items) if (!A[a[0]]) A[a[0]] = { id: a[0], label: a[1], key: a[2], run: a[3] };

  // Panel buttons call these as functions, whereas menu entries are command objects.
  Object.assign(A, {
    layerNew: () => A['layer.new'].run(),
    layerDuplicate: () => A['layer.duplicate'].run(),
    layerDelete: () => A['layer.delete'].run(),
    layerGroup: () => A['layer.group'].run(),
    mergeDown: () => A['layer.mergeDown'].run(),
    mergeVisible: () => A['layer.mergeVisible'].run(),
    flatten: () => A['layer.flatten'].run(),
    addMask: (kind = 'reveal') => app.addMask(kind),
    layerNewAdjustment: () => adjustDialog(app, 'brightness', { asLayer: true }),
    selectionFromChannel: () => app.selectionFromChannel(),
    pathToSelection: () => app.pathToSelection(),
    strokePath: () => app.strokePath(),
    fillPath: () => app.fillPath(),
  });

  A.MENU = MENU;
  return A;
}

function hexToRgbArr(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function applyDirect(app, kind) {
  const L = app.activeRaster(true);
  if (!L) return;
  const w = L.canvas.width, h = L.canvas.height;
  const id = L.canvas.getContext('2d').getImageData(0, 0, w, h);
  applyAdjustment(id.data, kind, {}, w, h);
  L.canvas.getContext('2d').putImageData(id, 0, 0);
  app.push(kind);
}

function rotateCanvas(app, n) {
  const doc = app.doc;
  const w = n % 2 ? doc.height : doc.width, h = n % 2 ? doc.width : doc.height;
  for (const L of doc.flat()) {
    if (L.canvas) L.canvas = rotate90(L.canvas, n);
    if (L.mask) L.mask = rotate90(L.mask, n);
  }
  doc.resize(w, h);
  app.compCanvas = makeCanvas(w, h);
  app.push('Rotate Canvas');
  app.fitToScreen();
}
function flipCanvas(app, dir) {
  const doc = app.doc;
  for (const L of doc.flat()) {
    if (L.canvas) L.canvas = flip(L.canvas, dir);
    if (L.mask) L.mask = flip(L.mask, dir);
  }
  app.push('Flip Canvas');
}

export { rotateCanvas, flipCanvas };
