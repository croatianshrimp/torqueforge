// Procedural wheel assembly: tire (lathe profile + tread/sidewall normal maps), rim (extruded face with style-specific
// windows, dished), barrel, lug nuts, centre cap, vented/drilled brake disc and caliper.
// Geometries + materials are cached per configuration so 4 wheels (and rivals) share GPU buffers.
import * as THREE from '../vendor/three.module.js';
import { mergeGeometries, mergeVertices } from '../vendor/BufferGeometryUtils.js';

const geoCache = new Map(), texCache = new Map(), matCache = new Map();
const cached = (map, key, fn) => { if (!map.has(key)) map.set(key, fn()); return map.get(key); };

function heightToNormal(h, w, hgt, strength, wrapX = true) {
  // h: Float32Array height 0..1 -> RGBA normal map canvas
  const cv = document.createElement('canvas'); cv.width = w; cv.height = hgt;
  const g = cv.getContext('2d'), img = g.createImageData(w, hgt), d = img.data;
  const H = (x, y) => h[((y + hgt) % hgt) * w + (wrapX ? (x + w) % w : Math.max(0, Math.min(w - 1, x)))];
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * strength, dy = (H(x, y + 1) - H(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1), i = (y * w + x) * 4;
    d[i] = (-dx / l * 0.5 + 0.5) * 255; d[i + 1] = (dy / l * 0.5 + 0.5) * 255; d[i + 2] = (1 / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 8;
  return t;
}

// Tire texture: v runs across the profile (0 = inner bead, 0.5 = tread centre, 1 = outer bead), u around the wheel.
function tireTextures(compound, sizeText) {
  return cached(texCache, 'tire:' + compound + sizeText, () => {
    const W = 1024, Hh = 256, h = new Float32Array(W * Hh);
    const slick = /slick|semi|r-comp|track/i.test(compound);
    const grooves = slick ? [] : [0.39, 0.46, 0.54, 0.61];
    for (let y = 0; y < Hh; y++) {
      const v = y / (Hh - 1);
      for (let x = 0; x < W; x++) {
        let val = 0.5;
        if (v > 0.3 && v < 0.7) {
          val = 0.8;
          for (const gv of grooves) if (Math.abs(v - gv) < 0.012) val = 0.15;
          if (!slick) { // lateral sipes on the shoulders
            const u = x / W * 96;
            if ((v < 0.37 || v > 0.63) && Math.abs((u % 1) - 0.5) < 0.07) val = 0.35;
            if (v > 0.47 && v < 0.53 && Math.abs(((u * 0.5 + v * 3) % 1) - 0.5) < 0.04) val = 0.5;
          }
        } else if (v > 0.12 && v < 0.24 || v > 0.76 && v < 0.88) {
          val = 0.5 + 0.04 * Math.sin(x / W * Math.PI * 2 * 40); // sidewall ribbing
        }
        h[y * W + x] = val;
      }
    }
    const normal = heightToNormal(h, W, Hh, 6);
    // sidewall lettering (colour map): raised, slightly lighter rubber
    const cv = document.createElement('canvas'); cv.width = 2048; cv.height = 256;
    const g = cv.getContext('2d'); g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, 2048, 256);
    g.fillStyle = '#262626'; g.font = 'bold 22px system-ui, sans-serif'; g.textBaseline = 'middle';
    for (const vy of [0.19, 0.81]) for (let k = 0; k < 2; k++) {
      g.save(); g.translate(k * 1024 + 120, vy * 256); if (vy > 0.5) g.scale(1, -1);
      g.fillText(`${compound.toUpperCase()}   ${sizeText}`, 0, 0); g.restore();
    }
    const map = new THREE.CanvasTexture(cv); map.colorSpace = THREE.SRGBColorSpace; map.wrapS = THREE.RepeatWrapping; map.anisotropy = 8;
    return { normal, map };
  });
}

function discTexture(drilled) {
  return cached(texCache, 'disc:' + drilled, () => {
    const N = 512, cv = document.createElement('canvas'); cv.width = cv.height = N;
    const g = cv.getContext('2d');
    g.fillStyle = '#8d9094'; g.fillRect(0, 0, N, N);
    // machining rings
    for (let r = 120; r < 256; r += 2) { g.strokeStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${0.04 + Math.random() * 0.05})`; g.beginPath(); g.arc(256, 256, r, 0, 7); g.stroke(); }
    // heat tint near the hat
    const grd = g.createRadialGradient(256, 256, 120, 256, 256, 256); grd.addColorStop(0, 'rgba(70,60,90,.35)'); grd.addColorStop(0.5, 'rgba(0,0,0,0)'); g.fillStyle = grd; g.fillRect(0, 0, N, N);
    if (drilled) {
      g.fillStyle = '#151515';
      for (let k = 0; k < 36; k++) for (const rr of [150, 185, 220]) {
        const a = k / 36 * Math.PI * 2 + rr * 0.01; g.beginPath(); g.arc(256 + Math.cos(a) * rr, 256 + Math.sin(a) * rr, 5, 0, 7); g.fill();
      }
      g.strokeStyle = '#3a3a3a'; g.lineWidth = 3;
      for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2; g.beginPath(); g.arc(256, 256, 200, a, a + 0.25); g.stroke(); }
    }
    // hat
    g.fillStyle = '#5c5f63'; g.beginPath(); g.arc(256, 256, 118, 0, 7); g.fill();
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  });
}

function tireGeometry(R, rimR, width, seg) {
  return cached(geoCache, `tire:${R.toFixed(3)}:${rimR.toFixed(3)}:${width.toFixed(3)}:${seg}`, () => {
    const hw = width / 2, side = R - rimR;
    // profile in (radius, axial) from inner bead -> tread -> outer bead
    const pts = [];
    const bulge = Math.min(0.018, side * 0.12);
    const shoulder = Math.min(0.03, side * 0.35);
    const N = 14;
    for (let i = 0; i <= N; i++) { // inner sidewall: bead -> shoulder
      const t = i / N, r = rimR + 0.004 + t * (side - shoulder - 0.004);
      pts.push([r, -hw * 0.94 - Math.sin(t * Math.PI) * bulge * (0.6 + 0.4 * t)]);
    }
    for (let i = 1; i <= 8; i++) { const a = (i / 8) * Math.PI / 2; pts.push([R - shoulder + Math.sin(a) * shoulder, -hw + shoulder * (1 - Math.cos(a)) - (1 - Math.sin(a)) * bulge * 0.3]); }
    for (let i = 1; i < 10; i++) { const t = i / 10, x = -hw + shoulder + t * (2 * hw - 2 * shoulder); pts.push([R + 0.002 * Math.cos((x / hw) * Math.PI / 2), x]); }
    const half = pts.length;
    for (let i = half - 10; i >= 0; i--) pts.push([pts[i][0], -pts[i][1]]);
    const prof = pts.map(([r, x]) => new THREE.Vector2(r, x));
    const g = new THREE.LatheGeometry(prof, seg);
    // lathe: profile x = radius, y = axial; uv.x around, uv.y along profile -> swap so texture u = around
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) { const u = uv.getX(i), v = uv.getY(i); uv.setXY(i, u * 2, v); }
    g.rotateZ(Math.PI / 2); // axle along X
    g.computeVertexNormals();
    return g;
  });
}

function windowShape(rIn, rOut, a0, a1, round) {
  const s = new THREE.Path();
  const steps = 10;
  s.moveTo(Math.cos(a0) * rIn, Math.sin(a0) * rIn);
  for (let i = 0; i <= steps; i++) { const a = a0 + (a1 - a0) * i / steps; s.lineTo(Math.cos(a) * rIn, Math.sin(a) * rIn); }
  const rr = Math.min(round, (a1 - a0) * rOut * 0.4);
  for (let i = 0; i <= steps; i++) {
    const a = a1 - (a1 - a0) * i / steps;
    const k = Math.min(1, Math.min(i, steps - i) / 2);
    const r = rOut - rr * (1 - k);
    s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  return s;
}

// window whose outer edge is rotated by `sweep` relative to the inner edge (curved / directional spokes)
function sweptWindow(rIn, rOut, a0, a1, sweep) {
  const s = new THREE.Path(), steps = 10, mid = 6;
  s.moveTo(Math.cos(a0) * rIn, Math.sin(a0) * rIn);
  for (let i = 0; i <= steps; i++) { const a = a0 + (a1 - a0) * i / steps; s.lineTo(Math.cos(a) * rIn, Math.sin(a) * rIn); }
  for (let i = 1; i <= mid; i++) { const t = i / mid, r = rIn + (rOut - rIn) * t, a = a1 + sweep * t * t; s.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  for (let i = 0; i <= steps; i++) { const a = a1 + sweep - (a1 - a0) * i / steps; s.lineTo(Math.cos(a) * rOut, Math.sin(a) * rOut); }
  for (let i = mid - 1; i >= 1; i--) { const t = i / mid, r = rIn + (rOut - rIn) * t, a = a0 + sweep * t * t; s.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  s.closePath();
  return s;
}

// window bounded by two straight edges whose angular half-width changes from hub (hIn) to rim (hOut): tapered spokes
function taperWindow(rIn, rOut, c, hIn, hOut) {
  const s = new THREE.Path(), steps = 8;
  const pt = (r, a) => [Math.cos(a) * r, Math.sin(a) * r];
  s.moveTo(...pt(rIn, c - hIn));
  for (let i = 1; i <= steps; i++) s.lineTo(...pt(rIn, c - hIn + 2 * hIn * i / steps));
  for (let i = 1; i <= steps; i++) { const t = i / steps; s.lineTo(...pt(rIn + (rOut - rIn) * t, c + hIn + (hOut - hIn) * t)); }
  for (let i = 1; i <= steps * 2; i++) s.lineTo(...pt(rOut, c + hOut - 2 * hOut * i / (steps * 2)));
  for (let i = 1; i < steps; i++) { const t = 1 - i / steps; s.lineTo(...pt(rIn + (rOut - rIn) * t, c - hIn - (hOut - hIn) * t)); }
  s.closePath();
  return s;
}
const diamond = (r, a, dr, da) => { const s = new THREE.Path(), pt = (rr, aa) => [Math.cos(aa) * rr, Math.sin(aa) * rr];
  s.moveTo(...pt(r - dr, a)); s.lineTo(...pt(r, a - da)); s.lineTo(...pt(r + dr, a)); s.lineTo(...pt(r, a + da)); s.closePath(); return s; };

function rimFaceGeometry(wheelR, style, spokes, seg) {
  return cached(geoCache, `rim:${wheelR.toFixed(3)}:${style}:${spokes}:${seg}`, () => {
    const rFace = wheelR * 0.93;
    const face = new THREE.Shape();
    face.absarc(0, 0, rFace, 0, Math.PI * 2, false);
    const n = spokes || 5;
    const holes = [];
    const circleHole = (cx, cy, r) => { const p = new THREE.Path(); p.absarc(cx, cy, r, 0, Math.PI * 2, true); return p; };
    if (style === 'steel') {
      for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; holes.push(circleHole(Math.cos(a) * rFace * 0.62, Math.sin(a) * rFace * 0.62, rFace * 0.1)); }
    } else if (style === 'dish') {
      const span = Math.PI * 2 / n;
      for (let k = 0; k < n; k++) holes.push(windowShape(rFace * 0.46, rFace * 0.8, k * span + span * 0.22, (k + 1) * span - span * 0.22, rFace * 0.08));
    } else if (style === 'twin') {
      const span = Math.PI * 2 / n, sw = 0.075;
      for (let k = 0; k < n; k++) {
        const a = k * span;
        holes.push(windowShape(rFace * 0.32, rFace * 0.9, a + sw * 2.2, a + span - sw * 2.2, rFace * 0.08));   // big window between pairs
        holes.push(windowShape(rFace * 0.42, rFace * 0.86, a - sw * 0.55, a + sw * 0.55, rFace * 0.02));       // slot between the twins
      }
    } else if (style === 'mesh') {
      const m = n * 2, span = Math.PI * 2 / m;
      for (let k = 0; k < m; k++) {
        const a = k * span;
        holes.push(windowShape(rFace * 0.34, rFace * 0.6, a + span * 0.14, a + span * 0.86, rFace * 0.03));
        holes.push(windowShape(rFace * 0.64, rFace * 0.9, a + span * 0.64, a + span * 1.36, rFace * 0.03));
      }
    } else if (style === 'multi') {        // many thin straight spokes (CE28 / FI-R / Ultraleggera)
      const span = Math.PI * 2 / n, sw = span * 0.3;
      for (let k = 0; k < n; k++) holes.push(windowShape(rFace * 0.3, rFace * 0.9, k * span + sw / 2, (k + 1) * span - sw / 2, rFace * 0.03));
    } else if (style === 'y') {            // spokes that fork into a Y near the rim
      const span = Math.PI * 2 / n, sw = span * 0.36;
      for (let k = 0; k < n; k++) {
        const a = k * span;
        holes.push(windowShape(rFace * 0.3, rFace * 0.9, a + sw / 2, a + span - sw / 2, rFace * 0.06));
        holes.push(windowShape(rFace * 0.6, rFace * 0.9, a - sw * 0.2, a + sw * 0.2, rFace * 0.02));
      }
    } else if (style === 'directional') {  // curved, swept spokes (RS05RR style)
      const span = Math.PI * 2 / n, sw = span * 0.32;
      for (let k = 0; k < n; k++) holes.push(sweptWindow(rFace * 0.3, rFace * 0.9, k * span + sw / 2, (k + 1) * span - sw / 2, span * 0.55));
    } else if (style === 'turbofan') {     // flat aero disc with a ring of narrow swept vanes
      const span = Math.PI * 2 / n;
      for (let k = 0; k < n; k++) holes.push(sweptWindow(rFace * 0.42, rFace * 0.86, k * span + span * 0.18, (k + 1) * span - span * 0.42, span * 0.9));
    } else if (style === 'rally') {        // solid face with big round holes (rally / gravel wheel)
      for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2; holes.push(circleHole(Math.cos(a) * rFace * 0.6, Math.sin(a) * rFace * 0.6, rFace * 0.19)); }
    } else if (style === 'dishspoke') {    // 3-piece: short spokes inside a deep, flat lip
      const span = Math.PI * 2 / n, sw = span * 0.3;
      for (let k = 0; k < n; k++) holes.push(windowShape(rFace * 0.26, rFace * 0.7, k * span + sw / 2, (k + 1) * span - sw / 2, rFace * 0.08));
    } else if (style === 'star') {         // classic 5-spoke star: spokes thick at the hub, thin at the rim (Torq Thrust)
      const span = Math.PI * 2 / n;
      for (let k = 0; k < n; k++) holes.push(taperWindow(rFace * 0.3, rFace * 0.88, (k + 0.5) * span, span * 0.2, span * 0.41));
    } else if (style === 'fuchs') {        // forged petals: spokes widen toward the rim, small rounded windows
      const span = Math.PI * 2 / n;
      for (let k = 0; k < n; k++) holes.push(taperWindow(rFace * 0.3, rFace * 0.8, (k + 0.5) * span, span * 0.13, span * 0.3));
    } else if (style === 'cross') {        // cross-spoke mesh (BBS RS): rings of diamond windows
      const m = n * 2, span = Math.PI * 2 / m;
      for (const [r, off, sz] of [[0.42, 0, 0.09], [0.6, 0.5, 0.1], [0.78, 0, 0.1]])
        for (let k = 0; k < m; k++) holes.push(diamond(rFace * r, (k + off) * span, rFace * sz, span * 0.42));
    } else if (style === 'phonedial') {    // flat disc with a ring of round holes near the rim (phone dial)
      for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2; holes.push(circleHole(Math.cos(a) * rFace * 0.68, Math.sin(a) * rFace * 0.68, rFace * 0.13)); }
    } else if (style === 'split') {        // split spokes: each spoke has a slot running its full length
      const span = Math.PI * 2 / n;
      for (let k = 0; k < n; k++) {
        const a = k * span;
        holes.push(windowShape(rFace * 0.3, rFace * 0.9, a + span * 0.2, a + span * 0.8, rFace * 0.08));
        holes.push(taperWindow(rFace * 0.3, rFace * 0.88, a, span * 0.015, span * 0.05));
      }
    } else if (style === 'disc') {         // aero cover: nearly solid, a ring of short cooling slots
      const span = Math.PI * 2 / n;
      for (let k = 0; k < n; k++) holes.push(windowShape(rFace * 0.7, rFace * 0.86, k * span + span * 0.22, (k + 1) * span - span * 0.22, rFace * 0.02));
    } else if (style === 'beadlock') {     // off-road: chunky spokes + bolted ring
      const span = Math.PI * 2 / n, sw = span * 0.42;
      for (let k = 0; k < n; k++) holes.push(windowShape(rFace * 0.32, rFace * 0.78, k * span + sw / 2, (k + 1) * span - sw / 2, rFace * 0.1));
      for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2; holes.push(circleHole(Math.cos(a) * rFace * 0.88, Math.sin(a) * rFace * 0.88, rFace * 0.018)); }
    } else { // spoke / concave
      const span = Math.PI * 2 / n, spokeW = Math.min(0.45, 1.6 / n) * span * (n > 7 ? 0.9 : 1);
      for (let k = 0; k < n; k++) holes.push(windowShape(rFace * 0.3, rFace * 0.9, k * span + spokeW / 2, (k + 1) * span - spokeW / 2, rFace * 0.1));
    }
    face.holes.push(...holes);
    // centre bore
    face.holes.push(circleHole(0, 0, rFace * 0.11));
    const depth = 0.028;
    const g = new THREE.ExtrudeGeometry(face, { depth, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.005, bevelSegments: 3, curveSegments: seg });
    g.deleteAttribute('uv');
    // dish: pull the face back towards the hub as radius shrinks (concave wheel), spokes taper thinner outward
    const pos = g.attributes.position;
    const dish = { dish: 0.09, steel: 0.035, concave: 0.11, dishspoke: 0.12, turbofan: 0.02, rally: 0.03, directional: 0.08, phonedial: 0, disc: 0, fuchs: 0.04, cross: 0.06, star: 0.07 }[style] ?? 0.055;
    const flatFace = style === 'phonedial' || style === 'disc';   // big solid faces: a curved dish shows as creases across long triangles
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const r = Math.hypot(x, y) / rFace;
      const concave = dish * (1 - Math.min(1, r)) ** 1.4;
      // dishspoke: the spokes sit deep, the lip outside them stays flat
      const c2 = style === 'dishspoke' ? dish * (1 - Math.min(1, r / 0.72)) ** 0.7 : concave;
      if (!flatFace) pos.setZ(i, z - c2 - (style === 'dish' || style === 'dishspoke' ? 0 : 0.01 * r));
    }
    // to wheel axes: face normal +Z -> +X (outboard)
    g.rotateY(Math.PI / 2);
    const m = mergeVertices(g, 1e-5); m.computeVertexNormals();
    return m;
  });
}

function caliperGeometry(wheelR, big) {
  return cached(geoCache, `cal:${wheelR.toFixed(3)}:${big}`, () => {
    const r0 = wheelR * 0.62, r1 = wheelR * (big ? 0.9 : 0.84), span = big ? 0.85 : 0.62;
    const s = new THREE.Shape();
    const steps = 12;
    for (let i = 0; i <= steps; i++) { const a = -span / 2 + span * i / steps; const p = [Math.cos(a) * r1, Math.sin(a) * r1]; i ? s.lineTo(...p) : s.moveTo(...p); }
    for (let i = steps; i >= 0; i--) { const a = -span / 2 + span * i / steps; s.lineTo(Math.cos(a) * r0, Math.sin(a) * r0); }
    s.closePath();
    const thick = big ? 0.07 : 0.055;
    const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 3, curveSegments: 8 });
    g.translate(0, 0, -thick / 2);
    g.rotateY(Math.PI / 2);
    g.deleteAttribute('uv');
    return g;
  });
}

const mat = (key, fn) => cached(matCache, key, fn);

// Build one wheel assembly. side: +1 left (outboard +X), -1 right. Returns { pivot, spin }.
export function buildWheel(spec, side, front, quality = { wheelSeg: 48 }) {
  const seg = quality.wheelSeg || 48;
  const R = spec.tire.R, rimR = spec.wheel.dia * 0.0254 / 2, tw = spec.tire.width / 1000;
  const rimW = Math.min(tw * 0.92, (spec.wheel.width || 8) * 0.0254);
  const style = spec.wheel.style || 'spoke', n = spec.wheel.spokes || 5;
  const tname = spec.tire.name || 'Performance';
  const compound = (/slick|r-?comp|semi|track/i.test((spec.tireItem?.type || '') + tname) ? 'slick ' : '') + (tname.replace(/OEM\s*/, '').replace(/\d+\/\d+R\d+.*$/, '').trim() || 'Touring').slice(0, 40);
  const sizeText = (tname.match(/\d+\/\d+R\d+/) || [''])[0];
  const T = tireTextures(compound, sizeText);
  const rubber = mat('rubber:' + compound + sizeText, () => new THREE.MeshStandardMaterial({ color: 0xffffff, map: T.map, normalMap: T.normal, normalScale: new THREE.Vector2(1, 1), roughness: 0.88, metalness: 0 }));
  const rimColor = spec.sel?.wheelColor || spec.wheel.color || '#b9bcc0';
  const finish = spec.sel?.wheelColor ? 0.3 : /black|gunmetal|bronze/i.test(spec.wheel.finish || '') ? 0.4 : 0.22;
  const rimMat = mat('rim:' + rimColor + finish, () => new THREE.MeshPhysicalMaterial({ color: rimColor, metalness: 0.9, roughness: finish, clearcoat: 0.6, clearcoatRoughness: 0.15 }));
  const barrelMat = mat('barrel', () => new THREE.MeshStandardMaterial({ color: 0x6d7074, metalness: 0.85, roughness: 0.45 }));
  const nutMat = mat('nut', () => new THREE.MeshStandardMaterial({ color: 0xcfd2d6, metalness: 1, roughness: 0.2 }));
  const big = (spec.brakes.torque || 0) > 1.15 || !!spec.brakes.caliper;
  const discMat = mat('disc:' + big, () => new THREE.MeshStandardMaterial({ map: discTexture(big), metalness: 0.8, roughness: 0.5 }));
  const calColor = spec.brakes.caliper || '#2b2b2b';
  const calMat = mat('cal:' + calColor, () => new THREE.MeshPhysicalMaterial({ color: calColor, metalness: 0.2, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.1 }));

  const pivot = new THREE.Group();
  const spin = new THREE.Group(); pivot.add(spin);
  const add = (g, m, parent = spin) => { const o = new THREE.Mesh(g, m); o.castShadow = true; o.receiveShadow = true; parent.add(o); return o; };

  add(tireGeometry(R, rimR, tw, seg), rubber);
  // barrel (inner rim) + outer lip
  const barrel = cached(geoCache, `barrel:${rimR.toFixed(3)}:${rimW.toFixed(3)}:${seg}`, () => {
    const g = new THREE.CylinderGeometry(rimR * 0.985, rimR * 0.985, rimW, seg, 1, true); g.rotateZ(Math.PI / 2); return g;
  });
  add(barrel, barrelMat);
  const lip = cached(geoCache, `lip:${rimR.toFixed(3)}:${seg}`, () => { const g = new THREE.TorusGeometry(rimR * 0.985, 0.011, 8, seg); g.rotateY(Math.PI / 2); return g; });
  const faceX = side * (rimW / 2 - 0.005);
  add(lip, rimMat).position.x = faceX;
  const face = add(rimFaceGeometry(rimR, style, n, Math.max(24, seg)), rimMat);
  face.position.x = faceX - side * 0.006;
  if (side < 0) face.scale.x = -1;
  // hub, lug nuts, centre cap
  const nutG = cached(geoCache, 'nut', () => { const g = new THREE.CylinderGeometry(0.0105, 0.0115, 0.028, 6); g.rotateZ(Math.PI / 2); return g; });
  const lugs = /4x/.test(spec.car.wheel?.bolt || '') ? 4 : 5;
  const faceInset = { dish: 0.085, steel: 0.03, concave: 0.1, dishspoke: 0.115, turbofan: 0.02, rally: 0.03, directional: 0.075, phonedial: 0.025, disc: 0.015, fuchs: 0.04, cross: 0.06, star: 0.065 }[style] ?? 0.05;
  for (let k = 0; k < lugs; k++) {
    const a = k / lugs * Math.PI * 2;
    const nut = add(nutG, nutMat); nut.position.set(faceX - side * faceInset, Math.cos(a) * rimR * 0.2, Math.sin(a) * rimR * 0.2);
  }
  const capG = cached(geoCache, 'cap:' + rimR.toFixed(3), () => { const g = new THREE.CylinderGeometry(rimR * 0.1, rimR * 0.115, 0.02, 24); g.rotateZ(Math.PI / 2); return g; });
  const cap = add(capG, rimMat); cap.position.x = faceX - side * (faceInset - 0.01);
  // brake disc (spins with the wheel)
  const discR = Math.min(rimR * 0.86, big ? rimR * 0.86 : rimR * 0.76);
  const discG = cached(geoCache, `disc:${discR.toFixed(3)}`, () => {
    const g = new THREE.CylinderGeometry(discR, discR, 0.03, 48, 1, false);
    g.rotateZ(Math.PI / 2);
    // planar UVs on the faces
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getZ(i) / discR * 0.5 + 0.5, p.getY(i) / discR * 0.5 + 0.5);
    return g;
  });
  add(discG, discMat).position.x = side * (rimW / 2 - 0.085 - faceInset * 0.5);
  // caliper (fixed to the upright, not spinning): trailing edge for fronts, leading for rears
  const cal = add(caliperGeometry(rimR, big), calMat, pivot);
  cal.position.x = side * (rimW / 2 - 0.085 - faceInset * 0.5);
  cal.rotation.x = front ? Math.PI * 0.62 : Math.PI * 0.38;
  if (side < 0) cal.scale.x = -1;
  return { pivot, spin };
}
