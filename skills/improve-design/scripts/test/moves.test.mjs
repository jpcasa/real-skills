import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMoves, COMMANDS, kindOf, REFINE, SHIFT } from '../lib/moves.mjs';

const issue = (id, over = {}) => ({ id, severity: 'P2', element: `el-${id}`, problem: `problem ${id}`, fix: `fix ${id}`, command: 'polish', source: 'critique', files: ['src/a.tsx'], visual: true, ...over });

test('every command is refine or shift, and nothing is both', () => {
  assert.equal(COMMANDS.length, REFINE.length + SHIFT.length);
  for (const c of COMMANDS) assert.ok(['refine', 'shift'].includes(kindOf(c)));
  assert.equal(kindOf('bolder'), 'shift');
  assert.equal(kindOf('layout'), 'refine');
  assert.equal(kindOf('critique'), null);
});

test('ranking: severity first, then detector-backed, then audit, then the rest', () => {
  const { moves } = buildMoves([
    issue('a', { severity: 'P3' }),
    issue('b', { severity: 'P1', source: 'critique' }),
    issue('c', { severity: 'P1', source: 'detector' }),
    issue('d', { severity: 'P1', source: 'audit' }),
    issue('e', { severity: 'P0' }),
  ]);
  assert.deepEqual(moves.map((m) => m.issues[0]), ['e', 'c', 'd', 'b', 'a']);
  assert.deepEqual(moves.map((m) => m.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
});

test('two issues on one element and command become one move', () => {
  const { moves } = buildMoves([
    issue('a', { element: 'Save button', severity: 'P2', files: ['src/a.tsx'] }),
    issue('b', { element: 'save button ', severity: 'P1', source: 'detector', files: ['src/b.tsx'], visual: false }),
    issue('c', { element: 'Save button', command: 'clarify' }),
  ]);
  assert.equal(moves.length, 2);
  const merged = moves.find((m) => m.command === 'polish');
  assert.deepEqual(merged.issues, ['a', 'b']);
  assert.equal(merged.severity, 'P1');
  assert.equal(merged.source, 'detector');
  assert.deepEqual(merged.files, ['src/a.tsx', 'src/b.tsx']);
  assert.equal(merged.visual, true);
});

test('cut at maxMoves keeps the best ranked and says what was cut', () => {
  const { moves, cut } = buildMoves([issue('a', { severity: 'P3' }), issue('b', { severity: 'P0' }), issue('c', { severity: 'P1' })], { maxMoves: 2 });
  assert.deepEqual(moves.map((m) => m.issues[0]), ['b', 'c']);
  assert.deepEqual(cut.map((m) => [m.issues[0], m.why]), [['a', 'over the limit of 2 moves']]);
});

test('refine moves run before shift moves, whatever their severity', () => {
  const { moves } = buildMoves([issue('a', { severity: 'P0', command: 'bolder' }), issue('b', { severity: 'P3', command: 'layout' })]);
  assert.deepEqual(moves.map((m) => m.command), ['layout', 'bolder']);
});

test('a shift is listed but not preselected; under auto it is skipped with a reason', () => {
  const issues = [issue('a', { command: 'colorize' }), issue('b')];
  const asked = buildMoves(issues).moves;
  assert.deepEqual(asked.map((m) => [m.kind, m.selected]), [['refine', true], ['shift', false]]);
  assert.equal(asked[1].skipped, undefined);
  const auto = buildMoves(issues, { auto: true }).moves;
  assert.equal(auto[1].selected, false);
  assert.match(auto[1].skipped, /direction/);
});

test('--direction forces a move in, selected, and it is never cut', () => {
  const { moves } = buildMoves([issue('a', { severity: 'P0' }), issue('b', { severity: 'P0' })], { direction: 'bolder', maxMoves: 2, auto: true });
  const forced = moves.find((m) => m.command === 'bolder');
  assert.ok(forced.forced && forced.selected);
  assert.equal(moves.length, 2);
  // An issue that already asks for that command is the forced one.
  const again = buildMoves([issue('a', { command: 'bolder' })], { direction: 'bolder' }).moves;
  assert.equal(again.length, 1);
  assert.ok(again[0].forced && again[0].selected);
  assert.throws(() => buildMoves([], { direction: 'critique' }), /not a command/);
});

test('an issue with an unknown command, severity or no element is refused, not guessed at', () => {
  const { moves, refused } = buildMoves([issue('a', { command: 'redesign' }), issue('b', { severity: 'high' }), issue('c', { element: ' ' }), issue('d')]);
  assert.deepEqual(moves.map((m) => m.issues[0]), ['d']);
  assert.deepEqual(refused.map((r) => r.issue), ['a', 'b', 'c']);
  assert.match(refused[0].why, /redesign/);
});

test('an alternative command is kept only when it is a different known command', () => {
  const { moves } = buildMoves([issue('a', { alt: 'layout' }), issue('b', { alt: 'polish' }), issue('c', { alt: 'nonsense' })]);
  assert.deepEqual(moves.map((m) => m.alt), ['layout', null, null]);
});
