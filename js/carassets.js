// Loads processed car models (assets/cars/<id>/{low,high}.glb + manifest) made by tools/process_model.mjs.
import * as THREE from '../vendor/three.module.js';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/meshopt_decoder.module.js';

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
let INDEX = {};
const cache = new Map();   // `${id}:${lod}` -> Promise<{scene, manifest}>
const ready = new Map();   // resolved entries

export async function initCarAssets() {
  try {
    const r = await fetch('assets/cars/index.json', { cache: 'no-cache' });
    if (r.ok) INDEX = await r.json();
  } catch (e) { INDEX = {}; }
  return INDEX;
}
export const hasRealModel = id => !!INDEX[id];
export const carCredit = id => INDEX[id]?.credit || null;
export const allCredits = () => Object.entries(INDEX).map(([id, m]) => ({ id, ...m.credit }));

export function getCarAsset(id, lod) { return ready.get(`${id}:${lod}`) || null; }

export function loadCarAsset(id, lod = 'high') {
  if (!INDEX[id]) return Promise.resolve(null);
  const key = `${id}:${lod}`;
  if (!cache.has(key)) {
    cache.set(key, loader.loadAsync(`assets/cars/${id}/${lod}.glb`).then(g => {
      const scene = g.scene;
      scene.traverse(o => {
        if (o.isMesh) {
          o.castShadow = true; o.receiveShadow = true;
          // meshopt-quantised positions: make sure bounds exist for culling
          if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        }
      });
      const entry = { scene, manifest: INDEX[id] };
      ready.set(key, entry);
      return entry;
    }).catch(e => { console.warn('car model failed', id, e); cache.delete(key); return null; }));
  }
  return cache.get(key);
}

const GLASS = /glass|window|windscreen|windshield|vidro|cristal|scheibe/i;
const isGlass = m => (m.transmission > 0) || (GLASS.test(m.name) && !/light|lamp|lens|mirror|tail|head/i.test(m.name)) || (m.transparent && m.opacity < 0.7 && !/light|lamp|lens|opaque|interior|stitch|alcantara|leather|carpet|seat|trim/i.test(m.name));

// Deep-ish clone: share geometry + most materials, but give this instance its own paint + tail-light materials.
export function instantiateCar(entry, { paint = null, quality, paintMats: bodyPaint = null } = {}) {
  const m = entry.manifest;
  const root = entry.scene.clone(true);
  const paintMats = [], tailMats = [];
  const swapped = new Map();
  const paintSet = new Set(m.paint || []), tailSet = new Set(m.tail || []);
  root.traverse(o => {
    if (!o.isMesh) return;
    const conv = mat => {
      if (swapped.has(mat)) return swapped.get(mat);
      let out = mat;
      if (bodyPaint ? bodyPaint.includes(mat) : paintSet.has(mat.name)) {
        const p = new THREE.MeshPhysicalMaterial();
        THREE.MeshStandardMaterial.prototype.copy.call(p, mat);
        if (quality.clearcoat) { p.clearcoat = 1; p.clearcoatRoughness = 0.04; }
        if (paint) { p.color.set(paint); p.map = null; }
        p.roughness = Math.min(p.roughness, 0.45);
        p.envMapIntensity = 1.0;
        paintMats.push(p); out = p;
      } else if (tailSet.has(mat.name)) {
        out = mat.clone(); out.emissive = new THREE.Color(0xff1a10); out.emissiveIntensity = 0.15; tailMats.push(out);
      } else if (isGlass(mat)) {
        const g = new THREE.MeshPhysicalMaterial({ name: mat.name, color: 0x0b0f14, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.42, depthWrite: false, envMapIntensity: 1.2, side: THREE.DoubleSide });
        if (quality.transmission) { g.transmission = 0.9; g.opacity = 1; g.thickness = 0.004; g.ior = 1.5; g.color.set(0x9aa4ad); g.transparent = false; g.depthWrite = true; }
        out = g;
      }
      swapped.set(mat, out);
      return out;
    };
    o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
  });
  // the main body skin (largest painted area, from analyzeShell) so bolt-on panels copy the right paint
  const mainPaint = bodyPaint?.length ? swapped.get(bodyPaint[0]) || null : null;
  return { root, paintMats, tailMats, manifest: m, mainPaint };
}
