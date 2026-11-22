// Performance index (class rating) + game rules (price / class limits), shared by the garage, AI and multiplayer.
export const PI_CLASSES = [['D', 0], ['C', 400], ['B', 500], ['A', 600], ['S1', 700], ['S2', 800], ['X', 900]];
export const downforce = v => -(v.aero.clF + v.aero.clR) * 0.5 * 1.225 * v.aero.A * (200 / 3.6) ** 2 / 9.81;
export function perfIndex(v) {
  const pw = v.engine.hp / v.mass * 1000;                         // hp per tonne
  const mu = v.tire.mu;                                             // tire grip incl. suspension/chassis bonus
  const df = Math.max(0, downforce(v)) / v.mass;                    // downforce share at 200 km/h
  const br = Math.min(1.4, v.brakes.torque);
  const pi = 40 + 1.75 * pw + 460 * (mu - 0.75) + 260 * df + 60 * (br - 1) - 120 * Math.max(0, v.aero.cd - 0.3);
  return Math.max(100, Math.min(999, Math.round(pi)));
}
export const piClass = n => PI_CLASSES.filter(([, t]) => n >= t).pop()[0];
export const piBadge = n => `<span class="pi ${piClass(n)}"><span class="c">${piClass(n)}</span><span class="v">${n}</span></span>`;
export const classMax = c => { const i = PI_CLASSES.findIndex(([k]) => k === c); return i < 0 || i === PI_CLASSES.length - 1 ? 999 : PI_CLASSES[i + 1][1] - 1; };

// ---------- rules ----------
export const BUDGETS = [[0, 'No price limit'], [20000, '$20k budget'], [40000, '$40k budget'], [75000, '$75k budget'], [150000, '$150k budget'], [300000, '$300k budget']];
export const CLASS_LIMITS = [['', 'Any class'], ['D', 'D class (PI ≤399)'], ['C', 'C class (PI ≤499)'], ['B', 'B class (PI ≤599)'], ['A', 'A class (PI ≤699)'], ['S1', 'S1 class (PI ≤799)'], ['S2', 'S2 class (PI ≤899)']];
let rules = { budget: 0, cls: '' };
try { rules = { ...rules, ...JSON.parse(localStorage.getItem('tf_rules') || '{}') }; } catch (e) { }
const listeners = new Set();
export const getRules = () => rules;
export function setRules(r, { save = true } = {}) {
  rules = { ...rules, ...r };
  if (save) { try { localStorage.setItem('tf_rules', JSON.stringify(rules)); } catch (e) { } }
  listeners.forEach(f => f(rules));
}
export const onRules = f => listeners.add(f);
export function rulesText(r = rules) {
  const a = [];
  if (r.budget) a.push(`$${(r.budget / 1000).toFixed(0)}k budget`);
  if (r.cls) a.push(`${r.cls} class max`);
  return a.length ? a.join(' · ') : 'Open rules';
}
// [] when legal, else human-readable reasons
export function ruleViolations(spec, r = rules) {
  const out = [];
  if (r.budget && spec.totalPrice > r.budget) out.push(`$${Math.round(spec.totalPrice - r.budget).toLocaleString()} over the $${(r.budget / 1000).toFixed(0)}k budget`);
  if (r.cls) { const pi = perfIndex(spec), mx = classMax(r.cls); if (pi > mx) out.push(`PI ${pi} is above ${r.cls} class (max ${mx})`); }
  if (spec.issues?.some(i => i.level === 'error')) out.push('build has compatibility errors');
  return out;
}
