// What stays and what the run is worth. Two decisions, both made here from
// recorded facts: whether one move is kept, and the verdict for the whole run.
// A model's report can make either worse and can never make either better.

// impeccable's critique scores Nielsen's ten, 0 to 4 each, "n/a" where a
// heuristic cannot apply to the surface.
export const HEURISTICS = [
  { id: 'h1', name: 'Visibility of system status' },
  { id: 'h2', name: 'Match between system and real world' },
  { id: 'h3', name: 'User control and freedom' },
  { id: 'h4', name: 'Consistency and standards' },
  { id: 'h5', name: 'Error prevention' },
  { id: 'h6', name: 'Recognition rather than recall' },
  { id: 'h7', name: 'Flexibility and efficiency' },
  { id: 'h8', name: 'Aesthetic and minimalist design' },
  { id: 'h9', name: 'Error recovery' },
  { id: 'h10', name: 'Help and documentation' },
];
// impeccable's audit: five technical dimensions, 0 to 4 each.
export const AUDIT = ['accessibility', 'performance', 'theming', 'responsive', 'integrity'];

// -> { scores, total, max, na }. Throws on a report that is not a full set.
export function parseScores(raw, items = HEURISTICS.map((h) => h.id)) {
  if (!raw || typeof raw !== 'object') throw new Error('no scores in the report');
  const scores = {};
  const na = [];
  let total = 0;
  for (const id of items) {
    const v = raw[id];
    if (v === 'n/a') {
      scores[id] = 'n/a';
      na.push(id);
    } else if (Number.isInteger(v) && v >= 0 && v <= 4) {
      scores[id] = v;
      total += v;
    } else throw new Error(`score for ${id} must be 0 to 4 or "n/a", got ${JSON.stringify(v)}`);
  }
  return { scores, total, max: 4 * (items.length - na.length), na };
}

// Nothing overrides these: not the comparison, not Jev, not the user's pick.
export const VETOES = ['no_commit', 'blocked', 'uncommitted_changes', 'out_of_scope', 'gate_red', 'new_detector_finding'];

// check:   {committed, blocked, dirty, out_of_scope: [], gates_red: [], new_findings: [], unchecked: []}
//          unchecked: what could not be checked (the detector did not run). Never a pass.
// compare: unblinded rows for this move, or null when nothing was rendered
// jev:     {is_improvement: {p, threshold, on}, harms_another_state: {p, threshold, on}}
// -> { keep, vetoed, unverified, same: [viewports], reasons }
export function moveDecision({ check, compare = null, visual = true, issueGone = null, jev = null }) {
  const reasons = [];
  if (check.blocked) reasons.push('blocked');
  else if (!check.committed) reasons.push('no_commit');
  if (check.dirty) reasons.push('uncommitted_changes');
  if (check.out_of_scope?.length) reasons.push(`out_of_scope: ${check.out_of_scope.slice(0, 3).join(', ')}`);
  if (check.gates_red?.length) reasons.push(`gate_red: ${check.gates_red.join(', ')}`);
  if (check.new_findings?.length) reasons.push(`new_detector_finding: ${check.new_findings.slice(0, 3).join(', ')}`);
  if (reasons.length) return { keep: false, vetoed: true, unverified: false, same: [], reasons };

  let unverified = (check.unchecked || []).length > 0;
  const same = [];
  if (!visual) {
    if (issueGone !== true) reasons.push('issue_still_there');
  } else {
    const rows = (compare || []).filter((r) => r.prefers !== 'missing');
    if (!rows.length || rows.length < (compare || []).length) unverified = true;
    for (const r of rows) {
      if (r.prefers === 'before') reasons.push(`before_preferred at ${r.viewport}`);
      if (r.broke) reasons.push(`broke at ${r.viewport}: ${r.broke.what} (${r.broke.where})`);
      if (r.prefers === 'same') same.push(r.viewport);
    }
    if (rows.length && same.length === rows.length && !reasons.length) reasons.push('no_visible_difference');
  }
  if (reasons.length) return { keep: false, vetoed: false, unverified: false, same: [], reasons };

  // Jev only subtracts, and only where /calibrate switched the question on.
  const improvement = jev?.is_improvement;
  const harm = jev?.harms_another_state;
  if (improvement?.on && typeof improvement.p === 'number' && improvement.p < improvement.threshold) reasons.push('jev: is_improvement');
  if (harm?.on && typeof harm.p === 'number' && harm.p >= harm.threshold) reasons.push('jev: harms_another_state');
  if (reasons.length) return { keep: false, vetoed: false, unverified: false, same: [], reasons };
  return { keep: true, vetoed: false, unverified, same, reasons: [] };
}

export const VERDICTS = ['better', 'mixed', 'unverified', 'no_change'];

// run: {mode: rendered|code_only, moves: [{id, visual, decision}], baseline, final, detector: {baseline, final}}
// baseline and final are parseScores() results; final is null when the re-score never happened.
export function verdict({ mode, moves, baseline, final, detector }) {
  const kept = (moves || []).filter((m) => m.decision?.keep);
  if (!kept.length) return { verdict: 'no_change', reasons: ['no move was kept'] };

  const blind = [];
  if (mode !== 'rendered') blind.push('nothing was rendered: the run was code-only');
  const unseen = kept.filter((m) => m.decision.unverified).map((m) => m.id);
  if (unseen.length) blind.push(`kept without being fully checked: ${unseen.join(', ')}`);
  if (!final) blind.push('the result was never re-scored');
  if (!detector) blind.push('the detector did not run on the result');
  if (blind.length) return { verdict: 'unverified', reasons: blind };

  const reasons = [];
  const lower = HEURISTICS.filter((h) => Number.isInteger(baseline.scores[h.id]) && Number.isInteger(final.scores[h.id]) && final.scores[h.id] < baseline.scores[h.id]);
  if (lower.length) reasons.push(`scored lower than before: ${lower.map((h) => `${h.id} ${h.name} ${baseline.scores[h.id]} to ${final.scores[h.id]}`).join('; ')}`);
  // Totals are compared as a share of what applied, so an n/a on one side does not count as a gain or a loss.
  if (final.max && baseline.max && final.total / final.max < baseline.total / baseline.max) reasons.push(`total ${final.total}/${final.max} is below the ${baseline.total}/${baseline.max} it started at`);
  if (detector && detector.final > detector.baseline) reasons.push(`detector findings went from ${detector.baseline} to ${detector.final}`);
  const same = kept.filter((m) => m.decision.same?.length);
  if (same.length) reasons.push(`no difference seen at a viewport: ${same.map((m) => `${m.id} at ${m.decision.same.join(', ')}`).join('; ')}`);
  return { verdict: reasons.length ? 'mixed' : 'better', reasons };
}

export const DRAFT_MODES = ['auto', 'always', 'never'];
// Whether the pull request opens as a draft, or null when none opens.
export function draftFor(v, mode = 'auto') {
  if (v === 'no_change') return null;
  if (v === 'unverified') return true;
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return v !== 'better';
}
