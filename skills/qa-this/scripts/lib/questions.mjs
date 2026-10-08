// Jev questions for /qa-this. Jev sees derived facts only: an item's title, its
// criteria lines, changed file paths and one line per check. Never diff or
// source text, command output, row values, screenshots or a URL's query
// string. Everything is scrubbed again here before it leaves.

import * as C from './calibration.mjs';
import { scrub } from './scrub.mjs';

export const SKILL = 'qa-this';
export const THRESHOLDS = {
  needs_browser_check: 0.7, // at or above: add the browser method
  needs_data_check: 0.7, // at or above: add the database method
  needs_new_tests: 0.7, // at or above: add new tests
  check_covers_criterion: 0.3, // below: this check does not exercise its criterion
  failure_is_environmental: 0.8, // at or above: the failure is the environment's, not the product's
};
// acts_when: which side of the threshold changes anything. unsafe: the error
// that must never happen (fn = saying no when the answer was yes, fp = the reverse).
export const META = {
  needs_browser_check: { acts_when: 'gte', unsafe: 'fn' },
  needs_data_check: { acts_when: 'gte', unsafe: 'fn' },
  needs_new_tests: { acts_when: 'gte', unsafe: 'fn' },
  check_covers_criterion: { acts_when: 'lt', unsafe: 'fp' },
  failure_is_environmental: { acts_when: 'gte', unsafe: 'fp' },
};
export const NEEDS = { needs_browser_check: 'browser', needs_data_check: 'database', needs_new_tests: 'new_tests' };
// No outcome data yet: logged, never deciding. QA_THIS_TEST_CALIBRATED is for tests.
export const UNCALIBRATED = new Set(Object.keys(THRESHOLDS));
const forTests = (id) => (process.env.QA_THIS_TEST_CALIBRATED || '').split(',').includes(id);
export const calibrated = (id) => !UNCALIBRATED.has(id) || forTests(id) || C.isOn(SKILL, id);
export const thr = (id) => C.threshold(SKILL, id, THRESHOLDS[id]);
// One decision in ten of a question switched on by /calibrate is not acted on, and marked.
export const spot = (id, caseId) => UNCALIBRATED.has(id) && !forTests(id) && C.isOn(SKILL, id) && C.spotCheck(caseId);

export const MAX_CHECKS = 20;
const noul = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
// A query string can carry a token or a person's id.
const clean = (s, n) => scrub(String(s ?? '').replace(/\?[^\s"'<>)]*/g, '')).slice(0, n);
export const checkLine = (c) => clean(`${c.method}: ${c.action} -> ${c.expected}`, 300);

// item: { title, criteria: [{id, text}], changed_files, checks: [{id, criterion, method, action, expected}] }
export function buildPlan(item) {
  const checks = (item.checks || []).slice(0, MAX_CHECKS);
  const criteria = item.criteria || [];
  const state = {
    title: clean(item.title, 200),
    criteria: criteria.map((c) => clean(c.text, 300)),
    changed_files: (item.changed_files || []).slice(0, 50).map((f) => clean(f, 200)),
    checks: checks.map(checkLine),
  };
  const questions = {
    needs_browser_check: noul(
      'Going by `title`, `criteria` and `changed_files`, does checking this work properly need someone to use it in a browser?',
      'A criterion is about what a person sees or does on a screen, or the change alters a page, a form or a flow.',
      'The change is internal: a library, a job, a script, a schema or an API with no screen of its own.',
    ),
    needs_data_check: noul(
      'Going by `title`, `criteria` and `changed_files`, does checking this work properly need a look at what ended up stored in the database?',
      'A criterion is about data being saved, changed, migrated or kept consistent.',
      'Nothing stored changes, or what is stored is fully visible through the screen or the response.',
    ),
    needs_new_tests: noul(
      'Going by `criteria` and `checks`, is there a criterion that only a new automated test would check reliably?',
      'A criterion has no existing test among `checks`, and it is the kind of behaviour a test can pin down.',
      'Every criterion already has an automated test among `checks`, or what is left can only be judged by eye.',
    ),
  };
  checks.forEach((c, n) => {
    const at = criteria.findIndex((k) => k.id === c.criterion);
    questions[`covers__${n}`] = noul(
      `Would \`checks[${n}]\`, if it passed, show that \`criteria[${at}]\` is met?`,
      'The check performs the behaviour the criterion describes and looks at the result the criterion names.',
      'The check looks at something else, only loads a page, or would pass whether or not the criterion were met.',
    );
  });
  return { state, questions, checks };
}

// failures: [{id, method, action, expected, signal}] — signal is derived: "exit 1", "http 503", "timeout", or the tester's one-line observation.
export function buildFailures(item, failures) {
  const list = failures.slice(0, MAX_CHECKS);
  const state = { title: clean(item.title, 200), failures: list.map((f) => ({ check: checkLine(f), observed: clean(f.signal, 200) })) };
  const questions = {};
  list.forEach((_, n) => {
    questions[`environmental__${n}`] = noul(
      `Is \`failures[${n}]\` a failure of the test environment rather than of the product being tested?`,
      'The service was unreachable, the session expired, a dependency timed out, test data was missing, or the runner itself broke.',
      'The product responded and did the wrong thing: wrong result, wrong screen, wrong data, or an error in its own logic.',
    );
  });
  return { state, questions, failures: list };
}
