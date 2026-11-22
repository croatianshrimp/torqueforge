// Headless sanity checks: node tools/selftest.mjs
// Runs every stock car through the drag/brake/top-speed/skidpad/lap sims and every part through compatibility.
import { CARS, PARTS } from '../js/data.js';
import { evaluate, emptyBuild, candidateCheck } from '../js/build.js';
import { fullStats } from '../js/physics.js';
import { CIRCUIT } from '../js/track.js';
let fails = 0;
const f = (x, d = 2) => x == null ? '  -- ' : x.toFixed(d).padStart(5);
console.log('car'.padEnd(13), ' hp   0-60   1/4    trap  top  100-0  skid   lap');
for (const c of CARS) {
  const s = evaluate(emptyBuild(c.id));
  if (s.errors) { fails++; console.log('STOCK ERROR', c.id, s.issues); }
  const r = fullStats(s, CIRCUIT);
  if (!r.drag.quarter || !isFinite(r.lap.time) || !isFinite(r.brake.dist)) { fails++; console.log('SIM FAIL', c.id); }
  for (const p of PARTS) candidateCheck(emptyBuild(c.id), p.cat, p.id);
  for (const code of c.swaps) { const e = evaluate({ ...emptyBuild(c.id), engine: code }); if (e.errors) { fails++; console.log('SWAP ERROR', c.id, code); } }
  console.log(c.id.padEnd(13), String(Math.round(s.engine.hp)).padStart(3), f(r.drag.t60), f(r.drag.quarter), String(Math.round(r.drag.trap * 2.237)).padStart(5), String(Math.round(r.top.v * 3.6)).padStart(4), f(r.brake.dist, 1), f(r.skid.g), f(r.lap.time));
}
console.log(fails ? `\n${fails} FAILURES` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
