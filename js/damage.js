// Crash damage for the player's car: the body panels dent and crumple where you hit (scaled by impact speed),
// debris and sparks fly off, and the damage changes how the car drives (power loss + overheating smoke from a
// smashed front, a bent corner pulls the steering, hanging bodywork adds drag). R (reset) repairs everything.
import * as THREE from '../vendor/three.module.js';

const MAX_DEBRIS = 160, MAX_SPARKS = 300, MAX_SMOKE = 90;

export class Damage {
  constructor(scene) {
    this.scene = scene;
    this.orig = new Map();   // geometry -> original positions / normals
    // debris: small instanced chunks
    const dg = new THREE.BoxGeometry(1, 1, 1);
    this.debris = new THREE.InstancedMesh(dg, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.2 }), MAX_DEBRIS);
    this.debris.count = 0; this.debris.frustumCulled = false; this.debris.castShadow = true;
    this.debris.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEBRIS * 3), 3);
    scene.add(this.debris);
    this.dp = [];
    // sparks: additive points
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_SPARKS * 3), 3));
    this.sparks = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffb040, size: 0.09, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.sparks.frustumCulled = false; scene.add(this.sparks);
    this.sp = [];
    // smoke from a damaged engine bay
    const smg = new THREE.BufferGeometry();
    smg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_SMOKE * 3), 3));
    const tex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(255,255,255,0.9)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
    this.smoke = new THREE.Points(smg, new THREE.PointsMaterial({ map: tex, color: 0x9a9a9a, size: 1.6, transparent: true, opacity: 0.45, depthWrite: false }));
    this.smoke.frustumCulled = false; scene.add(this.smoke);
    this.sm = [];
    this.zones = { fl: 0, fr: 0, rl: 0, rr: 0 };
    this.t = 0;
  }
  attach(model) { this.repair(); this.model = model; }
  get total() { const z = this.zones; return Math.min(1, (z.fl + z.fr + z.rl + z.rr) / 2.2); }
  // effects the physics reads
  get front() { return Math.min(1, (this.zones.fl + this.zones.fr) * 0.7); }
  powerMul() { const f = this.front; return 1 - 0.55 * Math.pow(f, 1.4); }
  cdMul() { return 1 + 0.25 * this.total; }
  steerPull() { const z = this.zones; return ((z.fl - z.fr) * 0.07 + (z.rl - z.rr) * 0.035); }

  // car: Vehicle, local: [a fwd, b left] contact point in car frame, n: world contact normal (into the car), v: closing speed
  hit(car, local, n, v, ground) {
    if (!local || v < 2) return;
    const sev = Math.min(1, (v - 2) / 26);
    const [a, b] = local;
    const key = (a >= 0 ? 'f' : 'r') + (b >= 0 ? 'l' : 'r');
    this.zones[key] = Math.min(1, this.zones[key] + sev * 0.9);
    // world contact point
    const s = Math.sin(car.yaw), c = Math.cos(car.yaw);
    const wx = car.x + s * a + c * b, wz = car.z + c * a - s * b, wy = (ground ? ground(wx, wz) : 0) + 0.5;
    if (this.model && sev > 0.03) this.dent(wx, wy, wz, n, sev);
    // debris + sparks
    const [vx, vz] = [car.u * s + car.v * c, car.u * c - car.v * s];
    const nd = Math.round(sev * 40);
    const paint = this.model?.paintMats?.[0]?.color || new THREE.Color(0x888888);
    for (let i = 0; i < nd && this.dp.length < MAX_DEBRIS; i++) {
      const col = Math.random() < 0.45 ? paint.clone() : new THREE.Color().setHSL(0, 0, 0.05 + Math.random() * 0.15);
      if (Math.random() < 0.15) col.setRGB(0.8, 0.85, 0.9);   // glass / chrome bits
      this.dp.push({ x: wx, y: wy, z: wz, vx: vx * 0.5 + n[0] * (1 + Math.random() * 4) + (Math.random() - 0.5) * 3, vy: 1 + Math.random() * 4 * (0.3 + sev), vz: vz * 0.5 + n[1] * (1 + Math.random() * 4) + (Math.random() - 0.5) * 3,
        rx: Math.random() * 6, ry: Math.random() * 6, wr: (Math.random() - 0.5) * 20, sz: 0.04 + Math.random() * 0.12 * (0.5 + sev), life: 6 + Math.random() * 6, col });
    }
    this.spark(wx, wy - 0.2, wz, vx, vz, n, 10 + sev * 60);
  }
  spark(x, y, z, vx, vz, n, count) {
    for (let i = 0; i < count && this.sp.length < MAX_SPARKS; i++)
      this.sp.push({ x, y, z, vx: vx * 0.7 + n[0] * Math.random() * 3 + (Math.random() - 0.5) * 4, vy: Math.random() * 3, vz: vz * 0.7 + n[1] * Math.random() * 3 + (Math.random() - 0.5) * 4, life: 0.25 + Math.random() * 0.45 });
  }

  // push the body in around the impact point; geometry is cloned on first damage so the showroom copy stays clean
  dent(wx, wy, wz, n, sev) {
    const M = this.model, root = M.root;
    root.updateMatrixWorld(true);
    const wheelSet = new Set(); for (const w of M.wheels || []) w.pivot?.traverse(o => wheelSet.add(o));
    const P = new THREE.Vector3(wx + n[0] * 0.15, wy, wz + n[1] * 0.15), D = new THREE.Vector3(n[0], -0.12, n[1]).normalize();
    const R = 0.6 + 0.75 * sev, depth = 0.06 + 0.3 * sev;
    const v = new THREE.Vector3(), inv = new THREE.Matrix4(), nm = new THREE.Matrix3();
    M.body.traverse(o => {
      if (!o.isMesh || wheelSet.has(o) || !o.geometry?.attributes?.position) return;
      o.updateMatrixWorld(true);
      // quick reject on the bounding sphere
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const bs = o.geometry.boundingSphere.clone().applyMatrix4(o.matrixWorld);
      if (bs.center.distanceTo(P) > bs.radius + R) return;
      if (!o.userData.dmgOwn) { o.geometry = o.geometry.clone(); o.userData.dmgOwn = true; }
      const g = o.geometry, pos = g.attributes.position, nor = g.attributes.normal;
      if (!this.orig.has(g)) this.orig.set(g, { pos: pos.array.slice(), nor: nor?.array.slice(), mesh: o });
      inv.copy(o.matrixWorld).invert();
      // dent direction in this mesh's local space (handles scaled glTF nodes)
      const Dl = D.clone().transformDirection(inv).multiplyScalar(depth / o.matrixWorld.getMaxScaleOnAxis());
      nm.getNormalMatrix(inv);
      let touched = 0;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        const d = v.distanceTo(P); if (d > R) continue;
        const f = (1 - d / R) ** 1.5, crumple = 0.7 + 0.6 * Math.sin(v.x * 23.1 + v.y * 17.3) * Math.sin(v.z * 19.7 - v.y * 11.9);
        pos.setXYZ(i, pos.getX(i) + Dl.x * f * crumple, pos.getY(i) + Dl.y * f * crumple, pos.getZ(i) + Dl.z * f * crumple);
        // crinkle the shading: tilt normals with the crumple pattern so the dent reads under reflections
        if (nor) { const k = f * sev * 0.9; nor.setXYZ(i, nor.getX(i) + Math.sin(v.x * 31 + v.z * 7) * k, nor.getY(i) + Math.sin(v.y * 29 + v.x * 5) * k, nor.getZ(i) + Math.sin(v.z * 27 + v.y * 3) * k); }
        touched++;
      }
      if (touched) { pos.needsUpdate = true; if (nor) { for (let i = 0; i < nor.count; i++) { v.fromBufferAttribute(nor, i).normalize(); nor.setXYZ(i, v.x, v.y, v.z); } nor.needsUpdate = true; } g.computeBoundingSphere(); }
    });
  }
  repair() {
    for (const [g, o] of this.orig) { g.attributes.position.array.set(o.pos); g.attributes.position.needsUpdate = true; if (o.nor) { g.attributes.normal.array.set(o.nor); g.attributes.normal.needsUpdate = true; } g.computeBoundingSphere(); }
    this.orig.clear();
    this.zones = { fl: 0, fr: 0, rl: 0, rr: 0 };
    this.dp.length = 0; this.sp.length = 0; this.sm.length = 0;
  }

  update(dt, car, ground) {
    this.t += dt;
    const G = 9.81, m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    // debris: ballistic, bounce + slide on the ground, settle
    for (let i = this.dp.length - 1; i >= 0; i--) {
      const d = this.dp[i]; d.life -= dt; if (d.life <= 0) { this.dp.splice(i, 1); continue; }
      const gy = ground ? ground(d.x, d.z) : 0;
      d.vy -= G * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt; d.rx += d.wr * dt; d.ry += d.wr * 0.7 * dt;
      if (d.y < gy + d.sz / 2) { d.y = gy + d.sz / 2; d.vy *= -0.3; d.vx *= 0.6; d.vz *= 0.6; d.wr *= 0.5; }
    }
    this.debris.count = this.dp.length;
    this.dp.forEach((d, i) => { m.compose(p.set(d.x, d.y, d.z), q.setFromEuler(e.set(d.rx, d.ry, 0)), sc.set(d.sz * 1.6, d.sz * 0.3, d.sz)); this.debris.setMatrixAt(i, m); this.debris.setColorAt(i, d.col); });
    this.debris.instanceMatrix.needsUpdate = true; if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true;
    // sparks
    const sa = this.sparks.geometry.attributes.position;
    for (let i = this.sp.length - 1; i >= 0; i--) { const s = this.sp[i]; s.life -= dt; if (s.life <= 0) { this.sp.splice(i, 1); continue; } s.vy -= G * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt; }
    this.sp.forEach((s, i) => sa.setXYZ(i, s.x, s.y, s.z)); sa.needsUpdate = true; this.sparks.geometry.setDrawRange(0, this.sp.length);
    // smoke from the engine bay when the front is badly damaged
    if (car && this.front > 0.45 && this.model) {
      const rate = (this.front - 0.4) * 40;
      if (Math.random() < rate * dt) {
        const s = Math.sin(car.yaw), c = Math.cos(car.yaw), a = (this.model.dims?.zN || 2) * 0.6;
        const x = car.x + s * a, z = car.z + c * a;
        this.sm.push({ x, y: (ground ? ground(x, z) : 0) + 1.0, z, vy: 0.8 + Math.random() * 0.6, life: 2.5 });
        if (this.sm.length > MAX_SMOKE) this.sm.shift();
      }
    }
    const ma = this.smoke.geometry.attributes.position;
    for (let i = this.sm.length - 1; i >= 0; i--) { const s = this.sm[i]; s.life -= dt; if (s.life <= 0) { this.sm.splice(i, 1); continue; } s.y += s.vy * dt; s.x += (Math.random() - 0.5) * 0.3 * dt; }
    this.sm.forEach((s, i) => ma.setXYZ(i, s.x, s.y, s.z)); ma.needsUpdate = true; this.smoke.geometry.setDrawRange(0, this.sm.length);
  }
  dispose() { for (const o of [this.debris, this.sparks, this.smoke]) { this.scene.remove(o); o.geometry.dispose(); o.material.dispose(); } }
}
