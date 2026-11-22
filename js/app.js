import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { RoomEnvironment } from '../vendor/RoomEnvironment.js';
import { FAMILIES, familyOf, CARS, CAR_BY_ID, SWAPS, PARTS, WHEELS, TIRES, CATEGORIES, CAT_BY_ID, PRICE_NOTE, totalPartCount, stockWheel, stockTire } from './data.js';
import { evaluate, emptyBuild, getPart, candidateCheck, matchTires, migrateSel, swapNeeds, resolveNeeds, TUNE_DEFAULTS, tuneLimits } from './build.js';
import { fullStats, dynoCurve } from './physics.js';
import { DynoRun } from './dyno.js';
import { sfx, loopHum, engineVoice, soundOn } from './sound.js';
import { WindTunnel, tunnelReport } from './tunnel.js';
import { perfIndex, piClass, piBadge, downforce, getRules, onRules, ruleViolations, rulesText } from './pi.js';
import { createCarModel, disposeModel } from './model.js';
import { CIRCUIT } from './track.js';
import { TestDrive } from './drive.js';
import { initCarAssets, loadCarAsset, getCarAsset, hasRealModel, allCredits } from './carassets.js';
import { PRESETS, settings, saveSettings, detectPreset, current as gfxQ, loadEnv, Pipeline } from './gfx.js';

const $ = s => document.querySelector(s);
const fmt$ = n => '$' + Math.round(n).toLocaleString('en-US');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600); }

// ---------------- state ----------------
let sel = loadInitial();
let spec = evaluate(sel);
function loadInitial() {
  const h = location.hash.match(/b=([^&]+)/);
  if (h) { try { const s = decodeSel(h[1]); if (CAR_BY_ID[s.car]) return s; } catch (e) { console.warn(e); } }
  try { const s = JSON.parse(localStorage.getItem('tf_current')); if (s && CAR_BY_ID[s.car]) return normalize(s); } catch (e) { }
  return emptyBuild('gr86');
}
function normalize(s) { s = migrateSel({ ...s }); const b = emptyBuild(s.car); return { ...b, ...s, tuning: { ...b.tuning, ...(s.tuning || {}) } }; }
function encodeSel(s) { return btoa(unescape(encodeURIComponent(JSON.stringify(s)))).replace(/=+$/, ''); }
function decodeSel(str) { return normalize(JSON.parse(decodeURIComponent(escape(atob(str))))); }

// ---------------- renderer + showroom ----------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
renderer.localClippingEnabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
const gpu = detectPreset(renderer);
if (!settings.preset) { settings.preset = gpu.preset; saveSettings(); }
const pipe = new Pipeline(renderer);
pipe.fpsEl = $('#fps');
pipe.apply();
const pmrem = new THREE.PMREMGenerator(renderer);
const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;   // instant fallback until the HDRI loads
let showKey = null;
const show = new THREE.Scene();
show.background = new THREE.Color(0x10131a);
show.environment = envTex;
show.environmentIntensity = 1;
function loadShowEnv() { loadEnv(renderer, 'studio_small_09', gfxQ().env).then(e => { if (e) { show.environment = e.env; show.environmentIntensity = 0.9; } }); }
loadShowEnv();
show.fog = new THREE.Fog(0x10131a, 14, 30);
const showCam = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
showCam.position.set(6.2, 2.3, 6.6);
const controls = new OrbitControls(showCam, renderer.domElement);
controls.target.set(0, 0.55, 0); controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49; controls.minDistance = 3; controls.maxDistance = 14;
{
  const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 64), new THREE.MeshStandardMaterial({ color: 0x1a1d24, roughness: 0.6, metalness: 0.1 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; show.add(floor);
  const disc = new THREE.Mesh(new THREE.RingGeometry(3.3, 3.4, 96), new THREE.MeshBasicMaterial({ color: 0xff5a1f }));
  disc.rotation.x = -Math.PI / 2; disc.position.y = 0.005; show.add(disc);
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(4, 8, 3); key.castShadow = true;
  key.shadow.mapSize.set(gfxQ().shadows || 1024, gfxQ().shadows || 1024); key.shadow.bias = -0.0003; key.shadow.normalBias = 0.02; showKey = key; Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 20 });
  show.add(key);
  show.add(new THREE.HemisphereLight(0xbfd4ff, 0x202020, 0.5));
  const rim = new THREE.DirectionalLight(0xff9a60, 0.8); rim.position.set(-5, 3, -5); show.add(rim);
}
let showModel = null, turntable = true, modelReq = 0;
const turnGroup = new THREE.Group(); show.add(turnGroup);

function placeModel(m, sp = spec) {
  if (showModel) { turnGroup.remove(showModel.root); disposeModel(showModel.root); }
  showModel = m;
  // centre model on wheelbase midpoint
  showModel.root.position.z = -(sp.a - sp.b) / 2;
  turnGroup.add(showModel.root);
  if (tunnelOn) buildTunnel(sp);
}
// ---------------- wind tunnel ----------------
let tunnelOn = false;
const tunnel = new WindTunnel();
function buildTunnel(sp = spec) {
  if (!showModel?.root.visible) return;
  tunnel.build(showModel, sp);
  $('#tunnelHud').innerHTML = tunnelReport(sp);
}
let fanHum = null;
function setTunnel(on) {
  tunnelOn = on;
  $('#tunnelBtn').classList.toggle('active', on);
  $('#tunnelHud').classList.toggle('hidden', !on);
  $('#tuning').classList.toggle('hidden', on);
  if (on) { buildTunnel(); focusCam('tunnel'); } else { tunnel.dispose(); focusCam('three'); savedTurntable = null; }
  if (on && soundOn()) { fanHum?.stop(); fanHum = loopHum('fan'); } else { fanHum?.stop(); fanHum = null; }
}
$('#tunnelBtn').onclick = () => setTunnel(!tunnelOn);
// Real (downloaded) models load async; keep showing the previous model meanwhile.
// sp: spec to show (defaults to the current build; the upgrade shop passes a preview spec)
function rebuildModel(sp = spec) {
  const q = gfxQ(), id = sp.car.id, req = ++modelReq;
  const opts = { paint: sel.color || null, quality: q };
  const cached = getCarAsset(id, q.lod);
  if (cached || !hasRealModel(id)) { const m = createCarModel(sp, { ...opts, paint: opts.paint || (cached ? null : sp.car.color), asset: cached }); m.carId = id; placeModel(m, sp); return; }
  $('#loading').classList.remove('hidden');
  if (!showModel || showModel.carId !== id) { placeModel(createCarModel(sp, { ...opts, paint: opts.paint || sp.car.color }), sp); showModel.root.visible = false; }
  loadCarAsset(id, q.lod).then(asset => {
    if (req !== modelReq) return;
    $('#loading').classList.add('hidden');
    const m = createCarModel(sp, { ...opts, paint: opts.paint || (asset ? null : sp.car.color), asset });
    m.carId = id; placeModel(m, sp);
  });
}

// performance index / class: js/pi.js

// ---------------- camera moves (upgrade shop focuses on the part being fitted) ----------------
const CAM_SHOTS = {
  front: [[3.9, 0.85, 5.3], [0, 0.45, 0.5]], rear: [[-3.9, 1.5, -5.4], [0, 0.6, -0.5]], side: [[6.0, 0.9, 1.0], [0, 0.45, 0]],
  top: [[3.6, 4.0, 3.8], [0, 0.6, 0]], tunnel: [[5.6, 1.5, 0.6], [0, 0.6, -0.6]], three: [[5.0, 1.6, 5.2], [0, 0.55, 0]], cabin: [[4.2, 2.1, -0.8], [0, 0.8, 0]],
};
const CAT_SHOT = { aero_front: 'front', aero_rear: 'rear', body: 'three', weight: 'top', chassis: 'cabin', wheels: 'side', tires: 'side', brakes: 'side', suspension: 'side', exhaust: 'rear', diff: 'rear' };
let camTween = null, savedTurntable = null;
function focusCam(name) {
  const shot = CAM_SHOTS[name]; if (!shot) return;
  const k0 = 1.32; // pull back: only ~2/3 of the viewer is visible next to the shop
  camTween = { t: 0, p0: showCam.position.clone(), t0: controls.target.clone(), p1: new THREE.Vector3(...shot[0]).sub(new THREE.Vector3(...shot[1])).multiplyScalar(k0).add(new THREE.Vector3(...shot[1])), t1: new THREE.Vector3(...shot[1]), r0: turnGroup.rotation.y, r1: Math.round(turnGroup.rotation.y / (Math.PI * 2)) * Math.PI * 2 };
  if (savedTurntable === null) savedTurntable = turntable;
  turntable = false;
}
function stepCam(dt) {
  if (!camTween) return;
  const c = camTween; c.t = Math.min(1, c.t + dt / 0.7);
  const k = c.t * c.t * (3 - 2 * c.t);
  showCam.position.lerpVectors(c.p0, c.p1, k); controls.target.lerpVectors(c.t0, c.t1, k);
  turnGroup.rotation.y = c.r0 + (c.r1 - c.r0) * k;
  if (c.t >= 1) camTween = null;
}

// ---------------- views ----------------
let view = 'build';
let test = null;
function setView(v) {
  // a build with incompatible parts (old save, shared link) can't be driven until it's fixed
  if (v === 'test' && spec.errors) {
    const e = spec.issues.find(i => i.level === 'error');
    toast(`Can't drive: ${spec.errors} incompatible part${spec.errors > 1 ? 's' : ''} — ${e.msg}`);
    if (view !== 'build') setView('build');
    return;
  }
  view = v;
  if (v !== 'build' && tunnelOn) setTunnel(false);
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
  if (v === 'build') { $('#viewer').appendChild(renderer.domElement); controls.enabled = true; test?.stop(); }
  if (v === 'test') {
    $('#testCanvas').appendChild(renderer.domElement); controls.enabled = false;
    if (!test) test = new TestDrive(renderer, { envTex, pipe });
    test.start(spec);
  }
  if (v === 'garage') { test?.stop(); renderGarage(); }
  resize();
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => setView(b.dataset.view));
function resize() {
  const el = view === 'test' ? $('#testCanvas') : $('#viewer');
  if (!el || view === 'garage') return;
  const w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) return;
  pipe.resize(w, h);
  showCam.aspect = w / h;
  const dr = $('#picker'), vr = $('#viewer').getBoundingClientRect();
  const cover = dr.classList.contains('hidden') ? 0 : Math.max(0, dr.getBoundingClientRect().right - vr.left);
  if (cover > 0 && view === 'build') showCam.setViewOffset(w, h, -cover / 2, 0, w, h); else showCam.clearViewOffset();
  showCam.updateProjectionMatrix();
  test?.resize(w, h);
}
addEventListener('resize', resize);

let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  if (!pipe.beginFrame(now)) return;
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (view === 'build') {
    if (turntable) turnGroup.rotation.y += dt * 0.25;
    if (tunnelOn) tunnel.tick(dt, renderer.domElement.clientWidth, renderer.domElement.clientHeight);
    stepCam(dt);
    controls.update();
    pipe.render(show, showCam);
  } else if (view === 'test' && test) test.frame(dt);
}

// ---------------- graphics settings ----------------
const PRESET_NOTES = {
  low: 'For integrated graphics and Apple M1-class laptops. Simplified car models, 1K lighting, no post-processing. Targets 60 fps.',
  medium: 'Balanced. Simplified car models with clear-coat paint, 4× MSAA, 2K shadows.',
  high: 'Full-detail car models, 2K HDR lighting, 4K soft shadows, bloom. For modern discrete GPUs, targets 144 fps+.',
  ultra: 'Everything on: ambient occlusion, refractive glass, 8× MSAA, max wheel detail.',
};
function renderGfx() {
  $('#gpuName').textContent = gpu.gpu ? '· ' + gpu.gpu.replace(/ANGLE \(|\)$/g, '').slice(0, 60) : '';
  $('#gfxPresets').innerHTML = Object.entries(PRESETS).map(([k, p]) => `<button data-p="${k}" class="${settings.preset === k ? 'active' : ''}">${p.label}<small>${k === gpu.preset ? 'recommended' : ''}</small></button>`).join('');
  $('#gfxPresetNote').textContent = PRESET_NOTES[settings.preset] || '';
  const sc = settings.scale ?? gfxQ().scale;
  $('#gfxScale').value = sc; $('#gfxScaleVal').textContent = Math.round(sc * 100) + '%';
  $('#gfxCap').value = String(settings.fpsCap || 0);
  $('#gfxDyn').checked = settings.dynRes; $('#gfxFps').checked = settings.showFps;
  if (window.tfDesktop) { $('#vsyncRow').hidden = false; $('#gfxVsync').checked = !!window.tfDesktop.uncapped; }
  const cr = allCredits();
  $('#credits').innerHTML = cr.length ? cr.map(c => `<div><b>${esc(CAR_BY_ID[c.id]?.make + ' ' + CAR_BY_ID[c.id]?.model)}</b> — “${esc(c.name)}” by ${esc(c.author)} · ${esc(c.license)} · <a href="${esc(c.url)}" target="_blank" rel="noopener">source</a></div>`).join('')
    : '<div>No downloaded car models installed — cars use built-in generated models.</div>';
  $('#credits').insertAdjacentHTML('beforeend', '<div style="margin-top:6px">Environment HDRIs and textures: Poly Haven (CC0).</div>');
}
function applyGfx(rebuild = true) {
  saveSettings();
  pipe.apply(); resize();
  if (showKey) { showKey.shadow.map?.dispose(); showKey.shadow.map = null; showKey.shadow.mapSize.set(gfxQ().shadows || 1024, gfxQ().shadows || 1024); }
  loadShowEnv();
  if (rebuild) { rebuildModel(); test?.applyQuality(); }
  renderGfx();
}
$('#gfxBtn').onclick = () => { renderGfx(); $('#gfxModal').classList.remove('hidden'); };
$('#gfxPresets').onclick = e => { const b = e.target.closest('button'); if (!b) return; settings.preset = b.dataset.p; settings.scale = null; applyGfx(); };
$('#gfxScale').oninput = () => { settings.scale = +$('#gfxScale').value; applyGfx(false); };
$('#gfxCap').onchange = () => { settings.fpsCap = +$('#gfxCap').value; applyGfx(false); };
$('#gfxDyn').onchange = () => { settings.dynRes = $('#gfxDyn').checked; applyGfx(false); };
$('#gfxFps').onchange = () => { settings.showFps = $('#gfxFps').checked; applyGfx(false); };
$('#gfxVsync').onchange = () => { window.tfDesktop?.setUncapped($('#gfxVsync').checked); };

// ---------------- parts list ----------------
function partLabel(cat, id) {
  const p = getPart(cat, id);
  if (!p) return { name: '(unknown)', price: 0 };
  return { name: cat === 'engine' ? p.name : `${p.brand} ${p.name}`, price: p.price };
}
function renderParts() {
  const c = spec.car;
  $('#carCard').innerHTML = `
    <div class="make">${esc(c.make)} · ${esc(c.years)}</div>
    <div class="model">${esc(c.model)}</div>
    <div class="meta">${esc(spec.car.engine.name)} · ${c.engine.hp} hp · ${c.drive} · ${c.mass} kg · ${c.trans.gears.length}-spd ${c.trans.type}</div>
    ${(() => { const f = familyOf(c.id); return f && f.ids.length > 1 ? `<div class="gens" title="Other generations of the ${esc(f.name)}"><span>${esc(f.name)}</span>${f.ids.map(id => { const g = CAR_BY_ID[id]; return `<button data-gen="${id}" class="${id === c.id ? 'on' : ''}" title="${esc(g.model)} · ${esc(g.years)} · ${g.engine.hp} hp">${esc(genLabel(g))}<small>${esc(g.years.slice(0, 4))}</small></button>`; }).join('')}</div>` : ''; })()}
    <div class="pirow">${(() => { const st = evaluate(emptyBuild(c.id)), a = perfIndex(st), b = perfIndex(spec); return a === b ? `${piBadge(b)} Performance class` : `Stock ${piBadge(a)}<span class="pi-arrow">→</span>Your build ${piBadge(b)}`; })()}</div>
    <div class="cprice"><span><b>${fmt$(c.price)}</b> <small>${PRICE_NOTE}</small></span><button id="chgCar">Change car</button></div>
    <div style="margin-top:6px"><a class="find" target="_blank" rel="noopener" href="${carSearchUrl(c)}">Find listings ↗</a><a class="find" target="_blank" rel="noopener" href="https://bringatrailer.com/search/?s=${encodeURIComponent(c.make + ' ' + c.model)}">BaT sold results ↗</a></div>`;
  $('#chgCar').onclick = openCarPicker;
  $('#carCard').querySelectorAll('[data-gen]').forEach(b => b.onclick = () => { if (b.dataset.gen !== spec.car.id) switchCar(b.dataset.gen); });
  let html = '', group = '';
  const gsum = {};
  for (const cat of CATEGORIES) {
    const ids = cat.multi ? (sel[cat.id] || []) : (sel[cat.id] ? [sel[cat.id]] : []);
    gsum[cat.group] = (gsum[cat.group] || 0) + ids.reduce((a, id) => a + partLabel(cat.id, id).price, 0);
  }
  // short "what it does" line for each installed category (build with vs without that category)
  const effect = catId => {
    const s0 = evaluate({ ...sel, [catId]: CAT_BY_ID[catId].multi ? [] : null }), b = spec, out = [];
    const d = (v, txt) => { if (v) out.push(txt); };
    const dh = Math.round(b.engine.hp - s0.engine.hp), dm = Math.round(b.mass - s0.mass);
    d(dh, `${dh > 0 ? '+' : ''}${dh} hp`); d(dm, `${dm > 0 ? '+' : ''}${dm} kg`);
    const dg = b.tire.mu - s0.tire.mu; if (Math.abs(dg) > 0.004) out.push(`grip ${dg > 0 ? '+' : ''}${dg.toFixed(2)}`);
    const dd = Math.round(downforce(b) - downforce(s0)); if (Math.abs(dd) > 2) out.push(`${dd > 0 ? '+' : ''}${dd} kg DF`);
    const dp = perfIndex(b) - perfIndex(s0); if (dp) out.unshift(`PI ${dp > 0 ? '+' : ''}${dp}`);
    return out.slice(0, 3).join(' · ');
  };
  for (const cat of CATEGORIES) {
    if (cat.group !== group) { group = cat.group; html += `<div class="group-title"><span>${group}</span>${gsum[group] ? `<span class="gs">${fmt$(gsum[group])}</span>` : ''}</div>`; }
    const iss = spec.issues.filter(i => i.cat === cat.id && i.level !== 'ok');
    const cls = iss.some(i => i.level === 'error') ? 'err' : iss.length ? 'warn' : '';
    let body = '', price = '', has = false;
    if (cat.multi) {
      const ids = sel[cat.id] || [];
      if (!ids.length) body = `<div class="pn none">+ Add ${cat.name.toLowerCase()}</div>`;
      else {
        has = true;
        body = ids.map(id => `<span class="chip">${esc(partLabel(cat.id, id).name)} <span class="x" data-rm="${cat.id}" data-id="${id}">✕</span></span>`).join('');
        price = fmt$(ids.reduce((s, id) => s + partLabel(cat.id, id).price, 0));
      }
    } else {
      const id = sel[cat.id];
      if (id) { has = true; const l = partLabel(cat.id, id); body = `<div class="pn">${esc(l.name)}</div>`; price = fmt$(l.price) + `<span class="x" data-rm="${cat.id}">✕</span>`; }
      else if (cat.id === 'wheels') body = `<div class="pn none">Stock: ${esc(stockWheel(spec.car).name)}</div>`;
      else if (cat.id === 'tires') body = `<div class="pn none">Stock: ${esc(stockTire(spec.car).name)}</div>`;
      else if (cat.id === 'engine') body = `<div class="pn none">Stock: ${esc(spec.car.engine.name)}</div>`;
      else body = `<div class="pn none">+ Choose ${cat.name.toLowerCase()}</div>`;
    }
    const eff = has ? effect(cat.id) : '';
    html += `<div class="prow ${cls} ${has ? 'has' : ''}" data-cat="${cat.id}" title="${esc(iss.map(i => i.msg).join('\n'))}">
      <div class="ic">${cat.icon}</div><div><div class="cn">${cat.name}${iss.length ? (cls === 'err' ? ' ⛔' : ' ⚠️') : ''}</div>${body}${eff ? `<div class="eff">${eff}</div>` : ''}</div><div class="pp">${price}</div></div>`;
  }
  $('#partList').innerHTML = html;
  $('#partList').querySelectorAll('.prow').forEach(r => r.onclick = e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { e.stopPropagation(); removePart(rm.dataset.rm, rm.dataset.id); return; }
    openPicker(r.dataset.cat);
  });
}
// would taking this part off leave something else without what it needs? (toasts the reason)
function removalBreaks(cat, id) {
  const pid = id ?? sel[cat];
  if (!pid) return false;
  const without = selWithout(cat, pid);
  if (cat === 'wheels' && sel.tires) { const t = matchTires(without); if (t !== undefined) without.tires = t; }
  const key = i => i.cat + '|' + i.msg.replace(/[\d.,]+/g, '#');
  const before = new Set(spec.issues.filter(i => i.level === 'error').map(key));
  const broken = evaluate(without).issues.filter(i => i.level === 'error' && !before.has(key(i)));
  if (broken.length) { toast(`Can't remove ${partLabel(cat, pid).name}: ${broken[0].msg}`); return true; }
  return false;
}
function removePart(cat, id) {
  // don't leave the build broken: a part other parts depend on (fuel system for a turbo, forged internals for boost...)
  if (removalBreaks(cat, id)) return;
  if (CAT_BY_ID[cat].multi) sel[cat] = sel[cat].filter(x => x !== id);
  else sel[cat] = null;
  if (cat === 'wheels' && sel.tires) autoTire();
  if (soundOn()) sfx.remove();
  update();
}

// ---------------- stats ----------------
let stockStats = null, stockFor = null, statsTimer = null, lastStats = null;
function renderStats() {
  const s = spec;
  // compatibility
  const errs = s.issues.filter(i => i.level === 'error'), warns = s.issues.filter(i => i.level === 'warn'), oks = s.issues.filter(i => i.level === 'ok');
  const col = errs.length ? 'var(--err)' : warns.length ? 'var(--warn)' : 'var(--ok)';
  const txt = errs.length ? `${errs.length} compatibility problem${errs.length > 1 ? 's' : ''}` : warns.length ? `Compatible — ${warns.length} note${warns.length > 1 ? 's' : ''}` : 'All parts compatible';
  $('#compat').innerHTML = `<h4>Compatibility</h4><div class="status"><span class="dot" style="background:${col}"></span>${txt}</div>
    <ul>${[...errs, ...warns, ...oks].map(i => `<li class="${i.level}">${esc(CAT_BY_ID[i.cat]?.name || '')}: ${esc(i.msg)}</li>`).join('')}</ul>`;
  // price
  const rows = [['Base car', s.carPrice]];
  for (const cat of CATEGORIES) {
    const ids = cat.multi ? sel[cat.id] : (sel[cat.id] ? [sel[cat.id]] : []);
    const sum = ids.reduce((a, id) => a + partLabel(cat.id, id).price, 0);
    if (sum) rows.push([cat.name, sum]);
  }
  $('#price').innerHTML = `<h4>Price</h4><div class="pricebig">${fmt$(s.totalPrice)}</div><small>${PRICE_NOTE} · parts ${fmt$(s.partsPrice)}</small>
    <table class="kv" style="margin-top:6px">${rows.map(r => `<tr><td class="d">${r[0]}</td><td>${fmt$(r[1])}</td></tr>`).join('')}</table>`;
  $('#topTotal').textContent = fmt$(s.totalPrice);
  // specs vs stock
  if (stockFor !== s.car.id) { stockFor = s.car.id; stockSpecCache = evaluate(emptyBuild(s.car.id)); stockStats = null; }
  const st = stockSpecCache;
  const delta = (v, base, digits = 0, invert = false, unit = '') => {
    const d = v - base; if (Math.abs(d) < Math.pow(10, -digits) / 2) return '';
    const good = invert ? d < 0 : d > 0;
    return `<span class="${good ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d.toFixed(digits)}${unit}</span>`;
  };
  const df = v => -(v.aero.clF + v.aero.clR) * 0.5 * 1.225 * v.aero.A * (200 / 3.6) ** 2 / 9.81;
  $('#specs').innerHTML = `<h4>Specs <small>vs stock</small></h4><table class="kv">
    <tr><td class="d">Engine</td><td>${esc(s.engine.name)}</td></tr>
    <tr><td class="d">Power</td><td>${Math.round(s.engine.hp)} hp${delta(s.engine.hp, st.engine.hp)}</td></tr>
    <tr><td class="d">Torque</td><td>${Math.round(s.engine.tq)} Nm${delta(s.engine.tq, st.engine.tq)}</td></tr>
    <tr><td class="d">Engine sound</td><td>${engineVoice(s).label}</td></tr>
    <tr><td class="d">Aspiration</td><td>${{ na: 'Naturally aspirated', turbo: 'Turbocharged', sc: 'Supercharged', ev: 'Electric' }[s.engine.asp]}</td></tr>
    <tr><td class="d">Weight</td><td>${Math.round(s.mass)} kg${delta(s.mass, st.mass, 0, true)}</td></tr>
    <tr><td class="d">Power / weight</td><td>${(s.engine.hp / s.mass * 1000).toFixed(0)} hp/t${delta(s.engine.hp / s.mass * 1000, st.engine.hp / st.mass * 1000)}</td></tr>
    <tr><td class="d">Weight dist. F/R</td><td>${(s.wdF * 100).toFixed(1)} / ${(100 - s.wdF * 100).toFixed(1)}</td></tr>
    <tr><td class="d">CG height</td><td>${(s.cgH * 1000).toFixed(0)} mm${delta(s.cgH * 1000, st.cgH * 1000, 0, true)}</td></tr>
    <tr><td class="d">Drive wheels</td><td>${s.drive}${s.drive === 'AWD' ? ` (${Math.round(s.awdSplit * 100)}:${Math.round(100 - s.awdSplit * 100)})` : ''}</td></tr>
    <tr><td class="d">Gearbox</td><td>${s.trans.gears.length}-spd ${s.trans.type} · FD ${s.trans.final.toFixed(2)}</td></tr>
    <tr><td class="d">Drag coeff. Cd</td><td>${s.aero.cd.toFixed(3)}${delta(s.aero.cd, st.aero.cd, 3, true)}</td></tr>
    <tr><td class="d">Downforce @200 km/h</td><td>${df(s).toFixed(0)} kg${delta(df(s), df(st))}</td></tr>
    <tr><td class="d">Aero balance (front)</td><td>${(s.aero.clF + s.aero.clR) < -0.01 ? (s.aero.clF / (s.aero.clF + s.aero.clR) * 100).toFixed(0) + '%' : 'lift'}</td></tr>
    <tr><td class="d">Tires</td><td>${esc(s.tireItem.name)}</td></tr>
    <tr><td class="d">Tire grip μ</td><td>${s.tire.mu.toFixed(2)}${delta(s.tire.mu, st.tire.mu, 2)}</td></tr>
    <tr><td class="d">Rotating mass / corner</td><td>${(s.wheel.wheelMass + s.tireItem.tireMass).toFixed(1)} kg${delta(s.wheel.wheelMass + s.tireItem.tireMass, st.wheel.wheelMass + st.tireItem.tireMass, 1, true)}</td></tr>
    <tr><td class="d">Ride height</td><td>${s.rideDrop > 0 ? '−' + s.rideDrop : s.rideDrop < 0 ? '+' + (-s.rideDrop) : '±0'} mm</td></tr>
    </table>`;
  $('#perf').innerHTML = `<h4>Performance <small>simulated</small></h4><div class="calc">Running simulations…</div>`;
  drawDyno();
  clearTimeout(statsTimer);
  statsTimer = setTimeout(runSims, 60);
}
let stockSpecCache = null;
function runSims() {
  const s = spec;
  if (!stockStats) stockStats = fullStats(stockSpecCache, CIRCUIT);
  const r = fullStats(s, CIRCUIT), b = stockStats;
  lastStats = r;
  const t = (v, bv, unit = 's', d = 2) => v == null ? '—' : `${v.toFixed(d)}${unit}${bv != null && Math.abs(v - bv) >= Math.pow(10, -d) ? `<span class="${v < bv ? 'up' : 'down'}">${v - bv > 0 ? '+' : ''}${(v - bv).toFixed(d)}</span>` : ''}`;
  const hi = (v, bv, unit, d = 0) => `${v.toFixed(d)}${unit}${Math.abs(v - bv) >= Math.pow(10, -d) ? `<span class="${v > bv ? 'up' : 'down'}">${v - bv > 0 ? '+' : ''}${(v - bv).toFixed(d)}</span>` : ''}`;
  const lap = x => `${Math.floor(x / 60)}:${(x % 60).toFixed(2).padStart(5, '0')}`;
  const warnTxt = s.errors ? `<div class="calc" style="color:var(--err)">⛔ Build has compatibility errors — numbers are hypothetical.</div>` : '';
  $('#perf').innerHTML = `<h4>Performance <small>simulated, with driver</small></h4>${warnTxt}<table class="kv">
    <tr><td class="d">0–60 mph</td><td>${t(r.drag.t60, b.drag.t60)}</td></tr>
    <tr><td class="d">0–100 km/h</td><td>${t(r.drag.t100k, b.drag.t100k)}</td></tr>
    <tr><td class="d">0–100 mph</td><td>${t(r.drag.t100m, b.drag.t100m)}</td></tr>
    <tr><td class="d">0–200 km/h</td><td>${t(r.drag.t200k, b.drag.t200k)}</td></tr>
    <tr><td class="d">¼ mile</td><td>${t(r.drag.quarter, b.drag.quarter)} @ ${(r.drag.trap * 2.237).toFixed(0)} mph</td></tr>
    <tr><td class="d">Top speed</td><td>${hi(r.top.v * 3.6, b.top.v * 3.6, ' km/h')}${r.top.gearLimited ? ' <small>(gear-limited)</small>' : ''}</td></tr>
    <tr><td class="d">100–0 km/h braking</td><td>${t(r.brake.dist, b.brake.dist, ' m', 1)}</td></tr>
    <tr><td class="d">Skidpad (61 m)</td><td>${hi(r.skid.g, b.skid.g, ' g', 2)} <small>${r.skid.limit}</small></td></tr>
    <tr><td class="d">Test circuit lap</td><td>${lap(r.lap.time)}${Math.abs(r.lap.time - b.lap.time) > 0.005 ? `<span class="${r.lap.time < b.lap.time ? 'up' : 'down'}">${r.lap.time - b.lap.time > 0 ? '+' : ''}${(r.lap.time - b.lap.time).toFixed(2)}</span>` : ''}</td></tr>
    <tr><td class="d">Drag force @200 km/h</td><td>${r.drag200.toFixed(0)} N</td></tr>
    </table><small>0–60 uses 1-ft rollout like magazine tests. Lap: 2.48 km test circuit.</small>`;
}

function drawDyno() {
  const cv = $('#dyno'), g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const cur = dynoCurve(spec), base = dynoCurve(stockSpecCache);
  const maxR = Math.max(spec.engine.redline, stockSpecCache.engine.redline);
  const maxHp = Math.max(...cur.map(p => p.hp), ...base.map(p => p.hp)) * 1.1;
  const maxTq = Math.max(...cur.map(p => p.tq), ...base.map(p => p.tq)) * 1.1;
  const X = r => 28 + (r / maxR) * (W - 56), Yh = v => H - 18 - v / maxHp * (H - 30), Yt = v => H - 18 - v / maxTq * (H - 30);
  g.strokeStyle = '#272c38'; g.lineWidth = 1; g.fillStyle = '#8b93a5'; g.font = '10px system-ui';
  for (let r = 0; r <= maxR; r += maxR > 10000 ? 4000 : 1000) { g.beginPath(); g.moveTo(X(r), 8); g.lineTo(X(r), H - 18); g.stroke(); g.fillText((r / 1000) + 'k', X(r) - 6, H - 5); }
  const line = (pts, key, Y, color, dash) => { g.setLineDash(dash ? [4, 4] : []); g.strokeStyle = color; g.lineWidth = dash ? 1.3 : 2.2; g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(X(p.rpm), Y(p[key])) : g.moveTo(X(p.rpm), Y(p[key]))); g.stroke(); };
  line(base, 'hp', Yh, '#ff5a1f88', true); line(base, 'tq', Yt, '#3fa9f588', true);
  line(cur, 'hp', Yh, '#ff5a1f'); line(cur, 'tq', Yt, '#3fa9f5');
  g.setLineDash([]);
  g.fillStyle = '#ff5a1f'; g.fillText(`${Math.round(spec.engine.hp)} hp`, 32, 16);
  g.fillStyle = '#3fa9f5'; g.fillText(`${Math.round(Math.max(...cur.map(p => p.tq)))} Nm`, 92, 16);
}

// ---------------- tuning ----------------
// setup sheet: [section, key, label, min, max, step, format, lock(spec, lim) -> reason when not adjustable, live (no model rebuild)]
const sgn = v => (v > 0 ? '+' : '') + v;
const TUNES = [
  ['Brakes', 'brakeBias', 'Brake bias', 0.5, 0.8, 0.01, v => Math.round(v * 100) + '% F', null, true],
  ['Tyres', 'pressF', 'Pressure front', 24, 40, 0.5, v => v.toFixed(1) + ' psi', null, true],
  ['Tyres', 'pressR', 'Pressure rear', 24, 40, 0.5, v => v.toFixed(1) + ' psi', null, true],
  ['Alignment', 'camberF', 'Camber front', -4, 0, 0.1, v => v.toFixed(1) + '°', null, true],
  ['Alignment', 'camberR', 'Camber rear', -4, 0, 0.1, v => v.toFixed(1) + '°', null, true],
  ['Alignment', 'toeF', 'Toe front', -0.4, 0.4, 0.05, v => v === 0 ? '0°' : `${Math.abs(v).toFixed(2)}° ${v > 0 ? 'in' : 'out'}`, null, true],
  ['Alignment', 'toeR', 'Toe rear', -0.4, 0.4, 0.05, v => v === 0 ? '0°' : `${Math.abs(v).toFixed(2)}° ${v > 0 ? 'in' : 'out'}`, null, true],
  ['Suspension', 'rollBal', 'Roll balance', -1, 1, 0.05, v => v > 0.02 ? 'stiffer front' : v < -0.02 ? 'stiffer rear' : 'neutral', (sp, l) => !l.roll && 'Add coilovers or sway bars', true],
  ['Suspension', 'rideH', 'Ride height', -30, 30, 1, v => { const h = v - (spec.rideNom || 0); return (h === 0 ? '±0' : sgn(h)) + ' mm vs stock'; }, (sp, l) => !l.rideH && 'Needs adjustable coilovers / air', false],
  ['Suspension', 'springs', 'Spring rate', 0.6, 1.5, 0.05, v => Math.round(v * 100) + '%', (sp, l) => !l.springs && 'Needs adjustable coilovers / air', true],
  ['Drivetrain', 'diffLock', 'Diff lock', 0, 1, 0.05, v => Math.round(v * 100) + '%', (sp, l) => !l.diff && (sp.sel.diff === 'spool' ? 'Welded diff: always locked' : 'Needs an aftermarket LSD'), true],
  ['Engine', 'boost', 'Boost', 0, 1, 0.05, v => '+' + Math.round(v * 14) + '% power', (sp, l) => !l.boost && (sp.engine.asp === 'na' || sp.engine.asp === 'ev' ? 'Turbo / supercharged engines only' : 'Needs an ECU tune'), true],
  ['Aero', 'wingAngle', 'Wing angle', 0, 1, 0.05, v => Math.round(3 + v * 14) + '°', (sp, l) => !l.wing && 'No adjustable wing fitted', false],
];
function renderTuning() {
  if (document.activeElement?.dataset?.k && document.activeElement.closest('#tuneBody')) return;   // mid-drag: keep the slider
  const t = sel.tuning = { ...TUNE_DEFAULTS, ...sel.tuning }, lim = tuneLimits(spec);
  let html = '', sec = '';
  for (const [s, key, label, min, max, step, fmt, lock] of TUNES) {
    if (s !== sec) { html += `<div class="tsec">${s}</div>`; sec = s; }
    const why = lock && lock(spec, lim);
    let lo = min, hi = max;
    if (key.startsWith('camber')) [lo, hi] = lim.camber;
    if (key === 'rideH' && lim.rideRange) [lo, hi] = [-lim.rideRange[1], -lim.rideRange[0]];
    const v = Math.max(lo, Math.min(hi, t[key]));
    html += `<label>${label} <span>${why ? '—' : fmt(v)}</span><input type="range" data-k="${key}" min="${lo}" max="${hi}" step="${step}" value="${v}" ${why ? 'disabled' : ''}></label>`;
    if (why) html += `<div class="tlock">🔒 ${why}</div>`;
    else if (key === 'camberR' && !lim.camberKit) html += `<div class="tlock">Stock bolts: −0.3° to −1.8°. A camber kit or coilovers open it to −4°.</div>`;
  }
  $('#tuneBody').innerHTML = html;
  $('#tuneBody').querySelectorAll('input[data-k]').forEach(inp => {
    const row = TUNES.find(r => r[1] === inp.dataset.k);
    inp.oninput = () => { sel.tuning[row[1]] = +inp.value; inp.parentElement.querySelector('span').textContent = row[6](+inp.value); update(false); };
    inp.onchange = () => { inp.blur(); if (!row[8]) update(); else renderTuning(); };
  });
}
$('#tuneHead').onclick = e => { if (e.target.id !== 'tuneReset') $('#tuning').classList.toggle('collapsed'); };
$('#tuneReset').onclick = () => { sel.tuning = { ...TUNE_DEFAULTS }; update(); renderTuning(); };
// ---------------- paint shop ----------------
const BODY_SW = ['#f4f4f2', '#c9ccd1', '#8a8f98', '#3b3f46', '#0d0e10', '#c8102e', '#9b1b30', '#ff5a1f', '#ffb020', '#ffd000', '#9acd32', '#1f8a4c', '#00b4d8', '#1f4fa8', '#14213d', '#7b2ff7'];
const STRIPE_SW = ['#ffffff', '#0d0e10', '#c8102e', '#ffb020', '#1f4fa8', '#c9ccd1', '#2ecc71', '#ff5a1f'];
const WHEEL_SW = [null, '#d7d9dc', '#5a5e66', '#141518', '#a0703a', '#c9a227', '#f4f4f2', '#c8102e'];
const FIN = { gloss: 'Gloss', metallic: 'Metallic', pearl: 'Pearl', candy: 'Candy', satin: 'Satin', matte: 'Matte', chrome: 'Chrome' };
function renderPaint() {
  const cur = sel.color || spec.car.color;
  $('#paintChip').style.background = cur; $('#paint').value = cur;
  $('#psBody').innerHTML = BODY_SW.map(c => `<button data-c="${c}" style="background:${c}" class="${c === sel.color ? 'on' : ''}" title="${c}"></button>`).join('');
  $('#psFinish').innerHTML = `<button data-f="" class="${!sel.finish ? 'on' : ''}">Factory</button>` + Object.entries(FIN).map(([k, l]) => `<button data-f="${k}" class="${sel.finish === k ? 'on' : ''}">${l}</button>`).join('');
  $('#psStripes').innerHTML = [['none', 'None'], ['racing', 'Racing stripes'], ['side', 'Side stripe'], ['both', 'Both']].map(([k, l]) => `<button data-s="${k}" class="${(sel.stripes || 'none') === k ? 'on' : ''}">${l}</button>`).join('');
  $('#psStripeCol').style.display = sel.stripes && sel.stripes !== 'none' ? '' : 'none';
  $('#psStripeCol').innerHTML = STRIPE_SW.map(c => `<button data-sc="${c}" style="background:${c}" class="${(sel.stripeColor || '#ffffff') === c ? 'on' : ''}"></button>`).join('');
  $('#psWheel').innerHTML = WHEEL_SW.map(c => c ? `<button data-w="${c}" style="background:${c}" class="${sel.wheelColor === c ? 'on' : ''}"></button>` : `<button data-w="" class="def ${!sel.wheelColor ? 'on' : ''}" title="Wheel's own finish">std</button>`).join('');
}
const repaint = () => { if (soundOn()) sfx.install('paint'); saveCurrent(); renderPaint(); update(); };
$('#paintBtn').onclick = () => { $('#paintShop').classList.toggle('hidden'); renderPaint(); };
$('#paintClose').onclick = () => $('#paintShop').classList.add('hidden');
$('#paintShop').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.c) { sel.color = b.dataset.c; repaint(); }
  else if (b.dataset.f !== undefined) { sel.finish = b.dataset.f || null; repaint(); }
  else if (b.dataset.s) { sel.stripes = b.dataset.s === 'none' ? null : b.dataset.s; repaint(); }
  else if (b.dataset.sc) { sel.stripeColor = b.dataset.sc; repaint(); }
  else if (b.dataset.w !== undefined) { sel.wheelColor = b.dataset.w || null; repaint(); }
};
$('#paint').oninput = e => {
  sel.color = e.target.value;
  if (showModel.paintMats?.length) for (const m of showModel.paintMats) { m.color.set(sel.color); if (m.map) { m.map = null; m.needsUpdate = true; } }
  else showModel.materials.paint.color.set(sel.color);
  $('#paintChip').style.background = sel.color;
  saveCurrent();
};
$('#paint').onchange = () => repaint();
$('#paintReset').onclick = () => { sel.color = null; sel.finish = null; sel.stripes = null; sel.wheelColor = null; repaint(); };
// ---------------- dyno run ----------------
let dyno = null;
$('#dynoBtn').onclick = () => {
  $('#dynoModal').classList.remove('hidden');
  dyno ||= new DynoRun($('#dynoBig'), $('#dynoOut'));
  $('#dynoCar').textContent = '· ' + (sel.name ? sel.name + ' — ' : '') + `${spec.car.make} ${spec.car.model} · ${spec.engine.name}`;
  requestAnimationFrame(() => { dyno.setup(spec, stockSpecCache, $('#dynoSound').checked); dyno.start(); });
};
$('#dynoGo').onclick = () => { dyno.sound = $('#dynoSound').checked; dyno.start(); };
$('#spinBtn').onclick = () => { turntable = !turntable; $('#spinBtn').textContent = turntable ? '⟳ Turntable' : '⟳ Turntable (off)'; };
$('#nameInput').oninput = e => { sel.name = e.target.value; saveCurrent(); };
$('#testBtn').onclick = () => setView('test');
$('#resetBtn').onclick = () => { sel = emptyBuild(sel.car); update(); toast('Build reset to stock'); };

// ---------------- update ----------------
function saveCurrent() { try { localStorage.setItem('tf_current', JSON.stringify(sel)); } catch (e) { } }
function update(model = true) {
  spec = evaluate(sel);
  renderParts(); renderStats(); renderTuning();
  if (model) rebuildModel();
  $('#paint').value = sel.color || spec.car.color; $('#paintChip').style.background = sel.color || spec.car.color;
  $('#nameInput').value = sel.name || '';
  saveCurrent();
}

// ---------------- part picker ----------------
let pick = null;
function itemsFor(cat) {
  if (cat === 'engine') return Object.values(SWAPS).map(s => ({ ...s, id: s.code, cat: 'engine', brand: 'Swap kit' }));
  if (cat === 'wheels') return [stockWheel(spec.car), ...WHEELS];
  if (cat === 'tires') return [stockTire(spec.car), ...TIRES];
  return PARTS.filter(p => p.cat === cat);
}
const pct = x => `${x > 0 ? '+' : ''}${Math.round(x * 100)}%`;
// one-line plain-English explanation of every category (shown at the top of the shop drawer)
const CAT_HELP = {
  ecu: 'Re-programs the engine computer. Small gains on non-turbo engines, big gains on turbo/supercharged ones.',
  intake: 'Lets the engine breathe in more easily. Modest power on its own; helps tunes and boost.',
  exhaust: 'Lets the engine breathe out. A bit more power and a louder sound.',
  fuel: 'Bigger injectors and pump. Needed once you add a lot of power, or the engine runs lean.',
  cooling: 'Radiator, oil cooler, intercooler. Keeps power consistent lap after lap; intercoolers are needed for big boost.',
  trans: 'Clutch and gearbox. Must be rated for your torque, or it slips. Sequentials and DCTs shift faster.',
  driveline: 'Driveshaft, flywheel, launch control. Faster shifts, quicker revving, better starts.',
  diff: 'Limited-slip differential. Puts power down out of corners instead of spinning the inside wheel.',
  final: 'Final drive ratio. Higher number = quicker acceleration but lower top speed.',
  suspension: 'Springs, dampers, ride height. Lower and stiffer = more cornering grip; coilovers unlock roll-balance tuning.',
  chassis: 'Braces and cages stiffen the body so the suspension can do its job. A cage also changes the interior.',
  brakes: 'Bigger brakes stop harder and fade less on track. Large kits need bigger wheels.',
  aero_front: 'Splitters and canards add front downforce. Balance them with a rear wing.',
  aero_rear: 'Wings add rear downforce (grip at speed) but also drag (lower top speed). Wing angle is in Tuning.',
  body: 'Wider fenders fit wider tires; carbon panels save weight. These change how the car looks.',
  weight: 'Less weight = faster everywhere. Stripped interiors and bucket seats change the cabin you see in cockpit view.',
};
function keySpecs(cat, p) {
  switch (cat) {
    case 'engine': return `${p.hp} hp · ${p.tq} Nm · ${p.cfg} · ${p.redline} rpm · ${p.mass} kg · ${p.trans.gears.length}-spd ${p.trans.type}`;
    case 'forced': return `${pct(p.fi.hp)} hp · ${pct(p.fi.tq)} torque · ${{ turbo: 'turbo', twin: 'twin-turbo', roots: 'roots supercharger', screw: 'twin-screw supercharger', centrifugal: 'centrifugal supercharger' }[p.fi.kind] || p.fi.asp}${p.desc ? ' · ' + p.desc : ''}`;
    case 'internals': return [p.hpNA ? `NA ${pct(p.hpNA)}` : null, p.hpBoost ? `boosted ${pct(p.hpBoost)}` : null, p.rev ? `${p.rev > 0 ? '+' : ''}${p.rev} rpm redline` : null, p.boostTol ? 'stronger bottom end' : null, p.desc].filter(Boolean).join(' · ');
    case 'ecu': case 'intake': case 'exhaust': case 'fuel': case 'cooling':
      return [p.hpEV ? `EV ${pct(p.hpEV)}` : null, p.hpNA ? `NA ${pct(p.hpNA)}` : null, p.hpBoost ? `Boosted ${pct(p.hpBoost)}` : null, p.fuel ? 'fuel capacity ↑' : null, p.ic ? 'intercooler' : null, p.cooling ? 'cooling ↑' : null].filter(Boolean).join(' · ') || '—';
    case 'trans': return `Rated ${p.rating} Nm${p.shiftTime ? ` · ${Math.round(p.shiftTime * 1000)} ms shifts` : ''}`;
    case 'driveline': return [p.shiftDelta ? `shifts ${Math.round(p.shiftDelta * 1000)} ms` : null, p.inertiaMul ? `rotating inertia ${pct(p.inertiaMul - 1)}` : null, p.launch ? 'optimal launch rpm' : null].filter(Boolean).join(' · ');
    case 'diff': return `Lock ${Math.round(p.lsd.lock * 100)}%${p.lsd.preload < 9000 ? ` · preload ${p.lsd.preload} Nm` : ''} · ${p.desc}`;
    case 'final': return `Ratio ×${p.finalMul} — ${p.finalMul > 1 ? 'quicker accel, lower top speed' : 'higher top speed'}`;
    case 'wheels': return `${p.dia}"×${p.width}" · ${p.type || 'OEM'} · ${p.wheelMass} kg each · ${p.bolts.includes(spec.car.wheel.bolt) ? spec.car.wheel.bolt + ' ✓' : p.bolts.slice(0, 3).join(', ') + (p.bolts.length > 3 ? '…' : '')}`;
    case 'tires': return `${p.type} · grip ${p.mu.toFixed(2)}${p.lng > 1 ? ` (launch ${(p.mu * p.lng).toFixed(2)})` : ''} · ${p.dia.toFixed(1)}" tall · ${p.tireMass} kg · TW ${p.treadwear ?? '—'}`;
    case 'suspension': { const mm = d => (d > 0 ? '−' : '+') + Math.abs(d) + ' mm';
      if (p.adjustable && p.rideRange) return `height ${mm(p.rideDrop + p.rideRange[1])} to ${mm(p.rideDrop + p.rideRange[0])} (adjustable) · grip ${pct(p.grip)}`;
      return `${mm(p.rideDrop)} ride height · grip ${pct(p.grip)}${p.adjustable ? ' · adjustable' : ''}`; }
    case 'chassis': return `grip ${pct(p.grip)}${p.swayBars ? ' · unlocks roll balance' : ''}`;
    case 'brakes': return `Torque ×${p.brake.torque} · fade +${p.brake.fade}°C${p.brake.minWheel ? ` · needs ${p.brake.minWheel}"+ wheels` : ''}`;
    case 'aero_front': case 'aero_rear': case 'body':
      return [p.clF ? `front Cl ${p.clF}` : null, p.clR ? `rear Cl ${p.clR}` : null, p.cd ? `Cd ${p.cd > 0 ? '+' : ''}${p.cd}` : null, p.tireBonus ? `+${p.tireBonus} mm tire room` : null].filter(Boolean).join(' · ');
    case 'weight': return `${p.mass} kg`;
  }
  return '';
}
function perfScore(cat, p) {
  switch (cat) {
    case 'engine': return p.hp;
    case 'forced': return p.fi.hp;
    case 'tires': return p.mu * (p.lng || 1);
    case 'wheels': return -p.wheelMass;
    case 'brakes': return p.brake.torque;
    case 'suspension': case 'chassis': return p.grip || 0;
    case 'aero_front': return -(p.clF || 0);
    case 'aero_rear': return -(p.clR || 0);
    case 'body': return -((p.clF || 0) + (p.clR || 0)) - (p.cd || 0);
    case 'weight': return -p.mass;
    case 'trans': return p.rating;
    case 'diff': return p.lsd.lock;
    default: return (p.hpBoost || 0) + (p.hpNA || 0) + (p.hpEV || 0);
  }
}
function findUrls(cat, p) {
  const q = cat === 'engine' ? p.name.split(' + ')[0] + ' swap' : cat === 'wheels' ? `${p.brand} ${p.name}` : cat === 'tires' ? `${p.brand} ${p.name}` : `${p.brand} ${p.name} ${spec.car.make} ${spec.car.model}`;
  return {
    shop: `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(q)}`,
    ebay: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1`,
  };
}
function carSearchUrl(c) { return `https://www.google.com/search?q=${encodeURIComponent(`used ${c.make} ${c.model} ${c.years} for sale`)}`; }

const VISUAL = new Set(['wheels', 'tires', 'brakes', 'suspension', 'aero_front', 'aero_rear', 'body', 'weight', 'chassis']);
const TIERS = ['Street', 'Sport', 'Race', 'Pro'];
// a selection with the conversion parts an engine swap needs added (fabrication is multi, drivetrain single)
const SUPPORT_RESOLVE = new Set(['forced', 'internals', 'ecu', 'gearbox', 'trans', 'fuel', 'cooling', 'intake', 'exhaust', 'diff', 'final']);
function withNeeds(s0, needs) {
  const s2 = { ...s0, tuning: { ...s0.tuning }, fab: [...(s0.fab || [])] };
  for (const n of needs) { const p = PARTS.find(x => x.id === n); if (!p) continue; if (CAT_BY_ID[p.cat].multi) s2[p.cat] = [...new Set([...(s2[p.cat] || []), n])]; else s2[p.cat] = n; }
  return s2;
}
function selWith(cat, id) {   // build selection with this part installed (single: replace, multi: add)
  const s2 = { ...sel, tuning: { ...sel.tuning } };
  if (CAT_BY_ID[cat].multi) s2[cat] = [...new Set([...(sel[cat] || []), id])]; else s2[cat] = id;
  return s2;
}
function selWithout(cat, id) {
  const s2 = { ...sel, tuning: { ...sel.tuning } };
  if (CAT_BY_ID[cat].multi) s2[cat] = (sel[cat] || []).filter(x => x !== id); else s2[cat] = null;
  return s2;
}
// stat changes between two evaluated builds, as small coloured chips
function deltaChips(a, b, cat) {
  const out = [];
  const ch = (d, txt, goodUp = true, eps = 0.5) => { if (Math.abs(d) < eps) return; out.push(`<span class="dchip ${(d > 0) === goodUp ? 'up' : 'down'}">${txt}</span>`); };
  ch(b.engine.hp - a.engine.hp, `${b.engine.hp > a.engine.hp ? '+' : ''}${Math.round(b.engine.hp - a.engine.hp)} hp`);
  ch(b.engine.tq - a.engine.tq, `${b.engine.tq > a.engine.tq ? '+' : ''}${Math.round(b.engine.tq - a.engine.tq)} Nm`, true, 3);
  ch(b.mass - a.mass, `${b.mass > a.mass ? '+' : ''}${Math.round(b.mass - a.mass)} kg`, false);
  const mu = v => v.tire.mu;
  ch(mu(b) - mu(a), `grip ${mu(b) > mu(a) ? '+' : ''}${(mu(b) - mu(a)).toFixed(2)}`, true, 0.004);
  ch(downforce(b) - downforce(a), `${downforce(b) > downforce(a) ? '+' : ''}${Math.round(downforce(b) - downforce(a))} kg downforce`, true, 2);
  ch(b.aero.cd - a.aero.cd, `drag ${b.aero.cd > a.aero.cd ? '+' : ''}${(b.aero.cd - a.aero.cd).toFixed(3)}`, false, 0.0015);
  ch(b.brakes.torque - a.brakes.torque, `braking ${b.brakes.torque > a.brakes.torque ? '+' : ''}${Math.round((b.brakes.torque / a.brakes.torque - 1) * 100)}%`, true, 0.005);
  ch((b.trans.shiftTime - a.trans.shiftTime) * 1000, `shifts ${Math.round((b.trans.shiftTime - a.trans.shiftTime) * 1000)} ms`, false, 4);
  ch(a.rideDrop - b.rideDrop, `ride ${b.rideDrop > a.rideDrop ? '−' : '+'}${Math.abs(b.rideDrop - a.rideDrop)} mm`, false, 1);
  const pa = perfIndex(a), pb = perfIndex(b);
  if (pa !== pb) out.unshift(`<span class="dchip ${pb > pa ? 'up' : 'down'}">PI ${pb > pa ? '+' : ''}${pb - pa}</span>`);
  if (VISUAL.has(cat) && !['tires'].includes(cat)) out.push('<span class="dchip vis">👁 visible on car</span>');
  return out.join('');
}
function renderTabs(cat) {
  const group = CAT_BY_ID[cat].group;
  const groups = [...new Set(CATEGORIES.map(c => c.group))];
  const count = c => c.multi ? (sel[c.id] || []).length : (sel[c.id] ? 1 : 0);
  let html = '<div class="dr-groups">' + groups.map(g => {
    const n = CATEGORIES.filter(c => c.group === g).reduce((a, c) => a + count(c), 0);
    return `<button data-group="${esc(g)}" class="${g === group ? 'on' : ''}">${esc(g)}${n ? `<span class="n">${n}</span>` : ''}</button>`;
  }).join('') + '</div><div class="dr-cats">';
  for (const c of CATEGORIES.filter(c => c.group === group)) {
    const n = count(c);
    html += `<button data-tab="${c.id}" class="${c.id === cat ? 'on' : ''}">${c.icon} ${c.name}${n ? `<span class="n">${n}</span>` : ''}</button>`;
  }
  $('#pickTabs').innerHTML = html + '</div>';
  $('#pickTabs').querySelectorAll('[data-tab]').forEach(b => b.onclick = () => openPicker(b.dataset.tab, true));
  $('#pickTabs').querySelectorAll('[data-group]').forEach(b => b.onclick = () => openPicker(CATEGORIES.find(c => c.group === b.dataset.group).id, true));
}
function renderPickFoot(after) {
  const piA = perfIndex(spec);
  let html = `<span class="lbl">Current build</span> ${piBadge(piA)} <b>${Math.round(spec.engine.hp)} hp</b> · <b>${Math.round(spec.mass)} kg</b> · <b>${fmt$(spec.totalPrice)}</b>`;
  if (after) {
    const piB = perfIndex(after.spec);
    html = `<span class="lbl">With ${esc(after.name)}</span> ${piBadge(piA)}<span class="pi-arrow">→</span>${piBadge(piB)} <b>${Math.round(after.spec.engine.hp)} hp</b> · <b>${Math.round(after.spec.mass)} kg</b> · <b>${fmt$(after.spec.totalPrice)}</b>`;
  }
  $('#pickFoot').innerHTML = html;
}
function openPicker(cat, keepSearch = false) {
  const c = CAT_BY_ID[cat];
  const items = itemsFor(cat);
  const wheelDia = spec.wheel.dia;
  // compatibility + resulting build for every candidate (fast pre-filters for the big generated catalogs)
  const checked = items.map(p => {
    if (p.stock) {
      if (cat === 'tires' && p.rim !== wheelDia) return { p, level: 'error', msgs: [`Stock tires are R${p.rim}; your wheels are ${wheelDia}"`] };
      return { p, level: 'ok', msgs: [], spec: evaluate(selWithout(cat, sel[cat])) };
    }
    if (cat === 'wheels' && !p.bolts.includes(spec.car.wheel.bolt)) return { p, level: 'error', msgs: [`Bolt pattern doesn't fit ${spec.car.wheel.bolt}`] };
    if (cat === 'wheels' && (p.dia < spec.car.wheel.min - 0 || p.dia > spec.car.wheel.max + 1)) return { p, level: 'error', msgs: [`${p.dia}" outside ${spec.car.wheel.min}–${spec.car.wheel.max}" fitment`] };
    if (cat === 'tires' && p.rim !== wheelDia) return { p, level: 'error', msgs: [`R${p.rim} tire — your wheels are ${wheelDia}"`] };
    const installed = c.multi ? (sel[cat] || []).includes(p.id) : sel[cat] === p.id;
    if (cat === 'engine' && !installed) {
      const n = swapNeeds(sel, p.id);
      if (n.blocked) return { p, level: 'error', msgs: [`Won't fit: ${n.blocked}`] };
      if (n.needs.length) {
        const r = candidateCheck(withNeeds(sel, n.needs), cat, p.id);
        if (r.level !== 'error') return { p, level: 'warn', conv: n.needs, msgs: [`No bolt-in kit — needs ${n.needs.map(x => PARTS.find(q => q.id === x)?.name).join(' + ')} (added when you install)`, ...r.msgs], spec: r.spec };
      }
    }
    const r = candidateCheck(sel, cat, p.id);
    if (r.level === 'error' && !installed && SUPPORT_RESOLVE.has(cat)) {
      const res = resolveNeeds(sel, cat, p.id);
      if (res) return { p, level: 'warn', conv: res.needs, msgs: [`Needs supporting mods: ${res.needs.map(x => PARTS.find(q => q.id === x)?.name).join(' + ')} (added when you install)`], spec: res.spec };
    }
    // installed: show what it contributes (build without it -> current); otherwise current -> with it
    return { p, level: r.level, msgs: r.msgs, spec: r.spec, base: installed ? evaluate(selWithout(cat, p.id)) : null };
  });
  // performance tiers by rank within the category
  const ranked = checked.filter(r => !r.p.stock).map(r => perfScore(cat, r.p)).sort((a, b) => a - b);
  for (const r of checked) if (!r.p.stock && ranked.length > 3) { const i = ranked.indexOf(perfScore(cat, r.p)); r.tier = Math.min(3, Math.floor(i / ranked.length * 4)); }
  pick = { cat, checked };
  $('#pickTitle').textContent = `${c.icon} ${c.name}`;
  $('#pickPI').innerHTML = piBadge(perfIndex(spec));
  if (!keepSearch) $('#pickSearch').value = '';
  $('#pickNote').innerHTML = {
    wheels: `Fitment for ${esc(spec.car.model)}: bolt pattern <b>${spec.car.wheel.bolt}</b>, ${spec.car.wheel.min}–${spec.car.wheel.max}" diameter. Prices are per set of 4. Changing diameter auto-matches tires. Hover a wheel to preview it on the car.`,
    tires: `Showing sizes for your ${wheelDia}"×${spec.wheel.width}" wheels. Stock size ${stockTire(spec.car).name.replace('OEM ', '')}. Prices per set of 4.`,
    engine: `Engine swaps include engine, gearbox, mounts, harness and labor. Proven swaps bolt in; others are allowed as custom jobs (+fabrication cost) if the engine fits.`,
    forced: `<b>Turbo</b>: big power, kicks in once it spools. <b>Roots / twin-screw supercharger</b>: instant torque off idle. <b>Centrifugal (ProCharger, Vortech)</b>: boost builds with rpm. Big kits need fuel, intercooler and forged internals.`,
    internals: `What's inside the engine. <b>Forged pistons/rods</b> and a <b>billet crank</b> let it survive big boost. <b>Heads, cams, valves</b> make more power; cams need <b>valve springs</b> to rev higher. A <b>stroker</b> adds torque but lowers the redline.`,
  }[cat] || `${CAT_HELP[cat] ? CAT_HELP[cat] + ' ' : ''}${VISUAL.has(cat) ? 'Hover a part to preview it on your car. ' : ''}${c.multi ? 'You can install several.' : ''}`;
  let f = '';
  if (cat === 'wheels') {
    const dias = [...new Set(WHEELS.map(w => w.dia))].sort((a, b) => a - b);
    f = `<select id="fDia"><option value="">All sizes</option>${dias.map(d => `<option>${d}</option>`).join('')}</select>`;
  }
  if (cat === 'tires') {
    const models = [...new Map(TIRES.map(t => [t.model, t.type])).entries()];
    f = `<select id="fModel"><option value="">All compounds</option>${models.map(([m, t]) => `<option value="${m}">${esc(TIRES.find(x => x.model === m).brand + ' — ' + t)}</option>`).join('')}</select>`;
  }
  $('#pickFilters').innerHTML = f;
  $('#pickFilters').querySelectorAll('select').forEach(s => s.onchange = renderPickList);
  const wasHidden = $('#picker').classList.contains('hidden');
  $('#picker').classList.remove('hidden');
  if (wasHidden) { document.body.classList.add('shop-open'); requestAnimationFrame(resize); }
  renderTabs(cat);
  renderPickFoot(null);
  focusCam(CAT_SHOT[cat] || 'three');
  renderPickList();
  if (!keepSearch) $('#pickSearch').focus();
}
function renderPickList() {
  if (!pick) return;
  const { cat, checked } = pick;
  const c = CAT_BY_ID[cat];
  const q = $('#pickSearch').value.toLowerCase().trim();
  const compatOnly = $('#pickCompat').checked;
  const sort = $('#pickSort').value;
  const fDia = $('#fDia')?.value, fModel = $('#fModel')?.value;
  let rows = checked.filter(r => (!compatOnly || r.level !== 'error') &&
    (!q || `${r.p.brand} ${r.p.name}`.toLowerCase().includes(q)) &&
    (!fDia || String(r.p.dia) === fDia) && (!fModel || r.p.model === fModel));
  const key = { price: r => r.p.price, '-price': r => -r.p.price, name: r => 0, perf: r => -perfScore(cat, r.p) }[sort];
  rows.sort((a, b) => (a.p.stock ? -1 : 0) - (b.p.stock ? -1 : 0) || (sort === 'name' ? `${a.p.brand} ${a.p.name}`.localeCompare(`${b.p.brand} ${b.p.name}`) : key(a) - key(b)));
  const total = rows.length;
  rows = rows.slice(0, 150);
  const current = c.multi ? (sel[cat] || []) : [sel[cat] || 'stock'];
  const html = rows.map((r, i) => {
    const p = r.p, isSel = current.includes(p.stock ? 'stock' : p.id) && !(c.multi && p.stock);
    const urls = p.stock ? null : findUrls(cat, p);
    const sw = p.color && cat === 'wheels' ? `<span class="swatch" style="background:${p.color}"></span>` : '';
    const deltas = r.spec ? (isSel && r.base ? deltaChips(r.base, spec, cat) : deltaChips(spec, r.spec, cat)) : '';
    const tier = r.tier != null ? `<span class="tier t${r.tier}">${TIERS[r.tier]}</span>` : '';
    const btn = isSel ? (c.multi ? 'Remove' : '✓ Installed') : (p.stock ? 'Use stock' : r.conv ? 'Install…' : 'Install');
    return `<div class="pcard ${isSel ? 'sel' : ''} ${r.level === 'error' ? 'bad' : ''}" data-i="${i}" data-id="${p.stock ? '' : p.id}">
      <div><div class="brand">${sw}${esc(p.stock ? 'Factory' : p.brand)} ${tier}</div><div class="nm">${esc(p.name)}</div><div class="ks">${esc(keySpecs(cat, p))}${p.mass != null && cat !== 'wheels' && cat !== 'tires' && p.mass ? ` · ${p.mass > 0 ? '+' : ''}${p.mass} kg` : ''}</div></div>
      <div class="rt"><div class="pr">${p.stock ? 'Included' : fmt$(p.price)}</div><button class="addbtn ${isSel ? '' : 'cta'}" ${r.level === 'error' && !isSel ? 'disabled' : ''}>${btn}</button></div>
      ${deltas ? `<div class="deltas">${isSel && r.base ? '<span class="dchip">installed:</span>' : ''}${deltas}</div>` : ''}
      <div class="foot"><span class="badge ${r.level}">${r.level === 'ok' ? '✓ Compatible' : r.conv ? (cat === 'engine' ? '🔧 Needs conversion' : '🔧 Needs supporting mods') : r.level === 'warn' ? '⚠ Caution' : '⛔ Incompatible'}</span>${r.msgs.length ? `<span class="why">${esc(r.msgs.join(' · '))}</span>` : ''}
      ${urls ? `<span style="margin-left:auto"><a class="find" href="${urls.ebay}" target="_blank" rel="noopener">eBay sold ↗</a><a class="find" href="${urls.shop}" target="_blank" rel="noopener">Shop ↗</a></span>` : ''}</div></div>`;
  }).join('');
  $('#pickList').innerHTML = html + `<div class="calc" style="padding:6px 2px">${total} ${total === 1 ? 'item' : 'items'}${total > 150 ? ' (showing 150, refine the search)' : ''}${compatOnly ? ' · untick "Compatible only" to see everything' : ''}</div>`;
  $('#pickList').querySelectorAll('.pcard').forEach(card => {
    const r = rows[+card.dataset.i];
    card.querySelector('.addbtn').onclick = () => choose(cat, card.dataset.id || null);
    card.onmouseenter = () => previewPart(cat, r);
  });
  $('#pickList').onmouseleave = () => previewPart(cat, null);
}
// live preview: hovering a card shows that part on the 3D car (and the resulting stats in the footer)
let previewTimer = null, previewing = false;
function previewPart(cat, r) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    if (!pick) return;
    if (!r || !r.spec || r.level === 'error') { renderPickFoot(null); if (previewing) { previewing = false; rebuildModel(); } return; }
    const installed = CAT_BY_ID[cat].multi ? (sel[cat] || []).includes(r.p.id) : (sel[cat] || null) === (r.p.stock ? null : r.p.id);
    renderPickFoot(installed ? null : { name: r.p.stock ? 'stock part' : r.p.name, spec: r.spec });
    if (!VISUAL.has(cat) || installed) { if (previewing) { previewing = false; rebuildModel(); } return; }
    previewing = true; rebuildModel(r.spec);
  }, 90);
}
function choose(cat, id) {
  const c = CAT_BY_ID[cat];
  // never install something that doesn't fit (the button is disabled too; this covers every other path)
  const adding = id && !(c.multi ? (sel[cat] || []).includes(id) : sel[cat] === id);
  if (!adding && (c.multi || !id) && removalBreaks(cat, c.multi ? id : sel[cat])) return;
  if (adding && cat === 'engine') {
    const n = swapNeeds(sel, id);
    if (n.blocked) { if (soundOn()) sfx.remove?.(); toast(`Can't install: ${n.blocked}`); return; }
    if (n.needs.length) {
      const s2 = withNeeds(sel, n.needs), r = candidateCheck(s2, cat, id);
      if (r.level === 'error') { if (soundOn()) sfx.remove?.(); toast(`Can't install: ${r.msgs[0] || 'not compatible with this build'}`); return; }
      askConversion(id, n, () => { Object.assign(sel, withNeeds(sel, n.needs)); choose(cat, id); });
      return;
    }
  }
  if (adding && cat !== 'engine' && SUPPORT_RESOLVE.has(cat) && candidateCheck(sel, cat, id).level === 'error') {
    const res = resolveNeeds(sel, cat, id);
    if (res) {
      const p = PARTS.find(q => q.id === id);
      askConversion({ title: 'Supporting mods needed', text: `The ${p.brand} ${p.name} won't run safely on this build as it is. Install it with the parts it needs?`, main: { name: `${p.brand} ${p.name}`, price: p.price }, needs: res.needs },
        () => { Object.assign(sel, withNeeds(sel, res.needs)); choose(cat, id); });
      return;
    }
  }
  if (adding) {
    const r = candidateCheck(sel, cat, id);
    if (r.level === 'error') { if (soundOn()) sfx.remove?.(); toast(`Can't install: ${r.msgs[0] || 'not compatible with this build'}`); return; }
  }
  if (c.multi) {
    const arr = sel[cat] || [];
    sel[cat] = arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id];
  } else sel[cat] = id;
  if (cat === 'wheels') autoTire();
  if (soundOn()) { const added = c.multi ? sel[cat].includes(id) : !!id; added ? sfx.install(cat) : sfx.remove(); }
  previewing = false;
  update();
  openPicker(cat, true);   // stay in the shop: refresh cards, deltas and tabs
  toast(id ? `Installed ${partLabel(cat, id).name}` : `Back to stock ${c.name.toLowerCase()}`);
}
// popup before a swap that needs conversion work: lists the engine + each job with its price, installs all on yes
function askConversion(code, n, onYes) {
  if (typeof code === 'object') return showConversion(code, n);
  const s = SWAPS[code], big = n.needs.includes('fab_bay'), rwd = n.needs.includes('dt_fwd2rwd');
  return showConversion({ title: rwd ? 'Drivetrain conversion needed' : big ? 'Engine bay mods needed' : 'Mount conversion needed',
    text: `There's no bolt-in kit for the ${s.name.split(' + ')[0]} in the ${spec.car.make} ${spec.car.model}` + (rwd ? ', and it sits longitudinally, so the car has to be converted to rear drive.' : big ? ', and it is too big for the stock bay.' : ', but it physically fits with custom mounts.') + ' Install the engine with the work it needs?',
    main: { name: s.name, price: s.price }, needs: n.needs }, onYes);
}
function showConversion(o, onYes) {
  const parts = o.needs.map(x => PARTS.find(q => q.id === x)).filter(Boolean);
  $('#convTitle').textContent = o.title; $('#convText').textContent = o.text;
  $('#convList').innerHTML = [`<li><b>${esc(o.main.name)}</b> — ${fmt$(o.main.price)}</li>`, ...parts.map(p => `<li>${esc(p.brand ? p.brand + ' ' : '')}${esc(p.name)} — ${fmt$(p.price)}${p.desc ? `<br><small>${esc(p.desc)}</small>` : ''}</li>`)].join('');
  $('#convTotal').textContent = `Total ${fmt$(o.main.price + parts.reduce((a, p) => a + p.price, 0))}`;
  const m = $('#convModal'); m.classList.remove('hidden');
  const close = () => m.classList.add('hidden');
  $('#convNo').onclick = close;
  $('#convYes').onclick = () => { close(); onYes(); };
}
// when the wheels change, match a tire of the same compound in a size that fits (same logic the compatibility check uses)
function autoTire() {
  const t = matchTires(sel);
  if (t === undefined || t === sel.tires) return;
  sel.tires = t;
  if (t) { const tt = TIRES.find(x => x.id === t); setTimeout(() => toast(`Auto-matched tires: ${tt.brand} ${tt.name}`), 50); }
  else setTimeout(() => toast('Stock tires restored'), 50);
}
$('#pickSearch').oninput = renderPickList;
$('#pickCompat').onchange = renderPickList;
$('#pickSort').onchange = renderPickList;
function closeModals() {
  const wasPick = !!pick;
  dyno?.stop();
  document.querySelectorAll('.modal, .drawer').forEach(m => m.classList.add('hidden')); pick = null;
  clearTimeout(previewTimer);
  if (previewing) { previewing = false; rebuildModel(); }
  document.body.classList.remove('shop-open');
  if (wasPick) resize();
  if (wasPick && savedTurntable !== null) { const restore = savedTurntable; focusCam('three'); savedTurntable = null; turntable = restore; }
}
document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModals);
document.querySelectorAll('.modal').forEach(m => m.onclick = e => { if (e.target === m) closeModals(); });
addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });

// ---------------- car picker ----------------
// short generation name: chassis code in brackets if there is one, else the years
const genLabel = c => (c.model.match(/\(([^)]+)\)/) || [])[1] || (c.model.match(/\b(I{1,3}|IV|VI{0,3}|IX|X)$/) || [])[1] || c.years.slice(0, 4);
// new car = new build (parts are chassis-specific), but keep the paint job and the build name
function switchCar(id) {
  const hadParts = CATEGORIES.some(c => c.multi ? sel[c.id]?.length : sel[c.id]);
  const keep = { color: sel.color, finish: sel.finish, stripes: sel.stripes, stripeColor: sel.stripeColor, wheelColor: sel.wheelColor };
  sel = Object.assign(emptyBuild(id), keep);
  update();
  toast(hadParts ? `New build: ${CAR_BY_ID[id].model} (previous parts cleared)` : `Selected ${CAR_BY_ID[id].make} ${CAR_BY_ID[id].model}`);
}
function openCarPicker() {
  $('#carPicker').classList.remove('hidden');
  $('#carSearch').value = '';
  renderCarGrid();
  $('#carSearch').focus();
}
function renderCarGrid() {
  const q = $('#carSearch').value.toLowerCase(), dr = $('#carDrive').value, so = $('#carSort').value;
  let list = CARS.filter(c => (!q || `${c.make} ${c.model} ${c.engine.name}`.toLowerCase().includes(q)) && (!dr || c.drive === dr));
  const k = { price: c => c.price, '-price': c => -c.price, '-hp': c => -c.engine.hp, make: c => 0 }[so];
  const lineKey = c => { const f = familyOf(c.id); return f ? `${FAMILIES.indexOf(f).toString().padStart(3, '0')}${f.ids.indexOf(c.id)}` : `999${c.make}${c.model}`; };
  if (so === 'line') list.sort((a, b) => lineKey(a).localeCompare(lineKey(b)));
  else list.sort((a, b) => so === 'make' ? `${a.make}${a.model}`.localeCompare(`${b.make}${b.model}`) : k(a) - k(b));
  $('#carGrid').innerHTML = list.map(c => `<div class="ccard" data-id="${c.id}"><div class="stripe" style="background:${c.color}"></div>
    <div class="make">${esc(c.make)} · ${esc(c.years)}</div><div class="model">${esc(c.model)}</div>
    <div class="meta">${esc(c.engine.name)}<br>${c.engine.hp} hp · ${c.engine.tq} Nm · ${c.mass} kg · ${(c.engine.hp / c.mass * 1000).toFixed(0)} hp/t</div>
    <div class="tags">${(() => { const f = familyOf(c.id); return f && f.ids.length > 1 ? `<span class="gen">Gen ${f.ids.indexOf(c.id) + 1}/${f.ids.length}</span>` : ''; })()}<span>${c.drive}</span><span>${c.body}</span><span>${c.wheel.bolt}</span>${c.swaps.length ? `<span>${c.swaps.length} swap${c.swaps.length > 1 ? "s" : ""}</span>` : ''}</div>
    <div class="p" style="margin-top:6px">${fmt$(c.price)} <small>avg</small></div></div>`).join('');
  $('#carGrid').querySelectorAll('.ccard').forEach(el => el.onclick = () => { closeModals(); switchCar(el.dataset.id); });
}
$('#carSearch').oninput = renderCarGrid; $('#carDrive').onchange = renderCarGrid; $('#carSort').onchange = renderCarGrid;

// ---------------- garage ----------------
function builds() { try { return JSON.parse(localStorage.getItem('tf_builds')) || []; } catch (e) { return []; } }
function saveBuilds(b) { localStorage.setItem('tf_builds', JSON.stringify(b)); }
$('#saveBtn').onclick = () => {
  const b = builds();
  const name = sel.name || `${spec.car.model} build`;
  const entry = { id: Date.now().toString(36), name, sel: JSON.parse(JSON.stringify(sel)), savedAt: Date.now(),
    summary: (() => { const st = fullStats(spec, CIRCUIT); return { car: `${spec.car.make} ${spec.car.model}`, hp: Math.round(spec.engine.hp), mass: Math.round(spec.mass), price: spec.totalPrice, lap: st.lap.time, t60: st.drag.t60 }; })() };
  const i = b.findIndex(x => x.name === name);
  if (i >= 0) b[i] = entry; else b.unshift(entry);
  saveBuilds(b); toast(`Saved "${name}"`);
};
function shareUrl(s) { return location.href.split('#')[0] + '#b=' + encodeSel(s); }
$('#shareBtn').onclick = async () => {
  const url = shareUrl(sel);
  history.replaceState(null, '', url);
  try { await navigator.clipboard.writeText(url); toast('Share link copied to clipboard'); } catch (e) { toast('Link is in the address bar'); }
};
function renderGarage() {
  const b = builds();
  const lap = x => x ? `${Math.floor(x / 60)}:${(x % 60).toFixed(2).padStart(5, '0')}` : '—';
  $('#garageList').innerHTML = b.length ? b.map(x => `<div class="gcard" data-id="${x.id}"><h3>${esc(x.name)}</h3><div class="meta">${esc(x.summary.car)} · saved ${new Date(x.savedAt).toLocaleDateString()}</div>
    <table class="kv"><tr><td class="d">Power</td><td>${x.summary.hp} hp</td></tr><tr><td class="d">Weight</td><td>${x.summary.mass} kg</td></tr>
    <tr><td class="d">0–60</td><td>${x.summary.t60 ? x.summary.t60.toFixed(2) + 's' : '—'}</td></tr><tr><td class="d">Lap</td><td>${lap(x.summary.lap)}</td></tr><tr><td class="d">Total</td><td>${fmt$(x.summary.price)}</td></tr></table>
    <div class="btns"><button data-a="load" class="cta">Open</button><button data-a="test">Test</button><button data-a="share">Link</button><button data-a="del" class="ghost">Delete</button></div></div>`).join('')
    : '<p style="color:var(--dim)">No saved builds yet. Build something and hit 💾 Save.</p>';
  $('#garageList').querySelectorAll('.gcard').forEach(card => card.querySelectorAll('button').forEach(btn => btn.onclick = async () => {
    const all = builds(), x = all.find(y => y.id === card.dataset.id);
    if (btn.dataset.a === 'load') { sel = normalize(x.sel); update(); setView('build'); }
    if (btn.dataset.a === 'test') { sel = normalize(x.sel); update(); setView('test'); }
    if (btn.dataset.a === 'share') { try { await navigator.clipboard.writeText(shareUrl(x.sel)); toast('Link copied'); } catch (e) { toast(shareUrl(x.sel)); } }
    if (btn.dataset.a === 'del') { saveBuilds(all.filter(y => y.id !== x.id)); renderGarage(); }
  }));
}

// ---------------- boot ----------------
$('#dbCount').textContent = `${CARS.length} cars · ${totalPartCount().toLocaleString()} parts`;
$('#viewer').appendChild(renderer.domElement);
update();
resize();
new ResizeObserver(resize).observe($('#viewer'));
new ResizeObserver(resize).observe($('#testCanvas'));
initCarAssets().then(() => { rebuildModel(); requestAnimationFrame(loop); });
window.__tf = { pipe, gfx: settings, applyGfx, get spec() { return spec; }, get sel() { return sel; }, setView, evaluate, cam: showCam, controls, turn: turnGroup, setTurntable: v => { turntable = v; }, update: () => update(), get test() { return test; }, get model() { return showModel; }, openPicker: (c) => openPicker(c) };
