// Graphics quality presets, post-processing chain, HDR environments, FPS counter, frame limiter + dynamic resolution.
import * as THREE from '../vendor/three.module.js';
import { RGBELoader } from '../vendor/RGBELoader.js';
import { EffectComposer } from '../vendor/EffectComposer.js';
import { RenderPass } from '../vendor/RenderPass.js';
import { OutputPass } from '../vendor/OutputPass.js';
import { UnrealBloomPass } from '../vendor/UnrealBloomPass.js';
import { GTAOPass } from '../vendor/GTAOPass.js';
import { SMAAPass } from '../vendor/SMAAPass.js';
import { ShaderPass } from '../vendor/ShaderPass.js';

// Replaces NaN/Inf pixels and clamps extreme HDR values: one bad pixel from a downloaded material would otherwise be
// smeared over the whole screen by bloom / AO.
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0); gl_FragColor = clamp(c, 0.0, 48.0); }',
};

// Low     — integrated GPUs / Apple M1 class, target 60 fps
// Medium  — midrange
// High    — modern discrete GPU, target 144 fps+
// Ultra   — high end, screenshots
export const PRESETS = {
  low:    { label: 'Low',    pixelRatio: 1.0,  scale: 0.85, shadows: 1024, shadowSoft: false, msaa: 0, smaa: false, bloom: false, ao: false, env: '1k', lod: 'low',  clearcoat: false, transmission: false, wheelSeg: 32, trees: 0.45, anisotropy: 2,  shadowRange: 22 },
  medium: { label: 'Medium', pixelRatio: 1.25, scale: 1.0,  shadows: 2048, shadowSoft: false, msaa: 4, smaa: false, bloom: false, ao: false, env: '1k', lod: 'low',  clearcoat: true,  transmission: false, wheelSeg: 40, trees: 0.75, anisotropy: 4,  shadowRange: 30 },
  high:   { label: 'High',   pixelRatio: 2.0,  scale: 1.0,  shadows: 4096, shadowSoft: true,  msaa: 4, smaa: false, bloom: true,  ao: false, env: '2k', lod: 'high', clearcoat: true,  transmission: false, wheelSeg: 56, trees: 1,    anisotropy: 8,  shadowRange: 36 },
  ultra:  { label: 'Ultra',  pixelRatio: 2.0,  scale: 1.0,  shadows: 4096, shadowSoft: true,  msaa: 8, smaa: false, bloom: true,  ao: true,  env: '2k', lod: 'high', clearcoat: true,  transmission: true,  wheelSeg: 72, trees: 1,    anisotropy: 16, shadowRange: 40 },
};

const DEFAULTS = { preset: null, fpsCap: 0, showFps: false, dynRes: true, scale: null };
export const settings = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('tf_gfx')) || {}; } catch (e) { }
  return { ...DEFAULTS, ...s };
})();
export function saveSettings() { try { localStorage.setItem('tf_gfx', JSON.stringify(settings)); } catch (e) { } window.tfDesktop?.saveSettings?.({ fpsCap: settings.fpsCap }); }

// Pick a sensible default from the GPU name
export function detectPreset(renderer) {
  const gl = renderer.getContext();
  let name = '';
  try { const ext = gl.getExtension('WEBGL_debug_renderer_info'); name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch (e) { }
  const n = name.toLowerCase();
  let p = 'medium';
  if (/swiftshader|llvmpipe|software|microsoft basic/.test(n)) p = 'low';
  else if (/apple m1|apple gpu|intel|uhd|iris|mali|adreno|powervr|radeon\(tm\) graphics|radeon graphics|vega \d|raphael|rembrandt|phoenix/.test(n)) p = 'low';
  else if (/apple m[2-9]/.test(n)) p = 'medium';
  else if (/rtx|rx [6-9]\d{3}|rx 9\d{2}|radeon rx|navi|arc a7|arc b/.test(n)) p = 'high';
  return { preset: p, gpu: name };
}

export function current() { return PRESETS[settings.preset] || PRESETS.medium; }

// ---------- HDR environments ----------
const rgbe = new RGBELoader();
const envCache = new Map();
export function loadEnv(renderer, name, res) {
  const key = name + res;
  if (!envCache.has(key)) {
    envCache.set(key, rgbe.loadAsync(`assets/env/${name}_${res}.hdr`).then(tex => {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      const pm = new THREE.PMREMGenerator(renderer);
      const env = pm.fromEquirectangular(tex).texture;
      pm.dispose();
      // brightest texel -> sun direction (for matching the directional light to the sky)
      const { data, width, height } = tex.image;
      let best = -1, bi = 0;
      const step = data.length / (width * height);
      for (let i = 0; i < width * height; i += 3) { const v = data[i * step] + data[i * step + 1] + data[i * step + 2]; if (v > best) { best = v; bi = i; } }
      // equirect: row 0 = zenith; three's mapping u = atan2(z, x) / 2pi + 0.5
      const u = (bi % width) / width, v = Math.floor(bi / width) / height;
      const a = (u - 0.5) * Math.PI * 2, th = v * Math.PI;
      const sunDir = new THREE.Vector3(Math.cos(a) * Math.sin(th), Math.cos(th), Math.sin(a) * Math.sin(th)).normalize();
      return { background: tex, env, sunDir };
    }).catch(e => { console.warn('env load failed', name, e); return null; }));
  }
  return envCache.get(key);
}

// ---------- render pipeline ----------
export class Pipeline {
  constructor(renderer) {
    this.r = renderer;
    this.composer = null;
    this.key = '';
    this.w = 1; this.h = 1;
    this.dyn = 1;              // dynamic resolution multiplier
    this.frameTimes = [];
    this.fps = 0;
    this.lastFrame = performance.now();
    this.fpsEl = null;
  }
  apply() {
    const q = current();
    const r = this.r;
    r.shadowMap.enabled = q.shadows > 0;
    r.shadowMap.type = q.shadowSoft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    r.shadowMap.needsUpdate = true;
    this.key = '';
    this.resize(this.w, this.h);
  }
  pixelRatio() {
    const q = current();
    const base = Math.min(window.devicePixelRatio || 1, q.pixelRatio);
    return Math.max(0.4, base * (settings.scale ?? q.scale) * this.dyn);
  }
  resize(w, h) {
    this.w = w; this.h = h;
    const pr = this.pixelRatio();
    this.r.setPixelRatio(pr);
    this.r.setSize(w, h, false);
    this.r.domElement.style.width = w + 'px'; this.r.domElement.style.height = h + 'px';
    if (this.composer) { this.composer.setPixelRatio(pr); this.composer.setSize(w, h); }
  }
  // build composer lazily per scene/camera + preset
  render(scene, camera) {
    const q = current();
    const usePost = q.bloom || q.ao || q.msaa > 0 || q.smaa;
    if (!usePost) { this.r.toneMapping = THREE.ACESFilmicToneMapping; this.r.render(scene, camera); return; }
    const key = `${scene.uuid}:${camera.uuid}:${settings.preset}`;
    if (key !== this.key) this.build(scene, camera, q, key);
    this.r.toneMapping = THREE.ACESFilmicToneMapping;
    this.composer.render();
  }
  build(scene, camera, q, key) {
    this.composer?.dispose?.();
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: q.msaa });
    const c = new EffectComposer(this.r, rt);
    c.addPass(new RenderPass(scene, camera));
    if (q.bloom || q.ao) c.addPass(new ShaderPass(SanitizeShader));
    if (q.ao) { const ao = new GTAOPass(scene, camera, this.w, this.h); ao.blendIntensity = 0.85; c.addPass(ao); }
    if (q.bloom) c.addPass(new UnrealBloomPass(new THREE.Vector2(this.w, this.h), 0.22, 0.5, 0.92));
    c.addPass(new OutputPass());
    if (q.smaa) c.addPass(new SMAAPass(this.w, this.h));
    this.composer = c; this.key = key;
    c.setPixelRatio(this.pixelRatio()); c.setSize(this.w, this.h);
  }

  // call at the start of each rAF; returns false if this frame should be skipped (frame cap)
  beginFrame(now) {
    if (settings.fpsCap > 0) {
      const min = 1000 / settings.fpsCap;
      if (now - this.lastFrame < min - 0.5) return false;
    }
    const dt = now - this.lastFrame; this.lastFrame = now;
    this.frameTimes.push(dt); if (this.frameTimes.length > 90) this.frameTimes.shift();
    this.tick = (this.tick || 0) + 1;
    if (this.tick % 30 === 0) {
      const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
      this.fps = 1000 / avg;
      if (this.fpsEl) { this.fpsEl.style.display = settings.showFps ? '' : 'none'; this.fpsEl.textContent = `${Math.round(this.fps)} fps · ${avg.toFixed(1)} ms${this.dyn < 0.999 ? ` · ${Math.round(this.dyn * 100)}% res` : ''}`; }
      // dynamic resolution: hold the target (cap, else 60 on Low / Medium, 144 on High+)
      if (settings.dynRes) {
        const target = settings.fpsCap || (settings.preset === 'high' || settings.preset === 'ultra' ? 144 : 60);
        const sorted = [...this.frameTimes].sort((a, b) => a - b), p90 = sorted[Math.floor(sorted.length * 0.9)];
        const budget = 1000 / target;
        let d = this.dyn;
        if (p90 > budget * 1.12) d = Math.max(0.6, d - 0.07);
        else if (p90 < budget * 0.8 && d < 1) d = Math.min(1, d + 0.04);
        if (Math.abs(d - this.dyn) > 0.001) { this.dyn = d; this.resize(this.w, this.h); }
      } else if (this.dyn !== 1) { this.dyn = 1; this.resize(this.w, this.h); }
    }
    return true;
  }
}
