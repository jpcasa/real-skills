#!/usr/bin/env node
// /promote harness. The agent reads, explains and asks; this script computes
// every gate and makes every write. Prints exactly ONE JSON object per call.
//
//   probe        < {repo}                      what the repo says about its environments, and a proposed stage list
//   configured   < {repo}                      checks .claude/promote.json after setup wrote it; labels the Jev cases
//   start        < {repo, args: [...]}         the stage, the range, the pull requests it carries, every gate
//   check        < {run, check_run?}           reads the check-infra-and-migrations verdict for this exact range
//   accept       --run <id> --confirmed        records that the user accepted the blockers, for this run only
//   brief        --run <id>                    the pull request title and body, as they would be sent
//   open         --run <id> --confirmed        opens the promotion pull request (write 1 of 2)
//   ready        --run <id>                    is it still the same commits, and does GitHub allow the merge
//   merge        --run <id> --confirmed        merges it, only if the head is still the commit that was checked (write 2 of 2)
//   watch        --run <id> [--wait <s>]       workflow runs and deployments for the merge commit
//   verify       --run <id> [--confirmed]      health URL and, after a yes, the configured read of what is running
//
// Nothing is checked out, no branch of the clone is moved, and no flag that
// skips a rule is ever passed to GitHub. Jev (optional) is asked only what the
// pipeline looks like, during probe, and decides no gate.

import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { ask as realAsk, redactBody } from './lib/jev.mjs';
import { loadConfig, jevMode, isProduction, stageOf, sourceOf, promotable, HOW, MERGE_METHODS, VERIFY_KINDS } from './lib/config.mjs';
import { probe as readRepo } from './lib/probe.mjs';
import { buildBody } from './lib/brief.mjs';
import { checkStart, checkVerdict, SIBLING } from './lib/sibling.mjs';
import * as G from './lib/gates.mjs';
import * as GH from './lib/github.mjs';
import * as S from './lib/state.mjs';
import * as Q from './lib/questions.mjs';
import * as C from './lib/calibration.mjs';

export const RESULTS = ['nothing_to_promote', 'opened', 'merged', 'deploy_pending', 'deploy_failed', 'not_serving', 'promoted_unverified', 'promoted_verified'];
export const MODES = ['promote', 'setup', 'status', 'watch'];
export const FLAGS = ['--dry-run', '--no-merge'];
export const MAX_WAIT_S = 540;
const POLL_MS = () => Number(process.env.PROMOTE_POLL_MS || 15000);
const DEPLOYED_TIMEOUT_S = 120;

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
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const stdin = () => {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};
const json = () => JSON.parse(stdin() || '{}');
const short = (sha) => String(sha).slice(0, 7);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Jev, stubbable (PROMOTE_JEV_STUB: { "<id or prefix*>": number, "__degraded": true }).
async function ask(built) {
  const stubFile = process.env.PROMOTE_JEV_STUB;
  if (!stubFile) return realAsk(built);
  const stub = JSON.parse(readFileSync(stubFile, 'utf8'));
  if (stub.__degraded) return { answers: {}, degraded: true, error: 'stub' };
  appendFileSync(`${stubFile}.sent.jsonl`, `${JSON.stringify(redactBody({ state: built.state, questions: built.questions }))}\n`);
  const answers = {};
  for (const id of Object.keys(built.questions)) {
    const key = Object.keys(stub).find((k) => k === id || (k.endsWith('*') && id.startsWith(k.slice(0, -1))));
    answers[id] = { type: 'noul', noul: key === undefined ? 0.5 : stub[key] };
  }
  return { answers, degraded: false };
}

// ---------------------------------------------------------------- probe, configured
export async function probe(input) {
  const repo = resolve(input.repo || process.cwd());
  const p = readRepo(repo);
  let mode = 'shadow';
  try {
    mode = jevMode(loadConfig(repo).config);
  } catch {
    mode = jevMode({});
  }
  const suggestions = [];
  if (mode !== 'off' && p.stages.length) {
    const built = Q.build(p, basename(repo));
    const res = await ask(built);
    if (res.degraded) mode = 'degraded';
    else {
      const cases = [];
      const kept = [];
      for (const c of built.cases) {
        const n = res.answers[c.key]?.noul;
        if (typeof n !== 'number') continue;
        const sp = Q.spot(c.question, c.case);
        const acted = mode === 'live' && Q.calibrated(c.question) && !sp;
        cases.push({ skill: Q.SKILL, question: c.question, case: c.case, p: n, threshold: Q.thr(c.question), ...Q.SHAPE[c.question], mode, acted, ...(sp ? { spot: true } : {}), show: c.show });
        kept.push({ ...c, p: n });
        if (!acted || n < Q.thr(c.question)) continue;
        // Calibrated, Jev may add the production wording to a stage, and may be shown as the other reading. It removes nothing.
        const stage = p.stages.find((s) => s.env === c.env);
        if (c.question === 'env_is_production' && stage && !stage.production) {
          stage.production = true;
          stage.why.push('Jev reads this environment as production');
        } else if (c.question === 'branch_deploys_env' && stage && stage.branch !== c.branch) suggestions.push(`Jev reads ${c.branch}, not ${stage.branch}, as the branch that deploys ${c.env}`);
        else if (c.question === 'env_promotes_from' && stage && stage.from !== c.from) suggestions.push(`Jev reads ${c.env} as fed from ${c.from}${stage.from ? `, not ${stage.from}` : ''}`);
      }
      C.writeCases(S.jevLog(), cases, redactBody);
      S.saveProbe(repo, { at: now(), cases: kept, labelled: false });
    }
  }
  return { ...p, jev: mode, ...(suggestions.length ? { suggestions } : {}) };
}

const stageView = (config, s) => ({ env: s.env, how: s.how, ...(s.branch ? { branch: s.branch } : {}), ...(s.from ? { from: s.from } : {}), ...(s.how === 'pr' ? { merge_method: s.merge_method || 'merge' } : {}), production: isProduction(config, s), ...(s.deploy_workflow ? { deploy_workflow: s.deploy_workflow } : {}), ...(s.how === 'manual' && s.command ? { command: s.command } : {}), ...(config.verify[s.env] ? { verify: Object.keys(config.verify[s.env]) } : {}) });

export function configured(input) {
  const repo = resolve(input.repo || process.cwd());
  const loaded = loadConfig(repo);
  if (loaded.needs_setup) throw new Error('.claude/promote.json has no `stages` list yet');
  const { config } = loaded;
  let labelled = 0;
  const revoked = [];
  const last = S.loadProbe(repo);
  if (last && !last.labelled) {
    for (const l of Q.labels(last.cases, config.stages, (s) => isProduction(config, s))) {
      const r = C.writeLabel(S.jevLog(), { skill: Q.SKILL, question: l.question, case: l.case, label: l.label, source: 'setup', p: l.p, unsafe: Q.SHAPE[l.question].unsafe });
      labelled += 1;
      if (r.revoked) revoked.push(l.question);
    }
    S.saveProbe(repo, { ...last, labelled: true });
  }
  const warnings = [];
  if (!config.stages.some((s) => isProduction(config, s))) warnings.push('no stage is marked or named as production: no promotion will carry the production warning. Set "production": true on the one real users are on');
  if (!promotable(config).length) warnings.push('no stage has "how": "pr": there is nothing this skill can promote');
  return { ok: true, stages: config.stages.map((s) => stageView(config, s)), promotable: promotable(config).map((s) => s.env), config_sources: loaded.sources, jev: jevMode(config), labelled, ...(revoked.length ? { revoked } : {}), warnings };
}

// ---------------------------------------------------------------- start
function parseInput(args) {
  const a = args.map(String);
  if (['setup', 'status', 'watch'].includes(a[0])) return { mode: a[0], rest: a.slice(1) };
  const flags = { dry_run: false, no_merge: false };
  let env = null;
  for (const t of a) {
    if (t === '--dry-run') flags.dry_run = true;
    else if (t === '--no-merge') flags.no_merge = true;
    else if (t.startsWith('-')) throw new Error(`unknown flag ${t} (known: ${FLAGS.join(', ')})`);
    else if (env) throw new Error(`one environment per run: got ${JSON.stringify(env)} and ${JSON.stringify(t)}`);
    else env = t;
  }
  return { mode: 'promote', env, flags };
}

const side = (repo, slug, stage) => ({ env: stage.env, branch: stage.branch, ref: GH.branchRef(repo, slug, stage.branch), sha: GH.tip(repo, slug, stage.branch), ...(stage.deploy_workflow ? { deploy_workflow: stage.deploy_workflow } : {}) });

function gateView(gates) {
  return { gates, blocking: G.of(gates, 'block'), waiting: G.of(gates, 'wait'), warnings: G.of(gates, 'warn'), unknown: G.of(gates, 'unknown') };
}

function statusOf(repo, config, slug) {
  const stages = promotable(config);
  GH.fetchBranches(repo, slug, [...new Set(stages.flatMap((s) => [s.branch, sourceOf(config, s).branch]))]);
  const log = S.readLog().filter((e) => e.repo === slug);
  return stages.map((s) => {
    const source = side(repo, slug, sourceOf(config, s));
    const target = side(repo, slug, s);
    const known = source.sha && target.sha;
    const open = GH.openPrsInto(repo, s.branch);
    const mine = open?.find((p) => p.head === source.branch && !p.fork) || null;
    const last = log.filter((e) => e.stage === s.env && e.result).pop() || null;
    const waiting = known ? GH.countCommits(repo, target.sha, source.sha) : null;
    return {
      env: s.env, from: source.env, production: isProduction(config, s), source: { branch: source.branch, sha: source.sha ? short(source.sha) : null }, target: { branch: target.branch, sha: target.sha ? short(target.sha) : null },
      commits_waiting: waiting, pull_requests_waiting: known && waiting ? GH.prsInRange(repo, target.sha, source.sha).prs.length : 0,
      open_pr: mine ? { number: mine.number, url: mine.url } : null, last_run: last ? { run: last.run, result: last.result, at: last.ts } : null,
    };
  });
}

export async function start(input) {
  const repo = resolve(input.repo || process.cwd());
  const parsed = parseInput(input.args || []);
  const loaded = loadConfig(repo);
  const { config } = loaded;
  if (parsed.mode === 'setup') return { mode: 'setup', needs_setup: loaded.needs_setup, config_sources: loaded.sources };
  if (loaded.needs_setup) return { mode: parsed.mode, needs: ['setup'], config_sources: loaded.sources, next: 'no .claude/promote.json with stages: say so in one line and run setup (references/setup.md). Nothing is promoted on a guess' };
  const slug = GH.repoSlug(repo);
  if (!slug) throw new Error('this is not a GitHub repository, or `gh` is not signed in: /promote works through pull requests on GitHub');

  if (parsed.mode === 'status') return { mode: 'status', repo: slug, stages: statusOf(repo, config, slug), manual: config.stages.filter((s) => s.how === 'manual').map((s) => stageView(config, s)) };
  if (parsed.mode === 'watch') {
    const id = parsed.rest[0] || S.readLog().filter((e) => e.repo === slug && ['open', 'merge'].includes(e.type)).pop()?.run || null;
    return { mode: 'watch', run_id: id, ...(id ? { next: 'call watch with this run, then verify' } : { next: 'no run of this repository has opened a pull request: there is nothing to watch' }) };
  }

  // Which stage.
  const can = promotable(config);
  let stage = null;
  if (parsed.env) {
    stage = stageOf(config, parsed.env);
    if (!stage) throw new Error(`no stage is called ${JSON.stringify(parsed.env)} (stages: ${config.stages.map((s) => s.env).join(', ')})`);
    if (stage.how === 'push') return { mode: 'promote', stage: stage.env, how: 'push', says: `${stage.env} follows ${stage.branch}: every merge into ${stage.branch} deploys it, so there is nothing to promote. Merge a pull request into ${stage.branch} instead.`, candidates: can.map((s) => s.env) };
    if (stage.how === 'manual') return { mode: 'promote', stage: stage.env, how: 'manual', command: stage.command || null, says: `${stage.env} is promoted by hand. This skill does not run that step${stage.command ? ': show the command and stop' : ', and no command is recorded for it'}.` };
  } else if (can.length === 1) [stage] = can;
  else return { mode: 'promote', needs: ['input'], candidates: can.map((s) => ({ env: s.env, from: s.from, production: isProduction(config, s) })), next: can.length ? 'more than one environment can be promoted to: ask which one, then call start again with its name. Never pick' : 'no stage has "how": "pr": there is nothing this skill can promote. Say so and stop' };

  const from = sourceOf(config, stage);
  if (!GH.fetchBranches(repo, slug, [from.branch, stage.branch])) throw new Error(`${from.branch} and ${stage.branch} could not be fetched: nothing is promoted from refs that may be stale`);
  const source = side(repo, slug, from);
  const target = { ...side(repo, slug, stage), merge_method: stage.merge_method || 'merge' };
  for (const x of [source, target]) if (!x.sha) throw new Error(`the branch ${x.branch} (${x.env}) is not on the remote`);
  const production = isProduction(config, stage);
  const base = { mode: 'promote', stage: stage.env, production, source: { env: source.env, branch: source.branch, sha: short(source.sha) }, target: { env: target.env, branch: target.branch, sha: short(target.sha) } };

  const commits = GH.countCommits(repo, target.sha, source.sha);
  if (commits === null) throw new Error(`the commits between ${target.branch} and ${source.branch} could not be counted`);
  if (commits === 0) {
    S.appendLog({ type: 'start', repo: slug, stage: stage.env, result: 'nothing_to_promote' });
    return { ...base, result: 'nothing_to_promote', says: `${target.env} already has everything ${source.env} has (${source.branch} at ${short(source.sha)}).`, next: 'say so in one line and stop' };
  }
  const { prs, more } = GH.prsInRange(repo, target.sha, source.sha);
  const gates = { range: { status: 'pass', says: `${plural(commits, 'commit')} on ${source.branch} that ${target.branch} does not have` } };
  gates.merges_cleanly = G.mergesCleanly(repo, target, source);
  const open = G.openPr(repo, target, source);
  gates.open_pr = open.gate;
  gates.source_checks = G.sourceChecks(repo, slug, source);
  gates.source_deployed = G.sourceDeployed(repo, slug, source);

  // Migrations and infrastructure: the sibling skill's harness reads the same range.
  let infra;
  const started = source.ref && target.ref ? checkStart(repo, target.ref, source.ref, target.env) : { ok: false, reason: 'the branch refs could not be named' };
  if (!started.ok) infra = { state: 'missing', reason: started.reason };
  else {
    const v = checkVerdict(started.run_id);
    const t = v.ok ? v.targets.find((x) => x.base_sha === target.sha && x.head_sha === source.sha) : null;
    if (!v.ok) infra = { state: 'missing', reason: v.reason };
    else if (!t) infra = { state: 'missing', reason: 'a branch moved while the check started: start again' };
    else if (!started.bucketed) {
      // Nothing changed under the paths that skill knows. When it only detected those paths, say so.
      const detected = Object.values(started.layout_from || {}).some((x) => x === 'probe');
      infra = { state: 'recorded', by: 'start', run: started.run_id, target: started.target, verdict: 'nothing_to_check', ...(detected ? { detected: true } : {}), counts: { blocker: 0, risk: 0, note: 0 }, blockers: [], risks: [], unchecked: [], runbook: [] };
    }
    else infra = { state: 'pending', run: started.run_id, target: started.target, buckets: Object.fromEntries(Object.entries(started.buckets || {}).map(([k, files]) => [k, files.length])), live: started.live };
  }
  gates.infra_check = G.infraCheck(infra, null);

  const run = {
    run_id: S.newRunId(), created_at: now(), repo, slug, stage: stage.env, production, flags: parsed.flags, source, target, commits, prs, more_prs: more,
    gates, infra, accepted: null, pr: open.pr ? { number: open.pr.number, url: open.pr.url, reused: true } : null, merge: null, deploy: null, verify: null, result: null,
  };
  S.saveRun(run);
  S.appendLog({ type: 'start', run: run.run_id, repo: slug, stage: stage.env, production, commits, prs: prs.length + more, gates: Object.fromEntries(Object.entries(gates).map(([k, v]) => [k, v.status])), infra: infra.state });
  const view = gateView(gates);
  return {
    ...base, run_id: run.run_id, flags: parsed.flags, commits, prs, more_prs: more, pr: run.pr, ...view,
    infra: infra.state === 'pending' ? { state: 'pending', check_run: infra.run, target: infra.target, buckets: infra.buckets, skill: SIBLING } : { state: infra.state, ...(infra.verdict ? { verdict: infra.verdict } : {}), ...(infra.reason ? { reason: infra.reason } : {}) },
    can_open: !parsed.flags.dry_run && !view.blocking.length && !view.waiting.length,
    next: nextAfterGates(run, view),
  };
}

function nextAfterGates(run, view) {
  if (run.infra.state === 'pending') return `this range changes migrations or infrastructure: follow the ${SIBLING} skill for its run ${run.infra.run} (from "Read what start found" through record, without posting), then call check`;
  if (view.blocking.length) return run.gates.infra_check.status === 'block' && view.blocking.length === 1 ? 'the check says blocked: show the blockers in full. Only if the user accepts them for this promotion, call accept with --confirmed; otherwise stop' : 'a gate blocks: say which and why, and stop. Nothing is opened';
  if (view.waiting.length) return 'something is still running: say what, and call start again later';
  if (run.flags.dry_run) return 'dry run: call brief, show it, and stop. Nothing is opened';
  return run.pr ? `the promotion pull request is already open (#${run.pr.number}): call brief, show it, then go to ready` : 'call brief, show it, and ask whether to open the pull request';
}

// ---------------------------------------------------------------- check, accept
function refresh(run) {
  run.gates.infra_check = G.infraCheck(run.infra, run.accepted);
}

// An acceptance covers exactly the blockers that were read out. Any other list, and it is gone.
function takeVerdict(run, id, t) {
  if (run.accepted && !G.sameList(run.accepted.blockers, t.blockers)) run.accepted = null;
  run.infra = { state: 'recorded', by: 'check', run: id, target: t.id, verdict: t.verdict, counts: t.counts, blockers: t.blockers, risks: t.risks, unchecked: t.unchecked, runbook: t.runbook };
}
// The check can be recorded again after `check` read it: read it once more before anything is written.
// If it cannot be read now, what was read before stands: a `blocked` never turns into nothing.
function syncInfra(run) {
  if (run.infra?.state !== 'recorded' || run.infra.by !== 'check') return;
  const v = checkVerdict(run.infra.run);
  const t = v.ok ? v.targets.find((x) => x.base_sha === run.target.sha && x.head_sha === run.source.sha && x.env === run.target.env) : null;
  if (t?.verdict) takeVerdict(run, run.infra.run, t);
}

export function check(input) {
  const run = S.loadRun(input.run || input.run_id);
  const id = input.check_run || run.infra?.run;
  if (!id) throw new Error(`no ${SIBLING} run belongs to this promotion: ${run.infra?.reason || 'start found none'}`);
  const v = checkVerdict(id);
  if (!v.ok) throw new Error(v.reason);
  const t = v.targets.find((x) => x.base_sha === run.target.sha && x.head_sha === run.source.sha);
  if (!t) throw new Error(`run ${id} checked ${v.targets.map((x) => `${short(x.base_sha)}..${short(x.head_sha)}`).join(', ') || 'nothing'}, not this promotion (${short(run.target.sha)}..${short(run.source.sha)}): a verdict for other commits is not taken`);
  if (t.env !== run.target.env) throw new Error(`run ${id} checked those commits for ${t.env || 'no environment'}, not for ${run.target.env}: what is pending and what a plan does differ per environment`);
  if (!t.verdict) throw new Error(`run ${id} has no verdict yet: finish the ${SIBLING} flow (record), then call check again`);
  takeVerdict(run, id, t);
  refresh(run);
  S.saveRun(run);
  const view = gateView(run.gates);
  return {
    run_id: run.run_id, verdict: t.verdict, gate: run.gates.infra_check, blockers: t.blockers, risks: t.risks, unchecked: t.unchecked, runbook: t.runbook,
    needs_accept: t.verdict === 'blocked' && !run.accepted, blocking: view.blocking, waiting: view.waiting,
    next: nextAfterGates(run, view),
  };
}

export function accept(a) {
  const run = S.loadRun(a.run);
  if (run.infra?.state !== 'recorded' || run.infra.verdict !== 'blocked') return { ok: false, refused: 'there is no `blocked` verdict to accept in this run' };
  if (a.confirmed !== true) return { ok: false, refused: 'accepting a blocker needs the user\'s yes in this conversation, after reading every blocker in full: ask, then call accept with --confirmed', blockers: run.infra.blockers };
  run.accepted = { at: now(), blockers: run.infra.blockers };
  refresh(run);
  S.saveRun(run);
  S.appendLog({ type: 'accept', run: run.run_id, repo: run.slug, stage: run.stage, blockers: run.infra.blockers.length });
  return { ok: true, run_id: run.run_id, accepted: run.infra.blockers, gate: run.gates.infra_check, next: 'call brief, show it, and ask whether to open the pull request. The accepted blockers are written into its body' };
}

// ---------------------------------------------------------------- brief, open
function built(run) {
  const b = buildBody(run);
  // A body that cannot be redacted is not sent.
  return { title: b.title, body: redactBody({ body: b.body }).body, lines: b.lines };
}

const briefHash = (b) => createHash('sha256').update(`${b.title}\u0000${b.body}`).digest('hex');

export function brief(a) {
  const run = S.loadRun(a.run);
  const b = built(run);
  // What the user is shown is what `open` may send, and nothing else.
  run.briefed = { at: now(), hash: briefHash(b) };
  S.saveRun(run);
  const view = gateView(run.gates);
  return {
    run_id: run.run_id, stage: run.stage, production: run.production, flags: run.flags, title: b.title, body: b.body, lines: b.lines, pr: run.pr,
    blocking: view.blocking, waiting: view.waiting, warnings: view.warnings, unknown: view.unknown,
    ask: run.flags.dry_run || run.pr || view.blocking.length || view.waiting.length ? null : `Open the pull request ${run.source.branch} → ${run.target.branch}?${run.production ? ' Merging it later deploys to production.' : ''}`,
  };
}

// The gates that can change while a run sits open.
function recheck(run) {
  const fetched = GH.fetchBranches(run.repo, run.slug, [run.source.branch, run.target.branch]);
  const tips = { fetched, source: GH.tip(run.repo, run.slug, run.source.branch), target: GH.tip(run.repo, run.slug, run.target.branch) };
  run.gates.source_checks = G.sourceChecks(run.repo, run.slug, run.source);
  run.gates.source_deployed = G.sourceDeployed(run.repo, run.slug, run.source);
  syncInfra(run);
  refresh(run);
  return tips;
}
const refusedBy = (view) => [...view.blocking, ...view.waiting].map((x) => `${x.gate}: ${x.says}`);

export function open(a) {
  const run = S.loadRun(a.run);
  if (run.flags.dry_run) return { ok: false, refused: 'this run is a dry run: nothing is opened' };
  if (run.merge) return { ok: false, refused: `this run already merged #${run.pr?.number}` };
  const tips = recheck(run);
  run.gates.head_unchanged = G.headUnchanged(run, tips);
  const found = G.openPr(run.repo, run.target, run.source);
  run.gates.open_pr = found.gate;
  if (!run.pr && found.pr) run.pr = { number: found.pr.number, url: found.pr.url, reused: true };
  S.saveRun(run);
  const view = gateView(run.gates);
  if (view.blocking.length || view.waiting.length) return { ok: false, refused: 'a gate does not pass', gates: refusedBy(view) };
  if (run.pr) return { ok: true, opened: false, reused: true, pr: run.pr, next: 'the promotion pull request was already open and is reused as it is: its body is not rewritten. Go to ready' };
  if (run.gates.open_pr.status === 'unknown') return { ok: false, refused: `${run.gates.open_pr.says}: nothing is opened without knowing whether one is already open` };
  const b = built(run);
  if (!run.briefed) return { ok: false, refused: 'the brief was never shown: call brief, show it, ask, then call open with --confirmed' };
  if (run.briefed.hash !== briefHash(b)) return { ok: false, refused: 'something changed since the brief was shown, so the pull request would not say what the user approved: call brief again, show it, and ask again' };
  // The harness cannot hear the answer, but it can refuse a call that does not claim one.
  if (a.confirmed !== true) return { ok: false, refused: 'opening needs the user\'s yes in this conversation: show the brief, ask, then call open with --confirmed' };
  const pr = GH.createPr(run.repo, { base: run.target.branch, head: run.source.branch, title: b.title, body: b.body });
  run.pr = { number: pr.number, url: pr.url, reused: false, opened_at: now() };
  run.result = 'opened';
  S.saveRun(run);
  S.appendLog({ type: 'open', run: run.run_id, repo: run.slug, stage: run.stage, pr: pr.number, result: 'opened' });
  return { ok: true, opened: true, pr: run.pr, next: run.flags.no_merge ? 'opened. --no-merge: stop here and say that `/real-skills:promote watch` picks up after a person merges' : 'opened. Call ready; when it allows, ask the second question before merge' };
}

// ---------------------------------------------------------------- ready, merge
function computeReady(run) {
  if (!run.pr) return { allowed: false, refused: 'no pull request yet: call open first' };
  const pr = GH.prView(run.repo, run.pr.number);
  if (pr.state === 'MERGED') {
    if (!run.merge) run.merge = { at: now(), sha: pr.merge_sha, by: 'outside this run' };
    S.saveRun(run);
    return { allowed: false, merged: true, refused: `#${pr.number} is already merged`, next: 'call watch' };
  }
  const tips = recheck(run);
  run.gates.head_unchanged = pr.base !== run.target.branch || pr.head !== run.source.branch
    ? { status: 'block', says: `#${pr.number} is ${pr.head} → ${pr.base}, not ${run.source.branch} → ${run.target.branch}` }
    : G.headUnchanged(run, { ...tips, pr_head: pr.head_sha });
  run.gates.pr_mergeable = G.prMergeable(pr);
  S.saveRun(run);
  const view = gateView(run.gates);
  const allowed = !view.blocking.length && !view.waiting.length;
  return { allowed, ...view, pr: { number: pr.number, url: pr.url, merge_state: pr.merge_state, review: pr.review } };
}

export function ready(a) {
  const run = S.loadRun(a.run);
  const r = computeReady(run);
  if (r.refused) return { run_id: run.run_id, ...r };
  const over = run.gates.head_unchanged?.moved === true;
  return {
    run_id: run.run_id, allowed: r.allowed && !run.flags.no_merge, production: run.production, pr: r.pr, method: run.target.merge_method, head: short(run.source.sha),
    blocking: r.blocking, waiting: r.waiting, restate: [...r.warnings, ...r.unknown].map((x) => `${x.gate}: ${x.says}`),
    ask: r.allowed && !run.flags.no_merge ? `Merge #${r.pr.number} (${run.source.branch} → ${run.target.branch}, ${run.target.merge_method}) at ${short(run.source.sha)}?${run.production ? ' This deploys to production.' : ''}` : null,
    next: over ? 'the commits moved under this run: it is over. Say what moved and start a new run; the open pull request stays as it is'
      : r.blocking.length ? 'GitHub or a gate blocks the merge: say which and why, and stop. Nothing is retried, re-run or bypassed'
      : r.waiting.length ? 'something is still running: say what, and call ready again later'
      : run.flags.no_merge ? '--no-merge: stop here. A person merges; `/real-skills:promote watch` picks up after'
      : 'restate every line of `restate`, then ask the second question. A yes to opening was not a yes to merging',
  };
}

export function merge(a) {
  const run = S.loadRun(a.run);
  if (run.flags.dry_run) return { ok: false, refused: 'this run is a dry run: nothing is merged' };
  if (run.flags.no_merge) return { ok: false, refused: 'this run was started with --no-merge: a person merges' };
  if (run.merge) return { ok: false, refused: `#${run.pr?.number} was already merged${run.merge.by ? ` (${run.merge.by})` : ' by this run'}` };
  // Checked again here, seconds before the write, not taken from the earlier `ready`.
  const r = computeReady(run);
  if (!r.allowed) return { ok: false, refused: r.refused || 'a gate does not pass', gates: r.refused ? [] : refusedBy(r) };
  if (a.confirmed !== true) return { ok: false, refused: 'merging needs its own yes from the user in this conversation, after the ready question: ask, then call merge with --confirmed' };
  let res;
  try {
    res = GH.mergePr(run.repo, run.pr.number, run.target.merge_method, run.source.sha);
  } catch (e) {
    S.appendLog({ type: 'merge', run: run.run_id, repo: run.slug, stage: run.stage, pr: run.pr.number, refused: true });
    return { ok: false, refused: e.message, next: 'GitHub refused. Report its words and stop: nothing is retried, no rule is bypassed, no setting is changed' };
  }
  run.merge = { at: now(), sha: res.sha, method: run.target.merge_method };
  run.result = 'merged';
  S.saveRun(run);
  S.appendLog({ type: 'merge', run: run.run_id, repo: run.slug, stage: run.stage, pr: run.pr.number, result: 'merged' });
  return { ok: true, merged: true, pr: run.pr.number, merge_sha: res.sha ? short(res.sha) : null, next: 'merged. Call watch with --wait, then verify. Do not say "deployed" yet' };
}

// ---------------------------------------------------------------- watch, verify
function mergeShaOf(run) {
  if (run.merge?.sha) return run.merge.sha;
  if (!run.pr) return null;
  const pr = GH.prView(run.repo, run.pr.number);
  if (pr.state !== 'MERGED' || !pr.merge_sha) return null;
  run.merge = { ...(run.merge || { at: now(), by: 'outside this run' }), sha: pr.merge_sha };
  S.saveRun(run);
  return run.merge.sha;
}

// What decides: the stage's deploy workflow when one is named, and GitHub
// deployments. Any other workflow run on the commit (CI, tests) is not a deploy
// and is not counted, green or red.
function deployState(run, sha) {
  const runs = GH.workflowRuns(run.repo, run.slug, sha);
  const deps = GH.deployments(run.repo, run.slug, sha);
  if (runs === null && deps === null) return { state: 'unknown', says: 'neither workflow runs nor deployments could be read', items: [] };
  const wf = run.target.deploy_workflow;
  const deciding = wf ? (runs || []).filter((r) => G.isWorkflow(r, wf, run.target.branch)) : [];
  // The merge commit lives on the target branch only, so its deployments are the target's; one named like the stage is preferred.
  const named = (deps || []).filter((d) => G.sameEnv(d.environment, run.target.env));
  const used = named.length ? named : deps || [];
  const items = [...deciding.map((r) => ({ kind: 'workflow', name: r.name || r.path, state: r.state, url: r.url })), ...used.map((d) => ({ kind: 'deployment', name: d.environment || 'deployment', state: d.state, url: d.url }))];
  if (items.some((i) => i.state === 'fail')) return { state: 'deploy_failed', says: `failed: ${items.filter((i) => i.state === 'fail').map((i) => i.name).join(', ')}`, items };
  // A named deploy workflow is the one that decides: until it has a run, nothing else stands in for it.
  if (wf && !deciding.length) return { state: 'nothing_seen', says: `${wf} has not started for ${short(sha)}`, items };
  if (!items.length) return { state: 'nothing_seen', says: `GitHub records no deployment of ${short(sha)} yet, and no deploy_workflow is named for ${run.target.env}`, items };
  if (items.some((i) => i.state === 'pending')) return { state: 'deploy_pending', says: `still running: ${items.filter((i) => i.state === 'pending').map((i) => i.name).join(', ')}`, items };
  return { state: 'deploy_green', says: `${plural(items.length, 'deploy run or deployment')} for ${short(sha)} finished green`, items };
}

export async function watch(a) {
  const run = S.loadRun(a.run);
  const sha = mergeShaOf(run);
  if (!sha) return { run_id: run.run_id, state: 'not_merged', says: run.pr ? `#${run.pr.number} is not merged` : 'this run has no pull request', next: 'there is nothing to watch until the pull request is merged' };
  const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(a.wait === true ? 0 : a.wait || 0)));
  const until = Date.now() + wait * 1000;
  let d = deployState(run, sha);
  while (['deploy_pending', 'nothing_seen'].includes(d.state) && Date.now() + POLL_MS() <= until) {
    await sleep(POLL_MS());
    d = deployState(run, sha);
  }
  // Nothing reporting to GitHub is not a green deploy.
  const state = d.state === 'nothing_seen' && wait > 0 ? 'unknown' : d.state === 'nothing_seen' ? 'deploy_pending' : d.state;
  run.deploy = { at: now(), state, says: d.says, items: d.items };
  run.result = state === 'deploy_failed' ? 'deploy_failed' : state === 'deploy_green' ? 'promoted_unverified' : 'deploy_pending';
  S.saveRun(run);
  S.appendLog({ type: 'deploy', run: run.run_id, repo: run.slug, stage: run.stage, state, result: run.result });
  return {
    run_id: run.run_id, merge_sha: short(sha), state, says: d.says, items: d.items, result: run.result,
    next: state === 'deploy_failed' ? 'the deploy failed: say which run, link it, and stop. Do not re-run it'
      : state === 'deploy_green' ? 'green on GitHub. That is not yet "deployed": call verify'
      : state === 'unknown' ? 'nothing reported to GitHub for this commit in the time waited: say so plainly, then call verify, which may still show what is running'
      : 'still running: call watch again with --wait',
  };
}

async function httpOk(url) {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'TimeoutError' ? 'timeout' : 'no answer' };
  }
}

export async function verify(a) {
  const run = S.loadRun(a.run);
  const sha = mergeShaOf(run);
  if (!sha) return { run_id: run.run_id, refused: 'nothing is merged yet: there is nothing to verify' };
  const cfg = loadConfig(run.repo).config.verify[run.target.env] || {};
  const outv = { health: null, serving: null };
  if (cfg.health) {
    const h = await httpOk(cfg.health);
    outv.health = { ok: h.ok, status: h.status, ...(h.error ? { error: h.error } : {}) };
  }
  let asked = null;
  if (cfg.deployed) {
    // The command that runs is the one that was shown. A config edited after the question means asking again.
    if (a.confirmed !== true || run.deployed_shown !== cfg.deployed) {
      asked = { command: cfg.deployed, env: run.target.env, production: run.production, says: `${a.confirmed === true ? 'the command is not the one that was shown before, so the earlier yes does not cover it. ' : ''}this runs your own command against ${run.target.env}${run.production ? ': it reads production' : ''}. Show it, ask, then call verify with --confirmed. "No" is fine: the result then says the running commit was not checked` };
      run.deployed_shown = cfg.deployed;
    } else {
      let text = '';
      let ok = true;
      try {
        text = execFileSync('sh', ['-c', cfg.deployed], { cwd: run.repo, stdio: ['ignore', 'pipe', 'pipe'], timeout: DEPLOYED_TIMEOUT_S * 1000, maxBuffer: 16 * 1024 * 1024 }).toString();
      } catch (e) {
        ok = false;
        text = `${e.stdout || ''}${e.stderr || ''}`;
      }
      writeFileSync(join(S.runDir(run.run_id), 'deployed.txt'), text);
      // What runs may be the merge commit or, where the source build is promoted as it is, the source commit.
      // The command must print the running commit and no other: a list of past releases would name ours and prove nothing.
      const tokens = [...new Set(text.toLowerCase().match(/\b[0-9a-f]{7,40}\b/g) || [])];
      const mine = (t) => [sha, run.source.sha].some((s) => s.startsWith(t));
      const ours = tokens.some(mine);
      // Another commit id means it runs something else. A date or a build number (digits only) says nothing.
      const others = tokens.filter((t) => !mine(t) && /[a-f]/.test(t) && /[0-9]/.test(t));
      const state = !ok ? 'unknown' : ours && !others.length ? 'yes' : ours ? 'unknown' : others.length ? 'no' : 'unknown';
      outv.serving = { state, ...(ok ? {} : { error: 'the command failed' }), ...(ok && ours && others.length ? { note: 'the output names the promoted commit and other commits: the command must print only what is running now' } : {}), output: 'kept in the run folder, not shown' };
    }
  }
  const deploy = run.deploy?.state || 'unknown';
  const result = deploy === 'deploy_failed' ? 'deploy_failed'
    : outv.serving?.state === 'yes' && outv.health?.ok !== false ? 'promoted_verified'
    : outv.serving?.state === 'no' || outv.health?.ok === false ? (deploy === 'deploy_green' || deploy === 'unknown' ? 'not_serving' : 'deploy_pending')
    : deploy === 'deploy_green' ? 'promoted_unverified' : 'deploy_pending';
  run.verify = { at: now(), ...outv };
  run.result = result;
  S.saveRun(run);
  S.appendLog({ type: 'verify', run: run.run_id, repo: run.slug, stage: run.stage, result, health: outv.health?.ok ?? null, serving: outv.serving?.state ?? null });
  const SAYS = {
    promoted_verified: `${run.target.env} is running the promoted commit`,
    promoted_unverified: `the deploy finished green on GitHub; what ${run.target.env} is running was not checked${cfg.deployed ? '' : ' (no verify.deployed command is configured)'}`,
    not_serving: outv.health?.ok === false ? `the health check of ${run.target.env} failed (${outv.health.status || outv.health.error})` : `${run.target.env} is running another commit than the one promoted`,
    deploy_failed: 'the deploy failed',
    deploy_pending: 'the deploy has not finished',
  };
  return {
    run_id: run.run_id, result, says: SAYS[result], deploy, ...outv, ...(asked ? { ask: asked } : {}),
    next: asked ? 'ask about the `deployed` read; on a yes call verify again with --confirmed, on a no report this result as it is'
      : result === 'promoted_verified' ? 'report it, name the pull request and the commit, and offer /real-skills:changelog'
      : result === 'promoted_unverified' ? 'report it in exactly those words: green on GitHub, running commit not checked. Offer /real-skills:changelog'
      : result === 'deploy_pending' ? 'call watch again with --wait, then verify'
      : 'report it plainly, with the rollback lines of the runbook if there is one, and stop. Do not roll anything back yourself',
  };
}

// ---------------------------------------------------------------- main
const cmds = {
  probe: () => probe(json()),
  configured: () => configured(json()),
  start: () => start(json()),
  check: () => check(json()),
  accept: (a) => accept(a),
  brief: (a) => brief(a),
  open: (a) => open(a),
  ready: (a) => ready(a),
  merge: (a) => merge(a),
  watch: (a) => watch(a),
  verify: (a) => verify(a),
};
export const COMMANDS = Object.keys(cmds);
export { HOW, MERGE_METHODS, VERIFY_KINDS };

// Compared as real paths: a folder with a space in its name, or a symlinked install, is still this script.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  const fn = cmds[a._];
  if (!fn) {
    out({ error: `unknown command ${a._}`, commands: COMMANDS });
    process.exit(2);
  }
  Promise.resolve().then(() => fn(a)).then(out).catch((e) => {
    out({ error: e.message });
    process.exit(1);
  });
}
