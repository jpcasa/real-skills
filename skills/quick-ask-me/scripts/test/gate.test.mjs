import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDGET, UNCALIBRATED, gateAnswered, gateCriteria, gateQuestions, gateStop, takeCases } from '../gate.mjs';
import * as C from '../lib/calibration.mjs';

// Never this machine's real calibration file or logs.
process.env.REAL_SKILLS_CALIBRATION_DIR = mkdtempSync(join(tmpdir(), 'qam-cal-'));
process.env.QUICK_ASK_ME_STATE_DIR = mkdtempSync(join(tmpdir(), 'qam-state-'));
delete process.env.REAL_SKILLS_CALIBRATION;


const ALL = [...UNCALIBRATED].join(',');
const withCal = async (fn) => {
  process.env.QUICK_ASK_ME_TEST_CALIBRATED = ALL;
  try {
    return await fn();
  } finally {
    delete process.env.QUICK_ASK_ME_TEST_CALIBRATED;
  }
};
// Jev stand-in: noul per question id, default 0.5 (decides nothing either way).
const stub = (nouls = {}) => async ({ questions }) => ({
  degraded: false,
  answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', noul: nouls[id] ?? 0.5 }])),
});
const down = async () => ({ degraded: true, error: 'no TypeSafe API key', answers: {} });
const cands = (n) => Array.from({ length: n }, (_, i) => ({ id: `q${i}`, text: `Question ${i}?`, recommended: `r${i}` }));

test('budget is 6 and every question id ships uncalibrated', () => {
  assert.equal(BUDGET, 6);
  assert.equal(UNCALIBRATED.size, 5);
});

test('fallback (degraded): every candidate is asked in order, up to the budget; nothing skipped', async () => {
  const r = await gateQuestions({ objective: 'o', candidates: cands(8) }, { ask: down });
  assert.equal(r.mode, 'degraded');
  assert.deepEqual(r.ask, ['q0', 'q1', 'q2', 'q3', 'q4', 'q5']);
  assert.deepEqual([r.lookup, r.skip, r.over_budget, r.budget_left], [[], [], ['q6', 'q7'], 0]);
});

test('questions already asked count against the budget', async () => {
  const r = await gateQuestions({ objective: 'o', asked: 4, candidates: cands(5), jev: 'off' }, { ask: () => assert.fail('off must not call Jev') });
  assert.deepEqual([r.ask, r.over_budget, r.mode], [['q0', 'q1'], ['q2', 'q3', 'q4'], 'off']);
  assert.equal((await gateQuestions({ asked: 9, candidates: cands(2), jev: 'off' })).ask.length, 0);
});

test('shadow and live-uncalibrated: Jev is reported, no question leaves `ask`', async () => {
  const ask = stub({ repo__0: 0.99, build__1: 0.01 });
  for (const jev of ['shadow', 'live']) {
    const r = await gateQuestions({ objective: 'o', candidates: cands(3), jev }, { ask });
    assert.deepEqual([r.ask, r.lookup, r.skip], [['q0', 'q1', 'q2'], [], []], jev);
    assert.equal(r.jev.q0.repo_can_answer_this, 0.99);
  }
});

test('live and calibrated: lookups and skips do not spend the budget', async () => {
  await withCal(async () => {
    const nouls = { repo__0: 0.9, build__1: 0.1, repo__2: 0.69, build__2: 0.3 };
    const r = await gateQuestions({ objective: 'o', candidates: cands(9), jev: 'live' }, { ask: stub(nouls) });
    assert.deepEqual([r.lookup, r.skip], [['q0'], ['q1']]);
    assert.deepEqual(r.ask, ['q2', 'q3', 'q4', 'q5', 'q6', 'q7'], 'q2 sits on both thresholds and is still asked');
    assert.deepEqual(r.over_budget, ['q8']);
    assert.ok(r.ask.length <= BUDGET);
  });
});

test('criteria: verdict is null unless Jev decides; calibrated live gives a boolean', async () => {
  const input = { objective: 'o', criteria: ['`npm test` passes', 'it feels right'] };
  const ask = stub({ observable__0: 0.9, observable__1: 0.2 });
  const shadow = await gateCriteria({ ...input, jev: 'shadow' }, { ask });
  assert.deepEqual(shadow.criteria.map((c) => [c.p, c.observable]), [[0.9, null], [0.2, null]]);
  await withCal(async () => {
    const live = await gateCriteria({ ...input, jev: 'live' }, { ask });
    assert.deepEqual(live.criteria.map((c) => c.observable), [true, false]);
  });
  assert.deepEqual((await gateCriteria(input, { ask: down })).criteria.map((c) => c.observable), [null, null]);
});

const ready = { objective: 'o', objective_confirmed: true, criteria: ['`npm test` passes'], criteria_observable: true, out_of_scope: 'no PDF export', seam: 'test/export.test.ts calls exportCsv()', term_conflicts: 0, asked: 2 };

test('stop: all five conditions in code; each missing one blocks it', async () => {
  const ok = await gateStop(ready, { ask: down });
  assert.deepEqual([ok.stop, ok.missing, ok.budget_left, ok.budget_spent], [true, [], 4, false]);
  const cases = {
    'objective is not confirmed': { objective_confirmed: false },
    'no success criteria': { criteria: [] },
    'not all observable': { criteria_observable: false },
    'scope boundary is not named': { out_of_scope: '  ' },
    'seam is not known': { seam: '' },
    'term conflicts': { term_conflicts: 1 },
  };
  for (const [why, patch] of Object.entries(cases)) {
    const r = await gateStop({ ...ready, ...patch }, { ask: down });
    assert.equal(r.stop, false, why);
    assert.match(r.missing.join(' | '), new RegExp(why), why);
  }
  assert.equal((await gateStop({ ...ready, asked: 6 }, { ask: down })).budget_spent, true);
});

test('stop: calibrated live Jev can call a criterion, the scope or the seam too vague; uncalibrated cannot', async () => {
  const ask = stub({ observable__0: 0.1, scope_boundary_named: 0.1, seam_is_known: 0.9 });
  assert.equal((await gateStop({ ...ready, jev: 'live' }, { ask })).stop, true, 'uncalibrated: the caller\'s own judgment stands');
  await withCal(async () => {
    const r = await gateStop({ ...ready, jev: 'live' }, { ask });
    assert.equal(r.stop, false);
    assert.deepEqual(r.missing, ['criterion is not observable: `npm test` passes', 'scope boundary is too vague']);
  });
});

test('CLI: one JSON line per command; unknown command errors', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), '../gate.mjs');
  // A dead local port: the test never reaches the real API.
  const env = { ...process.env, TYPESAFE_API_KEY: 'test-key', TYPESAFE_API_URL: 'http://127.0.0.1:9/', QUICK_ASK_ME_STATE_DIR: mkdtempSync(join(tmpdir(), 'qam-state-')) };
  const run = (cmd, input) => JSON.parse(execFileSync('node', [cli, cmd], { env, input: JSON.stringify(input) }).toString().trim());
  assert.deepEqual(run('questions', { objective: 'o', candidates: cands(2), jev: 'off' }).ask, ['q0', 'q1']);
  assert.equal(run('stop', ready).mode, 'degraded');
  assert.throws(() => execFileSync('node', [cli, 'nope'], { env, input: '{}', stdio: ['pipe', 'pipe', 'ignore'] }));
});

// ---------------------------------------------------------------- calibration
const OBJ = 'Add CSV export';
const one = (id, text) => ({ id, text, recommended: 'yes' });

test('every Jev answer is logged as a case with its direction and unsafe side', async () => {
  takeCases();
  await gateQuestions({ objective: OBJ, candidates: [one('q0', 'Which delimiter?')] }, { ask: stub({ repo__0: 0.2, build__0: 0.9 }) });
  await gateStop({ objective: OBJ, objective_confirmed: true, criteria: ['exports a file'], out_of_scope: 'no XLSX', seam: 'tests/export.test.ts calls exportCsv()' }, { ask: stub({ observable__0: 0.8, scope_boundary_named: 0.7, seam_is_known: 0.4 }) });
  const cases = takeCases();
  assert.deepEqual(cases.map((c) => [c.question, c.p, c.acts_when, c.unsafe, c.acted]), [
    ['repo_can_answer_this', 0.2, 'gte', 'fp', false],
    ['answer_changes_what_gets_built', 0.9, 'lt', 'fn', false],
    ['criterion_is_observable', 0.8, 'both', 'fp', false],
    ['scope_boundary_named', 0.7, 'lt', null, false],
    ['seam_is_known', 0.4, 'lt', null, false],
  ]);
  assert.equal(cases[0].case, cases[1].case, 'both questions about one candidate share its case id');
  assert.equal(cases[0].case, C.caseId(OBJ, 'Which delimiter?'));
  assert.ok(cases.every((c) => c.skill === 'quick-ask-me' && c.show && c.ask.endsWith('?')));
  assert.match(cases[0].show, /Which delimiter\? \(recommended: yes\)/);
});

test('an entry written by /calibrate switches one question on, in live only, at its own threshold', async () => {
  const input = (jev) => ({ jev, objective: OBJ, candidates: [one('q0', 'Wording of the button?')] });
  const ask = stub({ repo__0: 0.1, build__0: 0.2 });
  assert.deepEqual((await gateQuestions(input('live'), { ask })).skip, [], 'not calibrated: asked');
  C.setEntry('quick-ask-me', 'answer_changes_what_gets_built', { threshold: 0.15, n: 30 });
  assert.deepEqual((await gateQuestions(input('live'), { ask })).ask, ['q0'], '0.2 is not under the calibrated 0.15 (the built-in 0.3 would have skipped it)');
  C.setEntry('quick-ask-me', 'answer_changes_what_gets_built', { threshold: 0.4, n: 30 });
  const spotted = C.spotCheck(C.caseId(OBJ, 'Wording of the button?'));
  assert.deepEqual((await gateQuestions(input('live'), { ask })).skip, spotted ? [] : ['q0']);
  assert.deepEqual((await gateQuestions(input('shadow'), { ask })).skip, []);
  process.env.REAL_SKILLS_CALIBRATION = 'off';
  assert.deepEqual((await gateQuestions(input('live'), { ask })).skip, []);
  delete process.env.REAL_SKILLS_CALIBRATION;
  C.revoke('quick-ask-me', 'answer_changes_what_gets_built', 'test');
  takeCases();
});

test('spot check: a spot-checked question is asked, not skipped', async () => {
  C.setEntry('quick-ask-me', 'answer_changes_what_gets_built', { threshold: 0.4, n: 30 });
  const texts = Array.from({ length: 80 }, (_, i) => `Detail ${i}?`);
  const spot = texts.find((t) => C.spotCheck(C.caseId(OBJ, t)));
  const plain = texts.find((t) => !C.spotCheck(C.caseId(OBJ, t)));
  takeCases();
  const r = await gateQuestions({ jev: 'live', objective: OBJ, candidates: [one('s', spot), one('p', plain)] }, { ask: stub({ repo__0: 0.1, build__0: 0.1, repo__1: 0.1, build__1: 0.1 }) });
  assert.deepEqual([r.ask, r.skip], [['s'], ['p']]);
  const marked = takeCases().filter((c) => c.question === 'answer_changes_what_gets_built').map((c) => [Boolean(c.spot), c.acted]);
  assert.deepEqual(marked, [[true, false], [false, true]]);
  C.revoke('quick-ask-me', 'answer_changes_what_gets_built', 'test');
});

test('answered: what the user picked becomes the right answer, and an unsafe one revokes', async () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), '../gate.mjs');
  const file = join(process.env.QUICK_ASK_ME_STATE_DIR, 'jev.jsonl');
  takeCases();
  await gateQuestions({ objective: OBJ, candidates: [one('a', 'Keep the old endpoint?'), one('b', 'Batch size?')] }, { ask: stub({ build__0: 0.2, build__1: 0.2 }) });
  C.writeCases(file, takeCases());
  C.setEntry('quick-ask-me', 'answer_changes_what_gets_built', { threshold: 0.3, n: 30 });
  const first = gateAnswered({ objective: OBJ, answers: [{ text: 'Batch size?', picked_recommended: true }, { text: 'Never gated?', picked_recommended: false }, { text: 'Keep the old endpoint?' }] });
  assert.deepEqual(first, { labeled: 1, unknown: 1, revoked: [] });
  assert.equal(C.isOn('quick-ask-me', 'answer_changes_what_gets_built'), true, 'took the recommended answer: skipping would have cost nothing');
  // Scored 0.2 (would be skipped under 0.3), and the user chose something else: skipping was the unsafe error.
  const out = JSON.parse(execFileSync('node', [cli, 'answered'], { input: JSON.stringify({ objective: OBJ, answers: [{ text: 'Keep the old endpoint?', picked_recommended: false }] }), env: process.env }).toString());
  assert.deepEqual(out, { labeled: 1, unknown: 0, revoked: ['answer_changes_what_gets_built'] });
  assert.equal(C.isOn('quick-ask-me', 'answer_changes_what_gets_built'), false);
  const labels = C.readJsonl(file).filter((r) => r.type === 'label');
  assert.deepEqual(labels.map((l) => [l.label, l.source]), [[false, 'answer'], [true, 'answer']]);
});
