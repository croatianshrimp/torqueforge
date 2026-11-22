// Download the picked Sketchfab models (assets/cars/picks.json) and run them through process_model.mjs.
//   node tools/fetch_models.mjs [carId ...]        (token from $SKETCHFAB_TOKEN or ~/.config/torqueforge/sketchfab_token)
// Raw downloads go to ~/.cache/torqueforge/raw/<carId>/ (outside the repo). Each model is unpacked into its own folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tokenFile = path.join(os.homedir(), '.config/torqueforge/sketchfab_token');
const TOKEN = (process.env.SKETCHFAB_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8') : '')).trim();
if (!TOKEN) { console.error('No Sketchfab token. Put it in', tokenFile); process.exit(2); }
const picks = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/cars/picks.json')));
const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
const force = process.argv.includes('--force');
const RAW = path.join(os.homedir(), '.cache/torqueforge/raw');
const H = { Authorization: `Token ${TOKEN}`, 'User-Agent': 'TorqueForge-asset-fetch' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers: H });
    if (r.status === 429) { await sleep(5000 * (i + 1)); continue; }
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }
  throw new Error('rate limited');
}

const results = {};
for (const [id, p] of Object.entries(picks)) {
  if (only.length && !only.includes(id)) continue;
  const out = path.join(ROOT, 'assets/cars', id);
  if (!force && fs.existsSync(path.join(out, 'manifest.json'))) { console.log(id, 'already processed'); continue; }
  try {
    const dir = path.join(RAW, p.uid);
    fs.mkdirSync(dir, { recursive: true });
    const info = await getJSON(`https://api.sketchfab.com/v3/models/${p.uid}`);
    const meta = { name: info.name, author: info.user?.displayName || info.user?.username, username: info.user?.username, license: info.license?.label || p.license, url: info.viewerUrl || p.url, uid: p.uid };
    let file = fs.readdirSync(dir).find(f => /\.(glb|gltf)$/i.test(f));
    if (!file) {
      const dl = await getJSON(`https://api.sketchfab.com/v3/models/${p.uid}/download`);
      const pick = dl.glb ? { url: dl.glb.url, ext: 'glb' } : { url: dl.gltf.url, ext: 'zip' };
      console.log(id, 'downloading', pick.ext, ((dl.glb || dl.gltf).size / 1e6).toFixed(1), 'MB');
      const r = await fetch(pick.url);
      if (!r.ok) throw new Error('download ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (pick.ext === 'glb') { fs.writeFileSync(path.join(dir, 'model.glb'), buf); file = 'model.glb'; }
      else {
        const zip = path.join(dir, 'model.zip'); fs.writeFileSync(zip, buf);
        execFileSync('7z', ['x', '-y', `-o${dir}`, zip], { stdio: 'ignore' });
        fs.unlinkSync(zip);
        file = fs.readdirSync(dir).find(f => /\.(glb|gltf)$/i.test(f));
      }
    }
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'source.json'), JSON.stringify(meta, null, 1));
    const extra = (p.flags || []);
    execFileSync('node', [path.join(ROOT, 'tools/process_model.mjs'), id, path.join(dir, file), ...extra], { stdio: 'inherit' });
    results[id] = 'ok';
  } catch (e) { console.error(id, 'FAILED', e.message); results[id] = 'failed: ' + e.message; }
  await sleep(600);
}
execFileSync('node', [path.join(ROOT, 'tools/build_index.mjs')], { stdio: 'inherit' });
console.log(results);
