// The bar a logged Jev question has to clear before it may decide.
//
//   1. MIN_LABELED labeled cases, MIN_EACH of each answer.
//   2. A threshold with zero unsafe errors in the sample. Among those that act
//      most often, the middle one, and never less than one STEP from the
//      unsafe side.
//      (A question with no unsafe side is chosen on accuracy.)
//   3. At that threshold it acts on at least MIN_ACT_RATE of cases.
//
// Zero unsafe errors in n cases does not mean zero: the true rate may still be
// up to about 3/n. `bound` carries that number so the report can say it.

import { acts, isUnsafe, says } from './calibration.mjs';

export const MIN_LABELED = 30;
export const MIN_EACH = 5;
export const MIN_ACT_RATE = 0.1;
export const STEP = 0.05;
export const NEAR = 0.1;
const GRID = Array.from({ length: 19 }, (_, i) => (i + 1) / 20);
const r2 = (x) => Math.round(x * 100) / 100;

function at(rows, t, actsWhen, unsafe) {
  let ok = 0, bad = 0, acted = 0;
  for (const c of rows) {
    if (says(c.p, t) === c.label) ok++;
    if (isUnsafe(c.p, t, c.label, unsafe)) bad++;
    if (acts(c.p, t, actsWhen)) acted++;
  }
  return { threshold: r2(t), unsafe_errors: bad, accuracy: r2(ok / rows.length), act_rate: r2(acted / rows.length) };
}

// cases: every logged case of ONE question, each {p, label?: boolean, acts_when, unsafe, threshold, case, show?}
export function evaluate(cases) {
  const last = cases[cases.length - 1] || {};
  const actsWhen = last.acts_when || 'gte';
  const unsafe = last.unsafe ?? null;
  const builtin = typeof last.threshold === 'number' ? last.threshold : 0.5;
  const rows = cases.filter((c) => typeof c.p === 'number' && typeof c.label === 'boolean');
  const yes = rows.filter((c) => c.label).length;
  const base = {
    cases: cases.length, labeled: rows.length, split: { true: yes, false: rows.length - yes },
    acts_when: actsWhen, unsafe, current_threshold: builtin,
  };
  if (rows.length < MIN_LABELED || Math.min(yes, rows.length - yes) < MIN_EACH) {
    return {
      ...base, status: 'not enough data',
      need: { labeled: Math.max(0, MIN_LABELED - rows.length), true: Math.max(0, MIN_EACH - yes), false: Math.max(0, MIN_EACH - (rows.length - yes)) },
    };
  }
  const current = at(rows, builtin, actsWhen, unsafe);
  const grid = GRID.map((t) => at(rows, t, actsWhen, unsafe));
  let pick;
  if (unsafe) {
    const safe = grid.filter((g) => g.unsafe_errors === 0);
    if (!safe.length) return { ...base, status: 'no safe threshold', current };
    // The safe thresholds that act most often (then most accurately) form a
    // run. fp errors shrink as the threshold rises and fn errors as it falls,
    // so one end of that run touches the unsafe side. Take the middle of the
    // run, and never less than one STEP away from that end.
    const top = safe.reduce((m, g) => (g.act_rate > m.act_rate || (g.act_rate === m.act_rate && g.accuracy > m.accuracy) ? g : m));
    const run = safe.filter((g) => g.act_rate === top.act_rate && g.accuracy === top.accuracy).map((g) => g.threshold).sort((a, b) => a - b);
    const edge = unsafe === 'fp' ? run[0] : run[run.length - 1];
    const steps = Math.max(1, Math.floor(run.length / 2));
    const stepped = Math.min(0.95, Math.max(0.05, edge + (unsafe === 'fp' ? 1 : -1) * steps * STEP));
    pick = at(rows, stepped, actsWhen, unsafe);
  } else {
    pick = grid.sort((a, b) => b.accuracy - a.accuracy || Math.abs(a.threshold - builtin) - Math.abs(b.threshold - builtin))[0];
  }
  const near = cases
    .filter((c) => typeof c.p === 'number' && Math.abs(c.p - pick.threshold) <= NEAR)
    .sort((a, b) => Math.abs(a.p - pick.threshold) - Math.abs(b.p - pick.threshold))
    .slice(0, 10)
    .map((c) => ({ case: c.case, p: c.p, label: c.label ?? null, ...(c.show ? { show: c.show } : {}) }));
  return {
    ...base, current, proposed: pick,
    ...(unsafe ? { bound: r2(3 / rows.length) } : {}),
    near,
    status: pick.act_rate < MIN_ACT_RATE ? 'never acts' : 'ready',
  };
}
