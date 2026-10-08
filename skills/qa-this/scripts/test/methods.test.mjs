import { test } from 'node:test';
import assert from 'node:assert/strict';

const { available, choose, METHODS } = await import('../lib/methods.mjs');
const { applyBudget, coverage, itemStatus, BUDGET, STATUSES } = await import('../lib/status.mjs');

const config = {
  production_hosts: ['app.example.com'],
  environments: [{ name: 'local', kind: 'local', base_url: 'http://localhost:3000' }, { name: 'prod', kind: 'staging', base_url: 'https://app.example.com' }],
  tests: { unit: 'npm test --', globs: ['**/*.test.ts'] },
  databases: [{ env: 'local', how: 'psql' }],
  runtime: { sentry: {} },
  path_rules: [{ pattern: '^apps/billing/', methods: ['database'] }, { pattern: '(', methods: ['api'] }],
};
const names = (xs) => xs.map((m) => m.method);
const crit = [{ id: 'c1', text: 'a' }];
const covered = [{ criterion: 'c1', method: 'checks' }];

test('default rules pick methods from what changed', () => {
  assert.deepEqual(names(choose({ changed_files: ['src/lib/math.ts'], criteria: crit, checks: covered }, config)), ['checks']);
  assert.deepEqual(names(choose({ changed_files: ['src/components/Bell.tsx'], criteria: crit, checks: covered }, config)), ['checks', 'browser', 'runtime']);
  assert.deepEqual(names(choose({ changed_files: ['db/migrations/001.sql'], criteria: crit, checks: covered }, config)), ['checks', 'database']);
  assert.deepEqual(names(choose({ changed_files: ['src/api/orders.ts'], criteria: crit, checks: covered }, config)), ['checks', 'api', 'runtime']);
  // A UI change covers its own API change.
  assert.deepEqual(names(choose({ changed_files: ['src/api/orders.ts', 'src/pages/orders.tsx'], criteria: crit, checks: covered }, config)), ['checks', 'browser', 'runtime']);
  // A changed test file alone says nothing about what to exercise.
  assert.deepEqual(names(choose({ changed_files: ['src/components/Bell.test.tsx'], criteria: crit, checks: covered }, config)), ['checks']);
});

test('a user-visible criterion, a path rule and an added method each add one', () => {
  assert.ok(names(choose({ changed_files: [], criteria: [{ id: 'c1', user_visible: true }], checks: covered }, config)).includes('browser'));
  const billed = choose({ changed_files: ['apps/billing/charge.ts'], criteria: crit, checks: covered }, config);
  assert.match(billed.find((m) => m.method === 'database').why, /path rule/);
  assert.deepEqual(names(choose({ changed_files: [], criteria: crit, checks: covered }, config, [{ method: 'api', why: '--method' }, { method: 'nope', why: 'x' }])), ['checks', 'api', 'runtime']);
});

test('a criterion with no existing test asks for a new one, when there is somewhere to put it', () => {
  assert.ok(names(choose({ changed_files: [], criteria: crit, checks: [] }, config)).includes('new_tests'));
  assert.ok(!names(choose({ changed_files: [], criteria: crit, checks: [] }, { ...config, tests: { unit: 'x' } })).includes('new_tests'));
});

test('availability names why a method cannot run', () => {
  const a = available(config, { browser: true }, 'local');
  assert.deepEqual(METHODS.filter((m) => a[m].ok), METHODS);
  assert.match(available(config, {}, 'local').browser.reason, /no browser/);
  assert.match(available(config, { browser: true }, 'prod').browser.reason, /production host/);
  assert.match(available(config, { browser: true }, 'prod').database.reason, /production host/);
  assert.match(available({ ...config, databases: [] }, {}, 'local').database.reason, /no databases entry/);
  const bare = available({}, { browser: true }, null);
  assert.deepEqual(METHODS.filter((m) => bare[m].ok), []);
});

test('coverage: a criterion needs a check that is not weak', () => {
  const criteria = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(coverage(criteria, [{ criterion: 'a' }, { criterion: 'b', weak: true }]), { covered: ['a'], uncovered: ['b', 'c'] });
});

test('budgets cut and count', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: i }));
  const r = applyBudget([{ checks: many(40) }, { checks: many(5) }]);
  assert.deepEqual(r.items.map((i) => i.checks.length), [BUDGET.per_item, 5]);
  assert.equal(r.cut, 10);
  const big = applyBudget(Array.from({ length: 6 }, () => ({ checks: many(30) })));
  assert.equal(big.items.reduce((n, i) => n + i.checks.length, 0), BUDGET.per_run);
  assert.equal(big.cut, 30);
});

test('every status, and a failed check never yields passed', () => {
  const c = [{ id: 'a' }, { id: 'b' }];
  const pass = (criterion) => ({ criterion, result: 'pass' });
  const got = {
    passed: itemStatus({ criteria: c, checks: [pass('a'), pass('b')] }),
    failed: itemStatus({ criteria: c, checks: [pass('a'), { criterion: 'b', result: 'fail' }] }),
    partial: itemStatus({ criteria: c, checks: [pass('a')] }),
    blocked: itemStatus({ criteria: c, checks: [{ criterion: 'a' }], blocked: 'sign-in' }),
    not_run: itemStatus({ criteria: [], checks: [] }),
  };
  assert.deepEqual(Object.keys(got), STATUSES);
  for (const [want, have] of Object.entries(got)) assert.equal(have, want);
  assert.equal(itemStatus({ criteria: c, checks: [pass('a'), pass('b')], dropped: true }), 'not_run');
  assert.equal(itemStatus({ criteria: c, checks: [pass('a'), { criterion: 'b', result: 'skipped' }] }), 'partial');
  assert.equal(itemStatus({ criteria: c, checks: [pass('a'), { criterion: 'b' }] }), 'partial');
  assert.equal(itemStatus({ criteria: c, checks: [pass('a'), pass('b')], blocked: 'tester stopped' }), 'partial');
  // Environmental failures only: not a product failure, and not a pass.
  assert.equal(itemStatus({ criteria: c, checks: [pass('a'), { criterion: 'b', result: 'fail', environmental: true }] }), 'blocked');
  assert.equal(itemStatus({ criteria: c, checks: [{ criterion: 'a', result: 'fail', environmental: true }, { criterion: 'b', result: 'fail' }] }), 'failed');
  for (const extra of [{}, { blocked: 'x' }, { dropped: false }]) {
    assert.notEqual(itemStatus({ criteria: c, checks: [pass('a'), pass('b'), { criterion: 'b', result: 'fail' }], ...extra }), 'passed');
  }
});
