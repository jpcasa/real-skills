// SKILL.md must name every command, gate, status, result, mode and flag the
// harness has; the example config must load; and nothing in the skill may
// carry a flag that skips a rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const skill = read('SKILL.md');
const setup = read('references/setup.md');
const { COMMANDS, RESULTS, MODES, FLAGS, HOW, MERGE_METHODS, VERIFY_KINDS } = await import('../promote.mjs');
const { GATES, STATUSES, VERDICT_STATUS } = await import('../lib/gates.mjs');
const { loadConfig, commandRefusal } = await import('../lib/config.mjs');
const { THRESHOLDS } = await import('../lib/questions.mjs');

test('frontmatter', () => {
  assert.match(skill, /^---\nname: promote\n/);
  assert.match(skill, /\nargument-hint: /);
  assert.match(skill, /\ndescription: /);
});

test('every command, gate, status, result, mode, flag, way and merge method is documented', () => {
  for (const group of [COMMANDS, GATES, STATUSES, RESULTS, MODES, FLAGS, HOW, MERGE_METHODS, Object.keys(VERDICT_STATUS)]) for (const x of group) assert.ok(skill.includes(`\`${x}\``), `SKILL.md missing ${x}`);
  for (const x of [...HOW, ...MERGE_METHODS, ...VERIFY_KINDS]) assert.ok(setup.includes(`\`${x}\``), `setup.md missing ${x}`);
  for (const state of ['deploy_pending', 'deploy_green', 'deploy_failed', 'unknown', 'not_merged']) assert.ok(skill.includes(`\`${state}\``), `SKILL.md missing watch state ${state}`);
});

test('the Jev section says what is asked, what is sent and that nothing decides', () => {
  assert.equal(Object.keys(THRESHOLDS).length, 3);
  assert.match(skill, /three questions/);
  assert.match(skill, /logged and decides nothing/);
  assert.match(skill, /it decides no gate/);
  assert.match(skill, /PROMOTE_JEV=off/);
});

test('every reference the skill links to exists', () => {
  const links = [...`${skill}\n${setup}`.matchAll(/\]\(((?:references\/|\.\.\/)[^)#]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 2);
  for (const path of links) assert.ok(existsSync(join(root, path.startsWith('../') ? path.slice(3) : path)), `${path} is missing`);
});

test('the two approvals are separate, and both say production', () => {
  assert.match(skill, /It writes two things, each after its own yes from the user: one pull request, and one merge/);
  assert.match(skill, /A yes to opening is not a yes to merging/);
  assert.match(skill, /This is its own question: the answer to the first one does not count/);
  assert.match(skill, /Never say "deployed" from a green workflow/);
  assert.match(skill, /do not roll anything back yourself/);
});

test('no flag that skips a rule appears anywhere in the skill, and no write is told to be done by hand', () => {
  const files = ['SKILL.md', 'references/setup.md', 'config.example.json', ...readdirSync(join(root, 'scripts')).filter((f) => f.endsWith('.mjs')).map((f) => `scripts/${f}`), ...readdirSync(join(root, 'scripts/lib')).filter((f) => f.endsWith('.mjs')).map((f) => `scripts/lib/${f}`)];
  for (const f of files) for (const banned of ['--admin', '--auto', '--delete-branch', '--force', '--no-verify', 'rulesets/', 'branches/protection']) assert.ok(!read(f).includes(banned), `${f} contains ${banned}`);
  // The only place a write command is spelled out is the sentence that forbids running it.
  for (const m of skill.matchAll(/gh pr (create|merge)|git (push|merge)\b/g)) {
    const line = skill.slice(skill.lastIndexOf('\n', m.index) + 1, skill.indexOf('\n', m.index));
    assert.match(line, /Never run/, `SKILL.md names "${m[0]}" outside the rule that forbids it`);
  }
  for (const banned of [/\$H (deploy|rollback|migrate)\b/]) assert.ok(!banned.test(`${skill}\n${setup}`));
});

test('the example config loads, and uses only keys the loader reads', () => {
  const example = JSON.parse(read('config.example.json'));
  const loader = read('scripts/lib/config.mjs');
  for (const k of Object.keys(example)) assert.ok(loader.includes(`'${k}'`), `config key ${k} is not read`);
  for (const s of example.stages) for (const k of Object.keys(s)) assert.ok(loader.includes(`'${k}'`), `stage key ${k} is not read`);
  const repo = mkdtempSync(join(tmpdir(), 'pro-example-'));
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.claude/promote.json'), JSON.stringify(example));
  const l = loadConfig(repo);
  assert.equal(l.needs_setup, false);
  assert.deepEqual(l.config.stages.map((s) => s.how), HOW);
  assert.deepEqual(Object.keys(l.config.verify.production), VERIFY_KINDS);
  // Every write word the setup text lists is one the guard refuses, and the other way round.
  const listed = setup.match(/contains a write word \(([^)]+)\)/)[1].match(/`([a-z]+)`/g).map((w) => w.slice(1, -1));
  for (const w of listed) assert.match(commandRefusal(`tool ${w} x`), new RegExp(`contains "${w}"`));
  assert.ok(listed.length >= 15);
});
