#!/usr/bin/env node
// /fix-ci harness. The agent reads a failure and writes the fix; this script
// reads the checks and their logs, cuts each failure down to what matters,
// says what kind it is, runs the failing commands before and after the fix,
// checks the fix for shortcuts, builds the commit, pushes it and watches CI.
// Prints exactly ONE JSON object per call.
//
//   start    < {repo, args: [...]}                 the pull request, its checks, every failure with its class
//   repro    < {run, confirm: [...]}               runs each failing command at the head, before any edit
//   check    < {run, subject, edits: [...]}        edits listed, red commands green, shortcuts asked, the commit
//   decide   --run <id> --id <flag:file> --confirmed   records the user's answer to one flag
//   push     --run <id> --confirmed                an ordinary push of that commit to the pull request branch
//   rerun    --run <id> --confirmed                asks GitHub to run the passing kind of failure again
//   watch    --run <id>                            waits for CI on the pushed commit; red starts the next round
//   drop     --run <id>                            ends a run and removes its worktree, if it made one
//
// Two things leave this machine, each after a yes: the push and the rerun.
// No history is rewritten and no flag that overwrites a branch is ever
// passed to git. Jev (optional) can only add a question or an offer.

import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, normalize, resolve as resolvePath } from 'node:path';
import { ask as realAsk, redactBody } from './lib/jev.mjs';
import { loadConfig, jevMode, mappedFor, isIgnored } from './lib/config.mjs';
import { CLASSES, REPRO, classify, shape } from './lib/classes.mjs';
import { FLAGS, flagsOf } from './lib/flags.mjs';
import * as L from './lib/logs.mjs';
import * as G from './lib/git.mjs';
import * as GH from './lib/github.mjs';
import * as R from './lib/runner.mjs';
import * as S from './lib/state.mjs';
import * as Q from './lib/questions.mjs';
import * as C from './lib/calibration.mjs';

export const VERDICTS = ['nothing_to_fix', 'ci_running', 'fixable', 'rerun_offered', 'report_only', 'fixed', 'fixed_unverified', 'needs_decision', 'still_red', 'blocked', 'pushed', 'green', 'red', 'pending', 'timed_out', 'stuck', 'gave_up'];
export const MODES = ['fix', 'status', 'drop'];
export const ARG_FLAGS = ['--no-push', '--worktree'];
export const GATES = ['pr_open', 'same_repo', 'conflicts', 'ci_pending', 'red_on_base', 'local_unpushed', 'head_unchanged', 'listed', 'proof', 'flags'];
export const STATUSES = ['pass', 'warn', 'block', 'unknown'];
export const RESULTS = R.RESULTS;
export { CLASSES, REPRO, FLAGS };
const SUBJECT_CHARS = 72;
// No check on a pushed commit after this long: CI did not start.
const NO_CI_S = 300;

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
const sha1 = (v) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const oneLine = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Jev, stubbable (FIX_CI_JEV_STUB: { "<id or prefix*>": number, "__degraded": true }).
async function ask(built) {
  const stubFile = process.env.FIX_CI_JEV_STUB;
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

const gate = (status, text) => ({ status, text });
const of = (gates, status) => Object.entries(gates).filter(([, g]) => g.status === status).map(([k]) => k);
const gateView = (gates) => ({ gates, blocking: of(gates, 'block'), warnings: of(gates, 'warn'), unknown: of(gates, 'unknown') });

// A path inside the repository, as git spells it.
function repoPath(file) {
  const p = normalize(String(file || '')).replaceAll('\\', '/').replace(/^\.\//, '');
  if (!p || p === '.' || p.startsWith('/') || p.startsWith('..')) throw new Error(`not a path inside the repository: ${JSON.stringify(file)}`);
  return p;
}

// ---------------------------------------------------------------- the run
const configOf = (run) => loadConfig([run.cwd_repo, run.root], { repo: run.root, base: run.base.sha, head: run.start_head });
const indexFile = (run, name = 'index.now') => join(S.runDir(run.run_id), name);
const headTree = (run) => G.treeOf(run.root, run.head.sha);

function loadActive(id) {
  const run = S.loadRun(id);
  if (run.ended) throw new Error(`run ${run.run_id} is over (${run.ended.why}): start again`);
  return run;
}
// Files in the run's worktree that differ from the head and are not what a command left behind:
// a fix that was being written. null when it cannot be told.
function unpushedEdits(run) {
  try {
    if (run.workspace?.mode !== 'worktree' || !existsSync(run.workspace.path) || G.headOf(run.workspace.path) !== run.head.sha) return [];
    return changedNotNoise(run, G.treeNow(run.workspace.path, indexFile(run), run.head.sha));
  } catch {
    return null;
  }
}
// keep: leave a worktree that holds unpushed edits where it is. -> true (removed), false (kept or not removable), null (none)
function endRun(run, why, { keep = false } = {}) {
  let removed = null;
  if (run.workspace?.mode === 'worktree' && run.workspace.path) {
    const edits = keep ? unpushedEdits(run) : [];
    if (edits === null || edits.length) removed = false;
    else {
      try {
        G.removeWorktree(run);
        removed = true;
      } catch {
        removed = false;
      }
    }
  }
  run.ended = { at: now(), why };
  S.saveRun(run);
  return removed;
}

// Which failures this run fixes: the code's own, and not the ones the base branch has too unless the user said so.
const inScope = (run, f) => f.class === 'code' && (!f.also_red_on_base || run.include_base_red === true);
const spent = (run, f) => f.jobs.every((j) => run.reruns?.[j.name]);
// A failure that may pass when run again: the runner's, one that is green here on the same commit,
// or one GitHub already saw pass on this commit.
const transient = (f) => f.class === 'infra' || f.baseline?.result === 'not_reproduced' || f.passed_before === true || f.jev_transient === true;
const rerunnable = (run, f) => transient(f) && !spent(run, f);
const toFix = (run) => run.failures.filter((f) => inScope(run, f) && f.baseline?.result !== 'not_reproduced');
const verdictOf = (run) => (toFix(run).length ? 'fixable' : run.failures.some((f) => rerunnable(run, f)) ? 'rerun_offered' : 'report_only');

function failureView(run, f) {
  const v = { id: f.id, class: f.class, evidence: f.evidence, jobs: f.jobs.map((j) => j.name), workflow: f.jobs[0].workflow, url: f.jobs[0].url };
  if (f.class === 'external' || f.class === 'derived') return v;
  Object.assign(v, { command: f.command, errors: f.errors, ...(f.more_errors ? { more_errors: f.more_errors } : {}), excerpt: f.excerpt, log: f.log });
  if (f.class === 'code') Object.assign(v, { repro: f.repro, repro_why: f.repro_why, in_scope: inScope(run, f) });
  if (f.also_red_on_base) v.also_red_on_base = true;
  if (f.passed_before) v.passed_before = true;
  if (f.baseline) v.here = { result: f.baseline.result, ...(f.baseline.matched ? { because: f.baseline.matched } : {}) };
  if (rerunnable(run, f)) v.rerun = 'offered';
  else if (transient(f)) v.rerun = 'already rerun once, and red again';
  if (f.jev_transient) v.jev = 'Jev reads this failure as one that passes when run again';
  return v;
}

// Every failed check of one commit, read, cut, classed and merged by cause.
// ctx: { repo, root, slug, run_id, base, head_sha, config, scripts, reran: Set(job names) }
function readFailures(ctx, rows) {
  const failed = rows.filter((r) => r.state === 'fail');
  const logDir = S.sub(ctx.run_id, join('logs', short(ctx.head_sha)));
  const jobs = failed.map((row) => {
    const j = { row, cut: null, shape: null, log: null };
    if (!row.actions) return j;
    const text = GH.jobLog(ctx.repo, ctx.slug, row.job_id);
    if (text === null) return j;
    const lines = L.clean(text);
    j.log = join(logDir, `job-${row.job_id}.log`);
    writeFileSync(j.log, lines.join('\n'));
    j.cut = L.cut(lines, GH.annotations(ctx.repo, ctx.slug, row.job_id));
    j.shape = shape(j.cut.script, { uses: j.cut.uses, scripts: ctx.scripts, mapped: mappedFor(ctx.config, row.name) });
    return j;
  });
  for (const j of jobs) {
    const errors = j.cut?.errors || [];
    j.cls = classify({
      actions: j.row.actions, log_read: Boolean(j.cut), conclusion: j.row.conclusion,
      error_texts: errors.map((e) => `${e.title}\n${e.message}`), excerpt: j.cut?.excerpt, own_error: Boolean(j.cut?.own_error), in_a_file: errors.some((e) => e.file),
      repro: j.shape?.repro, reran: ctx.reran.has(j.row.name),
      sibling_failed: jobs.some((o) => o !== j && o.row.run_id && o.row.run_id === j.row.run_id && o.cut?.own_error),
    });
  }
  const groups = new Map();
  for (const j of jobs) {
    const sig = j.cut ? L.signature(j.shape.command ?? j.cut.command, j.cut.errors) : sha1(j.row.name).slice(0, 12);
    const key = `${j.cls.class}:${sig}`;
    if (!groups.has(key)) groups.set(key, { sig, list: [] });
    groups.get(key).list.push(j);
  }
  const baseCache = new Map();
  const redOnBase = (row) => {
    if (!row.workflow) return null;
    if (!baseCache.has(row.workflow)) baseCache.set(row.workflow, GH.baseJobs(ctx.repo, ctx.slug, ctx.base, row.workflow));
    const state = baseCache.get(row.workflow)?.[row.name];
    return state === undefined ? null : state === 'fail';
  };
  return [...groups.values()].map(({ sig, list }, n) => {
    const [j] = list;
    const f = {
      id: `f${n + 1}`, class: j.cls.class, evidence: j.cls.evidence, signature: sig,
      jobs: list.map((x) => ({ name: x.row.name, workflow: x.row.workflow, job_id: x.row.job_id, run_id: x.row.run_id, url: x.row.url, conclusion: x.row.conclusion })),
      command: j.shape?.command ?? j.cut?.command ?? null, errors: j.cut?.errors || [], more_errors: j.cut?.more_errors || 0, excerpt: j.cut?.excerpt || '', log: j.log,
      repro: j.cls.class === 'code' ? j.shape.repro : null, repro_why: j.cls.class === 'code' ? j.shape.why : null, baseline: null,
    };
    if (f.class === 'code' || f.class === 'infra') {
      f.also_red_on_base = list.some((x) => redOnBase(x.row) === true);
      f.passed_before = list.some((x) => GH.passedBefore(ctx.repo, ctx.slug, x.row) === true);
    }
    return f;
  });
}

const packageScripts = (root, sha) => {
  try {
    return JSON.parse(G.fileAt(root, sha, 'package.json') || '{}').scripts || {};
  } catch {
    return {};
  }
};
const ctxOf = (run, config) => ({ repo: run.cwd_repo, root: run.root, slug: run.slug, run_id: run.run_id, base: run.base.branch, head_sha: run.head.sha, config, scripts: packageScripts(run.root, run.head.sha), reran: new Set(Object.keys(run.reruns || {})) });

// What the script will run, will show first, and will never run.
function commandsView(run, config) {
  const scope = toFix(run);
  const pick = (kind) => [...new Set(scope.filter((f) => f.repro === kind && f.command).map((f) => f.command))];
  const v = { run: pick('run'), ask: scope.filter((f) => f.repro === 'ask').map((f) => ({ id: f.id, command: f.command, why: f.repro_why })), never: scope.filter((f) => f.repro === 'never').map((f) => ({ id: f.id, command: f.command, why: f.repro_why })) };
  if (run.workspace?.mode === 'worktree' && scope.length) v.install = config.install || null;
  v.note = v.run.length || v.ask.length ? 'these commands run the pull request\'s code on this machine, as its own workflow wrote them' : 'no failing command can be run here: a fix will be reported as not proven';
  return v;
}

const counts = (failures) => {
  const c = {};
  for (const f of failures) c[f.class] = (c[f.class] || 0) + 1;
  return c;
};

// Paths that differ from the head and are not what a command left behind.
function changedNotNoise(run, tree) {
  const noise = run.noise || {};
  return G.changedPaths(run.root, headTree(run), tree).filter((p) => !(p in noise && (G.blobAt(run.root, tree, p) || 'gone') === noise[p]));
}
const noteNoise = (run, tree, paths) => {
  run.noise ||= {};
  for (const p of paths) run.noise[p] = G.blobAt(run.root, tree, p) || 'gone';
};

function headGate(run, gates) {
  const remoteHead = G.remoteHead(run.root, run.remote, run.head.branch);
  if (remoteHead === null) gates.head_unchanged = gate('block', `${run.remote} could not be asked where ${run.head.branch} is: an old answer proves nothing`);
  else if (remoteHead !== run.head.sha) gates.head_unchanged = gate('block', `the pull request head moved from ${short(run.head.sha)}${remoteHead ? ` to ${short(remoteHead)}` : ''}: this round is over. Start again`);
  else gates.head_unchanged = gate('pass', `the pull request head is still ${short(run.head.sha)}`);
  return gates.head_unchanged.status !== 'block';
}

// ---------------------------------------------------------------- Jev
async function askJev(run, mode, { failures = [], edits = [] }) {
  if (mode === 'off') return mode;
  const built = Q.build(`${run.slug}#${run.pr.number}`, run.pr, failures, edits);
  run.jev_seen ||= [];
  const fresh = built.cases.filter((c) => !run.jev_seen.includes(c.case));
  if (!fresh.length) return mode;
  const res = await ask({ state: built.state, questions: Object.fromEntries(fresh.map((c) => [c.key, built.questions[c.key]])) });
  if (res.degraded) return 'degraded';
  const cases = [];
  for (const c of fresh) {
    const p = res.answers[c.key]?.noul;
    if (typeof p !== 'number') continue;
    run.jev_seen.push(c.case);
    const sp = Q.spot(c.question, c.case);
    const acted = mode === 'live' && Q.calibrated(c.question) && !sp;
    cases.push({ skill: Q.SKILL, question: c.question, case: c.case, p, threshold: Q.thr(c.question), ...Q.SHAPE[c.question], mode, acted, ...(sp ? { spot: true } : {}), show: c.show });
    const why = acted ? Q.reason(c.question, p) : null;
    if (c.question === 'failure_is_transient') {
      const f = run.failures.find((x) => x.id === c.target);
      if (!f) continue;
      f.jev_case = { case: c.case, p };
      // It can add an offer. It never takes a failure off the list to fix.
      if (why) f.jev_transient = true;
      continue;
    }
    // The case id holds the edit's reason: a changed edit is a new case, and a new question.
    const file = c.target.slice(5);
    const edit = edits.find((e) => e.file === file);
    if (why && edit) (run.jev_asks ||= {})[`jev:${file}`] = { reason: why, hash: edit.hash };
  }
  C.writeCases(S.jevLog(), cases, redactBody);
  return mode;
}
const jevFailures = (run) => run.failures.filter((f) => (f.class === 'code' || f.class === 'infra') && f.log).map((f) => ({ id: f.id, job: f.jobs[0].name, workflow: f.jobs[0].workflow || '', command: f.command || '', error: L.headline(f.errors), hash: f.signature }));
// What a rerun showed: green without a change means the failure was a passing one.
function labelTransient(run, f, passed) {
  if (!f.jev_case) return;
  C.writeLabel(S.jevLog(), { skill: Q.SKILL, question: 'failure_is_transient', case: f.jev_case.case, label: passed, source: 'rerun', p: f.jev_case.p, unsafe: Q.SHAPE.failure_is_transient.unsafe });
}

// ---------------------------------------------------------------- start
function parseInput(args) {
  const a = args.map(String);
  if (a[0] === 'status') return { mode: 'status' };
  if (a[0] === 'drop') return { mode: 'drop', run: a[1] };
  const flags = { no_push: false, worktree: false };
  let pr = null;
  for (const t of a) {
    if (t === '--no-push') flags.no_push = true;
    else if (t === '--worktree') flags.worktree = true;
    else if (t.startsWith('-')) throw new Error(`unknown flag ${t} (known: ${ARG_FLAGS.join(', ')})`);
    else if (pr) throw new Error(`one pull request per run: got ${JSON.stringify(pr)} and ${JSON.stringify(t)}`);
    else pr = t;
  }
  return { mode: 'fix', pr, flags };
}

// "12", "#12" or a pull request link of this repository. -> number
function prNumber(ref, slug) {
  const plain = /^#?(\d+)$/.exec(ref);
  if (plain) return Number(plain[1]);
  const link = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(ref);
  if (!link) throw new Error(`${JSON.stringify(ref.slice(0, 80))} is not a pull request number or link`);
  if (link[1].toLowerCase() !== String(slug).toLowerCase()) throw new Error(`that pull request belongs to ${link[1]}, and this checkout is ${slug}`);
  return Number(link[2]);
}

const statusOf = (root) =>
  S.allRuns().filter((r) => r.root === root && !r.ended).map((r) => ({ run_id: r.run_id, pull_request: r.pr.number, title: r.pr.title, round: r.round, verdict: r.watch ? 'pending' : r.checked?.verdict || verdictOf(r), workspace: r.workspace?.mode || null, created_at: r.created_at }));

// Where the fix is made. The user's checkout has the dependencies installed
// already; it is used only when what is in it is exactly what CI ran.
function chooseWorkspace(repo, pr, headSha, flags) {
  if (flags.worktree) return { mode: 'worktree', why: 'asked for with --worktree' };
  const branch = G.currentBranch(repo);
  if (branch !== pr.head) return { mode: 'worktree', why: `this checkout is on ${branch ? `\`${branch}\`` : 'no branch'}, not on \`${pr.head}\`` };
  if (G.headOf(repo) !== headSha) return { mode: 'worktree', why: `this checkout is not at the pull request head (${short(headSha)})` };
  if (!G.isClean(repo)) return { mode: 'worktree', why: 'this checkout has uncommitted or untracked changes' };
  return { mode: 'checkout', path: repo, why: 'this checkout is on the pull request branch, clean and at its head' };
}

function startView(run, config, gates, jev, extra = {}) {
  const verdict = verdictOf(run);
  const scope = toFix(run);
  const next = {
    fixable: `${scope.some((f) => f.repro === 'ask') ? 'show each command in `commands.ask` and ask whether to run it; ' : ''}call repro before any edit`,
    rerun_offered: 'nothing here is the code\'s to fix: say what failed and why, and ask whether to run the failed jobs again',
    report_only: 'nothing here can be fixed by a commit or a rerun: say what failed, with its evidence, and who can fix it',
  }[verdict];
  return {
    mode: 'fix', run_id: run.run_id, verdict, round: run.round, max_rounds: config.max_rounds, pr: run.pr, base: run.base.branch, head: run.head,
    workspace: run.workspace, failures: run.failures.map((f) => failureView(run, f)), counts: counts(run.failures), ...gateView(gates),
    commands: commandsView(run, config), no_push: run.flags.no_push, jev, next, ...extra,
  };
}

export async function start(input) {
  const repo = G.topLevel(resolvePath(input.repo || process.cwd()));
  if (!repo) throw new Error('not inside a git repository');
  const root = G.mainRoot(repo);
  const parsed = parseInput(input.args || []);
  if (parsed.mode === 'status') return { mode: 'status', runs: statusOf(root) };
  if (parsed.mode === 'drop') return { mode: 'drop', ...drop({ run: parsed.run }) };

  const slug = GH.repoSlug(repo);
  if (!slug) throw new Error('this is not a GitHub repository, or `gh` is not signed in: /fix-ci works on GitHub pull requests');
  const number = parsed.pr ? prNumber(parsed.pr, slug) : GH.currentPr(repo);
  if (!number) {
    const mine = GH.myFailing(repo);
    return { mode: 'fix', needs: ['input'], candidates: mine ?? [], ...(mine === null ? { note: 'your open pull requests could not be listed' } : {}), next: 'the current branch has no pull request: ask which pull request, offering `candidates`. Never pick' };
  }
  const pr = GH.prView(repo, number);
  if (!pr) throw new Error(`no pull request #${number} in ${slug}`);
  const prView = { number: pr.number, title: pr.title, url: pr.url, author: pr.author };
  const gates = {};
  const blocked = (extra = {}) => ({ mode: 'fix', verdict: 'blocked', pr: prView, ...gateView(gates), ...extra });

  gates.pr_open = pr.state === 'OPEN' ? gate('pass', 'the pull request is open') : gate('block', `the pull request is ${String(pr.state).toLowerCase()}: there is nothing to make green`);
  gates.same_repo = pr.fork ? gate('block', 'the head branch lives in a fork: this skill runs the pull request\'s code and pushes only to branches of this repository') : gate('pass', 'the head branch is in this repository');
  gates.conflicts = pr.mergeable === 'CONFLICTING' ? gate('block', 'the pull request conflicts with its base: CI is not running on what would merge. Run /real-skills:solve-merge-conflicts first') : pr.mergeable === 'MERGEABLE' ? gate('pass', 'the pull request merges with its base') : gate('unknown', 'GitHub has not said whether the pull request merges with its base');
  if (of(gates, 'block').length) return blocked();

  const remote = G.remoteFor(repo, slug);
  if (!remote) throw new Error(`no git remote of this checkout points at ${slug}, and there are several: the push could land in another repository. Add a remote for ${slug} and start again`);
  const fetched = G.fetchRefs(repo, remote, [pr.base, pr.head]);
  const headSha = G.tip(repo, remote, pr.head);
  const baseSha = G.tip(repo, remote, pr.base);
  if (!fetched || !headSha || !baseSha) {
    gates.head_unchanged = gate('block', `${pr.base} and ${pr.head} could not be fetched from ${remote}: old refs prove nothing`);
    return blocked();
  }
  if (headSha !== pr.head_sha) {
    gates.head_unchanged = gate('block', `GitHub says the head is ${short(pr.head_sha)} and the fetch got ${short(headSha)}: someone is pushing. Try again in a moment`);
    return blocked();
  }

  const { config, ignored } = loadConfig([repo, root], { repo: root, base: baseSha, head: headSha });
  const rows = pr.checks.filter((r) => !isIgnored(config, r.name));
  const skipped = pr.checks.length - rows.length;
  const [failed, pending] = [rows.filter((r) => r.state === 'fail'), rows.filter((r) => r.state === 'pending')];
  // A new run for a pull request ends the ones before it: one run per pull request at a time.
  // A worktree that holds a fix nobody pushed is not removed: it is named instead.
  const kept = [];
  for (const old of S.allRuns().filter((r) => r.slug === slug && r.pr.number === pr.number && !r.ended)) if (endRun(old, 'a newer run was started for this pull request', { keep: true }) === false) kept.push({ run_id: old.run_id, worktree: old.workspace.path });
  const keptNote = kept.length ? { kept_worktrees: kept, kept_because: 'an earlier run of this pull request left edits in its worktree that were never pushed: say so. Nothing was removed' } : {};
  if (!failed.length && !pending.length) {
    S.appendLog({ repo: slug, pr: pr.number, verdict: 'nothing_to_fix' });
    return { mode: 'fix', verdict: 'nothing_to_fix', pr: prView, ...gateView(gates), ...keptNote, checks: rows.length, ...(skipped ? { ignored_checks: skipped } : {}), ...(rows.length ? {} : { note: 'this commit has no checks' }) };
  }

  const run = {
    run_id: S.newRunId(), created_at: now(), root, cwd_repo: repo, slug, remote, flags: parsed.flags,
    pr: { number: pr.number, title: pr.title, url: pr.url }, base: { branch: pr.base, sha: baseSha }, head: { branch: pr.head, sha: headSha }, start_head: headSha,
    round: 1, failures: [], reruns: {}, history: [], noise: {}, workspace: null,
  };
  if (!failed.length) {
    run.watch = { sha: headSha, started_at: now(), after: 'start' };
    run.start_gates = gates;
    S.saveRun(run);
    S.appendLog({ run: run.run_id, repo: slug, pr: pr.number, verdict: 'ci_running' });
    return { mode: 'fix', run_id: run.run_id, verdict: 'ci_running', pr: prView, ...gateView(gates), ...keptNote, running: pending.map((r) => r.name), next: 'nothing failed yet: say so. `watch` waits for the checks to finish' };
  }
  gates.ci_pending = pending.length ? gate('warn', `${plural(pending.length, 'check')} still running (${pending.slice(0, 5).map((r) => r.name).join(', ')}): more may fail`) : gate('pass', 'every check has finished');

  run.failures = readFailures(ctxOf(run, config), rows);
  const onBase = run.failures.filter((f) => f.class === 'code' && f.also_red_on_base);
  gates.red_on_base = onBase.length ? gate('warn', `${onBase.map((f) => f.id).join(', ')} ${onBase.length === 1 ? 'is' : 'are'} red on ${pr.base} too: left out unless the user says to fix ${onBase.length === 1 ? 'it' : 'them'} here (\`include_base_red\` at repro)`) : gate('pass', `none of the failures is red on ${pr.base} too`);
  const ahead = G.localAhead(repo, pr.head, headSha);
  gates.local_unpushed = ahead ? gate('warn', `your local ${pr.head} holds ${plural(ahead, 'commit')} the pull request lacks: CI ran the pull request head (${short(headSha)}), and that is what gets fixed`) : gate('pass', 'no local commits are missing from the pull request');

  const jev = await askJev(run, jevMode(config), { failures: jevFailures(run) });
  if (run.failures.some((f) => f.class === 'code')) {
    run.workspace = chooseWorkspace(repo, pr, headSha, parsed.flags);
    if (run.workspace.mode === 'worktree') run.workspace.path = G.addWorktree(root, run.run_id, headSha);
  }
  run.start_gates = gates;
  S.saveRun(run);
  S.appendLog({ run: run.run_id, repo: slug, pr: pr.number, round: 1, verdict: verdictOf(run), classes: counts(run.failures), workspace: run.workspace?.mode || null, jev });
  return startView(run, config, gates, jev, { ...keptNote, ...(skipped ? { ignored_checks: skipped } : {}), ...(ignored.length ? { ignored_config: ignored, ignored_because: 'the pull request adds this config file: a pull request does not choose the commands that run on it' } : {}) });
}

// ---------------------------------------------------------------- repro
export function repro(input) {
  const run = loadActive(input.run);
  const { config } = configOf(run);
  const gates = {};
  if (!headGate(run, gates)) return { run_id: run.run_id, verdict: 'blocked', ...gateView(gates) };
  if (input.include_base_red === true && !run.include_base_red) {
    run.include_base_red = true;
    for (const k of ['checked', 'proof']) delete run[k];
  }
  const ws = run.workspace?.path;
  if (!ws || !existsSync(ws)) throw new Error('this run has no workspace: it has no failure a code change can fix');
  if (G.headOf(ws) !== run.head.sha) throw new Error(`${ws} is no longer at the pull request head (${short(run.head.sha)}): start again`);
  const dirty = changedNotNoise(run, G.treeNow(ws, indexFile(run), run.head.sha));
  if (dirty.length) throw new Error(`repro runs before any edit, and ${dirty.slice(0, 5).join(', ')} ${dirty.length === 1 ? 'is' : 'are'} changed: undo the change, or go on to check`);

  const confirm = new Set((Array.isArray(input.confirm) ? input.confirm : []).map(String));
  const logDir = S.sub(run.run_id, join('runs', `round-${run.round}`));
  const opts = { timeoutS: config.gate_timeout_s };
  const scope = run.failures.filter((f) => inScope(run, f));
  let install = null;
  if (run.workspace.mode === 'worktree' && config.install && !run.installed && scope.some((f) => !f.baseline && (f.repro === 'run' || confirm.has(f.id)))) {
    const r = R.run(ws, config.install, { ...opts, log: join(logDir, 'install.log') });
    install = { command: config.install, ok: r.ok, ...(r.ok ? {} : { exit: r.exit, tail: R.tail(r.text), log: r.log }) };
    run.installed = r.ok;
  }
  const done = new Map();
  for (const f of scope.filter((x) => !x.baseline)) {
    if (f.repro === 'never') f.baseline = { result: 'not_run', matched: f.repro_why };
    else if (f.repro === 'ask' && !confirm.has(f.id)) continue;
    else if (install && !install.ok) f.baseline = { result: 'not_run', matched: `\`${config.install}\` failed here, so nothing could be run` };
    else {
      if (!done.has(f.command)) done.set(f.command, R.run(ws, f.command, { ...opts, log: join(logDir, `before-${f.id}.log`) }));
      const r = done.get(f.command);
      const c = R.compare(r, L.needles(f.errors));
      f.baseline = { ...c, exit: r.exit, log: r.log, ...(r.ok ? {} : { tail: R.tail(r.text) }) };
    }
  }
  // What the commands left behind (coverage, build output) is theirs, not an edit.
  const after = G.treeNow(ws, indexFile(run), run.head.sha);
  noteNoise(run, after, G.changedPaths(run.root, headTree(run), after));
  S.saveRun(run);

  const asks = scope.filter((f) => !f.baseline && f.repro === 'ask').map((f) => ({ id: f.id, command: f.command, why: f.repro_why }));
  const verdict = verdictOf(run);
  S.appendLog({ run: run.run_id, repo: run.slug, pr: run.pr.number, round: run.round, step: 'repro', results: Object.fromEntries(R.RESULTS.map((k) => [k, scope.filter((f) => f.baseline?.result === k).length])) });
  return {
    run_id: run.run_id, verdict, round: run.round, workspace: run.workspace, ...gateView(gates), ...(install ? { install } : {}),
    results: scope.filter((f) => f.baseline).map((f) => ({ id: f.id, jobs: f.jobs.map((j) => j.name), command: f.command, result: f.baseline.result, because: f.baseline.matched, ...(f.baseline.tail && f.baseline.result !== 'not_reproduced' ? { tail: f.baseline.tail, log: f.baseline.log } : {}) })),
    asks,
    next: asks.length ? 'show each command in `asks` and ask whether to run it. Yes: repro again with its id in `confirm`. No: go on; that fix will be reported as not proven'
      : verdict === 'fixable' ? `fix each failure in ${ws}, then check. A \`differs\` or \`not_run\` failure can still be fixed from its log; it is reported as not proven`
      : verdict === 'rerun_offered' ? 'nothing is red here on the same commit: say so, and ask whether to run the failed jobs again' : 'nothing here can be fixed by a commit or a rerun: say what failed and who can fix it',
  };
}

// ---------------------------------------------------------------- check
function commitMessage(subject, edits, fixed) {
  const jobs = [...new Set(fixed.flatMap((f) => f.jobs.map((j) => j.name)))];
  return `${subject}\n\n${edits.map((e) => `- ${e.file}: ${e.why}`).join('\n')}\n\nCI: ${jobs.join(', ')}\n`;
}

// The flags of this fix, with the answers that still hold: an answer is for one
// flag on one content of the file, and is void once that content changes.
function flagAsks(run, computed, edits) {
  const next = {};
  const held = (id, hash) => (run.flag_asks?.[id]?.decided === hash ? hash : null);
  for (const c of computed) next[c.id] = { flag: c.flag, file: c.file, reason: c.reason, hash: c.hash, decided: held(c.id, c.hash) };
  for (const [id, j] of Object.entries(run.jev_asks || {})) {
    const edit = edits.find((e) => `jev:${e.file}` === id);
    if (!edit || edit.hash !== j.hash) delete run.jev_asks[id];
    else next[id] = { flag: 'jev', file: edit.file, reason: j.reason, hash: j.hash, decided: held(id, j.hash) };
  }
  run.flag_asks = next;
  return Object.entries(next).filter(([, a]) => !a.decided).map(([id, a]) => ({ id, flag: a.flag, file: a.file, reason: a.reason }));
}

export async function check(input) {
  const run = loadActive(input.run);
  const { config } = configOf(run);
  const gates = {};
  const done = (verdict, extra = {}) => {
    if (verdict !== 'fixed' && verdict !== 'fixed_unverified') delete run.checked;
    S.saveRun(run);
    return { run_id: run.run_id, verdict, round: run.round, ...gateView(gates), ...extra };
  };
  if (!headGate(run, gates)) return done('blocked');
  const ws = run.workspace?.path;
  if (!ws || !existsSync(ws)) throw new Error('this run has no workspace: it has no failure a code change can fix');
  if (G.headOf(ws) !== run.head.sha) throw new Error(`${ws} is no longer at the pull request head (${short(run.head.sha)}): start again`);
  const scope = run.failures.filter((f) => inScope(run, f));
  const unrun = scope.filter((f) => f.repro === 'run' && !f.baseline);
  if (unrun.length) throw new Error(`call repro first: ${unrun.map((f) => f.id).join(', ')} ${unrun.length === 1 ? 'was' : 'were'} never run here, so there is nothing to compare the fix with`);

  // 1. Listed: what git says changed is exactly what the agent says it changed.
  const tree = G.treeNow(ws, indexFile(run), run.head.sha);
  const changed = changedNotNoise(run, tree);
  const byId = new Map(scope.map((f) => [f.id, f]));
  const edits = [];
  const problems = [];
  for (const e of Array.isArray(input.edits) ? input.edits : []) {
    try {
      const file = repoPath(e.file);
      const why = oneLine(e.why);
      if (!why) throw new Error(`${file}: \`why\` is missing`);
      const ids = [].concat(e.failure ?? []).map(String);
      if (!ids.length) throw new Error(`${file}: \`failure\` is missing: every edit is for a failure of this round`);
      for (const id of ids) if (!byId.has(id)) throw new Error(`${file}: ${id} is not a failure this run fixes (known: ${[...byId.keys()].join(', ') || 'none'})`);
      if (!changed.includes(file)) throw new Error(file in (run.noise || {}) ? `${file} holds exactly what a command left there, so it does not count as an edit: change it, or take it off the list` : `${file} is listed as an edit and is unchanged`);
      if (edits.some((x) => x.file === file)) throw new Error(`${file} is listed twice`);
      edits.push({ file, why, failures: ids, hash: sha1({ file, why, ids }) });
    } catch (err) {
      problems.push(err.message);
    }
  }
  const leave = [];
  for (const l of Array.isArray(input.leave) ? input.leave : []) {
    if (!byId.has(String(l.failure))) problems.push(`leave: ${l.failure} is not a failure this run fixes`);
    else if (!oneLine(l.why)) problems.push(`leave: ${l.failure} needs a \`why\``);
    else leave.push({ failure: String(l.failure), why: oneLine(l.why) });
  }
  const subject = oneLine(input.subject, 200);
  if (!subject) problems.push('`subject` is missing: the first line of the commit message');
  else if (subject.length > SUBJECT_CHARS) problems.push(`\`subject\` is ${subject.length} characters: ${SUBJECT_CHARS} at most`);
  const unlisted = changed.filter((p) => !edits.some((e) => e.file === p)).sort();
  if (!changed.length) problems.push('nothing is changed in the workspace: there is no fix to check');
  if (unlisted.length || problems.length) {
    gates.listed = gate('block', [unlisted.length ? `${plural(unlisted.length, 'file')} changed and not listed: ${unlisted.slice(0, 10).join(', ')}` : null, ...problems].filter(Boolean).join('; '));
    return done('needs_decision', { unlisted, problems, next: 'list each changed file in `edits` with one line on why and the failure it is for, or undo the change' });
  }
  gates.listed = gate('pass', `${plural(edits.length, 'file')} changed, each listed`);
  const files = edits.map((e) => e.file);
  const treeOfEdits = () => G.editTree(ws, indexFile(run, 'index.edit'), run.head.sha, files);

  // 2. Proof: every command that was red here for CI's reason runs again.
  const left = new Set(leave.map((l) => l.failure));
  const toProve = scope.filter((f) => f.baseline?.result === 'reproduced' && !left.has(f.id));
  let edited = treeOfEdits();
  if (toProve.length && (run.proof?.tree !== edited || toProve.some((f) => !run.proof.results[f.command]))) {
    const logDir = S.sub(run.run_id, join('runs', `round-${run.round}`));
    const results = {};
    for (const f of toProve) {
      if (results[f.command]) continue;
      const r = R.run(ws, f.command, { timeoutS: config.gate_timeout_s, log: join(logDir, `after-${f.id}-${Date.now()}.log`) });
      results[f.command] = { ok: r.ok, exit: r.exit, log: r.log, ...(r.ok ? {} : { tail: R.tail(r.text) }) };
    }
    const after = G.treeNow(ws, indexFile(run), run.head.sha);
    noteNoise(run, after, G.changedPaths(run.root, tree, after).filter((p) => !files.includes(p)));
    // A command may have rewritten a listed file (a formatter): the commit holds what is there now.
    edited = treeOfEdits();
    run.proof = { tree: edited, results };
  }
  const proofOf = (f) => run.proof?.results?.[f.command];
  const red = toProve.filter((f) => !proofOf(f)?.ok);
  if (red.length) {
    gates.proof = gate('block', `${red.map((f) => f.id).join(', ')} still red here: ${red.map((f) => `\`${f.command}\``).join(', ')}`);
    S.appendLog({ run: run.run_id, repo: run.slug, pr: run.pr.number, round: run.round, verdict: 'still_red', edits: edits.length, red: red.length });
    return done('still_red', { red: red.map((f) => ({ id: f.id, command: f.command, exit: proofOf(f).exit, tail: proofOf(f).tail, log: proofOf(f).log })), next: 'read each tail, fix what is still failing, list every changed file and check again. Nothing is pushed' });
  }
  const fixed = scope.filter((f) => edits.some((e) => e.failures.includes(f.id)));
  const unproven = fixed.filter((f) => f.baseline?.result !== 'reproduced');
  gates.proof = !toProve.length ? gate('unknown', 'no failing command could be run here: the fix is not proven') : unproven.length ? gate('warn', `${plural(toProve.length, 'command')} green here; ${unproven.map((f) => f.id).join(', ')} could not be proven here`) : gate('pass', `${plural(toProve.length, 'command')} that ${toProve.length === 1 ? 'was' : 'were'} red here ${toProve.length === 1 ? 'is' : 'are'} green`);

  // 3. Shortcuts: each one is the user's call.
  const changes = files.map((file) => ({ file, before: G.fileAt(run.root, run.head.sha, file), after: G.fileAt(run.root, edited, file) }));
  const computed = flagsOf(changes, scope, { check_config: config.check_config, max_files: config.max_files, max_lines: config.max_lines, lines_changed: G.linesChanged(run.root, headTree(run), edited) });
  const errorOf = (e) => L.headline(byId.get(e.failures[0]).errors) || byId.get(e.failures[0]).command || '';
  const jev = await askJev(run, jevMode(config), { edits: edits.map((e) => ({ ...e, error: errorOf(e) })) });
  const asks = flagAsks(run, computed, edits);
  if (asks.length) {
    gates.flags = gate('block', `${plural(asks.length, 'question')} waiting for the user's answer`);
    return done('needs_decision', { asks, jev, next: 'ask the user each one: the file, what the fix does there, why, and what you recommend. Yes: decide --id <id> --confirmed, then check again. No: change the fix' });
  }
  const answered = Object.entries(run.flag_asks).map(([id, a]) => ({ id, flag: a.flag, file: a.file, reason: a.reason }));
  gates.flags = answered.length ? gate('warn', `${plural(answered.length, 'shortcut')} the user said yes to: ${answered.map((a) => a.id).join(', ')}`) : gate('pass', 'the fix takes none of the known shortcuts');

  // 4. The commit: the head, plus the listed files as they are now.
  const commit = G.commitTree(ws, edited, run.head.sha, commitMessage(subject, edits, fixed.length ? fixed : scope));
  const verdict = gates.proof.status === 'pass' ? 'fixed' : 'fixed_unverified';
  run.checked = { tree: edited, commit, at: now(), verdict, files, fixed: fixed.map((f) => f.id) };
  const unaddressed = scope.filter((f) => !fixed.includes(f) && !left.has(f.id) && !proofOf(f)?.ok).map((f) => f.id);
  const others = run.failures.filter((f) => !inScope(run, f) && f.class !== 'derived').map((f) => ({ id: f.id, class: f.class, jobs: f.jobs.map((j) => j.name), evidence: f.evidence, ...(f.class === 'code' ? { why: `red on ${run.base.branch} too: left out` } : {}) }));
  const restate = [...of(gates, 'warn'), ...of(gates, 'unknown')].map((k) => gates[k].text).concat(Object.values(run.start_gates || {}).filter((g) => g.status === 'warn' || g.status === 'unknown').map((g) => g.text));
  if (unaddressed.length) restate.push(`${unaddressed.join(', ')} ${unaddressed.length === 1 ? 'was' : 'were'} not addressed by this fix`);
  if (others.length) restate.push(`${others.map((o) => o.id).join(', ')} ${others.length === 1 ? 'is' : 'are'} not fixed by this commit: ${others.map((o) => `${o.jobs[0]} (${o.class})`).join(', ')}`);
  S.appendLog({ run: run.run_id, repo: run.slug, pr: run.pr.number, round: run.round, verdict, edits: edits.length, fixed: fixed.length, unproven: unproven.length, flags: Object.fromEntries(answered.map((a) => [a.id.split(':')[0], true])), left: leave.length, jev });
  const pushLine = `git -C ${JSON.stringify(ws)} push ${run.remote} ${commit}:refs/heads/${run.head.branch}`;
  return done(verdict, {
    commit,
    summary: {
      pull_request: run.pr, subject,
      fixes: fixed.map((f) => ({ failure: f.id, jobs: f.jobs.map((j) => j.name), command: f.command, proof: f.baseline?.result === 'reproduced' ? 'red here before, green here now' : `not proven here: ${f.baseline?.matched || 'its command was not run'}` })),
      edits: edits.map((e) => ({ file: e.file, why: e.why, failure: e.failures.join(', ') })), answered, left: leave, unaddressed, not_fixed_here: others,
    },
    restate, jev,
    ...(run.flags.no_push ? { push_command: pushLine, next: '--no-push: show the summary and the command. Do not run it' } : { ask: `Push one commit (${short(commit)}) to ${run.head.branch}, the branch of pull request #${run.pr.number}? It adds to the branch and rewrites nothing, and it runs every check again.${verdict === 'fixed_unverified' ? ' The fix was not proven here.' : ''}` }),
  });
}

export function decide(a) {
  const run = loadActive(a.run);
  const id = String(a.id || '');
  const asked = run.flag_asks?.[id];
  if (!asked) throw new Error(`no open question ${id || '(no id)'} in this run (known: ${Object.keys(run.flag_asks || {}).join(', ') || 'none'}): check lists them`);
  if (a.confirmed !== true) return { decided: false, refused: 'needs --confirmed: the user\'s yes to this one question, in this conversation' };
  asked.decided = asked.hash;
  delete run.checked;
  S.saveRun(run);
  S.appendLog({ run: run.run_id, repo: run.slug, pr: run.pr.number, round: run.round, step: 'decide', flag: asked.flag });
  return { decided: true, id, next: 'check again' };
}

// ---------------------------------------------------------------- push, rerun
export function push(a) {
  const run = loadActive(a.run);
  const refuse = (reason, gates = {}) => ({ pushed: false, refused: reason, ...(Object.keys(gates).length ? gateView(gates) : {}) });
  if (run.flags.no_push) return refuse('this run was started with --no-push');
  if (!run.checked?.commit) return refuse('nothing was checked yet, or something changed since: run check first');
  if (a.confirmed !== true) return refuse('needs --confirmed: the user\'s yes to this push, in this conversation');
  const ws = run.workspace.path;
  if (G.headOf(ws) !== run.head.sha) return refuse(`${ws} is no longer at the pull request head: start again`);
  const now_ = G.treeNow(ws, indexFile(run), run.head.sha);
  const stray = changedNotNoise(run, now_).filter((p) => !run.checked.files.includes(p));
  if (stray.length || G.editTree(ws, indexFile(run, 'index.edit'), run.head.sha, run.checked.files) !== run.checked.tree) return refuse('the workspace changed since check: run check again, and show the summary again');
  // The commit is read back from git, not taken on the run file's word.
  let made = null;
  try {
    made = { tree: G.treeOf(run.root, run.checked.commit), parents: G.parentsOf(run.root, run.checked.commit) };
  } catch {}
  if (!made || made.tree !== run.checked.tree || made.parents.join(' ') !== run.head.sha) return refuse('the checked commit is not this round\'s fix on the pull request head: run check again');

  const gates = {};
  const pr = GH.prView(run.cwd_repo, run.pr.number);
  gates.pr_open = pr?.state === 'OPEN' ? gate('pass', 'the pull request is open') : gate('block', pr ? `the pull request is ${String(pr.state).toLowerCase()}` : 'the pull request could not be read');
  headGate(run, gates);
  if (pr && pr.head_sha !== run.head.sha && gates.head_unchanged.status === 'pass') gates.head_unchanged = gate('block', `GitHub says the pull request head is ${short(pr.head_sha)}, not ${short(run.head.sha)}: this round is over. Start again`);
  if (of(gates, 'block').length) return refuse(of(gates, 'block').map((k) => gates[k].text).join('; '), gates);

  const { commit } = run.checked;
  try {
    G.pushCommit(ws, run.remote, commit, run.head.branch);
  } catch (e) {
    return refuse(`git refused the push: ${G.firstLine(e)}`, gates);
  }
  const was = run.head.sha;
  run.history.push({ round: run.round, head: was, commit, at: now(), fixed: run.checked.fixed, fixed_signatures: run.failures.filter((f) => run.checked.fixed.includes(f.id)).map((f) => f.signature) });
  // HEAD follows the push. If it cannot, the push still happened: say so.
  let moved = true;
  try {
    G.advance(ws, commit, was);
  } catch {
    moved = false;
  }
  run.head.sha = commit;
  run.watch = { sha: commit, started_at: now(), after: 'push' };
  for (const k of ['checked', 'proof', 'flag_asks', 'jev_asks']) delete run[k];
  S.saveRun(run);
  S.appendLog({ run: run.run_id, repo: run.slug, pr: run.pr.number, round: run.round, verdict: 'pushed' });
  const behind = run.workspace.mode === 'worktree' && G.hasLocalBranch(run.root, run.head.branch);
  return {
    pushed: true, verdict: 'pushed', commit, round: run.round, pr: run.pr, ...gateView(gates), workspace: run.workspace.mode,
    ...(moved ? {} : { note: `the push went through, and ${ws} could not be moved to ${short(commit)}: \`git pull\` there` }),
    next: `CI runs again on ${short(commit)}: call watch.${behind ? ` The local ${run.head.branch} is one commit behind: \`git pull\` there.` : ''} Never say the checks are green before watch says so`,
  };
}

export function rerun(a) {
  const run = loadActive(a.run);
  const refuse = (reason, extra = {}) => ({ rerun: false, refused: reason, ...extra });
  if (run.checked?.commit) return refuse('this round has a fix to push: the push runs every check again');
  const jobs = run.failures.filter((f) => rerunnable(run, f)).flatMap((f) => f.jobs.filter((j) => j.job_id && !run.reruns[j.name]).map((j) => ({ ...j, failure: f.id })));
  if (!jobs.length) return refuse('nothing to run again: a rerun is for a failure of the runner or one that is green here on the same commit, once per job');
  const list = jobs.map((j) => ({ failure: j.failure, job: j.name }));
  if (a.confirmed !== true) return refuse('needs --confirmed: the user\'s yes to this rerun, in this conversation', { would_rerun: list });
  const gates = {};
  const pr = GH.prView(run.cwd_repo, run.pr.number);
  gates.pr_open = pr?.state === 'OPEN' ? gate('pass', 'the pull request is open') : gate('block', pr ? `the pull request is ${String(pr.state).toLowerCase()}` : 'the pull request could not be read');
  headGate(run, gates);
  if (of(gates, 'block').length) return refuse(of(gates, 'block').map((k) => gates[k].text).join('; '), gateView(gates));
  const failed = [];
  const asked = [];
  for (const j of jobs) {
    try {
      GH.rerunJob(run.cwd_repo, j.job_id);
      run.reruns[j.name] = { job: j.job_id, failure: j.failure, at: now() };
      asked.push(j);
    } catch (e) {
      failed.push({ job: j.name, error: G.firstLine(e) });
    }
  }
  if (asked.length) run.watch = { sha: run.head.sha, started_at: now(), after: 'rerun', jobs: asked.map((j) => j.job_id), names: asked.map((j) => j.name) };
  S.saveRun(run);
  S.appendLog({ run: run.run_id, repo: run.slug, pr: run.pr.number, round: run.round, step: 'rerun', jobs: asked.length, refused: failed.length });
  return { rerun: asked.length > 0, jobs: asked.map((j) => ({ failure: j.failure, job: j.name })), ...(failed.length ? { failed } : {}), ...gateView(gates), next: asked.length ? 'the jobs run again on the same commit: call watch' : 'GitHub refused every rerun: say why' };
}

// ---------------------------------------------------------------- watch
export async function watch(a) {
  const run = loadActive(a.run);
  if (!run.watch) throw new Error('nothing to watch: push or rerun first');
  const { config } = configOf(run);
  const budgetMs = Number(process.env.FIX_CI_WATCH_BUDGET_MS ?? 8 * 60 * 1000);
  const pollMs = Number(process.env.FIX_CI_POLL_MS ?? 20 * 1000);
  const began = Date.now();
  const w = run.watch;
  const gates = {};
  const view = (verdict, extra = {}) => ({ run_id: run.run_id, verdict, round: run.round, commit: w.sha, ...(Object.keys(gates).length ? gateView(gates) : {}), ...extra });
  let rows = [];
  let note = null;
  for (;;) {
    const pr = GH.prView(run.cwd_repo, run.pr.number);
    const waited = (Date.now() - Date.parse(w.started_at)) / 1000;
    let state = 'pending';
    if (!pr) note = 'the pull request could not be read';
    else if (pr.state !== 'OPEN') {
      gates.pr_open = gate('block', `the pull request is ${String(pr.state).toLowerCase()}`);
      endRun(run, `the pull request is ${String(pr.state).toLowerCase()}`);
      return view('blocked');
    } else if (pr.head_sha !== w.sha) {
      if (w.after === 'push' && pr.head_sha === run.history.at(-1)?.head) note = 'GitHub does not show the push yet';
      else {
        gates.head_unchanged = gate('block', `the pull request head is ${short(pr.head_sha)}, not the commit this run is watching (${short(w.sha)}): someone else pushed. This run is over`);
        endRun(run, 'the pull request head moved');
        return view('blocked');
      }
    } else {
      rows = pr.checks.filter((r) => !isIgnored(config, r.name));
      // A job that was rerun shows its old result until GitHub starts the new attempt.
      // Only for a while: should GitHub keep a job's id across attempts, its result is read after that.
      const stale = w.after === 'rerun' && waited <= NO_CI_S ? rows.filter((r) => w.jobs.includes(r.job_id) && r.state === 'fail') : [];
      const running = rows.filter((r) => r.state === 'pending').length + stale.length;
      if (!rows.length) {
        note = 'no check has appeared on this commit yet';
        if (waited > NO_CI_S) {
          S.appendLog({ run: run.run_id, repo: run.slug, pr: run.pr.number, round: run.round, verdict: 'timed_out', why: 'no_ci' });
          return view('timed_out', { note: `no check appeared on ${short(w.sha)} in ${Math.round(waited / 60)} minutes: CI did not start. Say so; nothing is known about this commit` });
        }
      } else if (running) note = `${plural(running, 'check')} still running`;
      else state = rows.some((r) => r.state === 'fail') ? 'red' : 'green';
    }
    if (state !== 'pending') {
      const out_ = await settle(run, config, state, rows);
      return view(out_.verdict, out_);
    }
    if (waited > config.watch_timeout_s) {
      S.appendLog({ run: run.run_id, repo: run.slug, pr: run.pr.number, round: run.round, verdict: 'timed_out' });
      return view('timed_out', { note: `${note} after ${Math.round(waited / 60)} minutes: this run stops waiting. Say so; \`watch\` can be called again later` });
    }
    if (Date.now() - began + pollMs > budgetMs) return view('pending', { note, waited_s: Math.round(waited), next: 'call watch again' });
    await sleep(pollMs);
  }
}

// CI finished on the watched commit.
async function settle(run, config, state, rows) {
  const w = run.watch;
  // What a rerun showed, for the failures Jev was asked about.
  if (w.after === 'rerun') for (const f of run.failures) for (const j of f.jobs.filter((x) => w.names.includes(x.name))) labelTransient(run, f, rows.find((r) => r.name === j.name)?.state === 'ok');
  if (state === 'green') {
    const removed = endRun(run, 'CI is green');
    S.appendLog({ run: run.run_id, repo: run.slug, pr: run.pr.number, round: run.round, verdict: 'green', after: w.after });
    return { verdict: 'green', checks: rows.length, after: w.after, ...(removed === null ? {} : { worktree_removed: removed }), next: `every check on ${short(w.sha)} is green: say so, with the pull request link${w.after === 'start' ? '. Nothing needed fixing' : ''}` };
  }
  // What the push claimed to fix. A failure that was left, or never addressed, is not the fix failing.
  const claimed = w.after === 'push' ? run.history.at(-1)?.fixed_signatures || [] : [];
  if (w.after === 'push') run.round += 1;
  delete run.watch;
  run.failures = readFailures(ctxOf(run, config), rows);
  for (const k of ['checked', 'proof', 'flag_asks', 'jev_asks']) delete run[k];
  const code = run.failures.filter((f) => f.class === 'code');
  const same = code.some((f) => claimed.includes(f.signature));
  const verdict = same ? 'stuck' : run.round > config.max_rounds ? 'gave_up' : 'red';
  S.appendLog({ run: run.run_id, repo: run.slug, pr: run.pr.number, round: run.round, verdict, after: w.after, classes: counts(run.failures) });
  const failures = run.failures.map((f) => failureView(run, f));
  if (verdict !== 'red') {
    endRun(run, verdict === 'stuck' ? 'the same failures came back after the fix' : `${plural(config.max_rounds, 'round')} spent`);
    return { verdict, failures, next: verdict === 'stuck' ? 'the failures the last round claimed to fix are red again: say so, show what is still red, and stop. The fix did not work in CI' : `${plural(config.max_rounds, 'round')} spent and CI is still red: say what is still red, and stop` };
  }
  if (code.length && !run.workspace) {
    // The first round had nothing the code could fix; this one has.
    run.workspace = chooseWorkspace(run.cwd_repo, { head: run.head.branch }, run.head.sha, run.flags);
    if (run.workspace.mode === 'worktree') run.workspace.path = G.addWorktree(run.root, run.run_id, run.head.sha);
  }
  S.saveRun(run);
  return { verdict: 'red', then: verdictOf(run), max_rounds: config.max_rounds, workspace: run.workspace, failures, counts: counts(run.failures), commands: commandsView(run, config), next: `CI is red on ${short(run.head.sha)}: round ${run.round} of ${config.max_rounds}. Go on as \`then\` says, as after start` };
}

// ---------------------------------------------------------------- drop
export function drop(a) {
  const run = S.loadRun(a.run);
  if (run.ended) return { dropped: false, run_id: run.run_id, note: `this run is already over (${run.ended.why})` };
  const mode = run.workspace?.mode || null;
  const discarded = unpushedEdits(run) || [];
  const removed = endRun(run, 'dropped');
  S.appendLog({ run: run.run_id, repo: run.slug, pr: run.pr.number, verdict: 'dropped' });
  return { dropped: true, run_id: run.run_id, ...(mode === 'worktree' ? { worktree_removed: removed } : {}), ...(discarded.length ? { discarded, discarded_note: 'these files held edits that were never pushed, and went with the worktree: say so' } : {}), note: mode === 'checkout' ? 'the run is over. Changes in your checkout are yours and stay' : run.history.length ? 'the run is over' : 'the run is over; nothing was pushed' };
}

// ---------------------------------------------------------------- main
const cmds = {
  start: () => start(json()),
  repro: () => repro(json()),
  check: () => check(json()),
  decide: (a) => decide(a),
  push: (a) => push(a),
  rerun: (a) => rerun(a),
  watch: (a) => watch(a),
  drop: (a) => drop(a),
};
export const COMMANDS = Object.keys(cmds);

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
