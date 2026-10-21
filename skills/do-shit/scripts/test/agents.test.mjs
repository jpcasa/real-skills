// Checks the 17 bundled /do-shit role agents. Zero deps: node --test agents.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/test -> scripts -> do-shit -> skills -> <root>
const AGENTS_DIR = process.env.DO_SHIT_AGENTS_DIR || join(HERE, '..', '..', '..', '..', 'agents');

const MODELS = {
  investigator: 'inherit', architect: 'inherit', worker: 'inherit', designer: 'inherit',
  'data-engineer': 'inherit', 'security-advisor': 'inherit', integrator: 'inherit',
  'content-creator': 'sonnet', 'observability-engineer': 'sonnet', 'docs-writer': 'sonnet',
  'test-engineer': 'sonnet', tester: 'sonnet', auditor: 'sonnet', 'accessibility-auditor': 'sonnet',
  'performance-engineer': 'sonnet', 'qa-planner': 'sonnet', 'qa-tester': 'sonnet',
};
const STAGES = {
  investigator: 'plan', architect: 'plan',
  'data-engineer': 'build', worker: 'build', designer: 'build', 'content-creator': 'build',
  'observability-engineer': 'build', 'docs-writer': 'build', 'test-engineer': 'build',
  tester: 'review', auditor: 'review', 'security-advisor': 'review',
  'accessibility-auditor': 'review', 'performance-engineer': 'review',
  integrator: 'merge', 'qa-planner': 'qa', 'qa-tester': 'qa',
};
const ROLES = Object.keys(MODELS);
const NO_WRITE = ['investigator', 'architect', 'auditor', 'security-advisor', 'accessibility-auditor',
  'performance-engineer', 'qa-planner', 'tester', 'qa-tester'];
const SCOPED = ['data-engineer', 'worker', 'designer', 'content-creator', 'observability-engineer',
  'docs-writer', 'test-engineer', 'integrator'];
const REPORT_REQUIRED = ['role', 'item', 'loop', 'verdict', 'summary', 'findings', 'files_touched', 'commits'];

function parse(role) {
  const text = readFileSync(join(AGENTS_DIR, `${role}.md`), 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `${role}: frontmatter block missing`);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(': ');
    if (i <= 0) continue;
    fm[line.slice(0, i).trim()] = line.slice(i + 2).trim();
  }
  const tools = (fm.tools || '').split(',').map((t) => t.trim()).filter(Boolean);
  return { fm, tools, body: m[2] };
}

test('ROLES covers 17 agents', () => assert.equal(ROLES.length, 17));

for (const role of ROLES) {
  test(`${role}: file exists`, () => assert.ok(existsSync(join(AGENTS_DIR, `${role}.md`))));

  test(`${role}: frontmatter`, () => {
    const { fm, tools } = parse(role);
    assert.equal(fm.name, role);
    assert.ok(fm.description && fm.description.length > 40, 'description');
    assert.equal(fm.model, MODELS[role]);
    assert.equal(fm.stage, STAGES[role]);
    assert.ok(tools.length > 0, 'tools');
    for (const t of ['Read', 'Grep', 'Glob', 'Bash']) assert.ok(tools.includes(t), `missing ${t}`);
  });

  test(`${role}: tool and scope rules`, () => {
    const { fm, tools } = parse(role);
    if (NO_WRITE.includes(role)) {
      assert.ok(!tools.includes('Edit') && !tools.includes('Write'), 'read-only role has Edit/Write');
      assert.equal(fm.allowed_paths, undefined, 'read-only role must not declare allowed_paths');
    }
    if (SCOPED.includes(role)) {
      assert.ok(tools.includes('Edit') && tools.includes('Write'), 'build role lacks Edit/Write');
      const paths = JSON.parse(fm.allowed_paths);
      assert.ok(Array.isArray(paths) && paths.length > 0, 'allowed_paths empty');
      for (const p of paths) assert.equal(typeof p, 'string');
    }
  });

  test(`${role}: body contract`, () => {
    const { body } = parse(role);
    for (const s of ['## Boundaries', '## Report', '```json', 'git push', 'stash']) {
      assert.ok(body.includes(s), `body missing ${s}`);
    }
    for (const s of [/tracker/i, /spawn subagents/i, /worktree/i]) assert.match(body, s);
  });

  test(`${role}: report example is valid JSON for this role`, () => {
    const { body } = parse(role);
    const blocks = [...body.matchAll(/```json\n([\s\S]*?)\n```/g)];
    assert.ok(blocks.length >= 1, 'no json example');
    const ex = JSON.parse(blocks.at(-1)[1]);
    for (const k of REPORT_REQUIRED) assert.ok(k in ex, `example missing ${k}`);
    assert.equal(ex.role, role);
    for (const f of ex.findings) {
      for (const k of ['severity', 'blocking', 'owner_role', 'text']) assert.ok(k in f, `finding missing ${k}`);
      assert.ok(ROLES.includes(f.owner_role), `unknown owner_role ${f.owner_role}`);
    }
  });
}

test('qa-tester has browser pane tools', () => {
  assert.ok(parse('qa-tester').tools.includes('mcp__Claude_Browser__computer'));
});
test('designer invokes impeccable', () => {
  const { body, tools } = parse('designer');
  assert.match(body, /impeccable/);
  assert.ok(tools.includes('Skill'));
});
test('integrator loads resolving-merge-conflicts', () => {
  const { body, tools } = parse('integrator');
  assert.match(body, /resolving-merge-conflicts/);
  assert.ok(tools.includes('Skill'));
});
test('security-advisor requires full prose', () => {
  assert.match(parse('security-advisor').body, /full prose/i);
});
test('investigator and architect may WebFetch', () => {
  for (const r of ['investigator', 'architect']) assert.ok(parse(r).tools.includes('WebFetch'), r);
});

// Roles that write or plan code carry the code-style rule's agent block verbatim.
const CODE_ROLES = ['worker', 'data-engineer', 'test-engineer', 'integrator', 'designer', 'observability-engineer', 'investigator', 'architect'];
test('code roles carry the code-style agent block verbatim', () => {
  const rule = readFileSync(join(HERE, '..', '..', 'references', 'code-style.md'), 'utf8');
  const block = rule.match(/<!-- agent-block -->\n([\s\S]*?)\n<!-- \/agent-block -->/)[1];
  for (const r of CODE_ROLES) assert.ok(parse(r).body.includes(`\n${block}\n`), `${r}: copy the agent block from skills/do-shit/references/code-style.md`);
});
