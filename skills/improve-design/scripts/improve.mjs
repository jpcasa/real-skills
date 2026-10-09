#!/usr/bin/env node
// /improve-design harness. The model critiques, edits and compares; this script
// decides which moves run, whether each one stays, the verdict and the
// pull-request text. Prints exactly ONE JSON object per call.
//
//   probe           < {repo}                  package manager, dev script, checks, impeccable, gh
//   start           < {repo, target, route?, base?, pr?, direction?, max_moves?, auto?, no_pr?, screenshots?, session: {browser}}
//   prepare         --run <id>                install, and the gates as they stand before any change
//   serve           --run <id>                the run's own dev server; decides rendered or code_only
//   detect          < {run, files: [...]}     impeccable's detector on the screen's source files
//   shoot           --run <id> --at baseline|<move>   pictures at each viewport, taken by the script when it can
//   shots-record    < {run, at, shots: [{viewport, path}]}   pictures an agent took
//   brief           --run <id> --job critique|rescore        the critic's prompt
//   baseline-record --run <id>   (stdin: the critic's final message)
//   plan            --run <id>                moves, ranked and cut; the checkpoint text
//   approve         < {run, moves: [ids], commands?: {id: command}, screenshots?}
//   move-start      --run <id> --move <id>    the designer's prompt; records where the move starts
//   move-check      --run <id> --move <id>   (stdin: the designer's final message)
//   compare-plan    --run <id> --move <id>    the blind sheet and the comparing critic's prompt
//   compare-record  --run <id> --move <id>   (stdin: the critic's final message)
//   final           --run <id>   (stdin: the re-scoring critic's final message)
//   ship-plan       --run <id>                the pull request exactly as it would be opened
//   ship            --run <id>                push, open the pull request
//   stop            --run <id>                stop the dev server, remove copied files
//   outcome         --run <id> [--move <id> --result right|wrong]
//   stats
//
// It writes one worktree, one branch, one commit per kept move (made by the
// designer), one push and one pull request, and with a yes one push of
// pictures. Jev (optional) reads scrubbed lines only and, until its questions
// are calibrated, is logged without deciding anything.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ask as jevAsk, redactBody } from './lib/jev.mjs';
import { jevMode, loadConfig, parseTarget, REF } from './lib/config.mjs';
import { anyMatch } from './lib/glob.mjs';
import { buildMoves, COMMANDS, kindOf, reorder } from './lib/moves.mjs';
import { assign, unblind } from './lib/compare.mjs';
import { AUDIT, draftFor, HEURISTICS, moveDecision, parseScores, verdict as runVerdict, VERDICTS, VETOES } from './lib/verdict.mjs';
import { delta, scan, total } from './lib/detect.mjs';
import { copyFiles, freePort, removeCopies, sh, startedAt, startServer, stopServer, waitReady } from './lib/dev.mjs';
import { runGates, turnedRed } from './lib/gates.mjs';
import { accept, capture, captureMethod, pairsFor, shotName } from './lib/shots.mjs';
import { createPr, viewPr } from './lib/pr.mjs';
import { publish } from './lib/evidence.mjs';
import { findImpeccable, hasGh, probe } from './lib/probe.mjs';
import * as G from './lib/git.mjs';
import * as S from './lib/state.mjs';
import * as Q from './lib/questions.mjs';
import * as C from './lib/calibration.mjs';

function parseCli(argv) {
  const [cmd, ...rest] = argv;
  const a = { _: cmd };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i].replace(/^--/, '');
    if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) a[k] = true;
    else a[k] = rest[++i];
  }
  return a;
}
const stdin = () => {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};
const json = () => JSON.parse(stdin() || '{}');
const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const jevFile = () => join(S.stateRoot(), 'jev.jsonl');
const findMove = (run, id) => {
  const m = (run.moves || []).find((x) => x.id === id);
  if (!m) throw new Error(`no move ${id} in ${run.run_id}`);
  return m;
};
const nextMove = (run) => (run.moves || []).find((m) => m.selected && !m.decision) || null;
const kept = (run) => (run.moves || []).filter((m) => m.decision?.keep);

// The JSON object in an agent's final message: the whole message, a fenced
// block, or the outermost braces. -> object or null
export function parseReport(message) {
  const t = String(message || '').trim();
  const tries = [t, ...[...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]).reverse(), t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)];
  for (const candidate of tries) {
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {}
  }
  return null;
}

const slugOf = (target) => {
  const from = target.route && target.route !== '/' ? target.route : target.file ? basename(target.file).replace(/\.[^.]+$/, '') : 'home';
  return from.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'screen';
};

// ---------------------------------------------------------------- start
export function start(input) {
  const repo = G.topLevel(String(input.repo || ''));
  if (!repo) throw new Error(`${input.repo} is not a git repository`);
  const { config, found, missing } = loadConfig(repo);
  const flags = { auto: input.auto === true, no_pr: input.no_pr === true, screenshots: input.screenshots === true || config.screenshots, direction: input.direction || null, max_moves: Number.isInteger(input.max_moves) ? input.max_moves : config.max_moves };
  const problems = [];
  const target = parseTarget(config, { target: input.target, route: input.route });
  if (target.problem) problems.push(target.problem);
  else if (target.file && !existsSync(join(repo, target.file))) problems.push(`${target.file} is not a file in this repo`);
  if (flags.direction && !kindOf(flags.direction)) problems.push(`--direction ${flags.direction} is not one of ${COMMANDS.join(', ')}`);
  const impeccable = findImpeccable(repo);
  if (!impeccable) problems.push('the impeccable plugin is not installed: this skill runs its detector and uses its rubric');
  if (!flags.no_pr && !hasGh()) problems.push('gh is not installed: pass --no-pr to stop before the pull request');
  let base = input.base || config.base || G.defaultBranch(repo);
  let stacked = null;
  if (input.pr !== undefined && input.pr !== null) {
    const pr = viewPr(repo, input.pr);
    if (!pr) problems.push(`no pull request ${input.pr}`);
    else if (pr.state !== 'OPEN') problems.push(`pull request ${pr.number} is ${String(pr.state).toLowerCase()}: only an open one can be stacked on`);
    else if (pr.fork) problems.push(`pull request ${pr.number} comes from a fork: its branch is not in this repository`);
    else {
      base = pr.head;
      stacked = { number: pr.number, url: pr.url };
    }
  }
  if (!REF.test(String(base))) problems.push(`${String(base).slice(0, 80)} is not a branch name`);
  if (problems.length) return { problems, config_found: found, setup_needed: missing };

  const run = S.newRun({ repo, root: G.mainRoot(repo), target: { route: target.route, file: target.file }, base, stacked, flags, config, impeccable, session: { browser: input.session?.browser === true }, mode: null, shots: {}, state_at: 'baseline', jev: {}, jev_logged: [], stage: 'started' });
  const [, day, , hex] = run.run_id.split('-');
  run.branch = `improve-design/${slugOf(run.target)}-${day}-${hex}`;
  const wt = G.createWorktree({ root: run.root, runId: run.run_id, base, branch: run.branch });
  Object.assign(run, { worktree: wt.worktree, start: wt.start, start_sha: wt.start_sha });
  const copy = copyFiles(repo, run.worktree, config.dev.copy);
  run.dev = { copied: copy.copied, pid: null, port: null, url: null };
  S.saveRun(run);
  return {
    run_id: run.run_id, worktree: run.worktree, branch: run.branch, base, stacked, target: run.target,
    copied: copy.copied, copy_refused: copy.refused, fetched: wt.fetched,
    will_render: Boolean(config.dev.command), setup_needed: missing, config_found: found,
    jev: jevMode(config), next: 'prepare',
  };
}

const appDir = (run) => join(run.worktree, run.config.dev.cwd);

export function prepare(runId) {
  const run = S.loadRun(runId);
  const logs = S.sub(run.run_id, 'logs');
  let install = null;
  if (run.config.dev.install) {
    const r = sh(appDir(run), run.config.dev.install, { timeoutS: Math.max(600, run.config.dev.timeout_s), log: join(logs, 'install.log') });
    install = { ok: r.exit === 0, exit: r.exit, log: join(logs, 'install.log') };
  }
  const baseline = runGates(run.worktree, run.config.gates, { timeoutS: run.config.gate_timeout_s, logDir: logs, label: 'baseline' });
  run.install = install;
  run.gates = { baseline, current: baseline };
  run.stage = 'prepared';
  S.saveRun(run);
  return {
    run_id: run.run_id, install,
    gates: baseline.map(({ cmd, ok, exit, log }) => ({ cmd, ok, exit, log })),
    note: baseline.some((g) => !g.ok) ? 'a gate is already red: a move is only blamed for a gate it turns red' : !baseline.length ? 'no gates configured: nothing checks that a move still builds' : null,
    next: 'serve',
  };
}

export async function serve(runId) {
  const run = S.loadRun(runId);
  const codeOnly = (why) => {
    run.mode = 'code_only';
    run.mode_why = why;
    run.stage = 'served';
    S.saveRun(run);
    return { run_id: run.run_id, mode: 'code_only', why, next: 'detect' };
  };
  if (!run.config.dev.command) return codeOnly('no dev.command in .claude/improve-design.json');
  if (run.install && !run.install.ok) return codeOnly('install failed: see install.log in the run folder');
  if (run.dev.pid) await stopServer(run.dev.pid, run.dev.started);
  const port = await freePort();
  const log = join(S.sub(run.run_id, 'logs'), 'dev.log');
  const pid = startServer({ cwd: appDir(run), command: run.config.dev.command, port, log });
  const base = `http://localhost:${port}`;
  const ready = await waitReady({ url: `${base}${run.config.dev.ready_path}`, pid, timeoutS: run.config.dev.timeout_s });
  if (!ready.ready) {
    await stopServer(pid);
    return codeOnly(ready.why);
  }
  run.dev = { ...run.dev, pid, started: startedAt(pid), port, url: `${base}${run.target.route}`, log };
  // A route that answers with a redirect most likely sends a signed-out visitor
  // to sign in. Only the browser pane holds the user's session.
  let redirects = false;
  try {
    const res = await fetch(run.dev.url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    redirects = res.status >= 300 && res.status < 400;
  } catch {}
  let how = captureMethod(appDir(run), run.config);
  if (redirects && how.method !== 'command') how = { method: 'agent', why: 'the route redirects, most likely to a sign-in only the browser pane has' };
  if (how.method === 'agent' && !run.session.browser) {
    await stopServer(pid);
    run.dev.pid = null;
    return codeOnly(how.why ? `${how.why}, and this session has no browser` : 'no way to take a picture: no capture command, Playwright or Chrome, and this session has no browser');
  }
  run.capture = how;
  run.mode = 'rendered';
  run.stage = 'served';
  S.saveRun(run);
  return { run_id: run.run_id, mode: 'rendered', url: run.dev.url, port, pictures_by: how.method, ...(how.why ? { why: how.why } : {}), viewports: run.config.viewports, next: 'detect' };
}

// ---------------------------------------------------------------- baseline
export function detect(input) {
  const run = S.loadRun(input.run);
  const asked = [...new Set([...(run.target.file ? [run.target.file] : []), ...(Array.isArray(input.files) ? input.files : [])].map((f) => str(f, 300)))];
  const files = asked.filter((f) => f && !f.startsWith('/') && !f.includes('..') && existsSync(join(run.worktree, f))).slice(0, 40);
  const r = files.length ? scan(run.impeccable, run.worktree, files) : { available: false, degraded: false, findings: [], error: 'no source file named for this screen' };
  run.screen_files = files;
  run.detector = { available: r.available, degraded: r.degraded, error: r.error || null, findings: r.findings };
  S.saveRun(run);
  return {
    run_id: run.run_id, files, not_found: asked.filter((f) => !files.includes(f)),
    detector: { available: r.available, degraded: r.degraded, ...(r.error ? { error: r.error } : {}), findings: r.findings.filter((f) => !f.advisory), advisory: r.findings.filter((f) => f.advisory).length },
    next: run.mode === 'rendered' ? 'shoot' : 'brief',
  };
}

const anyStarted = (run) => (run.moves || []).some((m) => m.started);
// Which pictures may be taken now: the baseline until a move starts, then only
// the move that was checked and is not decided yet. Nothing rewrites the "before".
function shotAts(run) {
  return [...(anyStarted(run) ? [] : ['baseline']), ...(run.moves || []).filter((m) => m.check && !m.decision).map((m) => m.id)];
}

export function shoot(a) {
  const run = S.loadRun(a.run);
  const at = String(a.at || '');
  if (!shotAts(run).includes(at)) throw new Error(`--at ${at || '(nothing)'} cannot be pictured now: ${shotAts(run).join(', ') || 'nothing can'}`);
  if (run.mode !== 'rendered') return { run_id: run.run_id, at, skipped: `the run is ${run.mode || 'not served yet'}: ${run.mode_why || 'run serve first'}` };
  const dir = S.sub(run.run_id, 'shots');
  const expect = run.config.viewports.map((viewport) => ({ viewport, path: join(dir, shotName(at, viewport)) }));
  if (run.capture.method === 'agent') return { run_id: run.run_id, at, by: 'agent', url: run.dev.url, save_to: expect, next: 'shots-record' };
  const taken = {};
  const failed = [];
  for (const e of expect) {
    const r = capture(run.capture, { url: run.dev.url, viewport: e.viewport, out: e.path, cwd: appDir(run) });
    const ok = r.ok ? accept(dir, e.path) : null;
    if (ok) taken[e.viewport] = ok;
    else failed.push({ viewport: e.viewport, why: r.why || 'not a picture' });
  }
  // Nothing at all from the script: an agent can still try, when there is a browser.
  if (!Object.keys(taken).length && run.session.browser) return { run_id: run.run_id, at, by: 'agent', url: run.dev.url, save_to: expect, failed, next: 'shots-record' };
  run.shots[at] = taken;
  S.saveRun(run);
  return { run_id: run.run_id, at, by: run.capture.method, taken: Object.keys(taken), failed };
}

export function shotsRecord(input) {
  const run = S.loadRun(input.run);
  const at = String(input.at || '');
  if (!shotAts(run).includes(at)) throw new Error(`${at || '(nothing)'} cannot be pictured now: ${shotAts(run).join(', ') || 'nothing can'}`);
  const dir = S.sub(run.run_id, 'shots');
  const taken = {};
  const dropped = [];
  for (const s of Array.isArray(input.shots) ? input.shots : []) {
    const ok = run.config.viewports.includes(s?.viewport) ? accept(dir, String(s.path || '')) : null;
    if (ok) taken[s.viewport] = ok;
    else dropped.push({ viewport: s?.viewport ?? null, why: 'not a picture inside the run\'s shots folder, or not a configured viewport' });
  }
  run.shots[at] = taken;
  S.saveRun(run);
  return { run_id: run.run_id, at, taken: Object.keys(taken), dropped };
}

const picturesOf = (run, at) => Object.entries(run.shots?.[at] || {}).map(([viewport, s]) => ({ viewport, path: s.path }));

// The critic's prompt. The re-scoring critic gets the screen as it is now and
// nothing about what it scored before, what was changed or why.
export function brief(a) {
  const run = S.loadRun(a.run);
  const job = a.job;
  if (!['critique', 'rescore'].includes(job)) throw new Error('--job must be critique or rescore');
  const at = job === 'critique' ? 'baseline' : run.state_at;
  const pictures = picturesOf(run, at);
  const lines = [
    `Job: ${job}. You are real-skills:design-critic. Read-only: you change nothing.`,
    `Screen: ${run.target.route} (${run.mode === 'rendered' ? 'rendered' : 'code only: nothing was rendered'}).`,
    `Worktree: ${run.worktree}. Read source only from there.`,
    `impeccable: ${run.impeccable.dir}. Load the impeccable skill, then read reference/critique.md (Assessment A, the heuristics scoring guide, issue severity) and reference/audit.md (the five dimensions) from that folder. Use their rubrics. Skip everything in them that is for a person: ask no questions, write no snapshot, run no detector, start no server.`,
    `Source files of this screen: ${(run.screen_files || []).join(', ') || 'not named: find the route\'s page file and the components it renders'}.`,
    pictures.length ? `Pictures (read each one): ${pictures.map((p) => `${p.viewport} ${p.path}`).join(' ; ')}.` : 'No pictures: judge from the source and say less about what only a rendered screen shows.',
    ...(run.mode === 'rendered' && run.session.browser ? [`The screen is live at ${run.dev.url} if you need to look at a state the pictures do not show. Open a new tab. Type no credentials.`] : []),
  ];
  if (job === 'critique') {
    const found = (run.detector?.findings || []).filter((f) => !f.advisory);
    lines.push(
      found.length ? `The detector already found (use these, source "detector", do not rerun it): ${found.slice(0, 30).map((f) => `${f.rule} at ${f.file}${f.line ? `:${f.line}` : ''}`).join(' ; ')}.` : `The detector found nothing${run.detector?.available ? '' : ' (it did not run)'}.`,
      'Return ONE JSON object and nothing else:',
      `{"heuristics": {${HEURISTICS.map((h) => `"${h.id}": 0-4 or "n/a"`).join(', ')}}, "audit": {${AUDIT.map((d) => `"${d}": 0-4`).join(', ')}}, "issues": [{"id": "i1", "severity": "P0|P1|P2|P3", "element": "the one element or region", "problem": "one line: what is wrong and who it hurts", "fix": "one line: what to do", "command": "<one of ${COMMANDS.join('|')}>", "alt": "<second-choice command or null>", "source": "detector|audit|critique", "files": ["repo-relative paths"], "visual": true|false}]}`,
      `Heuristics in order: ${HEURISTICS.map((h) => `${h.id} ${h.name}`).join('; ')}.`,
      'At most 12 issues, the ones that matter most. One element per issue. "visual": false only when nothing on screen would change (names, roles, focus order). Be honest with scores: most real screens total 20 to 32 of 40.',
    );
  } else {
    lines.push(
      'Return ONE JSON object and nothing else:',
      `{"heuristics": {${HEURISTICS.map((h) => `"${h.id}": 0-4 or "n/a"`).join(', ')}}, "audit": {${AUDIT.map((d) => `"${d}": 0-4`).join(', ')}}}`,
      `Heuristics in order: ${HEURISTICS.map((h) => `${h.id} ${h.name}`).join('; ')}.`,
      'Score what is in front of you. You are not told what this screen scored before, and you must not look for it.',
    );
  }
  const file = join(S.sub(run.run_id, 'prompts'), `${job}.md`);
  writeFileSync(file, `${lines.join('\n\n')}\n`);
  return { run_id: run.run_id, job, agent: 'real-skills:design-critic', prompt_file: file, pictures: pictures.length };
}

export function baselineRecord(runId, message) {
  const run = S.loadRun(runId);
  if (anyStarted(run)) throw new Error('a move has already started: the baseline is fixed');
  const report = parseReport(message);
  if (!report) throw new Error('the critic\'s message holds no JSON object');
  const scores = parseScores(report.heuristics);
  const audit = parseScores(report.audit, AUDIT);
  const issues = [];
  const refused = [];
  (Array.isArray(report.issues) ? report.issues : []).slice(0, 20).forEach((raw, n) => {
    const id = str(raw?.id, 40) || `i${n + 1}`;
    const named = (Array.isArray(raw?.files) ? raw.files : []).map((f) => str(f, 300));
    const files = named.filter((f) => f && !f.startsWith('/') && !f.includes('..') && existsSync(join(run.worktree, f)));
    if (named.length && !files.length) return refused.push({ issue: id, why: 'names no file that is in this repo' });
    issues.push({ ...raw, id, files });
  });
  run.baseline = { ...scores, audit: audit.scores, issues, refused };
  run.stage = 'baselined';
  S.saveRun(run);
  return { run_id: run.run_id, total: scores.total, max: scores.max, na: scores.na, audit: audit.scores, issues: issues.length, refused, next: 'plan' };
}

// ---------------------------------------------------------------- plan
// Logs one case per question, once, and says whether its answer may be acted on.
function kase(run, mode, cases, question, id, p, show) {
  if (typeof p !== 'number') return false;
  const sp = Q.spot(question, id);
  const acted = mode === 'live' && Q.calibrated(question) && !sp;
  const tag = `${question}\u0000${id}`;
  if (!run.jev_logged.includes(tag)) {
    run.jev_logged.push(tag);
    cases.push({ skill: Q.SKILL, question, case: id, p, threshold: Q.thr(question), ...Q.META[question], mode, acted, ...(sp ? { spot: true } : {}), show });
  }
  return acted;
}

const lowest = (baseline) => HEURISTICS.filter((h) => Number.isInteger(baseline.scores[h.id])).sort((a, b) => baseline.scores[a.id] - baseline.scores[b.id]).slice(0, 3).map((h) => `${h.name} ${baseline.scores[h.id]}/4`);

function checkpoint(run) {
  const b = run.baseline;
  const selected = run.moves.filter((m) => m.selected);
  const tag = (m) => [m.kind === 'shift' ? 'direction change' : null, m.forced ? '--direction' : null, m.source === 'detector' ? 'detector' : null, m.swapped_by ? `command chosen by ${m.swapped_by}` : null, m.cut_by ? `cut by ${m.cut_by}` : null, m.skipped ? 'skipped under --auto' : null].filter(Boolean).join(', ');
  const lines = [
    `Design pass on ${run.target.route}: ${b.total}/${b.max} on the ten heuristics${run.mode === 'rendered' ? `, rendered at ${run.config.viewports.join(' and ')}` : ', code only (nothing rendered, so the result will be unverified)'}.`,
    `Weakest: ${lowest(b).join('; ')}.`,
    'Moves, in the order they run:',
    ...run.moves.map((m) => `[${m.selected ? 'x' : ' '}] ${m.id} ${m.severity} ${m.command} · ${m.element}: ${m.problem}${tag(m) ? ` (${tag(m)})` : ''}`),
    ...(run.cut.length ? [`Left out, over the limit of ${run.flags.max_moves}: ${run.cut.map((m) => `${m.command} on ${m.element}`).join('; ')}.`] : []),
    ...(run.refused.length ? [`Not usable: ${run.refused.map((r) => `${r.issue} (${r.why})`).join('; ')}.`] : []),
    `Cost if run as ticked: ${selected.length} designer${selected.length === 1 ? '' : 's'}, up to ${selected.length} comparison${selected.length === 1 ? '' : 's'}, 1 re-score${run.capture?.method === 'agent' ? `, ${selected.length} picture-taking agent${selected.length === 1 ? '' : 's'}` : ''}.`,
  ];
  return lines;
}

export async function plan(runId, { ask = jevAsk } = {}) {
  const run = S.loadRun(runId);
  if (!run.baseline) throw new Error('no baseline recorded yet');
  if ((run.moves || []).some((m) => m.check || m.decision)) throw new Error('a move has already started: the plan is fixed');
  const mode = jevMode(run.config);
  const built = buildMoves(run.baseline.issues, { maxMoves: run.flags.max_moves, direction: run.flags.direction, auto: run.flags.auto });
  let moves = built.moves;

  const cases = [];
  if (mode !== 'off' && moves.length) {
    const q = Q.buildPlan({ route: run.target.route, lowest: lowest(run.baseline) }, moves);
    const res = await ask({ state: q.state, questions: q.questions }).catch((e) => ({ degraded: true, error: e.message, answers: {} }));
    run.jev.plan = res.degraded ? { error: res.error || 'degraded' } : { ok: true };
    if (!res.degraded) {
      const p = (id) => (typeof res.answers[id]?.noul === 'number' ? res.answers[id].noul : null);
      q.moves.forEach((m, n) => {
        const id = `${run.run_id}/${m.issues.join('+') || m.command}`;
        m.case = id;
        m.jev = { move_worth_doing: p(`worth__${n}`), changes_visual_identity: p(`identity__${n}`), direction_change_warranted: p(`warranted__${n}`), alternative_fits_better: m.alt ? p(`alt__${n}`) : null };
        const show = Q.moveLine(m);
        // Calibrated, Jev may swap the command for the critic's own second choice,
        if (kase(run, mode, cases, 'alternative_fits_better', id, m.jev.alternative_fits_better, `${show} || instead: ${m.alt}`) && m.jev.alternative_fits_better >= Q.thr('alternative_fits_better') && !m.forced) {
          Object.assign(m, { command: m.alt, alt: m.command, kind: kindOf(m.alt), swapped_by: 'Jev' });
        }
        // call a move a direction change whatever its command says,
        if (kase(run, mode, cases, 'changes_visual_identity', id, m.jev.changes_visual_identity, show) && m.jev.changes_visual_identity >= Q.thr('changes_visual_identity') && m.kind === 'refine' && !m.forced) {
          Object.assign(m, { kind: 'shift', reclassified_by: 'Jev' });
        }
        // cut a move that is not worth making,
        const cut = kase(run, mode, cases, 'move_worth_doing', id, m.jev.move_worth_doing, show) && m.jev.move_worth_doing < Q.thr('move_worth_doing') && !m.forced;
        // and say a direction change is needed. That last one is the only answer
        // that adds anything, and it adds a move the critic proposed, nothing more.
        const warranted = kase(run, mode, cases, 'direction_change_warranted', id, m.jev.direction_change_warranted, show) && m.jev.direction_change_warranted >= Q.thr('direction_change_warranted');
        if (cut) Object.assign(m, { selected: false, decided: true, cut_by: 'Jev' });
        else if (m.kind === 'shift' && warranted && !m.forced) Object.assign(m, { selected: true, decided: true, selected_by: 'Jev' });
      });
    }
    C.writeCases(jevFile(), cases, redactBody);
  }
  moves = reorder(moves, { auto: run.flags.auto });

  run.moves = moves;
  run.cut = built.cut;
  run.refused = [...(run.baseline.refused || []), ...built.refused];
  run.approved = run.flags.auto;
  run.stage = 'planned';
  S.saveRun(run);
  const lines = checkpoint(run);
  return {
    run_id: run.run_id, jev_mode: mode,
    moves: moves.map(({ id, severity, command, alt, kind, element, problem, intent, selected, skipped, forced, source }) => ({ id, severity, command, alt, kind, element, problem, intent, selected, ...(skipped ? { skipped } : {}), ...(forced ? { forced } : {}), source })),
    cut: built.cut.length, refused: run.refused,
    checkpoint: lines,
    ask: run.flags.auto ? null : { moves: true, screenshots: !run.flags.screenshots && run.mode === 'rendered' && !run.flags.no_pr },
    next: !moves.some((m) => m.selected) ? (run.flags.auto ? 'final' : 'approve') : run.flags.auto ? 'move-start' : 'approve',
  };
}

export function approve(input) {
  const run = S.loadRun(input.run);
  if (!run.moves) throw new Error('nothing planned yet');
  if (run.moves.some((m) => m.check || m.decision)) throw new Error('a move has already started: the plan is fixed');
  const picked = new Set(Array.isArray(input.moves) ? input.moves : []);
  for (const id of picked) findMove(run, id);
  const commands = input.commands && typeof input.commands === 'object' ? input.commands : {};
  for (const [id, command] of Object.entries(commands)) {
    if (!kindOf(command)) throw new Error(`${command} is not one of ${COMMANDS.join(', ')}`);
    findMove(run, id);
  }
  for (const m of run.moves) {
    const p = m.jev || {};
    const label = (question, value) => m.case && C.writeLabel(jevFile(), { skill: Q.SKILL, question, case: m.case, label: value, source: 'checkpoint', p: p[question] ?? null, unsafe: Q.META[question].unsafe });
    const chosen = commands[m.id];
    if (m.alt && !m.swapped_by) label('alternative_fits_better', chosen === m.alt);
    if (!m.forced && !m.cut_by) label(m.kind === 'shift' ? 'direction_change_warranted' : 'move_worth_doing', picked.has(m.id));
    if (chosen && chosen !== m.command) Object.assign(m, { alt: m.command, command: chosen, kind: kindOf(chosen), command_by: 'user' });
    Object.assign(m, { selected: picked.has(m.id), decided: true });
    delete m.skipped;
  }
  // A direction change the user ticked is theirs: it keeps its place after the refine moves.
  run.moves = reorder(run.moves);
  if (typeof input.screenshots === 'boolean') run.flags.screenshots = input.screenshots;
  run.approved = true;
  run.stage = 'approved';
  S.saveRun(run);
  const queue = run.moves.filter((m) => m.selected).map((m) => m.id);
  return { run_id: run.run_id, queue, screenshots: run.flags.screenshots, next: queue.length ? 'move-start' : 'final' };
}

// ---------------------------------------------------------------- one move
export function moveStart(a) {
  const run = S.loadRun(a.run);
  if (!run.approved) throw new Error('the plan has not been approved');
  const move = findMove(run, a.move);
  const next = nextMove(run);
  if (!next || next.id !== move.id) throw new Error(next ? `${next.id} is next, not ${move.id}` : 'no move is waiting');
  if (!G.isRunWorktree(run)) throw new Error(`${run.worktree} is not this run's worktree`);
  if (!G.isClean(run.worktree)) throw new Error('the worktree has uncommitted changes: the last move was not finished');
  // Asked twice: fine while nothing was committed. After that the commits belong
  // to this move and must be checked, not forgotten by starting again.
  if (move.started && G.head(run.worktree) !== move.started.parent) throw new Error(`${move.id} was already started and has commits: run move-check`);
  move.started ||= { parent: G.head(run.worktree), at: new Date().toISOString() };
  const lines = [
    `You are real-skills:designer. One design move, in one worktree, then stop.`,
    `Worktree: ${run.worktree} (branch ${run.branch}). Work only there.`,
    `Screen: ${run.target.route}${run.screen_files?.length ? `, source: ${run.screen_files.join(', ')}` : ''}.`,
    `Run \`/impeccable ${move.command}\` on ${move.element}. Invoke the impeccable skill first.`,
    `The problem: ${move.problem}`,
    ...(move.intent ? [`The intent: ${move.intent}`] : []),
    ...(move.files.length ? [`Start in: ${move.files.join(', ')}`] : []),
    `This move only. Do not fix anything else you notice: say it in your report instead. ${move.kind === 'refine' ? 'Keep the look the screen already has.' : 'This one may change the direction of the look; keep content, behaviour and everything outside this screen as they are.'}`,
    `Files you may change: ${run.config.ui_paths.join(', ')}. No logic, data fetching, validation or state shape.`,
    run.config.gates.length ? `Gates, run from the worktree before you commit: ${run.config.gates.map((g) => `\`${g}\``).join(', ')}.` : 'No gates are configured: make sure the app still builds.',
    'Commit your work (one or more commits) and leave the tree clean. Never push. If you cannot do it, change nothing and report {"status": "blocked", "why": "..."}.',
  ];
  const file = join(S.sub(run.run_id, 'prompts'), `${move.id}-designer.md`);
  writeFileSync(file, `${lines.join('\n\n')}\n`);
  S.saveRun(run);
  return { run_id: run.run_id, move: move.id, agent: 'real-skills:designer', prompt_file: file, command: move.command, next: 'move-check' };
}

// Decides, records, and takes a dropped move's commits off the branch.
function settle(run, move, decision) {
  move.decision = decision;
  // On disk first: if taking the commits off fails, the move is still recorded
  // as dropped, and ship refuses a branch whose tip is not the last kept move.
  S.saveRun(run);
  const patches = S.sub(run.run_id, 'moves');
  if (move.check.dirty) G.discardUncommitted(run, join(patches, `${move.id}.uncommitted.patch`));
  if (decision.keep) {
    // A kept move with no pictures of its own changed nothing on screen (or could
    // not be seen): the pictures already held still stand for the screen as it is.
    if (Object.keys(run.shots[move.id] || {}).length) run.state_at = move.id;
    run.gates.current = move.check.gates;
  } else if (move.check.committed) {
    move.dropped = G.dropHead(run, move, join(patches, `${move.id}.patch`));
    // The server must not keep showing what was just taken away.
    delete run.shots[move.id];
  }
  const next = nextMove(run);
  return { run_id: run.run_id, move: move.id, kept: decision.keep, reasons: decision.reasons, ...(decision.unverified ? { unverified: true } : {}), ...(move.dropped ? { patch: move.dropped.patch } : {}), next: next ? 'move-start' : 'final', next_move: next?.id || null };
}

export function moveCheck(a, message = '') {
  const run = S.loadRun(a.run);
  const move = findMove(run, a.move);
  if (!move.started) throw new Error(`${move.id} was not started`);
  if (move.decision) throw new Error(`${move.id} is already decided`);
  const report = parseReport(message) || {};
  const sha = G.head(run.worktree);
  const parent = move.started.parent;
  // The designer may add commits. It may not rewrite what was there: a kept move could vanish with it.
  if (!G.isAncestor(run.worktree, parent, sha)) throw new Error(`the branch no longer holds the commit ${move.id} started from: its history was rewritten. Stop the run; the worktree is ${run.worktree}`);
  const committed = sha !== parent && G.commitsSince(run.worktree, parent).length > 0;
  const files = committed ? G.changedFiles(run.worktree, parent, sha) : [];
  const logs = S.sub(run.run_id, 'logs');
  const check = {
    sha, parent, committed, files,
    blocked: /^blocked$/i.test(String(report.status || report.outcome || '')),
    dirty: !G.isClean(run.worktree),
    out_of_scope: files.filter((f) => !anyMatch(run.config.ui_paths, f)),
    gates: [], gates_red: [], new_findings: [], detector: null, unchecked: [],
  };
  // Nothing more is worth running for a move that is already out.
  if (committed && !check.blocked && !check.dirty && !check.out_of_scope.length) {
    check.gates = runGates(run.worktree, run.config.gates, { timeoutS: run.config.gate_timeout_s, logDir: logs, label: move.id });
    check.gates_red = turnedRed(run.gates.current, check.gates);
    const d = delta(run.impeccable, run.worktree, parent, sha, files, join(S.sub(run.run_id, 'detect'), move.id));
    check.detector = { available: d.available, degraded: d.degraded, fixed: d.fixed, new: d.new, ...(d.error ? { error: d.error } : {}) };
    check.new_findings = d.new;
    // No answer is not "no new finding": the move can stay, but never as verified.
    if (!d.available) check.unchecked.push('the detector did not run');
  }
  move.check = check;
  const decision = moveDecision({ check, visual: move.visual, compare: [], issueGone: true });
  if (decision.vetoed) {
    const out = settle(run, move, decision);
    S.saveRun(run);
    return { ...out, vetoed: true };
  }
  S.saveRun(run);
  return { run_id: run.run_id, move: move.id, committed, files: files.length, gates: check.gates.map(({ cmd, ok }) => ({ cmd, ok })), detector: check.detector, next: run.mode === 'rendered' ? 'shoot' : 'compare-plan' };
}

// file:line the critic points at must be a real line of a real file.
function cited(run, where) {
  const m = String(where || '').match(/^([^\s:]+):(\d+)$/);
  if (!m || m[1].startsWith('/') || m[1].includes('..')) return false;
  try {
    return Number(m[2]) >= 1 && Number(m[2]) <= readFileSync(join(run.worktree, m[1]), 'utf8').split('\n').length;
  } catch {
    return false;
  }
}

export function comparePlan(a, { rand = Math.random } = {}) {
  const run = S.loadRun(a.run);
  const move = findMove(run, a.move);
  if (!move.check) throw new Error(`${move.id} has not been checked`);
  if (move.decision) throw new Error(`${move.id} is already decided`);
  const done = (decision) => {
    const out = settle(run, move, decision);
    S.saveRun(run);
    return { ...out, critic: false };
  };

  if (!move.visual) {
    // The detector saw the finding go: nobody needs to be asked.
    if (move.source === 'detector' && move.check.detector?.fixed?.length) return done(moveDecision({ check: move.check, visual: false, issueGone: true }));
    const dir = mkdtempSync(join(tmpdir(), 'improve-design-check-'));
    const file = join(dir, 'check.md');
    writeFileSync(file, [
      'Job: check. You are real-skills:design-critic. Read-only: you change nothing.',
      `Worktree: ${run.worktree}. Read source only from there.`,
      `A problem was reported on ${move.element}: ${move.problem}`,
      `Look in: ${[...new Set([...move.files, ...move.check.files])].join(', ')}.`,
      'Is that problem gone in the code as it is now? Answer from what the code says, not from what a commit message claims.',
      'Return ONE JSON object and nothing else: {"issue_gone": true|false, "where": "path:line that shows it"}',
    ].join('\n\n') + '\n');
    move.compare = { kind: 'check', dir };
    S.saveRun(run);
    return { run_id: run.run_id, move: move.id, critic: true, agent: 'real-skills:design-critic', prompt_file: file, next: 'compare-record' };
  }

  const pairs = run.mode === 'rendered' ? pairsFor(run.shots, move, run.state_at) : [];
  // No pictures: nothing to compare. The move stays, marked as never seen.
  if (!pairs.length) return done(moveDecision({ check: move.check, visual: true, compare: null }));
  const differing = pairs.filter((p) => !p.identical);
  const blank = (viewport, prefers) => ({ move: move.id, viewport, prefers, broke: null, shows: { before: '', after: '' } });
  // A viewport with no pair (a picture failed) is "missing", which keeps the move from counting as seen.
  const sameRows = [...pairs.filter((p) => p.identical).map((p) => blank(p.viewport, 'same')), ...run.config.viewports.filter((v) => !pairs.some((p) => p.viewport === v)).map((v) => blank(v, 'missing'))];
  // Byte for byte the same picture at every viewport: nothing changed on screen.
  if (!differing.length) {
    move.compare = { kind: 'pictures', rows: sameRows };
    return done(moveDecision({ check: move.check, visual: true, compare: sameRows }));
  }
  // The sheet lives outside the run folder, under names that say nothing, with
  // the same timestamp on both pictures: nothing the critic is handed says which is newer.
  const dir = mkdtempSync(join(tmpdir(), 'improve-design-compare-'));
  const { sheet, key } = assign(differing, rand);
  const epoch = new Date(0);
  for (const s of sheet) {
    for (const side of ['X', 'Y']) {
      copyFileSync(key[s.pair][key[s.pair][side]], join(dir, s[side]));
      utimesSync(join(dir, s[side]), epoch, epoch);
      s[side] = join(dir, s[side]);
    }
  }
  const file = join(dir, 'compare.md');
  writeFileSync(file, [
    'Job: compare. You are real-skills:design-critic. Read-only: you change nothing, and you open no other file than the pictures named here.',
    `Two versions of one screen, called X and Y. A problem was reported on ${move.element}: ${move.problem}`,
    'You are not told which version is newer or what was changed, and you must not try to find out. Judge the pictures.',
    ...sheet.map((s) => `${s.pair} (${s.viewport}): X = ${s.X} ; Y = ${s.Y}`),
    'For each pair: which version handles that problem better for the people using the screen ("X", "Y", or "same" if you see no real difference)? One line on what each version shows. And if either version has something broken that the other does not (text cut off or wrapping badly, an element missing or overlapping, contrast lost), say which side, what, and where on the screen.',
    'Return ONE JSON object and nothing else:',
    '{"pairs": [{"pair": "p1", "prefers": "X|Y|same", "x": "one line on what X shows", "y": "one line on what Y shows", "broke": {"side": "X|Y", "what": "...", "where": "..."} or null}]}',
  ].join('\n\n') + '\n');
  move.compare = { kind: 'pictures', dir, key, same: sameRows };
  S.saveRun(run);
  return { run_id: run.run_id, move: move.id, critic: true, agent: 'real-skills:design-critic', prompt_file: file, pairs: sheet.length, next: 'compare-record' };
}

export async function compareRecord(a, message, { ask = jevAsk } = {}) {
  const run = S.loadRun(a.run);
  const move = findMove(run, a.move);
  if (!move.compare || move.decision) throw new Error(`${move.id} is not waiting for a comparison`);
  const report = parseReport(message) || {};
  const mode = jevMode(run.config);
  let decision;
  if (move.compare.kind === 'check') {
    const gone = report.issue_gone === true && cited(run, report.where) ? true : report.issue_gone === false ? false : null;
    move.compare.answer = { issue_gone: report.issue_gone ?? null, where: str(report.where, 200), cited: cited(run, report.where) };
    decision = moveDecision({ check: move.check, visual: false, issueGone: gone });
  } else {
    const rows = [...unblind(move.compare.key, report.pairs), ...move.compare.same];
    move.compare.rows = rows;
    let jev = null;
    const views = rows.filter((r) => r.shows.before && r.shows.after).map((r) => ({ viewport: r.viewport, ...r.shows }));
    if (mode !== 'off' && views.length) {
      const q = Q.buildCompare(move, views, { fixed: move.check.detector?.fixed?.length || 0, new: move.check.detector?.new?.length || 0 });
      const res = await ask({ state: q.state, questions: q.questions }).catch((e) => ({ degraded: true, error: e.message, answers: {} }));
      if (!res.degraded) {
        const cases = [];
        const id = move.case || `${run.run_id}/${move.id}`;
        jev = {};
        for (const question of Q.COMPARE) {
          const p = typeof res.answers[question]?.noul === 'number' ? res.answers[question].noul : null;
          move.jev = { ...move.jev, [question]: p };
          jev[question] = { p, threshold: Q.thr(question), on: kase(run, mode, cases, question, id, p, `${Q.moveLine(move)} || ${views.map((v) => `${v.viewport}: ${v.after}`).join(' | ')}`) };
        }
        C.writeCases(jevFile(), cases, redactBody);
      }
    }
    decision = moveDecision({ check: move.check, visual: true, compare: rows, jev });
  }
  if (move.compare.dir) rmSync(move.compare.dir, { recursive: true, force: true });
  delete move.compare.key;
  const out = settle(run, move, decision);
  S.saveRun(run);
  return out;
}

// ---------------------------------------------------------------- the run
export function final(runId, message = '') {
  const run = S.loadRun(runId);
  if (nextMove(run)) throw new Error(`${nextMove(run).id} has not run yet`);
  const keptMoves = kept(run);
  let scores = null;
  let why = null;
  if (keptMoves.length && message.trim()) {
    try {
      scores = parseScores(parseReport(message)?.heuristics);
    } catch (e) {
      why = e.message;
    }
  }
  let detector = null;
  if (keptMoves.length) {
    const files = G.changedFiles(run.worktree, run.start_sha);
    const d = delta(run.impeccable, run.worktree, run.start_sha, G.head(run.worktree), files, join(S.sub(run.run_id, 'detect'), 'final'));
    detector = d.available ? { baseline: total(d.before), final: total(d.after), degraded: d.degraded } : null;
  }
  const v = runVerdict({ mode: run.mode, moves: run.moves || [], baseline: run.baseline, final: scores, detector });
  // impeccable's detector without its parser modules matches patterns only: an undercount.
  v.notes = detector?.degraded ? ['The detector ran in its fallback mode (pattern matching only), so its counts are a lower bound.'] : [];
  if (v.verdict === 'unverified' && why) v.reasons.push(`the re-score was not usable: ${why}`);
  run.final = scores;
  run.detector_delta = detector;
  run.verdict = v;
  run.stage = 'final';
  S.saveRun(run);
  const moves = run.moves || [];
  S.appendLog({ type: 'run', run: run.run_id, verdict: v.verdict, mode: run.mode, moves: moves.filter((m) => m.decision).length, kept: keptMoves.length, vetoed: moves.filter((m) => m.decision?.vetoed).length, dropped: moves.filter((m) => m.decision && !m.decision.keep).map((m) => m.decision.reasons[0].split(/[ :]/)[0]), baseline: run.baseline ? `${run.baseline.total}/${run.baseline.max}` : null, final: scores ? `${scores.total}/${scores.max}` : null, jev_mode: jevMode(run.config) });
  return {
    run_id: run.run_id, verdict: v.verdict, reasons: v.reasons, notes: v.notes,
    baseline: run.baseline ? { total: run.baseline.total, max: run.baseline.max } : null, final: scores ? { total: scores.total, max: scores.max } : null,
    kept: keptMoves.map((m) => m.id), dropped: moves.filter((m) => m.decision && !m.decision.keep).map((m) => ({ move: m.id, reasons: m.decision.reasons })),
    next: v.verdict === 'no_change' || run.flags.no_pr ? 'stop' : 'ship-plan',
  };
}

export const BODY_LINES = 40;
// What a model wrote is scrubbed before it goes into a pull request.
const oneLine = (m) => `${m.command} on ${Q.clean(m.element, 120)}: ${Q.clean(m.problem, 300)}`;

function shipRefusal(run) {
  if (!run.verdict) return 'the run has no verdict yet';
  if (run.verdict.verdict === 'no_change') return 'nothing was kept: there is nothing to open a pull request for';
  if (run.flags.no_pr) return 'the run was started with --no-pr';
  if (run.pr?.url) return `already shipped: ${run.pr.url}`;
  if (!run.approved) return 'the plan was never approved';
  if (!G.isRunWorktree(run)) return `${run.worktree} is not this run's worktree`;
  if (!G.isClean(run.worktree)) return 'the worktree has uncommitted changes';
  const last = kept(run).at(-1);
  if (G.head(run.worktree) !== last.check.sha) return `HEAD is not the last kept move (${last.id})`;
  const gone = kept(run).find((m) => !G.isAncestor(run.worktree, m.check.sha));
  if (gone) return `the commit of ${gone.id} is no longer on the branch`;
  return null;
}

// The pull request, from recorded results only. -> { title, lines }
function prText(run, links = null) {
  const v = run.verdict;
  const keptMoves = kept(run);
  const dropped = run.moves.filter((m) => m.decision && !m.decision.keep);
  const skipped = run.moves.filter((m) => !m.decision);
  const b = run.baseline;
  const f = run.final;
  const cap = (items, n, render) => [...items.slice(0, n).map(render), ...(items.length > n ? [`- and ${items.length - n} more`] : [])];
  const lines = [
    `**Verdict: ${v.verdict}.**${v.reasons.length ? ` ${v.reasons.join('. ')}.` : ''}`,
    '',
    `A design pass on \`${run.target.route}\` by \`/real-skills:improve-design\`. ${run.mode === 'rendered' ? `The screen was rendered from this branch at ${run.config.viewports.join(' and ')}. Each change was compared with the screen before it by a reviewer who was not told which version was newer. ${keptMoves.some((m) => m.decision.unverified) ? 'Changes that reviewer preferred were kept, and so were the ones marked below that could not be fully checked.' : 'Only the changes that reviewer preferred were kept.'}` : 'Nothing was rendered, so no change here was looked at on screen. Please check it by eye before merging.'}`,
    '',
    '| | Before | After |',
    '|---|---|---|',
    `| Ten usability heuristics, 0 to 4 each | ${b.total}/${b.max} | ${f ? `${f.total}/${f.max}` : 'not re-scored'} |`,
    ...(run.detector_delta ? [`| Detector findings in the changed files | ${run.detector_delta.baseline} | ${run.detector_delta.final} |`] : []),
    ...(v.notes?.length ? ['', ...v.notes] : []),
    '',
    `Kept (${keptMoves.length}), one commit each:`,
    ...cap(keptMoves, 10, (m) => `- \`${m.check.sha.slice(0, 7)}\` ${oneLine(m)}${m.decision.unverified ? ` (${m.check.unchecked?.length ? m.check.unchecked.join(', ') : 'not seen on screen'})` : ''}`),
    ...(dropped.length ? ['', `Tried and taken back out (${dropped.length}):`, ...cap(dropped, 6, (m) => `- ${m.command} on ${Q.clean(m.element, 120)}: ${Q.clean(m.decision.reasons.join('; '), 300)}`)] : []),
    ...(skipped.length ? ['', `Proposed and not run (${skipped.length}):`, ...cap(skipped, 5, (m) => `- ${m.command} on ${Q.clean(m.element, 120)}${m.kind === 'shift' ? ' (a change of direction, which needs a yes)' : ''}`)] : []),
    '',
    `To re-check: open \`${run.target.route}\` at ${run.config.viewports.join(' and ')}.${run.config.gates.length ? ` Gates run after every change: ${run.config.gates.map((g) => `\`${g}\``).join(', ')}.` : ' No gates were configured, so nothing checked that each change still builds.'}`,
  ];
  const body = lines.slice(0, BODY_LINES);
  if (links) {
    body.push('', 'Before and after:');
    for (const viewport of run.config.viewports) {
      const [before, after] = [links[shotName('before', viewport)], links[shotName('after', viewport)]];
      if (before && after) body.push('', `${viewport}`, '', `| Before | After |`, '|---|---|', `| ![before](${before}) | ![after](${after}) |`);
    }
  }
  body.push('', '🤖 Generated with [Claude Code](https://claude.com/claude-code)');
  const n = keptMoves.length;
  return { title: str(`Design pass on ${run.target.route}: ${n} change${n === 1 ? '' : 's'} kept`, 70), lines: redactBody({ lines: body }).lines };
}

const evidenceFiles = (run) =>
  run.flags.screenshots && run.mode === 'rendered'
    ? run.config.viewports.flatMap((v) => (run.shots.baseline?.[v] && run.shots[run.state_at]?.[v] ? [{ name: shotName('before', v), path: run.shots.baseline[v].path }, { name: shotName('after', v), path: run.shots[run.state_at][v].path }] : []))
    : [];

export function shipPlan(runId) {
  const run = S.loadRun(runId);
  const refusal = shipRefusal(run);
  if (refusal) return { run_id: run.run_id, can_ship: false, why: refusal };
  const text = prText(run);
  const pictures = evidenceFiles(run);
  return {
    run_id: run.run_id, can_ship: true, verdict: run.verdict.verdict,
    title: text.title, body: text.lines.join('\n'), draft: draftFor(run.verdict.verdict, run.config.pr.draft), base: run.base, branch: run.branch, labels: run.config.pr.labels,
    pictures: pictures.length ? { files: pictures.map((p) => p.name), pushed_to: 'the design-evidence branch of this repository, where they stay' } : null,
    next: 'ship',
  };
}

export function ship(runId) {
  const run = S.loadRun(runId);
  const refusal = shipRefusal(run);
  if (refusal) throw new Error(`cannot ship: ${refusal}`);
  const pictures = evidenceFiles(run);
  let links = null;
  let picturesError = null;
  if (pictures.length) {
    try {
      links = publish(run.root, run.run_id, pictures).links;
    } catch (e) {
      picturesError = e.message; // the pull request is worth opening without them
    }
  }
  const text = prText(run, links);
  const bodyFile = join(S.runDir(run.run_id), 'pr-body.md');
  writeFileSync(bodyFile, `${text.lines.join('\n')}\n`);
  G.push(run);
  // Pushed is not shipped: if opening the pull request fails, ship can be run again.
  run.pushed = true;
  S.saveRun(run);
  const draft = draftFor(run.verdict.verdict, run.config.pr.draft);
  const url = createPr(run.worktree, { head: run.branch, base: run.base, title: text.title, bodyFile, draft, labels: run.config.pr.labels });
  run.shipped = true;
  run.pr = { url, draft, number: Number(url.match(/\/pull\/(\d+)/)?.[1]) || null, pictures: links ? Object.keys(links).length : 0 };
  run.stage = 'shipped';
  S.saveRun(run);
  S.appendLog({ type: 'ship', run: run.run_id, verdict: run.verdict.verdict, draft, pictures: run.pr.pictures });
  return { run_id: run.run_id, pr: url, draft, verdict: run.verdict.verdict, pictures: run.pr.pictures, ...(picturesError ? { pictures_error: picturesError } : {}), next: 'stop' };
}

export async function stop(runId) {
  const run = S.loadRun(runId);
  const stopped = run.dev?.pid ? await stopServer(run.dev.pid, run.dev.started) : false;
  removeCopies(run.worktree, run.dev?.copied);
  run.dev = { ...run.dev, pid: null, copied: [] };
  // Nothing kept and nothing pushed: no reason to leave a worktree and a branch behind.
  const removed = !kept(run).length ? G.removeEmpty(run) : false;
  run.stopped = true;
  S.saveRun(run);
  return { run_id: run.run_id, server_stopped: stopped, worktree: removed ? null : run.worktree, worktree_removed: removed, branch: removed ? null : run.branch, state: S.runDir(run.run_id) };
}

// ---------------------------------------------------------------- afterwards
export function outcome(a) {
  const run = S.loadRun(a.run);
  const put = (move, label, source) => {
    const p = move.jev?.is_improvement ?? null;
    const r = C.writeLabel(jevFile(), { skill: Q.SKILL, question: 'is_improvement', case: move.case || `${run.run_id}/${move.id}`, label, source, p, unsafe: Q.META.is_improvement.unsafe });
    move.outcome = { label, source };
    return r.revoked;
  };
  if (a.move) {
    if (!['right', 'wrong'].includes(a.result)) throw new Error('--result must be right or wrong');
    const move = findMove(run, a.move);
    if (!move.decision) throw new Error(`${move.id} never ran`);
    // "right" means the decision was right: kept and good, or dropped and bad.
    const improvement = move.decision.keep === (a.result === 'right');
    const revoked = put(move, improvement, 'outcome');
    S.saveRun(run);
    S.appendLog({ type: 'outcome', run: run.run_id, move: move.id, kept: move.decision.keep, result: a.result });
    return { run_id: run.run_id, move: move.id, kept: move.decision.keep, result: a.result, ...(revoked ? { revoked: 'improve-design/is_improvement' } : {}) };
  }
  if (!run.pr?.number) return { run_id: run.run_id, recorded: 0, why: 'this run opened no pull request: say which move was right or wrong' };
  const pr = viewPr(run.root, run.pr.number);
  if (!pr) return { run_id: run.run_id, recorded: 0, why: `pull request ${run.pr.number} could not be read` };
  if (!pr.merged) return { run_id: run.run_id, recorded: 0, pr: pr.state, why: 'the pull request is not merged: nothing can be read from that. Say which move was right or wrong' };
  // Merged as it stood: each kept move nobody spoke against was an improvement.
  const moves = kept(run).filter((m) => !m.outcome);
  for (const m of moves) put(m, true, 'merged');
  S.saveRun(run);
  for (const m of moves) S.appendLog({ type: 'outcome', run: run.run_id, move: m.id, kept: true, result: 'right', source: 'merged' });
  return { run_id: run.run_id, pr: 'MERGED', recorded: moves.length };
}

export function stats() {
  const log = S.readLog();
  const runs = log.filter((e) => e.type === 'run');
  const by = Object.fromEntries(VERDICTS.map((v) => [v, runs.filter((r) => r.verdict === v).length]));
  const reasons = {};
  for (const r of runs) for (const why of r.dropped || []) reasons[why] = (reasons[why] || 0) + 1;
  const outcomes = log.filter((e) => e.type === 'outcome');
  const right = outcomes.filter((o) => o.result === 'right').length;
  return {
    runs: runs.length, by_verdict: by,
    moves: { tried: runs.reduce((n, r) => n + (r.moves || 0), 0), kept: runs.reduce((n, r) => n + (r.kept || 0), 0), vetoed: runs.reduce((n, r) => n + (r.vetoed || 0), 0) },
    dropped_because: reasons,
    shipped: log.filter((e) => e.type === 'ship').length,
    outcomes: { rated: outcomes.length, right, wrong: outcomes.length - right, accuracy: outcomes.length ? Number((right / outcomes.length).toFixed(2)) : null },
  };
}

// ---------------------------------------------------------------- cli
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

const cmds = {
  probe: () => probe(G.topLevel(String(json().repo || '.')) || process.cwd()),
  start: () => start(json()),
  prepare: (a) => prepare(a.run),
  serve: (a) => serve(a.run),
  detect: () => detect(json()),
  shoot: (a) => shoot(a),
  'shots-record': () => shotsRecord(json()),
  brief: (a) => brief(a),
  'baseline-record': (a) => baselineRecord(a.run, stdin()),
  plan: (a) => plan(a.run),
  approve: () => approve(json()),
  'move-start': (a) => moveStart(a),
  'move-check': (a) => moveCheck(a, stdin()),
  'compare-plan': (a) => comparePlan(a),
  'compare-record': (a) => compareRecord(a, stdin()),
  final: (a) => final(a.run, stdin()),
  'ship-plan': (a) => shipPlan(a.run),
  ship: (a) => ship(a.run),
  stop: (a) => stop(a.run),
  outcome: (a) => outcome(a),
  stats: () => stats(),
};
export const COMMANDS_CLI = Object.keys(cmds);
export { VERDICTS, VETOES };

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseCli(process.argv.slice(2));
  const fn = cmds[a._];
  if (!fn) {
    out({ error: `unknown command ${a._}`, commands: COMMANDS_CLI });
    process.exit(2);
  }
  Promise.resolve().then(() => fn(a)).then(out).catch((e) => {
    out({ error: e.message });
    process.exit(1);
  });
}
