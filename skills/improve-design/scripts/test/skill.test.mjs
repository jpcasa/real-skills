// SKILL.md must name every command, veto, drop reason and verdict the harness
// has, and no write other than the ones the skill is allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const plugin = join(root, '../..');
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
const refs = ['setup', 'moves', 'compare'].map((r) => readFileSync(join(root, `references/${r}.md`), 'utf8'));
const { COMMANDS_CLI, VERDICTS, VETOES } = await import('../improve.mjs');
const { COMMANDS, REFINE, SHIFT } = await import('../lib/moves.mjs');
const Q = await import('../lib/questions.mjs');

test('frontmatter', () => {
  assert.match(skill, /^---\nname: improve-design\n/);
  assert.match(skill, /\nargument-hint: /);
  assert.match(skill, /\ndescription: /);
});

test('every command, veto, drop reason, verdict and Jev question is documented', () => {
  for (const c of COMMANDS_CLI) assert.ok(skill.includes(`\`${c}\``), `SKILL.md missing command ${c}`);
  for (const v of VETOES) assert.ok(skill.includes(`\`${v}\``), `SKILL.md missing veto ${v}`);
  for (const r of ['before_preferred', 'broke', 'no_visible_difference', 'issue_still_there']) assert.ok(skill.includes(`\`${r}\``), `SKILL.md missing drop reason ${r}`);
  for (const v of VERDICTS) assert.ok(skill.includes(`\`${v}\``), `SKILL.md missing verdict ${v}`);
  for (const q of Q.UNCALIBRATED) assert.ok(skill.includes(`\`${q}\``), `SKILL.md missing Jev question ${q}`);
  assert.match(skill, /logged and decides nothing/);
});

test('every impeccable command a move can run is in the moves reference, in its kind', () => {
  const moves = refs[1];
  for (const c of COMMANDS) assert.ok(moves.includes(`\`${c}\``), `moves.md missing ${c}`);
  const row = (kind) => moves.split('\n').find((l) => l.startsWith(`| \`${kind}\``));
  for (const c of REFINE) assert.ok(row('refine').includes(`\`${c}\``), `${c} is not in the refine row`);
  for (const c of SHIFT) assert.ok(row('shift').includes(`\`${c}\``), `${c} is not in the shift row`);
});

test('every reference the skill links to exists', () => {
  for (const [, path] of skill.matchAll(/\]\((references\/[^)#]+)\)/g)) assert.ok(existsSync(join(root, path)), `${path} is missing`);
  assert.ok(existsSync(join(root, 'references/report-style.md')));
});

test('the skill names no write beyond its own branch and its one pull request', () => {
  const all = [skill, ...refs].join('\n');
  for (const banned of [/gh pr (merge|review|comment|edit|close|ready|reopen)\b/, /gh issue \w+/, /git push[^\n`]*--force/, /git (merge|rebase|cherry-pick)\b/, /--approve\b/]) {
    assert.ok(!banned.test(all), `names a write it must not make: ${banned}`);
  }
  assert.match(skill, /never merges or approves, never pushes to a branch it did not create/);
  assert.match(skill, /A person reviews and merges the pull request/);
});

test('the agents the skill spawns exist, and the critic is read-only', () => {
  for (const [, agent] of skill.matchAll(/`real-skills:([a-z-]+)`/g)) assert.ok(existsSync(join(plugin, 'agents', `${agent}.md`)), `agents/${agent}.md is missing`);
  const critic = readFileSync(join(plugin, 'agents/design-critic.md'), 'utf8');
  const tools = critic.match(/^tools: (.*)$/m)[1].split(',').map((t) => t.trim());
  for (const t of ['Edit', 'Write', 'NotebookEdit', 'Agent']) assert.ok(!tools.includes(t), `design-critic has ${t}`);
  assert.ok(tools.includes('Skill'), 'it loads impeccable');
});

test('the example config is valid and uses only keys the loader reads', () => {
  const example = JSON.parse(readFileSync(join(root, 'config.example.json'), 'utf8'));
  const loader = readFileSync(join(root, 'scripts/lib/config.mjs'), 'utf8');
  for (const k of [...Object.keys(example), ...Object.keys(example.dev), ...Object.keys(example.pr)]) assert.ok(new RegExp(`\\b(raw|dev|raw\\.pr\\??)\\.${k}\\b`).test(loader), `config key ${k} is not read`);
});
