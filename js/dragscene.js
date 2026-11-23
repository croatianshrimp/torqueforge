// Drag strip venue: its own map (the circuit scenery is hidden while it's shown). Two lanes, a burnout box,
// rubbered-in launch area, concrete walls + catch fence, timing boards for every standard mark, a finish line that
// moves to the chosen distance (1/8 … 1 mile), bleachers with crowds, timing tower, christmas tree, light towers,
// and a long shut-down area with a sand trap and catch net.
import * as THREE from '../vendor/three.module.js';

export const DRAG_DISTANCES = [
  [201.168, '1/8 mile'], [402.336, '1/4 mile'], [804.672, '1/2 mile'], [1207.008, '3/4 mile'], [1609.344, '1 mile'],
];
// timing beams: [distance m, key, label]
export const DRAG_MARKS = [
  [18.288, 'ft60', '60 ft'], [100.584, 'ft330', '330 ft'], [201.168, 'eighth', '1/8 mile'], [304.8, 'ft1000', '1000 ft'],
  [402.336, 'quarter', '1/4 mile'], [804.672, 'half', '1/2 mile'], [1207.008, 'threeq', '3/4 mile'], [1609.344, 'mile', '1 mile'],
];
export const STRIP = { x: -180, z0: -420, width: 22, maxLen: 1609.344, shutdown: 900, back: 90 };
export const stripEnd = () => STRIP.z0 + STRIP.maxLen + STRIP.shutdown;
export const onStrip = (x, z) => Math.abs(x - STRIP.x) < STRIP.width / 2 && z > STRIP.z0 - STRIP.back && z < stripEnd();

function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  return t;
}
const BRANDS = [['TORQUEFORGE', '#ffb020', '#111'], ['NITRO X', '#fff', '#c8102e'], ['DRAGRADIAL', '#111', '#ffd000'], ['LAUNCH CTRL', '#fff', '#1f4fa8'], ['BOOST CO.', '#111', '#f4f4f2'], ['ET RACING', '#ffb020', '#14213d']];

export class DragScene {
  constructor(scene, { pbrTex }) {
    this.group = new THREE.Group(); this.group.visible = false; scene.add(this.group);
    this.pbrTex = pbrTex;
    this.mats = {
      concrete: new THREE.MeshStandardMaterial({ color: 0xc9c6bf, roughness: 0.9 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.6, metalness: 0.4 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x8d939b, roughness: 0.45, metalness: 0.8 }),
      white: new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.8 }),
      red: new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.7 }),
    };
    this.buildGround();
    this.buildStrip();
    this.buildWalls();
    this.buildBoards();
    this.buildTree();
    this.buildTower();
    this.buildStands();
    this.buildPits();
    this.buildLights();
    this.buildEnd();
    this.finish = this.buildFinish();
    this.setDistance(402.336);
  }
  add(o, cast = false) { o.castShadow = cast; o.receiveShadow = true; this.group.add(o); return o; }
  box(w, h, d, mat, x, y, z, cast = true) { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); b.position.set(x, y, z); return this.add(b, cast); }
  flat(w, l, mat, x, z, y = 0.03) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), mat); m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); return this.add(m); }

  buildGround() {
    const mat = new THREE.MeshStandardMaterial({ map: this.pbrTex('aerial_grass_rock_diff_1k.jpg', [700, 700], true), normalMap: this.pbrTex('aerial_grass_rock_nor_gl_1k.jpg', [700, 700]), color: 0xa9b98f, roughness: 1 });
    const g = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), mat);
    g.rotation.x = -Math.PI / 2; g.position.set(STRIP.x, -0.02, STRIP.z0 + 900); this.add(g);
    // paved apron either side of the strip (return road, pits side, spectator side)
    const len = STRIP.maxLen + STRIP.shutdown + STRIP.back;
    const ap = new THREE.MeshStandardMaterial({ map: this.pbrTex('asphalt_track_diff_1k.jpg', [4, len / 10], true), color: 0x8a8a8a, roughness: 1 });
    const zc = STRIP.z0 - STRIP.back + len / 2;
    this.flat(10, len, ap, STRIP.x + STRIP.width / 2 + 7, zc, 0.012);    // return road
  }

  buildStrip() {
    const S = STRIP, len = S.maxLen + S.shutdown + S.back, zc = S.z0 - S.back + len / 2;
    const rep = [S.width / 4, len / 4];
    const mat = new THREE.MeshStandardMaterial({ map: this.pbrTex('asphalt_track_diff_1k.jpg', rep, true), normalMap: this.pbrTex('asphalt_track_nor_gl_1k.jpg', rep),
      roughnessMap: this.pbrTex('asphalt_track_rough_1k.jpg', rep), roughness: 1, color: 0x9a9a9a });
    this.flat(S.width, len, mat, S.x, zc, 0.02);
    // launch area: concrete pad for the first 100 m, with black rubber laid down in each lane's wheel tracks
    const pad = canvasTex(256, 1024, (g, w, h) => {
      g.fillStyle = '#9c9a95'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 4000; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
      for (const cx of [0.27, 0.73]) for (const off of [-0.11, 0.11]) {
        const x = (cx + off) * w;
        const gr = g.createLinearGradient(0, h, 0, 0); gr.addColorStop(0, 'rgba(15,15,15,0.95)'); gr.addColorStop(0.6, 'rgba(25,25,25,0.6)'); gr.addColorStop(1, 'rgba(30,30,30,0)');
        g.fillStyle = gr; g.fillRect(x - 13, 0, 26, h);
      }
    });
    this.flat(S.width, 100, new THREE.MeshStandardMaterial({ map: pad, roughness: 0.85 }), S.x, S.z0 + 50, 0.025);
    // burnout box behind the start line (wet patch) + lane numbers
    this.flat(S.width - 1, 40, new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.15, metalness: 0.1 }), S.x, S.z0 - 30, 0.024);
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff }), yellow = new THREE.MeshBasicMaterial({ color: 0xffd000 });
    this.flat(0.25, len, white, S.x, zc, 0.032);                                   // centre line
    for (const s of [-1, 1]) this.flat(0.2, len, white, S.x + s * (S.width / 2 - 0.4), zc, 0.032);
    this.flat(S.width, 0.4, white, S.x, S.z0, 0.033);                              // start line
    // guide stripes in each lane for the first 300 m
    for (const s of [-1, 1]) for (let z = 10; z < 300; z += 12) this.flat(0.15, 6, yellow, S.x + s * S.width / 4, S.z0 + z, 0.031);
    for (const [s, n] of [[-1, 'LEFT'], [1, 'RIGHT']]) {
      const t = canvasTex(256, 128, (g, w, h) => { g.fillStyle = '#fff'; g.font = 'bold 78px system-ui'; g.textAlign = 'center'; g.fillText(n, w / 2, 96); });
      const m = this.flat(6, 3, new THREE.MeshBasicMaterial({ map: t, transparent: true }), S.x + s * S.width / 4, S.z0 - 14, 0.034); m.rotation.z = Math.PI;
    }
  }

  buildWalls() {
    const S = STRIP, z0 = S.z0 - S.back, z1 = stripEnd(), L = z1 - z0, zc = (z0 + z1) / 2;
    const wallT = canvasTex(512, 64, (g, w, h) => {
      g.fillStyle = '#d9d6cf'; g.fillRect(0, 0, w, h); g.fillStyle = '#c8102e'; g.fillRect(0, 0, w, 10);
      for (let x = 0; x < w; x += 64) { g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(x, 0, 2, h); }
    }, [L / 12, 1]);
    const wm = new THREE.MeshStandardMaterial({ map: wallT, roughness: 0.9 });
    for (const s of [-1, 1]) {
      const x = S.x + s * (S.width / 2 + 0.35);
      this.box(0.6, 1.1, L, wm, x, 0.55, zc);
      // catch fence on the spectator side, short posts on the return-road side
      const h = s < 0 ? 4 : 1.6, posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.06, h, 6), this.mats.steel, Math.ceil(L / 6));
      const M = new THREE.Matrix4(); for (let i = 0; i < posts.count; i++) { M.makeTranslation(x, 1.1 + h / 2, z0 + i * 6); posts.setMatrixAt(i, M); }
      this.add(posts);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(L, h), new THREE.MeshStandardMaterial({ color: 0x7d838c, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
      mesh.rotation.y = Math.PI / 2; mesh.position.set(x, 1.1 + h / 2, zc); this.group.add(mesh);
      // sponsor banners on the wall along the first 600 m
      for (let i = 0; i < 14; i++) {
        const b = BRANDS[(i + (s > 0 ? 3 : 0)) % BRANDS.length];
        const t = canvasTex(512, 96, (g, w, h2) => { g.fillStyle = b[2]; g.fillRect(0, 0, w, h2); g.fillStyle = b[1]; g.font = 'bold 64px system-ui'; g.textAlign = 'center'; g.fillText(b[0], w / 2, 70); });
        const p = new THREE.Mesh(new THREE.PlaneGeometry(14, 0.75), new THREE.MeshBasicMaterial({ map: t }));
        p.position.set(x - s * 0.31, 0.6, S.z0 + 30 + i * 42); p.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2; this.group.add(p);
      }
    }
  }

  board(label, d, accent = '#ffb020') {
    const S = STRIP, t = canvasTex(256, 96, (g, w, h) => { g.fillStyle = '#111'; g.fillRect(0, 0, w, h); g.fillStyle = accent; g.font = 'bold 46px system-ui'; g.textAlign = 'center'; g.fillText(label, w / 2, 64); });
    for (const s of [-1, 1]) {
      const x = S.x + s * (S.width / 2 + 2.4);
      const b = new THREE.Mesh(new THREE.PlaneGeometry(4, 1.5), new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide }));
      b.position.set(x, 3.2, S.z0 + d); b.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2; this.group.add(b);
      this.box(0.15, 2.5, 0.15, this.mats.dark, x, 1.25, S.z0 + d, false);
      // timing beam box on the wall
      this.box(0.25, 0.25, 0.4, this.mats.dark, S.x + s * (S.width / 2 - 0.1), 0.45, S.z0 + d, false);
    }
  }
  buildBoards() {
    for (const [d, , label] of DRAG_MARKS) this.board(label.toUpperCase(), d);
    for (let m = 100; m < STRIP.maxLen + STRIP.shutdown; m += 100) if (!DRAG_MARKS.some(([d]) => Math.abs(d - m) < 30)) this.board(`${m} m`, m, '#8b93a5');
  }

  buildFinish() {
    const S = STRIP, g = new THREE.Group(); this.group.add(g);
    const check = canvasTex(256, 32, (c, w, h) => { for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { c.fillStyle = (i + j) % 2 ? '#111' : '#fff'; c.fillRect(i * 16, j * 16, 16, 16); } }, [3, 1]);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(S.width, 1.2), new THREE.MeshBasicMaterial({ map: check }));
    line.rotation.x = -Math.PI / 2; line.position.y = 0.036; g.add(line);
    // finish gantry with win lights + scoreboards
    for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.5, 9, 0.5), this.mats.steel); p.position.set(S.x + s * (S.width / 2 + 1.5), 4.5, 0); p.castShadow = true; g.add(p); }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(S.width + 4, 1.4, 0.6), this.mats.dark); beam.position.set(S.x, 9, 0); g.add(beam);
    this.finishTex = canvasTex(1024, 96, () => {});
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(S.width + 3, 1.3), new THREE.MeshBasicMaterial({ map: this.finishTex, side: THREE.DoubleSide }));
    sign.position.set(S.x, 9, -0.32); sign.rotation.y = Math.PI; g.add(sign);
    this.winLights = [-1, 1].map(s => { const m = new THREE.MeshStandardMaterial({ color: 0x331100, emissive: 0xff3300, emissiveIntensity: 0 }); const b = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 8), m); b.position.set(S.x + s * S.width / 4, 8, -0.4); g.add(b); return m; });
    return g;
  }
  setDistance(d) {
    this.dist = d;
    this.finish.position.z = STRIP.z0 + d;
    const label = (DRAG_DISTANCES.find(x => Math.abs(x[0] - d) < 1)?.[1] || `${Math.round(d)} m`).toUpperCase();
    const c = this.finishTex.image, g = c.getContext('2d');
    g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#fff'; g.font = 'bold 64px system-ui'; g.textAlign = 'center'; g.fillText(`FINISH · ${label}`, c.width / 2, 70);
    this.finishTex.needsUpdate = true;
    this.winLights.forEach(m => m.emissiveIntensity = 0);
  }
  win(on) { this.winLights.forEach(m => m.emissiveIntensity = on ? 4 : 0); }

  buildTree() {
    const S = STRIP, g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.4, 3.4, 0.4), this.mats.dark); pole.position.y = 1.7; g.add(pole);
    const housing = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.4, 0.3), this.mats.dark); housing.position.set(0, 2.5, 0.1); g.add(housing);
    this.treeLights = [];
    for (let i = 0; i < 4; i++) {
      const m = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: i === 3 ? 0x00ff44 : 0xffaa00, emissiveIntensity: 0 });
      for (const sx of [-0.3, 0.3]) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), m); b.position.set(sx, 3.3 - i * 0.5, 0.3); g.add(b); }
      this.treeLights.push(m);
    }
    // pre-stage / stage bulbs on top
    for (const sx of [-0.3, 0.3]) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffee88, emissiveIntensity: 2 })); b.position.set(sx, 3.6, 0.3); g.add(b); }
    g.position.set(S.x, 0, S.z0 + 7); g.rotation.y = Math.PI; this.group.add(g);
    g.traverse(o => o.isMesh && (o.castShadow = true));
  }

  buildTower() {
    const S = STRIP, x = S.x + S.width / 2 + 24, z = S.z0 + 6;
    const walls = new THREE.MeshStandardMaterial({ color: 0xe6e8eb, roughness: 0.7 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x223344, roughness: 0.05, metalness: 0.9 });
    this.box(10, 12, 10, walls, x, 6, z);
    this.box(11, 3.6, 11, glass, x, 13.8, z);
    this.box(12.5, 0.5, 12.5, this.mats.dark, x, 15.9, z);
    const t = canvasTex(512, 128, (g, w, h) => { g.fillStyle = '#111'; g.fillRect(0, 0, w, h); g.fillStyle = '#ffb020'; g.font = 'bold 70px system-ui'; g.textAlign = 'center'; g.fillText('TORQUEFORGE', w / 2, 66); g.fillStyle = '#fff'; g.font = 'bold 34px system-ui'; g.fillText('DRAGWAY', w / 2, 112); });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.25), new THREE.MeshBasicMaterial({ map: t })); sign.position.set(x - 5.02, 9.5, z); sign.rotation.y = -Math.PI / 2; this.group.add(sign);
  }

  buildStands() {
    const S = STRIP, rows = 12, rowD = 0.85, rowH = 0.5;
    const prof = new THREE.Shape(); prof.moveTo(0, 0); prof.lineTo(0, 1.2);
    for (let r = 0; r < rows; r++) { prof.lineTo(-r * rowD, 1.2 + r * rowH); prof.lineTo(-(r + 1) * rowD, 1.2 + r * rowH); }
    prof.lineTo(-rows * rowD, 0); prof.closePath();
    const body = new THREE.CylinderGeometry(0.17, 0.2, 0.62, 6); body.translate(0, 0.31 + 0.8, 0);
    const head = new THREE.SphereGeometry(0.12, 6, 5); head.translate(0, 0.75 + 0.8, 0);
    const cols = [0xc8102e, 0x1f4fa8, 0xf4f4f2, 0x222222, 0xffb020, 0x1f8a4c, 0x7b2ff7, 0x888888];
    const segs = [[-60, 120], [140, 320], [340, 470]];
    const people = [];
    for (const [a, b] of segs) {
      const L = b - a, zc = S.z0 + (a + b) / 2, x = S.x - S.width / 2 - 6;
      const g = new THREE.ExtrudeGeometry(prof, { depth: L, bevelEnabled: false }); g.translate(0, 0, -L / 2);
      const st = new THREE.Mesh(g, this.mats.steel); st.position.set(x, 0, zc); this.add(st, true);
      // roof over the stands near the start
      if (a < 0) { this.box(rows * rowD + 2, 0.3, L, this.mats.white, x - rows * rowD / 2, 1.2 + rows * rowH + 3.2, zc); for (let z = a; z <= b; z += 30) this.box(0.3, 1.2 + rows * rowH + 3.2, 0.3, this.mats.steel, x - rows * rowD - 0.5, (1.2 + rows * rowH + 3.2) / 2, S.z0 + z); }
      for (let r = 0; r < rows; r++) for (let z = a + 1; z < b - 1; z += 0.75) if (Math.random() < (a < 0 ? 0.8 : 0.5)) people.push([x - (r + 0.55) * rowD, 1.2 + r * rowH, S.z0 + z + (Math.random() - 0.5) * 0.2]);
    }
    const mk = geo => { const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.8 }), people.length); const M = new THREE.Matrix4(), c = new THREE.Color();
      people.forEach(([x, y, z], i) => { M.makeTranslation(x, y, z); m.setMatrixAt(i, M); m.setColorAt(i, c.setHex(geo === head ? 0xe8c0a0 : cols[(i * 7 + (i >> 3)) % cols.length])); }); this.add(m); };
    mk(body); mk(head);
  }

  buildPits() {
    // staging lanes + parked trailers / canopies behind the start
    const S = STRIP, x = S.x + S.width / 2 + 12;
    const ap = new THREE.MeshStandardMaterial({ map: this.pbrTex('asphalt_track_diff_1k.jpg', [10, 12], true), color: 0x8a8a8a, roughness: 1 });
    this.flat(70, 120, ap, S.x, S.z0 - S.back - 60, 0.013);
    const canopyCols = [0xc8102e, 0x1f4fa8, 0xffb020, 0x1f8a4c, 0xf4f4f2, 0x7b2ff7];
    for (let i = 0; i < 8; i++) {
      const cx = S.x - 28 + (i % 4) * 18, cz = S.z0 - S.back - 30 - Math.floor(i / 4) * 40;
      this.box(4, 3.2, 12, this.mats.white, cx, 1.6, cz);                   // trailer
      const can = new THREE.MeshStandardMaterial({ color: canopyCols[i % canopyCols.length], roughness: 0.8, side: THREE.DoubleSide });
      this.box(6, 0.12, 6, can, cx + 5.5, 3, cz + 3, false);
      for (const [dx, dz] of [[-2.9, -2.9], [2.9, -2.9], [-2.9, 2.9], [2.9, 2.9]]) this.box(0.08, 3, 0.08, this.mats.steel, cx + 5.5 + dx, 1.5, cz + 3 + dz, false);
    }
    // concession stands behind the bleachers
    for (let i = 0; i < 3; i++) this.box(6, 3, 4, this.mats.red, S.x - S.width / 2 - 26, 1.5, S.z0 + 20 + i * 60);
    this.box(4, 2.5, 4, this.mats.white, x, 1.25, S.z0 - 20);
  }

  buildLights() {
    const S = STRIP, n = Math.floor((S.maxLen + S.shutdown) / 120);
    for (let i = 0; i <= n; i++) for (const s of [-1, 1]) {
      const x = S.x + s * (S.width / 2 + 5), z = S.z0 - 40 + i * 120;
      this.box(0.35, 16, 0.35, this.mats.steel, x, 8, z, false);
      const head = this.box(3, 0.9, 0.5, this.mats.dark, x - s * 1.2, 16, z, false);
      head.rotation.z = s * 0.4;
    }
  }

  buildEnd() {
    const S = STRIP, z = stripEnd();
    const sand = new THREE.MeshStandardMaterial({ color: 0xcdb889, roughness: 1 });
    this.flat(S.width + 6, 60, sand, S.x, z + 30, 0.02);
    for (let i = 0; i < 5; i++) this.box(S.width, 0.5, 0.5, this.mats.steel, S.x, 0.4 + i * 0.9, z + 62, false);   // catch net frame
    const net = new THREE.Mesh(new THREE.PlaneGeometry(S.width, 4), new THREE.MeshStandardMaterial({ color: 0x333333, transparent: true, opacity: 0.4, side: THREE.DoubleSide }));
    net.position.set(S.x, 2, z + 62); this.group.add(net);
    this.board('END', S.maxLen + S.shutdown - 20, '#ff4757');
  }
}
