import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeApp, branch, git, journal } from './fixture.mjs';

const app = makeApp('cim-live-');
process.env.CHECK_INFRA_STATE_DIR = join(app.tmp, 'state');
process.env.CHECK_INFRA_GH_STUB = app.stubFile;
process.env.REAL_SKILLS_CALIBRATION_DIR = join(app.tmp, 'calibration');
delete process.env.REAL_SKILLS_CALIBRATION;
process.env.CHECK_INFRA_JEV = 'off';

const H = await import('../check.mjs');
const S = await import('../lib/state.mjs');
const L = await import('../lib/live.mjs');

const { repo, tmp } = app;
// What the "environment" answers: files outside the repo, so the tree stays clean.
const answer = (name, text) => writeFileSync(join(tmp, name), text);
const setLive = (live, extra = {}) => {
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude/check-infra-and-migrations.json'), JSON.stringify({
    migrations: [{ tool: 'drizzle', dir: 'db/migrations', applied: 'before_deploy' }],
    infra: [{ tool: 'cdk', paths: ['infra/**'] }],
    targets: [{ branch: 'main', env: 'staging' }, { branch: 'production', env: 'production' }],
    live: { staging: live },
    ...extra,
  }));
};
const cat = (name) => `cat ${JSON.stringify(join(tmp, name))}`;
const start = (...args) => H.start({ repo, args });
const sha256 = (file) => createHash('sha256').update(readFileSync(join(repo, file))).digest('hex');

const CDK_DIFF = `Stack DataStack
IAM Statement Changes
┌───┬──────────┬────────┐
│   │ Resource │ Effect │
└───┴──────────┴────────┘
Resources
[-] AWS::S3::Bucket Uploads UploadsBucket5E5E9B64 destroy
[~] AWS::RDS::DBInstance Main MainDB7A1B2C3D
 └─ [~] DBInstanceClass (requires replacement)
     ├─ [-] db.t3.medium
     └─ [+] db.t3.small
[~] AWS::Lambda::Function Worker Worker0A1B2C3D
 └─ [~] Timeout
[~] AWS::ECS::Service Api ApiService9F8E7D6C replace
[-] AWS::Logs::LogGroup Old OldLogs1234 orphan
[+] AWS::SQS::Queue Jobs JobsQueue1A2B3C4D

✨  Number of stacks with differences: 1
`;
const TF_PLAN = `Terraform will perform the following actions:

  # aws_db_instance.main must be replaced
-/+ resource "aws_db_instance" "main" {
  # module.storage.aws_s3_bucket.logs[0] will be destroyed
  - resource "aws_s3_bucket" "logs" {
  # aws_lambda_function.worker will be updated in-place
  ~ resource "aws_lambda_function" "worker" {
  # aws_iam_role.old will be destroyed
  # aws_sqs_queue.jobs will be created

Plan: 2 to add, 1 to change, 3 to destroy.
`;

// ---------------------------------------------------------------- parsing
test('the command guard: a live command reads', () => {
  for (const ok of ['pnpm --dir infra cdk diff --no-color', 'terraform plan -no-color', "psql \"$RO_URL\" -At -c 'select hash from drizzle.__drizzle_migrations'", 'supabase migration list --linked']) assert.equal(L.commandRefusal(ok), null, ok);
  for (const [bad, word] of [
    ['cdk deploy --all', 'deploy'], ['terraform apply', 'apply'], ['supabase db push', 'push'], ['pnpm drizzle-kit migrate', 'migrate'], ['pulumi up', 'up'], ['terraform plan && terraform destroy', 'destroy'],
    ['bundle exec rails db:migrate', 'migrate'], ['npx knex migrate:latest', 'migrate'], ['pnpm db:push', 'push'], ['alembic upgrade head', 'upgrade'], ['terraform import aws_s3_bucket.a b', 'import'],
    ['aws rds delete-db-instance --db-instance-identifier x', 'delete'], ['psql "$URL" -c "DROP TABLE users"', 'DROP'], ["psql \"$URL\" -c 'truncate users'", 'truncate'], ['supabase db reset --linked', 'reset'],
  ]) assert.match(L.commandRefusal(bad), new RegExp(`contains "${word}"`), bad);
  assert.match(L.commandRefusal(''), /non-empty/);
});

test('a cdk diff: destroys and replaces, stateful or not', () => {
  const p = L.parsePlan(`\x1b[31m${CDK_DIFF}\x1b[0m`);
  assert.equal(p.tool, 'cdk');
  assert.deepEqual(p.counts, { create: 1, update: 1, destroy: 1, replace: 2, orphan: 1 });
  assert.deepEqual(L.planFindings(p).map((f) => [f.rule, f.normalized]), [
    ['plan_destroys_stateful', 'plan: destroy AWS::S3::Bucket Uploads'],
    ['plan_replaces_stateful', 'plan: replace AWS::RDS::DBInstance Main'],
    ['plan_replaces_resource', 'plan: replace AWS::ECS::Service Api'],
  ]);
  assert.deepEqual(L.parsePlan('Stack DataStack\nThere were no differences\n'), { tool: 'cdk', counts: { create: 0, update: 0, destroy: 0, replace: 0, orphan: 0 }, resources: [] });
});

test('a terraform plan: the same, with module addresses', () => {
  const p = L.parsePlan(TF_PLAN);
  assert.equal(p.tool, 'terraform');
  assert.deepEqual(p.counts, { create: 1, update: 1, destroy: 2, replace: 1, orphan: 0 });
  assert.deepEqual(L.planFindings(p).map((f) => [f.rule, f.normalized]), [
    ['plan_replaces_stateful', 'plan: replace aws_db_instance main'],
    ['plan_destroys_stateful', 'plan: destroy aws_s3_bucket logs'],
    ['plan_destroys_resource', 'plan: destroy aws_iam_role old'],
  ]);
  assert.equal(L.parsePlan('No changes. Your infrastructure matches the configuration.').tool, 'terraform');
  assert.equal(L.parsePlan('Error: cannot find module ./bin/infra').tool, null);
});

test('applied lists: by name, by version, by content hash', () => {
  const migs = [{ file: 'm/0000_init.sql', name: '0000_init.sql', content: 'a' }, { file: 'm/0001_next.sql', name: '0001_next.sql', content: 'b' }];
  assert.deepEqual(L.matchApplied(L.parseApplied('0000_init\n'), migs), { applied: ['m/0000_init.sql'], pending: ['m/0001_next.sql'], by: 'name', ahead: 0, no_match: false });
  const versions = L.matchApplied(L.parseApplied('0000 | init\n0007 | hotfix\n'), migs);
  assert.deepEqual([versions.by, versions.pending, versions.ahead], ['version', ['m/0001_next.sql'], 1]);
  const hash = createHash('sha256').update('a').digest('hex');
  const hashes = L.matchApplied(L.parseApplied(`${hash}\n${'f'.repeat(64)}\n`), migs);
  assert.deepEqual([hashes.by, hashes.applied, hashes.ahead], ['hash', ['m/0000_init.sql'], 1]);
  assert.equal(L.matchApplied(L.parseApplied('something else entirely\n'), migs).no_match, true);
  assert.equal(L.matchApplied(L.parseApplied(''), migs).no_match, false);
  // A stray short cell (an id, a count, a word) is not a migration.
  const short = [{ file: 'm/1_drop_users.sql', name: '1_drop_users.sql' }, { file: 'm/users.sql', name: 'users.sql' }];
  assert.deepEqual(L.matchApplied(L.parseApplied('1 | users | 0000_init\n'), short).applied, []);
  assert.deepEqual(L.matchApplied(L.parseApplied('1_drop_users\nusers.sql\n'), short).applied, ['m/1_drop_users.sql', 'm/users.sql']);
});

test('table sizes: schema and quotes off, tabs, pipes or spaces', () => {
  const s = L.parseSizes('public.users\t4200000\n"Orders"|12\nthings 7\nnot a size line\n');
  assert.deepEqual([...s], [['users', 4200000], ['orders', 12], ['things', 7]]);
  // Postgres says -1 for a table it never analyzed: unknown, not empty.
  assert.deepEqual([...L.parseSizes('users\t-1\naudit.users\t50\nnever\t-1\n')], [['users', 50], ['never', -1]]);
});

// ---------------------------------------------------------------- through the harness
test('live reads run only after confirmation, and only the ones that matter to the target', async () => {
  setLive({ applied: cat('applied.txt'), sizes: cat('sizes.txt'), plan: cat('plan.txt') });
  const r = await start('7');
  assert.deepEqual(r.ask.live, [{ target: 'pr-7', env: 'staging', production: false, commands: { applied: cat('applied.txt'), sizes: cat('sizes.txt'), plan: cat('plan.txt') } }]);
  assert.match(r.next, /ask the user once/);
  const no = H.live({ run: r.run_id });
  assert.equal(no.ok, false);
  assert.match(no.refused, /only after the user agreed/);
  // A change with no infrastructure file is not offered a plan.
  const additive = branch(app, 'additive', app.sha.base, { 'db/migrations/0001_things.sql': 'CREATE TABLE things (id uuid);\n', 'db/migrations/meta/_journal.json': journal('0000_init', '0001_things') });
  app.setStub({ prs: { 21: app.view(21, 'Additive', 'main', app.sha.base, 'additive', additive) } });
  assert.deepEqual(Object.keys((await start('21')).ask.live[0].commands), ['applied', 'sizes']);
  // Production is said plainly.
  assert.equal((await start('9')).targets[0].production, true);
  assert.equal((await start('7', '--no-live')).ask, null);
  app.setStub();
});

test('applied and sizes: pending, target ahead, a Drizzle hash, a big table', async () => {
  setLive({ applied: cat('applied.txt'), sizes: cat('sizes.txt') });
  answer('applied.txt', `${sha256('db/migrations/0000_init.sql')}\n${'e'.repeat(64)}\n`);
  answer('sizes.txt', 'public.users\t4200000\nthings\t3\n');
  const r = await start('7');
  const l = H.live({ run: r.run_id, confirmed: true });
  const res = l.targets[0].results;
  assert.deepEqual(res.applied, { ok: true, by: 'hash', applied: 1, pending: ['db/migrations/0001_drop_legacy.sql'], ahead: 1, no_match: false, empty: false, already_applied: [] });
  assert.deepEqual(res.sizes, { ok: true, tables: 2, raised: 1, unknown: [] });
  assert.deepEqual(l.targets[0].added.map((f) => f.rule), ['target_ahead']);
  assert.match(l.targets[0].raised[0].line, /^🔴 blocker: .*CREATE INDEX users_email_idx ON users \(email\) — builds an index without CONCURRENTLY.*~4200000 rows/);
  const rec = await H.record({ run: r.run_id });
  const [t] = rec.targets;
  assert.deepEqual(t.counts, { blocker: 3, risk: 3, note: 3 });
  assert.ok(t.runbook.some((x) => x === 'Order: 1 migration not yet applied on `staging` will run.'));
  assert.ok(!t.unchecked.some((u) => /live "applied"|live "sizes"/.test(u)));
  // Raw output stays in the run folder.
  assert.ok(readFileSync(join(l.targets[0].output_dir, 'live-sizes.txt'), 'utf8').includes('4200000'));
  assert.match(H.postPlan({ run: r.run_id, target: 'pr-7' }).body, /The table has about 4,200,000 rows\./);
  // A second call replaces what the first derived, it does not stack.
  H.live({ run: r.run_id, confirmed: true });
  assert.deepEqual((await H.record({ run: r.run_id })).targets[0].counts, { blocker: 3, risk: 3, note: 3 });
});

test('applied: a migration the target has not run and this change does not carry is read too', async () => {
  // `later` sits on top of feat: against a target that only ran 0000, 0001 is pending and outside the change.
  const later = branch(app, 'later', app.sha.feat, { 'db/migrations/0002_nick.sql': 'ALTER TABLE users ADD COLUMN nick text;\n', 'db/migrations/meta/_journal.json': journal('0000_init', '0001_drop_legacy', '0002_nick') });
  app.setStub({ prs: { 51: app.view(51, 'Nick', 'feat', app.sha.feat, 'later', later) } });
  setLive({ applied: cat('applied.txt') }, { targets: [{ branch: 'feat', env: 'staging' }] });
  answer('applied.txt', '0000_init\n');
  const r = await start('51');
  assert.equal(r.targets[0].counts.blocker, 0);
  const l = H.live({ run: r.run_id, confirmed: true });
  assert.deepEqual(l.targets[0].results.applied.pending, ['db/migrations/0001_drop_legacy.sql', 'db/migrations/0002_nick.sql']);
  const run = S.loadRun(r.run_id);
  const outside = run.targets[0].findings.filter((f) => f.outside_range).map((f) => f.rule);
  assert.deepEqual(outside, ['drop_column', 'index_not_concurrent', 'create_table', 'on_new_table']);
  const rec = await H.record({ run: r.run_id });
  assert.equal(rec.targets[0].verdict, 'blocked');
  assert.ok(rec.targets[0].blockers[0].includes('outside this change'));
  // The edited-migration rule learns that the old version really ran.
  const edit = branch(app, 'edit', app.sha.base, { 'db/migrations/0000_init.sql': 'CREATE TABLE users (id uuid PRIMARY KEY);\n' });
  app.setStub({ prs: { 52: app.view(52, 'Edit', 'main', app.sha.base, 'edit', edit) } });
  setLive({ applied: cat('applied.txt') });
  const e = await start('52');
  H.live({ run: e.run_id, confirmed: true });
  await H.record({ run: e.run_id });
  assert.match(H.postPlan({ run: e.run_id, target: 'pr-52' }).body, /changes or removes a migration that already exists on the base branch.*It has already run on staging\./);
  app.setStub();
});

test('a live read that fails or prints nothing useful is a reason, never a pass', async () => {
  const additive = git(repo, 'rev-parse', 'additive');
  app.setStub({ prs: { 21: app.view(21, 'Additive', 'main', app.sha.base, 'additive', additive) } });
  setLive({ applied: 'exit 3', sizes: cat('empty.txt') });
  answer('empty.txt', 'no rows\n');
  const r = await start('21');
  const before = (await H.record({ run: r.run_id })).targets[0];
  assert.equal(before.verdict, 'unverified');
  assert.match(before.unchecked.join('\n'), /the live "applied" read against staging gave nothing: it did not run/);
  H.live({ run: r.run_id, confirmed: true });
  const after = (await H.record({ run: r.run_id })).targets[0];
  assert.equal(after.verdict, 'unverified');
  assert.match(after.unchecked.join('\n'), /live "applied" read against staging gave nothing: the command exited 3/);
  assert.match(after.unchecked.join('\n'), /live "sizes" read against staging gave nothing: the output had no "table<TAB>rows" line/);
  // The list came back and matched nothing: the command is wrong, not the target empty.
  setLive({ applied: cat('applied.txt') });
  answer('applied.txt', 'version\n---\n(0 rows)\n');
  const m = await start('21');
  H.live({ run: m.run_id, confirmed: true });
  assert.match((await H.record({ run: m.run_id })).targets[0].unchecked.join('\n'), /matched no migration file: check the live\.applied command/);
  // An empty list, and a table nobody has a count for, are reasons too.
  answer('applied.txt', '');
  answer('sizes.txt', 'users\t-1\n');
  setLive({ applied: cat('applied.txt'), sizes: cat('sizes.txt') });
  const idx = branch(app, 'idx', app.sha.base, { 'db/migrations/0001_idx.sql': 'CREATE INDEX CONCURRENTLY a ON users (email);\nALTER TABLE users ALTER COLUMN email SET NOT NULL;\n', 'db/migrations/meta/_journal.json': journal('0000_init', '0001_idx') });
  app.setStub({ prs: { 61: app.view(61, 'Idx', 'main', app.sha.base, 'idx', idx) } });
  const e = await start('61');
  H.live({ run: e.run_id, confirmed: true });
  const reasons = (await H.record({ run: e.run_id })).targets[0].unchecked.join('\n');
  assert.match(reasons, /the applied list from staging was empty/);
  assert.match(reasons, /no row count from staging for users: a lock on a table of unknown size was not weighed/);
  app.setStub({ prs: { 21: app.view(21, 'Additive', 'main', app.sha.base, 'additive', additive) } });
  // Skipped for the run is also a reason.
  setLive({ applied: cat('applied.txt') });
  const s = await start('21', '--no-live');
  assert.match((await H.record({ run: s.run_id })).targets[0].unchecked.join('\n'), /it was skipped for this run/);
  // With both reads answering, the same change is safe.
  answer('applied.txt', '0000_init\n');
  answer('sizes.txt', 'users\t10\n');
  setLive({ applied: cat('applied.txt'), sizes: cat('sizes.txt') });
  const ok = await start('21');
  H.live({ run: ok.run_id, confirmed: true });
  assert.equal((await H.record({ run: ok.run_id })).targets[0].verdict, 'safe');
  app.setStub();
});

test('plan: only on a clean tree that is the head of the change; then its destroys count', async () => {
  setLive({ plan: cat('plan.txt') });
  answer('plan.txt', CDK_DIFF);
  let r = await start('7');
  let res = H.live({ run: r.run_id, confirmed: true }).targets[0].results.plan;
  assert.deepEqual([res.ok, res.skipped], [false, true]);
  assert.match(res.reason, /the working tree is at [0-9a-f]{7} and the change is at [0-9a-f]{7}/);
  assert.match((await H.record({ run: r.run_id })).targets[0].unchecked.join('\n'), /no plan was read against staging: the working tree is at/);

  git(repo, 'checkout', '-q', 'feat');
  writeFileSync(join(repo, 'src/other.ts'), 'export const x = 2;\n');
  res = H.live({ run: r.run_id, confirmed: true }).targets[0].results.plan;
  assert.match(res.reason, /uncommitted changes/);
  git(repo, 'checkout', '-q', '--', 'src/other.ts');

  const l = H.live({ run: r.run_id, confirmed: true }).targets[0];
  assert.deepEqual(l.results.plan, { ok: true, tool: 'cdk', counts: { create: 1, update: 1, destroy: 1, replace: 2, orphan: 1 } });
  assert.deepEqual(l.added.map((f) => f.rule), ['plan_destroys_stateful', 'plan_replaces_stateful', 'plan_replaces_resource']);
  const [t] = (await H.record({ run: r.run_id })).targets;
  assert.ok(!t.unchecked.some((u) => /no plan/.test(u)));
  assert.match(t.infra_from, /the diff and a plan/);
  assert.ok(t.blockers.some((b) => b === '🔴 blocker: plan: replace AWS::RDS::DBInstance Main — the plan replaces a resource that holds data: the old one is deleted'));
  assert.match(H.postPlan({ run: r.run_id, target: 'pr-7' }).body, /Plan: `replace AWS::RDS::DBInstance Main`: the plan replaces a resource that holds data: the old one is deleted\./);

  // A verdict recorded before a live read is stale: nothing can be posted from it.
  answer('plan.txt', CDK_DIFF);
  H.live({ run: r.run_id, confirmed: true });
  assert.match(H.postPlan({ run: r.run_id, target: 'pr-7' }).refused, /nothing recorded for this target yet/);
  // Output that is not a plan was read by nobody.
  answer('plan.txt', 'Error: Cannot find module ./bin/infra\n');
  res = H.live({ run: r.run_id, confirmed: true }).targets[0].results.plan;
  assert.match(res.reason, /neither a cdk diff nor a terraform plan/);
  git(repo, 'checkout', '-q', 'main');
});
