// Every call that leaves this script: `gh` reads, `git` reads against the
// local clone, and the one write (postComment). Nothing from a PR is checked
// out or executed: objects are fetched and read with `git show`.
//
// CHECK_INFRA_GH_STUB (tests) points at a JSON file that answers the `gh`
// calls: { slug, prs: { "<n>": { view } }, open_into: { "<branch>": [n] },
// current_pr, post }. Git reads still run for real; fetch is skipped.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const BIG = 64 * 1024 * 1024;
const stubPath = () => process.env.CHECK_INFRA_GH_STUB || null;
const stub = () => JSON.parse(readFileSync(stubPath(), 'utf8'));
const gh = (repo, args, input) =>
  execFileSync('gh', args, { cwd: repo, input, maxBuffer: BIG, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).toString();
const git = (repo, args) => execFileSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { maxBuffer: BIG, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const tryGit = (repo, args) => {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
};

// null when this is not a GitHub repository or `gh` is not signed in: ranges still work.
export function repoSlug(repo) {
  if (stubPath()) return stub().slug;
  try {
    return JSON.parse(gh(repo, ['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
  } catch {
    return null;
  }
}

export function prView(repo, n) {
  let v;
  if (stubPath()) {
    v = stub().prs?.[String(n)]?.view;
    if (!v) throw new Error(`PR #${n} not found`);
  } else {
    try {
      v = JSON.parse(gh(repo, ['pr', 'view', String(n), '--json', 'number,title,baseRefName,baseRefOid,headRefName,headRefOid,isDraft,state,url']));
    } catch (e) {
      throw new Error(`PR #${n} not found (${String(e.stderr || e.message).trim().split('\n')[0]})`);
    }
  }
  return { number: v.number, title: v.title || '', url: v.url || null, base: v.baseRefName, base_sha: v.baseRefOid, branch: v.headRefName || '', head_sha: v.headRefOid, draft: Boolean(v.isDraft), state: v.state || 'OPEN' };
}

// The open PR of the branch that is checked out, or null.
export function currentPr(repo) {
  if (stubPath()) return stub().current_pr ?? null;
  try {
    const v = JSON.parse(gh(repo, ['pr', 'view', '--json', 'number,state']));
    return v.state === 'OPEN' ? v.number : null;
  } catch {
    return null;
  }
}

// Open PRs into a branch, most recently updated first.
export function openInto(repo, branch) {
  if (stubPath()) return stub().open_into?.[branch] || [];
  try {
    const rows = JSON.parse(gh(repo, ['pr', 'list', '--base', branch, '--state', 'open', '--json', 'number,updatedAt', '--limit', '10']));
    return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map((r) => r.number);
  } catch {
    return [];
  }
}

// The remote that points at the PR's repository: `origin` in a plain clone,
// usually `upstream` in a clone of a fork.
function remoteFor(repo, slug) {
  const want = String(slug || '').toLowerCase();
  for (const l of (tryGit(repo, ['remote', '-v']) || '').split('\n')) {
    const [name, url = ''] = l.split(/\s+/);
    const u = url.toLowerCase().replace(/\.git$/, '');
    if (want && (u.endsWith(`github.com/${want}`) || u.endsWith(`github.com:${want}`))) return name;
  }
  return 'origin';
}

// A branch name is passed to git as an argument: one that starts with a dash would be read as an option.
const refName = (b) => {
  if (typeof b !== 'string' || !b || b.startsWith('-') || /[\s\0]/.test(b)) throw new Error(`not a branch name: ${JSON.stringify(b)}`);
  return b;
};

// Objects only: FETCH_HEAD moves, no ref is written, nothing is checked out.
export function fetchPr(repo, slug, n, base) {
  refName(base);
  if (!Number.isInteger(n)) throw new Error(`not a PR number: ${n}`);
  if (stubPath()) return;
  git(repo, ['fetch', '--quiet', '--no-tags', remoteFor(repo, slug), `pull/${n}/head`, base]);
}
// Remote-tracking refs for the named branches, best effort.
export function fetchBranches(repo, slug, branches) {
  branches.forEach(refName);
  if (stubPath()) return;
  const remote = remoteFor(repo, slug);
  tryGit(repo, ['fetch', '--quiet', '--no-tags', remote, ...branches.map((b) => `+refs/heads/${b}:refs/remotes/${remote}/${b}`)]);
}

export const revParse = (repo, ref) => tryGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim() || null;
export const mergeBase = (repo, a, b) => tryGit(repo, ['merge-base', a, b])?.trim() || null;
export const defaultBranch = (repo) => tryGit(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.trim().replace(/^origin\//, '') || null;

// -> [{ status: added|modified|deleted|renamed, file, old_file? }]
export function nameStatus(repo, from, to) {
  const parts = git(repo, ['diff', '--name-status', '-M', '-z', '--no-ext-diff', from, to]).split('\0');
  const out = [];
  for (let i = 0; i < parts.length - 1; ) {
    const code = parts[i][0];
    if (code === 'R' || code === 'C') {
      out.push({ status: code === 'R' ? 'renamed' : 'added', old_file: code === 'R' ? parts[i + 1] : undefined, file: parts[i + 2] });
      i += 3;
    } else {
      out.push({ status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified', file: parts[i + 1] });
      i += 2;
    }
  }
  return out;
}

// No external diff driver or textconv filter, which a PR could otherwise name in .gitattributes.
export const diffOf = (repo, from, to, paths) =>
  paths.length ? git(repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', from, to, '--', ...paths]) : '';

export const lsTree = (repo, sha, dir = null) => (tryGit(repo, ['ls-tree', '-r', '--name-only', '-z', sha, ...(dir ? ['--', dir] : [])]) || '').split('\0').filter(Boolean);

export function showFile(repo, sha, path) {
  try {
    return git(repo, ['show', '--no-textconv', `${sha}:${path}`]);
  } catch {
    return null;
  }
}

// Whole-word hits for any of `names` in the tree at `sha`, outside `exclude`.
// -> { hits: [{ file, line }], total }
export function grepTree(repo, sha, names, exclude = [], cap = 5) {
  const spec = ['.', ...exclude.map((e) => `:(exclude,glob)${e}`)];
  let out;
  try {
    out = git(repo, ['grep', '-n', '-w', '-F', '-I', ...names.flatMap((n) => ['-e', n]), sha, '--', ...spec]);
  } catch {
    return { hits: [], total: 0 };
  }
  const rows = out.split('\n').filter(Boolean).map((l) => l.slice(sha.length + 1).match(/^(.+?):(\d+):/)).filter(Boolean);
  return { hits: rows.slice(0, cap).map((m) => ({ file: m[1], line: Number(m[2]) })), total: rows.length };
}

// What is checked out, for the plan precondition.
// A status that could not be read counts as dirty: nothing is planned on a tree nobody can vouch for.
export function worktree(repo) {
  const status = tryGit(repo, ['status', '--porcelain']);
  return { head: revParse(repo, 'HEAD'), dirty: status === null || status.trim() !== '' };
}

// The only write this skill makes.
export function postComment(repo, slug, n, body) {
  if (stubPath()) {
    const s = stub();
    appendFileSync(`${stubPath()}.posted.jsonl`, `${JSON.stringify({ slug, n, body })}\n`);
    if (s.post?.error) throw new Error(s.post.error);
    return { id: s.post?.id ?? 1, html_url: s.post?.html_url ?? `https://github.com/${slug}/pull/${n}#issuecomment-1` };
  }
  const res = JSON.parse(gh(repo, ['api', '-X', 'POST', `repos/${slug}/issues/${n}/comments`, '--input', '-'], JSON.stringify({ body })));
  return { id: res.id, html_url: res.html_url };
}
