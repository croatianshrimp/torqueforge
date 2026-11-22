// Races: AI opponents (real physics cars with their own builds) + race control (grid, countdown, laps, positions,
// results). Multiplayer reuses the same race control with remote players instead of / as well as AI.
import { Vehicle, lapSim } from './physics.js';
import { nearest, poseOnGround } from './track.js';
import { collideWalls, collideCars } from './collide.js';
import { CARS } from './data.js';
import { evaluate, emptyBuild } from './build.js';
import { perfIndex, ruleViolations } from './pi.js';

const NAMES = ['M. Okafor', 'L. Brandt', 'S. Varga', 'K. Tanaka', 'R. Duarte', 'E. Lindqvist', 'A. Moreau', 'J. Novak', 'T. Rossi', 'P. Hale', 'N. Iyer', 'C. Walsh'];
const PAINT = ['#1f4fa8', '#ffd000', '#2ecc71', '#f5f5f5', '#111317', '#e85d04', '#7b2ff7', '#00b4d8', '#9b1b30', '#c0c0c0'];
const fmt = t => t == null ? '—' : `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`;
export { fmt as fmtRace };

// ---------- AI opponent picking ----------
let stockCache = null;
export function pickOpponents(playerSpec, rules, n, seed = Date.now()) {
  stockCache ||= CARS.map(c => { const s = evaluate(emptyBuild(c.id)); return { s, pi: perfIndex(s) }; });
  const target = perfIndex(playerSpec);
  let pool = stockCache.filter(e => !ruleViolations(e.s, rules).length);
  if (pool.length < n) pool = stockCache.slice();
  pool.sort((a, b) => Math.abs(a.pi - target) - Math.abs(b.pi - target));
  pool = pool.slice(0, Math.max(n + 3, Math.ceil(pool.length * 0.35)));
  let r = seed % 2147483647 || 1; const rnd = () => (r = r * 16807 % 2147483647) / 2147483647;
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0].s);
  const names = NAMES.slice().sort(() => rnd() - 0.5), paints = PAINT.slice().sort(() => rnd() - 0.5);
  return out.map((s, i) => ({ spec: s, name: names[i % names.length], paint: paints[i % paints.length] }));
}

// ---------- AI driver ----------
export class AIDriver {
  constructor(car, spec, T, world, skill = 0.93) {
    this.car = car; this.T = T; this.world = world; this.skill = skill;
    this.prof = lapSim(spec, T).profile;
    // the lap sim plans on flat ground: slow down where crests unload the tires and on downhill corners, then
    // re-run the braking pass so the car is already at that speed when it arrives
    const H = T.heightAt;
    if (H) {
      const N = T.N, P = T.points, h = P.map(p => H(p.x, p.z)), v = Float32Array.from(this.prof), ds = T.ds;
      for (let k = 0; k < N; k++) {
        const kv = (h[(k + 3) % N] - 2 * h[k] + h[(k - 3 + N) % N]) / (9 * ds * ds), slope = (h[(k + 2) % N] - h[(k - 2 + N) % N]) / (4 * ds);
        const load = Math.max(0.35, 1 + v[k] * v[k] * kv / 9.81);
        const curvy = Math.min(1, Math.abs(T.curv[k]) * 60);
        v[k] *= Math.min(1, Math.sqrt(load)) * (1 - curvy * Math.max(0, -slope) * 1.2) * (1 - 0.04 * curvy);
      }
      for (let pass = 0; pass < 2; pass++) for (let j = N - 1; j >= 0; j--) { const i = j, ip = (j - 1 + N) % N; v[ip] = Math.min(v[ip], Math.sqrt(v[i] * v[i] + 2 * 7.5 * ds)); }
      this.prof = v;
    }
    this.wb = (spec.a + spec.b) || 2.6;
    this.idx = -1; this.offset = 0; this.stuck = 0;
    this.noise = Math.random() * 100;
  }
  control(dt, others) {
    const c = this.car, T = this.T, A = this.world.A, N = T.N;
    this.idx = nearest(T, c.x, c.z, this.idx).i;
    const sp = Math.max(0, c.u);
    // traffic: move off the racing line to pass a slower car just ahead
    let want = 0, lift = 0;
    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
    for (const o of others) {
      if (o === c) continue;
      const dx = o.x - c.x, dz = o.z - c.z, along = dx * fx + dz * fz, lat = dx * Math.cos(c.yaw) - dz * Math.sin(c.yaw);
      if (along > 0 && along < 16 && Math.abs(lat) < 2.6) {
        want = lat > 0 ? -2.8 : 2.8;                       // go to the other side
        if (along < 7 && o.u < sp - 1) lift = 0.6;          // about to hit it: lift
      }
    }
    this.offset += (want - this.offset) * Math.min(1, dt * 1.5);
    // pure pursuit on the racing line (+ overtaking offset)
    const look = 7 + sp * 0.55, kAhead = (this.idx + Math.round(look / T.ds)) % N;
    const lineOff = Math.max(-A.hw + 1.2, Math.min(A.hw - 1.2, A.rl[kAhead] + this.offset));
    const p = T.points[kAhead], [lx, lz] = A.lat(kAhead);
    const tx = p.x + lx * lineOff - c.x, tz = p.z + lz * lineOff - c.z;
    const latT = tx * Math.cos(c.yaw) - tz * Math.sin(c.yaw), ld = Math.hypot(tx, tz);
    const delta = Math.atan2(2 * this.wb * latT, ld * ld);
    const maxSteer = c.maxSteer || 0.62;   // the car's current speed-sensitive lock (physics.js)
    const steer = Math.max(-1, Math.min(1, delta / maxSteer - c.r * 0.04));
    // speed: lap-sim profile a little ahead (it already contains the braking zones), scaled by skill
    let vt = Infinity;
    for (let j = 1; j <= 6; j++) vt = Math.min(vt, this.prof[(this.idx + j * 2) % N]);
    vt *= this.skill * (1 + 0.015 * Math.sin(this.noise + c.time * 0.3));
    if (Math.abs(c.v) > 2.5) vt *= 0.9;                        // sliding: settle it
    let throttle = Math.max(0, Math.min(1, (vt - sp) * 0.6 + 0.4)) * (1 - lift), brake = 0;
    if (sp > vt + 0.8) { throttle = 0; brake = Math.min(1, (sp - vt) * 0.35); }
    // stuck (nose in a wall / spun): reverse out, then carry on
    if (sp < 1.5) { this.stuck += dt; this.stuckTotal = (this.stuckTotal || 0) + dt; } else { this.stuck = Math.max(0, this.stuck - dt * 2); if (sp > 6) this.stuckTotal = 0; }
    if (this.stuckTotal > 9) this.marshal = true;
    if (this.stuck > 2.5) { if (this.stuck > 5) this.stuck = 0; return { throttle: 0, brake: 1, steer: -steer, handbrake: false }; }   // auto box: brake at standstill = reverse
    return { throttle, brake, steer, handbrake: false };
  }
}

// ---------- race control ----------
// entries: [{ name, car (Vehicle), model, ai?: AIDriver, isPlayer?, remote? }]
export class RaceControl {
  constructor(T, world, laps) {
    this.T = T; this.world = world; this.laps = laps;
    this.entries = []; this.t = -4; this.state = 'countdown'; this.results = null;
  }
  gridSlot(i) {
    const T = this.T, k = (T.N - 6 - i * 5 + T.N * 4) % T.N, side = i % 2 ? -1 : 1;
    const [lx, lz] = this.world.A.lat(k), o = side * this.world.A.hw * 0.42, p = T.points[k];
    return [p.x + lx * o, p.z + lz * o, T.head[k]];
  }
  add(e) { Object.assign(e, { lap: 0, idx: -1, prev: null, half: false, lapStart: null, best: null, finish: null }); this.entries.push(e); return e; }
  // lap counting for every car; returns progress for ordering
  track(e) {
    if (e.remote) return;                 // remote players report their own laps
    const T = this.T, c = e.car;
    e.idx = nearest(T, c.x, c.z, e.idx).i;
    if (e.prev != null) {
      if (e.prev > T.N - 40 && e.idx < 40 && c.u > 0) {
        if (e.lap === 0 || e.half) {
          const now = this.t;
          if (e.lap > 0) { const lt = now - e.lapStart; if (!e.best || lt < e.best) e.best = lt; e.lastLap = lt; }
          e.lap++; e.lapStart = now; e.half = false;
          if (e.lap > this.laps && e.finish == null) { e.finish = now; e.place = this.entries.filter(x => x.finish != null).length; }
        }
      }
      if (Math.abs(e.idx - T.N / 2) < 40) e.half = true;
    }
    e.prev = e.idx;
    e.progress = e.finish != null ? 1e9 - e.finish : e.lap === 0 ? e.idx - T.N : (e.lap - 1) * T.N + e.idx;
  }
  order() {
    if (this.mode === 'attack') return [...this.entries].sort((a, b) => (a.best ?? 1e9) - (b.best ?? 1e9));
    return [...this.entries].sort((a, b) => b.progress - a.progress);
  }
  // one physics sub-step for every AI car + all car-vs-car contacts
  step(DT, surfaceAt, held) {
    const cars = this.entries.map(e => e.car);
    for (const e of this.entries) {
      if (!e.ai) continue;
      if (held) continue;                                                  // on the grid: don't step (brake at rest = reverse in auto)
      const inp = e.finish != null && this.t - e.finish > 6 ? { throttle: 0, brake: 0.4, steer: 0 } : e.ai.control(DT, cars);
      if (e.ai.marshal) { this.marshal(e); continue; }
      e.load = inp.throttle || 0;
      const s = surfaceAt(e.car.x, e.car.z, e.ai.idx);
      e.car.step(DT, inp, { wind: { x: 0, z: 0 }, dirty: 0, muMul: s.muMul, rrExtra: s.rrExtra, height: this.T.heightAt });
      collideWalls(e.car, e.model.dims, this.world, this.T, e.ai.idx, nearest);
    }
    let playerHit = 0;
    for (let i = 0; i < this.entries.length; i++) for (let j = i + 1; j < this.entries.length; j++) {
      const a = this.entries[i], b = this.entries[j];
      if (a.remote || b.remote) continue;   // remote cars are handled as kinematic by the multiplayer layer
      const h = collideCars(a.car, a.model.dims, b.car, b.model.dims);
      if (a.isPlayer || b.isPlayer) playerHit = Math.max(playerHit, h);
    }
    return playerHit;
  }
  // stuck for good: put the car back on the racing line, pointing the right way (like a marshal / recovery truck)
  marshal(e) {
    const T = this.T, A = this.world.A, k = (e.ai.idx + 4) % T.N, p = T.points[k], [lx, lz] = A.lat(k);
    e.car.reset(p.x + lx * A.rl[k], p.z + lz * A.rl[k], T.head[k]);
    e.ai.marshal = false; e.ai.stuck = 0; e.ai.stuckTotal = 0;
  }
  syncModels(dt) {
    for (const e of this.entries) {
      if (e.isPlayer || !e.model) continue;
      const M = e.model, c = e.car;
      poseOnGround(this.T, M.root, c.x, c.z, c.yaw);
      if (c.wheels) c.wheels.forEach((w, i) => { if (!M.wheels[i]) return; M.wheels[i].spin.rotation.x += w.omega * dt; if (M.wheels[i].front) M.wheels[i].pivot.rotation.y = c.steerAngle; });
      else for (const w of M.wheels) w.spin.rotation.x += (c.u || 0) / 0.32 * dt;
    }
  }
  board(player) {
    const ord = this.order();
    const leader = ord[0];
    return ord.map((e, i) => {
      if (this.mode === 'attack') return `<div class="${e === player ? 'me' : ''}"><b>${i + 1}</b> ${e.name}${e.remote ? ' 🌐' : ''}<span>${fmt(e.best)}</span></div>`;
      const gap = i === 0 ? '' : e.finish != null && leader.finish != null ? '+' + (e.finish - leader.finish).toFixed(1) : e.lap < leader.lap - 1 ? `+${leader.lap - e.lap} laps` : '';
      return `<div class="${e === player ? 'me' : ''}"><b>${i + 1}</b> ${e.name}${e.remote ? ' 🌐' : ''}<span>${e.finish != null ? '🏁 ' : ''}${gap}</span></div>`;
    }).join('');
  }
  resultsHTML() {
    const ord = this.order(), w = ord[0];
    return `<h3>🏁 Race results</h3><table><tr><th>#</th><th>Driver</th><th>Car</th><th>Time</th><th>Best lap</th></tr>${ord.map((e, i) => `<tr class="${e.isPlayer ? 'me' : ''}"><td>${i + 1}</td><td>${e.name}</td><td>${e.carName}</td><td>${this.mode === 'attack' ? fmt(e.best) : e.finish != null ? (i === 0 ? fmt(e.finish) : '+' + (e.finish - w.finish).toFixed(3)) : 'DNF'}</td><td>${fmt(e.best)}</td></tr>`).join('')}</table>`;
  }
}
