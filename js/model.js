// Procedural 3D car models: body shell from side profile (with wheel-arch cutouts + fender bulges),
// greenhouse, lights, wheels generated from the selected rim style, brakes, and visible aero/body parts.
import * as THREE from '../vendor/three.module.js';
import { mergeVertices } from '../vendor/BufferGeometryUtils.js';
import { buildWheel } from './wheels.js';
import { instantiateCar } from './carassets.js';
import { scrubWheels, fixPlates, findOemSpoiler, withoutTris, analyzeShell, deformWidebody, applyCarbonPanels, addRealParts, addInterior, applyFinish } from './bodymods.js';

const BODY = {
  coupe:    { nose: .36, hood: .56, belt: .60, deck: .64, tail: .60, cowl: .33, roofF: .47, roofR: .68, rearW: .86, roof: 1, gc: .13 },
  sedan:    { nose: .40, hood: .58, belt: .62, deck: .66, tail: .64, cowl: .30, roofF: .42, roofR: .70, rearW: .82, roof: 1, gc: .14 },
  hatch:    { nose: .40, hood: .58, belt: .62, deck: .70, tail: .66, cowl: .28, roofF: .40, roofR: .90, rearW: .985, roof: 1, gc: .14 },
  roadster: { nose: .38, hood: .58, belt: .64, deck: .66, tail: .62, cowl: .42, roofF: .53, roofR: .62, rearW: .70, roof: .93, gc: .12, open: true },
  supercar: { nose: .30, hood: .46, belt: .60, deck: .68, tail: .64, cowl: .25, roofF: .40, roofR: .60, rearW: .88, roof: 1, gc: .10 },
  muscle:   { nose: .50, hood: .60, belt: .62, deck: .64, tail: .62, cowl: .40, roofF: .50, roofR: .68, rearW: .80, roof: 1, gc: .14 },
  truck:    { nose: .54, hood: .58, belt: .60, deck: .60, tail: .58, cowl: .27, roofF: .33, roofR: .56, rearW: .57, roof: 1, gc: .30, bed: true },
};

const sm = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
const lerp = (a, b, t) => a + (b - a) * t;

const MAT = {};
function mats(paint) {
  if (!MAT.glass) {
    MAT.glass = new THREE.MeshStandardMaterial({ color: 0x0a1016, metalness: 0.1, roughness: 0.12, envMapIntensity: 0.55 });
    MAT.black = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.75, metalness: 0.1 });
    MAT.trim = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.4, metalness: 0.4 });
    MAT.carbon = new THREE.MeshPhysicalMaterial({ color: 0x1b1d20, roughness: 0.35, metalness: 0.5, clearcoat: 1, clearcoatRoughness: 0.1 });
    MAT.rubber = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92, metalness: 0 });
    MAT.disc = new THREE.MeshStandardMaterial({ color: 0x8a8d91, roughness: 0.45, metalness: 0.85 });
    MAT.chrome = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.12, metalness: 1 });
    MAT.well = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1, side: THREE.DoubleSide });
    MAT.seat = new THREE.MeshStandardMaterial({ color: 0x222226, roughness: 0.8 });
  }
  const p = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(paint), metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06 });
  const head = new THREE.MeshStandardMaterial({ color: 0xeef4ff, emissive: 0xdde8ff, emissiveIntensity: 0.6, roughness: 0.1, metalness: 0.3 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1010, emissiveIntensity: 0.35, roughness: 0.3 });
  return { ...MAT, paint: p, head, tail };
}

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  return m;
}

// Build a shape in (forward z, height y) and extrude laterally; returns geometry in world orientation (x lateral, y up, z forward).
function extrudeSide(pts, width, bevel = 0.05) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const depth = Math.max(0.02, width - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: 4, curveSegments: 6 });
  g.translate(0, 0, -depth / 2);
  g.rotateY(-Math.PI / 2);
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  const m = mergeVertices(g, 1e-4);
  m.computeVertexNormals();
  return m;
}

// opts: { paint, asset (loaded real model entry from carassets.js), quality }
export function createCarModel(spec, opts = {}) {
  const quality = opts.quality || { clearcoat: true, wheelSeg: 48 };
  if (opts.asset) return createRealCar(spec, opts.asset, opts, quality);
  return createProceduralCar(spec, opts, quality);
}

function createProceduralCar(spec, opts, quality) {
  const car = spec.car;
  const B = BODY[car.body] || BODY.coupe;
  const M = mats(opts.paint || spec.sel?.color || car.color);
  if (spec.sel?.finish) applyFinish(M.paint, spec.sel.finish, quality);
  const L = car.L, W = car.W, H = car.H;
  const R = spec.tire.R;
  const wheelR = spec.wheel.dia * 0.0254 / 2;
  const tireW = spec.tire.width / 1000;
  const wide = spec.parts.some(p => p.model === 'widebody');
  const drop = spec.rideDrop || 0;
  const gc = Math.max(0.05, B.gc - drop / 1000 * 0.9);
  const Hs = H - drop / 1000 * 0.9;
  const fo = (L - car.wb) * 0.47;
  const zF = spec.a, zR = -spec.b;
  const zN = zF + fo, zT = zN - L;
  const zAt = u => zN - u * L;
  const rA = R + 0.035;
  const archTop = R + rA + 0.05;

  const root = new THREE.Group();     // positioned at CG ground point
  const body = new THREE.Group();     // pitches / rolls
  root.add(body);

  // ---------- lower body ----------
  const topH = u => {
    let h;
    if (u < 0.04) h = lerp(B.nose * 0.78, B.nose, Math.sin(u / 0.04 * Math.PI / 2));
    else if (u < B.cowl) h = lerp(B.nose, B.hood, sm((u - 0.03) / (B.cowl - 0.03)) * 0.7 + (u - 0.03) / (B.cowl - 0.03) * 0.3);
    else if (u < B.rearW) h = lerp(B.hood, B.belt, sm((u - B.cowl) / 0.08));
    else if (u < 0.97) h = lerp(B.belt, B.deck, sm((u - B.rearW) / 0.06));
    else h = lerp(B.deck, B.tail, (u - 0.97) / 0.03);
    h *= Hs;
    // fender bulges over each wheel
    for (const za of [zF, zR]) {
      const d = Math.abs(zAt(u) - za) / (rA * 1.35);
      if (d < 1) h = Math.max(h, lerp(archTop + 0.03, h, sm(d)));
    }
    return h;
  };
  const top = [];
  const NS = 70;
  for (let i = 0; i <= NS; i++) { const u = i / NS; top.push([zAt(u), topH(u)]); }
  const bottom = [];
  bottom.push([zT + 0.02, gc + 0.12]);
  bottom.push([zT + 0.12, gc]);
  for (const za of [zR, zF]) {
    bottom.push([za - rA - 0.02, gc]);
    bottom.push([za - rA, R * 0.85]);
    for (let k = 0; k <= 14; k++) { const th = Math.PI - k / 14 * Math.PI; bottom.push([za + rA * Math.cos(th), R * 0.85 + (rA + 0.0) * Math.sin(th) * ((archTop - R * 0.85) / rA)]); }
    bottom.push([za + rA, R * 0.85]);
    bottom.push([za + rA + 0.02, gc]);
  }
  bottom.push([zN - 0.18, gc]);
  bottom.push([zN - 0.06, gc + 0.04]);
  bottom.push([zN + 0.01, gc + 0.12]);
  const lowerPts = [...top, ...bottom];
  const lowerG = extrudeSide(lowerPts, W, 0.06);
  // plan taper + rounded sides
  const pos = lowerG.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const u = (zN - z) / L;
    let f = 1 - 0.17 * (1 - sm(u / 0.15)) - 0.08 * (1 - sm((1 - u) / 0.12));
    const mid = Hs * 0.42;
    f *= 1 - 0.06 * Math.pow((y - mid) / (Hs * 0.5), 2);
    if (wide) { for (const za of [zF, zR]) { const d = Math.abs(z - za) / (rA * 1.6); if (d < 1 && y < archTop + 0.05) f *= 1 + 0.05 * (1 - sm(d)); } }
    pos.setX(i, x * f);
  }
  lowerG.computeVertexNormals();
  const lower = new THREE.Mesh(lowerG, M.paint);
  lower.castShadow = true; lower.receiveShadow = true;
  body.add(lower);

  // ---------- greenhouse ----------
  const beltH = B.belt * Hs, roofH = B.roof * Hs, deckH = B.deck * Hs;
  const zc = zAt(B.cowl), zrf = zAt(B.roofF), zrr = zAt(B.roofR), zrw = zAt(B.rearW);
  let ghPts;
  if (B.open) ghPts = [[zc + 0.05, beltH - 0.03], [zrf, roofH], [zrf - 0.08, roofH], [zc - 0.06, beltH - 0.03]];
  else ghPts = [[zc, beltH - 0.04], [zc - 0.06, beltH + 0.02], [zrf, roofH - 0.01], [lerp(zrf, zrr, 0.5), roofH + 0.015], [zrr, roofH - 0.01], [zrw, deckH - 0.02]];
  const ghW = W * (B.open ? 0.86 : 0.80);
  const ghG = extrudeSide(ghPts, ghW, B.open ? 0.01 : 0.04);
  const gp = ghG.attributes.position;
  for (let i = 0; i < gp.count; i++) {
    const y = gp.getY(i), t = Math.max(0, Math.min(1, (y - beltH) / (roofH - beltH)));
    gp.setX(i, gp.getX(i) * (1 - (B.open ? 0.05 : 0.24) * t));
  }
  ghG.computeVertexNormals();
  const gh = new THREE.Mesh(ghG, M.glass);
  gh.castShadow = true;
  body.add(gh);
  if (!B.open) {
    // painted roof panel + pillars
    const rp = [[zrf - 0.12, roofH - 0.005], [zrf - 0.1, roofH + 0.03], [zrr + 0.05, roofH + 0.025], [zrr + 0.02, roofH - 0.01]];
    const roofG = extrudeSide(rp, ghW * 0.78, 0.02);
    const roof = new THREE.Mesh(roofG, spec.parts.some(p => p.id === 'cfroof') ? M.carbon : M.paint);
    roof.castShadow = true; body.add(roof);
    // A and C pillars as thin painted strips
    for (const s of [-1, 1]) {
      const pa = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, Math.hypot(zc - zrf, roofH - beltH) + 0.04), M.paint);
      const xa = s * ghW * 0.5 * 0.88;
      pa.position.set(xa, (beltH + roofH) / 2, (zc + zrf) / 2 - 0.03);
      pa.rotation.x = -Math.atan2(roofH - beltH, zc - zrf) * -1;
      pa.rotation.x = Math.atan2(roofH - beltH, zc - zrf);
      body.add(pa);
    }
  } else {
    // cockpit opening, seats and roll hoops
    const ck = box(W * 0.66, 0.02, Math.abs(zrf - zrw) * 0.95, M.black, 0, beltH + 0.012, (zrf + zrw) / 2 - 0.04);
    body.add(ck);
    for (const s of [-1, 1]) {
      body.add(box(0.42, 0.5, 0.12, M.seat, s * W * 0.2, beltH + 0.1, zrr + 0.05));
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.025, 6, 14, Math.PI), M.trim);
      hoop.position.set(s * W * 0.2, beltH + 0.2, zrr - 0.06);
      body.add(hoop);
    }
  }
  if (B.bed) {
    body.add(box(W * 0.84, 0.03, Math.abs(zrr - zT) * 0.86, M.black, 0, deckH + 0.02, (zrr + zT) / 2 - 0.05));
  }

  // ---------- details ----------
  const noseH = B.nose * Hs;
  for (const s of [-1, 1]) {
    const hl = box(W * 0.2, 0.05, 0.2, M.head, s * W * 0.32, noseH * 0.9 - 0.01, zN - 0.04);
    hl.rotation.x = 0.35; body.add(hl);
    body.add(box(W * 0.26, 0.08, 0.05, M.tail, s * W * 0.31, B.tail * Hs - 0.08, zT - 0.06));
    const mir = box(0.1, 0.07, 0.12, M.paint, s * (W * 0.47), beltH + 0.07, zc - 0.12);
    body.add(mir);
  }
  body.add(box(W * 0.5, 0.13, 0.05, M.black, 0, gc + 0.16, zN - 0.02));
  body.add(box(W * 0.78, 0.07, 0.05, M.trim, 0, gc + 0.08, zT - 0.05));
  // exhaust
  if (spec.engine.cfg !== 'EV') {
    const dual = spec.engine.cyl >= 6;
    const tipsX = dual ? [-W * 0.32, W * 0.32] : (spec.car.body === 'hatch' ? [0] : [W * 0.28]);
    for (const x of tipsX) for (const dx of (spec.engine.cyl >= 8 ? [-0.06, 0.06] : [0])) {
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.18, 14, 1, true), M.chrome);
      tip.rotation.x = Math.PI / 2; tip.position.set(x + dx, gc + 0.07, zT - 0.03);
      body.add(tip);
    }
  }
  // wheel wells
  for (const za of [zF, zR]) {
    const well = new THREE.Mesh(new THREE.CylinderGeometry(rA, rA, W * 0.92, 20, 1, true, 0, Math.PI), MAT.well);
    well.rotation.z = Math.PI / 2; well.rotation.x = 0; well.position.set(0, R * 0.85, za);
    well.rotation.set(0, 0, Math.PI / 2);
    well.rotateY(Math.PI / 2);
    well.scale.set(1, 1, (archTop - R * 0.85) / rA);
    body.add(well);
  }
  body.add(box(W * 0.8, 0.06, (zF - zR) * 0.75, M.black, 0, gc + 0.03, (zF + zR) / 2));
  for (const s of [-1, 1]) body.add(box(0.03, 0.07, (zF - zR) - 2 * rA - 0.1, M.trim, s * (W / 2 - 0.035), gc + 0.05, (zF + zR) / 2));

  const ctx = { spec, car, B, M, root, body, W, zN, zT, zF, zR, R, rA, archTop, gc, topH, zAt, roofH, zrr, wide, trackHalf: spec.track / 2, wheelX: null, quality };
  addParts(ctx);
  body.traverse(o => { if (o.isMesh) o.userData.own = true; });
  const wheels = addWheels(ctx);
  const setBrake = on => { M.tail.emissiveIntensity = on ? 2.2 : 0.35; };
  return { root, body, wheels, setBrake, dims: { L, W, H: Hs, zN, zT }, materials: M };
}

function addParts(ctx) {
  const { spec, car, B, M, body, W, zN, zT, zF, zR, R, rA, archTop, gc, topH, zAt, roofH, zrr, wide } = ctx;
  const zc = zAt(B.cowl);
  const has = id => spec.parts.some(p => p.id === id || p.model === id);
  if (has('cfhood')) {
    const hz0 = zN - 0.1, hz1 = zc + 0.05;
    const hood = box(W * 0.7, 0.01, Math.abs(hz0 - hz1), M.carbon, 0, (topH(0.06) + topH(B.cowl - 0.02)) / 2 + 0.035, (hz0 + hz1) / 2);
    hood.rotation.x = Math.atan2(topH(B.cowl - 0.02) - topH(0.06), Math.abs(hz0 - hz1));
    body.add(hood);
  }
  if (has('louvres')) for (let i = 0; i < 6; i++) {
    const u = B.cowl * (0.45 + i * 0.07);
    for (const s of [-1, 1]) body.add(box(0.22, 0.012, 0.03, M.black, s * W * 0.18, topH(u) + 0.04, zAt(u)));
  }
  const front = spec.parts.find(p => p.cat === 'aero_front');
  if (front) {
    if (front.model === 'lip') body.add(box(W * 0.88, 0.02, 0.1, M.carbon, 0, gc + 0.01, zN - 0.04));
    else {
      body.add(box(W * 0.96, 0.016, 0.28, M.carbon, 0, gc - 0.005, zN + 0.02));
      for (const s of [-1, 1]) { const rod = box(0.012, 0.012, 0.3, M.chrome, s * W * 0.3, gc + 0.12, zN + 0.02); rod.rotation.x = 0.6; body.add(rod); }
      if (front.model === 'canards') for (const s of [-1, 1]) for (const dy of [0, 0.09]) {
        const c = box(0.2, 0.012, 0.12, M.carbon, s * W * 0.46, gc + 0.12 + dy, zN - 0.14);
        c.rotation.z = s * 0.25; c.rotation.y = s * 0.4; body.add(c);
      }
    }
  }
  if (has('diffuser')) {
    body.add(box(W * 0.75, 0.015, 0.4, M.carbon, 0, gc + 0.02, zT + 0.22));
    for (let i = -3; i <= 3; i++) body.add(box(0.012, 0.14, 0.4, M.carbon, i * W * 0.1, gc + 0.08, zT + 0.22));
  }
  if (wide) for (const za of [zF, zR]) for (const s of [-1, 1]) {
    const fl = new THREE.Mesh(new THREE.TorusGeometry(rA + 0.03, 0.045, 6, 18, Math.PI), M.paint);
    fl.rotation.y = Math.PI / 2; fl.position.set(s * ((ctx.halfAt ? ctx.halfAt(za) : W / 2) + 0.03), R * 0.85, za);
    fl.scale.set(1, (archTop - R * 0.85 + 0.03) / (rA + 0.03), 1);
    fl.castShadow = true; body.add(fl);
  }
  const wing = spec.parts.find(p => p.cat === 'aero_rear');
  const wingAngle = (spec.sel?.tuning?.wingAngle ?? 0.5);
  if (wing) {
    const uMount = B.bed ? 0.95 : (car.body === 'hatch' ? B.rearW - 0.03 : 0.94);
    const baseY = car.body === 'hatch' ? roofH : topH(uMount);
    const zW = car.body === 'hatch' ? zrr - 0.08 : zAt(uMount) + 0.02;
    if (wing.model === 'ducktail') {
      const d = box(W * 0.75, 0.05, 0.16, M.paint, 0, baseY + 0.02, zT + 0.12); d.rotation.x = -0.35; body.add(d);
    } else {
      const hgt = { lowwing: 0.07, wing: 0.2, swan: 0.3, bigwing: 0.42 }[wing.model] || 0.2;
      const span = { lowwing: 0.8, wing: 0.92, swan: 0.95, bigwing: 1.0 }[wing.model] * W;
      const chord = { lowwing: 0.16, wing: 0.26, swan: 0.3, bigwing: 0.36 }[wing.model];
      const af = new THREE.Shape();
      af.moveTo(0, 0); af.bezierCurveTo(chord * 0.2, 0.05 * chord / 0.26, chord * 0.7, 0.05 * chord / 0.26, chord, 0.01); af.lineTo(chord, -0.005); af.bezierCurveTo(chord * 0.6, 0.01, chord * 0.2, -0.01, 0, 0);
      const ag = new THREE.ExtrudeGeometry(af, { depth: span, bevelEnabled: false, curveSegments: 10 });
      ag.translate(-chord / 2, 0, -span / 2); ag.rotateY(Math.PI / 2);
      const el = new THREE.Mesh(ag, wing.model === 'lowwing' ? M.paint : M.carbon);
      el.position.set(0, baseY + hgt, zW);
      el.rotation.x = -(0.05 + wingAngle * 0.25);
      el.castShadow = true; body.add(el);
      if (wing.model !== 'lowwing') {
        for (const s of [-1, 1]) {
          body.add(box(0.01, chord * 0.55, chord * 1.05, M.carbon, s * span / 2, baseY + hgt - 0.01, zW));
          const up = box(0.012, hgt, 0.1, M.trim, s * span * 0.3, baseY + hgt / 2 + (wing.model === 'swan' ? 0.03 : 0), zW + (wing.model === 'swan' ? 0.03 : 0));
          body.add(up);
        }
      }
    }
  }

}

function addWheels(ctx) {
  const { spec, root, zF, zR } = ctx;
  const wheels = [];
  for (const [xs, za, front] of [[1, zF, true], [-1, zF, true], [1, zR, false], [-1, zR, false]]) {
    const w = buildWheel(spec, xs, front, ctx.quality);
    const x = ctx.wheelX ? ctx.wheelX(xs, front) : xs * (ctx.trackHalf - spec.tire.width / 1000 * 0.15);
    w.pivot.position.set(x, spec.tire.R, za);
    root.add(w.pivot);
    wheels.push({ pivot: w.pivot, spin: w.spin, front });
  }
  return wheels;
}

// ---------- real (downloaded) car model ----------
function createRealCar(spec, asset, opts, quality) {
  const car = spec.car, B = BODY[car.body] || BODY.coupe;
  const man = asset.manifest;
  if (asset.scrubbed == null) asset.scrubbed = scrubWheels(asset.scene, man);
  if (asset.plates == null) asset.plates = fixPlates(asset.scene);
  let F = asset.shellF || (asset.shellF = analyzeShell(asset.scene, man));
  // an aftermarket wing / ducktail replaces the factory rear spoiler (it is unbolted on real cars): find it once per
  // model, keep spoiler-free copies of the affected geometry, and re-measure the shell without it so the new wing
  // mounts on the trunk lid, not on top of the old spoiler
  const rearAero = spec.parts.some(p => p.cat === 'aero_rear');
  if (rearAero && asset.noSpoiler === undefined) {
    const found = findOemSpoiler(asset.scene, F, car.body === 'hatch', car.id);
    asset.noSpoiler = null;
    if (found.length) {
      const byMesh = new Map();
      for (const f of found) { if (!byMesh.has(f.mesh)) byMesh.set(f.mesh, new Set()); for (const t of f.tris) byMesh.get(f.mesh).add(t); }
      const list = [], swaps = [];
      asset.scene.traverse(o => { if (o.isMesh) list.push(o); });
      list.forEach((o, i) => { const drop = byMesh.get(o); if (drop) swaps.push([i, withoutTris(o.geometry, drop)]); });
      asset.noSpoiler = new Map(swaps);
      const keep = swaps.map(([i, g]) => { const o = list[i], old = o.geometry; o.geometry = g; return [o, old]; });
      asset.shellFNoSpoiler = analyzeShell(asset.scene, man);
      for (const [o, old] of keep) o.geometry = old;
    }
  }
  if (rearAero && asset.noSpoiler) F = asset.shellFNoSpoiler;
  const inst = instantiateCar(asset, { paint: opts.paint, quality, paintMats: F.paintMats });
  if (rearAero && asset.noSpoiler) { let i = 0; inst.root.traverse(o => { if (o.isMesh) { const g = asset.noSpoiler.get(i); if (g) o.geometry = g; i++; } }); }
  const M = mats(opts.paint || car.color);
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body);
  const L = man.L, H = man.H;
  const ws = man.wheels;
  const R = spec.tire.R;
  // model axle positions -> place so the CG (root origin) splits the model's wheelbase like the real car (a : b)
  const zFm = ws ? (ws[0].z + ws[1].z) / 2 : L * 0.32, zRm = ws ? (ws[2].z + ws[3].z) / 2 : -L * 0.3;
  const wbm = zFm - zRm;
  const zF = spec.a / (spec.a + spec.b) * wbm, zR = zF - wbm, dz = zF - zFm;
  const Rm = ws ? ws.reduce((s, w) => s + w.r, 0) / 4 : R;
  const Ym = ws ? ws.reduce((s, w) => s + (w.y ?? w.r), 0) / 4 : R;   // wheel-centre height in the model
  const drop = (spec.rideDrop || 0) / 1000;
  const lift = (R - Ym) - drop * 0.9;
  const shell = inst.root;
  const wideK = spec.parts.some(p => p.model === 'widebody');
  if (spec.flare && ws) deformWidebody(shell, man, F, spec.flare);   // before positioning: works in shell space
  const panels = [['cfhood', 'hood'], ['cftrunk', 'trunk'], ['cfroof', 'roof'], ['cfdoors', 'doors']].filter(([id]) => spec.parts.some(p => p.id === id)).map(([, n]) => n);
  const sel = spec.sel || {};
  if (sel.finish) for (const m of inst.paintMats) applyFinish(m, sel.finish, quality);
  applyCarbonPanels(inst.paintMats, shell, F, man, panels, { stripes: sel.stripes, stripeColor: sel.stripeColor, fourDoor: car.body === 'sedan', midRear: car.layout !== 'F' });
  shell.position.set(0, lift, dz);
  body.add(shell);
  const prof = man.profile, NB = prof.top.length;
  const sample = (arr, u) => { const f = Math.max(0, Math.min(NB - 1, u * NB - 0.5)), i = Math.floor(f), t = f - i; return arr[i] * (1 - t) + arr[Math.min(NB - 1, i + 1)] * t; };
  const zN = L / 2 + dz, zT = -L / 2 + dz;
  const zAt = u => zN - u * L;
  const topH = u => sample(prof.top, u) + lift;
  const halfAt = z => sample(prof.half, (zN - z) / L);
  const gc = Math.min(sample(prof.bottom, 0.04), sample(prof.bottom, 0.96)) + lift;
  const W = Math.max(...prof.half) * 2;
  const roofH = Math.max(...prof.top) + lift;
  const rA = Rm + 0.035;
  const wide = spec.parts.some(p => p.model === 'widebody');
  const ctx = {
    spec, car, B, M, root, body, W, zN, zT, zF, zR, R, rA, archTop: R + rA + 0.05, gc, topH, zAt, roofH, zrr: zAt(B.roofR), wide, halfAt, quality,
    real: true,
    wheelX: (xs, front) => {
      if (!ws) return xs * (spec.track / 2);
      const w = ws.find(w => Math.sign(w.x) === xs && w.front === front) || ws[0];
      // wider tires push outward a little (offset), widebody adds spacers
      return w.x + xs * ((spec.tire.width / 1000 - w.tw) * 0.35 + (spec.flare || 0));
    },
  };
  // main body paint = the paint material covering the most geometry
  const paintUse = new Map();
  shell.traverse(o => { if (o.isMesh) for (const m of [].concat(o.material)) if (inst.paintMats.includes(m)) paintUse.set(m, (paintUse.get(m) || 0) + o.geometry.attributes.position.count); });
  const mainPaint = inst.mainPaint || [...paintUse.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  // some models colour the body with vertex colours: average them so added panels match
  let tint = null;
  if (mainPaint?.vertexColors) {
    let r = 0, g = 0, b = 0, n = 0;
    shell.traverse(o => { const c = o.isMesh && [].concat(o.material).includes(mainPaint) && o.geometry.attributes.color; if (!c) return; for (let i = 0; i < c.count; i += 7) { r += c.getX(i); g += c.getY(i); b += c.getZ(i); n++; } });
    if (n) tint = new THREE.Color(r / n, g / n, b / n);
  }
  addRealParts({ spec, body, F, man, shell, lift, dz, paint: mainPaint || M.paint, paintTint: tint, wingAngle: spec.sel?.tuning?.wingAngle ?? 0.5, wide });
  const interior = addInterior({ spec, body, F, shell, lift, dz, paint: mainPaint || M.paint, paintTint: tint });
  body.traverse(o => { if (o.isMesh && !isUnder(o, shell)) o.userData.own = true; });
  const wheels = addWheels(ctx);
  // with the original wheels removed we can see straight through the arches: dark wheel-well liners
  if (ws) for (const w of ws) {
    const liner = new THREE.Mesh(wellGeo(w.r + 0.03, 0.26), MAT.well);
    liner.position.set(w.x - Math.sign(w.x) * 0.16, (w.y ?? w.r) + lift, w.z + dz);
    body.add(liner);
  }
  const tails = inst.tailMats;
  const setBrake = on => {
    for (const m of tails) m.emissiveIntensity = on ? 2.5 : 0.15;
    if (!tails.length) M.tail.emissiveIntensity = on ? 2.2 : 0.35;
  };
  // camera mount points in body space (driver's eye on the left seat, hood, bumper)
  const eyes = {
    cockpit: new THREE.Vector3(W * 0.2, F.roofY + lift - 0.3, F.roofF + dz - 0.5),
    hood: (() => { const z = F.cowl + (L / 2 - F.cowl) * 0.45; return new THREE.Vector3(0, Math.max(F.topAt(0, z), 0.55) + lift + 0.1, z + dz); })(),
    bumper: new THREE.Vector3(0, Math.max(0.35, F.lowFront + 0.25) + lift, L / 2 + dz + 0.05),
  };
  return { root, body, wheels, setBrake, dims: { L, W: man.W, H: H + lift, zN, zT }, materials: M, paintMats: inst.paintMats, real: true, eyes, F, lift, dz, shell };
}

const isUnder = (o, anc) => { for (let p = o; p; p = p.parent) if (p === anc) return true; return false; };
const wellCache = new Map();
function wellGeo(r, w) {
  const k = r.toFixed(3) + w;
  if (!wellCache.has(k)) {
    // arch only: over the top of the tire, ending just below hub height at the front and back (after rotateZ, y = r·sinθ)
    const g = new THREE.CylinderGeometry(r, r, w, 24, 1, true, -Math.PI * 0.06, Math.PI * 1.12);
    g.rotateZ(Math.PI / 2);
    wellCache.set(k, g);
  }
  return wellCache.get(k);
}

export function disposeModel(obj) {
  // geometry is shared/cached (wheels, real models); only dispose per-instance procedural body meshes
  obj.traverse(o => { if (o.geometry && o.userData.own) o.geometry.dispose(); });
}
