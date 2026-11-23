// Auto-updater for the game files (like Blockfire's): on every launch the app asks GitHub for the latest release's
// version.json. If it's newer, only the game files that changed are downloaded (from the repo at that release's tag),
// checked against their SHA-256, and stored in userData/game-<version>/. They're used from the next start on; the
// player is offered a restart straight away. If the new release also needs a newer app (SHELL bumped), the player is
// pointed at the download page instead.
import { app, dialog, net, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { SHELL } from './content.js';
const REPO = 'croatianshrimp/torqueforge';
const VERSION_URL = process.env.TF_UPDATE_URL || `https://github.com/${REPO}/releases/latest/download/version.json`;
const rawUrl = (tag, rel) => process.env.TF_UPDATE_RAW
  ? `${process.env.TF_UPDATE_RAW}/${rel}` : `https://raw.githubusercontent.com/${REPO}/${tag}/${rel}`;

const dataDir = () => app.getPath('userData');
const pointerFile = () => path.join(dataDir(), 'game-current.json');

export function newer(a, b) {   // is version a > b ("1.2.0" style)
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** The game files to serve this session: { version, dir, overlay:Set } — overlay files come from dir, rest from ROOT. */
export function activeGame(ROOT) {
  const bundled = readJson(path.join(ROOT, 'desktop/content.json')) || { version: app.getVersion(), files: {} };
  const p = readJson(pointerFile());
  let active = { version: bundled.version, dir: null, overlay: new Set(), files: bundled.files, bundled };
  if (p && newer(p.version, bundled.version) && fs.existsSync(path.join(p.dir, 'manifest.json'))) {
    const m = readJson(path.join(p.dir, 'manifest.json'));
    if (m) active = { version: m.version, dir: p.dir, overlay: new Set(m.overlay), files: m.files, bundled };
  }
  // tidy up: old update folders (never the one in use)
  try {
    for (const n of fs.readdirSync(dataDir())) {
      const d = path.join(dataDir(), n);
      if (/^game-(\d|staging)/.test(n) && d !== active.dir && fs.statSync(d).isDirectory())
        fs.rmSync(d, { recursive: true, force: true });
    }
  } catch {}
  return active;
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function fetchBuf(url) {
  const r = await net.fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

export async function checkForUpdate(ROOT, active, win) {
  let info;
  try { info = JSON.parse((await fetchBuf(VERSION_URL)).toString('utf8')); }
  catch (e) { console.log('[update] check failed:', e.message); return; }
  if (!info?.version || !newer(info.version, active.version)) { console.log('[update] up to date', active.version); return; }

  if ((info.shell || 1) > SHELL) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info', buttons: ['Open download page', 'Later'], defaultId: 0, cancelId: 1,
      title: 'TorqueForge update', message: `TorqueForge ${info.version} is out`,
      detail: 'This update needs a fresh download of the app (it can\'t update itself this time).' +
        (info.notes ? `\n\nWhat's new:\n${info.notes}` : ''),
    });
    if (response === 0) shell.openExternal(`https://github.com/${REPO}/releases/latest`);
    return;
  }

  const tag = info.tag || `v${info.version}`;
  const staging = path.join(dataDir(), `game-staging-${process.pid}`);
  const final = path.join(dataDir(), `game-${info.version}`);
  fs.rmSync(staging, { recursive: true, force: true });
  const overlay = [];
  const todo = [];
  for (const [rel, hash] of Object.entries(info.files)) {
    if (rel.includes('..') || path.isAbsolute(rel)) continue;
    if (active.bundled.files[rel] === hash) continue;              // the installed app already has it
    overlay.push(rel);
    if (active.dir && active.overlay.has(rel) && active.files[rel] === hash) {
      const dst = path.join(staging, rel);                        // reuse a file from the previous update
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(active.dir, rel), dst);
    } else todo.push([rel, hash]);
  }
  console.log(`[update] ${active.version} -> ${info.version}: ${todo.length} files to download`);

  let done = 0;
  const title = () => win && !win.isDestroyed() &&
    win.setTitle(`TorqueForge — downloading update ${info.version} (${Math.round(100 * done / Math.max(1, todo.length))}%)`);
  title();
  try {
    const queue = todo.slice();
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const [rel, hash] = queue.shift();
        let buf, tries = 0;
        for (;;) {
          try { buf = await fetchBuf(rawUrl(tag, rel)); if (sha256(buf) !== hash) throw new Error(`bad checksum: ${rel}`); break; }
          catch (e) { if (++tries >= 3) throw e; }
        }
        const dst = path.join(staging, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, buf);
        done++; title();
      }
    }));
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ version: info.version, files: info.files, overlay }));
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(staging, final);
    const POINTER = pointerFile();
    fs.writeFileSync(POINTER + '.tmp', JSON.stringify({ version: info.version, dir: final }));
    fs.renameSync(POINTER + '.tmp', POINTER);
  } catch (e) {
    console.log('[update] failed:', e.message);
    fs.rmSync(staging, { recursive: true, force: true });
    if (win && !win.isDestroyed()) win.setTitle('TorqueForge');
    return;
  }
  if (!win || win.isDestroyed()) return;
  win.setTitle('TorqueForge');
  if (process.env.TF_UPDATE_TEST) { console.log('[update] ready', info.version); app.exit(0); return; }
  const { response } = await dialog.showMessageBox(win, {
    type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
    title: 'TorqueForge update', message: `TorqueForge ${info.version} is ready`,
    detail: (info.notes ? `What's new:\n${info.notes}\n\n` : '') + 'Restart now, or it\'ll be used next time you open TorqueForge.',
  });
  if (response === 0) { app.relaunch(); app.exit(0); }
}
