// Every `gh` call /fix-ci makes. All of them read, except one: rerunJob asks
// GitHub to run one failed job again, and only after the user said yes. The
// skill never comments on, reviews, merges, retargets or closes a pull request.
//
// FIX_CI_GH_STUB (tests) points at a JSON file that answers them:
//   { slug, current_pr: <n>|null, prs: { "<n>": view }, mine: [view],
//     checks: { "<head sha>": [rollup row] },
//     jobs: { "<job id>": { log, annotations: [], run_attempt, passed_before } },
//     base: { "<workflow name>": { "<job name>": "success"|"failure" } } }
// A rerun is appended to <stub>.reruns.jsonl. Git itself is never stubbed.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const BIG = 128 * 1024 * 1024;
const stubPath = () => process.env.FIX_CI_GH_STUB || null;
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
const JOB_URL = /\/actions\/runs\/(\d+)\/job\/(\d+)/;
// -> { name, workflow, state, conclusion, url, actions, run_id, job_id }
export function checkRow(c) {
  const url = c.detailsUrl || c.targetUrl || null;
  const m = JOB_URL.exec(url || '');
  return {
    name: String(c.name || c.context || 'check'), workflow: c.workflowName || null, state: checkState(c),
    conclusion: String(c.conclusion || c.state || '').toLowerCase() || null, url,
    actions: Boolean(m), run_id: m ? m[1] : null, job_id: m ? m[2] : null,
  };
}

const FIELDS = 'number,state,title,url,baseRefName,headRefName,headRefOid,isCrossRepository,mergeable,author,statusCheckRollup';
const view = (p, rollup) =>
  p && {
    number: p.number, state: p.state, title: String(p.title || ''), url: p.url,
    base: p.baseRefName, head: p.headRefName, head_sha: p.headRefOid, fork: p.isCrossRepository === true,
    mergeable: p.mergeable || 'UNKNOWN', author: p.author?.login || null,
    checks: (rollup ?? p.statusCheckRollup ?? []).map(checkRow),
  };
const stubView = (p) => p && view(p, stub().checks?.[p.headRefOid] ?? p.statusCheckRollup ?? []);

// -> the pull request with the checks of its head, or null when GitHub has none by that number.
export function prView(repo, number) {
  if (stubPath()) return stubView(stub().prs?.[String(number)]) || null;
  return view(tryJson(repo, ['pr', 'view', String(number), '--json', FIELDS])) || null;
}

// The pull request of the branch this checkout is on. -> number or null
export function currentPr(repo) {
  if (stubPath()) return stub().current_pr ?? null;
  return tryJson(repo, ['pr', 'view', '--json', 'number'])?.number ?? null;
}

// The user's open pull requests with a failed check.
// -> [{ number, title, head, url, failed }], or null when they could not be listed.
export function myFailing(repo) {
  const list = stubPath() ? (stub().mine ?? []).map(stubView) : tryJson(repo, ['pr', 'list', '--author', '@me', '--state', 'open', '--limit', '50', '--json', FIELDS])?.map((p) => view(p));
  if (!Array.isArray(list)) return null;
  return list.filter((p) => !p.fork && p.checks.some((c) => c.state === 'fail')).map((p) => ({ number: p.number, title: p.title, head: p.head, url: p.url, failed: p.checks.filter((c) => c.state === 'fail').length }));
}

// The whole log of one job, or null when GitHub no longer has it.
export function jobLog(repo, slug, jobId) {
  if (stubPath()) return stub().jobs?.[String(jobId)]?.log ?? null;
  try {
    return gh(repo, ['api', `repos/${slug}/actions/jobs/${jobId}/logs`]);
  } catch {
    return null;
  }
}

// What the job's tools reported against files: [{ path, start_line, annotation_level, title, message }]
export function annotations(repo, slug, jobId) {
  if (stubPath()) return stub().jobs?.[String(jobId)]?.annotations ?? [];
  const list = tryJson(repo, ['api', `repos/${slug}/check-runs/${jobId}/annotations?per_page=50`]);
  return Array.isArray(list) ? list : [];
}

// Did this job pass in an earlier attempt of the same run, on the same commit?
// -> true, false, or null when it could not be read.
export function passedBefore(repo, slug, row) {
  if (stubPath()) return stub().jobs?.[String(row.job_id)]?.passed_before ?? false;
  const job = tryJson(repo, ['api', `repos/${slug}/actions/jobs/${row.job_id}`]);
  if (!job) return null;
  const attempt = Number(job.run_attempt || 1);
  for (let k = attempt - 1; k >= 1 && k >= attempt - 3; k--) {
    const jobs = tryJson(repo, ['api', `repos/${slug}/actions/runs/${row.run_id}/attempts/${k}/jobs?per_page=100`])?.jobs;
    if (!Array.isArray(jobs)) return null;
    if (jobs.some((j) => j.name === row.name && j.conclusion === 'success')) return true;
  }
  return false;
}

// The jobs of the base branch's latest finished run of one workflow.
// -> { "<job name>": 'ok'|'fail'|'pending' }, or null when there is none to read.
export function baseJobs(repo, slug, base, workflow) {
  if (stubPath()) {
    const jobs = stub().base?.[workflow];
    return jobs ? Object.fromEntries(Object.entries(jobs).map(([name, conclusion]) => [name, checkState({ status: 'completed', conclusion })])) : null;
  }
  const runs = tryJson(repo, ['api', `repos/${slug}/actions/runs?branch=${encodeURIComponent(base)}&status=completed&per_page=30`])?.workflow_runs;
  const last = Array.isArray(runs) ? runs.find((r) => r.name === workflow && r.head_branch === base) : null;
  if (!last) return null;
  const jobs = tryJson(repo, ['api', `repos/${slug}/actions/runs/${last.id}/jobs?per_page=100`])?.jobs;
  return Array.isArray(jobs) ? Object.fromEntries(jobs.map((j) => [j.name, checkState(j)])) : null;
}

// The one write: run one failed job again. Throws when GitHub refuses.
export function rerunJob(repo, jobId) {
  if (stubPath()) {
    appendFileSync(`${stubPath()}.reruns.jsonl`, `${JSON.stringify({ job: String(jobId) })}\n`);
    return;
  }
  gh(repo, ['run', 'rerun', '--job', String(jobId)]);
}
