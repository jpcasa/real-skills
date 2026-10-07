import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../lib/autonomy.mjs';
import { THRESHOLDS, UNCALIBRATED, isCalibrated } from '../lib/questions.mjs';

const jev = (answers, degraded = false) => ({ degraded, answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { type: 'noul', noul: v }])) });
const leaf = (o = {}) => ({ id: 'A', ref: '#1', leaf: true, excluded: null, roles: ['investigator', 'worker', 'tester'], plan: { summary: 's', files: ['src/a.ts'] }, ...o });
const mkRun = (o = {}) => ({ mode: 'live', items: [leaf()], flags: {}, plan: { estimate: 4, warnings: [] }, spawns_used: 1, spawn_cap: 60, ...o });
const withCal = (ids, fn) => {
  process.env.DO_SHIT_TEST_CALIBRATED = ids;
  try {
    return fn();
  } finally {
    delete process.env.DO_SHIT_TEST_CALIBRATED;
  }
};
const ALL = [...UNCALIBRATED].join(',');

test('new questions ship uncalibrated', () => {
  assert.deepEqual([...UNCALIBRATED].sort(), ['fix_stays_within_item_scope', 'plan_needs_human_review']);
  assert.equal(isCalibrated('plan_needs_human_review'), false);
  assert.equal(isCalibrated('plan_is_wrong'), true);
});

test('checkpoint: auto only when live, calibrated, autonomy on, no veto, Jev below threshold', () => {
  const low = jev({ plan_needs_human_review: 0.1 });
  withCal(ALL, () => {
    assert.deepEqual(A.checkpointGate({ run: mkRun(), config: {}, jev: low }), { would: true, auto: true, vetoes: [], p: 0.1 });
    assert.equal(A.checkpointGate({ run: mkRun(), config: { autonomy: 'off' }, jev: low }).auto, false);
    assert.equal(A.checkpointGate({ run: mkRun({ mode: 'shadow' }), config: {}, jev: low }).auto, false);
    assert.equal(A.checkpointGate({ run: mkRun({ mode: 'degraded' }), config: {}, jev: jev({}, true) }).would, false);
    const high = A.checkpointGate({ run: mkRun(), config: {}, jev: jev({ plan_needs_human_review: THRESHOLDS.plan_needs_human_review }) });
    assert.deepEqual([high.would, high.auto], [false, false], 'at the threshold it asks');
    assert.equal(A.checkpointGate({ run: mkRun(), config: {}, jev: null }).would, false, 'no Jev answer, no decision');
  });
  const uncal = A.checkpointGate({ run: mkRun(), config: {}, jev: low });
  assert.deepEqual([uncal.would, uncal.auto], [true, false]);
  assert.match(A.blockedBy(mkRun(), {}, 'plan_needs_human_review'), /not calibrated/);
});

test('checkpoint: every veto alone forces the ask', () => {
  const cases = {
    'open questions': mkRun({ items: [leaf({ plan: { files: [], open_questions: ['?'] } })] }),
    'not covered': mkRun({ items: [leaf({ plan: { files: [], uncovered_parent_work: 'the export' } })] }),
    'security-sensitive': mkRun({ items: [leaf({ roles: ['worker', 'security-advisor'] })] }),
    'migration or schema': mkRun({ items: [leaf({ plan: { files: ['supabase/migrations/001.sql'] } })] }),
    'excluded or skipped': mkRun({ items: [leaf(), leaf({ id: 'B', excluded: 'bad premise' })] }),
    'architect failed': mkRun({ architect_failed: { error: 'x' } }),
    'planner warnings': mkRun({ plan: { estimate: 4, warnings: ['cycle dropped'] } }),
    'over the cap': mkRun({ plan: { estimate: 60, warnings: [] } }),
    'human already answered': mkRun({ flags: { checkpoint_asked: true } }),
    'no leaf left': mkRun({ items: [leaf({ excluded: 'x' })] }),
  };
  withCal(ALL, () => {
    for (const [why, run] of Object.entries(cases)) {
      const g = A.checkpointGate({ run, config: {}, jev: jev({ plan_needs_human_review: 0 }) });
      assert.equal(g.auto, false, why);
      assert.match(g.vetoes.join(' | '), new RegExp(why), why);
    }
  });
});

const fixLs = (o = {}) => ({
  loops: [{
    reports: {
      worker: { role: 'worker', verdict: 'pass', findings: [], files_touched: ['src/a.ts'] },
      tester: { role: 'tester', verdict: 'pass', findings: [], files_touched: [] },
      ...o,
    },
  }],
});

test('reapproval: auto only with a passing tester, in-plan files, no security, Jev at or above threshold', () => {
  const item = leaf();
  const yes = jev({ fix_stays_within_item_scope: 0.9 });
  withCal(ALL, () => {
    assert.deepEqual(A.reapprovalGate({ run: mkRun(), config: {}, ls: fixLs(), item, jev: yes }), { would: true, auto: true, vetoes: [], p: 0.9 });
    assert.equal(A.reapprovalGate({ run: mkRun(), config: {}, ls: fixLs(), item, jev: jev({ fix_stays_within_item_scope: 0.69 }) }).auto, false);
    assert.equal(A.reapprovalGate({ run: mkRun({ mode: 'shadow' }), config: {}, ls: fixLs(), item, jev: yes }).auto, false);
    const vetoed = {
      'tester did not pass': fixLs({ tester: { role: 'tester', verdict: 'fail', findings: [] } }),
      'outside the plan': fixLs({ worker: { role: 'worker', verdict: 'pass', findings: [], files_touched: ['src/other.ts'] } }),
      'migration or schema': fixLs({ worker: { role: 'worker', verdict: 'pass', findings: [], files_touched: ['db/migrations/2.sql'] } }),
      'security findings': fixLs({ tester: { role: 'tester', verdict: 'pass', findings: [{ text: 'SECURITY: token logged' }] } }),
      'invalid report': fixLs({ worker: { role: 'worker', verdict: 'fail', invalid: true, findings: [], files_touched: [] } }),
    };
    for (const [why, ls] of Object.entries(vetoed)) {
      const g = A.reapprovalGate({ run: mkRun(), config: {}, ls, item, jev: yes });
      assert.equal(g.auto, false, why);
      assert.match(g.vetoes.join(' | '), new RegExp(why), why);
    }
  });
  assert.equal(A.reapprovalGate({ run: mkRun(), config: {}, ls: fixLs(), item, jev: yes }).auto, false, 'uncalibrated');
});

test('ci_pending: continue inside the window, skip after it, ask when autonomy is off', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  const at = (min) => ({ ci_first_pending_at: new Date(now - min * 60_000).toISOString() });
  assert.equal(A.ciPendingGate({ config: {}, entry: at(5), now }), 'continue');
  assert.equal(A.ciPendingGate({ config: {}, entry: at(20), now }), 'skip');
  assert.equal(A.ciPendingGate({ config: { ci_wait_minutes: 30 }, entry: at(20), now }), 'continue');
  assert.equal(A.ciPendingGate({ config: { autonomy: 'off' }, entry: at(1), now }), 'ask');
  assert.equal(A.ciPendingGate({ config: {}, entry: {}, now }), 'continue', 'first sighting starts the clock');
});

test('offers: decided only when the repo states after_qa', () => {
  assert.equal(A.offersGate({}), null);
  assert.equal(A.offersGate({ autonomy: 'off', after_qa: { fix_bugs: true } }), null);
  assert.deepEqual(A.offersGate({ after_qa: { fix_bugs: true } }), { fix_bugs: true, e2e: false });
  assert.deepEqual(A.offersGate({ after_qa: {} }), { fix_bugs: false, e2e: false });
});

test('there is no decider for merge_approval or qa_approval', () => {
  assert.deepEqual(Object.keys(A).filter((k) => /merge|qa(?!_)|Approval/i.test(k) && !/reapproval/i.test(k)), []);
});
