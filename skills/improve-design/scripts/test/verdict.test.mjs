import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assign, unblind } from '../lib/compare.mjs';
import { draftFor, HEURISTICS, moveDecision, parseScores, verdict, VERDICTS, VETOES } from '../lib/verdict.mjs';

// ---------------------------------------------------------------- blind comparison
const pairs = [
  { move: 'm1', viewport: '1440x900', before: '/r/before-1440.png', after: '/r/after-1440.png' },
  { move: 'm1', viewport: '390x844', before: '/r/before-390.png', after: '/r/after-390.png' },
];

test('the sheet never says which side is newer, and the key un-blinds it', () => {
  const seq = [0.1, 0.9];
  const { sheet, key } = assign(pairs, () => seq.shift());
  assert.deepEqual(sheet.map((s) => Object.keys(s).sort()), [['X', 'Y', 'pair', 'viewport'], ['X', 'Y', 'pair', 'viewport']]);
  assert.ok(!JSON.stringify(sheet).match(/before|after|m1/));
  assert.equal(key.p1.X, 'after');
  assert.equal(key.p2.X, 'before');
  const rows = unblind(key, [{ pair: 'p1', prefers: 'X' }, { pair: 'p2', prefers: 'X', broke: { side: 'Y', what: 'CTA wraps', where: 'header' } }]);
  assert.deepEqual(rows.map((r) => [r.viewport, r.prefers]), [['1440x900', 'after'], ['390x844', 'before']]);
  assert.deepEqual(rows[1].broke, { what: 'CTA wraps', where: 'header' });
});

test('both sides come up over many draws', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(assign(pairs).key.p1.X);
  assert.deepEqual([...seen].sort(), ['after', 'before']);
});

test('a missing or malformed answer is "missing", and damage on the old side is not damage', () => {
  const { key } = assign(pairs, () => 0.9); // X = before for both
  const rows = unblind(key, [{ pair: 'p1', prefers: 'Z' }, { pair: 'p9', prefers: 'X' }, { pair: 'p2', prefers: 'Y', broke: { side: 'X', what: 'old bug', where: 'nav' } }]);
  assert.equal(rows[0].prefers, 'missing');
  assert.equal(rows[1].prefers, 'after');
  assert.equal(rows[1].broke, null);
  // "broke" with no place named is an opinion, not a finding.
  assert.equal(unblind(key, [{ pair: 'p1', prefers: 'Y', broke: { side: 'Y', what: 'feels off', where: '' } }])[0].broke, null);
});

// ---------------------------------------------------------------- one move
const clean = { committed: true, blocked: false, out_of_scope: [], gates_red: [], new_findings: [] };
const row = (prefers, over = {}) => ({ viewport: '1440x900', prefers, broke: null, ...over });

test('each veto drops the move and no comparison can save it', () => {
  const cases = [
    [{ ...clean, out_of_scope: ['src/api.ts'] }, 'out_of_scope'],
    [{ ...clean, gates_red: ['pnpm lint'] }, 'gate_red'],
    [{ ...clean, new_findings: ['flat-hierarchy|src/a.tsx'] }, 'new_detector_finding'],
    [{ ...clean, committed: false }, 'no_commit'],
    [{ ...clean, blocked: true }, 'blocked'],
  ];
  for (const [check, veto] of cases) {
    const d = moveDecision({ check, visual: true, compare: [row('after')] });
    assert.equal(d.keep, false, veto);
    assert.equal(d.vetoed, true);
    assert.ok(d.reasons.some((r) => r.startsWith(veto)), `${veto} in ${d.reasons}`);
    assert.ok(VETOES.includes(veto));
  }
});

test('the before picture preferred at one viewport drops the move', () => {
  const d = moveDecision({ check: clean, visual: true, compare: [row('after'), row('before', { viewport: '390x844' })] });
  assert.equal(d.keep, false);
  assert.deepEqual(d.reasons, ['before_preferred at 390x844']);
  assert.equal(d.vetoed, false);
});

test('something broken, with a place named, drops the move even when it was preferred', () => {
  const d = moveDecision({ check: clean, visual: true, compare: [row('after', { broke: { what: 'CTA wraps', where: 'header' } })] });
  assert.equal(d.keep, false);
  assert.match(d.reasons[0], /^broke at 1440x900: CTA wraps \(header\)/);
});

test('kept: preferred everywhere; "same" somewhere is kept and noted', () => {
  assert.deepEqual(moveDecision({ check: clean, visual: true, compare: [row('after')] }), { keep: true, vetoed: false, unverified: false, same: [], reasons: [] });
  const d = moveDecision({ check: clean, visual: true, compare: [row('after'), row('same', { viewport: '390x844' })] });
  assert.equal(d.keep, true);
  assert.deepEqual(d.same, ['390x844']);
  // No difference anywhere is not an improvement.
  assert.equal(moveDecision({ check: clean, visual: true, compare: [row('same')] }).keep, false);
});

test('a visual move with no pictures, or with an answer missing, is kept as unverified', () => {
  for (const compare of [null, [], [row('missing')]]) {
    const d = moveDecision({ check: clean, visual: true, compare });
    assert.equal(d.keep, true);
    assert.equal(d.unverified, true);
  }
});

test('a move with nothing to see is kept only when its issue is gone', () => {
  assert.equal(moveDecision({ check: clean, visual: false, issueGone: true }).keep, true);
  assert.equal(moveDecision({ check: clean, visual: false, issueGone: true }).unverified, false);
  for (const issueGone of [false, null]) {
    const d = moveDecision({ check: clean, visual: false, issueGone });
    assert.equal(d.keep, false);
    assert.deepEqual(d.reasons, ['issue_still_there']);
  }
});

test('Jev can drop a kept move and can never keep a dropped one', () => {
  const on = { is_improvement: { p: 0.2, threshold: 0.4, on: true }, harms_another_state: { p: 0.9, threshold: 0.7, on: true } };
  const d = moveDecision({ check: clean, visual: true, compare: [row('after')], jev: on });
  assert.equal(d.keep, false);
  assert.deepEqual(d.reasons, ['jev: is_improvement', 'jev: harms_another_state']);
  const off = { is_improvement: { p: 0.2, threshold: 0.4, on: false }, harms_another_state: { p: 0.9, threshold: 0.7, on: false } };
  assert.equal(moveDecision({ check: clean, visual: true, compare: [row('after')], jev: off }).keep, true);
  const glowing = { is_improvement: { p: 0.99, threshold: 0.4, on: true }, harms_another_state: { p: 0.01, threshold: 0.7, on: true } };
  assert.equal(moveDecision({ check: { ...clean, gates_red: ['lint'] }, visual: true, compare: [row('after')], jev: glowing }).keep, false);
  assert.equal(moveDecision({ check: clean, visual: true, compare: [row('before')], jev: glowing }).keep, false);
});

// ---------------------------------------------------------------- scores
const scores = (over = {}) => Object.fromEntries(HEURISTICS.map((h, i) => [h.id, over[h.id] ?? 3]));

test('scores: all ten needed, 0 to 4 or n/a, and n/a lowers the maximum', () => {
  assert.deepEqual(parseScores(scores()), { scores: scores(), total: 30, max: 40, na: [] });
  const withNa = parseScores(scores({ h7: 'n/a', h10: 'n/a' }));
  assert.deepEqual([withNa.total, withNa.max, withNa.na], [24, 32, ['h7', 'h10']]);
  const missing = scores();
  delete missing.h4;
  assert.throws(() => parseScores(missing), /h4/);
  assert.throws(() => parseScores(scores({ h2: 5 })), /h2/);
  assert.throws(() => parseScores(scores({ h2: 2.5 })), /h2/);
  assert.throws(() => parseScores(null), /scores/);
});

// ---------------------------------------------------------------- the run
const kept = (over = {}) => ({ id: 'm1', visual: true, decision: { keep: true, vetoed: false, unverified: false, same: [], reasons: [], ...over } });
const dropped = { id: 'm2', visual: true, decision: { keep: false, vetoed: true, unverified: false, same: [], reasons: ['gate_red: lint'] } };
const base = parseScores(scores());
const run = (over = {}) => ({ mode: 'rendered', moves: [kept()], baseline: base, final: parseScores(scores({ h1: 4 })), detector: { baseline: 3, final: 2 }, ...over });

test('every verdict', () => {
  assert.deepEqual(verdict(run()), { verdict: 'better', reasons: [] });
  assert.equal(verdict(run({ moves: [dropped] })).verdict, 'no_change');
  assert.equal(verdict(run({ moves: [] })).verdict, 'no_change');
  assert.equal(verdict(run({ mode: 'code_only' })).verdict, 'unverified');
  assert.equal(verdict(run({ final: null })).verdict, 'unverified');
  assert.equal(verdict(run({ moves: [kept({ unverified: true })] })).verdict, 'unverified');
  for (const v of ['better', 'mixed', 'unverified', 'no_change']) assert.ok(VERDICTS.includes(v));
});

test('mixed: a heuristic lower, the total lower, more detector findings, or no difference at a viewport', () => {
  const one = verdict(run({ final: parseScores(scores({ h1: 4, h3: 2 })) }));
  assert.equal(one.verdict, 'mixed');
  assert.match(one.reasons[0], /lower.*h3/i);
  assert.equal(verdict(run({ final: parseScores(scores({ h3: 1 })) })).verdict, 'mixed');
  assert.equal(verdict(run({ detector: { baseline: 3, final: 4 } })).verdict, 'mixed');
  assert.equal(verdict(run({ moves: [kept({ same: ['390x844'] })] })).verdict, 'mixed');
  // n/a on one side only is not a drop.
  assert.equal(verdict(run({ final: parseScores(scores({ h1: 4, h7: 'n/a' })) })).verdict, 'better');
});

test('a move without pictures does not make a run unverified when it had nothing to see', () => {
  assert.equal(verdict(run({ moves: [{ id: 'm1', visual: false, decision: { keep: true, vetoed: false, unverified: false, same: [], reasons: [] } }] })).verdict, 'better');
});

test('draft: ready only for better; unverified cannot be made ready; no_change opens nothing', () => {
  assert.equal(draftFor('better', 'auto'), false);
  assert.equal(draftFor('better', 'always'), true);
  assert.equal(draftFor('mixed', 'auto'), true);
  assert.equal(draftFor('mixed', 'never'), false);
  assert.equal(draftFor('unverified', 'never'), true);
  assert.equal(draftFor('no_change', 'never'), null);
});
