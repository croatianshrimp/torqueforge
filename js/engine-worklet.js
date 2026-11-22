// Engine sound synthesis (AudioWorklet). Every cylinder fires at its real crank angle; each firing is a sharp pressure
// pulse that rings through the exhaust bank it belongs to (two resonances + a muffler low-pass + saturation), plus
// combustion noise, intake roar, overrun pops / bangs and a rev-limiter cut. The character comes from the firing
// pattern: cross-plane V8 banks fire unevenly (burble), unequal-length boxer headers bunch pulses (rumble), flat-plane
// V8s / V10s / V12s fire evenly per bank (scream), rotaries fire short and hard (brap), small cylinder-to-cylinder
// imbalances give the cycle-rate "lope" every real engine has.
const TAU = Math.PI * 2;

class BQ {
  constructor() { this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = this.z1 = this.z2 = 0; }
  set(type, f, Q) {
    f = Math.max(10, Math.min(f, sampleRate * 0.45));
    const w = TAU * f / sampleRate, c = Math.cos(w), s = Math.sin(w), al = s / (2 * Q), a0 = 1 + al;
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    else { b0 = al; b1 = 0; b2 = -al; }   // band-pass, 0 dB peak
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
    return this;
  }
  run(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
}

class EngineSynth extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 900, minValue: 0, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'gain', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.p = null; this.phase = 0; this.next = 0; this.cut = 0; this.seed = 22222; this.popEnv = 0; this.popAmp = 0;
    this.lpRpm = -1; this.lpLoad = -1; this.env = 0; this.cycleN = 0;
    this.dc = [new BQ().set('hp', 28, 0.7), new BQ().set('hp', 28, 0.7)];
    this.popBq = new BQ().set('bp', 900, 0.8); this.thumpBq = new BQ().set('lp', 140, 0.9);
    this.port.onmessage = e => {
      const d = e.data;
      if (d.type === 'profile') this.setProfile(d.p);
      else if (d.type === 'shift') { this.cut = Math.round(d.cut * sampleRate); if (d.crack) this.pop(1.4); }
      else if (d.type === 'pop') this.pop(d.amp || 1);
    };
  }
  rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }
  setProfile(p) {
    this.p = p;
    const order = p.fire.map((f, i) => ({ ...f, i })).sort((a, b) => a.a - b.a);
    this.order = order; this.next = 0; this.phase = 0;
    // fixed per-cylinder imbalance (each cylinder a little different, like a real engine)
    this.imb = order.map(() => (this.rnd() * 2 - 1));
    this.banks = p.banks.map(b => ({
      ...b, pulses: [],
      r1: new BQ().set('bp', b.f1, b.q1), r2: new BQ().set('bp', b.f2, b.q2), lp: new BQ(), lp2: new BQ(), nHp: new BQ().set('hp', 1800, 0.7), env: 0,
    }));
    this.intake = new BQ().set('bp', p.intake.f, p.intake.q);
    this.intake2 = new BQ().set('bp', p.intake.f * 2.1, p.intake.q);
    this.clatter = new BQ().set('hp', 2500, 0.7);
    this.lpRpm = -1;
  }
  pop(amp) { this.popEnv = 1; this.popAmp = amp * (0.6 + this.rnd() * 0.8); }
  fire(k, rpm, load) {
    const p = this.p, f = this.order[k];
    if (this.cut > 0) return;
    // rev limiter: hard cut most firings (+ the odd bang)
    if (rpm > p.redline * 0.985 && load > 0.3) { if (this.rnd() < 0.6) { if (this.rnd() < p.pops * 2) this.pop(0.8); return; } }
    let lvl = load > 0.04 ? 0.28 + 0.72 * load : rpm < 1400 ? 0.4 : 0.1;   // idle keeps firing properly; overrun is quiet
    // overrun: crackles and pops from unburnt fuel (more with a tune / free-flowing exhaust)
    if (load < 0.04 && rpm > 2600 && this.rnd() < p.pops * Math.min(1, (rpm - 2600) / 2500)) this.pop(0.5 + this.rnd() * 0.7);
    let amp = f.amp * lvl * (1 + p.imb * (1 + (rpm < 1600 ? p.idleImb : 0)) * this.imb[k]);
    // cam lope at low rpm: uneven, lumpy idle
    if (p.lope > 0 && rpm < 2600) amp *= 1 + p.lope * (this.rnd() * 2 - 1) * (1 - rpm / 2600);
    // rotary / big-cam misfire-ish chop at idle
    if (p.chop > 0 && rpm < 2000 && this.rnd() < p.chop * (1 - rpm / 2000)) amp *= 0.25;
    const bank = this.banks[f.bank % this.banks.length];
    if (bank.pulses.length < 8) bank.pulses.push({ t: -Math.round((bank.dly || 0) * sampleRate / 1000), amp, cl: p.clatter > 0 ? 1 : 0 });
  }
  process(_, outputs, params) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    const p = this.p;
    if (!p) { L.fill(0); if (R !== L) R.fill(0); return true; }
    const rpm = Math.max(0, params.rpm[0]), load = params.load[0], gain = params.gain[0];
    const n = L.length, sr = sampleRate;
    // per-block filter updates (muffler opens up with load and rpm)
    if (Math.abs(rpm - this.lpRpm) > 40 || Math.abs(load - this.lpLoad) > 0.03) {
      this.lpRpm = rpm; this.lpLoad = load;
      const vt = p.vtec && rpm > p.vtec ? 1 : 0;
      for (const b of this.banks) {
        const fc = b.lp0 * (0.45 + 0.55 * load) * (1 + rpm / 9000) * (1 + vt * 0.25);
        b.lp.set('lp', fc, 0.75); b.lp2.set('lp', fc * 1.6, 0.6);
      }
      this.vt = vt;
    }
    const cyc = p.cycle, dphi = rpm * 6 / sr;   // crank degrees per sample
    const interval = rpm > 0 ? (cyc / p.fire.length) / (rpm * 6) : 0.05;   // seconds between firings
    const dec = Math.min(p.pw / 1000, interval * 0.3) * sr, rise = 0.00025 * sr;
    const ord = this.order, N = ord.length;
    const g = gain * p.vol;
    const ig = p.intake.g * (0.15 + 0.85 * load) * (this.vt ? 2.2 : 1) * Math.min(1.5, rpm / 4000);
    for (let i = 0; i < n; i++) {
      // advance the crank and fire any cylinder whose angle we passed
      if (this.cut > 0) this.cut--;
      this.phase += dphi;
      let guard = 0;
      while (guard++ < N && this.phase >= (this.next < N ? ord[this.next].a : cyc)) {
        if (this.next < N) { this.fire(this.next, rpm, load); this.next++; }
        else { this.phase -= cyc; this.next = 0; }
      }
      if (this.phase >= cyc) { this.phase -= cyc; this.next = 0; }
      let l = 0, r = 0, envAll = 0;
      for (const b of this.banks) {
        let e = 0, cl = 0;
        const ps = b.pulses;
        for (let j = ps.length - 1; j >= 0; j--) {
          const q = ps[j]; const t = q.t++;
          if (t < 0) continue;
          if (t < rise) e += q.amp * t / rise;
          else { const x = (t - rise) / dec; if (x > 7) { ps.splice(j, 1); continue; } e += q.amp * Math.exp(-x); }
          if (q.cl && t < 0.0006 * sr) cl += q.amp;
        }
        b.env += (Math.abs(e) - b.env) * 0.004;
        envAll += b.env;
        const nz = (this.rnd() * 2 - 1);
        const ex = e + nz * b.env * p.noise;
        let y = e * p.body + b.r1.run(ex) * b.g1 + b.r2.run(ex) * b.g2;
        y += b.nHp.run(nz) * b.env * p.hiss;
        if (cl) y += this.clatter.run(nz) * cl * p.clatter;
        y = Math.tanh(y * p.drive);
        y = b.lp2.run(b.lp.run(y));
        const bk = b.k ?? 1; l += y * b.panL * bk; r += y * b.panR * bk;
      }
      // intake / induction roar
      const nz2 = this.rnd() * 2 - 1;
      const ia = (this.intake.run(nz2) + 0.5 * this.intake2.run(nz2)) * envAll * ig;
      l += ia; r += ia;
      // pops / bangs (bright crack + low thump)
      if (this.popEnv > 0.001) {
        const nz3 = this.rnd() * 2 - 1;
        const pv = (this.popBq.run(nz3) * 2.2 + this.thumpBq.run(nz3) * 6) * this.popEnv * this.popAmp * p.popVol;
        this.popEnv *= Math.exp(-1 / (0.012 * sr));
        l += pv; r += pv;
      }
      L[i] = this.dc[0].run(l) * g;
      if (R !== L) R[i] = this.dc[1].run(r) * g;
    }
    return true;
  }
}
registerProcessor('engine-synth', EngineSynth);
