import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDGET, UNCALIBRATED, gateCriteria, gateQuestions, gateStop } from '../gate.mjs';

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
