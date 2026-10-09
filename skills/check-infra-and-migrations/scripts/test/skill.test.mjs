// SKILL.md must name every command, verdict, severity and bucket the harness
// has; references/rules.md must name every rule; and neither may tell the
// agent to apply, deploy or merge anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const skill = read('SKILL.md');
const { COMMANDS, VERDICTS, SEVERITIES, BUCKETS, LIVE_KINDS } = await import('../check.mjs');
const { RULES } = await import('../lib/rules.mjs');
const { POST_MODES, APPLIED, loadConfig } = await import('../lib/config.mjs');
const { PHASES } = await import('../lib/runbook.mjs');
const { THRESHOLDS } = await import('../lib/questions.mjs');

test('frontmatter', () => {
  assert.match(skill, /^---\nname: check-infra-and-migrations\n/);
  assert.match(skill, /\nargument-hint: /);
  assert.match(skill, /\ndescription: /);
});

test('every command, verdict, severity, bucket, live read and phase is documented', () => {
  for (const group of [COMMANDS, VERDICTS, SEVERITIES, BUCKETS, LIVE_KINDS, PHASES]) for (const x of group) assert.ok(skill.includes(`\`${x}\``), `SKILL.md missing ${x}`);
  assert.ok(POST_MODES.every((m) => skill.includes(`post: ${m}`) || skill.includes(`\`post: ${m}\``)), 'post modes');
  const setup = read('references/setup.md');
  assert.ok(APPLIED.every((a) => setup.includes(`\`${a}\``)), 'setup names every `applied` value');
  assert.ok(LIVE_KINDS.every((k) => setup.includes(`\`${k}\``)));
});

test('every rule is in references/rules.md with its severity and sentence', async () => {
  const doc = read('references/rules.md');
  const { render } = await import('../gen-rules-doc.mjs');
  assert.equal(doc, render(), 'references/rules.md is stale: run scripts/gen-rules-doc.mjs');
  for (const [name, r] of Object.entries(RULES)) {
    const row = doc.split('\n').find((l) => l.startsWith(`| \`${name}\` |`));
    assert.ok(row, `rules.md missing ${name}`);
    assert.ok(row.includes(`| ${r.severity} |`), `${name}: severity`);
    assert.ok(row.toLowerCase().includes(r.says.toLowerCase()), `${name}: sentence drifted`);
  }
});

test('every Jev question is named in the README section the skill points users to, or in SKILL.md', () => {
  // The skill describes them in words; the catalog test pins the names.
  assert.equal(Object.keys(THRESHOLDS).length, 5);
  assert.match(skill, /five questions/);
  assert.match(skill, /can only make a verdict worse/);
});

test('every reference the skill links to exists', () => {
  const links = [...skill.matchAll(/\]\((references\/[^)#]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 3);
  for (const path of links) assert.ok(existsSync(join(root, path)), `${path} is missing`);
});

test('the skill never tells the agent to apply, deploy, merge or check out', () => {
  const all = [skill, read('references/setup.md'), read('references/what-to-check.md')].join('\n');
  for (const banned of [/gh pr (merge|review|ready|close|edit|checkout)\b/, /git (checkout|switch|push|merge|pull)\b(?! the change)/, /\$H (apply|deploy|migrate)\b/]) assert.ok(!banned.test(all), `names an action it must not take: ${banned}`);
  assert.match(skill, /never applies a migration, never deploys, merges, pushes or approves, never checks out the change/);
  assert.match(skill, /A person decides whether to push/);
});

test('the example config loads, and uses only keys the loader reads', () => {
  const example = JSON.parse(read('config.example.json'));
  const loader = read('scripts/lib/config.mjs');
  for (const k of Object.keys(example)) assert.ok(loader.includes(`'${k}'`), `config key ${k} is not read`);
  const repo = mkdtempSync(join(tmpdir(), 'cim-example-'));
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.claude/check-infra-and-migrations.json'), JSON.stringify(example));
  const l = loadConfig(repo);
  assert.equal(l.needs_setup, false);
  assert.deepEqual(Object.keys(l.config.live.staging), LIVE_KINDS);
});
