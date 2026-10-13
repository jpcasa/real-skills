// SKILL.md must name every command, class, repro shape, result, flag,
// verdict, gate, status, mode and argument the harness has; the example
// config must load; and nothing in the skill may overwrite a branch, write to
// GitHub beyond the one rerun, or tell the agent to write by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const skill = read('SKILL.md');
const fixing = read('references/fixing.md');
const docs = `${skill}\n${fixing}`;
const { COMMANDS, VERDICTS, MODES, ARG_FLAGS, GATES, STATUSES, CLASSES, REPRO, RESULTS, FLAGS } = await import('../fix.mjs');
const { loadConfig } = await import('../lib/config.mjs');
const Q = await import('../lib/questions.mjs');
const scripts = ['scripts/fix.mjs', ...readdirSync(join(root, 'scripts/lib')).filter((f) => f.endsWith('.mjs')).map((f) => `scripts/lib/${f}`)];

test('frontmatter', () => {
  assert.match(skill, /^---\nname: fix-ci\n/);
  assert.match(skill, /\nargument-hint: /);
  assert.match(skill, /\ndescription: /);
});

test('every command, class, repro shape, result, flag, verdict, gate, status, mode and argument is documented', () => {
  for (const group of [COMMANDS, CLASSES, REPRO, RESULTS, FLAGS, VERDICTS, GATES, STATUSES, MODES, ARG_FLAGS]) for (const x of group) assert.ok(skill.includes(`\`${x}\``), `SKILL.md missing ${x}`);
  // Each has a row of its own in a table.
  for (const x of [...CLASSES, ...REPRO, ...RESULTS, ...FLAGS, ...GATES]) assert.ok(skill.split('\n').some((l) => l.startsWith(`| \`${x}\` |`)), `no row for ${x}`);
  for (const f of ['test_edited', 'not_reproduced', 'differs', 'infra', 'config']) assert.ok(fixing.includes(`\`${f}\``), `fixing.md missing ${f}`);
});

test('the Jev section says what is asked, what is sent and that nothing decides', () => {
  assert.equal(Object.keys(Q.THRESHOLDS).length, 3);
  assert.deepEqual([...Q.UNCALIBRATED].sort(), Object.keys(Q.THRESHOLDS).sort());
  assert.deepEqual(Object.keys(Q.SHAPE).sort(), Object.keys(Q.THRESHOLDS).sort());
  assert.match(skill, /three questions/);
  assert.match(skill, /logged and decides nothing/);
  assert.match(skill, /never removes a failure, never answers a flag and never decides a push/);
  assert.match(skill, /Never the code, never the log/);
  assert.match(skill, /FIX_CI_JEV=off/);
});

test('every reference the skill links to exists', () => {
  const links = [...docs.matchAll(/\]\(((?:references\/)?[a-z.-]+\.(?:md|json))\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 3);
  for (const path of links) assert.ok(existsSync(join(root, path)), `${path} is missing`);
  assert.ok(existsSync(join(root, 'references/report-style.md')));
});

test('the skill says what it writes, that it runs the pull request\'s code, and when it must ask', () => {
  assert.match(skill, /It writes two things outside this machine, each after its own yes from the user/);
  assert.match(skill, /Reproducing a failure runs the pull request's code on this machine/);
  assert.match(skill, /a command that deploys, publishes or migrates never runs here at all/);
  assert.match(skill, /Never fetch a job log yourself/);
  assert.match(skill, /a yes to one push is not a yes to the next round's/);
  assert.match(skill, /Show the command in full and ask the user whether to run it/);
  assert.match(skill, /Stop and ask the user about that one/);
  assert.match(skill, /Never pick/);
  assert.match(skill, /say the fix was not proven here/);
  assert.match(skill, /Never say CI is green before `watch` says `green`/);
  assert.match(fixing, /Say the cause in one sentence before you edit/);
});

test('nothing can overwrite a branch, and no write is told to be done by hand', () => {
  for (const f of scripts) {
    const text = read(f);
    for (const banned of ['--force-with-lease', '--force-if-includes', '--mirror', '--no-verify', '--admin', "'-f'", '"-f"', "['rebase'", "['reset'", "['checkout'", "['commit'", "['stash'", "['branch'", "['cherry-pick'", "['pull'", "['am'", "['merge'", 'gh pr merge', 'gh pr comment', 'gh pr review', 'gh pr close', 'gh pr edit']) assert.ok(!text.includes(banned), `${f} contains ${banned}`);
    // The one --force in the scripts removes a worktree the run created.
    for (const line of text.split('\n').filter((l) => l.includes('--force'))) assert.match(line, /'worktree', 'remove', '--force'/, `${f}: ${line.trim()}`);
  }
  const git = read('scripts/lib/git.mjs');
  assert.equal(git.match(/'push'/g).length, 1);
  assert.match(git, /raw\(dir, \['push', '--quiet', remote, `\$\{sha\}:refs\/heads\/\$\{refName\(branch\)\}`\]\)/);
  // HEAD moves in one place, from the commit the fix was built on, after the push.
  assert.equal(git.match(/'update-ref'/g).length, 1);
  assert.match(git, /\['update-ref', '-m', 'fix-ci: pushed', 'HEAD', to, from\]/);
});

test('`gh` reads, and writes exactly one thing: the rerun of a job', () => {
  const gh = read('scripts/lib/github.mjs');
  const calls = [...gh.matchAll(/(?:tryJson|gh)\(repo, \['(\w+)'(?:, '(\w+)')?/g)].map((m) => [m[1], m[2]].filter(Boolean).join(' '));
  assert.deepEqual([...new Set(calls)].sort(), ['api', 'pr list', 'pr view', 'repo view', 'run rerun']);
  assert.ok(!/--method|-X |-f |--field|--raw-field|--input/.test(gh), 'no api call that writes');
  assert.equal(gh.match(/'rerun'/g).length, 1);
  // The harness asks for the yes before it calls it.
  const harness = read('scripts/fix.mjs');
  assert.equal(harness.match(/GH\.rerunJob\(/g).length, 1);
  assert.ok(harness.indexOf("a.confirmed !== true) return refuse('needs --confirmed: the user\\'s yes to this rerun") < harness.indexOf('GH.rerunJob('));
  assert.ok(harness.indexOf("a.confirmed !== true) return refuse('needs --confirmed: the user\\'s yes to this push") < harness.indexOf('G.pushCommit('));
});

test('in the docs, a git write is spelled only in the rule that forbids running it', () => {
  for (const m of docs.matchAll(/git (add|commit|merge|rebase|checkout|reset|stash|push|pull)\b/g)) {
    const line = docs.slice(docs.lastIndexOf('\n', m.index) + 1, docs.indexOf('\n', m.index));
    assert.match(line, /Never run|`git pull`/, `names "${m[0]}" outside the rule that forbids it: ${line.slice(0, 80)}`);
  }
  for (const banned of [/gh pr (merge|review|comment|edit|close|ready|reopen|create)\b/, /gh issue \w+/, /gh run (view|rerun|watch)\b/]) assert.ok(!banned.test(docs), `names a command the agent must not run: ${banned}`);
});

test('the example config loads, and uses only keys the loader reads', () => {
  const example = JSON.parse(read('config.example.json'));
  const loader = read('scripts/lib/config.mjs');
  for (const k of Object.keys(example)) assert.ok(loader.includes(`'${k}'`), `config key ${k} is not read`);
  const repo = mkdtempSync(join(tmpdir(), 'ci-example-'));
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.claude/fix-ci.json'), JSON.stringify(example));
  const { config } = loadConfig(repo);
  assert.equal(config.install, example.install);
  assert.deepEqual(config.repro, example.repro);
  assert.deepEqual(config.ignore, example.ignore);
  assert.deepEqual(config.check_config, example.check_config);
  assert.deepEqual([config.max_rounds, config.max_files, config.max_lines, config.gate_timeout_s, config.watch_timeout_s], [3, 10, 300, 900, 2700]);
  assert.equal(config.jev, 'shadow');
});
