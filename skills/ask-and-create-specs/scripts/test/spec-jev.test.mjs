import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAP, SECTIONS, T, gate, lint, lintStructure, parseSpec, shape, triage } from '../spec-jev.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '../spec-jev.mjs');

// Fake Jev: score(id) -> probability; every question must be a well-formed noul.
const jev = (score) => async ({ questions }) => {
  const answers = {};
  for (const [id, q] of Object.entries(questions)) {
    assert.equal(q.type, 'noul');
    assert.ok(q.instructions && q.criteria.true && q.criteria.false, `${id} incomplete`);
    answers[id] = { type: 'noul', noul: score(id) };
  }
  return { answers, degraded: false };
};
const down = async () => ({ answers: {}, degraded: true, error: 'HTTP 529' });

const BRIEF = {
  goal: 'Export invoices as CSV from the billing page',
  done_when: ['`pnpm test export` passes'],
  decisions: ['Stream rows, no temp file'],
  assumed: [],
  out_of_scope: ['PDF export'],
  seam: '`exportInvoices()` · src/billing/export.test.ts',
};

const SPEC = `# Invoice CSV export

Goal: Export invoices as CSV from billing page.

## Done when
- [ ] \`pnpm test export\` passes
- [ ] Download has one row per invoice

## Decisions
- Stream rows — no temp file

## Out of scope
- PDF export

## Seam
- \`exportInvoices()\` · src/billing/export.test.ts
`;

test('triage: drop, assume, ask', async () => {
  const scores = {
    matters__0: 0.1, user_call__0: 0.9, risky__0: 0.9, // does not matter -> drop wins
    matters__1: 0.8, user_call__1: 0.2, risky__1: 0.1, // matters, cheap, derivable -> assume
    matters__2: 0.8, user_call__2: 0.7, risky__2: 0.1, // requester's call -> ask
    matters__3: 0.8, user_call__3: 0.1, risky__3: 0.6, // expensive if wrong -> ask
  };
  const r = await triage(
    { goal: 'g', known: ['k'], questions: ['a', 'b', 'c', 'd'].map((id) => ({ id, question: `${id}?`, recommended: 'r' })) },
    jev((id) => scores[id]),
  );
  assert.deepEqual(r.verdicts.map((v) => [v.id, v.verdict]), [['a', 'drop'], ['b', 'assume'], ['c', 'ask'], ['d', 'ask']]);
});

test('triage: degraded returns no verdicts; empty input skips Jev', async () => {
  assert.deepEqual(await triage({ questions: [{ id: 'a', question: 'a?' }] }, down), { degraded: true, error: 'HTTP 529', verdicts: [] });
  assert.deepEqual(await triage({ questions: [] }, () => assert.fail('called')), { degraded: false, verdicts: [] });
});

test('gate: empty fields fail without calling Jev', async () => {
  const r = await gate({ goal: 'g', done_when: [], out_of_scope: [' '], seam: '' }, () => assert.fail('called'));
  assert.deepEqual(r, { degraded: false, stop: false, missing: ['done_when', 'out_of_scope', 'seam'] });
});

test('gate: stops only when every check passes and no fork is open', async () => {
  assert.equal((await gate(BRIEF, jev((id) => (id === 'open_fork' ? 0.1 : 0.9)))).stop, true);
  const fork = await gate(BRIEF, jev(() => 0.9));
  assert.deepEqual([fork.stop, fork.missing], [false, ['open_fork']]);
  const seam = await gate(BRIEF, jev((id) => (id === 'seam' ? 0.2 : id === 'open_fork' ? 0.1 : 0.9)));
  assert.deepEqual([seam.stop, seam.missing], [false, ['seam']]);
});

test('gate: degraded never stops', async () => {
  const r = await gate(BRIEF, down);
  assert.deepEqual([r.degraded, r.stop], [true, false]);
});

test('shape: sliced needs separable and large; sections by threshold', async () => {
  const s = await shape(BRIEF, jev((id) => ({ separable: 0.9, large: 0.8, section__Data: 0.7, section__Risks: T.section }[id] ?? 0.1)));
  assert.deepEqual([s.shape, s.sections], ['sliced', ['Data', 'Risks']]);
  const one = await shape(BRIEF, jev((id) => (id === 'separable' ? 0.9 : 0.1)));
  assert.deepEqual([one.shape, one.sections], ['single', []]);
  assert.deepEqual(await shape(BRIEF, down), { degraded: true, error: 'HTTP 529', shape: 'single', sections: [] });
});

test('lint: clean spec passes structure', () => {
  assert.deepEqual(lintStructure(parseSpec(SPEC)), []);
});

test('lint: structure problems', () => {
  const long = `- ${'x'.repeat(220)}`;
  const bad = `# T\n\n## Done when\n- passes\n\n## Decisions\n\n## Seam\n${long}\n${'- a\n'.repeat(CAP)}`;
  const rules = lintStructure(parseSpec(bad)).map((x) => x.rule);
  for (const r of ['over_cap', 'no_goal', 'missing_section', 'empty_section', 'long_line', 'not_checkbox']) assert.ok(rules.includes(r), r);
});

test('lint: index file needs Goal and Slices only', () => {
  const idx = parseSpec('# T\n\nGoal: g.\n\n## Slices\n- 01-a.md — a\n', 'docs/specs/x/README.md');
  assert.equal(idx.kind, 'index');
  assert.deepEqual(lintStructure(idx), []);
});

test('lint: Jev flags duplicate, dead and uncheckable lines by file line number', async () => {
  // body lines: 0,1 Done when (file lines 6,7) · 2 Decisions (10) · 3 Out of scope (13) · 4 Seam (16)
  const scores = { duplicate__2: 0.9, useful__2: 0.1, useful__3: 0.1, useful__4: 0.1, checkable__1: 0.2 }; // Seam (4) is exempt from dead_line
  const r = await lint([{ file: 'spec.md', text: SPEC }], jev((id) => scores[id] ?? (id.startsWith('duplicate') ? 0.1 : 0.9)));
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems.map((x) => [x.line, x.rule]), [[7, 'not_checkable'], [10, 'duplicate'], [13, 'dead_line']]);
});

test('lint: degraded keeps structure findings', async () => {
  const r = await lint([{ file: 'spec.md', text: '# T\n\nGoal: g.\n\n## Seam\n- x\n' }], down);
  assert.equal(r.degraded, true);
  assert.ok(r.problems.some((x) => x.rule === 'missing_section'));
});

test('lint: many lines are chunked across requests', async () => {
  let calls = 0;
  const base = jev((id) => (id.startsWith('duplicate') ? 0.1 : 0.9));
  const text = `# T\n\nGoal: g.\n\n## Done when\n${'- [ ] a\n'.repeat(30)}\n## Out of scope\n- b\n\n## Seam\n- c\n`;
  const r = await lint([{ file: 'spec.md', text }], (a) => (calls++, base(a)));
  assert.ok(calls > 1);
  assert.deepEqual(r.problems, []);
});

test('cli: lint runs without Jev; triage reads stdin', () => {
  const env = { ...process.env, ASK_SPECS_JEV: '0' };
  const f = join(mkdtempSync(join(tmpdir(), 'spec-')), 'spec.md');
  writeFileSync(f, SPEC);
  const l = JSON.parse(execFileSync('node', [CLI, 'lint', f], { env }));
  assert.deepEqual([l.degraded, l.ok], [true, true]);
  const t = JSON.parse(execFileSync('node', [CLI, 'triage'], { env, input: JSON.stringify({ goal: 'g', questions: [{ id: 'a', question: 'a?' }] }) }));
  assert.equal(t.degraded, true);
});

test('SKILL.md documents every verdict, rule, section and threshold-free fallback', () => {
  const skill = readFileSync(join(here, '../../SKILL.md'), 'utf8');
  const src = readFileSync(CLI, 'utf8');
  const rules = [...new Set([...src.matchAll(/add\((?:[a-z0-9.]+, )?'([a-z_]+)'/g)].map((m) => m[1]))];
  assert.ok(rules.length >= 9, `found ${rules.length} rules`);
  for (const w of ['ask', 'assume', 'drop', 'open_fork', 'ASK_SPECS_JEV=0', ...rules]) assert.ok(skill.includes(`\`${w}\``), `SKILL.md missing ${w}`);
  for (const s of Object.keys(SECTIONS)) assert.ok(skill.includes(`## ${s}`), `SKILL.md missing section ${s}`);
  assert.ok(skill.includes(`${CAP} non-blank lines`));
});
