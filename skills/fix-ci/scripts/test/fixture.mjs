// A small app with a bare remote, where pull request #7 (`feat` into `main`)
// has one red check: `node --test` fails because the pull request broke
// price(). Running the tests also leaves a file behind (last-run.txt), as a
// coverage tool would. Git and the commands are real throughout; only `gh` is
// answered from a stub, with job logs written in the form GitHub Actions uses.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
export const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
export const write = (repo, file, content) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
};
export const commit = (repo, message) => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
};
export const sha = (repo, ref) => git(repo, 'rev-parse', ref);

export const GOOD = 'export const price = (n) => n * 2;\n';
export const BROKEN = 'export const price = (n) => n * 3;\n';
export const TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { price } from '../src/price.mjs';

writeFileSync('last-run.txt', 'ran\\n');

test('price doubles the amount', () => {
  assert.equal(price(2), 4, 'price doubles the amount');
});
test('price of nothing is nothing', () => {
  assert.equal(price(0), 0);
});
`;
// Red when a source file says `var`.
export const LINT = `import { readdirSync, readFileSync } from 'node:fs';
const bad = readdirSync('src').filter((f) => /\\bvar /.test(readFileSync('src/' + f, 'utf8')));
for (const f of bad) console.log('src/' + f + ': no-var: use const or let');
process.exit(bad.length ? 1 : 0);
`;
// No path: Node 20 and Node 22 read a folder argument differently, and both find test/ by themselves.
export const TEST_COMMAND = 'node --test';
export const LINT_COMMAND = 'node lint.mjs';

const T = '2026-10-12T21:19:25.7201869Z ';
const stamp = (lines) => lines.map((l) => `${T}${l}`).join('\n');
// A job log as the runner writes it: setup, the failed step's group, its output, the errors.
export function actionsLog({ script, output = [], errors = [], uses = null, exit = 1 }) {
  const lines = [].concat(script || []);
  return stamp([
    "Current runner version: '2.337.0'",
    '##[group]Run actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd',
    'with:',
    '  fetch-depth: 1',
    '##[endgroup]',
    ...Array.from({ length: 80 }, (_, i) => `setup line ${i}`),
    ...(uses
      ? [`##[group]Run ${uses}`, 'with:', '  token: ***', '##[endgroup]']
      : [`##[group]Run ${lines[0]}`, ...lines.map((l) => `\u001b[36;1m${l}\u001b[0m`), 'shell: /usr/bin/bash -e {0}', 'env:', '  CI: true', '##[endgroup]']),
    ...output,
    ...errors.map((e) => `##[error]${e}`),
    ...(exit ? [`##[error]Process completed with exit code ${exit}.`] : []),
    'Post job cleanup.',
    'Cleaning up orphan processes',
  ]);
}
export const note = (path, line, message, title = '') => ({ path, start_line: line, annotation_level: 'failure', title, message });
export const EXIT_NOTE = { path: '.github', start_line: 12, annotation_level: 'failure', title: '', message: 'Process completed with exit code 1.' };

// The failed unit-test job of the fixture.
export const testJob = (extra = {}) => ({
  log: actionsLog({
    script: TEST_COMMAND,
    output: ['\u001b[31m✖ price doubles the amount\u001b[0m (1.2ms)', "  AssertionError [ERR_ASSERTION]: price doubles the amount", '  6 !== 4', '    at TestContext.<anonymous> (test/price.test.mjs:9:10)', 'ℹ tests 2', 'ℹ pass 1', 'ℹ fail 1'],
    errors: ['AssertionError [ERR_ASSERTION]: price doubles the amount'],
  }),
  annotations: [note('test/price.test.mjs', 9, 'AssertionError [ERR_ASSERTION]: price doubles the amount\n\n6 !== 4', 'test/price.test.mjs > price doubles the amount'), EXIT_NOTE],
  ...extra,
});
export const lintJob = (file = 'src/price.mjs') => ({
  log: actionsLog({ script: LINT_COMMAND, output: [`${file}: no-var: use const or let`], errors: [`${file}: no-var: use const or let`] }),
  annotations: [note(file, 1, 'no-var: use const or let', 'no-var'), EXIT_NOTE],
});

// One row of a pull request's check rollup.
export const row = (name, conclusion, { job, run = 100, workflow = 'Quality', status = 'COMPLETED' } = {}) => ({
  __typename: 'CheckRun', name, workflowName: workflow, status, conclusion: status === 'COMPLETED' ? conclusion : '',
  detailsUrl: `https://github.com/acme/app/actions/runs/${run}/job/${job}`,
});
export const statusRow = (context, state) => ({ __typename: 'StatusContext', context, state, targetUrl: `https://ci.example.com/${context}` });

export const setConfig = (repo, value, name = 'fix-ci.json') => write(repo, `.claude/${name}`, JSON.stringify(value));

export function prStub(head, extra = {}) {
  return { number: 7, state: 'OPEN', title: 'Triple pricing', url: 'https://github.com/acme/app/pull/7', baseRefName: 'main', headRefName: 'feat', headRefOid: head, isCrossRepository: false, mergeable: 'MERGEABLE', author: { login: 'dev' }, ...extra };
}

// Built once per process, then copied: every test gets its own remote and clone.
let template = null;
function build() {
  const tmp = mkdtempSync(join(tmpdir(), 'ci-template-'));
  const remote = join(tmp, 'remote.git');
  const repo = join(tmp, 'app');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: { ...process.env, ...GIT_ENV } });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', remote);
  write(repo, '.gitignore', '.claude/\nnode_modules/\n');
  write(repo, 'package.json', `${JSON.stringify({ name: 'app', private: true, scripts: { test: TEST_COMMAND, lint: LINT_COMMAND, ship: 'vercel deploy --prod' }, dependencies: {} }, null, 2)}\n`);
  write(repo, 'src/price.mjs', GOOD);
  write(repo, 'test/price.test.mjs', TEST);
  write(repo, 'lint.mjs', LINT);
  write(repo, 'run-tests.sh', `${TEST_COMMAND}\n`);
  commit(repo, 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'feat');
  write(repo, 'src/price.mjs', BROKEN);
  const broken = commit(repo, 'Triple the price');
  git(repo, 'push', '-q', 'origin', 'feat');
  return { tmp, broken, base: sha(repo, 'main') };
}

// opts.on: the branch the checkout is left on ('feat' by default, so the checkout can be the workspace).
// opts.config: .claude/fix-ci.json for the checkout (untracked: the user's own).
export function makeApp(prefix, opts = {}) {
  template ||= build();
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  cpSync(template.tmp, tmp, { recursive: true });
  const remote = join(tmp, 'remote.git');
  const repo = join(tmp, 'app');
  git(repo, 'remote', 'set-url', 'origin', remote);
  if (opts.on && opts.on !== 'feat') git(repo, 'checkout', '-q', opts.on);
  if (opts.config) setConfig(repo, opts.config);
  const head = template.broken;
  const stubFile = join(tmp, 'gh.json');
  const stub = {
    slug: 'acme/app', current_pr: 7, prs: { 7: prStub(head) }, mine: [],
    checks: { [head]: [row('Unit tests', 'FAILURE', { job: 11 }), row('Lint', 'SUCCESS', { job: 12 })] },
    jobs: { 11: testJob() }, base: {},
  };
  const app = {
    tmp, remote, repo, head, base: template.base, stubFile, stub,
    save: () => writeFileSync(stubFile, JSON.stringify(stub)),
    // The checks of a commit, and the jobs behind them.
    checks(commitSha, rows, jobs = {}) {
      stub.checks[commitSha] = rows;
      Object.assign(stub.jobs, jobs);
      app.save();
    },
    // GitHub's view after a push: the pull request is at that commit, with these checks.
    at(commitSha, rows, jobs = {}) {
      stub.prs[7].headRefOid = commitSha;
      app.checks(commitSha, rows, jobs);
    },
  };
  app.save();
  return app;
}

// A commit pushed to a branch of the remote, from a scratch clone: the app's own checkout does not move.
// opts.force: paths to add although .gitignore names them.
export function pushTo(app, branch, files, message, opts = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'ci-push-'));
  execFileSync('git', ['clone', '-q', '-b', branch, app.remote, scratch], { env: { ...process.env, ...GIT_ENV } });
  for (const [file, content] of Object.entries(files)) content === null ? rmSync(join(scratch, file)) : write(scratch, file, content);
  for (const path of opts.force || []) git(scratch, 'add', '-f', path);
  const tipSha = commit(scratch, message);
  git(scratch, 'push', '-q', 'origin', branch);
  return tipSha;
}
