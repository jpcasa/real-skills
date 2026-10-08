// The one place /qa-this writes into the repo by hand is a new test file. This
// proves that is all that happened: a snapshot of the working tree before the
// model writes, and after it a list of every path that changed. Anything
// outside the configured test globs, or a moved HEAD, is a violation.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { anyMatch } from './glob.mjs';

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString();

function hash(repo, path) {
  const p = join(repo, path);
  try {
    if (!existsSync(p)) return 'gone';
    if (!statSync(p).isFile()) return 'dir';
    return createHash('sha1').update(readFileSync(p)).digest('hex');
  } catch {
    return 'unreadable';
  }
}

// -> { head, files: { path: content hash } } for every path git reports as not clean.
export function snapshot(repo) {
  const files = {};
  const entries = git(repo, ['status', '--porcelain', '-uall', '-z']).split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    files[e.slice(3)] = hash(repo, e.slice(3));
    // A rename or copy is followed by its old path.
    if (/^[RC]/.test(e)) {
      const from = entries[++i];
      if (from) files[from] = hash(repo, from);
    }
  }
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
  const changed = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter((p) => before.files[p] !== (after.files[p] ?? hash(repo, p)));
  const tests = [];
  for (const path of changed.sort()) {
    if (anyMatch(globs || [], path)) {
      if (existsSync(join(repo, path))) tests.push(path);
      else violations.push({ path, why: 'a test file was deleted' });
    } else violations.push({ path, why: 'changed, and not a test file (outside tests.globs)' });
  }
  return { ok: violations.length === 0, violations, new_tests: tests };
}
