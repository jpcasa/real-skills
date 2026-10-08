import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = mkdtempSync(join(tmpdir(), 'wtf-'));
process.env.WTF_STATE_DIR = join(tmp, 'state');
process.env.WTF_GH_STUB = join(tmp, 'gh.json');
delete process.env.WTF_JEV;

const { checkCitations } = await import('../lib/cite.mjs');
const { skew } = await import('../lib/skew.mjs');
const { scrub } = await import('../lib/scrub.mjs');
const { decide, COUNTER_FLAGS, VERDICTS } = await import('../lib/rules.mjs');
const { detect } = await import('../lib/config.mjs');
const Q = await import('../lib/questions.mjs');
const W = await import('../wtf.mjs');

// ---------------------------------------------------------------- a repo to cite and to skew
const repo = join(tmp, 'app');
const sh = (args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
mkdirSync(join(repo, 'src'), { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
sh(['config', 'user.email', 't@t']);
sh(['config', 'user.name', 'T']);
writeFileSync(join(repo, 'src/void.ts'), [
  'export function canVoid(t) {',
  '  // internal errors cannot be voided',
  "  if (t.status === 'internal_error') return { ok: false, reason: 'blocked' };",
  '  return { ok: true };',
  '}',
  'export function save(t) {',
  '  db.update(t.id, { note: t.note });',
  '}',
].join('\n'));
writeFileSync(join(repo, 'src/screen.tsx'), "export const label = 'Cancel order';\nexport const hint = '';\n");
sh(['add', '.']);
sh(['commit', '-qm', 'init']);
sh(['branch', 'production']);
sh(['tag', 'v1.0.0']);
writeFileSync(join(repo, 'src/fix.ts'), 'export const fixed = true;\n');
sh(['add', '.']);
sh(['commit', '-qm', 'fix: the thing']);
const FIX = sh(['rev-parse', 'HEAD']);
const OLD = sh(['rev-parse', 'production']);
const RELEASE = { mode: 'promotion', main_branch: 'main', production_branch: 'production' };

const cfg = (extra = {}) => {
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude/wtf.json'), JSON.stringify({
    tracker: { type: 'clickup', id_pattern: '86[0-9a-z]{7}', url_template: 'https://app.clickup.com/t/{id}' },
    inbox: { type: 'helpdesk', url_pattern: 'https://support\\.example\\.com/conversations/(\\d+)' },
    release: RELEASE,
    environments: [
      { name: 'staging', kind: 'staging', base_url: 'https://staging.example.com' },
      { name: 'sneaky', kind: 'staging', base_url: 'https://eu.app.example.com/login' },
      { name: 'live', kind: 'production', base_url: 'https://app.example.com' },
    ],
    production_hosts: ['app.example.com'],
    jev: 'shadow',
    ...extra,
  }));
};
cfg();

const E = {
  guard: { path: 'src/void.ts', line: 3, quote: "if (t.status === 'internal_error') return { ok: false", role: 'guard' },
  expected: { path: 'src/void.ts', line: 7, quote: 'db.update(t.id, { note: t.note })', role: 'expected' },
  actual: { path: 'src/void.ts', line: 6, quote: 'export function save(t)', role: 'actual' },
  message: { path: 'src/screen.tsx', line: 2, quote: "export const hint = ''", role: 'message' },
  exists: { path: 'src/screen.tsx', line: 1, quote: "label = 'Cancel order'", role: 'exists' },
  write: { path: 'src/void.ts', line: 7, quote: 'db.update(t.id', role: 'write_path' },
};
const ver = (...xs) => checkCitations(repo, xs);
const base = (o) => ({ prior: [], evidence: [], flags: [], runtime: [], ...o });

// ---------------------------------------------------------------- cite
test('cite: real file, line in range, quote near the line', () => {
  const [ok] = ver(E.guard);
  assert.deepEqual([ok.verified, ok.path], [true, 'src/void.ts']);
  assert.equal(ver({ ...E.guard, line: 5 })[0].verified, true, 'two lines off is tolerated');
  assert.equal(ver({ ...E.guard, path: join(repo, 'src/void.ts') })[0].path, 'src/void.ts', 'absolute path inside the repo');
});

test('cite: every way a citation can be fake', () => {
  const p = (e) => ver(e)[0].problem;
  assert.match(p({ ...E.guard, path: 'src/nope.ts' }), /does not exist/);
  assert.match(p({ ...E.guard, line: 99 }), /out of range/);
  assert.match(p({ ...E.guard, line: 8 }), /quote not found within 3 lines/);
  assert.match(p({ ...E.guard, quote: 'return everything();' }), /quote not found/);
  assert.match(p({ ...E.guard, quote: 'if' }), /too short/);
  assert.match(p({ ...E.guard, quote: 'return {' }), /too short/, 'a quote that occurs everywhere proves nothing');
  assert.match(p({ ...E.guard, quote: '   \n\t   \n      ' }), /too short/);
  assert.match(p({ ...E.guard, line: 3.5 }), /out of range/);
  assert.match(p({ ...E.guard, path: 'src' }), /does not exist/, 'a directory is not a file');
  // A symlink inside the repo that points outside it.
  const outside = join(tmp, 'outside.ts');
  writeFileSync(outside, 'const secretValue = "not in the repo";\n');
  symlinkSync(outside, join(repo, 'src/link.ts'));
  assert.match(p({ path: 'src/link.ts', line: 1, quote: 'const secretValue = "not in the repo"', role: 'actual' }), /outside the repo/);
  assert.match(p({ ...E.guard, role: 'vibes' }), /role must be one of/);
  assert.match(p({ ...E.guard, path: '../../etc/hosts' }), /outside the repo/);
  assert.match(p({ ...E.guard, path: '/etc/hosts' }), /outside the repo/);
});

// ---------------------------------------------------------------- skew
test('skew: merged but not promoted; promoted; unknown commit', () => {
  const pending = skew({ repo, ref: FIX, release: RELEASE });
  assert.deepEqual([pending.exists, pending.in_main, pending.in_production, pending.in_env], [true, true, false, false]);
  assert.match(pending.detail, /not yet in production/);
  const shipped = skew({ repo, ref: OLD, release: RELEASE });
  assert.deepEqual([shipped.in_production, shipped.in_env], [true, true]);
  // A staging report: main is what staging runs.
  assert.equal(skew({ repo, ref: FIX, release: RELEASE, environment: 'staging' }).in_env, true);
  assert.equal(skew({ repo, ref: 'deadbeefdeadbeef', release: RELEASE }).exists, false);
  assert.equal(skew({ repo, release: RELEASE }).exists, false);
  // A "ref" shaped like a git option is looked up as a name and not found.
  assert.equal(skew({ repo, ref: '--all', release: RELEASE }).exists, false);
  assert.equal(skew({ repo, ref: '-h', release: RELEASE }).exists, false);
});

test('skew: PR number resolves through gh; open PR is not merged; tags mode', () => {
  writeFileSync(process.env.WTF_GH_STUB, JSON.stringify({ 12: { state: 'MERGED', sha: FIX }, 13: { state: 'OPEN', sha: null }, 14: { state: 'CLOSED', sha: null } }));
  const merged = skew({ repo, pr: 12, release: RELEASE });
  assert.deepEqual([merged.exists, merged.merged, merged.in_env], [true, true, false]);
  const open = skew({ repo, pr: 13, release: RELEASE });
  assert.deepEqual([open.exists, open.merged, open.in_env], [true, false, false]);
  assert.equal(skew({ repo, pr: 14, release: RELEASE }).exists, false);
  const tags = { mode: 'tags', main_branch: 'main', tag_pattern: 'v*' };
  assert.equal(skew({ repo, ref: FIX, release: tags }).in_production, false);
  assert.equal(skew({ repo, ref: OLD, release: tags }).in_production, true);
});

// ---------------------------------------------------------------- rules
test('every verdict is accepted with exactly its required evidence', () => {
  const cases = {
    KNOWN: base({ prior: [{ id: '86a', url: 'u', same_issue: true }] }),
    ALREADY_FIXED: base({ fix: skew({ repo, ref: FIX, release: RELEASE }) }),
    USER_ERROR: base({ evidence: ver(E.guard), steps: ['Open the order', 'Press Cancel order'] }),
    DEFECT: base({ evidence: ver(E.expected, E.actual) }),
    FEATURE_REQUEST: base({ premise_exists: false, searched: ['grep -r bulkVoid src/'] }),
    INSUFFICIENT_INFO: base({ missing_fact: 'the order number', who: 'the support agent' }),
  };
  assert.deepEqual(Object.keys(cases).sort(), [...VERDICTS].sort());
  for (const [v, input] of Object.entries(cases)) {
    const d = decide({ ...input, proposed: [v] });
    assert.deepEqual([d.accepted, d.verdicts.map((x) => x.verdict), d.missing, d.vetoes], [true, [v], [], []], v);
  }
});

test('an unsupported verdict becomes INSUFFICIENT_INFO and says what is missing', () => {
  const need = {
    KNOWN: /prior ticket with id and url/,
    ALREADY_FIXED: /fix commit or PR that exists/,
    USER_ERROR: /role guard or designed_behavior/,
    DEFECT: /expected and actual/,
    FEATURE_REQUEST: /premise_exists: false/,
  };
  for (const [v, re] of Object.entries(need)) {
    const d = decide(base({ proposed: [v] }));
    assert.deepEqual([d.accepted, d.verdicts[0].verdict, d.downgraded_from, d.confidence], [false, 'INSUFFICIENT_INFO', [v], 'low'], v);
    assert.match(d.missing.join(' | '), re, v);
  }
  // Half the evidence is not enough.
  assert.equal(decide(base({ proposed: ['USER_ERROR'], evidence: ver(E.guard) })).accepted, false, 'guard without steps');
  assert.equal(decide(base({ proposed: ['DEFECT'], evidence: ver(E.expected) })).accepted, false, 'expected without actual');
  assert.equal(decide(base({ proposed: ['KNOWN'], prior: [{ id: '86a', url: 'u', same_issue: false }] })).accepted, false, 'related is not same');
  assert.equal(decide(base({ proposed: ['FEATURE_REQUEST'], premise_exists: false })).accepted, false, 'no search recorded');
});

test('unverified citations do not count', () => {
  const fake = ver({ ...E.guard, quote: 'this line is not in the file' });
  assert.equal(fake[0].verified, false);
  assert.equal(decide(base({ proposed: ['USER_ERROR'], evidence: fake, steps: ['x'] })).accepted, false);
});

test('USER_ERROR: every counter-prior vetoes it, and so does a faithful reproduction', () => {
  const ok = base({ proposed: ['USER_ERROR'], evidence: ver(E.guard), steps: ['do this instead'] });
  for (const f of COUNTER_FLAGS) {
    const d = decide({ ...ok, flags: [f] });
    assert.equal(d.accepted, false, f);
    assert.match(d.vetoes.join(), new RegExp(`${f}: never user error`));
  }
  const repro = { result: 'reproduced', failed_steps: 1 };
  assert.equal(decide({ ...ok, repro, repro_followed_correct_steps: true }).accepted, false);
  assert.equal(decide({ ...ok, repro, repro_followed_correct_steps: false }).accepted, true, 'reproducing the wrong steps proves nothing');
  assert.equal(decide({ ...ok, repro: { result: 'not_reproduced' } }).accepted, true);
});

test('DEFECT: a reproduction with a failed step, or a counter-prior with a code citation, also supports it', () => {
  assert.equal(decide(base({ proposed: ['DEFECT'], repro: { result: 'reproduced', failed_steps: 1 } })).accepted, true);
  assert.equal(decide(base({ proposed: ['DEFECT'], repro: { result: 'not_reproduced', failed_steps: 0 } })).accepted, false);
  assert.equal(decide(base({ proposed: ['DEFECT'], flags: ['silent_write_noop'], evidence: ver(E.write) })).accepted, true);
  assert.equal(decide(base({ proposed: ['DEFECT'], flags: ['silent_write_noop'] })).accepted, false, 'a flag alone is a claim');
});

test('ALREADY_FIXED is vetoed when the fix is already live; FEATURE_REQUEST when the behaviour exists', () => {
  const live = decide(base({ proposed: ['ALREADY_FIXED'], fix: skew({ repo, ref: OLD, release: RELEASE }) }));
  assert.equal(live.accepted, false);
  assert.match(live.vetoes.join(), /already in the environment.*DEFECT/);
  const fr = decide(base({ proposed: ['FEATURE_REQUEST'], premise_exists: false, searched: ['x'], evidence: ver(E.exists) }));
  assert.match(fr.vetoes.join(), /shows the behaviour exists/);
});

test('split verdict: only USER_ERROR + DEFECT, and the messaging half needs its own evidence', () => {
  const logic = { evidence: ver(E.guard, E.message), steps: ['do this'] };
  const d = decide(base({ proposed: ['USER_ERROR', 'DEFECT'], ...logic }));
  assert.deepEqual(d.verdicts, [{ verdict: 'USER_ERROR', scope: 'logic' }, { verdict: 'DEFECT', scope: 'messaging' }]);
  const absent = decide(base({ proposed: ['DEFECT', 'USER_ERROR'], evidence: ver(E.guard), steps: ['x'], message_absent: 'no reason text next to the disabled button in screen.tsx' }));
  assert.equal(absent.accepted, true, 'order does not matter; a stated absence counts');
  assert.match(decide(base({ proposed: ['USER_ERROR', 'DEFECT'], evidence: ver(E.guard), steps: ['x'] })).missing.join(), /DEFECT \(messaging\)/);
  assert.match(decide(base({ proposed: ['KNOWN', 'DEFECT'] })).missing[0], /only split verdict/);
  assert.match(decide(base({ proposed: ['USER_ERROR', 'DEFECT', 'KNOWN'] })).missing[0], /at most two/);
  assert.match(decide(base({ proposed: ['NOPE'] })).missing[0], /unknown verdict/);
  assert.match(decide(base({ proposed: [] })).missing[0], /no verdict proposed/);
});

test('runtime evidence alone supports nothing; it can only corroborate', () => {
  const rt = [{ source: 'sentry', kind: 'error', matches_code: true }];
  for (const v of ['DEFECT', 'USER_ERROR', 'FEATURE_REQUEST', 'KNOWN']) assert.equal(decide(base({ proposed: [v], runtime: rt })).accepted, false, v);
  const withCode = decide(base({ proposed: ['DEFECT'], evidence: ver(E.expected, E.actual), runtime: rt }));
  assert.equal(withCode.confidence, 'high');
});

test('confidence is computed from the evidence', () => {
  const code = { proposed: ['DEFECT'], evidence: ver(E.expected, E.actual) };
  assert.equal(decide(base(code)).confidence, 'medium');
  assert.match(decide(base(code)).raise_with, /reproduction, prior art/);
  assert.equal(decide(base({ ...code, prior: [{ id: 'a', url: 'u', same_issue: true }] })).confidence, 'high');
  assert.equal(decide(base({ ...code, repro: { result: 'reproduced', failed_steps: 1 } })).confidence, 'high');
  assert.equal(decide(base({ ...code, runtime: [{ kind: 'error', matches_code: false }] })).confidence, 'medium', 'a merely correlated error is not a second source');
  assert.equal(decide(base({ proposed: ['DEFECT'], repro: { result: 'reproduced', failed_steps: 1 } })).confidence, 'low', 'no verified code path yet');
  assert.equal(decide(base({ proposed: ['KNOWN'], prior: [{ id: 'a', url: 'u', same_issue: true }] })).confidence, 'medium');
  assert.equal(decide(base({ proposed: ['ALREADY_FIXED'], fix: skew({ repo, ref: FIX, release: RELEASE }) })).confidence, 'high');
});

test('supported lists every verdict the evidence would carry; unknown flags are reported', () => {
  const d = decide(base({ proposed: ['USER_ERROR'], evidence: ver(E.guard, E.expected, E.actual), steps: ['x'], flags: ['wrong_data_shown', 'made_up'] }));
  assert.equal(d.accepted, false);
  assert.deepEqual(d.supported, ['DEFECT']);
  assert.deepEqual(d.unknown_flags, ['made_up']);
});

// ---------------------------------------------------------------- scrub + shapes
test('scrub removes emails, phone numbers and long digit runs', () => {
  const s = scrub('Dana (dana.r@acme-supply.com, +1 (415) 555-0199) says order 88213377 vanished at 10:42');
  assert.equal(s, 'Dana ([email], [phone]) says order [number] vanished at 10:42');
});

test('input shapes: flags, tracker ids and URLs, inbox URLs, files, screenshots, free text', () => {
  const { config } = W.start({ repo, args: ['setup'] }) && { config: JSON.parse(readFileSync(join(repo, '.claude/wtf.json'), 'utf8')) };
  const shot = join(tmp, 'shot.PNG');
  writeFileSync(shot, 'x');
  const d = detect(['--plain', 'https://app.clickup.com/t/86abc1234', '86zzz9999', 'https://support.example.com/conversations/382', shot, 'src/void.ts', 'https://other.example/x', 'cancel', 'button', 'dead'], config, repo);
  assert.equal(d.register, 'plain');
  assert.deepEqual(d.sources.map((s) => [s.kind, s.id ?? null]), [['tracker', '86abc1234'], ['tracker', '86zzz9999'], ['inbox', '382'], ['screenshot', null], ['file', null], ['url', null]]);
  assert.deepEqual([d.text, d.needs], ['cancel button dead', []]);
  assert.deepEqual(detect([], config, repo).needs, ['input', 'register'], 'nothing given: ask, never default');
  assert.deepEqual(detect(['--tech', 'it broke'], { ...config, default_register: 'plain' }, repo).register, 'tech', 'a flag beats the default');
  assert.equal(detect(['it broke'], { ...config, default_register: 'plain' }, repo).register, 'plain');
  assert.deepEqual(detect(['#12'], { tracker: { type: 'github' } }, repo).sources, [{ kind: 'tracker', ref: '#12', id: '12' }]);
});

test('modes: setup, stats, outcome, latest (clamped)', () => {
  const m = (...a) => detect(a, {}, repo);
  assert.equal(m('setup').mode, 'setup');
  assert.equal(m('stats').mode, 'stats');
  assert.deepEqual([m('outcome', 'wtf-1', 'wrong', 'DEFECT').run, m('outcome', 'wtf-1', 'wrong', 'DEFECT').actual], ['wtf-1', 'DEFECT']);
  assert.deepEqual([m('latest').count, m('latest', '50').count, m('latest', '0').count], [3, 10, 3]);
});

// ---------------------------------------------------------------- run state, budgets
const newRun = (args = ['--tech', 'cancel button does nothing']) => W.start({ repo, args }).run_id;

test('start opens a run and reports what the repo is configured for', () => {
  const s = W.start({ repo, args: ['--tech', 'cancel button does nothing'] });
  assert.match(s.run_id, /^wtf-\d{8}-\d{4}-[0-9a-f]{4}$/);
  assert.deepEqual([s.mode, s.config_found, s.has.tracker, s.has.can_reproduce, s.jev], ['triage', true, 'clickup', true, 'shadow']);
  assert.deepEqual(s.budgets, { tracker: { cap: 5, used: 0 }, runtime: { cap: 4, used: 0 }, repro: { cap: 1, used: 0 } });
  assert.equal(W.start({ repo, args: ['setup'] }).run_id, undefined, 'setup opens no run');
});

test('budgets stop at their caps', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), '../wtf.mjs');
  const run = newRun();
  const spend = (kind) => JSON.parse(execFileSync('node', [cli, 'spend', '--run', run, '--kind', kind], { env: process.env }).toString());
  const tracker = Array.from({ length: 6 }, () => spend('tracker'));
  assert.deepEqual(tracker.map((r) => r.ok), [true, true, true, true, true, false]);
  assert.deepEqual([tracker[4].left, tracker[5].left], [0, 0]);
  assert.deepEqual(Array.from({ length: 5 }, () => spend('runtime').ok), [true, true, true, true, false]);
  assert.throws(() => spend('coffee'));
});

// ---------------------------------------------------------------- reproduction
test('reproduction is refused on production, on unknown environments, and with no production_hosts', () => {
  const run = newRun();
  const steps = [{ action: 'Open an order and press Cancel order', expected: 'The order is cancelled' }];
  const plan = (env) => W.reproPlan({ run, env, steps });
  assert.match(plan('live').refused, /kind production/);
  assert.match(plan('sneaky').refused, /eu\.app\.example\.com is a production host/);
  assert.match(plan('nowhere').refused, /no environment named nowhere/);
  assert.match(W.reproPlan({ run, env: 'staging', steps: [] }).refused, /no steps/);
  // Ports, trailing dots, case and userinfo do not hide a production host.
  const hosts = { port: 'https://app.example.com:8443/x', dot: 'https://app.example.com./x', upper: 'https://APP.Example.COM', userinfo: 'https://staging.example.com@app.example.com/', sub: 'https://a.b.app.example.com' };
  for (const [why, base_url] of Object.entries(hosts)) {
    cfg({ environments: [{ name: 'trick', kind: 'staging', base_url }] });
    assert.match(plan('trick').refused || '', /is a production host/, why);
  }
  // production_hosts written as URLs or with ports still match; a non-host entry stops everything.
  for (const entry of ['https://app.example.com/', 'app.example.com:443', 'APP.EXAMPLE.COM.']) {
    cfg({ production_hosts: [entry], environments: [{ name: 'trick', kind: 'staging', base_url: 'https://app.example.com' }] });
    assert.match(plan('trick').refused || '', /is a production host/, entry);
  }
  cfg({ production_hosts: ['app.example.com', 'http://'] });
  assert.match(plan('staging').refused, /not a host/);
  cfg({ environments: [{ name: 'nokind', base_url: 'https://staging.example.com' }] });
  assert.match(plan('nokind').refused, /kind undefined/);
  cfg();
  // A look-alike that is not a subdomain is a different host.
  cfg({ environments: [{ name: 'other', kind: 'staging', base_url: 'https://notapp.example.com' }] });
  assert.equal(W.reproRefusal(JSON.parse(readFileSync(join(repo, '.claude/wtf.json'), 'utf8')), 'other'), null);
  cfg();
  cfg({ production_hosts: [] });
  try {
    assert.match(plan('staging').refused, /production_hosts is empty/);
    assert.equal(W.start({ repo, args: ['--tech', 'x'] }).has.can_reproduce, false);
  } finally {
    cfg();
  }
});

test('reproduction: one per run; the tester prompt names the environment and forbids production', () => {
  const run = newRun();
  const steps = [{ action: 'Open an order and press Cancel order', expected: 'The order is cancelled' }];
  const p = W.reproPlan({ run, env: 'staging', steps });
  assert.deepEqual([p.ok, p.subagent_type, p.base_url], [true, 'real-skills:qa-tester', 'https://staging.example.com']);
  const prompt = readFileSync(p.prompt_file, 'utf8');
  assert.match(prompt, /staging \(staging\) at https:\/\/staging\.example\.com/);
  assert.match(prompt, /Never production\. Production hosts: app\.example\.com/);
  assert.match(prompt, /1\. Open an order and press Cancel order\n {3}Expected: The order is cancelled/);
  assert.ok(existsSync(p.screenshots));
  assert.match(W.reproPlan({ run, env: 'staging', steps }).refused, /budget spent/);
});

const tester = (verdict, results) => `\`\`\`json\n${JSON.stringify({ role: 'qa-tester', item: 'wtf', loop: 1, verdict, summary: 's', findings: [], files_touched: [], commits: [], qa: { env: 'staging', steps: results.map((result, n) => ({ action: `a${n}`, expected: 'e', actual: 'nothing happened', result })) } })}\n\`\`\``;

test('repro-record: a failed step means the report reproduced; all pass means it did not', () => {
  const plan = (run) => W.reproPlan({ run, env: 'staging', steps: [{ action: 'a', expected: 'e' }] });
  const a = newRun();
  plan(a);
  assert.deepEqual([W.reproRecord(a, tester('fail', ['pass', 'fail'])).result, W.reproRecord(a, tester('fail', ['pass', 'fail'])).failed_steps], ['reproduced', 1]);
  const b = newRun();
  plan(b);
  assert.equal(W.reproRecord(b, tester('pass', ['pass'])).result, 'not_reproduced');
  const c = newRun();
  plan(c);
  assert.equal(W.reproRecord(c, tester('blocked', [])).result, 'blocked');
  assert.equal(W.reproRecord(c, 'no json here').ok, false);
  assert.throws(() => W.reproRecord(newRun(), tester('fail', ['fail'])), /no reproduction was planned/);
});

// ---------------------------------------------------------------- verdict: trust nothing it can check
const off = () => assert.fail('Jev must not be called');
const jevStub = (nouls = {}) => {
  const seen = [];
  const ask = async (built) => {
    seen.push(built);
    return { degraded: false, answers: Object.fromEntries(Object.keys(built.questions).map((id) => [id, { type: 'noul', noul: nouls[id] ?? 0.5 }])) };
  };
  return { ask, seen };
};
const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
};
const noJev = (fn) => withEnv({ WTF_JEV: 'off' }, fn);

test('verdict re-verifies citations: `verified: true` in the input is ignored', async () => {
  await noJev(async () => {
    const lie = { ...E.guard, quote: 'this is not in the file', verified: true };
    const r = await W.runVerdict({ run: newRun(), proposed: ['USER_ERROR'], evidence: [lie], steps: ['x'] }, { ask: off });
    assert.deepEqual([r.accepted, r.verdicts[0].verdict, r.evidence[0].verified], [false, 'INSUFFICIENT_INFO', false]);
    const honest = await W.runVerdict({ run: newRun(), proposed: ['USER_ERROR'], evidence: [E.guard], steps: ['x'] }, { ask: off });
    assert.deepEqual([honest.accepted, honest.confidence, honest.jev_mode], [true, 'medium', 'off']);
    assert.match(honest.outcome_hint, /\/real-skills:wtf outcome wtf-/);
  });
});

test('verdict recomputes deploy skew: an asserted `in_env: false` is ignored', async () => {
  await noJev(async () => {
    const shipped = await W.runVerdict({ run: newRun(), proposed: ['ALREADY_FIXED'], fix: { ref: OLD, in_env: false, exists: true } }, { ask: off });
    assert.equal(shipped.accepted, false);
    assert.match(shipped.vetoes.join(), /already in the environment/);
    const pending = await W.runVerdict({ run: newRun(), proposed: ['ALREADY_FIXED'], fix: { pr: 12 } }, { ask: off });
    assert.deepEqual([pending.accepted, pending.fix.in_main, pending.fix.in_production], [true, true, false]);
    // The same fix, reported from staging, is already there.
    const staging = await W.runVerdict({ run: newRun(), proposed: ['ALREADY_FIXED'], fix: { pr: 12 }, report: { environment: 'staging' } }, { ask: off });
    assert.equal(staging.accepted, false);
  });
});

test('verdict reads the reproduction from run state: an asserted `repro` is ignored', async () => {
  await noJev(async () => {
    const claimed = await W.runVerdict({ run: newRun(), proposed: ['DEFECT'], repro: { result: 'reproduced', failed_steps: 3 } }, { ask: off });
    assert.deepEqual([claimed.accepted, claimed.repro], [false, null]);
    const run = newRun();
    W.reproPlan({ run, env: 'staging', steps: [{ action: 'a', expected: 'e' }] });
    W.reproRecord(run, tester('fail', ['fail']));
    const real = await W.runVerdict({ run, proposed: ['DEFECT'] }, { ask: off });
    assert.deepEqual([real.accepted, real.repro], [true, { result: 'reproduced', failed_steps: 1 }]);
  });
});

// ---------------------------------------------------------------- Jev: derived facts only, logged until calibrated
const REPORT = 'Dana Reyes from Acme Supply (dana.r@acme-supply.com, 415-555-0199) wrote: "URGENT the cancel button is DEAD on order 88213377!!"';
const derived = { symptom: 'Cancel button does nothing on an internal-error order. Reporter: dana.r@acme-supply.com order 88213377', expected: 'Order is cancelled', actual: 'Nothing happens, no message' };

test('Jev sees the scrubbed derived facts and prior titles, never the report', async () => {
  const { ask, seen } = jevStub();
  const prior = [{ id: '86a', url: 'u', title: 'Cancel blocked for internal errors (call 415 555 0199)', same_issue: true }];
  const r = await W.runVerdict({ run: newRun(), proposed: ['KNOWN'], prior, ...derived, report: { text: REPORT, environment: 'production' } }, { ask });
  assert.equal(seen.length, 1);
  const sent = JSON.stringify(seen[0]);
  for (const leak of ['Dana', 'Reyes', 'Acme Supply', 'acme-supply.com', '555', '88213377', 'URGENT']) assert.ok(!sent.includes(leak), `leaked ${leak}`);
  assert.deepEqual(Object.keys(seen[0].state).sort(), ['actual', 'expected', 'prior_titles', 'symptom']);
  assert.match(seen[0].state.symptom, /\[email\] order \[number\]/);
  assert.deepEqual(Object.keys(seen[0].questions).sort(), ['ask_not_breakage', 'same_issue__0', 'screen_was_enough']);
  assert.deepEqual([r.jev_mode, r.jev.same_issue], ['shadow', [{ id: '86a', p: 0.5 }]]);
});

test('no symptom line, no Jev call; a failed call degrades and changes nothing', async () => {
  const quiet = await W.runVerdict({ run: newRun(), proposed: ['USER_ERROR'], evidence: [E.guard], steps: ['x'] }, { ask: off });
  assert.equal(quiet.jev, null);
  const down = await W.runVerdict({ run: newRun(), proposed: ['USER_ERROR'], evidence: [E.guard], steps: ['x'], ...derived }, { ask: async () => ({ degraded: true, error: 'HTTP 529', answers: {} }) });
  assert.deepEqual([down.accepted, down.jev_mode, down.jev], [true, 'degraded', { error: 'HTTP 529' }]);
});

test('uncalibrated Jev answers change no verdict, in shadow or live', async () => {
  assert.equal(Q.UNCALIBRATED.size, 3);
  const prior = [{ id: '86a', url: 'u', title: 't', same_issue: true }];
  const hostile = jevStub({ same_issue__0: 0.01, ask_not_breakage: 0.01, screen_was_enough: 0.01 });
  for (const WTF_JEV of ['shadow', 'live']) {
    await withEnv({ WTF_JEV }, async () => {
      const known = await W.runVerdict({ run: newRun(), proposed: ['KNOWN'], prior, ...derived }, hostile);
      const fr = await W.runVerdict({ run: newRun(), proposed: ['FEATURE_REQUEST'], premise_exists: false, searched: ['x'], ...derived }, hostile);
      const ue = await W.runVerdict({ run: newRun(), proposed: ['USER_ERROR'], evidence: [E.guard], steps: ['x'], ...derived }, hostile);
      assert.deepEqual([known.accepted, fr.accepted, ue.accepted, ue.consider_split], [true, true, true, undefined], WTF_JEV);
    });
  }
});

test('calibrated and live, Jev can only take support away', async () => {
  const ALL = [...Q.UNCALIBRATED].join(',');
  const prior = [{ id: '86a', url: 'u', title: 't', same_issue: true }];
  await withEnv({ WTF_JEV: 'live', WTF_TEST_CALIBRATED: ALL }, async () => {
    const no = jevStub({ same_issue__0: 0.05, ask_not_breakage: 0.05, screen_was_enough: 0.05 });
    const known = await W.runVerdict({ run: newRun(), proposed: ['KNOWN'], prior, ...derived }, no);
    assert.match(known.vetoes.join(), /Jev does not read the prior ticket as the same issue/);
    const fr = await W.runVerdict({ run: newRun(), proposed: ['FEATURE_REQUEST'], premise_exists: false, searched: ['x'], ...derived }, no);
    assert.match(fr.vetoes.join(), /reads the report as breakage/);
    const ue = await W.runVerdict({ run: newRun(), proposed: ['USER_ERROR'], evidence: [E.guard], steps: ['x'], ...derived }, no);
    assert.deepEqual([ue.accepted, typeof ue.consider_split], [true, 'string'], 'a hint, not a change of verdict');
    // Enthusiastic answers add nothing: an unsupported verdict stays unsupported.
    const yes = jevStub({ same_issue__0: 0.99, ask_not_breakage: 0.99, screen_was_enough: 0.99 });
    assert.equal((await W.runVerdict({ run: newRun(), proposed: ['KNOWN'], prior: [{ title: 't', same_issue: false }], ...derived }, yes)).accepted, false);
    assert.equal((await W.runVerdict({ run: newRun(), proposed: ['FEATURE_REQUEST'], ...derived }, yes)).accepted, false);
  });
});

// ---------------------------------------------------------------- learning loop
test('the log holds verdicts and counts, never report or symptom text', async () => {
  await W.runVerdict({ run: newRun(), proposed: ['USER_ERROR'], evidence: [E.guard], steps: ['x'], ...derived, report: { text: REPORT } }, jevStub());
  const log = readFileSync(join(process.env.WTF_STATE_DIR, 'log.jsonl'), 'utf8');
  for (const leak of ['Dana', 'acme-supply', '88213377', 'Cancel button does nothing', 'Nothing happens']) assert.ok(!log.includes(leak), `log leaked ${leak}`);
  const last = JSON.parse(log.trim().split('\n').at(-1));
  assert.deepEqual([last.type, last.verdicts, last.evidence], ['verdict', ['USER_ERROR'], { total: 1, verified: 1 }]);
});

test('outcome and stats: accuracy per verdict, and what the wrong ones turned out to be', async () => {
  await withEnv({ WTF_STATE_DIR: join(tmp, 'state-stats'), WTF_JEV: 'off' }, async () => {
    const mk = async (proposed, extra) => (await W.runVerdict({ run: W.start({ repo, args: ['--tech', 'x'] }).run_id, proposed, ...extra }, { ask: off })).run_id;
    const ue = { evidence: [E.guard], steps: ['x'] };
    const [a, b, c] = [await mk(['USER_ERROR'], ue), await mk(['USER_ERROR'], ue), await mk(['DEFECT'], { evidence: [E.expected, E.actual] })];
    await mk(['DEFECT'], { evidence: [E.expected, E.actual] }); // never rated
    W.outcome({ run: a, result: 'right' });
    W.outcome({ run: b, result: 'wrong', actual: 'DEFECT' });
    W.outcome({ run: c, result: 'wrong' });
    W.outcome({ run: c, result: 'right' }); // the latest outcome wins
    assert.deepEqual(W.stats(), {
      rated: 3, unrated: 1, accuracy: 0.67,
      by_verdict: { USER_ERROR: { n: 2, right: 1, wrong: 1, became: { DEFECT: 1 }, accuracy: 0.5 }, DEFECT: { n: 1, right: 1, wrong: 0, became: {}, accuracy: 1 } },
    });
    assert.throws(() => W.outcome({ run: a, result: 'maybe' }), /right\|wrong/);
    assert.throws(() => W.outcome({ run: a, result: 'wrong', actual: 'NOPE' }), /--actual must be one of/);
    assert.throws(() => W.outcome({ run: 'wtf-nope', result: 'right' }), /unknown run/);
    // A run id is never a path.
    for (const id of ['../state', '../../etc', '/etc', 'wtf-20261007-1916-b0af/../x', '']) assert.throws(() => W.outcome({ run: id, result: 'right' }), /unknown run/, id);
  });
});

// ---------------------------------------------------------------- cli
test('cli: one JSON line per command; cite and skew resolve the repo from the run', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), '../wtf.mjs');
  const env = { ...process.env, WTF_JEV: 'off' };
  const call = (args, input) => {
    const raw = execFileSync('node', [cli, ...args], { env, input: input === undefined ? '' : JSON.stringify(input) }).toString().trim();
    assert.equal(raw.split('\n').length, 1, raw);
    return JSON.parse(raw);
  };
  const run = call(['start'], { repo, args: ['--tech', 'cancel', 'button', 'dead'] }).run_id;
  assert.deepEqual([call(['cite'], { run, evidence: [E.guard, { ...E.guard, line: 99 }] }).verified, call(['cite'], { run, evidence: [E.guard, { ...E.guard, line: 99 }] }).unverified], [1, 1]);
  assert.equal(call(['skew'], { run, ref: FIX }).in_production, false);
  const long = call(['cite'], { run, evidence: [{ ...E.guard, note: 'n'.repeat(201) }], trigger: 't'.repeat(301), actual: 'short' });
  assert.deepEqual(long.over.map((o) => o.field), ['evidence[0].note', 'trigger']);
  const v = call(['verdict'], { run, proposed: ['DEFECT'], evidence: [E.expected, E.actual] });
  assert.deepEqual([v.accepted, v.confidence], [true, 'medium']);
  assert.equal(call(['outcome', '--run', run, '--result', 'right']).ok, true);
  assert.equal(call(['stats']).rated >= 1, true);
  assert.throws(() => execFileSync('node', [cli, 'nope'], { env, stdio: ['pipe', 'pipe', 'ignore'] }));
});

// ---------------------------------------------------------------- the skill text matches the harness
test('SKILL.md documents every command, verdict, flag and evidence role the harness uses', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  for (const w of [...W.COMMANDS, ...W.VERDICTS, ...W.COUNTER_FLAGS, ...W.ROLES, 'accepted', 'missing', 'supported', 'raise_with', 'consider_split', 'can_reproduce', 'refused', 'over', 'WTF_JEV=off']) {
    assert.ok(skill.includes(`\`${w}`) || skill.includes(`${w}\``), `SKILL.md does not mention ${w}`);
  }
  const fm = skill.slice(0, skill.indexOf('\n---', 4));
  assert.match(fm, /^---\nname: wtf\ndescription: "/);
  assert.ok(!/disable-model-invocation/.test(fm));
});

test('the skill names no tracker write tool', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const files = execFileSync('git', ['-C', dir, 'ls-files', '-co', '--exclude-standard', '.']).toString().trim().split('\n')
    .filter((f) => !f.endsWith('wtf.test.mjs') && !f.endsWith('jev.mjs') && !f.endsWith('redact.jq'));
  assert.ok(files.length >= 15, `found ${files.length} files`);
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const re of [/clickup_(create|update|delete|send|add|move|merge)_/, /gh (issue|pr) (create|edit|comment|close|merge)/, /git (push|commit)\b/]) {
      assert.ok(!re.test(text), `${f} names a write: ${re}`);
    }
  }
});

test('each reference file SKILL.md links to exists', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const links = [...skill.matchAll(/\]\((references\/[^)#]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 4);
  for (const l of links) assert.ok(existsSync(join(dir, l)), l);
  for (const t of ['github', 'clickup', 'linear', 'other']) assert.ok(existsSync(join(dir, `references/trackers/${t}.md`)), t);
  for (const r of ['sentry', 'posthog', 'logs']) assert.ok(existsSync(join(dir, `references/runtime/${r}.md`)), r);
});
