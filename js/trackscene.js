// Circuit scenery: rubbered-in asphalt, raised curbs, gravel traps, armco + tire walls, catch fences, grandstand with
// crowd, pit building + pit lane, start gantry with lights, sponsor boards, braking boards, marshal posts,
// two kinds of instanced trees, distant hills and a macro-varied grass ground.
// Everything is procedural (no extra downloads); counts scale with the graphics preset.
import * as THREE from '../vendor/three.module.js';
import { TERRAIN } from './track.js';

// ---------- small helpers ----------
const rng = seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
const vnoise = (x, y) => {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};
const fbm = (x, y) => vnoise(x, y) * 0.5 + vnoise(x * 2.1, y * 2.1) * 0.3 + vnoise(x * 4.3, y * 4.3) * 0.2;
const smooth01 = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function canvasTex(w, h, draw, { repeat, srgb = true, aniso = 8 } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (repeat) t.repeat.set(repeat[0], repeat[1]);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}
function merge(geos) {   // merge non-indexed position/normal/uv/color geometries
  const parts = geos.map(g => g.index ? g.toNonIndexed() : g);
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'color']) {
    if (!parts.every(g => g.attributes[name])) continue;
    const size = parts[0].attributes[name].itemSize;
    const arr = new Float32Array(parts.reduce((s, g) => s + g.attributes[name].count * size, 0));
    let o = 0; for (const g of parts) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  return out;
}
const shade = (geo, fn) => { // vertex colours from a function of the vertex position
  const p = geo.attributes.position, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const v = fn(p.getX(i), p.getY(i), p.getZ(i)); c[i * 3] = v[0]; c[i * 3 + 1] = v[1]; c[i * 3 + 2] = v[2]; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3)); return geo;
};

// ---------- track analysis (shared with physics for gravel / pit lane surfaces) ----------
export function analyzeTrack(T) {
  const N = T.N, hw = T.width / 2;
  const lat = k => { const h = T.head[k]; return [Math.cos(h), -Math.sin(h)]; };
  // which lateral side is the inside of the bend (+1 / -1)
  const inside = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const a = T.points[(k - 3 + N) % N], b = T.points[k], c = T.points[(k + 3) % N];
    const ax = a.x + c.x - 2 * b.x, az = a.z + c.z - 2 * b.z, [lx, lz] = lat(k);
    inside[k] = Math.sign(ax * lx + az * lz) || 1;
  }
  const curvAbs = k => Math.abs(T.rawCurv[(k + N) % N]);
  const smoothArr = (arr, win, it = 2) => { let a = arr; for (let n = 0; n < it; n++) { const b = new Float32Array(N); for (let k = 0; k < N; k++) { let s = 0; for (let j = -win; j <= win; j++) s += a[(k + j + N) % N]; b[k] = s / (2 * win + 1); } a = b; } return a; };
  // corners: curb where curvature is significant, gravel traps outside the faster/harder ones
  const curb = new Uint8Array(N), gravelRaw = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    let m = 0; for (let j = -5; j <= 5; j++) m = Math.max(m, curvAbs(k + j));
    curb[k] = m > 1 / 150 ? 1 : 0;
    let g = 0; for (let j = -10; j <= 6; j++) g = Math.max(g, curvAbs(k + j));   // gravel extends a little past the exit
    gravelRaw[k] = g > 1 / 110 ? 1 : 0;
  }
  const gravelW = T.street ? new Float32Array(N) : smoothArr(gravelRaw.map(g => g * 15), 6);
  const gravelSide = new Float32Array(N);
  for (let k = 0; k < N; k++) { let s = 0; for (let j = -10; j <= 6; j++) s += -inside[(k + j + N) % N] * curvAbs(k + j); gravelSide[k] = Math.sign(s) || 1; }
  // racing line: towards the inside at apexes, smoothed over ~60 m
  const rl = smoothArr(Array.from({ length: N }, (_, k) => inside[k] * hw * 0.78 * Math.min(1, curvAbs(k) * 110)), 18, 3);
  // braking zones: straight now, a corner within the next ~70 m
  const brake = new Float32Array(N);
  for (let k = 0; k < N; k++) { let m = 0; for (let j = 5; j < 35; j++) m = Math.max(m, curvAbs(k + j)); brake[k] = curvAbs(k) < 1 / 250 && m > 1 / 90 ? 1 : 0; }
  const brakeS = smoothArr(brake, 4, 1);
  // pit lane / grandstand zones on the main straight (x≈0, z -270..110)
  const PIT = { x0: hw + 3, x1: hw + 17, z0: -272, z1: -62 };
  const isPaved = (x, z) => x > PIT.x0 - 0.5 && x < PIT.x1 && z > PIT.z0 - 20 && z < PIT.z1 + 20;
  return { N, hw, lat, inside, curb, gravelW, gravelSide, rl, brake: brakeS, PIT, isPaved, curvAbs };
}

// ---------- materials / textures ----------
function curbTex() {
  return canvasTex(64, 256, (g, w, h) => {
    for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? '#f2f2f2' : '#d4161c'; g.fillRect(0, i * h / 4, w, h / 4); }
    for (let i = 0; i < 1500; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
  });
}
function gravelTex() {
  return canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#a8977a'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26000; i++) {
      const l = 120 + Math.random() * 110, r = 1 + Math.random() * 2.6;
      g.fillStyle = `rgb(${l},${l * 0.92},${l * 0.78})`; g.beginPath(); g.ellipse(Math.random() * w, Math.random() * h, r, r * (0.6 + Math.random() * 0.4), Math.random() * 3, 0, 7); g.fill();
    }
    for (let i = 0; i < 6000; i++) { g.fillStyle = `rgba(40,30,20,${Math.random() * 0.35})`; g.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5); }
  });
}
function macroTex() { // low-frequency variation to break up grass tiling
  const N = 256;
  return canvasTex(N, N, (g) => {
    const img = g.createImageData(N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const v = fbm(x / 22, y / 22) * 0.75 + fbm(x / 6 + 50, y / 6) * 0.25;
      const o = (y * N + x) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.round(v * 255); img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, { srgb: false });
}
const BRANDS = [
  ['TORQUEFORGE', '#ff5a1f', '#0d0f13'], ['APEX OIL', '#ffd200', '#14213d'], ['GRIDLINE TYRES', '#ffffff', '#c8102e'],
  ['VELOCE', '#0d0f13', '#f5f5f5'], ['NORTHWIND FUEL', '#ffffff', '#0b6e4f'], ['KESTREL BRAKES', '#111111', '#ffb020'],
];
function brandTex([name, fg, bg]) {
  return canvasTex(1024, 256, (g, w, h) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = fg; g.globalAlpha = 0.15; g.fillRect(0, h - 26, w, 26); g.globalAlpha = 1;
    g.font = '900 132px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name, w / 2, h / 2 + 4, w - 60);
  });
}
function garageTex() {
  return canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = '#dfe3e8'; g.fillRect(0, 0, w, h);
    // roller door
    g.fillStyle = '#9aa3ad'; g.fillRect(40, 50, w - 80, h - 50);
    for (let y = 54; y < h; y += 9) { g.fillStyle = '#7f8892'; g.fillRect(40, y, w - 80, 2); }
    g.fillStyle = '#c8102e'; g.fillRect(0, 0, w, 26);
  });
}

// ---------- the builder ----------
export class TrackScenery {
  constructor(scene, T, { pbrTex, quality }) {
    this.S = scene; this.T = T; this.A = analyzeTrack(T);
    this.group = new THREE.Group(); scene.add(this.group);
    this.pbrTex = pbrTex;
    this.scalable = [];   // { mesh, n } instanced meshes whose count follows the preset
    this.buildGround();
    this.buildAsphalt();
    this.buildCurbs();
    this.buildGravel();
    this.buildBarriers();
    this.buildPitAndGrandstand();
    this.buildGantry();
    this.buildBoards();
    this.keepOut = [];      // [x, z, r]: spots trees / city blocks must leave clear
    this.anim = [];         // things that move: (t, dt) => void
    this.buildCornerStands();
    this.buildCornerSigns();
    this.buildBridge();
    this.buildPaddock();
    this.buildCameraTowers();
    if (T.id === 'oval') this.buildFloodlights();
    this.buildHelicopter();
    if (T.street) this.buildCity();
    this.buildTrees();
    this.buildHills();
    this.drape();
    this.setQuality(quality);
  }
  add(o, shadow = false, receive = true) { o.castShadow = shadow; o.receiveShadow = receive; this.group.add(o); return o; }
  setQuality(q) {
    for (const s of this.scalable) { s.mesh.count = Math.max(1, Math.floor(s.n * (s.key === 'crowd' ? Math.max(0.35, q.trees) : q.trees))); if (s.shadowMin) s.mesh.castShadow = q.shadows >= s.shadowMin; }
  }

  // point at lateral offset o (metres, +lat side) of sample k
  at(k, o) { const T = this.T, N = T.N, p = T.points[(k + N) % N], [lx, lz] = this.A.lat((k + N) % N); return [p.x + lx * o, p.z + lz * o]; }

  // generic strip along the track. cols: [[offset, y], ...] (offset may be a function of k); returns BufferGeometry
  strip(k0, k1, cols, { uvV = 1, colorFn = null, closed = false } = {}) {
    const T = this.T, N = T.N, pos = [], uv = [], col = [], idx = [];
    const n = k1 - k0, C = cols.length;
    for (let i = 0; i <= n; i++) {
      const k = (k0 + i) % N;
      for (let c = 0; c < C; c++) {
        const o = typeof cols[c][0] === 'function' ? cols[c][0](k) : cols[c][0], y = typeof cols[c][1] === 'function' ? cols[c][1](k) : cols[c][1];
        const [x, z] = this.at(k, o);
        pos.push(x, y, z); uv.push(c / (C - 1), (k0 + i) * T.ds * uvV);
        if (colorFn) col.push(...colorFn(k, o, c));
      }
      if (i < n) for (let c = 0; c < C - 1; c++) { const a = i * C + c, b = a + C; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    if (colorFn) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx); g.computeVertexNormals();
    // ground-type strips must face up (column order decides the winding)
    const ny = g.attributes.normal.array.reduce((s, v, i) => i % 3 === 1 ? s + v : s, 0);
    if (ny < 0) { for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } g.setIndex(idx); g.computeVertexNormals(); }
    return g;
  }
  // contiguous runs of samples where pred(k) is true (wrapping)
  runs(pred) {
    const N = this.T.N, out = [];
    let start = -1;
    const first = (() => { for (let k = 0; k < N; k++) if (!pred(k)) return k; return 0; })();
    for (let i = 0; i <= N; i++) {
      const k = (first + i) % N, on = i < N && pred(k);
      if (on && start < 0) start = first + i;
      if (!on && start >= 0) { out.push([start, first + i]); start = -1; }
    }
    return out;
  }

  buildGround() {
    const tex = this.pbrTex('aerial_grass_rock_diff_1k.jpg', [900, 900], true), nor = this.pbrTex('aerial_grass_rock_nor_gl_1k.jpg', [900, 900]);
    const macro = macroTex();
    const mat = new THREE.MeshStandardMaterial({ map: tex, normalMap: nor, color: 0xb2c49a, roughness: 1, normalScale: new THREE.Vector2(0.6, 0.6) });
    mat.onBeforeCompile = sh => {
      sh.uniforms.macroMap = { value: macro };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vGW;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGW = (modelMatrix * vec4(transformed, 1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D macroMap; varying vec2 vGW;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          // anti-tiling: blend a second, rotated + rescaled sample of the same texture, weighted by noise
          vec2 uv2 = mat2(0.8, -0.6, 0.6, 0.8) * vMapUv * 0.37 + 0.21;
          vec4 t2 = texture2D(map, uv2);
          float bw = texture2D(macroMap, vGW / 37.0).r;
          diffuseColor.rgb = mix(diffuseColor.rgb, t2.rgb * diffuse, smoothstep(0.3, 0.7, bw));
          float mA = texture2D(macroMap, vGW / 420.0).r, mB = texture2D(macroMap, vGW / 61.0 + 0.37).r;
          float mv = mA * 0.7 + mB * 0.3;
          diffuseColor.rgb *= mix(vec3(0.78, 0.8, 0.7), vec3(1.12, 1.1, 0.98), mv);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.05, 0.98, 0.78), smoothstep(0.62, 0.8, mA) * 0.6);`);
    };
    mat.customProgramCacheKey = () => 'tf-grass';
    // detailed terrain around the circuit follows the track's height field; flat ground beyond it (with a hole cut
    // where the detailed patch sits, so the two never z-fight). UVs are world-mapped so the texture is seamless.
    const H = this.T.heightAt, R = TERRAIN, cell = 5, sink = -0.05;
    const uvOf = (x, z) => [(x + 3000) / 6000, (3000 - z) / 6000];
    if (H) {
      const nx = Math.round((R.x1 - R.x0) / cell), nz = Math.round((R.z1 - R.z0) / cell);
      const pos = new Float32Array((nx + 1) * (nz + 1) * 3), uv = new Float32Array((nx + 1) * (nz + 1) * 2), idx = [];
      for (let j = 0, v = 0; j <= nz; j++) for (let i = 0; i <= nx; i++, v++) {
        const x = R.x0 + i * cell, z = R.z0 + j * cell, edge = i === 0 || j === 0 || i === nx || j === nz;
        pos[v * 3] = x; pos[v * 3 + 1] = edge ? sink : H(x, z) + sink; pos[v * 3 + 2] = z;
        [uv[v * 2], uv[v * 2 + 1]] = uvOf(x, z);
      }
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i, b = a + nx + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
      const t = this.add(new THREE.Mesh(g, mat)); t.userData.noDrape = true;
      const sh = new THREE.Shape([new THREE.Vector2(-3000, -3000), new THREE.Vector2(3000, -3000), new THREE.Vector2(3000, 3000), new THREE.Vector2(-3000, 3000)]);
      sh.holes.push(new THREE.Path([new THREE.Vector2(R.x0, -R.z0), new THREE.Vector2(R.x0, -R.z1), new THREE.Vector2(R.x1, -R.z1), new THREE.Vector2(R.x1, -R.z0)]));
      const og = new THREE.ShapeGeometry(sh); og.rotateX(-Math.PI / 2); og.translate(0, sink, 0);
      const op = og.attributes.position, ou = og.attributes.uv; for (let i = 0; i < op.count; i++) { const [u, w] = uvOf(op.getX(i), op.getZ(i)); ou.setXY(i, u, w); }
      og.computeVertexNormals();
      const o = this.add(new THREE.Mesh(og, mat)); o.userData.noDrape = true;
    } else {
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), mat);
      ground.rotation.x = -Math.PI / 2; ground.userData.noDrape = true; this.add(ground);
    }
  }
  // lift everything that was laid out on flat ground onto the height field: world-space geometry per vertex,
  // placed objects by their position, instanced meshes per instance
  drape() {
    const H = this.T.heightAt; if (!H) return;
    const m = new THREE.Matrix4(), done = new Set();
    const visit = (o) => {
      if (o.userData.noDrape) return;
      if (o.isInstancedMesh) {
        for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); const e = m.elements; e[13] += H(e[12], e[14]); o.setMatrixAt(i, m); }
        o.instanceMatrix.needsUpdate = true; o.computeBoundingSphere?.(); return;
      }
      const atOrigin = o.position.lengthSq() === 0 && o.rotation.x === 0 && o.rotation.y === 0 && o.rotation.z === 0 && o.scale.x === 1 && o.scale.y === 1;
      if (atOrigin && o.isMesh) {
        if (done.has(o.geometry)) return; done.add(o.geometry);   // shared geometry: lift once
        const p = o.geometry.attributes.position;
        for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) + H(p.getX(i), p.getZ(i)));
        p.needsUpdate = true; o.geometry.computeBoundingSphere(); o.geometry.computeBoundingBox();
        return;
      }
      if (atOrigin && !o.isMesh) { for (const c of o.children) visit(c); return; }
      o.position.y += H(o.position.x, o.position.z);
    };
    for (const o of [...this.group.children]) visit(o);
  }

  buildAsphalt() {
    const T = this.T, A = this.A, hw = A.hw;
    const mat = new THREE.MeshStandardMaterial({
      map: this.pbrTex('asphalt_track_diff_1k.jpg', [3, 1], true), normalMap: this.pbrTex('asphalt_track_nor_gl_1k.jpg', [3, 1]),
      roughnessMap: this.pbrTex('asphalt_track_rough_1k.jpg', [3, 1]), roughness: 1, metalness: 0, color: 0xd0d0d0, vertexColors: true });
    const cols = []; for (let i = 0; i <= 24; i++) cols.push([hw - i * (2 * hw / 24), 0.02]);
    // resurfaced sections: some stretches were relaid at different times -> darker / lighter blocks with hard seams,
    // sometimes only one half of the track (a lane-width repair)
    const sect = [], rs = rng(808);
    for (let k = 0; k < T.N;) { const len = 25 + Math.floor(rs() * 70); sect.push({ k0: k, k1: k + len, v: rs() < 0.35 ? -0.13 - rs() * 0.08 : rs() < 0.3 ? 0.07 : 0, half: rs() < 0.25 ? (rs() < 0.5 ? 1 : -1) : 0 }); k += len; }
    const sectAt = new Int16Array(T.N); sect.forEach((q, i) => { for (let k = q.k0; k < Math.min(T.N, q.k1); k++) sectAt[k] = i; });
    const colorFn = (k, o) => {
      const d = (o - A.rl[k]) / 1.6;
      const rubber = Math.exp(-d * d) * (0.2 + 0.2 * A.brake[k]);
      const q = sect[sectAt[k]], relaid = q.half === 0 || Math.sign(o) === q.half ? q.v : 0;
      const patch = (fbm(k * 0.045, o * 0.12 + 3) - 0.5) * 0.16 + (fbm(k * 0.4, o * 0.9) - 0.5) * 0.06;
      const dust = smooth01(hw - 2.2, hw - 0.3, Math.abs(o)) * 0.08;
      const v = 1 - rubber + patch + dust + relaid;
      return [v, v, v * 1.01];
    };
    this.asphaltMat = mat;
    this.add(new THREE.Mesh(this.strip(0, T.N, cols, { uvV: 0.23, colorFn }), mat));
    this.buildSurfaceDetail();
    // edge lines
    const white = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.75 });
    this.add(new THREE.Mesh(this.strip(0, T.N, [[hw - 0.35, 0.028], [hw - 0.6, 0.028]]), white));
    this.add(new THREE.Mesh(this.strip(0, T.N, [[-hw + 0.6, 0.028], [-hw + 0.35, 0.028]]), white));
    // start / finish line + grid boxes
    const check = canvasTex(128, 16, (g) => { for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4'; g.fillRect(x * 4, y * 4, 4, 4); } });
    const p0 = T.points[0], h0 = T.head[0];
    const sl = new THREE.Mesh(new THREE.PlaneGeometry(T.width, 1.2), new THREE.MeshStandardMaterial({ map: check, roughness: 0.8 }));
    sl.rotation.x = -Math.PI / 2; const slG = new THREE.Group(); sl.position.y = 0.03; slG.add(sl); slG.position.set(p0.x, 0, p0.z); slG.rotation.y = h0; this.add(slG);
    for (let i = 0; i < 8; i++) {
      const k = T.N - 4 - i * 4, side = i % 2 ? 1 : -1;
      const [x, z] = this.at(k, side * hw * 0.45);
      const box = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.18), white); box.rotation.x = -Math.PI / 2;
      const g = new THREE.Group(); box.position.y = 0.029; g.add(box); g.position.set(x, 0, z); g.rotation.y = T.head[(k + T.N) % T.N]; this.add(g);
    }
  }

  // the things that make a real circuit's tarmac look used: rubber skid marks into the braking zones, black tar
  // crack-sealing snakes, oil / coolant stains, rubber "marbles" off line in the corners, patch repairs
  buildSurfaceDetail() {
    const T = this.T, A = this.A, N = T.N, hw = A.hw, rnd = rng(31337);
    const decal = (map, opacity = 1) => new THREE.MeshStandardMaterial({ map, transparent: true, opacity, depthWrite: false, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const lay = (k0, k1, o0, o1, mat, uvLen, y = 0.024) => {
      const g = this.strip(((k0 % N) + N) % N, ((k0 % N) + N) % N + (k1 - k0), [[o1, y], [o0, y]], { uvV: 1 / uvLen });
      this.add(new THREE.Mesh(g, mat));
    };
    // skid marks: pairs of streaks (left + right tire), fading in at the brake point, many cars' worth overlapping
    const skidT = canvasTex(64, 512, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      for (const x0 of [6, 46]) for (let n = 0; n < 3; n++) {
        const x = x0 + n * 3 + Math.random() * 3, a = 0.18 + Math.random() * 0.25;
        const grd = g.createLinearGradient(0, h, 0, 0); grd.addColorStop(0, 'rgba(8,8,8,0)'); grd.addColorStop(0.25, `rgba(8,8,8,${a})`); grd.addColorStop(0.85, `rgba(8,8,8,${a * 0.8})`); grd.addColorStop(1, 'rgba(8,8,8,0)');
        g.fillStyle = grd; g.fillRect(x, 0, 6 + Math.random() * 3, h);
      }
    });
    const skidM = decal(skidT);
    for (let k = 1; k < N; k++) {
      if (!(A.brake[k] > 0.5 && A.brake[k - 1] <= 0.5)) continue;
      for (let n = 0; n < 4; n++) {
        const len = 18 + rnd() * 25, k0 = k - Math.round(len / T.ds) + Math.round((rnd() - 0.3) * 8), o = A.rl[k] + (rnd() - 0.5) * 2.2;
        lay(k0, k0 + Math.round(len / T.ds), o - 0.95, o + 0.95, skidM, len);
      }
    }
    // tar snakes: wavy black crack-seal lines across the surface
    const tarT = canvasTex(256, 1024, (g, w, h) => {
      g.clearRect(0, 0, w, h); g.strokeStyle = 'rgba(10,10,10,0.85)'; g.lineCap = 'round';
      for (let n = 0; n < 5; n++) {
        let x = Math.random() * w; g.lineWidth = 2 + Math.random() * 3; g.beginPath(); g.moveTo(x, 0);
        for (let y = 0; y <= h; y += 16) { x += (Math.random() - 0.5) * 14; x = Math.max(4, Math.min(w - 4, x)); g.lineTo(x, y); }
        g.stroke();
      }
      for (let n = 0; n < 6; n++) {                      // a few transverse cracks too
        let y = Math.random() * h; g.lineWidth = 2 + Math.random() * 2; g.beginPath(); g.moveTo(0, y);
        for (let x = 0; x <= w; x += 12) { y += (Math.random() - 0.5) * 8; g.lineTo(x, y); } g.stroke();
      }
    });
    const tarM = decal(tarT, 0.9);
    for (let n = 0; n < Math.round(N / 70); n++) {
      const k0 = Math.floor(rnd() * N), len = 30 + rnd() * 60;
      lay(k0, k0 + Math.round(len / T.ds), -hw + 0.5, hw - 0.5, tarM, 40);
    }
    // oil / coolant stains + patch repairs (a sheet of scattered blotches)
    const stainT = canvasTex(512, 512, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      for (let n = 0; n < 10; n++) {
        const x = Math.random() * w, y = Math.random() * h, r = 8 + Math.random() * 30;
        const grd = g.createRadialGradient(x, y, 0, x, y, r); grd.addColorStop(0, 'rgba(15,14,12,0.55)'); grd.addColorStop(1, 'rgba(15,14,12,0)');
        g.fillStyle = grd; g.beginPath(); g.ellipse(x, y, r, r * (0.5 + Math.random() * 0.5), Math.random() * 3, 0, Math.PI * 2); g.fill();
      }
      for (let n = 0; n < 2; n++) {                      // square-cut patch repairs
        const x = Math.random() * (w - 120), y = Math.random() * (h - 120), pw = 50 + Math.random() * 70, ph = 50 + Math.random() * 70;
        g.fillStyle = 'rgba(25,25,27,0.55)'; g.fillRect(x, y, pw, ph); g.strokeStyle = 'rgba(5,5,5,0.8)'; g.lineWidth = 3; g.strokeRect(x, y, pw, ph);
      }
    });
    const stainM = decal(stainT, 0.8);
    for (let n = 0; n < Math.round(N / 120); n++) {
      const k0 = Math.floor(rnd() * N);
      lay(k0, k0 + Math.round(2 * hw / T.ds), -hw + 0.3, hw - 0.3, stainM, 2 * hw);
    }
    // marbles: rubber pellets thrown off line, collecting on the outside of corners
    const marbT = canvasTex(256, 256, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      for (let n = 0; n < 1400; n++) { const y = Math.random() * h, x = Math.pow(Math.random(), 0.6) * w; g.fillStyle = `rgba(12,12,12,${0.25 + Math.random() * 0.5})`; g.fillRect(x, y, 1.5 + Math.random() * 2.5, 1.5 + Math.random() * 2.5); }
    });
    const marbM = decal(marbT, 0.9);
    for (const [k0, k1] of this.runs(k => A.curvAbs(k) > 1 / 120)) {
      const km = Math.floor((k0 + k1) / 2) % N, s = -A.inside[km];
      const o0 = s > 0 ? hw - 3.2 : -hw + 0.4, o1 = s > 0 ? hw - 0.4 : -hw + 3.2;
      lay(k0, k1 + 8, o0, o1, marbM, 6);
    }
  }

  buildCurbs() {
    const A = this.A, hw = A.hw, tex = curbTex();
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.65 });
    // raised sawtooth-ish profile: track edge -> peak -> back down into the grass
    for (const [k0, k1] of this.runs(k => A.curb[k])) for (const s of [1, -1]) {
      const cols = s > 0 ? [[hw - 0.05, 0.02], [hw + 0.25, 0.075], [hw + 1.0, 0.085], [hw + 1.35, 0.03]] : [[-hw - 1.35, 0.03], [-hw - 1.0, 0.085], [-hw - 0.25, 0.075], [-hw + 0.05, 0.02]];
      const m = new THREE.Mesh(this.strip(k0, k1, cols, { uvV: 0.5 }), mat); this.add(m);
    }
  }

  buildGravel() {
    const A = this.A, hw = A.hw;
    const mat = new THREE.MeshStandardMaterial({ map: gravelTex(), roughness: 1, color: 0xf2f2f2, polygonOffset: true, polygonOffsetFactor: -1 });
    mat.map.repeat.set(4, 1);
    for (const [k0, k1] of this.runs(k => A.gravelW[k] > 0.4)) {
      const k = (k0 + k1) >> 1, s = A.gravelSide[k % this.T.N];
      const o0 = hw + 1.35, ow = k => o0 + A.gravelW[k % this.T.N];
      const cols = s > 0 ? [[o0, 0.012], [k => ow(k) - 0.6, 0.02], [ow, 0.006]] : [[k => -ow(k), 0.006], [k => -ow(k) + 0.6, 0.02], [-o0, 0.012]];
      this.add(new THREE.Mesh(this.strip(k0, k1, cols, { uvV: 0.08 }), mat));
    }
  }

  barrierOffset(k, s) { const A = this.A; return A.hw + (this.T.wallGap ?? 6.5) + (A.gravelSide[k] === s ? A.gravelW[k] : 0); }
  hasTires(k, s) { const A = this.A; return A.gravelSide[k] === s && A.gravelW[k] >= 10 && A.curvAbs(k) >= 1 / 75; }
  inPitZone(k, s) {
    const [x, z] = this.at(k, s * (this.A.hw + 3)), P = this.A.PIT;
    if (x > 0 && z > P.z0 - 8 && z < P.z1 + 8 && Math.abs(x) < 30) return true;          // pit wall side
    if (x < 0 && z > -78 && z < 108 && Math.abs(x) < 30) return true;                    // grandstand side
    return false;
  }
  buildBarriers() {
    const T = this.T, A = this.A, N = T.N;
    const steel = new THREE.MeshStandardMaterial({ color: 0xb7bcc2, metalness: 0.85, roughness: 0.35, side: THREE.DoubleSide });
    const postGeo = new THREE.BoxGeometry(0.12, 0.85, 0.12); postGeo.translate(0, 0.425, 0);
    const posts = [];
    for (const s of [1, -1]) {
      for (const [k0, k1] of this.runs(k => !this.inPitZone(k, s))) {
        const off = k => s * this.barrierOffset(k, s);
        if (T.street) {
          // concrete barrier wall with a painted base and a catch fence on top
          const cols = [[k => off(k) - s * 0.0, 0], [k => off(k), 1.1], [k => off(k) + s * 0.5, 1.1], [k => off(k) + s * 0.5, 0]];
          this.add(new THREE.Mesh(this.strip(k0, k1, cols), this.concreteMat ||= new THREE.MeshStandardMaterial({ color: 0xbfc2c4, roughness: 0.85, side: THREE.DoubleSide })), true, true);
          this.add(new THREE.Mesh(this.strip(k0, k1, [[k => off(k) - s * 0.01, 0.05], [k => off(k) - s * 0.01, 0.35]], { colorFn: (k) => (Math.floor(k * this.T.ds / 3) % 2 ? [0.8, 0.1, 0.12] : [0.95, 0.95, 0.95]) }),
            this.stripeMat ||= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide })), false, true);
          this.add(new THREE.Mesh(this.strip(k0, k1, [[k => off(k) + s * 0.25, 1.1], [k => off(k) + s * 0.25, 3.6]]), this.fenceMat ||= new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.5, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })));
          continue;
        }
        // W-profile double rail
        const cols = [[k => off(k), 0.42], [k => off(k) - s * 0.07, 0.52], [k => off(k), 0.62], [k => off(k) - s * 0.07, 0.72], [k => off(k), 0.82]];
        this.add(new THREE.Mesh(this.strip(k0, k1, cols), steel), false, true);
        for (let k = k0; k < k1; k += 2) posts.push([...this.at(k % N, off(k % N) + s * 0.12), T.head[k % N]]);
      }
    }
    const pm = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ color: 0x8a9096, metalness: 0.7, roughness: 0.5 }), posts.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
    posts.forEach(([x, z, h], i) => { m.compose(new THREE.Vector3(x, 0, z), q.setFromAxisAngle(up, h), one); pm.setMatrixAt(i, m); });
    this.add(pm);
    // tire walls in front of the barrier on the outside of the tightest corners
    const tires = [];
    for (let k = 0; k < N; k++) {
      if (A.gravelW[k] < 10 || A.curvAbs(k) < 1 / 75 || k % 1) continue;
      const s = A.gravelSide[k], off = this.barrierOffset(k, s) - 0.45;
      const segs = Math.max(1, Math.round(T.ds / 0.68));
      for (let j = 0; j < segs; j++) {
        const kk = k + j / segs, k0 = Math.floor(kk), f = kk - k0;
        const [xa, za] = this.at(k0, s * off), [xb, zb] = this.at(k0 + 1, s * off);
        const x = xa + (xb - xa) * f, z = za + (zb - za) * f;
        for (let r = 0; r < 2; r++) for (let h = 0; h < 3; h++) tires.push([x + Math.cos(T.head[k]) * s * r * 0.62, h * 0.24, z - Math.sin(T.head[k]) * s * r * 0.62, (Math.floor(kk * 1.5) % 6 === 0 && r === 0) ? 1 : 0]);
      }
    }
    const tg = new THREE.CylinderGeometry(0.32, 0.32, 0.24, 14, 1); tg.translate(0, 0.12, 0);
    const tm = new THREE.InstancedMesh(tg, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 }), tires.length);
    const black = new THREE.Color(0x161616), red = new THREE.Color(0xc8102e), white = new THREE.Color(0xd8d8d8);
    tires.forEach(([x, y, z, band], i) => { m.makeTranslation(x, y, z); tm.setMatrixAt(i, m); tm.setColorAt(i, band ? (Math.floor(x + z) % 2 ? red : white) : black); });
    this.add(tm, true);
  }

  buildPitAndGrandstand() {
    const A = this.A, P = A.PIT, hw = A.hw;
    const concrete = new THREE.MeshStandardMaterial({ color: 0xc9c6bf, roughness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.6, metalness: 0.4 });
    const box = (w, h, d, mat, x, y, z) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); b.position.set(x, y, z); return this.add(b, true); };
    // ---- pit lane: asphalt, pit wall with catch fence, garages ----
    const pitLen = P.z1 - P.z0;
    const asph = new THREE.MeshStandardMaterial({ map: this.pbrTex('asphalt_track_diff_1k.jpg', [(P.x1 - P.x0) / 13 * 3, pitLen * 0.23], true), roughness: 0.95, color: 0xb4b4b4 });
    const lane = new THREE.Mesh(new THREE.PlaneGeometry(P.x1 - P.x0 + 2, pitLen + 40), asph); lane.rotation.x = -Math.PI / 2; lane.position.set((P.x0 + P.x1) / 2, 0.018, (P.z0 + P.z1) / 2); this.add(lane);
    const line = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.8 });
    const ln = new THREE.Mesh(new THREE.PlaneGeometry(0.2, pitLen), line); ln.rotation.x = -Math.PI / 2; ln.position.set(P.x0 + 4.5, 0.025, (P.z0 + P.z1) / 2); this.add(ln);
    // pit wall (concrete, painted top stripe) + fence
    box(0.6, 1.05, pitLen, concrete, P.x0, 0.52, (P.z0 + P.z1) / 2);
    const stripe = new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.7 });
    box(0.62, 0.15, pitLen, stripe, P.x0, 0.98, (P.z0 + P.z1) / 2);
    this.fence(P.x0, P.z0, P.x0, P.z1, 1.05, 3.2);
    // garage block: ground floor roller doors, glass upper floor, roof
    const gx = P.x1 + 7, glen = pitLen - 10, gz = (P.z0 + P.z1) / 2;
    const gTex = garageTex(); gTex.repeat.set(glen / 7, 1);
    const front = new THREE.MeshStandardMaterial({ map: gTex, roughness: 0.6 });
    const walls = new THREE.MeshStandardMaterial({ color: 0xe6e8eb, roughness: 0.7 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x223344, roughness: 0.05, metalness: 0.9, envMapIntensity: 1.2 });
    const g1 = new THREE.Mesh(new THREE.BoxGeometry(14, 5, glen), [walls, front, walls, walls, walls, walls]); g1.position.set(gx, 2.5, gz); this.add(g1, true);
    const g2 = new THREE.Mesh(new THREE.BoxGeometry(12, 3.4, glen), [walls, glass, walls, walls, walls, walls]); g2.position.set(gx + 0.6, 6.7, gz); this.add(g2, true);
    box(15.5, 0.5, glen + 1.5, dark, gx - 0.4, 8.6, gz);
    // balcony rail + sponsor band
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.2, glen), new THREE.MeshBasicMaterial({ map: (() => { const t = brandTex(BRANDS[0]); t.repeat.set(glen / 14, 1); return t; })() }));
    band.position.set(gx - 7.05, 5.6, gz); band.rotation.y = 0; this.add(band);
    // control tower by the start line
    box(8, 14, 8, walls, gx, 7, P.z0 - 2);
    const tg = new THREE.Mesh(new THREE.CylinderGeometry(6.6, 6.6, 3.2, 8, 1), glass); tg.position.set(gx, 15.8, P.z0 - 2); this.add(tg, true);
    box(14, 0.5, 14, dark, gx, 17.6, P.z0 - 2);

    // ---- main grandstand opposite the pits ----
    const gsX = -hw - 9, gsZ0 = -70, gsZ1 = 100, rows = 14, rowD = 0.85, rowH = 0.48;
    const L = gsZ1 - gsZ0, zc = (gsZ0 + gsZ1) / 2;
    const prof = new THREE.Shape(); prof.moveTo(0, 0); prof.lineTo(0, 1.4);
    for (let r = 0; r < rows; r++) { prof.lineTo(-r * rowD, 1.4 + r * rowH); prof.lineTo(-(r + 1) * rowD, 1.4 + r * rowH); }
    prof.lineTo(-rows * rowD, 0); prof.closePath();
    const sg = new THREE.ExtrudeGeometry(prof, { depth: L, bevelEnabled: false }); sg.translate(0, 0, -L / 2);
    const stand = new THREE.Mesh(sg, concrete); stand.position.set(gsX, 0, zc); this.add(stand, true);
    // front wall + fence
    box(0.5, 1.2, L + 2, concrete, -hw - 4, 0.6, zc);
    box(0.52, 0.15, L + 2, stripe, -hw - 4, 1.15, zc);
    this.fence(-hw - 4, gsZ0 - 1, -hw - 4, gsZ1 + 1, 1.2, 3.6);
    // seats (instanced) + crowd
    const seatGeo = new THREE.BoxGeometry(0.42, 0.42, 0.46); seatGeo.translate(-0.15, 0.21, 0);
    const perRow = Math.floor(L / 0.55), seats = [];
    for (let r = 0; r < rows; r++) for (let i = 0; i < perRow; i++) seats.push([gsX - r * rowD - 0.4, 1.4 + r * rowH, gsZ0 + (i + 0.5) * L / perRow, r, i]);
    const seatM = new THREE.InstancedMesh(seatGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), seats.length);
    const mt = new THREE.Matrix4(), c = new THREE.Color();
    const SEAT = [new THREE.Color(0x1f4fa8), new THREE.Color(0xc8102e), new THREE.Color(0xf0f0f0), new THREE.Color(0xffb020)];
    seats.forEach(([x, y, z, r, i], n) => { mt.makeTranslation(x, y, z); seatM.setMatrixAt(n, mt); seatM.setColorAt(n, SEAT[(Math.floor(i / 24) + (r > 9 ? 1 : 0)) % 4]); });
    this.add(seatM);
    // spectators: body + head merged; random shirts, seated or standing
    const body = new THREE.CylinderGeometry(0.17, 0.2, 0.62, 6); body.translate(0, 0.31, 0);
    const head = new THREE.SphereGeometry(0.12, 6, 5); head.translate(0, 0.75, 0);
    const pg = merge([shade(body, () => [1, 1, 1]), shade(head, () => [0.93, 0.76, 0.62])]); pg.computeVertexNormals();
    const rnd = rng(4242), people = seats.filter(() => rnd() < 0.72);
    const crowd = new THREE.InstancedMesh(pg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), people.length);
    const SHIRT = [0xc8102e, 0xffffff, 0x1f4fa8, 0x222222, 0xffb020, 0x2e8b57, 0xff5a1f, 0x7a4fd0, 0x87ceeb, 0xf4f4a0];
    for (let i = people.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [people[i], people[j]] = [people[j], people[i]]; }
    const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3();
    people.forEach(([x, y, z], n) => {
      const stand = rnd() < 0.25, s = 0.9 + rnd() * 0.2;
      mt.compose(new THREE.Vector3(x - 0.05, y + (stand ? 0 : 0.18), z), q.setFromAxisAngle(up, Math.PI / 2 + (rnd() - 0.5) * 0.6), sc.set(s, stand ? s : s * 0.82, s));
      crowd.setMatrixAt(n, mt); crowd.setColorAt(n, c.setHex(SHIRT[Math.floor(rnd() * SHIRT.length)]));
    });
    this.add(crowd);
    this.scalable.push({ mesh: crowd, n: people.length, key: 'crowd' });
    // roof: columns at the back, cantilever beams rising towards the track (like a real grandstand, not an awning)
    const backX = gsX - rows * rowD, topY = 1.4 + rows * rowH, depth = rows * rowD + 4, tilt = 0.1;
    const roofY = x => topY + 4.2 + (x - backX) * Math.tan(tilt);         // roof height above a given x
    for (let z = gsZ0; z <= gsZ1 + 0.1; z += 17) {
      box(0.5, roofY(backX) + 0.2, 0.5, dark, backX - 0.3, (roofY(backX) + 0.2) / 2, z);
      const beam = box(depth, 0.45, 0.35, dark, backX + depth / 2 - 0.5, roofY(backX + depth / 2 - 0.5) + 0.3, z); beam.rotation.z = tilt;
      // diagonal tie from the column to the beam
      const tie = box(0.15, 5.2, 0.15, dark, backX + 1.6, roofY(backX) - 1.8, z); tie.rotation.z = -0.6;
    }
    const roof = box(depth, 0.25, L + 3, new THREE.MeshStandardMaterial({ color: 0xdfe2e6, roughness: 0.5, metalness: 0.3 }), backX + depth / 2 - 0.5, roofY(backX + depth / 2 - 0.5) + 0.6, zc);
    roof.rotation.z = tilt;
    // back wall: clad, with a sponsor band facing the paddock; closed ends
    const clad = new THREE.MeshStandardMaterial({ color: 0x3b4250, roughness: 0.7, metalness: 0.2 });
    box(0.4, roofY(backX) + 0.4, L, clad, backX - 0.6, (roofY(backX) + 0.4) / 2, zc);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(L, 2.2), new THREE.MeshBasicMaterial({ map: (() => { const t = brandTex(BRANDS[4]); t.repeat.set(L / 22, 1); return t; })() }));
    back.position.set(backX - 0.81, topY - 1.5, zc); back.rotation.y = -Math.PI / 2; this.add(back);
    const endShape = new THREE.Shape(); endShape.moveTo(0, 0); endShape.lineTo(0, 1.6); endShape.lineTo(-rows * rowD, topY + 0.2); endShape.lineTo(-rows * rowD - 0.8, roofY(backX) + 0.4); endShape.lineTo(-rows * rowD - 0.8, 0); endShape.closePath();
    for (const z of [gsZ0 - 0.15, gsZ1 + 0.15]) {
      const eg = new THREE.ExtrudeGeometry(endShape, { depth: 0.3, bevelEnabled: false }); eg.translate(0, 0, -0.15);
      const e = new THREE.Mesh(eg, clad); e.position.set(gsX, 0, z); this.add(e, true);
    }
    // sponsor band on the roof's front edge, facing the track
    const frontX = backX + depth - 0.6;
    const rb = new THREE.Mesh(new THREE.PlaneGeometry(L, 1.4), new THREE.MeshBasicMaterial({ map: (() => { const t = brandTex(BRANDS[1]); t.repeat.set(L / 20, 1); return t; })() }));
    rb.position.set(frontX + 0.05, roofY(frontX) + 0.1, zc); rb.rotation.y = Math.PI / 2; this.add(rb);
  }
  // catch fence: posts + transparent mesh between (x0,z0)-(x1,z1), from height y0, h tall
  fence(x0, z0, x1, z1, y0, h) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const tex = canvasTex(64, 64, (g, w) => { g.clearRect(0, 0, w, w); g.strokeStyle = 'rgba(200,205,210,0.85)'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, 0); g.lineTo(w, w); g.moveTo(w, 0); g.lineTo(0, w); g.stroke(); }, { srgb: true });
    tex.repeat.set(len / 0.12, h / 0.12);
    const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.25, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.5, depthWrite: true });
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(len, h), mat);
    pl.position.set((x0 + x1) / 2, y0 + h / 2, (z0 + z1) / 2); pl.rotation.y = Math.atan2(x1 - x0, z1 - z0) - Math.PI / 2; this.add(pl);
    const n = Math.ceil(len / 4), pg = new THREE.CylinderGeometry(0.05, 0.05, h, 6);
    const posts = new THREE.InstancedMesh(pg, new THREE.MeshStandardMaterial({ color: 0x6d7378, metalness: 0.7, roughness: 0.4 }), n + 1);
    const m = new THREE.Matrix4();
    for (let i = 0; i <= n; i++) { m.makeTranslation(x0 + (x1 - x0) * i / n, y0 + h / 2, z0 + (z1 - z0) * i / n); posts.setMatrixAt(i, m); }
    this.add(posts, true);
  }

  buildGantry() {
    const T = this.T, hw = this.A.hw, p0 = T.points[0], h0 = T.head[0];
    const g = new THREE.Group(); g.position.set(p0.x, 0, p0.z); g.rotation.y = h0; this.add(g, false, false);
    const truss = new THREE.MeshStandardMaterial({ color: 0x30343b, metalness: 0.7, roughness: 0.35 });
    const span = T.width + 6;
    for (const s of [-1, 1]) for (const dz of [-0.45, 0.45]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 7.4, 8), truss); p.position.set(s * span / 2, 3.7, dz); p.castShadow = true; g.add(p); }
    for (const y of [6.6, 7.8]) for (const dz of [-0.45, 0.45]) { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, span, 8), truss); b.rotation.z = Math.PI / 2; b.position.set(0, y, dz); b.castShadow = true; g.add(b); }
    for (let i = 0; i < 16; i++) { const x = -span / 2 + (i + 0.5) * span / 16, d = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.5, 6), truss); d.position.set(x, 7.2, 0.45); d.rotation.z = i % 2 ? 0.65 : -0.65; g.add(d); }
    // sign + start lights (5 pods, 2 red lamps each)
    const sign = new THREE.Mesh(new THREE.BoxGeometry(9, 1.3, 0.2), [truss, truss, truss, truss, new THREE.MeshBasicMaterial({ map: brandTex(BRANDS[0]) }), new THREE.MeshBasicMaterial({ map: brandTex(BRANDS[0]) })]);
    sign.position.set(0, 8.8, 0); g.add(sign);
    const lamp = new THREE.MeshStandardMaterial({ color: 0x220404, emissive: 0xff1010, emissiveIntensity: 0.25 });
    for (let i = 0; i < 5; i++) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.4, 0.35), truss); pod.position.set((i - 2) * 1.0, 5.9, -0.55); g.add(pod);
      for (const y of [-0.3, 0.3]) { const l = new THREE.Mesh(new THREE.CircleGeometry(0.22, 16), lamp); l.position.set((i - 2) * 1.0, 5.9 + y, -0.73); l.rotation.y = Math.PI; g.add(l); }
    }
  }

  buildBoards() {
    const T = this.T, A = this.A, N = T.N;
    const post = new THREE.MeshStandardMaterial({ color: 0x5c6168, metalness: 0.6, roughness: 0.5 });
    const brandMats = BRANDS.map(b => new THREE.MeshStandardMaterial({ map: brandTex(b), roughness: 0.55 }));
    // sponsor boards behind the barrier on straights, alternating sides
    let n = 0;
    for (let k = 10; k < N; k += 31) {
      if (A.curvAbs(k) > 1 / 300) continue;
      const s = (n % 2) ? 1 : -1;
      if (this.inPitZone(k, s)) continue;
      const off = s * (this.barrierOffset(k, s) + 2.2);
      const [x, z] = this.at(k, off);
      const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = T.head[k] + (s > 0 ? -Math.PI / 2 : Math.PI / 2);
      const b = new THREE.Mesh(new THREE.BoxGeometry(8, 1.8, 0.15), [post, post, post, post, brandMats[n % brandMats.length], post]); b.position.y = 1.9; b.castShadow = true; g.add(b);
      for (const dx of [-3.2, 3.2]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.9, 0.15), post); p.position.set(dx, 0.95, -0.1); g.add(p); }
      this.add(g, false, false); n++;
    }
    // braking boards 150 / 100 / 50 m before the corners that follow a straight
    const numTex = Object.fromEntries([150, 100, 50].map(v => [v, canvasTex(128, 160, (g, w, h) => { g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, w, h); g.strokeStyle = '#111'; g.lineWidth = 8; g.strokeRect(4, 4, w - 8, h - 8); g.fillStyle = '#111'; g.font = '900 64px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(v, w / 2, h / 2); })]));
    for (const [k0] of this.runs(k => A.curvAbs(k) > 1 / 85)) {
      const ks = k0 % N;
      let straight = true; for (let j = 8; j < 80; j++) if (A.curvAbs(ks - j) > 1 / 200) { straight = false; break; }
      if (!straight) continue;
      const s = A.gravelSide[ks] || 1;
      for (const d of [150, 100, 50]) {
        const k = (ks - Math.round(d / T.ds) + N) % N, [x, z] = this.at(k, s * (A.hw + 3.2));
        const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = T.head[k] + Math.PI;
        const b = new THREE.Mesh(new THREE.PlaneGeometry(1, 1.25), new THREE.MeshStandardMaterial({ map: numTex[d], roughness: 0.6, side: THREE.DoubleSide })); b.position.y = 1.45; g.add(b);
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, 0.1), post); p.position.y = 0.45; g.add(p);
        this.add(g, false, false);
      }
    }
    // marshal posts
    const hut = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.7 }), roof = new THREE.MeshStandardMaterial({ color: 0xff7a00, roughness: 0.6 });
    for (let k = 40, i = 0; k < N; k += 150, i++) {
      const s = i % 2 ? 1 : -1; if (this.inPitZone(k, s)) continue;
      const [x, z] = this.at(k, s * (this.barrierOffset(k, s) + 3));
      const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = T.head[k];
      const b = new THREE.Mesh(new THREE.BoxGeometry(2, 2.2, 2), hut); b.position.y = 1.1; b.castShadow = true; g.add(b);
      const r = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.18, 2.4), roof); r.position.y = 2.3; g.add(r);
      const fp = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 3.2, 5), new THREE.MeshStandardMaterial({ color: 0x999999 })); fp.position.set(1.2, 1.6, 0); g.add(fp);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.55), new THREE.MeshStandardMaterial({ color: i % 3 ? 0xffd200 : 0x18a050, side: THREE.DoubleSide })); flag.position.set(1.6, 2.9, 0); g.add(flag);
      this.add(g, false, false);
    }
  }

  buildTrees() {
    const T = this.T, A = this.A, rnd = rng(1234567);
    // foliage-card trees: a painted tree (trunk, branches, thousands of needles / leaves) on three crossed alpha-cut
    // cards. Reads like a real tree from any angle at a fraction of the cost of modelled leaves.
    const paint = (w, h, fn) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); fn(g, w, h); const t = bleed(g, w, h); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };
    // transparent canvas pixels are black (0,0,0,0) and mip-maps average them into the edges -> a dark outline.
    // Build the texture from raw pixels instead, giving every transparent pixel the average foliage colour.
    const bleed = (g, w, h) => {
      const d = g.getImageData(0, 0, w, h).data;
      let r = 0, gg = 0, b = 0, n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
      r /= n; gg /= n; b /= n;
      const out = new Uint8Array(d.length);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, o = ((h - 1 - y) * w + x) * 4, a = d[i + 3];   // flip rows (DataTexture isn't flipped)
        if (a < 250) { const k = a / 255; out[o] = d[i] * k + r * (1 - k); out[o + 1] = d[i + 1] * k + gg * (1 - k); out[o + 2] = d[i + 2] * k + b * (1 - k); }
        else { out[o] = d[i]; out[o + 1] = d[i + 1]; out[o + 2] = d[i + 2]; }
        out[o + 3] = a;
      }
      const t = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
      t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
      return t;
    };
    const pr = rng(4242);
    const pineTex = paint(512, 1024, (g, w, h) => {
      g.strokeStyle = '#33251b'; g.lineWidth = 12; g.beginPath(); g.moveTo(w / 2, h); g.lineTo(w / 2, 30); g.stroke();
      // whorls of drooping branches, longer toward the bottom. Each branch: a dark tapered mass, then layers of
      // needle sprays (dark inside, lighter tips catching the sun)
      for (let y = 40; y < h - 70; y += 13 + pr() * 10) {
        const t = (y - 30) / (h - 100), len = 22 + t * (w / 2 - 40) * (0.7 + pr() * 0.35);
        for (const sd of [-1, 1]) {
          const ex = w / 2 + sd * len, ey = y + len * (0.25 + pr() * 0.15), th = 7 + t * 16;
          g.fillStyle = `hsl(${125 + pr() * 15},30%,${9 + pr() * 5}%)`;
          g.beginPath(); g.moveTo(w / 2, y - th * 0.5); g.quadraticCurveTo(w / 2 + sd * len * 0.6, y, ex, ey); g.quadraticCurveTo(w / 2 + sd * len * 0.6, y + th * 1.6, w / 2, y + th); g.fill();
          for (let n = 0; n < 120; n++) {
            const f = pr(), bx = w / 2 + (ex - w / 2) * f, by = y + (ey - y) * f + (pr() - 0.3) * th * (1.1 - f);
            const l = 5 + 9 * pr(), tip = f * 0.6 + pr() * 0.4;
            g.strokeStyle = `hsl(${112 + pr() * 28},${30 + pr() * 20}%,${12 + tip * 22 + (1 - t) * 6}%)`; g.lineWidth = 1.8;
            const a = Math.PI / 2 + sd * (0.6 + pr() * 0.9);
            g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + Math.cos(a) * l * sd * -1, by + Math.abs(Math.sin(a)) * l * 0.8); g.stroke();
          }
        }
      }
    });
    const broadTex = paint(1024, 1024, (g, w, h) => {
      g.strokeStyle = '#3f2e20'; g.lineCap = 'round';
      const branch = (x, y, a, len, wd, d) => { const x2 = x + Math.cos(a) * len, y2 = y - Math.sin(a) * len; g.lineWidth = wd; g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke(); if (d > 0) for (let i = 0; i < 2; i++) branch(x2, y2, a + (i ? 0.5 : -0.5) + (pr() - 0.5) * 0.35, len * 0.7, wd * 0.62, d - 1); };
      branch(w / 2, h, Math.PI / 2, 300, 30, 5);
      // canopy = many leaf clumps of different sizes with gaps between them; each clump is shaded (dark core and
      // underside, sunlit top) and fringed with individual leaves so the outline is ragged, not a ball
      const clumps = [];
      for (let n = 0; n < 46; n++) { const a = pr() * Math.PI * 2, r = Math.pow(pr(), 0.6); clumps.push([w / 2 + Math.cos(a) * r * 390, 400 + Math.sin(a) * r * 300, 55 + pr() * 75]); }
      clumps.sort((a, b) => a[1] - b[1]);
      for (const [cx, cy, cr] of clumps) {
        const lit = Math.max(0, 1 - (cy - 80) / 650);
        for (let n = 0; n < 420; n++) {
          const a = pr() * Math.PI * 2, r = Math.sqrt(pr()) * cr, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.85;
          const top = (cy - y) / cr;                                    // +1 at the top of the clump
          const L = 8 + lit * 14 + Math.max(0, top) * 16 + (r / cr) * 6 + pr() * 8;
          g.fillStyle = `hsl(${78 + pr() * 34},${35 + pr() * 25}%,${L}%)`;
          g.beginPath(); g.ellipse(x, y, 5 + pr() * 6, 3 + pr() * 4, pr() * 3, 0, Math.PI * 2); g.fill();
        }
      }
    });
    const cards = (W, Hh) => {
      const parts = [];
      for (let i = 0; i < 3; i++) { const p = new THREE.PlaneGeometry(W, Hh); p.translate(0, Hh / 2, 0); p.rotateY(i * Math.PI / 3); parts.push(p); }
      const g = merge(parts);
      // soft "volume" normals (up + outward) so the cards light like a canopy instead of flipping bright/dark
      const p = g.attributes.position, nrm = g.attributes.normal;
      for (let i = 0; i < p.count; i++) { const v = new THREE.Vector3(p.getX(i) * 0.6, 0.8 + p.getY(i) / Hh, p.getZ(i) * 0.6).normalize(); nrm.setXYZ(i, v.x, v.y, v.z); }
      return g;
    };
    const pine = cards(9, 18), broad = cards(12, 12);
    const spots = { pine: [], broad: [] };
    const D = this.dragZone;
    for (let i = 0; i < 40000 && spots.pine.length + spots.broad.length < 2600; i++) {
      const x = -800 + rnd() * 2100, z = -1000 + rnd() * 2000;
      // clustered forests + a few lone trees: density from low-frequency noise
      const dens = fbm(x / 210 + 11, z / 210 - 3);
      if (rnd() > (dens > 0.52 ? 1 : 0.04)) continue;
      const nr = this.nearestD(x, z);
      if (nr < A.hw + 24) continue;
      if (x > -60 && x < 80 && z > -300 && z < 130) continue;          // pits, grandstand, main straight
      if (x > -215 && x < -145 && z > -480 && z < 560) continue;       // drag strip
      if (this.keepOut.some(([kx, kz, kr]) => (x - kx) ** 2 + (z - kz) ** 2 < kr * kr)) continue;
      const kind = dens > 0.55 || rnd() < 0.35 ? 'pine' : 'broad';
      spots[kind].push([x, z, 0.9 + rnd() * 0.8, rnd() * 6.28, rnd()]);
    }
    const mt = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3(), c = new THREE.Color();
    const make = (geo, list, tex, varFn) => {
      const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9 });
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      im.customDepthMaterial = new THREE.MeshDepthMaterial({ map: tex, alphaTest: 0.5, depthPacking: THREE.RGBADepthPacking });
      list.forEach(([x, z, s, r, v], i) => {
        mt.compose(new THREE.Vector3(x, 0, z), q.setFromAxisAngle(up, r), sc.set(s * (0.9 + v * 0.2), s * (0.85 + v * 0.35), s * (0.9 + v * 0.2)));
        im.setMatrixAt(i, mt); im.setColorAt(i, varFn(c, v));
      });
      this.add(im, true); return im;
    };
    const pines = make(pine, spots.pine, pineTex, (c, v) => c.setRGB(0.8 + v * 0.25, 0.85 + v * 0.2, 0.8 + v * 0.15));
    const broads = make(broad, spots.broad, broadTex, (c, v) => c.setRGB(0.85 + v * 0.25, 0.85 + v * 0.2, 0.75 + v * 0.2));
    const all = [...spots.pine, ...spots.broad];
    this.scalable.push({ mesh: pines, n: spots.pine.length, shadowMin: 2048 }, { mesh: broads, n: spots.broad.length, shadowMin: 2048 });
    this.treeCount = all.length;
  }
  // city blocks lining the street circuit: instanced boxes with window-band texture, kept clear of every part of the track
  buildCity() {
    const T = this.T, A = this.A, N = T.N;
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const win = (() => { const c = document.createElement('canvas'); c.width = 64; c.height = 128; const g = c.getContext('2d'); g.fillStyle = '#b3aca2'; g.fillRect(0, 0, 64, 128);
      for (let y = 6; y < 128; y += 16) for (let x = 4; x < 64; x += 15) { g.fillStyle = Math.random() < 0.25 ? '#e9d9a0' : '#2b3540'; g.fillRect(x, y, 10, 9); }
      const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t; })();
    const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
    const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 3, uv.getY(i) * 4);
    const mat = new THREE.MeshStandardMaterial({ map: win, roughness: 0.8 });
    const list = [];
    for (let k = 0; k < N; k += 6) for (const s of [1, -1]) {
      if (this.inPitZone(k, s)) continue;
      const w = 14 + rnd() * 16, d = 12 + rnd() * 14, h = 10 + rnd() * 34;
      const off = s * (this.barrierOffset(k, s) + 4 + d / 2);
      const [x, z] = this.at(k, off);
      if (this.nearestD(x, z) < A.hw + 4 + d * 0.5 || (x > -60 && x < 60 && z > -300 && z < 130)) continue;
      if (list.some(b => Math.hypot(b[0] - x, b[1] - z) < 13)) continue;
      if (this.keepOut.some(([kx, kz, kr]) => Math.hypot(x - kx, z - kz) < kr + Math.max(w, d) / 2)) continue;
      list.push([x, z, w, d, h, T.head[k], rnd()]);
    }
    const im = new THREE.InstancedMesh(geo, mat, list.length), m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
    list.forEach(([x, z, w, d, h, r, v], i) => { m.compose(new THREE.Vector3(x, 0, z), q.setFromAxisAngle(up, r), new THREE.Vector3(w, h, d)); im.setMatrixAt(i, m); im.setColorAt(i, c.setHSL(0.06 + v * 0.55, 0.14, 0.42 + v * 0.3)); });
    this.add(im, true, true);
    this.cityBlocks = list;
  }
  // ---------- race-day dressing ----------
  // corners worth dressing: runs of real curvature, with their apex sample, side (outside of the bend) and severity
  corners() {
    if (this._corners) return this._corners;
    const T = this.T, A = this.A, N = T.N, out = [];
    for (const [k0, k1] of this.runs(k => A.curvAbs(k) > 1 / 200)) {
      let apex = k0, m = 0, sum = 0;
      for (let k = k0; k < k1; k++) { const c = A.curvAbs(k % N); sum += c * T.ds; if (c > m) { m = c; apex = k; } }
      if (sum < 0.35) continue;                       // < ~20° of turn: a kink, not a corner
      out.push({ k0: k0 % N, k1: k1 % N, apex: apex % N, out: -A.inside[apex % N], angle: sum, sharp: m });
    }
    out.sort((a, b) => a.k0 - b.k0);
    return (this._corners = out);
  }
  // free ground for something of radius r centred at (x, z): clear of the track (with margin), pits, drag strip, other props
  clearAt(x, z, r, margin = 6) {
    const A = this.A;
    if (this.nearestD(x, z) < A.hw + margin + r) return false;
    if (x > -60 && x < 90 && z > -300 && z < 130) return false;
    if (x > -215 && x < -145 && z > -480 && z < 560) return false;
    return !this.keepOut.some(([kx, kz, kr]) => Math.hypot(x - kx, z - kz) < kr + r);
  }
  crowdGeo() {
    if (this._crowdGeo) return this._crowdGeo;
    const body = new THREE.CylinderGeometry(0.17, 0.2, 0.62, 6); body.translate(0, 0.31, 0);
    const legs = new THREE.CylinderGeometry(0.14, 0.12, 0.8, 5); legs.translate(0, -0.4, 0);
    const head = new THREE.SphereGeometry(0.12, 6, 5); head.translate(0, 0.75, 0);
    const g = merge([shade(body, () => [1, 1, 1]), shade(legs, () => [0.22, 0.24, 0.3]), shade(head, () => [0.93, 0.76, 0.62])]);
    g.translate(0, 0.8, 0); g.computeVertexNormals();
    return (this._crowdGeo = g);
  }
  // grandstands on the outside of the biggest corners + standing spectators on the banks of others
  buildCornerStands() {
    const T = this.T, A = this.A, N = T.N, rnd = rng(9090);
    const cs = this.corners().filter(c => !this.inPitZone(c.apex, c.out)).sort((a, b) => b.angle * b.sharp - a.angle * a.sharp);
    const concrete = new THREE.MeshStandardMaterial({ color: 0xc9c6bf, roughness: 0.9 });
    const roofM = new THREE.MeshStandardMaterial({ color: 0xe8eaee, roughness: 0.5, metalness: 0.3 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.6, metalness: 0.4 });
    const seatsAll = [], people = [];
    let stands = 0;
    const SEAT = [0x1f4fa8, 0xc8102e, 0xf0f0f0, 0xffb020, 0x2e8b57].map(c => new THREE.Color(c));
    const rows = 9, rowD = 0.85, rowH = 0.5, L = 44;
    for (const c of cs) {
      if (stands >= (T.street ? 2 : 3)) break;
      const k = c.apex, s = c.out;
      const off = this.barrierOffset(k, s) + 7;
      const [x, z] = this.at(k, s * (off + rows * rowD / 2));
      if (!this.clearAt(x, z, L / 2, 4)) continue;
      // face the apex: the stand's front runs along the track direction at the apex
      const g = new THREE.Group(); const [fx, fz] = this.at(k, s * off); g.position.set(fx, 0, fz);
      g.rotation.y = T.head[k] + (s > 0 ? 0 : Math.PI);        // local +x = away from the track
      // local frame: x = away from the track (rows step back along -x after the flip below), z = along the track
      const prof = new THREE.Shape(); prof.moveTo(0, 0); prof.lineTo(0, 1.3);
      for (let r = 0; r < rows; r++) { prof.lineTo(-r * rowD, 1.3 + r * rowH); prof.lineTo(-(r + 1) * rowD, 1.3 + r * rowH); }
      prof.lineTo(-rows * rowD, 0); prof.closePath();
      const sg = new THREE.ExtrudeGeometry(prof, { depth: L, bevelEnabled: false }); sg.translate(0, 0, -L / 2);
      const st = new THREE.Mesh(sg, concrete); st.rotation.y = Math.PI; st.castShadow = st.receiveShadow = true; g.add(st);
      // roof on four columns at the back + a front sponsor fascia
      const backX = rows * rowD, topY = 1.3 + rows * rowH + 3.2;
      for (const zz of [-L / 2 + 1, -L / 6, L / 6, L / 2 - 1]) { const col = new THREE.Mesh(new THREE.BoxGeometry(0.4, topY, 0.4), dark); col.position.set(backX + 0.3, topY / 2, zz); col.castShadow = true; g.add(col); }
      const roof = new THREE.Mesh(new THREE.BoxGeometry(backX + 2, 0.25, L + 1), roofM); roof.position.set(backX / 2 - 0.2, topY + 0.1, 0); roof.rotation.z = -0.06; roof.castShadow = true; g.add(roof);
      const fas = new THREE.Mesh(new THREE.PlaneGeometry(L, 1.2), new THREE.MeshBasicMaterial({ map: (() => { const t = brandTex(BRANDS[(stands + 1) % BRANDS.length]); t.repeat.set(L / 16, 1); return t; })() }));
      fas.position.set(-1.25, topY - 0.25, 0); fas.rotation.y = -Math.PI / 2; g.add(fas);
      this.add(g, false, false);
      g.updateMatrixWorld(true);
      const perRow = Math.floor(L / 0.55), v = new THREE.Vector3();
      for (let r = 0; r < rows; r++) for (let i = 0; i < perRow; i++) {
        v.set(r * rowD + 0.4, 1.3 + r * rowH, -L / 2 + (i + 0.5) * L / perRow).applyMatrix4(g.matrixWorld);
        seatsAll.push([v.x, v.y, v.z, g.rotation.y, SEAT[(Math.floor(i / 20) + stands) % SEAT.length]]);
        if (rnd() < 0.8) people.push([v.x, v.y - 0.38, v.z, g.rotation.y + Math.PI / 2 + (rnd() - 0.5) * 0.5, rnd() < 0.3]);
      }
      this.fenceAlong(k - 18, k + 18, s, this.barrierOffset(k, s) + 2.5, 3.2);
      this.keepOut.push([x, z, L / 2 + 6]);
      c.stand = true; stands++;
    }
    // spectator banks: a standing crowd behind a catch fence on the outside of other corners
    for (const c of cs) {
      if (c.stand || people.length > 4200) continue;
      const s = c.out, base = this.barrierOffset(c.apex, s) + 3.5;
      const [cx, cz] = this.at(c.apex, s * (base + 3));
      if (!this.clearAt(cx, cz, 12, 3)) continue;
      for (let k = c.apex - 14; k <= c.apex + 14; k++) {
        const kk = (k + N) % N; if (this.inPitZone(kk, s)) continue;
        for (let r = 0; r < 4; r++) for (let j = 0; j < 3; j++) {
          if (rnd() > 0.55) continue;
          const [x, z] = this.at(kk, s * (base + 0.8 + r * 0.9 + rnd() * 0.4));
          const along = (j - 1) * T.ds / 3, h = T.head[kk];
          people.push([x + Math.sin(h) * along, 0, z + Math.cos(h) * along, h + (s > 0 ? -Math.PI / 2 : Math.PI / 2) + (rnd() - 0.5) * 0.8, true]);
        }
      }
      this.fenceAlong(c.apex - 15, c.apex + 15, s, base, 2.6);
      this.keepOut.push([cx, cz, 26]);
    }
    if (seatsAll.length) {
      const seatGeo = new THREE.BoxGeometry(0.46, 0.42, 0.42); seatGeo.translate(0, 0.21, 0);
      const sm = new THREE.InstancedMesh(seatGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), seatsAll.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
      seatsAll.forEach(([x, y, z, r, col], i) => { m.compose(new THREE.Vector3(x, y, z), q.setFromAxisAngle(up, r), one); sm.setMatrixAt(i, m); sm.setColorAt(i, col); });
      this.add(sm);
    }
    if (people.length) {
      const SHIRT = [0xc8102e, 0xffffff, 0x1f4fa8, 0x222222, 0xffb020, 0x2e8b57, 0xff5a1f, 0x7a4fd0, 0x87ceeb, 0xf4f4a0];
      const im = new THREE.InstancedMesh(this.crowdGeo(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), people.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3(), c = new THREE.Color();
      for (let i = people.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [people[i], people[j]] = [people[j], people[i]]; }
      people.forEach(([x, y, z, r, standing], i) => {
        const k = 0.9 + rnd() * 0.2;
        m.compose(new THREE.Vector3(x, y, z), q.setFromAxisAngle(up, r), sc.set(k, k, k));
        im.setMatrixAt(i, m); im.setColorAt(i, c.setHex(SHIRT[Math.floor(rnd() * SHIRT.length)]));
      });
      this.add(im);
      this.scalable.push({ mesh: im, n: people.length, key: 'crowd' });
      // a little life: the crowd sways / jumps a few cm (cheap: move the whole instanced mesh)
      this.anim.push(t => { im.position.y = Math.abs(Math.sin(t * 2.3)) * 0.03; });
    }
  }
  // catch fence following the track between samples k0..k1 on side s at lateral offset `off`
  fenceAlong(k0, k1, s, off, h) {
    const N = this.T.N;
    const tex = this._fenceTex ||= canvasTex(64, 64, (g, w) => { g.clearRect(0, 0, w, w); g.strokeStyle = 'rgba(200,205,210,0.85)'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, 0); g.lineTo(w, w); g.moveTo(w, 0); g.lineTo(0, w); g.stroke(); });
    const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.25, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.5 });
    const geo = this.strip((k0 + N) % N, (k0 + N) % N + (k1 - k0), [[s * off, 0.2], [s * off, 0.2 + h]]);
    const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i) / 0.12, uv.getX(i) * h / 0.12);
    this.add(new THREE.Mesh(geo, mat));
  }
  // "T1", "T2"... number boards at each corner, on the outside just before the turn-in
  buildCornerSigns() {
    const T = this.T, A = this.A, N = T.N;
    const post = new THREE.MeshStandardMaterial({ color: 0x5c6168, metalness: 0.6, roughness: 0.5 });
    this.corners().forEach((c, i) => {
      const t = canvasTex(128, 128, (g, w, h) => { g.fillStyle = '#0d2c6b'; g.fillRect(0, 0, w, h); g.strokeStyle = '#fff'; g.lineWidth = 6; g.strokeRect(6, 6, w - 12, h - 12); g.fillStyle = '#fff'; g.font = '900 62px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('T' + (i + 1), w / 2, h / 2 + 3); });
      const k = (c.k0 - 6 + N) % N, s = c.out;
      if (this.inPitZone(k, s)) return;
      const [x, z] = this.at(k, s * (this.barrierOffset(k, s) + 1.2));
      const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = T.head[k] + Math.PI;
      const b = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, side: THREE.DoubleSide })); b.position.y = 2.1; g.add(b);
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.6, 0.1), post); p.position.y = 0.8; g.add(p);
      this.add(g, false, false);
    });
  }
  // a sponsor footbridge over the longest straight that isn't the start straight
  buildBridge() {
    const T = this.T, A = this.A, N = T.N;
    let best = null;
    for (const [k0, k1] of this.runs(k => A.curvAbs(k) < 1 / 400)) {
      const mid = ((k0 + k1) >> 1) % N, len = k1 - k0;
      if (mid < N * 0.15 || mid > N * 0.9 || len < 30) continue;
      if (!best || len > best.len) best = { k: mid, len };
    }
    if (!best) return;
    const k = best.k, h = T.head[k], p = T.points[k];
    const spanL = this.barrierOffset(k, 1) + 3, spanR = this.barrierOffset(k, -1) + 3, span = spanL + spanR, cy = 6.4;
    const g = new THREE.Group(); g.position.set(p.x, 0, p.z); g.rotation.y = h;
    const steel = new THREE.MeshStandardMaterial({ color: 0xdcdfe3, roughness: 0.4, metalness: 0.5 });
    const xc = (spanL - spanR) / 2;
    // towers with stairs, deck with railings, brand panels both faces (an arch-sponsor bridge like the classic ones)
    for (const sx of [spanL, -spanR]) {
      const tw = new THREE.Mesh(new THREE.BoxGeometry(3, cy + 1.2, 3), steel); tw.position.set(sx, (cy + 1.2) / 2, 0); tw.castShadow = true; g.add(tw);
    }
    const deck = new THREE.Mesh(new THREE.BoxGeometry(span + 3, 0.5, 2.6), steel); deck.position.set(xc, cy, 0); deck.castShadow = true; g.add(deck);
    const brand = BRANDS[2], t = brandTex(brand); t.repeat.set(1, 1);
    for (const dz of [-1.35, 1.35]) {
      const pan = new THREE.Mesh(new THREE.PlaneGeometry(span - 3, 2.2), new THREE.MeshBasicMaterial({ map: t })); pan.position.set(xc, cy + 1.45, dz); if (dz < 0) pan.rotation.y = Math.PI; g.add(pan);   // one-sided, facing out: reads right from both directions
      const rail = new THREE.Mesh(new THREE.BoxGeometry(span + 3, 0.1, 0.1), steel); rail.position.set(xc, cy + 2.7, dz); g.add(rail);
    }
    this.add(g, false, false);
    // a few spectators on the deck
    const n = 14, im = new THREE.InstancedMesh(this.crowdGeo(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), n), m = new THREE.Matrix4(), c = new THREE.Color(), rnd = rng(77);
    g.updateMatrixWorld(true);
    for (let i = 0; i < n; i++) { const v = new THREE.Vector3(xc + (rnd() - 0.5) * (span - 4), cy + 0.25, (rnd() - 0.5) * 1.6).applyMatrix4(g.matrixWorld); m.compose(v, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), h + (rnd() < 0.5 ? 0 : Math.PI)), new THREE.Vector3(1, 1, 1)); im.setMatrixAt(i, m); im.setColorAt(i, c.setHSL(rnd(), 0.6, 0.5)); }
    this.add(im);
    for (const sx of [spanL, -spanR]) { const [x, z] = this.at(k, sx); this.keepOut.push([x, z, 6]); }
  }
  // paddock behind the pit garages: team transporters, hospitality tents, motorhomes
  buildPaddock() {
    const A = this.A, P = A.PIT, rnd = rng(5150);
    const x0 = P.x1 + 7 + 7 + 6;                          // behind the garage block
    const trailerTex = BRANDS.map(b => { const t = brandTex(b); return new THREE.MeshStandardMaterial({ map: t, roughness: 0.45, metalness: 0.2 }); });
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f3f5, roughness: 0.45, metalness: 0.2 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.25, metalness: 0.9 });
    const tyre = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.9 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1a2430, roughness: 0.1, metalness: 0.6 });
    const g = new THREE.Group(); this.add(g, false, false);
    // paved paddock
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(70, P.z1 - P.z0 + 30), new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.95 }));
    pad.rotation.x = -Math.PI / 2; pad.position.set(x0 + 33, 0.015, (P.z0 + P.z1) / 2); pad.receiveShadow = true; g.add(pad);
    const wheelG = new THREE.CylinderGeometry(0.5, 0.5, 0.3, 12); wheelG.rotateZ(Math.PI / 2);
    let i = 0;
    for (let z = P.z0 + 12; z < P.z1 - 8; z += 9, i++) {
      // transporter: trailer + cab, parked nose-out toward the paddock road
      const tr = new THREE.Group(); tr.position.set(x0 + 9, 0, z);
      const box = new THREE.Mesh(new THREE.BoxGeometry(13.6, 3.6, 2.55), [white, white, white, white, trailerTex[i % trailerTex.length], trailerTex[(i + 2) % trailerTex.length]]);
      box.rotation.y = Math.PI / 2; box.position.set(0, 2.55, 0);
      // orient: long axis along x
      box.rotation.y = 0; box.geometry = new THREE.BoxGeometry(13.6, 3.6, 2.55); box.position.set(0, 2.55, 0); box.castShadow = true; tr.add(box);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 3.0, 2.5), white); cab.position.set(8.2, 2.1, 0); cab.castShadow = true; tr.add(cab);
      const ws = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.1), glass); ws.position.set(9.41, 2.9, 0); ws.rotation.y = Math.PI / 2; tr.add(ws);
      const grill = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.9), chrome); grill.position.set(9.41, 1.4, 0); grill.rotation.y = Math.PI / 2; tr.add(grill);
      for (const wx of [-5.5, -4.3, -3.1, 6.4, 8.6]) for (const wz of [-1.1, 1.1]) { const w = new THREE.Mesh(wheelG, tyre); w.position.set(wx, 0.5, wz); tr.add(w); }
      g.add(tr);
      // awning + tent between transporters, every other one
      if (i % 2 === 0) {
        const tent = new THREE.Mesh(new THREE.ConeGeometry(3.6, 2.2, 4, 1), new THREE.MeshStandardMaterial({ color: [0xffffff, 0xc8102e, 0x1f4fa8][i % 3], roughness: 0.8, side: THREE.DoubleSide }));
        tent.rotation.y = Math.PI / 4; tent.position.set(x0 + 26, 3.6, z + 4.5); g.add(tent);
        for (const [dx, dz] of [[-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5], [2.5, 2.5]]) { const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.5, 5), chrome); pole.position.set(x0 + 26 + dx, 1.25, z + 4.5 + dz); g.add(pole); }
      } else {
        // motorhome
        const mh = new THREE.Mesh(new THREE.BoxGeometry(8, 3.2, 2.5), white); mh.position.set(x0 + 30, 1.9, z); mh.castShadow = true; g.add(mh);
        const band = new THREE.Mesh(new THREE.BoxGeometry(8.02, 0.35, 2.52), new THREE.MeshStandardMaterial({ color: [0xff5a1f, 0x14213d, 0x0b6e4f][i % 3] })); band.position.set(x0 + 30, 1.6, z); g.add(band);
        for (const wx of [-2.6, 2.6]) for (const wz of [-1.1, 1.1]) { const w = new THREE.Mesh(wheelG, tyre); w.position.set(x0 + 30 + wx, 0.5, z + wz); g.add(w); }
      }
      // a few people milling about
    }
    this.keepOut.push([x0 + 30, (P.z0 + P.z1) / 2, (P.z1 - P.z0) / 2 + 20]);
    void rnd;
  }
  // TV camera scaffold towers at the two biggest corners (inside of the bend, behind the barrier)
  buildCameraTowers() {
    const T = this.T, scaf = new THREE.MeshStandardMaterial({ color: 0x8a9096, metalness: 0.7, roughness: 0.4 });
    const cs = [...this.corners()].sort((a, b) => b.angle - a.angle).slice(0, 2);
    for (const c of cs) {
      const s = -c.out, k = c.apex;
      if (this.inPitZone(k, s)) continue;
      const [x, z] = this.at(k, s * (this.barrierOffset(k, s) + 4));
      if (!this.clearAt(x, z, 2, 2)) continue;
      const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = T.head[k];
      const H = 6;
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, H, 5), scaf); p.position.set(dx, H / 2, dz); g.add(p); }
      for (let y = 1; y <= H; y += 1.5) for (const r of [0, Math.PI / 2]) {
        for (const d of [-1, 1]) { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2, 5), scaf); b.rotation.z = Math.PI / 2; b.rotation.y = r; const o = new THREE.Vector3(r ? d : 0, y, r ? 0 : d); b.position.copy(o); g.add(b); }
      }
      const deck = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, 2.4), new THREE.MeshStandardMaterial({ color: 0x55585c })); deck.position.y = H; g.add(deck);
      const cam = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.35, 0.7), new THREE.MeshStandardMaterial({ color: 0x1a1a1a })); cam.position.set(0, H + 1.4, 0); g.add(cam);
      const tri = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.2, 3, 1, true), scaf); tri.position.set(0, H + 0.65, 0); g.add(tri);
      const op = new THREE.Mesh(this.crowdGeo(), new THREE.MeshStandardMaterial({ color: 0x1f2a44, vertexColors: true })); op.position.set(0.6, H + 0.06 - 0.8, 0.5); g.add(op);
      this.add(g, false, false);
      this.keepOut.push([x, z, 4]);
      // the camera follows the action: pans slowly back and forth
      const ph = c.apex; this.anim.push(t => { cam.rotation.y = Math.sin(t * 0.4 + ph) * 0.9; });
    }
  }
  // oval: tall floodlight towers all round the outside
  buildFloodlights() {
    const T = this.T, N = T.N, steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.7, roughness: 0.4 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 0.6 });
    for (let k = 0; k < N; k += Math.round(90 / T.ds)) {
      const s = -this.A.inside[k] || 1;
      if (this.inPitZone(k, s)) continue;
      const [x, z] = this.at(k, s * (this.barrierOffset(k, s) + 12));
      if (!this.clearAt(x, z, 2, 6)) continue;
      const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = T.head[k] + (s > 0 ? -Math.PI / 2 : Math.PI / 2);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, 32, 8), steel); mast.position.y = 16; mast.castShadow = true; g.add(mast);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 0.4), steel); frame.position.set(0, 32.5, 0.5); frame.rotation.x = -0.35; g.add(frame);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) { const l = new THREE.Mesh(new THREE.CircleGeometry(0.42, 12), lamp); l.position.set(-1.8 + i * 1.2, 31.6 + j * 0.9, 0.75 + j * 0.3); l.rotation.x = -0.35; g.add(l); }
      this.add(g, false, false);
      this.keepOut.push([x, z, 4]);
    }
  }
  // TV helicopter circling over the circuit
  buildHelicopter() {
    const g = new THREE.Group();
    const body = new THREE.MeshStandardMaterial({ color: 0x1f4fa8, roughness: 0.4, metalness: 0.3 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.5 });
    const cab = new THREE.Mesh(new THREE.SphereGeometry(1.2, 14, 10), body); cab.scale.set(1, 0.85, 1.6); g.add(cab);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.32, 5, 8), body); boom.rotation.x = Math.PI / 2; boom.position.set(0, 0.3, -3.6); g.add(boom);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 0.8), body); fin.position.set(0, 0.9, -6); g.add(fin);
    const win = new THREE.Mesh(new THREE.SphereGeometry(1.0, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.4), new THREE.MeshStandardMaterial({ color: 0x0c1824, roughness: 0.05, metalness: 0.8 })); win.scale.set(1.05, 0.8, 1.45); win.position.set(0, 0.05, 0.35); win.rotation.x = 0.5; g.add(win);
    for (const sx of [-0.8, 0.8]) { const sk = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 3), dark); sk.position.set(sx, -1.25, 0); g.add(sk); }
    const rotor = new THREE.Group(); rotor.position.y = 1.2; g.add(rotor);
    for (let i = 0; i < 4; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 9), dark); b.rotation.y = i * Math.PI / 4 * 2 / 2 * 2; b.rotation.y = i * Math.PI / 2; b.position.y = 0; const bb = new THREE.Group(); bb.rotation.y = i * Math.PI / 4; bb.add(b); rotor.add(bb); }
    const tail = new THREE.Group(); tail.position.set(0.15, 0.9, -6.1); g.add(tail);
    for (let i = 0; i < 2; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.03, 1.4, 0.12), dark); b.rotation.x = i * Math.PI / 2; tail.add(b); }
    this.add(g, true, false);
    const T = this.T, pts = T.points;
    let cx = 0, cz = 0; for (const p of pts) { cx += p.x; cz += p.z; } cx /= pts.length; cz /= pts.length;
    let R = 0; for (const p of pts) R = Math.max(R, Math.hypot(p.x - cx, p.z - cz));
    R *= 0.7;
    this.anim.push((t, dt) => {
      const a = t * 0.045, x = cx + Math.cos(a) * R, z = cz + Math.sin(a) * R;
      g.position.set(x, 70 + Math.sin(t * 0.3) * 6, z);
      g.rotation.set(0.12, -a, 0.18);              // nose along the orbit, banked in
      rotor.rotation.y += dt * 38; tail.rotation.x += dt * 60;
    });
  }
  update(t, dt) { for (const f of this.anim) f(t, dt); }
  // wet track: darker, glossy asphalt (standing water reflects the sky)
  setWet(wet) {
    const m = this.asphaltMat; if (!m) return;
    m.color.set(wet ? 0x6f7276 : 0xd0d0d0); m.roughness = wet ? 0.32 : 1; m.envMapIntensity = wet ? 1.6 : 1; m.needsUpdate = true;
  }

  nearestD(x, z) {
    const T = this.T; let best = 1e9;
    for (let k = 0; k < T.N; k += 2) { const p = T.points[k], d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < best) best = d; }
    return Math.sqrt(best);
  }

  buildHills() {
    // ring of rolling hills well beyond the circuit, fading into the sky through fog
    const inner = 1300, outer = 2600, seg = 160, rings = 10;
    const pos = [], idx = [], col = [];
    const cx = 250, cz = 0;
    for (let r = 0; r <= rings; r++) for (let i = 0; i <= seg; i++) {
      const a = i / seg * Math.PI * 2, t = r / rings, rad = inner + (outer - inner) * t;
      const h = Math.max(0, (fbm(Math.cos(a) * 3 + 10, Math.sin(a) * 3 + 10) * 1.3 - 0.35)) * 260 * Math.sin(Math.PI * Math.min(1, t * 1.6)) + t * 40;
      pos.push(cx + Math.cos(a) * rad, h - 2, cz + Math.sin(a) * rad);
      const v = 0.75 + 0.25 * t; col.push(0.36 * v, 0.46 * v, 0.33 * v);
      if (r < rings && i < seg) { const p = r * (seg + 1) + i, n = p + seg + 1; idx.push(p, n, p + 1, n, n + 1, p + 1); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx); g.computeVertexNormals();
    this.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })), false, false);
  }
}
