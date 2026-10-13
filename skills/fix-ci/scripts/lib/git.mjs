// Every git call /fix-ci makes. It works where the fix is made: the user's
// checkout when that is on the pull request branch, clean and at its head,
// otherwise a worktree it created, detached at that head. The commit is built
// with `commit-tree` from the head and the listed files only, so nothing a
// command left behind reaches it and no hook runs. HEAD moves once, after the
// push went through. The one thing that leaves the machine is pushCommit: an
// ordinary push of that commit, which git itself refuses if the branch moved.

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
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

// Where a checkout stands: its branch (null when detached), its commit, and whether anything is uncommitted or untracked.
export const currentBranch = (dir) => tryGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
export const headOf = (dir) => tryGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
export const isClean = (dir) => tryGit(dir, ['status', '--porcelain', '--untracked-files=normal']) === '';
// Commits on the user's local branch that the pull request head lacks.
export function localAhead(repo, branch, headSha) {
  if (!tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${refName(branch)}`])) return 0;
  return Number(tryGit(repo, ['rev-list', '--count', `${headSha}..refs/heads/${branch}`]) || 0);
}
export const hasLocalBranch = (repo, branch) => tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${refName(branch)}`]) !== null;

export const WORKTREES = '.claude/worktrees';
export const worktreePath = (root, runId) => join(root, WORKTREES, runId);
// The run's worktree and nothing else: under the main checkout's worktree folder, named after the run.
export const isRunWorktree = (run) => RUN_ID.test(String(run.run_id)) && run.workspace?.mode === 'worktree' && real(run.workspace.path) === real(worktreePath(run.root, run.run_id));

// A new worktree with no branch, at the pull request's head.
export function addWorktree(root, runId, sha) {
  const path = worktreePath(root, runId);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  git(root, ['worktree', 'add', '--quiet', '--detach', path, sha]);
  return path;
}
export function removeWorktree(run) {
  if (!isRunWorktree(run)) throw new Error(`${run.workspace?.path} is not this run's worktree`);
  if (existsSync(run.workspace.path)) git(run.root, ['worktree', 'remove', '--force', run.workspace.path]);
}

export const treeOf = (repo, sha) => tryGit(repo, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`]);
// A file as a commit or a tree has it, or null when it has no such file.
export function fileAt(repo, sha, path) {
  try {
    return raw(repo, ['cat-file', 'blob', `${sha}:${path}`]).toString();
  } catch {
    return null;
  }
}
export const blobAt = (repo, tree, path) => tryGit(repo, ['rev-parse', '--verify', '--quiet', `${tree}:${path}`]);

const withIndex = (dir, indexFile, args, input) => git(dir, args, { input, env: { GIT_INDEX_FILE: indexFile } });
// The tree of the folder as it stands, ignored files left out. Built in an
// index of its own: the folder's index is not touched.
export function treeNow(dir, tmpIndex, head) {
  rmSync(tmpIndex, { force: true });
  withIndex(dir, tmpIndex, ['read-tree', head]);
  withIndex(dir, tmpIndex, ['add', '-A']);
  return withIndex(dir, tmpIndex, ['write-tree']);
}
// The head's tree with these files as the folder now has them, and nothing
// else: what a command wrote beside them (coverage, build output) stays out.
export function editTree(dir, tmpIndex, head, files) {
  rmSync(tmpIndex, { force: true });
  withIndex(dir, tmpIndex, ['read-tree', head]);
  if (files.length) withIndex(dir, tmpIndex, ['update-index', '--add', '--remove', '-z', '--stdin'], files.join('\0'));
  return withIndex(dir, tmpIndex, ['write-tree']);
}
// Paths that differ between two trees. --no-renames: a moved file shows under both names.
export const changedPaths = (repo, a, b) => git(repo, ['diff', '--name-only', '--no-renames', '-z', a, b]).split('\0').filter(Boolean);
// Lines added and removed between two trees, binary files counted as one.
export function linesChanged(repo, a, b) {
  return git(repo, ['diff', '--numstat', '--no-renames', a, b]).split('\n').filter(Boolean).reduce((n, l) => {
    const [add, del] = l.split('\t');
    return n + (add === '-' ? 1 : Number(add) + Number(del));
  }, 0);
}

// A commit of `tree` on top of `parent`. HEAD does not move and no hook runs.
export function commitTree(dir, tree, parent, message) {
  const sign = tryGit(dir, ['config', '--get', '--bool', 'commit.gpgsign']) === 'true';
  return git(dir, ['commit-tree', tree, '-p', parent, ...(sign ? ['-S'] : []), '-F', '-'], { input: message });
}
export const parentsOf = (repo, sha) => git(repo, ['rev-list', '--parents', '-n', '1', sha]).split(' ').slice(1);

// The one write that leaves the machine: an ordinary push of one commit to the
// pull request's branch. No flag that lets it overwrite anything exists here.
export function pushCommit(dir, remote, sha, branch) {
  raw(dir, ['push', '--quiet', remote, `${sha}:refs/heads/${refName(branch)}`]);
}
// After the push: HEAD goes to the pushed commit, only from the commit it was
// built on. In the user's checkout that moves their branch; the files already
// hold the fix, so only the index is brought along.
export function advance(dir, to, from) {
  git(dir, ['update-ref', '-m', 'fix-ci: pushed', 'HEAD', to, from]);
  git(dir, ['read-tree', to]);
}
