// TorqueForge audio: shared AudioContext, per-engine voices (js/engine-worklet.js does the synthesis), forced-induction
// layers (turbo whistle + blow-off, supercharger whine), driving sounds (wind, road, gravel, kerbs, tire squeal, hits)
// and small effects for the garage and races.
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------------- shared context + settings ----------------
let ctx = null, master = null, workletP = null;
let enabled = true;
try { enabled = localStorage.getItem('tf_sound') !== '0'; } catch (e) { }
export const soundOn = () => enabled;
export function setSoundOn(v) {
  enabled = !!v;
  try { localStorage.setItem('tf_sound', enabled ? '1' : '0'); } catch (e) { }
  if (master) master.gain.setTargetAtTime(enabled ? 0.9 : 0, ctx.currentTime, 0.05);
}
export function audioCtx() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return null;
    ctx = new C({ latencyHint: 'interactive' });
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.15;
    master = ctx.createGain(); master.gain.value = enabled ? 0.9 : 0;
    master.connect(comp).connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => { });
  return ctx;
}
export const audioOut = () => (audioCtx(), master);
function loadWorklet() {
  const a = audioCtx(); if (!a || !a.audioWorklet) return Promise.reject(new Error('no AudioWorklet'));
  return workletP ||= a.audioWorklet.addModule(new URL('./engine-worklet.js', import.meta.url));
}
let noiseBuf = null;
function noise() {
  const a = audioCtx();
  if (!noiseBuf) { noiseBuf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const s = a.createBufferSource(); s.buffer = noiseBuf; s.loop = true; return s;
}

// ---------------- engine voices ----------------
const evenFire = (n, cyc = 720) => Array.from({ length: n }, (_, i) => i * cyc / n);
const bank2 = (o = {}) => [
  { f1: 140, q1: 2.2, g1: 1.6, f2: 800, q2: 2.6, g2: 0.8, lp0: 1500, panL: 0.74, panR: 0.26, dly: 0, k: 1, ...o },
  { f1: 140 * 1.07, q1: 2.2, g1: 1.6, f2: 800 * 1.05, q2: 2.6, g2: 0.8, lp0: 1500, panL: 0.26, panR: 0.74, dly: 0.8, k: 0.96, ...o, ...(o.f1 ? { f1: o.f1 * 1.07 } : {}), ...(o.f2 ? { f2: o.f2 * 1.05 } : {}) },
];
const bank1 = (o = {}) => [{ f1: 170, q1: 2.4, g1: 1.6, f2: 950, q2: 2.8, g2: 0.8, lp0: 1700, panL: 0.5, panR: 0.5, dly: 0, ...o }];
const FLAT_PLANE = /Voodoo|LT6|F136|F154|M840T|flat-plane/i;
const VTEC = /^(K20|K24|F20C|B16|B18C|H22|C30|D16|F22C|K20C)/i;
const BIG_BLOCK = /L78|BBC|big-block|Godzilla|LSX454|Hellephant/i;

// base sound of an engine from its layout (+ a few famous special cases), then modified by the build
export function engineVoice(spec) {
  const e = spec.engine, cfg = e.cfg, code = `${e.code || ''} ${e.name || ''}`;
  let v = {
    cycle: 720, fire: evenFire(4).map((a, i) => ({ a, bank: 0, amp: 1 })), banks: bank1(),
    body: 0.35, drive: 1.6, noise: 0.25, hiss: 0.05, pw: 1.4, imb: 0.08, lope: 0, chop: 0, pops: 0.004, popVol: 0.7, clatter: 0, idleImb: 0.4,
    intake: { f: 420, q: 1.6, g: 0.18 }, vol: 0.5, vtec: 0, redline: e.redline || 7000, label: cfg,
  };
  const set = o => Object.assign(v, o);
  switch (cfg) {
    case 'I3': set({ fire: evenFire(3).map(a => ({ a, bank: 0, amp: 1 })), banks: bank1({ f1: 150, f2: 820 }), imb: 0.1, label: 'Inline-3 thrum' }); break;
    case 'I4': set({ banks: bank1({ f1: 185, f2: 1000, lp0: 1900 }), label: 'Inline-4' }); break;
    case 'F4':
      if (/EJ/.test(code)) set({ fire: [0, 212, 360, 572].map((a, i) => ({ a, bank: i < 2 ? 0 : 1, amp: 1 })), banks: bank2({ f1: 118, f2: 640, lp0: 1300 }), imb: 0.16, pw: 1.9, drive: 1.9, idleImb: 1.3, label: 'Boxer rumble (unequal headers)' });
      if (/EJ/.test(code)) v.banks[1].k = 0.85;
      else set({ fire: evenFire(4).map((a, i) => ({ a, bank: i % 2, amp: 1 })), banks: bank2({ f1: 140, f2: 720 }), imb: 0.12, label: 'Boxer-4' });
      break;
    case 'I5': set({ fire: evenFire(5).map(a => ({ a, bank: 0, amp: 1 })), banks: bank1({ f1: 165, f2: 1150, lp0: 2000 }), imb: 0.11, drive: 1.9, label: 'Inline-5 warble' }); break;
    case 'I6': set({ fire: evenFire(6).map((a, i) => ({ a, bank: i % 2, amp: 1 })), banks: bank2({ f1: 210, f2: 1350, lp0: 2400, q2: 3.2 }), imb: 0.045, pw: 1.1, drive: 1.5, label: 'Inline-6 (smooth)' }); break;
    case 'V6': set({ fire: evenFire(6).map((a, i) => ({ a, bank: i % 2, amp: 1 })), banks: bank2({ f1: 185, f2: 1250, lp0: 2200 }), imb: 0.07, drive: 2.1, label: 'V6 (raspy)' }); break;
    case 'F6': set({ fire: evenFire(6).map((a, i) => ({ a, bank: i % 2, amp: 1 })), banks: bank2({ f1: 215, f2: 1550, lp0: 3000, q2: 3.4 }), imb: 0.05, pw: 1.0, drive: 2.3, label: 'Flat-6 (metallic howl)' }); break;
    case 'V8':
      if (FLAT_PLANE.test(code)) set({ fire: evenFire(8).map((a, i) => ({ a, bank: i % 2, amp: 1 })), banks: bank2({ f1: 225, f2: 1650, lp0: 3300, q2: 3.2 }), imb: 0.04, pw: 1.0, drive: 2.3, label: 'Flat-plane V8 (scream)' });
      else {
        // cross-plane: GM firing order 1-8-4-3-6-5-7-2, odd cylinders on the left bank -> each bank fires unevenly
        const banks = [0, 1, 1, 0, 1, 0, 0, 1];
        const big = BIG_BLOCK.test(code);
        set({ fire: evenFire(8).map((a, i) => ({ a, bank: banks[i], amp: 1 })), banks: bank2({ f1: big ? 95 : 112, f2: big ? 560 : 660, lp0: big ? 1200 : 1450, q1: 2.0 }), imb: big ? 0.16 : 0.12, pw: big ? 2.4 : 2.0, drive: 1.9, idleImb: big ? 2.2 : 1.7, label: big ? 'Big-block V8 (deep burble)' : 'Cross-plane V8 (burble)' });
        v.banks[1].k = 0.8;
      }
      break;
    case 'V10':
      if (/Viper/i.test(code)) set({ fire: [0, 54, 144, 198, 288, 342, 432, 486, 576, 630].map((a, i) => ({ a, bank: i % 2, amp: 1 })), banks: bank2({ f1: 120, f2: 760, lp0: 1500 }), imb: 0.1, pw: 1.8, drive: 1.8, label: 'Odd-fire V10 (truck-like)' });
      else set({ fire: evenFire(10).map((a, i) => ({ a, bank: i % 2, amp: 1 })), banks: bank2({ f1: 205, f2: 1550, lp0: 3200, q2: 3.2 }), imb: 0.05, pw: 1.0, drive: 2.3, label: 'V10 (shriek)' });
      break;
    case 'V12': set({ fire: evenFire(12).map((a, i) => ({ a, bank: i % 2, amp: 1 })), banks: bank2({ f1: 240, f2: 1800, lp0: 3600, q2: 3.4 }), imb: 0.03, pw: 0.9, drive: 2.0, label: 'V12 (smooth wail)' }); break;
    case 'R2': case 'R3': case 'R4': {
      const n = { R2: 2, R3: 3, R4: 4 }[cfg];
      set({ cycle: 360, fire: evenFire(n, 360).map(a => ({ a, bank: 0, amp: 1.25 })), banks: bank1({ f1: 260, f2: 1450, lp0: 2400, q2: 2.2 }), imb: 0.14, pw: 0.7, drive: 3.0, noise: 0.6, hiss: 0.12, chop: 0.35, pops: 0.03, label: 'Rotary (brap)' });
      break;
    }
  }
  if (/Cummins|diesel/i.test(code)) set({ banks: bank2({ f1: 105, f2: 560, lp0: 900 }), clatter: 0.9, drive: 1.3, pw: 2.2, imb: 0.1, label: 'Diesel I6 (clatter)' });
  if (/Hayabusa/i.test(code)) set({ banks: bank1({ f1: 260, f2: 1600, lp0: 3200 }), pw: 0.8, drive: 2.2, intake: { f: 700, q: 1.8, g: 0.35 }, label: 'Bike engine (howl)' });
  if (VTEC.test(code)) v.vtec = v.redline * 0.7;

  // ---- the build changes the sound ----
  const has = id => spec.parts.some(p => p.id === id);
  const ex = spec.parts.find(p => p.cat === 'exhaust')?.id;
  const k = { catback: [0.68, 1.35, 1.15, 0.012], tiexhaust: [0.82, 1.7, 1.3, 0.03], straightpipe: [0.88, 2.4, 1.6, 0.06] }[ex] || [0.52, 1, 1, 0];
  v.vol = k[0]; v.drive *= k[2]; v.pops += k[3];
  for (const b of v.banks) { b.lp0 *= k[1]; if (ex === 'tiexhaust' || ex === 'straightpipe') b.f2 *= 1.08; }
  if (ex === 'straightpipe') { v.noise *= 1.5; v.hiss *= 1.6; }
  v.pops += has('haltech') ? 0.05 : has('stage2') ? 0.03 : has('stage1') ? 0.01 : 0;
  if (has('cai')) v.intake.g *= 1.6;
  if (has('carbonbox')) v.intake.g *= 2.0;
  if (has('itb')) { v.intake.g *= 3.2; v.intake.f = 850; }
  if (has('racecams')) { v.lope = 0.7; v.imb += 0.06; v.idleImb += 1; v.chop = Math.max(v.chop, 0.15); }
  else if (has('cams')) { v.lope = 0.35; v.imb += 0.03; v.idleImb += 0.5; }
  // a turbine in the exhaust muffles it
  if (e.asp === 'turbo') { for (const b of v.banks) b.lp0 *= 0.82; v.drive *= 0.9; v.pops += 0.01; }
  // louder engines need less make-up gain; more cylinders = more pulses
  v.vol *= 1.25 / Math.sqrt(v.fire.length / (v.cycle === 360 ? 2 : 4)) ** 0.5;
  // forced induction layers
  const fi = spec.parts.find(p => p.cat === 'forced');
  v.fi = e.ev ? null : e.asp === 'turbo' ? { kind: fi?.fi?.kind === 'twin' || /twin|TT/i.test(code) ? 'twin' : 'turbo', aftermarket: !!fi, spool: e.spool || 0.42 }
    : e.asp === 'sc' ? { kind: e.blower || 'roots', aftermarket: !!fi } : null;
  v.ev = e.asp === 'ev' || cfg === 'EV';
  if (v.ev) v.label = 'Electric motor whine';
  return v;
}

// ---------------- one engine (player, opponent or dyno) ----------------
export class EngineSound {
  constructor(dest = audioOut()) {
    this.a = audioCtx(); this.dest = dest; this.ready = false; this.boost = 0; this.prevLoad = 0; this.gain = 1;
    const a = this.a; if (!a) return;
    this.out = a.createGain(); this.out.gain.value = 0; this.out.connect(dest);
    this.pan = a.createStereoPanner ? a.createStereoPanner() : null;
    if (this.pan) { this.pan.connect(this.out); }
    this.bus = this.pan || this.out;
    // turbo whistle + whoosh
    this.tOsc = a.createOscillator(); this.tOsc.type = 'sine';
    this.tOsc2 = a.createOscillator(); this.tOsc2.type = 'sine';
    this.tG = a.createGain(); this.tG.gain.value = 0;
    this.tOsc.connect(this.tG); this.tOsc2.connect(this.tG); this.tG.connect(this.bus);
    this.tN = noise(); this.tBp = a.createBiquadFilter(); this.tBp.type = 'bandpass'; this.tBp.Q.value = 2.5; this.tNG = a.createGain(); this.tNG.gain.value = 0;
    this.tN.connect(this.tBp).connect(this.tNG).connect(this.bus);
    // supercharger whine
    this.sOsc = a.createOscillator(); this.sOsc.type = 'sawtooth';
    this.sBp = a.createBiquadFilter(); this.sBp.type = 'bandpass'; this.sBp.Q.value = 6;
    this.sG = a.createGain(); this.sG.gain.value = 0;
    this.sOsc.connect(this.sBp).connect(this.sG).connect(this.bus);
    // EV motor whine (inverter + gear)
    this.eOsc = a.createOscillator(); this.eOsc.type = 'triangle'; this.eOsc2 = a.createOscillator(); this.eOsc2.type = 'sine';
    this.eG = a.createGain(); this.eG.gain.value = 0;
    this.eOsc.connect(this.eG); this.eOsc2.connect(this.eG); this.eG.connect(this.bus);
    for (const o of [this.tOsc, this.tOsc2, this.tN, this.sOsc, this.eOsc, this.eOsc2]) o.start();
    loadWorklet().then(() => {
      if (this.dead) return;
      this.node = new AudioWorkletNode(a, 'engine-synth', { numberOfInputs: 0, outputChannelCount: [2] });
      this.node.connect(this.bus);
      this.ready = true;
      if (this.v) this.node.port.postMessage({ type: 'profile', p: this.v });
    }).catch(e => console.warn('[sound] engine worklet unavailable', e));
  }
  setSpec(spec) {
    this.v = engineVoice(spec);
    if (this.node) this.node.port.postMessage({ type: 'profile', p: this.v });
    this.boost = 0;
  }
  // rpm, load 0..1 (throttle actually reaching the engine), vol 0..1 (distance / camera), pan -1..1
  update(rpm, load, { vol = 1, pan = 0, dt = 1 / 60 } = {}) {
    const a = this.a, v = this.v; if (!a || !v) return;
    const t = a.currentTime;
    this.out.gain.setTargetAtTime(vol, t, 0.05);
    if (this.pan) this.pan.pan.setTargetAtTime(clamp(pan, -1, 1), t, 0.05);
    const red = v.redline;
    if (v.ev) {
      const f = rpm / 60 * 6;
      this.eOsc.frequency.setTargetAtTime(Math.max(30, f), t, 0.03); this.eOsc2.frequency.setTargetAtTime(Math.max(40, f * 2.7), t, 0.03);
      this.eG.gain.setTargetAtTime((0.012 + load * 0.03) * Math.min(1, rpm / 800), t, 0.05);
      if (this.node) this.node.parameters.get('gain').setTargetAtTime(0, t, 0.05);
      return;
    }
    if (this.node) {
      const P = this.node.parameters;
      P.get('rpm').setTargetAtTime(rpm, t, 0.012);
      P.get('load').setTargetAtTime(load, t, 0.02);
      P.get('gain').setTargetAtTime(1, t, 0.05);
    }
    const fi = v.fi, r = rpm / red;
    if (fi && (fi.kind === 'turbo' || fi.kind === 'twin')) {
      const tgt = load * clamp((rpm - 1400) / Math.max(400, fi.spool * red - 1400), 0, 1);
      this.boost += (tgt - this.boost) * Math.min(1, dt / (tgt > this.boost ? 0.35 + fi.spool * 0.4 : 0.12));
      const b = this.boost, f = 2200 + b * 5200 + r * 1500;
      this.tOsc.frequency.setTargetAtTime(f, t, 0.05); this.tOsc2.frequency.setTargetAtTime(f * (fi.kind === 'twin' ? 1.013 : 2.0), t, 0.05);
      this.tBp.frequency.setTargetAtTime(f * 0.45, t, 0.05);
      const k = fi.aftermarket ? 1.6 : 1;
      this.tG.gain.setTargetAtTime(b * b * 0.006 * k, t, 0.04);
      this.tNG.gain.setTargetAtTime(b * 0.05 * k, t, 0.04);
      // blow-off valve when the throttle snaps shut on boost
      if (this.prevLoad > 0.55 && load < 0.15 && b > 0.4) { this.bov(b * (fi.aftermarket ? 1 : 0.4)); this.boost *= 0.25; }
    } else if (fi) {
      // roots / twin-screw: whine locked to crank speed; centrifugal: high whine rising with rpm squared
      const cen = fi.kind === 'centrifugal';
      const f = cen ? 900 + rpm * 1.15 : rpm * (fi.kind === 'screw' ? 0.42 : 0.28);
      this.sOsc.frequency.setTargetAtTime(f, t, 0.03); this.sBp.frequency.setTargetAtTime(f * (cen ? 1 : 2), t, 0.03);
      this.sG.gain.setTargetAtTime(cen ? r * r * (0.4 + 0.6 * load) * 0.05 : (0.25 + 0.75 * load) * r * 0.05, t, 0.04);
      if (cen && this.prevLoad > 0.55 && load < 0.15 && r > 0.55) this.bov(0.7);
    }
    this.prevLoad = load;
  }
  bov(k) {
    const a = this.a, t = a.currentTime;
    const s = noise(), bp = a.createBiquadFilter(), g = a.createGain();
    bp.type = 'bandpass'; bp.Q.value = 1.4; bp.frequency.setValueAtTime(3200, t); bp.frequency.exponentialRampToValueAtTime(1100, t + 0.35);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16 * k, t + 0.015); g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    s.connect(bp).connect(g).connect(this.bus); s.start(t); s.stop(t + 0.45);
  }
  shift(type) {
    // ignition cut while the gear changes; sequentials / DCTs crack on upshift
    const crack = (type === 'SEQ' || type === 'DCT') && this.v && !this.v.ev;
    this.node?.port.postMessage({ type: 'shift', cut: type === 'MT' ? 0.12 : 0.06, crack });
  }
  stop() {
    this.dead = true;
    try { this.out.gain.setTargetAtTime(0, this.a.currentTime, 0.04); } catch (e) { }
    setTimeout(() => { try { this.node?.disconnect(); for (const o of [this.tOsc, this.tOsc2, this.tN, this.sOsc, this.eOsc, this.eOsc2]) o.stop(); this.out.disconnect(); } catch (e) { } }, 200);
  }
}

// ---------------- the player's car on track ----------------
export class CarAudio {
  constructor() { this.a = null; this.engine = null; this.others = new Map(); }
  init() {
    if (this.a) return;
    const a = this.a = audioCtx(); if (!a) return;
    this.bus = a.createGain(); this.bus.gain.value = 0; this.bus.connect(audioOut());
    this.engine = new EngineSound(this.bus);
    const loop = (type, f, q) => { const s = noise(), fl = a.createBiquadFilter(), g = a.createGain(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; g.gain.value = 0; s.connect(fl).connect(g).connect(this.bus); s.start(); return { fl, g }; };
    this.wind = loop('lowpass', 500, 0.7);
    this.road = loop('lowpass', 180, 0.8);
    this.gravel = loop('highpass', 1800, 0.7);
    this.squeal = loop('bandpass', 1300, 7);
    this.squeal2 = loop('bandpass', 1900, 9);
    // kerb rumble: square wave through a low-pass, rate from speed
    this.kOsc = a.createOscillator(); this.kOsc.type = 'square';
    this.kLp = a.createBiquadFilter(); this.kLp.type = 'lowpass'; this.kLp.frequency.value = 160;
    this.kG = a.createGain(); this.kG.gain.value = 0;
    this.kOsc.connect(this.kLp).connect(this.kG).connect(this.bus); this.kOsc.start();
  }
  get ctx() { return this.a; }
  setSpec(spec) { this.spec = spec; this.engine?.setSpec(spec); }
  // per frame: st = { rpm, load, speed, slip, surface: 'asphalt'|'grass'|'gravel', kerb, gear, dt, active }
  update(st) {
    const a = this.a; if (!a) return;
    const t = a.currentTime, on = st.active ? 1 : 0;
    this.bus.gain.setTargetAtTime(on, t, 0.08);
    if (!on) return;
    this.engine.update(st.rpm, st.load, { dt: st.dt });
    if (this.gear != null && st.gear !== this.gear && st.gear > 0 && this.gear > 0) this.engine.shift(this.spec?.trans?.type);
    this.gear = st.gear;
    const v = st.speed;
    this.wind.fl.frequency.setTargetAtTime(400 + v * 14, t, 0.1);
    this.wind.g.gain.setTargetAtTime(Math.min(0.22, (v / 70) ** 2 * 0.16), t, 0.1);
    const offRoad = st.surface !== 'asphalt';
    this.road.g.gain.setTargetAtTime(Math.min(0.09, v / 45 * 0.05) * (offRoad ? 2.2 : 1), t, 0.08);
    this.road.fl.frequency.setTargetAtTime(offRoad ? 320 : 180, t, 0.1);
    this.gravel.g.gain.setTargetAtTime(st.surface === 'gravel' ? Math.min(0.12, v / 25 * 0.1) * (0.6 + Math.random() * 0.8) : 0, t, 0.03);
    this.kOsc.frequency.setTargetAtTime(Math.max(2, v / 0.6), t, 0.03);
    this.kG.gain.setTargetAtTime(st.kerb ? Math.min(0.28, v / 20 * 0.2) : 0, t, 0.025);
    const sq = st.surface === 'asphalt' ? clamp((st.slip - 0.85) * 0.25, 0, 0.1) : 0;
    this.squeal.g.gain.setTargetAtTime(sq, t, 0.05); this.squeal2.g.gain.setTargetAtTime(sq * 0.5, t, 0.05);
    this.squeal.fl.frequency.setTargetAtTime(1150 + 250 * Math.sin(t * 9), t, 0.05);
  }
  // other cars (AI / online): engine notes that fade with distance and pan with direction
  updateOthers(list, lis) {
    if (!this.a) return;
    const near = list.map(o => ({ o, d: Math.hypot(o.x - lis.x, o.z - lis.z) })).filter(e => e.d < 140).sort((p, q) => p.d - q.d).slice(0, 3);
    const keep = new Set(near.map(e => e.o.key));
    for (const [k, s] of this.others) if (!keep.has(k)) { s.stop(); this.others.delete(k); }
    for (const { o, d } of near) {
      let s = this.others.get(o.key);
      if (!s) { s = new EngineSound(this.bus); s.setSpec(o.spec); this.others.set(o.key, s); }
      const dx = o.x - lis.x, dz = o.z - lis.z, rx = dx * Math.cos(lis.yaw) - dz * Math.sin(lis.yaw);
      s.update(o.rpm, o.load, { vol: 0.75 / (1 + d / 9), pan: clamp(-rx / (d + 2), -0.8, 0.8), dt: lis.dt });
    }
  }
  clearOthers() { for (const s of this.others.values()) s.stop(); this.others.clear(); }
  impact(v) {
    const a = this.a; if (!a || !enabled) return;
    const t = a.currentTime, len = 0.35;
    const s = noise(), lp = a.createBiquadFilter(), g = a.createGain();
    lp.type = 'lowpass'; lp.frequency.value = 300 + v * 40;
    g.gain.setValueAtTime(Math.min(0.9, v / 16), t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    s.connect(lp).connect(g).connect(this.bus); s.start(t); s.stop(t + len);
    if (v > 7) {   // metal crunch + scrape for real hits
      const s2 = noise(), bp = a.createBiquadFilter(), g2 = a.createGain();
      bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 1.2;
      g2.gain.setValueAtTime(Math.min(0.35, v / 50), t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      s2.connect(bp).connect(g2).connect(this.bus); s2.start(t); s2.stop(t + 0.55);
    }
  }
  silence() { if (this.a) this.bus.gain.setTargetAtTime(0, this.a.currentTime, 0.05); this.clearOthers(); }
}

// ---------------- one-shot effects ----------------
function tone(f, len, { type = 'sine', vol = 0.12, at = 0, slide = 0 } = {}) {
  const a = audioCtx(); if (!a || !enabled) return;
  const t = a.currentTime + at, o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t); if (slide) o.frequency.exponentialRampToValueAtTime(f * slide, t + len);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0008, t + len);
  o.connect(g).connect(audioOut()); o.start(t); o.stop(t + len + 0.02);
}
function burst(len, { f = 2000, q = 1, type = 'bandpass', vol = 0.15, at = 0, decay = true } = {}) {
  const a = audioCtx(); if (!a || !enabled) return;
  const t = a.currentTime + at, s = noise(), fl = a.createBiquadFilter(), g = a.createGain();
  fl.type = type; fl.frequency.value = f; fl.Q.value = q;
  g.gain.setValueAtTime(vol, t); if (decay) g.gain.exponentialRampToValueAtTime(0.001, t + len); else g.gain.setValueAtTime(0, t + len);
  s.connect(fl).connect(g).connect(audioOut()); s.start(t, Math.random()); s.stop(t + len + 0.02);
}
export const sfx = {
  countdown(n) { tone(n > 0 ? 660 : 1320, n > 0 ? 0.28 : 0.7, { type: 'square', vol: 0.06 }); },
  lap(good = true) { if (good) { tone(880, 0.18, { vol: 0.08 }); tone(1320, 0.3, { vol: 0.08, at: 0.12 }); } else tone(330, 0.35, { type: 'triangle', vol: 0.08, slide: 0.8 }); },
  medal(m) { [523, 659, 784, 1047].slice(0, 4 - m).forEach((f, i) => tone(f, 0.35, { vol: 0.08, at: i * 0.11 })); },
  finish(p) { const notes = p === 1 ? [523, 659, 784, 1047, 1319] : [523, 659, 784]; notes.forEach((f, i) => tone(f, 0.4, { type: 'triangle', vol: 0.09, at: i * 0.13 })); },
  // garage: impact wrench for engine / wheels, ratchet for bolt-ons, spray can for paint
  install(cat) {
    if (['engine', 'forced', 'internals', 'trans', 'wheels', 'tires', 'brakes', 'suspension'].includes(cat)) {
      for (let i = 0; i < 2; i++) {
        const a = audioCtx(); if (!a || !enabled) return;
        const t = a.currentTime + i * 0.32, o = a.createOscillator(), am = a.createGain(), g = a.createGain(), bp = a.createBiquadFilter();
        o.type = 'sawtooth'; o.frequency.value = 38; bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 0.9;
        const s = noise(); s.connect(bp).connect(am).connect(g).connect(audioOut());
        o.connect(am.gain); am.gain.value = 0;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.28, t + 0.02); g.gain.setValueAtTime(0.28, t + 0.2); g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
        o.start(t); o.stop(t + 0.3); s.start(t, Math.random()); s.stop(t + 0.3);
      }
      burst(0.12, { f: 220, type: 'lowpass', vol: 0.35, at: 0.62 });
    } else if (cat === 'paint') burst(0.55, { f: 5000, q: 0.6, vol: 0.06, decay: false });
    else for (let i = 0; i < 5; i++) burst(0.025, { f: 3800, q: 2, vol: 0.12, at: i * 0.07 });
  },
  remove() { burst(0.15, { f: 260, type: 'lowpass', vol: 0.3 }); burst(0.05, { f: 2600, q: 2, vol: 0.08, at: 0.02 }); },
  click() { burst(0.02, { f: 3000, q: 3, vol: 0.05 }); },
};

// wind-tunnel fan (looping) + dyno roller hum
export function loopHum(kind) {
  const a = audioCtx(); if (!a) return { stop() { }, set() { } };
  const s = noise(), fl = a.createBiquadFilter(), g = a.createGain(), o = a.createOscillator(), og = a.createGain();
  fl.type = 'lowpass'; fl.frequency.value = kind === 'fan' ? 700 : 260; fl.Q.value = 0.8;
  o.type = 'sine'; o.frequency.value = kind === 'fan' ? 95 : 48; og.gain.value = kind === 'fan' ? 0.025 : 0;
  g.gain.value = 0; g.gain.setTargetAtTime(kind === 'fan' ? 0.07 : 0, a.currentTime, 0.4);
  s.connect(fl).connect(g).connect(audioOut()); o.connect(og).connect(audioOut()); s.start(); o.start();
  return {
    set(x) { g.gain.setTargetAtTime(x * 0.08, a.currentTime, 0.05); o.frequency.setTargetAtTime(30 + x * 120, a.currentTime, 0.05); og.gain.setTargetAtTime(x * 0.03, a.currentTime, 0.05); },
    stop() { g.gain.setTargetAtTime(0, a.currentTime, 0.2); og.gain.setTargetAtTime(0, a.currentTime, 0.2); setTimeout(() => { try { s.stop(); o.stop(); } catch (e) { } }, 900); },
  };
}
