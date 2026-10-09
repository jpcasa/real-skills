// Every call that leaves this script: `gh` reads, `git` reads against the
// local clone, a fetch of the stage branches, and the two writes (createPr,
// mergePr). Nothing is checked out, and no branch of the clone is moved.
//
// PROMOTE_GH_STUB (tests) points at a JSON file that answers the `gh` calls:
//   { slug, open_prs: { "<base>": [pr] }, prs: { "<n>": view },
//     checks: { "<sha>": [{ name, status, conclusion }] },
//     runs: { "<sha>": [{ id, name, path, status, conclusion, html_url }] },
//     deployments: { "<sha>": [{ environment, state, url }] },
//     create: { number, url } | { error }, merge: { sha } | { error } }
// Writes are appended to <stub>.calls.jsonl. Git reads still run for real;
// fetch is skipped, and a branch with no remote-tracking ref is read locally.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const BIG = 64 * 1024 * 1024;
const stubPath = () => process.env.PROMOTE_GH_STUB || null;
const stub = () => JSON.parse(readFileSync(stubPath(), 'utf8'));
const called = (entry) => appendFileSync(`${stubPath()}.calls.jsonl`, `${JSON.stringify(entry)}\n`);
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
const firstLine = (e) => String(e.stderr || e.message || e).trim().split('\n')[0];
const api = (repo, path) => JSON.parse(gh(repo, ['api', path]));

// null when this is not a GitHub repository or `gh` is not signed in.
export function repoSlug(repo) {
  if (stubPath()) return stub().slug ?? null;
  try {
    return JSON.parse(gh(repo, ['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
  } catch {
    return null;
  }
}

// The remote that points at the repository: `origin` in a plain clone.
export function remoteFor(repo, slug) {
  const want = String(slug || '').toLowerCase();
  for (const l of (tryGit(repo, ['remote', '-v']) || '').split('\n')) {
    const [name, url = ''] = l.split(/\s+/);
    const u = url.toLowerCase().replace(/\.git$/, '');
    if (want && (u.endsWith(`github.com/${want}`) || u.endsWith(`github.com:${want}`))) return name;
  }
  return 'origin';
}

const refName = (b) => {
  if (typeof b !== 'string' || !b || b.startsWith('-') || /[\s\0]/.test(b)) throw new Error(`not a branch name: ${JSON.stringify(b)}`);
  return b;
};

// Remote-tracking refs for the named branches. -> true when the fetch ran clean.
export function fetchBranches(repo, slug, branches) {
  branches.forEach(refName);
  if (stubPath()) return true;
  const remote = remoteFor(repo, slug);
  return tryGit(repo, ['fetch', '--quiet', '--no-tags', remote, ...branches.map((b) => `+refs/heads/${b}:refs/remotes/${remote}/${b}`)]) !== null;
}

export const revParse = (repo, ref) => tryGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim() || null;
// The ref a branch is read from: what the remote has, never a local branch
// that may be behind it (tests have no remote).
export function branchRef(repo, slug, branch) {
  refName(branch);
  const remote = `${remoteFor(repo, slug)}/${branch}`;
  if (revParse(repo, `refs/remotes/${remote}`)) return remote;
  return stubPath() && revParse(repo, `refs/heads/${branch}`) ? branch : null;
}
export const tip = (repo, slug, branch) => {
  const ref = branchRef(repo, slug, branch);
  return ref ? revParse(repo, ref) : null;
};
export const defaultBranch = (repo) => tryGit(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.trim().replace(/^origin\//, '') || null;
export const countCommits = (repo, from, to) => {
  const n = tryGit(repo, ['rev-list', '--count', `${from}..${to}`]);
  return n === null ? null : Number(n.trim());
};

// The pull requests a range carries, read from the subjects GitHub writes when
// it merges one. Subjects only: bodies cite other PRs. Newest first.
// -> [{ number, title }]
export function prsInRange(repo, from, to, cap = 100) {
  // A commit pushed straight to the branch with "(#N)" at the end of its subject reads as a pull request here too.
  const raw = tryGit(repo, ['log', '--format=%s%x1f%b%x1e', `${from}..${to}`]) || '';
  const out = [];
  const seen = new Set();
  for (const rec of raw.split('\x1e')) {
    const [subject = '', body = ''] = rec.replace(/^\n+/, '').split('\x1f');
    let number = null;
    let title = '';
    const merge = subject.match(/^Merge pull request #(\d+) from /);
    const squash = subject.match(/^(.*\S)\s+\(#(\d+)\)$/);
    if (merge) {
      number = Number(merge[1]);
      title = body.split('\n').map((l) => l.trim()).find(Boolean) || '';
    } else if (squash) {
      number = Number(squash[2]);
      title = squash[1];
    }
    if (number === null || seen.has(number)) continue;
    seen.add(number);
    out.push({ number, title });
  }
  return { prs: out.slice(0, cap), more: Math.max(0, out.length - cap) };
}

// What merging `source` into `target` would give, without touching anything.
// -> { state: clean|diverged|conflict|unknown, files: [] }
//   diverged: it merges, but the result is not the source's tree, so the target
//   carries something the source lacks.
export function mergeResult(repo, target, source) {
  let stdout;
  let conflict = false;
  try {
    stdout = git(repo, ['merge-tree', '--write-tree', '--name-only', target, source]);
  } catch (e) {
    if (e.status !== 1) return { state: 'unknown', files: [], why: firstLine(e) };
    conflict = true;
    stdout = String(e.stdout || '');
  }
  const lines = stdout.split('\n');
  if (conflict) {
    const end = lines.indexOf('', 1);
    return { state: 'conflict', files: lines.slice(1, end === -1 ? undefined : end).filter(Boolean).slice(0, 10) };
  }
  const tree = lines[0].trim();
  const want = tryGit(repo, ['rev-parse', '--verify', '--quiet', `${source}^{tree}`])?.trim();
  if (!tree || !want) return { state: 'unknown', files: [], why: 'the merged tree could not be read' };
  if (tree === want) return { state: 'clean', files: [] };
  const files = (tryGit(repo, ['diff', '--name-only', '--no-ext-diff', source, tree]) || '').split('\n').filter(Boolean);
  return { state: 'diverged', files: files.slice(0, 10), total: files.length };
}

const prRow = (v) => ({ number: v.number, title: v.title || '', url: v.url || null, head: v.headRefName || '', head_sha: v.headRefOid || null, fork: Boolean(v.isCrossRepository) });

// Open PRs into a branch. -> [{ number, title, url, head, head_sha, fork }] or null when it could not be read.
export function openPrsInto(repo, base) {
  if (stubPath()) return (stub().open_prs?.[base] || []).map(prRow);
  try {
    return JSON.parse(gh(repo, ['pr', 'list', '--base', refName(base), '--state', 'open', '--limit', '30', '--json', 'number,title,url,headRefName,headRefOid,isCrossRepository'])).map(prRow);
  } catch {
    return null;
  }
}

// One state per check, whatever shape GitHub gave it in.
const FAIL = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale', 'error'];
const OK = ['success', 'neutral', 'skipped'];
export function checkState(c) {
  const status = String(c.status || '').toLowerCase();
  const end = String(c.conclusion || c.state || '').toLowerCase();
  if (FAIL.includes(end)) return 'fail';
  if (OK.includes(end)) return 'ok';
  // Finished with a word this script does not know: not a pass.
  if (status === 'completed' && end) return 'fail';
  return 'pending';
}
const checkRow = (c) => ({ name: String(c.name || c.context || 'check'), state: checkState(c) });

export function prView(repo, n) {
  let v;
  if (stubPath()) {
    v = stub().prs?.[String(n)];
    if (!v) throw new Error(`PR #${n} not found`);
  } else {
    try {
      v = JSON.parse(gh(repo, ['pr', 'view', String(n), '--json', 'number,state,title,url,baseRefName,headRefName,headRefOid,isDraft,isCrossRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,mergeCommit']));
    } catch (e) {
      throw new Error(`PR #${n} not found (${firstLine(e)})`);
    }
  }
  return {
    ...prRow(v), base: v.baseRefName, state: String(v.state || 'OPEN').toUpperCase(), draft: Boolean(v.isDraft),
    mergeable: String(v.mergeable || 'UNKNOWN').toUpperCase(), merge_state: String(v.mergeStateStatus || 'UNKNOWN').toUpperCase(), review: v.reviewDecision || null,
    checks: (v.statusCheckRollup || []).map(checkRow), merge_sha: v.mergeCommit?.oid || null,
  };
}

// Checks and commit statuses on one commit. -> [{ name, state }] or null when it could not be read.
export function commitChecks(repo, slug, sha) {
  if (stubPath()) return (stub().checks?.[sha] || []).map(checkRow);
  try {
    const runs = api(repo, `repos/${slug}/commits/${sha}/check-runs?per_page=100`);
    const status = api(repo, `repos/${slug}/commits/${sha}/status?per_page=100`);
    const rows = [...(runs.check_runs || []), ...(status.statuses || [])];
    // More checks than one page holds: a failure could sit on the next one, so this is not a reading.
    if ((runs.total_count || 0) > (runs.check_runs || []).length || (status.total_count || 0) > (status.statuses || []).length) return null;
    return rows.map(checkRow);
  } catch {
    return null;
  }
}

// Workflow runs for one commit. -> [{ id, name, path, branch, state, url }] or null.
export function workflowRuns(repo, slug, sha) {
  const row = (r) => ({ id: r.id, name: r.name || '', path: String(r.path || '').split('@')[0], branch: r.head_branch || null, state: checkState(r), url: r.html_url || null });
  if (stubPath()) return (stub().runs?.[sha] || []).map(row);
  try {
    return (api(repo, `repos/${slug}/actions/runs?head_sha=${sha}&per_page=50`).workflow_runs || []).map(row);
  } catch {
    return null;
  }
}

// GitHub deployments of one commit (Vercel, Netlify and Render report here).
// -> [{ environment, state: ok|fail|pending, url }] or null.
export function deployments(repo, slug, sha) {
  const state = (s) => (['success'].includes(s) ? 'ok' : ['failure', 'error'].includes(s) ? 'fail' : 'pending');
  if (stubPath()) return (stub().deployments?.[sha] || []).map((d) => ({ environment: d.environment || '', state: state(String(d.state || '').toLowerCase()), url: d.url || null }));
  try {
    const list = api(repo, `repos/${slug}/deployments?sha=${sha}&per_page=10`);
    return list.map((d) => {
      let s = '';
      let url = null;
      try {
        const [latest] = api(repo, `repos/${slug}/deployments/${d.id}/statuses?per_page=1`);
        s = String(latest?.state || '').toLowerCase();
        url = latest?.environment_url || latest?.target_url || null;
      } catch {}
      return { environment: d.environment || '', state: state(s), url };
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the two writes
// -> { number, url }
export function createPr(repo, { base, head, title, body }) {
  refName(base);
  refName(head);
  if (stubPath()) {
    const s = stub();
    called({ call: 'create', base, head, title, body });
    if (s.create?.error) throw new Error(s.create.error);
    return { number: s.create?.number ?? 1, url: s.create?.url ?? `https://github.com/${s.slug}/pull/${s.create?.number ?? 1}` };
  }
  let url;
  try {
    url = gh(repo, ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body-file', '-'], body).trim().split('\n').pop();
  } catch (e) {
    throw new Error(`GitHub refused the pull request: ${firstLine(e)}`);
  }
  const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
  if (!number) throw new Error(`the pull request was created but its number could not be read from ${JSON.stringify(url)}`);
  return { number, url };
}

// Merges only if the PR head is still `sha`. No flag that skips a rule, waits
// for one, or removes a branch: the argument list is all there is.
export const mergeArgs = (n, method, sha) => ['pr', 'merge', String(n), `--${method}`, '--match-head-commit', sha];
// -> { sha } the merge commit, or null when GitHub has not reported it yet.
export function mergePr(repo, n, method, sha) {
  if (!Number.isInteger(n) || !/^[0-9a-f]{40}$/.test(String(sha))) throw new Error('merge needs a PR number and a full commit id');
  const args = mergeArgs(n, method, sha);
  if (stubPath()) {
    const s = stub();
    called({ call: 'merge', args });
    if (s.merge?.error) throw new Error(s.merge.error);
    return { sha: s.merge?.sha ?? null };
  }
  try {
    gh(repo, args);
  } catch (e) {
    throw new Error(`GitHub refused the merge: ${firstLine(e)}`);
  }
  try {
    return { sha: prView(repo, n).merge_sha };
  } catch {
    return { sha: null };
  }
}
