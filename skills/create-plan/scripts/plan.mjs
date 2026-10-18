#!/usr/bin/env node
// /create-plan harness. Stateless: a plan file in, one JSON object out.
//
//   lint  <plan.md> [--spec <spec.md>]   -> structure, placeholders, parallel overlap, coverage, review rule
//   judge <plan.md>                      -> per task: too big? needs its own review? vague steps?
//
// `lint` is code only and always counts. `judge` asks Jev; a score decides only
// when the run is `live` ($CREATE_PLAN_JEV=live) and its threshold is
// calibrated. Otherwise it is logged (`scores`, `shadow`) and the result says
// `by_hand: true`: SKILL.md's By hand rule decides. The review path rule is
// code and stands in every mode; Jev can only add a task to review, never
// take one out. The Jev client (redaction, retry, degrade) is do-shit's.

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './lib/calibration.mjs';
import { coverage, lintPlan, needsReview, parseDoneWhen, parsePlan } from './lib/rules.mjs';

export const COMMANDS = ['lint', 'judge'];
export const T = { task_too_big: 0.6, needs_review: 0.6, step_vague: 0.6 };
// No eval data behind any of them yet: logged, decides nothing, until /calibrate
// writes an entry. CREATE_PLAN_TEST_CALIBRATED is for the test suite only.
export const UNCALIBRATED = new Set(Object.keys(T));
const SKILL = 'create-plan';
const forTests = (k) => (process.env.CREATE_PLAN_TEST_CALIBRATED || '').split(',').includes(k);
const calibrated = (k) => !UNCALIBRATED.has(k) || forTests(k) || C.isOn(SKILL, k);
const thr = (k) => C.threshold(SKILL, k, T[k]);
const spot = (id, k) => UNCALIBRATED.has(k) && !forTests(k) && C.isOn(SKILL, k) && C.spotCheck(id);
export const modeOf = (v = process.env.CREATE_PLAN_JEV) => (v === 'live' ? 'live' : v === '0' || v === 'off' ? 'off' : 'shadow');
const decides = (mode, k) => mode === 'live' && calibrated(k);

const ASK = {
  task_too_big: 'Was this task too big to review and reject as one unit?',
  needs_review: 'Did this task need a review of its own (auth, data, payments, deletion, irreversible)?',
  step_vague: 'Was this step too vague to act on without guessing?',
};

const CASES = [];
export const takeCases = () => CASES.splice(0);
const kase = (question, id, p, mode, acted, sp, show) => {
  if (typeof p !== 'number') return;
  CASES.push({ skill: SKILL, question, case: id, p, threshold: thr(question), mode, acted, ...(sp ? { spot: true } : {}), acts_when: 'gte', unsafe: 'fn', show, ask: ASK[question] });
};

const noul = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
const OFF = async () => ({ answers: {}, degraded: true, error: 'Jev client unavailable or disabled' });

let redactBody = null;
async function loadAsk() {
  if (modeOf() === 'off') return null;
  try {
    const client = await import('../../do-shit/scripts/lib/jev.mjs');
    redactBody = client.redactBody;
    return client.ask;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- lint
export function lint(planText, specText = null) {
  const plan = parsePlan(planText);
  const done = specText === null ? null : parseDoneWhen(specText);
  const problems = lintPlan(plan, done);
  return { ok: problems.length === 0, tasks: plan.tasks.length, problems, ...(done ? { coverage: coverage(plan, done) } : {}) };
}

// ------------------------------------------------------------------ judge
export async function judge(planText, ask = OFF, { mode = 'shadow' } = {}) {
  const plan = parsePlan(planText);
  const goal = plan.header.Goal?.value || '';
  const code = plan.tasks.map((t) => ({ id: t.id, needs_review: needsReview(t.files).length > 0 }));
  if (!plan.tasks.length) return { degraded: false, by_hand: false, tasks: [] };
  const state = { goal, tasks: plan.tasks.map((t) => ({ name: t.name, files: t.files, steps: t.steps.map((s) => s.text) })) };
  const questions = {};
  plan.tasks.forEach((t, i) => {
    const ref = `\`tasks[${i}]\``;
    questions[`task_too_big__${i}`] = noul(
      `Is ${ref} too big to review and reject as one unit: several independent behaviours, unrelated areas, or more work than one focused commit?`,
      'A reviewer would want it split; parts could land or fail independently.',
      'One coherent change a reviewer can accept or reject whole.',
    );
    questions[`needs_review__${i}`] = noul(
      `Does ${ref} touch authentication, authorization, persistent data or schema, payments, personal data, data deletion, or anything hard to undo once released?`,
      'A mistake here is costly or harmful: it deserves a review of its own before the next task builds on it.',
      'Ordinary code where one review at the end of the branch is enough.',
    );
    t.steps.forEach((_, j) => {
      questions[`step_vague__${i}__${j}`] = noul(
        `Is \`tasks[${i}].steps[${j}]\` too vague to act on without guessing what to write, which file, or which command to run?`,
        'Too vague: names no file, behaviour, assertion or command.',
        'Concrete: says what to write, check or run.',
      );
    });
  });
  const res = await ask({ state, questions });
  if (res.degraded) return { degraded: true, by_hand: true, error: res.error, tasks: code };
  const p = (id) => res.answers?.[id]?.noul;
  let byHand = false;
  const tasks = plan.tasks.map((t, i) => {
    const id = C.caseId(goal, t.name, t.files.join(','));
    const s = { task_too_big: p(`task_too_big__${i}`), needs_review: p(`needs_review__${i}`) };
    const out = { id: t.id, needs_review: code[i].needs_review, scores: s };
    const shadow = {};
    for (const k of ['task_too_big', 'needs_review']) {
      const sp = decides(mode, k) && spot(id, k);
      const acted = decides(mode, k) && !sp;
      kase(k, id, s[k], mode, acted, sp, `${t.name} · files: ${t.files.join(', ')}`);
      const would = s[k] >= thr(k);
      if (acted) {
        if (k === 'task_too_big') out.too_big = would;
        else out.needs_review ||= would; // Jev may add, never remove
      } else {
        byHand = true;
        shadow[k] = would;
      }
    }
    const vague = [];
    const vagueShadow = [];
    t.steps.forEach((step, j) => {
      const v = p(`step_vague__${i}__${j}`);
      const sid = C.caseId(goal, t.name, step.text);
      const sp = decides(mode, 'step_vague') && spot(sid, 'step_vague');
      const acted = decides(mode, 'step_vague') && !sp;
      kase('step_vague', sid, v, mode, acted, sp, step.text);
      if (v >= thr('step_vague')) (acted ? vague : vagueShadow).push({ line: step.n, text: step.text });
      if (!acted) byHand = true;
    });
    out.vague_steps = vague;
    if (vagueShadow.length) shadow.vague_steps = vagueShadow;
    if (Object.keys(shadow).length) out.shadow = shadow;
    return out;
  });
  return { degraded: false, by_hand: byHand, tasks };
}

// -------------------------------------------------------------------- cli
const out = (o) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);

function log(cmd, mode, res) {
  if (res.degraded) return;
  try {
    const dir = process.env.CREATE_PLAN_STATE_DIR || join(homedir(), '.claude/state/create-plan');
    mkdirSync(dir, { recursive: true });
    C.writeCases(join(dir, 'jev.jsonl'), takeCases(), redactBody);
    appendFileSync(join(dir, 'jev.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), cmd, mode, tasks: res.tasks?.length ?? 0 })}\n`);
  } catch {}
}

// The spec the plan names in its header, when it is a file that exists.
function headerSpec(planPath, planText) {
  const v = parsePlan(planText).header.Spec?.value || '';
  const m = v.match(/`([^`]+\.md)`/) || v.match(/(\S+\.md)\b/);
  if (!m) return null;
  for (const p of [resolve(m[1]), resolve(dirname(planPath), m[1])]) if (existsSync(p)) return p;
  return null;
}

async function main([cmd, file, ...rest]) {
  if (!COMMANDS.includes(cmd) || !file) {
    out({ error: `usage: plan.mjs <${COMMANDS.join('|')}> <plan.md> [--spec <spec.md>]` });
    process.exit(2);
  }
  const text = readFileSync(file, 'utf8');
  if (cmd === 'lint') {
    const i = rest.indexOf('--spec');
    const specPath = i >= 0 ? rest[i + 1] : headerSpec(file, text);
    return out({ ...(specPath ? { spec: specPath } : {}), ...lint(text, specPath ? readFileSync(specPath, 'utf8') : null) });
  }
  const mode = modeOf();
  const res = await judge(text, (await loadAsk()) || OFF, { mode });
  log(cmd, mode, res);
  out({ mode, ...res });
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    out({ error: e.message });
    process.exit(1);
  });
}
