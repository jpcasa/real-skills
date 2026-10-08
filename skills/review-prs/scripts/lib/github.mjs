// Every call that leaves this script: `gh` reads, `git` reads against the
// local clone, and the one write (postReview). Nothing from a PR is checked
// out or executed: objects are fetched and read with `git show`.
//
// REVIEW_PRS_GH_STUB (tests) points at a JSON file that answers the `gh`
// calls: { slug, requested: [...], prs: { "<n>": { view, comments } }, post }.
// Git reads still run for real, against a repo the test built; fetch is skipped.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const BIG = 64 * 1024 * 1024;
const stubPath = () => process.env.REVIEW_PRS_GH_STUB || null;
const stub = () => JSON.parse(readFileSync(stubPath(), 'utf8'));
const gh = (repo, args, input) =>
  execFileSync('gh', args, { cwd: repo, input, maxBuffer: BIG, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).toString();
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: BIG, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

export function repoSlug(repo) {
  if (stubPath()) return stub().slug;
  return JSON.parse(gh(repo, ['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
}

// Open, non-draft PRs waiting on the user's review.
export function listRequested(repo) {
  if (stubPath()) return stub().requested || [];
  const rows = JSON.parse(gh(repo, ['pr', 'list', '--state', 'open', '--search', 'review-requested:@me draft:false', '--json', 'number,title,author', '--limit', '30']));
  return rows.map((r) => ({ number: r.number, title: r.title, author: r.author?.login || null }));
}

const FAILING = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
function ciOf(rollup = []) {
  if (!rollup.length) return { state: 'none', failing: [] };
  const failing = rollup.filter((c) => FAILING.has(c.conclusion) || FAILING.has(c.state)).map((c) => c.name || c.context || 'check');
  if (failing.length) return { state: 'failing', failing };
  const pending = rollup.some((c) => (c.status && c.status !== 'COMPLETED') || c.state === 'PENDING' || c.state === 'EXPECTED');
  return { state: pending ? 'pending' : 'passing', failing: [] };
}

export function prView(repo, n) {
  let v;
  if (stubPath()) {
    v = stub().prs?.[String(n)]?.view;
    if (!v) throw new Error(`PR #${n} not found`);
  } else {
    try {
      v = JSON.parse(gh(repo, ['pr', 'view', String(n), '--json', 'number,title,body,author,baseRefName,baseRefOid,headRefName,headRefOid,isDraft,state,url,statusCheckRollup']));
    } catch (e) {
      throw new Error(`PR #${n} not found (${String(e.stderr || e.message).trim().split('\n')[0]})`);
    }
  }
  return {
    number: v.number, title: v.title || '', body: v.body || '', author: v.author?.login || null, url: v.url || null,
    base: v.baseRefName, base_sha: v.baseRefOid, branch: v.headRefName || '', head_sha: v.headRefOid, draft: Boolean(v.isDraft), state: v.state || 'OPEN',
    ci: ciOf(v.statusCheckRollup || []),
  };
}

// Review comments already on the PR, on the head side and still current:
// [{ path, line }]. An outdated comment has no `line`, and its old line number
// means nothing against the head.
export function prComments(repo, slug, n) {
  let rows;
  if (stubPath()) rows = stub().prs?.[String(n)]?.comments || [];
  else {
    try {
      rows = JSON.parse(gh(repo, ['api', `repos/${slug}/pulls/${n}/comments`, '--paginate', '--slurp']) || '[]').flat();
    } catch {
      rows = [];
    }
  }
  return rows.filter((c) => c.path && Number.isInteger(c.line) && c.side !== 'LEFT').map((c) => ({ path: c.path, line: c.line }));
}

// The remote that points at the PR's repository: `origin` in a plain clone,
// usually `upstream` in a clone of a fork.
function remoteFor(repo, slug) {
  try {
    const want = slug.toLowerCase();
    for (const l of git(repo, ['remote', '-v']).split('\n')) {
      const [name, url = ''] = l.split(/\s+/);
      if (url.toLowerCase().replace(/\.git$/, '').endsWith(`github.com/${want}`) || url.toLowerCase().replace(/\.git$/, '').endsWith(`github.com:${want}`)) return name;
    }
  } catch {}
  return 'origin';
}

// Objects only: FETCH_HEAD moves, no ref is written, nothing is checked out.
export function fetchPr(repo, slug, n, base) {
  if (stubPath()) return;
  git(repo, ['fetch', '--quiet', '--no-tags', remoteFor(repo, slug), `pull/${n}/head`, base]);
}

const has = (repo, sha) => {
  try {
    git(repo, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

// The PR's own changes: merge-base to head. No external diff driver or
// textconv filter, which a PR could otherwise name in .gitattributes.
export function prDiff(repo, pr) {
  if (has(repo, pr.base_sha) && has(repo, pr.head_sha)) {
    return git(repo, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', `${pr.base_sha}...${pr.head_sha}`]);
  }
  if (stubPath()) throw new Error(`commits for PR #${pr.number} are not in this clone`);
  return gh(repo, ['pr', 'diff', String(pr.number)]);
}

export function showFile(repo, sha, path) {
  try {
    return git(repo, ['show', '--no-textconv', `${sha}:${path}`]);
  } catch {
    return null;
  }
}

// Old-side line ranges that changed between two commits, for one file. null
// when that cannot be told from the PR's own work: the old head is no longer
// an ancestor (a rebase or force-push), or a merge in between brought in
// someone else's edits.
export function changedOldLines(repo, from, to, path) {
  let text;
  try {
    git(repo, ['merge-base', '--is-ancestor', from, to]);
    if (git(repo, ['rev-list', '--merges', '-n', '1', `${from}..${to}`]).trim()) return null;
    text = git(repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', from, to, '--', path]);
  } catch {
    return null;
  }
  const ranges = [];
  for (const m of text.matchAll(/^@@ -(\d+)(?:,(\d+))? \+/gm)) {
    const start = Number(m[1]);
    const len = m[2] === undefined ? 1 : Number(m[2]);
    ranges.push([start, start + Math.max(len, 1) - 1]);
  }
  return ranges;
}

// The only write this skill makes.
export function postReview(repo, slug, n, payload) {
  if (stubPath()) {
    const s = stub();
    appendFileSync(`${stubPath()}.posted.jsonl`, `${JSON.stringify({ slug, n, payload })}\n`);
    if (s.post?.error) throw new Error(s.post.error);
    return { id: s.post?.id ?? 1, html_url: s.post?.html_url ?? `https://github.com/${slug}/pull/${n}#pullrequestreview-1` };
  }
  const res = JSON.parse(gh(repo, ['api', '-X', 'POST', `repos/${slug}/pulls/${n}/reviews`, '--input', '-'], JSON.stringify(payload)));
  return { id: res.id, html_url: res.html_url };
}
