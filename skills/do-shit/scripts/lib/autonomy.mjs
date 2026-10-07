// Gates the harness may decide instead of asking the user. Every decider is
// pure: (state, config, Jev answer) -> { auto, would, vetoes, ... }.
//   would: the inputs are clean and Jev agrees.
//   auto:  `would`, and the harness is allowed to act on it.
// When `would && !auto` the caller logs a shadow_gate event and still asks;
// that log is the calibration data. merge_approval and qa_approval have no
// decider here on purpose: they always ask.

import * as S from './state.mjs';
import { THRESHOLDS, isCalibrated } from './questions.mjs';

const MIGRATION = /(^|\/)(migrations?|drizzle|supabase)\/|(^|\/)schema[^/]*$|\.sql$/i;
const isSecurityFinding = (f) => /^\s*security\b/i.test(f.text || '');

// Code-only gates need just this. Jev-decided gates also need jevDecides().
export const autonomyOn = (config) => config.autonomy !== 'off';

const noul = (jev, id) => (jev && !jev.degraded && typeof jev.answers?.[id]?.noul === 'number' ? jev.answers[id].noul : null);
const jevDecides = (run, config, id) => autonomyOn(config) && run.mode === 'live' && isCalibrated(id);

export function recordAutoGate(run, { gate, decision, reason, p = null, ref = null }) {
  run.auto_gates ??= [];
  const entry = { gate, decision, reason, p, ref, at: new Date().toISOString() };
  run.auto_gates.push(entry);
  S.appendEvent(run.run_id, { type: 'auto_gate', ...entry });
}

export function recordShadowGate(run, { gate, decision, p = null, ref = null, blocked_by }) {
  S.appendEvent(run.run_id, { type: 'shadow_gate', gate, decision, p, ref, blocked_by });
}

// Why a `would` did not become an `auto`, for the shadow log and the payload.
export function blockedBy(run, config, id) {
  if (!autonomyOn(config)) return 'autonomy off';
  if (run.mode !== 'live') return `mode ${run.mode}`;
  if (!isCalibrated(id)) return `${id} is not calibrated`;
  return null;
}

// ---------------------------------------------------------------- checkpoint
export function checkpointVetoes(run) {
  const leaves = run.items.filter((i) => i.leaf && !i.excluded);
  const v = [];
  if (!leaves.length) v.push('no leaf left to build');
  if (run.flags?.checkpoint_asked) v.push('a human already answered a checkpoint in this run');
  if (run.items.some((i) => i.excluded)) v.push('an item was excluded or skipped');
  if (run.architect_failed) v.push('the architect failed: leaves build without a shared contract');
  if (run.plan?.warnings?.length) v.push(`planner warnings: ${run.plan.warnings.join('; ')}`);
  if ((run.plan?.estimate ?? 0) + run.spawns_used > run.spawn_cap) v.push('spawn estimate is over the cap');
  for (const i of leaves) {
    const p = i.plan || {};
    if (p.open_questions?.length) v.push(`${i.ref}: the plan has open questions`);
    if (p.uncovered_parent_work) v.push(`${i.ref}: parent work is not covered by any leaf`);
    if ((i.roles || []).includes('security-advisor')) v.push(`${i.ref}: touches a security-sensitive area`);
    if ((p.files || []).some((f) => MIGRATION.test(f))) v.push(`${i.ref}: the plan includes a migration or schema file`);
  }
  return v;
}

export function checkpointGate({ run, config, jev }) {
  const vetoes = checkpointVetoes(run);
  const p = noul(jev, 'plan_needs_human_review');
  const would = !vetoes.length && p !== null && p < THRESHOLDS.plan_needs_human_review;
  return { would, auto: would && jevDecides(run, config, 'plan_needs_human_review'), vetoes, p };
}

// ---------------------------------------------------------------- reapproval
// ls: the merge-fix team's leaf state. item: the leaf, with its approved plan.
// touched: files the fix changed, from git when the caller has it; the
// roles' own files_touched otherwise.
export function reapprovalVetoes({ ls, item, touched = null }) {
  const v = [];
  const reports = ls.loops.flatMap((l) => Object.values(l.reports));
  const last = ls.loops[ls.loops.length - 1];
  if (last.reports.tester?.verdict !== 'pass') v.push('the tester did not pass the fix');
  const planned = new Set(item.plan?.files || []);
  touched ??= [...new Set(reports.flatMap((r) => r.files_touched || []))];
  const outside = touched.filter((f) => !planned.has(f));
  if (outside.length) v.push(`the fix touched files outside the plan: ${outside.join(', ')}`);
  if (touched.some((f) => MIGRATION.test(f))) v.push('the fix touched a migration or schema file');
  if (reports.some((r) => r.role === 'security-advisor' || (r.findings || []).some(isSecurityFinding))) v.push('the fix has security findings');
  if (reports.some((r) => r.invalid)) v.push('a fix role returned an invalid report');
  return v;
}

export function reapprovalGate({ run, config, ls, item, jev, touched = null }) {
  const vetoes = reapprovalVetoes({ ls, item, touched });
  const p = noul(jev, 'fix_stays_within_item_scope');
  const would = !vetoes.length && p !== null && p >= THRESHOLDS.fix_stays_within_item_scope;
  return { would, auto: would && jevDecides(run, config, 'fix_stays_within_item_scope'), vetoes, p };
}

// ---------------------------------------------------------------- ci_pending (code only)
export const CI_RECHECK_SECONDS = 120;
// -> 'ask' | 'continue' | 'skip'
export function ciPendingGate({ config, entry, now = Date.now() }) {
  if (!autonomyOn(config)) return 'ask';
  const minutes = Number(config.ci_wait_minutes ?? 20);
  const since = Date.parse(entry.ci_first_pending_at || '') || now;
  return now - since < minutes * 60_000 ? 'continue' : 'skip';
}

// ---------------------------------------------------------------- offers (code only)
// Auto only when the repo states its preference; otherwise the gate asks.
export function offersGate(config) {
  if (!autonomyOn(config) || !config.after_qa) return null;
  return { fix_bugs: Boolean(config.after_qa.fix_bugs), e2e: Boolean(config.after_qa.e2e) };
}
