import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'qa-this-'));
process.env.QA_THIS_STATE_DIR = join(tmp, 'state');
process.env.QA_THIS_GH_STUB = join(tmp, 'gh.json');
// Never this machine's real calibration file.
process.env.REAL_SKILLS_CALIBRATION_DIR = join(tmp, 'calibration');
delete process.env.REAL_SKILLS_CALIBRATION;
delete process.env.QA_THIS_TEST_CALIBRATED;
process.env.QA_THIS_JEV = 'off';

const { loadConfig } = await import('../lib/config.mjs');
const { probe } = await import('../lib/probe.mjs');
const { parseArgs } = await import('../lib/items.mjs');
const { requestRefusal } = await import('../lib/runner.mjs');
const { MAX_LINES } = await import('../lib/post.mjs');
const R = await import('../lib/report.mjs');
const S = await import('../lib/state.mjs');
const C = await import('../lib/calibration.mjs');
const QA = await import('../qa.mjs');

// ---------------------------------------------------------------- an app to QA
const server = createServer((req, res) => {
  if (req.url.startsWith('/health')) res.end('{"ok":true}');
  else if (req.url === '/away') res.writeHead(302, { location: 'https://app.example.com/' }).end();
  else if (req.method === 'POST') res.writeHead(201).end('made');
  else res.writeHead(404).end('nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;

const TOKEN = `ghp_${'a'.repeat(36)}`;
const ROW_VALUE = 'ada@lovelace.example';
function makeRepo(name, config) {
  const repo = join(tmp, name);
  const sh = (args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  mkdirSync(join(repo, 'src/components'), { recursive: true });
  mkdirSync(join(repo, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  sh(['config', 'user.email', 't@example.com']);
  sh(['config', 'user.name', 't']);
  writeFileSync(join(repo, 'src/math.mjs'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(repo, 'src/math.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.mjs';\ntest('adds', () => assert.equal(add(1, 2), 3));\n");
  writeFileSync(join(repo, 'src/bad.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails', () => assert.equal(1, 2));\n");
  writeFileSync(join(repo, 'src/components/Bell.tsx'), 'export const Bell = () => null;\n');
  writeFileSync(join(repo, '.claude/qa-this.json'), JSON.stringify(config, null, 2));
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', 'init']);
  return { repo, sh };
}
const CONFIG = {
  tracker: { type: 'linear', id_pattern: '[A-Z]{2,10}-[0-9]+', url_template: 'https://linear.app/acme/issue/{id}' },
  environments: [
    { name: 'local', kind: 'local', base_url: base },
    { name: 'staging', kind: 'staging', base_url: 'https://staging.example.com' },
    { name: 'prod', kind: 'staging', base_url: 'https://app.example.com' },
  ],
  production_hosts: ['app.example.com'],
  tests: { unit: 'node --test', globs: ['**/*.test.mjs'] },
  databases: [{ env: 'local', how: `cat > /dev/null; printf 'id\\temail\\n1\\t${ROW_VALUE}\\n2\\tb@example.com\\n'`, header: true }],
};
const { repo, sh } = makeRepo('app', CONFIG);
writeFileSync(process.env.QA_THIS_GH_STUB, JSON.stringify({
  'pr view 12': { number: 12, title: 'Add the bell', url: 'https://github.com/acme/app/pull/12', state: 'OPEN', headRefName: 'bell', headRefOid: 'abcdef1234567890', files: [{ path: 'src/components/Bell.tsx' }] },
  'pr view --json': { number: 12, title: 'Add the bell', url: 'https://github.com/acme/app/pull/12', state: 'OPEN' },
  'pr list --state': [{ number: 9, title: 'Old', url: 'u', mergedAt: '2001-01-01T00:00:00Z' }, { number: 11, title: 'Fresh', url: 'u', mergedAt: new Date().toISOString() }],
}));

const begin = (args, session = { browser: true }, r = repo) => QA.start({ repo: r, args, session });
const crit = (...ids) => ids.map((id) => ({ id, text: `criterion ${id} holds` }));
const unit = (id, criterion, file = 'src/math.test.mjs') => ({ id, criterion, method: 'checks', action: `run ${file}`, expected: 'the test passes', files: [file] });
const step = (id, criterion, action = 'Open the bell') => ({ id, criterion, method: 'browser', action, expected: 'A list of notifications shows' });
const tester = (steps, extra = {}) => `done\n\`\`\`json\n${JSON.stringify({ role: 'qa-tester', verdict: 'pass', summary: 'ok', qa: { steps }, ...extra })}\n\`\`\`\n`;

// ---------------------------------------------------------------- config, probe, arguments
test('config: qa-this.json wins over wtf.json over changelog.json, and setup is asked only for what is missing', () => {
  const { repo: r } = makeRepo('layers', { tests: { unit: 'x' }, production_hosts: ['mine.example.com'] });
  writeFileSync(join(r, '.claude/wtf.json'), JSON.stringify({ tracker: { type: 'clickup' }, production_hosts: ['theirs.example.com'], environments: [{ name: 'local', kind: 'local', base_url: 'http://localhost:1' }], tests: { unit: 'ignored' } }));
  writeFileSync(join(r, '.claude/changelog.json'), JSON.stringify({ tracker: { type: 'github' } }));
  const c = loadConfig(r);
  assert.equal(c.config.tracker.type, 'clickup');
  assert.deepEqual(c.config.production_hosts, ['mine.example.com']);
  assert.equal(c.sources.environments, '.claude/wtf.json');
  assert.equal(c.config.tests.unit, 'x');
  assert.deepEqual(c.missing, []);
  assert.deepEqual([c.config.post, c.config.screenshots, c.config.report_dir], ['ask', false, 'docs/qa']);
  const bare = makeRepo('bare', {});
  writeFileSync(join(bare.repo, '.claude/changelog.json'), JSON.stringify({ tracker: { type: 'github' } }));
  assert.deepEqual(loadConfig(bare.repo).missing, ['environments', 'production_hosts', 'tests']);
  assert.deepEqual(begin(['some', 'feature'], {}, bare.repo).needs, ['setup']);
});

test('probe finds test files and reads variable names, never values', () => {
  writeFileSync(join(repo, '.env.example'), 'DATABASE_URL=postgres://user:hunter2@db/app\nOTHER=1\n');
  const p = probe(repo);
  assert.deepEqual(p.test_globs[0], { glob: '**/*.test.mjs', files: 2 });
  assert.deepEqual(p.database_vars, ['DATABASE_URL']);
  assert.ok(!JSON.stringify(p).includes('hunter2'));
  assert.deepEqual(p.missing, []);
});

test('arguments: flags, modes and problems', () => {
  const a = parseArgs(['ENG-1', '--env', 'local', '--method', 'database', '--method', 'nope', '--screenshots', '--no-post', '--wat']);
  assert.deepEqual(a.flags, { env: 'local', methods: ['database'], screenshots: true, no_post: true });
  assert.equal(a.problems.length, 2);
  assert.deepEqual(parseArgs(['outcome', 'r', 'i', 'right']).result, 'right');
  assert.deepEqual(parseArgs(['post', 'r', 'a', 'b']).items, ['a', 'b']);
});

// ---------------------------------------------------------------- start
test('start: nothing named asks, and offers what it can see', () => {
  const s = begin([]);
  assert.deepEqual(s.needs, ['input']);
  assert.equal(s.run_id, undefined);
  assert.equal(s.candidates.current_pr.number, 12);
  assert.deepEqual(s.candidates.merged_last_7_days.map((p) => p.number), [11]);
});

test('start: a PR, a ticket, a branch and words become items; a PR brings its own changed files', () => {
  sh(['branch', 'feature/x']);
  const s = begin(['#12', 'ENG-7', 'https://linear.app/acme/issue/ENG-8/slug', 'feature/x', 'the', 'export', 'button', '--env', 'local']);
  assert.deepEqual(s.items.map((i) => [i.id, i.kind]), [['pr-12', 'pr'], ['ENG-7', 'tracker'], ['ENG-8', 'tracker'], ['branch-feature-x', 'branch'], ['text', 'text']]);
  assert.equal(s.items[0].changed_files, 1);
  assert.deepEqual(s.items[0].destination, { kind: 'pr', number: 12, url: 'https://github.com/acme/app/pull/12' });
  assert.deepEqual(s.items[1].destination, { kind: 'tracker', type: 'linear', id: 'ENG-7' });
  assert.equal(s.items[4].destination, null);
  assert.equal(s.env, 'local');
  assert.ok(s.methods.browser.ok && s.methods.database.ok);
  assert.match(s.environments.find((e) => e.name === 'prod').refused, /production host/);
});

test('start: production and an over-long list are refused; several environments is a question', () => {
  assert.match(begin(['ENG-1', '--env', 'prod']).refused, /production host/);
  assert.match(begin(Array.from({ length: 11 }, (_, i) => `ENG-${i + 1}`)).refused, /at most 10/);
  const s = begin(['ENG-1']);
  assert.deepEqual(s.needs, ['env']);
  assert.equal(s.env, null);
});

// ---------------------------------------------------------------- plan
test('plan: methods come from code, unselected and unavailable checks are set aside, uncovered criteria are named', async () => {
  const s = begin(['#12', '--env', 'local'], { browser: false });
  const p = await QA.plan({
    run: s.run_id,
    items: [{ id: 'pr-12', criteria: crit('a', 'b', 'c'), checks: [unit('t1', 'a'), step('s1', 'b'), { id: 'q1', criterion: 'c', method: 'database', action: 'count', expected: 'two rows', sql: 'select 1', expect: { rows_eq: 2 } }] }],
  });
  const it = p.items[0];
  assert.deepEqual(it.methods.map((m) => m.method), ['checks', 'new_tests']);
  assert.match(it.unavailable.find((u) => u.method === 'browser').reason, /no browser/);
  assert.deepEqual(it.set_aside.map((c) => c.method).sort(), ['browser', 'database']);
  assert.deepEqual(it.uncovered.map((u) => u.id), ['b', 'c']);
  assert.match(it.uncovered[0].why, /browser unavailable/);
  assert.match(it.uncovered[1].why, /database was not selected/);
  assert.equal(p.confirmed, false);
  // The user adds a method at the plan question.
  const again = await QA.plan({ run: s.run_id, items: [{ id: 'pr-12', add: ['database'] }] });
  assert.deepEqual(again.items[0].uncovered.map((u) => u.id), ['b']);
  assert.equal(again.items[0].checks.database, 1);
});

test('plan: a check that cannot be run as written is invalid, with the reason', async () => {
  const s = begin(['ENG-1', '--env', 'staging', '--method', 'database', '--method', 'api']);
  const mk = (id, more) => ({ id, criterion: 'a', action: 'x', expected: 'y', ...more });
  const p = await QA.plan({
    run: s.run_id,
    items: [{ id: 'ENG-1', criteria: crit('a'), checks: [
      mk('sql', { method: 'database', sql: 'delete from users', expect: { rows_eq: 0 } }),
      mk('noexpect', { method: 'database', sql: 'select 1' }),
      mk('gone', { method: 'checks', files: ['src/nope.test.mjs'] }),
      mk('escape', { method: 'checks', files: ['../x.test.mjs'] }),
      mk('outside', { method: 'new_tests', files: ['src/math.mjs'] }),
      mk('post', { method: 'api', request: { method: 'POST', path: '/orders' } }),
      mk('abs', { method: 'api', request: { path: 'https://app.example.com/' } }),
      mk('auth', { method: 'api', request: { path: '/me', headers: { Authorization: 'x' } } }),
      mk('crit', { method: 'checks', criterion: 'zzz' }),
      mk('ok', { method: 'api', request: { path: '/health' } }),
      mk('ok', { method: 'api', request: { path: '/health' } }),
    ] }],
  });
  const why = Object.fromEntries(p.items[0].invalid.map((i) => [i.id, i.reason]));
  assert.match(why.sql, /SQL refused/);
  assert.match(why.noexpect, /needs expect/);
  assert.match(why.gone, /does not exist/);
  assert.match(why.escape, /inside the repo/);
  assert.match(why.outside, /outside tests.globs/);
  assert.match(why.post, /changes data/);
  assert.match(why.abs, /must be a path/);
  assert.match(why.auth, /credential/);
  assert.match(why.crit, /not one of/);
  assert.match(why.ok, /duplicate/);
  assert.equal(p.items[0].checks.api, 1);
  // The user accepts data changes: the POST is planned.
  const yes = await QA.plan({ run: s.run_id, data_changes: true, items: [{ id: 'ENG-1', criteria: crit('a'), checks: [mk('post', { method: 'api', request: { method: 'POST', path: '/orders' } })] }] });
  assert.deepEqual(yes.items[0].invalid, []);
  assert.equal(yes.ask.may_change_data, true);
});

test('plan: production is refused, the tester prompt is written, the budget cuts, and nothing runs unconfirmed', async () => {
  const s = begin(['#12', '--env', 'local']);
  assert.match((await QA.plan({ run: s.run_id, env: 'prod' })).refused, /production host/);
  const many = Array.from({ length: 35 }, (_, i) => step(`s${i}`, 'a', `Step ${i}`));
  const p = await QA.plan({ run: s.run_id, env: 'local', items: [{ id: 'pr-12', criteria: crit('a'), checks: many }] });
  assert.equal(p.items[0].checks.browser, 30);
  assert.equal(p.cut_by_budget, 5);
  const prompt = readFileSync(p.items[0].tester.prompt_file, 'utf8');
  assert.match(prompt, /Never production/);
  assert.match(prompt, /30\. Step 29/);
  assert.match(prompt, /Never type credentials/);
  assert.equal(p.items[0].tester.subagent_type, 'real-skills:qa-tester');
  assert.deepEqual(p.ask.posts_to, [{ item: 'pr-12', kind: 'pr', number: 12, url: 'https://github.com/acme/app/pull/12' }]);
  assert.match((await QA.runChecks({ run: s.run_id })).refused, /not confirmed/);
  assert.match(QA.testsOpen(s.run_id).refused, /not confirmed/);
  const empty = begin(['ENG-2', '--env', 'local']);
  assert.match((await QA.plan({ run: empty.run_id, confirmed: true })).problems[0], /nothing to run/);
});

// ---------------------------------------------------------------- a full run
test('a run: commands, a query and requests are executed here, and the statuses follow from them', async () => {
  const s = begin(['#12', 'ENG-3', 'checkout', 'flow', '--env', 'local', '--method', 'database', '--method', 'api']);
  const q = (id, criterion, expect) => ({ id, criterion, method: 'database', action: 'Count the users', expected: 'Two users exist', sql: `select id, email from users where email <> '${ROW_VALUE}'`, expect });
  const http = (id, criterion, request, expect) => ({ id, criterion, method: 'api', action: `${request.method || 'GET'} ${request.path}`, expected: 'It answers', request, expect });
  const p = await QA.plan({
    run: s.run_id, confirmed: true,
    items: [
      { id: 'pr-12', criteria: crit('a', 'b', 'c'), checks: [unit('t1', 'a'), q('q1', 'b', { rows_eq: 2 }), http('h1', 'c', { path: '/health?token=abc' }, { status: 200, body_includes: 'ok' }), step('s1', 'c'), step('s2', 'c', 'Click Mark all read')] },
      { id: 'ENG-3', title: 'Orders export', criteria: crit('a', 'b'), checks: [unit('t1', 'a', 'src/bad.test.mjs'), q('q1', 'b', { rows_gte: 5 }), http('h1', 'b', { path: '/missing' }), http('h2', 'b', { path: '/away' }, { status: 302 }), http('h3', 'b', { method: 'POST', path: '/orders', body: { a: 1 } }, { status: [200, 201] })] },
      { id: 'text', criteria: crit('a', 'b'), checks: [unit('t1', 'a')] },
    ],
  });
  assert.equal(p.ok, true);
  assert.equal(p.confirmed, true);

  const r = await QA.runChecks({ run: s.run_id });
  const got = Object.fromEntries(r.results.map((x) => [`${x.item}/${x.check}`, x]));
  assert.equal(got['pr-12/t1'].result, 'pass');
  assert.equal(got['pr-12/t1'].exit, 0);
  assert.deepEqual([got['pr-12/q1'].result, got['pr-12/q1'].rows, got['pr-12/q1'].columns], ['pass', 2, ['id', 'email']]);
  assert.deepEqual([got['pr-12/h1'].result, got['pr-12/h1'].status, got['pr-12/h1'].path], ['pass', 200, '/health']);
  assert.equal(got['ENG-3/t1'].result, 'fail');
  assert.equal(got['ENG-3/t1'].exit, 1);
  assert.equal(got['ENG-3/q1'].result, 'fail');
  assert.deepEqual([got['ENG-3/h1'].result, got['ENG-3/h1'].status], ['fail', 404]);
  assert.deepEqual([got['ENG-3/h2'].result, got['ENG-3/h2'].status], ['pass', 302]);
  assert.deepEqual([got['ENG-3/h3'].result, got['ENG-3/h3'].status], ['pass', 201]);
  assert.equal(r.left, 0);
  assert.equal((await QA.runChecks({ run: s.run_id })).ran, 0);
  await assert.rejects(QA.plan({ run: s.run_id }), /already started/);

  // The tester's report: one screenshot is real, one is claimed, one is outside the folder.
  const run = S.loadRun(s.run_id);
  const shots = run.items[0].tester.screenshots;
  writeFileSync(join(shots, '01.png'), 'png');
  writeFileSync(join(tmp, 'elsewhere.png'), 'png');
  const b = QA.browserRecord(s.run_id, 'pr-12', tester([
    { action: 'a', expected: 'b', actual: `Saw <b>the list</b> for ${ROW_VALUE} @channel`, result: 'pass', screenshot: join(shots, '01.png') },
    { action: 'a', expected: 'b', actual: 'The badge stayed at 3', result: 'fail', screenshot: join(shots, '02-not-there.png') },
  ]));
  assert.deepEqual([b.passed, b.failed, b.screenshots, b.blocked], [1, 1, 1, false]);
  const outside = QA.browserRecord(s.run_id, 'pr-12', tester([{ actual: 'x', result: 'pass', screenshot: join(tmp, 'elsewhere.png') }, { actual: 'The badge stayed at 3', result: 'fail', screenshot: join(shots, '01.png') }]));
  assert.equal(outside.screenshots, 1);
  assert.match(QA.postPlan({ run: s.run_id }).refused, /status first/);

  const st = await QA.status(s.run_id);
  assert.deepEqual(st.items.map((i) => [i.id, i.status]), [['pr-12', 'failed'], ['ENG-3', 'failed'], ['text', 'partial']]);
  assert.equal(st.items[0].failed_checks[0].actual, 'The badge stayed at 3');
  assert.deepEqual(st.items[1].failed_checks.map((c) => c.actual), ['exit 1', '2 rows', 'http 404']);
  assert.equal(st.items[2].uncovered[0].why, 'no check was proposed');

  // Comments: short, built from results, nothing a query returned, nowhere for a text item.
  const pp = QA.postPlan({ run: s.run_id });
  assert.equal(pp.confirm_before_send, true);
  const [pr, eng, text] = pp.items;
  assert.equal(pr.allowed, true);
  assert.ok(pr.lines <= MAX_LINES);
  assert.match(pr.body, /^\*\*QA: failed\*\* · local · `abcdef123456` · 4 of 5 checks passed/);
  assert.match(pr.body, /❌ criterion c holds: The badge stayed at 3 \(browser\)/);
  assert.match(pr.body, /✅ criterion b holds \(database: 2 rows\)/);
  assert.deepEqual(pr.attachments, []);
  assert.ok(!pr.body.includes('{{shot:'));
  assert.equal(readFileSync(pr.body_file, 'utf8'), `${pr.body}\n`);
  assert.equal(eng.allowed, true);
  assert.match(text.reason, /nowhere to post/);
  for (const body of [pr.body, eng.body]) {
    assert.ok(!body.includes(ROW_VALUE), 'a row value reached a comment');
    assert.ok(!body.includes('select '), 'SQL reached a comment');
    assert.ok(!body.includes('token=abc'));
  }
  // Row values are in the run folder, and only there.
  assert.ok(readFileSync(join(S.runDir(s.run_id), 'out/pr-12--q1.rows'), 'utf8').includes(ROW_VALUE));
  assert.ok(!readFileSync(join(S.runDir(s.run_id), 'run.json'), 'utf8').replace(/"sql": "[^\n]*/g, '').includes(ROW_VALUE));

  QA.postRecord({ run: s.run_id, item: 'pr-12', result: 'posted', url: 'https://github.com/acme/app/pull/12#issuecomment-1' });
  QA.postRecord({ run: s.run_id, item: 'ENG-3', result: 'not_posted', reason: 'no Linear connector in this session' });
  assert.match(QA.postPlan({ run: s.run_id, items: 'pr-12' }).items[0].reason, /already posted/);

  const rep = QA.report(s.run_id);
  assert.equal(rep.committed, false);
  assert.match(rep.path, /^docs\/qa\/\d{4}-\d\d-\d\d-add-the-bell-[0-9a-f]{4}\.md$/);
  const md = readFileSync(rep.absolute, 'utf8');
  assert.ok(md.split('\n').length - 1 <= R.MAX_LINES);
  assert.match(md, /\| #12 Add the bell \| failed \| 4 of 5 \| \[comment\]\(https:\/\/github.com\/acme\/app\/pull\/12#issuecomment-1\) \|/);
  assert.match(md, /\| ENG-3 Orders export \| failed \| 2 of 5 \| not posted: no Linear connector/);
  assert.match(md, /report only/);
  assert.match(md, /Bug draft: \*\*Click Mark all read does not A list of notifications shows\*\*/);
  assert.match(md, /- Repro: 1\. Open the bell 2\. Click Mark all read/);
  assert.match(md, /## Not tested\n- checkout flow: criterion b holds \(no check was proposed\)/);
  assert.match(md, /qa-this #12 ENG-3 --env local/);
  assert.ok(!md.includes(ROW_VALUE));

  // How it turned out.
  assert.equal(QA.outcome({ run: s.run_id, item: 'pr-12', result: 'right' }).ok, true);
  QA.outcome({ run: s.run_id, item: 'ENG-3', result: 'wrong', actual: 'blocked' });
  assert.throws(() => QA.outcome({ run: s.run_id, item: 'text', result: 'maybe' }), /right\|wrong/);
  const stats = QA.stats();
  assert.deepEqual([stats.rated, stats.by_status.failed.right, stats.by_status.failed.wrong, stats.by_status.failed.became.blocked], [2, 1, 1, 1]);
  assert.ok(stats.items_by_method.checks >= 3);
});

test('requests: a write needs local or the user\'s yes; a credential header and an absolute URL are never sent', () => {
  const staging = { kind: 'staging' };
  assert.equal(requestRefusal({ path: '/a' }, staging, false), null);
  assert.match(requestRefusal({ method: 'DELETE', path: '/a' }, staging, false), /changes data/);
  assert.equal(requestRefusal({ method: 'DELETE', path: '/a' }, staging, true), null);
  assert.equal(requestRefusal({ method: 'post', path: '/a' }, { kind: 'local' }, false), null);
  assert.match(requestRefusal({ path: '//evil.example.com/a' }, staging, true), /must be a path/);
  assert.match(requestRefusal({ path: '/a', headers: { 'X-Api-Key': 'k' } }, staging, true), /credential/);
  assert.match(requestRefusal({ method: 'TRACE', path: '/a' }, staging, true), /unknown HTTP method/);
});

// ---------------------------------------------------------------- new tests
test('new tests: a file inside the globs is run; a source edit, a deletion or a commit is a violation', async () => {
  const mk = async () => {
    const s = begin(['adds', 'numbers']);
    await QA.plan({ run: s.run_id, confirmed: true, items: [{ id: 'text', criteria: crit('a'), checks: [{ id: 'n1', criterion: 'a', method: 'new_tests', action: 'Test subtraction', expected: 'The new test passes', files: ['src/sub.test.mjs'] }] }] });
    return s.run_id;
  };
  const good = "import { test } from 'node:test';\ntest('ok', () => {});\n";

  let run = await mk();
  assert.deepEqual(QA.testsOpen(run).write_only, ['src/sub.test.mjs']);
  assert.equal((await QA.runChecks({ run })).results[0].result, 'waiting');
  writeFileSync(join(repo, 'src/sub.test.mjs'), good);
  const closed = QA.testsClose(run);
  assert.deepEqual([closed.ok, closed.new_tests], [true, ['src/sub.test.mjs']]);
  assert.equal((await QA.runChecks({ run })).results[0].result, 'pass');
  assert.equal((await QA.status(run)).items[0].status, 'passed');
  assert.match(QA.postPlan({ run }).items[0].reason, /nowhere to post/);
  assert.match(readFileSync(QA.report(run).absolute, 'utf8'), /## New tests \(uncommitted\)\n- `src\/sub.test.mjs`/);

  run = await mk();
  QA.testsOpen(run);
  writeFileSync(join(repo, 'src/math.mjs'), 'export const add = (a, b) => a - b;\n');
  writeFileSync(join(repo, 'src/sub.test.mjs'), `${good}// again\n`);
  const bad = QA.testsClose(run);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.violations.map((v) => v.path), ['src/math.mjs']);
  assert.equal(readFileSync(join(repo, 'src/math.mjs'), 'utf8').includes('a - b'), true, 'nothing is reverted');
  assert.equal((await QA.runChecks({ run })).ran, 0);
  assert.equal((await QA.status(run)).items[0].status, 'failed');
  assert.match(readFileSync(QA.report(run).absolute, 'utf8'), /## Changed outside the test folders\n- `src\/math.mjs`/);
  sh(['checkout', '-q', '--', 'src/math.mjs']);

  run = await mk();
  QA.testsOpen(run);
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', 'sneaky']);
  assert.match(QA.testsClose(run).violations[0].why, /committed/);
});

// ---------------------------------------------------------------- blocked, off, screenshots
test('a tester that could not start blocks the item; posting can be off; screenshots are opt-in', async () => {
  const s = begin(['#12', '--env', 'local', '--screenshots']);
  await QA.plan({ run: s.run_id, confirmed: true, items: [{ id: 'pr-12', criteria: crit('a'), checks: [step('s1', 'a'), step('s2', 'a', 'Reload')] }] });
  const blocked = QA.browserRecord(s.run_id, 'pr-12', tester([], { verdict: 'blocked', summary: 'Sign-in page shown' }));
  assert.equal(blocked.blocked, true);
  assert.equal((await QA.status(s.run_id)).items[0].status, 'blocked');
  assert.match(QA.postPlan({ run: s.run_id }).items[0].body, /Blocked: Sign-in page shown/);
  assert.equal(QA.browserRecord(s.run_id, 'pr-12', 'no json here').ok, false);

  const shots = S.loadRun(s.run_id).items[0].tester.screenshots;
  for (const f of ['1.png', '2.png']) writeFileSync(join(shots, f), 'png');
  QA.browserRecord(s.run_id, 'pr-12', tester([{ actual: 'ok', result: 'pass', screenshot: join(shots, '1.png') }, { actual: 'Blank page', result: 'fail', screenshot: join(shots, '2.png') }]));
  await QA.status(s.run_id);
  const withShots = QA.postPlan({ run: s.run_id }).items[0];
  assert.deepEqual(withShots.attachments.map((a) => a.path), [join(shots, '2.png')]);
  assert.match(withShots.body, /!\[Reload\]\(\{\{shot:.*2\.png\}\}\)$/);

  const off = begin(['#12', '--env', 'local', '--no-post']);
  const p = await QA.plan({ run: off.run_id, confirmed: true, items: [{ id: 'pr-12', criteria: crit('a'), checks: [unit('t1', 'a')] }] });
  assert.deepEqual(p.ask.posts_to, []);
  await QA.runChecks({ run: off.run_id });
  await QA.status(off.run_id);
  assert.match(QA.postPlan({ run: off.run_id }).items[0].reason, /posting is off/);
  assert.equal(QA.block({ run: off.run_id, item: 'pr-12', reason: 'user stopped' }).blocked, 'user stopped');
});

test('comments and reports stay inside their line caps, and a secret-shaped string is redacted', async () => {
  const s = begin(['#12', '--env', 'local']);
  const ids = Array.from({ length: 25 }, (_, i) => `k${i}`);
  await QA.plan({ run: s.run_id, confirmed: true, items: [{ id: 'pr-12', criteria: ids.map((id) => ({ id, text: `criterion ${id} with ${TOKEN}` })), checks: ids.flatMap((id) => [unit(`t-${id}`, id, 'src/bad.test.mjs')]) }] });
  await QA.runChecks({ run: s.run_id });
  await QA.status(s.run_id);
  const c = QA.postPlan({ run: s.run_id }).items[0];
  assert.equal(c.lines, MAX_LINES);
  assert.match(c.body, /…and \d+ more, all in the report/);
  assert.ok(!c.body.includes(TOKEN), 'a token reached a comment');
  const md = readFileSync(QA.report(s.run_id).absolute, 'utf8');
  assert.ok(md.split('\n').length - 1 <= R.MAX_LINES);
});

test('the commands the skill text names are the commands that exist', () => {
  assert.deepEqual(QA.COMMANDS, ['probe', 'start', 'plan', 'run', 'tests-open', 'tests-close', 'browser-record', 'runtime-record', 'block', 'status', 'post-plan', 'post-record', 'report', 'outcome', 'stats']);
  assert.ok(existsSync(join(S.stateRoot(), 'log.jsonl')));
  assert.deepEqual(C.readJsonl(join(S.stateRoot(), 'jev.jsonl')), [], 'with Jev off nothing is logged');
});
