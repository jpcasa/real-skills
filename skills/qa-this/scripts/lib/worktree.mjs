// The one place /qa-this writes into the repo by hand is a new test file. This
// proves that is all that happened: a hash of every tracked file and every
// untracked one git would show, taken before the model writes and compared
// afterwards. Anything outside the configured test globs, or a moved HEAD, is
// a violation.
//
// Hashing the files themselves, not asking `git status`, is deliberate: status
// can be told to look away (assume-unchanged, skip-worktree), and it says
// nothing about a tracked file that also matches .gitignore.
//
// Not covered: untracked files git ignores (build output, caches, .env). They
// are not source, and there can be a great many of them.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { anyMatch } from './glob.mjs';

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).toString();
const sha = (data) => createHash('sha1').update(data).digest('hex');

function hash(repo, path) {
  const p = join(repo, path);
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return `link:${readlinkSync(p)}`;
    // A nested repository or submodule: its commit and everything not clean in it.
    if (st.isDirectory()) return existsSync(join(p, '.git')) ? `repo:${sha(git(p, ['rev-parse', 'HEAD']) + git(p, ['status', '--porcelain', '-uall']) + git(p, ['diff']))}` : 'dir';
    return `${st.mode & 0o111 ? 'x' : '-'}${sha(readFileSync(p))}`;
  } catch {
    return 'gone';
  }
}

// -> { head, files: { path: hash } }
export function snapshot(repo) {
  const list = (args) => git(repo, ['ls-files', '-z', ...args]).split('\0').filter(Boolean);
  const files = {};
  for (const path of new Set([...list([]), ...list(['--others', '--exclude-standard'])])) files[path] = hash(repo, path);
  let head = '';
  try {
    head = git(repo, ['rev-parse', 'HEAD']).trim();
  } catch {}
  return { head, files };
}

// -> { ok, violations: [{path, why}], new_tests: [path] }
export function compare(repo, before, globs) {
  const after = snapshot(repo);
  const violations = [];
  if (after.head !== before.head) violations.push({ path: 'HEAD', why: 'the branch moved: something was committed, checked out or reset' });
  const changed = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter((p) => (before.files[p] ?? 'gone') !== (after.files[p] ?? 'gone'));
  const tests = [];
  for (const path of changed.sort()) {
    if (anyMatch(globs || [], path)) {
      if (after.files[path] && after.files[path] !== 'gone') tests.push(path);
      else violations.push({ path, why: 'a test file was deleted' });
    } else violations.push({ path, why: 'changed, and not a test file (outside tests.globs)' });
  }
  return { ok: violations.length === 0, violations, new_tests: tests };
}
