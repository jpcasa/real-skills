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
// Untracked files git ignores (build output, caches, .env) are a different
// matter: a dev server rewrites them all the time, so a change there is noted,
// not a violation. What makes a file ignored is checked, though: if the ignore
// rules outside the tree change, a new source file could be hidden by them.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
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

// Size and time of an ignored path. Not its content: these can be large and many.
function stamp(repo, path) {
  try {
    const st = lstatSync(join(repo, path));
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return 'gone';
  }
}

// The ignore rules that live outside the working tree.
function ignoreRules(repo) {
  const read = (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  };
  const tryGit = (args) => {
    try {
      return git(repo, args).trim();
    } catch {
      return '';
    }
  };
  const info = tryGit(['rev-parse', '--git-path', 'info/exclude']);
  const global = tryGit(['config', '--get', 'core.excludesFile']);
  const home = process.env.HOME || '';
  return sha([info && read(isAbsolute(info) ? info : join(repo, info)), global, global && read(global.replace(/^~(?=\/)/, home))].join('\0'));
}

// -> { head, files: { path: hash }, ignored: { path: stamp }, rules }
export function snapshot(repo) {
  const list = (args) => git(repo, ['ls-files', '-z', ...args]).split('\0').filter(Boolean);
  const files = {};
  for (const path of new Set([...list([]), ...list(['--others', '--exclude-standard'])])) files[path] = hash(repo, path);
  const ignored = {};
  for (const path of list(['--others', '--ignored', '--exclude-standard', '--directory']).slice(0, 5000)) ignored[path] = stamp(repo, path);
  let head = '';
  try {
    head = git(repo, ['rev-parse', 'HEAD']).trim();
  } catch {}
  return { head, files, ignored, rules: ignoreRules(repo) };
}

// -> { ok, violations: [{path, why}], new_tests: [path], noted: [path] }
export function compare(repo, before, globs) {
  const after = snapshot(repo);
  const violations = [];
  if (after.head !== before.head) violations.push({ path: 'HEAD', why: 'the branch moved: something was committed, checked out or reset' });
  if (before.rules !== undefined && after.rules !== before.rules) violations.push({ path: '.git/info/exclude', why: 'the ignore rules changed (.git/info/exclude or core.excludesFile): a new file could be hidden by them' });
  const was = before.ignored || {};
  const noted = [...new Set([...Object.keys(was), ...Object.keys(after.ignored)])].filter((p) => (was[p] ?? 'gone') !== (after.ignored[p] ?? 'gone')).sort();
  const changed = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter((p) => (before.files[p] ?? 'gone') !== (after.files[p] ?? 'gone'));
  const tests = [];
  for (const path of changed.sort()) {
    if (anyMatch(globs || [], path)) {
      if (after.files[path] && after.files[path] !== 'gone') tests.push(path);
      else violations.push({ path, why: 'a test file was deleted' });
    } else violations.push({ path, why: 'changed, and not a test file (outside tests.globs)' });
  }
  return { ok: violations.length === 0, violations, new_tests: tests, noted };
}
