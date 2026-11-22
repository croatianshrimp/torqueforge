// Circuits (closed Catmull-Rom splines) and the drag strip. Units: meters, XZ plane.
// Every circuit starts with the same main straight (x = 0, z -250 → 200) so the shared pit lane, grandstand and
// start gantry line up; the rest of each layout lives on the +x side (the drag strip is at x ≈ -180).
const CTRL = [
  [0, -250], [0, 200], [25, 290], [100, 330], [190, 310], [240, 250], [262, 170], [320, 128], [400, 150], [450, 222],
  [530, 245], [600, 192], [612, 100], [562, 30], [482, 2], [452, -70], [500, -150], [492, -240], [420, -292], [320, -282],
  [250, -222], [180, -250], [100, -322], [28, -318],
];

// centripetal Catmull-Rom (alpha 0.5): no cusps / overshoot where long and short control segments meet
function catmull(p0, p1, p2, p3, t) {
  const d = (a, b) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const L = (a, b, ta, tb) => [0, 1].map(k => ((tb - u) * a[k] + (u - ta) * b[k]) / (tb - ta));
  const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
  const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
  return L(B1, B2, t1, t2);
}

function buildCircuit(CTRL, { width = 13, ds = 2, ...meta } = {}) {
  // dense sample
  const dense = [];
  const n = CTRL.length;
  for (let i = 0; i < n; i++) {
    const p0 = CTRL[(i - 1 + n) % n], p1 = CTRL[i], p2 = CTRL[(i + 1) % n], p3 = CTRL[(i + 2) % n];
    for (let j = 0; j < 60; j++) dense.push(catmull(p0, p1, p2, p3, j / 60));
  }
  // resample uniformly
  const cum = [0];
  for (let i = 1; i <= dense.length; i++) {
    const a = dense[i - 1], b = dense[i % dense.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[cum.length - 1];
  const N = Math.round(total / ds), step = total / N;
  const points = [];
  let k = 0;
  for (let i = 0; i < N; i++) {
    const s = i * step;
    while (cum[k + 1] < s) k++;
    const a = dense[k], b = dense[(k + 1) % dense.length];
    const f = (s - cum[k]) / (cum[k + 1] - cum[k]);
    points.push({ x: a[0] + (b[0] - a[0]) * f, z: a[1] + (b[1] - a[1]) * f });
  }
  // headings + curvature
  const head = [], curv = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = points[(i - 1 + N) % N], b = points[(i + 1) % N];
    head.push(Math.atan2(b.x - a.x, b.z - a.z));
  }
  for (let i = 0; i < N; i++) {
    let d = head[(i + 1) % N] - head[(i - 1 + N) % N];
    while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    curv[i] = d / (2 * step);
  }
  // smooth curvature (racing line approximation: drivers use the track width)
  const sm = new Float32Array(N);
  for (let it = 0; it < 3; it++) {
    for (let i = 0; i < N; i++) { let s = 0; for (let j = -4; j <= 4; j++) s += curv[(i + j + N) % N]; sm[i] = s / 9; }
    curv.set(sm);
  }
  const widened = curv.map(c => c * 0.78); // using full track width lowers effective curvature
  return { points, head, curv: widened, rawCurv: curv, ds: step, length: total, width, N, ...meta };
}


// Layouts are written as driving instructions from the end of the start straight (0, 200) heading north:
// ['S', metres] straight · ['A', degrees, radius] corner (+ = right) — then closed automatically: a turn to head
// south, a run down the back, and two corners onto the start straight. Keeps hairpin radii and straights exact.
function layout(prog) {
  let x = 0, z = 200, h = 0; const pts = [];
  const line = L => { const n = Math.max(1, Math.round(L / 60)); for (let i = 1; i <= n; i++) { x += Math.sin(h) * L / n; z += Math.cos(h) * L / n; pts.push([x, z]); } };
  const arc = (deg, R) => { const tot = deg * Math.PI / 180, n = Math.max(2, Math.ceil(Math.abs(tot) * R / Math.min(22, R * 0.7)));
    for (let i = 0; i < n; i++) { const dh = tot / n, c = 2 * R * Math.sin(Math.abs(dh) / 2); h += dh / 2; x += Math.sin(h) * c; z += Math.cos(h) * c; h += dh / 2; pts.push([x, z]); } };
  for (const [op, a, b] of prog) op === 'S' ? line(a) : arc(a, b);
  const dh = ((180 - h * 180 / Math.PI) % 360 + 540) % 360 - 180;
  if (Math.abs(dh) > 1) arc(dh, 45);
  line((-310 - z) / Math.cos(h)); arc(90, 40); line((50 - x) / Math.sin(h)); arc(90, 50);
  return [[0, -250], [0, 200], ...pts.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10])];
}

export const TRACK_DEFS = {
  park: { name: 'TorqueForge Park', desc: 'Club circuit: tight T1, a long straight, esses, a hairpin and a flowing back section.', width: 13,
    ctrl: layout([['S',  40], ['A',  90,  30], ['S',  250], ['A',  -50,  90], ['A',  100,  65], ['A',  -50,  90], ['S',  60], ['A',  -90,  35], ['S',  40], ['A',  180,  20], ['A',  -20,  100], ['S',  130], ['A',  -30,  150], ['S',  90], ['A',  60,  50], ['A',  -60,  50], ['S',  80], ['A',  90,  40], ['S',  100], ['A',  -90,  30]]) },
  gp: {
    name: 'Northwind GP', desc: 'Fast GP circuit: 520 m straight, a 200 m-radius sweeper, a hairpin and winding esses.', width: 14,
    ctrl: layout([['S',  60], ['A',  90,  45], ['S',  520], ['A',  -45,  200], ['S',  160], ['A',  135,  30], ['S',  260], ['A',  -90,  60], ['S',  60], ['A',  180,  20], ['A',  -20,  120], ['S',  200], ['A',  -70,  60], ['A',  40,  120], ['A',  -60,  100], ['A',  90,  90], ['S',  60], ['A',  90,  50], ['S',  60], ['A',  -90,  40]]),
  },
  street: {
    name: 'Harbour Street Circuit', desc: 'Tight 90° city corners and a hairpin between concrete walls. No runoff — no mistakes.', width: 11, street: true, wallGap: 1.3,
    ctrl: layout([['S',  30], ['A',  90,  16], ['S',  230], ['A',  -90,  16], ['S',  110], ['A',  90,  16], ['S',  160], ['A',  90,  16], ['S',  200], ['A',  -90,  16], ['S',  70], ['A',  90,  16], ['S',  150], ['A',  90,  16], ['S',  60], ['A',  -180,  16], ['S',  100], ['A',  90,  16]]),
  },
  ridge: {
    name: 'Kestrel Ridge', desc: 'Technical hill track: two hairpins, linked climbing bends and a long downhill straight.', width: 12,
    ctrl: layout([['S',  20], ['A',  110,  25], ['A',  -50,  70], ['A',  -60,  70], ['A',  70,  45], ['S',  20], ['A',  -140,  20], ['S',  40], ['A',  50,  60], ['A',  -60,  55], ['A',  80,  50], ['S',  80], ['A',  170,  20], ['A',  -30,  90], ['S',  110], ['A',  -90,  40], ['A',  70,  70], ['S',  120], ['A',  -60,  35], ['A',  80,  35]]),
  },
  oval: {
    name: 'Speedway Oval', desc: 'Flat-out 2.6 km oval. Top speed and nerve.', width: 16, wallGap: 2.2,
    ctrl: [[0, -250], [0, 160], [12, 260], [70, 335], [160, 362], [250, 335], [308, 260], [320, 160], [320, -210], [308, -310], [250, -385], [160, -412], [70, -385], [12, -310]],
  },
};
// pin the main straight dead straight (x = 0) so the pit wall / grandstand line up exactly
const pinStraight = c => [c[0], [0, c[0][1] + 15], [0, -50], [0, c[1][1] - 15], ...c.slice(1), [0, c[0][1] - 22]];
export const TRACKS = Object.fromEntries(Object.entries(TRACK_DEFS).map(([id, d]) => [id, buildCircuit(pinStraight(d.ctrl), { width: d.width, id, name: d.name, desc: d.desc, street: !!d.street, wallGap: d.wallGap })]));
export const CIRCUIT = TRACKS.park;

// ---------------- elevation ----------------
// Every track gets a smooth height field (metres) shared by the scenery and the physics. Rolling hills are a few long
// waves (grades stay ≲ 12%, crests make cars go light, dips load them up); the start straight, pits, paddock and drag
// strip stay flat; the oval gets banked turns instead.
const ELEV = {
  park: { amp: 13, lam: [420, 760], seed: 3 },
  gp: { amp: 18, lam: [520, 980], seed: 8 },
  ridge: { amp: 21, lam: [380, 700], seed: 21 },
  street: { amp: 4, lam: [500, 800], seed: 5 },
  oval: { bank: 0.21 },                        // ≈ 12° banking in the turns
};
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const rectDist = (x, z, x0, x1, z0, z1) => Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1));
function makeHeight(id) {
  const c = ELEV[id];
  if (!c) return null;
  if (c.bank) {
    // two semicircular turns; the surface rises across the track (inside low, outside high), then an embankment
    // falls back to the ground beyond the outer wall. Ramps in/out along the straights.
    const turns = [{ cx: 160, cz: 200, R: 163, w: z => sstep(110, 205, z) }, { cx: 160, cz: -250, R: 162, w: z => sstep(-160, -255, z) }];
    const tb = c.bank;
    return (x, z) => {
      let h = 0;
      for (const t of turns) {
        const w = t.w(z); if (w <= 0) continue;
        const d = Math.hypot(x - t.cx, z - t.cz), up = Math.max(0, Math.min(d - (t.R - 11), 32));
        const fall = 1 - sstep(t.R + 26, t.R + 70, d);
        h = Math.max(h, w * tb * up * fall);
      }
      return h;
    };
  }
  let seed = c.seed * 9301 + 49297; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const waves = [];
  for (let i = 0; i < 4; i++) {
    const lam = c.lam[0] + (c.lam[1] - c.lam[0]) * rnd(), dir = rnd() * Math.PI * 2, k = 2 * Math.PI / lam;
    waves.push({ kx: Math.cos(dir) * k, kz: Math.sin(dir) * k, ph: rnd() * Math.PI * 2, a: [0.45, 0.3, 0.17, 0.08][i] });
  }
  return (x, z) => {
    // flat: drag strip + start straight / pits / paddock; fade to flat at the edge of the detailed terrain
    const dFlat = Math.min(rectDist(x, z, -270, -100, -530, 610), rectDist(x, z, -100, 130, -345, 150));
    const m = sstep(0, 110, dFlat) * (1 - sstep(0, 150, rectDist(x, z, -560, 1100, -560, 560)));
    if (m <= 0) return 0;
    let h = 0; for (const w of waves) h += w.a * Math.cos(w.kx * x + w.kz * z + w.ph);
    return c.amp * m * h;
  };
}
for (const [id, T] of Object.entries(TRACKS)) T.heightAt = makeHeight(id);
// terrain extent with detail (outside it the ground is flat at 0)
export const TERRAIN = { x0: -700, x1: 1260, z0: -720, z1: 720 };

// put a car model on the ground: height + pitch/roll from the local slope
export function poseOnGround(T, root, x, z, yaw) {
  root.rotation.order = 'YXZ';
  const H = T.heightAt;
  if (!H) { root.position.set(x, 0, z); root.rotation.set(0, yaw, 0); return 0; }
  const e = 1.2, h = H(x, z), gx = (H(x + e, z) - H(x - e, z)) / (2 * e), gz = (H(x, z + e) - H(x, z - e)) / (2 * e);
  const sF = gx * Math.sin(yaw) + gz * Math.cos(yaw), sL = gx * Math.cos(yaw) - gz * Math.sin(yaw);
  root.position.set(x, h, z); root.rotation.set(-Math.atan(sF), yaw, Math.atan(sL));
  return h;
}

// nearest point index search, using a hint for O(1) tracking
export function nearest(track, x, z, hint = -1) {
  const N = track.N, P = track.points;
  let best = -1, bd = Infinity;
  if (hint >= 0) {
    for (let j = -40; j <= 40; j++) {
      const i = (hint + j + N) % N, dx = P[i].x - x, dz = P[i].z - z, d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    if (bd < 900) return { i: best, d: Math.sqrt(bd) };
  }
  for (let i = 0; i < N; i++) { const dx = P[i].x - x, dz = P[i].z - z, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = i; } }
  return { i: best, d: Math.sqrt(bd) };
}

// signed lateral offset (left positive) of a point relative to centerline at index i
export function lateral(track, i, x, z) {
  const p = track.points[i], h = track.head[i];
  const lx = Math.cos(h), lz = -Math.sin(h);
  return (x - p.x) * lx + (z - p.z) * lz;
}

export const DRAG = { x: -180, z0: -420, length: 402.34, runoff: 520, width: 22 };
