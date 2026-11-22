// Interactive chassis-dyno pull: the engine sweeps from low rpm to the rev limiter (rate follows torque, like an
// inertia dyno), the hp / torque curves are drawn live against the stock car, with the engine's own sound (js/sound.js).
import { dynoCurve, makeEngine } from './physics.js';
import { EngineSound, loopHum } from './sound.js';

const LOSS = { FWD: 0.12, RWD: 0.15, AWD: 0.2 };
export class DynoRun {
  constructor(cv, readout) { this.cv = cv; this.out = readout; this.raf = 0; this.audio = null; }
  setup(spec, stock, sound) {
    this.stop();
    this.spec = spec; this.stock = stock; this.sound = sound;
    this.cur = dynoCurve(spec); this.base = dynoCurve(stock);
    this.eng = makeEngine(spec.engine);
    this.loss = spec.engine.cfg === 'EV' ? 0.08 : LOSS[spec.drive] ?? 0.15;
    this.rpm = 0; this.trace = []; this.done = false;
    this.draw();
  }
  start() {
    this.stop();
    const e = this.eng, red = e.redline, start = e.ev ? 0 : Math.max(1500, red * 0.2);
    this.rpm = start; this.trace = []; this.done = false;
    const peak = Math.max(...this.cur.map(p => p.tq));
    const dur = 7.5; // seconds for a full sweep at peak torque
    if (this.sound) this.startSound();
    let last = performance.now(), hold = 0;
    const tick = now => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (!this.done) {
        const tq = e.torque(this.rpm);
        this.rpm += (red - start) / dur * Math.max(0.25, tq / peak) * dt;
        this.trace.push({ rpm: this.rpm, tq, hp: tq * this.rpm * Math.PI / 30 / 745.7 });
        if (this.rpm >= red) { this.rpm = red; this.done = true; }
      } else { hold += dt; this.rpm = Math.max(e.idle, this.rpm - red * dt * 0.9); }
      this.updSound();
      this.draw();
      if (hold < 1.6) this.raf = requestAnimationFrame(tick); else { this.stopSound(); this.raf = 0; }
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop() { cancelAnimationFrame(this.raf); this.raf = 0; this.stopSound(); }
  startSound() {
    try {
      this.audio = new EngineSound(); this.audio.setSpec(this.spec);
      this.hum = loopHum('roller');
    } catch (e) { this.audio = null; }
  }
  updSound() {
    if (!this.audio) return;
    // full throttle on the pull, lift (pops / blow-off) once it hits the limiter
    this.audio.update(this.rpm, this.done ? 0 : 1, { vol: 0.9, dt: 1 / 60 });
    this.hum?.set(Math.min(1, this.rpm / this.eng.redline));
  }
  stopSound() { this.audio?.stop(); this.audio = null; this.hum?.stop(); this.hum = null; }

  draw() {
    const cv = this.cv, g = cv.getContext('2d'), dpr = Math.min(2, devicePixelRatio || 1);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0f1218'; g.fillRect(0, 0, W, H);
    const cur = this.cur, base = this.base, red = this.eng.redline;
    const maxR = Math.max(red, this.stock.engine.redline);
    const maxHp = Math.max(...cur.map(p => p.hp), ...base.map(p => p.hp)) * 1.15;
    const maxTq = Math.max(...cur.map(p => p.tq), ...base.map(p => p.tq)) * 1.15;
    const L = 56, R = 56, T = 20, B = 36;
    const X = r => L + r / maxR * (W - L - R), Yh = v => H - B - v / maxHp * (H - T - B), Yt = v => H - B - v / maxTq * (H - T - B);
    g.font = '12px system-ui'; g.lineWidth = 1;
    const stepR = maxR > 12000 ? 2000 : 1000;
    for (let r = 0; r <= maxR; r += stepR) { g.strokeStyle = '#232835'; g.beginPath(); g.moveTo(X(r), T); g.lineTo(X(r), H - B); g.stroke(); g.fillStyle = '#8b93a5'; g.fillText(r / 1000 + 'k', X(r) - 8, H - B + 16); }
    for (let i = 0; i <= 5; i++) {
      const y = T + (H - T - B) * i / 5; g.strokeStyle = '#1d2230'; g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
      g.fillStyle = '#ff5a1f'; g.fillText(Math.round(maxHp * (1 - i / 5)), 10, y + 4);
      g.fillStyle = '#3fa9f5'; g.fillText(Math.round(maxTq * (1 - i / 5)), W - R + 8, y + 4);
    }
    g.fillStyle = '#8b93a5'; g.fillText('rpm', W / 2 - 10, H - 6); g.fillText('hp', 10, 12); g.fillText('Nm', W - R + 8, 12);
    const line = (pts, key, Y, color, w, dash) => { if (!pts.length) return; g.setLineDash(dash ? [5, 5] : []); g.strokeStyle = color; g.lineWidth = w; g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(X(p.rpm), Y(p[key])) : g.moveTo(X(p.rpm), Y(p[key]))); g.stroke(); };
    line(base, 'hp', Yh, '#ff5a1f66', 1.5, true); line(base, 'tq', Yt, '#3fa9f566', 1.5, true);
    const live = this.trace.length ? this.trace : (this.raf ? [] : cur);
    line(live, 'hp', Yh, '#ff5a1f', 3); line(live, 'tq', Yt, '#3fa9f5', 3);
    g.setLineDash([]);
    // rpm marker
    if (this.raf && this.rpm > 0) { g.strokeStyle = '#ffffff55'; g.beginPath(); g.moveTo(X(this.rpm), T); g.lineTo(X(this.rpm), H - B); g.stroke(); }
    // redline band
    g.fillStyle = '#ff475722'; g.fillRect(X(red), T, Math.max(0, X(maxR) - X(red)) + 4, H - T - B);
    const pk = (pts, k) => pts.reduce((a, p) => p[k] > a[k] ? p : a, { [k]: 0, rpm: 0 });
    const src = this.trace.length ? this.trace : cur, ph = pk(src, 'hp'), pt = pk(src, 'tq'), sh = pk(base, 'hp');
    const now = this.trace.length ? this.trace[this.trace.length - 1] : null;
    this.out.innerHTML = `
      <div><b style="color:var(--acc)">${Math.round(ph.hp)}</b> hp <small>@ ${Math.round(ph.rpm / 100) * 100} rpm</small><span>crank</span></div>
      <div><b>${Math.round(ph.hp * (1 - this.loss))}</b> whp <small>${Math.round(this.loss * 100)}% driveline loss</small><span>at the wheels</span></div>
      <div><b style="color:var(--blue)">${Math.round(pt.tq)}</b> Nm <small>${Math.round(pt.tq * 0.7376)} lb-ft @ ${Math.round(pt.rpm / 100) * 100}</small><span>torque</span></div>
      <div><b>${ph.hp - sh.hp >= 0 ? '+' : ''}${Math.round(ph.hp - sh.hp)}</b> hp <small>vs stock ${Math.round(sh.hp)}</small><span>gain</span></div>
      <div><b>${Math.round(this.rpm || 0)}</b> <small>${now ? Math.round(now.hp) + ' hp now' : 'ready'}</small><span>rpm</span></div>`;
  }
}
