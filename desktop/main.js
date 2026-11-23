// TorqueForge desktop shell (Electron). Serves the game from an app:// protocol (ES modules + fetch work like a website),
// forces the discrete GPU, and optionally removes the VSync / frame-rate limit (setting persisted in userData).
import { app, BrowserWindow, protocol, net, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { activeGame, checkForUpdate } from './updater.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.TF_USERDATA) app.setPath('userData', process.env.TF_USERDATA);   // tests: keep the real profile clean
const SETTINGS = path.join(app.getPath('userData'), 'desktop-settings.json');
const readSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; } };
const settings = { uncapped: false, ...readSettings() };

// GPU: always the high-performance GPU on dual-GPU laptops/desktops
if (!process.env.TF_LOWPOWER) app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
if (settings.uncapped || process.argv.includes('--uncapped')) {
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

function createWindow(game) {
  const win = new BrowserWindow({
    width: 1600, height: 940, minWidth: 1100, minHeight: 680,
    backgroundColor: '#0b0d12', title: 'TorqueForge', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(ROOT, 'desktop/preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => { if (!process.env.TF_HIDDEN) win.show(); });
  win.loadURL('app://game/index.html');
  // auto-update the game files (installed apps only; TF_UPDATE_URL forces it for testing)
  if (!process.env.TF_SHOT && (app.isPackaged || process.env.TF_UPDATE_URL))
    win.webContents.once('did-finish-load', () => checkForUpdate(ROOT, game, win));
  // external links (eBay / Shop / listings / credits) open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) { e.preventDefault(); shell.openExternal(url); } });
  // test hook: TF_SHOT=<file.png> [TF_JS=<js to eval first>] -> wait, report fps, screenshot, quit
  if (process.env.TF_SHOT) win.webContents.once('did-finish-load', async () => {
    await new Promise(r => setTimeout(r, 2500));
    if (process.env.TF_JS) console.log('[eval]', await win.webContents.executeJavaScript(process.env.TF_JS));
    await new Promise(r => setTimeout(r, +(process.env.TF_WAIT || 6000)));
    console.log('[fps]', await win.webContents.executeJavaScript(`(window.__tf?.pipe?.fps||0).toFixed(0) + ' fps @ ' + innerWidth + 'x' + innerHeight + ' dpr ' + devicePixelRatio + ' preset ' + __tf.gfx.preset + ' gpu ' + (()=>{const gl=document.createElement('canvas').getContext('webgl2');const e=gl.getExtension('WEBGL_debug_renderer_info');return gl.getParameter(e.UNMASKED_RENDERER_WEBGL)})()`));
    fs.writeFileSync(process.env.TF_SHOT, (await win.webContents.capturePage()).toPNG());
    app.exit(0);
  });
  win.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen()); });
}

app.whenReady().then(() => {
  const game = activeGame(ROOT);
  console.log('[game] version', game.version, game.dir ? `(updated files in ${game.dir})` : '(as installed)');
  protocol.handle('app', req => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const base = game.dir && game.overlay.has(rel) ? game.dir : ROOT;
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  ipcMain.handle('tf:getUncapped', () => settings.uncapped);
  ipcMain.handle('tf:setUncapped', (e, v) => {
    settings.uncapped = !!v;
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
    fs.writeFileSync(SETTINGS, JSON.stringify(settings));
    app.relaunch(); app.exit(0);
  });
  createWindow(game);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(game); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
