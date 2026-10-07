#!/usr/bin/env node
// /do-shit harness. Owns run state and every loop decision; Jev supplies
// judgments, code applies policy. Prints exactly ONE JSON object to stdout.
//
//   init           --repo <abs> --base <b> --tracker <t> [--verify <cmd>] [--dry-run] [--cap N] [--mode shadow|live]   (stdin: {items})
//   next           --run <id>
//   record         --run <id> --leaf <id> --role <r> --agent <name>      (stdin: agent final message)
//   record-pr      --run <id> --leaf <id> --number <n> --url <u> [--draft]
//   record-tracker --run <id> --key <k>                                    (stdin: {results:[{item, op, ok, detail?}]})
//   record-answer  --run <id> --kind architect_failed|checkpoint|merge_approval|qa_approval|… (stdin: answer JSON)
//   record-merge   --run <id> --pr <n> --result merged|failed [--detail ..]
//   record-push    --run <id> --leaf <id> --pr <n>                       (after a merge-fix force-with-lease push)
//   status         --run <id>
//   reissue        --run <id>      clear in-flight markers so pending work is re-emitted (resume)
//   jev-smoke
//   eval           run Jev calibration over scripts/eval/fixtures (live API)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './lib/state.mjs';
import { validate } from './lib/validate.mjs';
import { checkCaps, capsMessage } from './lib/caps.mjs';
import { ask } from './lib/jev.mjs';
import * as Q from './lib/questions.mjs';
import * as P from './lib/policy.mjs';
import * as G from './lib/git.mjs';
import { loadConfig, resolveAgent, allowedPaths } from './lib/repo.mjs';
import { REPORT_SCHEMA } from './lib/paths.mjs';
import { buildPrompt } from './lib/prompts.mjs';
import { computePlan } from './lib/planner.mjs';
import * as M from './lib/merge.mjs';
import * as A from './lib/autonomy.mjs';

// ---------------------------------------------------------------- utils
function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const a = { _: cmd };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i].replace(/^--/, '');
    if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) a[k] = true;
    else a[k] = rest[++i];
  }
  return a;
}
const readStdin = () => {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const slugify = (s, n = 40) => {
  const x = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (x.length <= n) return x;
  const cut = x.slice(0, n);
  return cut.includes('-') ? cut.slice(0, cut.lastIndexOf('-')) : cut;
};
const refSlug = (ref) => slugify(String(ref).replace(/^#/, 'gh-'), 20);
const agentName = (role, item) => `${role}-${refSlug(item.ref)}-${slugify(item.title, 24)}`;
const itemById = (run, id) => run.items.find((i) => i.id === id);
const activeLeaves = (run) => run.items.filter((i) => i.leaf && !i.excluded);

// Jev wrapper: stubbable, degrades the run on failure, logs every call.
async function jevAsk(run, kind, built) {
  let res;
  if (process.env.DO_SHIT_JEV_STUB) {
    const stub = JSON.parse(readFileSync(process.env.DO_SHIT_JEV_STUB, 'utf8'));
    const answers = {};
    for (const [id, q] of Object.entries(built.questions)) {
      const key = Object.keys(stub).find((k) => k === id || (k.endsWith('*') && id.startsWith(k.slice(0, -1))));
      const v = key !== undefined ? stub[key] : null;
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: v ?? 0.1 };
      if (q.type === 'choice') answers[id] = { type: 'choice', choice: v ?? Object.keys(q.criteria)[0], confidence: 0.9, probabilities: {} };
      if (q.type === 'score') answers[id] = { type: 'score', score: v ?? 0, confidence: 0.9 };
    }
    res = { answers, degraded: stub.__degraded === true };
  } else if (run.mode === 'degraded') {
    res = { answers: {}, degraded: true, error: 'run already degraded' };
  } else {
    res = await ask(built);
  }
  if (res.degraded && run.mode !== 'degraded') {
    run.mode = 'degraded';
    S.appendEvent(run.run_id, { type: 'jev_degraded', kind, error: res.error });
  }
  S.appendEvent(run.run_id, { type: 'jev', kind, mode: run.mode, answers: res.answers, error: res.error });
  return res;
}

function pend(run, key, info) {
  run.pending ??= {};
  run.pending[key] = { ...info, at: new Date().toISOString() };
}
const isPending = (run, key) => Boolean(run.pending?.[key]);
const unpend = (run, key) => {
  if (run.pending) delete run.pending[key];
};

// ---------------------------------------------------------------- init
function cmdInit(a) {
  const { items = [] } = JSON.parse(readStdin() || '{}');
  const repo = a.repo;
  const config = loadConfig(repo);
  const run = S.newRun({
    repo,
    base: a.base || config.base || 'main',
    tracker: a.tracker,
    dryRun: Boolean(a['dry-run']),
    spawnCap: Number(a.cap || config.spawn_cap || 60),
    mode: a.mode || 'shadow',
  });
  run.verify = a.verify || config.verify || null;
  run.owner = G.ownerPrefix(repo);
  run.items = items.map((it) => ({
    ...it,
    leaf: Boolean(it.leaf),
    excluded: it.excluded || null,
    status_initial: it.status || null,
    status_type_initial: it.status_type || null,
    status_type: it.status_type || null,
    status_history: [],
    team: null,
    pr: null,
    outcome: null,
    plan: null,
    roles: null,
  }));
  run.phase = 'plan';
  run.flags = {};
  run.pending = {};
  S.saveRun(run);
  S.appendEvent(run.run_id, { type: 'init', items: run.items.length, dry_run: run.dry_run, mode: run.mode });
  out({
    run_id: run.run_id,
    leaves: activeLeaves(run).map((i) => i.ref),
    umbrellas: run.items.filter((i) => !i.leaf).map((i) => i.ref),
    excluded: run.items.filter((i) => i.excluded).map((i) => ({ ref: i.ref, why: i.excluded })),
  });
}

// ---------------------------------------------------------------- spawn helper
function spawnAction(run, { role, item, team = null, leafState = null, loopObj = null, failures = [], extra = '' }) {
  const loop = loopObj?.n ?? 1;
  const name = leafState?.agents?.[role] || item.agents?.[role] || agentName(role, item);
  const reuse = Boolean(leafState?.agents?.[role] || item.agents?.[role]);
  const { agent, source } = resolveAgent(run.repo, role);
  const key = `spawn:${name}:L${loop}`;
  if (isPending(run, key)) return null;
  if (!reuse) run.spawns_used += 1;
  if (leafState && loopObj) {
    loopObj.sha_before[role] = G.headSha(leafState.worktree);
  }
  const promptFile = buildPrompt(run.run_id, {
    role, name, loop, item, repo: run.repo,
    worktree: leafState?.worktree, branch: leafState?.branch, base_ref: leafState?.base_ref,
    verify: run.verify, plan: item.plan, contract: item.contract, failures, notes: item.notes, extra,
  });
  pend(run, key, { role, leaf: item.id, team, name, loop, via: reuse ? 'message' : 'new' });
  return { action: 'spawn', via: reuse ? 'message' : 'new', role, subagent_type: agent, agent_source: source, name, leaf: item.id, loop, prompt_file: promptFile, background: true };
}

// ---------------------------------------------------------------- plan phase
async function planPhase(run) {
  const actions = [];
  for (const item of activeLeaves(run)) {
    if (item.plan) continue;
    const s = spawnAction(run, { role: 'investigator', item });
    if (s) actions.push(s);
  }
  if (Object.keys(run.pending).some((k) => k.startsWith('spawn:'))) {
    return actions.length ? actions : [{ action: 'wait', pending: Object.keys(run.pending) }];
  }
  // All investigators reported: pick roles and plan.
  const leaves = activeLeaves(run).filter((i) => !i.roles);
  await Promise.all(
    leaves.map(async (item) => {
      const jev = await jevAsk(run, 'role_pick', Q.roleNeeds({
        item: { title: item.title, body: item.body, acceptance_criteria: item.acceptance_criteria },
        plan: { summary: item.plan.summary, files: item.plan.files },
      }));
      const config = loadConfig(run.repo);
      const pr = P.pickRoles({
        mode: run.mode, jev, planFiles: item.plan.files || [],
        pathRules: [...P.DEFAULT_PATH_RULES, ...(config.path_rules || [])],
      });
      item.roles = pr.roles;
      item.role_reasons = pr.reasons;
      if (pr.shadow) S.appendEvent(run.run_id, { type: 'shadow_roles', leaf: item.id, fallback: pr.roles, jev_roles: pr.shadow.jev_roles });
    }),
  );
  // Pairwise overlap + dependency (one Jev request) and the architect trigger.
  if (!run.flags.pairwise) {
    run.flags.pairwise = true;
    const L = activeLeaves(run);
    const fileOverlap = {};
    for (let i = 0; i < L.length; i++) {
      for (let j = i + 1; j < L.length; j++) {
        const a = new Set(L[i].plan.files || []);
        const b = L[j].plan.files || [];
        const inter = b.filter((f) => a.has(f)).length;
        const union = new Set([...a, ...b]).size || 1;
        fileOverlap[[L[i].id, L[j].id].sort().join('|')] = inter / union >= 0.2 ? 1 : inter / union;
      }
    }
    const overlap = { ...fileOverlap };
    const jevDeps = {};
    let shares = Object.values(fileOverlap).some((v) => v > 0);
    if (L.length >= 2) {
      const pairs = [];
      for (let i = 0; i < L.length && pairs.length < 45; i++) for (let j = i + 1; j < L.length && pairs.length < 45; j++) pairs.push([i, j]);
      const state = { leaves: L.map((l) => ({ id: l.ref, title: l.title, body: (l.body || '').slice(0, 1500), plan_summary: l.plan.summary, files: l.plan.files })) };
      const built = Q.pairwise(state, pairs);
      Object.assign(built.questions, Q.sharesInterface(state).questions);
      const jev = await jevAsk(run, 'pairwise', built);
      if (run.mode === 'live' && !jev.degraded) {
        for (const [i, j] of pairs) {
          const k = [L[i].id, L[j].id].sort().join('|');
          overlap[k] = Math.max(overlap[k] || 0, Q.normScore(jev.answers[`overlap__${i}__${j}`], 3));
          jevDeps[`${L[i].id}>${L[j].id}`] = jev.answers[`depends__${i}__${j}`]?.noul;
          jevDeps[`${L[j].id}>${L[i].id}`] = jev.answers[`depends__${j}__${i}`]?.noul;
        }
        shares = jev.answers.shares_interface?.noul >= Q.THRESHOLDS.shares_interface;
      }
      if (shares) {
        const parent = run.items.find((i) => !i.leaf) || L[0];
        const synthetic = {
          id: '__architect__', ref: parent.ref, title: `Shared contract for ${parent.title}`, url: parent.url,
          body: L.map((l) => `### ${l.ref} ${l.title}\n${l.plan.summary}\nFiles: ${(l.plan.files || []).join(', ')}`).join('\n\n'),
          acceptance_criteria: [],
        };
        run.architect_item = synthetic;
        run.architect_failed = null;
        run.plan_inputs = { overlap, jevDeps };
        const s = spawnAction(run, { role: 'architect', item: synthetic });
        S.appendEvent(run.run_id, { type: 'architect', reason: run.mode === 'live' ? 'jev shares_interface' : 'plans share files' });
        return [s];
      }
    }
    run.plan_inputs = { overlap, jevDeps };
  }
  // The architect was asked for but neither reported nor failed: `reissue`
  // cleared its spawn. Spawn it again rather than plan without a contract.
  if (run.architect_item && run.contract == null && !run.architect_failed && !Object.values(run.pending).some((p) => p.role === 'architect')) {
    const s = spawnAction(run, { role: 'architect', item: run.architect_item });
    if (s) return [s];
  }
  if (Object.keys(run.pending).some((k) => k.startsWith('spawn:'))) return [{ action: 'wait', pending: Object.keys(run.pending) }];
  // The architect failed. The first time, retry it (same agent, by message)
  // without asking; after that the user picks retry, no contract, or cancel.
  if (run.architect_failed && !run.architect_failed.resolution) {
    if (run.flags.architect_retried || !A.autonomyOn(loadConfig(run.repo))) return [architectFailedAction(run)];
    run.flags.architect_retried = true;
    run.architect_item.agents = { ...(run.architect_item.agents || {}), architect: run.architect_failed.agent };
    run.architect_failed.resolution = 'retry';
    A.recordAutoGate(run, { gate: 'architect_failed', decision: 'retry', reason: `first failure (${run.architect_failed.error}); retried once` });
  }
  if (run.architect_failed?.resolution === 'retry') {
    const { error } = run.architect_failed;
    run.architect_failed = null;
    return [spawnAction(run, {
      role: 'architect', item: run.architect_item,
      extra: `## Retry\nYour previous report could not be recorded (${error}). Reply with the full report again: exactly one fenced \`\`\`json block, the contract in plan.summary.`,
    })];
  }
  run.plan = computePlan({
    leaves: activeLeaves(run), overlap: run.plan_inputs.overlap, jevDeps: run.plan_inputs.jevDeps,
    mode: run.mode, thresholds: Q.THRESHOLDS, architect: Boolean(run.contract),
  });
  // Checkpoint: pass it without asking only when no veto fires and Jev sees
  // nothing for a person to review. Vetoes skip the Jev call: they ask anyway.
  const config = loadConfig(run.repo);
  let review = { would: false, auto: false, vetoes: A.checkpointVetoes(run), p: null };
  if (!review.vetoes.length) {
    const L = activeLeaves(run);
    const jev = await jevAsk(run, 'plan_review', Q.planReview({
      leaves: L.map((l) => ({
        ref: l.ref, title: l.title, body: (l.body || '').slice(0, 1500), acceptance_criteria: l.acceptance_criteria,
        plan_summary: l.plan.summary, files: l.plan.files, risks: l.plan.risks || [],
      })),
      teams: run.plan.teams.length, stacks: run.plan.stacks,
    }));
    review = A.checkpointGate({ run, config, jev });
  }
  if (review.auto) {
    A.recordAutoGate(run, { gate: 'checkpoint', decision: 'proceed', p: review.p, reason: `no veto; plan_needs_human_review p=${review.p.toFixed(2)}` });
    run.phase = 'build';
    return buildPhase(run);
  }
  if (review.would) A.recordShadowGate(run, { gate: 'checkpoint', decision: 'proceed', p: review.p, blocked_by: A.blockedBy(run, config, 'plan_needs_human_review') });
  run.checkpoint_review = {
    p: review.p, vetoes: review.vetoes,
    would_auto_proceed: review.would, not_auto_because: review.would ? A.blockedBy(run, config, 'plan_needs_human_review') : null,
  };
  run.phase = 'checkpoint';
  return [checkpointAction(run)];
}

function architectFailedAction(run) {
  return {
    action: 'ask_user',
    kind: 'architect_failed',
    payload: {
      agent: run.architect_failed.agent, error: run.architect_failed.error,
      leaves: activeLeaves(run).map((i) => ({ id: i.id, ref: i.ref, title: i.title })),
    },
    answer_shape: '{ "choice": "retry" | "proceed" | "cancel" }',
  };
}

function checkpointAction(run) {
  return {
    action: 'ask_user',
    kind: 'checkpoint',
    payload: {
      mode: run.mode,
      dry_run: run.dry_run,
      leaves: activeLeaves(run).map((i) => ({
        id: i.id, ref: i.ref, title: i.title,
        plan: i.plan?.summary, files: i.plan?.files?.length ?? 0,
        open_questions: i.plan?.open_questions || [], risks: i.plan?.risks || [],
        roles: i.role_reasons,
      })),
      excluded: run.items.filter((i) => i.excluded).map((i) => ({ ref: i.ref, why: i.excluded, uncovered: i.plan?.uncovered_parent_work })),
      teams: run.plan.teams, waves: run.plan.waves, stacks: run.plan.stacks, warnings: run.plan.warnings || [],
      architect_contract: run.contract || null,
      architect_failed: run.architect_failed || null,
      spawn_estimate: run.plan.estimate, spawns_used: run.spawns_used, spawn_cap: run.spawn_cap,
      // Why this was asked instead of decided: vetoes, or Jev not allowed to decide.
      review: run.checkpoint_review || null,
    },
    answer_shape: '{ "proceed": true, "exclude": [ids], "notes": {id: text}, "replan": [ids], "spawn_cap": n }',
  };
}

// ---------------------------------------------------------------- build phase
function teamOf(run, teamId) {
  return S.loadTeam(run.run_id, teamId);
}

function startLeaf(run, team, leafId) {
  const item = itemById(run, leafId);
  const stackParent = run.plan.stacks?.[leafId];
  const parentLs = stackParent ? findLeafState(run, stackParent) : null;
  const slug = `${refSlug(item.ref)}-${slugify(item.title, 32)}`;
  const worktree = join(run.repo, '.claude/worktrees', `ds-${slug}`);
  const branch = `${run.owner}/${slug}`;
  const from = parentLs ? parentLs.branch : G.baseRef(run.repo, run.base);
  G.addWorktree(run.repo, worktree, branch, from);
  const roles = item.roles.filter((r) => r !== 'investigator');
  team.leaf_state[leafId] = {
    worktree, branch, base_ref: from, base_branch: parentLs ? parentLs.branch : run.base,
    stage: 'build', agents: {}, pr: null, outcome: null,
    loops: [{ n: 1, roles, reports: {}, sha_before: {}, failures: [], extra_failures: [], decision: null }],
  };
  team.current_leaf = leafId;
  team.stage = 'build';
  team.loop = 1;
  item.team = team.team_id;
  S.appendEvent(run.run_id, { type: 'leaf_start', team: team.team_id, leaf: leafId, worktree, branch, from, roles });
}

function findLeafState(run, leafId) {
  const item = itemById(run, leafId);
  if (!item?.team) return null;
  return teamOf(run, item.team).leaf_state[leafId] || null;
}

const curLoop = (ls) => ls.loops[ls.loops.length - 1];

async function teamStep(run, team) {
  const leaf = team.current_leaf;
  const ls = team.leaf_state[leaf];
  const item = itemById(run, leaf);
  const L = curLoop(ls);
  const acts = [];

  if (ls.stage === 'replan') {
    if (!L.reports.investigator) {
      const s = spawnAction(run, { role: 'investigator', item, team: team.team_id, leafState: ls, loopObj: L, failures: L.failures });
      if (s) acts.push(s);
      return acts;
    }
    item.plan = L.reports.investigator.plan || item.plan;
    L.roles = item.roles.filter((r) => r !== 'investigator');
    ls.stage = 'build';
  }

  if (ls.stage === 'build') {
    const nextRole = P.buildSequence(L.roles).find((r) => !L.reports[r]);
    if (nextRole) {
      const s = spawnAction(run, { role: nextRole, item, team: team.team_id, leafState: ls, loopObj: L, failures: L.failures.filter((f) => f.owner_role === nextRole) });
      if (s) acts.push(s);
      return acts;
    }
    ls.stage = 'review';
  }

  if (ls.stage === 'review') {
    const missing = P.reviewSet(L.roles).filter((r) => !L.reports[r]);
    if (missing.length) {
      for (const r of missing) {
        const s = spawnAction(run, { role: r, item, team: team.team_id, leafState: ls, loopObj: L });
        if (s) acts.push(s);
      }
      return acts;
    }
    ls.stage = 'decide';
  }

  if (ls.stage === 'decide') {
    const agg = P.aggregate(Object.values(L.reports));
    if (L.extra_failures.length) {
      agg.pass = false;
      agg.failures.push(...L.extra_failures);
    }
    let jev = null;
    if (!agg.pass) {
      const prev = ls.loops.length > 1 ? ls.loops[ls.loops.length - 2].failures : [];
      jev = await jevAsk(run, 'loop_decision', Q.loopDecision({
        item: { title: item.title, acceptance_criteria: item.acceptance_criteria },
        plan: { summary: item.plan?.summary, files: item.plan?.files },
        loop: L.n,
        current_failures: agg.failures.map((f) => ({ from: f.from, owner: f.owner_role, text: f.text, file: f.file })),
        previous_failures: prev.map((f) => ({ from: f.from, text: f.text, file: f.file })),
        review_summary: Object.values(L.reports).filter((r) => P.REVIEW_ROLES.includes(r.role)).map((r) => `${r.role}: ${r.verdict}`).join(', '),
      }));
    }
    let d = P.nextLoopAction({ loop: L.n, maxLoops: team.max_loops, agg, jev, mode: run.mode });
    if (d.action === 'fix' || d.action === 'replan') {
      const roles = d.action === 'replan' ? ['investigator', ...item.roles.filter((r) => r !== 'investigator')] : P.loopRoles(agg);
      const newSpawns = roles.filter((r) => !ls.agents[r]).length;
      if (!P.canSpawn(run, newSpawns)) d = { action: 'draft_flagged', reason: 'spawn cap reached' };
      else {
        ls.loops.push({ n: L.n + 1, roles, reports: {}, sha_before: {}, failures: agg.failures, extra_failures: [], decision: null });
        team.loop = L.n + 1;
        ls.stage = d.action === 'replan' ? 'replan' : 'build';
      }
    }
    L.decision = d;
    S.appendEvent(run.run_id, { type: 'decision', team: team.team_id, leaf, loop: L.n, ...d });
    if (ls.kind === 'merge_fix') {
      const entry = run.merge_plan.find((e) => e.team === team.team_id);
      if (d.action === 'ship') ls.stage = 'push';
      else if (d.action === 'draft_flagged') {
        entry.state = 'skipped';
        entry.skip_reason = `merge fix failed: ${d.reason}`;
        finishFixTeam(run, team, leaf);
      }
      S.saveTeam(run.run_id, team);
      return ls.stage === 'push' ? teamStep(run, team) : [];
    }
    if (d.action === 'ship' || d.action === 'draft_flagged') {
      ls.stage = 'pr';
      ls.outcome = d.action === 'ship' ? 'ready' : 'draft_flagged';
      ls.flag_reason = d.action === 'draft_flagged' ? d.reason : null;
      ls.outstanding = d.action === 'draft_flagged' ? agg.failures : [];
    }
    S.saveTeam(run.run_id, team);
    return teamStep(run, team);
  }

  if (ls.stage === 'push') {
    const key = `push:${leaf}`;
    if (isPending(run, key)) return acts;
    const entry = run.merge_plan.find((e) => e.team === team.team_id);
    pend(run, key, { leaf });
    acts.push({
      action: 'push', leaf, pr: entry.pr, dry_run: run.dry_run, worktree: ls.worktree, branch: ls.branch,
      force_with_lease: true, record: `record-push --leaf ${leaf} --pr ${entry.pr}`,
    });
    return acts;
  }

  if (ls.stage === 'pr') {
    const key = `pr:${leaf}`;
    if (isPending(run, key)) return acts;
    const body = M.prBody(run, item, ls);
    const dir = join(S.runDir(run.run_id), 'pr');
    mkdirSync(dir, { recursive: true });
    const bodyFile = join(dir, `${refSlug(item.ref)}.md`);
    writeFileSync(bodyFile, body);
    const config = loadConfig(run.repo);
    pend(run, key, { leaf });
    acts.push({
      action: 'pr', leaf, team: team.team_id, dry_run: run.dry_run,
      worktree: ls.worktree, branch: ls.branch, base_branch: ls.base_branch,
      rebase_onto: ls.base_branch === run.base ? `origin/${run.base}` : ls.base_branch,
      draft: ls.outcome === 'draft_flagged',
      title: M.prTitle(run, item, config),
      body_file: bodyFile,
      labels: M.prLabels(run, item, ls, config),
    });
    return acts;
  }

  if (ls.stage === 'close') {
    const key = `tracker:close:${leaf}`;
    if (isPending(run, key)) return acts;
    const dir = join(S.runDir(run.run_id), 'comments');
    mkdirSync(dir, { recursive: true });
    const commentFile = join(dir, `${refSlug(item.ref)}-pr.md`);
    writeFileSync(commentFile, M.prComment(run, item, ls));
    const ops = [
      { op: 'comment', item: item.ref, body_file: commentFile },
      { op: 'status', item: item.ref, to_type: 'review' },
    ];
    if (ls.outcome === 'draft_flagged') ops.push({ op: 'label', item: item.ref, label: 'agent-tests-failed' });
    pend(run, key, { leaf });
    acts.push({ action: 'tracker', key, dry_run: run.dry_run, ops });
    return acts;
  }
  return acts;
}

function finishLeaf(run, team, leaf) {
  const ls = team.leaf_state[leaf];
  const rm = G.removeWorktree(run.repo, ls.worktree);
  S.appendEvent(run.run_id, { type: 'leaf_done', leaf, outcome: ls.outcome, worktree_removed: rm.ok, error: rm.error });
  ls.stage = 'done';
  itemById(run, leaf).outcome = ls.outcome;
  const idx = team.leaves.indexOf(leaf);
  const nextLeaf = team.leaves.slice(idx + 1).find((l) => !itemById(run, l).excluded);
  if (nextLeaf) {
    const est = itemById(run, nextLeaf).roles.length - 1;
    if (P.canSpawn(run, est)) startLeaf(run, team, nextLeaf);
    else {
      for (const l of team.leaves.slice(idx + 1)) itemById(run, l).outcome ??= 'not_started: spawn cap';
      team.stage = 'done';
      team.outcome = 'done';
    }
  } else {
    team.stage = 'done';
    team.outcome = 'done';
  }
}

// Merge-phase fix team on an existing PR branch.
function startFixTeam(run, entry, g, facts) {
  const item = itemById(run, entry.leaf);
  const orig = findLeafState(run, entry.leaf);
  const branch = facts.headRefName || orig?.branch;
  const worktree = join(run.repo, '.claude/worktrees', `ds-fix-${entry.pr}`);
  G.addWorktree(run.repo, worktree, branch, branch);
  const roles = g.fix === 'conflict' || g.fix === 'rebase' ? ['integrator', 'tester'] : ['worker', 'tester'];
  const failures = [];
  if (g.fix === 'conflict' || g.fix === 'rebase') {
    failures.push({ from: 'merge-gate', owner_role: 'integrator', severity: 'bug', blocking: true, text: `Rebase ${branch} onto origin/${run.base} and resolve conflicts (${g.reason}). Do not add behavior.` });
  } else if (g.fix === 'ci') {
    for (const c of facts.failed || []) failures.push({ from: 'ci', owner_role: 'worker', severity: 'bug', blocking: true, text: `CI check "${c.name}" failed.${c.log_excerpt ? `\n\`\`\`\n${c.log_excerpt}\n\`\`\`` : ''}` });
  } else {
    for (const c of facts.comments || []) failures.push({ from: `review:${c.author}`, owner_role: 'worker', severity: 'bug', blocking: true, text: c.body });
  }
  const team = S.newTeam(run.run_id, { leaves: [entry.leaf], roles, teamId: `m${entry.pr}-${entry.fixes}` });
  team.max_loops = 2;
  team.current_leaf = entry.leaf;
  team.stage = 'build';
  team.loop = 1;
  team.leaf_state[entry.leaf] = {
    kind: 'merge_fix', worktree, branch, base_ref: `origin/${run.base}`, base_branch: run.base,
    stage: 'build', agents: {}, pr: item.pr, outcome: null,
    loops: [{ n: 1, roles, reports: {}, sha_before: {}, failures, extra_failures: [], decision: null }],
  };
  S.saveTeam(run.run_id, team);
  S.appendEvent(run.run_id, { type: 'fix_team', pr: entry.pr, fix: g.fix, roles, worktree });
  return team;
}

function finishFixTeam(run, team, leaf) {
  const ls = team.leaf_state[leaf];
  const rm = G.removeWorktree(run.repo, ls.worktree);
  ls.stage = 'done';
  team.stage = 'done';
  team.outcome = 'done';
  S.appendEvent(run.run_id, { type: 'fix_team_done', team: team.team_id, worktree_removed: rm.ok });
}

async function cmdRecordPush(a) {
  const run = S.loadRun(a.run);
  const entry = run.merge_plan.find((e) => e.pr === Number(a.pr));
  const team = teamOf(run, entry.team);
  const ls = team.leaf_state[a.leaf];
  unpend(run, `push:${a.leaf}`);
  // Did the fix change behavior beyond a clean rebase?
  let behaviorChanged = true;
  if (entry.fix_kind === 'conflict' || entry.fix_kind === 'rebase') {
    const integ = ls.loops.flatMap((l) => (l.reports.integrator ? [l.reports.integrator] : []));
    const jev = await jevAsk(run, 'rebase_check', Q.mergeGate({
      pr: { title: itemById(run, a.leaf).title, files: [] },
      ci: { failed_checks: [] },
      review_comments: [],
      rebase: { before_summary: itemById(run, a.leaf).plan?.summary || '', after_summary: integ.map((r) => r.summary).join('\n') },
    }));
    const p = jev.answers?.behavior_changed_after_rebase?.noul;
    if (run.mode === 'live' && !jev.degraded && typeof p === 'number') behaviorChanged = p >= Q.THRESHOLDS.behavior_changed_after_rebase;
  }
  M.onFixPushed(run, entry, { behaviorChanged });
  if (entry.state === 'needs_reapproval') await reviewFix(run, entry, ls);
  finishFixTeam(run, team, a.leaf);
  S.saveTeam(run.run_id, team);
  S.saveRun(run);
  S.appendEvent(run.run_id, { type: 'push', pr: entry.pr, behavior_changed: behaviorChanged, next_state: entry.state });
  out({ ok: true, state: entry.state });
}

// A fix changed an approved PR. Re-approve it without asking only when no
// veto fires and Jev says the fix stayed inside the item. Runs before the fix
// worktree is removed: the changed files come from git, not from reports.
async function reviewFix(run, entry, ls) {
  const item = itemById(run, entry.leaf);
  const config = loadConfig(run.repo);
  const first = Object.values(ls.loops[0].sha_before)[0];
  const touched = first ? G.changedSince(ls.worktree, first) : null;
  let review = { would: false, auto: false, vetoes: A.reapprovalVetoes({ ls, item, touched }), p: null };
  if (!review.vetoes.length) {
    const reports = ls.loops.flatMap((l) => Object.values(l.reports));
    const jev = await jevAsk(run, 'fix_scope', Q.fixScope({
      item: { title: item.title, acceptance_criteria: item.acceptance_criteria },
      plan: { summary: item.plan?.summary, files: item.plan?.files },
      fix: { kind: entry.fix_kind, asked: ls.loops[0].failures.map((f) => f.text), summaries: reports.map((r) => `${r.role}: ${r.summary}`), files_touched: touched || [] },
    }));
    review = A.reapprovalGate({ run, config, ls, item, jev, touched });
  }
  if (review.auto) {
    entry.state = 'queued';
    entry.approved_after_fix = true;
    A.recordAutoGate(run, { gate: 'reapproval', decision: 'approve', ref: entry.pr, p: review.p, reason: `tester passed, fix inside the plan; fix_stays_within_item_scope p=${review.p.toFixed(2)}` });
    return;
  }
  const blocked = review.would ? A.blockedBy(run, config, 'fix_stays_within_item_scope') : null;
  if (review.would) A.recordShadowGate(run, { gate: 'reapproval', decision: 'approve', ref: entry.pr, p: review.p, blocked_by: blocked });
  entry.reapproval_review = { p: review.p, vetoes: review.vetoes, would_auto_approve: review.would, not_auto_because: blocked };
}

function spawnQa(run, role, item, { extra }) {
  return spawnAction(run, { role, item, loopObj: null, extra });
}

async function buildPhase(run) {
  const actions = [];
  const config = loadConfig(run.repo);
  if (!run.teams.length) {
    for (const t of run.plan.teams) {
      const leaves = t.leaves.filter((l) => !itemById(run, l).excluded);
      if (!leaves.length) continue;
      const team = S.newTeam(run.run_id, { leaves, roles: [], teamId: t.team_id });
      S.saveTeam(run.run_id, team);
      run.teams.push(team.team_id);
    }
  }
  const maxConc = config.max_concurrent_teams || 3;
  const teams = run.teams.map((id) => teamOf(run, id));
  let active = teams.filter((t) => t.stage !== 'queued' && t.stage !== 'done').length;
  const waveOf = (leaf) => run.plan.waves.findIndex((w) => w.includes(leaf));
  const blockedByStack = (leaf) => {
    const parent = run.plan.stacks?.[leaf];
    if (!parent) return false;
    const pls = findLeafState(run, parent);
    return !pls || !['close', 'done'].includes(pls.stage) || !pls.pr;
  };
  for (const team of teams) {
    if (team.stage !== 'queued') continue;
    if (active >= maxConc) break;
    const first = team.leaves[0];
    if (blockedByStack(first)) continue;
    if (waveOf(first) > 0 && teams.some((t) => t.stage !== 'done' && t.leaves.some((l) => waveOf(l) < waveOf(first) && !itemById(run, l).outcome && !run.plan.stacks?.[first]))) continue;
    const est = itemById(run, first).roles.length - 1;
    if (!P.canSpawn(run, est)) {
      for (const l of team.leaves) itemById(run, l).outcome ??= 'not_started: spawn cap';
      team.stage = 'done';
      team.outcome = 'done';
      S.saveTeam(run.run_id, team);
      continue;
    }
    startLeaf(run, team, first);
    S.saveTeam(run.run_id, team);
    active++;
  }
  for (const team of teams) {
    if (team.stage === 'queued' || team.stage === 'done') continue;
    actions.push(...(await teamStep(run, team)));
    S.saveTeam(run.run_id, team);
  }
  const allDone = teams.every((t) => t.stage === 'done');
  if (allDone && !Object.keys(run.pending).length) {
    run.phase = 'merge_approval';
    return M.mergeApprovalActions(run, teams);
  }
  if (!actions.length) actions.push({ action: 'wait', pending: Object.keys(run.pending) });
  return actions;
}

// ---------------------------------------------------------------- tracker status
// Items move to in_progress on the run's first `next`, before planning. An
// item the run then drops (excluded, never started, run cancelled) goes back
// to the exact status it had at init, but only while it still sits in an
// in_progress-class status: a human's move in between wins.
const movedToInProgress = (item) => item.status_history.some((s) => s.to === 'in_progress' && s.ok && !s.skipped);
const dropped = (run, item) => Boolean(run.cancelled || item.excluded || String(item.outcome || '').startsWith('not_started'));
const hasLiveLeaf = (run, parent) =>
  run.items.some((k) => k.parent === parent.id && (k.leaf ? !dropped(run, k) : hasLiveLeaf(run, k)));

function statusActions(run) {
  const actions = [];
  if (['plan', 'checkpoint', 'build'].includes(run.phase) && !run.cancelled && !run.flags.in_progress && !isPending(run, 'tracker:in_progress')) {
    const ops = run.items.filter((i) => !i.excluded).map((i) => ({ op: 'status', item: i.ref, to_type: 'in_progress' }));
    if (ops.length) {
      pend(run, 'tracker:in_progress', {});
      actions.push({ action: 'tracker', key: 'tracker:in_progress', dry_run: run.dry_run, ops });
    } else run.flags.in_progress = true;
  }
  if (!isPending(run, 'tracker:in_progress') && !isPending(run, 'tracker:restore')) {
    const ops = run.items
      .filter((i) => !i.status_restored && i.status_initial && movedToInProgress(i) && (i.leaf ? dropped(run, i) : run.cancelled || !hasLiveLeaf(run, i)))
      .map((i) => ({ op: 'restore_status', item: i.ref, to_name: i.status_initial, to_type: i.status_type_initial || 'open', only_if_type: 'in_progress' }));
    if (ops.length) {
      pend(run, 'tracker:restore', {});
      actions.push({ action: 'tracker', key: 'tracker:restore', dry_run: run.dry_run, ops });
    }
  }
  return actions;
}

// ---------------------------------------------------------------- next
async function cmdNext(a) {
  const run = S.loadRun(a.run);
  const status = statusActions(run);
  let actions;
  if (run.phase === 'done' && status.length) {
    // Restore statuses before handing back the final report.
    S.saveRun(run);
    out({ run_id: run.run_id, phase: run.phase, mode: run.mode, spawns_used: run.spawns_used, spawn_cap: run.spawn_cap, actions: status });
    return;
  }
  switch (run.phase) {
    case 'plan':
      actions = await planPhase(run);
      break;
    case 'checkpoint':
      actions = [checkpointAction(run)];
      break;
    case 'build':
      actions = await buildPhase(run);
      break;
    case 'merge_approval':
    case 'merge':
    case 'qa_approval':
    case 'qa':
      actions = await M.nextMergeQa(run, { jevAsk, teamOf, teamStep, startFixTeam, spawnQa });
      break;
    case 'done':
      actions = [{ action: 'done', report: M.finalReport(run) }];
      break;
    default:
      throw new Error(`unknown phase ${run.phase}`);
  }
  if (status.length) actions = [...status, ...actions.filter((x) => x.action !== 'wait')];
  S.saveRun(run);
  out({ run_id: run.run_id, phase: run.phase, mode: run.mode, spawns_used: run.spawns_used, spawn_cap: run.spawn_cap, actions });
}

// ---------------------------------------------------------------- record
// A JSON string may itself hold ``` (a summary quoting ```ts code), so the
// first fence after the opener is not necessarily the closer. Try each later
// fence until the text between parses; the last opener that parses wins. An
// opener needs a real newline after ```json, which valid JSON strings can't
// contain, so an opener is never matched inside a string.
export function extractReport(text) {
  const openers = [...text.matchAll(/```json[ \t]*\r?\n/g)].map((m) => m.index + m[0].length);
  if (!openers.length) return { error: 'no fenced ```json block found' };
  let firstError = null;
  for (let o = openers.length - 1; o >= 0; o--) {
    const body = text.slice(openers[o]);
    const closers = [...body.matchAll(/```/g)].map((m) => m.index);
    if (!closers.length) {
      firstError ??= 'unterminated ```json block';
      continue;
    }
    for (const c of closers) {
      try {
        return { report: JSON.parse(body.slice(0, c)) };
      } catch (e) {
        firstError ??= `json parse: ${e.message}`;
      }
    }
  }
  return { error: firstError };
}

// A twice-invalid result stays replaceable by a valid late report until
// something downstream has consumed it. Returns { rec } or { blocked }.
function replaceableInvalid(run, a) {
  const rec = run.invalid_records?.[a.agent];
  if (!rec || rec.role !== a.role || rec.leaf !== a.leaf) return null;
  if (a.role === 'qa-planner' || a.role === 'qa-tester') return { blocked: 'QA results are not replaceable' };
  if (!rec.entry.team && (a.role === 'architect' || a.role === 'investigator')) {
    return ['plan', 'checkpoint'].includes(run.phase) ? { rec } : { blocked: `planning is over (phase ${run.phase})` };
  }
  const ls = teamOf(run, rec.entry.team || itemById(run, a.leaf).team).leaf_state[a.leaf];
  const L = ls && curLoop(ls);
  if (!L || L.n !== rec.entry.loop || L.decision) return { blocked: `loop ${rec.entry.loop} is already decided` };
  if (a.role === 'investigator' && ls.stage !== 'replan') return { blocked: 'the replan already used it' };
  return { rec };
}

function cmdRecord(a) {
  const run = S.loadRun(a.run);
  const text = readStdin();
  const item = a.leaf === '__architect__' ? run.architect_item : itemById(run, a.leaf);
  if (!item) throw new Error(`unknown leaf ${a.leaf}`);
  const key = Object.keys(run.pending).find((k) => k.startsWith(`spawn:${a.agent}:`)) ||
    Object.keys(run.pending).find((k) => run.pending[k].role === a.role && run.pending[k].leaf === a.leaf);
  const prior = key ? null : replaceableInvalid(run, a);
  if (!key && !prior?.rec) {
    throw new Error(`no pending spawn for ${a.agent} (${a.role} on ${a.leaf})${prior?.blocked ? `; its invalid result can't be replaced: ${prior.blocked}` : ''}`);
  }
  const entry = key ? run.pending[key] : prior.rec.entry;

  let { report, error } = extractReport(text);
  if (!error) {
    const v = validate('report', report);
    if (!v.ok) error = v.errors.slice(0, 8).join('; ');
  }
  if (error && prior) {
    // Replacing needs a valid report; the stored failure stands.
    out({ ok: false, replaced: false, error: `still invalid: ${error}` });
    return;
  }
  let failed = null;
  if (error) {
    if (!entry.reasked) {
      entry.reasked = true;
      S.saveRun(run);
      out({ ok: false, action: 'reask', to: a.agent, message: `Your report is invalid: ${error}. Reply with ONLY the corrected fenced \`\`\`json block matching ${REPORT_SCHEMA}.` });
      return;
    }
    // Invalid twice: the role failed. Never store the error text as a plan or
    // contract; keep the spawn so a valid late report can replace the failure.
    failed = error;
    run.invalid_records ??= {};
    run.invalid_records[a.agent] = { role: a.role, leaf: a.leaf, entry: { ...entry }, error, at: new Date().toISOString() };
    S.appendEvent(run.run_id, { type: 'role_failed', role: a.role, leaf: a.leaf, agent: a.agent, error });
    report = {
      role: a.role, item: item.ref, loop: entry.loop, verdict: 'fail', summary: `invalid report: ${error}`, invalid: true,
      findings: [{ severity: 'bug', blocking: true, owner_role: P.BUILD_ORDER.includes(a.role) ? a.role : 'worker', text: `${a.role} returned an invalid report twice` }],
      files_touched: [], commits: [],
    };
  } else if (!prior) {
    // Valid but too long: one re-ask (shared with the invalid-report one),
    // then accept it as it is.
    const caps = checkCaps(text, report);
    if (!caps.ok) {
      if (!entry.reasked) {
        entry.reasked = true;
        S.saveRun(run);
        out({ ok: false, action: 'reask', to: a.agent, message: capsMessage(caps.over) });
        return;
      }
      S.appendEvent(run.run_id, { type: 'verbose_report', role: a.role, leaf: a.leaf, agent: a.agent, over: caps.over });
    }
    if (run.invalid_records?.[a.agent]) delete run.invalid_records[a.agent];
  } else {
    delete run.invalid_records[a.agent];
    S.appendEvent(run.run_id, { type: 'replaced', role: a.role, leaf: a.leaf, agent: a.agent, was: prior.rec.error });
  }
  if (key) unpend(run, key);
  const done = (o) => out(failed ? { ok: false, action: 'role_failed', role: a.role, leaf: a.leaf, error: failed, ...o } : { ok: true, ...(prior ? { replaced: true } : {}), ...o });

  if (a.role === 'architect') {
    if (failed) {
      run.architect_failed = { agent: a.agent, error: failed };
      S.saveRun(run);
      done({ stored: 'none', next: 'call next: it asks the user whether to retry the architect, proceed without a contract, or cancel' });
      return;
    }
    const contract = [report.plan?.summary || report.summary, (report.plan?.files || []).length ? `Files: ${report.plan.files.join(', ')}` : ''].filter(Boolean).join('\n');
    run.contract = contract;
    run.architect_failed = null;
    for (const it of activeLeaves(run)) it.contract = contract;
    // A contract landing after the checkpoint was built changes the plan.
    if (run.phase === 'checkpoint') run.phase = 'plan';
    S.saveRun(run);
    S.appendEvent(run.run_id, { type: 'record', role: 'architect', verdict: report.verdict });
    done({ stored: 'contract' });
    return;
  }

  if (a.role === 'qa-planner' || a.role === 'qa-tester') {
    M.recordQa(run, item, a.role, report);
    S.saveRun(run);
    S.appendEvent(run.run_id, { type: 'record', role: a.role, leaf: a.leaf, verdict: report.verdict });
    done({ stored: 'qa' });
    return;
  }

  // Plan-phase investigator (no team yet).
  if (!entry.team && a.role === 'investigator') {
    item.plan = failed ? null : report.plan || null;
    item.agents = { ...(item.agents || {}), investigator: a.agent };
    if (prior) item.excluded = null;
    if (failed) item.excluded = 'investigator returned an invalid report twice';
    else if (!item.plan) item.excluded = 'investigator returned no plan';
    else if (report.plan.premise_valid === false) item.excluded = 'bad premise';
    else if (report.plan.other_repo) item.excluded = 'other repo';
    item.investigator_summary = failed ? null : report.summary;
    if (prior) {
      // Re-plan with this leaf back in: roles, pairwise and the checkpoint rerun.
      item.roles = null;
      run.flags.pairwise = false;
      run.phase = 'plan';
    }
    S.saveRun(run);
    S.appendEvent(run.run_id, { type: 'record', role: a.role, leaf: a.leaf, verdict: report.verdict, excluded: item.excluded });
    done({ stored: failed ? 'none' : 'plan', excluded: item.excluded });
    return;
  }

  const team = teamOf(run, entry.team || item.team);
  const ls = team.leaf_state[a.leaf];
  const L = curLoop(ls);
  ls.agents[a.role] = a.agent;
  // A replaced report re-runs the checks below; drop what the failed one added.
  if (prior) L.extra_failures = L.extra_failures.filter((f) => f.by_role !== a.role);

  // Scope check against the worktree.
  let scope = { ok: true };
  if (ls.worktree && L.sha_before[a.role]) {
    const changed = G.changedSince(ls.worktree, L.sha_before[a.role]);
    const dirty = G.isDirty(ls.worktree);
    scope = P.scopeCheck({
      role: a.role, readOnly: P.READ_ONLY_ROLES.has(a.role),
      allowedPaths: allowedPaths(a.role, loadConfig(run.repo)), changedFiles: changed, dirty,
    });
    if (!scope.ok) {
      L.extra_failures.push({
        severity: 'bug', blocking: true, from: 'harness', by_role: a.role, file: scope.outside?.[0],
        owner_role: P.READ_ONLY_ROLES.has(a.role) ? 'worker' : a.role,
        text: `${scope.reason}. Revert those changes.`,
      });
    }
  }
  if (P.BUILD_ORDER.includes(a.role) && report.verdict === 'blocked') {
    L.extra_failures.push({ severity: 'bug', blocking: true, from: a.role, by_role: a.role, owner_role: a.role, text: `${a.role} blocked: ${report.summary}` });
  }
  L.reports[a.role] = report;
  S.saveTeam(run.run_id, team);
  S.saveRun(run);
  S.appendEvent(run.run_id, { type: 'record', role: a.role, leaf: a.leaf, loop: L.n, verdict: report.verdict, findings: report.findings.length, scope_ok: scope.ok });
  done({ stored: 'report', loop: L.n, scope });
}

function cmdRecordPr(a) {
  const run = S.loadRun(a.run);
  const item = itemById(run, a.leaf);
  const team = teamOf(run, item.team);
  const ls = team.leaf_state[a.leaf];
  // Dry runs record --number 0; give each leaf a unique synthetic number so
  // merge-plan entries can't collide.
  let number = Number(a.number);
  if (run.dry_run && number === 0) number = 9000 + run.items.indexOf(item);
  ls.pr = { number, url: a.url, draft: Boolean(a.draft) };
  item.pr = ls.pr;
  ls.stage = 'close';
  unpend(run, `pr:${a.leaf}`);
  S.saveTeam(run.run_id, team);
  S.saveRun(run);
  S.appendEvent(run.run_id, { type: 'pr', leaf: a.leaf, ...ls.pr });
  out({ ok: true });
}

function applyTrackerResults(run, results) {
  for (const r of results) {
    const item = run.items.find((i) => i.ref === r.item || i.id === r.item);
    if (!item) continue;
    if (r.op === 'status' || r.op === 'restore_status') {
      item.status_history.push({ to: r.op === 'restore_status' ? `restored:${r.to_type}` : r.to_type, ok: Boolean(r.ok), skipped: Boolean(r.skipped), detail: r.detail || null, at: new Date().toISOString() });
      if (r.ok && (r.op === 'status' || !r.skipped)) item.status_type = r.to_type;
    }
    // One attempt per item; a failed restore is reported, never retried.
    if (r.op === 'restore_status') item.status_restored = true;
  }
}

function cmdRecordTracker(a) {
  const run = S.loadRun(a.run);
  const { results = [] } = JSON.parse(readStdin() || '{}');
  applyTrackerResults(run, results);
  unpend(run, a.key);
  if (a.key === 'tracker:in_progress') run.flags.in_progress = true;
  const m = a.key.match(/^tracker:close:(.+)$/);
  if (m) {
    const item = itemById(run, m[1]);
    const team = teamOf(run, item.team);
    finishLeaf(run, team, m[1]);
    S.saveTeam(run.run_id, team);
  }
  M.onTrackerRecorded?.(run, a.key);
  S.saveRun(run);
  S.appendEvent(run.run_id, { type: 'tracker', key: a.key, results });
  out({ ok: true });
}

function cmdRecordAnswer(a) {
  const run = S.loadRun(a.run);
  const ans = JSON.parse(readStdin() || '{}');
  S.appendEvent(run.run_id, { type: 'answer', kind: a.kind, answer: ans });
  if (a.kind === 'architect_failed') {
    if (!run.architect_failed) throw new Error('no failed architect to answer for');
    if (ans.choice === 'cancel') {
      run.phase = 'done';
      run.cancelled = true;
    } else if (ans.choice === 'retry') {
      // Same agent, via message: it keeps its context.
      run.architect_item.agents = { ...(run.architect_item.agents || {}), architect: run.architect_failed.agent };
      run.architect_failed.resolution = 'retry';
    } else if (ans.choice === 'proceed') run.architect_failed.resolution = 'proceed';
    else throw new Error(`architect_failed answer needs choice retry|proceed|cancel, got ${JSON.stringify(ans.choice)}`);
  } else if (a.kind === 'checkpoint') {
    run.flags.checkpoint_asked = true;
    if (ans.proceed === false) {
      run.phase = 'done';
      run.cancelled = true;
    } else {
      for (const id of ans.exclude || []) {
        const it = itemById(run, id) || run.items.find((i) => i.ref === id);
        if (it) it.excluded = 'excluded at checkpoint';
      }
      for (const [id, note] of Object.entries(ans.notes || {})) {
        const it = itemById(run, id) || run.items.find((i) => i.ref === id);
        if (it) it.notes = note;
      }
      if (ans.spawn_cap) run.spawn_cap = Number(ans.spawn_cap);
      if (ans.replan?.length) {
        for (const id of ans.replan) {
          const it = itemById(run, id) || run.items.find((i) => i.ref === id);
          if (it) {
            it.plan = null;
            it.roles = null;
            // Naming an item in `replan` brings it back in, whatever dropped
            // it (bad premise, no plan, an earlier checkpoint): otherwise the
            // investigator never reruns and the same checkpoint comes back.
            // An `exclude` in the same answer wins.
            const excludedNow = (ans.exclude || []).some((e) => e === it.id || e === it.ref);
            if (it.excluded && !excludedNow) {
              it.excluded = null;
              // Its status was restored when it was dropped: move it again.
              if (it.status_restored) {
                it.status_restored = false;
                run.flags.in_progress = false;
              }
            }
          }
        }
        run.flags.pairwise = false;
        run.phase = 'plan';
      } else run.phase = 'build';
    }
  } else {
    M.onAnswer(run, a.kind, ans);
  }
  S.saveRun(run);
  out({ ok: true, phase: run.phase });
}

function cmdRecordMerge(a) {
  const run = S.loadRun(a.run);
  M.onMerge(run, { pr: Number(a.pr), result: a.result, detail: a.detail });
  S.saveRun(run);
  out({ ok: true, phase: run.phase });
}

function cmdStatus(a) {
  const run = S.loadRun(a.run);
  out({ run_id: run.run_id, phase: run.phase, mode: run.mode, pending: Object.keys(run.pending || {}), report: M.finalReport(run) });
}

function cmdReissue(a) {
  const run = S.loadRun(a.run);
  const cleared = Object.keys(run.pending || {});
  // Re-emitted spawns count again, so give back the ones that never ran.
  for (const k of cleared) if (k.startsWith('spawn:') && run.pending[k].via === 'new') run.spawns_used -= 1;
  run.pending = {};
  S.saveRun(run);
  S.appendEvent(run.run_id, { type: 'reissue', cleared });
  out({ ok: true, cleared });
}

async function cmdEval() {
  const { execFileSync } = await import('node:child_process');
  const res = execFileSync('node', [join(dirname(fileURLToPath(import.meta.url)), 'eval/run.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  process.stdout.write(res);
}

async function cmdJevSmoke() {
  const r = await ask({ state: 'The build is failing on main.', questions: { urgent: { type: 'noul', instructions: 'Is this urgent?' } } });
  out(r);
}

// ---------------------------------------------------------------- main
const a = parseArgs(process.argv.slice(2));
const cmds = {
  init: cmdInit, next: cmdNext, record: cmdRecord, 'record-pr': cmdRecordPr, 'record-tracker': cmdRecordTracker,
  'record-answer': cmdRecordAnswer, 'record-merge': cmdRecordMerge, 'record-push': cmdRecordPush, status: cmdStatus, reissue: cmdReissue, 'jev-smoke': cmdJevSmoke, eval: cmdEval,
};
if (import.meta.url === `file://${process.argv[1]}`) {
  const fn = cmds[a._];
  if (!fn) {
    out({ error: `unknown command ${a._}`, commands: Object.keys(cmds) });
    process.exit(2);
  }
  // then(): a sync throw must reach the catch and print {error} too.
  Promise.resolve().then(() => fn(a)).catch((e) => {
    process.stderr.write(`${e.stack}\n`);
    out({ error: e.message });
    process.exit(1);
  });
}
