// SKILL.md must name every command, mode, result and status the harness has,
// and no tracker write other than the comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
const { COMMANDS, FLOW_STATUSES, MODES, STEP_RESULTS } = await import('../uat.mjs');
const { POST_MODES } = await import('../lib/config.mjs');

test('frontmatter', () => {
  assert.match(skill, /^---\nname: lets-do-uat\n/);
  assert.match(skill, /\nargument-hint: /);
  assert.match(skill, /\ndescription: /);
});

test('every command, mode, step result and flow status is documented', () => {
  for (const c of COMMANDS) assert.ok(skill.includes(`\`${c}\``), `SKILL.md missing command ${c}`);
  for (const m of MODES) assert.ok(skill.includes(m), `SKILL.md missing mode ${m}`);
  for (const r of STEP_RESULTS) assert.ok(skill.includes(`\`${r}\``), `SKILL.md missing step result ${r}`);
  for (const s of FLOW_STATUSES) assert.ok(skill.includes(`\`${s}\``), `SKILL.md missing status ${s}`);
  assert.ok(POST_MODES.every((m) => skill.includes(m)));
});

test('every reference the skill links to exists, and every tracker adapter has its sections', () => {
  for (const [, path] of skill.matchAll(/\]\((references\/[^)#]+)\)/g)) assert.ok(existsSync(join(root, path)), `${path} is missing`);
  for (const f of readdirSync(join(root, 'references/trackers'))) {
    const text = readFileSync(join(root, 'references/trackers', f), 'utf8');
    for (const h of ['## Setup', '## Fetch', '## PRs', '## Comment']) assert.ok(text.includes(h), `${f} has no ${h}`);
  }
});

test('the skill and its adapters name no tracker write other than a comment, and never push', () => {
  const all = [skill, ...readdirSync(join(root, 'references')).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(root, 'references', f), 'utf8')), ...readdirSync(join(root, 'references/trackers')).map((f) => readFileSync(join(root, 'references/trackers', f), 'utf8'))].join('\n');
  for (const banned of [/gh (issue|pr) (create|edit|close|reopen|merge|review|ready)\b/, /clickup_(update_task|create_task|add_tag|delete|move_task|merge_tasks)/, /LINEAR_(UPDATE|CREATE_LINEAR_ISSUE|DELETE)/, /git push/]) {
    assert.ok(!banned.test(all), `names a write it must not make: ${banned}`);
  }
  assert.match(skill, /never pushes, never creates a ticket or changes a status, and agent mode never runs on production/);
});

test('the example config is valid and uses only keys the loader reads', () => {
  const example = JSON.parse(readFileSync(join(root, 'config.example.json'), 'utf8'));
  const loader = readFileSync(join(root, 'scripts/lib/config.mjs'), 'utf8');
  for (const k of Object.keys(example)) assert.ok(loader.includes(`'${k}'`) || loader.includes(`${k}:`), `config key ${k} is not read`);
});
