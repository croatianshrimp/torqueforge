// The game files the auto-updater keeps in sync (the same files package.json "build.files" ships, minus desktop/).
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

// Bump when desktop/ changes (main.js, preload, updater): those can't update in place, so players get sent to the
// download page instead.
export const SHELL = 1;

const DIRS = ['css', 'js', 'vendor', 'assets/env', 'assets/tex'];
const FILES = ['index.html', 'assets/cars/index.json', 'assets/cars/CREDITS.md', 'assets/CREDITS.md'];

function walk(root, rel, out) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(root, r, out);
    else if (e.isFile()) out.push(r);
  }
}

export function listContent(root) {
  const out = FILES.filter(f => fs.existsSync(path.join(root, f)));
  for (const d of DIRS) walk(root, d, out);
  for (const e of fs.readdirSync(path.join(root, 'assets/cars'), { withFileTypes: true }))
    if (e.isDirectory()) for (const q of ['high.glb', 'low.glb'])
      if (fs.existsSync(path.join(root, 'assets/cars', e.name, q))) out.push(`assets/cars/${e.name}/${q}`);
  return out.sort();
}

export function hashContent(root) {
  const files = {};
  for (const rel of listContent(root))
    files[rel] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
  return files;
}
