// A small app whose `main` deploys staging on push and whose `production`
// branch is fed by promotion pull requests, built in a temp folder, plus the
// `gh` answers that go with it. Shared by promote.test.mjs and probe.test.mjs.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
export const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
export const write = (repo, file, text) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
};
export const commit = (repo, message) => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
};
export const sha = (repo, ref) => git(repo, 'rev-parse', ref);

// A feature branch merged into `into` the way GitHub writes it. -> the new tip of `into`
export function mergePr(repo, n, title, files, into = 'main') {
  git(repo, 'checkout', '-q', '-b', `feat-${n}`, into);
  for (const [file, text] of Object.entries(files)) write(repo, file, text);
  commit(repo, title);
  git(repo, 'checkout', '-q', into);
  git(repo, 'merge', '-q', '--no-ff', `feat-${n}`, '-m', `Merge pull request #${n} from acme/feat-${n}\n\n${title}`);
  return sha(repo, 'HEAD');
}
// A squash merge into `into`. -> the new tip
export function squashPr(repo, n, title, files, into = 'main') {
  git(repo, 'checkout', '-q', into);
  for (const [file, text] of Object.entries(files)) write(repo, file, text);
  return commit(repo, `${title} (#${n})`);
}
// A promotion merged the way GitHub writes it. -> the new tip of `to`
export function promoteByHand(repo, n, from = 'main', to = 'production') {
  git(repo, 'checkout', '-q', to);
  git(repo, 'merge', '-q', '--no-ff', from, '-m', `Merge pull request #${n} from acme/${from}\n\nPromote`);
  const tip = sha(repo, 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  return tip;
}

export const STAGES = [
  { env: 'staging', branch: 'main', how: 'push', deploy_workflow: 'deploy.yml' },
  { env: 'production', branch: 'production', how: 'pr', from: 'staging', deploy_workflow: 'deploy-production.yml' },
];
export const setConfig = (repo, name, value) => {
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', name), JSON.stringify(value));
};

// -> { tmp, repo, stubFile, setStub(extra), calls() }
// `production` is one promotion behind `main`. With `config`, .claude/promote.json holds STAGES.
export function makeApp(prefix = 'pro-', { config = true } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const repo = join(tmp, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'db/migrations/0000_init.sql', 'CREATE TABLE users (id uuid PRIMARY KEY, legacy_id text, email text);\n');
  write(repo, 'db/migrations/meta/_journal.json', `${JSON.stringify({ version: '7', dialect: 'postgresql', entries: [{ idx: 0, tag: '0000_init' }] }, null, 2)}\n`);
  write(repo, 'src/app.ts', 'export const a = 1;\n');
  write(repo, '.github/workflows/deploy.yml', 'name: Deploy staging\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    environment: staging\n    steps:\n      - run: ./deploy.sh\n');
  write(repo, '.github/workflows/deploy-production.yml', 'name: Deploy production\non:\n  push:\n    branches:\n      - production\njobs:\n  deploy:\n    environment:\n      name: production\n    steps:\n      - uses: docker/build-push-action@v5\n        with:\n          push: true\n');
  write(repo, '.github/workflows/ci.yml', 'name: CI\non: [push, pull_request]\njobs:\n  test:\n    steps:\n      - run: npm test\n');
  write(repo, '.gitignore', '.claude/\n');
  commit(repo, 'init');
  git(repo, 'branch', 'production');
  mergePr(repo, 3, 'First feature', { 'src/one.ts': 'export const one = 1;\n' });
  promoteByHand(repo, 4);
  mergePr(repo, 11, 'Add a settings page', { 'src/settings.ts': 'export const s = 1;\n' });
  squashPr(repo, 12, 'Fix a typo', { 'src/app.ts': 'export const a = 2;\n' });
  if (config) setConfig(repo, 'promote.json', { stages: STAGES });

  const stubFile = join(tmp, 'gh.json');
  let current = {};
  const setStub = (extra = {}) => {
    current = { slug: 'acme/app', ...extra };
    writeFileSync(stubFile, JSON.stringify(current));
  };
  const patchStub = (extra) => setStub({ ...current, ...extra });
  setStub();
  return { tmp, repo, stubFile, setStub, patchStub };
}

// What a healthy source looks like to GitHub: checks green, deploy.yml ran this commit.
export const green = (source) => ({
  checks: { [source]: [{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'success' }] },
  runs: { [source]: [{ id: 1, name: 'Deploy staging', path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/app/actions/runs/1' }] },
});
export const prStub = (n, head, extra = {}) => ({ number: n, state: 'OPEN', title: 'Promote staging to production', url: `https://github.com/acme/app/pull/${n}`, baseRefName: 'production', headRefName: 'main', headRefOid: head, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...extra });
