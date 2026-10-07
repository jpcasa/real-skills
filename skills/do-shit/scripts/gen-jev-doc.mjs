// Regenerates references/jev-questions.md from lib/questions.mjs (single source).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as Q from './lib/questions.mjs';

const leaves = { leaves: [{ id: 'A' }, { id: 'B' }] };
const sets = [
  ['Role pick (per leaf)', 'plan', Q.roleNeeds({})],
  ['Architect trigger', 'plan', Q.sharesInterface(leaves)],
  ['Pairwise overlap + dependency (per pair i<j)', 'plan', Q.pairwise(leaves, [[0, 1]])],
  ['Checkpoint review (only when no veto fires)', 'plan', Q.planReview({})],
  ['Loop decision (only when review failed)', 'build', Q.loopDecision({})],
  ['Merge gate (only when CI red or comments open)', 'merge', Q.mergeGate({})],
  ['Fix scope (a merge fix changed an approved PR, no veto fired)', 'merge', Q.fixScope({})],
  ['QA failure (per failed step)', 'qa', Q.qaFailure({})],
];
const thr = (id) => {
  const base = id.startsWith('needs_') ? 'needs_role' : id.startsWith('overlap__') ? 'overlap' : id.startsWith('depends__') ? 'depends_on' : id;
  return Q.THRESHOLDS[base] ?? '—';
};
const out = [
  '# Jev question catalog',
  '',
  'Generated from `scripts/lib/questions.mjs` by `node scripts/gen-jev-doc.mjs`. Do not edit by hand.',
  '',
  'Code owns every decision; these answers feed policy in `scripts/lib/policy.mjs`, `scripts/lib/merge.mjs` and `scripts/lib/autonomy.mjs`. Thresholds are defaults until `harness eval` calibrates them.',
  '',
  'A question listed in `UNCALIBRATED` has no eval fixtures yet. Its answer is logged (`jev` and `shadow_gate` events) and decides nothing, in every mode. Removing it from that set, after `harness eval` has data for it, is what lets it decide.',
  '',
  '| Threshold key | Value |',
  '|---|---|',
  ...Object.entries(Q.THRESHOLDS).map(([k, v]) => `| \`${k}\` | ${v} |`),
  '',
];
for (const [title, phase, { questions }] of sets) {
  out.push(`## ${title} — phase: ${phase}`, '');
  for (const [id, q] of Object.entries(questions)) {
    out.push(`### \`${id}\` (${q.type}, threshold ${thr(id)}${Q.UNCALIBRATED.has(id) ? ', **uncalibrated: logged, never decides**' : ''})`, '', q.instructions, '');
    if (q.type === 'noul') out.push(`- **yes:** ${q.criteria.true}`, `- **no:** ${q.criteria.false}`, '');
    if (q.type === 'choice') out.push(...Object.entries(q.criteria).map(([k, v]) => `- **${k}:** ${v}`), '');
    if (q.type === 'score') out.push(...q.criteria.map((v, i) => `${i}. ${v}`), '');
  }
}
const resFile = new URL('./eval/results.json', import.meta.url);
if (existsSync(resFile)) {
  const res = JSON.parse(readFileSync(resFile, 'utf8'));
  out.push('## Calibration (`harness eval`)', '', `${res.fixtures} fixtures from a private repo's history, ${res.errors.length} errors. Eval "current" is the threshold at eval time; the table at the top is what the harness uses.`, '',
    '| Family | n | positives | threshold at eval | accuracy there | best plateau | best F1 / accuracy |', '|---|---|---|---|---|---|---|',
    ...Object.entries(res.report).map(([k, v]) => `| \`${k}\` | ${v.n} | ${v.positives} | ${v.current} | ${v.accuracy_at_current} | ${v.best.plateau?.join('–') ?? v.best.threshold} | ${v.best.f1} / ${v.best.accuracy} |`),
    '', 'Notes: `same_failure_as_last_loop` (n=5) and `open_review_comments_blocking` (n=4) are thin; `plan_is_wrong` misses a true positive at p=0.24 (one private PR: the ticket targeted the smaller problem), so consider rewording it. Re-run `harness eval` after adding fixtures from real /do-shit shadow runs.', '');
}
writeFileSync(new URL('../references/jev-questions.md', import.meta.url), out.join('\n'));
console.log('wrote references/jev-questions.md');
