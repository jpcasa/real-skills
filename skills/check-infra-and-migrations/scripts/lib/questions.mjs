// Jev questions for /check-infra-and-migrations. Jev sees the title of the
// change, the bucketed file paths, one normalized line per statement or
// infrastructure hit (keywords and identifiers, every literal already replaced
// by `?`), the rule names that fired and when migrations run. Never a full
// file, a diff hunk, a literal, plan or query output, a row count or a host.
// From a plan only the action and the resource type go, never a name.
// Everything is scrubbed again here before it leaves: links, host-like names,
// and double-quoted text in a value position (a string in MySQL).

import * as C from './calibration.mjs';
import { scrub } from './scrub.mjs';
import { RULES, severityOf } from './rules.mjs';

export const SKILL = 'check-infra-and-migrations';
export const THRESHOLDS = {
  destroys_data: 0.5, // at or above: add a blocker
  breaks_running_code: 0.6, // at or above: add a risk
  infra_change_is_disruptive: 0.6, // at or above: add a risk
  needs_manual_step: 0.6, // at or above: add a runbook note
  safe_to_push: 0.5, // below: a `safe` verdict becomes `caution`
};
// acts_when: which side of the threshold changes anything. unsafe: the error
// that must never happen (fn = saying no when the answer was yes, fp = the reverse).
// Whatever the answer, Jev can only make a verdict worse.
export const SHAPE = {
  destroys_data: { acts_when: 'gte', unsafe: 'fn' },
  breaks_running_code: { acts_when: 'gte', unsafe: 'fn' },
  infra_change_is_disruptive: { acts_when: 'gte', unsafe: 'fn' },
  needs_manual_step: { acts_when: 'gte', unsafe: 'fn' },
  safe_to_push: { acts_when: 'lt', unsafe: 'fp' },
};
// No outcome data yet: logged, never deciding. CHECK_INFRA_TEST_CALIBRATED is for tests.
export const UNCALIBRATED = new Set(Object.keys(THRESHOLDS));
const forTests = (id) => (process.env.CHECK_INFRA_TEST_CALIBRATED || '').split(',').includes(id);
export const calibrated = (id) => !UNCALIBRATED.has(id) || forTests(id) || C.isOn(SKILL, id);
export const thr = (id) => C.threshold(SKILL, id, THRESHOLDS[id]);
// One decision in ten of a question switched on by /calibrate is not acted on, and marked.
export const spot = (id, caseId) => UNCALIBRATED.has(id) && !forTests(id) && C.isOn(SKILL, id) && C.spotCheck(caseId);

export const MAX_CHANGES = 20;
const MAX_INFRA = 8;
const noul = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
// A link can carry a host or a token.
const clean = (s, n) => scrub(String(s ?? '').replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link]')).slice(0, n);
const HOST = /\b(?:[a-z0-9-]+\.){2,}[a-z]{2,}\b/gi;
const VALUE = /(?<=(?:[=(,<>!]|\b(?:VALUES|IN|LIKE))\s*)(?:"[^"]*"|`[^`]*`)/gi;
// One change line as Jev may see it.
const line = (s) => clean(String(s ?? '').replace(VALUE, '?').replace(HOST, '[host]'), 200);
const infraLine = (f) => (f.origin === 'plan' ? `plan: ${String(f.rule).replace(/^plan_/, '').replace(/_/g, ' ')} ${f.resource?.type || ''}`.trim() : f.normalized);

// target: { title, buckets, statements: [{file, line, normalized, rule}], applied }
// findings: every finding the rules and the agent kept.
export function build(target, findings) {
  const at = (file, line) => findings.filter((f) => f.file === file && f.line === line);
  const infra = findings.filter((f) => f.source !== 'agent' && f.bucket !== 'migration' && f.normalized).slice(0, MAX_INFRA);
  const statements = (target.statements || []).slice(0, MAX_CHANGES - infra.length);
  const worst = (fs) => (fs.some((f) => severityOf(f) === 'blocker') ? 'blocker' : fs.some((f) => severityOf(f) === 'risk') ? 'risk' : 'note');
  const changes = [
    ...statements.map((s) => ({ kind: 'statement', bucket: 'migration', file: s.file, line: s.line, text: line(s.normalized), key: `${s.file}:${s.line}:${s.rule}`, already: worst(at(s.file, s.line)) })),
    ...infra.map((f) => ({ kind: 'infra', bucket: f.bucket, file: f.file, line: f.line, text: line(infraLine(f)), key: `${f.file ?? 'plan'}:${f.line ?? 0}:${f.rule}:${f.resource?.name ?? ''}`, already: severityOf(f) })),
  ];
  const state = {
    title: clean(String(target.title ?? '').replace(HOST, '[host]'), 200),
    migrations_run: target.applied || 'unknown',
    paths: Object.values(target.buckets || {}).flat().slice(0, 60).map((p) => clean(p, 200)),
    changes: changes.map((c) => c.text),
    rules: [...new Set(findings.map((f) => f.rule).filter((r) => RULES[r]))],
  };
  const questions = {
    needs_manual_step: noul(
      'Going by `changes`, `rules` and `migrations_run`, does this release need a step a person must do outside the normal deploy?',
      'Something has to be done by hand: a backup, a backfill, a variable set on the target, a statement run on its own, a deploy in two parts.',
      'The normal deploy applies everything in `changes` with nothing extra.',
    ),
    safe_to_push: noul(
      'Going by `changes` and `rules`, can this be pushed with the normal deploy and no extra care?',
      'Every change is additive or harmless: nothing is dropped, rewritten, renamed, locked for long, replaced or opened up.',
      'At least one change can lose data, break running code, lock a table that takes traffic, replace a resource or widen access.',
    ),
  };
  changes.forEach((c, n) => {
    questions[`destroys__${n}`] = noul(
      `Would \`changes[${n}]\` lose data that cannot be rebuilt once it runs?`,
      'It drops, empties, overwrites or deletes stored data, or removes or replaces something that holds data.',
      'It adds something, changes structure without losing values, or only touches what can be rebuilt.',
    );
    if (c.kind === 'statement') {
      questions[`breaks__${n}`] = noul(
        `Would code that was written before \`changes[${n}]\` fail once it has run?`,
        'It removes or renames something existing code reads or writes, or adds a requirement existing writes do not meet.',
        'Existing code keeps working: the change only adds, or touches nothing existing code uses.',
      );
    } else {
      questions[`disruptive__${n}`] = noul(
        `Would \`changes[${n}]\` take a running service down or replace a resource?`,
        'It removes, replaces, resizes or reconfigures something a running service depends on, or opens access.',
        'It adds something new or changes a setting that takes effect without interruption.',
      );
    }
  });
  return { state, questions, changes };
}
