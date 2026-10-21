#!/usr/bin/env node
// /clean-slop harness. The agent finds the slop and edits it out; this script
// decides what is in scope, runs the repo's checks before and after, flags
// cuts that remove more than slop, and makes one local commit.
// Prints exactly ONE JSON object per call.
//
//   start   < {repo, args: [...]}                 scope (files and the lines the branch added), baseline checks
//   check   < {run, subject?, edits: [...]}       every change listed and in scope, checks still green, flags, the verdict
//   commit  --run <id> [--confirmed]              one commit of the checked files; --confirmed when check asked
//
// Nothing leaves this machine: no push, no pull request.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagsOf, isTest } from './lib/flags.mjs';
import { anyMatch, globMatch } from './lib/glob.mjs';
import { cutsOf } from './lib/cuts.mjs';

export const COMMANDS = ['start', 'check', 'commit'];
export const VERDICTS = ['nothing_to_clean', 'ready', 'nothing_changed', 'blocked', 'checks_failed', 'needs_decision', 'unverified', 'clean', 'committed'];
// shortcut: a fixed cap keeps the agent's reading bounded, pass paths to narrow a bigger branch.
const MAX_FILES = 40;
const NOT_SLOP = ['**/node_modules/**', '**/vendor/**', '**/dist/**', '**/build/**', '**/*.min.*', '**/*.lock', '**/package-lock.json', '**/pnpm-lock.yaml', '**/__snapshots__/**', '**/*.snap', '**/*.{png,jpg,jpeg,gif,webp,ico,svg,pdf,zip,woff,woff2,ttf}'];
const PROSE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;
// The other skills' check commands, first hit wins, so a repo that answered once is not asked again.
const GATE_SOURCES = [['clean-slop.json', 'gates'], ['solve-merge-conflicts.json', 'gates'], ['improve-design.json', 'gates'], ['do-shit.json', 'verify']];

// ---------------------------------------------------------------- git
// GIT_LITERAL_PATHSPECS: a path such as pages/[slug].tsx is that file, never a pattern.
const git = (repo, args) => execFileSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } }).toString().replace(/\n$/, '');
const tryGit = (repo, args) => {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
};
const lines = (s) => (s ? s.split('\n').filter(Boolean) : []);
// Tracked changes and untracked files, renames as delete + add.
const changedFiles = (repo) => [...new Set([...lines(git(repo, ['diff', '--name-only', '--no-renames', 'HEAD'])), ...lines(git(repo, ['ls-files', '--others', '--exclude-standard']))])].sort();
const atHead = (repo, file) => tryGit(repo, ['cat-file', '-p', `HEAD:${file}`]);
const onDisk = (repo, file) => (existsSync(join(repo, file)) ? readFileSync(join(repo, file), 'utf8') : null);
// What check saw: the diff and every untracked file, so commit can tell nothing moved since.
const workspaceHash = (repo) => {
  const h = createHash('sha1').update(git(repo, ['diff', '--binary', 'HEAD']));
  for (const f of lines(git(repo, ['ls-files', '--others', '--exclude-standard']))) h.update(`\0${f}\0`).update(onDisk(repo, f) ?? '');
  return h.digest('hex');
};

function baseRef(repo, given) {
  if (given) return given;
  const remoteHead = tryGit(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead) return remoteHead;
  return ['origin/main', 'origin/master', 'main', 'master'].find((b) => tryGit(repo, ['rev-parse', '--verify', '--quiet', `${b}^{commit}`]));
}

// Lines each file gained on the branch: `@@ -a,b +c,d @@` -> [c, c+d-1].
function addedRanges(repo, from, files) {
  const out = {};
  let file = null;
  for (const l of lines(git(repo, ['diff', '-U0', '--no-renames', from, 'HEAD', '--', ...files]))) {
    // git ends the header with a tab when the path has a space in it.
    if (l.startsWith('+++ ')) file = l.startsWith('+++ b/') ? l.slice(6).replace(/\t$/, '') : null;
    const m = file && l.match(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/);
    if (m && m[2] !== '0') (out[file] ||= []).push([+m[1], +m[1] + (m[2] === undefined ? 1 : +m[2]) - 1]);
  }
  return out;
}

// ---------------------------------------------------------------- config, state
const strings = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
export function loadConfig(repo) {
  const read = (name) => {
    const p = join(repo, '.claude', name);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      throw new Error(`.claude/${name} is not valid JSON: ${e.message}`);
    }
  };
  const own = read('clean-slop.json') || {};
  const hit = GATE_SOURCES.find(([file, key]) => strings(read(file)?.[key]).length);
  return {
    gates: hit ? strings(read(hit[0])[hit[1]]) : [],
    from: hit ? `.claude/${hit[0]}` : null,
    gate_timeout_s: Number.isInteger(own.gate_timeout_s) && own.gate_timeout_s > 0 ? own.gate_timeout_s : 900,
    ignore: strings(own.ignore),
  };
}

const stateRoot = () => process.env.CLEAN_SLOP_STATE_DIR || join(homedir(), '.claude/state/clean-slop');
const RUN_ID = /^slop-\d{8}-\d{4}-[0-9a-f]{4}$/;
const pad = (n) => String(n).padStart(2, '0');
function newRunId() {
  const d = new Date();
  for (;;) {
    const id = `slop-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${randomBytes(2).toString('hex')}`;
    if (!existsSync(join(stateRoot(), id))) return id;
  }
}
function saveRun(run) {
  const dir = join(stateRoot(), run.run_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json.tmp'), `${JSON.stringify(run, null, 2)}\n`);
  renameSync(join(dir, 'run.json.tmp'), join(dir, 'run.json'));
}
function loadRun(id) {
  const p = join(stateRoot(), String(id), 'run.json');
  if (!RUN_ID.test(String(id)) || !existsSync(p)) throw new Error(`unknown run ${id}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------- checks
// One check command through `sh -c`, output to a log in the run folder. It runs this repo's own code.
function gate(repo, cmd, timeoutS, log) {
  const fd = openSync(log, 'a');
  try {
    // NODE_TEST_CONTEXT: a `node --test` started from inside another one would report to a parent that is not its own.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    // detached: a timed-out command takes everything it started with it.
    const r = spawnSync('sh', ['-c', cmd], { cwd: repo, stdio: ['ignore', fd, fd], timeout: timeoutS * 1000, killSignal: 'SIGKILL', detached: true, env: { ...env, CI: '1' } });
    if ((r.error?.code === 'ETIMEDOUT' || r.signal) && r.pid) {
      try {
        process.kill(-r.pid, 'SIGKILL');
      } catch {}
    }
    return { cmd, ok: r.status === 0, log };
  } finally {
    closeSync(fd);
  }
}
function gates(run, phase) {
  const dir = join(stateRoot(), run.run_id, 'gates');
  mkdirSync(dir, { recursive: true });
  return run.config.gates.map((cmd, i) => gate(run.repo, cmd, run.config.gate_timeout_s, join(dir, `${i + 1}-${phase}.log`)));
}

// ---------------------------------------------------------------- commands
function parseStartArgs(args) {
  const a = { paths: [], all: false, base: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') a.all = true;
    else if (args[i] === '--base') a.base = args[++i];
    else if (args[i].startsWith('-')) throw new Error(`unknown argument ${args[i]}`);
    else a.paths.push(args[i].replace(/^\.\//, '').replace(/\/+$/, ''));
  }
  if (a.base !== null && (!a.base || a.base.startsWith('-'))) throw new Error('--base needs a ref');
  if (a.all && !a.paths.length) throw new Error('--all needs a path: it reads whole files, so name the folder or files');
  return a;
}

function startRun(input) {
  const repo = tryGit(input.repo || process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!repo) throw new Error(`not a git repository: ${input.repo}`);
  const a = parseStartArgs(strings(input.args));
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const base = baseRef(repo, a.base);
  if (!base || !tryGit(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])) throw new Error(`no base branch found${a.base ? `: ${a.base}` : ''}. Pass --base <ref>`);
  if (branch === 'HEAD') throw new Error('not on a branch: check out the branch to clean first');
  const baseBranch = lines(tryGit(repo, ['remote'])).reduce((b, r) => (b.startsWith(`${r}/`) ? b.slice(r.length + 1) : b), base);
  if (branch === baseBranch) throw new Error(`on the base branch ${branch}: clean slop on a branch of its own`);
  if (changedFiles(repo).length) throw new Error('the checkout has uncommitted changes: commit or set them aside first, so the cleanup is the only change in its commit');
  const config = loadConfig(repo);
  const mergeBase = git(repo, ['merge-base', base, 'HEAD']);
  const wanted = (f) => !a.paths.length || a.paths.some((p) => f === p || f.startsWith(`${p}/`) || globMatch(p, f));
  const listed = lines(a.all ? git(repo, ['ls-files']) : git(repo, ['diff', '--name-only', '--no-renames', '--diff-filter=AM', mergeBase, 'HEAD'])).filter(wanted);
  if (!listed.length) return { verdict: 'nothing_to_clean', branch, base, skipped: [], note: a.all ? 'no file under those paths' : 'the branch adds or changes no file' };
  const from = a.all ? git(repo, ['hash-object', '-t', 'tree', '/dev/null']) : mergeBase;
  const binary = new Set(lines(git(repo, ['diff', '--numstat', '--no-renames', from, 'HEAD', '--', ...listed])).filter((l) => l.startsWith('-\t-\t')).map((l) => l.slice(4)));
  const skipped = listed.filter((f) => binary.has(f) || anyMatch([...NOT_SLOP, ...config.ignore], f));
  const scope = listed.filter((f) => !skipped.includes(f));
  if (!scope.length) return { verdict: 'nothing_to_clean', branch, base, skipped, note: 'every file in scope is generated, vendored, binary or ignored' };
  if (scope.length > MAX_FILES) throw new Error(`${scope.length} files in scope, at most ${MAX_FILES}: pass paths to narrow it`);
  const run = { run_id: newRunId(), repo, branch, base, merge_base: mergeBase, head: git(repo, ['rev-parse', 'HEAD']), all: a.all, files: scope, config };
  const ranges = a.all ? {} : addedRanges(repo, mergeBase, scope);
  const files = scope.map((f) => ({ file: f, kind: PROSE.test(f) ? 'prose' : isTest(f) ? 'test' : 'code', lines: a.all ? 'all' : ranges[f] || [] }));
  run.baseline = gates(run, 'before');
  const dirtied = changedFiles(repo);
  if (dirtied.length) throw new Error(`a check command changed files (${dirtied.slice(0, 5).join(', ')}): checks must only check. Restore them and fix the command in .claude/clean-slop.json`);
  saveRun(run);
  const red = run.baseline.filter((g) => !g.ok).map((g) => g.cmd);
  return {
    verdict: 'ready',
    run_id: run.run_id,
    branch,
    base,
    merge_base: mergeBase,
    files,
    skipped,
    gates: { from: config.from, results: run.baseline.map(({ cmd, ok }) => ({ cmd, ok })) },
    note: !config.gates.length ? 'no check command found: the cleanup will not be checked. Add "gates" to .claude/clean-slop.json' : red.length ? `red before any edit, so it cannot prove the cleanup: ${red.join(', ')}` : 'checks green before any edit',
  };
}

function checkRun(input) {
  const run = loadRun(input.run);
  if (run.committed) throw new Error(`run ${run.run_id} already committed ${run.committed}: start again`);
  if (git(run.repo, ['rev-parse', 'HEAD']) !== run.head) throw new Error('HEAD moved since start: start again');
  const changed = changedFiles(run.repo);
  const save = (checked, out) => {
    run.checked = checked;
    saveRun(run);
    return out;
  };
  if (!changed.length) return save(null, { verdict: 'nothing_changed', note: 'no file changed: nothing to commit' });
  const edits = new Map((Array.isArray(input.edits) ? input.edits : []).filter((e) => typeof e?.file === 'string' && typeof e?.why === 'string' && e.why.trim()).map((e) => [e.file, e.why.trim()]));
  const changes = changed.map((file) => ({ file, before: atHead(run.repo, file), after: onDisk(run.repo, file) }));
  const unlisted = changed.filter((f) => !edits.has(f));
  // A new file may hold code merged out of near-copies; anything else must be in scope.
  const outside = changes.filter((c) => c.before !== null && !run.files.includes(c.file)).map((c) => c.file);
  if (unlisted.length || outside.length) {
    return save({ verdict: 'blocked' }, { verdict: 'blocked', unlisted, outside, note: 'list every changed file with one line on why, and touch only files in scope. Undo the rest by hand' });
  }
  const subject = typeof input.subject === 'string' && input.subject.trim() && !input.subject.includes('\n') ? input.subject.trim().slice(0, 100) : `refactor: clean slop from ${changed.length} file${changed.length === 1 ? '' : 's'}`;
  const cuts = cutsOf(changes);
  const flags = [...flagsOf(changes, [], { max_files: Infinity, max_lines: Infinity }).map(({ id, flag, file, reason }) => ({ id, flag, file, reason })), ...cuts.flags];
  const hash = workspaceHash(run.repo);
  const after = gates(run, 'after');
  if (workspaceHash(run.repo) !== hash) return save({ verdict: 'blocked' }, { verdict: 'blocked', note: 'a check command changed files: checks must only check. Restore them and fix the command' });
  const turned = after.filter((g, i) => g.ok === false && run.baseline[i]?.ok).map((g) => g.cmd);
  const stillRed = after.filter((g, i) => !g.ok && !run.baseline[i]?.ok).map((g) => g.cmd);
  const verdict = turned.length ? 'checks_failed' : flags.length ? 'needs_decision' : !after.length ? 'unverified' : 'clean';
  const next = {
    checks_failed: `undo or fix the edit that turned ${turned.join(', ')} red (logs below), then check again`,
    needs_decision: 'ask the user about every flag in one message. Yes to all: commit --confirmed. Otherwise undo what they refused and check again',
    unverified: 'no check command ran: say the cleanup is unchecked, and commit --confirmed only on a yes',
    clean: 'commit',
  }[verdict];
  return save(
    { verdict, hash, files: changed, subject, body: [...edits].map(([f, why]) => `- ${f}: ${why}`).join('\n'), added: cuts.added, removed: cuts.removed },
    {
      verdict,
      delta: { added: cuts.added, removed: cuts.removed },
      flags,
      gates: { results: after.map((g, i) => ({ cmd: g.cmd, before: run.baseline[i]?.ok ?? null, after: g.ok, ...(g.ok ? {} : { log: g.log }) })), turned_red: turned, still_red: stillRed },
      subject,
      next,
    },
  );
}

function commitRun(a) {
  const run = loadRun(a.run);
  if (run.committed) throw new Error(`run ${run.run_id} already committed ${run.committed}`);
  const c = run.checked;
  if (!c) throw new Error('check first: nothing has been checked since the last edit');
  if (c.verdict === 'blocked' || c.verdict === 'checks_failed') throw new Error(`the last check was ${c.verdict}: fix it and check again`);
  if ((c.verdict === 'needs_decision' || c.verdict === 'unverified') && a.confirmed !== true) throw new Error(`the last check was ${c.verdict}: commit only after the user said yes, with --confirmed`);
  if (git(run.repo, ['rev-parse', 'HEAD']) !== run.head) throw new Error('HEAD moved since start: start again');
  if (workspaceHash(run.repo) !== c.hash) throw new Error('the files changed since check: check again');
  git(run.repo, ['add', '-A', '--', ...c.files]);
  try {
    git(run.repo, ['commit', '-q', '-m', c.subject, '-m', `${c.body}\n\n-${c.removed} +${c.added} lines.`]);
  } catch (e) {
    throw new Error(`git commit failed (a hook?): ${String(e.stderr || e.message).trim().split('\n')[0]}. The files are staged; nothing was committed`);
  }
  run.committed = git(run.repo, ['rev-parse', 'HEAD']);
  saveRun(run);
  return { verdict: 'committed', commit: run.committed, branch: run.branch, files: c.files, delta: { added: c.added, removed: c.removed }, note: 'local commit only: nothing was pushed' };
}

// Every command answers with one object; a refusal is { error }.
const safe = (fn) => (input) => {
  try {
    return fn(input);
  } catch (e) {
    return { error: e.message };
  }
};
export const start = safe(startRun);
export const check = safe(checkRun);
export const commit = safe(commitRun);

// ---------------------------------------------------------------- cli
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const stdin = () => {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch (e) {
    throw new Error(`stdin is not one JSON object: ${e.message}`);
  }
};
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (k) => rest.includes(`--${k}`);
  const value = (k) => rest[rest.indexOf(`--${k}`) + 1];
  const cmds = { start: () => startRun(stdin()), check: () => checkRun(stdin()), commit: () => commitRun({ run: value('run'), confirmed: flag('confirmed') }) };
  if (!cmds[cmd]) {
    out({ error: `unknown command ${cmd}`, commands: COMMANDS });
    process.exit(2);
  }
  const r = safe(cmds[cmd])();
  out(r);
  if (r.error) process.exit(1);
}
