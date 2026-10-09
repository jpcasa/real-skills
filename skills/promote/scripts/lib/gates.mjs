// The gates a promotion passes through. Each is one fact about the range, the
// source or the pull request, read by this script. A gate that could not be
// read is `unknown`: it never counts as a pass, and it is said plainly.
//
//   block    nothing is opened or merged
//   wait     something is still running: come back
//   warn     shown in the brief and again at the merge question
//   unknown  could not be read
//   pass

import * as GH from './github.mjs';

export const STATUSES = ['pass', 'warn', 'wait', 'block', 'unknown'];
export const GATES = ['range', 'merges_cleanly', 'open_pr', 'source_checks', 'source_deployed', 'infra_check', 'head_unchanged', 'pr_mergeable'];
// Verdicts of /check-infra-and-migrations, and what each does here.
export const VERDICT_STATUS = { nothing_to_check: 'pass', safe: 'pass', unverified: 'warn', caution: 'warn', blocked: 'block' };

const g = (status, says, extra = {}) => ({ status, says, ...extra });
const short = (sha) => String(sha).slice(0, 7);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const names = (xs, cap = 5) => `${xs.slice(0, cap).join(', ')}${xs.length > cap ? ` and ${xs.length - cap} more` : ''}`;

export const sameList = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
export const blocking = (gates) => Object.entries(gates).filter(([, v]) => v.status === 'block').map(([k]) => k);
export const waiting = (gates) => Object.entries(gates).filter(([, v]) => v.status === 'wait').map(([k]) => k);
export const of = (gates, status) => Object.entries(gates).filter(([, v]) => v.status === status).map(([k, v]) => ({ gate: k, says: v.says }));

export function mergesCleanly(repo, target, source) {
  const m = GH.mergeResult(repo, target.sha, source.sha);
  if (m.state === 'clean') return g('pass', `${source.branch} merges into ${target.branch} and the result is exactly ${source.branch}`);
  if (m.state === 'conflict') return g('block', `${source.branch} does not merge into ${target.branch} cleanly: ${m.files.length ? `conflicts in ${names(m.files)}` : 'conflicts'}. ${target.branch} has changes ${source.branch} lacks: merge ${target.branch} back into ${source.branch} first`, { files: m.files });
  if (m.state === 'diverged') return g('warn', `${target.branch} carries changes ${source.branch} does not have (${names(m.files)}${m.total > m.files.length ? `, ${m.total} files in all` : ''}): after the merge ${target.branch} will not be identical to what ${source.env} ran`, { files: m.files });
  return g('unknown', `whether ${source.branch} merges into ${target.branch} could not be worked out${m.why ? ` (${m.why})` : ''}`);
}

// -> { gate, pr } where pr is the open promotion PR to reuse, or null.
export function openPr(repo, target, source) {
  const open = GH.openPrsInto(repo, target.branch);
  if (open === null) return { gate: g('unknown', `the open pull requests into ${target.branch} could not be listed`), pr: null };
  const mine = open.find((p) => p.head === source.branch && !p.fork) || null;
  const others = open.filter((p) => p !== mine);
  if (others.length) return { gate: g('warn', `${plural(others.length, 'other pull request')} into ${target.branch} ${others.length === 1 ? 'is' : 'are'} open (${names(others.map((p) => `#${p.number} from ${p.head}`), 3)}): merging one moves ${target.branch} under this promotion`, { reuse: mine?.number ?? null }), pr: mine };
  return { gate: g('pass', mine ? `the promotion pull request is already open (#${mine.number}): it is reused, not doubled` : `no pull request into ${target.branch} is open`, { reuse: mine?.number ?? null }), pr: mine };
}

function summarize(checks) {
  const fail = checks.filter((c) => c.state === 'fail').map((c) => c.name);
  const pending = checks.filter((c) => c.state === 'pending').map((c) => c.name);
  return { fail, pending, ok: checks.length - fail.length - pending.length };
}

export function sourceChecks(repo, slug, source) {
  const checks = GH.commitChecks(repo, slug, source.sha);
  if (checks === null) return g('unknown', `the checks on ${short(source.sha)} could not be read`);
  if (!checks.length) return g('unknown', `no check has reported on ${short(source.sha)}: whether ${source.branch} is green is not known`);
  const s = summarize(checks);
  if (s.fail.length) return g('block', `${plural(s.fail.length, 'check')} failed on ${short(source.sha)}: ${names(s.fail)}`, { failed: s.fail });
  if (s.pending.length) return g('wait', `${plural(s.pending.length, 'check')} still running on ${short(source.sha)}: ${names(s.pending)}`, { pending: s.pending });
  return g('pass', `${plural(s.ok, 'check')} passed on ${short(source.sha)}`);
}

// A run of this workflow file, on this branch when the run says which.
export const isWorkflow = (run, file, branch) => (run.path.endsWith(`/${file}`) || run.path === file) && (!run.branch || !branch || run.branch === branch);
// Is a GitHub deployment's environment this stage? "Production" is production; "Preview" is not staging.
export const sameEnv = (name, env) => {
  const a = String(name || '').toLowerCase().trim();
  const b = String(env || '').toLowerCase().trim();
  return Boolean(a) && Boolean(b) && (a === b || a.split(/[^a-z0-9]+/).includes(b) || b.split(/[^a-z0-9]+/).includes(a));
};

// Did the source environment run exactly this commit?
export function sourceDeployed(repo, slug, source) {
  const sha = short(source.sha);
  if (source.deploy_workflow) {
    const runs = GH.workflowRuns(repo, slug, source.sha);
    if (runs === null) return g('unknown', `the runs of ${source.deploy_workflow} could not be read`);
    const mine = runs.filter((r) => isWorkflow(r, source.deploy_workflow, source.branch));
    if (mine.some((r) => r.state === 'ok')) return g('pass', `${source.deploy_workflow} succeeded for ${sha}: ${source.env} ran this commit`);
    if (mine.some((r) => r.state === 'pending')) return g('wait', `${source.deploy_workflow} is still running for ${sha}`);
    if (mine.length) return g('block', `${source.deploy_workflow} failed for ${sha}: ${source.env} never ran this commit`);
    return g('block', `${source.deploy_workflow} has no run for ${sha}: what would be promoted is not what ${source.env} ran`);
  }
  const deps = GH.deployments(repo, slug, source.sha);
  if (deps === null) return g('unknown', `the deployments of ${sha} could not be read`);
  // The same commit can be deployed to a preview: only a deployment named like this stage proves this stage ran it.
  const mine = deps.filter((d) => sameEnv(d.environment, source.env));
  if (mine.some((d) => d.state === 'ok')) return g('pass', `GitHub records a successful deployment of ${sha} to ${mine.find((d) => d.state === 'ok').environment}`);
  if (mine.some((d) => d.state === 'pending')) return g('wait', `a deployment of ${sha} to ${source.env} is still in progress`);
  if (mine.length) return g('block', `the deployment of ${sha} to ${source.env} failed: ${source.env} never ran this commit`);
  if (deps.length) return g('unknown', `GitHub records deployments of ${sha} only to ${names([...new Set(deps.map((d) => d.environment || 'unnamed'))], 3)}, none named like ${source.env}: whether ${source.env} ran this commit is not known`);
  return g('unknown', `no deploy workflow is configured for ${source.env} and GitHub records no deployment of ${sha}: whether ${source.env} ran this commit was not checked`);
}

// infra: { state: none|pending|recorded|missing, verdict?, run?, reason?, blockers? }, accepted: {at, blockers} | null
export function infraCheck(infra, accepted) {
  if (!infra || infra.state === 'missing') return g('unknown', `migrations and infrastructure were not checked: ${infra?.reason || 'no check ran'}`);
  if (infra.state === 'pending') return g('wait', `this range changes migrations or infrastructure: run check-infra-and-migrations for run ${infra.run}, then call check`, { check_run: infra.run });
  const status = VERDICT_STATUS[infra.verdict];
  if (!status) return g('unknown', `check-infra-and-migrations gave a verdict this script does not know: ${infra.verdict}`);
  if (infra.verdict === 'nothing_to_check') return g('pass', `no migration or infrastructure change in this range${infra.detected ? ' (by the paths check-infra-and-migrations detected: it has no config for this repo)' : ''}`);
  // An acceptance covers the blockers that were read out, word for word, and nothing else.
  if (status === 'block' && accepted && sameList(accepted.blockers, infra.blockers)) return g('warn', `check-infra-and-migrations says blocked (${plural(infra.blockers?.length || 0, 'blocker')}); accepted for this run at ${accepted.at}`, { verdict: infra.verdict, accepted: true });
  return g(status, `check-infra-and-migrations says ${infra.verdict}${infra.counts ? ` (${plural(infra.counts.blocker || 0, 'blocker')}, ${plural(infra.counts.risk || 0, 'risk')})` : ''}`, { verdict: infra.verdict });
}

// Is everything still the commit the brief and the check covered?
export function headUnchanged(run, now) {
  // Tips read from refs that could not be refreshed prove nothing about what the remote has now.
  if (now.fetched === false) return g('block', `${run.source.branch} and ${run.target.branch} could not be fetched: whether they moved since the brief is not known, and nothing is opened or merged on that`);
  const moved = [];
  if (now.source !== run.source.sha) moved.push(`${run.source.branch} moved from ${short(run.source.sha)} to ${now.source ? short(now.source) : 'nothing'}`);
  if (now.target !== run.target.sha) moved.push(`${run.target.branch} moved from ${short(run.target.sha)} to ${now.target ? short(now.target) : 'nothing'}`);
  if (now.pr_head !== undefined && now.pr_head !== run.source.sha) moved.push(`the pull request head is ${now.pr_head ? short(now.pr_head) : 'unknown'}, not ${short(run.source.sha)}`);
  if (moved.length) return g('block', `${moved.join('; ')}. The brief and the checks cover the old commits: this run is over, start a new one`, { moved: true });
  return g('pass', `${run.source.branch} and ${run.target.branch} are where the brief left them`);
}

// What GitHub says about merging this pull request. Nothing here is retried or worked around.
const MERGE_STATE = {
  CLEAN: ['pass', 'GitHub says it can be merged'],
  HAS_HOOKS: ['pass', 'GitHub says it can be merged'],
  UNSTABLE: ['warn', 'GitHub allows the merge, with a check that is not required failing or still running'],
  BLOCKED: ['block', 'GitHub blocks the merge: a required review or a required check is missing'],
  BEHIND: ['block', 'GitHub requires the head branch to be up to date with the base first'],
  DIRTY: ['block', 'the pull request has merge conflicts'],
  DRAFT: ['block', 'the pull request is a draft'],
  UNKNOWN: ['wait', 'GitHub has not worked out yet whether it can be merged'],
};
export function prMergeable(pr) {
  if (pr.state !== 'OPEN') return g('block', `#${pr.number} is ${pr.state.toLowerCase()}`);
  if (pr.draft) return g('block', MERGE_STATE.DRAFT[1]);
  const s = summarize(pr.checks);
  if (pr.mergeable === 'CONFLICTING') return g('block', MERGE_STATE.DIRTY[1]);
  const [status, says] = MERGE_STATE[pr.merge_state] || ['unknown', `GitHub reports a merge state this script does not know: ${pr.merge_state}`];
  const detail = [s.fail.length && `failed: ${names(s.fail)}`, s.pending.length && `running: ${names(s.pending)}`, pr.review && pr.review !== 'APPROVED' && `review: ${String(pr.review).toLowerCase().replace(/_/g, ' ')}`].filter(Boolean).join('; ');
  // A check still running on a merge GitHub would allow: wait for it rather than merge under it.
  if (status !== 'block' && s.pending.length) return g('wait', `${plural(s.pending.length, 'check')} still running on #${pr.number}: ${names(s.pending)}`, { pending: s.pending });
  // A reviewer asked for changes and GitHub would still merge: said again at the merge question.
  const final = status === 'pass' && pr.review === 'CHANGES_REQUESTED' ? 'warn' : status;
  return g(final, `${says}${detail ? ` (${detail})` : ''}`, { failed: s.fail });
}
