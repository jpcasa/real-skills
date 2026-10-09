import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'qa-this-jev-'));
process.env.QA_THIS_STATE_DIR = join(tmp, 'state');
process.env.QA_THIS_GH_STUB = join(tmp, 'gh.json');
process.env.REAL_SKILLS_CALIBRATION_DIR = join(tmp, 'calibration');
delete process.env.REAL_SKILLS_CALIBRATION;
writeFileSync(process.env.QA_THIS_GH_STUB, '{}');

const Q = await import('../lib/questions.mjs');
const C = await import('../lib/calibration.mjs');
const S = await import('../lib/state.mjs');
const QA = await import('../qa.mjs');

const repo = join(tmp, 'app');
mkdirSync(join(repo, '.claude'), { recursive: true });
mkdirSync(join(repo, 'src'), { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
writeFileSync(join(repo, 'src/ok.test.mjs'), "import { test } from 'node:test';\ntest('ok', () => {});\n");
writeFileSync(join(repo, 'src/bad.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('no', () => assert.equal(1, 2));\n");
writeFileSync(join(repo, '.claude/qa-this.json'), JSON.stringify({
  tracker: { type: 'none' },
  environments: [{ name: 'local', kind: 'local', base_url: 'http://127.0.0.1:9' }],
  production_hosts: ['app.example.com'],
  tests: { unit: 'node --test' },
  databases: [{ env: 'local', how: "cat > /dev/null; printf '1\\n'" }],
}));
execFileSync('git', ['-C', repo, 'add', '-A']);
execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);

const SECRET_ROW = 'grace@hopper.example';
// answers: question id (or prefix before "__") -> probability
const stub = (answers, seen = []) => async ({ state, questions }) => {
  seen.push({ state, questions });
  return { degraded: false, answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', noul: answers[id] ?? answers[id.split('__')[0]] ?? 0.5 }])) };
};
const items = (file = 'src/ok.test.mjs') => [{
  id: 'text', changed_files: ['src/lib/math.ts'],
  criteria: [{ id: 'a', text: 'Adding works' }, { id: 'b', text: 'The total is stored' }],
  checks: [
    { id: 't1', criterion: 'a', method: 'checks', action: `run ${file}`, expected: 'passes', files: [file] },
    { id: 't2', criterion: 'b', method: 'checks', action: 'run the suite', expected: 'passes', files: ['src/ok.test.mjs'] },
    { id: 'q1', criterion: 'b', method: 'database', action: 'Open https://x.example.com/orders?token=abc123 and count', expected: 'one row', sql: `select 1 from t where email = '${SECRET_ROW}'`, expect: { rows_eq: 1 } },
  ],
}];
const begin = () => QA.start({ repo, args: ['the', 'totals'], session: { browser: true } }).run_id;
const cases = () => C.readJsonl(join(S.stateRoot(), 'jev.jsonl'));
const env = (jev, calibrated = '') => {
  process.env.QA_THIS_JEV = jev;
  process.env.QA_THIS_TEST_CALIBRATED = calibrated;
};

test('every question is uncalibrated, has a threshold, a direction and an unsafe side', () => {
  assert.equal(Q.UNCALIBRATED.size, 5);
  for (const q of Q.UNCALIBRATED) {
    assert.ok(Q.THRESHOLDS[q] > 0 && Q.THRESHOLDS[q] < 1, q);
    assert.ok(['gte', 'lt'].includes(Q.META[q].acts_when) && ['fp', 'fn'].includes(Q.META[q].unsafe), q);
    assert.equal(Q.calibrated(q), false);
  }
});

test('shadow and live: an uncalibrated answer is logged and changes nothing', async () => {
  for (const mode of ['shadow', 'live']) {
    env(mode);
    const seen = [];
    const run = begin();
    const p = await QA.plan({ run, confirmed: true, items: items() }, { ask: stub({ needs_browser_check: 0.99, needs_data_check: 0.99, covers: 0.01 }, seen) });
    assert.deepEqual(p.items[0].methods.map((m) => m.method), ['checks'], mode);
    assert.deepEqual(p.items[0].uncovered, [], mode);
    assert.equal(p.jev_mode, mode);
    await QA.runChecks({ run });
    assert.equal((await QA.status(run, { ask: stub({ environmental: 0.99 }, seen) })).items[0].status, 'passed');

    // What left the machine.
    const sent = JSON.stringify(seen);
    assert.ok(!sent.includes(SECRET_ROW) && !sent.includes('select 1'), 'SQL or a row value was sent');
    assert.ok(!sent.includes('token=abc123'), 'a URL query string was sent');
    assert.deepEqual(seen[0].state.changed_files, ['src/lib/math.ts']);
    assert.match(seen[0].state.checks[2], /^database: Open https:\/\/x\.example\.com\/orders and count -> one row$/);

    const mine = cases().filter((c) => c.type === 'case' && c.case.startsWith(run));
    assert.deepEqual([...new Set(mine.map((c) => c.question))].sort(), ['check_covers_criterion', 'needs_browser_check', 'needs_data_check', 'needs_new_tests']);
    assert.ok(mine.every((c) => c.acted === false && c.skill === 'qa-this' && c.mode === mode));
    assert.equal(mine.find((c) => c.question === 'needs_data_check').unsafe, 'fn');
    // The accepted plan is the right answer to "did this item need that method".
    const labels = cases().filter((c) => c.type === 'label' && c.case === `${run}/text`);
    assert.deepEqual(Object.fromEntries(labels.map((l) => [l.question, l.label])), { needs_browser_check: false, needs_data_check: false, needs_new_tests: false });
  }
});

test('re-planning does not log the same case twice or ask again for the same facts', async () => {
  env('shadow');
  const seen = [];
  const run = begin();
  const ask = stub({}, seen);
  await QA.plan({ run, items: items() }, { ask });
  await QA.plan({ run, items: [] }, { ask });
  await QA.plan({ run, confirmed: true }, { ask });
  assert.equal(seen.length, 1);
  assert.equal(cases().filter((c) => c.type === 'case' && c.case === `${run}/text`).length, 3);
});

test('calibrated and live: a need adds a method and never removes one', async () => {
  env('live', 'needs_browser_check,needs_data_check,needs_new_tests');
  const run = begin();
  const p = await QA.plan({ run, env: 'local', confirmed: true, items: items() }, { ask: stub({ needs_browser_check: 0.1, needs_data_check: 0.9, needs_new_tests: 0.1 }) });
  const methods = Object.fromEntries(p.items[0].methods.map((m) => [m.method, m.why]));
  assert.equal(methods.database, 'Jev: needs_data_check');
  assert.ok(methods.checks, 'a low score took a rule-chosen method away');
  assert.equal(p.items[0].checks.database, 1);
  const label = cases().filter((c) => c.type === 'label' && c.case === `${run}/text` && c.question === 'needs_data_check').pop();
  assert.equal(label.label, true);
  // Chosen by a rule, with no check proposed for it: not evidence that it was needed.
  const hollow = cases().filter((c) => c.type === 'label' && c.case === `${run}/text` && c.question === 'needs_new_tests').pop();
  assert.equal(hollow.label, false);
});

test('calibrated and live: a check Jev says does not cover its criterion counts for nothing', async () => {
  env('live', 'check_covers_criterion');
  const run = begin();
  const p = await QA.plan({ run, confirmed: true, items: items() }, { ask: stub({ covers__0: 0.05, covers: 0.9 }) });
  assert.deepEqual(p.items[0].uncovered.map((u) => u.id), ['a']);
  await QA.runChecks({ run });
  const st = await QA.status(run, { ask: stub({}) });
  assert.equal(st.items[0].status, 'partial');
  assert.equal(st.items[0].passed, 2);
});

test('calibrated and live: an environmental failure blocks the item; it is never a pass', async () => {
  env('live', 'failure_is_environmental');
  const run = begin();
  await QA.plan({ run, confirmed: true, items: items('src/bad.test.mjs') }, { ask: stub({}) });
  await QA.runChecks({ run });
  const seen = [];
  const st = await QA.status(run, { ask: stub({ environmental: 0.95 }, seen) });
  assert.equal(st.items[0].status, 'blocked');
  assert.equal(st.items[0].failed_checks[0].environmental, true);
  assert.deepEqual(seen[0].state.failures, [{ check: 'checks: run src/bad.test.mjs -> passes', observed: 'exit 1' }]);
  assert.match(QA.postPlan({ run }).items[0].reason, /nowhere to post/);
  // Below the threshold it is a product failure.
  const again = await QA.status(run, { ask: stub({ environmental: 0.2 }) });
  assert.equal(again.items[0].status, 'failed');
  // The user says it really was the product: that is the unsafe side for 0.95.
  env('shadow');
  const o = QA.outcome({ run, item: 'text', result: 'right' });
  assert.equal(o.labeled, 1);
  const label = cases().filter((c) => c.type === 'label' && c.question === 'failure_is_environmental').pop();
  assert.deepEqual([label.label, label.source, label.case], [false, 'outcome', `${run}/text/t1`]);
});

test('outcome labels: a confirmed pass says the checks covered; a failure that was really "blocked" says environmental', async () => {
  env('shadow');
  let run = begin();
  await QA.plan({ run, confirmed: true, items: items() }, { ask: stub({ covers: 0.8 }) });
  await QA.runChecks({ run });
  await QA.status(run, { ask: stub({}) });
  assert.equal(QA.outcome({ run, item: 'text', result: 'right' }).labeled, 2);
  assert.equal(QA.outcome({ run, item: 'text', result: 'wrong', actual: 'failed' }).labeled, 0);

  run = begin();
  await QA.plan({ run, confirmed: true, items: items('src/bad.test.mjs') }, { ask: stub({}) });
  await QA.runChecks({ run });
  await QA.status(run, { ask: stub({ environmental: 0.4 }) });
  QA.outcome({ run, item: 'text', result: 'wrong', actual: 'blocked' });
  assert.equal(cases().filter((c) => c.type === 'label' && c.case === `${run}/text/t1`).pop().label, true);
});

test('Jev unreachable or off: the run goes on by its code rules', async () => {
  env('shadow');
  let run = begin();
  const down = async () => ({ degraded: true, answers: {}, error: 'HTTP 529' });
  const p = await QA.plan({ run, confirmed: true, items: items('src/bad.test.mjs') }, { ask: down });
  assert.deepEqual(p.items[0].methods.map((m) => m.method), ['checks']);
  await QA.runChecks({ run });
  assert.equal((await QA.status(run, { ask: async () => { throw new Error('boom'); } })).items[0].status, 'failed');

  env('off');
  run = begin();
  const never = async () => assert.fail('asked with Jev off');
  await QA.plan({ run, confirmed: true, items: items() }, { ask: never });
  await QA.runChecks({ run });
  assert.equal((await QA.status(run, { ask: never })).items[0].status, 'passed');
});
