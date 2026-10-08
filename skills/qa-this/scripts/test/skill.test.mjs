// SKILL.md must name every command, method and status the harness has, and no
// tracker write other than the comment and the opt-in attachment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
const { COMMANDS, METHODS, STATUSES } = await import('../qa.mjs');
const { POST_MODES } = await import('../lib/config.mjs');
const { EXPECT_KEYS } = await import('../lib/runner.mjs');

test('frontmatter', () => {
  assert.match(skill, /^---\nname: qa-this\n/);
  assert.match(skill, /\nargument-hint: /);
  assert.match(skill, /\ndescription: /);
});

test('every command, method, status and expect key is documented', () => {
  for (const c of COMMANDS) assert.ok(skill.includes(`\`${c}\``), `SKILL.md missing command ${c}`);
  for (const m of METHODS) assert.ok(skill.includes(`\`${m}\``), `SKILL.md missing method ${m}`);
  for (const s of STATUSES) assert.ok(skill.includes(`\`${s}\``), `SKILL.md missing status ${s}`);
  for (const k of EXPECT_KEYS) assert.ok(skill.includes(`\`${k}\``), `SKILL.md missing expect key ${k}`);
  assert.ok(POST_MODES.every((m) => skill.includes(m)));
});

test('every reference the skill links to exists, and every tracker adapter has the three sections', () => {
  for (const [, path] of skill.matchAll(/\]\((references\/[^)#]+)\)/g)) assert.ok(existsSync(join(root, path)), `${path} is missing`);
  for (const f of readdirSync(join(root, 'references/trackers'))) {
    const text = readFileSync(join(root, 'references/trackers', f), 'utf8');
    for (const h of ['## Fetch', '## Comment', '## Attach']) assert.ok(text.includes(h), `${f} has no ${h}`);
  }
});

test('the skill and its adapters name no tracker write other than a comment and an attachment', () => {
  const all = [skill, ...readdirSync(join(root, 'references/trackers')).map((f) => readFileSync(join(root, 'references/trackers', f), 'utf8'))].join('\n');
  for (const banned of [/gh (issue|pr) (create|edit|close|reopen|merge|review|ready)\b/, /clickup_(update_task|create_task|add_tag|delete|move_task|merge_tasks)/, /LINEAR_(UPDATE|CREATE_LINEAR_ISSUE|DELETE)/, /status_write|create_child/]) {
    assert.ok(!banned.test(all), `names a write it must not make: ${banned}`);
  }
  assert.match(skill, /never creates a ticket or changes a status/);
});

test('the example config is valid and uses only keys the loader reads', async () => {
  const example = JSON.parse(readFileSync(join(root, 'config.example.json'), 'utf8'));
  const loader = readFileSync(join(root, 'scripts/lib/config.mjs'), 'utf8');
  for (const k of Object.keys(example)) assert.ok(loader.includes(`'${k}'`) || loader.includes(`${k}:`), `config key ${k} is not read`);
});
