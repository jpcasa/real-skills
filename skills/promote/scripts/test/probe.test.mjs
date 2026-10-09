import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeApp, git, write, commit, mergePr, promoteByHand, setConfig } from './fixture.mjs';

const { probe, readWorkflow } = await import('../lib/probe.mjs');
const Q = await import('../lib/questions.mjs');
const { isProduction } = await import('../lib/config.mjs');

const shape = (p) => p.stages.map((s) => [s.env, s.branch, s.how, s.from ?? null, Boolean(s.production)]);

test('a workflow\'s push branches are read in both spellings, and a step\'s own `push:` is not a trigger', () => {
  assert.deepEqual(readWorkflow('a.yml', 'on:\n  push:\n    branches: [main, "release/*"]\n').push, ['main', 'release/*']);
  assert.deepEqual(readWorkflow('a.yml', 'on:\n  push:\n    branches:\n      - production\n      - \'prod\'\n    paths:\n      - src/**\n').push, ['production', 'prod']);
  assert.deepEqual(readWorkflow('a.yml', 'on: [push, pull_request]\n').push, ['*']);
  assert.deepEqual(readWorkflow('a.yml', 'on:\n  push:\n    tags: [v*]\n').push, ['*']);
  const dispatch = readWorkflow('deploy.yml', 'on:\n  workflow_dispatch:\njobs:\n  d:\n    environment: production\n    steps:\n      - with:\n          push: true\n');
  assert.deepEqual([dispatch.push, dispatch.environments, dispatch.deploys], [null, ['production'], true]);
  assert.deepEqual(readWorkflow('x.yml', 'on:\n  push:\njobs:\n  d:\n    environment:\n      name: staging\n    env:\n      A: ${{ secrets.A }}\n    environment: ${{ inputs.env }}\n').environments, ['staging']);
});

test('main + production: main is staging, production is promoted from it by pull request', () => {
  const app = makeApp('pro-probe-', { config: false });
  const p = probe(app.repo);
  assert.equal(p.needs_setup, true);
  assert.deepEqual(shape(p), [['staging', 'main', 'push', null, false], ['production', 'production', 'pr', 'staging', true]]);
  assert.deepEqual(p.lineage, [{ from: 'main', into: 'production', merges: 1, of: 1 }]);
  assert.deepEqual(p.stages.map((s) => s.deploy_workflow), ['deploy.yml', 'deploy-production.yml']);
  assert.ok(p.stages[1].why.some((w) => /1 of the last 1 merges on production came from main/.test(w)));
  // The direction is read from whose tip was merged, so a feature merge into main does not make production feed main.
  assert.ok(!p.lineage.some((f) => f.into === 'main'));
  assert.equal(p.promotable, 1);
});

test('main + staging + production: the chain follows the merge history', () => {
  const app = makeApp('pro-probe3-', { config: false });
  const { repo } = app;
  git(repo, 'branch', 'staging', 'main');
  mergePr(repo, 20, 'More', { 'src/more.ts': 'export const m = 1;\n' });
  promoteByHand(repo, 21, 'main', 'staging');
  mergePr(repo, 25, 'Even more', { 'src/even.ts': 'export const e = 1;\n' });
  promoteByHand(repo, 26, 'main', 'production');
  write(repo, 'vercel.json', '{}\n');
  commit(repo, 'vercel');
  // Production has taken main's tip twice and staging's never: it is fed from main, past staging.
  const p = probe(repo);
  assert.deepEqual(shape(p), [['preview', 'main', 'push', null, false], ['staging', 'staging', 'pr', 'preview', false], ['production', 'production', 'pr', 'preview', true]]);
  assert.deepEqual(p.hosting, ['vercel']);
  // Once production is fed from staging, that is what the history says.
  promoteByHand(repo, 27, 'staging', 'production');
  promoteByHand(repo, 28, 'main', 'staging');
  promoteByHand(repo, 29, 'staging', 'production');
  assert.equal(probe(repo).stages.find((s) => s.env === 'production').from, 'staging');
});

test('staging + main, no production branch: main is production', () => {
  const app = makeApp('pro-probe2-', { config: false });
  const { repo } = app;
  git(repo, 'branch', '-D', 'production');
  git(repo, 'branch', 'staging', 'main');
  const p = probe(repo);
  assert.deepEqual(shape(p), [['staging', 'staging', 'push', null, false], ['production', 'main', 'pr', 'staging', true]]);
  assert.ok(p.stages[1].why.some((w) => /no merge history between them yet/.test(w)));
});

test('one branch: one stage, nothing to promote, and it says so', () => {
  const app = makeApp('pro-probe1-', { config: false });
  git(app.repo, 'branch', '-D', 'production');
  const p = probe(app.repo);
  assert.equal(p.promotable, 0);
  assert.match(p.note, /nothing to promote between/);
});

test('what another skill already knows is evidence, and an invalid own file is reported, not thrown', () => {
  const app = makeApp('pro-probek-', { config: false });
  setConfig(app.repo, 'check-infra-and-migrations.json', { migrations: [], targets: [{ branch: 'main', env: 'uat' }, { branch: 'production', env: 'live' }] });
  setConfig(app.repo, 'wtf.json', { release: { main_branch: 'main', production_branch: 'production' } });
  let p = probe(app.repo);
  assert.deepEqual(p.stages.map((s) => [s.env, s.branch]), [['uat', 'main'], ['live', 'production']]);
  assert.equal(p.stages[1].production, true);
  assert.equal(p.reuse.release, '.claude/wtf.json');
  setConfig(app.repo, 'promote.json', { stages: [{ env: 'x', how: 'teleport' }] });
  p = probe(app.repo);
  assert.match(p.config_error, /how must be one of/);
  assert.equal(p.needs_setup, true);
});

test('Jev sees names only, and the confirmed stage list labels the cases', () => {
  const app = makeApp('pro-probej-', { config: false });
  const p = probe(app.repo);
  p.workflows.push({ file: 'https://evil.example.com/x.yml', push_branches: ['main'], environments: ['app.internal.example.com'], deploys: true });
  const built = Q.build(p, 'app');
  const sent = JSON.stringify({ state: built.state, questions: built.questions });
  assert.ok(!/https?:|example\.com/.test(sent), 'no link and no host leaves');
  assert.deepEqual([...new Set(built.cases.map((c) => c.question))].sort(), Object.keys(Q.THRESHOLDS).sort());
  assert.equal(built.cases.filter((c) => c.question === 'env_is_production').length, 2);
  assert.ok(Object.keys(built.questions).length <= 2 * Q.MAX_PAIRS + 5);

  const confirmed = [{ env: 'staging', branch: 'main', how: 'push' }, { env: 'production', branch: 'production', how: 'pr', from: 'staging' }];
  const cases = built.cases.map((c) => ({ ...c, p: 0.7 }));
  const ls = Q.labels(cases, confirmed, (s) => isProduction({}, s));
  const of = (q, pick) => ls.find((l) => l.case === cases.find((c) => c.question === q && pick(c)).case).label;
  assert.equal(of('branch_deploys_env', (c) => c.branch === 'main' && c.env === 'staging'), true);
  assert.equal(of('branch_deploys_env', (c) => c.branch === 'production' && c.env === 'staging'), false);
  assert.equal(of('env_promotes_from', (c) => c.env === 'production' && c.from === 'staging'), true);
  assert.equal(of('env_promotes_from', (c) => c.env === 'staging' && c.from === 'production'), false);
  assert.equal(of('env_is_production', (c) => c.env === 'production'), true);
  assert.equal(of('env_is_production', (c) => c.env === 'staging'), false);
  // An environment the user renamed has no right answer here.
  const renamed = Q.labels(cases, [{ env: 'preview', branch: 'main', how: 'push' }, confirmed[1]], (s) => isProduction({}, s));
  assert.ok(!renamed.some((l) => l.case === cases.find((c) => c.question === 'env_is_production' && c.env === 'staging').case));
  assert.ok(renamed.length < ls.length);
});
