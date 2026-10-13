// Jev questions for /fix-ci. Each can only add a question or an offer for
// the user: none removes a failure, answers a flag or decides a push.
//
// Jev reads names and one-line reasons only: the job and workflow names, the
// command, one scrubbed error line, file paths and the agent's reason for
// each edit. Never the code, never the log. Everything is scrubbed again here.

import * as C from './calibration.mjs';
import { scrub } from './scrub.mjs';

export const SKILL = 'fix-ci';
export const THRESHOLDS = {
  failure_is_transient: 0.7, // at or above: a rerun is offered for a failure the script classed as code
  fix_weakens_check: 0.6, // at or above: the edit is put to the user
  fix_matches_failure: 0.4, // below: the edit is put to the user
};
// unsafe: the error that must never happen (fn = saying no when the answer was yes, fp = the reverse).
export const SHAPE = {
  failure_is_transient: { acts_when: 'gte', unsafe: 'fp' },
  fix_weakens_check: { acts_when: 'gte', unsafe: 'fn' },
  fix_matches_failure: { acts_when: 'lt', unsafe: 'fp' },
};
// No outcome data yet: logged, never deciding. FIX_CI_TEST_CALIBRATED is for tests.
export const UNCALIBRATED = new Set(Object.keys(THRESHOLDS));
const forTests = (id) => (process.env.FIX_CI_TEST_CALIBRATED || '').split(',').includes(id);
export const calibrated = (id) => !UNCALIBRATED.has(id) || forTests(id) || C.isOn(SKILL, id);
export const thr = (id) => C.threshold(SKILL, id, THRESHOLDS[id]);
// One decision in ten of a question switched on by /calibrate is not acted on, and marked.
export const spot = (id, caseId) => UNCALIBRATED.has(id) && !forTests(id) && C.isOn(SKILL, id) && C.spotCheck(caseId);

export const MAX_FAILURES = 12;
export const MAX_EDITS = 15;
const noul = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
// A link or a query string can carry a token or a person's id.
export const clean = (s, n = 300) => scrub(String(s ?? '').replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '').replace(/\?[^\s"'<>)]*/g, '')).replace(/\s+/g, ' ').trim().slice(0, n);

// label: what the case id is made of, never sent (repo, pull request number).
// failures: [{ id, job, workflow, command, error, hash }]     failed jobs whose log was read
// edits:    [{ file, why, error, hash }]                      the fix, one row per file; error: the failure it is for
// -> { state, questions, cases: [{ question, key, case, show, target }] }
export function build(label, pr, failures, edits) {
  const fs = failures.slice(0, MAX_FAILURES);
  const es = edits.slice(0, MAX_EDITS);
  const state = {
    pull_request: clean(pr.title, 200),
    failures: fs.map((f) => ({ job: clean(f.job, 120), workflow: clean(f.workflow, 120), command: clean(f.command, 200), error: clean(f.error) })),
    edits: es.map((e) => ({ file: clean(e.file, 200), reason: clean(e.why), failure: clean(e.error) })),
  };
  const questions = {};
  const cases = [];
  const add = (question, key, q, target, show, hash) => {
    questions[key] = q;
    cases.push({ question, key, case: C.caseId(label, question, target, hash), show: clean(show), target });
  };
  fs.forEach((f, n) => {
    add('failure_is_transient', `transient__${n}`, noul(
      `Going by \`failures[${n}].command\` and \`failures[${n}].error\`, would this job pass if it ran again with no change to the code?`,
      'The error is about the machine or the network: a timeout, a lost connection, a download that failed, a full disk, a service that did not answer.',
      'The error is about the code: a failed assertion, a type error, a lint rule, a build error, a missing import.',
    ), f.id, `${f.job}: would it pass if run again? ${f.error}`, f.hash);
  });
  es.forEach((e, n) => {
    add('fix_weakens_check', `weakens__${n}`, noul(
      `Going by \`edits[${n}].reason\` and \`edits[${n}].file\`, does this edit make the check pass by weakening the check instead of fixing what it found?`,
      'The reason describes skipping, deleting, loosening or silencing a test, a rule or a type, or changing what the check expects without saying the expectation was wrong.',
      'The reason describes a change to the code under test, or a correction to a test with the reason the test was wrong.',
    ), `edit:${e.file}`, `${e.file}: does it weaken the check? ${e.why}`, e.hash);
    add('fix_matches_failure', `matches__${n}`, noul(
      `Does the edit described in \`edits[${n}].reason\` address the failure in \`edits[${n}].failure\`?`,
      'The reason names the cause of that failure and says how the edit removes it.',
      'The reason is about something else, or does not connect to that failure.',
    ), `edit:${e.file}`, `${e.file}: does it address "${e.error}"? ${e.why}`, e.hash);
  });
  return { state, questions, cases };
}

// Why Jev's number puts this to the user, or null.
export function reason(question, p) {
  const t = thr(question);
  if (question === 'fix_matches_failure') return p < t ? 'Jev does not read this edit as addressing the failure it is listed for' : null;
  if (p < t) return null;
  return question === 'fix_weakens_check' ? 'Jev reads this edit as weakening the check' : 'Jev reads this failure as one that passes when run again';
}
