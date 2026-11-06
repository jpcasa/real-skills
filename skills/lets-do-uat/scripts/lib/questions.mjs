// Jev questions for /lets-do-uat. Jev sees derived facts only: the item title,
// PR titles, changed file paths, flow titles and step lines, and for a failed
// step its one-line observation and the failed endpoints. Never diff or source
// text, page text, screenshots, request bodies or a URL's query string.

import * as C from './calibration.mjs';
import { scrub } from './scrub.mjs';

export const SKILL = 'lets-do-uat';
export const THRESHOLDS = {
  flows_cover_change: 0.4, // below: the approval question warns that a change may have no flow
  step_needs_confirm: 0.7, // at or above: in agent mode, the user says yes before this step
  failure_is_environmental: 0.8, // at or above: the failed step counts as blocked, not failed
};
// acts_when: which side of the threshold changes anything. unsafe: the error
// that must never happen (fn = saying no when the answer was yes, fp = the reverse).
export const META = {
  flows_cover_change: { acts_when: 'lt', unsafe: 'fp' },
  step_needs_confirm: { acts_when: 'gte', unsafe: 'fn' },
  failure_is_environmental: { acts_when: 'gte', unsafe: 'fp' },
};
// No outcome data yet: logged, never deciding. LETS_DO_UAT_TEST_CALIBRATED is for tests.
export const UNCALIBRATED = new Set(Object.keys(THRESHOLDS));
const forTests = (id) => (process.env.LETS_DO_UAT_TEST_CALIBRATED || '').split(',').includes(id);
export const calibrated = (id) => !UNCALIBRATED.has(id) || forTests(id) || C.isOn(SKILL, id);
export const thr = (id) => C.threshold(SKILL, id, THRESHOLDS[id]);
// One decision in ten of a question switched on by /calibrate is not acted on, and marked.
export const spot = (id, caseId) => UNCALIBRATED.has(id) && !forTests(id) && C.isOn(SKILL, id) && C.spotCheck(caseId);

const noul = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
// A query string can carry a token or a person's id.
const clean = (s, n) => scrub(String(s ?? '').replace(/\?[^\s"'<>)]*/g, '')).slice(0, n);
export const stepLine = (s) => clean(`${s.action} -> ${s.expected}`, 300);

// One request at approval: coverage of the whole set, and each step's risk.
export function buildFlows(item, flows) {
  const steps = flows.flatMap((f) => f.steps.map((s) => ({ flow: f.id, n: s.n, line: stepLine(s) }))).slice(0, 60);
  const state = {
    title: clean(item.title, 200),
    prs: (item.prs || []).map((p) => clean(p.title, 200)),
    changed_files: (item.prs || []).flatMap((p) => p.files || []).slice(0, 60).map((f) => clean(f, 200)),
    flows: flows.map((f) => ({ title: clean(f.title, 120), goal: clean(f.goal, 200), steps: f.steps.length })),
    steps: steps.map((s) => s.line),
  };
  const questions = {
    flows_cover_change: noul(
      'Going by `title`, `prs` and `changed_files`, do the `flows` together walk through every change a user of this feature would notice?',
      'Each user-visible change the PRs make has at least one flow that reaches it, including the error or empty state the change adds.',
      'A screen, option, state or permission the PRs change has no flow that reaches it.',
    ),
  };
  steps.forEach((s, n) => {
    questions[`confirm__${n}`] = noul(
      `Would doing \`steps[${n}]\` create, change, send or delete something that matters outside this test, or that cannot easily be undone?`,
      'It submits, pays, sends a message or an email, deletes, publishes, invites, changes a permission or a setting, or starts a job.',
      'It only opens, reads, filters, sorts, navigates or fills a field without saving.',
    );
  });
  return { state, questions, steps };
}

// failures: [{n, action, expected, actual, failed: [endpoint → status]}]
export function buildFailures(flow, failures) {
  const list = failures.slice(0, 15);
  const state = { flow: clean(flow.title, 120), failures: list.map((f) => ({ step: stepLine(f), observed: clean(f.actual, 200), failed_requests: (f.failed || []).slice(0, 5).map((x) => clean(x, 160)) })) };
  const questions = {};
  list.forEach((_, n) => {
    questions[`environmental__${n}`] = noul(
      `Is \`failures[${n}]\` a failure of the test environment rather than of the feature being tested?`,
      'The service was unreachable, the session expired, a third-party sandbox was down, test data was missing, or the browser itself broke.',
      'The app responded and did the wrong thing: wrong screen, wrong data, a missing control, or an error in its own logic.',
    );
  });
  return { state, questions, failures: list };
}
