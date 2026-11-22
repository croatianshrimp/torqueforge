// Rigid-body contact for cars: barriers (armco / tire walls / concrete) and car-vs-car.
// Impulse at the contact point with restitution + Coulomb friction, so a glancing hit scrubs speed and yaws the car,
// a head-on hit bounces it back. Cars are boxes (4 corners + mid-sides) against walls, two circles each against cars.
const tmp = { x: 0, z: 0 };

function worldVel(c) { const s = Math.sin(c.yaw), co = Math.cos(c.yaw); return [c.u * s + c.v * co, c.u * co - c.v * s]; }
function setVel(c, vx, vz) { const s = Math.sin(c.yaw), co = Math.cos(c.yaw); c.u = vx * s + vz * co; c.v = vx * co - vz * s; }

// apply an impulse response at world offset (rx, rz) from the CG with contact normal N (pointing out of the obstacle)
function impulse(c, rx, rz, nx, nz, e, mu, otherInvM = 0, other = null, orx = 0, orz = 0) {
  const m = c.m, I = c.s.Iz;
  let [vx, vz] = worldVel(c);
  let pvx = vx + c.r * rz, pvz = vz - c.r * rx;
  let ovx = 0, ovz = 0;
  if (other) { const [ox, oz] = worldVel(other); ovx = ox + other.r * orz; ovz = oz - other.r * orx; }
  const rvx = pvx - ovx, rvz = pvz - ovz;
  const vn = rvx * nx + rvz * nz;
  if (vn >= 0) return 0;
  const rn = rz * nx - rx * nz, orn = orz * nx - orx * nz;
  const k = 1 / m + rn * rn / I + (other ? 1 / other.m + orn * orn / other.s.Iz : otherInvM);
  const j = -(1 + e) * vn / k;
  // friction along the tangent
  const tx = -nz, tz = nx, vt = rvx * tx + rvz * tz;
  const rt = rz * tx - rx * tz, ort = orz * tx - orx * tz;
  const kt = 1 / m + rt * rt / I + (other ? 1 / other.m + ort * ort / other.s.Iz : otherInvM);
  const jt = Math.max(-mu * j, Math.min(mu * j, -vt / kt));
  const Jx = j * nx + jt * tx, Jz = j * nz + jt * tz;
  // remember the hardest contact (world offset from CG + normal into the car) for damage / effects
  if (!c.hitInfo || -vn > c.hitInfo.v) c.hitInfo = { rx, rz, nx, nz, v: -vn };
  if (other && (!other.hitInfo || -vn > other.hitInfo.v)) other.hitInfo = { rx: orx, rz: orz, nx: -nx, nz: -nz, v: -vn };
  vx += Jx / m; vz += Jz / m; c.r += (rz * Jx - rx * Jz) / I;
  setVel(c, vx, vz);
  if (other) {
    const [ox, oz] = worldVel(other);
    setVel(other, ox - Jx / other.m, oz - Jz / other.m); other.r -= (orz * Jx - orx * Jz) / other.s.Iz;
  }
  return -vn;  // closing speed (m/s)
}

// world: TrackScenery (barrierOffset, inPitZone, A.lat, A.PIT, A.hw), track: CIRCUIT, idx: current nearest index
// returns the hardest impact speed this step (m/s), or 0
export function collideWalls(c, dims, world, track, idx, nearest) {
  const hl = dims.L / 2 - 0.05, hw = dims.W / 2 - 0.02;
  const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw), lx = Math.cos(c.yaw), lz = -Math.sin(c.yaw);
  const pts = [[hl, hw], [hl, -hw], [-hl, hw], [-hl, -hw], [0, hw], [0, -hw], [hl, 0], [-hl, 0]];
  const A = world.A, P = A.PIT;
  let best = null;
  for (const [a, b] of pts) {
    const rx = fx * a + lx * b, rz = fz * a + lz * b, x = c.x + rx, z = c.z + rz;
    const cands = [];
    // armco / tire walls along the circuit
    const n = nearest(track, x, z, idx), k = n.i, p = track.points[k], [ax, az] = A.lat(k);
    const o = (x - p.x) * ax + (z - p.z) * az, s = Math.sign(o) || 1;
    if (!world.inPitZone(k, s)) {
      const tire = world.hasTires(k, s);
      const conc = !!track.street;
      const lim = world.barrierOffset(k, s) - (tire ? 0.85 : 0.12);
      if (Math.abs(o) > lim && Math.abs(o) < lim + 2.5) cands.push({ d: Math.abs(o) - lim, nx: -s * ax, nz: -s * az, e: tire ? 0.12 : conc ? 0.2 : 0.28, mu: tire ? 0.7 : conc ? 0.45 : 0.35, kind: tire ? 'tires' : conc ? 'concrete' : 'armco' });
    }
    // pit wall (concrete, along z on the +x side) — both faces
    if (z > P.z0 && z < P.z1 && Math.abs(x - P.x0) < 0.3 + 1.5) {
      const side = c.x < P.x0 ? -1 : 1, face = P.x0 + side * 0.3;
      if ((x - face) * side < 0) cands.push({ d: (face - x) * side, nx: side, nz: 0, e: 0.2, mu: 0.4, kind: 'concrete' });
    }
    // grandstand wall
    const gx = -A.hw - 4 + 0.25;
    if (z > -71 && z < 101 && x < gx && x > gx - 1.5) cands.push({ d: gx - x, nx: 1, nz: 0, e: 0.2, mu: 0.4, kind: 'concrete' });
    for (const cd of cands) if (!best || cd.d > best.d) best = { ...cd, rx, rz };
  }
  if (!best) return 0;
  // push out, then bounce
  c.x += best.nx * (best.d + 0.005); c.z += best.nz * (best.d + 0.005);
  const v = impulse(c, best.rx, best.rz, best.nx, best.nz, best.e, best.mu);
  c.lastHit = best.kind;
  return v;
}

// car vs car: each car = two circles (front / rear) of radius W/2
export function collideCars(a, da, b, db) {
  const circles = (c, d) => { const r = d.W / 2, off = Math.max(0, d.L / 2 - r); return [[Math.sin(c.yaw) * off, Math.cos(c.yaw) * off, r], [-Math.sin(c.yaw) * off, -Math.cos(c.yaw) * off, r]]; };
  if (Math.hypot(a.x - b.x, a.z - b.z) > (da.L + db.L) / 2 + 0.5) return 0;
  let hit = 0;
  for (const [ax, az, ar] of circles(a, da)) for (const [bx, bz, br] of circles(b, db)) {
    const dx = (a.x + ax) - (b.x + bx), dz = (a.z + az) - (b.z + bz), dist = Math.hypot(dx, dz), pen = ar + br - dist;
    if (pen <= 0 || dist < 1e-4) continue;
    const nx = dx / dist, nz = dz / dist;
    const wa = b.m / (a.m + b.m), wb = 1 - wa;
    a.x += nx * pen * wa; a.z += nz * pen * wa; b.x -= nx * pen * wb; b.z -= nz * pen * wb;
    // contact point: on a's circle surface toward b
    const crx = ax - nx * ar, crz = az - nz * ar, orx = crx + (a.x - b.x), orz = crz + (a.z - b.z);
    hit = Math.max(hit, impulse(a, crx, crz, nx, nz, 0.3, 0.3, 0, b, orx, orz));
  }
  return hit;
}

// kinematic obstacle (scripted pace car): infinite mass, moving with velocity (vx, vz)
export function collideKinematic(a, da, k, dk) {
  const circles = (c, yaw, d) => { const r = d.W / 2, off = Math.max(0, d.L / 2 - r); return [[Math.sin(yaw) * off, Math.cos(yaw) * off, r], [-Math.sin(yaw) * off, -Math.cos(yaw) * off, r]]; };
  if (Math.hypot(a.x - k.x, a.z - k.z) > (da.L + dk.L) / 2 + 0.5) return 0;
  let hit = 0;
  for (const [ax, az, ar] of circles(a, a.yaw, da)) for (const [bx, bz, br] of circles(k, k.head, dk)) {
    const dx = (a.x + ax) - (k.x + bx), dz = (a.z + az) - (k.z + bz), dist = Math.hypot(dx, dz), pen = ar + br - dist;
    if (pen <= 0 || dist < 1e-4) continue;
    const nx = dx / dist, nz = dz / dist;
    a.x += nx * pen; a.z += nz * pen;
    // relative frame: subtract the obstacle's velocity, bounce, add it back
    const [vx, vz] = worldVel(a); setVel(a, vx - k.vx, vz - k.vz);
    hit = Math.max(hit, impulse(a, ax - nx * ar, az - nz * ar, nx, nz, 0.25, 0.3));
    const [wx, wz] = worldVel(a); setVel(a, wx + k.vx, wz + k.vz);
  }
  return hit;
}
