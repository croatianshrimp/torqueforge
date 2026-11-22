// Wind tunnel: animated smoke streamlines over the actual built car (including wings / splitters / widebody).
// The car is rasterised into top / underside height fields; each streamline is pushed over (or under) the body,
// rises before obstacles, separates behind sharp edges (more wake for draggier shapes) and is coloured by local
// flow speed (red = slow / high pressure, blue = fast / low pressure).
import * as THREE from '../vendor/three.module.js';
import { LineSegments2 } from '../vendor/LineSegments2.js';
import { LineSegmentsGeometry } from '../vendor/LineSegmentsGeometry.js';
import { LineMaterial } from '../vendor/LineMaterial.js';

const CELL = 0.035;
function heightFields(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const box = new THREE.Box3();
  const meshes = [];
  root.traverse(o => { if (o.isMesh && o.visible && o.geometry?.attributes.position && !o.userData.noTunnel) { meshes.push(o); } });
  for (const o of meshes) { const b = new THREE.Box3().setFromObject(o).applyMatrix4(inv); box.union(b); }
  const x0 = box.min.x - 0.2, z0 = box.min.z - 0.2;
  const NX = Math.ceil((box.max.x - x0 + 0.2) / CELL), NZ = Math.ceil((box.max.z - z0 + 0.2) / CELL);
  const top = new Float32Array(NX * NZ).fill(0), low = new Float32Array(NX * NZ).fill(99);
  const M = new THREE.Matrix4(), A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), P = new THREE.Vector3();
  const put = v => {
    const ix = Math.floor((v.x - x0) / CELL), iz = Math.floor((v.z - z0) / CELL);
    if (ix < 0 || ix >= NX || iz < 0 || iz >= NZ) return;
    const k = iz * NX + ix; if (v.y > top[k]) top[k] = v.y; if (v.y > 0.02 && v.y < low[k]) low[k] = v.y;
  };
  for (const o of meshes) {
    M.multiplyMatrices(inv, o.matrixWorld);
    const pos = o.geometry.attributes.position, idx = o.geometry.index;
    const n = idx ? idx.count : pos.count;
    const get = (i, v) => v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(M);
    for (let i = 0; i + 2 < n; i += 3) {
      get(i, A); get(i + 1, B); get(i + 2, C);
      const e = Math.max(A.distanceTo(B), B.distanceTo(C), C.distanceTo(A));
      const s = Math.min(24, Math.ceil(e / CELL));
      if (s <= 1) { put(A); put(B); put(C); continue; }
      for (let a = 0; a <= s; a++) for (let b = 0; a + b <= s; b++) {
        const u = a / s, w = b / s; P.set(0, 0, 0).addScaledVector(A, 1 - u - w).addScaledVector(B, u).addScaledVector(C, w); put(P);
      }
    }
  }
  const at = (F, x, z, def) => { const ix = Math.floor((x - x0) / CELL), iz = Math.floor((z - z0) / CELL); if (ix < 0 || ix >= NX || iz < 0 || iz >= NZ) return def; return F[iz * NX + ix]; };
  // widen by one cell across x so streamlines between panel gaps don't dive into the car
  const topAt = (x, z) => Math.max(at(top, x - CELL, z, 0), at(top, x, z, 0), at(top, x + CELL, z, 0));
  const lowAt = (x, z) => Math.min(at(low, x, z, 99), at(low, x - CELL, z, 99), at(low, x + CELL, z, 99));
  return { box, topAt, lowAt };
}

export class WindTunnel {
  constructor() { this.group = null; this.mat = new LineMaterial({ vertexColors: true, linewidth: 2.4, dashed: true, dashSize: 0.28, gapSize: 0.22, transparent: true, opacity: 0.85, depthWrite: false }); }
  build(model, spec) {
    this.dispose();
    const root = model.root, g = new THREE.Group(); g.name = 'windtunnel';
    const H = heightFields(root);
    const b = H.box, zF = b.max.z, zT = b.min.z, W = b.max.x - b.min.x, topMax = b.max.y;
    const cd = spec.aero.cd, step = 0.03;
    const zStart = zF + 1.6, zEnd = zT - 3.2, n = Math.ceil((zStart - zEnd) / step);
    const slow = new THREE.Color(0xff3b2f), mid = new THREE.Color(0xd8dde6), fast = new THREE.Color(0x35b8ff), tmp = new THREE.Color();
    const lanes = [];
    for (let i = 0; i < 7; i++) { const x = (i / 6 - 0.5) * W * 0.8; for (const h of [0.35, 0.7, 1.05, topMax + 0.12, topMax + 0.45]) lanes.push([x, h, false]); }
    for (let i = 0; i < 5; i++) lanes.push([(i / 4 - 0.5) * W * 0.6, 0.07, true]);   // underbody
    const pos = [], col = [];
    for (const [x, h, under] of lanes) {
      const zs = new Float32Array(n), y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const z = zStart - i * step; zs[i] = z;
        if (under) { const lo = H.lowAt(x, z); y[i] = lo < 98 ? Math.min(h, lo - 0.025) : h; continue; }
        const top = H.topAt(x, z);
        const env = top > 0 ? top + 0.045 : 0;
        y[i] = Math.max(h, env, h + 0.35 * Math.max(0, env - 0.3) * Math.exp(-Math.max(0, h - topMax) / 0.5));
      }
      if (!under) {
        // anticipate obstacles (flow rises ahead of the nose / windscreen)
        for (let i = n - 2; i >= 0; i--) y[i] = Math.max(y[i], y[i + 1] - step * 0.75);
        // separation: flow can't follow a steep drop (rear window / tail / wing trailing edge)
        const drop = step * (0.55 - Math.min(0.3, (cd - 0.25) * 0.8));
        for (let i = 1; i < n; i++) y[i] = Math.max(y[i], y[i - 1] - drop);
      } else for (let i = 1; i < n; i++) y[i] = Math.max(y[i], Math.min(h, y[i - 1]) - step * 0.4, 0.01);
      // smooth
      for (let pass = 0; pass < 3; pass++) for (let i = 1; i < n - 1; i++) y[i] = (y[i - 1] + y[i] * 2 + y[i + 1]) / 4;
      const lp = [], lc = [];
      for (let i = 0; i < n; i++) {
        const z = zs[i];
        // wake turbulence behind the car, stronger for boxy (high-Cd) shapes, near the body height
        let wx = 0, wy = 0;
        if (z < zT) {
          const d = zT - z, near = Math.exp(-Math.max(0, y[i] - topMax * 0.9) / 0.35), amp = 0.04 * (0.6 + 2.5 * Math.max(0, cd - 0.25)) * Math.min(1, d) * near;
          wx = amp * Math.sin(d * 5.3 + x * 9 + h * 7); wy = amp * Math.sin(d * 4.1 + x * 5 + h * 3);
        }
        const yy = y[i] + wy;
        // local speed: accelerates over the body (y above free stream), stagnates where the flow climbs steeply, slow in the wake
        const climb = i > 0 ? (y[i] - y[i - 1]) / step : 0;
        let v = 1 + (under ? 0.5 * (h - y[i]) / h : 1.3 * (y[i] - h)) - 1.6 * Math.max(0, climb - 0.15);
        if (z < zT) v -= 0.5 * Math.exp(-Math.max(0, y[i] - topMax) / 0.3) * Math.min(1, (zT - z) * 2);
        v = Math.max(0, Math.min(2, v));
        if (v < 1) tmp.copy(slow).lerp(mid, v); else tmp.copy(mid).lerp(fast, Math.min(1, v - 1));
        lp.push(x + wx, yy, z); lc.push(tmp.r, tmp.g, tmp.b);
      }
      for (let i = 1; i < n; i++) { pos.push(...lp.slice((i - 1) * 3, i * 3 + 3)); col.push(...lc.slice((i - 1) * 3, i * 3 + 3)); }
    }
    const geo = new LineSegmentsGeometry(); geo.setPositions(pos); geo.setColors(col);
    const lines = new LineSegments2(geo, this.mat); lines.computeLineDistances(); lines.frustumCulled = false; lines.renderOrder = 5; g.add(lines);
    // force arrows (scaled at 200 km/h): downforce at each axle, drag backwards
    const q = 0.5 * 1.225 * (200 / 3.6) ** 2 * spec.aero.A;
    const dfF = -spec.aero.clF * q, dfR = -spec.aero.clR * q, drag = spec.aero.cd * q;
    const zFa = model.wheels?.find(w => w.front)?.pivot, zRa = model.wheels?.find(w => !w.front)?.pivot;
    const axle = (piv, fb) => { if (!piv) return fb; const v = piv.getWorldPosition(new THREE.Vector3()); root.worldToLocal(v); return v.z; };
    const arrow = (dir, origin, N, color) => {
      if (Math.abs(N) < 30) return;
      const len = Math.min(1.6, 0.25 + Math.abs(N) / 2500);
      const d = dir.clone().multiplyScalar(Math.sign(N));
      const a = new THREE.ArrowHelper(d, origin.clone().addScaledVector(d, -len), len, color, 0.16, 0.1);
      a.traverse(o => { if (o.material) { o.material.depthTest = false; o.material.transparent = true; } o.renderOrder = 6; });
      g.add(a);
    };
    const yTop = topMax + 0.08;
    arrow(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, yTop, axle(zFa, zF - 0.9)), dfF, 0x2ecc71);
    arrow(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, yTop, axle(zRa, zT + 0.9)), dfR, 0x2ecc71);
    arrow(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, topMax * 0.55, zT - 0.15), drag, 0xff4757);
    root.add(g); this.group = g; this.root = root;
    return { dfF, dfR, drag };
  }
  tick(dt, w, h) { this.mat.dashOffset -= dt * 1.4; if (w) this.mat.resolution.set(w, h); }
  dispose() { if (this.group) { this.group.parent?.remove(this.group); this.group.traverse(o => { o.geometry?.dispose(); if (o.material && o.material !== this.mat) o.material.dispose(); }); } this.group = null; }
}

export function tunnelReport(spec) {
  const A = spec.aero.A, cd = spec.aero.cd, rows = [];
  const q = v => 0.5 * 1.225 * (v / 3.6) ** 2 * A;
  const kg = N => Math.round(N / 9.81);
  const df = v => kg(-(spec.aero.clF + spec.aero.clR) * q(v));
  const bal = (spec.aero.clF + spec.aero.clR) < -0.01 ? Math.round(spec.aero.clF / (spec.aero.clF + spec.aero.clR) * 100) : null;
  const dragHp = v => Math.round(cd * q(v) * v / 3.6 / 745.7);
  return `<h4>🌬️ Wind tunnel <small>@ 200 km/h</small></h4>
    <table>
      <tr><td>Drag coefficient (Cd)</td><td><b>${cd.toFixed(3)}</b></td></tr>
      <tr><td>Frontal area</td><td>${A.toFixed(2)} m² · CdA ${(cd * A).toFixed(2)}</td></tr>
      <tr><td>Drag</td><td>${kg(cd * q(200))} kgf · ${dragHp(200)} hp</td></tr>
      <tr><td>Downforce @100 km/h</td><td>${df(100)} kg</td></tr>
      <tr><td>Downforce @200 km/h</td><td><b>${df(200)} kg</b></td></tr>
      <tr><td>Front / rear</td><td>${kg(-spec.aero.clF * q(200))} / ${kg(-spec.aero.clR * q(200))} kg</td></tr>
      <tr><td>Aero balance</td><td>${bal == null ? 'lift' : bal + '% front'}</td></tr>
    </table>
    <div class="bar"></div><div class="legend"><span>slow · high pressure</span><span>fast · low pressure</span></div>
    <small class="muted">Green arrows = downforce, red = drag. Negative downforce means the body makes lift.</small>`;
}
