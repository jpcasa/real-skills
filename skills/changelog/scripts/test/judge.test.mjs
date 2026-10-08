import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathFlags, resolveTicket } from '../lib/rules.mjs';
import { judge, judgeOne, UNCALIBRATED } from '../judge.mjs';

// Never this machine's real calibration file.
process.env.REAL_SKILLS_CALIBRATION_DIR = mkdtempSync(join(tmpdir(), 'changelog-cal-'));
delete process.env.REAL_SKILLS_CALIBRATION;

const CU = { type: 'clickup', id_pattern: '86[0-9a-z]{7}' };
const LIN = { type: 'linear', id_pattern: '\\b(ENG)-[0-9]+\\b' };
const withCal = async (ids, fn) => {
  process.env.CHANGELOG_TEST_CALIBRATED = ids;
  try {
    return await fn();
  } finally {
    delete process.env.CHANGELOG_TEST_CALIBRATED;
  }
};
const ALL = [...UNCALIBRATED].join(',');
// A Jev stand-in: noul answers by question id prefix, optional area choice.
const stub = (nouls = {}, area = null) => async ({ questions }) => ({
  degraded: false,
  answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => {
    if (q.type === 'choice') return [id, { type: 'choice', choice: area?.choice ?? Object.keys(q.criteria)[0], confidence: area?.confidence ?? 0.9 }];
    const key = Object.keys(nouls).find((k) => id === k || id.startsWith(k));
    return [id, { type: 'noul', noul: key ? nouls[key] : 0.1 }];
  })),
});

test('branch ID beats every body ID', () => {
  const r = resolveTicket({ branch: 'jp/86abc1234-fix-login', body: 'Fixes 86zzz9999. Related: 86yyy8888' }, CU);
  assert.deepEqual([r.ticket, r.source], ['86abc1234', 'branch']);
  assert.deepEqual(r.candidates, ['86abc1234', '86zzz9999', '86yyy8888']);
});

test('no branch ID: the first ID the body declares wins over an earlier bare mention', () => {
  const body = 'Follows 86aaa1111 from last sprint.\n\nClickUp: https://app.clickup.com/t/86bbb2222\nSupersedes the approach in 86ccc3333.';
  const r = resolveTicket({ branch: 'fix-login', body }, CU);
  assert.deepEqual([r.ticket, r.source], ['86bbb2222', 'body_declared']);
});

test('several IDs, none in the branch, none declared: no ticket, candidates listed', () => {
  const r = resolveTicket({ branch: 'fix-login', body: 'See 86aaa1111 and 86bbb2222 for context.' }, CU);
  assert.deepEqual([r.ticket, r.source, r.candidates], [null, null, ['86aaa1111', '86bbb2222']]);
});

test('linear IDs are upper-cased; tracker none and a bad pattern return no ticket', () => {
  assert.equal(resolveTicket({ branch: 'jane/eng-123-fix', body: '' }, LIN).ticket, 'ENG-123');
  assert.deepEqual(resolveTicket({ branch: 'eng-123', body: 'Fixes ENG-9' }, { type: 'none' }), { ticket: null, source: null, candidates: [] });
  assert.match(resolveTicket({ branch: 'x', body: 'y' }, { type: 'other', id_pattern: '([' }).error, /not a valid regex/);
  assert.match(resolveTicket({ branch: 'x', body: 'y' }, { type: 'other' }).error, /id_pattern is not set/);
});

test('github: closing reference, then branch number, then Fixes #N; a bare #N is not a ticket', () => {
  const gh = { type: 'github' };
  assert.deepEqual(resolveTicket({ branch: '45-x', body: 'Fixes #9', closing_issues: [12] }, gh).source, 'github_link');
  assert.deepEqual([resolveTicket({ branch: 'fix/45-login', body: 'Fixes #9' }, gh).ticket], ['45']);
  assert.deepEqual(resolveTicket({ branch: 'login', body: 'Closes #9, see #10' }, gh).ticket, '9');
  assert.deepEqual(resolveTicket({ branch: 'login', body: 'Like #10 did.' }, gh), { ticket: null, source: null, candidates: [] });
});

test('path flags: migrations named, docs-only needs every path to be docs', () => {
  assert.deepEqual(pathFlags(['src/a.ts', 'supabase/migrations/001_add.sql']), { migration: true, migration_files: ['supabase/migrations/001_add.sql'], docs_only: false });
  assert.equal(pathFlags(['README.md', 'docs/setup.png']).docs_only, true);
  assert.equal(pathFlags(['README.md', 'src/a.ts']).docs_only, false);
  assert.equal(pathFlags([]).docs_only, false);
});

const ambiguous = { number: 7, title: 'Fix login', branch: 'fix-login', body: 'See 86aaa1111 and 86bbb2222.', files: ['src/login.ts'], labels: [] };

test('degraded (no key or API failure): code rules only, Jev fields empty', async () => {
  const r = await judgeOne(ambiguous, { tracker: CU, areas: ['Auth', 'Billing'], ask: async () => ({ degraded: true, error: 'no TypeSafe API key', answers: {} }) });
  assert.deepEqual([r.mode, r.ticket, r.area, r.flags.default_on_change], ['degraded', null, null, null]);
  assert.deepEqual(r.jev, { error: 'no TypeSafe API key' });
});

test('shadow: Jev answers are reported and decide nothing', async () => {
  const r = await withCal(ALL, () => judgeOne(ambiguous, { tracker: CU, areas: ['Auth', 'Billing'], mode: 'shadow', ask: stub({ own_ticket__1: 0.95, changes_live: 0.9 }, { choice: 'Billing', confidence: 0.99 }) }));
  assert.deepEqual([r.ticket, r.area, r.flags.default_on_change], [null, null, null]);
  assert.deepEqual(r.jev.own_ticket, [{ id: '86aaa1111', p: 0.1 }, { id: '86bbb2222', p: 0.95 }]);
  assert.equal(r.jev.area.choice, 'Billing');
});

test('live but uncalibrated: still decides nothing', async () => {
  const r = await judgeOne(ambiguous, { tracker: CU, areas: ['Auth', 'Billing'], mode: 'live', ask: stub({ own_ticket__1: 0.95, changes_live: 0.9 }) });
  assert.deepEqual([r.ticket, r.ticket_source, r.area, r.flags.default_on_change], [null, null, null, null]);
});

test('live and calibrated: Jev fills what code left open, from the PR candidates only', async () => {
  await withCal(ALL, async () => {
    const r = await judgeOne(ambiguous, { tracker: CU, areas: ['Auth', 'Billing'], mode: 'live', ask: stub({ own_ticket__1: 0.95, changes_live: 0.9 }, { choice: 'Billing', confidence: 0.8 }) });
    assert.deepEqual([r.ticket, r.ticket_source, r.area, r.flags.default_on_change], ['86bbb2222', 'jev', 'Billing', true]);
    assert.ok(r.candidates.includes(r.ticket));
    // Below the threshold: "no ticket linked" stands.
    const low = await judgeOne(ambiguous, { tracker: CU, mode: 'live', ask: stub({ own_ticket: 0.6 }) });
    assert.equal(low.ticket, null);
    // An area Jev invents is ignored.
    const odd = await judgeOne(ambiguous, { tracker: CU, areas: ['Auth', 'Billing'], mode: 'live', ask: stub({}, { choice: 'Payments', confidence: 0.99 }) });
    assert.equal(odd.area, null);
  });
});

test('Jev never overrides a ticket code resolved, and is not asked about it', async () => {
  await withCal(ALL, async () => {
    let asked;
    const ask = async (built) => {
      asked = Object.keys(built.questions);
      return stub({ own_ticket: 0.99 })(built);
    };
    const r = await judgeOne({ ...ambiguous, branch: '86ccc3333-fix' }, { tracker: CU, mode: 'live', ask });
    assert.deepEqual([r.ticket, r.ticket_source], ['86ccc3333', 'branch']);
    assert.ok(!asked.some((q) => q.startsWith('own_ticket')));
  });
});

test('jev off: no call at all; batch input returns one result per PR', async () => {
  const ask = async () => assert.fail('must not be called');
  const res = await judge({ prs: [ambiguous, { ...ambiguous, number: 8, branch: '86ddd4444-x' }], tracker: CU, jev: 'off' }, { ask });
  assert.deepEqual(res.results.map((r) => [r.number, r.ticket]), [[7, null], [8, '86ddd4444']]);
  assert.equal(res.mode, 'off');
});

test('CLI: one JSON line; when Jev is unreachable it degrades to code rules', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), '../judge.mjs');
  // A dead local port: the test never reaches the real API, whatever key the machine has.
  const env = { ...process.env, TYPESAFE_API_KEY: 'test-key', TYPESAFE_API_URL: 'http://127.0.0.1:9/', CHANGELOG_STATE_DIR: mkdtempSync(join(tmpdir(), 'changelog-state-')) };
  const out = execFileSync('node', [cli], { env, input: JSON.stringify({ pr: { ...ambiguous, branch: '86eee5555-x' }, tracker: CU }) }).toString().trim();
  assert.equal(out.split('\n').length, 1);
  const res = JSON.parse(out);
  assert.deepEqual([res.mode, res.results[0].ticket, res.results[0].ticket_source], ['degraded', '86eee5555', 'branch']);
});

// ---------------------------------------------------------------- calibration
const C = await import('../lib/calibration.mjs');
const { takeCases } = await import('../judge.mjs');
const PR = { number: 7, title: 'Tighten session timeout', branch: 'fix-login', body: 'Related 86aaa1111 and 86bbb2222', files: ['src/a.ts'] };
const AREAS = ['Billing', 'Auth'];

test('every Jev answer is logged as a case, in shadow too, with its direction and unsafe side', async () => {
  takeCases();
  const r = await judgeOne(PR, { tracker: CU, areas: AREAS, mode: 'shadow', repo: 'acme/app', ask: stub({ changes_live: 0.8, own_ticket__0: 0.9 }, { choice: 'Auth', confidence: 0.7 }) });
  assert.deepEqual([r.flags.default_on_change, r.ticket, r.area], [null, null, null], 'shadow decides nothing');
  const cases = takeCases();
  assert.deepEqual(cases.map((c) => [c.question, c.case, c.p, c.acts_when, c.unsafe, c.acted]), [
    ['changes_live_behaviour_without_opt_in', 'acme/app#7', 0.8, 'both', 'fn', false],
    ['id_is_this_prs_own_ticket', 'acme/app#7/86aaa1111', 0.9, 'gte', 'fp', false],
    ['id_is_this_prs_own_ticket', 'acme/app#7/86bbb2222', 0.1, 'gte', 'fp', false],
    ['area', 'acme/app#7', 0.7, 'gte', 'fp', false],
  ]);
  assert.ok(cases.every((c) => c.skill === 'changelog' && c.show.startsWith('PR #7: Tighten session timeout') && c.ask.endsWith('?')));
  assert.equal(cases[3].choice, 'Auth');
  assert.deepEqual(takeCases(), [], 'taken once');
  await judgeOne(PR, { tracker: CU, areas: AREAS, mode: 'shadow', ask: stub({ changes_live: 0.8 }) });
  assert.deepEqual(takeCases(), [], 'no repo given: PR numbers from different repos would collide, so nothing is logged');
});

test('an entry written by /calibrate switches that one question on, in live only, at its own threshold', async () => {
  const ask = stub({ changes_live: 0.55, own_ticket__0: 0.9 });
  const run = (mode) => judgeOne(PR, { tracker: CU, areas: [], mode, repo: 'acme/app', ask });
  assert.equal((await run('live')).flags.default_on_change, null, 'nothing calibrated yet');
  C.setEntry('changelog', 'changes_live_behaviour_without_opt_in', { threshold: 0.6, n: 30 });
  const live = await run('live');
  assert.equal(live.flags.default_on_change, false, '0.55 is under the calibrated 0.6 (the built-in 0.5 would have said true)');
  assert.equal(live.ticket, null, 'the other question is still off');
  assert.equal((await run('shadow')).flags.default_on_change, null);
  process.env.REAL_SKILLS_CALIBRATION = 'off';
  assert.equal((await run('live')).flags.default_on_change, null);
  delete process.env.REAL_SKILLS_CALIBRATION;
  assert.equal(takeCases().filter((c) => c.acted).length, 1);
  C.revoke('changelog', 'changes_live_behaviour_without_opt_in', 'test');
});

test('spot check: one decision in ten is left to the fallback and marked', async () => {
  C.setEntry('changelog', 'changes_live_behaviour_without_opt_in', { threshold: 0.5, n: 30 });
  takeCases();
  const numbers = Array.from({ length: 60 }, (_, i) => i + 1);
  for (const number of numbers) await judgeOne({ ...PR, number }, { tracker: CU, mode: 'live', repo: 'acme/app', ask: stub({ changes_live: 0.9 }) });
  const cases = takeCases().filter((c) => c.question === 'changes_live_behaviour_without_opt_in');
  const spots = cases.filter((c) => c.spot);
  assert.ok(spots.length >= 1 && spots.length <= 15, `${spots.length} of 60`);
  assert.ok(spots.every((c) => c.acted === false) && cases.filter((c) => !c.spot).every((c) => c.acted === true));
  assert.deepEqual(spots.map((c) => c.case), numbers.map((n) => `acme/app#${n}`).filter(C.spotCheck));
  C.revoke('changelog', 'changes_live_behaviour_without_opt_in', 'test');
});

test('CLI: with Jev unreachable no case is written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-state-'));
  const cli = join(dirname(fileURLToPath(import.meta.url)), '../judge.mjs');
  // Jev is unreachable here, so nothing is answered and nothing is logged as a case.
  execFileSync('node', [cli], { input: JSON.stringify({ repo: 'acme/app', pr: PR, tracker: CU }), env: { ...process.env, CHANGELOG_STATE_DIR: dir, TYPESAFE_API_KEY: 'k', TYPESAFE_API_URL: 'http://127.0.0.1:9/' } });
  assert.deepEqual(C.readJsonl(join(dir, 'jev.jsonl')).filter((r) => r.type === 'case'), []);
});
