// Visual mods for real (downloaded) car models. Everything is fitted to the actual body:
//  - analyzeShell(): height field + underside field of the model (once per loaded model)
//  - widebody: real deformation of the fenders/sills + bolt-on overfenders with rivets
//  - lip / splitter / canards / diffuser follow the bumper outline at the bumper's real height
//  - wings / ducktail mount on the measured trunk / hatch surface
//  - carbon hood / trunk / roof / doors: carbon weave on just that panel (shader region mask on the paint)
//  - louvres conform to the hood & fender tops, roll cages fit the cabin
import * as THREE from '../vendor/three.module.js';

const NX = 48, NZ = 140;
const v3 = new THREE.Vector3();

// ---------- shell analysis ----------
// Remove whatever is left of the model's own wheels (tire walls, spokes, brake discs) inside each wheel's cylinder.
// The download-time processing cuts most wheels out, but some models keep tire edges / inner rims that then show
// through or beside the build's wheels. Runs once per loaded model, before the shell is measured.
// some models ship the licence plate as a flat untextured black material: give it a plain blank plate (white, embossed
// border, small registration-style characters) mapped flat onto each plate (front and rear separately)
export function fixPlates(scene, label = 'TQF 000', dbg = null) {
  let tex = null;
  const plateTex = () => {
    if (tex) return tex;
    const c = document.createElement('canvas'); c.width = 512; c.height = 112;
    const x = c.getContext('2d');
    x.fillStyle = '#f2f2ee'; x.fillRect(0, 0, 512, 112);
    x.strokeStyle = '#1b1d22'; x.lineWidth = 6; x.strokeRect(8, 8, 496, 96);
    x.fillStyle = '#1b2a55'; x.font = 'bold 70px "DejaVu Sans Mono", monospace'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(label, 256, 60);
    tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    return tex;
  };
  const v = new THREE.Vector3();
  let n = 0;
  scene.updateMatrixWorld(true);
  scene.traverse(o => {
    if (!o.isMesh) return;
    const mats = [].concat(o.material);
    const hit = mats.map(m => m && !m.map && /lic.?plate|^plate$|license|registration/i.test(m.name) && m.color && m.color.getHSL({}).l < 0.15);
    if (!hit.some(Boolean)) return;
    let geo = o.geometry;
    const pos = geo.attributes.position, idx = geo.index;
    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: idx ? idx.count : pos.count, materialIndex: 0 }];
    // collect the plate vertices, split front / rear (shell space z)
    const sets = { f: new Set(), r: new Set() };
    for (const gr of groups) {
      if (!hit[gr.materialIndex || 0]) continue;
      for (let k = gr.start; k < gr.start + gr.count; k++) {
        const vi = idx ? idx.getX(k) : k;
        v.fromBufferAttribute(pos, vi).applyMatrix4(o.matrixWorld);
        sets[v.z > 0 ? 'f' : 'r'].add(vi);
      }
    }
    let uv = geo.attributes.uv;
    if (!uv) { uv = new THREE.Float32BufferAttribute(new Float32Array(pos.count * 2), 2); geo.setAttribute('uv', uv); }
    for (const [side, set] of Object.entries(sets)) {
      if (!set.size) continue;
      let x0 = 9, x1 = -9, y0 = 9, y1 = -9;
      const P = new Map();
      for (const vi of set) { v.fromBufferAttribute(pos, vi).applyMatrix4(o.matrixWorld); P.set(vi, [v.x, v.y]); x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
      const w = Math.max(1e-4, x1 - x0), h = Math.max(1e-4, y1 - y0);
      for (const [vi, [px, py]] of P) uv.setXY(vi, side === 'f' ? (px - x0) / w : (x1 - px) / w, (py - y0) / h);
    }
    uv.needsUpdate = true;
    const nm = mats.map((m, i) => hit[i] ? new THREE.MeshStandardMaterial({ name: m.name, map: plateTex(), roughness: 0.35, metalness: 0.15 }) : m);
    o.material = Array.isArray(o.material) ? nm : nm[0];
    n++;
  });
  if (n) return n;
  // no named plate: look for the shape instead. A plate (or the blank plate holder standing in for one) is a flat,
  // dark, untextured rectangle about 52×11 cm (EU/JP) or 30×15 cm (US), centred on the nose or tail, facing out.
  // Rays from in front of / behind the car find the surface you actually see there; its connected piece is the plate
  // if it has a plate's size and shape.
  const box = new THREE.Box3().setFromObject(scene), zMax = box.max.z, zMin = box.min.z;
  const geoUse = new Map(), meshes = [];
  scene.traverse(o => { if (o.isMesh) { geoUse.set(o.geometry, (geoUse.get(o.geometry) || 0) + 1); meshes.push(o); } });
  const found = { f: null, r: null };
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), nrm = new THREE.Vector3();
  const ray = new THREE.Raycaster();
  const tried = new Set();
  for (const side of ['f', 'r']) {
    for (let y = 0.25; y <= 1.0 && !found[side]; y += 0.04) for (const x of [0, -0.08, 0.08]) {
      if (found[side]) break;
      ray.set(new THREE.Vector3(x, y, side === 'f' ? zMax + 1 : zMin - 1), new THREE.Vector3(0, 0, side === 'f' ? -1 : 1));
      const h = ray.intersectObjects(meshes, false).find(h => { const m = [].concat(h.object.material)[h.face.materialIndex || 0]; return m && !m.transparent && m.visible !== false; });
      if (!h) continue;
      const o = h.object, mats = [].concat(o.material), m = mats[h.face.materialIndex || 0];
      if (m.map || !m.color || m.color.getHSL({}).l > 0.09 || /glass|light|lamp|lens/i.test(m.name)) continue;
      const geo = o.geometry, pos = geo.attributes.position, idx = geo.index;
      if (!idx) continue;
      const groups = geo.groups.length ? geo.groups : [{ start: 0, count: idx.count, materialIndex: 0 }];
      const kSeed = h.faceIndex * 3;
      const gr = groups.find(g => kSeed >= g.start && kSeed < g.start + g.count);
      if (!gr) continue;
      const tag = o.uuid + ':' + gr.start + ':' + side;
      if (tried.has(tag)) continue;
      const W = new Map(), wp = vi => { let p = W.get(vi); if (!p) { p = v.fromBufferAttribute(pos, vi).applyMatrix4(o.matrixWorld).toArray(); W.set(vi, p); } return p; };
      // triangles of this material near the seed, joined by welded vertices
      const sp = h.point, tris = [];
      for (let k = gr.start; k + 2 < gr.start + gr.count; k += 3) {
        const a = idx.getX(k), b = idx.getX(k + 1), c = idx.getX(k + 2), pa = wp(a), pb = wp(b), pc = wp(c);
        const cx = (pa[0] + pb[0] + pc[0]) / 3, cy = (pa[1] + pb[1] + pc[1]) / 3, cz = (pa[2] + pb[2] + pc[2]) / 3;
        if (Math.abs(cx - sp.x) > 0.45 || Math.abs(cy - sp.y) > 0.3 || Math.abs(cz - sp.z) > 0.3) continue;
        tris.push([k, a, b, c]);
      }
      const keyOf = vi => wp(vi).map(q => Math.round(q * 1000)).join(',');
      const par = tris.map((_, i) => i), find = i => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
      const byKey = new Map();
      tris.forEach((t, i) => { for (const vi of t.slice(1)) { const kk = keyOf(vi); const j = byKey.get(kk); if (j == null) byKey.set(kk, i); else par[find(i)] = find(j); } });
      const si = tris.findIndex(t => t[0] === kSeed);
      if (si < 0) continue;
      const root = find(si), list = tris.filter((_, i) => find(i) === root);
      let x0 = 9, x1 = -9, y0 = 9, y1 = -9, z0 = 9, z1 = -9, area = 0, nz = 0;
      for (const [, a, b, c] of list) {
        for (const vi of [a, b, c]) { const p = wp(vi); x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
        A.fromArray(wp(a)); B.fromArray(wp(b)); C.fromArray(wp(c));
        nrm.crossVectors(B.sub(A), C.sub(A)); area += nrm.length() / 2; nz += Math.abs(nrm.z) / 2;
      }
      const w = x1 - x0, hh = y1 - y0, d = z1 - z0;
      if (dbg) dbg.push([side, o.name.slice(0, 14), m.name.slice(0, 14), w, hh, d, area, nz, list.length].map(q => typeof q === 'number' ? +q.toFixed(3) : q).join(' '));
      const plateLike = w > 0.26 && w < 0.6 && hh > 0.08 && hh < 0.21 && w / hh > 1.5 && w / hh < 6;
      if (!plateLike || Math.abs(x0 + x1) > 0.12 || d > 0.1 || nz < area * 0.6 || nz < w * hh * 0.5) { tried.add(tag); continue; }
      found[side] = { o, gr, list, x0, x1, y0, y1, side };
    }
  }
  // fallback for a side the rays didn't settle: scan dark untextured pieces near the nose / tail centre for the
  // best plate-shaped one (catches plates set slightly off the centre line or below a bumper overhang)
  for (const side of ['f', 'r']) {
    if (found[side]) continue;
    for (const o of meshes) {
      const mats = [].concat(o.material), geo = o.geometry, pos = geo.attributes.position, idx = geo.index;
      if (!idx) continue;
      const dark = mats.map(m => m && !m.map && !m.transparent && m.color && m.color.getHSL({}).l < 0.09 && !/glass|light|lamp|lens|grill|grille|mesh|vent|window/i.test(m.name));
      if (!dark.some(Boolean)) continue;
      const groups = geo.groups.length ? geo.groups : [{ start: 0, count: idx.count, materialIndex: 0 }];
      const W = new Map(), wp = vi => { let q = W.get(vi); if (!q) { q = v.fromBufferAttribute(pos, vi).applyMatrix4(o.matrixWorld).toArray(); W.set(vi, q); } return q; };
      for (const gr of groups) {
        if (!dark[gr.materialIndex || 0]) continue;
        const tris = [];
        for (let k = gr.start; k + 2 < gr.start + gr.count; k += 3) {
          const a = idx.getX(k), b = idx.getX(k + 1), c = idx.getX(k + 2), pa = wp(a), pb = wp(b), pc = wp(c);
          const cx = (pa[0] + pb[0] + pc[0]) / 3, cz = (pa[2] + pb[2] + pc[2]) / 3;
          if (Math.abs(cx) > 0.35 || (side === 'f' ? cz < zMax - 0.5 : cz > zMin + 0.5)) continue;
          tris.push([k, a, b, c]);
        }
        if (!tris.length || tris.length > 20000) continue;
        const keyOf = vi => wp(vi).map(q => Math.round(q * 1000)).join(',');
        const par = tris.map((_, i) => i), find = i => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
        const byKey = new Map();
        tris.forEach((t, i) => { for (const vi of t.slice(1)) { const kk = keyOf(vi); const jj = byKey.get(kk); if (jj == null) byKey.set(kk, i); else par[find(i)] = find(jj); } });
        const comps = new Map();
        tris.forEach((t, i) => { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(t); });
        for (const list of comps.values()) {
          let x0 = 9, x1 = -9, y0 = 9, y1 = -9, z0 = 9, z1 = -9, area = 0, nz = 0;
          for (const [, a, b, c] of list) {
            for (const vi of [a, b, c]) { const q = wp(vi); x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[2]); }
            A.fromArray(wp(a)); B.fromArray(wp(b)); C.fromArray(wp(c));
            nrm.crossVectors(B.sub(A), C.sub(A)); area += nrm.length() / 2; nz += Math.abs(nrm.z) / 2;
          }
          const w = x1 - x0, hh = y1 - y0, d = z1 - z0;
          const eu = w > 0.44 && w < 0.58 && hh > 0.08 && hh < 0.16, us = w > 0.26 && w < 0.36 && hh > 0.12 && hh < 0.2;
          if (!(eu || us) || Math.abs(x0 + x1) > 0.12 || d > 0.08 || y0 < 0.12 || y1 > 1.1 || nz < area * 0.7 || nz < w * hh * 0.55) continue;
          // must be the outermost thing there: nothing else further out right in front of its middle
          ray.set(new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, side === 'f' ? zMax + 1 : zMin - 1), new THREE.Vector3(0, 0, side === 'f' ? -1 : 1));
          const hit = ray.intersectObjects(meshes, false).find(hh2 => { const m = [].concat(hh2.object.material)[hh2.face.materialIndex || 0]; return m && !m.transparent; });
          if (!hit || Math.abs(hit.point.z - (side === 'f' ? z1 : z0)) > 0.03) continue;
          const score = Math.abs(nz - w * hh);
          if (!found[side] || score < found[side].score) found[side] = { o, gr, list, x0, x1, y0, y1, side, score };
        }
      }
    }
  }
  // apply: per mesh + material group, move all its plate triangles to the end of the group as a new group with the
  // plate material (one pass per group, so a front and rear plate sharing a group don't scramble each other)
  const jobs = new Map();
  for (const f of Object.values(found)) { if (!f) continue; const k = f.o.uuid + ':' + f.gr.start; if (!jobs.has(k)) jobs.set(k, []); jobs.get(k).push(f); }
  for (const fs of jobs.values()) {
    const o = fs[0].o;
    if (geoUse.get(o.geometry) > 1) { o.geometry = o.geometry.clone(); geoUse.set(o.geometry, 1); }
    const geo = o.geometry, idx = geo.index, pos = geo.attributes.position;
    if (!geo.groups.length) geo.addGroup(0, idx.count, 0);
    const g0 = geo.groups.find(g => g.start === fs[0].gr.start) || geo.groups[0];
    const take = new Set(fs.flatMap(f => f.list.map(t => t[0])));
    const keep = [], plate = [];
    for (let k = g0.start; k + 2 < g0.start + g0.count; k += 3) (take.has(k) ? plate : keep).push(idx.getX(k), idx.getX(k + 1), idx.getX(k + 2));
    const arr = [...keep, ...plate];
    for (let k = 0; k < arr.length; k++) idx.setX(g0.start + k, arr[k]);
    idx.needsUpdate = true;
    const mats = [].concat(o.material), mi = mats.length;
    mats.push(new THREE.MeshStandardMaterial({ name: 'tf_plate', map: plateTex(), roughness: 0.35, metalness: 0.15 }));
    o.material = mats;
    g0.count = keep.length;
    geo.addGroup(g0.start + keep.length, plate.length, mi);
    let uv = geo.attributes.uv;
    if (!uv) { uv = new THREE.Float32BufferAttribute(new Float32Array(pos.count * 2), 2); geo.setAttribute('uv', uv); }
    for (const f of fs) {
      const w = Math.max(1e-4, f.x1 - f.x0), h = Math.max(1e-4, f.y1 - f.y0);
      for (const vi of new Set(f.list.flatMap(t => [t[1], t[2], t[3]]))) { v.fromBufferAttribute(pos, vi).applyMatrix4(o.matrixWorld); uv.setXY(vi, f.side === 'f' ? (v.x - f.x0) / w : (f.x1 - v.x) / w, (v.y - f.y0) / h); }
      n++;
    }
    uv.needsUpdate = true;
  }
  return n;
}

export function scrubWheels(scene, man) {
  const ws = man.wheels; if (!ws?.length) return 0;
  scene.updateMatrixWorld(true);
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const geoUse = new Map();
  scene.traverse(o => { if (o.isMesh) geoUse.set(o.geometry, (geoUse.get(o.geometry) || 0) + 1); });
  // inside a wheel: within the radius, from just inboard of the tire to well outboard (some models carry a second,
  // wider wheel set). Wheel-named materials (tire / rim / brake) are removed out to 1.25 r.
  const WHEELMAT = /tire|tyre|rim\b|rims|wheel|brake|caliper|disc|rotor|hub|spoke|lug/i;
  let wheelish = false;
  const inside = v => ws.some(w => {
    if (Math.sign(v.x) !== Math.sign(w.x)) return false;
    const dx = Math.abs(v.x) - Math.abs(w.x), rr = Math.hypot(v.y - (w.y ?? w.r), v.z - w.z);
    if (wheelish) return dx > -w.tw / 2 - 0.12 && dx < w.tw / 2 + 0.2 && rr < w.r * 1.25;
    return dx > -w.tw / 2 - 0.045 && dx < w.tw / 2 + 0.14 && rr < w.r * 1.02;
  });
  let removed = 0;
  scene.traverse(o => {
    if (!o.isMesh || o.isSkinnedMesh || o.morphTargetInfluences) return;
    let g = o.geometry; const pos = g.attributes.position; if (!pos) return;
    const idx = g.index, n = idx ? idx.count : pos.count;
    const groups = g.groups?.length ? g.groups.map(gr => ({ ...gr })) : [{ start: 0, count: n, materialIndex: 0, whole: true }];
    const keep = [], newGroups = [];
    let drop = 0;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const gr of groups) {
      const start = keep.length;
      const mt = mats[gr.materialIndex ?? 0] || mats[0];
      wheelish = WHEELMAT.test((mt?.name || '') + ' ' + o.name) && !/paint|body|glass|window|light|lamp|steer/i.test((mt?.name || '') + ' ' + o.name);
      for (let t = gr.start; t < Math.min(n, gr.start + gr.count); t += 3) {
        const ia = idx ? idx.getX(t) : t, ib = idx ? idx.getX(t + 1) : t + 1, ic = idx ? idx.getX(t + 2) : t + 2;
        A.fromBufferAttribute(pos, ia).applyMatrix4(o.matrixWorld); B.fromBufferAttribute(pos, ib).applyMatrix4(o.matrixWorld); C.fromBufferAttribute(pos, ic).applyMatrix4(o.matrixWorld);
        // a triangle goes only when all three corners are inside a wheel (fender liners / arches straddle the edge and stay)
        if (inside(A) && inside(B) && inside(C)) { drop++; continue; }
        keep.push(ia, ib, ic);
      }
      newGroups.push({ start, count: keep.length - start, materialIndex: gr.materialIndex, whole: gr.whole });
    }
    if (!drop) return;
    if (geoUse.get(g) > 1) { g = g.clone(); o.geometry = g; }
    g.setIndex(keep);
    g.clearGroups();
    if (!newGroups[0].whole) for (const gr of newGroups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    removed += drop;
  });
  return removed;
}

export function analyzeShell(scene, man) {
  const W = man.W, L = man.L;
  const top = new Float32Array(NX * NZ).fill(-1), low = new Float32Array(NX * NZ).fill(9);
  const ws = man.wheels || [];
  const archX = ws.map(() => 0);
  scene.updateMatrixWorld(true);
  // rasterise triangles (not just vertices): low-poly models have big flat panels with almost no vertices
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), P = new THREE.Vector3();
  const cellS = Math.min(W / NX, L / NZ) * 0.8;
  const topMat = new Array(NX * NZ).fill(null), sideMatP = new Array(NZ * 40).fill(null), sideMatN = new Array(NZ * 40).fill(null);
  let curMat = null;
  const NY = 40, sideP = new Float32Array(NZ * NY), sideN = new Float32Array(NZ * NY);
  const put = v => {
    const ix = Math.floor((v.x / W + 0.5) * NX), iz = Math.floor((v.z / L + 0.5) * NZ);
    if (ix < 0 || ix >= NX || iz < 0 || iz >= NZ) return;
    const k = iz * NX + ix;
    if (v.y > top[k]) { top[k] = v.y; topMat[k] = curMat; }
    if (v.y > 0.03 && v.y < low[k]) low[k] = v.y;
    const iy = Math.floor(v.y / 1.6 * NY);
    if (iy >= 0 && iy < NY) { const j = iz * NY + iy; if (v.x > 0) { if (v.x > sideP[j]) { sideP[j] = v.x; sideMatP[j] = curMat; } } else if (-v.x > sideN[j]) { sideN[j] = -v.x; sideMatN[j] = curMat; } }
    for (let w = 0; w < ws.length; w++) {
      const W0 = ws[w], wy = W0.y ?? W0.r;
      if (Math.sign(v.x) === Math.sign(W0.x) && Math.abs(v.z - W0.z) < W0.r * 1.3 && v.y > wy && v.y < wy + W0.r * 1.4) archX[w] = Math.max(archX[w], Math.abs(v.x));
    }
  };
  scene.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position, idx = o.geometry.index, M = o.matrixWorld;
    curMat = Array.isArray(o.material) ? o.material[0] : o.material;
    const n = idx ? idx.count : pos.count;
    for (let t = 0; t < n; t += 3) {
      const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
      A.fromBufferAttribute(pos, i0).applyMatrix4(M); B.fromBufferAttribute(pos, i1).applyMatrix4(M); C.fromBufferAttribute(pos, i2).applyMatrix4(M);
      const e = Math.max(Math.hypot(A.x - B.x, A.z - B.z), Math.hypot(B.x - C.x, B.z - C.z), Math.hypot(C.x - A.x, C.z - A.z));
      const m = Math.min(40, Math.ceil(e / cellS));
      if (m <= 1) { put(A); put(B); put(C); continue; }
      for (let i = 0; i <= m; i++) for (let j = 0; j <= m - i; j++) {
        const u = i / m, v = j / m, w = 1 - u - v;
        P.set(A.x * u + B.x * v + C.x * w, A.y * u + B.y * v + C.y * w, A.z * u + B.z * v + C.z * w); put(P);
      }
    }
  });
  const F = { W, L, top, low, archX };
  // body paint = the material that forms most of the visible outer skin (top surfaces + upper sides), excluding glass/lights/tyres
  {
    const GL = /glass|window|windscreen|windshield|vidro|cristal|scheibe|light|lamp|lens|tire|tyre|rubber|wheel|rim|chrome|interior|seat/i;
    const okMat = m => m && !(m.transparent && m.opacity < 0.8) && !(m.transmission > 0) && !GL.test(m.name || '');
    const cnt = new Map();
    const add = (m, w) => { if (okMat(m)) cnt.set(m, (cnt.get(m) || 0) + w); };
    for (let k = 0; k < NX * NZ; k++) if (top[k] > 0.4) add(topMat[k], 1);
    for (let j = 0; j < NZ * NY; j++) { const y = (j % NY + 0.5) / NY * 1.6; if (y > 0.35 && y < 1.0) { add(sideMatP[j], 1); add(sideMatN[j], 1); } }
    const ranked = [...cnt.entries()].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((a, e) => a + e[1], 0) || 1;
    // extra materials only when they are clearly paint too (by name), never black trim / plastics / chassis
    const PAINTY = /paint|body|colou?r|_ext_|ext\d|carpaint/i, NOT = /black|plastic|chassis|badge|trim|detail|misc|cab|glass|chrome/i;
    F.paintMats = ranked.filter(([m, n], i) => i === 0 || (n / total > 0.03 && PAINTY.test(m.name || '') && !NOT.test(m.name || ''))).map(([m]) => m);
    // + panels the processing step tagged as paint whose names say so (e.g. separate bumper / door materials)
    const manP = new Set(man.paint || []);
    scene.traverse(o => { if (!o.isMesh) return; for (const m of [].concat(o.material)) if (manP.has(m.name) && PAINTY.test(m.name) && !NOT.test(m.name) && okMat(m) && !F.paintMats.includes(m)) F.paintMats.push(m); });
  }
  // outer body surface |x| at (z, y) on side s (+1/-1); searches nearby cells to bridge holes
  F.surfX = (s, z, y) => {
    const arr = s > 0 ? sideP : sideN, iz = Math.floor((z / L + 0.5) * NZ), iy = Math.floor(y / 1.6 * NY);
    let m = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const i = iz + a, j = iy + b; if (i >= 0 && i < NZ && j >= 0 && j < NY) m = Math.max(m, arr[i * NY + j]); }
    return m;
  };
  const cell = (x, z) => [Math.max(0, Math.min(NX - 1, Math.floor((x / W + 0.5) * NX))), Math.max(0, Math.min(NZ - 1, Math.floor((z / L + 0.5) * NZ)))];
  F.topAt = (x, z) => { // max of a 3x3 neighbourhood to bridge holes
    const [ix, iz] = cell(x, z); let m = -1;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const i = ix + a, j = iz + b; if (i >= 0 && i < NX && j >= 0 && j < NZ) m = Math.max(m, top[j * NX + i]); }
    return m;
  };
  F.sideX = (z, y) => { for (let i = NX - 1; i >= NX / 2; i--) { const x = (i + 0.5) / NX * W - W / 2; if (F.topAt(x, z) > y && F.lowAt(x, z) < y) return x; } return W * 0.45; };
  F.lowAt = (x, z) => { const [ix, iz] = cell(x, z); return low[iz * NX + ix]; };
  // front-most / rear-most z at column x where the body comes below height yMax
  F.frontZ = (x, yMax) => { const [ix] = cell(x, 0); for (let j = NZ - 1; j >= 0; j--) if (low[j * NX + ix] < yMax) return (j + 1) / NZ * L - L / 2; return null; };
  F.rearZ = (x, yMax) => { const [ix] = cell(x, 0); for (let j = 0; j < NZ; j++) if (low[j * NX + ix] < yMax) return j / NZ * L - L / 2; return null; };
  F.tailZ = (x, yMin) => { const [ix] = cell(x, 0); for (let j = 0; j < NZ; j++) if (top[j * NX + ix] > yMin) return j / NZ * L - L / 2; return null; };
  F.noseZ = (x, yMin) => { const [ix] = cell(x, 0); for (let j = NZ - 1; j >= 0; j--) if (top[j * NX + ix] > yMin) return (j + 1) / NZ * L - L / 2; return null; };
  // bumper bottoms (lowest underside in the front / rear 12%, inboard of the wheels)
  const minLow = (z0, z1) => { let m = 9; for (let j = 0; j < NZ; j++) { const z = j / NZ * L - L / 2; if (z < z0 || z > z1) continue; for (let i = NX * 0.2 | 0; i < NX * 0.8; i++) m = Math.min(m, low[j * NX + i]); } return m < 8 ? m : 0.15; };
  F.lowFront = minLow(L / 2 - L * 0.12, L / 2);
  F.lowRear = minLow(-L / 2, -L / 2 + L * 0.12);
  // centreline profile -> roof height, windshield base (cowl), roof span, tail
  // centre-line profile: median across the middle of the car (ignores antennas, roof fins, a mirror poking up)
  const zs = j => j / NZ * L - L / 2;
  const ctr = new Float32Array(NZ);
  for (let j = 0; j < NZ; j++) {
    const v = [-0.24, -0.16, -0.08, 0, 0.08, 0.16, 0.24].map(u => F.topAt(u * W, zs(j))).sort((a, b) => a - b);
    ctr[j] = v[3];
  }
  F.ctrAt = z => ctr[Math.max(0, Math.min(NZ - 1, Math.floor((z / L + 0.5) * NZ)))];
  // roof: the highest stretch that stays high for 40 cm (a rear wing can rise above the roof but is only a chord long)
  const win = Math.max(1, Math.round(0.2 / (L / NZ)));
  let roofY = 0;
  const jA = Math.floor(NZ * 0.2), jB = Math.ceil(NZ * 0.85);   // the cabin is never in the last 20% (wings live there)
  for (let j = jA; j < jB; j++) { let m = 9; for (let k = j - win; k <= j + win; k++) m = Math.min(m, ctr[Math.max(0, Math.min(NZ - 1, k))]); roofY = Math.max(roofY, m); }
  F.roofY = roofY;
  let roofF = 0, roofR = 0, jTop = 0;
  for (let j = jA; j < jB; j++) { let m = 9; for (let k = j - win; k <= j + win; k++) m = Math.min(m, ctr[Math.max(0, Math.min(NZ - 1, k))]); if (m >= roofY - 1e-6) { jTop = j; break; } }
  // walk out from the roof's middle in both directions while the profile stays within 6 cm of the roof
  { let j = jTop; while (j < NZ - 1 && ctr[j + 1] > roofY - 0.06) j++; roofF = zs(j); }
  { let j = jTop; while (j > 0 && ctr[j - 1] > roofY - 0.06 && ctr[j - 1] < roofY + 0.06) j--; roofR = zs(j); }
  F.roofF = roofF; F.roofR = roofR;
  // cowl: walking forward from the roof front, where the windshield slope flattens into the hood
  let cowl = roofF;
  for (let j = Math.floor((roofF / L + 0.5) * NZ); j < NZ - 1; j++) {
    const a = ctr[j], b = ctr[j + 1];
    if ((a - b) / (L / NZ) < 0.35 && a < roofY - 0.15) { cowl = zs(j); break; }
  }
  F.cowl = cowl;
  F.hoodY = Math.max(0.5, F.topAt(0, (cowl + L / 2) / 2));
  // rear: rear-window base / deck
  let deckZ = roofR;
  for (let j = Math.floor((roofR / L + 0.5) * NZ); j > 0; j--) {
    const a = ctr[j], b = ctr[j - 1];
    if ((a - b) / (L / NZ) < 0.3 && a < roofY - 0.15) { deckZ = zs(j); break; }
  }
  F.deckZ = deckZ;
  F.tail = F.tailZ(0, 0.3) ?? -L / 2;
  F.deckY = F.topAt(0, (deckZ + F.tail) / 2);
  return F;
}

// ---------- exact surface heights (raycast-free): triangles of the shell under a patch, binned in xz ----------
// returns y(x, z) = highest upward-facing surface at that point in shell space (null if none)
export function topSampler(shell, x0, x1, z0, z1) {
  shell.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(shell.matrixWorld).invert(), M = new THREE.Matrix4();
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3(), E1 = new THREE.Vector3(), E2 = new THREE.Vector3();
  const tris = [];
  shell.traverse(o => {
    if (!o.isMesh || !o.geometry.attributes.position) return;
    if ([].concat(o.material).every(m => m.transparent)) return;
    M.multiplyMatrices(inv, o.matrixWorld);
    const pos = o.geometry.attributes.position, idx = o.geometry.index, n = idx ? idx.count : pos.count;
    for (let t = 0; t < n; t += 3) {
      A.fromBufferAttribute(pos, idx ? idx.getX(t) : t).applyMatrix4(M); B.fromBufferAttribute(pos, idx ? idx.getX(t + 1) : t + 1).applyMatrix4(M); C.fromBufferAttribute(pos, idx ? idx.getX(t + 2) : t + 2).applyMatrix4(M);
      if (Math.max(A.x, B.x, C.x) < x0 || Math.min(A.x, B.x, C.x) > x1 || Math.max(A.z, B.z, C.z) < z0 || Math.min(A.z, B.z, C.z) > z1) continue;
      N.crossVectors(E1.subVectors(B, A), E2.subVectors(C, A));
      if (Math.abs(N.y) < 1e-9 || Math.abs(N.y) / N.length() < 0.2) continue;   // walls
      tris.push(A.x, A.y, A.z, B.x, B.y, B.z, C.x, C.y, C.z);
    }
  });
  return (x, z) => {
    let best = null;
    for (let i = 0; i < tris.length; i += 9) {
      const ax = tris[i], az = tris[i + 2], bx = tris[i + 3], bz = tris[i + 5], cx = tris[i + 6], cz = tris[i + 8];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(d) < 1e-12) continue;
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, w = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      const y = u * tris[i + 1] + v * tris[i + 4] + w * tris[i + 7];
      if (best == null || y > best) best = y;
    }
    return best;
  };
}

// one louvre panel conforming to the body at (xc, z0..z1), width wd
function addLouvre(g, shell, xc, z0, z1, wd, MM) {
  const xa = xc - wd / 2, xb = xc + wd / 2;
  const S = topSampler(shell, xa - 0.02, xb + 0.02, z0 - 0.02, z1 + 0.02);
  const ok = [[xa, z0], [xb, z0], [xa, z1], [xb, z1], [xc, (z0 + z1) / 2]].every(([x, z]) => S(x, z) != null);
  if (!ok) return;
  const y = (x, z) => S(x, z) ?? S(xc, z) ?? 0;
  // conformal quad grid over [u0,u1]x[v0,v1] (x, z) lifted by `off`, optional per-row lift for blades
  const patch = (u0, u1, v0, v1, nu, nv, off, mat, lift) => {
    const pos = [], idx = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const x = u0 + (u1 - u0) * i / nu, z = v0 + (v1 - v0) * j / nv;
      pos.push(x, y(x, z) + off + (lift ? lift(j / nv) : 0), z);
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i, b = a + nu + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
    const m = mesh(geo, mat, false); g.add(m); return m;
  };
  const NU = Math.max(4, Math.round(wd / 0.03));
  patch(xa, xb, z0, z1, NU, Math.max(4, Math.round((z1 - z0) / 0.03)), 0.0015, MM.louvreHole);           // the opening
  const fr = 0.014;
  patch(xa - fr, xb + fr, z1, z1 + fr, NU, 1, 0.003, MM.louvreFrame); patch(xa - fr, xb + fr, z0 - fr, z0, NU, 1, 0.003, MM.louvreFrame);
  patch(xa - fr, xa, z0, z1, 1, 8, 0.003, MM.louvreFrame); patch(xb, xb + fr, z0, z1, 1, 8, 0.003, MM.louvreFrame);
  // blades across the vent, 28 mm pitch, 20 mm deep; leading (front) edge flush, trailing edge raised 9 mm
  const pitch = 0.042, nb = Math.floor((z1 - z0 - 0.01) / pitch);
  for (let k = 0; k < nb; k++) {
    const zf = z1 - 0.01 - k * pitch, zr = zf - 0.024;
    patch(xa + 0.002, xb - 0.002, zr, zf, NU, 2, 0.0025, MM.louvreBlade, t => 0.013 * (1 - t));
  }
}

// ---------- materials ----------
let carbonTex = null;
function carbonMap() {
  if (carbonTex) return carbonTex;
  const N = 256, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const g = cv.getContext('2d'), cell = 16;
  for (let y = 0; y < N; y += cell) for (let x = 0; x < N; x += cell) {
    const twill = ((x + y) / cell) % 4 < 2;
    const grd = twill ? g.createLinearGradient(x, y, x + cell, y) : g.createLinearGradient(x, y, x, y + cell);
    grd.addColorStop(0, '#0c0d0f'); grd.addColorStop(0.5, twill ? '#2a2d31' : '#202327'); grd.addColorStop(1, '#0c0d0f');
    g.fillStyle = grd; g.fillRect(x, y, cell, cell);
  }
  carbonTex = new THREE.CanvasTexture(cv); carbonTex.wrapS = carbonTex.wrapT = THREE.RepeatWrapping; carbonTex.colorSpace = THREE.SRGBColorSpace; carbonTex.anisotropy = 8;
  return carbonTex;
}
const matCache = {};
export function modMats() {
  if (matCache.carbon) return matCache;
  const cm = carbonMap();
  matCache.carbon = new THREE.MeshPhysicalMaterial({ map: cm, color: 0x9a9a9a, roughness: 0.38, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.45 });
  matCache.carbon.map.repeat.set(6, 6);
  matCache.louvreHole = new THREE.MeshBasicMaterial({ color: 0x020202 });
  matCache.louvreFrame = new THREE.MeshStandardMaterial({ color: 0x161719, roughness: 0.55, metalness: 0.3 });
  matCache.louvreBlade = new THREE.MeshStandardMaterial({ color: 0x4a4d53, roughness: 0.45, metalness: 0.3, side: THREE.DoubleSide });
  matCache.carbonMatte = new THREE.MeshStandardMaterial({ map: cm, color: 0xb0b0b0, roughness: 0.6, metalness: 0.1, envMapIntensity: 0.35 });
  matCache.satin = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.55, metalness: 0.3 });
  matCache.alu = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.9 });
  matCache.rubber = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
  matCache.cage = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.6, metalness: 0.5 });
  matCache.rivet = new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.25, metalness: 1 });
  return matCache;
}
const mesh = (g, m, shadow = true) => { const o = new THREE.Mesh(g, m); o.castShadow = shadow; o.receiveShadow = true; o.userData.own = true; return o; };

// thin plate following a plan-view outline. pts: [[x, z]...] (front edge, left->right); depth: how far back; y; thickness
function outlinePlate(edge, back, thick) {
  const s = new THREE.Shape();
  s.moveTo(edge[0][0], -edge[0][1]);
  for (const [x, z] of edge) s.lineTo(x, -z);
  for (let i = edge.length - 1; i >= 0; i--) { const [x, z] = edge[i]; const t = Math.abs(i / (edge.length - 1) - 0.5) * 2; s.lineTo(x * (1 - 0.04 * t), -(z - back)); }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.003, bevelSegments: 1, curveSegments: 4 });
  g.rotateX(-Math.PI / 2); // shape y (= -z) -> world z; extrusion -> +y
  return g;
}
function airfoil(chord, span, camber = 1) {
  const s = new THREE.Shape(), N = 18;
  const up = [], lo = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, x = (1 - Math.cos(t * Math.PI)) / 2;
    const th = 0.12 * 5 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4); // NACA 00xx thickness
    const cam = -0.06 * camber * (x < 0.4 ? (2 * 0.4 * x - x * x) / 0.16 : ((1 - 0.8) + 2 * 0.4 * x - x * x) / 0.36); // inverted camber (downforce)
    up.push([x * chord, (cam + th * 0.5) * chord]); lo.push([x * chord, (cam - th * 0.5) * chord]);
  }
  s.moveTo(up[0][0], up[0][1]);
  for (const p of up) s.lineTo(p[0], p[1]);
  for (let i = lo.length - 1; i >= 0; i--) s.lineTo(lo[i][0], lo[i][1]);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: span, bevelEnabled: false, curveSegments: 2 });
  g.translate(-chord * 0.35, 0, -span / 2);
  g.rotateY(Math.PI / 2); // chord along -z (leading edge forward = +z after flip below)
  g.rotateY(Math.PI);
  return g;
}
function plate(shapePts, thick) {
  const s = new THREE.Shape(); s.moveTo(...shapePts[0]); for (const p of shapePts.slice(1)) s.lineTo(...p); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 1 });
  g.translate(0, 0, -thick / 2); g.rotateY(Math.PI / 2); // plate in the y-z plane, thickness along x
  return g;
}
function tube(points, r, closed = false) {
  const c = new THREE.CatmullRomCurve3(points, closed, 'catmullrom', 0.1);
  return new THREE.TubeGeometry(c, Math.max(8, points.length * 10), r, 8, closed);
}

// ---------- widebody deformation (per instance) ----------
export function deformWidebody(shellRoot, man, F, amt = 0.07) {
  const ws = man.wheels; if (!ws) return;
  shellRoot.updateMatrixWorld(true);
  const inv = new THREE.Matrix4();
  shellRoot.traverse(o => {
    if (!o.isMesh) return;
    const src = o.geometry.attributes.position, M = o.matrixWorld;
    inv.copy(M).invert();
    const out = new Float32Array(src.count * 3);
    let moved = false;
    for (let i = 0; i < src.count; i++) {
      v3.fromBufferAttribute(src, i).applyMatrix4(M);
      const ax = Math.abs(v3.x), s = Math.sign(v3.x) || 1;
      let dx = 0;
      for (const w of ws) {
        if (Math.sign(w.x) !== s) continue;
        const inner = Math.abs(w.x) - 0.34;
        if (ax < inner) continue;
        const wy = w.y ?? w.r;
        const d = Math.hypot(v3.y - wy, v3.z - w.z);
        const f = 1 - THREE.MathUtils.smoothstep(d, w.r * 1.05, w.r * 2.1);
        const below = v3.y < wy + w.r * 1.25 ? 1 : Math.max(0, 1 - (v3.y - wy - w.r * 1.25) / 0.12);
        const g = THREE.MathUtils.smoothstep(ax, inner, Math.abs(w.x) - 0.06);
        dx = Math.max(dx, amt * f * below * g);
      }
      // sills between the arches
      const zF = (ws[0].z + ws[1].z) / 2, zR = (ws[2].z + ws[3].z) / 2;
      if (v3.z < zF && v3.z > zR && v3.y < 0.42 && ax > F.W * 0.33) dx = Math.max(dx, amt * 0.5 * THREE.MathUtils.smoothstep(ax, F.W * 0.33, F.W * 0.45) * (1 - THREE.MathUtils.smoothstep(v3.y, 0.3, 0.42)));
      if (dx > 0) { v3.x += s * dx; moved = true; }
      v3.applyMatrix4(inv);
      out[i * 3] = v3.x; out[i * 3 + 1] = v3.y; out[i * 3 + 2] = v3.z;
    }
    if (!moved) return;
    const g = o.geometry.clone();
    g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    g.computeBoundingSphere(); g.computeBoundingBox();
    o.geometry = g; o.userData.own = true;
  });
}

// ---------- carbon panels: region mask injected into the paint shader ----------
export function applyCarbonPanels(paintMats, shellRoot, F, man, panels, livery = {}) {
  const stripes = livery.stripes || 'none';
  if (!panels.length && stripes === 'none') return;
  const ws = man.wheels || [];
  const zF = ws.length ? (ws[0].z + ws[1].z) / 2 : F.L * 0.3, zR = ws.length ? (ws[2].z + ws[3].z) / 2 : -F.L * 0.3, r = ws[0]?.r || 0.32;
  const uniforms = {
    shellInv: { value: new THREE.Matrix4() },
    cfOn: { value: new THREE.Vector4(panels.includes('hood') ? 1 : 0, panels.includes('roof') ? 1 : 0, panels.includes('trunk') ? 1 : 0, panels.includes('doors') ? 1 : 0) },
    cfHood: { value: new THREE.Vector4(F.cowl + 0.02, F.L / 2 - 0.12, F.hoodY - 0.16, F.W * 0.29) },     // z0, z1, yMin, halfW
    cfHoodMax: { value: (() => { let m = 0; for (let i = 0; i <= 8; i++) { const z = F.cowl + (F.L / 2 - F.cowl) * i / 8; m = Math.max(m, F.topAt(0, z)); } return m + 0.03; })() },   // fenders that rise above the hood centreline stay painted
    cfRoof: { value: new THREE.Vector4(F.roofR, F.roofF, F.roofY - 0.1, F.W * 0.36) },
    cfTrunk: { value: new THREE.Vector4(F.tail + 0.04, F.deckZ - 0.02, F.deckY - 0.2, F.W * 0.38) },
    // 2-door cars: one long door that ends at the B-pillar; 4-door: front + rear door, ending ahead of the rear arch
    cfDoor: { value: new THREE.Vector4(livery.fourDoor ? zR + r + 0.12 : Math.max(zR + r + 0.12, zF - r - 0.1 - Math.min(1.3, Math.max(1.0, 0.46 * (zF - zR)))), zF - r - 0.1, 0.28, F.hoodY + 0.12) },
    cfMap: { value: carbonMap() },
    // stripes: x = racing (0/1), y = side (0/1), z = racing band inner half-gap, w = racing band width; stripe colour; side band (y0, y1, z0, z1)
    stOn: { value: new THREE.Vector4(stripes === 'racing' || stripes === 'both' ? 1 : 0, stripes === 'side' || stripes === 'both' ? 1 : 0, F.W * 0.035, F.W * 0.085) },
    stCol: { value: new THREE.Color(livery.stripeColor || '#ffffff') },
    stSide: { value: new THREE.Vector4(Math.max(0.3, F.hoodY - 0.22), Math.max(0.36, F.hoodY - 0.14), F.tail + 0.25, F.L / 2 - 0.3) },
  };
  for (const m of paintMats) {
    m.userData.cf = uniforms;
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform mat4 shellInv; varying vec3 vShell; varying vec3 vShellN;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvec4 cfW = modelMatrix * vec4(transformed, 1.0); vShell = (shellInv * cfW).xyz; vShellN = normalize(mat3(shellInv) * mat3(modelMatrix) * objectNormal);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform vec4 cfOn, cfHood, cfRoof, cfTrunk, cfDoor, stOn, stSide; uniform float cfHoodMax; uniform vec3 stCol; uniform sampler2D cfMap; varying vec3 vShell; varying vec3 vShellN; float cfM; float stM;
float stMask(){
  vec3 p = vShell, n = normalize(vShellN); float m = 0.0; float ax = abs(p.x);
  if (stOn.x > 0.5 && ax > stOn.z && ax < stOn.z + stOn.w && (n.y > 0.12 || abs(n.z) > 0.5)) m = 1.0;
  if (stOn.y > 0.5 && abs(n.x) > 0.45 && p.y > stSide.x && p.y < stSide.y && p.z > stSide.z && p.z < stSide.w) m = 1.0;
  return m;
}
float cfMask(){
  vec3 p = vShell, n = normalize(vShellN); float m = 0.0;
  if (cfOn.x > 0.5 && p.z > cfHood.x && p.z < cfHood.y && p.y > cfHood.z && p.y < cfHoodMax && abs(p.x) < cfHood.w && n.y > 0.3) m = 1.0;
  if (cfOn.y > 0.5 && p.z > cfRoof.x && p.z < cfRoof.y && p.y > cfRoof.z && abs(p.x) < cfRoof.w && n.y > 0.35) m = 1.0;
  if (cfOn.z > 0.5 && p.z > cfTrunk.x && p.z < cfTrunk.y && p.y > cfTrunk.z && abs(p.x) < cfTrunk.w && n.y > 0.25) m = 1.0;
  if (cfOn.w > 0.5 && p.z > cfDoor.x && p.z < cfDoor.y && p.y > cfDoor.z && p.y < cfDoor.w && abs(n.x) > 0.55) m = 1.0;
  return m;
}
vec3 cfCol(){ vec3 p = vShell, n = abs(normalize(vShellN)); vec2 uv = n.y > 0.5 ? p.xz : (n.x > 0.5 ? p.zy : p.xy); return texture2D(cfMap, uv * 9.0).rgb; }`)
        .replace('#include <map_fragment>', '#include <map_fragment>\nstM = stMask(); diffuseColor.rgb = mix(diffuseColor.rgb, stCol, stM);\ncfM = cfMask(); diffuseColor.rgb = mix(diffuseColor.rgb, cfCol(), cfM);')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.36, cfM);')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.25, cfM);');
    };
    m.customProgramCacheKey = () => 'carbon-panels-st';
    m.needsUpdate = true;
  }
  // keep shellInv current (the car moves): refresh just before any painted mesh renders
  const upd = () => uniforms.shellInv.value.copy(shellRoot.matrixWorld).invert();
  shellRoot.traverse(o => { if (o.isMesh && [].concat(o.material).some(mm => paintMats.includes(mm))) o.onBeforeRender = upd; });
}

// ---------- paint finishes ----------
export const FINISHES = {
  gloss: { label: 'Gloss', metalness: 0.0, roughness: 0.32, clearcoat: 1, ccr: 0.04 },
  metallic: { label: 'Metallic', metalness: 0.62, roughness: 0.3, clearcoat: 1, ccr: 0.03 },
  pearl: { label: 'Pearl', metalness: 0.35, roughness: 0.28, clearcoat: 1, ccr: 0.03, iridescence: 0.75 },
  candy: { label: 'Candy', metalness: 0.5, roughness: 0.16, clearcoat: 1, ccr: 0.01, sheen: 0.6 },
  satin: { label: 'Satin', metalness: 0.25, roughness: 0.55, clearcoat: 0.25, ccr: 0.35 },
  matte: { label: 'Matte', metalness: 0.0, roughness: 0.86, clearcoat: 0, ccr: 1 },
  chrome: { label: 'Chrome', metalness: 1.0, roughness: 0.05, clearcoat: 1, ccr: 0.02 },
};
export function applyFinish(m, finish, quality = {}) {
  const f = FINISHES[finish]; if (!f || !m) return;
  m.metalness = f.metalness; m.roughness = f.roughness;
  if ('clearcoat' in m) { m.clearcoat = quality.clearcoat === false ? 0 : f.clearcoat; m.clearcoatRoughness = f.ccr; }
  if ('iridescence' in m) { m.iridescence = f.iridescence || 0; m.iridescenceIOR = 1.6; m.iridescenceThicknessRange = [180, 520]; }
  if ('sheen' in m) { m.sheen = f.sheen || 0; m.sheenColor?.copy(m.color).multiplyScalar(1.4); m.sheenRoughness = 0.3; }
  if (finish === 'chrome') m.envMapIntensity = 1.4;
  m.needsUpdate = true;
}

// ---------- paint for bolt-on body panels ----------
const avgCache = new WeakMap();
export function panelPaint(mat, tint = null) {
  const m = mat.clone(); m.side = THREE.DoubleSide;
  if (m.vertexColors) { m.vertexColors = false; if (tint) m.color.multiply(tint); }
  const img = mat.map?.image;
  if (img) {
    let c = avgCache.get(img);
    if (!c) {
      try {
        const cv = document.createElement('canvas'); cv.width = cv.height = 16; const g = cv.getContext('2d');
        g.drawImage(img, 0, 0, 16, 16); const d = g.getImageData(0, 0, 16, 16).data;
        let r = 0, gg = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4; c = new THREE.Color().setRGB(r / n / 255, gg / n / 255, b / n / 255, THREE.SRGBColorSpace);
      } catch (e) { c = new THREE.Color(0.5, 0.5, 0.5); }
      avgCache.set(img, c);
    }
    m.map = null; m.color.multiply(c);
  }
  m.onBeforeCompile = () => {}; m.customProgramCacheKey = () => 'panel';
  return m;
}

// ---------- bolt-on parts ----------
// ctx: { spec, body, F, man, lift, dz, paint (material), wingAngle, wide }
export function addRealParts(ctx) {
  const { spec, body, F, man } = ctx;
  const MM = modMats();
  const g = new THREE.Group(); g.position.set(0, ctx.lift, ctx.dz); body.add(g);   // shell space
  const has = id => spec.parts.some(p => p.id === id || p.model === id);
  const W = F.W, L = F.L;
  const xs = (half, n) => Array.from({ length: n }, (_, i) => -half + 2 * half * i / (n - 1));

  // ---- front aero ----
  const front = spec.parts.find(p => p.cat === 'aero_front');
  if (front) {
    // the bumper's own lower lip: lowest underside within 15 cm of the leading edge, per column, median across the width
    // (F.lowFront is the lowest point anywhere up front - often an undertray / chin further back, which left a gap)
    const lips = [];
    for (const x of xs(W * 0.34, 15)) {
      const zf = F.frontZ(x, 1.0); if (zf == null) continue;
      let m = 9; for (let d = 0.01; d <= 0.15; d += 0.02) m = Math.min(m, F.lowAt(x, zf - d));
      if (m < 8) lips.push(m);
    }
    lips.sort((a, b) => a - b);
    const y = lips.length >= 5 ? lips[lips.length >> 1] : F.lowFront;
    const edge = [];
    const isLip = front.model === 'lip';
    const fwd = isLip ? 0.02 : 0.04, back = isLip ? 0.09 : 0.3;
    // a real lip / splitter stops ahead of the front wheel opening: on round-nosed cars the bumper corner wraps back
    // toward the arch, so drop edge points whose plate would reach the tire (with steering lock + a bigger tire)
    const wf = (man.wheels || []).find(w => w.front);
    const tR = Math.max(wf?.r || 0, spec.tire?.R || 0);
    const clear = (x, z) => !wf || z - back < 0 ? true : (z - back > wf.z + tR + 0.06 || Math.abs(x) < Math.abs(wf.x) - (wf.tw / 2 + 0.1));
    for (const x of xs(W * 0.47, 31)) { const z = F.frontZ(x, y + 0.1); if (z != null && clear(x, z)) edge.push([x, z]); }
    if (edge.length > 4) {
      const e2 = edge.map(([x, z]) => [x, z + fwd]);
      const pl = mesh(outlinePlate(e2, back + fwd, isLip ? 0.012 : 0.009), isLip ? MM.satin : MM.carbonMatte);
      pl.position.y = y - (isLip ? 0.012 : 0.016);
      g.add(pl);
      if (!isLip) {
        // short support rods from the splitter's leading edge to the bumper face
        for (const s of [-1, 1]) {
          // tucked close to the bumper face, angled up into the bumper (hidden end bolts behind the fascia)
          const x = s * W * 0.22, zb = F.frontZ(x, y + 0.1), z0 = F.frontZ(x, y + 0.03);
          if (zb == null || z0 == null) continue;
          g.add(mesh(tube([new THREE.Vector3(x, y - 0.004, Math.min(z0 + 0.03, zb + 0.06)), new THREE.Vector3(x, y + 0.09, zb - 0.02)], 0.005), MM.alu));
        }
      }
      if (front.model === 'canards') {
        // two dive planes per side on the bumper corners, flush with the bodywork
        const fin = new THREE.Shape(); fin.moveTo(0, 0); fin.lineTo(0.13, 0.03); fin.lineTo(0.13, 0.075); fin.lineTo(0, 0.12); fin.closePath();
        const fg = new THREE.ExtrudeGeometry(fin, { depth: 0.005, bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0015, bevelSegments: 1 });
        fg.rotateX(Math.PI / 2); // shape x -> outward, shape y -> -z (back)
        for (const s of [-1, 1]) for (const dy of [0.1, 0.2]) {
          const yy = y + dy, zc = (F.frontZ(s * W * 0.4, yy + 0.04) ?? L / 2) - 0.1 - dy * 0.15;
          const xa = F.surfX(s, zc + 0.02, yy) || F.sideX(zc, yy), xb = F.surfX(s, zc - 0.1, yy) || xa;
          const c = mesh(fg, MM.carbon);
          c.scale.set(s * 0.75, 1, 0.8);                                  // ~10 cm out, 10 cm long
          c.position.set(s * (xa - 0.012), yy, zc + 0.02);
          c.rotation.order = 'YXZ'; c.rotation.y = -s * Math.atan2(xb - xa, 0.12); c.rotation.z = s * 0.06; c.rotation.x = 0.22;
          g.add(c);
        }
      }
    }
  }

  // ---- diffuser: ramp rising to the rear + strakes hanging from it (never below the bumper line) ----
  if (has('diffuser') && man.wheels) {
    const wr = man.wheels[2];
    const half = Math.max(0.3, Math.abs(wr.x) - wr.tw / 2 - 0.08);
    // rear bumper valance: the rear-most row under the bumper, and its underside height there (median across the width,
    // so exhaust cut-outs / a low muffler further forward don't drag it down)
    let zt = F.rearZ(0, F.lowRear + 0.25) ?? -L / 2;
    const val = []; for (const x of xs(half, 11)) for (const dzz of [0.03, 0.08, 0.13]) { const v = F.lowAt(x, zt + dzz); if (v < 8) val.push(v); }
    val.sort((a, b) => a - b);
    const yV = val.length ? val[val.length >> 1] : F.lowRear + 0.08;
    const len = 0.55, depth = Math.min(0.05, Math.max(0.03, yV - F.lowRear - 0.005));   // how far the ramp drops below the valance
    const y0 = yV - depth - 0.004, ang = Math.atan2(depth, len);
    zt = Math.max(zt, (F.rearZ(0, yV + 0.025) ?? zt) + 0.015);          // trailing edge tucked under the valance lip, not sticking out
    // trailing edge follows the bumper's lower edge across the width (corners wrap forward), tucked just under it
    const zEdge = x => Math.max(zt, (F.rearZ(x, yV + 0.025) ?? zt) + 0.015);
    // ramp surface: high (just under the valance) at the trailing edge, down to the floor line y0 `len` further forward
    const NXr = 17, xsR = xs(half, NXr), pos = [], idx = [];
    for (const x of xsR) { const ze = zEdge(x); for (const t of [0, 1]) pos.push(x, yV - 0.004 - depth * t, ze + len * t); }
    for (let k = 0; k < NXr - 1; k++) { const a = k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); rg.setIndex(idx); rg.computeVertexNormals();
    const rampMat = MM.carbon.clone(); rampMat.side = THREE.DoubleSide;
    g.add(mesh(rg, rampMat));
    // strakes fill the wedge between the floor line and the ramp (bottom edge level with the floor), outer ones close the sides
    for (const x of xs(half - 0.003, 6)) {
      const ze = zEdge(x), st = new THREE.Shape(); st.moveTo(0, 0); st.lineTo(len, 0); st.lineTo(len, depth); st.closePath();
      const sg = new THREE.ExtrudeGeometry(st, { depth: 0.006, bevelEnabled: false });
      sg.rotateY(Math.PI / 2);   // shape x -> -z (rearward), thickness along x
      const f = mesh(sg, MM.carbon); f.position.set(x - 0.003, y0 + 0.004, ze + len); g.add(f);
    }
  }

  // ---- rear wing / ducktail ----
  const wing = spec.parts.find(p => p.cat === 'aero_rear');
  if (wing) {
    const hatch = spec.car.body === 'hatch';
    const ang = 0.05 + (ctx.wingAngle ?? 0.5) * 0.22;
    if (wing.model === 'ducktail') {
      // lip along the trunk's trailing edge, painted
      const rows = [];
      for (const x of xs(W * 0.4, 23)) {
        const deck = F.topAt(x, F.tail + 0.3);
        const zt = F.tailZ(x, deck - 0.05); if (zt == null) continue;
        const yt = F.topAt(x, zt + 0.02);
        rows.push([x, yt, zt]);
      }
      if (rows.length > 4) {
        const pos = [], idx = [];
        const prof = [[0.12, 0.0], [0.05, 0.012], [0.0, 0.03], [-0.035, 0.065], [-0.04, 0.06], [0.0, 0.016], [0.12, -0.004]];
        rows.forEach(([x, y, z], i) => {
          const t = Math.abs(i / (rows.length - 1) - 0.5) * 2, k = 1 - 0.55 * t * t;
          for (const [dz, dy] of prof) pos.push(x, y + dy * k - 0.004, z + dz);
        });
        const P = prof.length;
        for (let i = 0; i < rows.length - 1; i++) for (let j = 0; j < P - 1; j++) { const a = i * P + j, b = a + P; idx.push(a, b, a + 1, b, b + 1, a + 1); }
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
        g.add(mesh(geo, panelPaint(ctx.paint, ctx.paintTint)));
      }
    } else {
      const S = { lowwing: { h: 0.07, span: 0.86, chord: 0.17, cam: 0.5 }, wing: { h: 0.24, span: 0.97, chord: 0.27, cam: 1 }, swan: { h: 0.34, span: 1.0, chord: 0.3, cam: 1.2 }, bigwing: { h: 0.48, span: 1.04, chord: 0.36, cam: 1.4 } }[wing.model] || { h: 0.2, span: 0.95, chord: 0.26, cam: 1 };
      // span from the body's width at the trunk (W includes the mirrors), never past the rear fenders
      const zw = hatch ? F.roofR : (F.tail + F.deckZ) / 2;
      const rearW = Math.max(F.surfX(1, zw, F.deckY - 0.12), F.surfX(-1, zw, F.deckY - 0.12)) * 2 || W * 0.9;
      const span = Math.min(1.8, S.span * Math.min(W, rearW + 0.02));
      // mounting point: trunk lid near the trailing edge (or the hatch top on hatchbacks)
      let zm = hatch ? F.roofR - 0.05 : Math.max(F.tail + 0.16, (F.tail + F.deckZ) / 2 - 0.05);
      // chassis-mount (time attack): uprights come up through the trunk lid near its trailing edge, element set back
      if (wing.model === 'bigwing' && !hatch) zm = Math.min(zm, F.tail + 0.2);
      const ux = Math.min(span * 0.32, W * 0.3);
      const baseY = Math.max(F.topAt(ux, zm), F.topAt(-ux, zm));
      // hatchbacks: the wing sits just above the hatch's trailing roof edge (measured surface, short uprights)
      const roofHatch = hatch;
      const wy = baseY + (roofHatch ? Math.min(S.h, wing.model === 'bigwing' ? 0.22 : 0.1) : S.h);
      const wz = wing.model === 'bigwing' ? (hatch ? zm - 0.12 : F.tail - 0.03) : zm - (wing.model === 'swan' && !hatch ? 0.13 : 0.02);
      const elem = new THREE.Group(); elem.position.set(0, wy, wz); elem.rotation.x = ang; g.add(elem);
      const wm = wing.model === 'lowwing' ? panelPaint(ctx.paint, ctx.paintTint) : MM.carbon;
      elem.add(mesh(airfoil(S.chord, span, S.cam), wm));
      if (wing.model !== 'lowwing') {
        // gurney flap + endplates
        const gf = mesh(new THREE.BoxGeometry(span, 0.018, 0.004), MM.satin); gf.position.set(0, 0.006, -S.chord * 0.66); elem.add(gf);
        for (const s of [-1, 1]) {
          const ep = mesh(plate([[-S.chord * 0.75, -0.06], [S.chord * 0.42, -0.04], [S.chord * 0.45, 0.07], [-S.chord * 0.55, 0.1], [-S.chord * 0.8, 0.04]].map(([z, y]) => [z, y]), 0.005), MM.carbon);
          ep.position.x = s * (span / 2 + 0.003); elem.add(ep);
        }
      }
      // uprights
      for (const s of [-1, 1]) {
        const x = s * ux;
        if (wing.model === 'swan' && !roofHatch) {
          const yb = F.topAt(x, zm);
          // gooseneck: a curved 10 mm aluminium plate rising from the lid, arching back over the blade and bolting to
          // its top surface (the underside stays clean)
          const cl = new THREE.CatmullRomCurve3([[zm, yb], [zm + 0.005, yb + (wy - yb) * 0.55], [wz + S.chord * 0.55, wy + 0.07], [wz + S.chord * 0.3, wy + 0.085], [wz + 0.03, wy + 0.035]].map(([z, y]) => new THREE.Vector3(0, y, z)));
          const P = cl.getPoints(24), left = [], right = [];
          P.forEach((p, k) => {
            const tg = cl.getTangent(k / (P.length - 1)), half = 0.028 - 0.01 * (k / (P.length - 1));   // tapers toward the blade
            const nz = -tg.y, ny = tg.z;                                                                  // normal in z-y
            left.push([-(p.z + nz * half), p.y + ny * half]); right.push([-(p.z - nz * half), p.y - ny * half]);
          });
          const u = mesh(plate([...left, ...right.reverse()], 0.01), MM.alu); u.position.x = x; g.add(u);
          const bp = mesh(new THREE.BoxGeometry(0.05, 0.006, 0.1), MM.satin, false); bp.position.set(x, yb + 0.001, zm); g.add(bp);
        } else {
          // tapered plate upright from the lid (wide foot) to the element's underside, leaning back to where it sits
          const yb = F.topAt(x, zm);
          const hgt = Math.max(0.02, wy - yb - 0.01), lean = zm - wz;   // plate x maps to -z
          const foot = wing.model === 'bigwing' ? 0.075 : 0.05, head = wing.model === 'bigwing' ? 0.045 : 0.035;
          const u = mesh(plate([[-foot, 0], [foot, 0], [lean + head, hgt], [lean - head * 1.6, hgt]], wing.model === 'lowwing' ? 0.03 : wing.model === 'bigwing' ? 0.01 : 0.008), wing.model === 'lowwing' ? panelPaint(ctx.paint, ctx.paintTint) : MM.alu);
          u.position.set(x, yb - 0.005, zm); g.add(u);
          if (wing.model !== 'lowwing') {   // base plate bolted to the lid
            const bp = mesh(new THREE.BoxGeometry(0.05, 0.006, foot * 2 + 0.03), MM.satin, false); bp.position.set(x, yb + 0.001, zm); g.add(bp);
          }
        }
      }
    }
  }

  // ---- louvres: extractor vents over the radiator exit (front half of the hood, both sides of centre) + fender tops
  // over the front wheels. Cut into the panel: dark opening, black frame, blades flush with the skin, rear edges raised.
  if (has('louvres') && ctx.shell) {
    const zc = F.cowl, zn = F.noseZ?.(0, F.hoodY - 0.25) ?? F.L / 2, hl = zn - zc;
    const wP = Math.min(0.32, W * 0.17), xP = W * 0.155;
    const spots = [[xP, zc + hl * 0.42, zc + hl * 0.7, wP], [-xP, zc + hl * 0.42, zc + hl * 0.7, wP]];
    if (man.wheels) for (const w of man.wheels.filter(w => w.front)) spots.push([w.x - Math.sign(w.x) * 0.1, w.z - 0.2, w.z + 0.1, 0.15]);
    for (const [xc, z0, z1, wd] of spots) addLouvre(g, ctx.shell, xc, z0, z1, wd, MM);
  }

  // ---- widebody overfenders: painted arch flares with rivets ----
  if (ctx.wide && man.wheels) {
    man.wheels.forEach((w, wi) => {
      const s = Math.sign(w.x), wy = w.y ?? w.r, R = w.r + 0.075;
      // swept profile (outward o, radial r'): flange on the body -> rolled outer edge -> lip over the tire
      // swept profile (outward o, radial r') rooted on the measured (widened) body surface at each point of the arch
      const prof = [[-0.006, 0.07], [0.012, 0.055], [0.03, 0.032], [0.04, 0.008], [0.036, -0.012], [0.018, -0.02], [-0.004, -0.02]];
      const N = 28, pos = [], idx = [];
      for (let k = 0; k <= N; k++) {
        const t = k / N, a = Math.PI * (0.04 + 0.92 * t), taper = Math.min(1, Math.sin(Math.PI * t) * 3);
        const zz = w.z + Math.cos(a) * R, yy = wy + Math.sin(a) * R;
        const base = Math.max(F.surfX(s, zz, yy), Math.abs(w.x) + w.tw / 2 - 0.02) + 0.07 * taper - 0.004;   // body after the widening
        for (const [o, rr] of prof) { const rad = R + rr; pos.push(base + o * taper, wy + Math.sin(a) * rad, w.z + Math.cos(a) * rad); }
      }
      const P = prof.length;
      for (let k = 0; k < N; k++) for (let j = 0; j < P - 1; j++) { const i0 = k * P + j, i1 = i0 + P; idx.push(i0, i0 + 1, i1, i1, i0 + 1, i1 + 1); }
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
      const fm = panelPaint(ctx.paint, ctx.paintTint);
      const fl = mesh(geo, fm);
      fl.scale.x = s; g.add(fl);
      for (let k = 1; k < 9; k++) {
        const a = Math.PI * (0.1 + 0.8 * k / 9);
        const rv = mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.006, 8), MM.rivet, false);
        const zz = w.z + Math.cos(a) * (R + 0.04), yy = wy + Math.sin(a) * (R + 0.04);
        rv.rotation.z = Math.PI / 2; rv.position.set(s * (Math.max(F.surfX(s, zz, yy), Math.abs(w.x) + w.tw / 2 - 0.02) + 0.07 + 0.012), wy + Math.sin(a) * (R + 0.045), w.z + Math.cos(a) * (R + 0.045)); g.add(rv);
      }
    });
  }

  // ---- roll cage / roll bar: built inside the measured cabin (under the headliner, inside the doors & glass) ----
  const cage = has('weldcage') ? 'full' : has('boltcage') ? 'bar' : null;
  if (cage && spec.car.body !== 'truck') addCage(g, F, cage, MM, spec.car.body === 'roadster');
  return g;
}

// Roll cage layout as fabricated in real cars (SCCA / FIA style, 1.75" x .120 DOM tube):
//  bolt-in roll bar = main hoop behind the front seats + two rear stays to the rear strut towers + harness bar
//  full weld-in cage = that + A-pillar bars and roof rails (front hoop) + windshield header + dash bar +
//  NASCAR door bars bowed into the doors + main-hoop diagonal + roof diagonal, landing on floor plates.
// Every tube is sampled along its length and clamped into the cabin envelope measured from the shell, so it hugs the
// roof / pillars from the inside instead of poking through on narrow-roofed or sloped cabins.
// driver's seat cushion centre (shell z): the hip point sits ~1.05 m behind the windshield base, and the seat back
// stays inside the roof (forward of its rear edge). Open roadsters: ~0.75 m behind the windscreen header.
export function seatZ(F, open) { return open ? F.roofR - 0.75 : Math.max(F.cowl - 1.05, F.roofR + 0.35); }
function addCage(g, F, kind, MM, roadster) {
  const W = F.W, V = (x, y, z) => new THREE.Vector3(x, y, z);
  const TUBE = 0.0222;
  // open roadster (top down): the "roof" found is just the windscreen header, the seats are ~0.75 m behind it, and the
  // hoop rises to helmet height (about the windscreen frame) instead of tucking under a roof
  const open = roadster && F.roofF - F.roofR < 0.5;
  const zSeat = seatZ(F, open);
  const yFloor = Math.max(0.16, Math.min(0.45, F.lowAt(W * 0.2, zSeat) + 0.06));
  // inner roof (outer skin - headliner gap) and inner side (door skin / glass - trim thickness); min over nearby z
  // so door mirrors and badges don't widen the cabin
  const topIn = open ? (x, z) => F.roofY + 0.04 - 0.12 * (x / W) ** 2 : (x, z) => Math.min(...[-0.08, 0, 0.08].map(d => F.topAt(x, z + d))) - 0.075;
  // open car: above the door tops there is nothing to measure, keep the width the cabin has at the beltline
  const beltY = open ? Math.max(...[0.36, 0.4, 0.44].map(u => F.topAt(u * W, zSeat))) - 0.04 : 9;
  const xIn = (z, y) => {
    y = Math.min(y, beltY);
    let m = W * 0.46;
    for (const d of [-0.16, -0.08, 0, 0.08, 0.16]) {
      // the side raster is continuous in x; the top/bottom grid (4 cm cells) is only a fallback for holes
      for (const s of [1, -1]) { const v = F.surfX(s, z + d, y); m = Math.min(m, v > 0.2 ? v : F.sideX(z + d, y)); }
    }
    return m - 0.085;
  };
  // the cabin box the cage has to live in
  const zH = open ? zSeat - 0.38 : Math.max(F.roofR + 0.1, zSeat - 0.38);   // main hoop: right behind the front seat backs
  const zA = F.cowl - 0.1;                                            // A-pillar base, behind the dash
  // pull a point into the cabin: width first (at a height known to be inside), then height at that width, repeat
  const clampIn = v => {
    const sx = Math.sign(v.x || 1);
    v.y = Math.max(yFloor + TUBE, Math.min(v.y, topIn(0, v.z) - TUBE));
    for (let it = 0; it < 3; it++) {
      v.x = sx * Math.min(Math.abs(v.x), Math.max(0.05, xIn(v.z, v.y) - TUBE));
      v.y = Math.max(yFloor + TUBE, Math.min(v.y, topIn(v.x, v.z) - TUBE));
    }
    return v;
  };
  // subdivide a rough path every ~6 cm and clamp each sample into the cabin
  const fit = pts => {
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], n = Math.max(1, Math.ceil(a.distanceTo(b) / 0.06));
      for (let k = 0; k < n; k++) out.push(a.clone().lerp(b, k / n));
    }
    out.push(pts[pts.length - 1].clone());
    const c = out.map(clampIn);
    // bent tube is smooth: average over ~30 cm, but never let the average move a point outward (up / sideways)
    for (let pass = 0; pass < 2; pass++) {   // pass 0 smooths, pass 1 smooths again and re-fits inside
      const src = c.map(v => v.clone());
      for (let i = 1; i < c.length - 1; i++) {
        const a0 = Math.max(0, i - 4), a1 = Math.min(c.length - 1, i + 4), m = new THREE.Vector3();
        for (let k = a0; k <= a1; k++) m.add(src[k]);
        m.divideScalar(a1 - a0 + 1);
        c[i].copy(m);
        if (pass === 1) clampIn(c[i]);
      }
    }
    return c;
  };
  const add = pts => g.add(mesh(tube(fit(pts), TUBE), MM.cage, false));
  const plate = (x, z) => { const p = mesh(new THREE.BoxGeometry(0.12, 0.008, 0.12), MM.cage, false); p.position.copy(clampIn(V(x, yFloor, z))); p.position.y = yFloor + 0.004; g.add(p); };
  const BIG = W;                                                      // "as far out as fits": the clamp pulls it in
  const roofYH = topIn(0, zH);
  // main hoop: up each B-pillar, across under the roof
  const hoop = [];
  for (const s of [-1, 1]) {
    const side = [0, 0.25, 0.5, 0.7, 0.85].map(t => V(s * BIG, yFloor + (roofYH - 0.1 - yFloor) * t, zH));
    if (s < 0) hoop.push(...side); else hoop.push(...side.reverse());
    if (s < 0) for (const u of [-0.75, -0.4, 0, 0.4, 0.75]) hoop.push(V(u * BIG, roofYH + 1, zH));
  }
  add(hoop);
  const hx = xIn(zH, yFloor + 0.3);
  plate(-hx, zH); plate(hx, zH);
  // harness bar at shoulder height + rear stays back to the strut towers
  const yHarness = Math.min(roofYH - 0.25, yFloor + 0.62);
  add([V(-BIG, yHarness, zH), V(BIG, yHarness, zH)]);
  const zStay = Math.max(F.deckZ - 0.35, zH - 0.9), yStay = Math.max(yFloor + 0.3, Math.min(roofYH - 0.35, (F.deckY || yFloor + 0.6) - 0.12));
  for (const s of [-1, 1]) {
    const top = clampIn(V(s * BIG, roofYH + 1, zH));
    add([V(top.x * 0.92, top.y - 0.03, zH - 0.01), V(s * hx * 0.8, (top.y + yStay) / 2, (zH + zStay) / 2), V(s * hx * 0.75, yStay, zStay)]);
  }
  if (kind === 'bar') { add([V(-BIG, roofYH + 1, zH), V(BIG, yFloor + 0.05, zH)]); return; }
  // main-hoop diagonal
  add([V(-BIG, roofYH + 1, zH), V(0, (roofYH + yFloor) / 2, zH), V(BIG, yFloor + 0.05, zH)]);
  // A-pillar bars: floor at the kick panel -> up the inside of the windshield pillar -> roof rail back to the hoop
  const aTop = [];
  for (const s of [-1, 1]) {
    // vertical up the kick panel to the dash, then one straight run along the pillar to the roof corner, then the rail
    const yDash = Math.min(topIn(0, zA) - 0.04, F.hoodY + 0.12);
    const corner = clampIn(V(s * BIG, 9, F.roofF - 0.02));
    const pts = [V(s * BIG, yFloor + 0.05, zA), V(s * BIG, yDash, zA)];
    for (let k = 1; k <= 4; k++) pts.push(V(s * BIG, yDash + (corner.y - yDash) * k / 4, zA + (corner.z - zA) * k / 4));
    pts.push(V(s * BIG, 9, (F.roofF + zH) / 2), V(s * BIG, 9, zH + 0.02));
    add(pts);
    aTop.push(clampIn(V(s * BIG, 9, F.roofF - 0.04)));
    plate(s * xIn(zA, yFloor + 0.2), zA);
    // NASCAR door bars: two bars bowed out into the gutted door
    for (const [y0, y1] of [[0.16, 0.2], [0.36, 0.4]]) add([V(s * BIG, yFloor + y0, zH + 0.02), V(s * BIG * 1.2, yFloor + y1, (zH + zA) / 2), V(s * BIG, yFloor + y0, zA + 0.03)]);
  }
  // windshield header + dash bar + roof diagonal
  add([aTop[0], V(0, 9, F.roofF - 0.04), aTop[1]]);
  add([V(-BIG, Math.min(F.hoodY + 0.02, topIn(0, zA) - 0.05), zA), V(BIG, Math.min(F.hoodY + 0.02, topIn(0, zA) - 0.05), zA)]);
  add([aTop[0], V(0, 9, (F.roofF + zH) / 2), V(BIG, 9, zH + 0.02)]);
}

// ---------- interiors that follow the build ----------
// Stock: the model's own interior. With bucket seats / a stripped interior, the original seats and floor trim are cut
// away (clipping box behind the dashboard, per instance) and replaced: fixed carbon buckets with harnesses,
// bare painted floor + no rear seats when stripped, fire extinguisher + harness bar with a cage.
export function addInterior(ctx) {
  const { spec, body, F, shell, lift, dz } = ctx;
  const has = id => spec.parts.some(p => p.id === id);
  const buckets = has('seats'), stripped = has('interior'), cage = has('weldcage') || has('boltcage');
  if (!buckets && !stripped) return null;
  const open = spec.car.body === 'roadster' && F.roofF - F.roofR < 0.5;
  const W = F.W, zSeat = seatZ(F, open), half = Math.min(F.W * 0.42, F.sideX(zSeat, F.roofY - 0.5) - 0.12);
  const floorY = Math.max(0.16, Math.min(0.45, F.lowAt(W * 0.2, zSeat) + 0.06));
  // ---- cut the original seats / rear bench / carpet (keep dash, doors, roof, glass) ----
  const zFront = Math.min(F.cowl - 0.45, Math.max(F.roofF - 0.45, zSeat + 0.4)), zBack = stripped ? F.roofR - 0.25 : zSeat - 0.45;
  const box = [
    [new THREE.Vector3(1, 0, 0), half], [new THREE.Vector3(-1, 0, 0), half],
    [new THREE.Vector3(0, 0, 1), -zBack], [new THREE.Vector3(0, 0, -1), zFront],
    [new THREE.Vector3(0, 1, 0), -(floorY - 0.04)], [new THREE.Vector3(0, -1, 0), F.roofY - 0.28],
  ];
  // planes in shell space: n·p + c >= 0 is the clipped side for clipIntersection (all planes must clip)
  const local = box.map(([n, c]) => new THREE.Plane(n.clone().negate(), -c));   // inside the box -> clipped
  const world = local.map(p => p.clone());
  const mats = new Map();
  shell.traverse(o => {
    if (!o.isMesh) return;
    const conv = m => { if (!mats.has(m)) { const c = m.clone(); c.clippingPlanes = world; c.clipIntersection = true; c.onBeforeCompile = m.onBeforeCompile; c.customProgramCacheKey = m.customProgramCacheKey; if (m.userData.cf) c.userData.cf = m.userData.cf; mats.set(m, c); } return mats.get(m); };
    o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
    o.onBeforeRender = ((prev) => function (...a) { for (let i = 0; i < local.length; i++) world[i].copy(local[i]).applyMatrix4(shell.matrixWorld); prev?.apply(this, a); })(o.onBeforeRender);
  });
  // ---- new interior ----
  const g = new THREE.Group(); g.position.set(0, lift, dz); body.add(g);
  const fabric = new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.95 });
  const MM = modMats();
  const floorMat = stripped ? panelPaint(ctx.paint, ctx.paintTint) : new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 1 });
  if (stripped) floorMat.roughness = 0.6;
  const floor = mesh(new THREE.BoxGeometry(half * 2, 0.02, zFront - zBack), floorMat, false); floor.position.set(0, floorY, (zFront + zBack) / 2); g.add(floor);
  const tunnel = mesh(new THREE.BoxGeometry(0.24, 0.16, zFront - zBack), stripped ? floorMat : fabric, false); tunnel.position.set(0, floorY + 0.08, (zFront + zBack) / 2); g.add(tunnel);
  const harness = new THREE.MeshStandardMaterial({ color: spec.sel?.color ? 0x1f4fa8 : 0xc8102e, roughness: 0.8 });
  // keep the seat back ~20 cm under the roof (head room), shorter seats in low cars
  const sH = Math.max(0.7, Math.min(1, (F.roofY - 0.22 - floorY) / 0.93));
  const seat = (x, bucket) => {
    const s = new THREE.Group(); s.position.set(x, floorY, zSeat); s.scale.set(1, sH, 1);
    const m = bucket ? MM.carbon : fabric;
    const base = mesh(new THREE.BoxGeometry(0.5, 0.12, 0.5), m); base.position.set(0, 0.14, 0.05); s.add(base);
    const back = mesh(new THREE.BoxGeometry(0.5, 0.75, 0.1), m); back.position.set(0, 0.55, -0.22); back.rotation.x = bucket ? -0.18 : -0.28; s.add(back);
    if (bucket) {
      for (const sx of [-1, 1]) { const b = mesh(new THREE.BoxGeometry(0.06, 0.7, 0.42), m); b.position.set(sx * 0.27, 0.48, -0.08); b.rotation.x = -0.18; s.add(b); const l = mesh(new THREE.BoxGeometry(0.06, 0.12, 0.45), m); l.position.set(sx * 0.27, 0.24, 0.07); s.add(l); }
      const pad = mesh(new THREE.BoxGeometry(0.4, 0.5, 0.03), fabric); pad.position.set(0, 0.55, -0.16); pad.rotation.x = -0.18; s.add(pad);
      for (const sx of [-0.09, 0.09]) { const st = mesh(new THREE.BoxGeometry(0.05, 0.62, 0.012), harness, false); st.position.set(sx, 0.62, -0.13); st.rotation.x = -0.18; s.add(st); }
      const lap = mesh(new THREE.BoxGeometry(0.38, 0.05, 0.012), harness, false); lap.position.set(0, 0.28, 0.12); s.add(lap);
    } else { const hr = mesh(new THREE.BoxGeometry(0.28, 0.18, 0.1), m); hr.position.set(0, 1.0, -0.3); s.add(hr); }
    g.add(s);
  };
  seat(W * 0.2, buckets); seat(-W * 0.2, buckets);
  if (!stripped && zSeat - 0.85 > F.roofR - 0.2) {
    const bench = mesh(new THREE.BoxGeometry(half * 1.8, 0.55, 0.45), fabric); bench.position.set(0, floorY + 0.35, zSeat - 0.9); g.add(bench);
  }
  if (cage || stripped) {
    const ext = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.4, 12), new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.4 })); ext.rotation.z = Math.PI / 2; ext.position.set(0, floorY + 0.12, zSeat + 0.35); g.add(ext);
  }
  return g;
}

// copy of a geometry (sharing its vertex attributes) without the given triangles (index offsets), groups kept
export function withoutTris(g, drop) {
  const idx = g.index, n = idx ? idx.count : g.attributes.position.count;
  const groups = g.groups.length ? g.groups : [{ start: 0, count: n, materialIndex: 0, whole: true }];
  const keep = [], ng = [];
  for (const gr of groups) {
    const st = keep.length;
    for (let t = gr.start; t < Math.min(n, gr.start + gr.count); t += 3) if (!drop.has(t)) keep.push(idx ? idx.getX(t) : t, idx ? idx.getX(t + 1) : t + 1, idx ? idx.getX(t + 2) : t + 2);
    ng.push([st, keep.length - st, gr.materialIndex, gr.whole]);
  }
  const out = new THREE.BufferGeometry();
  for (const [k, v] of Object.entries(g.attributes)) out.setAttribute(k, v);
  out.setIndex(keep);
  if (!ng[0][3]) for (const [st, c, m] of ng) out.addGroup(st, c, m);
  out.boundingSphere = g.boundingSphere; out.boundingBox = g.boundingBox;
  return out;
}

// Factory rear spoiler detection: a separate mesh piece (connected component) sitting on the trunk lid / hatch near
// the tail, most of the car wide, standing just above the deck with open air above it, not glass or a light. Pieces
// that belong to it (second shell, third brake light, separate posts) are taken with it. Returns [{mesh, tris:Set}] so
// the spoiler can be removed when an aftermarket wing / ducktail replaces it, as on real cars.
// models whose factory wing is welded into the one body mesh (no separate piece to find): its triangles by box (car space)
const OEM_WING_BOX = {
  fd3s: { x0: -0.95, x1: 0.95, y0: 0.8, y1: 1.2, z0: -2.2, z1: -1.72, float: true },
  r33: [{ x0: -0.9, x1: -0.5, y0: 1.0, y1: 1.3, z0: -2.35, z1: -1.9 }, { x0: 0.5, x1: 0.9, y0: 1.0, y1: 1.3, z0: -2.35, z1: -1.9 }],   // fins moulded into the lid
  viper_acr: { x0: -1.05, x1: 1.05, y0: 0.9, y1: 1.5, z0: -2.45, z1: -1.55, mesh: /detach_diffuser_5|detach_wing/ },   // the model calls its wing 'diffuser'
};
export function findOemSpoiler(scene, F, hatch, carId) {
  const W = F.W, A = new THREE.Vector3(), comps = [];
  scene.updateMatrixWorld(true);
  scene.traverse(o => {
    if (!o.isMesh || !o.geometry.attributes.position) return;
    const mats = [].concat(o.material);
    const g = o.geometry, pos = g.attributes.position, idx = g.index, n = idx ? idx.count : pos.count;
    const triMat = t => { for (const gr of g.groups) if (t >= gr.start && t < gr.start + gr.count) return mats[gr.materialIndex] || mats[0]; return mats[0]; };
    // union-find over vertices welded by position (1 mm)
    const key = new Map(), par = new Int32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const k = Math.round(pos.getX(i) * 1000) + ',' + Math.round(pos.getY(i) * 1000) + ',' + Math.round(pos.getZ(i) * 1000);
      const f = key.get(k); par[i] = f ?? i; if (f == null) key.set(k, i);
    }
    const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (let t = 0; t < n; t += 3) {
      const a = find(idx ? idx.getX(t) : t), b = find(idx ? idx.getX(t + 1) : t + 1), c = find(idx ? idx.getX(t + 2) : t + 2);
      par[b] = a; par[find(c)] = a;
    }
    const byRoot = new Map();
    for (let t = 0; t < n; t += 3) {
      const r = find(idx ? idx.getX(t) : t);
      let c = byRoot.get(r); if (!c) byRoot.set(r, c = { mesh: o, tris: [], x0: 9, x1: -9, y0: 9, y1: -9, z0: 9, z1: -9, bad: false });
      c.tris.push(t);
      const m = triMat(t);
      if (m && (m.transparent || /glass|window|light|lamp|lens|emis|plate|badge|logo/i.test(m.name || ''))) c.bad = true;
      for (let k = 0; k < 3; k++) {
        A.fromBufferAttribute(pos, idx ? idx.getX(t + k) : t + k).applyMatrix4(o.matrixWorld);
        c.x0 = Math.min(c.x0, A.x); c.x1 = Math.max(c.x1, A.x); c.y0 = Math.min(c.y0, A.y); c.y1 = Math.max(c.y1, A.y); c.z0 = Math.min(c.z0, A.z); c.z1 = Math.max(c.z1, A.z);
      }
    }
    for (const c of byRoot.values()) if (c.z1 > F.tail - 0.2 && c.z0 < F.tail + 1.4) comps.push(c);   // rear of the car only
  });
  const inBox = (p, c, m = 0.02) => p.x > c.x0 - m && p.x < c.x1 + m && p.y > c.y0 - m && p.y < c.y1 + m && p.z > c.z0 - m && p.z < c.z1 + m;
  const cands = comps.filter(c => !c.bad && c.tris.length >= 12
    && c.x1 - c.x0 > 0.5 * W && Math.abs(c.x1 + c.x0) < 0.15                     // most of the width, centred
    && c.z0 > F.tail - 0.15 && c.z1 < F.tail + (hatch ? 1.2 : 0.95)                // at the tail
    && c.z1 - c.z0 < (hatch ? 0.7 : 0.6) && c.y1 - c.y0 < 0.5 && c.y0 > 0.45 * F.roofY
    && (!hatch || c.z1 < F.roofR - 0.25));                                          // hatch: a wing on the hatch, not the roof spoiler (that stays)
  const ray = new THREE.Raycaster(), meshes = [];
  scene.traverse(o => { if (o.isMesh) meshes.push(o); });
  const triSet = new Map();   // comp -> Set (for hit tests)
  const own = (h, c) => h.object === c.mesh && (triSet.get(c) || triSet.set(c, new Set(c.tris)).get(c)).has(h.faceIndex * 3);
  const out = [];
  for (const c of cands) {
    const hx = (c.x1 - c.x0) / 2, dz = c.z1 - c.z0;
    let hitCols = 0, close = 0, covered = 0;
    for (const x of [-0.6 * hx, -0.3 * hx, 0.3 * hx, 0.6 * hx]) for (const z of [c.z0 + 0.25 * dz, c.z0 + 0.5 * dz, c.z0 + 0.75 * dz]) {
      ray.set(new THREE.Vector3(x, c.y1 + 0.6, z), new THREE.Vector3(0, -1, 0)); ray.far = 2;
      let lastSelf = null, gap = null, otherFirst = false;
      for (const h of ray.intersectObjects(meshes, false)) {
        if (own(h, c)) { lastSelf = h.distance; continue; }
        if (lastSelf == null) { if (!inBox(h.point, c)) otherFirst = true; }   // pieces inside its own box (a 2nd shell, a brake light) don't cover it
        else { gap = h.distance - lastSelf; break; }
      }
      if (lastSelf == null) continue;
      hitCols++;
      if (otherFirst) covered++;                     // something above it (glass over a parcel shelf, a wing over a lid)
      if (gap != null && gap < 0.25) close++;        // deck right under it (a lid has the empty trunk under it)
    }
    if (F._dbg) F._dbg.push({ m: ([].concat(c.mesh.material)[0]?.name || '').slice(0, 20), n: c.tris.length, hitCols, close, covered, box: [c.y0, c.y1, c.z0, c.z1].map(v => +v.toFixed(2)) });
    if (hitCols >= 3 && close >= 0.6 * hitCols && covered <= 1) out.push(c);
  }
  // take the pieces that belong to it: anything entirely inside its box, and posts reaching from the deck up to it
  const take = new Set(out);
  for (const w of out) for (const c of comps) {
    if (take.has(c)) continue;
    // mounts: whatever sits entirely under the blade's footprint, from the deck up to the blade
    const under = !c.bad && c.x0 > w.x0 - 0.02 && c.x1 < w.x1 + 0.02 && c.z0 > w.z0 - 0.06 && c.z1 < w.z1 + 0.06
      && c.y1 >= w.y0 - 0.03 && c.y1 < w.y1 + 0.03 && c.y0 > w.y0 - 0.3 && c.tris.length < 12 * w.tris.length + 2000;
    if (!under && c.tris.length > 3 * w.tris.length + 200) continue;               // never a big body panel
    // endplates / second shell: inside its box (endplates can stand a little above and outboard of the blade)
    // (a blade stacked right under the found piece - painted main plane under a black top skin - counts too)
    const stacked = !c.bad && c.y1 <= w.y0 + 0.02 && c.y0 > w.y0 - 0.12 && c.x1 - c.x0 > 0.8 * (w.x1 - w.x0) && c.x0 > w.x0 - 0.06 && c.x1 < w.x1 + 0.06 && c.z0 > w.z0 - 0.08 && c.z1 < w.z1 + 0.08;
    if (stacked) { take.add(c); continue; }
    // endplates / fins at the blade tips reaching down to the deck: thin in x, at either end of the blade
    const tip = !c.bad && c.x1 - c.x0 < 0.16 && (Math.abs(c.x0 - w.x0) < 0.1 || Math.abs(c.x1 - w.x1) < 0.1) && c.y1 > w.y0 - 0.02 && c.y1 < w.y1 + 0.1 && c.y0 > w.y0 - 0.4 && c.z0 > w.z0 - 0.15 && c.z1 < w.z1 + 0.15 && c.tris.length < 4 * w.tris.length + 500;
    if (tip) { take.add(c); continue; }
    const inside = c.x0 > w.x0 - 0.04 && c.x1 < w.x1 + 0.04 && c.y0 > w.y0 - 0.03 && c.y1 < w.y1 + 0.06 && c.z0 > w.z0 - 0.04 && c.z1 < w.z1 + 0.04
      && (!c.bad || (c.x1 - c.x0 < 0.45 && c.y0 > w.y0 + 0.3 * (w.y1 - w.y0)));       // a light only if it's a brake light up on the wing
    // stands / posts: narrow pieces (not lights) reaching from the deck up to the blade, under or just outboard of it,
    // possibly running forward along the hatch
    const post = !c.bad && c.x1 - c.x0 < 0.25 && c.y1 - c.y0 > 0.06
      && c.x0 > w.x0 - 0.2 && c.x1 < w.x1 + 0.2 && c.z0 > w.z0 - 0.1 && c.z1 < w.z1 + 0.35
      && c.y1 >= w.y0 - 0.03 && c.y1 < w.y1 + 0.03 && c.y0 > w.y0 - 0.35;
    if (inside || post || under) take.add(c);
  }
  const res = [...take].map(c => ({ mesh: c.mesh, tris: triSet.get(c) || new Set(c.tris), box: c }));
  for (const WB of [].concat(OEM_WING_BOX[carId] || [])) {
    // floating test: an up-facing surface 1-30 cm under the triangle (deck under a blade) - from a 2 cm grid of the
    // up-facing triangles around the box, so it's one pass over the geometry instead of a raycast per triangle
    let up = null;
    const CS = 0.02, NXg = Math.ceil((WB.x1 - WB.x0) / CS), NZg = Math.ceil((WB.z1 - WB.z0) / CS);
    const ci = (x, z) => { const i = Math.floor((x - WB.x0) / CS), k = Math.floor((z - WB.z0) / CS); return i < 0 || k < 0 || i >= NXg || k >= NZg ? -1 : k * NXg + i; };
    if (WB.float) {
      up = Array.from({ length: NXg * NZg }, () => []);
      const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
      scene.traverse(o => {
        if (!o.isMesh || !o.geometry.attributes.position) return;
        const g = o.geometry, pos = g.attributes.position, idx = g.index, n = idx ? idx.count : pos.count;
        for (let t = 0; t < n; t += 3) {
          for (let k = 0; k < 3; k++) P[k].fromBufferAttribute(pos, idx ? idx.getX(t + k) : t + k).applyMatrix4(o.matrixWorld);
          const cy = (P[0].y + P[1].y + P[2].y) / 3; if (cy < WB.y0 - 0.32 || cy > WB.y1) continue;
          const x0 = Math.min(P[0].x, P[1].x, P[2].x), x1 = Math.max(P[0].x, P[1].x, P[2].x), z0 = Math.min(P[0].z, P[1].z, P[2].z), z1 = Math.max(P[0].z, P[1].z, P[2].z);
          if (x1 < WB.x0 || x0 > WB.x1 || z1 < WB.z0 || z0 > WB.z1) continue;
          const nY = e1.subVectors(P[1], P[0]).cross(e2.subVectors(P[2], P[0])).normalize().y;
          if (nY < 0.2) continue;
          for (let x = Math.max(x0, WB.x0); x <= Math.min(x1, WB.x1); x += CS) for (let z = Math.max(z0, WB.z0); z <= Math.min(z1, WB.z1); z += CS) { const c = ci(x, z); if (c >= 0) up[c].push(cy); }
        }
      });
    }
    scene.traverse(o => {
      if (!o.isMesh || !o.geometry.attributes.position || [].concat(o.material).some(m => m.transparent)) return;
      if (WB.mesh && !WB.mesh.test(o.name || '')) return;
      const g = o.geometry, pos = g.attributes.position, idx = g.index, n = idx ? idx.count : pos.count, tris = new Set();
      for (let t = 0; t < n; t += 3) {
        let ok = true, cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < 3 && ok; k++) { A.fromBufferAttribute(pos, idx ? idx.getX(t + k) : t + k).applyMatrix4(o.matrixWorld); ok = A.x > WB.x0 && A.x < WB.x1 && A.y > WB.y0 && A.y < WB.y1 && A.z > WB.z0 && A.z < WB.z1; cx += A.x / 3; cy += A.y / 3; cz += A.z / 3; }
        if (!ok) continue;
        if (up) { const c = ci(cx, cz); if (c < 0 || !up[c].some(y => y < cy - 0.012 && y > cy - 0.3)) continue; }
        tris.add(t);
      }
      if (tris.size) res.push({ mesh: o, tris, box: WB });
    });
  }
  if (res.length) return res;
  // fallback: models that name their wing meshes ("detach_wing", "rear_spoiler"): whole meshes at the tail, up high
  const box = new THREE.Box3();
  scene.traverse(o => {
    if (!o.isMesh) return;
    let nm = '', p = o; for (let k = 0; k < 3 && p; k++, p = p.parent) nm += ' ' + (p.name || '');
    if (!/(wing|spoiler)/i.test(nm) || /mirror|door|fender|wheel/i.test(nm)) return;
    box.setFromObject(o);
    if ((box.min.z + box.max.z) / 2 > F.tail + 0.9 || box.max.y < 0.6 * F.roofY || box.max.z - box.min.z > 1.0) return;
    const n = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count);
    const tris = new Set(); for (let t = 0; t < n; t += 3) tris.add(t);
    res.push({ mesh: o, tris, box: { x0: box.min.x, x1: box.max.x, y0: box.min.y, y1: box.max.y, z0: box.min.z, z1: box.max.z } });
  });
  return res;
}
