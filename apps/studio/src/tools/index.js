// Tool metadata and option-bar controls. Pointer handlers are attached by paint.js.
const range = (key, label, def, min, max) => ({ key, label, def, type: 'range', min, max });
const choice = (key, label, def, options) => ({ key, label, def, type: 'select', options });
const check = (key, label, def = false) => ({ key, label, def, type: 'check' });
const selection = [choice('mode', 'Selection', 'replace', [['replace', 'New'], ['add', 'Add'], ['subtract', 'Subtract'], ['intersect', 'Intersect']])];
const brush = [range('size', 'Size', 24, 1, 500), range('hardness', 'Hardness', 75, 0, 100), range('opacity', 'Opacity', 100, 1, 100), range('flow', 'Flow', 100, 1, 100), range('smoothing', 'Smoothing', 4, 0, 20)];
const strength = [...brush, range('strength', 'Strength', 50, 1, 100)];
const shape = [choice('fill', 'Fill', 'solid', [['solid', 'Colour'], ['none', 'None'], ['gradient', 'Gradient'], ['pattern', 'Pattern']]), range('strokeWidth', 'Stroke', 0, 0, 80), range('opacity', 'Opacity', 100, 0, 100)];
const T = (id, name, group, key, icon, cursor = 'crosshair', options = []) => ({ id, name, group, key, icon, cursor, options });
export const TOOLS = [
  T('move', 'Move / Transform', 'move', 'V', '✥', 'move'),
  T('rectSelect', 'Rectangular Marquee', 'select', 'M', '▣', 'crosshair', selection),
  T('ellipseSelect', 'Elliptical Marquee', 'select', 'M', '◯', 'crosshair', selection),
  T('lasso', 'Lasso', 'select', 'L', '⌁', 'crosshair', selection),
  T('polyLasso', 'Polygonal Lasso', 'select', 'L', '⬡', 'crosshair', selection),
  T('magicWand', 'Magic Wand', 'select', 'W', '✦', 'crosshair', [...selection, range('tolerance', 'Tolerance', 32, 0, 255), check('contiguous', 'Contiguous', true)]),
  T('quickSelect', 'Quick Selection', 'select', 'W', '◉', 'brush', [...selection, range('size', 'Size', 30, 2, 200)]),
  T('crop', 'Crop', 'crop', 'C', '⌗', 'crosshair', [choice('ratio', 'Ratio', 'free', [['free', 'Free'], ['orig', 'Original'], ['1:1', 'Square'], ['4:3', '4:3'], ['16:9', '16:9']])]),
  T('eyedropper', 'Eyedropper', 'measure', 'I', '◈', 'eyedropper', [choice('size', 'Sample', 'point', [['point', 'Point'], ['3x3', '3×3'], ['5x5', '5×5']])]),
  T('ruler', 'Ruler', 'measure', 'I', '⌁'),
  T('brush', 'Brush', 'paint', 'B', '🖌', 'brush', brush),
  T('pencil', 'Pencil', 'paint', 'B', '✎', 'brush', [range('size', 'Size', 3, 1, 120), range('opacity', 'Opacity', 100, 1, 100)]),
  T('eraser', 'Eraser', 'paint', 'E', '▱', 'brush', brush),
  T('cloneStamp', 'Clone Stamp', 'heal', 'S', '♧', 'brush', brush),
  T('healBrush', 'Healing Brush', 'heal', 'J', '✚', 'brush', brush),
  T('smudge', 'Smudge', 'retouch', 'R', '☄', 'brush', strength),
  T('blurBrush', 'Blur Brush', 'retouch', 'R', '◌', 'brush', strength),
  T('sharpenBrush', 'Sharpen Brush', 'retouch', 'R', '✧', 'brush', strength),
  T('dodge', 'Dodge', 'retouch', 'O', '☼', 'brush', strength),
  T('burn', 'Burn', 'retouch', 'O', '☾', 'brush', strength),
  T('sponge', 'Sponge', 'retouch', 'O', '▦', 'brush', strength),
  T('redEye', 'Red Eye', 'heal', 'J', '◉', 'crosshair', [range('pupil', 'Pupil', 40, 4, 100), range('darken', 'Darken', 50, 1, 100)]),
  T('gradient', 'Gradient', 'fill', 'G', '▤', 'crosshair', [choice('type', 'Style', 'linear', [['linear', 'Linear'], ['radial', 'Radial'], ['angle', 'Angle'], ['reflected', 'Reflected'], ['diamond', 'Diamond']]), range('opacity', 'Opacity', 100, 1, 100), check('reverse', 'Reverse')]),
  T('bucket', 'Paint Bucket', 'fill', 'G', '◩', 'bucket', [range('tolerance', 'Tolerance', 32, 0, 255), check('contiguous', 'Contiguous', true), range('opacity', 'Opacity', 100, 1, 100)]),
  ...[['rect', 'Rectangle', '▭'], ['roundrect', 'Rounded Rectangle', '▢'], ['ellipse', 'Ellipse', '⬭'], ['polygon', 'Polygon', '⬡'], ['star', 'Star', '★'], ['line', 'Line', '╱'], ['heart', 'Heart', '♥']].map(([id, name, icon]) => T(id, name, 'shape', 'U', icon, 'crosshair', [...(id === 'line' ? shape.map(o => o.key === 'strokeWidth' ? { ...o, def: 3 } : o) : shape), ...(id === 'roundrect' ? [range('radius', 'Radius', 16, 0, 100)] : []), ...(id === 'polygon' || id === 'star' ? [range('sides', 'Sides', 5, 3, 16)] : [])])),
  T('text', 'Type', 'type', 'T', 'T', 'text', [range('size', 'Size', 64, 8, 300)]),
  T('pen', 'Pen', 'pen', 'P', '✒', 'crosshair', [choice('mode', 'Mode', 'path', [['path', 'Path'], ['shape', 'Shape']]), ...shape]),
  T('pathSelect', 'Path Selection', 'pen', 'A', '↖', 'move'),
  T('directSelect', 'Direct Selection', 'pen', 'A', '⌁', 'move'),
  T('hand', 'Hand', 'view', 'H', '✋', 'grab'),
  T('zoom', 'Zoom', 'view', 'Z', '⌕', 'zoom'),
];
export const TOOL_BY_ID = new Map(TOOLS.map((t) => [t.id, t]));
