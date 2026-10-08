// End-to-end harness run against a temp git repo, with Jev and gh stubbed.
// Two leaves under one parent; B depends on A (investigator evidence) so B is
// stacked on A. Covers: plan -> checkpoint -> build loops (incl. a fix loop,
// an invalid report re-ask, a read-only scope violation) -> PRs -> merge -> QA declined -> done.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '../harness.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'doshit-e2e-'));
const repo = join(tmp, 'demo-repo');
const stateDir = join(tmp, 'state');
const jevStub = join(tmp, 'jev.json');
const ghStub = join(tmp, 'gh.json');
writeFileSync(jevStub, JSON.stringify({ 'needs_*': 0.1 }));

const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
execFileSync('mkdir', ['-p', repo]);
sh(repo, 'git', ['init', '-q', '-b', 'main']);
sh(repo, 'git', ['config', 'user.email', 't@t']);
sh(repo, 'git', ['config', 'user.name', 'Test User']);
writeFileSync(join(repo, 'README.md'), '# demo\n');
writeFileSync(join(repo, '.gitignore'), '.claude/worktrees/\n');
sh(repo, 'git', ['add', '.']);
sh(repo, 'git', ['commit', '-qm', 'init']);

// Never this machine's real calibration file.
const calDir = join(tmp, 'calibration');
const env = { ...process.env, DO_SHIT_STATE_DIR: stateDir, DO_SHIT_JEV_STUB: jevStub, DO_SHIT_GH_STUB: ghStub, REAL_SKILLS_CALIBRATION_DIR: calDir, REAL_SKILLS_CALIBRATION: '' };
function h(args, stdin = '', extraEnv = {}) {
  const res = execFileSync('node', [HARNESS, ...args], { env: { ...env, ...extraEnv }, input: stdin, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  const lines = res.trim().split('\n');
  assert.equal(lines.length, 1, `exactly one JSON line from ${args[0]}: ${res}`);
  return JSON.parse(lines[0]);
}
const report = (role, item, loop, verdict, extra = {}) =>
  `Done.\n\n\`\`\`json\n${JSON.stringify({ role, item, loop, verdict, summary: `${role} ${verdict}`, findings: [], files_touched: [], commits: [], ...extra })}\n\`\`\``;
const commit = (wt, file, text) => {
  writeFileSync(join(wt, file), text);
  sh(wt, 'git', ['add', file]);
  sh(wt, 'git', ['commit', '-qm', `edit ${file}`]);
};
const spawns = (r) => r.actions.filter((a) => a.action === 'spawn');
const byRole = (r, role) => spawns(r).find((s) => s.role === role);

test('full run: plan, stacked leaves, fix loop, merge, QA declined', () => {
  const items = [
    { id: 'P', ref: 'CU-P', title: 'Parent epic', leaf: false, children: ['A', 'B'], status_type: 'open' },
    { id: 'A', ref: 'CU-A', title: 'Add widget API', body: 'api', leaf: true, parent: 'P', acceptance_criteria: ['GET /widgets'], status_type: 'open' },
    { id: 'B', ref: 'CU-B', title: 'Widget list UI', body: 'ui', leaf: true, parent: 'P', acceptance_criteria: ['list renders'], status_type: 'open' },
  ];
  const init = h(['init', '--repo', repo, '--base', 'main', '--tracker', 'clickup', '--dry-run', '--verify', 'true'], JSON.stringify({ items }));
  const run = init.run_id;
  assert.deepEqual(init.leaves, ['CU-A', 'CU-B']);

  // --- plan: two investigators in parallel
  let r = h(['next', '--run', run]);
  assert.equal(r.phase, 'plan');
  assert.equal(spawns(r).length, 2);
  // items move to in_progress at run start, before planning
  const trk = r.actions.find((a) => a.action === 'tracker');
  assert.equal(trk.key, 'tracker:in_progress');
  assert.equal(trk.ops.length, 3);
  h(['record-tracker', '--run', run, '--key', 'tracker:in_progress'], JSON.stringify({ results: items.map((i) => ({ item: i.ref, op: 'status', to_type: 'in_progress', ok: true })) }));
  const invA = byRole(r, 'investigator');
  assert.ok(existsSync(invA.prompt_file));
  assert.match(readFileSync(invA.prompt_file, 'utf8'), /Validate the premise/);
  // waiting while pending
  assert.equal(h(['next', '--run', run]).actions[0].action, 'wait');

  const [sA, sB] = spawns(r);
  h(['record', '--run', run, '--leaf', 'A', '--role', 'investigator', '--agent', sA.name],
    report('investigator', 'CU-A', 1, 'pass', { plan: { premise_valid: true, summary: 'add api', files: ['src/api.ts'], acceptance_criteria: ['GET /widgets'], test_plan: ['unit'], depends_on: [] } }));
  h(['record', '--run', run, '--leaf', 'B', '--role', 'investigator', '--agent', sB.name],
    report('investigator', 'CU-B', 1, 'pass', { plan: { premise_valid: true, summary: 'add ui', files: ['src/list.ts'], acceptance_criteria: ['list'], test_plan: ['unit'], depends_on: ['CU-A'] } }));

  // --- checkpoint
  r = h(['next', '--run', run]);
  assert.equal(r.phase, 'checkpoint');
  const cp = r.actions[0];
  assert.equal(cp.kind, 'checkpoint');
  assert.equal(cp.payload.stacks.B, 'A');
  assert.deepEqual(cp.payload.teams.map((t) => t.leaves), [['A', 'B']]);
  // shadow mode: fallback roles = core + auditor
  assert.deepEqual(Object.keys(cp.payload.leaves[0].roles).sort(), ['auditor', 'investigator', 'tester', 'worker']);
  h(['record-answer', '--run', run, '--kind', 'checkpoint'], JSON.stringify({ proceed: true }));

  // --- build A loop 1: worker (in_progress already done at run start)
  r = h(['next', '--run', run]);
  assert.equal(r.phase, 'build');
  assert.ok(!r.actions.some((a) => a.action === 'tracker'), 'no second in_progress move');
  const w1 = byRole(r, 'worker');
  assert.equal(w1.via, 'new');
  const wtA = join(repo, '.claude/worktrees/ds-cu-a-add-widget-api');
  assert.ok(existsSync(wtA), 'worktree A created');
  commit(wtA, 'api.ts', 'export const a = 1;\n');
  h(['record', '--run', run, '--leaf', 'A', '--role', 'worker', '--agent', w1.name], report('worker', 'CU-A', 1, 'pass'));

  // review: tester + auditor in parallel
  r = h(['next', '--run', run]);
  assert.deepEqual(spawns(r).map((s) => s.role).sort(), ['auditor', 'tester']);
  const t1 = byRole(r, 'tester');
  const tp = readFileSync(t1.prompt_file, 'utf8');
  assert.ok(!tp.includes('worker pass'), 'tester prompt must not include worker self-report');

  // invalid tester report -> reask, then valid FAIL
  let rec = h(['record', '--run', run, '--leaf', 'A', '--role', 'tester', '--agent', t1.name], 'no json here');
  assert.equal(rec.action, 'reask');
  h(['record', '--run', run, '--leaf', 'A', '--role', 'tester', '--agent', t1.name],
    report('tester', 'CU-A', 1, 'fail', { findings: [{ severity: 'bug', blocking: true, owner_role: 'worker', file: 'api.ts', line: 1, text: 'missing handler' }] }));
  // auditor dirties the tree (read-only violation)
  writeFileSync(join(wtA, 'stray.txt'), 'oops');
  rec = h(['record', '--run', run, '--leaf', 'A', '--role', 'auditor', '--agent', byRole(r, 'auditor').name], report('auditor', 'CU-A', 1, 'pass'));
  assert.equal(rec.scope.ok, false);

  // decide -> fix loop 2: worker (message, same agent) with routed failures
  r = h(['next', '--run', run]);
  const w2 = byRole(r, 'worker');
  assert.equal(w2.loop, 2);
  assert.equal(w2.via, 'message');
  assert.equal(w2.name, w1.name);
  const wp = readFileSync(w2.prompt_file, 'utf8');
  assert.match(wp, /missing handler/);
  assert.match(wp, /read-only but changed the tree/);
  sh(wtA, 'git', ['rm', '-q', '--cached', '--ignore-unmatch', 'stray.txt']);
  execFileSync('rm', ['-f', join(wtA, 'stray.txt')]);
  commit(wtA, 'api.ts', 'export const a = 2; // handler\n');
  h(['record', '--run', run, '--leaf', 'A', '--role', 'worker', '--agent', w2.name], report('worker', 'CU-A', 2, 'pass'));

  r = h(['next', '--run', run]);
  const loop2Reviewers = spawns(r).map((s) => s.role).sort();
  // auditor passed in loop 1 (the violation was harness-detected), so only tester re-runs
  assert.deepEqual(loop2Reviewers, ['tester']);
  for (const s of spawns(r)) h(['record', '--run', run, '--leaf', 'A', '--role', s.role, '--agent', s.name], report(s.role, 'CU-A', 2, 'pass'));

  // ship -> PR action
  r = h(['next', '--run', run]);
  const prA = r.actions.find((a) => a.action === 'pr');
  assert.equal(prA.draft, false);
  assert.equal(prA.base_branch, 'main');
  assert.match(prA.title, /\[CU-A\]/);
  const bodyA = readFileSync(prA.body_file, 'utf8');
  assert.match(bodyA, /Part of CU-P/);
  assert.match(bodyA, /Loops used: 2/);
  h(['record-pr', '--run', run, '--leaf', 'A', '--number', '101', '--url', 'https://gh/pr/101']);

  // close-out tracker ops, then leaf B starts stacked on A
  r = h(['next', '--run', run]);
  const closeA = r.actions.find((a) => a.action === 'tracker');
  assert.deepEqual(closeA.ops.map((o) => o.op), ['comment', 'status']);
  h(['record-tracker', '--run', run, '--key', closeA.key], JSON.stringify({ results: [{ item: 'CU-A', op: 'status', to_type: 'review', ok: true }] }));
  assert.ok(!existsSync(wtA), 'worktree A removed after close-out');

  r = h(['next', '--run', run]);
  const wB = byRole(r, 'worker');
  assert.ok(wB, 'worker for B spawned');
  const wtB = join(repo, '.claude/worktrees/ds-cu-b-widget-list-ui');
  assert.equal(sh(wtB, 'git', ['log', '--format=%s', '-1', 'HEAD']).trim(), 'edit api.ts', 'B starts from A branch');
  commit(wtB, 'list.ts', 'export const l = 1;\n');
  h(['record', '--run', run, '--leaf', 'B', '--role', 'worker', '--agent', wB.name], report('worker', 'CU-B', 1, 'pass'));
  r = h(['next', '--run', run]);
  for (const s of spawns(r)) h(['record', '--run', run, '--leaf', 'B', '--role', s.role, '--agent', s.name], report(s.role, 'CU-B', 1, 'pass'));
  r = h(['next', '--run', run]);
  const prB = r.actions.find((a) => a.action === 'pr');
  assert.match(prB.base_branch, /cu-a-add-widget-api/);
  h(['record-pr', '--run', run, '--leaf', 'B', '--number', '102', '--url', 'https://gh/pr/102']);
  r = h(['next', '--run', run]);
  const closeB = r.actions.find((a) => a.action === 'tracker');
  h(['record-tracker', '--run', run, '--key', closeB.key], JSON.stringify({ results: [{ item: 'CU-B', op: 'status', to_type: 'review', ok: true }] }));

  // --- merge approval
  r = h(['next', '--run', run]);
  assert.equal(r.phase, 'merge_approval');
  const ma = r.actions[0];
  assert.deepEqual(ma.payload.order.map((o) => o.pr), [101, 102]);
  h(['record-answer', '--run', run, '--kind', 'merge_approval'], JSON.stringify({ merge: 'all_green' }));

  const clean = { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', ci: 'green', failed: [], reviewDecision: null, comments: [], files: [] };
  writeFileSync(ghStub, JSON.stringify({ 101: clean, 102: clean }));
  r = h(['next', '--run', run]);
  const m1 = r.actions[0];
  assert.equal(m1.action, 'merge');
  assert.equal(m1.pr, 101);
  assert.deepEqual(m1.then_retarget, [{ pr: 102, base: 'main' }]);
  h(['record-merge', '--run', run, '--pr', '101', '--result', 'merged']);
  r = h(['next', '--run', run]);
  assert.equal(r.actions[0].pr, 102);
  h(['record-merge', '--run', run, '--pr', '102', '--result', 'merged']);

  // merged -> QA status
  r = h(['next', '--run', run]);
  const ms = r.actions[0];
  assert.equal(ms.key, 'tracker:merged_status');
  assert.ok(ms.ops.every((o) => o.to_type === 'qa' && o.fallback_to_type === 'done'));
  h(['record-tracker', '--run', run, '--key', ms.key], JSON.stringify({ results: ms.ops.map((o) => ({ ...o, ok: true })) }));

  // QA declined -> done statuses incl. parent
  r = h(['next', '--run', run]);
  assert.equal(r.actions[0].kind, 'qa_approval');
  h(['record-answer', '--run', run, '--kind', 'qa_approval'], JSON.stringify({ qa: false }));
  r = h(['next', '--run', run]);
  const qd = r.actions[0];
  assert.deepEqual(qd.ops.map((o) => `${o.item}:${o.to_type}`), ['CU-A:done', 'CU-B:done', 'CU-P:done']);
  h(['record-tracker', '--run', run, '--key', qd.key], JSON.stringify({ results: qd.ops.map((o) => ({ ...o, ok: true })) }));

  r = h(['next', '--run', run]);
  assert.equal(r.phase, 'done');
  const rep = r.actions[0].report;
  assert.deepEqual(rep.rows.map((x) => x.result), ['merged', 'merged']);
  assert.deepEqual(rep.merge.map((m) => m.state), ['merged', 'merged']);
  // spawn accounting: 2 investigators + A(worker, tester, auditor) + B(worker, tester, auditor) = 8 new
  assert.equal(r.spawns_used, 8);

  // events log exists and every line parses
  const ev = readFileSync(join(stateDir, run, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(ev.some((e) => e.type === 'shadow_roles'));
  assert.ok(ev.some((e) => e.type === 'decision' && e.action === 'fix'));
});

test('merge gate: conflict spawns an integrator fix team, push, re-gate', () => {
  // Reuses a fresh run that jumps straight to merge by driving a 1-leaf flow quickly.
  const items = [{ id: 'C', ref: '#7', title: 'Fix date bug', body: 'x', leaf: true, status_type: 'open' }];
  const run = h(['init', '--repo', repo, '--base', 'main', '--tracker', 'github', '--dry-run'], JSON.stringify({ items })).run_id;
  let r = h(['next', '--run', run]);
  h(['record-tracker', '--run', run, '--key', 'tracker:in_progress'], JSON.stringify({ results: [] }));
  h(['record', '--run', run, '--leaf', 'C', '--role', 'investigator', '--agent', spawns(r)[0].name],
    report('investigator', '#7', 1, 'pass', { plan: { premise_valid: true, summary: 'fix', files: ['d.ts'], acceptance_criteria: ['ok'] } }));
  h(['next', '--run', run]);
  h(['record-answer', '--run', run, '--kind', 'checkpoint'], JSON.stringify({ proceed: true }));
  r = h(['next', '--run', run]);
  const wt = join(repo, '.claude/worktrees/ds-gh-7-fix-date-bug');
  commit(wt, 'd.ts', 'x\n');
  h(['record', '--run', run, '--leaf', 'C', '--role', 'worker', '--agent', byRole(r, 'worker').name], report('worker', '#7', 1, 'pass'));
  r = h(['next', '--run', run]);
  for (const s of spawns(r)) h(['record', '--run', run, '--leaf', 'C', '--role', s.role, '--agent', s.name], report(s.role, '#7', 1, 'pass'));
  r = h(['next', '--run', run]);
  const pr = r.actions.find((a) => a.action === 'pr');
  assert.match(readFileSync(pr.body_file, 'utf8'), /Closes #7/);
  h(['record-pr', '--run', run, '--leaf', 'C', '--number', '7', '--url', 'u']);
  r = h(['next', '--run', run]);
  h(['record-tracker', '--run', run, '--key', r.actions[0].key], JSON.stringify({ results: [] }));
  r = h(['next', '--run', run]);
  h(['record-answer', '--run', run, '--kind', 'merge_approval'], JSON.stringify({ merge: 'all_green' }));

  const conflict = { state: 'OPEN', isDraft: false, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', ci: 'green', failed: [], comments: [], headRefName: pr.branch, files: [] };
  writeFileSync(ghStub, JSON.stringify({ 7: conflict }));
  r = h(['next', '--run', run]);
  const integ = byRole(r, 'integrator');
  assert.ok(integ, 'integrator spawned');
  assert.match(readFileSync(integ.prompt_file, 'utf8'), /resolve conflicts/);
  const fixWt = join(repo, '.claude/worktrees/ds-fix-7');
  assert.ok(existsSync(fixWt));
  commit(fixWt, 'd.ts', 'x resolved\n');
  h(['record', '--run', run, '--leaf', 'C', '--role', 'integrator', '--agent', integ.name], report('integrator', '#7', 1, 'pass'));
  r = h(['next', '--run', run]);
  const tst = byRole(r, 'tester');
  h(['record', '--run', run, '--leaf', 'C', '--role', 'tester', '--agent', tst.name], report('tester', '#7', 1, 'pass'));
  r = h(['next', '--run', run]);
  const push = r.actions.find((a) => a.action === 'push');
  assert.equal(push.force_with_lease, true);
  const pushed = h(['record-push', '--run', run, '--leaf', 'C', '--pr', '7']);
  // shadow mode: behavior change can't be ruled out -> re-approval required
  assert.equal(pushed.state, 'needs_reapproval');
  r = h(['next', '--run', run]);
  assert.equal(r.actions[0].kind, 'reapproval');
  h(['record-answer', '--run', run, '--kind', 'reapproval'], JSON.stringify({ pr: 7, approve: true }));
  writeFileSync(ghStub, JSON.stringify({ 7: { ...conflict, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' } }));
  r = h(['next', '--run', run]);
  assert.equal(r.actions[0].action, 'merge');
  assert.ok(!existsSync(fixWt), 'fix worktree removed');
});

test('dry run: two leaves recorded as --number 0 get distinct PR numbers and both merge', () => {
  const items = [
    { id: 'X', ref: '#21', title: 'Alpha thing', body: 'a', leaf: true, status_type: 'open' },
    { id: 'Y', ref: '#22', title: 'Beta thing', body: 'b', leaf: true, status_type: 'open' },
  ];
  const run = h(['init', '--repo', repo, '--base', 'main', '--tracker', 'github', '--dry-run'], JSON.stringify({ items })).run_id;
  let r = h(['next', '--run', run]);
  h(['record-tracker', '--run', run, '--key', 'tracker:in_progress'], JSON.stringify({ results: [] }));
  for (const s of spawns(r)) {
    h(['record', '--run', run, '--leaf', s.leaf, '--role', 'investigator', '--agent', s.name],
      report('investigator', s.leaf === 'X' ? '#21' : '#22', 1, 'pass', { plan: { premise_valid: true, summary: s.leaf, files: [`${s.leaf}.ts`], acceptance_criteria: ['ok'] } }));
  }
  h(['next', '--run', run]);
  h(['record-answer', '--run', run, '--kind', 'checkpoint'], JSON.stringify({ proceed: true }));
  const refOf = { X: '#21', Y: '#22' };
  const wtOf = { X: 'ds-gh-21-alpha-thing', Y: 'ds-gh-22-beta-thing' };
  let guard = 0;
  while (guard++ < 40) {
    r = h(['next', '--run', run]);
    if (r.phase === 'merge_approval') break;
    for (const a of r.actions) {
      if (a.action === 'tracker') h(['record-tracker', '--run', run, '--key', a.key], JSON.stringify({ results: [] }));
      if (a.action === 'spawn') {
        if (a.role === 'worker') commit(join(repo, '.claude/worktrees', wtOf[a.leaf]), `${a.leaf}.ts`, 'x\n');
        h(['record', '--run', run, '--leaf', a.leaf, '--role', a.role, '--agent', a.name], report(a.role, refOf[a.leaf], a.loop, 'pass'));
      }
      if (a.action === 'pr') h(['record-pr', '--run', run, '--leaf', a.leaf, '--number', '0', '--url', 'dry-run']);
    }
  }
  const nums = r.actions[0].payload.order.map((o) => o.pr);
  assert.equal(new Set(nums).size, 2, `distinct numbers: ${nums}`);
  h(['record-answer', '--run', run, '--kind', 'merge_approval'], JSON.stringify({ merge: 'all_green' }));
  const merged = [];
  for (let i = 0; i < 2; i++) {
    r = h(['next', '--run', run]);
    assert.equal(r.actions[0].action, 'merge');
    merged.push(r.actions[0].pr);
    h(['record-merge', '--run', run, '--pr', String(r.actions[0].pr), '--result', 'merged']);
  }
  assert.deepEqual(merged.sort(), [...nums].sort());
  r = h(['next', '--run', run]);
  assert.equal(r.actions[0].key, 'tracker:merged_status');
});

test('statuses: in_progress at run start; dropped items restored to their init status', () => {
  const items = [
    { id: 'P2', ref: 'CU-P2', title: 'Umbrella', leaf: false, status: 'ready', status_type: 'open' },
    { id: 'A2', ref: 'CU-A2', title: 'Real work', body: 'x', leaf: true, parent: 'P2', status: 'backlog', status_type: 'open' },
    { id: 'B2', ref: 'CU-B2', title: 'Stale premise', body: 'y', leaf: true, parent: 'P2', status: 'scoping', status_type: 'open' },
  ];
  const run = h(['init', '--repo', repo, '--base', 'main', '--tracker', 'clickup', '--dry-run'], JSON.stringify({ items })).run_id;
  let r = h(['next', '--run', run]);
  const trk = r.actions.find((a) => a.action === 'tracker');
  assert.equal(trk.key, 'tracker:in_progress');
  assert.deepEqual(trk.ops.map((o) => o.item), ['CU-P2', 'CU-A2', 'CU-B2']);
  assert.equal(r.actions[0], trk, 'status move comes before the investigator spawns');
  h(['record-tracker', '--run', run, '--key', 'tracker:in_progress'], JSON.stringify({ results: items.map((i) => ({ item: i.ref, op: 'status', to_type: 'in_progress', ok: true })) }));
  const inv = (leaf) => spawns(r).find((s) => s.leaf === leaf);
  h(['record', '--run', run, '--leaf', 'A2', '--role', 'investigator', '--agent', inv('A2').name],
    report('investigator', 'CU-A2', 1, 'pass', { plan: { premise_valid: true, summary: 'do it', files: ['a.ts'], acceptance_criteria: ['ok'] } }));
  h(['record', '--run', run, '--leaf', 'B2', '--role', 'investigator', '--agent', inv('B2').name],
    report('investigator', 'CU-B2', 1, 'pass', { plan: { premise_valid: false, summary: 'already done', files: [], acceptance_criteria: [] } }));

  // B2 dropped by its investigator: restore it; P2 still has a live leaf.
  r = h(['next', '--run', run]);
  assert.equal(r.phase, 'checkpoint');
  const rs = r.actions.find((a) => a.key === 'tracker:restore');
  assert.deepEqual(rs.ops, [{ op: 'restore_status', item: 'CU-B2', to_name: 'scoping', to_type: 'open', only_if_type: 'in_progress' }]);
  assert.ok(r.actions.some((a) => a.kind === 'checkpoint'));
  h(['record-tracker', '--run', run, '--key', 'tracker:restore'], JSON.stringify({ results: [{ item: 'CU-B2', op: 'restore_status', to_type: 'open', ok: true }] }));
  assert.ok(!h(['next', '--run', run]).actions.some((a) => a.action === 'tracker'), 'restore is not repeated');

  // Cancel at checkpoint: A2 and P2 go back before the final report.
  h(['record-answer', '--run', run, '--kind', 'checkpoint'], JSON.stringify({ proceed: false }));
  r = h(['next', '--run', run]);
  assert.equal(r.phase, 'done');
  assert.deepEqual(r.actions.map((a) => a.key), ['tracker:restore']);
  assert.deepEqual(r.actions[0].ops.map((o) => [o.item, o.to_name]), [['CU-P2', 'ready'], ['CU-A2', 'backlog']]);
  h(['record-tracker', '--run', run, '--key', 'tracker:restore'], JSON.stringify({ results: [
    { item: 'CU-P2', op: 'restore_status', to_type: 'open', ok: true },
    { item: 'CU-A2', op: 'restore_status', to_type: 'open', ok: true, skipped: true, detail: 'moved since (in review)' },
  ] }));
  r = h(['next', '--run', run]);
  assert.equal(r.actions[0].action, 'done');
  const st = JSON.parse(readFileSync(join(stateDir, run, 'run.json'), 'utf8'));
  assert.equal(st.items.find((i) => i.id === 'A2').status_type, 'in_progress', 'skipped restore leaves status_type alone');
  assert.equal(st.items.find((i) => i.id === 'P2').status_type, 'open');
});

// ---------------------------------------------------------------- invalid reports
const hFail = (args, stdin = '') => {
  try {
    execFileSync('node', [HARNESS, ...args], { env, input: stdin, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return JSON.parse(e.stdout.toString().trim());
  }
  assert.fail(`expected ${args[0]} to exit non-zero`);
};
const runState = (run) => JSON.parse(readFileSync(join(stateDir, run, 'run.json'), 'utf8'));
test('checkpoint replan brings a bad-premise leaf back: investigator reruns with the notes', () => {
  const items = [{ id: 'R1', ref: 'CU-R1', title: 'Reopened switch', body: 'x', leaf: true, status: 'ready', status_type: 'open' }];
  const run = h(['init', '--repo', repo, '--base', 'main', '--tracker', 'clickup', '--dry-run'], JSON.stringify({ items })).run_id;
  let r = h(['next', '--run', run]);
  h(['record-tracker', '--run', run, '--key', 'tracker:in_progress'], JSON.stringify({ results: [{ item: 'CU-R1', op: 'status', to_type: 'in_progress', ok: true }] }));
  const inv = byRole(r, 'investigator');
  h(['record', '--run', run, '--leaf', 'R1', '--role', 'investigator', '--agent', inv.name],
    report('investigator', 'CU-R1', 1, 'blocked', { plan: { premise_valid: false, summary: 'already ships', files: [], acceptance_criteria: [] } }));
  r = h(['next', '--run', run]);
  assert.equal(r.phase, 'checkpoint');
  assert.deepEqual(r.actions.find((a) => a.kind === 'checkpoint').payload.excluded.map((e) => e.why), ['bad premise']);
  h(['record-tracker', '--run', run, '--key', 'tracker:restore'], JSON.stringify({ results: [{ item: 'CU-R1', op: 'restore_status', to_type: 'open', ok: true }] }));

  h(['record-answer', '--run', run, '--kind', 'checkpoint'], JSON.stringify({ proceed: true, replan: ['R1'], notes: { R1: 'Scope is the reopened gaps only.' } }));
  r = h(['next', '--run', run]);
  assert.equal(r.phase, 'plan');
  const again = byRole(r, 'investigator');
  assert.ok(again, 'the investigator is spawned again');
  assert.equal(again.via, 'message');
  assert.match(readFileSync(again.prompt_file, 'utf8'), /Notes from the user\nScope is the reopened gaps only\./);
  const trk = r.actions.find((a) => a.key === 'tracker:in_progress');
  assert.deepEqual(trk.ops.map((o) => o.item), ['CU-R1'], 'the restored item moves to in_progress again');
  h(['record-tracker', '--run', run, '--key', 'tracker:in_progress'], JSON.stringify({ results: [{ item: 'CU-R1', op: 'status', to_type: 'in_progress', ok: true }] }));

  h(['record', '--run', run, '--leaf', 'R1', '--role', 'investigator', '--agent', again.name],
    report('investigator', 'CU-R1', 1, 'pass', { plan: { premise_valid: true, summary: 'close the gaps', files: ['a.ts'], acceptance_criteria: ['ok'] } }));
  r = h(['next', '--run', run]);
  const cp = r.actions.find((a) => a.kind === 'checkpoint').payload;
  assert.deepEqual(cp.leaves.map((l) => l.ref), ['CU-R1']);
  assert.deepEqual(cp.excluded, []);
  assert.ok(!r.actions.some((a) => a.key === 'tracker:restore'));

  // exclude in the same answer wins over replan
  h(['record-answer', '--run', run, '--kind', 'checkpoint'], JSON.stringify({ proceed: true, exclude: ['R1'], replan: ['R1'] }));
  assert.equal(runState(run).items[0].excluded, 'excluded at checkpoint');
});

const FENCED_SUMMARY = 'Shared type:\n```ts\nexport type Widget = { id: string };\n```\nTable:\n```sql\ncreate table widgets (id text);\n```';

test('extractReport: inner ``` fences inside JSON strings, last block wins, prose-only fails', async () => {
  const { extractReport } = await import(HARNESS);
  const body = { role: 'architect', item: 'CU-P', loop: 1, verdict: 'pass', summary: 's', findings: [], files_touched: [], commits: [], plan: { summary: FENCED_SUMMARY } };
  const pretty = `Contract below.\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
  assert.equal(extractReport(pretty).report.plan.summary, FENCED_SUMMARY);
  const oneLine = `\`\`\`json\n${JSON.stringify(body)}\`\`\``;
  assert.equal(extractReport(oneLine).report.plan.summary, FENCED_SUMMARY);
  const two = `\`\`\`json\n{"n":1}\n\`\`\`\nthen\n\`\`\`json\n{"n":2}\n\`\`\``;
  assert.equal(extractReport(two).report.n, 2);
  assert.match(extractReport('Sent them the corrected ```json block, see above.').error, /no fenced/);
  assert.match(extractReport('```json\n{"a": "unterminated\n```').error, /^json parse: /);
  assert.match(extractReport('```json\n{"a": 1}\n').error, /unterminated/);
});

// Two leaves touching the same file: shadow mode spawns the architect.
function toArchitect(tag) {
  const items = [
    { id: `P${tag}`, ref: `CU-P${tag}`, title: 'Widgets', leaf: false, status_type: 'open' },
    { id: `A${tag}`, ref: `CU-A${tag}`, title: 'Widget API', body: 'a', leaf: true, parent: `P${tag}`, status_type: 'open' },
    { id: `B${tag}`, ref: `CU-B${tag}`, title: 'Widget UI', body: 'b', leaf: true, parent: `P${tag}`, status_type: 'open' },
  ];
  const run = h(['init', '--repo', repo, '--base', 'main', '--tracker', 'clickup', '--dry-run'], JSON.stringify({ items })).run_id;
  let r = h(['next', '--run', run]);
  h(['record-tracker', '--run', run, '--key', 'tracker:in_progress'], JSON.stringify({ results: [] }));
  for (const s of spawns(r)) {
    h(['record', '--run', run, '--leaf', s.leaf, '--role', 'investigator', '--agent', s.name],
      report('investigator', s.leaf, 1, 'pass', { plan: { premise_valid: true, summary: s.leaf, files: ['src/shared.ts'], acceptance_criteria: ['ok'] } }));
  }
  r = h(['next', '--run', run]);
  const arch = byRole(r, 'architect');
  assert.ok(arch, 'architect spawned');
  return { run, arch };
}
const archReport = (summary) => report('architect', 'CU-P', 1, 'pass', { plan: { summary, files: ['src/shared.ts'] } });
const failArchitect = (run, arch) => {
  const rec1 = h(['record', '--run', run, '--leaf', '__architect__', '--role', 'architect', '--agent', arch.name], 'no json');
  assert.equal(rec1.action, 'reask');
  return h(['record', '--run', run, '--leaf', '__architect__', '--role', 'architect', '--agent', arch.name],
    'Note: re-asked the architect for a corrected ```json block.');
};

test('architect invalid twice: nothing stored, retried once without asking, valid late report replaces it', () => {
  const { run, arch } = toArchitect('3');
  const failed = failArchitect(run, arch);
  assert.equal(failed.ok, false);
  assert.equal(failed.action, 'role_failed');
  assert.equal(failed.stored, 'none');
  let st = runState(run);
  assert.equal(st.contract ?? null, null, 'no contract stored');
  assert.ok(!JSON.stringify(st.items).includes('invalid report'), 'no leaf carries the error as a contract');

  // First failure: the harness retries the same agent by message, no ask.
  let r = h(['next', '--run', run]);
  assert.equal(r.phase, 'plan');
  assert.ok(!r.actions.some((a) => a.action === 'ask_user'), 'first architect failure does not ask');
  const retry = byRole(r, 'architect');
  assert.equal(retry.via, 'message');
  assert.equal(retry.name, arch.name);
  assert.match(readFileSync(retry.prompt_file, 'utf8'), /## Retry/);
  st = runState(run);
  assert.deepEqual(st.auto_gates.map((g) => [g.gate, g.decision]), [['architect_failed', 'retry']]);

  // The corrected reply answers the retry.
  const rec = h(['record', '--run', run, '--leaf', '__architect__', '--role', 'architect', '--agent', arch.name], archReport(FENCED_SUMMARY));
  assert.deepEqual([rec.ok, rec.stored], [true, 'contract']);
  assert.equal(runState(run).contract, `${FENCED_SUMMARY}\nFiles: src/shared.ts`);

  r = h(['next', '--run', run]);
  assert.equal(r.actions[0].kind, 'checkpoint');
  assert.equal(r.actions[0].payload.architect_contract, `${FENCED_SUMMARY}\nFiles: src/shared.ts`);
  assert.equal(r.actions[0].payload.architect_failed, null);

  // Nothing left to replace: a second record is an error again.
  const again = hFail(['record', '--run', run, '--leaf', '__architect__', '--role', 'architect', '--agent', arch.name], archReport('other'));
  assert.match(again.error, /no pending spawn/);
});

test('architect fails the automatic retry too: user asked; retry re-messages the same agent; proceed plans without a contract', () => {
  const { run, arch } = toArchitect('4');
  failArchitect(run, arch);
  const auto = byRole(h(['next', '--run', run]), 'architect');
  assert.equal(auto.via, 'message');
  // Second failure: now it is the user's call.
  assert.equal(failArchitect(run, auto).action, 'role_failed');
  let r = h(['next', '--run', run]);
  assert.equal(r.actions[0].kind, 'architect_failed');
  assert.match(r.actions[0].payload.error, /no fenced/);
  h(['record-answer', '--run', run, '--kind', 'architect_failed'], JSON.stringify({ choice: 'retry' }));
  r = h(['next', '--run', run]);
  const retry = byRole(r, 'architect');
  assert.equal(retry.via, 'message');
  assert.equal(retry.name, arch.name);
  assert.match(readFileSync(retry.prompt_file, 'utf8'), /## Retry/);
  // A still-invalid reply gets a fresh re-ask on the retry spawn.
  assert.equal(failArchitect(run, retry).action, 'role_failed');
  assert.equal(h(['next', '--run', run]).actions[0].kind, 'architect_failed', 'only the first failure is retried without asking');
  h(['record-answer', '--run', run, '--kind', 'architect_failed'], JSON.stringify({ choice: 'proceed' }));
  r = h(['next', '--run', run]);
  assert.equal(r.actions[0].kind, 'checkpoint');
  assert.equal(r.actions[0].payload.architect_contract, null);
  assert.match(r.actions[0].payload.architect_failed.error, /no fenced/);
  assert.match(r.actions[0].payload.review.vetoes.join(), /architect failed/);
  assert.equal(runState(run).items.find((i) => i.id === 'A4').contract ?? null, null);
  assert.equal(runState(run).auto_gates.length, 1, 'one automatic retry recorded');
});

test('investigator invalid twice: leaf excluded, not planned; valid late report brings it back', () => {
  const items = [{ id: 'I5', ref: '#51', title: 'Lone item', body: 'x', leaf: true, status_type: 'open' }];
  const run = h(['init', '--repo', repo, '--base', 'main', '--tracker', 'github', '--dry-run'], JSON.stringify({ items })).run_id;
  const inv = spawns(h(['next', '--run', run]))[0];
  h(['record-tracker', '--run', run, '--key', 'tracker:in_progress'], JSON.stringify({ results: [] }));
  const rec = (text) => h(['record', '--run', run, '--leaf', 'I5', '--role', 'investigator', '--agent', inv.name], text);
  assert.equal(rec('nope').action, 'reask');
  const failed = rec('still nope');
  assert.equal(failed.action, 'role_failed');
  let it = runState(run).items[0];
  assert.equal(it.plan, null);
  assert.equal(it.excluded, 'investigator returned an invalid report twice');
  // An invalid replacement changes nothing.
  assert.deepEqual(rec('```json\n{"role":"investigator"}\n```').replaced, false);
  const ok = rec(report('investigator', '#51', 1, 'pass', { plan: { premise_valid: true, summary: 'do it', files: ['x.ts'], acceptance_criteria: ['ok'] } }));
  assert.equal(ok.replaced, true);
  it = runState(run).items[0];
  assert.equal(it.excluded, null);
  assert.equal(it.plan.summary, 'do it');
  const r = h(['next', '--run', run]);
  assert.equal(r.phase, 'checkpoint');
  assert.deepEqual(r.actions.find((a) => a.kind === 'checkpoint').payload.leaves.map((l) => l.id), ['I5']);
});

test('team role invalid twice: replaceable until the loop decides, then refused', () => {
  const items = [{ id: 'T6', ref: '#61', title: 'Team replace', body: 'x', leaf: true, status_type: 'open' }];
  const run = h(['init', '--repo', repo, '--base', 'main', '--tracker', 'github', '--dry-run'], JSON.stringify({ items })).run_id;
  let r = h(['next', '--run', run]);
  h(['record-tracker', '--run', run, '--key', 'tracker:in_progress'], JSON.stringify({ results: [] }));
  h(['record', '--run', run, '--leaf', 'T6', '--role', 'investigator', '--agent', spawns(r)[0].name],
    report('investigator', '#61', 1, 'pass', { plan: { premise_valid: true, summary: 'fix', files: ['t.ts'], acceptance_criteria: ['ok'] } }));
  h(['next', '--run', run]);
  h(['record-answer', '--run', run, '--kind', 'checkpoint'], JSON.stringify({ proceed: true }));
  r = h(['next', '--run', run]);
  commit(join(repo, '.claude/worktrees/ds-gh-61-team-replace'), 't.ts', 'x\n');
  h(['record', '--run', run, '--leaf', 'T6', '--role', 'worker', '--agent', byRole(r, 'worker').name], report('worker', '#61', 1, 'pass'));
  r = h(['next', '--run', run]);
  const tst = byRole(r, 'tester');
  const aud = byRole(r, 'auditor');
  const recT = (text) => h(['record', '--run', run, '--leaf', 'T6', '--role', 'tester', '--agent', tst.name], text);
  assert.equal(recT('bad').action, 'reask');
  const failed = recT('bad again');
  assert.deepEqual([failed.action, failed.stored], ['role_failed', 'report']);
  // Valid late report replaces the synthesized failure before the loop decides.
  assert.equal(recT(report('tester', '#61', 1, 'pass')).replaced, true);
  const recA = (text) => h(['record', '--run', run, '--leaf', 'T6', '--role', 'auditor', '--agent', aud.name], text);
  assert.equal(recA('bad').action, 'reask');
  assert.equal(recA('bad again').action, 'role_failed');
  // Tester's replaced pass stands; the auditor's failure drives a fix loop.
  r = h(['next', '--run', run]);
  const w2 = byRole(r, 'worker');
  assert.equal(w2.loop, 2);
  assert.match(readFileSync(w2.prompt_file, 'utf8'), /auditor returned an invalid report twice/);
  assert.doesNotMatch(readFileSync(w2.prompt_file, 'utf8'), /tester returned an invalid report twice/);
  // Loop 1 is decided: the late auditor report can't rewrite it.
  const late = hFail(['record', '--run', run, '--leaf', 'T6', '--role', 'auditor', '--agent', aud.name], report('auditor', '#61', 1, 'pass'));
  assert.match(late.error, /can't be replaced: loop 1 is already decided/);
});

test('reissue while the architect is pending: next spawns it again, no contract-less plan', () => {
  const { run, arch } = toArchitect('7');
  const used = h(['next', '--run', run]).spawns_used;
  const re = h(['reissue', '--run', run]);
  assert.ok(re.cleared.includes(`spawn:${arch.name}:L1`));
  let r = h(['next', '--run', run]);
  assert.equal(r.phase, 'plan');
  const again = byRole(r, 'architect');
  assert.ok(again, `architect re-spawned, got ${JSON.stringify(r.actions.map((a) => a.kind || a.action))}`);
  assert.equal(again.name, arch.name);
  assert.equal(r.spawns_used, used, 'refund + re-spawn nets out');
  h(['record', '--run', run, '--leaf', '__architect__', '--role', 'architect', '--agent', again.name], archReport('the contract'));
  r = h(['next', '--run', run]);
  assert.equal(r.actions[0].kind, 'checkpoint');
  assert.equal(r.actions[0].payload.architect_contract, 'the contract\nFiles: src/shared.ts');
});

test('over-long report: one re-ask naming the field, then accepted with a verbose_report event', () => {
  const items = [{ id: 'V7', ref: '#71', title: 'Verbose item', body: 'x', leaf: true, status_type: 'open' }];
  const run = h(['init', '--repo', repo, '--base', 'main', '--tracker', 'github', '--dry-run'], JSON.stringify({ items })).run_id;
  const inv = spawns(h(['next', '--run', run]))[0];
  assert.match(readFileSync(inv.prompt_file, 'utf8'), /report-style\.md/);
  assert.match(readFileSync(inv.prompt_file, 'utf8'), /nothing else/);
  const plan = { premise_valid: true, summary: 'do it', files: ['x.ts'], acceptance_criteria: ['ok'] };
  const rec = (summary) => h(['record', '--run', run, '--leaf', 'V7', '--role', 'investigator', '--agent', inv.name],
    report('investigator', '#71', 1, 'pass', { summary, plan }));
  const first = rec('y'.repeat(400));
  assert.equal(first.action, 'reask');
  assert.match(first.message, /summary is 400 chars \(cap 300\)/);
  const second = rec('y'.repeat(400));
  assert.deepEqual([second.ok, second.stored], [true, 'plan'], 'length never fails a role');
  const events = readFileSync(join(stateDir, run, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.filter((e) => e.type === 'verbose_report').length, 1);
  assert.equal(events.filter((e) => e.type === 'role_failed').length, 0);
});

// ---------------------------------------------------------------- auto-decided gates
const CAL = { DO_SHIT_TEST_CALIBRATED: 'plan_needs_human_review,fix_stays_within_item_scope' };
const eventsOf = (run) => readFileSync(join(stateDir, run, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
// One clean leaf, planned; returns the first `next` after the investigator reported.
function toCheckpoint(tag, { mode = 'live', envx = {}, plan = {}, title = 'Clean item' } = {}) {
  const items = [{ id: `G${tag}`, ref: `#9${tag}`, title, body: 'x', leaf: true, acceptance_criteria: ['ok'], status_type: 'open' }];
  const run = h(['init', '--repo', repo, '--base', 'main', '--tracker', 'github', '--dry-run', '--mode', mode], JSON.stringify({ items })).run_id;
  const inv = spawns(h(['next', '--run', run]))[0];
  h(['record-tracker', '--run', run, '--key', 'tracker:in_progress'], JSON.stringify({ results: [] }));
  h(['record', '--run', run, '--leaf', `G${tag}`, '--role', 'investigator', '--agent', inv.name],
    report('investigator', `#9${tag}`, 1, 'pass', { plan: { premise_valid: true, summary: 'do it', files: [`src/g${tag}.ts`], acceptance_criteria: ['ok'], ...plan } }));
  return { run, r: h(['next', '--run', run], '', envx) };
}

test('checkpoint: live + calibrated + no veto goes straight to build, and is recorded', () => {
  const { run, r } = toCheckpoint('1', { envx: CAL, title: 'Auto checkpoint' });
  assert.equal(r.phase, 'build');
  assert.ok(!r.actions.some((a) => a.action === 'ask_user'));
  assert.ok(byRole(r, 'worker'), 'build started');
  const st = runState(run);
  assert.deepEqual(st.auto_gates.map((g) => [g.gate, g.decision]), [['checkpoint', 'proceed']]);
  assert.equal(eventsOf(run).filter((e) => e.type === 'auto_gate').length, 1);
});

test('checkpoint: an uncalibrated question never decides, even live; the would-be decision is logged', () => {
  const { run, r } = toCheckpoint('2', { title: 'Uncalibrated checkpoint' });
  const cp = r.actions.find((a) => a.kind === 'checkpoint');
  assert.ok(cp, 'still asks');
  assert.equal(cp.payload.review.would_auto_proceed, true);
  assert.match(cp.payload.review.not_auto_because, /not calibrated/);
  assert.equal(runState(run).auto_gates ?? null, null);
  assert.equal(eventsOf(run).filter((e) => e.type === 'shadow_gate' && e.gate === 'checkpoint').length, 1);
});

test('checkpoint: shadow mode asks and logs; a veto asks without consulting Jev', () => {
  const shadow = toCheckpoint('3', { mode: 'shadow', envx: CAL, title: 'Shadow checkpoint' });
  const cp = shadow.r.actions.find((a) => a.kind === 'checkpoint');
  assert.match(cp.payload.review.not_auto_because, /mode shadow/);
  assert.equal(eventsOf(shadow.run).filter((e) => e.type === 'shadow_gate').length, 1);

  const veto = toCheckpoint('4', { envx: CAL, plan: { open_questions: ['which table?'] }, title: 'Veto checkpoint' });
  const cp2 = veto.r.actions.find((a) => a.kind === 'checkpoint');
  assert.match(cp2.payload.review.vetoes.join(), /open questions/);
  assert.equal(cp2.payload.review.would_auto_proceed, false);
  assert.equal(eventsOf(veto.run).filter((e) => e.type === 'jev' && e.kind === 'plan_review').length, 0);
});

test('checkpoint: once a human answered one, later checkpoints in the run ask too', () => {
  const { run, r } = toCheckpoint('5', { title: 'Replan checkpoint' });
  assert.ok(r.actions.find((a) => a.kind === 'checkpoint'));
  h(['record-answer', '--run', run, '--kind', 'checkpoint'], JSON.stringify({ proceed: true, replan: ['G5'], notes: { G5: 'smaller' } }));
  const inv = spawns(h(['next', '--run', run], '', CAL))[0];
  h(['record', '--run', run, '--leaf', 'G5', '--role', 'investigator', '--agent', inv.name],
    report('investigator', '#95', 1, 'pass', { plan: { premise_valid: true, summary: 'smaller', files: ['src/g5.ts'], acceptance_criteria: ['ok'] } }));
  const again = h(['next', '--run', run], '', CAL).actions.find((a) => a.kind === 'checkpoint');
  assert.ok(again, 'asks again');
  assert.match(again.payload.review.vetoes.join(), /human already answered/);
});

// One leaf driven to an approved merge plan. Every harness call gets `envx`.
function toMerge(tag, { mode = 'shadow', envx = {} } = {}) {
  const hx = (args, stdin = '') => h(args, stdin, envx);
  const ref = `#8${tag}`;
  const items = [{ id: `M${tag}`, ref, title: `Merge case ${tag}`, body: 'x', leaf: true, acceptance_criteria: ['ok'], status_type: 'open' }];
  const run = hx(['init', '--repo', repo, '--base', 'main', '--tracker', 'github', '--dry-run', '--mode', mode], JSON.stringify({ items })).run_id;
  let r = hx(['next', '--run', run]);
  hx(['record-tracker', '--run', run, '--key', 'tracker:in_progress'], JSON.stringify({ results: [] }));
  hx(['record', '--run', run, '--leaf', `M${tag}`, '--role', 'investigator', '--agent', spawns(r)[0].name],
    report('investigator', ref, 1, 'pass', { plan: { premise_valid: true, summary: 'fix', files: [`m${tag}.ts`], acceptance_criteria: ['ok'] } }));
  r = hx(['next', '--run', run]);
  const asked = { checkpoint: Boolean(r.actions.find((a) => a.kind === 'checkpoint')) };
  if (asked.checkpoint) {
    hx(['record-answer', '--run', run, '--kind', 'checkpoint'], JSON.stringify({ proceed: true }));
    r = hx(['next', '--run', run]);
  }
  const wt = join(repo, `.claude/worktrees/ds-gh-8${tag}-merge-case-${tag}`);
  commit(wt, `m${tag}.ts`, 'x\n');
  hx(['record', '--run', run, '--leaf', `M${tag}`, '--role', 'worker', '--agent', byRole(r, 'worker').name], report('worker', ref, 1, 'pass'));
  r = hx(['next', '--run', run]);
  for (const s of spawns(r)) hx(['record', '--run', run, '--leaf', `M${tag}`, '--role', s.role, '--agent', s.name], report(s.role, ref, 1, 'pass'));
  r = hx(['next', '--run', run]);
  const pr = r.actions.find((a) => a.action === 'pr');
  const number = 800 + Number(tag);
  hx(['record-pr', '--run', run, '--leaf', `M${tag}`, '--number', String(number), '--url', 'u']);
  r = hx(['next', '--run', run]);
  hx(['record-tracker', '--run', run, '--key', r.actions[0].key], JSON.stringify({ results: [] }));
  const approval = hx(['next', '--run', run]).actions[0];
  return { run, pr, number, ref, leaf: `M${tag}`, hx, asked, approval };
}
const facts = (o = {}) => ({ state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', ci: 'green', failed: [], comments: [], files: [], ...o });
const withConfig = (config, fn) => {
  const dir = join(repo, '.claude');
  execFileSync('mkdir', ['-p', dir]);
  writeFileSync(join(dir, 'do-shit.json'), JSON.stringify(config));
  try {
    return fn();
  } finally {
    execFileSync('rm', ['-f', join(dir, 'do-shit.json')]);
  }
};

test('merge_approval and qa_approval always ask, even live with every question calibrated', () => {
  const m = toMerge('1', { mode: 'live', envx: CAL });
  assert.equal(m.asked.checkpoint, false, 'checkpoint was auto-passed');
  assert.equal(m.approval.kind, 'merge_approval');
  assert.deepEqual(m.approval.payload.auto_gates.map((g) => g.gate), ['checkpoint'], 'auto decisions shown before merging');
  m.hx(['record-answer', '--run', m.run, '--kind', 'merge_approval'], JSON.stringify({ merge: 'all_green' }));
  writeFileSync(ghStub, JSON.stringify({ [m.number]: facts() }));
  assert.equal(m.hx(['next', '--run', m.run]).actions[0].action, 'merge');
  m.hx(['record-merge', '--run', m.run, '--pr', String(m.number), '--result', 'merged']);
  let r = m.hx(['next', '--run', m.run]);
  m.hx(['record-tracker', '--run', m.run, '--key', r.actions[0].key], JSON.stringify({ results: [] }));
  r = m.hx(['next', '--run', m.run]);
  assert.equal(r.actions[0].kind, 'qa_approval');
  m.hx(['record-answer', '--run', m.run, '--kind', 'qa_approval'], JSON.stringify({ qa: false }));
  r = m.hx(['next', '--run', m.run]);
  m.hx(['record-tracker', '--run', m.run, '--key', r.actions[0].key], JSON.stringify({ results: [] }));
  const done = m.hx(['next', '--run', m.run]).actions[0];
  assert.equal(done.action, 'done');
  assert.deepEqual(done.report.auto_gates.map((g) => [g.gate, g.decision]), [['checkpoint', 'proceed']]);
});

test('ci_pending: waits without asking, logs one gate, then skips the PR after ci_wait_minutes', () => {
  const m = toMerge('2');
  m.hx(['record-answer', '--run', m.run, '--kind', 'merge_approval'], JSON.stringify({ merge: 'all_green' }));
  writeFileSync(ghStub, JSON.stringify({ [m.number]: facts({ ci: 'pending' }) }));
  let r = m.hx(['next', '--run', m.run]);
  assert.deepEqual([r.actions[0].action, r.actions[0].prs, r.actions[0].seconds], ['wait_ci', [m.number], 120]);
  assert.equal(m.hx(['next', '--run', m.run]).actions[0].action, 'wait', 'nothing re-checked until the wait is recorded');
  m.hx(['record-tracker', '--run', m.run, '--key', 'ci_wait'], JSON.stringify({ results: [] }));
  r = m.hx(['next', '--run', m.run]);
  assert.equal(r.actions[0].action, 'wait_ci', 'still pending: waits again');
  assert.equal(runState(m.run).auto_gates.filter((g) => g.gate === 'ci_pending').length, 1, 'logged once per PR');
  m.hx(['record-tracker', '--run', m.run, '--key', 'ci_wait'], JSON.stringify({ results: [] }));
  // Window over: the PR is skipped and reported, not merged.
  withConfig({ ci_wait_minutes: 0 }, () => {
    r = m.hx(['next', '--run', m.run]);
  });
  const done = r.actions.find((a) => a.action === 'done');
  assert.ok(done, `run finishes, got ${JSON.stringify(r.actions.map((a) => a.kind || a.action))}`);
  assert.deepEqual(done.report.merge, [{ pr: m.number, state: 'skipped', reason: 'CI still pending after 0 min', fixes: 0 }]);
  assert.deepEqual(done.report.auto_gates.filter((g) => g.gate === 'ci_pending').map((g) => g.decision), ['continue', 'skip']);
});

test('ci_pending: autonomy off asks as before', () => {
  const m = toMerge('3');
  m.hx(['record-answer', '--run', m.run, '--kind', 'merge_approval'], JSON.stringify({ merge: 'all_green' }));
  writeFileSync(ghStub, JSON.stringify({ [m.number]: facts({ ci: 'pending' }) }));
  withConfig({ autonomy: 'off' }, () => {
    const r = m.hx(['next', '--run', m.run]);
    assert.equal(r.actions[0].kind, 'ci_pending');
  });
});

// CI red on an approved PR -> worker + tester fix team -> push.
function fixAndPush(m, { fixFile }) {
  m.hx(['record-answer', '--run', m.run, '--kind', 'merge_approval'], JSON.stringify({ merge: 'all_green' }));
  writeFileSync(ghStub, JSON.stringify({ [m.number]: facts({ ci: 'red', failed: [{ name: 'unit' }], headRefName: m.pr.branch }) }));
  let r = m.hx(['next', '--run', m.run]);
  const worker = byRole(r, 'worker');
  assert.ok(worker, `fix team worker, got ${JSON.stringify(r.actions.map((a) => a.kind || a.action))}`);
  commit(join(repo, `.claude/worktrees/ds-fix-${m.number}`), fixFile, 'fixed\n');
  m.hx(['record', '--run', m.run, '--leaf', m.leaf, '--role', 'worker', '--agent', worker.name], report('worker', m.ref, 1, 'pass'));
  r = m.hx(['next', '--run', m.run]);
  m.hx(['record', '--run', m.run, '--leaf', m.leaf, '--role', 'tester', '--agent', byRole(r, 'tester').name], report('tester', m.ref, 1, 'pass'));
  r = m.hx(['next', '--run', m.run]);
  assert.ok(r.actions.find((a) => a.action === 'push'));
  return m.hx(['record-push', '--run', m.run, '--leaf', m.leaf, '--pr', String(m.number)]);
}

test('reapproval: live + calibrated + fix inside the plan is approved without asking', () => {
  writeFileSync(jevStub, JSON.stringify({ 'needs_*': 0.1, fix_stays_within_item_scope: 0.9 }));
  try {
    const m = toMerge('4', { mode: 'live', envx: CAL });
    assert.equal(fixAndPush(m, { fixFile: 'm4.ts' }).state, 'queued');
    const gates = runState(m.run).auto_gates.map((g) => [g.gate, g.decision]);
    assert.deepEqual(gates, [['checkpoint', 'proceed'], ['reapproval', 'approve']]);
    writeFileSync(ghStub, JSON.stringify({ [m.number]: facts() }));
    assert.equal(m.hx(['next', '--run', m.run]).actions[0].action, 'merge');
  } finally {
    writeFileSync(jevStub, JSON.stringify({ 'needs_*': 0.1 }));
  }
});

test('reapproval: a fix outside the plan asks, with the veto in the payload; uncalibrated asks and logs', () => {
  writeFileSync(jevStub, JSON.stringify({ 'needs_*': 0.1, fix_stays_within_item_scope: 0.9 }));
  try {
    const out = toMerge('5', { mode: 'live', envx: CAL });
    assert.equal(fixAndPush(out, { fixFile: 'unrelated.ts' }).state, 'needs_reapproval');
    const ask = out.hx(['next', '--run', out.run]).actions[0];
    assert.equal(ask.kind, 'reapproval');
    assert.match(ask.payload.review.vetoes.join(), /outside the plan: unrelated\.ts/);

    const uncal = toMerge('6', { mode: 'live' });
    assert.equal(fixAndPush(uncal, { fixFile: 'm6.ts' }).state, 'needs_reapproval');
    const ask2 = uncal.hx(['next', '--run', uncal.run]).actions[0];
    assert.equal(ask2.payload.review.would_auto_approve, true);
    assert.match(ask2.payload.review.not_auto_because, /not calibrated/);
    assert.equal(eventsOf(uncal.run).filter((e) => e.type === 'shadow_gate' && e.gate === 'reapproval').length, 1);
    // The same gate is a calibration case, and the user's answer is its right answer.
    const kase = eventsOf(uncal.run).find((e) => e.type === 'case' && e.question === 'fix_stays_within_item_scope');
    assert.deepEqual([kase.p, kase.acts_when, kase.unsafe, kase.acted, kase.case], [0.9, 'gte', 'fp', false, `${uncal.run}/reapproval/${uncal.number}/${kase.case.split('/').pop()}`]);
    assert.match(kase.show, /PR #806 Merge case 6\. Fix/);
    uncal.hx(['record-answer', '--run', uncal.run, '--kind', 'reapproval'], JSON.stringify({ pr: uncal.number, approve: true }));
    const label = eventsOf(uncal.run).find((e) => e.type === 'label' && e.question === 'fix_stays_within_item_scope');
    assert.deepEqual([label.question, label.case, label.label, label.source], ['fix_stays_within_item_scope', kase.case, true, 'gate']);
    assert.deepEqual(runState(uncal.run).pending_cases, {});
  } finally {
    writeFileSync(jevStub, JSON.stringify({ 'needs_*': 0.1 }));
  }
});

// ---------------------------------------------------------------- calibration
const setCalibration = (questions) => {
  execFileSync('mkdir', ['-p', calDir]);
  writeFileSync(join(calDir, 'calibration.json'), JSON.stringify({ v: 1, questions }));
};
const clearCalibration = () => execFileSync('rm', ['-rf', calDir]);

test('checkpoint: logged as a case; proceeding untouched labels it "no review needed", a change labels it "needed"', () => {
  const calm = toCheckpoint('6', { mode: 'shadow', title: 'Calm plan' });
  const kase = eventsOf(calm.run).find((e) => e.type === 'case');
  assert.deepEqual([kase.skill, kase.question, kase.case, kase.acts_when, kase.unsafe, kase.acted, kase.v], ['do-shit', 'plan_needs_human_review', `${calm.run}/checkpoint/1`, 'lt', 'fn', false, 1]);
  assert.match(kase.show, /1 item\(s\): #96 Calm plan\. Plan: do it/);
  assert.deepEqual(runState(calm.run).pending_cases.checkpoint.case, kase.case);
  h(['record-answer', '--run', calm.run, '--kind', 'checkpoint'], JSON.stringify({ proceed: true, exclude: [], notes: {}, replan: [] }));
  assert.deepEqual(eventsOf(calm.run).filter((e) => e.type === 'label').map((l) => [l.case, l.label, l.source]), [[kase.case, false, 'gate']]);

  const noted = toCheckpoint('7', { mode: 'shadow', title: 'Noted plan' });
  h(['record-answer', '--run', noted.run, '--kind', 'checkpoint'], JSON.stringify({ proceed: true, notes: { G7: 'use the existing table' } }));
  assert.equal(eventsOf(noted.run).find((e) => e.type === 'label').label, true);

  const vetoed = toCheckpoint('8', { mode: 'shadow', plan: { open_questions: ['which table?'] }, title: 'Vetoed plan' });
  assert.equal(eventsOf(vetoed.run).filter((e) => e.type === 'case').length, 0, 'a vetoed gate never reaches Jev: no case');
  h(['record-answer', '--run', vetoed.run, '--kind', 'checkpoint'], JSON.stringify({ proceed: true }));
  assert.equal(eventsOf(vetoed.run).filter((e) => e.type === 'label').length, 0);
});

test('checkpoint: an entry written by /calibrate lets it pass in live, unless that run is the spot check', () => {
  try {
    setCalibration({ 'do-shit/plan_needs_human_review': { threshold: 0.3, n: 30 } });
    const { run, r } = toCheckpoint('9', { title: 'Locally calibrated' });
    const kase = eventsOf(run).find((e) => e.type === 'case');
    const cp = r.actions.find((a) => a.kind === 'checkpoint');
    if (kase.spot) {
      assert.match(cp.payload.review.not_auto_because, /spot check/);
      assert.equal(kase.acted, false);
    } else {
      assert.equal(r.phase, 'build');
      assert.deepEqual([kase.acted, cp], [true, undefined]);
      assert.deepEqual(runState(run).pending_cases, {}, 'nobody was asked: nothing waits for a label');
    }
    // The threshold in the file is the one used: the stub answers 0.1, so 0.05 asks.
    setCalibration({ 'do-shit/plan_needs_human_review': { threshold: 0.05, n: 30 } });
    const strict = toCheckpoint('0', { title: 'Strict threshold' });
    assert.equal(strict.r.actions.find((a) => a.kind === 'checkpoint').payload.review.would_auto_proceed, false);
    // Shadow never acts on it, and the off switch ignores the file.
    setCalibration({ 'do-shit/plan_needs_human_review': { threshold: 0.3, n: 30 } });
    assert.match(toCheckpoint('a', { mode: 'shadow', title: 'Shadow local' }).r.actions.find((a) => a.kind === 'checkpoint').payload.review.not_auto_because, /mode shadow/);
    assert.match(toCheckpoint('b', { envx: { REAL_SKILLS_CALIBRATION: 'off' }, title: 'Switched off' }).r.actions.find((a) => a.kind === 'checkpoint').payload.review.not_auto_because, /not calibrated/);
  } finally {
    clearCalibration();
  }
});

test('nothing in the calibration file can make merge_approval or qa_approval automatic', () => {
  try {
    const on = { threshold: 0.5, n: 999 };
    setCalibration(Object.fromEntries(['merge_approval', 'qa_approval', 'checkpoint', 'reapproval', 'ci_pending', 'offers', 'plan_needs_human_review', 'fix_stays_within_item_scope', 'plan_is_wrong', 'needs_role']
      .flatMap((q) => [[`do-shit/${q}`, on], [q, on]])));
    const m = toMerge('7', { mode: 'live' });
    assert.equal(m.approval.kind, 'merge_approval');
    assert.equal(m.approval.action, 'ask_user');
    m.hx(['record-answer', '--run', m.run, '--kind', 'merge_approval'], JSON.stringify({ merge: 'all_green' }));
    writeFileSync(ghStub, JSON.stringify({ [m.number]: facts() }));
    assert.equal(m.hx(['next', '--run', m.run]).actions[0].action, 'merge');
    m.hx(['record-merge', '--run', m.run, '--pr', String(m.number), '--result', 'merged']);
    let r = m.hx(['next', '--run', m.run]);
    m.hx(['record-tracker', '--run', m.run, '--key', r.actions[0].key], JSON.stringify({ results: [] }));
    r = m.hx(['next', '--run', m.run]);
    assert.deepEqual([r.actions[0].action, r.actions[0].kind], ['ask_user', 'qa_approval']);
  } finally {
    clearCalibration();
  }
});
