import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp, git, write, commit, sha, mergePr, setConfig, STAGES, green, prStub } from './fixture.mjs';

const root = mkdtempSync(join(tmpdir(), 'pro-state-'));
process.env.PROMOTE_STATE_DIR = join(root, 'promote');
process.env.CHECK_INFRA_STATE_DIR = join(root, 'check');
process.env.CHECK_INFRA_JEV = 'off';
// Never this machine's real calibration file.
process.env.REAL_SKILLS_CALIBRATION_DIR = join(root, 'calibration');
delete process.env.REAL_SKILLS_CALIBRATION;
delete process.env.PROMOTE_TEST_CALIBRATED;
delete process.env.PROMOTE_CHECK_HARNESS;
process.env.PROMOTE_JEV = 'off';
process.env.PROMOTE_POLL_MS = '20';

const H = await import('../promote.mjs');
const { RESULTS } = H;
const S = await import('../lib/state.mjs');
const C = await import('../lib/calibration.mjs');
const G = await import('../lib/gates.mjs');
const GH = await import('../lib/github.mjs');
const { loadConfig, commandRefusal, isProduction } = await import('../lib/config.mjs');
const CHECK = await import('../../../check-infra-and-migrations/scripts/check.mjs');

// Point both harnesses at one app's `gh` answers.
function use(app) {
  process.env.PROMOTE_GH_STUB = app.stubFile;
  const checkStub = join(app.tmp, 'check-gh.json');
  if (!existsSync(checkStub)) writeFileSync(checkStub, JSON.stringify({ slug: 'acme/app', prs: {}, open_into: {}, current_pr: null }));
  process.env.CHECK_INFRA_GH_STUB = checkStub;
  return app;
}
const go = (app, ...args) => H.start({ repo: app.repo, args });
// The flow: the brief is shown, then the user says yes.
function openIt(run) {
  H.brief({ run });
  return H.open({ run, confirmed: true });
}
const calls = (app) => (existsSync(`${app.stubFile}.calls.jsonl`) ? readFileSync(`${app.stubFile}.calls.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const status = (r) => Object.fromEntries(Object.entries(r.gates).map(([k, v]) => [k, v.status]));
// An app whose source is green, ready to promote.
function ready(prefix, opts) {
  const app = use(makeApp(prefix, opts));
  app.main = sha(app.repo, 'main');
  app.prod = sha(app.repo, 'production');
  app.setStub(green(app.main));
  return app;
}

// ---------------------------------------------------------------- config
test('config: the example loads; a half-right stage list is refused with the key and the reason', () => {
  const app = makeApp('pro-cfg-');
  const set = (v) => setConfig(app.repo, 'promote.json', v);
  const l = loadConfig(app.repo);
  assert.equal(l.needs_setup, false);
  assert.deepEqual(l.config.stages.map((s) => s.env), ['staging', 'production']);
  assert.equal(isProduction(l.config, l.config.stages[1]), true);
  assert.equal(isProduction(l.config, l.config.stages[0]), false);
  const bad = [
    [{ stages: [] }, /non-empty list/],
    [{ stages: [{ env: 'a', branch: 'main', how: 'teleport' }] }, /how must be one of push, pr, manual/],
    [{ stages: [{ env: 'a', branch: 'main', how: 'pr' }] }, /from must name another stage/],
    [{ stages: [{ env: 'a', branch: 'main', how: 'pr', from: 'a' }] }, /names its own stage/],
    [{ stages: [{ env: 'a', branch: 'main', how: 'push' }, { env: 'a', branch: 'x', how: 'push' }] }, /listed twice/],
    [{ stages: [{ env: 'a', branch: 'main', how: 'push' }, { env: 'b', branch: 'main', how: 'pr', from: 'a' }] }, /feeds two environments/],
    [{ stages: [{ env: 'a', branch: '--upload-pack=x', how: 'push' }] }, /must be a branch name/],
    [{ stages: [{ env: 'a', branch: 'm', how: 'pr', from: 'b' }, { env: 'b', branch: 'p', how: 'pr', from: 'a' }] }, /loops/],
    [{ stages: [{ env: 'a', branch: 'main', how: 'push', merge_method: 'force' }] }, /merge_method must be one of/],
    [{ stages: [{ env: 'a', branch: 'main', how: 'push', admin: true }] }, /unknown key "admin"/],
    [{ stages: [{ env: 'edge', how: 'manual' }, { env: 'b', branch: 'p', how: 'pr', from: 'edge' }] }, /has no branch to promote from/],
    [{ stages: STAGES, verify: { nowhere: { health: 'https://x.example.com' } } }, /verify\.nowhere names no stage/],
    [{ stages: STAGES, verify: { production: { health: 'ftp://x' } } }, /must be an http\(s\) URL/],
    [{ stages: STAGES, verify: { production: { deployed: 'aws ecs update-service --cluster c' } } }, /deployed contains "update"/],
    [{ stages: STAGES, verify: { production: { deploy: 'x' } } }, /unknown key "deploy"/],
  ];
  for (const [value, why] of bad) {
    set(value);
    assert.throws(() => loadConfig(app.repo), why, JSON.stringify(value));
  }
  assert.equal(commandRefusal('aws ecs describe-services --cluster main --services web'), null);
  assert.match(commandRefusal('vercel promote x'), /contains "promote"/);
  // The shared keys come from the other skills' files, never copied.
  set({ stages: [{ env: 'staging', branch: 'main', how: 'push' }, { env: 'live', branch: 'production', how: 'pr', from: 'staging' }] });
  setConfig(app.repo, 'wtf.json', { release: { production_branch: 'production' }, environments: [{ name: 'staging', kind: 'staging', base_url: 'https://staging.example.com' }], production_hosts: ['app.example.com'] });
  const shared = loadConfig(app.repo);
  assert.equal(shared.sources.release, '.claude/wtf.json');
  assert.equal(isProduction(shared.config, shared.config.stages[1]), true, 'the branch that release.production_branch names');
  // A manual stage needs no branch, and "false" is not believed against a name that says production.
  set({ stages: [{ env: 'staging', branch: 'main', how: 'push' }, { env: 'production', how: 'manual', command: 'vercel promote', production: false }] });
  assert.equal(isProduction(loadConfig(app.repo).config, loadConfig(app.repo).config.stages[1]), true);
});

// ---------------------------------------------------------------- start: which stage
test('start: no config asks for setup and promotes nothing on a guess', async () => {
  const app = use(makeApp('pro-nocfg-', { config: false }));
  const r = await go(app);
  assert.deepEqual(r.needs, ['setup']);
  assert.equal(r.run_id, undefined);
  assert.deepEqual((await go(app, 'setup')).needs_setup, true);
});

test('start: the stage is named or the only one; never picked among several', async () => {
  const app = ready('pro-stage-');
  assert.equal((await go(app)).stage, 'production');
  const push = await go(app, 'staging');
  assert.equal(push.how, 'push');
  assert.match(push.says, /every merge into main deploys it/);
  assert.equal(push.run_id, undefined);
  await assert.rejects(go(app, 'moon'), /no stage is called "moon"/);
  await assert.rejects(go(app, '--force'), /unknown flag --force/);
  await assert.rejects(go(app, 'production', 'staging'), /one environment per run/);

  git(app.repo, 'branch', 'uat', 'production');
  setConfig(app.repo, 'promote.json', { stages: [STAGES[0], { env: 'uat', branch: 'uat', how: 'pr', from: 'staging' }, { env: 'production', branch: 'production', how: 'pr', from: 'uat' }, { env: 'edge', how: 'manual', command: 'vercel promote', from: 'production' }] });
  const many = await go(app);
  assert.deepEqual(many.needs, ['input']);
  assert.deepEqual(many.candidates, [{ env: 'uat', from: 'staging', production: false }, { env: 'production', from: 'uat', production: true }]);
  const manual = await go(app, 'edge');
  assert.deepEqual([manual.how, manual.command, manual.run_id], ['manual', 'vercel promote', undefined]);
  assert.equal((await go(app, 'uat')).source.branch, 'main');
});

test('start: nothing to promote is an answer, not a run', async () => {
  const app = ready('pro-empty-');
  git(app.repo, 'branch', '-f', 'production', 'main');
  const r = await go(app);
  assert.equal(r.result, 'nothing_to_promote');
  assert.equal(r.run_id, undefined);
  assert.match(r.says, /production already has everything staging has/);
});

// ---------------------------------------------------------------- the whole way
test('a clean promotion: gates, brief, two separate yeses, a merge pinned to the commit, watch, verify', async () => {
  const app = ready('pro-happy-');
  const r = await go(app);
  assert.equal(r.production, true);
  assert.deepEqual([r.source, r.target], [{ env: 'staging', branch: 'main', sha: app.main.slice(0, 7) }, { env: 'production', branch: 'production', sha: app.prod.slice(0, 7) }]);
  assert.deepEqual(r.prs, [{ number: 12, title: 'Fix a typo' }, { number: 11, title: 'Add a settings page' }]);
  assert.equal(r.commits, 3);
  assert.deepEqual(status(r), { range: 'pass', merges_cleanly: 'pass', open_pr: 'pass', source_checks: 'pass', source_deployed: 'pass', infra_check: 'pass' });
  assert.deepEqual(r.infra, { state: 'recorded', verdict: 'nothing_to_check' });
  assert.equal(r.can_open, true);
  assert.match(r.next, /call brief/);

  const b = H.brief({ run: r.run_id });
  assert.equal(b.title, 'Promote staging to production');
  assert.match(b.body, /Promotes `main` \(`[0-9a-f]{7}`\) to `production` \(`[0-9a-f]{7}`\): 3 commits, 2 pull requests\. \*\*Merging this deploys to production\.\*\*/);
  assert.match(b.body, /- #12 Fix a typo\n- #11 Add a settings page/);
  assert.match(b.body, /no migration or infrastructure change in this range/);
  assert.match(b.ask, /Open the pull request main → production\? Merging it later deploys to production\./);

  // Yes #1.
  assert.match(H.open({ run: r.run_id }).refused, /needs the user's yes/);
  // What is sent is what was shown: a run whose brief was never shown, or changed since, opens nothing.
  const unseen = await go(app);
  assert.match(H.open({ run: unseen.run_id, confirmed: true }).refused, /the brief was never shown/);
  H.brief({ run: unseen.run_id });
  const edited = S.loadRun(unseen.run_id);
  edited.prs = [{ number: 99, title: 'Slipped in' }];
  S.saveRun(edited);
  assert.match(H.open({ run: unseen.run_id, confirmed: true }).refused, /something changed since the brief was shown/);
  assert.equal(calls(app).length, 0);
  app.patchStub({ create: { number: 7 }, prs: { 7: prStub(7, app.main) } });
  const o = openIt(r.run_id);
  assert.deepEqual([o.ok, o.opened, o.pr.number], [true, true, 7]);
  const [created] = calls(app);
  assert.deepEqual([created.call, created.base, created.head, created.title], ['create', 'production', 'main', 'Promote staging to production']);
  assert.equal(created.body, b.body);
  // Asking again opens nothing new.
  app.patchStub({ open_prs: { production: [prStub(7, app.main)] } });
  assert.deepEqual([openIt(r.run_id).reused, calls(app).length], [true, 1]);

  // Yes #2 is its own question.
  const rd = H.ready({ run: r.run_id });
  assert.equal(rd.allowed, true);
  assert.match(rd.ask, /Merge #7 \(main → production, merge\) at [0-9a-f]{7}\? This deploys to production\./);
  assert.match(H.merge({ run: r.run_id }).refused, /needs its own yes/);
  app.patchStub({ merge: { sha: 'f'.repeat(40) } });
  const m = H.merge({ run: r.run_id, confirmed: true });
  assert.deepEqual([m.ok, m.merged, m.merge_sha], [true, true, 'fffffff']);
  const merged = calls(app).at(-1);
  assert.deepEqual(merged, { call: 'merge', args: ['pr', 'merge', '7', '--merge', '--match-head-commit', app.main] });
  assert.match(H.merge({ run: r.run_id, confirmed: true }).refused, /already merged by this run/);
  assert.equal(calls(app).filter((c) => c.call === 'merge').length, 1);

  // Nothing has reported yet: pending, never green.
  let w = await H.watch({ run: r.run_id });
  assert.deepEqual([w.state, w.result], ['deploy_pending', 'deploy_pending']);
  const mergeSha = 'f'.repeat(40);
  app.patchStub({ runs: { [mergeSha]: [{ id: 9, name: 'Deploy production', path: '.github/workflows/deploy-production.yml', status: 'in_progress', conclusion: null }, { id: 10, name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'failure' }] } });
  w = await H.watch({ run: r.run_id });
  assert.equal(w.state, 'deploy_pending', 'only the configured deploy workflow decides');
  app.patchStub({ runs: { [mergeSha]: [{ id: 9, name: 'Deploy production', path: '.github/workflows/deploy-production.yml', status: 'completed', conclusion: 'success' }] } });
  w = await H.watch({ run: r.run_id });
  assert.deepEqual([w.state, w.result], ['deploy_green', 'promoted_unverified']);
  assert.match(w.next, /not yet "deployed"/);

  // Green on GitHub is not "deployed": without a read of what runs, the result says so.
  let v = await H.verify({ run: r.run_id });
  assert.equal(v.result, 'promoted_unverified');
  assert.match(v.says, /what production is running was not checked \(no verify\.deployed command is configured\)/);

  setConfig(app.repo, 'promote.json', { stages: STAGES, verify: { production: { deployed: `printf 'web %s\\n' ${app.main.slice(0, 12)}` } } });
  v = await H.verify({ run: r.run_id });
  assert.equal(v.result, 'promoted_unverified');
  assert.deepEqual([v.ask.production, v.ask.env], [true, 'production']);
  assert.match(v.ask.says, /it reads production/);
  v = await H.verify({ run: r.run_id, confirmed: true });
  assert.deepEqual([v.result, v.serving.state], ['promoted_verified', 'yes']);
  assert.ok(!JSON.stringify(v).includes(app.main.slice(0, 12)), 'the command output stays in the run folder');
  assert.match(readFileSync(join(S.runDir(r.run_id), 'deployed.txt'), 'utf8'), /^web /);

  setConfig(app.repo, 'promote.json', { stages: STAGES, verify: { production: { deployed: "printf 'web 0123456789ab\\n'" } } });
  // The command changed after the question: the earlier yes does not cover it.
  v = await H.verify({ run: r.run_id, confirmed: true });
  assert.equal(v.serving, null);
  assert.match(v.ask.says, /not the one that was shown before/);
  v = await H.verify({ run: r.run_id, confirmed: true });
  assert.deepEqual([v.result, v.serving.state], ['not_serving', 'no']);
  assert.match(v.next, /Do not roll anything back yourself/);
  // A list of releases names the promoted commit and proves nothing about what runs now.
  setConfig(app.repo, 'promote.json', { stages: STAGES, verify: { production: { deployed: `printf 'v3 0123456789ab\\nv2 %s\\n' ${app.main.slice(0, 12)}` } } });
  await H.verify({ run: r.run_id });
  v = await H.verify({ run: r.run_id, confirmed: true });
  assert.deepEqual([v.result, v.serving.state], ['promoted_unverified', 'unknown']);
  assert.match(v.serving.note, /must print only what is running now/);
  // A short string that merely contains seven characters of the commit is not the commit.
  setConfig(app.repo, 'promote.json', { stages: STAGES, verify: { production: { deployed: `printf 'x%sz\\n' ${app.main.slice(0, 7)}` } } });
  await H.verify({ run: r.run_id });
  assert.equal((await H.verify({ run: r.run_id, confirmed: true })).serving.state, 'unknown');
  // Output with no commit id in it settles nothing either way.
  setConfig(app.repo, 'promote.json', { stages: STAGES, verify: { production: { deployed: "printf 'web build 20261009 ok\\n'" } } });
  await H.verify({ run: r.run_id });
  v = await H.verify({ run: r.run_id, confirmed: true });
  assert.deepEqual([v.result, v.serving.state], ['promoted_unverified', 'unknown']);

  const log = readFileSync(join(process.env.PROMOTE_STATE_DIR, 'log.jsonl'), 'utf8');
  assert.ok(!/Fix a typo|settings page/.test(log), 'the log holds counts and results, never PR text');
  assert.equal((await go(app, 'watch')).run_id, r.run_id);
});

// ---------------------------------------------------------------- gates
test('source gates: a failed check blocks, a running one waits, silence is unknown and never a pass', async () => {
  const app = ready('pro-src-');
  const first = (await go(app)).run_id;
  app.setStub({ ...green(app.main), checks: { [app.main]: [{ name: 'test', status: 'completed', conclusion: 'failure' }, { context: 'ci/legacy', state: 'success' }] } });
  let r = await go(app);
  assert.equal(r.gates.source_checks.status, 'block');
  assert.match(r.gates.source_checks.says, /1 check failed on [0-9a-f]{7}: test/);
  assert.equal(r.can_open, false);
  assert.match(openIt(r.run_id).refused, /a gate does not pass/);
  // A run that started green is checked again at the moment of opening.
  const late = openIt(first);
  assert.deepEqual([late.ok, late.gates.length], [false, 1]);
  assert.match(late.gates[0], /^source_checks: 1 check failed/);

  app.setStub({ ...green(app.main), checks: { [app.main]: [{ name: 'e2e', status: 'in_progress', conclusion: null }] } });
  r = await go(app);
  assert.deepEqual([r.gates.source_checks.status, r.can_open], ['wait', false]);
  assert.match(r.next, /still running/);

  app.setStub({ runs: green(app.main).runs });
  r = await go(app);
  assert.equal(r.gates.source_checks.status, 'unknown');
  assert.deepEqual(r.unknown.map((u) => u.gate), ['source_checks']);
  assert.equal(r.can_open, true, 'unknown is said plainly; it is neither a pass nor a block');
  assert.equal(calls(app).length, 0);
});

test('source_deployed: the exact commit must have run on the source environment', async () => {
  const app = ready('pro-dep-');
  const { checks } = green(app.main);
  app.setStub({ checks });
  let r = await go(app);
  assert.equal(r.gates.source_deployed.status, 'block');
  assert.match(r.gates.source_deployed.says, /deploy\.yml has no run for [0-9a-f]{7}: what would be promoted is not what staging ran/);
  app.setStub({ checks, runs: { [app.main]: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' }, { id: 2, name: 'Deploy staging', path: '.github/workflows/deploy.yml', status: 'queued' }] } });
  assert.equal((await go(app)).gates.source_deployed.status, 'wait');
  app.setStub({ checks, runs: { [app.main]: [{ id: 2, name: 'Deploy staging', path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'failure' }] } });
  assert.equal((await go(app)).gates.source_deployed.status, 'block');

  // No workflow named: a GitHub deployment of that commit counts (Vercel, Netlify).
  setConfig(app.repo, 'promote.json', { stages: [{ env: 'staging', branch: 'main', how: 'push' }, { env: 'production', branch: 'production', how: 'pr', from: 'staging' }] });
  app.setStub({ checks, deployments: { [app.main]: [{ environment: 'Preview', state: 'failure' }, { environment: 'Staging', state: 'success' }] } });
  r = await go(app);
  assert.equal(r.gates.source_deployed.status, 'pass');
  assert.match(r.gates.source_deployed.says, /GitHub records a successful deployment of [0-9a-f]{7} to Staging/);
  // The same commit deployed somewhere else proves nothing about staging.
  app.setStub({ checks, deployments: { [app.main]: [{ environment: 'Preview', state: 'success' }] } });
  r = await go(app);
  assert.equal(r.gates.source_deployed.status, 'unknown');
  assert.match(r.gates.source_deployed.says, /only to Preview, none named like staging/);
  // A run of the deploy file on another branch is not the source's deploy.
  setConfig(app.repo, 'promote.json', { stages: STAGES });
  app.setStub({ checks, runs: { [app.main]: [{ id: 3, name: 'Deploy staging', path: '.github/workflows/deploy.yml', head_branch: 'feat-x', status: 'completed', conclusion: 'success' }] } });
  assert.equal((await go(app)).gates.source_deployed.status, 'block');
  setConfig(app.repo, 'promote.json', { stages: [{ env: 'staging', branch: 'main', how: 'push' }, { env: 'production', branch: 'production', how: 'pr', from: 'staging' }] });
  app.setStub({ checks });
  r = await go(app);
  assert.equal(r.gates.source_deployed.status, 'unknown');
  assert.match(r.gates.source_deployed.says, /was not checked/);
});

test('merges_cleanly: a hotfix on the target is a warning, a conflict blocks', async () => {
  const app = ready('pro-merge-');
  git(app.repo, 'checkout', '-q', 'production');
  write(app.repo, 'src/hotfix.ts', 'export const h = 1;\n');
  commit(app.repo, 'hotfix');
  git(app.repo, 'checkout', '-q', 'main');
  let r = await go(app);
  assert.equal(r.gates.merges_cleanly.status, 'warn');
  assert.match(r.gates.merges_cleanly.says, /production carries changes main does not have \(src\/hotfix\.ts\)/);
  assert.equal(r.can_open, true);
  assert.match(H.brief({ run: r.run_id }).body, /\*\*Open points\*\*\n- `merges_cleanly` warn: production carries changes/);

  git(app.repo, 'checkout', '-q', 'production');
  write(app.repo, 'src/app.ts', 'export const a = 99;\n');
  commit(app.repo, 'conflicting hotfix');
  git(app.repo, 'checkout', '-q', 'main');
  r = await go(app);
  assert.equal(r.gates.merges_cleanly.status, 'block');
  assert.match(r.gates.merges_cleanly.says, /conflicts in src\/app\.ts.*merge production back into main first/);
  assert.equal(git(app.repo, 'status', '--porcelain'), '', 'nothing was merged or checked out to find that out');
});

test('open_pr: the promotion pull request is reused, another one into the target is a warning', async () => {
  const app = ready('pro-openpr-');
  app.patchStub({ open_prs: { production: [prStub(31, app.main), { ...prStub(32, 'a'.repeat(40)), headRefName: 'hotfix/x' }, { ...prStub(33, app.main), isCrossRepository: true }] }, prs: { 31: prStub(31, app.main) } });
  const r = await go(app);
  assert.equal(r.gates.open_pr.status, 'warn');
  assert.match(r.gates.open_pr.says, /2 other pull requests into production are open \(#32 from hotfix\/x, #33 from main\)/);
  assert.deepEqual(r.pr, { number: 31, url: 'https://github.com/acme/app/pull/31', reused: true });
  assert.match(r.next, /already open \(#31\)/);
  const o = H.open({ run: r.run_id });
  assert.deepEqual([o.ok, o.opened, o.reused], [true, false, true]);
  assert.equal(calls(app).length, 0, 'nothing is created when one is open');
  assert.equal(H.brief({ run: r.run_id }).ask, null);
});

// ---------------------------------------------------------------- infra and migrations
test('a range with a migration waits for the sibling check; `blocked` stops until accepted for this run', async () => {
  const app = ready('pro-infra-');
  app.main = mergePr(app.repo, 13, 'Drop the legacy id', {
    'db/migrations/0001_drop_legacy.sql': 'ALTER TABLE users DROP COLUMN legacy_id;\n',
    'db/migrations/meta/_journal.json': `${JSON.stringify({ version: '7', dialect: 'postgresql', entries: [{ idx: 0, tag: '0000_init' }, { idx: 1, tag: '0001_drop_legacy' }] }, null, 2)}\n`,
  });
  app.setStub(green(app.main));
  const r = await go(app);
  assert.equal(r.gates.infra_check.status, 'wait');
  assert.deepEqual([r.infra.state, r.infra.skill, r.infra.buckets.migration], ['pending', 'check-infra-and-migrations', 2]);
  assert.match(r.infra.check_run, /^cim-/);
  assert.equal(r.can_open, false);
  assert.match(r.next, /follow the check-infra-and-migrations skill for its run cim-/);
  assert.match(openIt(r.run_id).gates[0], /^infra_check: /);
  // The verdict is read from that harness. Before it recorded one there is nothing to take.
  assert.throws(() => H.check({ run: r.run_id }), /has no verdict yet/);
  assert.throws(() => H.check({ run: r.run_id, check_run: '../../etc' }), /is not a check-infra-and-migrations run id/);

  await CHECK.record({ run: r.infra.check_run });
  const c = H.check({ run: r.run_id });
  assert.deepEqual([c.verdict, c.gate.status, c.needs_accept], ['blocked', 'block', true]);
  assert.ok(c.blockers.length >= 1 && /DROP COLUMN/i.test(c.blockers.join(' ')));
  assert.match(c.next, /Only if the user accepts them/);
  assert.match(openIt(r.run_id).gates[0], /infra_check: check-infra-and-migrations says blocked/);
  assert.equal(calls(app).length, 0);

  const no = H.accept({ run: r.run_id });
  assert.equal(no.ok, false);
  assert.deepEqual(no.blockers, c.blockers);
  const yes = H.accept({ run: r.run_id, confirmed: true });
  assert.deepEqual([yes.ok, yes.gate.status], [true, 'warn']);
  const b = H.brief({ run: r.run_id });
  assert.match(b.body, /\*\*Migrations and infrastructure: blocked\*\* \(check run `cim-/);
  assert.match(b.body, /\*\*Blockers, accepted for this promotion by the person who ran it\*\*\n- /);
  assert.match(b.body, /\*\*Runbook\*\*\n- /);
  assert.deepEqual(b.warnings.map((w) => w.gate), ['infra_check']);
  app.patchStub({ create: { number: 8 }, prs: { 8: prStub(8, app.main) } });
  assert.equal(openIt(r.run_id).opened, true);
  // The accepted blocker is said again at the merge question.
  assert.ok(H.ready({ run: r.run_id }).restate.some((l) => /^infra_check: .*accepted for this run/.test(l)));

  // A verdict for other commits is not taken, and neither is accepting where nothing is blocked.
  const other = await CHECK.start({ repo: app.repo, args: [`${app.prod}..${sha(app.repo, 'main~1')}`, '--no-post'] });
  await CHECK.record({ run: other.run_id });
  const again = await go(app);
  assert.throws(() => H.check({ run: again.run_id, check_run: other.run_id }), /not this promotion .*a verdict for other commits is not taken/);
  // Nor a verdict for the same commits and another environment.
  const elsewhere = await CHECK.start({ repo: app.repo, args: ['production..main', '--target', 'staging', '--no-post'] });
  await CHECK.record({ run: elsewhere.run_id });
  assert.throws(() => H.check({ run: again.run_id, check_run: elsewhere.run_id }), /for staging, not for production/);

  // The check is recorded again with one more blocker: what was accepted no longer covers it, and nothing is merged.
  await CHECK.record({ run: r.infra.check_run, targets: [{ id: S.loadRun(r.run_id).infra.target, findings: [{ bucket: 'migration', severity: 'blocker', file: 'db/migrations/0001_drop_legacy.sql', line: 1, quote: 'ALTER TABLE users DROP COLUMN legacy_id;', problem: 'The billing export still reads this column, so the nightly export fails after the drop.' }] }] });
  const after = H.ready({ run: r.run_id });
  assert.equal(after.allowed, false);
  assert.ok(after.blocking.some((x) => x.gate === 'infra_check' && /says blocked/.test(x.says)));
  assert.equal(S.loadRun(r.run_id).accepted, null);
  assert.match(H.merge({ run: r.run_id, confirmed: true }).gates.join(' '), /infra_check: /);
  assert.match(H.brief({ run: r.run_id }).body, /\*\*Blockers\*\*\n- /);

  const clean = ready('pro-infra2-');
  assert.match(H.accept({ run: (await go(clean)).run_id, confirmed: true }).refused, /no `blocked` verdict to accept/);
});

test('without the sibling skill the check is unknown, and said so in the brief', async () => {
  const app = ready('pro-alone-');
  process.env.PROMOTE_CHECK_HARNESS = join(app.tmp, 'nowhere/check.mjs');
  try {
    const r = await go(app);
    assert.equal(r.gates.infra_check.status, 'unknown');
    assert.match(r.gates.infra_check.says, /were not checked: check-infra-and-migrations is not installed next to this skill/);
    assert.deepEqual([r.infra.state, r.can_open], ['missing', true]);
    assert.match(H.brief({ run: r.run_id }).body, /\*\*Migrations and infrastructure:\*\* not checked \(check-infra-and-migrations is not installed/);
    // An older sibling without `verdict` is the same.
    const old = join(app.tmp, 'old-check.mjs');
    writeFileSync(old, "console.log(JSON.stringify(process.argv[2] === 'start' ? { run_id: 'cim-20260101-0000-abcd', targets: [{ id: 'range-a-b', bucketed: 1, buckets: {} }] } : { error: 'unknown command verdict' })); if (process.argv[2] !== 'start') process.exit(2);\n");
    process.env.PROMOTE_CHECK_HARNESS = old;
    assert.match((await go(app)).gates.infra_check.says, /too old to be read from here/);
  } finally {
    delete process.env.PROMOTE_CHECK_HARNESS;
  }
});

// ---------------------------------------------------------------- the merge guard
test('a commit that lands after the brief ends the run: nothing is merged under a stale check', async () => {
  const app = ready('pro-moved-');
  app.patchStub({ create: { number: 7 }, prs: { 7: prStub(7, app.main) } });
  const r = await go(app);
  openIt(r.run_id);
  const newer = mergePr(app.repo, 14, 'Late change', { 'src/late.ts': 'export const l = 1;\n' });
  app.patchStub({ checks: { ...green(app.main).checks, ...green(newer).checks }, runs: { ...green(app.main).runs, ...green(newer).runs }, prs: { 7: prStub(7, newer) } });
  const rd = H.ready({ run: r.run_id });
  assert.equal(rd.allowed, false);
  assert.deepEqual(rd.blocking.map((x) => x.gate), ['head_unchanged']);
  assert.match(rd.blocking[0].says, /main moved from [0-9a-f]{7} to [0-9a-f]{7}; the pull request head is [0-9a-f]{7}.*this run is over, start a new one/);
  assert.match(rd.next, /it is over/);
  const m = H.merge({ run: r.run_id, confirmed: true });
  assert.equal(m.ok, false);
  assert.match(m.gates[0], /^head_unchanged: /);
  assert.ok(!calls(app).some((c) => c.call === 'merge'));

  // The target moving (a hotfix merged into production) ends it too.
  const app2 = ready('pro-moved2-');
  app2.patchStub({ create: { number: 7 }, prs: { 7: prStub(7, app2.main) } });
  const r2 = await go(app2);
  openIt(r2.run_id);
  git(app2.repo, 'checkout', '-q', 'production');
  write(app2.repo, 'src/hotfix.ts', 'export const h = 1;\n');
  commit(app2.repo, 'hotfix');
  git(app2.repo, 'checkout', '-q', 'main');
  assert.match(H.ready({ run: r2.run_id }).blocking[0].says, /production moved from/);
  // And a pull request that is not this promotion is not merged as one.
  const app3 = ready('pro-moved3-');
  app3.patchStub({ create: { number: 7 }, prs: { 7: { ...prStub(7, app3.main), headRefName: 'hotfix/x' } } });
  const r3 = await go(app3);
  openIt(r3.run_id);
  assert.match(H.ready({ run: r3.run_id }).blocking[0].says, /#7 is hotfix\/x → production, not main → production/);
});

test('GitHub decides whether it can be merged; nothing is retried or bypassed', async () => {
  const app = ready('pro-gh-');
  app.patchStub({ create: { number: 7 }, prs: { 7: prStub(7, app.main, { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }) } });
  const r = await go(app);
  openIt(r.run_id);
  let rd = H.ready({ run: r.run_id });
  assert.deepEqual([rd.allowed, rd.ask], [false, null]);
  assert.match(rd.blocking[0].says, /GitHub blocks the merge: a required review or a required check is missing \(review: review required\)/);
  assert.match(rd.next, /Nothing is retried, re-run or bypassed/);
  assert.equal(H.merge({ run: r.run_id, confirmed: true }).ok, false);

  app.patchStub({ prs: { 7: prStub(7, app.main, { statusCheckRollup: [{ name: 'e2e', status: 'IN_PROGRESS' }] }) } });
  rd = H.ready({ run: r.run_id });
  assert.deepEqual([rd.allowed, rd.waiting.map((x) => x.gate)], [false, ['pr_mergeable']]);
  app.patchStub({ prs: { 7: prStub(7, app.main, { mergeStateStatus: 'UNSTABLE', statusCheckRollup: [{ name: 'optional', status: 'COMPLETED', conclusion: 'FAILURE' }] }) } });
  rd = H.ready({ run: r.run_id });
  assert.equal(rd.allowed, true);
  assert.ok(rd.restate.some((l) => /^pr_mergeable: .*failed: optional/.test(l)), 'a failing optional check is restated at the merge question');
  for (const [extra, why] of [[{ mergeable: 'CONFLICTING' }, /merge conflicts/], [{ isDraft: true }, /is a draft/], [{ mergeStateStatus: 'BEHIND' }, /up to date with the base/], [{ state: 'CLOSED' }, /#7 is closed/], [{ mergeStateStatus: 'SOMETHING_NEW' }, /does not know/]]) {
    assert.match(G.prMergeable(GH.prView(app.repo, 7) && { ...GH.prView(app.repo, 7), ...Object.fromEntries(Object.entries({ mergeable: extra.mergeable, draft: extra.isDraft, merge_state: extra.mergeStateStatus, state: extra.state }).filter(([, v]) => v !== undefined)) }).says, why);
  }
  assert.equal(G.prMergeable({ ...GH.prView(app.repo, 7), merge_state: 'SOMETHING_NEW', checks: [] }).status, 'unknown');
  const asked = G.prMergeable({ ...GH.prView(app.repo, 7), merge_state: 'CLEAN', checks: [], review: 'CHANGES_REQUESTED' });
  assert.deepEqual([asked.status, /review: changes requested/.test(asked.says)], ['warn', true]);

  // GitHub's own refusal is reported in its words.
  app.patchStub({ prs: { 7: prStub(7, app.main) }, merge: { error: 'GitHub refused the merge: Pull request is not mergeable: the base branch policy prohibits the merge' } });
  const m = H.merge({ run: r.run_id, confirmed: true });
  assert.equal(m.ok, false);
  assert.match(m.refused, /base branch policy prohibits the merge/);
  assert.match(m.next, /no rule is bypassed/);
  assert.equal(S.loadRun(r.run_id).merge, null);
});

test('refs that could not be refreshed prove nothing: nothing is opened or merged on them', () => {
  const run = { source: { branch: 'main', sha: 'a'.repeat(40) }, target: { branch: 'production', sha: 'b'.repeat(40) } };
  const same = { source: run.source.sha, target: run.target.sha, pr_head: run.source.sha };
  assert.equal(G.headUnchanged(run, { ...same, fetched: true }).status, 'pass');
  const stale = G.headUnchanged(run, { ...same, fetched: false });
  assert.equal(stale.status, 'block');
  assert.match(stale.says, /could not be fetched: whether they moved since the brief is not known/);
  // An acceptance covers the blockers that were read out, and no others.
  const infra = { state: 'recorded', verdict: 'blocked', blockers: ['a.', 'b.'], counts: { blocker: 2, risk: 0 } };
  assert.equal(G.infraCheck(infra, { at: 'now', blockers: ['a.', 'b.'] }).status, 'warn');
  assert.equal(G.infraCheck(infra, { at: 'now', blockers: ['a.'] }).status, 'block');
  assert.match(G.infraCheck({ state: 'recorded', verdict: 'nothing_to_check', detected: true }, null).says, /by the paths check-infra-and-migrations detected/);
  assert.deepEqual([G.sameEnv('Production', 'production'), G.sameEnv('Preview', 'staging'), G.sameEnv('Production – web', 'production'), G.sameEnv('', 'x')], [true, false, true, false]);
});

test('the merge call can carry no flag that skips a rule', () => {
  for (const method of H.MERGE_METHODS) assert.deepEqual(GH.mergeArgs(7, method, 'a'.repeat(40)), ['pr', 'merge', '7', `--${method}`, '--match-head-commit', 'a'.repeat(40)]);
  assert.throws(() => GH.mergePr('/tmp', 7, 'merge', 'abc1234'), /full commit id/);
});

test('--dry-run writes nothing; --no-merge opens and stops; a merge by hand is picked up by watch', async () => {
  const app = ready('pro-flags-');
  app.patchStub({ create: { number: 7 }, prs: { 7: prStub(7, app.main) } });
  const dry = await go(app, '--dry-run');
  assert.deepEqual([dry.can_open, dry.flags.dry_run], [false, true]);
  assert.match(dry.next, /dry run/);
  assert.equal(H.brief({ run: dry.run_id }).ask, null);
  assert.match(openIt(dry.run_id).refused, /dry run/);
  assert.match(H.merge({ run: dry.run_id, confirmed: true }).refused, /dry run/);
  assert.equal(calls(app).length, 0);

  const r = await go(app, 'production', '--no-merge');
  assert.match(openIt(r.run_id).next, /--no-merge: stop here/);
  const rd = H.ready({ run: r.run_id });
  assert.deepEqual([rd.allowed, rd.ask], [false, null]);
  assert.match(H.merge({ run: r.run_id, confirmed: true }).refused, /--no-merge: a person merges/);
  assert.match((await H.watch({ run: r.run_id })).says, /#7 is not merged/);
  const merged = 'e'.repeat(40);
  app.patchStub({ prs: { 7: prStub(7, app.main, { state: 'MERGED', mergeCommit: { oid: merged } }) }, deployments: { [merged]: [{ environment: 'Production', state: 'success' }] } });
  setConfig(app.repo, 'promote.json', { stages: STAGES.map(({ deploy_workflow, ...s }) => s) });
  assert.equal(H.ready({ run: r.run_id }).merged, true);
  const w = await H.watch({ run: (await go(app, 'watch')).run_id });
  assert.deepEqual([w.merge_sha, w.state], ['eeeeeee', 'deploy_pending'], 'this run still names deploy-production.yml, which has not run');
});

// ---------------------------------------------------------------- watch, verify
test('watch: a failed deploy is a failed deploy; nothing reporting is unknown after the wait, never green', async () => {
  const app = ready('pro-watch-');
  setConfig(app.repo, 'promote.json', { stages: STAGES.map(({ deploy_workflow, ...s }) => s) });
  app.setStub({ checks: green(app.main).checks, deployments: { [app.main]: [{ environment: 'Preview', state: 'success' }] }, create: { number: 7 }, prs: { 7: prStub(7, app.main) }, merge: { sha: 'd'.repeat(40) } });
  const r = await go(app);
  openIt(r.run_id);
  H.merge({ run: r.run_id, confirmed: true });
  const t0 = Date.now();
  let w = await H.watch({ run: r.run_id, wait: '1' });
  assert.ok(Date.now() - t0 >= 900, 'it waited');
  assert.deepEqual([w.state, w.result], ['unknown', 'deploy_pending']);
  assert.match(w.next, /nothing reported to GitHub/);
  // A green CI run on the merge commit is not a deploy, and a red one is not a failed deploy.
  app.patchStub({ runs: { ['d'.repeat(40)]: [{ id: 5, name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' }, { id: 6, name: 'Lint', path: '.github/workflows/lint.yml', status: 'completed', conclusion: 'failure' }] } });
  w = await H.watch({ run: r.run_id });
  assert.deepEqual([w.state, w.items], ['deploy_pending', []]);
  app.patchStub({ deployments: { ['d'.repeat(40)]: [{ environment: 'Production', state: 'in_progress' }] } });
  assert.equal((await H.watch({ run: r.run_id })).state, 'deploy_pending');
  app.patchStub({ deployments: { ['d'.repeat(40)]: [{ environment: 'Production', state: 'success', url: 'https://app.example.com' }] } });
  w = await H.watch({ run: r.run_id });
  assert.deepEqual([w.state, w.items[0].kind], ['deploy_green', 'deployment']);
  app.patchStub({ deployments: { ['d'.repeat(40)]: [{ environment: 'Production', state: 'failure' }] } });
  w = await H.watch({ run: r.run_id });
  assert.deepEqual([w.state, w.result], ['deploy_failed', 'deploy_failed']);
  assert.match(w.next, /Do not re-run it/);
  assert.equal((await H.verify({ run: r.run_id })).result, 'deploy_failed');
});

test('verify: the health URL counts, and a failing one is not a promotion', async () => {
  const app = ready('pro-verify-');
  let code = 200;
  const server = createServer((req, res) => {
    res.statusCode = code;
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/health`;
  try {
    setConfig(app.repo, 'promote.json', { stages: STAGES, verify: { production: { health: url } } });
    const mergeSha = 'c'.repeat(40);
    app.patchStub({ create: { number: 7 }, prs: { 7: prStub(7, app.main) }, merge: { sha: mergeSha }, runs: { ...green(app.main).runs, [mergeSha]: [{ id: 9, name: 'Deploy production', path: '.github/workflows/deploy-production.yml', status: 'completed', conclusion: 'success' }] } });
    const r = await go(app);
    assert.match((await H.verify({ run: r.run_id })).refused, /nothing is merged yet/);
    openIt(r.run_id);
    H.merge({ run: r.run_id, confirmed: true });
    await H.watch({ run: r.run_id });
    let v = await H.verify({ run: r.run_id });
    assert.deepEqual([v.result, v.health], ['promoted_unverified', { ok: true, status: 200 }]);
    code = 503;
    v = await H.verify({ run: r.run_id });
    assert.deepEqual([v.result, v.health.status], ['not_serving', 503]);
    assert.match(v.says, /the health check of production failed \(503\)/);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- status, setup labels
test('status: what waits per stage, without starting a run', async () => {
  const app = ready('pro-status-');
  app.patchStub({ open_prs: { production: [prStub(31, app.main)] } });
  const before = S.readLog().length;
  const s = await go(app, 'status');
  assert.equal(s.mode, 'status');
  const [{ last_run, ...stage }] = s.stages;
  assert.deepEqual(stage, { env: 'production', from: 'staging', production: true, source: { branch: 'main', sha: app.main.slice(0, 7) }, target: { branch: 'production', sha: app.prod.slice(0, 7) }, commits_waiting: 3, pull_requests_waiting: 2, open_pr: { number: 31, url: 'https://github.com/acme/app/pull/31' } });
  assert.ok(last_run === null || RESULTS.includes(last_run.result));
  assert.equal(s.stages.length, 1);
  assert.equal(S.readLog().length, before);
});

test('probe logs what Jev read and decides nothing; the stage list confirmed at setup labels it', async () => {
  const app = use(makeApp('pro-jev-', { config: false }));
  const stub = join(app.tmp, 'jev.json');
  writeFileSync(stub, JSON.stringify({ 'prod__0': 0.9, 'prod__1': 0.2, 'deploys__*': 0.8, 'from__*': 0.3 }));
  process.env.PROMOTE_JEV_STUB = stub;
  process.env.PROMOTE_JEV = 'shadow';
  try {
    const p = await H.probe({ repo: app.repo });
    assert.equal(p.jev, 'shadow');
    // Jev called staging production and production not: logged, and the proposal is untouched.
    assert.deepEqual(p.stages.map((s) => [s.env, Boolean(s.production)]), [['staging', false], ['production', true]]);
    assert.equal(p.suggestions, undefined);
    const logged = C.readJsonl(S.jevLog()).filter((c) => c.type === 'case');
    assert.deepEqual([...new Set(logged.map((c) => c.question))].sort(), ['branch_deploys_env', 'env_is_production', 'env_promotes_from']);
    assert.ok(logged.every((c) => c.acted === false && c.mode === 'shadow' && c.skill === 'promote'));
    const sent = readFileSync(`${stub}.sent.jsonl`, 'utf8');
    assert.ok(!/acme|https?:\/\//.test(sent));

    assert.throws(() => H.configured({ repo: app.repo }), /no `stages` list yet/);
    setConfig(app.repo, 'promote.json', { stages: STAGES });
    const c = H.configured({ repo: app.repo });
    assert.deepEqual([c.ok, c.promotable, c.warnings], [true, ['production'], []]);
    assert.deepEqual(c.stages[1], { env: 'production', how: 'pr', branch: 'production', from: 'staging', merge_method: 'merge', production: true, deploy_workflow: 'deploy-production.yml' });
    const labels = C.readJsonl(S.jevLog()).filter((l) => l.type === 'label');
    assert.equal(labels.length, c.labelled);
    assert.ok(labels.length >= 6 && labels.every((l) => l.source === 'setup'));
    const prodCase = logged.find((x) => x.question === 'env_is_production' && /^Is production /.test(x.show));
    assert.equal(labels.find((l) => l.case === prodCase.case).label, true);
    // Labelled once: checking the file again adds nothing.
    assert.equal(H.configured({ repo: app.repo }).labelled, 0);

    // Calibrated (tests only), Jev can add the production wording and be shown as the other reading. It removes nothing.
    process.env.PROMOTE_JEV = 'live';
    process.env.PROMOTE_TEST_CALIBRATED = 'env_is_production,branch_deploys_env';
    const live = await H.probe({ repo: app.repo });
    assert.deepEqual(live.stages.map((s) => Boolean(s.production)), [true, true]);
    assert.ok(live.suggestions.some((s) => /Jev reads production, not main, as the branch that deploys staging/.test(s)));

    writeFileSync(stub, JSON.stringify({ __degraded: true }));
    assert.equal((await H.probe({ repo: app.repo })).jev, 'degraded');
    // The file can switch it off; the environment variable wins over the file.
    delete process.env.PROMOTE_JEV;
    setConfig(app.repo, 'promote.json', { stages: STAGES, jev: 'off' });
    assert.equal((await H.probe({ repo: app.repo })).jev, 'off');
  } finally {
    delete process.env.PROMOTE_JEV_STUB;
    delete process.env.PROMOTE_TEST_CALIBRATED;
    process.env.PROMOTE_JEV = 'off';
  }
});

test('a run id is something this script made, and a stage list with nothing to warn about says so', async () => {
  assert.throws(() => H.brief({ run: '../../x' }), /unknown run/);
  assert.throws(() => H.check({ run: 'pro-20260101-0000-zzzz' }), /unknown run/);
  const app = use(makeApp('pro-warn-'));
  setConfig(app.repo, 'promote.json', { stages: [{ env: 'staging', branch: 'main', how: 'push' }, { env: 'edge', how: 'manual' }] });
  const c = H.configured({ repo: app.repo });
  assert.equal(c.warnings.length, 2);
  assert.match(c.warnings.join(' '), /no stage is marked or named as production.*nothing this skill can promote/);
});
