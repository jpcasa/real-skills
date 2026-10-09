import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeApp, branch, git, write, journal } from './fixture.mjs';

const app = makeApp('cim-check-');
process.env.CHECK_INFRA_STATE_DIR = join(app.tmp, 'state');
process.env.CHECK_INFRA_GH_STUB = app.stubFile;
// Never this machine's real calibration file.
process.env.REAL_SKILLS_CALIBRATION_DIR = join(app.tmp, 'calibration');
delete process.env.REAL_SKILLS_CALIBRATION;
delete process.env.CHECK_INFRA_TEST_CALIBRATED;
process.env.CHECK_INFRA_JEV = 'off';

const H = await import('../check.mjs');
const S = await import('../lib/state.mjs');
const C = await import('../lib/calibration.mjs');
const { loadConfig } = await import('../lib/config.mjs');
const { probe } = await import('../lib/probe.mjs');
const { MAX_LINES } = await import('../lib/post.mjs');
const { MAX_LINES: RUNBOOK_MAX, buildRunbook } = await import('../lib/runbook.mjs');

const { repo } = app;
const start = (...args) => H.start({ repo, args });
const rules = (t) => [...t.findings, ...t.notes].map((f) => f.rule);
const setConfig = (name, value) => {
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', name), JSON.stringify(value));
};
const OWN = 'check-infra-and-migrations.json';
const CONFIG = {
  migrations: [{ tool: 'drizzle', dir: 'db/migrations', applied: 'before_deploy', applied_by: '.github/workflows/deploy.yml' }],
  infra: [{ tool: 'cdk', paths: ['infra/**'], applied_by: '.github/workflows/deploy.yml' }],
  targets: [{ branch: 'production', env: 'production' }, { branch: 'main', env: 'staging' }],
};
const GOOD = { bucket: 'migration', severity: 'risk', file: 'db/migrations/0001_drop_legacy.sql', line: 3, quote: 'CREATE INDEX users_email_idx ON users (email);', problem: 'The index build and the column drop ship in one migration, so a failed index build leaves the drop applied.', step: { phase: 'before', text: 'Split the index into its own migration.' } };

// ---------------------------------------------------------------- probe, config
test('probe reads the repo: Drizzle folder, CDK app, who applies them', () => {
  const p = probe(repo);
  assert.deepEqual(p.migrations.map((m) => [m.tool, m.dir]), [['drizzle', 'db/migrations']]);
  assert.deepEqual(p.infra.map((m) => [m.tool, m.paths]), [['cdk', ['infra/**']]]);
  assert.deepEqual(p.migration_applied_by, ['.github/workflows/deploy.yml']);
  assert.deepEqual(p.infra_applied_by, ['.github/workflows/deploy.yml']);
  assert.deepEqual(p.env_files, ['.env.example']);
  assert.deepEqual(p.targets, [{ branch: 'production', env: 'production' }]);
  assert.equal(p.needs_setup, true);
});

test('config: three files, read in order, never merged into one another', () => {
  setConfig('changelog.json', { release: { main_branch: 'main', production_branch: 'production' }, tracker: { type: 'github' } });
  setConfig('wtf.json', { release: { production_branch: 'ignored' }, environments: [{ name: 'staging', kind: 'staging', base_url: 'https://staging.example.com' }], production_hosts: ['app.example.com'] });
  setConfig('qa-this.json', { environments: [{ name: 'local', kind: 'local', base_url: 'http://localhost:3000' }] });
  let l = loadConfig(repo);
  assert.equal(l.needs_setup, true, 'neither migrations nor infra answered');
  assert.equal(l.sources.release, '.claude/changelog.json');
  assert.equal(l.sources.environments, '.claude/wtf.json');
  assert.equal(l.config.release.production_branch, 'production');
  setConfig(OWN, { migrations: [] });
  l = loadConfig(repo);
  assert.equal(l.needs_setup, false, '"none" is an answer');
  assert.deepEqual(l.explicit, { migrations: true, infra: false });
  assert.deepEqual([l.config.post, l.config.big_table_rows], ['ask', 1000000]);
  setConfig(OWN, { ...CONFIG, live: { staging: { plan: 'terraform apply -auto-approve' } } });
  assert.throws(() => loadConfig(repo), /live\.staging\.plan contains "apply"/);
  setConfig(OWN, { migrations: [{ dir: 'db/migrations', applied: 'whenever' }] });
  assert.throws(() => loadConfig(repo), /applied must be one of/);
  for (const f of [OWN, 'changelog.json', 'wtf.json', 'qa-this.json']) writeFileSync(join(repo, '.claude', f), '{}');
});

// ---------------------------------------------------------------- start
test('start on a PR with no config: probe decides the buckets, rules fire, nothing is checked out', async () => {
  const before = git(repo, 'rev-parse', 'HEAD');
  const r = await start('7');
  assert.deepEqual(r.needs, ['setup']);
  assert.deepEqual(r.layout_from, { migrations: 'probe', infra: 'probe' });
  const [t] = r.targets;
  assert.equal(t.id, 'pr-7');
  assert.deepEqual(t.buckets, {
    migration: ['db/migrations/0001_drop_legacy.sql', 'db/migrations/meta/_journal.json'],
    infra: ['infra/lib/data-stack.ts'], pipeline: [], env: ['.env.example'],
  });
  assert.deepEqual(rules(t).sort(), ['create_table', 'deletion_guard_weakened', 'drop_column', 'env_var_added', 'index_not_concurrent', 'on_new_table', 'stateful_resource_removed', 'still_referenced'].sort());
  assert.deepEqual(t.counts, { blocker: 2, risk: 3, note: 3 });
  const still = S.loadRun(r.run_id).targets[0].findings.find((f) => f.rule === 'still_referenced');
  assert.deepEqual(still.refs, [{ file: 'src/users.ts', line: 1 }, { file: 'src/users.ts', line: 2 }]);
  assert.match(t.findings[0].line, /^🔴 blocker: db\/migrations\/0001_drop_legacy\.sql:L1: ALTER TABLE users DROP COLUMN legacy_id — drops a column/);
  assert.ok(existsSync(join(t.head_dir, 'db/migrations/0001_drop_legacy.sql')));
  assert.equal(t.live, null);
  assert.equal(r.ask, null);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('start: a promotion PR, `promotion` with none open, a range, no arguments', async () => {
  setConfig(OWN, CONFIG);
  let [t] = (await start('https://github.com/acme/app/pull/9')).targets;
  assert.deepEqual([t.id, t.promotion, t.env, t.production], ['pr-9', true, 'production', true]);

  app.setStub({ open_into: { production: [9] } });
  assert.equal((await start('promotion')).targets[0].id, 'pr-9');

  // None open: what would go out next, from the remote-tracking refs.
  app.setStub();
  git(repo, 'update-ref', 'refs/remotes/origin/production', app.sha.base);
  git(repo, 'update-ref', 'refs/remotes/origin/main', app.sha.feat);
  [t] = (await start('promotion')).targets;
  assert.deepEqual([t.kind, t.base, t.env, t.title], ['range', 'production', 'production', 'main → production']);
  assert.match(t.id, /^range-[0-9a-f]{7}-[0-9a-f]{7}$/);
  assert.ok(t.findings.some((f) => f.rule === 'drop_column'));

  [t] = (await start('production..feat')).targets;
  assert.deepEqual([t.kind, t.env], ['range', 'production']);
  [t] = (await start('production..feat', '--target', 'staging')).targets;
  assert.equal(t.env, 'staging');

  app.setStub({ current_pr: 7, open_into: { production: [9] } });
  assert.equal((await start()).targets[0].id, 'pr-7');
  app.setStub({ open_into: { production: [9] } });
  assert.equal((await start()).targets[0].id, 'pr-9');
  app.setStub();
  const none = await start();
  assert.deepEqual(none.needs, ['input']);
  assert.deepEqual(none.candidates, { current_branch_pr: null, promotion_pr: null, range: 'origin/production..origin/main' });

  await assert.rejects(start('1', '2', '3', '4', '5', '6'), /at most 5 per run/);
  await assert.rejects(start('https://github.com/other/repo/pull/3'), /is in other\/repo, not acme\/app/);
  await assert.rejects(start('what'), /not a PR number/);
  assert.deepEqual((await start('setup')).mode, 'setup');
});

test('a change with no migration or infrastructure file is nothing_to_check', async () => {
  const r = await start('8');
  assert.equal(r.targets[0].bucketed, 0);
  assert.match(r.next, /say so and stop/);
  const rec = await H.record({ run: r.run_id });
  assert.equal(rec.targets[0].verdict, 'nothing_to_check');
  assert.equal(H.postPlan({ run: r.run_id, target: 'pr-8' }).allowed, false);
});

test('config says where things are: deploy window and applied_by reach the findings', async () => {
  const r = await start('7');
  assert.deepEqual(r.needs, []);
  assert.deepEqual(r.layout_from, { migrations: 'config', infra: 'config' });
  const t = S.loadRun(r.run_id).targets[0];
  assert.equal(t.findings.find((f) => f.rule === 'drop_column').window, 'old_code');
  assert.equal(t.env, 'staging');
  assert.match(r.targets[0].findings[0].line, /old code hits it during deploy/);
});

// ---------------------------------------------------------------- history
test('history rules fire from git: an edited migration, an out-of-order one, a broken journal', async () => {
  const sha = branch(app, 'history', app.sha.feat, {
    'db/migrations/0000_init.sql': 'CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL);\n',
    'db/migrations/0001_also.sql': 'CREATE TABLE more (id uuid);\n',
    'db/migrations/0005_unlisted.sql': 'CREATE TABLE even_more (id uuid);\n',
  });
  app.setStub({ prs: { 11: app.view(11, 'History', 'feat', app.sha.feat, 'history', sha) } });
  const r = await start('11');
  const t = S.loadRun(r.run_id).targets[0];
  const hit = (rule) => t.findings.filter((f) => f.rule === rule).map((f) => f.file);
  assert.deepEqual(hit('edited_existing_migration'), ['db/migrations/0000_init.sql']);
  assert.deepEqual(hit('out_of_order'), ['db/migrations/0001_also.sql']);
  assert.deepEqual(t.findings.filter((f) => f.rule === 'journal_mismatch').map((f) => f.detail), ['`0001_also.sql` has no journal entry.', '`0005_unlisted.sql` has no journal entry.']);
  assert.equal(r.targets[0].counts.blocker, 3);
});

// ---------------------------------------------------------------- record
test('record: citations are checked, the agent can add and never lower, verdict and runbook follow', async () => {
  const r = await start('7');
  const lower = { bucket: 'migration', severity: 'note', file: 'db/migrations/0001_drop_legacy.sql', line: 1, quote: 'ALTER TABLE users DROP COLUMN legacy_id;', problem: 'This drop is fine, the column was unused for a year.' };
  const rec = await H.record({ run: r.run_id, targets: [{ id: 'pr-7', findings: [
    GOOD,
    { ...GOOD, quote: 'CREATE INDEX something_else ON users (name);' },
    { ...GOOD, file: '../../etc/passwd' },
    { ...GOOD, severity: 'fine' },
    { ...GOOD, file: 'src/users.ts', line: 1, quote: "export const q = 'select legacy_id from users';", bucket: 'migration', severity: 'blocker', problem: 'This query still selects legacy_id and will fail once the column is gone.', step: undefined },
    lower,
  ] }] });
  const [t] = rec.targets;
  assert.equal(t.verdict, 'blocked');
  assert.deepEqual(t.counts, { blocker: 3, risk: 4, note: 4 });
  assert.deepEqual(t.dropped.map((d) => [d.index, d.why]), [
    [1, 'quote not found within 3 lines of line 3'],
    [2, 'no file, or a path outside the repository'],
    [3, 'severity must be one of blocker, risk, note'],
  ]);
  assert.ok(t.blockers.some((l) => l.includes('ALTER TABLE users DROP COLUMN legacy_id — drops a column')), 'the rule hit is still a blocker');
  assert.ok(t.blockers.some((l) => l.includes('src/users.ts:L1: This query still selects')));
  assert.ok(t.unchecked.some((u) => /infrastructure changed and no plan was read against staging \(no live\.plan command is configured\)/.test(u)));
  assert.match(t.infra_from, /diff only/);
  const book = t.runbook.join('\n');
  assert.match(book, /Before: Set `STRIPE_KEY` on `staging`\./);
  assert.match(book, /Before: Back up table `users` before `db\/migrations\/0001_drop_legacy\.sql:1` runs/);
  assert.match(book, /Before: Take a snapshot or export of `Bucket Uploads` before the infrastructure change\./);
  assert.match(book, /Before: Split the index into its own migration\./);
  assert.match(book, /Order: Migrations run before the new code goes live \(`\.github\/workflows\/deploy\.yml`\)\. Old code runs against the new schema/);
  assert.match(book, /Rollback: `db\/migrations\/0001_drop_legacy\.sql` is not reversible without the backup\./);
  assert.ok(t.runbook.length <= RUNBOOK_MAX);
  // The same input twice gives the same answer.
  const again = await H.record({ run: r.run_id, targets: [{ id: 'pr-7', findings: [GOOD] }] });
  assert.deepEqual(again.targets[0].counts, { blocker: 2, risk: 4, note: 3 });
});

test('`safe` needs every statement classified and every infra change planned', async () => {
  const additive = branch(app, 'additive', app.sha.base, { 'db/migrations/0001_things.sql': 'CREATE TABLE things (id uuid PRIMARY KEY);\nALTER TABLE users ADD COLUMN nickname text;\n', 'db/migrations/meta/_journal.json': journal('0000_init', '0001_things') });
  const opaque = branch(app, 'opaque', app.sha.base, { 'db/migrations/0001_do.sql': 'CREATE TABLE things (id uuid);\nDO $$ BEGIN PERFORM 1; END $$;\n', 'db/migrations/meta/_journal.json': journal('0000_init', '0001_do') });
  const infra = branch(app, 'infra-only', app.sha.base, { 'infra/lib/data-stack.ts': `// a comment\n${readFileSync(join(repo, 'infra/lib/data-stack.ts'), 'utf8')}` });
  app.setStub({ prs: { 21: app.view(21, 'Additive', 'main', app.sha.base, 'additive', additive), 22: app.view(22, 'Opaque', 'main', app.sha.base, 'opaque', opaque), 23: app.view(23, 'Infra', 'main', app.sha.base, 'infra-only', infra) } });
  const r = await start('21', '22', '23');
  const rec = await H.record({ run: r.run_id });
  assert.deepEqual(rec.targets.map((t) => t.verdict), ['safe', 'unverified', 'unverified']);
  assert.deepEqual(rec.targets[0].unchecked, []);
  assert.match(rec.targets[1].unchecked[0], /db\/migrations\/0001_do\.sql:2 could not be classified/);
  assert.match(rec.targets[2].unchecked[0], /infrastructure changed and no plan was read/);
  assert.deepEqual(rec.targets[2].counts, { blocker: 0, risk: 0, note: 0 });
});

test('runbook: capped, and the line that says how many were cut fits inside the cap', () => {
  const findings = Array.from({ length: 40 }, (_, i) => ({ rule: 'drop_table', bucket: 'migration', file: `m/${i}.sql`, line: 1, table: `t${i}` }));
  const book = buildRunbook({ env: 'production', buckets: { migration: findings.map((f) => f.file), infra: [] } }, findings);
  assert.equal(book.lines.length, RUNBOOK_MAX);
  assert.match(book.lines.at(-1), /^…and \d+ more steps\.$/);
  assert.ok(book.lines.some((l) => l.startsWith('Rollback: ')) && book.lines.some((l) => l.startsWith('Before: ')));
});

// ---------------------------------------------------------------- post
test('post: one comment built by the script, redacted, and refused when it should be', async () => {
  const TOKEN = `ghp_${'a'.repeat(36)}`;
  app.setStub();
  const r = await start('7');
  await H.record({ run: r.run_id, targets: [{ id: 'pr-7', findings: [{ ...GOOD, problem: `Leaks ${TOKEN} and pings @someone with a [link](https://evil.example/x) while the index builds.` }] }] });
  const p = H.postPlan({ run: r.run_id, target: 'pr-7' });
  assert.equal(p.allowed, true);
  assert.equal(p.confirm_before_send, true);
  assert.ok(p.lines <= MAX_LINES && p.body.split('\n').length <= MAX_LINES);
  assert.match(p.body, /^\*\*Migration and infrastructure check: blocked\*\* · `staging` · `[0-9a-f]{7}` · 2 blockers, 4 risks, 3 notes/);
  assert.match(p.body, /\*\*Blockers\*\*\n- `db\/migrations\/0001_drop_legacy\.sql:1` `ALTER TABLE users DROP COLUMN legacy_id`: drops a column: its data is gone once this runs\. Old code runs against this until the deploy finishes\./);
  assert.match(p.body, /`infra\/lib\/data-stack\.ts:\d+` `cdk: remove Bucket Uploads`: removes the declaration of a resource that holds data\. Read from the diff, not from a plan\./);
  assert.match(p.body, /Named at `src\/users\.ts:1`, `src\/users\.ts:2`/);
  assert.match(p.body, /\*\*Not checked\*\*/);
  assert.match(p.body, /\*\*Runbook\*\*\n- Before: Set `STRIPE_KEY`/);
  assert.ok(!p.body.includes(TOKEN) && !p.body.includes('evil.example') && !p.body.includes('@someone'), p.body);

  // A moved head, then a closed PR.
  app.setStub({ prs: { 7: app.view(7, 'Drop legacy id', 'main', app.sha.base, 'feat', app.sha.docs) } });
  assert.match(H.postPlan({ run: r.run_id, target: '7' }).refused, /moved to [0-9a-f]{7} since it was checked/);
  app.setStub({ prs: { 7: app.view(7, 'Drop legacy id', 'main', app.sha.base, 'feat', app.sha.feat, 'MERGED') } });
  assert.match(H.post({ run: r.run_id, target: 'pr-7', confirmed: true }).refused, /#7 is merged/);

  app.setStub();
  // The user's yes is a flag the caller has to set.
  assert.match(H.post({ run: r.run_id, target: 'pr-7' }).refused, /needs the user's yes/);
  assert.equal(existsSync(`${app.stubFile}.posted.jsonl`), false);
  const sent = H.post({ run: r.run_id, target: 'pr-7', confirmed: true });
  assert.equal(sent.ok, true);
  const posted = readFileSync(`${app.stubFile}.posted.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(posted.length, 1);
  assert.deepEqual([posted[0].slug, posted[0].n, posted[0].body], ['acme/app', 7, p.body]);
  assert.match(H.post({ run: r.run_id, target: 'pr-7', confirmed: true }).refused, /already posted to #7/);
  await assert.rejects(H.record({ run: r.run_id }), /already posted/);

  const off = await start('7', '--no-post');
  await H.record({ run: off.run_id });
  assert.match(H.postPlan({ run: off.run_id, target: 'pr-7' }).refused, /posting is off/);
  const range = await start('production..feat');
  await H.record({ run: range.run_id });
  assert.match(H.postPlan({ run: range.run_id, target: range.targets[0].id }).refused, /commit range, not a pull request/);
  assert.throws(() => H.postPlan({ run: '../../x', target: 'pr-7' }), /unknown run/);
});

test('names from the change cannot become markup, a mention or a link in the comment', async () => {
  const evil = 'db/migrations/0001_x`\n[approve](https://evil.example/x) @org-security.sql';
  const sha = branch(app, 'evil', app.sha.base, {
    [evil]: 'ALTER TABLE users DROP COLUMN "x` @org-team [a](https://evil.example/y)";\n',
    'db/migrations/meta/_journal.json': journal('0000_init', '0001_ghost\n[click](https://evil.example/z) @org-admins'),
  });
  app.setStub({ prs: { 71: app.view(71, 'Evil', 'main', app.sha.base, 'evil', sha) } });
  const r = await start('71');
  await H.record({ run: r.run_id });
  const { body } = H.postPlan({ run: r.run_id, target: 'pr-71' });
  // Outside a code span there is no backtick-free place for a name to land: strip the spans and look at what is left.
  const outside = body.replace(/`[^`\n]*`/g, '');
  assert.ok(!/evil\.example|@org|\]\(/.test(outside), outside);
  for (const l of body.split('\n')) assert.equal((l.match(/`/g) || []).length % 2, 0, `unbalanced code span: ${l}`);
  assert.match(body, /a name with unusual characters/);
  app.setStub();
});

test('a comment with many findings stays inside the cap and says what it left out', async () => {
  const many = Array.from({ length: 30 }, (_, i) => `ALTER TABLE users DROP COLUMN c${i};\nCREATE INDEX i${i} ON users (email);`).join('\n');
  const sha = branch(app, 'many', app.sha.base, { 'db/migrations/0001_many.sql': `${many}\n`, 'db/migrations/meta/_journal.json': journal('0000_init', '0001_many') });
  app.setStub({ prs: { 31: app.view(31, 'Many', 'main', app.sha.base, 'many', sha) } });
  const r = await start('31');
  await H.record({ run: r.run_id });
  const p = H.postPlan({ run: r.run_id, target: 'pr-31' });
  assert.equal(p.body.split('\n').length <= MAX_LINES, true);
  assert.match(p.body, /- …and 18 more blockers\./);
  assert.match(p.body, /- …and 20 more risks\./);
  assert.match(p.body, /Run `cim-/);
});

// ---------------------------------------------------------------- Jev
test('Jev: logged and deciding nothing until calibrated; calibrated, it only makes a verdict worse', async () => {
  const sha = branch(app, 'jev', app.sha.base, { 'db/migrations/0001_fill.sql': "ALTER TABLE users ADD COLUMN plan text;\nUPDATE users SET plan = 'ada@lovelace.example' WHERE id = '00000000-0000-0000-0000-000000000005';\n", 'db/migrations/meta/_journal.json': journal('0000_init', '0001_fill') });
  app.setStub({ prs: { 41: app.view(41, 'Fill plan for https://db.internal.example.com/x', 'main', app.sha.base, 'jev', sha) } });
  const stub = join(app.tmp, 'jev.json');
  process.env.CHECK_INFRA_JEV_STUB = stub;
  const run = async (answers, mode) => {
    writeFileSync(stub, JSON.stringify(answers));
    process.env.CHECK_INFRA_JEV = mode;
    const r = await start('41');
    return (await H.record({ run: r.run_id })).targets[0];
  };
  const alarm = { 'destroys__*': 0.95, 'breaks__*': 0.95, needs_manual_step: 0.95, safe_to_push: 0.05 };

  // Shadow, uncalibrated: every answer is logged and none decides.
  let t = await run(alarm, 'shadow');
  assert.deepEqual([t.verdict, t.counts.blocker, t.counts.risk], ['safe', 0, 0]);
  const cases = C.readJsonl(S.jevLog()).filter((c) => c.type === 'case');
  assert.deepEqual([...new Set(cases.map((c) => c.question))].sort(), ['breaks_running_code', 'destroys_data', 'needs_manual_step', 'safe_to_push']);
  assert.ok(cases.every((c) => c.acted === false && c.skill === 'check-infra-and-migrations'));
  // Live but still uncalibrated: the same.
  t = await run(alarm, 'live');
  assert.equal(t.verdict, 'safe');

  // What left the machine: one-liners, no literal, no link, no hunk.
  const sent = readFileSync(`${stub}.sent.jsonl`, 'utf8');
  assert.ok(sent.includes('UPDATE users SET plan = ? WHERE id = ?'));
  for (const leak of ['ada@', 'lovelace', '00000000-0000', 'db.internal.example.com', 'diff --git', '@@']) assert.ok(!sent.includes(leak), leak);
  // A host-like construct id, a plan's resource name and a MySQL string in double quotes stay home too.
  const Q = await import('../lib/questions.mjs');
  const built = Q.build({ title: 'x', buckets: {}, statements: [{ file: 'm/1.sql', line: 1, rule: 'data_change', normalized: 'INSERT INTO accounts ("name", pin) VALUES ("alice", "bob") WHERE "id" = "carol"' }] }, [
    { source: 'rule', bucket: 'infra', rule: 'stateful_resource_removed', file: 'i.ts', line: 1, normalized: 'cdk: remove Bucket assets.acme-prod.example.com' },
    { source: 'live', bucket: 'infra', origin: 'plan', rule: 'plan_destroys_stateful', file: null, line: null, resource: { type: 'aws_db_instance', name: 'orders_primary' }, normalized: 'plan: destroy aws_db_instance orders_primary' },
  ]);
  assert.deepEqual(built.state.changes, ['INSERT INTO accounts (?, pin) VALUES (?, ?) WHERE "id" = ?', 'cdk: remove Bucket [host]', 'plan: destroys stateful aws_db_instance']);

  // Calibrated and live: each question can raise.
  process.env.CHECK_INFRA_TEST_CALIBRATED = 'safe_to_push';
  t = await run({ safe_to_push: 0.05 }, 'live');
  assert.deepEqual([t.verdict, t.risks.length], ['caution', 1]);
  assert.match(t.risks[0], /Jev does not read this release as safe/);
  process.env.CHECK_INFRA_TEST_CALIBRATED = 'destroys_data,breaks_running_code,needs_manual_step';
  t = await run({ 'destroys__0': 0.1, 'destroys__1': 0.9, 'breaks__0': 0.9, needs_manual_step: 0.9, safe_to_push: 0.99 }, 'live');
  assert.deepEqual([t.verdict, t.counts.blocker, t.counts.risk], ['blocked', 1, 1]);
  assert.ok(t.runbook.some((l) => /Jev expects a step by hand/.test(l)));

  // And never lower: a calm Jev on a change the rules block.
  process.env.CHECK_INFRA_TEST_CALIBRATED = 'destroys_data,breaks_running_code,infra_change_is_disruptive,needs_manual_step,safe_to_push';
  writeFileSync(stub, JSON.stringify({ 'destroys__*': 0.01, 'breaks__*': 0.01, 'disruptive__*': 0.01, needs_manual_step: 0.01, safe_to_push: 0.99 }));
  app.setStub();
  const blocked = (await H.record({ run: (await start('7')).run_id })).targets[0];
  assert.deepEqual([blocked.verdict, blocked.counts.blocker], ['blocked', 2]);

  // Jev unreachable: the verdict is the rules', and the output says so.
  writeFileSync(stub, JSON.stringify({ __degraded: true }));
  const d = await H.record({ run: (await start('7')).run_id });
  assert.deepEqual([d.jev, d.targets[0].verdict], ['degraded', 'blocked']);
  delete process.env.CHECK_INFRA_TEST_CALIBRATED;
  delete process.env.CHECK_INFRA_JEV_STUB;
  process.env.CHECK_INFRA_JEV = 'off';
});

// ---------------------------------------------------------------- outcome, stats
test('outcome labels safe_to_push, and stats counts verdicts and rules', async () => {
  const stub = join(app.tmp, 'jev2.json');
  writeFileSync(stub, JSON.stringify({ safe_to_push: 0.9 }));
  process.env.CHECK_INFRA_JEV_STUB = stub;
  process.env.CHECK_INFRA_JEV = 'shadow';
  app.setStub({ prs: { 21: app.view(21, 'Additive', 'main', app.sha.base, 'additive', git(repo, 'rev-parse', 'additive')) } });
  const r = await start('21');
  await H.record({ run: r.run_id });
  const o = H.outcome({ run: r.run_id, target: 'pr-21', result: 'wrong', actual: 'blocked' });
  assert.deepEqual([o.verdict, o.actual, o.labelled], ['safe', 'blocked', true]);
  const label = C.readJsonl(S.jevLog()).filter((c) => c.type === 'label').at(-1);
  assert.deepEqual([label.question, label.label, label.source], ['safe_to_push', false, 'outcome']);
  assert.throws(() => H.outcome({ run: r.run_id, target: 'pr-21', result: 'maybe' }), /right or wrong/);
  delete process.env.CHECK_INFRA_JEV_STUB;
  process.env.CHECK_INFRA_JEV = 'off';

  const s = H.stats();
  assert.ok(s.checks >= 10);
  assert.equal(s.verdicts.safe.wrong, 1);
  assert.ok(s.verdicts.blocked.checks >= 3 && s.rules.drop_column >= 3);
  assert.equal(s.posts, 1);
  // The log holds verdicts and counts, never statement text.
  const log = readFileSync(join(process.env.CHECK_INFRA_STATE_DIR, 'log.jsonl'), 'utf8');
  assert.ok(!/ALTER TABLE|legacy_id/.test(log));
});
