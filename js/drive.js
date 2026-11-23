// Test track: drivable 3D world with circuit, drag strip, pace car (dirty air), wind, HUD, engine audio.
import * as THREE from '../vendor/three.module.js';
import { Vehicle, lapSim, dragTest } from './physics.js';
import { createCarModel, disposeModel } from './model.js';
import { CIRCUIT, TRACKS, DRAG, nearest, lateral, poseOnGround } from './track.js';
import { Damage } from './damage.js';
import { collideWalls, collideCars, collideKinematic } from './collide.js';
import { CARS, CAR_BY_ID } from './data.js';
import { evaluate, emptyBuild } from './build.js';
import { loadCarAsset, getCarAsset, hasRealModel } from './carassets.js';
import { current as gfxQ, loadEnv } from './gfx.js';
import { TrackScenery } from './trackscene.js';
import { DragScene, STRIP, DRAG_MARKS, DRAG_DISTANCES, onStrip, stripEnd } from './dragscene.js';
import { RaceControl, AIDriver, pickOpponents, fmtRace } from './race.js';
import { Net } from './net.js';
import { CarAudio, sfx, soundOn, setSoundOn } from './sound.js';
import { getRules, setRules, onRules, ruleViolations, rulesText, BUDGETS, CLASS_LIMITS } from './pi.js';

const texLoader = new THREE.TextureLoader();
function pbrTex(file, repeat, srgb) {
  const t = texLoader.load('assets/tex/' + file);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = gfxQ().anisotropy;
  return t;
}

const $ = s => document.querySelector(s);
const CAMS = ['chase', 'far', 'cockpit', 'hood', 'bumper', 'tv', 'heli'];
const DT = 1 / 500;

function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (repeat) t.repeat.set(repeat[0], repeat[1]);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function noise(g, w, h, base, amp, n = 9000) {
  g.fillStyle = base; g.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) { const v = Math.random() * amp - amp / 2; g.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 255})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
}

export class TestDrive {
  constructor(renderer, { envTex, pipe }) {
    this.r = renderer;
    this.pipe = pipe;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9cc8ff);
    this.scene.fog = new THREE.Fog(0x9cc8ff, 450, 3200);
    this.scene.environment = envTex;
    this.cam = new THREE.PerspectiveCamera(60, 1, 0.1, 4500);
    this.keys = {};
    this.camName = localStorage.getItem('tf_cam') || 'chase';
    this.audio = new CarAudio();
    this.running = false;
    this.T = TRACKS[localStorage.getItem('tf_track')] || CIRCUIT;
    this.wet = localStorage.getItem('tf_weather') === 'wet';
    this.buildWorld();
    this.bindUI();
    addEventListener('keydown', e => {
      if (!this.running || e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
      // driving keys never go to whatever button/slider was last clicked
      if (document.activeElement && document.activeElement !== document.body && !(e.target.tagName === 'INPUT' && e.target.type === 'text')) document.activeElement.blur();
      const k = e.key.toLowerCase();
      if (!this.keys[k]) {
        // manual shifting: E up, Q down (W/S always drive, so WASD works in every gearbox mode)
        if (k === 'e') this.edgeUp = true;
        if (k === 'q') this.edgeDown = true;
        if (k === 'c') this.setCam(CAMS[(CAMS.indexOf(this.camName) + 1) % CAMS.length]);
        if (k === 'r') this.reset();
      }
      this.keys[k] = true;
    });
    addEventListener('keyup', e => {
      this.keys[e.key.toLowerCase()] = false;
      // a focused button would "click" on Space/Enter release and steal the drive (restart, camera, menus...)
      if (this.running && [' ', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !(e.target.tagName === 'INPUT' && e.target.type === 'text')) e.preventDefault();
    });
    addEventListener('blur', () => { this.keys = {}; });
  }

  // ---------------- world ----------------
  buildWorld() {
    const S = this.scene;
    S.add(new THREE.HemisphereLight(0xe4f0ff, 0x4a6b3a, 0.9));
    const sun = this.sun = new THREE.DirectionalLight(0xfff3e0, 2.6);
    sun.castShadow = true;
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
    this.sunDir = new THREE.Vector3(0.45, 0.8, 0.3).normalize();
    this.applyShadowQuality();
    this.loadSky();
    S.add(sun); S.add(sun.target);

    this.world = new TrackScenery(S, this.T, { pbrTex, quality: gfxQ() });
    const gantryMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.6, roughness: 0.4 });

    // drag strip: its own map, shown instead of the circuit in drag mode
    this.dragScene = new DragScene(S, { pbrTex });
    this.treeLights = this.dragScene.treeLights;

    this.mapBounds();
    this.applyWeather();
  }
  mapBounds() {
    if (this.mode === 'drag') { const h = (stripEnd() - STRIP.z0 + 120) / 2; this.mapB = { x0: STRIP.x - h, x1: STRIP.x + h, z0: STRIP.z0 - 100, z1: stripEnd() + 20 }; return; }
    const T = this.T;
    const xs = T.points.map(p => p.x), zs = T.points.map(p => p.z);
    this.mapB = { x0: Math.min(...xs) - 20, x1: Math.max(...xs) + 20, z0: Math.min(...zs) - 20, z1: Math.max(...zs) + 20 };
  }

  setTrack(id) {
    if (!TRACKS[id] || this.T === TRACKS[id]) return;
    this.T = TRACKS[id];
    try { localStorage.setItem('tf_track', id); } catch (e) { }
    const old = this.world;
    old.group.parent.remove(old.group);
    old.group.traverse(o => { o.geometry?.dispose(); for (const m of [].concat(o.material || [])) m.dispose?.(); });
    this.world = new TrackScenery(this.scene, this.T, { pbrTex, quality: gfxQ() });
    this.mapBounds();
    this.applyWeather();
    this.tvK = null; this.best = null; this.lastLap = null; this.resetSectors();
    if (this.spec) { this.lap = lapSim(this.wetSpec(this.spec), this.T); this.setupRival(); }
    this.reset();
    if ($('#trackSel')) $('#trackSel').value = id;
    $('#trackDesc') && ($('#trackDesc').textContent = `${(this.T.length / 1000).toFixed(2)} km · ${this.T.desc}`);
  }

  // ---------------- UI ----------------
  bindUI() {
    const rv = $('#rival');
    rv.innerHTML = `<option value="self">Same build (ghost of you)</option>` + CARS.map(c => `<option value="${c.id}">${c.make} ${c.model}</option>`).join('');
    rv.value = 'gt3_991';
    const panel = $('#testPanel');
    const extra = document.createElement('div');
    extra.innerHTML = `<label id="autoDragWrap" class="hidden" style="color:var(--text);font-size:13px"><input type="checkbox" id="optAutoDrag"> Auto-drive the run (pro driver)</label>`;
    $('#paceOpts').after(extra);
    const upd = () => {
      $('#paceVal').textContent = Math.round($('#pace').value * 100) + '%';
      $('#windVal').textContent = $('#windSpd').value + ' km/h';
      const d = +$('#windDir').value; $('#windDirVal').textContent = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8] + ` (${d}°)`;
      $('#paceOpts').style.display = $('#mode').value === 'pace' ? '' : 'none';
      $('#raceOpts').classList.toggle('hidden', $('#mode').value !== 'race');
      $('#onlineBox').classList.toggle('hidden', $('#mode').value !== 'online');
      if ($('#mode').value === 'online' && !this.net) this.net = new Net(this);
      if ($('#mode').value !== 'online' && this.net) { this.net.leave(); this.net = null; }
      this.syncRules?.();
      $('#autoDragWrap').classList.toggle('hidden', $('#mode').value !== 'drag');
      $('#dragDistWrap').classList.toggle('hidden', $('#mode').value !== 'drag');
      $('#trackSel').value = $('#mode').value === 'drag' ? 'drag' : this.T.id;
      $('#trackDesc').textContent = $('#mode').value === 'drag' ? 'Two-lane strip · christmas tree start · timing at every mark' : `${(this.T.length / 1000).toFixed(2)} km · ${this.T.desc}`;
      if ($('#optSound').checked !== soundOn()) setSoundOn($('#optSound').checked);
      if (this.car) { this.car.tc = $('#optTC').checked; this.car.abs = $('#optABS').checked; this.car.esc = $('#optESC').checked; this.car.auto = $('#optAuto').checked; }
      $('#keysAuto').classList.toggle('hidden', !$('#optAuto').checked); $('#keysManual').classList.toggle('hidden', $('#optAuto').checked);
      document.activeElement?.type === 'checkbox' && document.activeElement.blur();
    };
    this.updUI = upd;
    $('#ruleBudget').innerHTML = BUDGETS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    $('#ruleClass').innerHTML = CLASS_LIMITS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    const syncRules = () => {
      const r = getRules(); $('#ruleBudget').value = r.budget; $('#ruleClass').value = r.cls;
      if (!this.spec) return;
      const v = ruleViolations(this.spec, r);
      $('#ruleStatus').innerHTML = v.length ? `<span class="bad">✗ ${v.join(' · ')}</span>` : `<span class="ok">✓ Your build is legal (${rulesText(r)})</span>`;
    };
    this.syncRules = syncRules;
    onRules(() => { syncRules(); if (this.running) this.reset(); });
    $('#ruleBudget').onchange = () => { setRules({ budget: +$('#ruleBudget').value }); $('#ruleBudget').blur(); };
    $('#ruleClass').onchange = () => { setRules({ cls: $('#ruleClass').value }); $('#ruleClass').blur(); };
    for (const id of ['#raceLaps', '#raceAI', '#raceSkill']) $(id).onchange = () => { this.reset(); $(id).blur(); };
    $('#trackSel').innerHTML = Object.entries(TRACKS).map(([id, t]) => `<option value="${id}">${t.name} — ${(t.length / 1000).toFixed(1)} km</option>`).join('') + `<option value="drag">Drag strip — ⅛ to 1 mile</option>`;
    $('#trackDesc').textContent = `${(this.T.length / 1000).toFixed(2)} km · ${this.T.desc}`;
    // the drag strip is its own map: picking it switches to drag mode, picking a circuit leaves drag mode
    $('#trackSel').onchange = () => {
      const v = $('#trackSel').value;
      if (v === 'drag') $('#mode').value = 'drag';
      else { if ($('#mode').value === 'drag') $('#mode').value = 'circuit'; this.setTrack(v); }
      upd(); this.reset(); $('#trackSel').blur();
    };
    $('#dragDist').innerHTML = DRAG_DISTANCES.map(([d, l]) => `<option value="${d}">${l} (${Math.round(d)} m)</option>`).join('');
    try { const sd = localStorage.getItem('tf_dragdist'); if (sd && DRAG_DISTANCES.some(([d]) => String(d) === sd)) $('#dragDist').value = sd; else $('#dragDist').value = '402.336'; } catch (e) { $('#dragDist').value = '402.336'; }
    $('#dragDist').onchange = () => { try { localStorage.setItem('tf_dragdist', $('#dragDist').value); } catch (e) { } this.reset(); $('#dragDist').blur(); };
    $('#camSel').onchange = () => { this.setCam($('#camSel').value); $('#camSel').blur(); };
    $('#weatherSel').value = this.wet ? 'wet' : 'dry';
    $('#weatherSel').onchange = () => { this.setWeather($('#weatherSel').value); $('#weatherSel').blur(); };
    $('#optSound').checked = soundOn();
    ['#pace', '#windSpd', '#windDir', '#optTC', '#optABS', '#optESC', '#optAuto', '#optSound', '#optMph'].forEach(s => $(s).addEventListener('input', upd));
    $('#mode').onchange = () => { upd(); this.reset(); $('#mode').blur(); };
    rv.onchange = () => { this.setupRival(); this.reset(); rv.blur(); };
    $('#pace').addEventListener('change', () => { this.paceMul = +$('#pace').value; });
    $('#restartBtn').onclick = () => { this.reset(); $('#restartBtn').blur(); };
    upd();
  }

  start(spec) {
    // gearbox default follows the car: manual cars start in manual (E/Q shift), automatics / DCTs / EVs in auto
    if (this.spec?.car.id !== spec.car.id || this.spec?.trans.type !== spec.trans.type) $('#optAuto').checked = spec.trans.type !== 'MT';
    this.spec = spec;
    this.net?.updateMyBuild();
    this.setCam(this.camName);
    this.updUI?.();
    this.running = true;
    this.audio.init();
    this.audio.ctx?.resume();
    this.audio.setSpec(spec);
    $('#testCarName').textContent = (spec.sel.name ? spec.sel.name + ' — ' : '') + `${spec.car.make} ${spec.car.model}`;
    this.buildPlayerModel();
    this.lap = lapSim(this.wetSpec(spec), this.T);
    const dt = dragTest(spec);
    this.simDrag = dt.quarter ? `${dt.quarter.toFixed(2)}s @ ${(dt.trap * 2.237).toFixed(0)} mph` : '—';
    this.best = null; this.lastLap = null; this.resetSectors();
    this.setupRival();
    this.reset();
  }
  // player car: real model if available (async), procedural meanwhile
  buildPlayerModel() {
    const spec = this.spec, q = gfxQ(), id = spec.car.id, req = this.modelReq = (this.modelReq || 0) + 1;
    const make = asset => {
      const m = createCarModel(spec, { paint: spec.sel.color || (asset ? null : spec.car.color), asset, quality: q });
      if (this.model) { this.scene.remove(this.model.root); disposeModel(this.model.root); }
      this.model = m; this.scene.add(m.root);
      (this.damage ||= new Damage(this.scene)).attach(m);
    };
    const cached = getCarAsset(id, q.lod);
    make(cached);
    if (!cached && hasRealModel(id)) loadCarAsset(id, q.lod).then(a => { if (a && req === this.modelReq) make(a); });
  }
  applyQuality() {
    this.applyShadowQuality(); this.applyTreeQuality(); this.loadSky();
    if (this.spec) { this.buildPlayerModel(); this.setupRival(); this.rival && (this.rival.model.root.visible = this.mode === 'pace'); }
  }
  applyShadowQuality() {
    const q = gfxQ(), s = this.sun, R = q.shadowRange;
    s.castShadow = q.shadows > 0;
    if (s.shadow.map) { s.shadow.map.dispose(); s.shadow.map = null; }
    s.shadow.mapSize.set(q.shadows || 512, q.shadows || 512);
    Object.assign(s.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 260 });
    s.shadow.camera.updateProjectionMatrix();
  }
  applyTreeQuality() { this.world?.setQuality(gfxQ()); }
  loadSky() {
    loadEnv(this.r, 'kloofendal_48d_partly_cloudy_puresky', gfxQ().env).then(e => {
      if (!e) return;
      this.scene.background = e.background; this.scene.environment = e.env;
      this.scene.backgroundIntensity = 1; this.scene.environmentIntensity = 0.85;
      this.scene.fog.color.set(0xb9cde0);
      if (e.sunDir.y > 0.1) this.sunDir.copy(e.sunDir);
      this.applyWeather();
    });
  }
  stop() { this.running = false; this.audio.silence(); this.keys = {}; }
  // what the lap sims / AI should plan with: the same car on a wet track has ~28% less grip
  wetSpec(spec) { return this.wet ? { ...spec, tire: { ...spec.tire, mu: spec.tire.mu * 0.72 } } : spec; }
  setWeather(w) {
    this.wet = w === 'wet';
    try { localStorage.setItem('tf_weather', w); } catch (e) { }
    this.applyWeather();
    if (this.spec) { this.lap = lapSim(this.wetSpec(this.spec), this.T); this.setupRival(); }
    this.resetSectors?.(); this.best = null; this.lastLap = null;
    if (this.running) this.reset();
  }
  applyWeather() {
    const wet = this.wet, S = this.scene;
    this.sun.intensity = wet ? 0.75 : 2.6;
    S.backgroundIntensity = wet ? 0.38 : 1; S.environmentIntensity = wet ? 0.55 : 0.85;
    S.fog.color.set(wet ? 0x7d868f : 0xb9cde0); S.fog.near = wet ? 120 : 450; S.fog.far = wet ? 1300 : 3200;
    this.world.setWet?.(wet);
    if (wet && !this.rain) {
      // rain: streaks in a box that travels with the camera
      const n = 7000, pos = new Float32Array(n * 6);
      this.rainP = []; for (let i = 0; i < n; i++) this.rainP.push([(Math.random() - 0.5) * 70, Math.random() * 30, (Math.random() - 0.5) * 70]);
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xaab4c0, transparent: true, opacity: 0.45, depthWrite: false }));
      this.rain.frustumCulled = false; S.add(this.rain);
    }
    if (this.rain) this.rain.visible = wet;
  }
  updateRain(dt) {
    if (!this.rain?.visible) return;
    const c = this.cam.position, a = this.rain.geometry.attributes.position.array, P = this.rainP;
    const vx = (this.car?.u || 0) * Math.sin(this.car?.yaw || 0), vz = (this.car?.u || 0) * Math.cos(this.car?.yaw || 0);
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      p[1] -= 11 * dt;
      if (p[1] < 0) { p[1] += 30; p[0] = (Math.random() - 0.5) * 70; p[2] = (Math.random() - 0.5) * 70; }
      const x = c.x + p[0], y = c.y - 12 + p[1], z = c.z + p[2], o = i * 6;
      // streak length along the fall + the car's own speed (rain sweeps past when you're quick)
      a[o] = x; a[o + 1] = y; a[o + 2] = z;
      a[o + 3] = x + vx * 0.012; a[o + 4] = y + 0.55; a[o + 5] = z + vz * 0.012;
    }
    this.rain.geometry.attributes.position.needsUpdate = true;
  }

  setupRival() {
    if (this.rival) { this.scene.remove(this.rival.model.root); disposeModel(this.rival.model.root); this.rival = null; }
    const id = $('#rival').value;
    const rs = id === 'self' ? this.spec : evaluate(emptyBuild(id));
    const q = { ...gfxQ(), wheelSeg: 32 };
    const asset = getCarAsset(rs.car.id, 'low');
    const model = createCarModel(rs, { paint: id === 'self' ? '#7fd3ff' : (asset ? null : rs.car.color), asset, quality: q });
    this.rival = { spec: rs, model, prof: lapSim(this.wetSpec(rs), this.T).profile, s: 0, v: 0 };
    this.rival.model.root.visible = false;
    this.scene.add(model.root);
    if (!asset && hasRealModel(rs.car.id)) loadCarAsset(rs.car.id, 'low').then(a => {
      if (!a || !this.rival || this.rival.spec !== rs) return;
      const m2 = createCarModel(rs, { paint: id === 'self' ? '#7fd3ff' : null, asset: a, quality: q });
      m2.root.visible = this.rival.model.root.visible;
      this.scene.remove(this.rival.model.root); disposeModel(this.rival.model.root);
      this.rival.model = m2; this.scene.add(m2.root);
    });
  }

  reset() {
    if (!this.spec) return;
    const mode = $('#mode').value;
    this.mode = mode;
    this.car = new Vehicle(this.spec, { tc: $('#optTC').checked, abs: $('#optABS').checked, esc: $('#optESC').checked, auto: $('#optAuto').checked });
    this.acc = 0; this.t = 0; this.steerIn = 0;
    this.damage?.repair();
    this.lapStart = null; this.halfway = false; this.invalid = false; this.idx = -1;
    this.drag = null;
    $('#timeslip').classList.add('hidden'); $('#tree').classList.add('hidden'); $('#msg').textContent = '';
    const T = this.T;
    // drag strip is its own map: hide the circuit scenery, show the strip
    const dragMap = mode === 'drag';
    this.world.group.visible = !dragMap; this.dragScene.group.visible = dragMap;
    this.mapBounds();
    if (dragMap) {
      this.dragDist = +($('#dragDist')?.value || 402.336);
      this.dragScene.setDistance(this.dragDist);
      this.car.reset(STRIP.x - STRIP.width / 4, STRIP.z0 - 0.5, 0);
      this.drag = { phase: 'stage', t: 0, green: null, launched: false, start: null, marks: {}, rt: null, finish: null };
      $('#tree').classList.remove('hidden');
    } else {
      const i0 = T.N - 25, p = T.points[i0];
      this.car.reset(p.x, p.z, T.head[i0]);
      this.idx = i0;
    }
    this.paceMul = +$('#pace').value;
    if (this.rival) {
      this.rival.model.root.visible = mode === 'pace';
      this.rival.s = (T.N - 25) * T.ds + 35; this.rival.v = 0;
      this.rival.wait = 2.0;
    }
    this.camPos = null;
    this.setupRace();
  }

  // ---------------- races / time attack ----------------
  clearRace() {
    if (this.race) for (const e of this.race.entries) if (!e.isPlayer && e.model && !e.remote) { this.scene.remove(e.model.root); disposeModel(e.model.root); }
    this.race = null; this.playerEntry = null;
    $('#raceBoard').classList.add('hidden'); $('#raceResults').classList.add('hidden');
  }
  setupRace() {
    const mode = this.mode, T = this.T;
    this.illegal = (mode === 'race' || mode === 'attack') ? ruleViolations(this.spec, getRules()) : [];
    this.targets = mode === 'attack' ? [1.03, 1.07, 1.12].map(k => lapSim(this.wetSpec(this.spec), T).time * k) : null;
    this.medal = null;
    if (this.raceKeep && this.race) {             // multiplayer race: R = respawn on the racing line where you were
      const e = this.playerEntry;
      if (e) {
        const A = this.world.A, k = e.idx >= 0 ? e.idx : T.N - 25, p = T.points[k], [lx, lz] = A.lat(k);
        if (this.race.t > 0) this.car.reset(p.x + lx * A.rl[k], p.z + lz * A.rl[k], T.head[k]); else { const sl = this.race.gridSlot(this.race.entries.indexOf(e)); this.car.reset(...sl); }
        e.car = this.car; this.idx = k;
      }
      return;
    }
    this.clearRace();
    if (mode !== 'race' || this.illegal.length) return;
    const R = this.race = new RaceControl(T, this.world, +$('#raceLaps').value);
    const opps = pickOpponents(this.spec, getRules(), +$('#raceAI').value);
    const skill = +$('#raceSkill').value, total = opps.length + 1;
    opps.forEach((o, i) => {
      const car = new Vehicle(o.spec, { tc: true, abs: true, esc: true, auto: true });
      const [x, z, h] = R.gridSlot(i); car.reset(x, z, h);
      const e = R.add({ name: o.name, carName: `${o.spec.car.make} ${o.spec.car.model}`, car, spec: o.spec, ai: new AIDriver(car, this.wetSpec(o.spec), T, this.world, skill * (0.97 + 0.06 * Math.random())) });
      this.loadOpponentModel(e, o.spec, o.paint);
    });
    const [x, z, h] = R.gridSlot(total - 1);
    this.car.reset(x, z, h);
    this.idx = nearest(T, x, z).i;
    this.playerEntry = R.add({ name: 'You', carName: `${this.spec.car.make} ${this.spec.car.model}`, car: this.car, model: this.model, isPlayer: true });
    $('#raceBoard').classList.remove('hidden');
  }
  loadOpponentModel(e, spec, paint) {
    const q = { ...gfxQ(), wheelSeg: 32 };
    const asset = getCarAsset(spec.car.id, 'low');
    e.model = createCarModel(spec, { paint: asset ? paint : paint || spec.car.color, asset, quality: q });
    this.scene.add(e.model.root);
    if (!asset && hasRealModel(spec.car.id)) loadCarAsset(spec.car.id, 'low').then(a => {
      if (!a || !this.race?.entries.includes(e)) return;
      const m2 = createCarModel(spec, { paint, asset: a, quality: q });
      this.scene.remove(e.model.root); disposeModel(e.model.root);
      e.model = m2; this.scene.add(m2.root);
    });
  }
  raceFrame(dt) {
    const R = this.race, P = this.playerEntry;
    for (const e of R.entries) R.track(e);
    R.syncModels(dt);
    // countdown
    if (R.t < 0.8) {
      const c = Math.ceil(-R.t);
      $('#msg').classList.add('count');
      $('#msg').textContent = R.t < -3 ? '' : R.t < 0 ? String(c) : 'GO!';
      const beat = R.t < -3 ? null : R.t < 0 ? c : 0;
      if (beat != null && beat !== this.lastBeat) sfx.countdown(beat);
      this.lastBeat = beat;
    } else if ($('#msg').classList.contains('count')) { $('#msg').classList.remove('count'); $('#msg').textContent = ''; }
    if (P && P.finish != null && !R.shown && R.t - P.finish > 1.2) {
      R.shown = true;
      $('#raceResults').innerHTML = R.resultsHTML() + `<div class="foot">You finished P${R.order().indexOf(P) + 1} · press R to race again</div>`;
      $('#raceResults').classList.remove('hidden');
      sfx.finish(R.order().indexOf(P) + 1);
    }
  }


  resize(w, h) { this.cam.aspect = w / h; this.cam.updateProjectionMatrix(); }

  // ---------------- per frame ----------------
  input() {
    const k = this.keys;
    // W/S or arrows drive in every mode; manual shifts on E/Q (handled on keydown)
    let thr = (k['w'] || k['arrowup']) ? 1 : 0, brk = (k['s'] || k['arrowdown']) ? 1 : 0;
    const left = (k['a'] || k['arrowleft']) ? 1 : 0, right = (k['d'] || k['arrowright']) ? 1 : 0;
    let target = left - right;
    let hb = !!k[' '];
    let up = this.edgeUp, down = this.edgeDown; this.edgeUp = this.edgeDown = false;
    // gamepad adds to the keyboard (never replaces it): a connected pad with a drifting stick used to override
    // keyboard steering completely
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let padSteer = null;
    for (const gp of pads) {
      if (!gp) continue;
      const ax = gp.axes[0] || 0;
      if (Math.abs(ax) > 0.15 && padSteer == null) padSteer = -Math.sign(ax) * (Math.abs(ax) - 0.15) / 0.85;
      const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
      if (rt > 0.05) thr = Math.max(thr, rt); if (lt > 0.05) brk = Math.max(brk, lt);
      if (gp.buttons[0]?.pressed) hb = true;
      if (gp.buttons[5]?.pressed && !this.padUp) up = true; this.padUp = gp.buttons[5]?.pressed;
      if (gp.buttons[4]?.pressed && !this.padDn) down = true; this.padDn = gp.buttons[4]?.pressed;
    }
    if (padSteer != null && target === 0) { this.steerIn = padSteer; return { throttle: thr, brake: brk, steer: padSteer, handbrake: hb, shiftUp: up, shiftDown: down }; }
    // keyboard steering: ramp in, faster return; reduce at speed for stability
    const rate = target === 0 || Math.sign(target) !== Math.sign(this.steerIn) ? 6 : 3.5;
    this.steerIn += Math.max(-rate * this.fdt, Math.min(rate * this.fdt, target - this.steerIn));
    return { throttle: thr, brake: brk, steer: this.steerIn, handbrake: hb, shiftUp: up, shiftDown: down };
  }

  wind(t) {
    const spd = +$('#windSpd').value / 3.6, dir = +$('#windDir').value * Math.PI / 180 + Math.PI;
    const gust = 1 + 0.28 * Math.sin(t * 0.9) + 0.14 * Math.sin(t * 2.7 + 1.3);
    return { x: Math.sin(dir) * spd * gust, z: -Math.cos(dir) * spd * gust };
  }

  surface(x, z) {
    const r = this.surfaceAt(x, z, this.idx);
    if (this.mode !== 'drag' && r.n) this.idx = r.n.i;
    return r;
  }
  // grip / rolling drag under a point (pure: AI cars use it with their own index hint)
  surfaceAt(x, z, hint = -1) {
    const r = this.surfaceDry(x, z, hint);
    if (this.wet) r.muMul *= r.on ? 0.72 : 0.8;
    return r;
  }
  surfaceDry(x, z, hint = -1) {
    if (this.mode === 'drag') return onStrip(x, z) ? { muMul: 1, rrExtra: 0, on: true } : { muMul: 0.6, rrExtra: 0.045, on: false };
    const n = nearest(this.T, x, z, hint);
    if (n.d < this.T.width / 2 + 1.3) return { muMul: 1, rrExtra: 0, on: true, n };
    const A = this.world.A;
    if (A.isPaved(x, z)) return { muMul: 0.95, rrExtra: 0, on: true, n };
    // gravel trap: deep, loose -> low grip, heavy rolling drag
    const k = n.i, p = this.T.points[k], [lx, lz] = A.lat(k), o = (x - p.x) * lx + (z - p.z) * lz;
    if (Math.sign(o) === A.gravelSide[k] && Math.abs(o) < A.hw + 1.35 + A.gravelW[k]) return { muMul: 0.45, rrExtra: 0.16, on: false, gravel: true, n };
    return { muMul: 0.6, rrExtra: 0.045, on: false, n };
  }

  frame(dt) {
    if (!this.running || !this.car) return;
    this.world.update?.(performance.now() / 1000, dt);   // helicopter, camera towers, crowd
    this.updateRain(dt);
    if (this.damage && this.car) { this.damage.update(dt, this.car, (x, z) => this.gh(x, z)); this.car.powerMul = this.damage.powerMul(); this.car.cdMul = this.damage.cdMul(); }
    this.fdt = dt;
    const car = this.car, s = this.spec;
    let inp = this.input();
    // bent suspension / steering arm from a crash: the car pulls to one side (needs a little opposite lock)
    if (this.damage) inp.steer = Math.max(-1, Math.min(1, inp.steer + this.damage.steerPull() * Math.min(1, (this.car?.speed || 0) / 10)));
    const mode = this.mode;

    // drag strip logic
    let hold = false;
    if (mode === 'drag') {
      const D = this.drag;
      D.t += dt;
      const auto = $('#optAutoDrag').checked;
      if (auto) inp = { throttle: D.phase === 'done' ? 0 : 1, brake: D.phase === 'done' ? 1 : 0, steer: -car.yaw * 2 - (car.x - (STRIP.x - STRIP.width / 4)) * 0.05,
        // the pro driver shifts a manual box too: right at the limiter
        shiftUp: !car.auto && D.phase === 'run' && car.rpm > car.eng.redline * 0.97 && !(car.shiftTimer > 0) && car.gear < car.gears.length };
      if (D.phase === 'stage') {
        hold = true;
        const tt = D.t - 1.0;
        this.treeLights.forEach((m, i) => m.emissiveIntensity = tt > i * 0.5 ? 3 : 0);
        document.querySelectorAll('#tree i').forEach((el, i) => el.classList.toggle('on', tt > i * 0.5));
        $('#msg').textContent = tt < 0 ? 'STAGED — hold W to build revs' : '';
        if (tt >= 1.5) { D.phase = 'run'; D.green = D.t; }
        // pre-load launch rpm while held
        car.rpm = car.eng.idle + inp.throttle * ((s.hasLaunch ? 0.62 : 0.5) * car.eng.redline - car.eng.idle);
        car.launchRpm = Math.max(car.eng.idle + 400, car.rpm);
      } else {
        if (D.rt == null && inp.throttle > 0.5) D.rt = D.t - D.green;
        const dist = car.z - STRIP.z0;
        if (D.start == null && dist > 0.3) D.start = car.time;
        if (D.start != null) {
          const et = car.time - D.start;
          for (const [d, key] of DRAG_MARKS) {
            if (d <= this.dragDist + 0.5 && !D.marks[key] && dist >= d) D.marks[key] = { t: et - (dist - d) / Math.max(1, car.u), v: car.u }; // interpolate to the beam
          }
          if (!D.finish && dist >= this.dragDist) D.finish = { t: et - (dist - this.dragDist) / Math.max(1, car.u), v: car.u };
          if (D.finish && D.phase !== 'done') { D.phase = 'done'; this.dragScene.win(true); this.showTimeslip(); $('#tree').classList.add('hidden'); }
        }
        if (car.gear > 1 || car.u > 15) car.launchRpm = null;
      }
    }

    if (this.illegal?.length) { hold = true; if (!$('#msg').textContent) $('#msg').textContent = '⛔ ' + this.illegal[0]; }
    if (this.race) { this.race.t += dt; if (this.race.t < 0) hold = true; }

    // physics
    this.acc += dt;
    const wind = this.wind(this.t);
    let dirty = 0;
    if (mode === 'pace' && this.rival) dirty = this.dirtyAir();
    const surf = this.surface(car.x, car.z);
    let n = 0;
    while (this.acc >= DT && n < 40) {
      if (!hold) car.step(DT, inp, { wind, dirty, muMul: surf.muMul, rrExtra: surf.rrExtra, noReverse: mode === 'drag', height: mode === 'drag' ? null : this.T.heightAt });
      inp.shiftUp = inp.shiftDown = false;
      if (mode === 'drag' && car.z > STRIP.z0 - STRIP.back && car.z < stripEnd()) {
        // strip walls: bounce off and straighten up (the lanes are walled in on both sides)
        const lim = STRIP.width / 2 - 0.65 - this.model.dims.W / 2, off = car.x - STRIP.x;
        if (Math.abs(off) > lim) {
          const hard = Math.abs(car.v) + Math.abs(car.u * Math.sin(car.yaw));
          car.x = STRIP.x + Math.sign(off) * lim; car.v *= -0.25; car.r *= 0.3; car.yaw *= 0.6; car.u *= hard > 3 ? 0.85 : 0.98;
          if (hard > 3) this.shake = Math.min(0.6, (this.shake || 0) + hard * 0.03);
        }
      }
      if (mode !== 'drag') {
        let hit = collideWalls(car, this.model.dims, this.world, this.T, this.idx, nearest);
        const R = this.rival;
        if (mode === 'pace' && R && R.x != null) hit = Math.max(hit, collideKinematic(car, this.model.dims, { x: R.x, z: R.z, head: R.head, vx: Math.sin(R.head) * R.v, vz: Math.cos(R.head) * R.v }, R.model.dims));
        if (this.race) hit = Math.max(hit, this.race.step(DT, (x, z, i) => this.surfaceAt(x, z, i), this.race.t < 0));
        if (this.net) hit = Math.max(hit, this.net.collide(car, this.model.dims));
        if (hit > 0) this.onImpact(hit);
        const hi = car.hitInfo; car.hitInfo = null;
        if (hi && this.damage) {
          const sy = Math.sin(car.yaw), cy = Math.cos(car.yaw), la = hi.rx * sy + hi.rz * cy, lb = hi.rx * cy - hi.rz * sy;
          if (hi.v > 2) this.damage.hit(car, [la, lb], [hi.nx, hi.nz], hi.v, (x, z) => this.gh(x, z));
          else if (car.speed > 4 && car.lastHit !== 'tires') { const wx = car.x + hi.rx, wz = car.z + hi.rz; this.damage.spark(wx, this.gh(wx, wz) + 0.3, wz, car.u * sy, car.u * cy, [hi.nx, hi.nz], 3); }   // scraping along a wall
        }
      }
      this.acc -= DT; n++; this.t += DT;
    }
    if (n >= 40) this.acc = 0;
    if (mode !== 'drag' && !surf.on && this.lapStart != null) this.invalid = true;

    // lap timing
    if (mode !== 'drag') this.lapTiming();
    if (mode === 'pace' && this.rival) this.updateRival(dt);
    if (this.race) this.raceFrame(dt);
    if (this.net) this.net.frame(dt);

    // model sync
    const M = this.model;
    poseOnGround(this.groundT(), M.root, car.x, car.z, car.yaw);
    M.body.rotation.x += ((-car.axs * 0.006) - M.body.rotation.x) * Math.min(1, dt * 8);
    M.body.rotation.z += ((car.ays * 0.007) - M.body.rotation.z) * Math.min(1, dt * 8);
    car.wheels.forEach((w, i) => {
      M.wheels[i].spin.rotation.x += w.omega * dt;
      if (M.wheels[i].front) M.wheels[i].pivot.rotation.y = car.steerAngle;
    });
    M.setBrake(inp.brake > 0.05 && car.gear !== -1 || (car.gear === -1 && inp.throttle > 0.05));

    this.updateCamera(dt);
    // shadow camera follows the car, light comes from the sky's sun direction; snap to texels to avoid shimmering
    const snap = (gfxQ().shadowRange * 2) / (gfxQ().shadows || 512);
    const sx = Math.round(car.x / snap) * snap, sz = Math.round(car.z / snap) * snap;
    this.sun.position.set(sx + this.sunDir.x * 120, this.sunDir.y * 120, sz + this.sunDir.z * 120); this.sun.target.position.set(sx, 0, sz);
    let maxS = 0;
    for (const w of car.wheels) maxS = Math.max(maxS, Math.hypot(w.kappa / s.tire.kp, Math.tan(w.alpha) / s.tire.ap));
    this.lastLoad = car.shiftTimer > 0 ? 0 : Math.max(inp.throttle * car.tcF, 0);
    this.audio.update({ rpm: car.rpm, load: this.lastLoad, speed: car.speed, slip: car.speed > 2 ? maxS : 0, gear: car.gear, dt,
      surface: surf.gravel ? 'gravel' : surf.on ? 'asphalt' : 'grass', kerb: this.onKerb(surf), active: this.running });
    // other cars' engines (AI opponents, online players, the pace car)
    const others = [];
    if (this.race) for (const e of this.race.entries) if (!e.isPlayer && e.car && e.spec) others.push({ key: e.name, x: e.car.x, z: e.car.z, rpm: e.car.rpm || 900, load: e.load ?? 0.5, spec: e.spec });
    if (this.net) for (const p of this.net.players.values()) if (!p.self && p.car && p.spec && !p.entry) others.push({ key: 'net' + p.id, x: p.car.x, z: p.car.z, rpm: p.car.rpm || 900, load: p.car.load || 0, spec: p.spec });
    if (this.rival?.model && this.rival.spec && this.mode === 'pace') { const R = this.rival, gr = R.spec.trans.gears, k = R.spec.trans.final * gr[Math.min(gr.length - 1, Math.max(0, Math.floor(R.v / 14)))]; others.push({ key: 'pace', x: R.x, z: R.z, rpm: Math.max(1200, Math.min(R.spec.engine.redline, R.v / R.spec.tire.R * k * 9.55)), load: 0.6, spec: R.spec }); }
    this.audio.updateOthers(others, { x: car.x, z: car.z, yaw: car.yaw, dt });
    this.hud(inp, wind, dirty, surf, dt);
    this.pipe.render(this.scene, this.cam);
  }

  dirtyAir() {
    const R = this.rival, car = this.car;
    const h = R.head ?? 0, fx = Math.sin(h), fz = Math.cos(h);
    const rx = car.x - R.x, rz = car.z - R.z;
    const along = rx * fx + rz * fz, lat = rx * Math.cos(h) - rz * Math.sin(h);
    if (along > -2 || along < -50) return 0;
    const d = -along, wakeW = 1.4 + d * 0.06;
    return Math.max(0, (1 - d / 50)) * Math.exp(-((lat / wakeW) ** 2)) * Math.min(1, car.speed / 25);
  }

  // crash feedback: camera shake + thump, scaled by closing speed
  onImpact(v) {
    if (v < 1.2) return;
    this.shake = Math.min(0.5, (this.shake || 0) + v * 0.018);
    if (v > 4 && this.lapStart != null) this.invalid = true;
    const a = this.audio.ctx;
    if (a && (!this.lastThump || a.currentTime - this.lastThump > 0.15)) {
      this.lastThump = a.currentTime;
      this.audio.impact(v);
    }
  }
  // is a wheel on a kerb? (kerbs run 0..1.35 m outside the track edge in corners)
  onKerb(surf) {
    const n = surf.n, A = this.world?.A; if (!n || !A?.curb?.[n.i]) return false;
    const d = Math.abs(n.d), half = (this.spec?.track || 1.55) / 2;
    return d + half > A.hw - 0.05 && d - half < A.hw + 1.35;
  }
  updateRival(dt) {
    const R = this.rival, T = this.T;
    if (R.wait > 0) R.wait -= dt;
    else {
      const total = T.N * T.ds;
      const i = Math.floor(R.s / T.ds) % T.N;
      const target = R.prof[i] * this.paceMul;
      R.v += Math.max(-12 * dt, Math.min(5 * dt, target - R.v));
      R.s = (R.s + R.v * dt) % total;
    }
    const f = R.s / T.ds, i = Math.floor(f) % T.N, j = (i + 1) % T.N, t = f - Math.floor(f);
    const a = T.points[i], b = T.points[j];
    R.x = a.x + (b.x - a.x) * t; R.z = a.z + (b.z - a.z) * t;
    let dh = T.head[j] - T.head[i]; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI;
    R.head = T.head[i] + dh * t;
    const m = R.model;
    poseOnGround(this.T, m.root, R.x, R.z, R.head);
    for (const w of m.wheels) w.spin.rotation.x += R.v / R.spec.tire.R * dt;
  }

  // sectors (thirds of the lap) + a live delta against the best lap's time at the same point of the track
  sectorTiming() {
    const T = this.T, i = this.idx, p = this.prevIdx;
    if (this.lapStart == null || p == null || i < 0) return;
    const el = this.car.time - this.lapStart;
    if (!this.curTrace || this.curTrace.length !== T.N) this.curTrace = new Float32Array(T.N).fill(-1);
    if (i >= p && i - p < 20) for (let k = p + 1; k <= i; k++) if (this.curTrace[k] < 0) this.curTrace[k] = el;
    this.delta = this.bestTrace && this.bestTrace[i] > 0 && this.curTrace[i] > 0 ? this.curTrace[i] - this.bestTrace[i] : null;
    for (let sct = 1; sct <= 2; sct++) {
      const b = Math.round(T.N * sct / 3);
      if (p < b && i >= b && i - p < 20) this.closeSector(sct - 1, el);
    }
  }
  closeSector(n, el) {
    this.secs ||= [];
    const start = n === 0 ? 0 : this.secSum || 0;
    const t = el - start;
    this.secs[n] = t; this.secSum = el;
    this.bestSec ||= [];
    const pb = this.bestSec[n];
    const col = this.invalid ? 'inv' : pb == null || t < pb ? 'purple' : 'yellow';
    if (!this.invalid && (pb == null || t < pb)) this.bestSec[n] = t;
    this.secCol ||= []; this.secCol[n] = col;
    this.secFlash = { n, t, col, d: pb == null ? null : t - pb, until: this.car.time + 3 };
  }
  resetSectors() { this.bestTrace = null; this.curTrace = null; this.bestSec = []; this.secs = []; this.secCol = []; this.secSum = 0; this.delta = null; this.secFlash = null; }
  lapTiming() {
    const T = this.T, i = this.idx;
    this.sectorTiming();
    if (this.prevIdx != null) {
      if (this.prevIdx > T.N - 40 && i < 40 && this.car.u > 0) {
        if (this.lapStart != null && this.halfway) {
          const lt = this.car.time - this.lapStart;
          this.closeSector(2, lt);
          if (!this.invalid && (!this.best || lt < this.best) && this.curTrace) { this.bestTrace = this.curTrace.slice(); }
          this.lastLap = { t: lt, invalid: this.invalid };
          if (!this.invalid && (!this.best || lt < this.best)) this.best = lt;
          if (this.targets && !this.invalid) {
            const m = this.targets.findIndex(t => lt <= t);
            if (m >= 0 && (this.medal == null || m < this.medal)) { this.medal = m; setTimeout(() => sfx.medal(m), 350); setTimeout(() => { $('#msg').textContent = ['🥇 GOLD!', '🥈 Silver', '🥉 Bronze'][m] + ' — ' + fmtLap(lt); }, 50); }
            try { const key = `tf_pb_${this.T.id}_${this.spec.car.id}`, pb = +localStorage.getItem(key) || Infinity; if (lt < pb) localStorage.setItem(key, lt); } catch (e) { }
          }
          $('#msg').textContent = this.invalid ? 'Lap invalid (off track)' : `LAP ${fmtLap(lt)}`;
          sfx.lap(!this.invalid);
          setTimeout(() => { if ($('#msg').textContent.startsWith('LAP') || $('#msg').textContent.startsWith('Lap')) $('#msg').textContent = ''; }, 2500);
        }
        this.lapStart = this.car.time; this.halfway = false; this.invalid = false;
        this.curTrace = new Float32Array(T.N).fill(-1); this.secSum = 0; this.secs = []; this.secCol = [];
      }
      if (Math.abs(i - T.N / 2) < 30) this.halfway = true;
    }
    this.prevIdx = i;
  }

  showTimeslip() {
    const D = this.drag, mph = v => (v * 2.237).toFixed(2);
    const r = D.marks;
    $('#timeslip').innerHTML = `<h4>TIMESLIP</h4><table>
      <tr><td>Reaction</td><td>${(D.rt ?? 0).toFixed(3)}</td></tr>
      ${DRAG_MARKS.filter(([d, k]) => r[k] && d < this.dragDist - 0.5).map(([d, k, l]) => `<tr><td>${l}</td><td>${r[k].t.toFixed(3)}${d >= 200 ? ` @ ${mph(r[k].v)} mph` : ''}</td></tr>`).join('')}
      <tr><td><b>${this.dragLabel()}</b></td><td><b>${D.finish.t.toFixed(3)} @ ${mph(D.finish.v)} mph</b></td></tr>
      </table><div style="text-align:center;margin-top:6px;color:#8b93a5;font-size:12px">${this.spec.car.make} ${this.spec.car.model} · ${Math.round(this.spec.engine.hp)} hp · ${Math.round(this.spec.mass)} kg · Press R to run again</div>`;
    $('#timeslip').classList.remove('hidden');
  }

  gh(x, z) { return this.mode !== 'drag' && this.T.heightAt ? this.T.heightAt(x, z) : 0; }
  groundT() { return this.mode === 'drag' ? FLAT : this.T; }
  dragLabel() { return DRAG_DISTANCES.find(([d]) => Math.abs(d - this.dragDist) < 1)?.[1] || `${Math.round(this.dragDist)} m`; }
  setCam(name) {
    this.camName = name; this.camPos = null;
    try { localStorage.setItem('tf_cam', name); } catch (e) { }
    if ($('#camSel')) $('#camSel').value = name;
    const lbl = $('#camSel')?.selectedOptions[0]?.textContent || name;
    if (this.model?.interior) this.model.interior.visible = true;
  }
  updateCamera(dt) {
    this.updateCamera0(dt);
    if (this.shake > 0.002) { const k = this.shake; this.cam.position.x += (Math.random() - 0.5) * k * 0.5; this.cam.position.y += (Math.random() - 0.5) * k * 0.4; this.cam.rotation.z += (Math.random() - 0.5) * k * 0.08; this.shake *= Math.exp(-dt * 9); }
  }
  updateCamera0(dt) {
    const car = this.car, M = this.model, d = M.dims, name = this.camName;
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    const setFov = f => { if (Math.abs(this.cam.fov - f) > 0.01) { this.cam.fov = f; this.cam.updateProjectionMatrix(); } };
    // mounted cameras ride with the body (pitch / roll / bumps)
    if (name === 'cockpit' || name === 'hood' || name === 'bumper') {
      M.root.updateMatrixWorld(true);
      const local = M.eyes?.[name] || new THREE.Vector3(name === 'cockpit' ? d.W * 0.2 : 0, name === 'bumper' ? 0.45 : d.H * (name === 'cockpit' ? 0.82 : 0.75), name === 'bumper' ? d.zN : name === 'hood' ? d.zN * 0.35 : 0);
      const p = M.body.localToWorld(local.clone());
      const ahead = M.body.localToWorld(local.clone().add(new THREE.Vector3(0, name === 'cockpit' ? -0.25 : -0.4, 20)));
      this.cam.position.copy(p); this.cam.up.set(0, 1, 0); this.cam.lookAt(ahead);
      setFov(name === 'cockpit' ? 68 : 62);
      this.cam.near = name === 'cockpit' ? 0.03 : 0.1; this.cam.updateProjectionMatrix();
      return;
    }
    this.cam.near = 0.1;
    if (name === 'tv' && this.mode === 'drag') {
      // trackside cameras every 150 m along the spectator side of the strip
      const k = Math.max(0, Math.round((car.z - STRIP.z0 + 40) / 150));
      this.tvPos = new THREE.Vector3(STRIP.x - STRIP.width / 2 - 9, 7, STRIP.z0 + k * 150 + 40);
      this.cam.position.copy(this.tvPos); this.cam.lookAt(car.x, 0.8, car.z);
      setFov(Math.max(8, Math.min(55, 2 * Math.atan(9 / this.tvPos.distanceTo(new THREE.Vector3(car.x, 0.8, car.z))) * 180 / Math.PI)));
      return;
    }
    if (name === 'tv') {
      // nearest trackside camera tower, zooming to keep the car a similar size on screen
      const T = this.T, A = this.world.A, step = 55;
      const k = Math.round(this.idx / step) * step % T.N;
      const s = (Math.floor(k / step) % 2) ? 1 : -1;
      if (this.tvK !== k) { this.tvK = k; const [x, z] = this.world.at(k + 12, s * (A.hw + 26)); this.tvPos = new THREE.Vector3(x, 9 + this.gh(x, z), z); }
      this.cam.position.copy(this.tvPos);
      const cy = this.gh(car.x, car.z) + 0.8;
      this.cam.lookAt(car.x, cy, car.z);
      const dist = this.tvPos.distanceTo(new THREE.Vector3(car.x, cy, car.z));
      setFov(Math.max(8, Math.min(55, 2 * Math.atan(9 / dist) * 180 / Math.PI)));
      return;
    }
    const cfg = { chase: [d.L * 0.5 + 1.9, 1.0, 0.95], far: [d.L * 1.1 + 4.2, 2.1, 1.2], heli: [d.L * 2 + 14, 11, 0.5] }[name] || [d.L * 0.5 + 1.9, 1.0, 0.95];
    const [dist, hgt, lookH] = cfg;
    // follow velocity direction a bit so drifts are visible
    const vx = car.u * fx + car.v * Math.cos(car.yaw), vz = car.u * fz - car.v * Math.sin(car.yaw);
    const sp = Math.hypot(vx, vz);
    let dx = fx, dz = fz;
    if (sp > 3 && car.u > 0) { dx = fx * 0.6 + vx / sp * 0.4; dz = fz * 0.6 + vz / sp * 0.4; const l = Math.hypot(dx, dz); dx /= l; dz /= l; }
    // over hills: ride at the car's height, never below the ground behind it
    const px = car.x - dx * dist, pz = car.z - dz * dist, hc = this.gh(car.x, car.z);
    const pos = new THREE.Vector3(px, Math.max(hc, this.gh(px, pz) + 0.3) + hgt + d.H * 0.35, pz);
    const look = new THREE.Vector3(car.x + fx * 2.5, this.gh(car.x + fx * 2.5, car.z + fz * 2.5) + lookH, car.z + fz * 2.5);
    if (!this.camPos) this.camPos = pos.clone();
    this.camPos.lerp(pos, Math.min(1, dt * (name === 'heli' ? 3 : 7)));
    this.cam.position.copy(this.camPos);
    this.cam.lookAt(look);
    const fov = (name === 'heli' ? 50 : 58) + Math.min(12, car.speed * 0.1);
    setFov(this.cam.fov + (fov - this.cam.fov) * Math.min(1, dt * 3));
  }

  hud(inp, wind, dirty, surf, dt) {
    this.hudT = (this.hudT || 0) + dt;
    const car = this.car, s = this.spec;
    const mph = $('#optMph').checked;
    const v = car.speed * (mph ? 2.237 : 3.6);
    $('#speed').textContent = Math.round(v);
    $('#speedUnit').textContent = mph ? 'mph' : 'km/h';
    $('#gear').textContent = car.shiftTimer > 0 ? '·' : car.gear === -1 ? 'R' : car.gear === 0 ? 'N' : car.gear;
    $('#rpmFill').style.width = Math.min(100, car.rpm / car.eng.redline * 100) + '%';
    $('#rpmTxt').textContent = `${Math.round(car.rpm)} rpm`;
    if (this.hudT < 0.08) return;
    this.hudT = 0;
    // laps
    if (this.mode !== 'drag') {
      const cur = this.lapStart != null ? car.time - this.lapStart : null;
      const tg = this.targets, b = this.best;
      $('#hudTL').innerHTML = `<div class="big">${cur != null ? fmtLap(cur) : '--:--.--'}</div>${this.invalid ? '<div style="color:#ff4757">INVALID</div>' : ''}
        <div>Last: ${this.lastLap ? fmtLap(this.lastLap.t) + (this.lastLap.invalid ? ' ✗' : '') : '—'}</div>
        <div>Best: ${this.best ? fmtLap(this.best) : '—'}</div>
        ${this.damage && this.damage.total > 0.02 ? `<div class="dmg">Damage ${Math.round(this.damage.total * 100)}%${this.damage.front > 0.3 ? ' · engine ' + Math.round((1 - this.damage.powerMul()) * 100) + '% down' : ''}${Math.abs(this.damage.steerPull()) > 0.01 ? ' · pulling ' + (this.damage.steerPull() > 0 ? 'left' : 'right') : ''} <small>(R repairs)</small></div>` : ''}
        <div class="sectors">${[0, 1, 2].map(n => `<span class="sec ${this.secCol?.[n] || ''}">S${n + 1} ${this.secs?.[n] != null ? this.secs[n].toFixed(2) : '—'}</span>`).join('')}</div>
        ${this.delta != null ? `<div class="delta ${this.delta < 0 ? 'up' : 'down'}">${this.delta < 0 ? '−' : '+'}${Math.abs(this.delta).toFixed(2)}</div>` : ''}
        ${tg ? `<div class="medals">${['🥇', '🥈', '🥉'].map((m, i) => `<span class="${b && b <= tg[i] ? 'got' : ''}">${m} ${fmtLap(tg[i])}</span>`).join('<br>')}</div>` : ''}`;
      const R = this.race || this.net?.race;
      if (R) {
        const P = this.playerEntry || this.net?.me, ord = R.order(), pos = ord.indexOf(P) + 1;
        $('#raceBoard').innerHTML = `<div class="head">P${pos}/${ord.length} · Lap ${Math.max(1, Math.min(P.lap, R.laps))}/${R.laps}</div><div>${R.board(P)}</div>`;
      }
    } else {
      const D = this.drag;
      const et = D.start != null && !D.finish ? car.time - D.start : D.finish?.t;
      $('#hudTL').innerHTML = `<div class="big">${et != null ? et.toFixed(3) : '0.000'}</div><div>${this.dragLabel()} · ${Math.max(0, Math.min(this.dragDist, car.z - STRIP.z0)).toFixed(0)} m / ${Math.round(this.dragDist)} m</div>`;
    }
    const sf = this.secFlash && car.time < this.secFlash.until ? this.secFlash : null;
    $('#hudTC').innerHTML = (surf.on ? '' : '<span class="pill dirty">OFF TRACK</span>') +
      (sf && this.mode !== 'drag' ? `<span class="pill sec ${sf.col}">S${sf.n + 1} ${sf.t.toFixed(2)}${sf.d != null ? ` (${sf.d < 0 ? '−' : '+'}${Math.abs(sf.d).toFixed(2)})` : ''}</span>` : '');
    this.drawMap();
  }

  drawMap() {
    const cv = $('#minimap'), g = cv.getContext('2d'), W = cv.width, B = this.mapB;
    const sc = Math.min((W - 20) / (B.x1 - B.x0), (W - 20) / (B.z1 - B.z0));
    const X = x => 10 + (x - B.x0) * sc, Y = z => 10 + (z - B.z0) * sc;
    g.clearRect(0, 0, W, W);
    if (this.mode === 'drag') {
      g.strokeStyle = '#ccc'; g.lineWidth = 6; g.beginPath(); g.moveTo(X(STRIP.x), Y(STRIP.z0 - STRIP.back)); g.lineTo(X(STRIP.x), Y(stripEnd())); g.stroke();
      g.strokeStyle = '#ffb020'; g.lineWidth = 2; g.beginPath(); g.moveTo(X(STRIP.x) - 8, Y(STRIP.z0 + this.dragDist)); g.lineTo(X(STRIP.x) + 8, Y(STRIP.z0 + this.dragDist)); g.stroke();
    } else {
      g.strokeStyle = '#ccc'; g.lineWidth = 3; g.beginPath();
      this.T.points.forEach((p, i) => i ? g.lineTo(X(p.x), Y(p.z)) : g.moveTo(X(p.x), Y(p.z))); g.closePath(); g.stroke();
    }
    if (this.mode === 'pace' && this.rival) { g.fillStyle = '#7fd3ff'; g.beginPath(); g.arc(X(this.rival.x), Y(this.rival.z), 4, 0, 7); g.fill(); }
    const RR = this.race || this.net?.race;
    if (RR) for (const e of RR.entries) if (!e.isPlayer && e.car) { g.fillStyle = e.remote ? '#7CFC9A' : '#7fd3ff'; g.beginPath(); g.arc(X(e.car.x), Y(e.car.z), 3.5, 0, 7); g.fill(); }
    g.fillStyle = '#ff5a1f'; g.beginPath(); g.arc(X(this.car.x), Y(this.car.z), 5, 0, 7); g.fill();
    g.fillStyle = '#8b93a5'; g.font = '10px system-ui'; g.fillText('N ↑', W - 26, 14);
  }
}

const FLAT = {};   // ground for poseOnGround on the (flat) drag strip map
function fmtLap(t) { const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`; }
