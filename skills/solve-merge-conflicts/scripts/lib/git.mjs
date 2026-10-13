// Every git call /solve-merge-conflicts makes. It works in one worktree it
// created, detached at the pull request's head, and moves no branch of the
// clone. The merge commit is built with `commit-tree`, so not even the
// worktree's HEAD moves. The one thing that leaves the machine is pushCommit:
// an ordinary push of that commit, which git itself refuses if the branch moved.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RUN_ID } from './state.mjs';

const BIG = 256 * 1024 * 1024;
// GIT_LITERAL_PATHSPECS: a path such as pages/[slug].tsx is that file, never a pattern.
const raw = (cwd, args, { input, env } = {}) =>
  execFileSync('git', ['-C', cwd, '-c', 'core.quotePath=false', ...args], { input, maxBuffer: BIG, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', ...env } });
export const git = (cwd, args, opts) => raw(cwd, args, opts).toString().trim();
export const tryGit = (cwd, args, opts) => {
  try {
    return git(cwd, args, opts);
  } catch {
    return null;
  }
};
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
export const firstLine = (e) => String(e.stderr || e.message || e).trim().split('\n')[0];

export const topLevel = (dir) => tryGit(dir, ['rev-parse', '--show-toplevel']);
// The main checkout, also when called from a linked worktree: worktrees live under it.
export function mainRoot(repo) {
  const common = tryGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return common ? dirname(common) : null;
}

// A branch name that git can only read as a name.
export const refName = (b) => {
  if (typeof b !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b) || b.includes('..')) throw new Error(`not a branch name: ${JSON.stringify(b)}`);
  return b;
};

// The remote that points at the pull request's repository. Matched on
// owner/name at the end of the URL, so an SSH host alias works too. With
// several remotes and none that matches there is no telling which one the
// pull request lives on (a fork is the usual other one): null, and nothing runs.
export function remoteFor(repo, slug) {
  const want = String(slug || '').toLowerCase();
  const names = new Set();
  for (const l of (tryGit(repo, ['remote', '-v']) || '').split('\n').filter(Boolean)) {
    const [name, url = ''] = l.split(/\s+/);
    names.add(name);
    const u = url.toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
    if (want && (u.endsWith(`/${want}`) || u.endsWith(`:${want}`))) return name;
  }
  return names.size === 1 ? [...names][0] : null;
}

// Remote-tracking refs for the named branches. -> true when the fetch ran clean.
export const fetchRefs = (repo, remote, branches) => tryGit(repo, ['fetch', '--quiet', '--no-tags', remote, ...branches.map((b) => `+refs/heads/${refName(b)}:refs/remotes/${remote}/${b}`)]) !== null;
export const tip = (repo, remote, branch) => tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${refName(branch)}^{commit}`]);
// What the remote itself says the branch is at, right now. null when it cannot be asked.
export function remoteHead(repo, remote, branch) {
  const out = tryGit(repo, ['ls-remote', '--heads', remote, `refs/heads/${refName(branch)}`]);
  if (out === null) return null;
  return out.split(/\s+/)[0] || '';
}
export const mergeBase = (repo, a, b) => tryGit(repo, ['merge-base', a, b]);
export const isAncestor = (repo, older, newer) => tryGit(repo, ['merge-base', '--is-ancestor', older, newer]) !== null;
// True when `sha` is one of the commits in from..to.
export const inRange = (repo, sha, from, to) => isAncestor(repo, sha, to) && !isAncestor(repo, sha, from);
export const fullSha = (repo, s) => (/^[0-9a-f]{7,40}$/.test(String(s)) ? tryGit(repo, ['rev-parse', '--verify', '--quiet', `${s}^{commit}`]) : null);

// Does `base` merge into `head` without a conflict? Nothing is checked out.
// -> { clean, files } — files: the paths in conflict.
export function mergeConflicts(repo, head, base) {
  try {
    raw(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', head, base]);
    return { clean: true, files: [] };
  } catch (e) {
    if (e.status !== 1) throw new Error(`git could not try the merge: ${firstLine(e)}`);
    return { clean: false, files: e.stdout.toString().split('\n').slice(1).filter(Boolean) };
  }
}

// Commits on the user's local branch that the pull request head lacks.
export function localAhead(repo, branch, headSha) {
  if (!tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${refName(branch)}`])) return 0;
  return Number(tryGit(repo, ['rev-list', '--count', `${headSha}..refs/heads/${branch}`]) || 0);
}

export const WORKTREES = '.claude/worktrees';
export const worktreePath = (root, runId) => join(root, WORKTREES, runId);
// The run's worktree and nothing else: under the main checkout's worktree folder, named after the run.
export const isRunWorktree = (run) => RUN_ID.test(String(run.run_id)) && Boolean(run.worktree) && real(run.worktree) === real(worktreePath(run.root, run.run_id));

// A new worktree with no branch, at the pull request's head.
export function addWorktree(root, runId, sha, suffix = '') {
  const path = `${worktreePath(root, runId)}${suffix}`;
  if (existsSync(path)) throw new Error(`${path} already exists`);
  git(root, ['worktree', 'add', '--quiet', '--detach', path, sha]);
  return path;
}
export function removeWorktreeAt(root, path) {
  if (existsSync(path)) git(root, ['worktree', 'remove', '--force', path]);
}
// The run's worktree, and the two the checks use beside it.
export const CHECK = '-check';
export const BEFORE = '-before';
export function removeWorktree(run) {
  if (!isRunWorktree(run)) throw new Error(`${run.worktree} is not this run's worktree`);
  for (const suffix of [CHECK, BEFORE, '']) removeWorktreeAt(run.root, `${worktreePath(run.root, run.run_id)}${suffix}`);
}
// Puts a worktree the run made for its checks at another commit. What a check
// left behind in tracked files goes; the installed dependencies stay.
export const moveTo = (worktree, sha) => git(worktree, ['switch', '--quiet', '--detach', '--discard-changes', sha]);
export const treeOf = (repo, sha) => tryGit(repo, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`]);
// A file as a commit has it, or null when that commit has no such file.
export function fileAt(repo, sha, path) {
  try {
    return raw(repo, ['cat-file', 'blob', `${sha}:${path}`]).toString();
  } catch {
    return null;
  }
}

// Merges the base into the worktree and stops before committing.
// -> { conflicted, messages } — messages: git's own CONFLICT lines.
export function startMerge(worktree, baseSha) {
  try {
    raw(worktree, ['merge', '--no-commit', '--no-ff', '--no-edit', baseSha]);
    return { conflicted: false, messages: [] };
  } catch (e) {
    const outText = `${e.stdout || ''}`;
    if (!/CONFLICT/.test(outText)) throw new Error(`git could not start the merge: ${firstLine(e)}`);
    return { conflicted: true, messages: outText.split('\n').filter((l) => l.startsWith('CONFLICT')).map((l) => l.slice(0, 300)) };
  }
}

const XY = { '1,2,3': 'UU', '2,3': 'AA', '1,2': 'UD', '1,3': 'DU', 1: 'DD', 2: 'AU', 3: 'UA' };
// Paths the merge left unresolved. Stage 1 is where both started, 2 the pull request, 3 the base.
// -> [{ path, xy, stages: { 1?: {mode, sha}, 2?, 3? } }]
export function unmerged(worktree) {
  const byPath = new Map();
  for (const entry of raw(worktree, ['ls-files', '-u', '-z']).toString().split('\0').filter(Boolean)) {
    // A path may hold a tab itself: only the first one separates.
    const [meta, path] = [entry.slice(0, entry.indexOf('\t')), entry.slice(entry.indexOf('\t') + 1)];
    const [mode, sha, stage] = meta.split(' ');
    if (!byPath.has(path)) byPath.set(path, {});
    byPath.get(path)[stage] = { mode, sha };
  }
  return [...byPath].map(([path, stages]) => ({ path, xy: XY[Object.keys(stages).sort().join(',')], stages })).sort((a, b) => a.path.localeCompare(b.path));
}
export const blob = (worktree, sha) => raw(worktree, ['cat-file', 'blob', sha]);
export const looksBinary = (buf) => buf.subarray(0, 8000).includes(0);

// The conflicted copy of one file, built from its three versions with labels
// and a marker length the script chose. -> text
export function mergeFile(dir, { pr, origin, base }, size) {
  mkdirSync(dir, { recursive: true });
  for (const [name, buf] of [['pr', pr], ['origin', origin], ['base', base]]) writeFileSync(join(dir, name), buf);
  try {
    return execFileSync('git', ['merge-file', '-p', '--zdiff3', `--marker-size=${size}`, '-L', 'pr', '-L', 'origin', '-L', 'base', 'pr', 'origin', 'base'], { cwd: dir, maxBuffer: BIG, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    // The exit code is the number of conflicts; below zero or 255 is a failure.
    if (typeof e.status !== 'number' || e.status < 1 || e.status > 127) throw new Error(`git could not rebuild the conflict: ${firstLine(e)}`);
    return e.stdout.toString();
  }
}

const withIndex = (worktree, indexFile, args, input) => git(worktree, args, { input, env: { GIT_INDEX_FILE: indexFile } });
const indexPath = (worktree) => git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);

// The tree of everything the merge settled by itself: the index as the merge
// left it, minus the paths in conflict. Built in a copy of the index.
export function cleanTree(worktree, tmpIndex, conflictPaths) {
  copyFileSync(indexPath(worktree), tmpIndex);
  if (conflictPaths.length) withIndex(worktree, tmpIndex, ['update-index', '--force-remove', '-z', '--stdin'], conflictPaths.join('\0'));
  return withIndex(worktree, tmpIndex, ['write-tree']);
}
// The tree of the worktree as it stands, ignored files left out. Built in a
// copy of the index: the worktree's own index is not touched.
export function treeNow(worktree, tmpIndex) {
  copyFileSync(indexPath(worktree), tmpIndex);
  withIndex(worktree, tmpIndex, ['add', '-A']);
  return withIndex(worktree, tmpIndex, ['write-tree']);
}
// Paths that differ between two trees. --no-renames: a moved file shows under both names.
export const changedPaths = (repo, a, b) => git(repo, ['diff', '--name-only', '--no-renames', '-z', a, b]).split('\0').filter(Boolean);
export const blobAt = (repo, tree, path) => tryGit(repo, ['rev-parse', '--verify', '--quiet', `${tree}:${path}`]);
export const hashFile = (repo, file) => git(repo, ['hash-object', '--', file]);

// A commit of `tree` with these parents. HEAD does not move and no hook runs.
export function commitTree(worktree, tree, parents, message) {
  const sign = tryGit(worktree, ['config', '--get', '--bool', 'commit.gpgsign']) === 'true';
  return git(worktree, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), ...(sign ? ['-S'] : []), '-F', '-'], { input: message });
}
export const parentsOf = (repo, sha) => git(repo, ['rev-list', '--parents', '-n', '1', sha]).split(' ').slice(1);

// The one write that leaves the machine: an ordinary push of one commit to the
// pull request's branch. No flag that lets it overwrite anything exists here.
export function pushCommit(worktree, remote, sha, branch) {
  raw(worktree, ['push', '--quiet', remote, `${sha}:refs/heads/${refName(branch)}`]);
}
