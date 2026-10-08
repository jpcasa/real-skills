// The workflow script, run here against stubbed agent()/parallel()/pipeline().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../workflows/review.js'), 'utf8');
const AsyncFunction = (async () => {}).constructor;

function runScript(args, agentImpl) {
  const calls = [];
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', src.replace('export const meta', 'const meta'));
  const agent = async (prompt, opts) => {
    calls.push({ prompt, opts });
    return agentImpl(prompt, opts);
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  // Each item runs through every stage on its own; a throw drops the item to null.
  const pipeline = (items, ...stages) => Promise.all(items.map(async (item, i) => {
    let v = item;
    try {
      for (const s of stages) v = await s(v, item, i);
      return v;
    } catch {
      return null;
    }
  }));
  return fn(args, agent, parallel, pipeline, () => {}, () => {}).then((result) => ({ result, calls }));
}

const A = (pr, key) => ({ pr, lens: key.split('.')[0], key, name: `reviewer-${pr}-${key}`, agent_type: 'real-skills:reviewer', prompt_file: `/p/${pr}/${key}.md` });
const R = (pr) => ({ pr, name: `refuter-${pr}`, agent_type: 'real-skills:reviewer', prompt_file: `/p/${pr}/refuter.md` });
const finding = (severity) => ({ severity, file: 'a.ts', line: 3, quote: 'const a = 1;', problem: 'p', fix: 'f' });

test('meta is a pure literal and the first statement; no imports, clock or randomness', () => {
  assert.match(src, /^export const meta = \{\n {2}name: 'review-prs',/);
  assert.ok(!/\bimport\b|Date\.now|Math\.random|new Date\(\)/.test(src));
});

test('one agent per PR per lens; the refuter runs only for a PR with a bug', async () => {
  const agents = [A(7, 'correctness'), A(7, 'standards'), A(9, 'correctness.1'), A(9, 'correctness.2')];
  const { result, calls } = await runScript({ run_id: 'rp-1', agents, refuters: [R(7), R(9)] }, (prompt, opts) => {
    if (opts.phase === 'Refute') return { pr: 9, refutations: [{ id: 'correctness.2#1', refuted: false, reason: 'holds' }] };
    if (prompt.includes('/p/9/correctness.2.md')) return { pr: 9, lens: 'correctness', findings: [finding('nit'), finding('bug')] };
    if (prompt.includes('/p/7/standards.md')) return null;
    return { pr: 0, lens: 'correctness', findings: [finding('risk')] };
  });
  const review = calls.filter((c) => c.opts.phase === 'Review');
  assert.deepEqual(review.map((c) => c.opts.label).sort(), agents.map((a) => a.name).sort());
  for (const c of review) {
    assert.equal(c.opts.agentType, 'real-skills:reviewer');
    assert.deepEqual(c.opts.schema.required, ['pr', 'lens', 'findings']);
  }
  const refute = calls.filter((c) => c.opts.phase === 'Refute');
  assert.equal(refute.length, 1, 'PR 7 has no bug, so no refuter');
  assert.equal(refute[0].opts.label, 'refuter-9');
  assert.ok(refute[0].prompt.includes('/p/9/refuter.md'));
  // The bug keeps its index within its own report: the same id `record` gives it.
  assert.ok(refute[0].prompt.includes('"id": "correctness.2#1"'));
  assert.ok(!refute[0].prompt.includes('#0"'), 'the nit is not sent to the refuter');
  assert.deepEqual(refute[0].opts.schema.required, ['pr', 'refutations']);

  assert.equal(result.run_id, 'rp-1');
  assert.deepEqual(result.results.map((r) => [r.pr, r.key, r.report === null]).sort(), [[7, 'correctness', false], [7, 'standards', true], [9, 'correctness.1', false], [9, 'correctness.2', false]]);
  assert.deepEqual(result.refutations.map((r) => r.pr), [9]);
});

test('no refuters given: nothing is refuted', async () => {
  const { calls, result } = await runScript({ run_id: 'r', agents: [A(7, 'correctness')], refuters: [] }, () => ({ pr: 7, lens: 'correctness', findings: [finding('bug')] }));
  assert.equal(calls.length, 1);
  assert.deepEqual(result.refutations, []);
});

test('a refuter that returns nothing leaves no refutation, and the reviews survive', async () => {
  const { result } = await runScript({ run_id: 'r', agents: [A(7, 'correctness')], refuters: [R(7)] }, (p, o) => (o.phase === 'Refute' ? null : { pr: 7, lens: 'correctness', findings: [finding('bug')] }));
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.refutations, []);
});

test('refuses to run without the args from start', async () => {
  await assert.rejects(runScript(undefined, () => null), /review\.mjs start/);
});

test('its schema copies match the schema files', async () => {
  const { calls } = await runScript({ run_id: 'r', agents: [A(7, 'correctness')], refuters: [R(7)] }, (p, o) => (o.phase === 'Refute' ? null : { pr: 7, lens: 'correctness', findings: [finding('bug')] }));
  const file = (n) => JSON.parse(readFileSync(join(here, `../../schemas/${n}.schema.json`), 'utf8'));
  assert.deepEqual(calls[0].opts.schema, file('findings'));
  assert.deepEqual(calls[1].opts.schema, file('refutations'));
});
