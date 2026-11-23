#!/usr/bin/env node
// Publish a TorqueForge update. Everyone with the desktop app (1.1.0+) gets it automatically on their next launch.
//
//   node tools/release.mjs 1.2.0 "What's new"          build everything, commit, tag, push, GitHub release
//   node tools/release.mjs 1.2.0 "What's new" --dry    build only (no git / upload)
//
// Steps: set package.json version -> desktop/content.json (hashes of the game files the installed app has) ->
// selftest -> build Linux / Windows / macOS -> dist/version.json -> commit + tag v<version> + push -> gh release.
// The app's updater reads releases/latest/download/version.json and downloads changed files from the tag.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashContent, SHELL } from '../desktop/content.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const dry = process.argv.includes('--dry');
const [version, notes = 'New update'] = args;
if (!/^\d+\.\d+\.\d+$/.test(version || '')) { console.error('usage: node tools/release.mjs <x.y.z> "notes" [--dry]'); process.exit(1); }
const tag = `v${version}`;
const run = (cmd, a, env) => { console.log('$', cmd, a.join(' ')); execFileSync(cmd, a, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } }); };

// fpm (deb/rpm) needs libcrypt.so.1, which Fedora doesn't ship by default
// (copy from Fedora's libxcrypt-compat: `dnf download libxcrypt-compat` + rpm2cpio into ~/.cache/torqueforge/libcrypt)
const LIBCRYPT = [process.env.TF_LIBCRYPT_DIR, `${process.env.HOME}/.cache/torqueforge/libcrypt/usr/lib64`]
  .find(d => d && fs.existsSync(path.join(d, 'libcrypt.so.1')));

const pkgFile = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

const files = hashContent(ROOT);
fs.writeFileSync(path.join(ROOT, 'desktop/content.json'), JSON.stringify({ version, files }) + '\n');
console.log(`content: ${Object.keys(files).length} files`);

run('node', ['tools/selftest.mjs']);
for (const f of fs.readdirSync(path.join(ROOT, 'dist'), { withFileTypes: true }))
  if (f.isFile() && !f.name.endsWith('.AppImage')) fs.rmSync(path.join(ROOT, 'dist', f.name));   // keep AppImages (the menu launcher uses one)
run('npx', ['electron-builder', '--linux', 'AppImage', 'deb', 'rpm'], LIBCRYPT ? { LD_LIBRARY_PATH: LIBCRYPT } : {});
run('npx', ['electron-builder', '--win', 'nsis', 'portable']);
run('npx', ['electron-builder', '--mac', 'zip', '--arm64', '--x64']);

const info = { version, tag, shell: SHELL, notes, files };
fs.writeFileSync(path.join(ROOT, 'dist/version.json'), JSON.stringify(info));
const assets = fs.readdirSync(path.join(ROOT, 'dist'))
  .filter(n => /\.(AppImage|deb|rpm|exe|zip)$/.test(n) && n.includes(version) || n === 'version.json')
  .map(n => path.join('dist', n));
console.log('assets:\n  ' + assets.join('\n  '));
if (dry) { console.log('dry run: not committing or uploading'); process.exit(0); }

run('git', ['add', '-A']);
run('git', ['commit', '-m', `TorqueForge ${version}: ${notes.split('\n')[0]}`]);
run('git', ['tag', tag]);
run('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', 'origin', 'HEAD', tag]);
run('gh', ['release', 'create', tag, '--title', `TorqueForge ${version}`, '--notes', notes, ...assets]);
console.log(`released ${tag}`);
