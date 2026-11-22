// Convert a downloaded car model (.glb/.gltf) into TorqueForge game assets.
//   node tools/process_model.mjs <carId> <input.glb|gltf> [--flip] [--rot90] [--keep-wheels]
// Output: assets/cars/<carId>/{high.glb, low.glb, manifest.json}
//
// Steps: bake node transforms -> drop ground planes -> orient (length on +Z, front = +Z) -> scale to the real car length
// -> find the 4 wheels from tire contact patches + circle fit -> cut the original wheels/brakes out (the game draws the
// selected wheels/tires/brakes there) -> detect paint + brake-light materials -> measure body profile (for aero parts)
// -> two LODs (simplified with meshoptimizer, WebP textures, meshopt-compressed).
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import * as F from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { CAR_BY_ID } from '../js/data.js';
import { evaluate, emptyBuild } from '../js/build.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [carId, input, ...flags] = process.argv.slice(2);
if (!carId || !input || !CAR_BY_ID[carId]) { console.error('usage: process_model.mjs <carId> <input> [--flip] [--rot90] [--keep-wheels]'); process.exit(2); }
const car = CAR_BY_ID[carId];
const spec = evaluate(emptyBuild(carId));
const OUT = path.join(ROOT, 'assets/cars', carId);
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(`[${carId}]`, ...a);

await MeshoptDecoder.ready; await MeshoptEncoder.ready; await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder,
});
const doc = await io.read(input);
const root = doc.getRoot();
for (const e of root.listExtensionsUsed()) if (e.extensionName === 'KHR_draco_mesh_compression') e.dispose(); // re-encoded with meshopt instead

// ---------- clean + bake transforms ----------
for (const a of root.listAnimations()) a.dispose();
for (const s of root.listSkins()) s.dispose();
for (const c of root.listCameras()) c.dispose();
// only the default scene
const scene = root.getDefaultScene() || root.listScenes()[0];
for (const s of root.listScenes()) if (s !== scene) s.dispose();
await doc.transform(F.dequantize(), F.uninstance(), F.flatten());
for (const n of root.listNodes()) { if (n.getMesh() || n.listChildren().length) F.clearNodeTransform(n); }
// drop non-triangle primitives (lines/points) and morph targets
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
  if (p.getMode() !== 4) { p.dispose(); continue; }
  for (const t of p.listTargets()) t.dispose();
}
await doc.transform(F.prune());

const prims = () => {
  const out = [];
  for (const n of scene.listChildren().length ? collectNodes(scene) : []) {
    const m = n.getMesh(); if (!m) continue;
    for (const p of m.listPrimitives()) out.push({ node: n, mesh: m, prim: p });
  }
  return out;
};
function collectNodes(sc) { const out = []; sc.traverse(n => out.push(n)); return out; }
function bbox(p) {
  const pos = p.getAttribute('POSITION'); const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; const v = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); for (let k = 0; k < 3; k++) { if (v[k] < mn[k]) mn[k] = v[k]; if (v[k] > mx[k]) mx[k] = v[k]; } }
  return { mn, mx };
}
const nameOf = e => `${e.node.getName()} ${e.mesh.getName()} ${e.prim.getMaterial()?.getName() || ''}`.toLowerCase();

// ground planes / shadow catchers / backdrops
{
  let all = prims(); const boxes = all.map(e => bbox(e.prim));
  const gmn = [0, 1, 2].map(k => Math.min(...boxes.map(b => b.mn[k]))), gmx = [0, 1, 2].map(k => Math.max(...boxes.map(b => b.mx[k])));
  all.forEach((e, i) => {
    const b = boxes[i], ex = [0, 1, 2].map(k => b.mx[k] - b.mn[k]);
    const flat = ex[1] < 0.01 * Math.max(ex[0], ex[2]) && ex[0] * ex[2] > 0.25 * (gmx[0] - gmn[0]) * (gmx[2] - gmn[2]) && b.mx[1] <= gmn[1] + 0.05 * (gmx[1] - gmn[1]);
    if (flat || /\b(shadow|ground|floor|backdrop|groundplane|studio)\b/.test(nameOf(e))) { log('removing ground/backdrop prim:', nameOf(e).trim()); e.prim.dispose(); }
  });
  await doc.transform(F.prune());
}

// ---------- orientation + scale ----------
function applyAll(mat) { for (const e of prims()) F.transformPrimitive(e.prim, mat); }
const mat4 = (a) => a; // column-major 16 array
function totalBox() {
  const bs = prims().map(e => bbox(e.prim));
  return { mn: [0, 1, 2].map(k => Math.min(...bs.map(b => b.mn[k]))), mx: [0, 1, 2].map(k => Math.max(...bs.map(b => b.mx[k]))) };
}
let B = totalBox();
let ext = [0, 1, 2].map(k => B.mx[k] - B.mn[k]);
log('raw extents', ext.map(x => x.toFixed(3)).join(' x '));
if (ext[1] > ext[0] && ext[1] > ext[2]) log('WARNING: Y is the longest axis — model may not be Y-up');
// length along Z
if (ext[0] > ext[2] !== flags.includes('--rot90')) { applyAll(mat4([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1])); B = totalBox(); ext = [0, 1, 2].map(k => B.mx[k] - B.mn[k]); }
// scale to real length, centre on x/z, ground at y=0
const S = car.L / ext[2];
const cx = (B.mn[0] + B.mx[0]) / 2, cz = (B.mn[2] + B.mx[2]) / 2;
applyAll(mat4([S, 0, 0, 0, 0, S, 0, 0, 0, 0, S, 0, -cx * S, -B.mn[1] * S, -cz * S, 1]));
B = totalBox(); ext = [0, 1, 2].map(k => B.mx[k] - B.mn[k]);
log(`scaled x${S.toFixed(4)} -> L ${ext[2].toFixed(3)} W ${ext[0].toFixed(3)} H ${ext[1].toFixed(3)} (real ${car.L} x ${car.W} x ${car.H})`);

// gather all vertex positions (for analysis)
function allVerts(filter) {
  const out = []; const v = [0, 0, 0];
  for (const e of prims()) { const pos = e.prim.getAttribute('POSITION'); for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); if (!filter || filter(v)) out.push([v[0], v[1], v[2]]); } }
  return out;
}

// ---------- front/back ----------
function frontVote() {
  let vote = 0; const why = [];
  for (const e of prims()) {
    const nm = nameOf(e), b = bbox(e.prim), z = (b.mn[2] + b.mx[2]) / 2;
    const zr = z / (ext[2] / 2);
    if (Math.abs(zr) < 0.35) continue;
    if (/head ?l|headlamp|front|grille|grill|f_bumper|bumper_f|bonnet|hood|radiator/.test(nm)) { vote += Math.sign(z); why.push('F:' + nm.slice(0, 30)); }
    if (/tail ?l|taillamp|rear|trunk|boot|exhaust|muffler|diffuser|bumper_r|r_bumper|spoiler|wing/.test(nm)) { vote -= Math.sign(z); why.push('R:' + nm.slice(0, 30)); }
  }
  for (const e of prims()) { const nm = nameOf(e); if (/steer/.test(nm)) { const b = bbox(e.prim); const z = (b.mn[2] + b.mx[2]) / 2; const cab = cabinZ(); vote += 3 * Math.sign(z - cab); why.push(`steer ${z.toFixed(2)} vs cabin ${cab.toFixed(2)}`); break; } }
  const cab = cabinZ();
  if (car.layout === 'F') { vote += -2 * Math.sign(cab); why.push(`cabin z ${cab.toFixed(2)} (front-engine)`); }
  if (car.layout === 'M') { vote += 2 * Math.sign(cab); why.push(`cabin z ${cab.toFixed(2)} (mid-engine)`); }
  return { vote, why };
}
function cabinZ() { const H = ext[1]; const vs = allVerts(v => v[1] > H * 0.85 && Math.abs(v[0]) < ext[0] * 0.3); return vs.reduce((s, v) => s + v[2], 0) / Math.max(1, vs.length); }
let fv = frontVote();
let flip = fv.vote < 0;
if (flags.includes('--flip')) flip = !flip;
log('front vote', fv.vote, flip ? '(rotating 180°)' : '', flags.includes('--flip') ? '[--flip override]' : '', '|', fv.why.slice(0, 6).join(', '));
if (flip) applyAll(mat4([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]));

// ---------- wheels ----------
const keepWheels = flags.includes('--keep-wheels');
function findWheels() {
  const ymin = 0, W = ext[0];
  // per corner: the tire is the lowest thing near each corner (robust to splitters/exhausts/stray low parts elsewhere)
  const outer = allVerts(v => Math.abs(v[0]) > W * 0.22 && Math.abs(v[2]) > ext[2] * 0.12 && v[1] < ext[1] * 0.25);
  const quads = [[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([sx, sz]) => {
    const q = outer.filter(v => Math.sign(v[0]) === sx && Math.sign(v[2]) === sz);
    const qmin = Math.min(...q.map(v => v[1]));
    return q.filter(v => v[1] < qmin + 0.018);
  });
  if (quads.some(q => q.length < 6)) return { ok: false, why: 'contact patches: ' + quads.map(q => q.length).join('/') };
  const near = allVerts(v => v[1] < 1.0);
  const wheels = quads.map((q, i) => {
    const xs = q.map(v => v[0]).sort((a, b) => a - b), zs = q.map(v => v[2]).sort((a, b) => a - b);
    const xlo = xs[Math.floor(xs.length * 0.02)], xhi = xs[Math.floor(xs.length * 0.98)];
    const xc = (xlo + xhi) / 2, tw = Math.max(0.12, xhi - xlo), zc = (zs[0] + zs[zs.length - 1]) / 2, g0 = Math.min(...q.map(v => v[1]));
    // circle fit in side view: centre (ymin + r, zc), count vertices lying on the circle
    const pts = near.filter(v => Math.abs(v[0] - xc) < tw / 2 + 0.03 && Math.abs(v[2] - zc) < 0.55);
    // the tread is a circle with empty air just outside it (below/fore/aft of the tire); rim and spokes fill the
    // inside. Score = points on the lower half of the circle minus points in a thin shell just outside it.
    let best = -1e9, bestR = 0.3, bestHits = 0;
    for (let r = 0.2; r <= 0.5; r += 0.0025) {
      const bins = new Uint8Array(18); let on = 0, outside = 0;
      for (const v of pts) {
        const dy = v[1] - g0 - r, dz = v[2] - zc; if (dy > 0) continue;
        const d = Math.hypot(dy, dz) - r;
        if (Math.abs(d) < 0.006) { on++; bins[Math.min(17, Math.floor((Math.atan2(-dy, dz)) / Math.PI * 18))] = 1; }
        else if (d > 0.012 && d < 0.05) outside++;
      }
      const cov = bins.reduce((a, b) => a + b, 0);
      const score = cov * 10 + on * 0.05 - outside * 0.5;
      if (score > best) { best = score; bestR = r; bestHits = cov; }
    }
    return { x: xc, z: zc, r: bestR, y: g0 + bestR, tw, hits: bestHits, front: zc > 0 }; // hits = lower-half bins covered of 18
  });
  return { ok: true, wheels };
}
let wf = findWheels();
let wheelInfo = null;
if (wf.ok) {
  const w = wf.wheels;
  const wb = ((w[0].z + w[1].z) - (w[2].z + w[3].z)) / 2;
  const trF = Math.abs(w[0].x - w[1].x), trR = Math.abs(w[2].x - w[3].x);
  const rs = w.map(x => x.r);
  log(`wheels: wb ${wb.toFixed(3)} (real ${car.wb}) track ${trF.toFixed(2)}/${trR.toFixed(2)} r ${rs.map(r => r.toFixed(3)).join('/')} (stock tire R ${spec.tire.R.toFixed(3)}) hits ${w.map(x => x.hits).join('/')}`);
  const sane = Math.abs(wb - car.wb) / car.wb < 0.12 && rs.every(r => Math.abs(r - spec.tire.R) / spec.tire.R < 0.3);
  if (!sane) { log('WARNING: wheel fit looks off; keeping original wheels'); wf = { ok: false, why: 'fit not sane' }; }
  else wheelInfo = { wb, trF, trR, wheels: w };
} else log('WARNING: wheel detection failed:', wf.why);

let removedTris = 0;
if (wheelInfo && !keepWheels) {
  // cut triangles fully inside each wheel's cylinder (tire, rim, brake disc/caliper, hub)
  for (const e of prims()) {
    const p = e.prim, pos = p.getAttribute('POSITION');
    let idx = p.getIndices();
    const n = idx ? idx.getCount() : pos.getCount();
    const get = i => idx ? idx.getScalar(i) : i;
    const inside = new Uint8Array(pos.getCount()); const v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      for (const w of wheelInfo.wheels) {
        const out = Math.sign(w.x), dx = (v[0] - w.x) * out; // + = outward
        if (dx > w.tw / 2 + 0.035 || dx < -(w.tw / 2 + 0.24)) continue;
        if (Math.hypot(v[1] - w.y, v[2] - w.z) < w.r * 1.012 + 0.004) { inside[i] = 1; break; }
      }
    }
    const keep = [];
    for (let t = 0; t < n; t += 3) { const a = get(t), b = get(t + 1), c = get(t + 2); if (inside[a] && inside[b] && inside[c]) { removedTris++; continue; } keep.push(a, b, c); }
    if (keep.length === n) continue;
    if (!keep.length) { p.dispose(); continue; }
    const big = pos.getCount() > 65535;
    const acc = doc.createAccessor().setType('SCALAR').setArray(big ? new Uint32Array(keep) : new Uint16Array(keep)).setBuffer(root.listBuffers()[0]);
    p.setIndices(acc);
  }
  await doc.transform(F.prune());
  log(`removed ${removedTris} wheel/brake triangles`);
}

// ---------- materials: paint, brake lights, glass ----------
const triArea = (a, b, c) => { const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; return 0.5 * Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]); };
const matStats = new Map();
for (const e of prims()) {
  const m = e.prim.getMaterial(); if (!m) continue;
  const pos = e.prim.getAttribute('POSITION'), idx = e.prim.getIndices();
  const n = idx ? idx.getCount() : pos.getCount(); const A = [0, 0, 0], Bv = [0, 0, 0], C = [0, 0, 0];
  let area = 0, zs = 0, ys = 0, outer = 0;
  for (let t = 0; t < n; t += 3) {
    pos.getElement(idx ? idx.getScalar(t) : t, A); pos.getElement(idx ? idx.getScalar(t + 1) : t + 1, Bv); pos.getElement(idx ? idx.getScalar(t + 2) : t + 2, C);
    const ar = triArea(A, Bv, C); area += ar; zs += ar * (A[2] + Bv[2] + C[2]) / 3; ys += ar * (A[1] + Bv[1] + C[1]) / 3;
    if (Math.abs(A[0]) > ext[0] * 0.38 || A[1] > ext[1] * 0.8) outer += ar;
  }
  const s = matStats.get(m) || { area: 0, zs: 0, ys: 0, outer: 0 };
  s.area += area; s.zs += zs; s.ys += ys; s.outer += outer; matStats.set(m, s);
}
const EXCL = /glass|window|windscreen|windshield|tire|tyre|rubber|chrome|interior|seat|plastic|light|lamp|grill|carbon|logo|badge|emblem|decal|plate|brake|rim|wheel|mirror_glass|engine|dash|leather|black|trim|lens|reflector|exhaust|undercarriage|chassis|shadow|steer|carpet|cloth|gauge|screen|bulb|caliper|disc|rotor|tread|metal|alum/i;
const PAINT = /paint|body|carpaint|car_paint|exterior|lack|coat|color|colour|shell/i;
const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const sat = c => Math.max(...c) - Math.min(...c);
let paintCands = [];
for (const [m, s] of matStats) {
  const nm = m.getName() || '';
  const bc = m.getBaseColorFactor();
  const transp = m.getAlphaMode() === 'BLEND' || bc[3] < 0.9 || m.getExtension('KHR_materials_transmission');
  if (transp) continue;
  const named = PAINT.test(nm) && !/interior|under/i.test(nm);
  if (EXCL.test(nm) && !named) continue;
  let score = s.outer * (named ? 3 : 1) * (sat(bc) > 0.15 ? 1.5 : 1) * (lum(bc) < 0.02 && !named ? 0.3 : 1);
  paintCands.push({ m, nm, score, bc, area: s.area });
}
paintCands.sort((a, b) => b.score - a.score);
const paint = [];
if (paintCands.length) {
  const top = paintCands[0];
  paint.push(top.nm);
  for (const c of paintCands.slice(1)) {
    const d = Math.hypot(c.bc[0] - top.bc[0], c.bc[1] - top.bc[1], c.bc[2] - top.bc[2]);
    if ((d < 0.06 && c.score > top.score * 0.02) || (PAINT.test(c.nm) && c.score > top.score * 0.1 && !/interior/i.test(c.nm))) paint.push(c.nm);
  }
}
log('paint materials:', paint.join(', ') || '(none found)', '| candidates:', paintCands.slice(0, 5).map(c => `${c.nm}:${c.score.toFixed(2)}`).join(' '));
// brake lights: red-ish materials or named tail/brake/stop lights at the rear
const tail = [];
for (const [m, s] of matStats) {
  const nm = m.getName() || '', bc = m.getBaseColorFactor(), em = m.getEmissiveFactor();
  const z = s.zs / Math.max(1e-6, s.area), rear = z < -ext[2] * 0.3;
  const red = (bc[0] > 0.35 && bc[1] < 0.2 && bc[2] < 0.2) || (em[0] > 0.3 && em[1] < 0.2);
  if (rear && (/tail|brake|stop|rear_?light|rearlight|taillight|backlight/i.test(nm) || (red && /light|lamp|lens|glass|red/i.test(nm)))) tail.push(nm);
}
log('tail-light materials:', tail.join(', ') || '(none)');

// ---------- body profile (for placing wings/splitters/diffusers) ----------
const NB = 60;
const prof = { top: Array(NB).fill(0), bottom: Array(NB).fill(9), half: Array(NB).fill(0) };
for (const v of allVerts()) {
  const b = Math.min(NB - 1, Math.max(0, Math.floor((ext[2] / 2 - v[2]) / ext[2] * NB))); // 0 = nose
  if (Math.abs(v[0]) < ext[0] * 0.22) { prof.top[b] = Math.max(prof.top[b], v[1]); if (v[1] > 0.04) prof.bottom[b] = Math.min(prof.bottom[b], v[1]); }
  if (v[1] < ext[1] * 0.62 && v[1] > 0.15) prof.half[b] = Math.max(prof.half[b], Math.abs(v[0]));
}
prof.bottom = prof.bottom.map(x => x > 8 ? 0.15 : x);
const r3 = x => Math.round(x * 1000) / 1000;

// ---------- LODs ----------
async function countTris(d) { let t = 0; for (const m of d.getRoot().listMeshes()) for (const p of m.listPrimitives()) t += (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3; return Math.round(t); }
await doc.transform(F.dedup(), F.prune());
// keep material names stable through join (join merges prims sharing a material)
await doc.transform(F.join({ keepNamed: false }), F.weld());
const srcTris = await countTris(doc);
log('source triangles after cleanup', srcTris);
// crease-aware weld: merge vertices sharing a position when normals (<40deg) and UVs agree, so the simplifier sees
// connected surfaces instead of a triangle soup. Real hard edges / UV seams stay split.
function creaseWeld(d) {
  let before = 0, after = 0;
  for (const m of d.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    const pos = p.getAttribute('POSITION'), nor = p.getAttribute('NORMAL'), uv = p.getAttribute('TEXCOORD_0');
    const n = pos.getCount(); before += n;
    const sems = p.listSemantics();
    const map = new Map(); const remap = new Uint32Array(n); const keep = [];
    const P = [0, 0, 0], N = [0, 0, 0], U = [0, 0];
    const reps = [];
    for (let i = 0; i < n; i++) {
      pos.getElement(i, P);
      const key = `${Math.round(P[0] * 2e4)},${Math.round(P[1] * 2e4)},${Math.round(P[2] * 2e4)}`;
      let list = map.get(key); if (!list) map.set(key, list = []);
      if (nor) nor.getElement(i, N); if (uv) uv.getElement(i, U);
      let found = -1;
      for (const r of list) {
        if (nor && N[0] * r.n[0] + N[1] * r.n[1] + N[2] * r.n[2] < 0.766) continue;
        if (uv && (Math.abs(U[0] - r.u[0]) > 1e-3 || Math.abs(U[1] - r.u[1]) > 1e-3)) continue;
        found = r.i; break;
      }
      if (found < 0) { found = keep.length; keep.push(i); list.push({ i: found, n: [...N], u: [...U] }); }
      remap[i] = found;
    }
    if (keep.length === n) { after += n; continue; }
    after += keep.length;
    for (const sem of sems) {
      const a = p.getAttribute(sem), sz = a.getElementSize(), src = a.getArray();
      const dst = new src.constructor(keep.length * sz);
      for (let k = 0; k < keep.length; k++) for (let c = 0; c < sz; c++) dst[k * sz + c] = src[keep[k] * sz + c];
      p.setAttribute(sem, d.createAccessor().setType(a.getType()).setArray(dst).setNormalized(a.getNormalized()).setBuffer(a.getBuffer()));
    }
    const idx = p.getIndices(); const cnt = idx ? idx.getCount() : n;
    const out = keep.length > 65535 ? new Uint32Array(cnt) : new Uint16Array(cnt);
    for (let t = 0; t < cnt; t++) out[t] = remap[idx ? idx.getScalar(t) : t];
    p.setIndices(d.createAccessor().setType('SCALAR').setArray(out).setBuffer(pos.getBuffer()));
  }
  return { before, after };
}
const cw = creaseWeld(doc);
await doc.transform(F.prune());
log(`crease weld: ${cw.before} -> ${cw.after} vertices`);
const LODS = [{ name: 'high', tris: 380000, tex: 2048, err: 0.001 }, { name: 'low', tris: 120000, tex: 1024, err: 0.004 }];
const lodInfo = {};
let lodDoc = null;
for (const L of LODS) {
  let d = F.cloneDocument(doc); lodDoc = null;
  if (srcTris > L.tris) {
    // simplify every primitive by the same ratio; raise the error budget until we hit the triangle target
    let err = L.err, got = srcTris;
    const base = F.cloneDocument(d);
    for (let it = 0; it < 5 && got > L.tris * 1.1; it++, err *= 2) {
      const t = it === 0 ? d : F.cloneDocument(base);
      got = 0;
      for (const m of t.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
        const pos = p.getAttribute('POSITION'), idx = p.getIndices();
        const ia = new Uint32Array(idx.getArray()), pa = new Float32Array(pos.getArray());
        const target = Math.max(3, Math.floor(ia.length * L.tris / srcTris / 3) * 3);
        const [o] = MeshoptSimplifier.simplify(ia, pa, 3, target, err, ['Prune']);
        if (!o.length) { p.dispose(); continue; }
        p.setIndices(t.createAccessor().setType('SCALAR').setArray(pos.getCount() > 65535 ? o : new Uint16Array(o)).setBuffer(pos.getBuffer()));
        got += o.length / 3;
      }
      if (t !== d) { d.__best = t; }
      log(`  ${L.name}: error ${err.toFixed(4)} -> ${Math.round(got)} tris`);
      if (got <= L.tris * 1.1 || it === 4) { if (t !== d) { lodDoc = t; } break; }
    }
  }
  if (lodDoc) d = lodDoc;
  await d.transform(
    F.prune(),
    F.textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [L.tex, L.tex], quality: L.name === 'high' ? 90 : 82 }),
    F.prune(),
    F.meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  const file = path.join(OUT, `${L.name}.glb`);
  await io.write(file, d);
  lodInfo[L.name] = { tris: await countTris(d), bytes: fs.statSync(file).size };
  log(`${L.name}: ${lodInfo[L.name].tris} tris, ${(lodInfo[L.name].bytes / 1e6).toFixed(1)} MB`);
}

const manifest = {
  id: carId, version: 1,
  L: r3(ext[2]), W: r3(ext[0]), H: r3(ext[1]),
  wheels: wheelInfo && !keepWheels ? wheelInfo.wheels.map(w => ({ x: r3(w.x), y: r3(w.y), z: r3(w.z), r: r3(w.r), tw: r3(w.tw), front: w.front })) : null,
  wheelsKept: !wheelInfo || keepWheels,
  paint, tail,
  profile: { top: prof.top.map(r3), bottom: prof.bottom.map(r3), half: prof.half.map(r3) },
  lods: lodInfo, srcTris, flip, frontVote: fv.vote,
};
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest));
log('done');
