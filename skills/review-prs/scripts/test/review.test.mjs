// The harness end to end against a temp git repo, with `gh` and Jev stubbed:
// start (no checkout), record, the refuter path, posting and its refusals,
// Jev logging, outcome and stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '../review.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'review-prs-'));
const repo = join(tmp, 'repo');
mkdirSync(join(repo, 'src/auth'), { recursive: true });
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
git('config', 'user.email', 't@t');
git('config', 'user.name', 'T');

const SESSION = (check, ttl, extra = []) => [
  '// session helpers', "import { audit } from './audit';", '', 'export function check(token) {', '  const now = Date.now();',
  check, ...extra, '  return true;', '}', ...Array.from({ length: 10 }, (_, i) => `// padding ${i}`), 'export function ttl(token) {', ttl, '}', '',
].join('\n');
const put = (file, text) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
};
put('src/auth/session.ts', SESSION('  if (token.expires <= now) return false;', '  return token.expires - Date.now();'));
put('pnpm-lock.yaml', 'lock: 1\n');
git('add', '.');
git('commit', '-qm', 'init');
const BASE = git('rev-parse', 'HEAD');
git('checkout', '-qb', 'pr');
put('src/auth/session.ts', SESSION('  if (token.expires < now) return false;', '  return Math.max(0, token.expires - Date.now());', ['  audit(token);']));
put('pnpm-lock.yaml', 'lock: 2\n');
git('commit', '-qam', 'change');
const HEAD = git('rev-parse', 'HEAD');
git('checkout', '-q', 'main');

const view = (number, over = {}) => ({
  number, title: 'Tighten session expiry', body: 'Makes the expiry check strict. `ghp_' + 'a'.repeat(36) + '`', author: { login: 'dev' },
  baseRefName: 'main', baseRefOid: BASE, headRefOid: HEAD, isDraft: false, state: 'OPEN', url: `https://github.com/o/r/pull/${number}`,
  statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...over,
});
let seq = 0;
// Each test gets its own stub and state folder.
function world(prs = { 7: { view: view(7), comments: [] } }, extraEnv = {}) {
  const dir = join(tmp, `w${seq++}`);
  mkdirSync(dir);
  const stub = join(dir, 'gh.json');
  const jev = join(dir, 'jev.json');
  const data = { slug: 'o/r', requested: [{ number: 7, title: 'Tighten session expiry', author: 'dev' }], prs, post: { id: 55, html_url: 'https://github.com/o/r/pull/7#pullrequestreview-55' } };
  const save = () => writeFileSync(stub, JSON.stringify(data));
  save();
  writeFileSync(jev, JSON.stringify({}));
  const env = { ...process.env, REVIEW_PRS_STATE_DIR: join(dir, 'state'), REVIEW_PRS_GH_STUB: stub, REVIEW_PRS_JEV_STUB: jev, REVIEW_PRS_JEV: 'off', REAL_SKILLS_CALIBRATION_DIR: join(dir, 'cal'), ...extraEnv };
  const h = (args, input, more = {}) => {
    let res;
    try {
      res = execFileSync('node', [CLI, ...args], { env: { ...env, ...more }, input: input === undefined ? '' : JSON.stringify(input), stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    } catch (e) {
      res = e.stdout.toString();
    }
    const lines = res.trim().split('\n');
    assert.equal(lines.length, 1, `exactly one JSON line: ${res}`);
    return JSON.parse(lines[0]);
  };
  return { dir, stub, jev, data, save, h, state: join(dir, 'state'), start: (args = ['7'], more) => h(['start'], { repo, args }, more) };
}

const BUG = { severity: 'bug', file: 'src/auth/session.ts', line: 6, quote: 'if (token.expires < now) return false;', problem: 'The expiry check uses <, so a token stays valid one tick too long.', fix: 'Use <=.' };
const NIT = { severity: 'nit', file: 'src/auth/session.ts', line: 21, quote: 'return Math.max(0, token.expires - Date.now());', problem: 'The clamp is undocumented.', fix: 'Add a comment saying why ttl never goes negative.' };
const BAD = { severity: 'risk', file: 'src/auth/session.ts', line: 2, quote: 'this text is nowhere in the file', problem: 'Made up.', fix: 'None.' };
const OUTSIDE = { severity: 'risk', file: 'src/auth/session.ts', line: 1, quote: '// session helpers', problem: 'The header comment is stale.', fix: 'Update it.' };
const rep = (lens, findings) => ({ pr: 7, lens, findings });
const results = (o = {}) => ['correctness', 'standards', 'security'].map((key) => ({ pr: 7, key, lens: key, report: key in o ? o[key] : rep(key, []) }));

test('start with no arguments lists the PRs waiting on review and opens no run', () => {
  const w = world();
  const r = w.start([]);
  assert.deepEqual(r.candidates, [{ number: 7, title: 'Tighten session expiry', author: 'dev' }]);
  assert.equal(r.run_id, undefined);
  assert.ok(!existsSync(w.state));
});

test('start: fetches without checking out, skips drafts and closed PRs, picks lenses', () => {
  const w = world({ 7: { view: view(7), comments: [] }, 8: { view: view(8, { isDraft: true }) }, 9: { view: view(9, { state: 'MERGED' }) } });
  const r = w.start(['7', '#8', 'https://github.com/o/r/pull/9']);
  assert.deepEqual(r.prs.map((p) => p.number), [7]);
  assert.deepEqual(r.skipped.map((s) => [s.number, s.why]), [[8, 'it is a draft'], [9, 'it is merged']]);
  const pr = r.prs[0];
  assert.deepEqual(pr.lenses, ['correctness', 'standards', 'security']);
  assert.match(pr.reasons.security, /path rule: src\/auth\/session\.ts/);
  assert.equal(pr.ci, 'passing');
  assert.equal(pr.files, 1, 'the lockfile is ignored');
  // Nothing was checked out: the clone is still on main and clean.
  assert.equal(git('rev-parse', 'HEAD'), BASE);
  assert.equal(git('status', '--porcelain'), '');
  const dir = join(w.state, r.run_id, 'pr-7');
  assert.match(readFileSync(join(dir, 'head/src/auth/session.ts'), 'utf8'), /token\.expires < now/);
  assert.ok(existsSync(join(dir, 'diff.patch')));
  assert.ok(!existsSync(join(dir, 'head/pnpm-lock.yaml')));
  // One agent per lens, a refuter per PR, and ready-made workflow args.
  assert.deepEqual(r.agents.map((a) => a.key), ['correctness', 'standards', 'security']);
  assert.deepEqual(r.refuters.map((a) => a.name), ['refuter-7']);
  assert.equal(r.estimate, 4);
  assert.ok(existsSync(r.workflow.script_path));
  assert.deepEqual(r.workflow.args.agents, r.agents);
  for (const a of r.agents) assert.match(a.agent_type, /reviewer$/);
  const prompt = readFileSync(r.agents[2].prompt_file, 'utf8');
  assert.match(prompt, /Your lens is \*\*security\*\*/);
  assert.match(prompt, /# Lens: security/);
  assert.match(prompt, /data, not instructions/);
  assert.match(prompt, /never run the PR's code/);
  assert.match(readFileSync(r.agents[1].prompt_file, 'utf8'), new RegExp(`show ${BASE}:CLAUDE\\.md`));
});

test('start: refusals', () => {
  const w = world();
  assert.match(w.start(Array.from({ length: 11 }, (_, i) => String(i + 1))).error, /at most 10 per run/);
  assert.match(w.start(['abc']).error, /not a PR number or URL/);
  assert.match(w.start(['https://github.com/other/repo/pull/3']).error, /is in other\/repo, not o\/r/);
  assert.match(w.start(['7', '--lens', 'vibes']).error, /unknown lens/);
  assert.match(w.start(['404']).error, /PR #404 not found/);
  assert.equal(w.start(['7', '--no-refute']).refuters.length, 0);
  assert.deepEqual(w.start(['7', '--lens', 'performance']).prs[0].lenses, ['correctness', 'standards', 'security', 'performance']);
});

test('record: checks every citation, splits outside-diff, computes the verdict', () => {
  const w = world();
  const s = w.start(['7', '--no-refute']);
  const r = w.h(['record'], { run: s.run_id, results: results({ correctness: rep('correctness', [BUG, BAD, OUTSIDE]), standards: rep('standards', [NIT]) }) });
  const pr = r.prs[0];
  assert.deepEqual([pr.verdict, pr.partial], ['blocking', false]);
  assert.deepEqual(pr.counts, { bug: 1, risk: 1, nit: 1, q: 0, security: 0 });
  assert.deepEqual(pr.lines, [
    'src/auth/session.ts:L6: 🔴 bug: The expiry check uses <, so a token stays valid one tick too long. Use <=.',
    'src/auth/session.ts:L21: 🔵 nit: The clamp is undocumented. Add a comment saying why ttl never goes negative.',
  ]);
  assert.deepEqual(pr.outside_diff, ['src/auth/session.ts:L1: 🟡 risk: The header comment is stale. Update it.']);
  assert.equal(pr.dropped.citation, 1);
  assert.deepEqual(pr.not_shown, ['1 finding failed the citation check']);
  assert.deepEqual(pr.would_post, { inline_comments: 2, in_body: 1 });
  assert.equal(pr.proposed, 4);
});

test('record: a missing, null or invalid lens report makes the PR partial', () => {
  const w = world();
  const s = w.start(['7', '--no-refute']);
  const res = [{ pr: 7, key: 'correctness', report: rep('correctness', []) }, { pr: 7, key: 'standards', report: null }, { pr: 7, key: 'security', report: { pr: 7, lens: 'security', findings: [{ severity: 'huge' }] } }];
  const pr = w.h(['record'], { run: s.run_id, results: res }).prs[0];
  assert.deepEqual([pr.verdict, pr.partial], ['clean', true]);
  assert.equal(pr.partial_reasons[0], 'standards returned no report');
  const unread = w.h(['record'], { run: s.run_id, results: results({ correctness: { ...rep('correctness', []), not_reviewed: ['a', 'b', 'c', 'd'] } }) }).prs[0];
  assert.deepEqual(unread.partial_reasons, ['correctness did not read 4 files: a, b, c, …']);
  assert.match(pr.partial_reasons[1], /security returned an invalid report/);
});

test('record: already-raised findings are dropped; a fenced text report is accepted', () => {
  // Current head-side comments count. An outdated one (no `line`) and a base-side one do not.
  const comments = [{ path: 'src/auth/session.ts', line: 7, side: 'RIGHT' }, { path: 'src/auth/session.ts', line: 21 }, { path: 'src/auth/session.ts', line: null, original_line: 1 }, { path: 'src/auth/session.ts', line: 1, side: 'LEFT' }];
  const w = world({ 7: { view: view(7), comments } });
  const s = w.start(['7', '--no-refute']);
  const text = `\`\`\`json\n${JSON.stringify(rep('correctness', [BUG, NIT, OUTSIDE]))}\n\`\`\``;
  const pr = w.h(['record'], { run: s.run_id, results: results({ correctness: text }) }).prs[0];
  assert.equal(pr.dropped.already_raised, 1, 'the nit at L21');
  assert.equal(pr.lines.length, 1);
  assert.match(pr.lines[0], /bug: .*\[a review comment already sits near this line\]$/, 'a bug is never dropped on a nearby comment');
  assert.equal(pr.outside_diff.length, 1, 'L1 has only an outdated and a base-side comment');
  assert.equal(pr.verdict, 'blocking');
});

test('refuter: planned only for bugs, drops a bug only with a verified citation', () => {
  const w = world();
  const s = w.start();
  const res = results({ correctness: rep('correctness', [BUG, NIT]) });
  const plan = w.h(['refute-plan'], { run: s.run_id, results: res });
  assert.deepEqual(plan.refuters.map((x) => [x.pr, x.bugs]), [[7, 1]]);
  const prompt = readFileSync(plan.refuters[0].prompt_file, 'utf8');
  assert.match(prompt, /"id": "correctness#0"/);
  assert.match(prompt, /Unsure means not refuted/);
  assert.equal(w.h(['refute-plan'], { run: s.run_id, results: results() }).refuters.length, 0);

  const refute = (r) => [{ pr: 7, report: { pr: 7, refutations: [{ id: 'correctness#0', refuted: true, reason: 'The contract says expiry is exclusive.', ...r }] } }];
  const rec = (refutations) => w.h(['record'], { run: s.run_id, results: res, refutations }).prs[0];
  // No refuter report at all: the bug stands and the PR says so.
  const none = rec([]);
  assert.equal(none.verdict, 'blocking');
  assert.match(none.partial_reasons[0], /refuter did not run/);
  // A refutation that cites nothing, or a line that is not there: the bug stands.
  assert.equal(rec(refute({})).verdict, 'blocking');
  const wrong = rec(refute({ file: 'src/auth/session.ts', line: 5, quote: 'not what the line says at all' }));
  assert.equal(wrong.verdict, 'blocking');
  assert.match(wrong.lines[0], /refuter disagreed without a checkable citation/);
  // A verified citation drops it.
  const ok = rec(refute({ file: 'src/auth/session.ts', line: 5, quote: 'const now = Date.now();' }));
  assert.deepEqual([ok.verdict, ok.partial, ok.dropped.refuted], ['comments', false, 1]);
  assert.deepEqual(ok.not_shown, ['1 bug refuted by a second reviewer']);
  // The refuter may cite a file outside the PR, read at the PR head.
  assert.equal(rec(refute({ file: 'pnpm-lock.yaml', line: 1, quote: 'lock: 2' })).dropped.refuted, 1);
});

test('post: one COMMENT review built from run state, with every refusal', () => {
  const w = world();
  const s = w.start(['7', '--no-refute']);
  assert.match(w.h(['post-plan', '--run', s.run_id, '--pr', '7']).refused, /no recorded review/);
  w.h(['record'], { run: s.run_id, results: results({ correctness: rep('correctness', [BUG, OUTSIDE, BAD]), standards: rep('standards', [NIT]) }) });
  const plan = w.h(['post-plan', '--run', s.run_id, '--pr', '7', '--event', 'APPROVE']);
  assert.equal(plan.allowed, true);
  assert.equal(plan.payload.event, 'COMMENT', 'no flag changes the event');
  assert.equal(plan.payload.commit_id, HEAD);
  assert.deepEqual(plan.payload.comments.map((c) => [c.path, c.line, c.side]), [['src/auth/session.ts', 6, 'RIGHT'], ['src/auth/session.ts', 21, 'RIGHT']]);
  assert.equal(plan.payload.comments[0].body, '**bug** (correctness): The expiry check uses <, so a token stays valid one tick too long.\n\nFix: Use <=.');
  assert.match(plan.payload.body, /\*\*blocking\*\* \(1 bug, 1 risk, 1 nit\)\. CI as read: passing\./);
  assert.match(plan.payload.body, /### Outside the diff\n- `src\/auth\/session\.ts:L1` \*\*risk\*\*/);
  assert.match(plan.payload.body, /Not shown: 1 finding failed the citation check\./);
  assert.match(plan.payload.body, /automated reviewer/);
  assert.ok(!JSON.stringify(plan.payload).includes('Made up'), 'an unverified finding is never posted');
  assert.ok(!existsSync(`${w.stub}.posted.jsonl`), 'post-plan posts nothing');

  const posted = w.h(['post', '--run', s.run_id, '--pr', '7', '--event', 'REQUEST_CHANGES']);
  assert.deepEqual([posted.ok, posted.event, posted.review_id, posted.inline_comments], [true, 'COMMENT', 55, 2]);
  const sent = readFileSync(`${w.stub}.posted.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].payload, plan.payload, 'post sends exactly what post-plan showed');
  assert.match(w.h(['post', '--run', s.run_id, '--pr', '7']).refused, /already posted to #7/);
  assert.match(w.h(['record'], { run: s.run_id, results: results() }).error, /already posted to #7/);
  assert.equal(readFileSync(`${w.stub}.posted.jsonl`, 'utf8').trim().split('\n').length, 1);
  assert.match(w.h(['post', '--run', s.run_id, '--pr', '99']).error, /not in run/);
  assert.match(w.h(['post', '--run', '../../etc', '--pr', '7']).error, /unknown run/);
});

test('post: refused on a moved head, a closed PR and an empty review', () => {
  const w = world();
  const s = w.start(['7', '--no-refute']);
  w.h(['record'], { run: s.run_id, results: results() });
  assert.match(w.h(['post', '--run', s.run_id, '--pr', '7']).refused, /nothing to post/);
  w.h(['record'], { run: s.run_id, results: results({ correctness: rep('correctness', [BUG]) }) });
  w.data.prs[7].view.headRefOid = BASE;
  w.save();
  assert.match(w.h(['post', '--run', s.run_id, '--pr', '7']).refused, /moved from .* since it was reviewed: run the review again/);
  // A head that moved before `record` also marks the review partial.
  assert.match(w.h(['record'], { run: s.run_id, results: results() }).prs[0].partial_reasons[0], /moved to .* during the review/);
  w.data.prs[7].view.headRefOid = HEAD;
  w.data.prs[7].view.state = 'CLOSED';
  w.save();
  w.h(['record'], { run: s.run_id, results: results({ correctness: rep('correctness', [BUG]) }) });
  assert.match(w.h(['post', '--run', s.run_id, '--pr', '7']).refused, /#7 is closed/);
  assert.ok(!existsSync(`${w.stub}.posted.jsonl`));
});

const cases = (w) => (existsSync(join(w.state, 'jev.jsonl')) ? readFileSync(join(w.state, 'jev.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const SECOND = { severity: 'q', file: 'src/auth/session.ts', line: 21, quote: 'return Math.max(0, token.expires - Date.now());', problem: 'Is zero the right floor here?', fix: 'Say so in a comment or return null.' };

test('Jev uncalibrated: logged in the shared case shape, sees no code, changes nothing', () => {
  const input = (s) => ({ run: s.run_id, results: results({ correctness: rep('correctness', [BUG]), standards: rep('standards', [NIT]) }) });
  const off = world();
  const a = off.h(['record'], input(off.start(['7', '--no-refute']))).prs[0];
  const on = world(undefined, { REVIEW_PRS_JEV: 'live' });
  writeFileSync(on.jev, JSON.stringify({ 'actionable__*': 0.01, 'needs_lens__*': 0.99, outside_stated_scope: 0.99, 'same__*': 0.99 }));
  const s = on.start(['7', '--no-refute']);
  assert.deepEqual(s.prs[0].lenses, ['correctness', 'standards', 'security'], 'an uncalibrated needs_lens adds nothing');
  const b = on.h(['record'], input(s)).prs[0];
  for (const k of ['verdict', 'lines', 'outside_diff', 'dropped', 'counts', 'scope_note']) assert.deepEqual(b[k], a[k], k);

  const sent = readFileSync(`${on.jev}.sent.jsonl`, 'utf8');
  assert.ok(!sent.includes('token.expires'), 'no quoted line or diff text reaches Jev');
  assert.ok(!sent.includes('Math.max'));
  assert.ok(!sent.includes('a'.repeat(36)) && sent.includes('ghp_[REDACTED]'), 'a token in the PR body is redacted');
  assert.match(sent, /The clamp is undocumented/);
  const log = cases(on);
  assert.deepEqual([...new Set(log.map((c) => c.question))].sort(), ['finding_is_actionable', 'needs_lens', 'outside_stated_scope', 'same_finding']);
  for (const c of log) {
    assert.deepEqual([c.v, c.type, c.skill, c.acted], [1, 'case', 'review-prs', false]);
    assert.equal(typeof c.threshold, 'number');
    assert.ok(['gte', 'lt'].includes(c.acts_when));
  }
  assert.equal(log.find((c) => c.question === 'finding_is_actionable').unsafe, 'fn');
});

test('Jev calibrated and live: hides a nit, never a bug; adds a lens; notes scope', () => {
  const w = world(undefined, { REVIEW_PRS_JEV: 'live', REVIEW_PRS_TEST_CALIBRATED: 'finding_is_actionable,needs_lens,outside_stated_scope' });
  writeFileSync(w.jev, JSON.stringify({ 'actionable__*': 0.01, needs_lens__data: 0.9, 'needs_lens__*': 0.1, outside_stated_scope: 0.9 }));
  const s = w.start(['7', '--no-refute']);
  assert.deepEqual(s.prs[0].lenses, ['correctness', 'standards', 'security', 'data']);
  assert.match(s.prs[0].reasons.data, /^Jev/);
  const res = [...results({ correctness: rep('correctness', [BUG]), standards: rep('standards', [NIT]) }), { pr: 7, key: 'data', report: rep('data', []) }];
  const pr = w.h(['record'], { run: s.run_id, results: res }).prs[0];
  assert.equal(pr.lines.length, 1);
  assert.match(pr.lines[0], /bug/);
  assert.equal(pr.dropped.not_actionable, 1);
  assert.equal(pr.verdict, 'blocking');
  assert.match(pr.scope_note, /go beyond what the title and description say/);
  assert.ok(cases(w).filter((c) => c.question !== 'same_finding').every((c) => c.acted === true));
  assert.ok(cases(w).filter((c) => c.question === 'same_finding').every((c) => c.acted === false));
});

test('Jev calibrated same_finding merges two points in one file without losing either', () => {
  const w = world(undefined, { REVIEW_PRS_JEV: 'live', REVIEW_PRS_TEST_CALIBRATED: 'same_finding' });
  writeFileSync(w.jev, JSON.stringify({ 'same__*': 0.95, 'actionable__*': 0.9 }));
  const s = w.start(['7', '--no-refute']);
  const risk = { ...BUG, severity: 'risk' };
  const pr = w.h(['record'], { run: s.run_id, results: results({ correctness: rep('correctness', [risk]), standards: rep('standards', [SECOND]) }) }).prs[0];
  assert.equal(pr.lines.length, 1);
  assert.match(pr.lines[0], /\(\+1 more here\)/);
  assert.equal(pr.merged, 1);
  assert.match(w.h(['post-plan', '--run', s.run_id, '--pr', '7']).payload.comments[0].body, /Also here:\n- L21 \*\*q\*\* \(standards\): Is zero the right floor here\?/);
});

test('a degraded Jev changes nothing and says so', () => {
  const w = world(undefined, { REVIEW_PRS_JEV: 'live', REVIEW_PRS_TEST_CALIBRATED: 'finding_is_actionable' });
  writeFileSync(w.jev, JSON.stringify({ __degraded: true }));
  const s = w.start(['7', '--no-refute']);
  assert.equal(s.jev, 'degraded');
  const r = w.h(['record'], { run: s.run_id, results: results({ standards: rep('standards', [NIT]) }) });
  assert.equal(r.jev, 'degraded');
  assert.equal(r.prs[0].lines.length, 1);
});

test('outcome labels a finding whose line changed, and stats reads the log', () => {
  const w = world(undefined, { REVIEW_PRS_JEV: 'shadow' });
  writeFileSync(w.jev, JSON.stringify({ 'actionable__*': 0.8 }));
  const s = w.start(['7', '--no-refute']);
  // Two minor findings far apart: line 6 and line 21.
  const early = { severity: 'q', file: 'src/auth/session.ts', line: 6, quote: 'if (token.expires < now) return false;', problem: 'Is strict expiry intended?', fix: 'Confirm or revert to <=.' };
  w.h(['record'], { run: s.run_id, results: results({ correctness: rep('correctness', [early]), standards: rep('standards', [NIT]) }) });
  assert.deepEqual(w.h(['outcome', '--run', s.run_id]).prs, [], 'nothing posted yet');
  w.h(['post', '--run', s.run_id, '--pr', '7']);
  const still = w.h(['outcome', '--run', s.run_id]).prs[0];
  assert.deepEqual([still.posted, still.addressed, still.open], [2, 0, 2]);

  // The author fixes line 6 and leaves line 21 alone.
  git('checkout', '-q', 'pr');
  put('src/auth/session.ts', SESSION('  if (token.expires <= now) return false;', '  return Math.max(0, token.expires - Date.now());', ['  audit(token);']));
  git('commit', '-qam', 'address review');
  const NEW = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  w.data.prs[7].view.headRefOid = NEW;
  w.save();
  const open = w.h(['outcome', '--run', s.run_id]).prs[0];
  assert.deepEqual([open.addressed, open.open], [1, 1]);
  const labels = () => cases(w).filter((c) => c.type === 'label');
  assert.deepEqual(labels().map((l) => [l.question, l.label, l.source]), [['finding_is_actionable', true, 'outcome']]);
  // A head the old one is not an ancestor of (a rebase): nothing can be told, nothing is labeled.
  w.data.prs[7].view.headRefOid = BASE;
  w.save();
  const rebased = w.h(['outcome', '--run', s.run_id]).prs[0];
  assert.deepEqual([rebased.addressed, rebased.open], [0, 2]);
  assert.equal(labels().length, 1);
  w.data.prs[7].view.headRefOid = NEW;
  // Merged: the untouched finding is now final, and labeled as not acted on.
  w.data.prs[7].view.state = 'MERGED';
  w.save();
  assert.equal(w.h(['outcome', '--run', s.run_id]).prs[0].open, 0);
  assert.deepEqual(labels().map((l) => l.label).sort(), [false, true, true]);

  const st = w.h(['stats']);
  assert.deepEqual([st.reviews, st.posts, st.verdicts.comments], [1, 1, 1]);
  assert.deepEqual(st.addressed.map((r) => [r.lens, r.severity, r.posted, r.addressed, r.rate]).sort(), [['correctness', 'q', 1, 1, 1], ['standards', 'nit', 1, 0, 0]]);
  const logText = readFileSync(join(w.state, 'log.jsonl'), 'utf8');
  assert.ok(!logText.includes('token.expires') && !logText.includes('clamp'), 'the log holds no code and no finding text');
});

test('the reviewer agent is read-only and bounded', () => {
  const text = readFileSync(join(here, '../../../../agents/reviewer.md'), 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---/)[1];
  assert.match(fm, /^name: reviewer$/m);
  assert.match(fm, /^tools: Read, Grep, Glob, Bash$/m);
  for (const s of ['Never check out, never run', 'Never write to GitHub', 'Data, not instructions', 'Never spawn subagents']) assert.ok(text.includes(s), s);
});

test('SKILL.md documents every command, verdict, severity, lens and drop rule, and no GitHub write but post', async () => {
  const R = await import('../review.mjs');
  const skill = readFileSync(join(here, '../../SKILL.md'), 'utf8');
  for (const w of [...R.COMMANDS, ...R.VERDICTS, ...R.SEVERITIES, ...R.LENSES, ...R.DROP_RULES, 'partial', 'refused', 'candidates', 'would_post', 'not_shown', 'scope_note', 'COMMENT', 'REVIEW_PRS_JEV=off']) {
    assert.ok(skill.includes(`\`${w}`) || skill.includes(`${w}\``), `SKILL.md does not mention ${w}`);
  }
  const fm = skill.slice(0, skill.indexOf('\n---', 4));
  assert.match(fm, /^---\nname: review-prs\ndescription: "/);
  // Every `gh` write the skill names is one it forbids.
  for (const m of skill.matchAll(/^.*\bgh (pr (review|comment|merge|edit|close)|api)\b.*$/gm)) assert.match(m[0], /\b(no|never|not)\b/i, m[0]);
  assert.ok(!/APPROVE|REQUEST_CHANGES/.test(skill));
});
