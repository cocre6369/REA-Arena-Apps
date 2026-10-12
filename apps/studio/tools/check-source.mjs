// Fail packaging if a relative renderer import is missing (notably src/tools).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../src/tools/index.js';
import '../src/tools/paint.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const visited = new Set();
function walk(file) {
  file = path.resolve(file);
  if (visited.has(file)) return;
  if (!fs.existsSync(file)) throw Error('Missing renderer module: ' + path.relative(root, file));
  visited.add(file);
  const text = fs.readFileSync(file, 'utf8');
  for (const [, name] of text.matchAll(/(?:\bfrom\s*|\bimport\s*)['"](\.[^'"]+)['"]/g)) walk(path.resolve(path.dirname(file), name));
}
walk(path.join(root, 'src/main.js'));
if (!TOOLS.length || TOOLS.some(t => !t.onDown)) throw Error('Toolbar contains an unbound tool');
for (const file of ['index.html', 'desktop/main.js', 'desktop/preload.cjs']) if (!fs.existsSync(path.join(root, file))) throw Error('Missing packaged file: ' + file);
console.log(`Renderer ready: ${visited.size} modules, ${TOOLS.length} bound tools`);
