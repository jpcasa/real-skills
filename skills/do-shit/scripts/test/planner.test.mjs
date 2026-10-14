import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlan, cluster, dependencies, topoOrder, mergeOrder, estimateSpawns } from '../lib/planner.mjs';
import { gate, normalizeCi } from '../lib/merge.mjs';

const leaf = (id, extra = {}) => ({ id, ref: id, roles: ['investigator', 'worker', 'tester'], plan: { files: [], depends_on: [] }, links: {}, ...extra });

test('clustering is transitive above threshold', () => {
  const c = cluster(['a', 'b', 'c', 'd'], { 'a|b': 0.9, 'b|c': 0.8, 'c|d': 0.1, 'a|d': 0.2 }, 0.5);
  assert.deepEqual(c.map((x) => [...x].sort()), [['a', 'b', 'c'], ['d']]);
});

test('dependency needs evidence; jev alone is not enough; live needs jev agreement', () => {
  const leaves = [leaf('A'), leaf('B', { plan: { files: [], depends_on: ['A'] } }), leaf('C')];
  const jev = { 'A>B': 0.9, 'A>C': 0.95 }; // C has no evidence
  const live = dependencies(leaves, jev, 'live', 0.6);
  assert.deepEqual(live, [['A', 'B']]);
  const liveLow = dependencies(leaves, { 'A>B': 0.2 }, 'live', 0.6);
  assert.deepEqual(liveLow, []);
  const shadow = dependencies(leaves, {}, 'shadow', 0.6);
  assert.deepEqual(shadow, [['A', 'B']]);
  const linked = dependencies([leaf('A'), leaf('B', { links: { blocked_by: ['A'] } })], {}, 'shadow', 0.6);
  assert.deepEqual(linked, [['A', 'B']]);
});

test('topo order and cycle detection', () => {
  assert.deepEqual(topoOrder(['a', 'b', 'c'], [['c', 'a']]).order, ['b', 'c', 'a']);
  const t = topoOrder(['a', 'b', 'c'], [['c', 'a']]);
  assert.ok(t.order.indexOf('c') < t.order.indexOf('a'));
  const cyc = topoOrder(['a', 'b'], [['a', 'b'], ['b', 'a']]);
  assert.ok(cyc.cycle.length > 0);
});

test('computePlan: dependent leaves share a team, stacked in order; independent leaves split', () => {
  const leaves = [leaf('A'), leaf('B', { plan: { files: [], depends_on: ['A'] } }), leaf('C')];
  const p = computePlan({ leaves, overlap: {}, jevDeps: {}, mode: 'shadow' });
  const teamAB = p.teams.find((t) => t.leaves.includes('A'));
  assert.deepEqual(teamAB.leaves, ['A', 'B']);
  assert.equal(p.stacks.B, 'A');
  assert.ok(p.teams.find((t) => t.leaves.includes('C')).leaves.length === 1);
  assert.equal(p.warnings.length, 0);
});

test('computePlan: cycle edges dropped with a warning', () => {
  const leaves = [leaf('A', { plan: { files: [], depends_on: ['B'] } }), leaf('B', { plan: { files: [], depends_on: ['A'] } })];
  const p = computePlan({ leaves, overlap: {}, jevDeps: {}, mode: 'shadow' });
  assert.deepEqual(p.stacks, {});
  assert.match(p.warnings[0], /cycle/);
});

test('spawn estimate for 3 leaves', () => {
  const leaves = [leaf('A'), leaf('B', { roles: ['investigator', 'worker', 'tester', 'designer', 'auditor'] }), leaf('C')];
  // (2+2) + (4+2) + (2+2) = 14
  assert.equal(estimateSpawns(leaves), 14);
});

test('merge order: stack parents first, then lowest overlap first', () => {
  const plan = { stacks: { B: 'A' }, overlap: { 'A|C': 0.9, 'B|C': 0.8, 'A|D': 0.1 } };
  const o = mergeOrder(['B', 'C', 'A', 'D'], plan);
  assert.ok(o.indexOf('A') < o.indexOf('B'));
  assert.equal(o[0], 'D');
});

test('gate outcomes', () => {
  const base = { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', ci: 'green', failed: [], reviewDecision: null, comments: [] };
  const e = { reran: false, picked_draft: false };
  const live = (a) => ({ degraded: false, answers: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, { type: 'noul', noul: v }])) });
  assert.equal(gate(base, null, e, 'live').decision, 'merge');
  assert.equal(gate({ ...base, mergeable: 'CONFLICTING' }, null, e, 'live').fix, 'conflict');
  assert.equal(gate({ ...base, ci: 'red', failed: [{ name: 'test' }] }, live({ ci_failure_unrelated_to_pr: 0.9 }), e, 'live').decision, 'rerun');
  assert.equal(gate({ ...base, ci: 'red', failed: [{ name: 'test' }] }, live({ ci_failure_unrelated_to_pr: 0.9 }), { ...e, reran: true }, 'live').fix, 'ci');
  assert.equal(gate({ ...base, isDraft: true }, null, e, 'live').decision, 'skip');
  assert.equal(gate({ ...base, isDraft: true }, null, { ...e, picked_draft: true }, 'live').decision, 'merge');
  // degraded/shadow: ambiguity never merges
  assert.equal(gate({ ...base, ci: 'red', failed: [{ name: 't' }] }, { degraded: true, answers: {} }, e, 'degraded').decision, 'fix');
  assert.equal(gate({ ...base, comments: [{ body: 'nit' }] }, null, e, 'shadow').decision, 'skip');
  assert.equal(gate({ ...base, comments: [{ body: 'nit' }] }, live({ open_review_comments_blocking: 0.1 }), e, 'live').decision, 'merge');
  assert.equal(gate({ ...base, ci: 'pending' }, null, e, 'live').decision, 'defer');
  assert.equal(gate({ ...base, mergeStateStatus: 'BLOCKED' }, null, e, 'live').decision, 'skip');
});

test('normalizeCi', () => {
  assert.equal(normalizeCi([{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }]).ci, 'green');
  assert.equal(normalizeCi([{ name: 'a', status: 'IN_PROGRESS' }]).ci, 'pending');
  assert.equal(normalizeCi([{ name: 'a', status: 'COMPLETED', conclusion: 'FAILURE' }, { context: 'b', state: 'PENDING' }]).ci, 'red');
  assert.equal(normalizeCi([]).ci, 'none');
});

test('normalizeCi judges a check by its latest run', () => {
  const run = (conclusion, startedAt, extra = {}) => ({
    __typename: 'CheckRun', name: 'Guard Drizzle History', workflowName: 'Guard Drizzle History', status: 'COMPLETED', conclusion, startedAt,
    detailsUrl: `https://github.com/o/r/actions/runs/${Date.parse(startedAt) / 1000}/job/1`, ...extra,
  });
  const other = { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-13T21:11:30Z' };
  const skipped = { __typename: 'CheckRun', name: 'deploy', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SKIPPED', startedAt: '2026-10-13T21:11:30Z' };
  const base = { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, comments: [] };
  const e = { reran: false, picked_draft: false };

  // Pvragon/echo1#2963: the `opened` run was cancelled by workflow concurrency
  // when a label was added; the `labeled` run of the same check passed.
  const superseded = normalizeCi([run('CANCELLED', '2026-10-13T21:11:32Z'), other, skipped, run('SUCCESS', '2026-10-13T21:16:40Z')]);
  assert.deepEqual(superseded, { ci: 'green', failed: [] });
  assert.equal(gate({ ...base, ...superseded }, null, e, 'live').decision, 'merge');
  // rollup order does not matter, only the start time
  assert.equal(normalizeCi([run('SUCCESS', '2026-10-13T21:16:40Z'), run('CANCELLED', '2026-10-13T21:11:32Z')]).ci, 'green');

  // a pass that a later run of the same check failed is a failure
  const regressed = normalizeCi([run('SUCCESS', '2026-10-13T21:11:32Z'), other, run('FAILURE', '2026-10-13T21:16:40Z')]);
  assert.equal(regressed.ci, 'red');
  assert.deepEqual(regressed.failed.map((f) => f.name), ['Guard Drizzle History']);
  assert.match(regressed.failed[0].url, new RegExp(`/runs/${Date.parse('2026-10-13T21:16:40Z') / 1000}/`));
  assert.equal(gate({ ...base, ...regressed }, null, e, 'live').fix, 'ci');

  // a cancelled run nothing replaced is not green
  const lone = normalizeCi([run('CANCELLED', '2026-10-13T21:11:32Z'), other]);
  assert.notEqual(lone.ci, 'green');
  assert.deepEqual(lone.failed.map((f) => f.name), ['Guard Drizzle History']);
  assert.notEqual(gate({ ...base, ...lone }, null, e, 'live').decision, 'merge');

  // a later run still in progress replaces the old result: pending, not red
  assert.equal(normalizeCi([run('FAILURE', '2026-10-13T21:11:32Z'), run(null, '2026-10-13T21:16:40Z', { status: 'IN_PROGRESS' })]).ci, 'pending');
  // same check name in another workflow is another check
  assert.equal(normalizeCi([run('CANCELLED', '2026-10-13T21:11:32Z', { workflowName: 'Other' }), run('SUCCESS', '2026-10-13T21:16:40Z')]).ci, 'red');
  // no timestamps: nothing proves a later run, so every entry counts
  assert.equal(normalizeCi([{ name: 'a', status: 'COMPLETED', conclusion: 'CANCELLED' }, { name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }]).ci, 'red');
  // commit statuses group by context
  assert.equal(normalizeCi([{ context: 'ci/x', state: 'FAILURE', startedAt: '2026-10-13T21:11:32Z' }, { context: 'ci/x', state: 'SUCCESS', startedAt: '2026-10-13T21:16:40Z' }]).ci, 'green');
});

test('eval sweep picks best-F1 threshold', async () => {
  const { sweep } = await import('../eval/run.mjs');
  const pts = [{ p: 0.9, y: true }, { p: 0.7, y: true }, { p: 0.55, y: false }, { p: 0.2, y: false }];
  const b = sweep(pts);
  assert.equal(b.f1, 1);
  assert.ok(b.threshold > 0.55 && b.threshold <= 0.7, String(b.threshold));
});
