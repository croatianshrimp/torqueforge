// Build evaluation: combines a base car + selected parts into a physical spec, and checks compatibility.
import { CAR_BY_ID, SWAPS, PART_BY_ID, WHEEL_BY_ID, TIRE_BY_ID, CAT_BY_ID, CATEGORIES, ENGINE_INERTIA, CYLS, stockWheel, stockTire, tireDiaIn, engineDims } from './data.js';

// Will engine swap s physically go into this car? Compares the engine (with accessories) against the engine bay, and
// its orientation (transverse engine + transaxle vs longitudinal) against the chassis. kit = off-the-shelf bolt-in kit.
// ratio > 1: too big for the stock bay (up to 1.15 a bay cut makes room), needDt: a longitudinal engine in a FWD car.
const RWD_CONV = new Set(['dt_fwd2rwd', 'dt_2awd']);
export function engineFit(car, s, sel = {}) {
  const kit = car.swaps.includes(s.code), d = engineDims(s), b = car.bay;
  const out = { kit, ev: s.cfg === 'EV', ratio: 0, needDt: null, impossible: null, worst: null };
  if (out.ev) return out;
  const fit = dims => { let r = 0, w = null; for (const [name, have, lim] of dims) { const q = have / lim; if (q > r) { r = q; w = { name, over: Math.round(have - lim) }; } } return [r, w]; };
  let r;
  if (car.layout === 'F' && car.transverse) {
    if (d.orient.includes('T')) r = fit([['wide', d.L, b.across], ['long', d.W, b.fore], ['tall', d.H, b.H]]);
    else if (car.drive === 'FWD') { out.needDt = 'dt_fwd2rwd'; r = fit([['long', d.L, Math.max(b.fore, car.wb * 1000 * 0.3)], ['wide', d.W, b.across], ['tall', d.H, b.H]]); }
    else out.impossible = `the ${s.code} is a longitudinal engine and this AWD chassis is built around a transverse engine + transaxle — there's no conversion for that`;
  } else if (car.layout === 'F') {
    if (d.orient === 'T') out.impossible = `the ${s.code} only exists as a transverse engine with a front-drive transaxle — it can't drive the rear wheels of a longitudinal chassis`;
    else r = fit([['long', d.L, b.L], ['wide', d.W, b.W], ['tall', d.H, b.H]]);
  } else {
    // mid / rear engine: transaxle adapter either way round, whichever orientation fits better
    const a1 = fit([['long', d.L, b.L], ['wide', d.W, b.W], ['tall', d.H, b.H]]), a2 = fit([['wide', d.L, b.W], ['long', d.W, b.L], ['tall', d.H, b.H]]);
    r = d.orient === 'T' ? (a2[0] < a1[0] ? a2 : a1) : a1;
  }
  if (r) { out.ratio = r[0]; out.worst = r[1]; }
  if (out.ratio > 1.15) out.impossible = `the ${s.code} is ${out.worst.over} mm too ${out.worst.name} for the ${car.model}'s engine bay, even with the firewall moved`;
  return out;
}
// what has to be installed with an engine swap: [] when it bolts in, part ids otherwise, or {blocked: reason}
export function swapNeeds(sel, code) {
  const car = CAR_BY_ID[sel.car], s = SWAPS[code];
  if (!car || !s) return { needs: [] };
  const f = engineFit(car, s, sel);
  if (f.kit) return { needs: [] };
  if (f.impossible) return { needs: [], blocked: f.impossible };
  const needs = [];
  if (f.ev) needs.push('fab_ev'); else needs.push('fab_swap');
  if (f.ratio > 1 || (s.code === 'Cummins' && car.mass < 1300)) needs.push('fab_bay');
  if (f.needDt && !RWD_CONV.has(sel.drivetrain)) needs.push(f.needDt);
  const have = new Set([...(sel.fab || []), sel.drivetrain]);
  return { needs: needs.filter(n => !have.has(n)), fit: f };
}

// ---- tuning (setup sheet) ----
// every car: brake bias, tyre pressures, camber (stock bolts: small range; camber kit / coilovers: full), toe.
// needs hardware: roll balance (sway bars / coilovers), ride height + spring rate (adjustable suspension),
// diff lock (aftermarket LSD), boost (turbo/SC + ECU tune), wing angle (adjustable wing).
export const TUNE_DEFAULTS = { brakeBias: 0.65, rollBal: 0, wingAngle: 0.5, pressF: 32, pressR: 32, camberF: -1.0, camberR: -1.2, toeF: 0, toeR: 0.1, rideH: 0, springs: 1, diffLock: 0.5, boost: 0 };
export function tuneLimits(spec) {
  const kit = spec.parts.some(p => p.camberKit) || !!spec.adjustableSusp;
  return {
    camber: kit ? [-4, 0] : [-1.8, -0.3], camberKit: kit,
    rideH: spec.adjustableSusp, rideRange: spec.rideRange, rideNom: spec.rideNom, springs: spec.adjustableSusp, roll: spec.adjustable,
    diff: !!spec.sel.diff && spec.sel.diff !== 'spool', boost: spec.boostTune, wing: !!spec.hasWing,
  };
}
export function emptyBuild(carId) {
  const sel = { car: carId, tuning: { ...TUNE_DEFAULTS }, color: null, name: '', fitV: 2 };
  for (const c of CATEGORIES) sel[c.id] = c.multi ? [] : null;
  return sel;
}

// builds saved before conversions existed paid for kitless-swap fabrication automatically: give them the part
export function migrateSel(sel) {
  if (!sel.fab) {
    sel.fab = [];
    const s = SWAPS[sel.engine], car = CAR_BY_ID[sel.car];
    if (s && car && !car.swaps.includes(s.code)) sel.fab.push(s.cfg === 'EV' ? 'fab_ev' : 'fab_swap');
  }
  // engine-fit rules v2 (physical bay size + orientation): a swap built under the old rules gets the conversion work
  // it now needs, once
  if (!sel.fitV && sel.engine && SWAPS[sel.engine] && CAR_BY_ID[sel.car]) {
    const n = swapNeeds(sel, sel.engine);
    if (!n.blocked) for (const id of n.needs) { if (id.startsWith('dt_')) { if (!sel.drivetrain) sel.drivetrain = id; } else if (!sel.fab.includes(id)) sel.fab.push(id); }
  }
  sel.fitV = 2;
  return sel;
}

export function getPart(cat, id) {
  if (!id) return null;
  if (cat === 'engine') return SWAPS[id] ? { ...SWAPS[id], id, cat: 'engine', brand: 'Swap kit' } : null;
  if (cat === 'wheels') return WHEEL_BY_ID[id] || null;
  if (cat === 'tires') return TIRE_BY_ID[id] || null;
  return PART_BY_ID[id] || null;
}

const BODY_CG = { supercar: 0.43, roadster: 0.45, coupe: 0.48, muscle: 0.52, sedan: 0.52, hatch: 0.54, truck: 0.78 };
const SHIFT = { MT: 0.28, SEQ: 0.08, DCT: 0.07, AT: 0.16, EV: 0 };

export function evaluate(sel) {
  const car = CAR_BY_ID[sel.car];
  const issues = [];
  const add = (level, cat, msg) => issues.push({ level, cat, msg });
  const parts = []; // resolved non-wheel parts (with cat)

  // ----- engine -----
  const fab = new Set((sel.fab || []).map(id => PART_BY_ID[id]?.fab).filter(Boolean));   // conversions done
  let eng = { ...car.engine };
  let trans = { ...car.trans };
  let swapPrice = 0, swapped = null;
  if (sel.engine) {
    const s = SWAPS[sel.engine];
    if (s) {
      swapped = s;
      const f = engineFit(car, s, sel);
      if (!f.kit) {
        // no off-the-shelf kit: it has to physically fit, and goes in with the matching fabrication work
        const heavy = s.code === 'Cummins' && car.mass < 1300;
        if (f.impossible) add('error', 'engine', `Won't fit: ${f.impossible}`);
        else {
          if (f.needDt && !RWD_CONV.has(sel.drivetrain)) add('error', 'engine', `The ${s.code} is a longitudinal engine — in this front-drive chassis it needs a FWD → RWD (or AWD) conversion`);
          if ((f.ratio > 1 || heavy) && !fab.has('bay')) add('error', 'engine', `The ${s.code} is ${f.worst ? f.worst.over + ' mm too ' + f.worst.name : 'too big'} for the stock bay — needs an engine bay cut & firewall relocation`);
          if (!fab.has(f.ev ? 'ev' : 'swap')) add('error', 'engine', f.ev ? `No bolt-in EV kit for the ${car.model} — needs EV conversion fabrication` : `No bolt-in kit for the ${car.model} — the ${s.code} fits, but needs an engine mount conversion`);
          else add('ok', 'engine', f.ev ? 'EV conversion fabrication installed' : 'Engine mount conversion installed');
        }
      }
      eng = { code: s.code, name: s.name, cfg: s.cfg, hp: s.hp, tq: s.tq, redline: s.redline, asp: s.asp, mass: s.mass };
      trans = { ...s.trans };
      swapPrice += s.price;
      if (s.cfg === 'EV' && car.engine.cfg !== 'EV') add('ok', 'engine', 'EV swap: single-speed reduction, no clutch');
    }
  }
  // drivetrain conversion: which wheels are driven
  let drive = car.drive, awdSplit = car.awdSplit, lockedCentre = false;
  if (sel.drivetrain) {
    const p = PART_BY_ID[sel.drivetrain], r = p?.check(car);
    if (r) add(r[0], 'drivetrain', `${p.name}: ${r[1]}`);
    if (p && (!r || r[0] !== 'error')) { drive = p.dt.drive; awdSplit = p.dt.split; lockedCentre = !!p.dt.lockedCentre; }
  }
  // transmission swap
  const baseEngine = { ...eng };
  const ctx = { engine: eng, trans, car, drive };
  if (sel.gearbox) {
    const p = PART_BY_ID[sel.gearbox], r = p?.check(car, { ...ctx, engine: { ...eng, asp: eng.cfg === 'EV' ? 'ev' : eng.asp } });
    if (r) add(r[0], 'gearbox', `${p.name}: ${r[1]}`);
    if (p && (!r || r[0] !== 'error')) {
      // keep first-gear overall ratio close to what the car had, so launch gearing suits its tires
      const firstOverall = trans.gears[0] * trans.final;
      Object.assign(trans, { type: p.tx.type, gears: p.tx.gears, final: +(firstOverall / p.tx.gears[0]).toFixed(2), maxTq: p.tx.rating });
      if (p.tx.shiftTime) trans.swapShift = p.tx.shiftTime;
    }
  }

  // forced induction first (changes aspiration)
  let fi = null;
  if (sel.forced) {
    const p = PART_BY_ID[sel.forced];
    const r = p.check(car, ctx);
    if (r) add(r[0], 'forced', r[1]);
    if (!r || r[0] !== 'error') { fi = p; }
    parts.push(p);
  }
  if (fi) eng.asp = fi.fi.asp;

  // trans part first (may change gearbox type)
  if (sel.trans) {
    const p = PART_BY_ID[sel.trans];
    const r = p.check(car, ctx);
    if (r) add(r[0], 'trans', r[1]);
    parts.push(p);
  }

  for (const c of CATEGORIES) {
    if (['engine', 'forced', 'trans', 'wheels', 'tires'].includes(c.id)) continue;
    if (c.id === 'gearbox' || c.id === 'drivetrain') { const p = PART_BY_ID[sel[c.id]]; if (p) parts.push(p); continue; }
    const ids = c.multi ? (sel[c.id] || []) : (sel[c.id] ? [sel[c.id]] : []);
    for (const id of ids) {
      const p = PART_BY_ID[id];
      if (!p) continue;
      const r = p.check ? p.check(car, ctx) : null;
      if (r) add(r[0], c.id, `${p.name}: ${r[1]}`);
      parts.push(p);
    }
  }
  const has = (pred) => parts.some(pred);
  const transPart = sel.trans ? PART_BY_ID[sel.trans] : null;
  if (transPart?.newType) trans.type = transPart.newType;

  // requirements
  for (const p of parts) {
    for (const req of p.req || []) {
      if (req === 'fuel' && !has(q => q.fuel)) add('error', p.cat, `${p.name} requires a fuel system upgrade`);
      if (req === 'ic' && !has(q => q.ic)) add('error', p.cat, `${p.name} requires a front-mount intercooler`);
      if ((req === 'intake' && !sel.intake) || (req === 'exhaust' && !sel.exhaust)) add('warn', p.cat, `${p.name} is mapped for intake + exhaust; gains assume both`);
    }
  }

  // ----- power -----
  const isEV = eng.asp === 'ev';
  const boosted = eng.asp === 'turbo' || eng.asp === 'sc';
  let hp = eng.hp, tq = eng.tq, spool = eng.asp === 'turbo' ? 0.42 : null;
  if (fi) { hp *= 1 + fi.fi.hp; tq *= 1 + fi.fi.tq; if (fi.fi.spool) spool = fi.fi.spool; }
  let g = 0, gt = 0;
  for (const p of parts) {
    if (p === fi) continue;
    if (isEV) { g += p.hpEV || 0; gt += p.hpEV || 0; continue; }
    if (boosted) { g += p.hpBoost || 0; gt += p.tqBoost ?? p.hpBoost ?? 0; }
    else { g += p.hpNA || 0; gt += p.tqNA ?? p.hpNA ?? 0; }
  }
  hp *= 1 + g; tq *= 1 + gt;
  // boost tune: turned up on a boosted engine with an ECU tune (more boost = more power, more heat / stress)
  const T = { ...TUNE_DEFAULTS, ...(sel.tuning || {}) };
  const boostTune = !isEV && boosted && parts.some(p => p.cat === 'ecu');
  if (boostTune) { const b = Math.max(0, Math.min(1, T.boost)); hp *= 1 + 0.14 * b; tq *= 1 + 0.16 * b; if (b > 0.7) add('warn', 'ecu', 'High boost: knock risk and extra engine stress — run a fuel / cooling upgrade'); }
  // bottom end / valvetrain
  if (!isEV) {
    let rev = 0;
    const springs = has(q => q.valveSprings);
    for (const p of parts) if (p.rev) rev += (p.req?.includes('springs') && !springs) ? 0 : p.rev;
    for (const p of parts) if (p.req?.includes('springs') && !springs) add('warn', 'internals', `${p.name}: valve float without upgraded springs — rev gain lost`);
    for (const p of parts) if (p.needsPart && !has(q => q.id === p.needsPart)) add('error', p.cat, `${p.name} needs ${PART_BY_ID[p.needsPart]?.name || p.needsPart}`);
    eng.redline = Math.round((eng.redline + rev) / 50) * 50;
    const tol = (baseEngine.asp === 'na' ? 1.75 : 1.9) + parts.reduce((a, p) => a + (p.boostTol || 0), 0);
    const ratio = hp / baseEngine.hp;
    if (ratio > tol * 1.3) add('error', 'internals', `Stock bottom end can't hold ${Math.round(hp)} hp (≈${Math.round(baseEngine.hp * tol)} hp safe) — add ${/^R\d$/.test(eng.cfg || baseEngine.cfg) ? 'apex seals, studded/billet housings or a billet e-shaft' : 'forged pistons/rods or a billet crank'}`);
    else if (ratio > tol) add('warn', 'internals', `${Math.round(hp)} hp is past what the internals are rated for (≈${Math.round(baseEngine.hp * tol)} hp) — engine life will be short`);
  }
  if (!isEV && !has(q => q.fuel) && hp > baseEngine.hp * 1.45) add('error', 'fuel', `Stock fuel system can't feed ${Math.round(hp)} hp (≈${Math.round(baseEngine.hp * 1.45)} hp max) — add a fuel upgrade`);
  if (!isEV && hp > baseEngine.hp * 1.9 && !has(q => q.cooling)) add('warn', 'cooling', 'Over 1.9× stock power without radiator/oil cooler — expect heat soak on track');
  if (isEV && hp > baseEngine.hp * 1.1 && !has(q => q.cooling)) add('warn', 'cooling', 'Unlocked EV will thermally derate without a chiller upgrade');
  if (boosted && !has(q => q.ic) && fi && fi.fi.asp === 'turbo' && fi.id !== 'hybridturbo' && fi.id !== 'bigsingle') add('warn', 'cooling', 'Intercooler recommended for the turbo kit');

  const rating = transPart?.rating && transPart.check(car, ctx) == null ? Math.max(transPart.rating, trans.maxTq) : trans.maxTq;
  if (!isEV) {
    if (tq > rating * 1.1) add('error', 'trans', `${trans.type === 'MT' || trans.type === 'SEQ' ? 'Clutch' : 'Gearbox'} rated ${rating} Nm — will slip/break with ${Math.round(tq)} Nm`);
    else if (tq > rating) add('warn', 'trans', `Torque ${Math.round(tq)} Nm is at the limit of the ${rating} Nm driveline`);
  }

  // ----- wheels & tires -----
  const sw = stockWheel(car), st = stockTire(car);
  const wheel = sel.wheels ? (WHEEL_BY_ID[sel.wheels] || sw) : sw;
  let tire = sel.tires ? (TIRE_BY_ID[sel.tires] || st) : st;
  const brakePart = sel.brakes ? PART_BY_ID[sel.brakes] : null;
  if (!wheel.bolts.includes(car.wheel.bolt) && !fab.has('hub')) add('error', 'wheels', `Bolt pattern ${wheel.bolts.length > 3 ? 'options' : wheel.bolts.join('/')} don't include ${car.wheel.bolt} — needs a hub / bolt-pattern conversion`);
  const minDia = Math.max(car.wheel.min, brakePart?.brake.minWheel || 0);
  if (wheel.dia < car.wheel.min) add('error', 'wheels', `${wheel.dia}" won't clear the ${car.model}'s brakes (min ${car.wheel.min}")`);
  else if (wheel.dia < minDia) add('error', 'brakes', `${brakePart.name} needs ${brakePart.brake.minWheel}"+ wheels (you have ${wheel.dia}")`);
  if (wheel.dia > car.wheel.max + 1) add('error', 'wheels', `${wheel.dia}" is too large for the ${car.model} (max ~${car.wheel.max}")`);
  else if (wheel.dia > car.wheel.max) add('warn', 'wheels', `${wheel.dia}" is above the usual max (${car.wheel.max}") — needs very low profile tires`);
  if (wheel.truck && car.body !== 'truck') add('error', 'wheels', 'Truck wheel — wrong offset/load rating for a car');

  if (tire.rim !== wheel.dia) {
    add('error', 'tires', `${tire.stock ? 'Stock tires' : 'Tires'} are R${tire.rim} but wheels are ${wheel.dia}" — choose matching tires`);
  }
  const wmm = wheel.width * 25.4;
  {
    // a rim so wide that the narrowest safe tire for it can't fit under the car's fenders
    const maxT = car.wheel.maxTire + parts.reduce((s, p) => s + (p.tireBonus || 0), 0) + (sel.suspension && PART_BY_ID[sel.suspension]?.rideDrop < 0 ? 20 : 0);
    if (wmm - 5 > maxT + 10) add('error', 'wheels', `${wheel.width}" wide rim needs ${Math.ceil((wmm - 5) / 5) * 5}mm+ tires — the ${car.model} only fits ~${maxT}mm${maxT === car.wheel.maxTire ? ' (a widebody kit or fender work makes room)' : ''}`);
  }
  if (tire.width < wmm - 5) add('error', 'tires', `${tire.width}mm tire is too narrow for a ${wheel.width}" rim (unsafe stretch)`);
  else if (tire.width > wmm + (tire.aspect >= 60 ? 110 : 65)) add('error', 'tires', `${tire.width}mm tire is too wide for a ${wheel.width}" rim`);
  const susp = sel.suspension ? PART_BY_ID[sel.suspension] : null;
  const lifted = susp && susp.rideDrop < 0;
  const maxTire = car.wheel.maxTire + parts.reduce((s, p) => s + (p.tireBonus || 0), 0) + (lifted ? 20 : 0);
  if (tire.width > maxTire + 10) add('error', 'tires', `${tire.width}mm won't fit under the fenders (max ~${maxTire}mm${maxTire === car.wheel.maxTire ? ' — try a widebody kit or cut & flared fenders' : ''})`);
  else if (tire.width > maxTire) add('warn', 'tires', `${tire.width}mm may rub at full lock (max ~${maxTire}mm) — a fender roll fixes it`);
  const dRatio = tire.dia / st.dia - 1;
  const dLim = lifted ? 0.18 : 0.08;
  if (Math.abs(dRatio) > dLim) add('error', 'tires', `Tire diameter ${tire.dia.toFixed(1)}" is ${(dRatio * 100).toFixed(0)}% off stock (${st.dia.toFixed(1)}") — clearance/ABS problems`);
  else if (Math.abs(dRatio) > 0.035 && !lifted) add('warn', 'tires', `Tire diameter ${(dRatio * 100).toFixed(1)}% off stock — speedometer error`);
  if (tire.model === 'slick') add('warn', 'tires', 'Slicks are not street legal');
  if (tire.model === 'ko2' && car.body !== 'truck') add('warn', 'tires', 'All-terrain tires on a car — low grip, heavy');

  // ----- aero -----
  const wingScale = 0.55 + 0.9 * (sel.tuning?.wingAngle ?? 0.5);
  let cd = car.aero.cd, clF = car.aero.cl * 0.45, clR = car.aero.cl * 0.55;
  for (const p of parts) {
    const k = p.wing ? wingScale : 1;
    cd += (p.cd || 0) * (p.wing ? (0.4 + 1.2 * (sel.tuning?.wingAngle ?? 0.5)) : 1);
    clF += (p.clF || 0); clR += (p.clR || 0) * k;
  }
  const adjustableSusp = !!susp?.adjustable;
  // height adjuster: T.rideH raises (+) or lowers (−) from the part's nominal height, within the part's range
  const rideRange = adjustableSusp ? (susp.rideRange || [-30, 30]) : null;
  const rideAdj = adjustableSusp ? Math.max(-rideRange[1], Math.min(rideRange[0] * -1, Math.round(T.rideH))) : 0;
  const drop = (susp ? susp.rideDrop : 0) - rideAdj;
  if (adjustableSusp && drop > 60) add('warn', 'suspension', `Slammed ${drop} mm: bottoms out over kerbs and bumps`);
  // lowering reduces lift / increases ground effect
  clF -= drop * 0.0012; clR -= drop * 0.0010; cd -= Math.max(0, drop) * 0.00015; cd += Math.max(0, -drop) * 0.0004;
  const front = parts.find(p => p.cat === 'aero_front');
  if (!front && parts.some(p => p.wing && p.clR < -0.2)) add('warn', 'aero_front', 'Big rear wing without front aero — high-speed understeer');

  // ----- mass & balance -----
  const posF = { f: 0.92, r: 0.08, c: 0.5 };
  let mass = car.mass, mF = car.mass * car.wdF;
  const addMass = (m, f) => { mass += m; mF += m * f; };
  const engF = car.layout === 'F' ? 0.95 : car.layout === 'M' ? 0.15 : -0.05;
  addMass(eng.mass - car.engine.mass, eng.cfg === 'EV' && car.engine.cfg !== 'EV' ? 0.45 : engF);
  for (const p of parts) if (p.mass) addMass(p.mass, posF[p.pos || 'c']);
  addMass(((wheel.wheelMass - sw.wheelMass) + (tire.tireMass - st.tireMass)) * 4, 0.5);
  const wdF = mF / mass;
  let cgH = BODY_CG[car.body] - drop / 1000 * 0.85 + parts.reduce((s, p) => s + (p.cgUp || 0), 0);

  // ----- chassis -----
  const grip = 1 + parts.reduce((s, p) => s + (p.grip || 0), 0);
  const adjustable = !!(susp?.adjustable) || has(p => p.swayBars);
  const rollBase = drive === 'FWD' ? 0.56 : drive === 'AWD' ? 0.53 : 0.50;
  const rollF = rollBase + (adjustable ? (sel.tuning?.rollBal || 0) * 0.12 : 0);
  let lsd = sel.diff ? PART_BY_ID[sel.diff].lsd : (drive === 'AWD' ? { lock: 0.25, preload: 30 } : { lock: 0.08, preload: 0 });
  // adjustable LSD: the diff lock slider scales its lock (0.5 = as delivered)
  if (sel.diff && sel.diff !== 'spool') { const k = 0.4 + 1.2 * Math.max(0, Math.min(1, T.diffLock)); lsd = { lock: Math.min(0.95, lsd.lock * k), preload: lsd.preload * k }; }
  // steering hardware
  const steer = { lock: 0.62, gain: 1, rate: 1 };
  for (const p of parts) if (p.steer) { if (p.steer.lock) steer.lock = Math.max(steer.lock, p.steer.lock); steer.gain *= p.steer.gain || 1; steer.rate *= p.steer.rate || 1; }

  // tire physics
  const R = tire.dia * 0.0254 / 2;
  const wheelI = (wheel.wheelMass * 0.55 * Math.pow(wheel.dia * 0.0254 / 2, 2)) + tire.tireMass * 0.8 * R * R;
  const widthF = Math.pow(tire.width / 235, 0.08);
  const tireSpec = {
    // tires grip ~10% more longitudinally than laterally
    mu: tire.mu * grip * widthF, lat: tire.lat, lng: tire.lng * 1.1, kp: tire.kp, ap: tire.ap, rr: tire.rr, R, I: wheelI + 0.25,
    width: tire.width, name: tire.name,
  };
  // per-axle setup: pressure (best ~31 psi hot; low = lazy + more rolling resistance, high = sharp but less grip),
  // camber (lateral grip peaks around -2.5°, braking/traction fall off with it), toe (front toe-out = sharper turn-in,
  // rear toe-in = stable rear), spring rate (stiffer = sharper response, less mechanical grip away from ~stock)
  const spr = adjustableSusp ? Math.max(0.6, Math.min(1.5, T.springs)) : 1;
  const camLim = (has(p => p.camberKit) || adjustableSusp) ? [-4, 0] : [-1.8, -0.3];
  const axle = (press, cam, toe, front) => {
    const c = Math.abs(Math.max(camLim[0], Math.min(camLim[1], cam)));
    const pG = 1 - 0.0018 * (press - 31) ** 2;
    const lat = (1 + 0.04 * c - 0.008 * c * c) * (front ? 1 : 1 + 0.06 * toe) * (1 - 0.04 * (spr - 1) ** 2);
    const lng = 1 - 0.012 * c - 0.004 * c * c;
    return { ...tireSpec, mu: tireSpec.mu * pG, lat: tireSpec.lat * lat, lng: tireSpec.lng * lng,
      ap: tireSpec.ap * (1 + 0.02 * (31 - press)) * (1 - 0.08 * (spr - 1)), rr: tireSpec.rr * (1 + 0.03 * (31 - press)) * (1 + 0.15 * Math.abs(toe)) };
  };
  const tireF = axle(T.pressF, T.camberF, T.toeF, true), tireR = axle(T.pressR, T.camberR, T.toeR, false);
  steer.gain *= 1 + 0.5 * Math.max(-0.4, Math.min(0.4, -T.toeF));   // toe-out sharpens turn-in
  if (T.toeR < -0.05) add('warn', 'suspension', 'Rear toe-out: twitchy, the rear steps out on lift-off');

  const brake = brakePart?.brake || { torque: 1, fade: 0 };
  const shiftTime = Math.max(0.03, (transPart?.shiftTime ?? trans.swapShift ?? SHIFT[trans.type] ?? 0.2) + parts.reduce((s, p) => s + (p.shiftDelta || 0), 0));
  const finalMul = sel.final ? PART_BY_ID[sel.final].finalMul : 1;
  let inertia = ENGINE_INERTIA[eng.cfg] || 0.15;
  for (const p of parts) if (p.inertiaMul) inertia *= p.inertiaMul;
  if (isEV) inertia = ENGINE_INERTIA.EV;

  // ----- price -----
  const partsPrice = parts.reduce((s, p) => s + p.price, 0) + swapPrice + (sel.wheels ? wheel.price : 0) + (sel.tires ? tire.price : 0);
  const errors = issues.filter(i => i.level === 'error').length;
  const warns = issues.filter(i => i.level === 'warn').length;

  const L = car.wb, a = L * (1 - wdF), b = L * wdF;
  const layoutIz = car.layout === 'M' ? 0.88 : car.layout === 'R' ? 0.95 : 1.0;
  // fender flares / widebody: the wheels are spaced out to fill the wider arches (wider track)
  const flare = parts.reduce((m, p) => Math.max(m, p.flare || 0), 0);
  return {
    sel, car, issues, errors, warns,
    carPrice: car.price, partsPrice, totalPrice: car.price + partsPrice,
    engine: { name: eng.name, code: eng.code, cfg: eng.cfg, cyl: CYLS[eng.cfg], asp: eng.asp, hp, tq, redline: eng.redline, spool, blower: fi?.fi.kind || (eng.asp === 'sc' ? 'roots' : null), inertia, baseHp: car.engine.hp, swapped: !!swapped },
    trans: { type: trans.type, gears: trans.gears, final: trans.final * finalMul, shiftTime, rating, eff: trans.type === 'EV' ? 0.92 : trans.type === 'AT' ? 0.85 : 0.87 },
    drive, awdSplit, lockedCentre, steer,
    mass, wdF, cgH, L, a, b, track: car.W * 0.85 + 2 * flare, flare, Iz: mass * a * b * layoutIz * 1.05,
    tire: tireSpec, tireF, tireR, wheel, tireItem: tire, adjustableSusp, rideRange, rideNom: susp ? susp.rideDrop : 0, boostTune,
    // real-world drag: cooling flow, wheels, mirrors + induced drag from downforce
    aero: { cd: Math.max(0.18, cd * 1.08 + 0.1 * Math.max(0, -(clF + clR))), A: car.aero.A * (has(p => p.id === 'widebody') ? 1.04 : 1) * (lifted ? 1.06 : 1), clF, clR },
    brakes: { torque: brake.torque, fadeTemp: 560 + brake.fade, caliper: brake.caliper, bias: sel.tuning?.brakeBias ?? 0.65, heatCap: 2600 * (1 + brake.fade / 260) },
    lsd, rollF, adjustable, rideDrop: drop, grip,
    hasLaunch: has(p => p.launch),
    parts, swapped,
    hasWing: parts.find(p => p.wing),
  };
}

// count how many issues are attributed to a category
export function issuesFor(spec, cat) { return spec.issues.filter(i => i.cat === cat && i.level !== 'ok'); }

// Tires that go with a wheel choice (what the app installs automatically when the wheels change).
// Returns the tire id to use (null = stock tires), or undefined when no tire size fits that wheel on this car.
export function matchTires(sel) {
  const car = CAR_BY_ID[sel.car];
  const wheel = sel.wheels ? WHEEL_BY_ID[sel.wheels] : stockWheel(car);
  const cur = sel.tires ? TIRE_BY_ID[sel.tires] : stockTire(car);
  if (!sel.wheels && !sel.tires) return null;
  if (cur.rim === wheel.dia && cur.width >= wheel.width * 25.4 - 5 && cur.width <= wheel.width * 25.4 + 65) return sel.tires;
  if (!sel.wheels && cur.rim !== car.wheel.dia) return null;
  const stockD = stockTire(car).dia;
  const model = cur.stock ? (car.body === 'truck' ? 'ko2' : car.tireMu >= 1 ? 'ps4s' : 'dws06') : cur.model;
  const bonus = (sel.body || []).concat(sel.weight || [], sel.chassis || []).reduce((s, id) => s + (PART_BY_ID[id]?.tireBonus || 0), 0);
  const maxW = car.wheel.maxTire + bonus;
  const fits = t => t.rim === wheel.dia && t.width >= wheel.width * 25.4 - 5 && t.width <= Math.min(wheel.width * 25.4 + 55, maxW) && Math.abs(t.dia / stockD - 1) <= 0.08 && !(t.model === 'ko2' && car.body !== 'truck');
  let cands = TIRE_LIST().filter(t => t.model === model && fits(t));
  if (!cands.length) cands = TIRE_LIST().filter(fits);
  if (!cands.length) return undefined;
  const target = Math.min(Math.max(cur.width, wheel.width * 25.4 + 15), maxW);
  cands.sort((a, b) => (Math.abs(a.dia - stockD) * 30 + Math.abs(a.width - target) / 10) - (Math.abs(b.dia - stockD) * 30 + Math.abs(b.width - target) / 10));
  return cands[0].id;
}
const TIRE_LIST = () => Object.values(TIRE_BY_ID);

// Evaluate a candidate part in context: returns {level, msgs, spec, sel}.
// A part is an 'error' (not installable) when it has an error itself, or when it would break something else in the
// build that currently works (e.g. wheels no tire size fits, a turbo the fuel system can't feed).
const baseCache = { key: null, errs: null };
const errKey = i => i.cat + '|' + i.msg.replace(/[\d.,]+/g, '#');   // same problem, different numbers = not new
export function candidateCheck(sel, cat, id, baseSel = sel) {
  const s2 = { ...sel };
  const c = CAT_BY_ID[cat];
  if (c.multi) s2[cat] = [...(sel[cat] || []), id];
  else s2[cat] = id;
  let noTire = false;
  if (cat === 'wheels') { const t = matchTires(s2); if (t === undefined) noTire = true; else s2.tires = t; }
  const spec = evaluate(s2);
  const key = JSON.stringify(baseSel);
  if (baseCache.key !== key) { baseCache.key = key; baseCache.errs = new Set(evaluate(baseSel).issues.filter(i => i.level === 'error').map(errKey)); }
  const own = i => i.cat === cat || (cat === 'wheels' && (i.cat === 'brakes' || i.cat === 'tires')) || (cat === 'brakes' && i.cat === 'wheels');
  const msgs = [], seen = new Set();
  let level = 'ok';
  for (const i of spec.issues) {
    if (i.level === 'ok') continue;
    const fresh = !baseCache.errs.has(errKey(i));
    if (i.level === 'error' && (own(i) || fresh)) { level = 'error'; }
    else if (!own(i) && !(i.level === 'warn' && fresh)) continue;
    else if (level !== 'error') level = 'warn';
    if (!seen.has(i.msg)) { seen.add(i.msg); msgs.push(own(i) ? i.msg : `${CAT_BY_ID[i.cat]?.name || i.cat}: ${i.msg}`); }
  }
  if (noTire) { level = 'error'; msgs.unshift(`No tire size fits a ${WHEEL_BY_ID[id]?.width}" wide ${WHEEL_BY_ID[id]?.dia}" wheel on this car`); }
  return { level, msgs, spec, sel: s2 };
}

// A part that only fails because supporting mods are missing (fuel system, intercooler, clutch, internals...):
// find the cheapest set of parts that makes it work. Returns { needs: [ids], spec } or null when no parts fix it.
const SUPPORT_CATS = ['fuel', 'cooling', 'trans', 'internals', 'ecu', 'gearbox'];
export function resolveNeeds(sel, cat, id) {
  let s2 = { ...sel, tuning: { ...sel.tuning } };
  const needs = [];
  // a part that needs another one first (billet housings → studded housings → apex seals) brings that chain with it
  const add = (sx, pid) => { const p = PART_BY_ID[pid], c = CAT_BY_ID[p.cat]; let o = { ...sx }; o[p.cat] = c.multi ? [...new Set([...(sx[p.cat] || []), pid])] : pid; if (p.needsPart && !(o[PART_BY_ID[p.needsPart].cat] || []).includes(p.needsPart)) o = add(o, p.needsPart); return o; };
  // errors left (+ the part's own missing requirements weigh a little more, so fixing one that exposes the next counts)
  const score = sx => { const r = candidateCheck(sx, cat, id, sel); if (r.level !== 'error') return [0, r]; const e = r.spec.issues.filter(i => i.level === 'error'); return [e.length + 1 + 0.5 * e.filter(i => i.cat === cat).length, r]; };
  let [cur, r] = score(s2);
  for (let iter = 0; iter < 6 && cur > 0; iter++) {
    let best = null;
    for (const c of SUPPORT_CATS) {
      if (c === cat) continue;
      const cands = PARTS_BY_CAT(c).filter(p => !(CAT_BY_ID[c].multi ? (s2[c] || []).includes(p.id) : s2[c] === p.id)).sort((a, b) => a.price - b.price);
      for (const p of cands) {
        if (!CAT_BY_ID[c].multi && s2[c] && needs.includes(s2[c]) === false && s2[c]) continue;   // never replace a part the user chose
        const t = add(s2, p.id), [sc, rt] = score(t);
        if (rt.spec.issues.some(i => i.level === 'error' && i.msg.startsWith(p.name + ':'))) continue;   // that part doesn't fit itself
        if (sc < cur && (!best || sc < best.sc || (sc === best.sc && p.price < best.p.price))) best = { sc, p, t };
        if (sc < cur) break;   // cheapest improvement in this category
      }
    }
    if (!best) return null;
    const inSel = (sx, q) => { const v = sx[PART_BY_ID[q].cat]; return Array.isArray(v) ? v.includes(q) : v === q; };
    for (let q = best.p.id; q && !needs.includes(q) && !inSel(s2, q); q = PART_BY_ID[q].needsPart) needs.push(q);
    s2 = best.t; [cur, r] = score(s2);
  }
  if (cur > 0) return null;
  return { needs, spec: r.spec, sel: s2 };
}
const _byCat = new Map();
function PARTS_BY_CAT(c) { if (!_byCat.has(c)) _byCat.set(c, Object.values(PART_BY_ID).filter(p => p.cat === c)); return _byCat.get(c); }

export { tireDiaIn };
