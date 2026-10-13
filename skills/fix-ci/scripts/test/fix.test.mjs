import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp, git, write, sha, setConfig, pushTo, row, statusRow, actionsLog, note, testJob, lintJob, GIT_ENV, GOOD, TEST, TEST_COMMAND, LINT_COMMAND } from './fixture.mjs';

const root = mkdtempSync(join(tmpdir(), 'ci-state-'));
Object.assign(process.env, GIT_ENV);
process.env.FIX_CI_STATE_DIR = join(root, 'fix-ci');
// Never this machine's real calibration file.
process.env.REAL_SKILLS_CALIBRATION_DIR = join(root, 'calibration');
delete process.env.REAL_SKILLS_CALIBRATION;
delete process.env.FIX_CI_TEST_CALIBRATED;
delete process.env.FIX_CI_JEV_STUB;
process.env.FIX_CI_JEV = 'off';
// watch: one look per call, no waiting.
process.env.FIX_CI_POLL_MS = '0';
process.env.FIX_CI_WATCH_BUDGET_MS = '0';

const H = await import('../fix.mjs');
const S = await import('../lib/state.mjs');
const C = await import('../lib/calibration.mjs');
const { loadConfig } = await import('../lib/config.mjs');

const use = (app) => {
  process.env.FIX_CI_GH_STUB = app.stubFile;
  return app;
};
const status = (r) => Object.fromEntries(Object.entries(r.gates).map(([k, v]) => [k, v.status]));
const by = (s, job) => s.failures.find((f) => f.jobs.includes(job));
const FIX = [{ file: 'src/price.mjs', why: 'price() tripled the amount; it doubles it again', failure: 'f1' }];
const SUBJECT = 'fix: price doubles the amount again';

// start on pull request #7. -> { app, run, s, ws }
async function started(prefix, opts, ...args) {
  const app = use(makeApp(prefix, opts));
  const s = await H.start({ repo: app.repo, args: ['7', ...args] });
  return { app, run: s.run_id, s, ws: s.workspace?.path };
}
// start, repro, the right fix, check.
async function fixed(prefix, opts, ...args) {
  const t = await started(prefix, opts, ...args);
  t.r = H.repro({ run: t.run });
  write(t.ws, 'src/price.mjs', GOOD);
  t.c = await H.check({ run: t.run, subject: SUBJECT, edits: FIX });
  return t;
}
const greenRows = [row('Unit tests', 'SUCCESS', { job: 21, run: 200 }), row('Lint', 'SUCCESS', { job: 22, run: 200 })];

// ---------------------------------------------------------------- config
test('config: own keys; install from the other skills; a job name with a slash matches a glob', async () => {
  const app = makeApp('ci-cfg-', { config: { repro: { 'Unit tests*': 'pnpm test', Deploy: false }, ignore: ['Preview*'], max_rounds: 2 } });
  setConfig(app.repo, { install: 'pnpm install --frozen-lockfile' }, 'solve-merge-conflicts.json');
  const { config, sources } = loadConfig(app.repo);
  const { mappedFor, isIgnored } = await import('../lib/config.mjs');
  assert.equal(config.install, 'pnpm install --frozen-lockfile');
  assert.equal(sources.install, '.claude/solve-merge-conflicts.json');
  assert.equal(mappedFor(config, 'Unit tests (shard 2/2)'), 'pnpm test');
  assert.equal(mappedFor(config, 'Deploy'), false);
  assert.equal(mappedFor(config, 'Lint'), undefined);
  assert.equal(isIgnored(config, 'Preview / deploy'), true);
  assert.deepEqual([config.max_rounds, config.max_files, config.gate_timeout_s], [2, 10, 900]);
  setConfig(app.repo, { repro: { Lint: 3 } });
  assert.throws(() => loadConfig(app.repo), /repro\["Lint"\] is a command, or false/);
});

// ---------------------------------------------------------------- start
test('start: green is nothing to fix; only running checks is ci_running', async () => {
  const app = use(makeApp('ci-green-'));
  app.checks(app.head, greenRows);
  const s = await H.start({ repo: app.repo, args: ['7'] });
  assert.equal(s.verdict, 'nothing_to_fix');
  assert.equal(s.run_id, undefined);
  app.checks(app.head, [row('Unit tests', '', { job: 11, status: 'IN_PROGRESS' })]);
  const r = await H.start({ repo: app.repo, args: [] });
  assert.equal(r.verdict, 'ci_running');
  assert.deepEqual(r.running, ['Unit tests']);
  assert.equal((await H.watch({ run: r.run_id })).verdict, 'pending');
});

test('start: a fork, a closed pull request and a conflicting one are blocked', async () => {
  const app = use(makeApp('ci-block-'));
  for (const [extra, gate] of [[{ isCrossRepository: true }, 'same_repo'], [{ state: 'MERGED' }, 'pr_open'], [{ mergeable: 'CONFLICTING' }, 'conflicts']]) {
    Object.assign(app.stub.prs[7], { isCrossRepository: false, state: 'OPEN', mergeable: 'MERGEABLE' }, extra);
    app.save();
    const s = await H.start({ repo: app.repo, args: ['7'] });
    assert.equal(s.verdict, 'blocked');
    assert.deepEqual(s.blocking, [gate]);
  }
  assert.match((await H.start({ repo: app.repo, args: ['7'] })).gates.conflicts.text, /solve-merge-conflicts/);
});

test('start: no pull request for the branch asks which, offering the red ones; one per run', async () => {
  const app = use(makeApp('ci-none-'));
  app.stub.current_pr = null;
  app.stub.mine = [app.stub.prs[7], { ...app.stub.prs[7], number: 8, title: 'Green one', headRefOid: 'f'.repeat(40) }];
  app.save();
  const s = await H.start({ repo: app.repo, args: [] });
  assert.deepEqual(s.needs, ['input']);
  assert.deepEqual(s.candidates.map((c) => [c.number, c.failed]), [[7, 1]]);
  await assert.rejects(H.start({ repo: app.repo, args: ['7', '8'] }), /one pull request per run/);
  await assert.rejects(H.start({ repo: app.repo, args: ['--force'] }), /unknown flag/);
  await assert.rejects(H.start({ repo: app.repo, args: ['https://github.com/other/repo/pull/7'] }), /belongs to other\/repo/);
});

test('start: every failed check gets a class with its evidence; the code one gets its command', async () => {
  const app = use(makeApp('ci-classes-'));
  app.checks(app.head, [
    row('Unit tests', 'FAILURE', { job: 11 }),
    row('E2E', 'FAILURE', { job: 13 }),
    row('Release notes', 'FAILURE', { job: 14 }),
    row('All checks', 'FAILURE', { job: 15 }),
    row('Slow', 'TIMED_OUT', { job: 16 }),
    row('Old', 'FAILURE', { job: 17 }),
    statusRow('vercel', 'FAILURE'),
    row('Lint', 'SUCCESS', { job: 12 }),
  ], {
    13: { log: actionsLog({ script: 'pnpm e2e', errors: ['request to https://registry.npmjs.org failed, reason: read ECONNRESET'] }), annotations: [] },
    14: { log: actionsLog({ uses: 'actions/github-script@v7', errors: ['Resource not accessible by integration'] }), annotations: [] },
    15: { log: actionsLog({ script: ['result="failure"', 'if [ "$result" != "success" ]; then exit 1; fi'] }), annotations: [] },
    16: { log: actionsLog({ script: 'pnpm slow', exit: 0 }), annotations: [] },
  });
  const s = await H.start({ repo: app.repo, args: ['7'] });
  assert.equal(s.verdict, 'fixable');
  assert.deepEqual(Object.fromEntries(s.failures.map((f) => [f.jobs[0], f.class])), { 'Unit tests': 'code', E2E: 'infra', 'Release notes': 'config', 'All checks': 'derived', Slow: 'infra', Old: 'external', vercel: 'external' });
  assert.deepEqual(s.counts, { code: 1, infra: 2, config: 1, derived: 1, external: 2 });
  const code = by(s, 'Unit tests');
  assert.equal(code.command, TEST_COMMAND);
  assert.equal(code.repro, 'run');
  assert.equal(code.errors[0].file, 'test/price.test.mjs');
  assert.match(code.excerpt, /6 !== 4/);
  assert.ok(existsSync(code.log) && readFileSync(code.log, 'utf8').includes('setup line 3'), 'the whole log is kept for when more is needed');
  assert.match(by(s, 'E2E').evidence, /a network error/);
  assert.equal(by(s, 'E2E').rerun, 'offered');
  assert.match(by(s, 'Release notes').evidence, /lacks a permission/);
  assert.match(by(s, 'Old').evidence, /could not be read/);
  assert.equal(by(s, 'vercel').excerpt, undefined);
  assert.deepEqual(s.commands.run, [TEST_COMMAND]);
  assert.match(s.commands.note, /run the pull request's code on this machine/);
});

test('start: shards that fail the same way are one failure; a job in `ignore` is not read', async () => {
  const app = use(makeApp('ci-shards-', { config: { ignore: ['Preview*'] } }));
  app.checks(app.head, [row('Unit tests (shard 1/2)', 'FAILURE', { job: 11 }), row('Unit tests (shard 2/2)', 'FAILURE', { job: 18 }), row('Preview / deploy', 'FAILURE', { job: 19 })], { 18: testJob() });
  const s = await H.start({ repo: app.repo, args: ['7'] });
  assert.equal(s.failures.length, 1);
  assert.deepEqual(s.failures[0].jobs, ['Unit tests (shard 1/2)', 'Unit tests (shard 2/2)']);
  assert.equal(s.ignored_checks, 1);
});

test('start: the checkout is the workspace only when it is on the branch, clean and at the head', async () => {
  const here = await started('ci-ws-here-');
  assert.deepEqual([here.s.workspace.mode, here.s.workspace.path], ['checkout', realpathSync(here.app.repo)]);
  const forced = await started('ci-ws-flag-', {}, '--worktree');
  assert.equal(forced.s.workspace.mode, 'worktree');
  assert.ok(forced.ws.includes('.claude/worktrees/ci-') && existsSync(join(forced.ws, 'src/price.mjs')));
  assert.equal(sha(forced.ws, 'HEAD'), forced.app.head);
  const other = await started('ci-ws-main-', { on: 'main' });
  assert.match(other.s.workspace.why, /is on `main`, not on `feat`/);
  const dirty = use(makeApp('ci-ws-dirty-'));
  write(dirty.repo, 'notes.txt', 'mine\n');
  assert.match((await H.start({ repo: dirty.repo, args: ['7'] })).workspace.why, /uncommitted or untracked/);
  const ahead = use(makeApp('ci-ws-ahead-'));
  write(ahead.repo, 'src/more.mjs', 'export const x = 1;\n');
  git(ahead.repo, 'add', '-A');
  git(ahead.repo, 'commit', '-q', '-m', 'local only');
  const a = await H.start({ repo: ahead.repo, args: ['7'] });
  assert.equal(a.workspace.mode, 'worktree');
  assert.equal(status(a).local_unpushed, 'warn');
});

test('start: a config file the pull request adds does not choose the commands', async () => {
  const app = use(makeApp('ci-cfg-pr-', { on: 'main' }));
  const head = pushTo(app, 'feat', { '.claude/fix-ci.json': JSON.stringify({ repro: { 'Unit tests': 'touch /tmp/owned' } }) }, 'add config', { force: ['.claude/fix-ci.json'] });
  app.at(head, [row('Unit tests', 'FAILURE', { job: 11 })]);
  const s = await H.start({ repo: app.repo, args: ['7'] });
  assert.deepEqual(s.ignored_config, ['.claude/fix-ci.json']);
  assert.equal(by(s, 'Unit tests').command, TEST_COMMAND);
});

test('start: a failure that is red on the base too is left out unless the user says so', async () => {
  const app = use(makeApp('ci-base-'));
  app.stub.base = { Quality: { 'Unit tests': 'failure' } };
  app.save();
  const s = await H.start({ repo: app.repo, args: ['7'] });
  assert.equal(status(s).red_on_base, 'warn');
  assert.equal(s.failures[0].in_scope, false);
  assert.equal(s.verdict, 'report_only');
  const r = H.repro({ run: s.run_id, include_base_red: true });
  assert.equal(r.verdict, 'fixable');
  assert.equal(r.results[0].result, 'reproduced');
});

// ---------------------------------------------------------------- repro
test('repro: red here for the reason CI gave; what the command left behind is not an edit', async () => {
  const t = await started('ci-repro-');
  const r = H.repro({ run: t.run });
  assert.equal(r.verdict, 'fixable');
  assert.deepEqual(r.results.map((x) => [x.id, x.result, x.because]), [['f1', 'reproduced', 'price.test.mjs']]);
  assert.match(r.results[0].tail, /price doubles the amount/);
  assert.ok(existsSync(join(t.ws, 'last-run.txt')));
  assert.deepEqual(Object.keys(S.loadRun(t.run).noise), ['last-run.txt']);
  // A second call runs nothing again.
  assert.equal(H.repro({ run: t.run }).results[0].result, 'reproduced');
});

test('repro: green here on the same commit is not reproduced, and a rerun is offered', async () => {
  const app = use(makeApp('ci-flaky-', { on: 'main' }));
  const head = pushTo(app, 'feat', { 'src/price.mjs': GOOD }, 'fix it back');
  app.at(head, [row('Unit tests', 'FAILURE', { job: 11 })]);
  const s = await H.start({ repo: app.repo, args: ['7'] });
  const r = H.repro({ run: s.run_id });
  assert.equal(r.results[0].result, 'not_reproduced');
  assert.equal(r.verdict, 'rerun_offered');
  assert.match(r.next, /nothing is red here on the same commit/);
});

test('repro: red here for another reason differs; it refuses after an edit', async () => {
  const app = use(makeApp('ci-differs-'));
  app.checks(app.head, [row('Unit tests', 'FAILURE', { job: 11 })], { 11: { ...testJob(), annotations: [note('test/checkout.test.mjs', 3, 'TypeError: cart.total is not a function', 'checkout')] } });
  const s = await H.start({ repo: app.repo, args: ['7'] });
  const r = H.repro({ run: s.run_id });
  assert.equal(r.results[0].result, 'differs');
  assert.match(r.results[0].because, /none of the files or errors CI named/);
  const t = await started('ci-repro-late-');
  write(t.ws, 'src/price.mjs', GOOD);
  assert.throws(() => H.repro({ run: t.run }), /repro runs before any edit, and src\/price\.mjs is changed/);
});

test('repro: an unusual command runs only after a yes; one that writes somewhere never runs', async () => {
  const app = use(makeApp('ci-ask-'));
  app.checks(app.head, [row('Unit tests', 'FAILURE', { job: 11 }), row('Publish', 'FAILURE', { job: 13 })], {
    11: { ...testJob(), log: testJob().log.replaceAll(TEST_COMMAND, 'sh ./run-tests.sh') },
    13: { log: actionsLog({ script: 'npm publish --dry-run', errors: ['src/price.mjs: version already exists on the registry for this package'] }), annotations: [note('src/price.mjs', 1, 'version already exists on the registry for this package')] },
  });
  const s = await H.start({ repo: app.repo, args: ['7'] });
  assert.deepEqual(s.commands.ask.map((a) => a.command), ['sh ./run-tests.sh']);
  assert.deepEqual(s.commands.never.map((a) => a.command), ['npm publish --dry-run']);
  assert.match(s.next, /show each command in `commands.ask`/);
  const first = H.repro({ run: s.run_id });
  assert.deepEqual(first.asks.map((a) => a.id), [by(s, 'Unit tests').id]);
  assert.deepEqual(first.results.map((x) => x.result), ['not_run']);
  assert.ok(!existsSync(join(app.repo, 'last-run.txt')), 'nothing ran');
  const second = H.repro({ run: s.run_id, confirm: [by(s, 'Unit tests').id] });
  assert.deepEqual(second.results.map((x) => x.result).sort(), ['not_run', 'reproduced']);
  assert.deepEqual(second.asks, []);
});

// ---------------------------------------------------------------- check
test('check: needs repro first; refuses an unlisted edit, an unknown failure, a missing subject', async () => {
  const t = await started('ci-check-');
  write(t.ws, 'src/price.mjs', GOOD);
  await assert.rejects(H.check({ run: t.run, subject: SUBJECT, edits: FIX }), /call repro first: f1 was never run here/);
  git(t.ws, 'checkout', '-q', '--', 'src/price.mjs');
  H.repro({ run: t.run });
  assert.match((await H.check({ run: t.run, subject: SUBJECT, edits: [] })).problems[0], /nothing is changed/);
  write(t.ws, 'src/price.mjs', GOOD);
  write(t.ws, 'src/extra.mjs', 'export const y = 1;\n');
  const c = await H.check({ run: t.run, subject: SUBJECT, edits: FIX });
  assert.equal(c.verdict, 'needs_decision');
  assert.deepEqual(c.unlisted, ['src/extra.mjs']);
  assert.equal(status(c).listed, 'block');
  const bad = await H.check({ run: t.run, subject: '', edits: [{ file: 'src/price.mjs', why: 'x', failure: 'f9' }, { file: 'src/extra.mjs', why: '', failure: 'f1' }, { file: 'lint.mjs', why: 'x', failure: 'f1' }, { file: '../x', why: 'x', failure: 'f1' }] });
  assert.equal(bad.problems.length, 5);
  assert.match(bad.problems.join('\n'), /f9 is not a failure this run fixes[\s\S]*`why` is missing[\s\S]*lint\.mjs is listed as an edit and is unchanged[\s\S]*not a path inside the repository[\s\S]*`subject` is missing/);
  assert.equal(S.loadRun(t.run).checked, undefined);
});

test('check: a fix that leaves the command red is still_red, and nothing can be pushed', async () => {
  const t = await started('ci-red-');
  H.repro({ run: t.run });
  write(t.ws, 'src/price.mjs', 'export const price = (n) => n * 4;\n');
  const c = await H.check({ run: t.run, subject: SUBJECT, edits: FIX });
  assert.equal(c.verdict, 'still_red');
  assert.equal(c.red[0].id, 'f1');
  assert.match(c.red[0].tail, /price doubles the amount/);
  assert.equal(status(c).proof, 'block');
  assert.match(H.push({ run: t.run, confirmed: true }).refused, /nothing was checked yet/);
});

test('check: the right fix is fixed; the commit holds the listed file and nothing a command left behind', async () => {
  const t = await fixed('ci-fixed-');
  assert.equal(t.c.verdict, 'fixed');
  assert.equal(status(t.c).proof, 'pass');
  assert.equal(status(t.c).flags, 'pass');
  assert.deepEqual(t.c.summary.fixes, [{ failure: 'f1', jobs: ['Unit tests'], command: TEST_COMMAND, proof: 'red here before, green here now' }]);
  assert.match(t.c.ask, /Push one commit \([0-9a-f]{7}\) to feat, the branch of pull request #7\?/);
  assert.equal(git(t.app.repo, 'rev-parse', `${t.c.commit}^`), t.app.head);
  assert.deepEqual(git(t.app.repo, 'show', '--name-only', '--format=', t.c.commit).split('\n'), ['src/price.mjs']);
  assert.match(git(t.app.repo, 'log', '-1', '--format=%B', t.c.commit), /^fix: price doubles the amount again\n\n- src\/price\.mjs: price\(\) tripled the amount; it doubles it again\n\nCI: Unit tests/);
  // HEAD has not moved, and the branch still is where CI saw it.
  assert.equal(sha(t.app.repo, 'feat'), t.app.head);
  // A second check with nothing changed does not run the command again.
  const logs = () => Object.values(S.loadRun(t.run).proof.results).map((r) => r.log);
  const before = logs();
  await H.check({ run: t.run, subject: SUBJECT, edits: FIX });
  assert.deepEqual(logs(), before);
});

test('check: a shortcut is asked, one question per flag; the answer is void once the file changes', async () => {
  const t = await started('ci-flag-');
  H.repro({ run: t.run });
  const loosened = TEST.replace('assert.equal(price(2), 4,', 'assert.equal(price(2), 6,');
  write(t.ws, 'test/price.test.mjs', loosened);
  const edits = [{ file: 'test/price.test.mjs', why: 'the test expected the old price', failure: 'f1' }];
  const c = await H.check({ run: t.run, subject: SUBJECT, edits });
  assert.equal(c.verdict, 'needs_decision');
  assert.deepEqual(c.asks.map((a) => a.id), ['test_edited:test/price.test.mjs']);
  assert.equal(status(c).proof, 'pass', 'the command is green: that is exactly why it is asked');
  assert.match(H.decide({ run: t.run, id: 'test_edited:test/price.test.mjs' }).refused, /needs --confirmed/);
  assert.throws(() => H.decide({ run: t.run, id: 'suppression:x', confirmed: true }), /no open question suppression:x/);
  assert.equal(H.decide({ run: t.run, id: 'test_edited:test/price.test.mjs', confirmed: true }).decided, true);
  const ok = await H.check({ run: t.run, subject: SUBJECT, edits });
  assert.equal(ok.verdict, 'fixed');
  assert.deepEqual(ok.summary.answered.map((a) => a.flag), ['test_edited']);
  assert.equal(status(ok).flags, 'warn');
  // The file changes again: a new question, also for the new shortcut.
  write(t.ws, 'test/price.test.mjs', loosened.replace("test('price of nothing", "test.skip('price of nothing"));
  const again = await H.check({ run: t.run, subject: SUBJECT, edits });
  assert.deepEqual(again.asks.map((a) => a.flag).sort(), ['test_edited', 'test_skipped']);
});

test('check: a fix that could not be proven here is fixed_unverified, in those words', async () => {
  const app = use(makeApp('ci-unver-'));
  app.checks(app.head, [row('Unit tests', 'FAILURE', { job: 11 })], { 11: { ...testJob(), annotations: [note('test/checkout.test.mjs', 3, 'TypeError: cart.total is not a function', 'checkout')] } });
  const s = await H.start({ repo: app.repo, args: ['7'] });
  H.repro({ run: s.run_id });
  write(app.repo, 'src/price.mjs', GOOD);
  const c = await H.check({ run: s.run_id, subject: SUBJECT, edits: FIX });
  assert.equal(c.verdict, 'fixed_unverified');
  assert.equal(status(c).proof, 'unknown');
  assert.match(c.summary.fixes[0].proof, /^not proven here: red here, and none of the files/);
  assert.match(c.ask, /The fix was not proven here\.$/);
});

test('check: a failure can be left, with a reason; what is not addressed is said', async () => {
  const app = use(makeApp('ci-leave-'));
  const head = pushTo(app, 'feat', { 'src/legacy.mjs': 'var old = 1;\nexport default old;\n' }, 'add legacy');
  git(app.repo, 'pull', '-q', 'origin', 'feat');
  app.at(head, [row('Unit tests', 'FAILURE', { job: 11 }), row('Lint', 'FAILURE', { job: 12 })], { 12: lintJob('src/legacy.mjs') });
  const s = await H.start({ repo: app.repo, args: ['7'] });
  const [unit, lint] = [by(s, 'Unit tests').id, by(s, 'Lint').id];
  H.repro({ run: s.run_id });
  write(app.repo, 'src/price.mjs', GOOD);
  const edits = [{ file: 'src/price.mjs', why: 'doubles again', failure: unit }];
  const strict = await H.check({ run: s.run_id, subject: SUBJECT, edits });
  assert.equal(strict.verdict, 'still_red');
  assert.deepEqual(strict.red.map((r) => r.command), [LINT_COMMAND]);
  const c = await H.check({ run: s.run_id, subject: SUBJECT, edits, leave: [{ failure: lint, why: 'the legacy file is being removed in another pull request' }] });
  assert.equal(c.verdict, 'fixed');
  assert.deepEqual(c.summary.left.map((l) => l.failure), [lint]);
  // The failure that was left is red after the push: that is not the fix failing.
  const p = H.push({ run: s.run_id, confirmed: true });
  app.at(p.commit, [row('Unit tests', 'SUCCESS', { job: 21, run: 200 }), row('Lint', 'FAILURE', { job: 22, run: 200 })], { 22: lintJob('src/legacy.mjs') });
  const w = await H.watch({ run: s.run_id });
  assert.deepEqual([w.verdict, w.round, w.then], ['red', 2, 'fixable']);
});

// ---------------------------------------------------------------- push
test('push: needs the yes, a checked fix and an unchanged workspace; --no-push shows the command', async () => {
  const t = await fixed('ci-push-refuse-');
  assert.match(H.push({ run: t.run }).refused, /needs --confirmed/);
  write(t.ws, 'src/price.mjs', `${GOOD}// more\n`);
  assert.match(H.push({ run: t.run, confirmed: true }).refused, /the workspace changed since check/);
  write(t.ws, 'src/price.mjs', GOOD);
  write(t.ws, 'src/late.mjs', 'export const z = 1;\n');
  assert.match(H.push({ run: t.run, confirmed: true }).refused, /the workspace changed since check/);
  assert.equal(sha(t.app.remote, 'feat'), t.app.head);
  const n = await fixed('ci-nopush-', {}, '--no-push');
  assert.equal(n.c.ask, undefined);
  assert.match(n.c.push_command, /push origin [0-9a-f]{40}:refs\/heads\/feat$/);
  assert.match(H.push({ run: n.run, confirmed: true }).refused, /--no-push/);
});

test('push: a head that moved ends the round', async () => {
  const t = await fixed('ci-moved-');
  pushTo(t.app, 'feat', { 'README.md': 'hi\n' }, 'someone else');
  const p = H.push({ run: t.run, confirmed: true });
  assert.equal(p.pushed, false);
  assert.deepEqual(p.blocking, ['head_unchanged']);
  assert.equal((await H.check({ run: t.run, subject: SUBJECT, edits: FIX })).verdict, 'blocked');
});

test('push: in the checkout, the commit lands on the remote and the branch moves with it', async () => {
  const t = await fixed('ci-push-here-');
  const p = H.push({ run: t.run, confirmed: true });
  assert.equal(p.verdict, 'pushed');
  assert.equal(sha(t.app.remote, 'feat'), p.commit);
  assert.equal(git(t.app.remote, 'rev-parse', 'feat^'), t.app.head, 'one commit on top of the head');
  assert.equal(sha(t.app.repo, 'feat'), p.commit);
  assert.equal(git(t.app.repo, 'symbolic-ref', '--short', 'HEAD'), 'feat');
  // Clean, but for the file the test run left behind.
  assert.equal(git(t.app.repo, 'status', '--porcelain'), '?? last-run.txt');
  assert.match(p.next, /call watch/);
  assert.match(H.push({ run: t.run, confirmed: true }).refused, /nothing was checked yet/);
});

test('push: from a worktree, the user\'s checkout is not touched and is said to be behind', async () => {
  const t = await fixed('ci-push-wt-', { on: 'main' });
  assert.equal(t.s.workspace.mode, 'worktree');
  const p = H.push({ run: t.run, confirmed: true });
  assert.equal(sha(t.app.remote, 'feat'), p.commit);
  assert.equal(sha(t.ws, 'HEAD'), p.commit);
  assert.equal(sha(t.app.repo, 'feat'), t.app.head);
  assert.equal(git(t.app.repo, 'status', '--porcelain'), '');
  assert.match(p.next, /local feat is one commit behind/);
});

// ---------------------------------------------------------------- watch
test('watch: pending, then green ends the run and removes its worktree', async () => {
  const t = await fixed('ci-watch-green-', { on: 'main' });
  const p = H.push({ run: t.run, confirmed: true });
  // GitHub still shows the old head for a moment.
  const lag = await H.watch({ run: t.run });
  assert.equal(lag.verdict, 'pending');
  assert.match(lag.note, /does not show the push yet/);
  t.app.at(p.commit, []);
  assert.match((await H.watch({ run: t.run })).note, /no check has appeared/);
  t.app.at(p.commit, [row('Unit tests', '', { job: 21, run: 200, status: 'IN_PROGRESS' }), row('Lint', 'SUCCESS', { job: 22, run: 200 })]);
  assert.match((await H.watch({ run: t.run })).note, /1 check still running/);
  t.app.at(p.commit, greenRows);
  const g = await H.watch({ run: t.run });
  assert.equal(g.verdict, 'green');
  assert.equal(g.worktree_removed, true);
  assert.ok(!existsSync(t.ws));
  await assert.rejects(H.watch({ run: t.run }), /is over \(CI is green\)/);
});

test('watch: red on the pushed commit starts round 2 with the new failures', async () => {
  const t = await fixed('ci-watch-red-');
  const p = H.push({ run: t.run, confirmed: true });
  // The fix worked; a lint rule now fails on a file that was there all along.
  write(t.ws, 'src/legacy.mjs', 'var old = 1;\nexport default old;\n');
  git(t.ws, 'add', '-A');
  git(t.ws, 'commit', '-q', '-m', 'legacy');
  git(t.ws, 'push', '-q', 'origin', 'feat');
  const head2 = sha(t.ws, 'HEAD');
  // That was someone else's push: this run is over.
  t.app.at(head2, [row('Lint', 'FAILURE', { job: 32, run: 300 })], { 32: lintJob('src/legacy.mjs') });
  const moved = await H.watch({ run: t.run });
  assert.equal(moved.verdict, 'blocked');
  assert.deepEqual(moved.blocking, ['head_unchanged']);

  const u = await fixed('ci-watch-red2-');
  const q = H.push({ run: u.run, confirmed: true });
  u.app.at(q.commit, [row('Unit tests', 'SUCCESS', { job: 21, run: 200 }), row('Lint', 'FAILURE', { job: 22, run: 200 })], { 22: lintJob('src/price.mjs') });
  const w = await H.watch({ run: u.run });
  assert.equal(w.verdict, 'red');
  assert.deepEqual([w.round, w.then], [2, 'fixable']);
  assert.deepEqual(w.failures.map((f) => [f.jobs[0], f.class, f.command]), [['Lint', 'code', LINT_COMMAND]]);
  // Round 2 is a whole round: repro, fix, check, push. (Green here: the lint failure was invented.)
  const r = H.repro({ run: u.run });
  assert.equal(r.round, 2);
  assert.equal(r.results[0].result, 'not_reproduced');
  assert.equal(r.verdict, 'rerun_offered');
});

test('watch: the same failure red again after the push is stuck; rounds are capped', async () => {
  const t = await fixed('ci-stuck-');
  const p = H.push({ run: t.run, confirmed: true });
  t.app.at(p.commit, [row('Unit tests', 'FAILURE', { job: 21, run: 200 })], { 21: testJob() });
  const w = await H.watch({ run: t.run });
  assert.equal(w.verdict, 'stuck');
  assert.match(w.next, /The fix did not work in CI/);
  assert.equal(w.failures.length, 1);
  await assert.rejects(H.watch({ run: t.run }), /is over/);

  const u = await fixed('ci-gaveup-', { config: { max_rounds: 1 } });
  const q = H.push({ run: u.run, confirmed: true });
  u.app.at(q.commit, [row('Lint', 'FAILURE', { job: 22, run: 200 })], { 22: lintJob() });
  const g = await H.watch({ run: u.run });
  assert.equal(g.verdict, 'gave_up');
  assert.match(g.next, /1 round spent and CI is still red/);
});

test('watch: no check on the pushed commit after five minutes is said as CI not starting; a long wait times out', async () => {
  const t = await fixed('ci-noci-');
  const p = H.push({ run: t.run, confirmed: true });
  t.app.at(p.commit, []);
  const age = (minutes) => {
    const run = S.loadRun(t.run);
    run.watch.started_at = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    S.saveRun(run);
  };
  age(6);
  const w = await H.watch({ run: t.run });
  assert.equal(w.verdict, 'timed_out');
  assert.match(w.note, /CI did not start/);
  t.app.at(p.commit, [row('Unit tests', '', { job: 21, run: 200, status: 'QUEUED' })]);
  age(50);
  const late = await H.watch({ run: t.run });
  assert.equal(late.verdict, 'timed_out');
  assert.match(late.note, /1 check still running after 50 minutes/);
});

// ---------------------------------------------------------------- rerun
async function infraOnly(prefix) {
  const app = use(makeApp(prefix));
  app.checks(app.head, [row('E2E', 'FAILURE', { job: 13 }), row('Lint', 'SUCCESS', { job: 12 })], { 13: { log: actionsLog({ script: 'pnpm e2e', errors: ['request to https://registry.npmjs.org failed, reason: read ECONNRESET'] }), annotations: [] } });
  const s = await H.start({ repo: app.repo, args: ['7'] });
  return { app, s, run: s.run_id };
}
const reruns = (app) => (existsSync(`${app.stubFile}.reruns.jsonl`) ? readFileSync(`${app.stubFile}.reruns.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l).job) : []);

test('rerun: offered for a failure of the runner, made after a yes, once per job', async () => {
  const t = await infraOnly('ci-rerun-');
  assert.equal(t.s.verdict, 'rerun_offered');
  assert.equal(t.s.workspace, null, 'nothing to fix: no workspace');
  const no = H.rerun({ run: t.run });
  assert.match(no.refused, /needs --confirmed/);
  assert.deepEqual(no.would_rerun, [{ failure: 'f1', job: 'E2E' }]);
  assert.deepEqual(reruns(t.app), []);
  const yes = H.rerun({ run: t.run, confirmed: true });
  assert.equal(yes.rerun, true);
  assert.deepEqual(reruns(t.app), ['13']);
  // GitHub still shows the old result of the job: not a result of the rerun.
  assert.equal((await H.watch({ run: t.run })).verdict, 'pending');
  t.app.checks(t.app.head, [row('E2E', 'SUCCESS', { job: 43 }), row('Lint', 'SUCCESS', { job: 12 })]);
  const g = await H.watch({ run: t.run });
  assert.equal(g.verdict, 'green');
  assert.equal(g.after, 'rerun');
});

test('rerun: red again after its rerun is the code\'s from then on, and is not rerun twice', async () => {
  const t = await infraOnly('ci-rerun-red-');
  H.rerun({ run: t.run, confirmed: true });
  t.app.checks(t.app.head, [row('E2E', 'FAILURE', { job: 43 }), row('Lint', 'SUCCESS', { job: 12 })], { 43: t.app.stub.jobs[13] });
  const w = await H.watch({ run: t.run });
  assert.equal(w.verdict, 'red');
  assert.equal(w.round, 1, 'a rerun is not a round');
  assert.equal(w.failures[0].class, 'code');
  assert.match(w.failures[0].evidence, /red again after a rerun/);
  assert.equal(w.then, 'fixable');
  assert.ok(w.workspace.path, 'now there is something to fix, and somewhere to fix it');
  assert.match(H.rerun({ run: t.run, confirmed: true }).refused, /nothing to run again/);
  assert.deepEqual(reruns(t.app), ['13']);
});

test('rerun: refused while the round has a fix to push', async () => {
  const app = use(makeApp('ci-rerun-fix-'));
  app.checks(app.head, [row('Unit tests', 'FAILURE', { job: 11 }), row('E2E', 'TIMED_OUT', { job: 13 })], { 13: { log: actionsLog({ script: 'pnpm e2e', exit: 0 }), annotations: [] } });
  const s = await H.start({ repo: app.repo, args: ['7'] });
  H.repro({ run: s.run_id });
  write(app.repo, 'src/price.mjs', GOOD);
  const c = await H.check({ run: s.run_id, subject: SUBJECT, edits: FIX });
  assert.equal(c.verdict, 'fixed');
  assert.match(c.restate.join('\n'), /f2 is not fixed by this commit: E2E \(infra\)/);
  assert.match(H.rerun({ run: s.run_id, confirmed: true }).refused, /the push runs every check again/);
  assert.deepEqual(reruns(app), []);
});

// ---------------------------------------------------------------- status, drop
test('status lists the runs that are not over; drop removes a worktree and nothing of the user\'s', async () => {
  const t = await started('ci-drop-', { on: 'main' });
  const st = await H.start({ repo: t.app.repo, args: ['status'] });
  assert.deepEqual(st.runs.map((r) => [r.run_id, r.pull_request, r.verdict, r.workspace]), [[t.run, 7, 'fixable', 'worktree']]);
  const d = await H.start({ repo: t.app.repo, args: ['drop', t.run] });
  assert.equal(d.dropped, true);
  assert.equal(d.worktree_removed, true);
  assert.ok(!existsSync(t.ws));
  assert.deepEqual((await H.start({ repo: t.app.repo, args: ['status'] })).runs, []);
  assert.equal(H.drop({ run: t.run }).dropped, false);
  assert.throws(() => H.drop({ run: '../../etc' }), /unknown run/);

  const here = await started('ci-drop-here-');
  H.repro({ run: here.run });
  write(here.ws, 'src/price.mjs', GOOD);
  assert.match(H.drop({ run: here.run }).note, /Changes in your checkout are yours and stay/);
  assert.equal(readFileSync(join(here.app.repo, 'src/price.mjs'), 'utf8'), GOOD);
  // A new start for the same pull request ends the run before it.
  const a = await started('ci-super-', { on: 'main' });
  const again = await H.start({ repo: a.app.repo, args: ['7'] });
  assert.notEqual(again.run_id, a.run);
  assert.ok(!existsSync(a.ws));
  assert.equal(again.kept_worktrees, undefined);
  assert.throws(() => H.repro({ run: a.run }), /a newer run was started/);
  // Unless its worktree holds a fix nobody pushed: then it stays, and is named.
  H.repro({ run: again.run_id });
  write(again.workspace.path, 'src/price.mjs', GOOD);
  const third = await H.start({ repo: a.app.repo, args: ['7'] });
  assert.deepEqual(third.kept_worktrees, [{ run_id: again.run_id, worktree: again.workspace.path }]);
  assert.equal(readFileSync(join(again.workspace.path, 'src/price.mjs'), 'utf8'), GOOD);
  assert.throws(() => H.repro({ run: again.run_id }), /a newer run was started/);
  // Dropping a run whose worktree holds edits says which files went with it.
  H.repro({ run: third.run_id });
  write(third.workspace.path, 'src/price.mjs', GOOD);
  assert.deepEqual(H.drop({ run: third.run_id }).discarded, ['src/price.mjs']);
});

// ---------------------------------------------------------------- Jev
const jevStub = (answers) => {
  const f = join(mkdtempSync(join(tmpdir(), 'ci-jev-')), 'jev.json');
  writeFileSync(f, JSON.stringify(answers));
  process.env.FIX_CI_JEV_STUB = f;
  return f;
};
const jevOff = () => {
  delete process.env.FIX_CI_JEV_STUB;
  delete process.env.FIX_CI_TEST_CALIBRATED;
  process.env.FIX_CI_JEV = 'off';
};
const cases = () => C.readJsonl(S.jevLog());

test('Jev in shadow: cases are logged, nothing is decided, and no code or log is sent', async () => {
  const stub = jevStub({ 'transient__*': 0.95, 'weakens__*': 0.95, 'matches__*': 0.05 });
  process.env.FIX_CI_JEV = 'shadow';
  try {
    const t = await fixed('ci-jev-shadow-');
    assert.equal(t.s.jev, 'shadow');
    assert.equal(t.s.failures[0].rerun, undefined, 'a number that decides nothing offers nothing');
    assert.equal(t.c.verdict, 'fixed');
    const logged = cases().filter((c) => c.type === 'case' && c.skill === 'fix-ci');
    assert.deepEqual([...new Set(logged.map((c) => c.question))].sort(), ['failure_is_transient', 'fix_matches_failure', 'fix_weakens_check']);
    assert.ok(logged.every((c) => c.acted === false && c.mode === 'shadow'));
    const sent = readFileSync(`${stub}.sent.jsonl`, 'utf8');
    assert.match(sent, /"job":"Unit tests"/);
    assert.match(sent, /price\(\) tripled the amount/);
    for (const secret of ['n * 2', 'n * 3', 'setup line', '6 !== 4']) assert.ok(!sent.includes(secret), `sent ${secret}`);
  } finally {
    jevOff();
  }
});

test('Jev switched on can add a question and an offer, never take one away', async () => {
  jevStub({ 'transient__*': 0.95, 'weakens__*': 0.95, 'matches__*': 0.9 });
  process.env.FIX_CI_JEV = 'live';
  process.env.FIX_CI_TEST_CALIBRATED = 'failure_is_transient,fix_weakens_check';
  try {
    const t = await started('ci-jev-live-');
    assert.equal(t.s.verdict, 'fixable', 'still the code\'s to fix');
    assert.equal(t.s.failures[0].rerun, 'offered');
    assert.match(t.s.failures[0].jev, /passes when run again/);
    H.repro({ run: t.run });
    write(t.ws, 'src/price.mjs', GOOD);
    const c = await H.check({ run: t.run, subject: SUBJECT, edits: FIX });
    assert.equal(c.verdict, 'needs_decision');
    assert.deepEqual(c.asks, [{ id: 'jev:src/price.mjs', flag: 'jev', file: 'src/price.mjs', reason: 'Jev reads this edit as weakening the check' }]);
    H.decide({ run: t.run, id: 'jev:src/price.mjs', confirmed: true });
    assert.equal((await H.check({ run: t.run, subject: SUBJECT, edits: FIX })).verdict, 'fixed');
  } finally {
    jevOff();
  }
});

test('Jev: what a rerun showed is the right answer for failure_is_transient', async () => {
  jevStub({ 'transient__*': 0.8 });
  process.env.FIX_CI_JEV = 'shadow';
  try {
    const t = await infraOnly('ci-jev-label-');
    H.rerun({ run: t.run, confirmed: true });
    t.app.checks(t.app.head, [row('E2E', 'SUCCESS', { job: 43 }), row('Lint', 'SUCCESS', { job: 12 })]);
    await H.watch({ run: t.run });
    const mine = cases().filter((c) => c.skill === 'fix-ci' && c.question === 'failure_is_transient');
    const label = mine.filter((c) => c.type === 'label').at(-1);
    assert.deepEqual([label.label, label.source], [true, 'rerun']);
    assert.ok(mine.some((c) => c.type === 'case' && c.case === label.case));
  } finally {
    jevOff();
  }
});

test('a degraded Jev changes nothing', async () => {
  jevStub({ __degraded: true });
  process.env.FIX_CI_JEV = 'live';
  try {
    const t = await fixed('ci-jev-down-');
    assert.equal(t.s.jev, 'degraded');
    assert.equal(t.c.verdict, 'fixed');
  } finally {
    jevOff();
  }
});
