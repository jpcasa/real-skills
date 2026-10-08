// Jev questions for /review-prs. Jev sees the PR's title and body, the paths
// of the changed files and each finding's one-line problem. Never the diff, a
// quoted line or any source.

import * as C from './calibration.mjs';
import { OPTIONAL } from './lenses.mjs';

export const THRESHOLDS = {
  needs_lens: 0.6, // at or above: add a lens the path rules did not pick
  finding_is_actionable: 0.3, // below: a nit or question the author would not act on
  same_finding: 0.7, // at or above: two findings in one file are the same point
  outside_stated_scope: 0.7, // at or above: the PR does more than it says
};
// No outcome data yet: logged, never deciding. REVIEW_PRS_TEST_CALIBRATED is for tests.
export const UNCALIBRATED = new Set(Object.keys(THRESHOLDS));
// A question leaves that state on this machine through /calibrate.
export const SKILL = 'review-prs';
const forTests = (id) => (process.env.REVIEW_PRS_TEST_CALIBRATED || '').split(',').includes(id);
export const calibrated = (id) => !UNCALIBRATED.has(id) || forTests(id) || C.isOn(SKILL, id);
export const thr = (id) => C.threshold(SKILL, id, THRESHOLDS[id]);
// One decision in ten of a question switched on by /calibrate is not acted on, and marked.
export const spot = (id, caseId) => UNCALIBRATED.has(id) && !forTests(id) && C.isOn(SKILL, id) && C.spotCheck(caseId);

// How each question is logged for /calibrate: which side of the threshold
// changes the outcome, and which error is the unsafe one (null: acting only
// adds a check or a note).
export const SHAPE = {
  needs_lens: { acts_when: 'gte', unsafe: null },
  finding_is_actionable: { acts_when: 'lt', unsafe: 'fn' },
  same_finding: { acts_when: 'gte', unsafe: null }, // a merge keeps both findings
  outside_stated_scope: { acts_when: 'gte', unsafe: null },
};
export const MAX_ACTIONABLE = 30;
export const MAX_PAIRS = 20;

const noul = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
const prState = (pr, files) => ({ title: String(pr.title).slice(0, 300), body: String(pr.body).slice(0, 1500), files: files.slice(0, 60) });

const LENS_ASK = {
  security: 'authentication, authorization, secrets, personal data, payments, deletion or untrusted input',
  data: 'a database schema, a migration, row-level security or a backfill',
  performance: 'database queries, loops over rows, large lists or bundle size',
  accessibility: 'user interface markup, styles, focus or keyboard behaviour',
};

// start: should a lens the path rules skipped run anyway?
export function buildLens(pr, files, chosen) {
  const ask = OPTIONAL.filter((l) => !chosen.includes(l));
  const questions = {};
  for (const l of ask) {
    questions[`needs_lens__${l}`] = noul(
      `Going by \`title\`, \`body\` and \`files\`, does this pull request change ${LENS_ASK[l]}?`,
      'The description or the file paths show such a change.',
      'Nothing in the description or the paths points to it.',
    );
  }
  return { state: prState(pr, files), questions, ask };
}

// record: per-finding and per-PR questions over what the rules kept.
export function buildFindings(pr, files, findings) {
  const minor = findings.filter((f) => f.severity === 'nit' || f.severity === 'q').slice(0, MAX_ACTIONABLE);
  const pairs = [];
  for (let i = 0; i < findings.length && pairs.length < MAX_PAIRS; i++) {
    for (let j = i + 1; j < findings.length && pairs.length < MAX_PAIRS; j++) {
      if (findings[i].file === findings[j].file && findings[i].in_diff === findings[j].in_diff) pairs.push([findings[i], findings[j]]);
    }
  }
  const state = { ...prState(pr, files), findings: findings.map((f) => `${f.file}: ${String(f.problem).slice(0, 300)}`) };
  const at = (f) => findings.indexOf(f);
  const questions = {
    outside_stated_scope: noul(
      'Do `files` include changes that `title` and `body` do not account for, so that the pull request does more than it says?',
      'Some changed paths belong to an area the description never mentions.',
      'Every changed path fits what the description says, or is an ordinary side effect of it (tests, lockfiles, docs).',
    ),
  };
  for (const f of minor) {
    questions[`actionable__${at(f)}`] = noul(
      `Would the author of this pull request change code because of \`findings[${at(f)}]\`?`,
      'It names a concrete defect, risk or rule the repository follows, and a change that fixes it.',
      'It is a matter of taste, restates the diff, or asks for nothing specific.',
    );
  }
  pairs.forEach(([a, b], n) => {
    questions[`same__${n}`] = noul(
      `Do \`findings[${at(a)}]\` and \`findings[${at(b)}]\` make the same point, so that one fix settles both?`,
      'Same problem, worded differently or seen through a different lens.',
      'Two different problems that happen to be in one file.',
    );
  });
  return { state, questions, minor, pairs };
}
