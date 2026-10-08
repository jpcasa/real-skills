import { test } from 'node:test';
import assert from 'node:assert/strict';

const { checkSelect, ROW_LIMIT } = await import('../lib/sql.mjs');
const ok = (sql) => assert.equal(checkSelect(sql).ok, true, `${sql} -> ${checkSelect(sql).reason}`);
const no = (sql, re) => {
  const r = checkSelect(sql);
  assert.equal(r.ok, false, `accepted: ${sql}`);
  if (re) assert.match(r.reason, re);
};

test('reads are accepted', () => {
  ok('select 1');
  ok('SELECT id, updated_at, deleted_at FROM orders WHERE status = \'paid\';');
  ok('with recent as (select * from orders limit 5) select count(*) from recent');
  ok("select * from notes where body = 'please; drop table x -- not a comment'");
  ok('select "update", created_at from audit');
  ok("select $tag$ ; delete from x $tag$ as s");
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
  no('select pg_sleep(10)', /pg_sleep/);
  no("select * from dblink('host=x', 'select 1') as t(a int)", /dblink/);
  no("select nextval('orders_id_seq')", /nextval/);
  no('explain analyze delete from x', /not a SELECT/);
});

test('a comment cannot hide a second statement', () => {
  no('select 1 /* ok */; delete from x', /more than one/);
  no('select 1 -- fine\n; delete from x', /more than one/);
  no('select 1 /* open', /unterminated comment/);
  no("select 'open", /unterminated quote/);
});

test('a backslash in a literal is refused, because databases disagree on what it ends', () => {
  no("select * from t where a = '\\'; delete from t; --'", /backslash/);
});

test('a row limit is added once, and only when the statement has none of its own', () => {
  assert.equal(checkSelect('select * from orders;').sql, `select * from orders\nLIMIT ${ROW_LIMIT}`);
  assert.equal(checkSelect('select * from orders limit 3').sql, 'select * from orders limit 3');
  assert.match(checkSelect('select * from (select * from a limit 2) t').sql, new RegExp(`LIMIT ${ROW_LIMIT}$`));
  assert.equal(checkSelect("select 'limit' from t").sql, `select 'limit' from t\nLIMIT ${ROW_LIMIT}`);
});
