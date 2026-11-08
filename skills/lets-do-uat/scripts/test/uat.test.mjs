import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'lets-do-uat-'));
process.env.LETS_DO_UAT_STATE_DIR = join(tmp, 'state');
process.env.LETS_DO_UAT_GH_STUB = join(tmp, 'gh.json');
// Never this machine's real calibration file.
process.env.REAL_SKILLS_CALIBRATION_DIR = join(tmp, 'calibration');
delete process.env.REAL_SKILLS_CALIBRATION;
delete process.env.LETS_DO_UAT_TEST_CALIBRATED;
process.env.LETS_DO_UAT_JEV = 'off';

const U = await import('../uat.mjs');
const S = await import('../lib/state.mjs');
const { classify, parseArgs } = await import('../lib/ref.mjs');
const { checkFlows, flowStatus } = await import('../lib/flows.mjs');
const { cleanSignals, template } = await import('../lib/signals.mjs');
const { probeRag } = await import('../lib/probe.mjs');

const runs = [];
after(() => runs.forEach((r) => U.stop(r)));

function makeRepo(name, files) {
  const repo = join(tmp, name);
  mkdirSync(join(repo, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), typeof body === 'string' ? body : JSON.stringify(body));
  }
  const sh = (args) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', 'init']);
  return { repo, sh };
}
const CONFIG = {
  tracker: { type: 'linear', id_pattern: '[A-Z]{2,10}-[0-9]+', url_template: 'https://linear.app/acme/issue/{id}' },
  environments: [
    { name: 'local', kind: 'local', base_url: 'http://localhost:3000' },
    { name: 'prod', kind: 'production', base_url: 'https://app.example.com' },
  ],
  production_hosts: ['app.example.com'],
};
writeFileSync(process.env.LETS_DO_UAT_GH_STUB, JSON.stringify({
  'pr view 7': { number: 7, title: 'Approve transport requests', state: 'MERGED', url: 'https://github.com/acme/app/pull/7', headRefName: 'eng-12', files: [{ path: 'src/Requests.tsx' }] },
}));
const FLOWS = [
  { id: 'approve', title: 'Approve a request', goal: 'A dispatcher approves a pending request.', role: 'Dispatcher', section: 'Operations > Transport requests', start_path: '/requests', steps: [{ action: 'Click the first transport request', expected: 'Its detail opens' }, { action: 'Click Approve', expected: 'Status turns to Approved' }] },
  { id: 'filter', title: 'Filter by status', goal: 'Find pending requests.', role: 'Dispatcher', section: 'Operations > Transport requests', start_path: '/requests', steps: [{ action: 'Pick Pending in the status filter', expected: 'Only pending requests show' }] },
];
const SESSION = { browsers: ['built-in', 'chrome'] };

async function openRun(repo, args = ['ENG-12'], flows = FLOWS) {
  const s = U.start({ repo, args, session: SESSION });
  assert.ok(s.run, JSON.stringify(s));
  runs.push(s.run);
  U.item({ run: s.run, title: 'Approve transport requests', summary: 'Dispatchers can approve requests.', prs: [7] });
  const f = await U.flows({ run: s.run, flows });
  assert.equal(f.ok, true, JSON.stringify(f));
  return s.run;
}

test('arguments: one ticket, flags, other modes', () => {
  assert.deepEqual(parseArgs(['ENG-1', '--mode', 'agent']).flags.mode, 'agent');
  assert.match(parseArgs(['ENG-1', 'ENG-2']).problems[0], /one ticket or PR per run/);
  assert.match(parseArgs(['--mode', 'robot']).problems[0], /--mode/);
  assert.equal(parseArgs(['outcome', 'uat-1', 'approve', 'right']).flow, 'approve');
  assert.equal(classify('ENG-12', CONFIG).slug, 'ENG-12');
  assert.equal(classify('https://linear.app/acme/issue/ENG-12/approve', CONFIG).id, 'ENG-12');
  assert.equal(classify('https://github.com/acme/app/pull/7', CONFIG).kind, 'pr');
  assert.equal(classify('#9', { tracker: { type: 'github' } }).kind, 'ticket');
  assert.ok(classify('hello', CONFIG).error);
});

test('start: setup, RAG question once, no browser, input', () => {
  const { repo } = makeRepo('start', { 'package.json': { dependencies: { chromadb: '1' } } });
  let s = U.start({ repo, args: ['ENG-1'], session: SESSION });
  assert.ok(s.needs.includes('setup'));
  assert.deepEqual(s.missing.sort(), ['environments', 'production_hosts', 'tracker']);
  writeFileSync(join(repo, '.claude/qa-this.json'), JSON.stringify(CONFIG));
  s = U.start({ repo, args: ['ENG-1'], session: SESSION });
  runs.push(s.run);
  assert.equal(s.config_sources.tracker, '.claude/qa-this.json');
  assert.deepEqual(s.needs, ['rag']);
  assert.match(s.rag.strong[0], /chromadb/);
  U.rag({ run: s.run, enabled: false });
  const saved = JSON.parse(readFileSync(join(repo, '.claude/lets-do-uat.json'), 'utf8'));
  assert.equal(saved.rag.enabled, false);
  s = U.start({ repo, args: ['ENG-1'], session: SESSION });
  runs.push(s.run);
  assert.deepEqual(s.needs, [], 'asked once: a no is remembered too');
  assert.match(U.start({ repo, args: ['ENG-1'], session: { browsers: [] } }).refused, /no browser/);
  assert.ok(U.start({ repo, args: [], session: SESSION }).needs.includes('input'));
});

test('probe: weak signals alone do not ask, own docs do not count', () => {
  const { repo } = makeRepo('probe', { 'package.json': { dependencies: { openai: '4' } }, 'docs/uat/x/rag/a.md': 'x', 'db/001.sql': 'create extension if not exists vector;' });
  const r = probeRag(repo).rag;
  assert.ok(r.weak.some((w) => w.startsWith('openai')));
  assert.ok(r.strong.some((w) => w.startsWith('pgvector')));
  assert.ok(!r.strong.some((w) => w.includes('docs/uat')));
});

test('item: PRs are read with gh, unknown ones dropped', () => {
  const { repo } = makeRepo('item', { '.claude/qa-this.json': CONFIG });
  const s = U.start({ repo, args: ['ENG-12'], session: SESSION });
  runs.push(s.run);
  const r = U.item({ run: s.run, title: 'T', summary: 'S', prs: [7, 99] });
  assert.equal(r.item.prs[0].state, 'MERGED');
  assert.deepEqual(r.changed_files, ['src/Requests.tsx']);
  assert.match(r.dropped[0], /#99/);
  assert.throws(() => U.item({ run: s.run, title: 'T' }), /summary/);
});

test('flows: invalid flows are refused, confirm steps marked, draft written', async () => {
  const { invalid } = checkFlows([{ id: 'a', title: 'A', goal: 'G', start_path: 'requests', steps: [] }, { id: 'b', title: 'B', goal: 'G', start_path: '/x?token=abc', steps: [{ action: 'x', expected: 'y' }] }]);
  assert.equal(invalid.length, 2);
  assert.match(invalid[0], /start_path/);
  assert.match(invalid[1], /credential/);
  assert.match(invalid[0], /no role/);
  assert.match(invalid[0], /no section/);
  const { repo } = makeRepo('flows', { '.claude/qa-this.json': CONFIG });
  const run = await openRun(repo);
  const r = S.loadRun(run);
  assert.equal(r.flows[0].steps[1].confirm, true);
  // The draft the user approves the flows on.
  await U.flows({ run, flows: FLOWS, notes: { requires: ['The billing flag on'], not_covered: ['BC7 rates: no screen shows them', ''] } });
  const d = U.artifact(run);
  assert.equal(d.draft, true);
  const page = readFileSync(d.file_path, 'utf8');
  assert.match(page, /Draft for review/);
  assert.match(page, /The billing flag on/);
  assert.match(page, /Not covered here.*BC7 rates/s);
  assert.match(page, /2 steps/);
  assert.ok(!page.includes('Not run'), 'no results on a draft');
  assert.deepEqual(d.files, {});
  assert.match(readFileSync(join(repo, 'docs/uat/ENG-12/flows.md'), 'utf8'), /Not covered by these flows:\n- BC7 rates/);
  assert.equal(r.flows[1].steps[0].confirm, false);
  const md = readFileSync(join(repo, 'docs/uat/ENG-12/flows.md'), 'utf8');
  assert.match(md, /# UAT: Approve transport requests/);
  assert.match(md, /Click Approve ⚠/);
});

test('approve: agent mode never on production; user mode reads only there', async () => {
  const { repo } = makeRepo('approve', { '.claude/qa-this.json': CONFIG });
  const run = await openRun(repo);
  assert.match(U.approve({ run, mode: 'agent', browser: 'chrome', env: 'prod' }).refused, /not confirmed/);
  assert.match(U.approve({ run, confirmed: true, mode: 'agent', browser: 'chrome', env: 'prod' }).refused, /agent mode/);
  assert.match(U.approve({ run, confirmed: true, mode: 'agent', browser: 'firefox', env: 'local' }).refused, /browser/);
  const a = U.approve({ run, confirmed: true, mode: 'user', browser: 'chrome', env: 'prod' });
  assert.equal(a.ok, true);
  assert.equal(a.read_only, true);
  assert.ok(a.rules.some((r) => /Never click/.test(r)));
  assert.equal(a.flows[0].start_url, 'https://app.example.com/requests');
});

test('a full agent walk: capture, confirm gate, signals, status, docs, commit, artifact, comment', async () => {
  const { repo, sh } = makeRepo('walk', { '.claude/qa-this.json': CONFIG, '.claude/lets-do-uat.json': { rag: { enabled: true } }, 'other.txt': 'a' });
  const run = await openRun(repo);
  const a = U.approve({ run, confirmed: true, mode: 'agent', browser: 'built-in', env: 'local' });
  assert.ok(a.capture.port, JSON.stringify(a.capture));

  // The receiver: only the run's token, only expected names, only PNG bytes.
  const shot = U.shot({ run, flow: 'approve', step: '1', target: 'Transport request' });
  assert.match(shot.js, /"transport request"/);
  assert.equal(shot.expect, '201 box');
  const url = shot.js.match(/"(http:\/\/127\.0\.0\.1:\d+\/shot\?[^"]+)"/)[1];
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')]);
  assert.equal((await fetch(url.replace(/t=[0-9a-f]+/, 't=nope'), { method: 'POST', body: png })).status, 403);
  assert.equal((await fetch(url.replace(/name=[^&]+/, 'name=evil.png'), { method: 'POST', body: png })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', body: Buffer.from('not a png') })).status, 400);
  assert.equal((await fetch(url, { method: 'OPTIONS' })).headers.get('access-control-allow-private-network'), 'true');
  assert.equal((await fetch(`${url}&box=0.1,0.2,0.3,0.05`, { method: 'POST', body: png })).status, 201);
  const end = U.shot({ run, flow: 'approve', step: 'end' });
  assert.equal(end.name, 'approve-end.png');
  assert.equal((await fetch(end.js.match(/"(http:\/\/127\.0\.0\.1:\d+\/shot\?[^"]+)"/)[1], { method: 'POST', body: png })).status, 201);
  assert.ok(existsSync(join(repo, 'docs/uat/ENG-12/shots', shot.name)));

  const s1 = U.step({ run, flow: 'approve', step: 1, result: 'pass', what: 'Opens the request', signed_in_as: 'dispatcher@test.example', section: 'Operations > Requests', signals: { requests: [{ method: 'get', url: 'http://localhost:3000/api/requests/42?token=x', status: 200, ms: 80 }, { url: 'http://localhost:3000/main.js', status: 200 }], console: [{ level: 'error', text: 'boom for ada@example.com at https://x.io/a?b=c' }] } });
  assert.equal(s1.shot, shot.name);
  assert.deepEqual(S.loadRun(run).flows[0].steps[0].record.box, [0.1, 0.2, 0.3, 0.05]);
  assert.equal(S.loadRun(run).flows[0].observed.signed_in_as, 'dispatcher@test.example', 'a test account is kept off production');
  assert.equal(s1.qa.requests, 1, 'static file dropped');
  assert.match(U.step({ run, flow: 'approve', step: 1, result: 'pass' }).refused, /already recorded/);
  assert.match(U.step({ run, flow: 'approve', step: 2, result: 'pass' }).refused, /said yes/);
  const s2 = U.step({ run, flow: 'approve', step: 2, result: 'pass', confirmed: true, signals: { requests: [{ method: 'POST', url: 'http://localhost:3000/api/requests/42/approve', status: 500 }] } });
  assert.deepEqual(s2.qa.failed, ['POST /api/requests/:id/approve → 500']);

  const f1 = await U.flowClose({ run, flow: 'approve' });
  assert.deepEqual(f1.needs, ['summary']);
  assert.equal(f1.facts.server_errors, 1);
  assert.match(f1.facts.errors[0], /\[email\]/);
  assert.ok(!JSON.stringify(f1.facts).includes('token=x'));
  const f2 = await U.flowClose({ run, flow: 'approve', summary: 'GET /api/requests/:id loads it; POST approve returned 500.' });
  assert.equal(f2.status, 'issues');
  assert.equal(f2.next.id, 'filter');

  U.step({ run, flow: 'filter', step: 1, result: 'fail', actual: 'Approved requests still show' });
  assert.equal((await U.flowClose({ run, flow: 'filter', summary: 'No request on filter change: filtering is client side.' })).status, 'failed');

  const d = U.docs(run);
  assert.equal(d.written.length, 3, 'flows.md and one chunk per flow');
  const md = readFileSync(join(repo, 'docs/uat/ENG-12/flows.md'), 'utf8');
  assert.match(md, /\*\*Under the hood:\*\* GET/);
  assert.match(md, new RegExp(`shots/${shot.name}`));
  assert.match(md, /\| Dispatcher \(dispatcher@test\.example\) \| Operations > Requests \| `http:\/\/localhost:3000\/requests` \|/);
  assert.match(md, /!\[Outcome\]\(shots\/approve-end\.png\)/);
  assert.match(md, /\*\*fail\*\*: Approved requests still show/);
  assert.match(readFileSync(join(repo, 'docs/uat/ENG-12/rag/approve.md'), 'utf8'), /^---\nid: "ENG-12\/approve"/);

  writeFileSync(join(repo, 'other.txt'), 'changed');
  sh(['add', 'other.txt']);
  const c = U.commit(run);
  assert.equal(c.committed, true);
  assert.equal(c.pushed, false);
  assert.deepEqual(sh(['show', '--name-only', '--format=', 'HEAD']).split('\n').sort(), ['docs/uat/ENG-12/flows.md', 'docs/uat/ENG-12/rag/approve.md', 'docs/uat/ENG-12/rag/filter.md', `docs/uat/ENG-12/shots/${shot.name}`, 'docs/uat/ENG-12/shots/approve-end.png']);
  assert.match(sh(['diff', '--cached', '--name-only']), /other\.txt/, "the user's staged file stays staged");

  const art = U.artifact(run);
  assert.equal(art.draft, false);
  const html = readFileSync(art.file_path, 'utf8');
  assert.match(html, /<title>UAT ENG-12<\/title>/);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /Opens the request/);
  assert.match(html, /Sign in as<\/dt><dd>Dispatcher · dispatcher@test\.example/);
  assert.match(html, /Operations &gt; Requests/);
  assert.match(html, /class="ring" style="left:10%;top:20%;width:30%;height:5%"/);
  assert.match(html, /class="route"/);
  assert.deepEqual(Object.keys(art.files).sort(), [`shots/${shot.name}`, 'shots/approve-end.png'].sort());

  const p = U.postPlan({ run, artifact: 'https://claude.ai/artifact/abc' });
  assert.equal(p.allowed, true);
  const body = readFileSync(p.body_file, 'utf8');
  assert.match(body, /1 of 2 flows passed \(1 with errors under the hood\)/);
  assert.match(body, /Walkthrough: https:\/\/claude\.ai\/artifact\/abc/);
  assert.ok(body.split('\n').length <= U.COMMENT_LINES + 1);
  assert.deepEqual(p.target, { tracker: 'linear', kind: 'ticket', id: 'ENG-12' });
  assert.equal(U.postPlan({ run, artifact: 'https://evil.example/x' }).allowed, true);
  assert.ok(!readFileSync(p.body_file, 'utf8').includes('evil'));

  assert.equal(U.outcome({ run, flow: 'filter', result: 'right' }).status, 'failed');
  const st = U.stats();
  assert.equal(st.rated, 1);
  assert.equal(U.stop(run).stopped, true);
});

test('flow status rules', () => {
  const f = (results, facts = {}) => ({ steps: results.map((r, i) => ({ n: i + 1, record: r ? { result: r } : undefined })), facts });
  assert.equal(flowStatus(f([null])), 'not_run');
  assert.equal(flowStatus(f(['pass', 'pass'])), 'passed');
  assert.equal(flowStatus(f(['pass'], { console_errors: 1 })), 'issues');
  assert.equal(flowStatus(f(['pass', 'fail'])), 'failed');
  assert.equal(flowStatus(f(['pass', 'fail']), [2]), 'blocked');
  assert.equal(flowStatus(f(['pass', null])), 'partial');
  assert.equal(flowStatus(f(['skipped'])), 'partial');
});

test('signals: ids templated, query strings and other hosts handled', () => {
  assert.equal(template('/api/orders/8f14e45f-ceea-467a-9575-3a5b3e2a1c11/items/42'), '/api/orders/:id/items/:id');
  const s = cleanSignals({ requests: [{ url: 'https://api.stripe.com/v1/charges?key=sk', status: 0 }, { url: 'not a url' }], console: [{ level: 'warn', text: 'x' }] }, 'localhost');
  assert.deepEqual(s.requests, [{ method: 'GET', endpoint: 'api.stripe.com/v1/charges', status: 0 }]);
  assert.deepEqual(s.errors, []);
});

test('Jev: logged in shadow, never deciding; in live only adds', async () => {
  process.env.LETS_DO_UAT_JEV = 'shadow';
  try {
    const { repo } = makeRepo('jev', { '.claude/qa-this.json': CONFIG });
    const s = U.start({ repo, args: ['ENG-12'], session: SESSION });
    runs.push(s.run);
    U.item({ run: s.run, title: 'T', summary: 'S', prs: [7] });
    let seen;
    const ask = async ({ state, questions }) => {
      seen = state;
      return { degraded: false, answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: k === 'flows_cover_change' ? 0.1 : 0.95 }])) };
    };
    const r = await U.flows({ run: s.run, flows: FLOWS }, { ask });
    assert.deepEqual(r.warnings, [], 'shadow decides nothing');
    assert.equal(r.flows[1].confirm_steps.length, 0);
    assert.ok(!JSON.stringify(seen).includes('diff'));
    const log = readFileSync(join(process.env.LETS_DO_UAT_STATE_DIR, 'jev.jsonl'), 'utf8');
    assert.match(log, /"question":"flows_cover_change"/);
    assert.match(log, /"acted":false/);

    process.env.LETS_DO_UAT_JEV = 'live';
    process.env.LETS_DO_UAT_TEST_CALIBRATED = 'flows_cover_change,step_needs_confirm';
    const s2 = U.start({ repo, args: ['ENG-12'], session: SESSION });
    runs.push(s2.run);
    U.item({ run: s2.run, title: 'T', summary: 'S', prs: [7] });
    const live = await U.flows({ run: s2.run, flows: FLOWS }, { ask });
    assert.equal(live.warnings.length, 1);
    assert.deepEqual(live.flows[1].confirm_steps, [1], 'Jev added a confirmation');
  } finally {
    process.env.LETS_DO_UAT_JEV = 'off';
    delete process.env.LETS_DO_UAT_TEST_CALIBRATED;
  }
});

test('CLI prints one JSON object and exits 2 on an unknown command', () => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '../uat.mjs'), 'nope'], { env: process.env });
  assert.equal(r.status, 2);
  assert.deepEqual(JSON.parse(r.stdout.toString()).commands, U.COMMANDS);
});
