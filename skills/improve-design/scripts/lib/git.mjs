// Every git call /improve-design makes. It works in one worktree it created,
// on one branch it created, and never moves any other branch or tree.

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BIG = 64 * 1024 * 1024;
export const git = (cwd, args, input) =>
  execFileSync('git', ['-C', cwd, ...args], { input, maxBuffer: BIG, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).toString().trim();
export const tryGit = (cwd, args) => {
  try {
    return git(cwd, args);
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

export const topLevel = (dir) => tryGit(dir, ['rev-parse', '--show-toplevel']);
// The main checkout, also when called from a linked worktree: worktrees live under it.
export function mainRoot(repo) {
  const common = tryGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return common ? dirname(common) : null;
}
export const hasOrigin = (repo) => tryGit(repo, ['remote', 'get-url', 'origin']) !== null;
export const defaultBranch = (repo) => tryGit(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.replace(/^origin\//, '') || tryGit(repo, ['symbolic-ref', '--short', 'HEAD']) || 'main';
export const head = (cwd) => git(cwd, ['rev-parse', 'HEAD']);

export const WORKTREES = '.claude/worktrees';
export const worktreePath = (root, runId) => join(root, WORKTREES, runId);
// The run's worktree and nothing else: under the main checkout's worktree folder, named after the run.
export const isRunWorktree = (run) => /^id-\d{8}-\d{4}-[0-9a-f]{4}$/.test(run.run_id) && real(run.worktree) === real(worktreePath(run.root, run.run_id));

// A new worktree on a new branch, from the freshest copy of the base there is.
// -> { worktree, start, start_sha, fetched }
export function createWorktree({ root, runId, base, branch }) {
  let fetched = false;
  if (hasOrigin(root)) fetched = tryGit(root, ['fetch', '--quiet', 'origin', base]) !== null;
  const start = tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]) ? `origin/${base}` : base;
  if (!tryGit(root, ['rev-parse', '--verify', '--quiet', `${start}^{commit}`])) throw new Error(`no branch ${base} to start from`);
  if (tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) throw new Error(`branch ${branch} already exists`);
  const worktree = worktreePath(root, runId);
  if (existsSync(worktree)) throw new Error(`${worktree} already exists`);
  git(root, ['worktree', 'add', '--quiet', '-b', branch, worktree, start]);
  return { worktree, start, start_sha: head(worktree), fetched };
}

export const isClean = (cwd) => git(cwd, ['status', '--porcelain']) === '';
// --no-renames: a file moved into a ui path must show up under its old name too.
export const changedFiles = (cwd, from, to = 'HEAD') => git(cwd, ['diff', '--name-only', '--no-renames', `${from}..${to}`]).split('\n').filter(Boolean);
export const isAncestor = (cwd, older, newer = 'HEAD') => tryGit(cwd, ['merge-base', '--is-ancestor', older, newer]) !== null;
export const OWN_BRANCH = /^improve-design\/[A-Za-z0-9._-]+$/;
export const commitsSince = (cwd, from) => git(cwd, ['rev-list', '--reverse', `${from}..HEAD`]).split('\n').filter(Boolean);
export const everPushed = (run) => run.pushed === true || run.shipped === true || tryGit(run.worktree, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${run.branch}`]) !== null;

// Why the commits of a move may not be taken off the branch, or null.
// All four must hold: the tip is this move's last commit, nothing is
// uncommitted, the branch never left this machine, and the tree is the run's own.
export function dropRefusal(run, move) {
  if (!isRunWorktree(run)) return `${run.worktree} is not this run's worktree`;
  if (!OWN_BRANCH.test(String(run.branch))) return `${run.branch} is not a branch this skill made`;
  if (tryGit(run.worktree, ['symbolic-ref', '--short', 'HEAD']) !== run.branch) return `the worktree is not on ${run.branch}`;
  if (head(run.worktree) !== move.check?.sha) return `HEAD is not the commit of ${move.id}`;
  if (!isClean(run.worktree)) return 'the worktree has uncommitted changes';
  if (everPushed(run)) return `${run.branch} has been pushed`;
  if (!move.check?.parent || !isAncestor(run.worktree, move.check.parent)) return `the commit before ${move.id} is not behind HEAD`;
  return null;
}

// Takes a move's commits off the branch. The patch is written first, so
// nothing a designer made is ever lost. -> { patch }
export function dropHead(run, move, patchFile) {
  const why = dropRefusal(run, move);
  if (why) throw new Error(`cannot drop ${move.id}: ${why}`);
  writeFileSync(patchFile, `${git(run.worktree, ['format-patch', '--stdout', `${move.check.parent}..HEAD`])}\n`);
  git(run.worktree, ['reset', '--quiet', '--hard', move.check.parent]);
  return { patch: patchFile };
}

// What a designer left uncommitted is saved as a patch, then cleared. Ignored
// files (dependencies, the copied env files) are left alone.
export function discardUncommitted(run, patchFile) {
  if (!isRunWorktree(run)) throw new Error(`${run.worktree} is not this run's worktree`);
  git(run.worktree, ['add', '-A']);
  writeFileSync(patchFile, `${git(run.worktree, ['diff', '--cached', '--binary', 'HEAD'])}\n`);
  git(run.worktree, ['reset', '--quiet', '--hard', 'HEAD']);
}

// A run that kept nothing leaves nothing behind: the worktree and the branch
// go, but only when the branch holds no commit of its own and never left this machine.
export function removeEmpty(run) {
  if (!isRunWorktree(run) || !existsSync(run.worktree) || !OWN_BRANCH.test(String(run.branch))) return false;
  if (head(run.worktree) !== run.start_sha || !isClean(run.worktree) || everPushed(run)) return false;
  git(run.root, ['worktree', 'remove', '--force', run.worktree]);
  tryGit(run.root, ['branch', '-D', run.branch]);
  return true;
}

export function push(run) {
  if (!isRunWorktree(run)) throw new Error(`${run.worktree} is not this run's worktree`);
  if (!OWN_BRANCH.test(String(run.branch))) throw new Error(`${run.branch} is not a branch this skill made`);
  git(run.worktree, ['push', '--quiet', '-u', 'origin', `refs/heads/${run.branch}:refs/heads/${run.branch}`]);
}
