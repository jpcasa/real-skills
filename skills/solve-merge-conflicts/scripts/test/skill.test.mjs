// SKILL.md must name every command, class, kind, verdict, gate, status, mode
// and flag the harness has; the example config must load; and nothing in the
// skill may overwrite a branch or tell the agent to write by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const skill = read('SKILL.md');
const resolving = read('references/resolving.md');
const { COMMANDS, VERDICTS, MODES, FLAGS, GATES, STATUSES, CLASSES, KINDS } = await import('../solve.mjs');
const { ALL_KINDS, LOCKFILES } = await import('../lib/classes.mjs');
const { loadConfig } = await import('../lib/config.mjs');
const Q = await import('../lib/questions.mjs');
const scripts = ['scripts/solve.mjs', ...readdirSync(join(root, 'scripts/lib')).filter((f) => f.endsWith('.mjs')).map((f) => `scripts/lib/${f}`)];

test('frontmatter', () => {
  assert.match(skill, /^---\nname: solve-merge-conflicts\n/);
  assert.match(skill, /\nargument-hint: /);
  assert.match(skill, /\ndescription: /);
});

test('every command, class, kind, verdict, gate, status, mode and flag is documented', () => {
  for (const group of [COMMANDS, CLASSES, ALL_KINDS, VERDICTS, GATES, STATUSES, MODES, FLAGS]) for (const x of group) assert.ok(skill.includes(`\`${x}\``), `SKILL.md missing ${x}`);
  // Each class's row names the kinds it takes.
  for (const c of CLASSES) {
    const row = skill.split('\n').find((l) => l.startsWith(`| \`${c}\` |`));
    assert.ok(row, `no row for ${c}`);
    for (const k of KINDS[c]) assert.ok(row.includes(`\`${k}\``) || (c === 'lockfile' && k !== 'regenerate'), `the ${c} row does not name ${k}`);
  }
  for (const k of ['both', 'combined', 'pr', 'base', 'port']) assert.ok(resolving.includes(`\`${k}\``), `resolving.md missing ${k}`);
});

test('the Jev section says what is asked, what is sent and that nothing decides', () => {
  assert.equal(Object.keys(Q.THRESHOLDS).length, 3);
  assert.deepEqual([...Q.UNCALIBRATED].sort(), Object.keys(Q.THRESHOLDS).sort());
  assert.deepEqual(Object.keys(Q.SHAPE).sort(), Object.keys(Q.THRESHOLDS).sort());
  assert.match(skill, /three questions/);
  assert.match(skill, /logged and decides nothing/);
  assert.match(skill, /never resolves a hunk, never removes a question and never decides the push/);
  assert.match(skill, /Never the code/);
  assert.match(skill, /SOLVE_CONFLICTS_JEV=off/);
});

test('every reference the skill links to exists', () => {
  const links = [...`${skill}\n${resolving}`.matchAll(/\]\(((?:references\/)?[a-z.-]+\.(?:md|json))\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 3);
  for (const path of links) assert.ok(existsSync(join(root, path)), `${path} is missing`);
  assert.ok(existsSync(join(root, 'references/report-style.md')));
});

test('the skill says what it writes, that it runs the pull request\'s code, and when it must ask', () => {
  assert.match(skill, /It writes one thing outside this machine, after a yes from the user: that push/);
  assert.match(skill, /Running the repo's checks runs the pull request's code on this machine/);
  assert.match(skill, /Never edit a file that is in conflict/);
  assert.match(skill, /no yes to a resolution is a yes to the push/);
  assert.match(skill, /stop and ask the user about that one resolution/);
  assert.match(skill, /Never pick/);
  assert.match(skill, /say the result was not checked/);
  assert.match(skill, /never "mergeable" unless GitHub said so/);
});

test('nothing can overwrite a branch, and no write is told to be done by hand', () => {
  for (const f of scripts) {
    const text = read(f);
    for (const banned of ['--force-with-lease', '--force-if-includes', '--mirror', '--no-verify', '--admin', "'-f'", '"-f"', "['rebase'", "['reset'", "['checkout'", "['commit'", "['stash'", "['branch'", "['cherry-pick'", "['pull'", "['am'", 'gh pr merge', 'gh pr comment', 'gh pr review', 'gh pr close', 'gh pr edit']) assert.ok(!text.includes(banned), `${f} contains ${banned}`);
    // The one --force in the scripts removes a worktree the run created.
    for (const line of text.split('\n').filter((l) => l.includes('--force'))) assert.match(line, /'worktree', 'remove', '--force'|'update-index', '--force-remove'/, `${f}: ${line.trim()}`);
  }
  const git = read('scripts/lib/git.mjs');
  assert.equal(git.match(/'push'/g).length, 1);
  assert.match(git, /raw\(worktree, \['push', '--quiet', remote, `\$\{sha\}:refs\/heads\/\$\{refName\(branch\)\}`\]\)/);
  // `gh` only reads.
  const gh = read('scripts/lib/github.mjs');
  const calls = [...gh.matchAll(/(?:tryJson|gh)\(repo, \['(\w+)'(?:, '(\w+)')?/g)].map((m) => [m[1], m[2]].filter(Boolean).join(' '));
  assert.deepEqual([...new Set(calls)].sort(), ['api', 'pr list', 'pr view', 'repo view']);
  assert.ok(!/--method|-X |-f |--field/.test(gh));
  // In the docs, a git write is spelled only in the rule that forbids running it.
  for (const m of `${skill}\n${resolving}`.matchAll(/git (add|commit|merge|rebase|checkout|reset|push|pull)\b/g)) {
    const all = `${skill}\n${resolving}`;
    const line = all.slice(all.lastIndexOf('\n', m.index) + 1, all.indexOf('\n', m.index));
    assert.match(line, /Never run|`git pull`|one commit behind/, `names "${m[0]}" outside the rule that forbids it: ${line.slice(0, 80)}`);
  }
  for (const banned of [/gh pr (merge|review|comment|edit|close|ready|reopen|create)\b/, /gh issue \w+/]) assert.ok(!banned.test(`${skill}\n${resolving}`), `names a write: ${banned}`);
});

test('every package manager command in the lockfile table keeps install scripts off', () => {
  for (const [name, cmd] of Object.entries(LOCKFILES)) if (/^(npm|pnpm|yarn|bun) /.test(cmd)) assert.match(cmd, /--ignore-scripts/, name);
});

test('the example config loads, and uses only keys the loader reads', () => {
  const example = JSON.parse(read('config.example.json'));
  const loader = read('scripts/lib/config.mjs');
  for (const k of [...Object.keys(example), ...example.generated.flatMap((g) => Object.keys(g))]) assert.ok(loader.includes(`'${k}'`), `config key ${k} is not read`);
  const repo = mkdtempSync(join(tmpdir(), 'mc-example-'));
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.claude/solve-merge-conflicts.json'), JSON.stringify(example));
  const { config } = loadConfig(repo);
  assert.deepEqual(config.gates, example.gates);
  assert.equal(config.install, example.install);
  assert.deepEqual(config.generated, [{ glob: 'src/generated/**', command: 'pnpm codegen' }, { glob: '**/__snapshots__/**', command: null }]);
  assert.deepEqual(config.lockfiles, example.lockfiles);
  assert.equal(config.jev, 'shadow');
});
