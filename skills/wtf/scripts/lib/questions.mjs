// Jev questions for /wtf. Jev sees derived facts only: a symptom line the
// model wrote without names, prior-ticket titles, and the expected/actual
// lines. Never the ticket, the thread, or screenshot text. Everything is
// scrubbed again here before it leaves.

import * as C from './calibration.mjs';
import { scrub } from './scrub.mjs';

export const THRESHOLDS = {
  same_issue_as_prior: 0.3, // below: this prior ticket is not the same issue
  ask_not_breakage: 0.3, // below: this is not a feature request
  screen_was_enough: 0.4, // below: a competent user could not have got it right
};
// No outcome data yet: logged, never deciding. WTF_TEST_CALIBRATED is for tests.
export const UNCALIBRATED = new Set(Object.keys(THRESHOLDS));
// A question leaves that state on this machine through /calibrate, which
// writes an entry for it (lib/calibration.mjs) and may move its threshold.
export const SKILL = 'wtf';
const forTests = (id) => (process.env.WTF_TEST_CALIBRATED || '').split(',').includes(id);
export const calibrated = (id) => !UNCALIBRATED.has(id) || forTests(id) || C.isOn(SKILL, id);
export const thr = (id) => C.threshold(SKILL, id, THRESHOLDS[id]);
// One decision in ten of a question switched on by /calibrate is not acted on, and marked.
export const spot = (id, caseId) => UNCALIBRATED.has(id) && !forTests(id) && C.isOn(SKILL, id) && C.spotCheck(caseId);

const noul = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });

// input: { symptom, expected, actual, prior: [{title}] }
export function build(input) {
  const prior = (input.prior || []).filter((p) => p && p.title);
  const state = {
    symptom: scrub(input.symptom).slice(0, 400),
    expected: scrub(input.expected).slice(0, 300),
    actual: scrub(input.actual).slice(0, 300),
    prior_titles: prior.map((p) => scrub(p.title).slice(0, 200)),
  };
  const questions = {
    ask_not_breakage: noul(
      'Is `symptom` a request for the product to do something it was never built to do, rather than a report that something built is broken?',
      'It asks for a new capability, or for a deliberate restriction to be removed: "let me do X", "there should be a way to".',
      'It reports that an existing feature misbehaved: wrong result, error, nothing happened, data lost.',
    ),
    screen_was_enough: noul(
      'Given `expected` and `actual`, could a competent first-time user have done the right thing from what the product showed them, without outside help?',
      'The product stated the rule, the reason, or the next step where the user was looking.',
      'The product blocked or diverted the user without saying why, or the control gave no sign of what it needed.',
    ),
  };
  prior.forEach((_, i) => {
    questions[`same_issue__${i}`] = noul(
      `Does \`prior_titles[${i}]\` describe the same underlying problem as \`symptom\`, so that fixing or answering one settles the other?`,
      'Same feature and same failure, even if worded differently.',
      'A different feature, a different failure, or only loosely the same area.',
    );
  });
  return { state, questions, prior };
}
