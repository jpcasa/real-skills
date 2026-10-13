// Jev questions for /solve-merge-conflicts. Each can only add a question for
// the user: none resolves a hunk, drops a question or decides the push.
//
// Jev reads names and one-line reasons only: the file path, the way a
// conflict was resolved, the agent's reason, and each side's commit subjects
// and pull request titles. Never the code. Everything is scrubbed again here.

import * as C from './calibration.mjs';
import { scrub } from './scrub.mjs';

export const SKILL = 'solve-merge-conflicts';
export const THRESHOLDS = {
  sides_disagree: 0.6, // at or above: the hunk is put to the user, whatever the script's own check said
  resolution_adds_behaviour: 0.6, // at or above: the combined text or the edit is put to the user
  edit_is_adaptation: 0.4, // below: the edit is put to the user
};
// unsafe: the error that must never happen (fn = saying no when the answer was yes, fp = the reverse).
export const SHAPE = {
  sides_disagree: { acts_when: 'gte', unsafe: 'fn' },
  resolution_adds_behaviour: { acts_when: 'gte', unsafe: 'fn' },
  edit_is_adaptation: { acts_when: 'lt', unsafe: 'fp' },
};
// No outcome data yet: logged, never deciding. SOLVE_CONFLICTS_TEST_CALIBRATED is for tests.
export const UNCALIBRATED = new Set(Object.keys(THRESHOLDS));
const forTests = (id) => (process.env.SOLVE_CONFLICTS_TEST_CALIBRATED || '').split(',').includes(id);
export const calibrated = (id) => !UNCALIBRATED.has(id) || forTests(id) || C.isOn(SKILL, id);
export const thr = (id) => C.threshold(SKILL, id, THRESHOLDS[id]);
// One decision in ten of a question switched on by /calibrate is not acted on, and marked.
export const spot = (id, caseId) => UNCALIBRATED.has(id) && !forTests(id) && C.isOn(SKILL, id) && C.spotCheck(caseId);

export const MAX_HUNKS = 20;
export const MAX_EDITS = 10;
const noul = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
// A link or a query string can carry a token or a person's id.
export const clean = (s, n = 300) => scrub(String(s ?? '').replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '').replace(/\?[^\s"'<>)]*/g, '')).replace(/\s+/g, ' ').trim().slice(0, n);
// A squash commit's subject already is its pull request's title.
const subjects = (list) => (list || []).slice(0, 6).map((c) => clean(c.pr && !c.subject.includes(c.pr.title) ? `${c.subject} (pull request: ${c.pr.title})` : c.subject, 200));

// label: what the case id is made of, never sent (repo, pull request number).
// hunks: [{ id, file, kind, why, hash, sources: { pr_side, base_side } }]   content hunks, resolved
// edits: [{ file, why, because, hash }]                                     edits outside the conflicts
// -> { state, questions, cases: [{ question, key, case, show, target }] }
export function build(label, pr, hunks, edits) {
  const hs = hunks.slice(0, MAX_HUNKS);
  const es = edits.slice(0, MAX_EDITS);
  const state = {
    pull_request: clean(pr.title, 200),
    hunks: hs.map((h) => ({ file: clean(h.file, 200), resolved_as: h.kind, reason: clean(h.why), pull_request_commits: subjects(h.sources?.pr_side), base_commits: subjects(h.sources?.base_side) })),
    edits: es.map((e) => ({ file: clean(e.file, 200), reason: clean(e.why), because_of: clean(e.because, 200) })),
  };
  const questions = {};
  const cases = [];
  const add = (question, key, q, target, show, hash) => {
    questions[key] = q;
    cases.push({ question, key, case: C.caseId(label, question, target, hash), show: clean(show), target });
  };
  hs.forEach((h, n) => {
    add('sides_disagree', `disagree__${n}`, noul(
      `Going by \`hunks[${n}].pull_request_commits\` and \`hunks[${n}].base_commits\`, do the two sides want different things for the same lines of \`hunks[${n}].file\`, so that one of them has to give way?`,
      'The two sets of commits pull in opposite directions: one removes or replaces what the other relies on, or they set the same thing to different values.',
      'The two sets of commits do separate things that can both stay, such as two additions, or a rename on one side and new code on the other.',
    ), h.id, `${h.file} (${h.kind}): do the two sides want different things? ${h.why}`, h.hash);
    if (h.kind !== 'combined') return;
    add('resolution_adds_behaviour', `adds__${n}`, noul(
      `Going by \`hunks[${n}].reason\` and what the commits on both sides say, does this resolution do something neither side set out to do?`,
      'The reason describes new logic, a new value, a fix or a choice that neither side\'s commits mention.',
      'The reason describes joining the two changes and nothing else.',
    ), h.id, `${h.file} (combined): does it do something neither side did? ${h.why}`, h.hash);
  });
  es.forEach((e, n) => {
    add('resolution_adds_behaviour', `adds_edit__${n}`, noul(
      `Going by \`edits[${n}].reason\`, does this edit to \`edits[${n}].file\` do something neither side of the merge set out to do?`,
      'The reason describes new logic, a fix for something unrelated, or a change in what the code does.',
      'The reason describes making existing code fit a change the other side made.',
    ), `edit:${e.file}`, `${e.file} (edit outside the conflicts): does it do something neither side did? ${e.why}`, e.hash);
    add('edit_is_adaptation', `adapt__${n}`, noul(
      `Is the edit to \`edits[${n}].file\` needed only because of what \`edits[${n}].because_of\` changed on the other side?`,
      'That change renamed, moved, removed or reshaped something this file uses, and the edit follows it.',
      'The file would have worked without the edit, or the edit goes beyond following that change.',
    ), `edit:${e.file}`, `${e.file} (edit outside the conflicts): needed only because of "${e.because}"? ${e.why}`, e.hash);
  });
  return { state, questions, cases };
}

// Why Jev's number puts this to the user, or null.
export function reason(question, p) {
  const t = thr(question);
  if (question === 'edit_is_adaptation') return p < t ? 'Jev does not read this edit as following the other side\'s change' : null;
  if (p < t) return null;
  return question === 'sides_disagree' ? 'Jev reads the two sides as wanting different things here' : 'Jev reads this as doing something neither side did';
}

// The right answer the user's decision gives for `sides_disagree`: one side
// kept means they did; both kept whole means they did not. A combined text
// answers a different question and labels nothing.
export const disagreeLabel = (kind) => (kind === 'pr' || kind === 'base' ? true : kind === 'both' ? false : null);
