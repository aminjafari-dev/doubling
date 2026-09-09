// Copies static files (manifest, HTML, CSS, worklet) into dist/ after `tsc`.
// Run via `npm run build`. Plain Node, no extra dependencies.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const files = [
  'manifest.json',
  'src/popup/popup.html',
  'src/popup/popup.css',
  'src/offscreen/offscreen.html',
  'src/offscreen/pcm-capture-processor.js',
];

// dist/ mirrors the src/ layout, e.g. src/popup/popup.html -> dist/popup/popup.html
for (const file of files) {
  const from = join(root, file);
  const to = join(root, 'dist', file.startsWith('src/') ? file.slice(4) : file);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copied ${file} -> ${to}`);
}
