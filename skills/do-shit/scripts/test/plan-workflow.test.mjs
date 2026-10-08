// plan_workflow: the plan-phase investigators as one `workflow` action plus
// record-batch, the per-leaf fallback to a plain spawn, and the script itself
// (run here against stubbed agent()/parallel()).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(here, '../harness.mjs');
const SCRIPT = join(here, '../../workflows/plan.js');
const tmp = mkdtempSync(join(tmpdir(), 'doshit-wf-'));
const jevStub = join(tmp, 'jev.json');
writeFileSync(jevStub, JSON.stringify({ 'needs_*': 0.1 }));
const env = { ...process.env, DO_SHIT_STATE_DIR: join(tmp, 'state'), DO_SHIT_JEV_STUB: jevStub };

function h(args, stdin = '') {
  const res = execFileSync('node', [HARNESS, ...args], { env, input: stdin, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  return JSON.parse(res.trim());
}
function newRepo(name, config) {
  const repo = join(tmp, name);
  mkdirSync(join(repo, '.claude'), { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 'Test User');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  if (config) writeFileSync(join(repo, '.claude/do-shit.json'), JSON.stringify(config));
  git('add', '.');
  git('commit', '-qm', 'init');
  return repo;
}
const leaf = (id) => ({ id, ref: `CU-${id}`, title: `Item ${id}`, body: 'b', leaf: true, acceptance_criteria: ['x'], status_type: 'open' });
const plan = (ref, file) => ({
  role: 'investigator', item: ref, loop: 1, verdict: 'pass', summary: 'ok', findings: [], files_touched: [], commits: [],
  plan: { premise_valid: true, summary: 'do it', files: [file], acceptance_criteria: ['x'], test_plan: ['unit'], depends_on: [] },
});
function start(repo, ids) {
  const { run_id: run } = h(['init', '--repo', repo, '--base', 'main', '--tracker', 'clickup', '--dry-run', '--verify', 'true'], JSON.stringify({ items: ids.map(leaf) }));
  const r = h(['next', '--run', run]);
  h(['record-tracker', '--run', run, '--key', 'tracker:in_progress'], JSON.stringify({ results: [] }));
  return { run, r };
}
const of = (r, action) => r.actions.filter((a) => a.action === action);

test('off by default: plain spawns', () => {
  const { r } = start(newRepo('off'), ['A', 'B']);
  assert.equal(of(r, 'spawn').length, 2);
  assert.equal(of(r, 'workflow').length, 0);
});

test('one fresh investigator is not worth a workflow', () => {
  const { r } = start(newRepo('single', { plan_workflow: true }), ['A']);
  assert.equal(of(r, 'spawn').length, 1);
  assert.equal(of(r, 'workflow').length, 0);
});

test('workflow action, record-batch, then the checkpoint', () => {
  const { run, r } = start(newRepo('on', { plan_workflow: true }), ['A', 'B']);
  assert.equal(of(r, 'spawn').length, 0);
  const [wf] = of(r, 'workflow');
  assert.ok(existsSync(wf.script_path));
  assert.equal(wf.args.run_id, run);
  assert.deepEqual(wf.args.agents.map((a) => a.leaf), ['A', 'B']);
  for (const a of wf.args.agents) {
    assert.equal(a.role, 'investigator');
    assert.match(a.agent_type, /investigator$/);
    assert.ok(existsSync(a.prompt_file));
  }
  assert.equal(r.spawns_used, 2);
  assert.equal(h(['next', '--run', run]).actions[0].action, 'wait');

  const [a, b] = wf.args.agents;
  const rec = h(['record-batch', '--run', run], JSON.stringify({
    run_id: run,
    results: [{ agent: a.name, leaf: 'A', report: plan('CU-A', 'src/a.ts') }, { agent: b.name, leaf: 'B', report: plan('CU-B', 'src/b.ts') }],
  }));
  assert.deepEqual(rec.recorded.map((x) => x.leaf), ['A', 'B']);
  assert.deepEqual(rec.fallback, []);

  const next = h(['next', '--run', run]);
  assert.equal(next.phase, 'checkpoint');
  assert.equal(next.actions[0].payload.leaves.length, 2);
  // Nothing is left to record a second time.
  assert.throws(() => h(['record-batch', '--run', run], JSON.stringify({ results: [] })));
});

test('a missing or invalid report falls back to a plain spawn for that leaf', () => {
  const { run, r } = start(newRepo('partial', { plan_workflow: true }), ['A', 'B', 'C']);
  const [a, b, c] = of(r, 'workflow')[0].args.agents;
  const rec = h(['record-batch', '--run', run], JSON.stringify({
    results: [
      { agent: a.name, leaf: 'A', report: plan('CU-A', 'src/a.ts') },
      { agent: b.name, leaf: 'B', report: null },
      { agent: c.name, leaf: 'C', report: { role: 'investigator' } },
    ],
  }));
  assert.deepEqual(rec.recorded.map((x) => x.leaf), ['A']);
  assert.deepEqual(rec.fallback.map((x) => x.leaf), ['B', 'C']);
  assert.match(rec.fallback[1].error, /required/);

  // Both failed leaves come back as plain spawns, never as a second workflow.
  const next = h(['next', '--run', run]);
  assert.equal(of(next, 'workflow').length, 0);
  assert.deepEqual(of(next, 'spawn').map((s) => [s.leaf, s.via]), [['B', 'new'], ['C', 'new']]);
  assert.equal(next.spawns_used, 3, 'the two failed workflow spawns were refunded');
  // The fallback spawn records the classic way.
  const sB = of(next, 'spawn')[0];
  const ok = h(['record', '--run', run, '--leaf', 'B', '--role', 'investigator', '--agent', sB.name], `\`\`\`json\n${JSON.stringify(plan('CU-B', 'src/b.ts'))}\n\`\`\``);
  assert.equal(ok.stored, 'plan');
});

test('a workflow that could not run: empty results send every leaf back to spawn', () => {
  const { run } = start(newRepo('declined', { plan_workflow: true }), ['A', 'B']);
  const rec = h(['record-batch', '--run', run], JSON.stringify({ results: [] }));
  assert.equal(rec.fallback.length, 2);
  const next = h(['next', '--run', run]);
  assert.equal(of(next, 'spawn').length, 2);
  assert.equal(next.spawns_used, 2);
});

test('reissue refunds a pending workflow and re-emits it', () => {
  const { run } = start(newRepo('reissue', { plan_workflow: true }), ['A', 'B']);
  h(['reissue', '--run', run]);
  const next = h(['next', '--run', run]);
  assert.equal(of(next, 'workflow').length, 1);
  assert.equal(next.spawns_used, 2);
});

// ---- the script, against stubs
const src = readFileSync(SCRIPT, 'utf8');
const AsyncFunction = (async () => {}).constructor;
function runScript(args, agentImpl) {
  const calls = [];
  const body = `${src.replace('export const meta', 'const meta')}`;
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', `${body}`);
  const agent = async (prompt, opts) => {
    calls.push({ prompt, opts });
    return agentImpl(prompt, opts);
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  return fn(args, agent, parallel, () => {}, () => {}).then((result) => ({ result, calls }));
}

test('script: meta is a pure literal and the first statement', () => {
  assert.match(src, /^export const meta = \{\n {2}name: 'do-shit-plan',/);
  assert.ok(!/\bimport\b|Date\.now|Math\.random|new Date\(\)/.test(src), 'no imports, clock or randomness in a workflow script');
});

test('script: one agent per leaf with its role agent and the report schema', async () => {
  const agents = [
    { role: 'investigator', agent_type: 'real-skills:investigator', name: 'inv-a', leaf: 'A', prompt_file: '/p/a.md' },
    { role: 'investigator', agent_type: 'acme-researcher', name: 'inv-b', leaf: 'B', prompt_file: '/p/b.md' },
  ];
  const { result, calls } = await runScript({ run_id: 'r1', agents }, (p) => (p.includes('/p/b.md') ? null : { role: 'investigator' }));
  assert.deepEqual(calls.map((c) => [c.opts.agentType, c.opts.label]), [['real-skills:investigator', 'inv-a'], ['acme-researcher', 'inv-b']]);
  assert.ok(calls[0].prompt.includes('/p/a.md'));
  assert.ok(calls[0].opts.schema.required.includes('plan'));
  assert.deepEqual(result, {
    run_id: 'r1',
    results: [
      { agent: 'inv-a', leaf: 'A', role: 'investigator', report: { role: 'investigator' } },
      { agent: 'inv-b', leaf: 'B', role: 'investigator', report: null },
    ],
  });
});

test('script: refuses to run without harness args', async () => {
  await assert.rejects(runScript(undefined, () => null), /harness/);
});

test('script: its schema copy matches report.schema.json', async () => {
  const { calls } = await runScript({ run_id: 'r', agents: [{ role: 'investigator', agent_type: 'x', name: 'n', leaf: 'A', prompt_file: '/p' }] }, () => null);
  const { $id, title, ...file } = JSON.parse(readFileSync(join(here, '../../schemas/report.schema.json'), 'utf8'));
  const { required, ...copy } = calls[0].opts.schema;
  assert.deepEqual(required, [...file.required, 'plan']);
  delete file.required;
  assert.deepEqual(copy, file);
});
