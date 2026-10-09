import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitStatements, classify, normalize } from '../lib/sql.mjs';
import { RULES } from '../lib/rules.mjs';

const rules = (sql) => splitStatements(sql).flatMap((s) => classify(s).map((h) => h.rule));
const one = (sql) => {
  const hits = splitStatements(sql).flatMap(classify);
  assert.equal(hits.length, 1, `${sql} -> ${JSON.stringify(hits)}`);
  return hits[0];
};

test('every statement rule fires on its statement', () => {
  const cases = {
    'DROP TABLE legacy_users;': 'drop_table',
    'drop table if exists public."Legacy" cascade;': 'drop_table',
    'ALTER TABLE users DROP COLUMN legacy_id;': 'drop_column',
    'ALTER TABLE users DROP legacy_id;': 'drop_column',
    'TRUNCATE TABLE audit_logs;': 'truncate',
    'DROP SCHEMA reporting CASCADE;': 'drop_schema',
    'DELETE FROM sessions;': 'delete_without_where',
    'ALTER TABLE users ALTER COLUMN age TYPE bigint;': 'alter_column_type',
    'ALTER TABLE users ALTER COLUMN age SET DATA TYPE bigint USING age::bigint;': 'alter_column_type',
    'ALTER TABLE users ALTER COLUMN email SET NOT NULL;': 'set_not_null',
    'ALTER TABLE users ADD COLUMN tenant_id uuid NOT NULL;': 'add_not_null_without_default',
    'ALTER TABLE users RENAME TO accounts;': 'rename_table',
    'ALTER TABLE users RENAME COLUMN name TO full_name;': 'rename_column',
    'CREATE INDEX users_email_idx ON users (email);': 'index_not_concurrent',
    'CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON public.users USING btree (email);': 'index_not_concurrent',
    'ALTER TABLE orders ADD CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES users(id);': 'fk_without_not_valid',
    'ALTER TABLE orders ADD CONSTRAINT orders_total_check CHECK (total >= 0);': 'add_constraint_scans_table',
    'ALTER TABLE orders ADD UNIQUE (reference);': 'add_constraint_scans_table',
    "UPDATE users SET status = 'active';": 'update_without_where',
    'ALTER TABLE users ENABLE ROW LEVEL SECURITY;': 'rls_enabled',
    'ALTER TABLE users DISABLE ROW LEVEL SECURITY;': 'rls_disabled',
    'DROP POLICY "read own" ON users;': 'policy_dropped',
    'GRANT SELECT ON users TO anon;': 'grant_to_public',
    'GRANT ALL ON ALL TABLES IN SCHEMA public TO PUBLIC;': 'grant_to_public',
    'DROP FUNCTION IF EXISTS public.touch(uuid);': 'drop_object',
    'DROP VIEW active_users;': 'drop_object',
    "ALTER TYPE status RENAME VALUE 'a' TO 'b';": 'alter_type',
    'CREATE TABLE IF NOT EXISTS "public"."things" (id uuid primary key);': 'create_table',
    'ALTER TABLE users ADD COLUMN nickname text;': 'add_column',
    "ALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT 'free';": 'add_column',
    'CREATE INDEX CONCURRENTLY users_email_idx ON users (email);': 'index_concurrent',
    'CREATE POLICY "read own" ON users FOR SELECT USING (auth.uid() = id);': 'create_policy',
    'CREATE OR REPLACE FUNCTION touch() RETURNS trigger AS $$ BEGIN DROP TABLE x; END $$ LANGUAGE plpgsql;': 'replace_object',
    'CREATE EXTENSION IF NOT EXISTS pgcrypto;': 'create_object',
    "INSERT INTO plans (name) VALUES ('free');": 'data_change',
    "UPDATE users SET status = 'active' WHERE status IS NULL;": 'data_change',
    'DELETE FROM sessions WHERE expires_at < now();': 'data_change',
    'DROP INDEX users_email_idx;': 'drop_index',
    'ALTER TABLE orders DROP CONSTRAINT orders_total_check;': 'drop_constraint',
    'ALTER TABLE users ALTER COLUMN plan SET DEFAULT 0;': 'alter_other',
    'ALTER TABLE orders ADD CONSTRAINT o_fk FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;': 'alter_other',
    'ALTER TABLE orders VALIDATE CONSTRAINT o_fk;': 'alter_other',
    "ALTER TYPE status ADD VALUE 'archived';": 'enum_value_added',
    'REVOKE ALL ON users FROM app;': 'grant_changed',
    "SELECT cron.schedule('nightly', '0 0 * * *', 'select 1');": 'function_call',
    'ALTER TABLE `users` MODIFY COLUMN `age` BIGINT;': 'alter_column_type',
  };
  for (const [sql, rule] of Object.entries(cases)) {
    assert.deepEqual(rules(sql), [rule], sql);
    assert.ok(RULES[rule], `${rule} is in the rule table`);
  }
});

test('statements that change nothing produce no hit', () => {
  assert.deepEqual(rules("BEGIN; SET search_path = public; COMMENT ON TABLE users IS 'people'; COMMIT;"), []);
});

test('a keyword inside a string, a comment or a dollar-quoted body fires nothing', () => {
  assert.deepEqual(rules("INSERT INTO notes (body) VALUES ('please DROP TABLE users; now');"), ['data_change']);
  assert.deepEqual(rules('-- DROP TABLE users;\n/* TRUNCATE x; /* nested */ DELETE FROM y; */\nCREATE TABLE a (id int);'), ['create_table']);
  assert.deepEqual(rules('CREATE FUNCTION f() RETURNS void AS $fn$ BEGIN DELETE FROM users; END; $fn$ LANGUAGE plpgsql;'), ['create_object']);
  assert.deepEqual(rules("INSERT INTO t (a) VALUES (E'it\\'s; DROP TABLE x');"), ['data_change']);
  assert.deepEqual(rules("INSERT INTO t (a) VALUES ('it''s; DROP TABLE x');"), ['data_change']);
});

test('an unknown statement is unparsed, never assumed harmless', () => {
  assert.deepEqual(rules('DO $$ BEGIN EXECUTE format(\'DROP TABLE %I\', t); END $$;'), ['unparsed']);
  assert.deepEqual(rules('WITH gone AS (DELETE FROM a RETURNING *) INSERT INTO b SELECT * FROM gone;'), ['unparsed']);
  assert.deepEqual(rules('EXECUTE some_prepared_statement;'), ['unparsed']);
  assert.deepEqual(rules('LOCK TABLE users IN ACCESS EXCLUSIVE MODE;'), ['unparsed']);
  assert.deepEqual(rules('ALTER TABLE users DETACH PARTITION users_2020;'), ['unparsed']);
});

test('a WHERE inside a subquery does not limit the statement around it', () => {
  assert.deepEqual(rules('UPDATE user_tasks ut SET sort_order = COALESCE((SELECT t.sort_order FROM items t WHERE t.id = ut.item_id), 0);'), ['update_without_where']);
  assert.deepEqual(rules('UPDATE auth.users AS u SET meta = p.meta FROM profiles p WHERE p.id = u.id;'), ['data_change']);
  assert.deepEqual(rules('update corrective_actions ca set doc_id = d.id from documents d where d.kind = ca.kind;'), ['data_change']);
  assert.deepEqual(rules('DELETE FROM sessions WHERE id IN (SELECT id FROM old);'), ['data_change']);
  assert.deepEqual(rules('DELETE FROM sessions s USING old o WHERE o.id = s.id;'), ['data_change']);
  assert.deepEqual(rules('DELETE FROM sessions RETURNING (SELECT 1 WHERE true);'), ['delete_without_where']);
  assert.equal(one('UPDATE "public"."users" "u" SET a = 1;').table, 'users');
});

test('WITH … followed by a write is read as that write', () => {
  assert.deepEqual(rules('WITH ranked AS (SELECT id, row_number() OVER (PARTITION BY k ORDER BY id) n FROM a WHERE x) DELETE FROM a USING ranked r WHERE r.id = a.id AND r.n > 1;'), ['data_change']);
  assert.deepEqual(rules('WITH gone AS (SELECT id FROM a WHERE old) DELETE FROM a;'), ['delete_without_where']);
  assert.deepEqual(rules('WITH src AS (SELECT 1) UPDATE a SET x = 1;'), ['update_without_where']);
  assert.deepEqual(rules('WITH src AS (SELECT id FROM b) INSERT INTO a (id) SELECT id FROM src;'), ['data_change']);
  assert.deepEqual(rules('WITH x AS (SELECT 1) SELECT setval(?, 1) FROM x;'), ['function_call']);
});

test('a limit that limits nothing', () => {
  assert.deepEqual(rules('DELETE FROM users WHERE 1=1;'), ['delete_without_where']);
  assert.deepEqual(rules('DELETE FROM users WHERE true;'), ['delete_without_where']);
  assert.deepEqual(rules("UPDATE users SET email = NULL WHERE 'a' = 'a';"), ['update_without_where']);
  assert.deepEqual(rules('DELETE FROM users USING staging_ids;'), ['delete_without_where']);
  assert.deepEqual(rules('DELETE FROM "where";'), ['delete_without_where']);
  assert.deepEqual(rules('DELETE FROM "using" u;'), ['delete_without_where']);
  assert.deepEqual(rules('DELETE FROM users WHERE (expires_at < now());'), ['data_change']);
  assert.deepEqual(rules('DELETE FROM users WHERE "deleted";'), ['data_change']);
});

test('statements the splitter cannot be sure it cut right are unparsed, and so is everything after', () => {
  // psql runs a backslash line on its own; the DROP after it is a statement.
  assert.deepEqual(rules('\\set ON_ERROR_STOP off\nDROP TABLE users;'), ['unparsed', 'drop_table']);
  // A transaction word is a no-op only as the whole statement.
  assert.deepEqual(rules('BEGIN\nDROP TABLE users;'), ['unparsed']);
  assert.deepEqual(rules('BEGIN; START TRANSACTION ISOLATION LEVEL SERIALIZABLE; SAVEPOINT a; ROLLBACK TO SAVEPOINT a; COMMIT;'), []);
  // MySQL: a new delimiter, and a backslash before a quote, both move the statement boundaries.
  assert.deepEqual(rules('DELIMITER //\nDROP TABLE users//\nDELIMITER ;\nCREATE TABLE a (id int);'), ['unparsed', 'unparsed']);
  assert.deepEqual(rules("INSERT INTO t VALUES ('O\\'Brien'); ALTER TABLE users DROP COLUMN email;"), ['unparsed']);
  assert.deepEqual(rules("CREATE TABLE a (id int); INSERT INTO t VALUES ('x\\'); DROP TABLE b;"), ['create_table', 'unparsed', 'unparsed']);
});

test('a function can do anything: only well-known harmless calls are a note', () => {
  assert.deepEqual(rules('SELECT purge_all_users();'), ['unparsed']);
  assert.deepEqual(rules('CALL purge_all_users();'), ['unparsed']);
  assert.deepEqual(rules("SELECT setval(pg_get_serial_sequence('users', 'id'), coalesce(max(id), 1)) FROM users;"), ['function_call']);
  assert.deepEqual(rules("SELECT pg_catalog.set_config('search_path', '', false);"), ['function_call']);
  assert.deepEqual(rules('WITH x AS (SELECT 1) SELECT wipe() FROM x;'), ['unparsed']);
});

test('MERGE, lists and CASCADE', () => {
  assert.deepEqual(rules('MERGE INTO users t USING src s ON t.id = s.id WHEN NOT MATCHED BY SOURCE THEN DELETE;'), ['unparsed']);
  assert.deepEqual(rules('MERGE INTO users t USING src s ON t.id = s.id WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id);'), ['data_change']);
  assert.deepEqual(splitStatements('TRUNCATE a, public.users RESTART IDENTITY CASCADE;').flatMap(classify).map((h) => [h.rule, h.table]), [['truncate', 'a'], ['truncate', 'users']]);
  assert.deepEqual(splitStatements('DROP TABLE IF EXISTS a, ONLY b CASCADE;').flatMap(classify).map((h) => h.table), ['a', 'b']);
  assert.deepEqual(rules('DROP TYPE status CASCADE;'), ['drop_cascade']);
  assert.deepEqual(rules('DROP EXTENSION IF EXISTS hstore CASCADE;'), ['drop_cascade']);
  assert.deepEqual(rules('DROP TYPE status;'), ['drop_object']);
  assert.equal(RULES.drop_cascade.severity, 'blocker');
});

test('quoted names do not hide an action or a rule', () => {
  assert.deepEqual(rules('ALTER TABLE users ADD COLUMN "(" int, DROP COLUMN legacy_id;'), ['add_column', 'drop_column']);
  assert.deepEqual(rules('ALTER TABLE orders ADD CONSTRAINT "orders fk" FOREIGN KEY (user_id) REFERENCES users(id);'), ['fk_without_not_valid']);
  assert.deepEqual(rules('ALTER TABLE orders ADD CONSTRAINT "a check" CHECK (total > 0);'), ['add_constraint_scans_table']);
});

test('the table key: what two statements must share to mean the same table', () => {
  const key = (sql) => one(sql).tkey;
  assert.equal(key('CREATE TABLE users (id int);'), key('DROP TABLE public.users;'));
  assert.equal(key('CREATE TABLE "things" (id int);'), key('CREATE INDEX i ON Things (id);'));
  assert.notEqual(key('CREATE TABLE audit.users (id int);'), key('DROP TABLE public.users;'));
  assert.notEqual(key('CREATE TABLE "Users" (id int);'), key('DROP TABLE users;'));
  assert.equal(one('CREATE TABLE IF NOT EXISTS a (id int);').if_not_exists, true);
  assert.equal(one('CREATE TABLE a (id int);').if_not_exists, false);
});

test('one ALTER TABLE with several actions gives one hit per action', () => {
  const hits = splitStatements('ALTER TABLE users\n  DROP COLUMN a,\n  ADD COLUMN b numeric(10, 2),\n  ALTER COLUMN c SET NOT NULL;').flatMap(classify);
  assert.deepEqual(hits.map((h) => h.rule), ['drop_column', 'add_column', 'set_not_null']);
  assert.deepEqual(hits.map((h) => h.column), ['a', 'b', 'c']);
  assert.ok(hits.every((h) => h.table === 'users'));
});

test('the start line is where the statement begins', () => {
  const stmts = splitStatements('-- first\nCREATE TABLE a (id int);\n\n--> statement-breakpoint\nALTER TABLE a\n  DROP COLUMN b;\n');
  assert.deepEqual(stmts.map((s) => s.line), [2, 5]);
});

test('names are read without schema or quotes', () => {
  const h = one('ALTER TABLE "public"."Users" RENAME COLUMN "fullName" TO "name";');
  assert.deepEqual([h.table, h.column, h.to], ['Users', 'fullName', 'name']);
  assert.equal(one('CREATE INDEX i ON ONLY public.orders (id);').table, 'orders');
});

test('the normalized line holds no literal', () => {
  const h = one("UPDATE users SET email = 'ada@lovelace.example', tries = 42 WHERE id = 'abc-123';");
  assert.ok(!/ada|lovelace|42|abc-123/.test(h.normalized), h.normalized);
  assert.match(h.normalized, /^UPDATE users SET email = \?, tries = \? WHERE id = \?$/);
  assert.ok(normalize(`CREATE TABLE t (${'col text, '.repeat(80)})`).length <= 160);
  assert.equal(one('CREATE TABLE things (id uuid, secret text DEFAULT \'x\');').normalized, 'CREATE TABLE things (…)');
});
