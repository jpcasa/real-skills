import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, T, UNCALIBRATED, judge, lint, modeOf, takeCases } from '../plan.mjs';
import { MAX_TASKS, RULES, parseDoneWhen, parsePlan, splitFiles } from '../lib/rules.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'create-plan-'));
// Never this machine's real calibration file or state folder.
process.env.REAL_SKILLS_CALIBRATION_DIR = join(tmp, 'calibration');
process.env.CREATE_PLAN_STATE_DIR = join(tmp, 'state');
delete process.env.REAL_SKILLS_CALIBRATION;
const ALL = Object.keys(T).join(',');
const LIVE = { mode: 'live' };

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '../plan.mjs');

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

const SPEC = `# Export

Goal: CSV export.

## Done when
- [ ] \`pnpm test export\` passes
- [ ] Button on billing page

## Seam
- \`exportInvoices()\` · src/export.test.ts
`;

const task = (n, { files = `src/t${n}.ts`, covers = 'D1', parallel = 'no', review = 'no', extra = '' } = {}) => `### Task ${n}: thing ${n}
Files: ${files}
Covers: ${covers} · Parallel: ${parallel} · Review: ${review}
- [ ] Failing test: export returns rows
- [ ] Implement${extra}
- [ ] Run: \`pnpm test export\`
- [ ] Commit: \`feat: thing ${n}\`
`;

const PLAN = (tasks) => `# Export Plan

Spec: \`docs/specs/x.md\`
Goal: CSV export.
Verify: \`pnpm check\`

## File map
- \`src/export.ts\` — query

## Tasks

${tasks}
## Execution
In-thread.
`;

const GOOD = PLAN(task(1, { files: 'src/export.ts, src/export.test.ts', covers: 'D1' }) + '\n' + task(2, { files: 'src/{button,page}.tsx', covers: 'D2' }));

test('splitFiles: commas, braces, notes and backticks', () => {
  assert.deepEqual(splitFiles('`a/{b,c}.ts` (create), d.ts (modify)'), ['a/b.ts', 'a/c.ts', 'd.ts']);
  assert.deepEqual(splitFiles('—'), []);
});

test('parse: header, tasks, fields and steps', () => {
  const p = parsePlan(GOOD);
  assert.deepEqual(Object.keys(p.header), ['Spec', 'Goal', 'Verify']);
  assert.deepEqual(p.tasks.map((t) => [t.id, t.files.length, t.steps.length, t.fields.Review.value]), [[1, 2, 4, 'no'], [2, 2, 4, 'no']]);
  assert.deepEqual(parseDoneWhen(SPEC).length, 2);
});

test('lint: a good plan passes, with coverage per Done-when item', () => {
  const r = lint(GOOD, SPEC);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.coverage, { D1: [1], D2: [2] });
});

test('lint: every rule fires on its own fixture', () => {
  const rules = (text, spec = SPEC) => lint(text, spec).problems.map((x) => x.rule);
  assert.ok(rules('# P\n\n## Tasks\n' + task(1)).includes('missing_header'));
  assert.ok(rules(GOOD.replace('Verify: `pnpm check`', 'Verify: run the tests')).includes('missing_header'));
  assert.ok(rules(GOOD.replace('## Execution\nIn-thread.\n', '')).includes('missing_section'));
  assert.ok(rules(GOOD.replace('- [ ] Commit: `feat: thing 1`\n', '')).includes('missing_field'));
  assert.ok(rules(GOOD.replace('- [ ] Run: `pnpm test export`', '- [ ] Run: the tests')).includes('missing_field'));
  assert.ok(rules(PLAN(task(1, { covers: 'D1,D2', extra: ', add error handling' }))).includes('placeholder'));
  assert.ok(rules(PLAN(task(1, { covers: 'D1,D2', extra: ' TBD' }))).includes('placeholder'));
  const par = PLAN(task(1, { files: 'src/a.ts', parallel: 'yes', covers: 'D1' }) + task(2, { files: 'src/b.ts, src/a.ts', parallel: 'yes', covers: 'D2' }));
  assert.deepEqual(rules(par), ['parallel_overlap']);
  assert.deepEqual(rules(PLAN(task(1, { covers: 'D1' }))), ['uncovered']);
  assert.deepEqual(rules(PLAN(task(1, { covers: 'D1,D2,D3' }))), ['bad_covers']);
  assert.deepEqual(rules(PLAN(task(1, { files: 'db/migrations/002_add.sql', covers: 'D1,D2' }))), ['needs_review']);
  assert.deepEqual(rules(PLAN(task(1, { files: 'db/migrations/002_add.sql', covers: 'D1,D2', review: 'yes' }))), []);
  const many = PLAN(Array.from({ length: MAX_TASKS + 1 }, (_, i) => task(i + 1, { covers: 'D1,D2' })).join('\n'));
  assert.deepEqual(rules(many), ['over_cap']);
  assert.ok(rules(PLAN(task(1, { covers: 'D1,D2', extra: '\n- [ ] a\n- [ ] b\n- [ ] c' }))).includes('over_cap'));
});

test('lint: without a spec, coverage is not checked', () => {
  const r = lint(PLAN(task(1, { covers: 'D9' })));
  assert.equal(r.ok, true);
  assert.equal(r.coverage, undefined);
});

test('judge: Jev decides only live and calibrated; review rule is code and Jev may only add', async () => {
  process.env.CREATE_PLAN_TEST_CALIBRATED = ALL;
  try {
    const mig = PLAN(task(1, { files: 'db/migrations/002.sql', covers: 'D1,D2', review: 'yes' }) + task(2, { covers: 'D1' }));
    const low = await judge(mig, jev(() => 0.1), LIVE);
    assert.deepEqual(low.tasks.map((t) => [t.needs_review, t.too_big, t.vague_steps.length]), [[true, false, 0], [false, false, 0]]);
    assert.equal(low.by_hand, false);
    const high = await judge(mig, jev((id) => (id.startsWith('step_vague__1__1') ? 0.9 : id.startsWith('needs_review__1') ? 0.9 : 0.1)), LIVE);
    assert.deepEqual(high.tasks.map((t) => [t.needs_review, t.vague_steps.map((s) => s.text)]), [[true, []], [true, ['Implement']]]);
  } finally {
    delete process.env.CREATE_PLAN_TEST_CALIBRATED;
  }
});

test('judge: uncalibrated logs shadow only; degraded keeps the code rule', async () => {
  const mig = PLAN(task(1, { files: 'src/auth/login.ts', covers: 'D1' }));
  takeCases();
  const r = await judge(mig, jev(() => 0.9), LIVE);
  assert.equal(r.by_hand, true);
  assert.deepEqual([r.tasks[0].needs_review, r.tasks[0].too_big, r.tasks[0].vague_steps.length], [true, undefined, 0]);
  assert.deepEqual([r.tasks[0].shadow.task_too_big, r.tasks[0].shadow.vague_steps.length], [true, 4]);
  const cases = takeCases();
  assert.deepEqual([...new Set(cases.map((c) => c.question))].sort(), Object.keys(T).sort());
  assert.ok(cases.every((c) => c.skill === 'create-plan' && c.acted === false && c.ask.endsWith('?') && c.show));
  const off = await judge(mig, down, LIVE);
  assert.deepEqual([off.degraded, off.by_hand, off.tasks[0].needs_review], [true, true, true]);
});

test('modes and calibration sets', () => {
  assert.deepEqual([modeOf(undefined), modeOf('live'), modeOf('off'), modeOf('0')], ['shadow', 'live', 'off', 'off']);
  assert.deepEqual([...UNCALIBRATED].sort(), Object.keys(T).sort());
});

test('cli: lint reads the spec named in the header; judge degrades without Jev', () => {
  const dir = mkdtempSync(join(tmp, 'cli-'));
  writeFileSync(join(dir, 'spec.md'), SPEC);
  writeFileSync(join(dir, 'plan.md'), GOOD.replace('docs/specs/x.md', join(dir, 'spec.md')));
  const r = JSON.parse(execFileSync('node', [CLI, 'lint', join(dir, 'plan.md')], { encoding: 'utf8' }));
  assert.deepEqual([r.ok, r.coverage.D2], [true, [2]]);
  const j = JSON.parse(execFileSync('node', [CLI, 'judge', join(dir, 'plan.md')], { encoding: 'utf8', env: { ...process.env, CREATE_PLAN_JEV: 'off' } }));
  assert.deepEqual([j.mode, j.degraded, j.by_hand, j.tasks.length], ['off', true, true, 2]);
});

test('SKILL.md: model-invocable, ≤120 lines, documents every command, rule, question and mode', () => {
  const SKILL = readFileSync(join(here, '../../SKILL.md'), 'utf8');
  assert.match(SKILL, /^---\nname: create-plan\n/);
  assert.doesNotMatch(SKILL, /disable-model-invocation/);
  assert.ok(SKILL.split('\n').length <= 120, `${SKILL.split('\n').length} lines`);
  for (const w of [...COMMANDS, ...RULES, ...Object.keys(T), 'by_hand: true', 'CREATE_PLAN_JEV', 'Covers', 'Parallel', 'Review']) assert.ok(SKILL.includes(`\`${w}`), `SKILL.md missing ${w}`);
  assert.match(SKILL, /logged and decides nothing/);
});

test('review fixes: route groups, camelCase auth, todo paths, nested braces, ./ paths', () => {
  assert.deepEqual(splitFiles('`src/app/(auth)/reset/page.tsx` (create)'), ['src/app/(auth)/reset/page.tsx']);
  assert.deepEqual(splitFiles('src/{a,b}/{c,d}.ts'), ['src/a/c.ts', 'src/a/d.ts', 'src/b/c.ts', 'src/b/d.ts']);
  assert.deepEqual(splitFiles('./src/a.ts'), ['src/a.ts']);
  const rules = (text) => lint(text, SPEC).problems.map((x) => x.rule);
  for (const f of ['src/app/(auth)/reset/page.tsx', 'src/authMiddleware.ts', 'src/useAuth.ts', 'src/AuthProvider.tsx', 'src/policyService.ts', 'src/authorize.ts']) {
    assert.deepEqual(rules(PLAN(task(1, { files: f, covers: 'D1,D2' }))), ['needs_review'], f);
  }
  assert.deepEqual(rules(PLAN(task(1, { files: 'src/Author.tsx', covers: 'D1,D2' }))), []);
  assert.deepEqual(rules(PLAN(task(1, { files: 'src/features/todo/TodoList.tsx', covers: 'D1,D2' }))), []);
  const par = PLAN(task(1, { files: './src/a.ts', parallel: 'yes', covers: 'D1' }) + task(2, { files: 'src/a.ts', parallel: 'yes', covers: 'D2' }));
  assert.deepEqual(rules(par), ['parallel_overlap']);
  const groups = PLAN(task(1, { files: 'src/app/(shop)/page.tsx', parallel: 'yes', covers: 'D1' }) + task(2, { files: 'src/app/(marketing)/page.tsx', parallel: 'yes', covers: 'D2' }));
  assert.deepEqual(rules(groups), []);
});

test('review fixes: Covers ranges, D0, and a spec with no Done-when items', () => {
  const r = lint(PLAN(task(1, { covers: 'D1–D2' })), SPEC);
  assert.deepEqual([r.problems, r.coverage], [[], { D1: [1], D2: [1] }]);
  assert.deepEqual(lint(PLAN(task(1, { covers: 'D0,D1,D2' })), SPEC).problems.map((x) => x.rule), ['bad_covers']);
  assert.deepEqual(lint(PLAN(task(1, { covers: 'D1' })), '# S\n\nGoal: g.\n').problems.map((x) => x.rule), ['uncovered']);
});
