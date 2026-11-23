// Minimal headless-Chrome driver for smoke tests: node tools/cdp.mjs <url> <script.json>
// script: [{eval: "js"}, {wait: ms}, {shot: "file.png"}, {key: "w", down: true}]
import { spawn } from 'node:child_process';
import fs, { writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
const [url, scriptFile, outDir = '.'] = process.argv.slice(2);
const steps = JSON.parse(readFileSync(scriptFile, 'utf8'));
const port = +(process.env.CDP_PORT || 9333);
const PROF = fs.mkdtempSync(os.tmpdir() + '/tf-chrome-');
const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${port}`, '--mute-audio', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + PROF, '--window-size=1600,900', ...(process.env.CDP_GPU ? ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit', '--disable-gpu-vsync'] : ['--enable-unsafe-swiftshader', '--use-angle=swiftshader']), 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pend = new Map();
for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); const j = await r.json(); const pg = j.find(t => t.type === 'page'); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch (e) { } await sleep(200); }
await new Promise(r => ws.onopen = r);
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  if (d.method === 'Runtime.consoleAPICalled') console.log('[console.' + d.params.type + ']', d.params.args.map(a => a.value ?? a.description).join(' '));
  if (d.method === 'Runtime.exceptionThrown') console.log('[EXCEPTION]', d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text, d.params.exceptionDetails.url || '', d.params.exceptionDetails.lineNumber);
  if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') console.log('[log]', d.params.entry.text, d.params.entry.url || ''); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url }); await sleep(2500);
for (const st of steps) {
  if (st.eval) { const r = await send('Runtime.evaluate', { expression: st.eval, awaitPromise: true, returnByValue: true }); console.log('[eval]', JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description)); }
  if (st.wait) await sleep(st.wait);
  if (st.key) await send('Input.dispatchKeyEvent', { type: st.down ? 'keyDown' : 'keyUp', key: st.key, code: st.code || ('Key' + st.key.toUpperCase()), text: st.down ? st.key : undefined });
  if (st.shot) { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(outDir + '/' + st.shot, Buffer.from(r.result.data, 'base64')); console.log('[shot]', st.shot); }
}
ws.close(); chrome.kill();
await new Promise(r => setTimeout(r, 400)); try { fs.rmSync(PROF, { recursive: true, force: true }); } catch {}
process.exit(0);
