// Collect assets/cars/<id>/manifest.json (+ credits from picks.json / fetched meta) into assets/cars/index.json
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.join(ROOT, 'assets/cars');
const picks = fs.existsSync(path.join(dir, 'picks.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'picks.json'))) : {};
const index = {};
const credits = ['# Car model credits', '', 'Downloaded from Sketchfab; each model belongs to its author and is used under the licence shown. Models were scaled, re-oriented, simplified and had their wheels replaced for use in TorqueForge.', ''];
for (const id of fs.readdirSync(dir).sort()) {
  const mf = path.join(dir, id, 'manifest.json');
  if (!fs.existsSync(mf)) continue;
  const m = JSON.parse(fs.readFileSync(mf));
  const metaF = path.join(dir, id, 'source.json');
  const meta = fs.existsSync(metaF) ? JSON.parse(fs.readFileSync(metaF)) : (picks[id] || {});
  m.credit = { name: meta.name || '?', author: meta.author || '?', license: meta.license || '?', url: meta.url || '' };
  index[id] = m;
  credits.push(`- **${id}**: “${m.credit.name}” by ${m.credit.author} — ${m.credit.license} — ${m.credit.url}`);
}
fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
fs.writeFileSync(path.join(dir, 'CREDITS.md'), credits.join('\n') + '\n');
console.log('index:', Object.keys(index).length, 'cars');
