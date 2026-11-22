// Online multiplayer (peer-to-peer over WebRTC, PeerJS public signalling server; no game server of our own).
// Star topology: the host relays everything. Each player simulates their own car and sends its state at 20 Hz;
// other cars are shown ~100 ms in the past, interpolated, and are solid (local car bounces off them).
import { evaluate, migrateSel } from './build.js';
import { createCarModel, disposeModel } from './model.js';
import { loadCarAsset, getCarAsset, hasRealModel } from './carassets.js';
import { current as gfxQ } from './gfx.js';
import { TRACKS, nearest, poseOnGround } from './track.js';
import { RaceControl, fmtRace } from './race.js';
import { collideKinematic } from './collide.js';
import { getRules, setRules, ruleViolations, rulesText, perfIndex, piBadge } from './pi.js';

const $ = s => document.querySelector(s);
const PREFIX = 'torqueforge-v1-';
const SEND_HZ = 20, DELAY = 0.1;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cleanName = s => String(s || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').slice(0, 18) || 'Driver';

function loadPeer() {
  if (window.Peer) return Promise.resolve(window.Peer);
  return new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'vendor/peerjs.min.js'; sc.onload = () => res(window.Peer); sc.onerror = rej; document.head.appendChild(sc); });
}

export class Net {
  constructor(drive) {
    this.d = drive; this.peer = null; this.conns = new Map(); this.host = false; this.code = null;
    this.myId = null; this.players = new Map();     // id -> { id, name, sel, spec, ready, entry, buf: [] }
    this.settings = { track: drive.T.id, mode: 'race', laps: 3, minutes: 5, rules: getRules() };
    this.race = null; this.sendT = 0; this.clock = 0; this.status = '';
    this.name = localStorage.getItem('tf_name') || 'Driver ' + Math.floor(100 + Math.random() * 900);
    this.render();
  }
  get me() { return this.players.get(this.myId); }

  // ---------------- connection ----------------
  async hostGame() {
    const Peer = await loadPeer();
    this.leave(false);
    this.host = true;
    const tryOpen = () => new Promise((res, rej) => {
      this.code = Array.from({ length: 5 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
      const p = new Peer(PREFIX + this.code);
      p.on('open', id => res(p)); p.on('error', e => { p.destroy(); rej(e); });
    });
    this.setStatus('Opening room…');
    let p = null;
    for (let i = 0; i < 3 && !p; i++) p = await tryOpen().catch(e => (this.setStatus('Could not open a room: ' + (e.type || e.message)), null));
    if (!p) return;
    this.peer = p; this.myId = p.id;
    p.on('connection', c => this.accept(c));
    p.on('disconnected', () => p.reconnect());
    this.addSelf();
    this.settings.track = this.d.T.id; this.settings.rules = getRules();
    this.setStatus('Room open — share the code with your friends.');
    this.broadcastLobby();
  }
  async joinGame(code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 5) { this.setStatus('Room codes are 5 letters.'); return; }
    const Peer = await loadPeer();
    this.leave(false);
    this.host = false; this.code = code;
    this.setStatus('Connecting to ' + code + '…');
    const p = this.peer = new Peer();
    p.on('error', e => this.setStatus(e.type === 'peer-unavailable' ? `No room called ${code}.` : 'Connection error: ' + (e.type || e.message)));
    p.on('open', id => {
      this.myId = id;
      const c = p.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      c.on('open', () => { this.conns.set('host', c); this.addSelf(); this.send(c, { t: 'hello', name: this.name, sel: this.mySel() }); this.setStatus('Connected to room ' + code); });
      c.on('data', m => this.onMsg(m, c));
      c.on('close', () => { this.setStatus('Host left the room.'); this.leave(false); });
    });
  }
  accept(c) {
    if (this.players.size >= 8) { c.on('open', () => { this.send(c, { t: 'full' }); setTimeout(() => c.close(), 500); }); return; }
    c.on('data', m => this.onMsg(m, c));
    c.on('close', () => { this.dropPlayer(c.peer); this.conns.delete(c.peer); this.broadcastLobby(); });
    this.conns.set(c.peer, c);
  }
  leave(rerender = true) {
    for (const c of this.conns.values()) try { c.close(); } catch (e) { }
    this.conns.clear();
    for (const id of [...this.players.keys()]) this.dropPlayer(id);
    if (this.peer) try { this.peer.destroy(); } catch (e) { }
    this.peer = null; this.code = null; this.host = false; this.myId = null;
    this.endRace();
    if (rerender) this.render();
  }
  send(c, m) { try { if (c.open) c.send(m); } catch (e) { } }
  broadcast(m, except = null) { for (const [id, c] of this.conns) if (id !== except) this.send(c, m); }
  toHost(m) { const c = this.conns.get('host'); if (c) this.send(c, m); }

  // ---------------- players ----------------
  mySel() { return JSON.parse(JSON.stringify(this.d.spec.sel)); }
  addSelf() {
    this.players.set(this.myId, { id: this.myId, name: this.name, sel: this.mySel(), spec: this.d.spec, ready: false, self: true });
  }
  setPlayer(id, name, sel) {
    let p = this.players.get(id);
    let spec; try { spec = evaluate(migrateSel({ ...sel })); } catch (e) { return; }
    if (!p) { p = { id, buf: [] }; this.players.set(id, p); }
    const carChanged = !p.spec || JSON.stringify(p.sel) !== JSON.stringify(sel);
    Object.assign(p, { name: cleanName(name), sel, spec });
    if (carChanged && !p.self) this.makeModel(p);
  }
  dropPlayer(id) {
    const p = this.players.get(id); if (!p) return;
    if (p.model) { this.d.scene.remove(p.model.root); disposeModel(p.model.root); }
    if (this.race) this.race.entries = this.race.entries.filter(e => e.pid !== id);
    this.players.delete(id);
  }
  makeModel(p) {
    if (p.model) { this.d.scene.remove(p.model.root); disposeModel(p.model.root); }
    const q = { ...gfxQ(), wheelSeg: 32 }, spec = p.spec, paint = p.sel.color || null;
    const asset = getCarAsset(spec.car.id, 'low');
    p.model = createCarModel(spec, { paint: paint || (asset ? null : spec.car.color), asset, quality: q });
    p.model.root.visible = false; this.d.scene.add(p.model.root);
    if (!asset && hasRealModel(spec.car.id)) loadCarAsset(spec.car.id, 'low').then(a => {
      if (!a || this.players.get(p.id) !== p || p.spec !== spec) return;
      const m2 = createCarModel(spec, { paint, asset: a, quality: q });
      m2.root.visible = p.model.root.visible;
      this.d.scene.remove(p.model.root); disposeModel(p.model.root); p.model = m2; this.d.scene.add(m2.root);
      if (p.entry) p.entry.model = m2;
    });
    // proxy "car" for collisions / race tracking, filled from network snapshots
    p.car = { x: 0, z: 0, yaw: 0, u: 0, v: 0, r: 0, m: spec.mass + 75, s: { Iz: 2500 } };
  }
  // my build changed in the garage
  updateMyBuild() {
    if (!this.myId) return;
    const me = this.me; if (!me) return;
    me.sel = this.mySel(); me.spec = this.d.spec; me.ready = false;
    if (this.host) this.broadcastLobby(); else this.toHost({ t: 'hello', name: this.name, sel: me.sel });
    this.render();
  }

  // ---------------- messages ----------------
  onMsg(m, c) {
    if (!m || typeof m !== 'object') return;
    if (this.host) {
      const id = c.peer;
      if (m.t === 'hello') { this.setPlayer(id, m.name, m.sel); const p = this.players.get(id); if (p) p.ready = false; this.broadcastLobby(); }
      else if (m.t === 'ready') { const p = this.players.get(id); if (p) { p.ready = !!m.v && !ruleViolations(p.spec, this.settings.rules).length; this.broadcastLobby(); } }
      else if (m.t === 'st') { m.id = id; this.onState(m); this.broadcast(m, id); }
      else if (m.t === 'fin') { m.id = id; this.onFinish(m); this.broadcast(m, id); }
      return;
    }
    if (m.t === 'lobby') this.onLobby(m);
    else if (m.t === 'st') this.onState(m);
    else if (m.t === 'start') this.beginRace(m);
    else if (m.t === 'fin') this.onFinish(m);
    else if (m.t === 'end') this.endRace();
    else if (m.t === 'full') this.setStatus('That room is full (8 players).');
  }
  broadcastLobby() {
    if (!this.host) return;
    const players = [...this.players.values()].map(p => ({ id: p.id, name: p.name, sel: p.sel, ready: !!p.ready }));
    this.broadcast({ t: 'lobby', players, settings: this.settings, racing: !!this.race });
    this.render();
  }
  onLobby(m) {
    const seen = new Set();
    for (const q of m.players) {
      seen.add(q.id);
      if (q.id === this.myId) { const me = this.me; if (me) me.ready = q.ready; continue; }
      this.setPlayer(q.id, q.name, q.sel); const p = this.players.get(q.id); if (p) p.ready = q.ready;
    }
    for (const id of [...this.players.keys()]) if (!seen.has(id) && id !== this.myId) this.dropPlayer(id);
    const trackChanged = m.settings.track !== this.settings.track || this.d.T.id !== m.settings.track;
    this.settings = m.settings;
    setRules(m.settings.rules, { save: false });
    if (trackChanged) this.d.setTrack(m.settings.track);
    this.render();
  }
  onState(m) {
    const p = this.players.get(m.id); if (!p || p.self || !p.car) return;
    p.buf.push({ ...m, t: performance.now() / 1000 });
    if (p.buf.length > 30) p.buf.shift();
    if (p.entry) { p.entry.lap = m.lap; p.entry.idx = m.idx; p.entry.best = m.best; if (m.fin != null) p.entry.finish = m.fin; }
  }
  onFinish(m) { const p = this.players.get(m.id); if (p?.entry) { p.entry.finish = m.time; p.entry.best = m.best; } }

  // ---------------- races ----------------
  startRace() {
    if (!this.host) return;
    const s = this.settings;
    const order = [...this.players.values()].filter(p => p.self || p.ready).map(p => p.id);
    this.broadcast({ t: 'start', order, settings: s });
    this.beginRace({ order, settings: s });
  }
  beginRace(m) {
    const d = this.d, s = m.settings;
    if (d.T.id !== s.track) d.setTrack(s.track);
    this.endRace(false);
    const R = this.race = new RaceControl(d.T, d.world, s.mode === 'attack' ? 999 : s.laps);
    R.mode = s.mode; R.duration = s.minutes * 60;
    const ids = m.order.filter(id => this.players.has(id));
    if (!ids.includes(this.myId)) { this.setStatus('Race started without you (not ready) — spectating.'); }
    ids.forEach((id, i) => {
      const p = this.players.get(id);
      const slot = R.gridSlot(i);
      if (p.self) {
        d.car.reset(...slot); d.idx = nearest(d.T, slot[0], slot[1]).i;
        p.entry = R.add({ pid: id, name: p.name + ' (you)', carName: `${p.spec.car.make} ${p.spec.car.model}`, car: d.car, model: d.model, isPlayer: true });
        d.playerEntry = p.entry;
      } else {
        p.entry = R.add({ pid: id, name: p.name, carName: `${p.spec.car.make} ${p.spec.car.model}`, car: p.car, model: p.model, remote: true });
      }
    });
    d.race = R; d.raceKeep = true;
    $('#raceBoard').classList.remove('hidden'); $('#raceResults').classList.add('hidden');
    this.render();
  }
  endRace(rerender = true) {
    if (this.race && this.d.race === this.race) { this.d.race = null; this.d.playerEntry = null; }
    this.race = null; this.d.raceKeep = false;
    for (const p of this.players.values()) p.entry = null;
    $('#raceBoard')?.classList.add('hidden');
    if (rerender) this.render();
  }

  // ---------------- per frame ----------------
  frame(dt) {
    const d = this.d, now = performance.now() / 1000;
    // remote cars: interpolate DELAY seconds in the past
    for (const p of this.players.values()) {
      if (p.self || !p.model || !p.buf?.length) continue;
      const tt = now - DELAY, b = p.buf;
      let i = b.length - 1; while (i > 0 && b[i - 1].t > tt) i--;
      const a = b[Math.max(0, i - 1)], c = b[i], f = c.t > a.t ? Math.max(0, Math.min(1.5, (tt - a.t) / (c.t - a.t))) : 1;
      let dy = c.yaw - a.yaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
      Object.assign(p.car, { x: a.x + (c.x - a.x) * f, z: a.z + (c.z - a.z) * f, yaw: a.yaw + dy * f, u: c.u, v: c.v, r: c.r, steerAngle: c.st, rpm: c.rpm || 900, load: c.th || 0 });
      const M = p.model; M.root.visible = now - c.t < 3;
      poseOnGround(d.T, M.root, p.car.x, p.car.z, p.car.yaw);
      for (const w of M.wheels) { w.spin.rotation.x += c.u / 0.32 * dt; if (w.front) w.pivot.rotation.y = c.st || 0; }
      if (p.entry) { const T = d.T; p.entry.progress = p.entry.finish != null ? 1e9 - p.entry.finish : p.entry.lap === 0 ? p.entry.idx - T.N : (p.entry.lap - 1) * T.N + p.entry.idx; }
    }
    // send my state
    this.sendT += dt;
    if (this.myId && this.conns.size && this.sendT >= 1 / SEND_HZ) {
      this.sendT = 0;
      const c = d.car, e = this.me?.entry;
      const m = { t: 'st', x: +c.x.toFixed(3), z: +c.z.toFixed(3), yaw: +c.yaw.toFixed(4), u: +c.u.toFixed(2), v: +c.v.toFixed(2), r: +c.r.toFixed(3), st: +(c.steerAngle || 0).toFixed(3), rpm: Math.round(c.rpm || 0), th: +(d.lastLoad || 0).toFixed(2), lap: e?.lap ?? 0, idx: e?.idx ?? d.idx, best: e?.best ?? null, fin: e?.finish ?? null };
      if (this.host) { m.id = this.myId; this.broadcast(m); } else this.toHost(m);
    }
    // time attack: ends after the set time
    const R = this.race;
    if (R && R.mode === 'attack' && R.t > R.duration && !R.shown) {
      R.shown = true; R.entries.forEach(e => { e.finish = e.finish ?? R.t; });
      $('#raceResults').innerHTML = R.resultsHTML() + `<div class="foot">Time attack over</div>`; $('#raceResults').classList.remove('hidden');
    }
    // tell everyone when I finish
    const me = this.me?.entry;
    if (me && me.finish != null && !me.sentFin) { me.sentFin = true; const m = { t: 'fin', time: me.finish, best: me.best }; if (this.host) { m.id = this.myId; this.broadcast(m); } else this.toHost(m); }
    if ((this.uiT = (this.uiT || 0) + dt) > 0.5) { this.uiT = 0; this.renderPlayers(); }
  }
  // remote cars are kinematic obstacles for my car
  collide(car, dims) {
    let hit = 0;
    for (const p of this.players.values()) {
      if (p.self || !p.car || !p.model?.root.visible) continue;
      hit = Math.max(hit, collideKinematic(car, dims, { x: p.car.x, z: p.car.z, head: p.car.yaw, vx: Math.sin(p.car.yaw) * p.car.u, vz: Math.cos(p.car.yaw) * p.car.u }, p.model.dims));
    }
    return hit;
  }

  // ---------------- UI ----------------
  setStatus(s) { this.status = s; const el = $('#netStatus'); if (el) el.textContent = s; }
  render() {
    const box = $('#onlineBox'); if (!box) return;
    const s = this.settings, conn = !!this.myId;
    box.innerHTML = `
      <div class="sub-h">Online with friends</div>
      <label>Your name <input id="netName" maxlength="18" value="${esc(this.name)}"></label>
      ${!conn ? `
        <button id="netHost" class="cta" style="width:100%;margin:2px 0 8px">Host a game</button>
        <div class="row-join"><input id="netCode" placeholder="ROOM CODE" maxlength="5"><button id="netJoin">Join</button></div>` : `
        <div class="room">Room <b>${this.code}</b> ${this.host ? '<small>(you host)</small>' : ''}<button id="netLeave" class="ghost mini">Leave</button></div>
        ${this.host ? `
          <label>Mode <select id="netMode"><option value="race">Race</option><option value="attack">Time attack (best lap)</option></select></label>
          <label id="netLapsL">Laps <select id="netLaps">${[1, 2, 3, 5, 10].map(n => `<option ${n === s.laps ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label id="netMinL">Minutes <select id="netMin">${[3, 5, 10, 15].map(n => `<option ${n === s.minutes ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <small class="muted">Track and rules above apply to everyone in the room.</small>` : `<div class="muted" style="font-size:12px">${s.mode === 'attack' ? `Time attack · ${s.minutes} min` : `Race · ${s.laps} laps`} · ${esc(TRACKS[s.track]?.name)} · ${esc(rulesText(s.rules))}</div>`}
        <div id="netPlayers"></div>
        ${this.race ? `${this.host ? '<button id="netEnd" class="ghost" style="width:100%">End race → lobby</button>' : ''}` : this.host ? '<button id="netStart" class="cta" style="width:100%">Start race</button>' : '<button id="netReady" style="width:100%">Ready</button>'}`}
      <div id="netStatus" class="muted" style="font-size:12px;margin:6px 0">${esc(this.status)}</div>`;
    const on = (id, ev, f) => { const el = box.querySelector(id); if (el) el[ev] = f; };
    on('#netName', 'onchange', e => { this.name = cleanName(e.target.value); try { localStorage.setItem('tf_name', this.name); } catch (er) { } if (this.me) { this.me.name = this.name; this.updateMyBuild(); } });
    on('#netHost', 'onclick', () => this.hostGame());
    on('#netJoin', 'onclick', () => this.joinGame(box.querySelector('#netCode').value));
    on('#netCode', 'onkeydown', e => { e.stopPropagation(); if (e.key === 'Enter') this.joinGame(e.target.value); });
    on('#netName', 'onkeydown', e => e.stopPropagation());
    on('#netLeave', 'onclick', () => { this.leave(); this.setStatus('Left the room.'); });
    on('#netStart', 'onclick', () => this.startRace());
    on('#netEnd', 'onclick', () => { this.broadcast({ t: 'end' }); this.endRace(); this.broadcastLobby(); });
    on('#netReady', 'onclick', () => { const me = this.me; if (!me) return; const v = !me.ready; if (v && ruleViolations(this.d.spec, this.settings.rules).length) { this.setStatus('Your build breaks the room rules — fix it in the garage first.'); return; } me.ready = v; this.toHost({ t: 'ready', v }); this.render(); });
    const mode = box.querySelector('#netMode');
    if (mode) {
      mode.value = s.mode;
      const vis = () => { box.querySelector('#netLapsL').style.display = s.mode === 'race' ? '' : 'none'; box.querySelector('#netMinL').style.display = s.mode === 'attack' ? '' : 'none'; };
      vis();
      mode.onchange = () => { s.mode = mode.value; vis(); this.broadcastLobby(); };
      on('#netLaps', 'onchange', e => { s.laps = +e.target.value; this.broadcastLobby(); });
      on('#netMin', 'onchange', e => { s.minutes = +e.target.value; this.broadcastLobby(); });
    }
    this.renderPlayers();
  }
  renderPlayers() {
    const el = $('#netPlayers'); if (!el) return;
    const rules = this.settings.rules;
    el.innerHTML = [...this.players.values()].map(p => {
      if (!p.spec) return '';
      const bad = ruleViolations(p.spec, rules), pi = perfIndex(p.spec);
      return `<div class="np"><span>${p.self || (this.host && p.id === this.myId) ? '🙂' : '🌐'} ${esc(p.name)}${p.id === this.myId ? ' (you)' : ''}</span>
        <small>${esc(p.spec.car.make + ' ' + p.spec.car.model)} · ${Math.round(p.spec.engine.hp)} hp ${piBadge(pi)}</small>
        <em class="${bad.length ? 'bad' : p.ready || (this.host && p.self) ? 'ok' : ''}">${bad.length ? '✗ ' + esc(bad[0]) : (p.self && this.host) ? 'host' : p.ready ? '✓ ready' : 'not ready'}</em></div>`;
    }).join('');
  }
}
