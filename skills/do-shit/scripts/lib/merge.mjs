// Merge + QA phases, PR text, tracker text and the final report.
// Local reads (gh pr view, gh run view) run here; every outward write
// (merge, push, status, comment) is returned as an action for the orchestrator.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as S from './state.mjs';
import * as Q from './questions.mjs';
import * as A from './autonomy.mjs';
import * as P from './policy.mjs';
import { loadConfig } from './repo.mjs';
import { mergeOrder } from './planner.mjs';

const itemById = (run, id) => run.items.find((i) => i.id === id);
const isMigration = (f) => /(^|\/)(migrations?|drizzle)\/|\.sql$/i.test(f);

// ---------------------------------------------------------------- PR + tracker text
export function prTitle(run, item, config = {}) {
  const tpl = config.pr_title || (run.tracker === 'github' ? '{title}' : run.tracker === 'linear' ? '[{ref}] {title}' : '{title} [{ref}]');
  return tpl.replace('{title}', item.title).replace('{ref}', item.ref);
}

export function prLabels(run, item, ls, config = {}) {
  const labels = [...(config.labels?.always || [])];
  const files = [
    ...(item.plan?.files || []),
    ...ls.loops.flatMap((l) => Object.values(l.reports).flatMap((r) => r.files_touched || [])),
  ];
  if (files.some(isMigration)) labels.push(...(config.labels?.migration || []));
  if (ls.outcome === 'draft_flagged') labels.push('agent-tests-failed');
  return [...new Set(labels)];
}

const parentRef = (run, item) => (item.parent ? itemById(run, item.parent) || { ref: item.parent } : null);

export function prBody(run, item, ls) {
  const parent = parentRef(run, item);
  // Markers follow references/trackers/<tracker>.md link_pr.
  const markers = [];
  if (run.tracker === 'github') markers.push(`Closes ${item.ref}`);
  else if (run.tracker === 'linear') markers.push(`Ref ${item.ref}`, `Linear: ${item.url || ''}`);
  else markers.push(`ClickUp: ${item.ref} ${item.url || ''}`.trim());
  if (parent) {
    // Linear treats "Part of" as a linking magic word; use a plain URL there.
    if (run.tracker === 'linear') markers.push(`Parent: ${parent.url || parent.ref}`);
    else markers.push(`Part of ${parent.ref}${parent.url ? ` (${parent.url})` : ''}`);
  }
  const builds = ls.loops.flatMap((l) =>
    P.BUILD_ORDER.filter((r) => l.reports[r]).map((r) => `- **${r}** (loop ${l.n}): ${l.reports[r].summary}`),
  );
  const last = ls.loops[ls.loops.length - 1];
  const verdicts = P.REVIEW_ROLES.filter((r) => last.reports[r]).map((r) => `| ${r} | ${last.reports[r].verdict} | ${last.reports[r].findings.length} |`);
  const lines = [
    markers.join('\n'),
    '',
    '## Plan',
    item.plan?.summary || '(no plan summary)',
    '',
    '## What changed',
    builds.join('\n') || '- (no build reports)',
    '',
    '## Review (final loop)',
    '| role | verdict | findings |',
    '|---|---|---|',
    ...verdicts,
    '',
    `Loops used: ${ls.loops.length} of 3. Harness mode: ${run.mode}.`,
  ];
  if (ls.outcome === 'draft_flagged') {
    lines.push('', `## Outstanding (draft: ${ls.flag_reason})`, ...(ls.outstanding || []).map((f) => `- [${f.from}] ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\` ` : ''}${f.text}`));
  }
  lines.push('', '🤖 Generated with [Claude Code](https://claude.com/claude-code) via /do-shit');
  return lines.join('\n');
}

export function prComment(run, item, ls) {
  const url = ls.pr?.url || '(dry run)';
  const head = ls.outcome === 'ready' ? `PR ready for review: ${url}` : `Draft PR opened: ${url}. Tests still failing (${ls.flag_reason}).`;
  const lines = [head, '', item.plan?.summary || '', '', `Verification: ${ls.loops.length} loop(s). Final review: ${P.REVIEW_ROLES.filter((r) => ls.loops.at(-1).reports[r]).map((r) => `${r} ${ls.loops.at(-1).reports[r].verdict}`).join(', ')}.`];
  if (ls.outcome !== 'ready') lines.push('', 'Outstanding:', ...(ls.outstanding || []).slice(0, 8).map((f) => `- ${f.text}`), '', 'Needs a human look before merging.');
  return lines.join('\n');
}

// ---------------------------------------------------------------- gh facts (read-only)
function gh(args) {
  return execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

export function normalizeCi(rollup = []) {
  const failed = [];
  let pending = false;
  for (const c of rollup) {
    const status = c.status || (c.state === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED');
    const concl = c.conclusion || c.state;
    if (status !== 'COMPLETED') pending = true;
    else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(concl)) {
      failed.push({ name: c.name || c.context, url: c.detailsUrl || c.targetUrl || null });
    }
  }
  const ci = failed.length ? 'red' : pending ? 'pending' : rollup.length ? 'green' : 'none';
  return { ci, failed };
}

export function prFacts(run, pr) {
  if (process.env.DO_SHIT_GH_STUB && existsSync(process.env.DO_SHIT_GH_STUB)) {
    const hit = JSON.parse(readFileSync(process.env.DO_SHIT_GH_STUB, 'utf8'))[String(pr)];
    if (hit) return hit;
  }
  if (run.dry_run) return { number: pr, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', ci: 'green', failed: [], reviewDecision: null, comments: [], files: [] };
  const j = JSON.parse(gh(['pr', 'view', String(pr), '--repo', repoSlug(run), '--json',
    'number,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,headRefName,baseRefName,files,comments,reviews,author']));
  const { ci, failed } = normalizeCi(j.statusCheckRollup);
  for (const f of failed) {
    const m = f.url?.match(/\/actions\/runs\/(\d+)/);
    if (!m) continue;
    try {
      f.log_excerpt = gh(['run', 'view', m[1], '--repo', repoSlug(run), '--log-failed']).split('\n').slice(-60).join('\n');
    } catch {}
  }
  const author = j.author?.login;
  const human = (c) => c.author?.login !== author && !/\[bot\]$|bot$/i.test(c.author?.login || '');
  const comments = [...(j.comments || []), ...(j.reviews || []).filter((r) => r.body)]
    .filter(human)
    .map((c) => ({ author: c.author?.login, body: c.body, state: c.state || null }));
  return {
    number: j.number, state: j.state, isDraft: j.isDraft, mergeable: j.mergeable, mergeStateStatus: j.mergeStateStatus,
    ci, failed, reviewDecision: j.reviewDecision, comments, headRefName: j.headRefName, baseRefName: j.baseRefName,
    files: (j.files || []).map((f) => f.path),
  };
}

let _slug = null;
function repoSlug(run) {
  if (_slug) return _slug;
  _slug = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: run.repo }).toString().trim();
  return _slug;
}

// ---------------------------------------------------------------- merge gate (pure)
// Returns { decision: merge|fix|rerun|defer|skip|merged, fix?: conflict|rebase|ci|review, reason }
export function gate(f, jev, entry, mode) {
  const live = mode === 'live' && jev && !jev.degraded;
  const p = (id) => jev?.answers?.[id]?.noul ?? null;
  if (f.state === 'MERGED') return { decision: 'merged', reason: 'already merged' };
  if (f.state === 'CLOSED') return { decision: 'skip', reason: 'PR closed' };
  if (f.isDraft && !entry.picked_draft) return { decision: 'skip', reason: 'draft not selected' };
  if (f.mergeable === 'CONFLICTING' || f.mergeStateStatus === 'DIRTY') return { decision: 'fix', fix: 'conflict', reason: 'merge conflicts' };
  if (f.mergeStateStatus === 'BEHIND') return { decision: 'fix', fix: 'rebase', reason: 'branch behind base' };
  if (f.ci === 'pending') return { decision: 'defer', reason: 'CI still running' };
  if (f.ci === 'red') {
    if (!entry.reran && live && p('ci_failure_unrelated_to_pr') >= Q.THRESHOLDS.ci_failure_unrelated_to_pr) {
      return { decision: 'rerun', reason: `CI failure looks unrelated (p=${p('ci_failure_unrelated_to_pr').toFixed(2)})` };
    }
    return { decision: 'fix', fix: 'ci', reason: `CI failed: ${f.failed.map((x) => x.name).join(', ')}` };
  }
  if (f.reviewDecision === 'CHANGES_REQUESTED') return { decision: 'fix', fix: 'review', reason: 'changes requested' };
  if (f.comments?.length) {
    if (!live) return { decision: 'skip', reason: 'open review comments; Jev unavailable to judge (fallback)' };
    if (p('open_review_comments_blocking') >= Q.THRESHOLDS.open_review_comments_blocking) {
      return { decision: 'fix', fix: 'review', reason: `blocking review comments (p=${p('open_review_comments_blocking').toFixed(2)})` };
    }
  }
  if (f.mergeStateStatus === 'BLOCKED') return { decision: 'skip', reason: 'branch protection blocks merge (required reviews/checks)' };
  if (f.mergeStateStatus === 'UNKNOWN' || f.mergeable === 'UNKNOWN') return { decision: 'defer', reason: 'GitHub still computing mergeability' };
  return { decision: 'merge', reason: 'green, mergeable, no blocking reviews' };
}

// ---------------------------------------------------------------- phase: merge approval
export function mergeApprovalActions(run, teams) {
  const leaves = run.items.filter((i) => i.leaf && i.pr);
  if (!leaves.length) {
    run.phase = 'done';
    return [{ action: 'done', report: finalReport(run) }];
  }
  const order = mergeOrder(leaves.map((l) => l.id), run.plan);
  run.merge_candidates = order;
  return [{
    action: 'ask_user',
    kind: 'merge_approval',
    payload: {
      dry_run: run.dry_run,
      order: order.map((id) => {
        const it = itemById(run, id);
        const team = teams.find((t) => t.team_id === it.team);
        const ls = team?.leaf_state[id];
        return {
          leaf: id, ref: it.ref, title: it.title, pr: it.pr.number, url: it.pr.url, draft: it.pr.draft,
          outcome: it.outcome, loops: ls?.loops.length, roles: ls ? [...new Set(ls.loops.flatMap((l) => Object.keys(l.reports)))] : [],
          stacked_on: run.plan.stacks?.[id] || null,
        };
      }),
      // Gates the harness decided on its own so far: show them before anything merges.
      auto_gates: run.auto_gates || [],
    },
    answer_shape: '{ "merge": "all_green" | "none" | [pr numbers], "include_drafts": [pr numbers] }',
  }];
}

export function onAnswer(run, kind, ans) {
  if (kind === 'merge_approval') {
    const cands = (run.merge_candidates || []).map((id) => itemById(run, id));
    let picked;
    if (ans.merge === 'none') picked = [];
    else if (ans.merge === 'all_green') picked = cands.filter((i) => i.outcome === 'ready' && !i.pr.draft);
    else picked = cands.filter((i) => (ans.merge || []).includes(i.pr.number));
    for (const n of ans.include_drafts || []) {
      const it = cands.find((i) => i.pr.number === n);
      if (it && !picked.includes(it)) picked.push(it);
    }
    run.merge_plan = run.merge_candidates
      .map((id) => picked.find((p) => p.id === id))
      .filter(Boolean)
      .map((it) => ({ leaf: it.id, pr: it.pr.number, state: 'queued', picked_draft: it.pr.draft, reran: false, fixes: 0, defers: 0, log: [] }));
    run.phase = run.merge_plan.length ? 'merge' : 'done';
  } else if (kind === 'reapproval') {
    const e = run.merge_plan.find((m) => m.pr === ans.pr);
    if (e) e.state = ans.approve ? 'queued' : 'skipped';
    if (e) e.approved_after_fix = Boolean(ans.approve);
  } else if (kind === 'ci_pending') {
    for (const e of run.merge_plan) if (e.state === 'deferred') e.state = ans.continue ? 'queued' : 'skipped';
  } else if (kind === 'qa_approval') {
    run.qa = { enabled: Boolean(ans.qa), env: ans.env || null, base_url: ans.base_url || null, signed_in: Boolean(ans.signed_in), items: {} };
    run.phase = ans.qa ? 'qa' : 'qa_closeout';
    if (!ans.qa) run.phase = 'qa';
  } else if (kind === 'offers') {
    run.offers_answer = ans;
    run.phase = 'done';
  }
}

export function onMerge(run, { pr, result, detail }) {
  const e = run.merge_plan.find((m) => m.pr === pr);
  if (!e) throw new Error(`PR ${pr} not in merge plan`);
  e.state = result === 'merged' ? 'merged' : 'failed';
  e.log.push({ result, detail: detail || null, at: new Date().toISOString() });
  const it = itemById(run, e.leaf);
  it.outcome = result === 'merged' ? 'merged' : `merge failed: ${detail || ''}`;
  delete run.pending?.[`merge:${pr}`];
  S.appendEvent(run.run_id, { type: 'merge', pr, result, detail });
}

export function onTrackerRecorded(run, key) {
  if (key === 'tracker:merged_status') run.flags.merged_status = true;
  if (key.startsWith('tracker:qa:')) {
    const leaf = key.slice('tracker:qa:'.length);
    run.qa.items[leaf].closed = true;
  }
  if (key === 'tracker:qa_declined') run.flags.qa_closed = true;
}

// ---------------------------------------------------------------- phases: merge, qa
export async function nextMergeQa(run, ctx) {
  if (run.phase === 'merge_approval') {
    const teams = run.teams.map((id) => ctx.teamOf(run, id));
    return mergeApprovalActions(run, teams);
  }
  if (run.phase === 'merge') return mergePhase(run, ctx);
  if (run.phase === 'qa_approval') return [qaApprovalAction(run)];
  if (run.phase === 'qa') return qaPhase(run, ctx);
  return [];
}

async function mergePhase(run, ctx) {
  const actions = [];
  // A fix team in flight: drive it.
  const fixing = run.merge_plan.find((e) => e.state === 'fixing');
  if (fixing) {
    const team = ctx.teamOf(run, fixing.team);
    const acts = await ctx.teamStep(run, team);
    S.saveTeam(run.run_id, team);
    return acts.length ? acts : [{ action: 'wait', pending: Object.keys(run.pending) }];
  }
  if (Object.keys(run.pending).some((k) => k.startsWith('merge:') || k.startsWith('rerun:') || k === 'ci_wait')) {
    return [{ action: 'wait', pending: Object.keys(run.pending) }];
  }
  const entry = run.merge_plan.find((e) => e.state === 'queued');
  if (!entry) {
    const deferred = run.merge_plan.filter((e) => e.state === 'deferred');
    if (deferred.length) {
      // CI still running. Keep gating inside ci_wait_minutes, then skip the PR
      // and report it; with autonomy off, ask as before.
      const config = loadConfig(run.repo);
      const decided = deferred.map((e) => [e, A.ciPendingGate({ config, entry: e })]);
      if (decided.some(([, d]) => d === 'ask')) {
        return [{ action: 'ask_user', kind: 'ci_pending', payload: { prs: deferred.map((e) => e.pr) }, answer_shape: '{ "continue": true|false }' }];
      }
      const minutes = Number(config.ci_wait_minutes ?? 20);
      const waiting = [];
      for (const [e, d] of decided) {
        if (d === 'skip') {
          e.state = 'skipped';
          e.skip_reason = `CI still pending after ${minutes} min`;
          A.recordAutoGate(run, { gate: 'ci_pending', decision: 'skip', ref: e.pr, reason: e.skip_reason });
          continue;
        }
        e.state = 'queued';
        if (!e.ci_first_pending_at) e.ci_first_pending_at = new Date().toISOString();
        if (!e.ci_wait_logged) {
          e.ci_wait_logged = true;
          A.recordAutoGate(run, { gate: 'ci_pending', decision: 'continue', ref: e.pr, reason: `keeps gating for up to ${minutes} min` });
        }
        waiting.push(e.pr);
      }
      if (!waiting.length) return mergePhase(run, ctx);
      run.pending.ci_wait = { prs: waiting };
      return [{ action: 'wait_ci', prs: waiting, seconds: A.CI_RECHECK_SECONDS, dry_run: run.dry_run, record: 'record-tracker --key ci_wait' }];
    }
    if (run.merge_plan.some((e) => e.state === 'needs_reapproval')) {
      const e = run.merge_plan.find((x) => x.state === 'needs_reapproval');
      return [{ action: 'ask_user', kind: 'reapproval', payload: { pr: e.pr, leaf: e.leaf, why: e.reapproval_reason, review: e.reapproval_review || null }, answer_shape: '{ "pr": n, "approve": true|false }' }];
    }
    return mergeDone(run);
  }
  const it = itemById(run, entry.leaf);
  const f = prFacts(run, entry.pr);
  let jev = null;
  if (f.ci === 'red' || f.comments?.length) {
    jev = await ctx.jevAsk(run, 'merge_gate', Q.mergeGate({
      pr: { title: it.title, files: f.files },
      ci: { failed_checks: f.failed.map((x) => ({ name: x.name, log_excerpt: x.log_excerpt || '' })) },
      review_comments: f.comments || [],
      rebase: { before_summary: '', after_summary: '' },
    }));
  }
  const g = gate(f, jev, entry, run.mode);
  entry.log.push({ gate: g, at: new Date().toISOString() });
  S.appendEvent(run.run_id, { type: 'gate', pr: entry.pr, ...g });
  const config = loadConfig(run.repo);
  switch (g.decision) {
    case 'merged':
      entry.state = 'merged';
      it.outcome = 'merged';
      return mergePhase(run, ctx);
    case 'skip':
      entry.state = 'skipped';
      entry.skip_reason = g.reason;
      return mergePhase(run, ctx);
    case 'defer':
      entry.defers += 1;
      entry.ci_first_pending_at ??= new Date().toISOString();
      entry.state = entry.defers > 1 ? 'deferred' : 'queued';
      if (entry.state === 'queued') {
        // move to the end of the queue once
        run.merge_plan.push(run.merge_plan.splice(run.merge_plan.indexOf(entry), 1)[0]);
      }
      return mergePhase(run, ctx);
    case 'rerun':
      entry.reran = true;
      run.pending[`rerun:${entry.pr}`] = { pr: entry.pr };
      entry.state = 'deferred';
      return [{ action: 'rerun_checks', pr: entry.pr, dry_run: run.dry_run, record: `record-tracker --key rerun:${entry.pr}` }];
    case 'fix': {
      if (entry.fixes >= 2) {
        entry.state = 'skipped';
        entry.skip_reason = `still failing after 2 fix attempts: ${g.reason}`;
        return mergePhase(run, ctx);
      }
      entry.fixes += 1;
      entry.state = 'fixing';
      entry.fix_kind = g.fix;
      const team = ctx.startFixTeam(run, entry, g, f);
      entry.team = team.team_id;
      const acts = await ctx.teamStep(run, team);
      S.saveTeam(run.run_id, team);
      return acts;
    }
    case 'merge': {
      run.pending[`merge:${entry.pr}`] = { pr: entry.pr };
      const children = Object.entries(run.plan.stacks || {}).filter(([, parent]) => parent === entry.leaf).map(([child]) => itemById(run, child)?.pr?.number).filter(Boolean);
      return [{
        action: 'merge', pr: entry.pr, method: config.merge_method || 'squash', dry_run: run.dry_run,
        then_retarget: children.map((n) => ({ pr: n, base: run.base })),
        record: `record-merge --pr ${entry.pr} --result merged|failed`,
      }];
    }
    default:
      throw new Error(`bad gate decision ${g.decision}`);
  }
}

// Called by harness when a merge-fix team decides "ship": push happened, re-gate.
export function onFixPushed(run, entry, { behaviorChanged }) {
  entry.state = behaviorChanged && !entry.approved_after_fix ? 'needs_reapproval' : 'queued';
  entry.reapproval_reason = behaviorChanged ? `fix changed code beyond a clean rebase (${entry.fix_kind})` : null;
}

function mergeDone(run) {
  const merged = run.merge_plan.filter((e) => e.state === 'merged');
  if (!merged.length) {
    run.phase = 'done';
    return [{ action: 'done', report: finalReport(run) }];
  }
  if (!run.flags.merged_status && !run.pending['tracker:merged_status']) {
    run.pending['tracker:merged_status'] = {};
    const ops = merged.map((e) => ({ op: 'status', item: itemById(run, e.leaf).ref, to_type: 'qa', fallback_to_type: 'done' }));
    return [{ action: 'tracker', key: 'tracker:merged_status', dry_run: run.dry_run, ops }];
  }
  if (run.pending['tracker:merged_status']) return [{ action: 'wait', pending: Object.keys(run.pending) }];
  run.phase = 'qa_approval';
  return [qaApprovalAction(run)];
}

function qaApprovalAction(run) {
  const merged = run.merge_plan.filter((e) => e.state === 'merged').map((e) => itemById(run, e.leaf));
  return {
    action: 'ask_user',
    kind: 'qa_approval',
    payload: { items: merged.map((i) => ({ ref: i.ref, title: i.title, pr: i.pr?.url })), never_prod: true },
    answer_shape: '{ "qa": true|false, "env": "local"|"preview"|"staging", "base_url": "...", "signed_in": true|false }',
  };
}

// ---------------------------------------------------------------- QA
async function qaPhase(run, ctx) {
  const merged = run.merge_plan.filter((e) => e.state === 'merged').map((e) => itemById(run, e.leaf));
  if (!run.qa.enabled) {
    if (!run.flags.qa_closed && !run.pending['tracker:qa_declined']) {
      run.pending['tracker:qa_declined'] = {};
      return [{ action: 'tracker', key: 'tracker:qa_declined', dry_run: run.dry_run, ops: [...merged.map((i) => ({ op: 'status', item: i.ref, to_type: 'done' })), ...parentDoneOps(run, new Set(merged.map((i) => i.id)))] }];
    }
    if (run.pending['tracker:qa_declined']) return [{ action: 'wait', pending: Object.keys(run.pending) }];
    return offers(run);
  }
  const actions = [];
  const qaDir = join(S.runDir(run.run_id), 'qa');
  for (const item of merged) {
    const q = (run.qa.items[item.id] ??= { stage: 'plan', loop: 1 });
    if (q.closed) continue;
    if (q.stage === 'plan') {
      const s = ctx.spawnQa(run, 'qa-planner', item, { extra: `QA environment: ${run.qa.env} at ${run.qa.base_url}. Merged PR: ${item.pr?.url}. Summarize the merged diff with \`gh pr diff ${item.pr?.number}\`.` });
      if (s) actions.push(s);
      break; // one QA item at a time: one shared browser pane
    }
    if (q.stage === 'test') {
      const shots = join(qaDir, item.id.replace(/[^a-zA-Z0-9_-]/g, '_'));
      mkdirSync(shots, { recursive: true });
      const s = ctx.spawnQa(run, 'qa-tester', item, {
        extra: `QA environment: ${run.qa.env} at ${run.qa.base_url}. Signed in already: ${run.qa.signed_in}. Save screenshots to ${shots}/step-<n>.png.\n\n## Test plan\n${(q.plan?.test_plan || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
      });
      if (s) actions.push(s);
      break;
    }
    if (q.stage === 'judge') {
      const failures = (q.report?.qa?.steps || []).filter((s) => s.result === 'fail');
      q.bugs = [];
      q.notes = [];
      for (const step of failures) {
        const jev = await ctx.jevAsk(run, 'qa_failure', Q.qaFailure({ item: { title: item.title, acceptance_criteria: item.acceptance_criteria }, qa_step: step, merged_diff_summary: item.plan?.summary || '' }));
        const p = jev.answers?.failure_is_regression_of_item?.noul;
        const regression = run.mode === 'live' && !jev.degraded ? p >= Q.THRESHOLDS.failure_is_regression_of_item : true;
        (regression ? q.bugs : q.notes).push(step);
      }
      q.stage = 'evidence';
    }
    if (q.stage === 'evidence') {
      const key = `tracker:qa:${item.id}`;
      if (run.pending[key]) break;
      const commentFile = join(S.runDir(run.run_id), 'comments', `${item.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-qa.md`);
      mkdirSync(join(S.runDir(run.run_id), 'comments'), { recursive: true });
      writeFileSync(commentFile, qaComment(run, item, q));
      const shots = (q.report?.qa?.steps || []).map((s) => s.screenshot).filter(Boolean);
      const ops = [
        { op: 'attach', item: item.ref, files: shots, run_id: run.run_id },
        { op: 'comment', item: item.ref, body_file: commentFile, embeds_attachments: true },
        { op: 'status', item: item.ref, to_type: q.bugs.length ? 'reopened' : 'done' },
        ...q.bugs.map((b) => ({ op: 'create_child', parent: item.ref, title: `QA: ${b.action.slice(0, 80)}`, body: `Repro: ${b.action}\nExpected: ${b.expected}\nActual: ${b.actual}${b.screenshot ? `\nScreenshot: ${b.screenshot}` : ''}\nFound by /do-shit QA (${run.qa.env}).`, label: 'bug' })),
      ];
      run.pending[key] = {};
      actions.push({ action: 'tracker', key, dry_run: run.dry_run, ops });
      break;
    }
  }
  if (actions.length) return actions;
  if (merged.every((i) => run.qa.items[i.id]?.closed)) {
    if (!run.flags.parents_done && !run.pending['tracker:parents']) {
      const ops = parentDoneOps(run);
      if (ops.length) {
        run.pending['tracker:parents'] = {};
        return [{ action: 'tracker', key: 'tracker:parents', dry_run: run.dry_run, ops }];
      }
      run.flags.parents_done = true;
    }
    if (run.pending['tracker:parents']) return [{ action: 'wait', pending: Object.keys(run.pending) }];
    return offers(run);
  }
  return [{ action: 'wait', pending: Object.keys(run.pending) }];
}

export function recordQa(run, item, role, report) {
  const q = run.qa.items[item.id];
  if (role === 'qa-planner') {
    q.plan = report.plan || { test_plan: [] };
    q.stage = 'test';
  } else {
    q.report = report;
    q.stage = report.verdict === 'blocked' ? 'evidence' : 'judge';
    if (report.verdict === 'blocked') {
      q.bugs = [];
      q.notes = [{ action: 'QA blocked', expected: '', actual: report.summary, result: 'fail' }];
    }
  }
}

function qaComment(run, item, q) {
  const r = q.report?.qa || {};
  const lines = [
    `QA on ${run.qa.env} (${r.sha || 'merged main'}): ${q.bugs.length ? `${q.bugs.length} failing step(s), bug(s) filed` : 'all steps passed'}.`,
    '',
    '| # | Step | Expected | Result |',
    '|---|---|---|---|',
    ...(r.steps || []).map((s, i) => `| ${i + 1} | ${s.action} | ${s.expected} | ${s.result}${s.screenshot ? ` — {{shot:${s.screenshot}}}` : ''} |`),
    '',
    '**How it works**',
    r.walkthrough || q.report?.summary || '',
  ];
  if (q.notes?.length) lines.push('', 'Not caused by this change (noted only):', ...q.notes.map((n) => `- ${n.action}: ${n.actual}`));
  return lines.join('\n');
}

// Parents move to done when every non-excluded leaf child is done (or is
// being moved to done in the same batch: `alsoDone`).
function parentDoneOps(run, alsoDone = new Set()) {
  const parents = run.items.filter((i) => !i.leaf);
  const ops = [];
  for (const p of parents) {
    const kids = run.items.filter((i) => i.parent === p.id && i.leaf && !i.excluded);
    const allDone = kids.length && kids.every((k) => alsoDone.has(k.id) || k.status_type === 'done' || k.status_history.some((h) => h.to === 'done' && h.ok));
    if (allDone) ops.push({ op: 'status', item: p.ref, to_type: 'done' });
  }
  if (!ops.length) run.flags.parents_done = true;
  return ops;
}

function offers(run) {
  if (run.offers_answer) {
    run.phase = 'done';
    return [{ action: 'done', report: finalReport(run) }];
  }
  const bugs = Object.values(run.qa.items || {}).flatMap((q) => q.bugs || []);
  const passing = Object.entries(run.qa.items || {}).filter(([, q]) => (q.report?.qa?.steps || []).some((s) => s.result === 'pass'));
  if (!bugs.length && !passing.length) {
    run.phase = 'done';
    return [{ action: 'done', report: finalReport(run) }];
  }
  const auto = A.offersGate(loadConfig(run.repo));
  if (auto) {
    run.offers_answer = auto;
    A.recordAutoGate(run, { gate: 'offers', decision: `fix_bugs=${auto.fix_bugs}, e2e=${auto.e2e}`, reason: 'after_qa in .claude/do-shit.json' });
    run.phase = 'done';
    return [{ action: 'done', report: finalReport(run) }];
  }
  return [{
    action: 'ask_user', kind: 'offers',
    payload: { bug_children: bugs.length, e2e_candidates: passing.map(([id]) => itemById(run, id).ref) },
    answer_shape: '{ "fix_bugs": true|false, "e2e": true|false }',
  }];
}

// ---------------------------------------------------------------- report
export function finalReport(run) {
  const rows = run.items.filter((i) => i.leaf).map((i) => ({
    ref: i.ref, title: i.title, pr: i.pr?.url || null,
    result: i.excluded ? `excluded: ${i.excluded}` : i.outcome || 'in progress',
    statuses: i.status_history.map((h) => `${h.to}${h.ok ? '' : h.skipped ? ' (skipped)' : ' (failed)'}`),
    roles: i.role_reasons ? Object.keys(i.role_reasons) : [],
  }));
  return {
    run_id: run.run_id, mode: run.mode, dry_run: run.dry_run, cancelled: Boolean(run.cancelled),
    spawns_used: run.spawns_used, spawn_cap: run.spawn_cap, rows,
    merge: (run.merge_plan || []).map((e) => ({ pr: e.pr, state: e.state, reason: e.skip_reason || null, fixes: e.fixes })),
    qa: run.qa?.enabled ? Object.fromEntries(Object.entries(run.qa.items || {}).map(([k, q]) => [k, { bugs: q.bugs?.length || 0 }])) : null,
    offers: run.offers_answer || null,
    auto_gates: (run.auto_gates || []).map((g) => ({ gate: g.gate, decision: g.decision, ref: g.ref, reason: g.reason })),
  };
}
