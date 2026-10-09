import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileFindings, historyFindings, journalFindings, windowFindings, referencedNames, isMeta } from '../lib/migrations.mjs';
import { infraFindings, pipelineFindings, envFindings, STATEFUL_TYPE } from '../lib/infra.mjs';
import { parsePatch } from '../lib/diff.mjs';
import { bucketOf } from '../lib/buckets.mjs';
import { RULES, SEVERITIES, verdict } from '../lib/rules.mjs';

const rulesOf = (r) => r.findings.map((f) => f.rule);
// A diff for one file: lines starting with + or - inside one hunk.
const fd = (file, body, { tool = 'cdk', status = 'modified' } = {}) => {
  const head = status === 'added' ? 'new file mode 100644\n--- /dev/null\n+++ b/' + file : status === 'deleted' ? `deleted file mode 100644\n--- a/${file}\n+++ /dev/null` : `--- a/${file}\n+++ b/${file}`;
  const [f] = parsePatch(`diff --git a/${file} b/${file}\n${head}\n@@ -1,9 +1,9 @@\n${body}\n`);
  return { ...f, tool };
};

test('every rule has a severity and a sentence', () => {
  for (const [name, r] of Object.entries(RULES)) {
    assert.ok(SEVERITIES.includes(r.severity), name);
    assert.ok(r.says && !/[.!]$/.test(r.says), `${name}: one clause, no full stop`);
  }
});

// ---------------------------------------------------------------- migrations
test('a lock or scan on a table this change creates is a note', () => {
  const ctx = { created: new Set() };
  const r = fileFindings('m/0002_things.sql', 'CREATE TABLE things (id uuid);\nCREATE INDEX things_idx ON things (id);\nALTER TABLE things ADD CONSTRAINT t_fk FOREIGN KEY (id) REFERENCES users(id);\nALTER TABLE "things" ENABLE ROW LEVEL SECURITY;\nCREATE INDEX users_idx ON users (id);', ctx);
  assert.deepEqual(rulesOf(r), ['create_table', 'on_new_table', 'on_new_table', 'on_new_table', 'index_not_concurrent']);
  assert.equal(r.findings[1].was, 'index_not_concurrent');
  // The table stays "new" for the next file of the same change.
  assert.deepEqual(rulesOf(fileFindings('m/0003_more.sql', 'ALTER TABLE things DROP COLUMN id;', ctx)), ['on_new_table']);
});

test('IF NOT EXISTS may create nothing: locks are let off, a drop or a rewrite never is', () => {
  const r = fileFindings('m/1.sql', 'CREATE TABLE IF NOT EXISTS users (id uuid);\nCREATE INDEX users_idx ON users (id);\nALTER TABLE users ENABLE ROW LEVEL SECURITY;\nALTER TABLE users DROP COLUMN email;\nALTER TABLE users ALTER COLUMN id TYPE text;\nDELETE FROM users;\nDROP TABLE users;');
  assert.deepEqual(rulesOf(r), ['create_table', 'on_new_table', 'on_new_table', 'drop_column', 'alter_column_type', 'delete_without_where', 'drop_table']);
});

test('a table of the same name in another schema, or in another case, is not the new table', () => {
  assert.deepEqual(rulesOf(fileFindings('m/1.sql', 'CREATE TABLE audit.users (id uuid);\nDROP TABLE public.users;\nDROP TABLE users;\nDROP TABLE audit.users;')), ['create_table', 'drop_table', 'drop_table', 'on_new_table']);
  assert.deepEqual(rulesOf(fileFindings('m/2.sql', 'CREATE TABLE "Users" (id uuid);\nDROP TABLE users;\nTRUNCATE "Users", users;')), ['create_table', 'drop_table', 'on_new_table', 'truncate']);
});

test('a CASCADE drop is not a replacement, whatever is created after it', () => {
  const r = fileFindings('m/1.sql', "DROP TYPE status CASCADE;\nCREATE TYPE status AS ENUM ('a');\nDROP FUNCTION touch() CASCADE;\nCREATE FUNCTION touch() RETURNS void AS $$ $$ LANGUAGE sql;");
  assert.deepEqual(rulesOf(r), ['drop_cascade', 'create_object', 'drop_object', 'create_object']);
});

test('a drop before the create is about the old table', () => {
  assert.deepEqual(rulesOf(fileFindings('m/1.sql', 'DROP TABLE IF EXISTS things;\nCREATE TABLE things (id int);')), ['drop_table', 'create_table']);
});

test('DROP then CREATE of one policy or function is a replacement', () => {
  const r = fileFindings('m/1.sql', 'DROP POLICY IF EXISTS "read own" ON users;\nCREATE POLICY "read own" ON users USING (true);\nDROP POLICY "write own" ON users;\nDROP FUNCTION touch();\nCREATE FUNCTION touch() RETURNS void AS $$ $$ LANGUAGE sql;');
  assert.deepEqual(rulesOf(r), ['replace_object', 'create_policy', 'policy_dropped', 'replace_object', 'create_object']);
});

test('an unparsed statement is listed, not turned into a finding', () => {
  const r = fileFindings('m/1.sql', 'CREATE TABLE a (id int);\nDO $$ BEGIN END $$;');
  assert.deepEqual(rulesOf(r), ['create_table']);
  assert.deepEqual(r.unparsed.map((u) => [u.file, u.line]), [['m/1.sql', 2]]);
  assert.equal(r.statements.length, 2);
});

test('a migration that is not SQL: destructive calls fire, the file stays unparsed', () => {
  const rails = fileFindings('db/migrate/20240101_x.rb', 'class X < ActiveRecord::Migration[7.0]\n  def up\n    remove_column :users, :legacy_id\n    add_column :users, :nick, :string\n  end\n  def down\n    drop_table :things\n  end\nend\n');
  assert.deepEqual(rails.findings.map((f) => [f.rule, f.line]), [['drop_column', 3]]);
  assert.equal(rails.unparsed.length, 1);
  const alembic = fileFindings('alembic/versions/ab12_x.py', 'def upgrade():\n    op.drop_table("things")\n    op.execute("DELETE FROM a")\n\ndef downgrade():\n    op.drop_column("users", "nick")\n');
  assert.deepEqual(rulesOf(alembic), ['drop_table']);
  assert.equal(alembic.unparsed.length, 2);
  const knex = fileFindings('migrations/2024_x.js', 'exports.down = (knex) => knex.schema.dropTable("a");\nexports.up = (knex) => knex.schema.table("users", (t) => {\n  t.dropColumn("legacy");\n});\n');
  assert.deepEqual(knex.findings.map((f) => [f.rule, f.line]), [['drop_column', 3]]);
});

test('history: an edited, deleted or renamed base migration is a blocker', () => {
  const entry = { tool: 'drizzle', dir: 'db/migrations' };
  const changed = [
    { file: 'db/migrations/0001_init.sql', status: 'modified', entry },
    { file: 'db/migrations/0002_gone.sql', status: 'deleted', entry },
    { file: 'db/migrations/0009_new_name.sql', status: 'renamed', old_file: 'db/migrations/0003_old.sql', entry },
    { file: 'db/migrations/meta/_journal.json', status: 'modified', entry },
    { file: 'db/migrations/0010_fine.sql', status: 'added', entry },
  ];
  const f = historyFindings(changed, ['db/migrations/0001_init.sql', 'db/migrations/0009_last.sql', 'db/migrations/meta/_journal.json'], () => entry);
  assert.deepEqual(f.map((x) => [x.rule, x.file, x.line]), [
    ['edited_existing_migration', 'db/migrations/0001_init.sql', 1],
    ['edited_existing_migration', 'db/migrations/0002_gone.sql', null],
    ['edited_existing_migration', 'db/migrations/0009_new_name.sql', 1],
  ]);
  assert.equal(RULES.edited_existing_migration.severity, 'blocker');
});

test('history: a new migration that sorts before the newest on the base is out of order', () => {
  const entry = { tool: 'supabase', dir: 'supabase/migrations' };
  const base = ['supabase/migrations/20260101000000_a.sql', 'supabase/migrations/20260301000000_c.sql'];
  const out = historyFindings([{ file: 'supabase/migrations/20260201000000_b.sql', status: 'added', entry }, { file: 'supabase/migrations/20260401000000_d.sql', status: 'added', entry }], base, () => entry);
  assert.deepEqual(out.map((x) => [x.rule, x.file]), [['out_of_order', 'supabase/migrations/20260201000000_b.sql']]);
  // Per folder: Django numbers every app from 0001.
  const dj = { tool: 'django', paths: ['**/migrations/*.py'] };
  assert.deepEqual(historyFindings([{ file: 'billing/migrations/0002_x.py', status: 'added', entry: dj }], ['users/migrations/0007_y.py', 'billing/migrations/0001_initial.py'], () => dj), []);
});

test('history: a Drizzle journal that does not match the files is a blocker', () => {
  const journal = JSON.stringify({ entries: [{ idx: 0, tag: '0000_init' }, { idx: 1, tag: '0001_ghost' }] });
  const f = journalFindings('db/migrations', journal, ['db/migrations/0000_init.sql', 'db/migrations/0002_unlisted.sql', 'db/migrations/meta/0000_snapshot.json']);
  assert.deepEqual(f.map((x) => x.detail), ['`0002_unlisted.sql` has no journal entry.', 'Journal entry `0001_ghost` has no file.']);
  assert.ok(f.every((x) => x.rule === 'journal_mismatch' && x.file === 'db/migrations/meta/_journal.json'));
  assert.deepEqual(journalFindings('db/migrations', JSON.stringify({ entries: [{ tag: '0000_init' }] }), ['db/migrations/0000_init.sql']), []);
  assert.deepEqual(journalFindings('db/migrations', null, ['db/migrations/0000_init.sql']), []);
  // A tag is text from the change, on its way to a PR comment.
  const evil = journalFindings('db/migrations', JSON.stringify({ entries: [{ tag: '0001_x\n[approve](https://evil.example/x) @org/security' }] }), []);
  assert.deepEqual(evil.map((x) => x.detail), ['Journal entry `a name with unusual characters` has no file.']);
});

test('deploy window: which side of the deploy a change can break', () => {
  const mk = () => fileFindings('m/1.sql', 'ALTER TABLE users DROP COLUMN legacy_id;\nALTER TABLE users ADD COLUMN nick text;').findings;
  const before = mk();
  assert.deepEqual(windowFindings(before, 'before_deploy'), []);
  assert.deepEqual(before.map((f) => f.window), ['old_code', undefined]);
  const after = mk();
  const extra = windowFindings(after, 'after_deploy');
  assert.deepEqual(extra.map((f) => [f.rule, f.count]), [['new_code_needs_schema', 1]]);
  assert.equal(after[0].window, undefined);
  assert.equal(windowFindings(mk(), undefined).length, 0);
});

test('names searched in code after a drop or rename', () => {
  assert.deepEqual(referencedNames({ rule: 'drop_column', table: 'users', column: 'legacy_id' }), ['legacy_id', 'legacyId']);
  assert.deepEqual(referencedNames({ rule: 'drop_table', table: 'sessions' }), ['sessions']);
  assert.deepEqual(referencedNames({ rule: 'drop_column', table: 'users', column: 'id' }), []);
  assert.deepEqual(referencedNames({ rule: 'add_column', table: 'users', column: 'nickname' }), []);
  assert.ok(isMeta('db/migrations/meta/0001_snapshot.json') && !isMeta('db/migrations/0001_a.sql'));
});

// ---------------------------------------------------------------- infrastructure
test('infra: a removed stateful declaration is a blocker; a moved one is not', () => {
  const cdk = fd('infra/lib/data-stack.ts', "-    new s3.Bucket(this, 'Uploads', {\n-    const db = new rds.DatabaseInstance(this, 'Main', {\n+    const db = new rds.DatabaseInstance(this, 'Main', { // moved\n-    new lambda.Function(this, 'Worker', {");
  const f = infraFindings([cdk]);
  assert.deepEqual(f.map((x) => [x.rule, x.normalized]), [['stateful_resource_removed', 'cdk: remove Bucket Uploads']]);
  const tf = fd('terraform/db.tf', '-resource "aws_db_instance" "main" {\n-resource "aws_iam_role" "app" {', { tool: 'terraform' });
  const moved = fd('terraform/storage.tf', '+resource "aws_db_instance" "main" {', { tool: 'terraform', status: 'added' });
  assert.deepEqual(infraFindings([tf]).map((x) => x.normalized), ['terraform: remove aws_db_instance main']);
  assert.deepEqual(infraFindings([tf, moved]), []);
  const cfn = fd('template.yaml', '-    Type: AWS::DynamoDB::Table', { tool: 'cloudformation' });
  assert.deepEqual(infraFindings([cfn]).map((x) => x.rule), ['stateful_resource_removed']);
});

test('infra: a deleted file has no head line', () => {
  const gone = fd('terraform/db.tf', '-resource "aws_s3_bucket" "logs" {', { tool: 'terraform', status: 'deleted' });
  assert.deepEqual(infraFindings([gone]).map((x) => [x.rule, x.line]), [['stateful_resource_removed', null]]);
});

test('infra: weakened deletion guards', () => {
  const cdk = fd('infra/lib/data-stack.ts', '+      removalPolicy: RemovalPolicy.DESTROY,\n+      autoDeleteObjects: true,\n-      deletionProtection: true,\n+      deletionProtection: false,');
  assert.deepEqual(infraFindings([cdk]).map((x) => x.rule), ['deletion_guard_weakened', 'deletion_guard_weakened', 'deletion_guard_weakened', 'deletion_guard_weakened']);
  const tf = fd('terraform/db.tf', '+  skip_final_snapshot = true\n-    prevent_destroy = true', { tool: 'terraform' });
  assert.deepEqual(infraFindings([tf]).map((x) => x.normalized), ['terraform: weaken deletion guard (skip_final_snapshot = true)', 'terraform: remove deletion guard (prevent_destroy = true)']);
  // The guard is still there: it only moved.
  assert.deepEqual(infraFindings([fd('terraform/db.tf', '-    prevent_destroy = true\n+      prevent_destroy = true', { tool: 'terraform' })]), []);
});

test('infra: open ingress fires, egress does not', () => {
  const head = ['resource "aws_security_group" "web" {', '  ingress {', '    from_port = 443', '    cidr_blocks = ["0.0.0.0/0"]', '  }', '  egress {', '    from_port = 0', '    cidr_blocks = ["0.0.0.0/0"]', '  }', '}'];
  const [f] = parsePatch('diff --git a/terraform/sg.tf b/terraform/sg.tf\n--- a/terraform/sg.tf\n+++ b/terraform/sg.tf\n@@ -1,8 +1,10 @@\n resource "aws_security_group" "web" {\n   ingress {\n     from_port = 443\n+    cidr_blocks = ["0.0.0.0/0"]\n   }\n   egress {\n     from_port = 0\n+    cidr_blocks = ["0.0.0.0/0"]\n   }\n }\n');
  const out = infraFindings([{ ...f, tool: 'terraform' }], () => head);
  assert.deepEqual(out.map((x) => [x.rule, x.line]), [['open_ingress', 4]]);
  assert.deepEqual(infraFindings([fd('infra/lib/net.ts', '+    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22));')]).map((x) => x.rule), ['open_ingress']);
  // The direction comes from the rule, not from a comment near it.
  const commented = ['const sg = new SecurityGroup(this, "Web");', '// outbound traffic only', 'const rules = {', "  ingress: [{ cidrIp: '0.0.0.0/0' }],", '};'];
  const [c] = parsePatch("diff --git a/infra/lib/sg.ts b/infra/lib/sg.ts\n--- a/infra/lib/sg.ts\n+++ b/infra/lib/sg.ts\n@@ -1,4 +1,5 @@\n const sg = new SecurityGroup(this, \"Web\");\n // outbound traffic only\n const rules = {\n+  ingress: [{ cidrIp: '0.0.0.0/0' }],\n };\n");
  assert.deepEqual(infraFindings([{ ...c, tool: 'cdk' }], () => commented).map((x) => [x.rule, x.line]), [['open_ingress', 4]]);
  assert.deepEqual(infraFindings([fd('infra/lib/net.ts', '+    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));')]), []);
});

test('infra: wildcard IAM, changed sizing, a removed variable', () => {
  const f = infraFindings([fd('infra/lib/compute-stack.ts', "+      actions: ['*'],\n+      resources: ['arn:aws:s3:::bucket/*'],\n+      actions: ['s3:*'],\n-      instanceType: ec2.InstanceType.of(T3, MEDIUM),\n+      instanceType: ec2.InstanceType.of(T3, SMALL),\n-        STRIPE_KEY: secret.value,\n+        timeout: 30,")]);
  assert.deepEqual(f.map((x) => x.rule), ['iam_wildcard', 'iam_wildcard', 'service_config_changed', 'env_var_removed']);
  assert.equal(f[2].normalized, 'cdk: change instanceType');
  assert.equal(f[3].name, 'STRIPE_KEY');
  // Named actions on any resource is common, and only a note. A new resource's sizing is not a change.
  const quiet = infraFindings([fd('infra/lib/new-stack.ts', "+      actions: ['ses:ListSuppressedDestinations'],\n+      resources: ['*'],\n+      engineVersion: '8.0',\n+      instanceType: small,")]);
  assert.deepEqual(quiet.map((x) => [x.rule, RULES[x.rule].severity]), [['iam_any_resource', 'note']]);
  // Renamed in place is not removed.
  assert.deepEqual(infraFindings([fd('render.yaml', '-      - key: API_URL\n+      - key: API_URL\n+        sync: false', { tool: 'service' })]).map((x) => x.rule), ['service_config_changed']);
  assert.deepEqual(infraFindings([fd('render.yaml', '-      - key: API_URL', { tool: 'service' })]).map((x) => x.rule), ['service_config_changed', 'env_var_removed']);
});

test('infra: an unrelated change fires nothing', () => {
  assert.deepEqual(infraFindings([fd('infra/lib/monitoring-stack.ts', "-    new cloudwatch.Alarm(this, 'Old', {\n+    new cloudwatch.Alarm(this, 'New', {\n+      threshold: 5,")]), []);
});

test('pipeline and env example files', () => {
  // A workflow's own shell variables come and go: one note per file, nothing per line.
  const p = pipelineFindings([fd('.github/workflows/deploy.yml', '-          RES_ENV="$1"\n-          DATABASE_URL: ${{ secrets.DATABASE_URL }}\n+          node-version: 22', { tool: 'pipeline' })]);
  assert.deepEqual(p.map((x) => [x.rule, x.bucket, x.line]), [['pipeline_changed', 'pipeline', 1]]);
  const e = envFindings([fd('.env.example', '+STRIPE_WEBHOOK_SECRET=\n-OLD_FLAG=1\n-RENAMED=1\n+RENAMED=2\n+# COMMENTED=1')]);
  assert.deepEqual(e.map((x) => [x.rule, x.name]), [['env_var_added', 'STRIPE_WEBHOOK_SECRET'], ['env_example_removed', 'OLD_FLAG']]);
  assert.ok(e.every((x) => !/=\S/.test(x.normalized)), 'names only, never a value');
});

test('stateful types as a plan names them', () => {
  for (const t of ['AWS::RDS::DBInstance', 'AWS::S3::Bucket', 'AWS::DynamoDB::GlobalTable', 'aws_db_instance', 'google_storage_bucket', 'aws_elasticache_cluster']) assert.ok(STATEFUL_TYPE.test(t), t);
  for (const t of ['AWS::Lambda::Function', 'AWS::IAM::Role', 'aws_iam_role', 'aws_lambda_function']) assert.ok(!STATEFUL_TYPE.test(t), t);
});

// ---------------------------------------------------------------- buckets
test('buckets: config paths, the defaults, and a file in none', () => {
  const layout = { migrations: [{ tool: 'drizzle', dir: 'app/db/migrations' }], infra: [{ tool: 'cdk', paths: ['infra/**'] }], explicit: { migrations: true, infra: true } };
  const b = (f, l = layout) => bucketOf(f, l)?.bucket ?? null;
  assert.equal(b('app/db/migrations/0001_a.sql'), 'migration');
  assert.equal(b('app/db/migrations/meta/_journal.json'), 'migration');
  assert.equal(b('infra/lib/data-stack.ts'), 'infra');
  assert.equal(b('infra/test/data-stack.test.ts'), null);
  assert.equal(b('infra/README.md'), null);
  assert.equal(b('.github/workflows/deploy.yml'), 'pipeline');
  assert.equal(b('.github/workflows/quality.yml'), null);
  assert.equal(b('.env.example'), 'env');
  assert.equal(b('app/server/users.ts'), null);
  // The config answered: a folder it did not name is not picked up by default.
  assert.equal(b('supabase/migrations/2026_a.sql'), null);
  assert.equal(b('terraform/main.tf'), null);
  // No config: the defaults see a first migration folder and a first Terraform file.
  assert.equal(b('supabase/migrations/2026_a.sql', {}), 'migration');
  assert.equal(b('services/api/migrations/0001_a.sql', {}), 'migration');
  assert.equal(bucketOf('terraform/main.tf', {}).entry.tool, 'terraform');
  assert.equal(bucketOf('render.yaml', {}).entry.tool, 'service');
  assert.equal(b('src/migrations.ts', {}), null);
});

// ---------------------------------------------------------------- verdict
test('every verdict row', () => {
  const f = (rule) => ({ rule });
  assert.equal(verdict({ findings: [f('drop_table'), f('index_not_concurrent')] }).verdict, 'blocked');
  assert.equal(verdict({ findings: [f('index_not_concurrent'), f('create_table')] }).verdict, 'caution');
  assert.equal(verdict({ findings: [f('create_table')], unchecked: ['m/1.sql:2 could not be classified'] }).verdict, 'unverified');
  assert.equal(verdict({ findings: [f('create_table')] }).verdict, 'safe');
  assert.equal(verdict({ findings: [], bucketed: 0 }).verdict, 'nothing_to_check');
  assert.deepEqual(verdict({ findings: [f('drop_table'), f('create_table'), { rule: 'x', severity: 'risk' }] }).counts, { blocker: 1, risk: 1, note: 1 });
  // A risk with something unchecked is still caution, and says what was unchecked.
  assert.deepEqual(verdict({ findings: [f('rename_column')], unchecked: ['no plan'] }), { verdict: 'caution', counts: { blocker: 0, risk: 1, note: 0 }, unchecked: ['no plan'] });
});
