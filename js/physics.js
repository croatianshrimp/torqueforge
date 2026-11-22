// TorqueForge vehicle physics.
// Four-wheel model: combined-slip tire curves with load sensitivity, longitudinal + lateral weight transfer,
// aerodynamic drag/downforce split front/rear, wind, dirty air / slipstream, engine torque curve, gearbox,
// drivetrain inertia (engine + wheels), differentials, brakes with heat & fade, ABS/TC.

export const G = 9.81, RHO = 1.225;
// peak at normalized slip 1, falls to ~88% at large slip (progressive breakaway like real street tires)
const PAC_C = 1.32, PAC_B = Math.tan(Math.PI / (2 * PAC_C)), PAC_BC = PAC_B * PAC_C;
const smooth = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------------- engine ----------------
export function makeEngine(e) {
  const P = e.hp * 745.7, Tpk = e.tq, red = e.redline, ev = e.asp === 'ev';
  const idle = ev ? 0 : 900;
  const step = 50, n = Math.ceil(red * 1.05 / step) + 1;
  const T = new Float32Array(n);
  let pmax = 0;
  for (let i = 0; i < n; i++) {
    const rpm = Math.max(i * step, 1), r = rpm / red, w = rpm * Math.PI / 30;
    let shape;
    if (ev) shape = 1;
    else if (e.asp === 'turbo') shape = 0.32 + 0.68 * smooth((rpm - 1400) / ((e.spool || 0.42) * red - 1400));
    else if (e.asp === 'sc' && e.blower === 'centrifugal') shape = 0.42 + 0.58 * Math.pow(Math.min(1, Math.max(0, (rpm - 800) / (0.92 * red - 800))), 1.3);
    else if (e.asp === 'sc') shape = (e.blower === 'screw' ? 0.82 : 0.78) + (e.blower === 'screw' ? 0.18 : 0.22) * smooth((rpm - 1000) / (0.35 * red - 1000)) - 0.12 * smooth((r - 0.8) / 0.2);
    else shape = 0.66 + 0.34 * smooth((rpm - 1000) / (0.68 * red - 1000));
    const pcap = ev ? P * (1 - 0.25 * smooth((r - 0.75) / 0.25)) : P * (1 - 0.10 * smooth((r - 0.9) / 0.1));
    T[i] = Math.min(Tpk * shape, pcap / w);
    if (rpm <= red) pmax = Math.max(pmax, T[i] * w);
  }
  const k = P / pmax;
  for (let i = 0; i < n; i++) T[i] *= k;
  const torque = rpm => {
    if (rpm <= 0) return T[0];
    const f = rpm / step, i = Math.floor(f);
    if (i >= n - 1) return T[n - 1];
    return T[i] + (T[i + 1] - T[i]) * (f - i);
  };
  const friction = rpm => ev ? 0 : Tpk * 0.09 * (0.35 + 0.65 * rpm / red);
  return { torque, friction, idle, redline: red, ev, Tpk, P, cyl: e.cyl, curve: T, step };
}

export function dynoCurve(spec) {
  const eng = makeEngine(spec.engine);
  const pts = [];
  const start = eng.ev ? 0 : 1000;
  for (let rpm = start; rpm <= eng.redline; rpm += eng.redline / 60) {
    const t = eng.torque(rpm);
    pts.push({ rpm, tq: t, hp: t * rpm * Math.PI / 30 / 745.7 });
  }
  return pts;
}

// ---------------- tire ----------------
function loadMu(mu, Fz) { return mu * clamp(1.0 - 0.075 * (Fz / 4000 - 1), 0.78, 1.12); }

// returns [fx, fy] in wheel frame; kappa = slip ratio, tanA = tan(slip angle)
function tireForce(t, Fz, kappa, tanA, muMul, out) {
  const mu = loadMu(t.mu, Fz) * muMul;
  const Dx = mu * Fz * t.lng, Dy = mu * Fz * t.lat;
  const sx = kappa / t.kp, sy = tanA / t.ap;
  const s = Math.hypot(sx, sy);
  if (s < 1e-9) { out[0] = 0; out[1] = 0; return out; }
  const f = Math.sin(PAC_C * Math.atan(PAC_B * s));
  out[0] = Dx * f * sx / s;
  out[1] = -Dy * f * sy / s;
  return out;
}

// ---------------- vehicle ----------------
export class Vehicle {
  constructor(spec, opts = {}) {
    this.s = spec;
    this.eng = makeEngine(spec.engine);
    this.m = spec.mass + 75; // with driver
    this.gears = spec.trans.gears;
    this.final = spec.trans.final;
    this.auto = opts.auto ?? true;
    this.tc = opts.tc ?? true;
    this.abs = opts.abs ?? true;
    this.esc = opts.esc ?? true;
    this.launchRpm = opts.launchRpm ?? null;
    const t = spec.track / 2, a = spec.a, b = spec.b;
    const drv = spec.drive;
    this.wheels = [
      { x: a, y: t, front: true }, { x: a, y: -t, front: true },
      { x: -b, y: t, front: false }, { x: -b, y: -t, front: false },
    ].map(w => ({ ...w, omega: 0, driven: drv === 'AWD' || (drv === 'FWD' ? w.front : !w.front), Fz: 0, kappa: 0, alpha: 0, fx: 0, fy: 0, temp: 40, absF: 1 }));
    this.nDriven = this.wheels.filter(w => w.driven).length;
    this.shiftRpm = this.computeShiftPoints();
    this.reset(0, 0, 0);
  }

  reset(x, z, yaw) {
    this.x = x; this.z = z; this.yaw = yaw;
    this.u = 0; this.v = 0; this.r = 0;
    this.axs = 0; this.ays = 0;
    this.gear = 1; this.rpm = this.eng.idle; this.shiftTimer = 0; this.pendingGear = 1;
    this.tcF = 1; this.revTimer = 0; this.steerAngle = 0;
    this.odo = 0; this.time = 0;
    for (const w of this.wheels) { w.omega = 0; w.temp = 40; w.absF = 1; }
    this.df = 0; this.drag = 0; this.dirty = 0;
    this.vv = null; this.avS = 0; this.loadMul = 1; this.slopeF = 0; this.slopeL = 0; this.h = 0;
  }

  ratio(g = this.gear) {
    if (g === -1) return -3.3 * this.final;
    if (g <= 0) return 0;
    return this.gears[g - 1] * this.final;
  }

  // optimal upshift rpm per gear (max wheel force crossover)
  computeShiftPoints() {
    const R = this.s.tire.R, red = this.eng.redline, out = [];
    for (let g = 1; g <= this.gears.length; g++) {
      let shift = red * 0.985;
      if (g < this.gears.length) {
        const r1 = this.gears[g - 1] * this.final, r2 = this.gears[g] * this.final;
        for (let rpm = red * 0.6; rpm <= red; rpm += 25) {
          const v = rpm * Math.PI / 30 / r1 * R;
          const rpm2 = v / R * r2 * 30 / Math.PI;
          if (this.eng.torque(rpm2) * r2 > this.eng.torque(rpm) * r1) { shift = rpm; break; }
        }
      }
      out.push(Math.min(shift, red * 0.985));
    }
    return out;
  }

  get speed() { return Math.hypot(this.u, this.v); }

  step(dt, inp, env = {}) {
    const s = this.s, m = this.m, ws = this.wheels, R = s.tire.R;
    const wind = env.wind || { x: 0, z: 0 };
    const muMul = env.muMul ?? 1;
    const rrExtra = env.rrExtra ?? 0;
    const dirty = env.dirty || 0;
    this.time += dt;
    // ---- terrain: slope along / across the car, and the load change over crests and through dips ----
    let slopeF = 0, slopeL = 0, loadMul = 1;
    if (env.height) {
      const H = env.height, e = 0.6, x = this.x, z = this.z;
      const gx = (H(x + e, z) - H(x - e, z)) / (2 * e), gz = (H(x, z + e) - H(x, z - e)) / (2 * e);
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      slopeF = gx * sy + gz * cy; slopeL = gx * cy - gz * sy;
      const vv = slopeF * this.u + slopeL * this.v;              // vertical speed following the surface
      if (this.vv == null) this.vv = vv;
      const av = (vv - this.vv) / dt; this.vv = vv;
      this.avS += (clamp(av, -40, 40) - this.avS) * Math.min(1, dt / 0.05);
      loadMul = clamp(1 + this.avS / G, 0.05, 2.5);               // crest: light; compression: heavy
      this.h = H(x, z);
    }
    this.loadMul = loadMul; this.slopeF = slopeF; this.slopeL = slopeL;

    // ---- inputs / reverse logic ----
    let thr = clamp(inp.throttle || 0, 0, 1), brk = clamp(inp.brake || 0, 0, 1);
    if (this.auto && this.eng && !env.noReverse) {
      if (this.gear >= 1 && this.u < 0.6 && brk > 0.1 && thr < 0.05) {
        this.revTimer += dt; if (this.revTimer > 0.35) { this.gear = -1; this.revTimer = 0; }
      } else if (this.gear === -1 && this.u > -0.6 && thr > 0.1 && brk < 0.05) {
        this.revTimer += dt; if (this.revTimer > 0.2) { this.gear = 1; this.revTimer = 0; }
      } else this.revTimer = 0;
    }
    if (this.gear === -1 && this.auto) { const t0 = thr; thr = brk; brk = t0; }

    // ---- steering ----
    const sp = Math.abs(this.u);
    // speed-sensitive steering: full lock at parking speed; at speed, full input asks for what the tires can actually
    // give (geometric angle for ~the grip limit + a little front slip) instead of sawing the fronts past the limit.
    // Extra lock opens up while the car is sliding so you can still catch it with countersteer.
    const gripG = s.tire.mu * s.tire.lat * muMul * (1 + Math.max(0, this.df) / (m * G));
    const betaNow = sp > 2 ? Math.abs(Math.atan2(this.v, Math.max(1, Math.abs(this.u)))) : 0;
    const SR = s.steer || { lock: 0.62, gain: 1, rate: 1 };          // rack ratio / angle kit
    const lock = SR.lock;
    const base = Math.min(lock, (s.L * gripG * G * 1.1 / Math.max(1, sp * sp) + 0.3 * s.tire.ap) * SR.gain);
    this.maxSteer = base;
    const st = clamp(inp.steer || 0, -1, 1);
    // the extra lock while sliding is only there for COUNTERsteer (wheels toward where the car is going); it used to
    // add lock into the slide too, which fed the spin
    const counter = sp > 2 && Math.sign(st) === Math.sign(this.v) ? betaNow * 1.1 : 0;
    let target = st * Math.min(lock, base + counter);
    // hands off the wheel: caster / self-aligning torque swings the front wheels to where the front axle is actually
    // travelling (a real car catches a slide like this) instead of locking them dead straight
    if (Math.abs(st) < 0.02 && this.u > 4) target = clamp(Math.atan2(this.v + this.r * s.a, this.u) * 0.6, -0.4, 0.4);
    const rate = 2.6 * SR.rate * (lock / 0.62) * dt;
    this.steerAngle += clamp(target - this.steerAngle, -rate, rate);
    const delta = this.steerAngle, cd = Math.cos(delta), sd = Math.sin(delta);

    // ---- aero ----
    const fx_w = Math.sin(this.yaw), fz_w = Math.cos(this.yaw);   // forward in world
    const lx_w = Math.cos(this.yaw), lz_w = -Math.sin(this.yaw);  // left in world
    const vwx = this.u * fx_w + this.v * lx_w - wind.x, vwz = this.u * fz_w + this.v * lz_w - wind.z;
    const ua = vwx * fx_w + vwz * fz_w, va = vwx * lx_w + vwz * lz_w;
    const vair = Math.hypot(ua, va);
    const A = s.aero.A;
    const dragK = 0.5 * RHO * s.aero.cd * A * (1 - 0.38 * dirty) * (this.cdMul ?? 1);
    const Fdx = -dragK * ua * vair;
    const sideArea = s.car.L * s.car.H * 0.62;
    const Fdy = -0.5 * RHO * 0.95 * sideArea * va * Math.abs(va);
    const q = 0.5 * RHO * ua * ua * A * (1 - 0.48 * dirty);
    const DFf = -s.aero.clF * q, DFr = -s.aero.clR * q;
    this.df = DFf + DFr; this.drag = -Fdx; this.dirty = dirty;

    // ---- loads ----
    const cosS = 1 / Math.sqrt(1 + slopeF * slopeF + slopeL * slopeL);
    const W = m * G * loadMul * cosS, h = s.cgH, L = s.L, tr = s.track;
    const Fzf = W * s.wdF + DFf - m * this.axs * h / L;
    const Fzr = W * (1 - s.wdF) + DFr + m * this.axs * h / L;
    const dF = m * this.ays * h / tr;
    ws[0].Fz = Math.max(40, Fzf / 2 - dF * s.rollF);
    ws[1].Fz = Math.max(40, Fzf / 2 + dF * s.rollF);
    ws[2].Fz = Math.max(40, Fzr / 2 - dF * (1 - s.rollF));
    ws[3].Fz = Math.max(40, Fzr / 2 + dF * (1 - s.rollF));

    // ---- engine & gearbox ----
    const eng = this.eng;
    let wd = 0; for (const w of ws) if (w.driven) wd += w.omega; wd /= this.nDriven;
    const ratioNow = this.ratio();
    const rpmWheel = wd * ratioNow * 30 / Math.PI;
    const rpmRoad = Math.max(0, this.u) / R * ratioNow * 30 / Math.PI; // shift on road speed, not wheelspin
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      if (this.shiftTimer <= 0) this.gear = this.pendingGear;
    } else if (this.gears.length > 1 && this.gear >= 1) {
      if (this.auto) {
        const g = this.gear;
        if (g < this.gears.length && rpmRoad > this.shiftRpm[g - 1] && thr > 0.05) this.shift(g + 1);
        else if (g < this.gears.length && rpmRoad > eng.redline * 0.99) this.shift(g + 1);
        else if (g > 1) {
          const lowerRpm = rpmRoad * this.gears[g - 2] / this.gears[g - 1];
          if ((rpmRoad < eng.redline * 0.42 && lowerRpm < this.shiftRpm[g - 2] * 0.88) || (brk > 0.3 && lowerRpm < eng.redline * 0.8)) this.shift(g - 1);
        }
      } else {
        if (inp.shiftUp && this.gear < this.gears.length) this.shift(this.gear + 1);
        if (inp.shiftDown && this.gear > 1) this.shift(this.gear - 1);
      }
    }
    if (!this.auto && inp.shiftDown && this.gear === 1 && Math.abs(this.u) < 1) this.gear = -1;
    if (!this.auto && inp.shiftUp && this.gear === -1) this.gear = 1;

    // TC
    let maxSlip = 0;
    for (const w of ws) if (w.driven) maxSlip = Math.max(maxSlip, w.kappa);
    if (this.tc) {
      // proportional slip controller holding the driven tires near peak slip
      // allow less longitudinal slip when the tires are also working laterally (friction circle) or the car is yawing
      let latUse = 0;
      for (const w of ws) if (w.driven) latUse = Math.max(latUse, Math.abs(Math.tan(w.alpha)) / s.tire.ap);
      // trims wheelspin, doesn't strangle the car: allow a bit less slip while the tires are also cornering hard
      const target = s.tire.kp * (sp < 8 ? 1.1 : 0.95) * Math.max(0.45, 1 - 0.45 * Math.min(1, latUse));
      const err = (target - maxSlip) / s.tire.kp;
      this.tcF = clamp(this.tcF + clamp(err, -4, 1.2) * dt * 5, 0.05, 1);
    } else this.tcF = 1;
    // ESC: body slip beyond ~6 deg -> cut throttle and brake the outer front wheel to stop the rotation
    // ESC watches the rear axle: oversteer = the rear tires sliding outward past their peak slip angle
    const vRear = this.v - this.r * s.b, aRear = sp > 4 ? Math.atan2(vRear, Math.abs(this.u)) : 0;
    let escF = 0;
    if (this.esc && sp > 6) {
      const out = Math.abs(this.r) > 0.03 && Math.sign(vRear) === Math.sign(this.r) ? 0 : Math.abs(aRear);
      escF = clamp((out - 1.15 * Math.atan(s.tire.ap)) * 8, 0, 1);
      // also catch yaw building well past what grip can support
      const rMax = s.tire.mu * G * (1 + Math.max(0, this.df) / (m * G)) * 1.3 / sp;
      if (Math.abs(this.r) > rMax) escF = Math.max(escF, clamp((Math.abs(this.r) / rMax - 1) * 3, 0, 1));
    }
    this.escActive = escF > 0.05;
    const thrE = thr * this.tcF * (1 - 0.85 * escF) * (this.powerMul ?? 1);

    let Te = 0, slipping = false, coupledI = 0;
    const ratio = this.ratio();
    if (this.shiftTimer > 0 || ratio === 0) {
      this.rpm += ((eng.idle + thr * eng.redline * 0.6) - this.rpm) * Math.min(1, dt * 8);
      Te = 0;
    } else if (eng.ev) {
      this.rpm = Math.abs(rpmWheel);
      if (this.rpm > eng.redline) Te = 0;
      else Te = thrE * eng.torque(this.rpm) - (thr < 0.02 && Math.abs(this.u) > 1 ? eng.Tpk * 0.12 : 0);
      coupledI = s.engine.inertia * ratio * ratio / this.nDriven;
    } else {
      const slipRpm = this.launchRpm && this.gear === 1 ? this.launchRpm : Math.max(1800, eng.redline * 0.3);
      const absWheel = Math.abs(rpmWheel);
      if (absWheel < slipRpm && (this.gear === 1 || this.gear === -1 || absWheel < eng.idle)) {
        slipping = true;
        const tgt = Math.max(absWheel, eng.idle + thr * (slipRpm - eng.idle));
        this.rpm += (tgt - this.rpm) * Math.min(1, dt * 12);
        Te = thrE * eng.torque(this.rpm);
        // gentle creep / clutch drag when off throttle in gear
        if (thr < 0.02) Te = absWheel < eng.idle ? 0.06 * eng.Tpk * (brk > 0.05 ? 0 : 1) : 0;
      } else {
        this.rpm = absWheel;
        if (this.rpm > eng.redline) Te = -eng.friction(this.rpm);
        else Te = thrE * eng.torque(this.rpm) - (1 - thrE) * eng.friction(this.rpm);
        coupledI = s.engine.inertia * ratio * ratio / this.nDriven;
      }
    }
    this.rpm = Math.max(eng.idle, Math.min(this.rpm, eng.redline * 1.02));
    this.engineTorque = Te;
    const Tw = Te * ratio * (Te > 0 ? s.trans.eff : 1);

    // torque split + diffs
    const split = s.drive === 'AWD' ? s.awdSplit : s.drive === 'FWD' ? 1 : 0;
    const axleT = [Tw * split, Tw * (1 - split)];
    if (s.lockedCentre && s.drive === 'AWD') {
      // locked centre: front and rear axles forced to turn together (binds in tight corners)
      const wf = (ws[0].omega + ws[1].omega) / 2, wr = (ws[2].omega + ws[3].omega) / 2;
      const tc = clamp(Math.min(0.6 * (s.tire.I + coupledI) / dt, 6000) * (wf - wr), -4000, 4000);
      axleT[0] -= tc; axleT[1] += tc;
    }
    const drive = [0, 0, 0, 0];
    for (let ax = 0; ax < 2; ax++) {
      const T = axleT[ax]; if (!ws[ax * 2].driven) continue;
      const l = ws[ax * 2], rgt = ws[ax * 2 + 1];
      const lock = s.lsd.preload + s.lsd.lock * Math.abs(T);
      const Iw = s.tire.I + coupledI;
      const kv = Math.min(0.3 * Iw / dt, 3000);
      const tr2 = clamp(kv * (l.omega - rgt.omega), -lock, lock);
      drive[ax * 2] = T / 2 - tr2 / 2;
      drive[ax * 2 + 1] = T / 2 + tr2 / 2;
    }

    // brakes
    const fadeOf = w => 1 - clamp((w.temp - s.brakes.fadeTemp) / 260, 0, 0.55);
    const Tcap = 1.75 * m * G * R * s.brakes.torque;
    const bias = s.brakes.bias;

    // ---- wheels & tire forces ----
    // gravity along the slope: uphill slows, downhill pushes; across a bank / camber it holds the car in (or pulls it out)
    let Fx = Fdx - m * G * slopeF * cosS, Fy = Fdy - m * G * slopeL * cosS, Mz = Fdy * (-0.12 * L);
    const tmp = [0, 0];
    for (let i = 0; i < 4; i++) {
      const w = ws[i], tw = (w.front ? s.tireF : s.tireR) || s.tire;   // per-axle setup (pressure / camber / toe)
      let vx = this.u - this.r * w.y, vy = this.v + this.r * w.x;
      if (w.front) { const vx2 = vx * cd + vy * sd; vy = -vx * sd + vy * cd; vx = vx2; }
      const vden = Math.max(Math.abs(vx), 2.5);
      const tanA = clamp(vy / vden, -3, 3);
      w.alpha = Math.atan(tanA);
      // brake torque
      let Tb = brk * Tcap * (w.front ? bias : 1 - bias) / 2 * fadeOf(w);
      if (!w.front && inp.handbrake) Tb += 0.9 * m * G * R / 2;
      if (escF > 0 && w.front && ((this.r > 0 && i === 1) || (this.r < 0 && i === 0))) Tb += escF * 0.45 * Tcap;
      if (this.abs && !(inp.handbrake && !w.front)) {
        if (brk > 0 && w.kappa < -tw.kp * 1.2 && Math.abs(vx) > 1.5) w.absF = Math.max(0.1, w.absF - 14 * dt);
        else w.absF = Math.min(1, w.absF + 5 * dt);
        Tb *= w.absF;
      }
      // implicit wheel spin integration with secant tire stiffness
      const Ieff = s.tire.I + (w.driven ? coupledI : 0);
      const kap0 = (w.omega * R - vx) / vden;
      tireForce(tw, w.Fz, kap0, tanA, muMul, tmp);
      let k = Math.abs(kap0) > 1e-3 ? tmp[0] / kap0 : 0;
      const k0 = loadMu(tw.mu, w.Fz) * muMul * w.Fz * tw.lng * PAC_BC / tw.kp;
      if (!(k > 0)) k = k0 * 0.3; k = Math.min(k, k0);
      const den = Ieff + dt * R * R * k / vden;
      const wFree = (Ieff * w.omega + dt * drive[i] + dt * R * k * vx / vden) / den;
      const dB = dt * Tb / den;
      w.omega = Math.abs(wFree) <= dB ? 0 : wFree - Math.sign(wFree) * dB;
      // brake heat
      w.temp += Tb * Math.abs(w.omega) * dt / (s.brakes.heatCap * (w.front ? 1.25 : 0.75));
      w.temp -= (w.temp - 30) * (0.006 + 0.0011 * sp) * dt * 3;
      // final forces
      w.kappa = (w.omega * R - vx) / vden;
      tireForce(tw, w.Fz, w.kappa, tanA, muMul, tmp);
      const rr = tw.rr * (1 + 0.35 * (vx / 40) * (vx / 40)) + rrExtra; // rolling resistance grows with speed
      let fx = tmp[0] - rr * w.Fz * Math.tanh(vx / 0.4), fy = tmp[1];
      w.fx = fx; w.fy = fy;
      if (w.front) { const bx = fx * cd - fy * sd, by = fx * sd + fy * cd; fx = bx; fy = by; }
      Fx += fx; Fy += fy; Mz += w.x * fy - w.y * fx;
    }

    // ---- integrate body ----
    const axm = Fx / m, aym = Fy / m;
    const k2 = Math.min(1, dt / 0.045);
    this.axs += (axm - this.axs) * k2; this.ays += (aym - this.ays) * k2;
    this.u += (axm + this.v * this.r) * dt;
    this.v += (aym - this.u * this.r) * dt;
    this.r += Mz / s.Iz * dt;
    if (Math.abs(this.u) < 0.05 && Math.abs(this.v) < 0.05 && thr < 0.02 && (brk > 0.05 || inp.handbrake)) { this.u = 0; this.v = 0; this.r *= 0.5; }
    this.yaw += this.r * dt;
    const vxw = this.u * Math.sin(this.yaw) + this.v * Math.cos(this.yaw);
    const vzw = this.u * Math.cos(this.yaw) - this.v * Math.sin(this.yaw);
    this.x += vxw * dt; this.z += vzw * dt;
    this.odo += Math.abs(this.u) * dt;
    this.ax = axm; this.ay = aym;
  }

  shift(g) {
    if (this.shiftTimer > 0) return;
    this.pendingGear = g;
    this.shiftTimer = this.s.trans.shiftTime;
    if (this.shiftTimer <= 0) { this.gear = g; }
  }
}

// ---------------- tests ----------------
const KMH = 1 / 3.6, MPH = 0.44704;

export function dragTest(spec, opts = {}) {
  const car = new Vehicle(spec, { auto: true, tc: true, abs: true });
  const eng = car.eng;
  car.launchRpm = eng.ev ? null : (spec.hasLaunch ? eng.redline * 0.62 : (spec.engine.asp === 'turbo' ? eng.redline * 0.55 : eng.redline * 0.48));
  const dt = 1 / 400;
  const res = { t60: null, t100k: null, t100m: null, t200k: null, eighth: null, quarter: null, trap: null, trace: [] };
  let t = 0, t0 = null; // t0 = 1-ft rollout (how magazines time 0-60)
  const maxT = opts.maxT ?? 40;
  while (t < maxT) {
    car.step(dt, { throttle: 1, steer: 0 }, { noReverse: true });
    t += dt;
    const v = car.u, d = car.odo;
    if (t0 === null && d >= 0.3048) t0 = t;
    const tr = t - (t0 ?? 0);
    if (!res.t60 && v >= 60 * MPH) res.t60 = tr;
    if (!res.t100k && v >= 100 * KMH) res.t100k = tr;
    if (!res.t100m && v >= 100 * MPH) res.t100m = tr;
    if (!res.t200k && v >= 200 * KMH) res.t200k = tr;
    if (!res.eighth && d >= 201.17) res.eighth = t;
    if (!res.quarter && d >= 402.34) { res.quarter = t; res.trap = v; }
    if (opts.trace && Math.round(t * 400) % 20 === 0) res.trace.push({ t, v, d, rpm: car.rpm, gear: car.gear });
    if (res.quarter && (res.t200k || t > 30)) break;
  }
  return res;
}

export function brakeTest(spec) {
  const car = new Vehicle(spec, { abs: true });
  const v0 = 100 * KMH;
  car.u = v0;
  for (const w of car.wheels) w.omega = v0 / spec.tire.R;
  car.gear = Math.min(3, spec.trans.gears.length); car.auto = false;
  const dt = 1 / 400; let t = 0;
  const d0 = car.odo;
  while (car.u > 0.1 && t < 15) { car.step(dt, { brake: 1, throttle: 0 }, { noReverse: true }); t += dt; }
  return { dist: car.odo - d0, time: t };
}

// tractive force at a given speed (best gear), plus whether gear-limited
export function tractive(spec, eng, v) {
  const R = spec.tire.R, g = spec.trans.gears, fd = spec.trans.final;
  let best = 0;
  for (const gr of g) {
    const ratio = gr * fd;
    let rpm = v / R * ratio * 30 / Math.PI;
    if (rpm > eng.redline) continue;
    if (!eng.ev) rpm = Math.max(rpm, eng.redline * 0.45);
    const F = eng.torque(rpm) * ratio * spec.trans.eff / R;
    if (F > best) best = F;
  }
  return best;
}

export function topSpeed(spec) {
  const eng = makeEngine(spec.engine), m = spec.mass + 75;
  let top = 0, gearLimited = false;
  for (let v = 5; v < 160; v += 0.25) {
    const F = tractive(spec, eng, v);
    const D = 0.5 * RHO * spec.aero.cd * spec.aero.A * v * v;
    const DF = -(spec.aero.clF + spec.aero.clR) * 0.5 * RHO * spec.aero.A * v * v;
    const RR = spec.tire.rr * (1 + 0.35 * (v / 40) ** 2) * (m * G + Math.max(0, DF));
    if (F > D + RR) { top = v; gearLimited = F > 0 && tractive(spec, eng, v + 0.25) === 0; }
    else if (F === 0) { gearLimited = true; break; }
    else break;
  }
  return { v: top, gearLimited };
}

// max steady lateral accel (m/s^2) at speed v, with axle-limit diagnostics
export function maxLat(spec, v) {
  const m = spec.mass + 75, q = 0.5 * RHO * spec.aero.A * v * v;
  const DFf = -spec.aero.clF * q, DFr = -spec.aero.clR * q;
  const Ff = m * G * spec.wdF + DFf, Fr = m * G * (1 - spec.wdF) + DFr;
  const t = spec.tire;
  const cap = (Fax, ay, share) => {
    const dF = m * ay * spec.cgH / spec.track * share;
    const fo = Math.max(40, Fax / 2 + dF), fi = Math.max(40, Fax / 2 - dF);
    return (loadMu(t.mu, fo) * fo + loadMu(t.mu, fi) * fi) * t.lat;
  };
  let lo = 0, hi = 40, limit = 'balanced';
  for (let it = 0; it < 30; it++) {
    const ay = (lo + hi) / 2;
    const needF = m * ay * spec.b / spec.L, needR = m * ay * spec.a / spec.L;
    const okF = needF <= cap(Ff, ay, spec.rollF), okR = needR <= cap(Fr, ay, 1 - spec.rollF);
    if (okF && okR) lo = ay; else { hi = ay; limit = !okF && okR ? 'understeer' : okF && !okR ? 'oversteer' : 'balanced'; }
  }
  return { ay: lo * 0.97, limit };
}

export function skidpad(spec, radius = 61) {
  let v = 20;
  for (let i = 0; i < 12; i++) v = Math.sqrt(maxLat(spec, v).ay * radius);
  const r = maxLat(spec, v);
  return { g: r.ay / G, v, limit: r.limit };
}

// quasi-steady-state lap time simulation over a track (array of {x,z}, closed)
export function lapSim(spec, track) {
  const eng = makeEngine(spec.engine), m = spec.mass + 75;
  const pts = track.points, n = pts.length;
  const ds = track.ds, curv = track.curv;
  const latTab = [];
  for (let v = 0; v <= 130; v++) latTab.push(maxLat(spec, v).ay);
  const lat = v => { const i = Math.min(129, Math.floor(v)); const f = v - i; return latTab[i] * (1 - f) + latTab[i + 1] * f; };
  const vmax = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(curv[i]);
    let v = 120;
    if (k > 1e-5) for (let it = 0; it < 8; it++) v = Math.min(120, Math.sqrt(lat(v) / k));
    vmax[i] = v;
  }
  const drv = spec.drive === 'AWD' ? 1 : spec.drive === 'FWD' ? spec.wdF : 1 - spec.wdF;
  const accel = (v, k) => {
    const q = 0.5 * RHO * spec.aero.A * v * v;
    const DF = -(spec.aero.clF + spec.aero.clR) * q;
    const D = spec.aero.cd * q;
    const used = Math.min(0.999, (v * v * Math.abs(k)) / Math.max(0.1, lat(v)));
    const fric = Math.sqrt(1 - used * used);
    const tractionLim = spec.tire.mu * spec.tire.lng * (m * G * drv * (spec.drive === 'FWD' ? 0.92 : 1.06) + DF * (spec.drive === 'AWD' ? 1 : 0.5)) * fric;
    const F = Math.min(tractive(spec, eng, Math.max(v, 1)), tractionLim);
    return (F - D - spec.tire.rr * (1 + 0.35 * (v / 40) ** 2) * m * G) / m;
  };
  const decel = (v, k) => {
    const q = 0.5 * RHO * spec.aero.A * v * v;
    const DF = -(spec.aero.clF + spec.aero.clR) * q;
    const used = Math.min(0.999, (v * v * Math.abs(k)) / Math.max(0.1, lat(v)));
    const fric = Math.sqrt(1 - used * used);
    const brakeCap = 1.75 * G * spec.brakes.torque * m;
    return (Math.min(spec.tire.mu * 0.97 * (m * G + DF) * fric, brakeCap) + spec.aero.cd * q) / m;
  };
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = vmax[i];
  // two passes each direction for wraparound
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < n; j++) {
      const i = j, i2 = (j + 1) % n;
      const a = Math.max(0, accel(v[i], curv[i]));
      v[i2] = Math.min(v[i2], Math.sqrt(v[i] * v[i] + 2 * a * ds));
    }
    for (let j = n - 1; j >= 0; j--) {
      const i = j, ip = (j - 1 + n) % n;
      const d = decel(v[i], curv[i]);
      v[ip] = Math.min(v[ip], Math.sqrt(v[i] * v[i] + 2 * d * ds));
    }
  }
  let time = 0, vtop = 0, vmin = 999;
  for (let i = 0; i < n; i++) { const a = v[i], b = v[(i + 1) % n]; time += 2 * ds / (a + b); vtop = Math.max(vtop, a); vmin = Math.min(vmin, a); }
  return { time, profile: v, vtop, vmin };
}

export function fullStats(spec, track) {
  const drag = dragTest(spec);
  const brake = brakeTest(spec);
  const top = topSpeed(spec);
  const skid = skidpad(spec);
  const lap = track ? lapSim(spec, track) : null;
  const q200 = 0.5 * RHO * spec.aero.A * Math.pow(200 / 3.6, 2);
  return {
    drag, brake, top, skid, lap,
    df200: -(spec.aero.clF + spec.aero.clR) * q200 / G,
    drag200: spec.aero.cd * q200,
    hpPerTon: spec.engine.hp / (spec.mass / 1000),
    kgPerHp: spec.mass / spec.engine.hp,
  };
}
