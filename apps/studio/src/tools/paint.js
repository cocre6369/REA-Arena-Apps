// Pointer bindings for the editor tools. Canvas mutations are committed on pointer-up.
import { TOOLS } from './index.js';

const tool = (id) => TOOLS.find((t) => t.id === id);
const options = (a) => a.toolOptions[a.tool] || {};
const clampPoint = (a, p) => ({ ...p, x: Math.max(0, Math.min(a.doc.width - 1, p.x)), y: Math.max(0, Math.min(a.doc.height - 1, p.y)) });
const mode = (a, p) => p.shift ? 'add' : p.alt ? 'subtract' : options(a).mode || 'replace';
const change = (a, label) => { a.push(label); a.update({ overlay: true }); };

// Brush-like tools share the stroke engine. Painting a selected mask reveals or hides
// its alpha instead of touching layer pixels; the app composites the stroke at mouse-up.
for (const [id, strokeMode] of Object.entries({ brush: 'paint', pencil: 'paint', eraser: 'erase', cloneStamp: 'clone', healBrush: 'heal', smudge: 'smudge', blurBrush: 'blur', sharpenBrush: 'sharpen', dodge: 'dodge', burn: 'burn', sponge: 'sponge' })) {
  const t = tool(id);
  t.onDown = (a, p) => {
    const o = { ...options(a), color: a.fg };
    if (id === 'pencil') { o.hardness = 100; o.flow = 100; o.smoothing = 0; }
    a.beginStroke(strokeMode, o);
    if (a.stroke) a.strokeMove(p.x, p.y, p.pressure);
  };
  t.onMove = (a, p) => { if (a.stroke) a.strokeMove(p.x, p.y, p.pressure); };
  t.onUp = (a) => { if (a.stroke) a.endStroke(t.name); };
}

tool('move').onDown = (a, p) => {
  const hit = a.hitTestLayer(p.x, p.y);
  if (hit) a.doc.activeLayerId = hit.id;
  a.beginTransform();
  a.update({ panels: true });
};

function startRect(kind) {
  const t = tool(kind);
  t.onDown = (a, p) => { a.drag = { kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y, ellipse: kind === 'ellipseSelect', mode: mode(a, p) }; };
  t.onMove = (a, p) => { if (a.drag?.kind === 'marquee') { a.drag.x1 = p.x; a.drag.y1 = p.y; a.update({ overlay: true }); } };
  t.onUp = (a, p) => {
    const d = a.drag; if (d?.kind !== 'marquee') return;
    d.x1 = p.x; d.y1 = p.y; a.drag = null;
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w < 2 || h < 2) { a.update({ overlay: true }); return; }
    const s = a.doc.selection;
    if (d.mode === 'replace') s.none();
    if (d.ellipse) s.drawPath((c) => c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2), d.mode);
    else s.fillRect(x, y, w, h, d.mode);
    change(a, 'Selection');
  };
}
startRect('rectSelect'); startRect('ellipseSelect');

function selectPolygon(a, d) {
  if (!d || d.pts.length < 3) { a.drag = null; a.update({ overlay: true }); return; }
  const s = a.doc.selection;
  if (d.mode === 'replace') s.none();
  s.drawPath((c) => { c.moveTo(...d.pts[0]); for (const p of d.pts.slice(1)) c.lineTo(...p); c.closePath(); }, d.mode);
  a.drag = null; change(a, 'Lasso Selection');
}
tool('lasso').onDown = (a, p) => { a.drag = { kind: 'freehand', pts: [[p.x, p.y]], mode: mode(a, p) }; };
tool('lasso').onMove = (a, p) => { if (a.drag?.kind === 'freehand') { a.drag.pts.push([p.x, p.y]); a.update({ overlay: true }); } };
tool('lasso').onUp = (a, p) => { if (a.drag?.kind === 'freehand') { a.drag.pts.push([p.x, p.y]); selectPolygon(a, a.drag); } };
tool('polyLasso').onDown = (a, p) => {
  if (a.drag?.kind !== 'poly') a.drag = { kind: 'poly', pts: [], mode: mode(a, p) };
  a.drag.pts.push([p.x, p.y]); a.update({ overlay: true });
};
tool('polyLasso').onMove = (a, p) => { if (a.drag?.kind === 'poly') { a.drag.hover = [p.x, p.y]; a.update({ overlay: true }); } };
tool('polyLasso').onDoubleClick = (a) => selectPolygon(a, a.drag);

tool('magicWand').onDown = (a, p) => {
  p = clampPoint(a, p);
  const o = options(a);
  a.selectByColor(a.flattenedSnapshot(), p.x, p.y, o.tolerance, o.contiguous, mode(a, p));
  change(a, 'Magic Wand');
};
tool('quickSelect').onDown = (a, p) => { a.drag = { kind: 'quick', base: a.flattenedSnapshot(), mode: mode(a, p) }; if (a.drag.mode === 'replace') a.doc.selection.none(); a.quickSelectAt(p.x, p.y, a.drag.mode); a.update({ overlay: true }); };
tool('quickSelect').onMove = (a, p) => { if (a.drag?.kind === 'quick') { a.quickSelectAt(p.x, p.y, a.drag.mode); a.update({ overlay: true }); } };
tool('quickSelect').onUp = (a) => { if (a.drag?.kind === 'quick') { a.drag = null; change(a, 'Quick Selection'); } };

const dragLine = (kind, finish) => {
  const t = tool(kind);
  t.onDown = (a, p) => { a.drag = { kind, x0: p.x, y0: p.y, x1: p.x, y1: p.y }; };
  t.onMove = (a, p) => { if (a.drag?.kind === kind) { a.drag.x1 = p.x; a.drag.y1 = p.y; a.update({ overlay: true }); } };
  t.onUp = (a, p) => { if (a.drag?.kind === kind) { a.drag.x1 = p.x; a.drag.y1 = p.y; const d = a.drag; a.drag = null; finish(a, d); a.update({ overlay: true }); } };
};
dragLine('crop', (a, d) => { a.applyCropRatio(d); const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1); const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0); if (w >= 2 && h >= 2) a.commitCrop({ x, y, w, h }); });
dragLine('gradient', (a, d) => { const o = options(a); a.commitGradient(d, { ...o, stops: [[0, a.fg, 1], [1, a.bg, 1]] }); });
dragLine('ruler', (a, d) => a.status(`Distance: ${Math.hypot(d.x1 - d.x0, d.y1 - d.y0).toFixed(1)} px`));
for (const id of ['rect', 'roundrect', 'ellipse', 'polygon', 'star', 'line', 'heart']) {
  const t = tool(id);
  t.onDown = (a, p) => { a.drag = { kind: 'shape', shape: id, x0: p.x, y0: p.y, x1: p.x, y1: p.y }; };
  t.onMove = (a, p) => { if (a.drag?.kind === 'shape') { a.drag.x1 = p.x; a.drag.y1 = p.y; a.drag.constrain = p.shift; a.update({ overlay: true }); } };
  t.onUp = (a, p) => { if (a.drag?.kind !== 'shape') return; const d = a.drag; d.x1 = p.x; d.y1 = p.y; a.drag = null; if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) > 2) a.commitShape(d, options(a)); a.update({ overlay: true }); };
}
tool('bucket').onDown = (a, p) => { p = clampPoint(a, p); a.fillBucket(p.x, p.y, { ...options(a), fill: 'color', blend: 'normal' }); };
tool('eyedropper').onDown = (a, p) => a.setForeground(a.sampleColor(p.x, p.y, true));
tool('redEye').onDown = (a, p) => a.removeRedEye(p.x, p.y, options(a));
tool('text').onDown = (a, p) => a.createTextLayer(p.x, p.y, options(a));
tool('pen').onDown = (a, p) => a.penDown(p.x, p.y, p.shift);
tool('pen').onMove = (a, p) => { if (a.drag?.kind === 'penDrag') { a.drag.cx = p.x; a.drag.cy = p.y; a.update({ overlay: true }); } };
tool('pen').onUp = (a, p) => a.penUp(p.x, p.y);
tool('pen').onDoubleClick = (a) => a.commitPath();
tool('pathSelect').onDown = (a, p) => a.pathSelectDown(p.x, p.y);
tool('pathSelect').onMove = (a, p) => { a.pathMove(p.x, p.y); a.update({ overlay: true }); };
tool('pathSelect').onUp = (a) => { if (a.drag) { a.drag = null; change(a, 'Move Path'); } };
tool('directSelect').onDown = (a, p) => a.directSelectDown(p.x, p.y);
tool('directSelect').onMove = (a, p) => { if (a.drag) { a.anchorMove(p.x, p.y); a.update({ overlay: true }); } };
tool('directSelect').onUp = (a) => { if (a.drag) { a.drag = null; change(a, 'Edit Path'); } };
tool('hand').onDown = (a, p) => { a.drag = { kind: 'pan', sx: p.sx, sy: p.sy, ox: a.view.panX, oy: a.view.panY }; };
tool('hand').onMove = (a, p) => { if (a.drag?.kind === 'pan') { a.view.panX = a.drag.ox + p.sx - a.drag.sx; a.view.panY = a.drag.oy + p.sy - a.drag.sy; a.update({ transform: true }); } };
tool('zoom').onDown = (a, p) => a.zoomAt(p.sx, p.sy, p.alt ? 1 / 1.25 : 1.25);
