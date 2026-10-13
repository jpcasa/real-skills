// Every `gh` call /solve-merge-conflicts makes. All of them read: the skill
// never comments on, merges, retargets or closes a pull request.
//
// SOLVE_CONFLICTS_GH_STUB (tests) points at a JSON file that answers them:
//   { slug, current_pr: <n>|null, prs: { "<n>": view }, mine: [view],
//     commit_prs: { "<sha>": { number, title } } }
// Git itself is never stubbed: tests run against a real bare remote.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BIG = 64 * 1024 * 1024;
const stubPath = () => process.env.SOLVE_CONFLICTS_GH_STUB || null;
const stub = () => JSON.parse(readFileSync(stubPath(), 'utf8'));
const gh = (repo, args) => execFileSync('gh', args, { cwd: repo, maxBuffer: BIG, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const tryJson = (repo, args) => {
  try {
    return JSON.parse(gh(repo, args));
  } catch {
    return null;
  }
};

// null when this is not a GitHub repository or `gh` is not signed in.
export function repoSlug(repo) {
  if (stubPath()) return stub().slug ?? null;
  return tryJson(repo, ['repo', 'view', '--json', 'nameWithOwner'])?.nameWithOwner ?? null;
}

const FIELDS = 'number,state,title,body,url,baseRefName,headRefName,headRefOid,isCrossRepository,mergeable,author';
const view = (p) =>
  p && {
    number: p.number, state: p.state, title: String(p.title || ''), body: String(p.body || ''), url: p.url,
    base: p.baseRefName, head: p.headRefName, head_sha: p.headRefOid, fork: p.isCrossRepository === true,
    mergeable: p.mergeable || 'UNKNOWN', author: p.author?.login || null,
  };

// -> the pull request, or null when GitHub has none by that number.
export function prView(repo, number) {
  if (stubPath()) return view(stub().prs?.[String(number)]) || null;
  return view(tryJson(repo, ['pr', 'view', String(number), '--json', FIELDS])) || null;
}

// The pull request of the branch this checkout is on. -> number or null
export function currentPr(repo) {
  if (stubPath()) return stub().current_pr ?? null;
  return tryJson(repo, ['pr', 'view', '--json', 'number'])?.number ?? null;
}

// The user's open pull requests that GitHub marks as conflicting.
// -> [{ number, title, head, url }], or null when they could not be listed.
export function myConflicting(repo) {
  const list = stubPath() ? stub().mine ?? [] : tryJson(repo, ['pr', 'list', '--author', '@me', '--state', 'open', '--limit', '50', '--json', FIELDS]);
  if (!Array.isArray(list)) return null;
  return list.map(view).filter((p) => p.mergeable === 'CONFLICTING' && !p.fork).map((p) => ({ number: p.number, title: p.title, head: p.head, url: p.url }));
}

// The pull request that carried a commit into the base, when GitHub knows one.
export function commitPr(repo, slug, sha) {
  if (stubPath()) return stub().commit_prs?.[sha] ?? null;
  const first = tryJson(repo, ['api', `repos/${slug}/commits/${sha}/pulls`])?.[0];
  return first ? { number: first.number, title: String(first.title || '') } : null;
}
