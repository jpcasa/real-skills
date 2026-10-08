import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'calib-'));
process.env.REAL_SKILLS_STATE_DIR = join(tmp, 'state');
process.env.REAL_SKILLS_CALIBRATION_DIR = join(tmp, 'state/calibration');
for (const k of ['DO_SHIT_STATE_DIR', 'CHANGELOG_STATE_DIR', 'QUICK_ASK_ME_STATE_DIR', 'ASK_SPECS_STATE_DIR', 'WTF_STATE_DIR', 'REAL_SKILLS_CALIBRATION']) delete process.env[k];

const C = await import('../lib/calibration.mjs');
const { evaluate, MIN_LABELED } = await import('../lib/bar.mjs');
const K = await import('../calibrate.mjs');
const { CATALOG } = await import('../lib/catalog.mjs');

const reset = () => rmSync(join(tmp, 'state'), { recursive: true, force: true });
const row = (p, label, extra = {}) => ({ skill: 's', question: 'q', case: `c${Math.random()}`, p, label, threshold: 0.5, acts_when: 'gte', unsafe: 'fp', ...extra });
// n cases: the first `yes` are true with high scores, the rest false with low ones.
const clean = (n, yes, extra = {}) => Array.from({ length: n }, (_, i) => (i < yes ? row(0.9, true, extra) : row(0.1, false, extra)));

// ---------------------------------------------------------------- the bar
test('bar: needs 30 labeled cases and 5 of each answer', () => {
  assert.equal(MIN_LABELED, 30);
  const short = evaluate(clean(29, 15));
  assert.deepEqual([short.status, short.need.labeled], ['not enough data', 1]);
  const lopsided = evaluate(clean(40, 4));
  assert.deepEqual([lopsided.status, lopsided.need.true], ['not enough data', 1]);
  assert.equal(evaluate([...clean(30, 15), { ...row(0.5, undefined), label: undefined }]).cases, 31, 'unlabeled cases are counted, not used');
  assert.equal(evaluate(clean(30, 15)).status, 'ready');
});

test('bar: zero unsafe errors, most action, then the middle of the safe run', () => {
  // unsafe = fp (acting on a wrong "yes"). One false case scores 0.62: every threshold at or below 0.6 is unsafe.
  const fp = evaluate([...clean(40, 20), row(0.62, false)]);
  assert.equal(fp.status, 'ready');
  assert.equal(fp.proposed.unsafe_errors, 0);
  assert.equal(fp.proposed.threshold, 0.8, 'safe and acting from 0.65 to 0.9: the middle, away from the unsafe end');
  assert.ok(fp.current.unsafe_errors === 1, 'the built-in 0.5 would have made the unsafe error');
  assert.deepEqual([fp.exposed, fp.bound], [20, 0.15], 'only the 20 cases it says yes to could have been the unsafe error: 3/20, not 3/41');

  // unsafe = fn, acts below the threshold (skip the human when the score is low). One true case scores 0.33.
  const fnRows = [...clean(40, 20, { acts_when: 'lt', unsafe: 'fn' }), row(0.33, true, { acts_when: 'lt', unsafe: 'fn' })];
  const fn = evaluate(fnRows);
  assert.equal(fn.proposed.threshold, 0.2, 'safe and acting from 0.15 to 0.3: the middle, away from the unsafe end');
  assert.equal(fn.proposed.unsafe_errors, 0);
});

test('bar: an unsafe error at every threshold is "no safe threshold"', () => {
  const r = evaluate([...clean(40, 20), row(0.99, false), row(0.97, false)]);
  assert.equal(r.status, 'no safe threshold');
  assert.equal(r.proposed, undefined);
});

test('bar: a question with no unsafe side is chosen on accuracy, with no safety step', () => {
  const rows = [...clean(40, 20, { unsafe: null }), row(0.42, true, { unsafe: null }), row(0.44, true, { unsafe: null })];
  const r = evaluate(rows);
  assert.equal(r.status, 'ready');
  assert.equal(r.proposed.accuracy, 1);
  assert.equal(r.proposed.threshold, 0.4, 'nearest to the built-in 0.5 among the perfect ones');
  assert.equal(r.bound, undefined);
});

test('bar: a question that would almost never act is not worth turning on', () => {
  // Acts at or above the threshold; a false case at 0.93 forces the threshold to 0.95, where nothing acts.
  const rows = [...Array.from({ length: 20 }, () => row(0.9, true)), ...Array.from({ length: 20 }, () => row(0.1, false)), row(0.93, false)];
  const r = evaluate(rows);
  assert.deepEqual([r.status, r.proposed.act_rate], ['never acts', 0]);
});

test('bar: cases near the proposed threshold are listed for a person to look at', () => {
  const r = evaluate([...clean(40, 20), row(0.62, false), row(0.78, true, { case: 'edge', show: 'the edge one' })]);
  const edge = r.near.find((n) => n.case === 'edge');
  assert.deepEqual([r.proposed.threshold, edge.show, edge.label, r.near.indexOf(edge) < 2], [0.7, 'the edge one', true, true]);
  assert.ok(r.near.length <= 10);
});

// ---------------------------------------------------------------- the file
test('calibration file: missing, malformed, off and out-of-range all mean "not calibrated"', () => {
  reset();
  assert.equal(C.isOn('s', 'q'), false);
  assert.equal(C.threshold('s', 'q', 0.4), 0.4);
  mkdirSync(C.dir(), { recursive: true });
  writeFileSync(join(C.dir(), 'calibration.json'), '{not json');
  assert.equal(C.isOn('s', 'q'), false);
  C.setEntry('s', 'q', { threshold: 0.7, n: 30 });
  assert.deepEqual([C.isOn('s', 'q'), C.threshold('s', 'q', 0.4), C.isOn('s', 'other')], [true, 0.7, false]);
  process.env.REAL_SKILLS_CALIBRATION = 'off';
  assert.deepEqual([C.isOn('s', 'q'), C.threshold('s', 'q', 0.4)], [false, 0.4]);
  delete process.env.REAL_SKILLS_CALIBRATION;
  for (const bad of [0, 1, 1.5, -0.2, '0.7', null]) {
    C.setEntry('s', 'bad', { threshold: bad });
    assert.equal(C.isOn('s', 'bad'), false, `threshold ${bad}`);
  }
});

test('spot check is repeatable and about one in ten', () => {
  const ids = Array.from({ length: 2000 }, (_, i) => `case-${i}`);
  const hits = ids.filter(C.spotCheck);
  assert.deepEqual(hits, ids.filter(C.spotCheck));
  assert.ok(hits.length > 140 && hits.length < 260, `${hits.length} of 2000`);
});

test('writeCases: redacts `show` in one batch, caps it, and drops it when redaction is unavailable', () => {
  reset();
  const f = join(tmp, 'state/x/jev.jsonl');
  let calls = 0;
  const redact = (body) => {
    calls++;
    return { shows: body.shows.map((s) => s.replace(/sk_live_\w+/g, '[redacted]')) };
  };
  C.writeCases(f, [
    { skill: 's', question: 'q', case: 'a', p: 0.4, threshold: 0.5, acts_when: 'gte', unsafe: 'fp', show: `key sk_live_abc ${'x'.repeat(400)}` },
    { skill: 's', question: 'q', case: 'b', p: 0.6, threshold: 0.5, acts_when: 'gte', show: 'plain' },
    { skill: 's', question: 'q', case: 'no-score', p: null, threshold: 0.5 },
  ], redact);
  const rows = C.readJsonl(f);
  assert.equal(calls, 1);
  assert.deepEqual(rows.map((r) => [r.case, r.type, r.v, r.unsafe]), [['a', 'case', 1, 'fp'], ['b', 'case', 1, null]]);
  assert.ok(rows[0].show.startsWith('key [redacted]') && rows[0].show.length <= C.SHOW_MAX);
  C.writeCases(f, [{ skill: 's', question: 'q', case: 'c', p: 0.5, threshold: 0.5, show: 'secret' }]);
  C.writeCases(f, [{ skill: 's', question: 'q', case: 'd', p: 0.5, threshold: 0.5, show: 'secret' }], () => {
    throw new Error('jq missing');
  });
  assert.deepEqual(C.readJsonl(f).slice(2).map((r) => [r.case, r.show]), [['c', undefined], ['d', undefined]]);
});

test('a label on the unsafe side of a deciding question switches it off at once', () => {
  reset();
  const f = join(C.dir(), 'labels.jsonl');
  C.setEntry('s', 'q', { threshold: 0.6, n: 30 });
  // Safe: score below the threshold, so it did not act.
  assert.equal(C.writeLabel(f, { skill: 's', question: 'q', case: 'a', label: false, source: 'human', p: 0.4, unsafe: 'fp' }).revoked, false);
  // Wrong but not unsafe: it should have acted and did not.
  assert.equal(C.writeLabel(f, { skill: 's', question: 'q', case: 'b', label: true, source: 'human', p: 0.4, unsafe: 'fp' }).revoked, false);
  assert.equal(C.isOn('s', 'q'), true);
  assert.equal(C.writeLabel(f, { skill: 's', question: 'q', case: 'c', label: false, source: 'gate', p: 0.8, unsafe: 'fp' }).revoked, true);
  assert.equal(C.isOn('s', 'q'), false);
  const log = C.readJsonl(join(C.dir(), 'revoked.jsonl'));
  assert.match(log[0].reason, /case c: p=0.8 at threshold 0.6/);
  assert.equal(C.writeLabel(f, { skill: 's', question: 'q', case: 'd', label: 'yes', source: 'human' }).revoked, false);
  assert.equal(C.readJsonl(f).length, 3, 'a label that is not true or false is not written');
});

test('writeLabel never throws: a skill in the middle of its work must not lose it to a log', () => {
  reset();
  mkdirSync(join(tmp, 'state'), { recursive: true });
  const blocker = join(tmp, 'state/a-file');
  writeFileSync(blocker, 'x');
  // The label file would sit under a regular file: the write cannot succeed.
  const r = C.writeLabel(join(blocker, 'labels.jsonl'), { skill: 's', question: 'q', case: 'a', label: true, source: 'gate', p: 0.9, unsafe: 'fp' });
  assert.equal(r.revoked, false);
  assert.match(r.error, /ENOTDIR|EEXIST|not a directory/);
  // The revoke still happens when only the label could not be written.
  C.setEntry('s', 'q', { threshold: 0.5, n: 30 });
  const r2 = C.writeLabel(join(blocker, 'labels.jsonl'), { skill: 's', question: 'q', case: 'b', label: false, source: 'gate', p: 0.9, unsafe: 'fp' });
  assert.deepEqual([r2.revoked, C.isOn('s', 'q'), typeof r2.error], [true, false, 'string']);
});

// ---------------------------------------------------------------- the CLI
const seed = (dir, name, records) => {
  mkdirSync(join(tmp, 'state', dir), { recursive: true });
  writeFileSync(join(tmp, 'state', dir, name), records.map((r) => JSON.stringify({ v: 1, ...r })).join('\n') + '\n');
};
const kase = (skill, question, id, p, extra = {}) => ({ type: 'case', skill, question, case: id, p, threshold: 0.5, acts_when: 'gte', unsafe: 'fp', show: `case ${id}`, ask: 'Is it so?', ...extra });
const lab = (skill, question, id, label, source = 'gate') => ({ type: 'label', skill, question, case: id, label, source });
const ready = (skill, question) => Array.from({ length: 30 }, (_, i) => [kase(skill, question, `r${i}`, i < 15 ? 0.9 : 0.1), lab(skill, question, `r${i}`, i < 15)]).flat();

test('status: reads every skill folder, last record per case wins, every catalogued question is listed', () => {
  reset();
  seed('changelog', 'jev.jsonl', [kase('changelog', 'area', 'pr1', 0.2), kase('changelog', 'area', 'pr1', 0.8), { type: 'verdict', run: 'old-shape' }, { v: 2, type: 'case' }]);
  seed('do-shit/run-1', 'events.jsonl', [kase('do-shit', 'plan_needs_human_review', 'run-1/checkpoint', 0.1, { acts_when: 'lt', unsafe: 'fn' }), lab('do-shit', 'plan_needs_human_review', 'run-1/checkpoint', false)]);
  seed('wtf', 'log.jsonl', ready('wtf', 'ask_not_breakage'));
  const s = K.status();
  const q = Object.fromEntries(s.questions.map((x) => [x.id, x]));
  assert.equal(s.questions.length, CATALOG.length, 'one row per known question, logged or not');
  assert.deepEqual([q['changelog/area'].cases, q['changelog/area'].labeled, q['changelog/area'].status], [1, 0, 'not enough data']);
  assert.deepEqual([q['do-shit/plan_needs_human_review'].labeled, q['do-shit/plan_needs_human_review'].acts_when], [1, 'lt']);
  assert.equal(q['wtf/ask_not_breakage'].status, 'ready');
  assert.deepEqual([q['quick-ask-me/seam_is_known'].cases, q['quick-ask-me/seam_is_known'].status], [0, 'not enough data']);
  assert.ok(!('unsafe' in q['quick-ask-me/seam_is_known']) && !('current_threshold' in q['quick-ask-me/seam_is_known']), 'nothing is claimed about a question with no case');
  assert.deepEqual([s.totals.ready, s.totals.deciding, s.totals.questions], [1, 0, CATALOG.length]);
  // A case logged again later (here: after its threshold moved) is the newest record of its question.
  seed('changelog', 'later.jsonl', [kase('changelog', 'area', 'pr0', 0.3, { threshold: 0.6 }), kase('changelog', 'area', 'pr1', 0.8, { threshold: 0.75 })]);
  assert.equal(K.status().questions.find((x) => x.id === 'changelog/area').cases, 2);
  const many = Array.from({ length: 30 }, (_, i) => [kase('changelog', 'area', `m${i}`, i < 15 ? 0.9 : 0.1, { threshold: 0.6 }), lab('changelog', 'area', `m${i}`, i < 15)]).flat();
  seed('changelog', 'many.jsonl', many);
  seed('changelog', 'zz-newest.jsonl', [kase('changelog', 'area', 'm0', 0.9, { threshold: 0.75 })]);
  assert.equal(K.status().questions.find((x) => x.id === 'changelog/area').current_threshold, 0.75, 'the threshold shown is the one on the newest record');
  assert.deepEqual(K.status({ skill: 'wtf' }).questions.map((x) => x.skill).filter((x) => x !== 'wtf'), []);
});

test('label-next: unlabeled only, spot checks first, then nearest the threshold, no score shown, capped', () => {
  reset();
  seed('changelog', 'jev.jsonl', [
    kase('changelog', 'area', 'far', 0.7), kase('changelog', 'area', 'near', 0.52), kase('changelog', 'area', 'spot', 0.9, { spot: true }),
    kase('changelog', 'area', 'done', 0.5), lab('changelog', 'area', 'done', true), kase('changelog', 'area', 'blind', 0.5, { show: undefined }),
    ...Array.from({ length: 20 }, (_, i) => kase('wtf', 'screen_was_enough', `w${i}`, 0.1)),
  ]);
  const n = K.labelNext();
  assert.deepEqual(n.cases.slice(0, 3).map((c) => c.case), ['spot', 'near', 'far']);
  assert.deepEqual([n.cases.length, n.remaining, n.unshowable], [K.LABEL_BATCH, 11, 1]);
  assert.ok(n.cases.every((c) => !('p' in c) && c.ask && c.show), 'the score is not shown to the labeler');
  assert.deepEqual(K.labelNext({ skill: 'changelog', limit: 2 }).cases.map((c) => c.case), ['spot', 'near']);
  assert.equal(K.labelNext({ limit: 500 }).cases.length, K.LABEL_BATCH);
});

test('label: yes/no are written, "can\'t tell" is not, an unknown case is rejected', () => {
  reset();
  seed('changelog', 'jev.jsonl', [kase('changelog', 'area', 'a', 0.6), kase('changelog', 'area', 'b', 0.4), kase('changelog', 'area', 'c', 0.4)]);
  const r = K.label({ labels: [
    { skill: 'changelog', question: 'area', case: 'a', answer: 'yes' },
    { skill: 'changelog', question: 'area', case: 'b', answer: 'No' },
    { skill: 'changelog', question: 'area', case: 'c', answer: 'cant_tell' },
    { skill: 'changelog', question: 'area', case: 'ghost', answer: 'yes' },
  ] });
  assert.deepEqual([r.written, r.skipped, r.rejected.length], [2, 1, 1]);
  const q = K.status().questions.find((x) => x.id === 'changelog/area');
  assert.deepEqual([q.labeled, q.split], [2, { true: 1, false: 1 }]);
  assert.deepEqual(K.labelNext({ skill: 'changelog' }).cases.map((c) => c.case), ['c']);
});

test('apply: recomputes from the logs and refuses anything that is not ready', () => {
  reset();
  seed('wtf', 'log.jsonl', ready('wtf', 'ask_not_breakage'));
  seed('changelog', 'jev.jsonl', [kase('changelog', 'area', 'a', 0.6)]);
  const r = K.apply({ questions: ['wtf/ask_not_breakage', 'changelog/area', 'nope/nothing'], threshold: 0.01, status: 'ready' });
  assert.deepEqual(r.applied.map((a) => a.id), ['wtf/ask_not_breakage']);
  assert.deepEqual(r.refused.map((x) => [x.id, x.status]), [['changelog/area', 'not enough data'], ['nope/nothing', 'no cases logged']]);
  const e = C.entry('wtf', 'ask_not_breakage');
  assert.deepEqual([e.n, e.split, typeof e.threshold, e.labels_sha.length], [30, { true: 15, false: 15 }, 'number', 12]);
  assert.equal(C.isOn('changelog', 'area'), false);
  const s = K.status().questions.find((x) => x.id === 'wtf/ask_not_breakage');
  assert.equal(s.deciding.threshold, e.threshold);
  assert.deepEqual([s.deciding.accuracy_now, s.deciding.labeled_now], [1, 30], 'how it is holding up at its own threshold');
});

test('a label written by a skill itself revokes at the next status; revoke by hand works', () => {
  reset();
  seed('wtf', 'log.jsonl', ready('wtf', 'ask_not_breakage'));
  K.apply({ questions: ['wtf/ask_not_breakage'] });
  const t = C.entry('wtf', 'ask_not_breakage').threshold;
  seed('wtf', 'late.jsonl', [kase('wtf', 'ask_not_breakage', 'late', Math.min(0.99, t + 0.1)), lab('wtf', 'ask_not_breakage', 'late', false, 'outcome')]);
  assert.deepEqual(K.status().revoked, ['wtf/ask_not_breakage']);
  assert.equal(C.isOn('wtf', 'ask_not_breakage'), false);

  reset();
  seed('wtf', 'log.jsonl', ready('wtf', 'ask_not_breakage'));
  K.apply({ questions: ['wtf/ask_not_breakage'] });
  assert.deepEqual(K.revoke({ question: 'wtf/ask_not_breakage' }).revoked, true);
  assert.deepEqual(K.revoke({ question: 'wtf/ask_not_breakage' }).revoked, false);
  assert.throws(() => K.revoke({ question: 'no-slash' }), /needs --question/);
});

test('CLI: one JSON object per call, unknown command exits 2, bad stdin exits 1', () => {
  reset();
  const cli = join(here, '../calibrate.mjs');
  const run = (args, input = '') => {
    try {
      return { code: 0, out: JSON.parse(execFileSync('node', [cli, ...args], { input, env: process.env }).toString()) };
    } catch (e) {
      return { code: e.status, out: JSON.parse(e.stdout.toString()) };
    }
  };
  assert.equal(run(['status']).out.totals.ready, 0);
  assert.deepEqual([run(['nope']).code, run(['apply'], 'not json').code], [2, 1]);
  assert.deepEqual(run(['label-next', '--limit', '3']).out.cases, []);
});

test('SKILL.md documents every command and status, and is user-invoked only', () => {
  const skill = readFileSync(join(here, '../../SKILL.md'), 'utf8');
  for (const w of [...K.COMMANDS, 'not enough data', 'no safe threshold', 'never acts', 'ready', 'REAL_SKILLS_CALIBRATION=off', 'spot check']) {
    assert.ok(skill.includes(w), `SKILL.md does not mention ${w}`);
  }
  assert.match(skill, /disable-model-invocation: true/);
  assert.ok(existsSync(join(here, '../../agents/openai.yaml')));
});
