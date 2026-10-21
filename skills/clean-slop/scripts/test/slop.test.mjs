import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
Object.assign(process.env, GIT_ENV);
process.env.CLEAN_SLOP_STATE_DIR = mkdtempSync(join(tmpdir(), 'slop-state-'));

const H = await import('../slop.mjs');
const { cutsOf } = await import('../lib/cuts.mjs');

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const write = (repo, file, content) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
};
const commitAll = (repo, msg) => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
};

const SLOP = `// Adds two numbers together.
export function add(a, b) {
  // Return the sum of a and b.
  const result = a + b;
  return result;
}

export function parse(raw) {
  if (typeof raw !== 'string') throw new Error('raw must be a string');
  return raw.trim();
}
`;
const CLEAN = `export const add = (a, b) => a + b;

export function parse(raw) {
  if (typeof raw !== 'string') throw new Error('raw must be a string');
  return raw.trim();
}
`;

// main: old.mjs + a gate that fails when any source says BROKEN. feat: adds src/math.mjs.
function repo(prefix = 'slop-') {
  const r = mkdtempSync(join(tmpdir(), prefix));
  git(r, 'init', '-q', '-b', 'main');
  write(r, '.gitignore', '.claude/\n');
  write(r, 'gate.mjs', "import { readFileSync, readdirSync } from 'node:fs';\nfor (const f of readdirSync('src')) if (readFileSync(`src/${f}`, 'utf8').includes('BROKEN')) process.exit(1);\n");
  write(r, 'src/old.mjs', '// Old code nobody on this branch touched.\nexport const old = 1;\n');
  write(r, '.claude/clean-slop.json', JSON.stringify({ gates: ['node gate.mjs'] }));
  commitAll(r, 'base');
  git(r, 'checkout', '-q', '-b', 'feat');
  write(r, 'src/math.mjs', SLOP);
  write(r, 'README.md', 'Run `node gate.mjs` first. See https://example.com.\n');
  commitAll(r, 'feat: math');
  return r;
}
const started = (r, ...args) => H.start({ repo: r, args: ['--base', 'main', ...args] });
const EDITS = [{ file: 'src/math.mjs', why: 'one-line add; narrating comments cut' }];

test('start: scope is what the branch added, with its lines; baseline gates run', () => {
  const r = repo();
  const s = started(r);
  assert.equal(s.verdict, 'ready', JSON.stringify(s));
  assert.deepEqual(s.files.map((f) => f.file).sort(), ['README.md', 'src/math.mjs']);
  assert.deepEqual(s.files.find((f) => f.file === 'src/math.mjs'), { file: 'src/math.mjs', kind: 'code', lines: [[1, 11]] });
  assert.equal(s.files.find((f) => f.file === 'README.md').kind, 'prose');
  assert.deepEqual(s.gates.results, [{ cmd: 'node gate.mjs', ok: true }]);
  assert.deepEqual(started(r, 'src').files.map((f) => f.file), ['src/math.mjs']);
  const all = started(r, '--all', 'src');
  assert.deepEqual(all.files.map((f) => [f.file, f.lines]), [['src/math.mjs', 'all'], ['src/old.mjs', 'all']]);
});

test('start: refuses --all without a path, the base branch, a dirty tree', () => {
  const r = repo();
  assert.match(started(r, '--all').error, /--all needs a path/);
  write(r, 'scratch.txt', 'x');
  assert.match(started(r).error, /uncommitted/);
  git(r, 'checkout', '-q', 'main');
  assert.match(started(r).error, /base branch/);
});

test('check + commit: green and unflagged commits the listed file only, never pushes', () => {
  const r = repo();
  const s = started(r);
  write(r, 'src/math.mjs', CLEAN);
  const c = H.check({ run: s.run_id, edits: EDITS });
  assert.equal(c.verdict, 'clean', JSON.stringify(c));
  assert.deepEqual(c.flags, []);
  assert.ok(c.delta.removed > c.delta.added);
  const m = H.commit({ run: s.run_id });
  assert.equal(m.verdict, 'committed', JSON.stringify(m));
  assert.equal(git(r, 'rev-parse', 'HEAD'), m.commit);
  assert.match(git(r, 'log', '-1', '--format=%s%n%b'), /^refactor: clean slop from 1 file\n[\s\S]*src\/math\.mjs: one-line add/);
  assert.equal(git(r, 'status', '--porcelain'), '');
  assert.match(H.commit({ run: s.run_id }).error, /already committed/);
});

test('check blocks an unlisted file, a file out of scope, and a moved HEAD', () => {
  const r = repo();
  const s = started(r);
  write(r, 'src/math.mjs', CLEAN);
  write(r, 'src/old.mjs', 'export const old = 1;\n');
  const c = H.check({ run: s.run_id, edits: EDITS });
  assert.equal(c.verdict, 'blocked');
  assert.deepEqual(c.unlisted, ['src/old.mjs']);
  assert.deepEqual(c.outside, ['src/old.mjs']);
  assert.match(H.commit({ run: s.run_id }).error, /blocked/);
  git(r, 'checkout', '-q', '--', 'src/old.mjs');
  git(r, 'commit', '-q', '--allow-empty', '-m', 'moved');
  assert.match(H.check({ run: s.run_id, edits: EDITS }).error, /HEAD moved/);
});

test('a gate green before and red after fails the check; commit refused', () => {
  const r = repo();
  const s = started(r);
  write(r, 'src/math.mjs', `${CLEAN}// BROKEN\n`);
  const c = H.check({ run: s.run_id, edits: EDITS });
  assert.equal(c.verdict, 'checks_failed');
  assert.deepEqual(c.gates.turned_red, ['node gate.mjs']);
  assert.match(H.commit({ run: s.run_id, confirmed: true }).error, /checks_failed/);
});

test('a cut past slop is asked: commit needs --confirmed, and a later edit needs a new check', () => {
  const r = repo();
  const s = started(r);
  write(r, 'src/math.mjs', 'export const add = (a, b) => a + b;\nexport const parse = (raw) => raw.trim();\n');
  write(r, 'README.md', 'Run the gate first.\n');
  const c = H.check({ run: s.run_id, edits: [...EDITS, { file: 'README.md', why: 'filler cut' }] });
  assert.equal(c.verdict, 'needs_decision');
  assert.deepEqual(c.flags.map((f) => f.id).sort(), ['doc_fact:README.md', 'never_cut:src/math.mjs']);
  assert.match(H.commit({ run: s.run_id }).error, /yes/);
  write(r, 'README.md', 'Run the gate.\n');
  assert.match(H.commit({ run: s.run_id, confirmed: true }).error, /changed since check/);
  H.check({ run: s.run_id, edits: [...EDITS, { file: 'README.md', why: 'filler cut' }] });
  assert.equal(H.commit({ run: s.run_id, confirmed: true }).verdict, 'committed');
});

test('no gate found: unverified, and commit needs --confirmed', () => {
  const r = repo();
  write(r, '.claude/clean-slop.json', '{}');
  const s = started(r);
  assert.deepEqual(s.gates.results, []);
  write(r, 'src/math.mjs', CLEAN);
  assert.equal(H.check({ run: s.run_id, edits: EDITS }).verdict, 'unverified');
  assert.match(H.commit({ run: s.run_id }).error, /yes/);
});

test('cutsOf: comments and moved lines are not cuts; growth is flagged', () => {
  const before = '// try the fast path first\nfunction f(x) {\n  if (!x) throw new Error("x");\n  return x;\n}\n';
  const after = 'function f(x) {\n  return x;\n}\n';
  const helper = 'export const need = (x) => {\n  if (!x) throw new Error("x");\n};\n';
  assert.deepEqual(cutsOf([{ file: 'a.js', before, after }]).flags.map((f) => f.flag), ['never_cut']);
  assert.deepEqual(cutsOf([{ file: 'a.js', before, after }, { file: 'need.js', before: null, after: helper }]).flags.map((f) => f.flag), ['grew']);
  const { added, removed } = cutsOf([{ file: 'a.js', before: '// try it\nx();\n', after: 'x();\n' }]);
  assert.deepEqual([added, removed], [0, 1]);
  assert.deepEqual(cutsOf([{ file: 'a.js', before: '// try it\nx();\n', after: 'x();\n' }]).flags, []);
});

test('SKILL.md documents every harness command', () => {
  const skill = readFileSync(new URL('../../SKILL.md', import.meta.url), 'utf8');
  for (const c of H.COMMANDS) assert.match(skill, new RegExp(`\`${c}\``), c);
});
