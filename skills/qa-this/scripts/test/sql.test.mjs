import { test } from 'node:test';
import assert from 'node:assert/strict';

const { checkSelect, ROW_LIMIT } = await import('../lib/sql.mjs');
const ok = (sql) => assert.equal(checkSelect(sql).ok, true, `${sql} -> ${checkSelect(sql).reason}`);
const no = (sql, re) => {
  const r = checkSelect(sql);
  assert.equal(r.ok, false, `accepted: ${sql}`);
  if (re) assert.match(r.reason, re);
};

test('plain reads are accepted', () => {
  ok('select 1');
  ok("SELECT id, updated_at, deleted_at FROM orders WHERE status = 'paid';");
  ok('with recent as (select * from orders limit 5) select count(*) from recent');
  ok("select * from notes where body = 'please; drop table x -- not a comment # nor this /* or this */'");
  ok('select "order id", created_at from audit');
  ok("select count(*), max(total) from orders o join users u on (u.id = o.user_id) where u.email = 'a@b.co' and o.id in (1, 2)");
  ok("select lower(name), coalesce(total, 0)::numeric(10, 2) from t where created_at > now() - interval '1 day' group by 1, 2");
  ok('select row_number() over (partition by a order by b) from t');
  ok("select data->>'key' from t where exists (select 1 from u where u.id = t.id)");
  ok('select tags[1], arr[1:2], json_agg(id), typeof(x) from t');
});

test('anything that is not one read is refused', () => {
  no('', /empty/);
  no('update orders set a = 1', /not a SELECT/);
  no('select 1; select 2', /more than one/);
  no('select 1; drop table x', /more than one/);
  no('select * into backup from orders', /into/);
  no('select * from orders for update', /update/);
  no('select * from orders for share', /locking/);
  no('with gone as (delete from orders returning *) select * from gone', /delete/);
  no('explain analyze delete from x', /not a SELECT/);
  no('table orders', /not a SELECT/);
  no('select @a := 1', /assignment/);
  no(`select ${'1,'.repeat(2500)}1`, /longer than/);
});

test('a function is refused unless it is on the read-only list', () => {
  no('select pg_sleep(10)', /pg_sleep/);
  no('select pg_sleep (10)', /pg_sleep/);
  no('select pg_catalog.pg_sleep(10)', /pg_sleep/);
  no("select * from dblink('host=x', 'select 1') as t(a int)", /dblink/);
  no("select nextval('orders_id_seq')", /nextval/);
  no("select pg_read_file('/etc/passwd')", /pg_read_file/);
  no("select lo_import('/etc/passwd')", /lo_import/);
  no("select writefile('/tmp/x', 'y')", /writefile/);
  no("select readfile('/etc/hosts')", /readfile/);
  no("select load_extension('x')", /load_extension/);
  no('select sleep(5)', /sleep/);
  no("select load_file('/etc/passwd')", /load_file/);
  no('select txid_current()', /txid_current/);
  no('select * from generate_series(1, 1000000000)', /generate_series/);
  no("select repeat('x', 1000000000)", /repeat/);
});

// Each of these was accepted by an earlier version and ran something else in a real database.
test('what the databases read differently is refused outright', () => {
  no('select 1\n\\! touch /tmp/pwned', /line may not start/);
  no('select 1\n  \\copy t to /tmp/x', /line may not start/);
  no('select 1\n.shell touch /tmp/pwned', /line may not start/);
  no('select 1 # x; with d as (delete from t where id = 1) select 1', /comments are not allowed/);
  no('select "pg_sleep"(2)', /pg_sleep/);
  no('select 1 as a$b$; delete from t where id = 2; select 1 as x$b$', /dollar sign/);
  no("select $tag$ ; delete from x $tag$ as s", /dollar sign/);
  no("select name from users /*!into outfile '/tmp/x'*/", /comments are not allowed/);
  no('select 1 /* /* */ ; delete from t where id = 1 -- */', /comments are not allowed/);
  no('select 1 --x; delete from t where id = 1', /comments are not allowed/);
  no('select 1 /* ok */', /comments are not allowed/);
  no("select * from t where a = '\\'; delete from t; --'", /backslash/);
  no("select e'\\x27; delete from t'", /backslash/);
  no("select ` ' ` , ' ; delete from t ; '", /backticks/);
  no("select [']; delete from t; select [']", /inside \[ \]/);
  no('select [1 \\! touch /tmp/pwned # ]', /line may not start|inside \[ \]/);
  no('select x [1 \\! touch /tmp/pwned ]', /inside \[ \]/);
  no('select [a;b]', /inside \[ \]/);
  no('select U&"d!0065lete" UESCAPE \'!\'', /U&/);
  no("select U&'x'", /U&/);
  no('select "a;b" from t', /double-quoted name/);
  no('select "a\'b" from t', /double-quoted name/);
  no("select 'open", /unterminated quote/);
  no('select "update" from t', /update/);
});

test('a row limit is added once, and only when the statement has none of its own', () => {
  assert.equal(checkSelect('select * from orders;').sql, `select * from orders\nLIMIT ${ROW_LIMIT}`);
  assert.equal(checkSelect('select * from orders limit 3').sql, 'select * from orders limit 3');
  assert.match(checkSelect('select * from (select * from a limit 2) t').sql, new RegExp(`LIMIT ${ROW_LIMIT}$`));
  assert.equal(checkSelect("select 'limit' from t").sql, `select 'limit' from t\nLIMIT ${ROW_LIMIT}`);
});
