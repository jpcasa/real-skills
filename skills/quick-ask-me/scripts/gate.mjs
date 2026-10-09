#!/usr/bin/env node
// Decides which /quick-ask-me questions reach the user, whether a success
// criterion is checkable, and whether the interview can stop. The model
// drafts; this script applies the budget and the stop conditions in code and
// asks Jev (optional) for the judgments. Prints ONE JSON object.
//
//   node gate.mjs questions < {objective, criteria[], facts[], asked, candidates:[{id, text, recommended}]}
//   node gate.mjs criteria  < {objective, criteria[]}
//   node gate.mjs stop      < {objective_confirmed, criteria[], criteria_observable, out_of_scope, seam, term_conflicts, asked}
//
// Modes (input.jev, else $QUICK_ASK_ME_JEV, else shadow): shadow asks Jev and
// logs the answers, the fallback decides; live lets calibrated answers decide;
// degraded means no key or an API failure; off never calls Jev.
// Fallback = today's behaviour: every candidate is asked, up to the budget.
// Sent to Jev, after redaction: the objective, criteria, looked-up facts and
// candidate questions. Never file contents.

import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask as jevAsk, redactBody } from './lib/jev.mjs';
import * as C from './lib/calibration.mjs';

export const BUDGET = 6; // questions after the two openers
export const THRESHOLDS = {
  repo_can_answer_this: 0.7, // at or above: look it up instead of asking
  answer_changes_what_gets_built: 0.3, // below: skip, take the recommended answer
  criterion_is_observable: 0.6,
  scope_boundary_named: 0.6,
  seam_is_known: 0.6,
};
// No eval fixtures yet: logged, never deciding. QUICK_ASK_ME_TEST_CALIBRATED is for tests.
export const UNCALIBRATED = new Set(Object.keys(THRESHOLDS));
// A question leaves that state on this machine through /calibrate, which
// writes an entry for it (lib/calibration.mjs) and may move its threshold.
const SKILL = 'quick-ask-me';
const forTests = (id) => (process.env.QUICK_ASK_ME_TEST_CALIBRATED || '').split(',').includes(id);
const calibrated = (id) => !UNCALIBRATED.has(id) || forTests(id) || C.isOn(SKILL, id);
const thr = (id) => C.threshold(SKILL, id, THRESHOLDS[id]);
// One decision in ten of a question switched on by /calibrate is left to the
// fallback (the person is asked) and marked, so it still gets a right answer.
const spot = (id, caseId) => UNCALIBRATED.has(id) && !forTests(id) && C.isOn(SKILL, id) && C.spotCheck(caseId);
// Calibration cases from this process; the CLI writes them out.
const CASES = [];
export const takeCases = () => CASES.splice(0);
const stateDir = () => process.env.QUICK_ASK_ME_STATE_DIR || join(homedir(), '.claude/state/quick-ask-me');
// -> does this answer decide? Logs the case either way.
function kase(mode, question, id, value, extra) {
  if (value === null) return false;
  const sp = spot(question, id);
  const acted = mode === 'live' && calibrated(question) && !sp;
  CASES.push({ skill: SKILL, question, case: id, p: value, threshold: thr(question), mode, acted, ...(sp ? { spot: true } : {}), ...extra });
  return acted;
}
const ASK = {
  repo_can_answer_this: 'Could this have been answered by reading the project, instead of asking you?',
  answer_changes_what_gets_built: 'Would a different answer to this have changed what got built?',
  criterion_is_observable: 'Can this be checked and get a clear yes or no?',
  scope_boundary_named: 'Does this name at least one concrete thing that will NOT be done?',
  seam_is_known: 'Does this say where the tests live and which interface they exercise?',
};

const noul = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const modeOf = (input) => {
  const m = input.jev || process.env.QUICK_ASK_ME_JEV || 'shadow';
  return ['shadow', 'live', 'off'].includes(m) ? m : 'shadow';
};

// -> { mode, answers } ; answers is {} when Jev did not answer.
async function consult(mode, built, ask) {
  if (mode === 'off' || !Object.keys(built.questions).length) return { mode, answers: {} };
  const res = await ask(built);
  if (res.degraded) return { mode: 'degraded', answers: {}, error: res.error || 'degraded' };
  return { mode, answers: res.answers };
}
const p = (answers, id) => (typeof answers[id]?.noul === 'number' ? answers[id].noul : null);

// ---------------------------------------------------------------- questions
export async function gateQuestions(input, { ask = jevAsk } = {}) {
  const candidates = (input.candidates || []).filter((c) => c && c.id && text(c.text));
  const left = Math.max(0, BUDGET - Number(input.asked || 0));
  const questions = {};
  candidates.forEach((c, i) => {
    questions[`repo__${i}`] = noul(
      `Could \`candidates[${i}].text\` be answered by reading the project itself (its files, git history, configuration or tooling) rather than by asking the person who wants the work done?`,
      'It asks for a fact about how the project is today: what exists, where something lives, which tool or convention is in use.',
      'It asks for a decision, a preference, a priority or a trade-off that only the person can make.',
    );
    questions[`build__${i}`] = noul(
      `Would different answers to \`candidates[${i}].text\` lead to different code, tests or scope for \`objective\`?`,
      'The answer changes what gets built, what gets tested, or where the scope boundary sits.',
      'Any reasonable answer leads to the same implementation; it is curiosity, wording or a detail that can be settled while building.',
    );
  });
  const state = {
    objective: text(input.objective), criteria: input.criteria || [], facts: input.facts || [],
    candidates: candidates.map((c) => ({ text: c.text, recommended: c.recommended ?? null })),
  };
  const { mode, answers, error } = await consult(modeOf(input), { state, questions }, ask);

  const out = { mode, ask: [], lookup: [], skip: [], over_budget: [], budget_left: left, jev: {} };
  candidates.forEach((c, i) => {
    const repo = p(answers, `repo__${i}`);
    const build = p(answers, `build__${i}`);
    if (repo !== null || build !== null) out.jev[c.id] = { repo_can_answer_this: repo, answer_changes_what_gets_built: build };
    // The case id is the objective plus the question text: `answered` finds it again.
    const id = C.caseId(state.objective, c.text);
    const show = `${c.text}${c.recommended ? ` (recommended: ${c.recommended})` : ''}`;
    const repoActs = kase(mode, 'repo_can_answer_this', id, repo, { acts_when: 'gte', unsafe: 'fp', show, ask: ASK.repo_can_answer_this });
    const buildActs = kase(mode, 'answer_changes_what_gets_built', id, build, { acts_when: 'lt', unsafe: 'fn', show, ask: ASK.answer_changes_what_gets_built });
    if (repoActs && repo >= thr('repo_can_answer_this')) out.lookup.push(c.id);
    else if (buildActs && build < thr('answer_changes_what_gets_built')) out.skip.push(c.id);
    else if (out.ask.length < left) out.ask.push(c.id);
    else out.over_budget.push(c.id);
  });
  out.budget_left = left - out.ask.length;
  if (error) out.error = error;
  return out;
}

// ---------------------------------------------------------------- criteria
function criteriaQuestions(criteria) {
  const questions = {};
  criteria.forEach((_, i) => {
    questions[`observable__${i}`] = noul(
      `Is \`criteria[${i}]\` something a person or a script can check and get a clear yes or no?`,
      'It names an observable result: a test passes, a command prints something specific, a user can do a named thing, a number moves from one value to another.',
      'It is a feeling or a quality with no check attached: "it works", "it is clean", "it feels right", "it is fast".',
    );
  });
  return questions;
}
// observable: null = not decided here, judge it yourself.
const criteriaVerdicts = (criteria, answers, mode, objective = '') =>
  criteria.map((c, i) => {
    const v = p(answers, `observable__${i}`);
    const acts = kase(mode, 'criterion_is_observable', C.caseId(objective, c), v, { acts_when: 'both', unsafe: 'fp', show: c, ask: ASK.criterion_is_observable });
    return { text: c, p: v, observable: acts ? v >= thr('criterion_is_observable') : null };
  });

export async function gateCriteria(input, { ask = jevAsk } = {}) {
  const criteria = (input.criteria || []).map(text).filter(Boolean);
  const { mode, answers, error } = await consult(modeOf(input), { state: { objective: text(input.objective), criteria }, questions: criteriaQuestions(criteria) }, ask);
  return { mode, criteria: criteriaVerdicts(criteria, answers, mode, text(input.objective)), ...(error ? { error } : {}) };
}

// ---------------------------------------------------------------- stop
export async function gateStop(input, { ask = jevAsk } = {}) {
  const criteria = (input.criteria || []).map(text).filter(Boolean);
  const scope = text(input.out_of_scope);
  const seam = text(input.seam);
  const questions = {};
  if (scope) {
    questions.scope_boundary_named = noul(
      'Does `out_of_scope` name at least one concrete thing that will NOT be done as part of `objective`?',
      'It names specific work, a feature, a case or an area that is excluded.',
      'It is empty in effect: "nothing", "n/a", "keep it small", or a restatement of the objective.',
    );
  }
  if (seam) {
    questions.seam_is_known = noul(
      'Does `seam` say where the tests for `objective` will live and which interface they exercise?',
      'It names a test location or file and the function, endpoint, component or command the tests call.',
      'It is vague ("we will add tests", "somewhere in the test folder") or names no interface.',
    );
  }
  Object.assign(questions, criteriaQuestions(criteria));
  const { mode, answers, error } = await consult(modeOf(input), { state: { objective: text(input.objective), criteria, out_of_scope: scope, seam }, questions }, ask);
  const verdicts = criteriaVerdicts(criteria, answers, mode, text(input.objective));

  const missing = [];
  if (input.objective_confirmed !== true) missing.push('objective is not confirmed');
  if (!criteria.length) missing.push('no success criteria');
  // Jev's verdict per criterion when it decides; the caller's own judgment otherwise.
  const decided = verdicts.filter((c) => c.observable !== null);
  if (decided.length === criteria.length && criteria.length) {
    for (const c of verdicts) if (!c.observable) missing.push(`criterion is not observable: ${c.text}`);
  } else if (criteria.length && input.criteria_observable !== true) missing.push('success criteria are not all observable');
  const scopeP = p(answers, 'scope_boundary_named');
  if (!scope) missing.push('scope boundary is not named');
  else if (kase(mode, 'scope_boundary_named', C.caseId(text(input.objective), scope), scopeP, { acts_when: 'lt', unsafe: null, show: scope, ask: ASK.scope_boundary_named }) && scopeP < thr('scope_boundary_named')) missing.push('scope boundary is too vague');
  const seamP = p(answers, 'seam_is_known');
  if (!seam) missing.push('seam is not known');
  else if (kase(mode, 'seam_is_known', C.caseId(text(input.objective), seam), seamP, { acts_when: 'lt', unsafe: null, show: seam, ask: ASK.seam_is_known }) && seamP < thr('seam_is_known')) missing.push('seam is too vague');
  if (Number(input.term_conflicts || 0) > 0) missing.push('unresolved term conflicts with CONTEXT.md');

  const asked = Number(input.asked || 0);
  return {
    mode, stop: missing.length === 0, missing,
    budget_left: Math.max(0, BUDGET - asked), budget_spent: asked >= BUDGET,
    jev: { criteria: verdicts.map((c) => ({ text: c.text, p: c.p })), scope_boundary_named: scopeP, seam_is_known: seamP },
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------- answered
// What the person actually picked, for the questions that were put to them.
// Picking something other than the recommended answer is the proof that asking
// changed what gets built; picking it shows the skip would have cost nothing.
// input: { objective, answers: [{text, recommended, picked_recommended: true|false}] }
export function gateAnswered(input) {
  const file = join(stateDir(), 'jev.jsonl');
  const logged = new Map(C.readJsonl(file).filter((r) => r.type === 'case' && r.question === 'answer_changes_what_gets_built').map((r) => [r.case, r]));
  const out = { labeled: 0, unknown: 0, revoked: [] };
  for (const a of input.answers || []) {
    if (typeof a?.picked_recommended !== 'boolean' || !text(a.text)) continue;
    const id = C.caseId(text(input.objective), a.text);
    const c = logged.get(id);
    if (!c) {
      out.unknown++;
      continue;
    }
    const r = C.writeLabel(file, { skill: SKILL, question: 'answer_changes_what_gets_built', case: id, label: !a.picked_recommended, source: 'answer', p: c.p, unsafe: c.unsafe });
    out.labeled++;
    if (r.revoked) out.revoked.push('answer_changes_what_gets_built');
  }
  return out;
}

function log(cmd, res) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    // One record per question per case, in the shape /calibrate reads.
    C.writeCases(join(stateDir(), 'jev.jsonl'), takeCases(), redactBody);
    if (!res.jev || res.mode === 'degraded' || res.mode === 'off') return;
    appendFileSync(join(stateDir(), 'jev.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), cmd, ...res })}\n`);
  } catch {}
}

const cmds = { questions: gateQuestions, criteria: gateCriteria, stop: gateStop, answered: gateAnswered };
// Real paths on both sides: import.meta.url is percent-encoded and has symlinks
// resolved, process.argv[1] is neither, so a string comparison fails for an
// install path with a space or a symlink in it.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const cmd = process.argv[2];
  Promise.resolve()
    .then(async () => {
      if (!cmds[cmd]) throw new Error(`unknown command ${cmd}; use questions | criteria | stop | answered`);
      const res = await cmds[cmd](JSON.parse(readFileSync(0, 'utf8') || '{}'));
      log(cmd, res);
      process.stdout.write(`${JSON.stringify(res)}\n`);
    })
    .catch((e) => {
      process.stdout.write(`${JSON.stringify({ error: e.message })}\n`);
      process.exit(1);
    });
}
