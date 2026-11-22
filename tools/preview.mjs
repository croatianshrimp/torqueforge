// Contact sheet of processed cars in the showroom: node tools/preview.mjs <outDir> [ids...]  (needs the dev server on :8765)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const [out, ...ids0] = process.argv.slice(2);
const index = JSON.parse(fs.readFileSync(new URL('../assets/cars/index.json', import.meta.url)));
const ids = ids0.length ? ids0 : Object.keys(index);
const steps = [{ wait: 1500 }, { eval: "(()=>{__tf.setTurntable(false); document.querySelector('#statsPanel').style.display='none'; document.querySelector('#partsPanel').style.display='none'; document.querySelector('#tuning').style.display='none'; dispatchEvent(new Event('resize')); return 'ok'})()" }];
for (const id of ids) {
  for (const [ang, tag] of [[0.75, 'a'], [Math.PI / 2, 's']]) {
    steps.push({ eval: `(()=>{const s=__tf.sel; for (const k of Object.keys(s)) if (Array.isArray(s[k])) s[k]=[]; else if (!['tuning','name'].includes(k)) s[k]=null; s.car='${id}'; __tf.update(); __tf.turn.rotation.y=${ang}; __tf.cam.position.set(0,1.5,7.6); __tf.controls.update(); return 'ok'})()` });
    steps.push({ wait: 2200 });
    steps.push({ shot: `pv_${id}_${tag}.png` });
  }
}
fs.writeFileSync(out + '/pv_steps.json', JSON.stringify(steps));
execFileSync('node', [new URL('./cdp.mjs', import.meta.url).pathname, 'http://127.0.0.1:8765/index.html', out + '/pv_steps.json', out], { stdio: 'inherit', env: { ...process.env, CDP_GPU: '1' } });
