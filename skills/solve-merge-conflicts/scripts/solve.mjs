#!/usr/bin/env node
// /solve-merge-conflicts harness. The agent reads both sides and proposes a
// resolution; this script lists the conflicts, writes every resolution,
// checks every claim it can check, runs the repo's checks and makes the one
// push. Prints exactly ONE JSON object per call.
//
//   start    < {repo, args: [...]}        the pull request, both branches, whether they conflict, the gates
//   open     < {run}                      a worktree at the pull request head with the base merged in; every conflict
//   resolve  < {run, id, kind, …}         writes one resolution into the file; says whether the user must be asked
//   decide   --run <id> --id <c1.h2> --confirmed   records the user's answer for one resolution
//   check    < {run, edits: [...]}        everything accounted for, the merge commit, the repo's checks, the verdict
//   push     --run <id> --confirmed       an ordinary push of that commit to the pull request branch (the one write)
//   drop     --run <id>                   removes the run's worktree
//
// It works in a worktree of its own, detached at the pull request head. No
// branch of the clone moves, no history is rewritten, and no flag that
// overwrites a branch is ever passed to git. Jev (optional) can only add a question.

import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, resolve as resolvePath, sep } from 'node:path';
import { ask as realAsk, redactBody } from './lib/jev.mjs';
import { loadConfig, jevMode } from './lib/config.mjs';
import { CLASSES, KINDS, classify, fileAsk, generatedRule, lockCommand } from './lib/classes.mjs';
import * as HK from './lib/hunks.mjs';
import * as G from './lib/git.mjs';
import * as GH from './lib/github.mjs';
import * as SRC from './lib/sources.mjs';
import * as CHK from './lib/gates.mjs';
import * as S from './lib/state.mjs';
import * as Q from './lib/questions.mjs';
import * as C from './lib/calibration.mjs';

export const VERDICTS = ['nothing_to_solve', 'resolved', 'resolved_unverified', 'needs_decision', 'checks_failed', 'blocked', 'pushed'];
export const MODES = ['solve', 'status', 'drop'];
export const FLAGS = ['--no-push'];
export const GATES = ['pr_open', 'same_repo', 'conflicts', 'local_unpushed', 'migrations', 'head_unchanged', 'base_moved', 'decisions', 'outside_edits', 'checks'];
export const STATUSES = ['pass', 'warn', 'block', 'unknown'];
export { CLASSES, KINDS };
const SHOWN_CHARS = 6000;
const REGEN_TIMEOUT_S = 600;
const MIGRATION = /(^|\/)(migrations?|drizzle|migrate)\//i;

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

// Jev, stubbable (SOLVE_CONFLICTS_JEV_STUB: { "<id or prefix*>": number, "__degraded": true }).
async function ask(built) {
  const stubFile = process.env.SOLVE_CONFLICTS_JEV_STUB;
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

// ---------------------------------------------------------------- the run's conflicts
const copyDir = (run, c) => join(S.runDir(run.run_id), 'conflicted', c.id);
const segmentsOf = (run, c) => HK.parse(readFileSync(join(copyDir(run, c), 'copy'), 'utf8'), c.size);
const resolutionsOf = (c) => Object.fromEntries(c.hunks.filter((h) => h.resolution).map((h) => [h.n, h.resolution]));
const abs = (run, file) => join(run.worktree, file);
// Where a conflicted file is written or removed. A pull request can carry a
// symbolic link, as the file itself or as one of its folders: nothing is ever
// written or removed through one, so nothing outside the worktree is reached.
function target(run, file) {
  const p = abs(run, file);
  const root = realpathSync(run.worktree);
  let dir = dirname(p);
  while (!existsSync(dir)) dir = dirname(dir);
  if (!`${realpathSync(dir)}${sep}`.startsWith(`${root}${sep}`)) throw new Error(`${file} does not lead to a place inside the worktree`);
  let link = false;
  try {
    link = lstatSync(p).isSymbolicLink();
  } catch {}
  if (link) throw new Error(`${file} is a symbolic link: this skill does not write through one`);
  return p;
}
// mode: the file's mode on the side it is taken from ("100755" is executable).
function writeFile(run, file, content, mode = null) {
  const p = target(run, file);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  if (mode) chmodSync(p, mode === '100755' ? 0o755 : 0o644);
}
const removeFile = (run, file) => rmSync(target(run, file), { force: true });
const stageOf = (side) => (side === 'pr' ? '2' : '3');
const sideBlob = (run, c, side) => {
  const st = c.stages[stageOf(side)];
  if (!st) throw new Error(`${c.file} does not exist on ${side === 'pr' ? "the pull request's" : "the base's"} side`);
  return G.blob(run.worktree, st.sha);
};
// One side's version of the file, whole, with that side's mode.
const writeSide = (run, c, side) => writeFile(run, c.file, sideBlob(run, c, side), c.stages[stageOf(side)].mode);
const rewrite = (run, c) => writeFile(run, c.file, HK.render(segmentsOf(run, c), resolutionsOf(c), c.size));

// Everything that takes a resolution: each hunk of a content conflict, and every other conflict as a whole.
const targets = (run) => run.conflicts.flatMap((c) => (c.class === 'content' ? c.hunks.map((h) => ({ c, h, t: h, id: h.id })) : [{ c, h: null, t: c, id: c.id }]));
const isDecided = (t) => Boolean(t.decided && t.resolution && t.decided.hash === t.resolution.hash);
const needsAnswer = (t) => Boolean(t.resolution && t.ask && !isDecided(t));
const unresolvedIds = (run) => targets(run).filter((x) => !x.t.resolution).map((x) => x.id);
const askList = (run) => [
  ...targets(run).filter((x) => needsAnswer(x.t)).map((x) => ({ id: x.id, file: x.c.file, ...(x.h ? { line: x.h.line } : {}), kind: x.t.resolution.kind, reason: x.t.ask })),
  ...Object.entries(run.edit_asks || {}).filter(([, e]) => !e.decided).map(([file, e]) => ({ id: `edit:${file}`, file, kind: 'edit', reason: e.reason })),
];

function findTarget(run, id) {
  const m = /^(c\d+)(?:\.h(\d+))?$/.exec(String(id));
  const c = m && run.conflicts.find((x) => x.id === m[1]);
  if (!c) throw new Error(`no conflict ${id} in this run (known: ${run.conflicts.map((x) => x.id).join(', ')})`);
  if (c.class === 'content') {
    const h = c.hunks.find((x) => x.id === id);
    if (!h) throw new Error(`${c.file} is resolved hunk by hunk: name one of ${c.hunks.map((x) => x.id).join(', ')}`);
    return { c, h, t: h };
  }
  if (m[2]) throw new Error(`${c.file} is a ${c.class} conflict and is resolved as a whole: use ${c.id}`);
  return { c, h: null, t: c };
}

function cap(lines) {
  const text = HK.textOf(lines);
  return text.length > SHOWN_CHARS ? { text: text.slice(0, SHOWN_CHARS), truncated: true } : { text };
}
function conflictView(run, c) {
  const v = { id: c.id, file: c.file, class: c.class, kinds: KINDS[c.class], sources: c.sources };
  if (c.modified) v.changed_by = c.modified;
  if (c.has !== undefined) v.exists_on = c.has;
  if (c.unsupported) v.unsupported = c.unsupported;
  if (c.whole_because) v.whole_because = c.whole_because;
  if (c.class === 'content') {
    const segs = HK.hunksOf(segmentsOf(run, c));
    v.copy = join(copyDir(run, c), 'copy');
    v.hunks = c.hunks.map((h) => {
      const s = segs.find((x) => x.id === h.n);
      const [pr, origin, base] = [cap(s.pr), cap(s.origin), cap(s.base)];
      return { id: h.id, line: h.line, pr: pr.text, origin: origin.text, base: base.text, ...(pr.truncated || origin.truncated || base.truncated ? { truncated: true } : {}), ...(h.resolution ? { resolution: h.resolution.kind, ...(h.ask ? { ask: h.ask, decided: isDecided(h) } : {}) } : {}) };
    });
  } else if (c.resolution) {
    v.resolution = c.resolution.kind;
    if (c.resolution.command) v.command = c.resolution.command;
    if (c.ask) Object.assign(v, { ask: c.ask, decided: isDecided(c) });
  }
  if (c.regen_failed) v.regenerate_failed = c.regen_failed;
  return v;
}

function loadOpen(id) {
  const run = S.loadRun(id);
  if (run.pushed) throw new Error(`run ${run.run_id} already pushed ${short(run.pushed.commit)}`);
  if (!run.worktree || !G.isRunWorktree(run) || !existsSync(run.worktree)) throw new Error(`run ${run.run_id} has no worktree: call open first, or start a new run`);
  return run;
}
const configOf = (run) => loadConfig([run.cwd_repo, run.root], { repo: run.root, base: run.base.sha, head: run.head.sha });

// ---------------------------------------------------------------- start
function parseInput(args) {
  const a = args.map(String);
  if (a[0] === 'status') return { mode: 'status' };
  if (a[0] === 'drop') return { mode: 'drop', run: a[1] };
  const flags = { no_push: false };
  let pr = null;
  for (const t of a) {
    if (t === '--no-push') flags.no_push = true;
    else if (t.startsWith('-')) throw new Error(`unknown flag ${t} (known: ${FLAGS.join(', ')})`);
    else if (pr) throw new Error(`one pull request per run: got ${JSON.stringify(pr)} and ${JSON.stringify(t)}`);
    else pr = t;
  }
  return { mode: 'solve', pr, flags };
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

function statusOf(root) {
  return S.allRuns().filter((r) => r.root === root && r.conflicts && r.worktree && existsSync(r.worktree)).map((r) => ({ run_id: r.run_id, pull_request: r.pr.number, title: r.pr.title, verdict: r.checked?.verdict || (unresolvedIds(r).length || askList(r).length ? 'needs_decision' : 'open'), created_at: r.created_at, worktree: r.worktree }));
}

export function start(input) {
  const repo = G.topLevel(resolvePath(input.repo || process.cwd()));
  if (!repo) throw new Error('not inside a git repository');
  const root = G.mainRoot(repo);
  const parsed = parseInput(input.args || []);
  if (parsed.mode === 'status') return { mode: 'status', runs: statusOf(root) };
  if (parsed.mode === 'drop') return { mode: 'drop', ...drop({ run: parsed.run }) };

  const slug = GH.repoSlug(repo);
  if (!slug) throw new Error('this is not a GitHub repository, or `gh` is not signed in: /solve-merge-conflicts works on GitHub pull requests');
  const number = parsed.pr ? prNumber(parsed.pr, slug) : GH.currentPr(repo);
  const candidates = () => GH.myConflicting(repo);
  if (!number) {
    const mine = candidates();
    return { mode: 'solve', needs: ['input'], candidates: mine ?? [], ...(mine === null ? { note: 'your open pull requests could not be listed' } : {}), next: 'the current branch has no pull request: ask which pull request, offering `candidates`. Never pick' };
  }
  const pr = GH.prView(repo, number);
  if (!pr) throw new Error(`no pull request #${number} in ${slug}`);
  const prView = { number: pr.number, title: pr.title, url: pr.url, author: pr.author, github_says: pr.mergeable };
  const gates = {};
  const blocked = (extra = {}) => ({ mode: 'solve', verdict: 'blocked', pr: prView, ...gateView(gates), ...extra });

  gates.pr_open = pr.state === 'OPEN' ? gate('pass', 'the pull request is open') : gate('block', `the pull request is ${String(pr.state).toLowerCase()}: there is nothing to make mergeable`);
  gates.same_repo = pr.fork ? gate('block', 'the head branch lives in a fork: this skill pushes only to branches of this repository') : gate('pass', 'the head branch is in this repository');
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
  const mergeBase = G.mergeBase(repo, headSha, baseSha);
  if (!mergeBase) {
    gates.conflicts = gate('block', `${pr.head} and ${pr.base} share no history`);
    return blocked();
  }
  const m = G.mergeConflicts(repo, headSha, baseSha);
  if (m.clean) {
    gates.conflicts = gate('pass', `${pr.head} merges with ${pr.base} without a conflict`);
    S.appendLog({ repo: slug, pr: pr.number, verdict: 'nothing_to_solve' });
    const mine = parsed.pr ? null : candidates();
    return { mode: 'solve', verdict: 'nothing_to_solve', pr: prView, ...gateView(gates), ...(mine?.filter((p) => p.number !== pr.number).length ? { candidates: mine.filter((p) => p.number !== pr.number) } : {}) };
  }
  gates.conflicts = gate('pass', `${plural(m.files.length, 'file')} in conflict`);

  const ahead = G.localAhead(repo, pr.head, headSha);
  gates.local_unpushed = ahead ? gate('warn', `your local ${pr.head} holds ${plural(ahead, 'commit')} the pull request lacks: the pull request head (${short(headSha)}) is what gets resolved`) : gate('pass', 'no local commits are missing from the pull request');
  const added = (to) => (G.tryGit(repo, ['diff', '--name-only', '--diff-filter=A', mergeBase, to]) || '').split('\n').filter((f) => MIGRATION.test(f));
  const [prMig, baseMig] = [added(headSha), added(baseSha)];
  gates.migrations = prMig.length && baseMig.length ? gate('warn', `both sides add a migration (${prMig[0]}, ${baseMig[0]}): their order is not checked here. Run /real-skills:check-infra-and-migrations on the pull request after the push`) : gate('pass', 'the two sides do not both add a migration');

  const { config, sources: configSources, ignored } = loadConfig([repo, root], { repo: root, base: baseSha, head: headSha });
  const run = {
    run_id: S.newRunId(), created_at: now(), root, cwd_repo: repo, slug, remote, flags: parsed.flags,
    pr: { number: pr.number, title: pr.title, url: pr.url },
    base: { branch: pr.base, sha: baseSha }, head: { branch: pr.head, sha: headSha }, merge_base: mergeBase,
    start_gates: gates, conflicts: null,
  };
  S.saveRun(run);
  return {
    mode: 'solve', run_id: run.run_id, pr: { ...prView, body: pr.body.slice(0, 4000) }, base: run.base, head: run.head, merge_base: mergeBase,
    conflicted_files: m.files, base_since: SRC.baseSince(repo, mergeBase, baseSha), ...gateView(gates),
    checks: { install: config.install, commands: config.gates, from: configSources, ...(ignored.length ? { ignored, ignored_because: 'the pull request adds this config file: a pull request does not choose the commands that run on it' } : {}), ...(config.gates.length ? { note: 'these commands run the pull request\'s code on this machine' } : { note: 'no check command was found: the result will be reported as not checked' }) },
    no_push: parsed.flags.no_push, jev: jevMode(config),
  };
}

// ---------------------------------------------------------------- open
function buildConflict(run, config, entry, n, cache) {
  const c = { id: `c${n}`, file: entry.path, xy: entry.xy, stages: entry.stages, resolution: null, ask: null, decided: null };
  const blobs = Object.fromEntries(Object.entries(entry.stages).map(([st, v]) => [st, v.mode === '160000' ? null : G.blob(run.worktree, v.sha)]));
  const present = Object.values(blobs);
  const asText = (buf) => buf.toString('utf8');
  const binary = present.some((b) => b === null || G.looksBinary(b) || !Buffer.from(asText(b), 'utf8').equals(b));
  Object.assign(c, classify({ xy: entry.xy, path: entry.path, binary, config }));
  if (present.includes(null)) c.unsupported = 'a submodule pointer: this skill does not move submodules';
  else if (Object.values(entry.stages).some((v) => v.mode === '120000')) c.unsupported = 'a symbolic link: this skill does not write through one';
  const src = SRC.fileSources(run.root, run.slug, { merge_base: run.merge_base, head_sha: run.head.sha, base_sha: run.base.sha }, entry.path, cache);
  c.cite = src.all;
  c.sources = { pr_side: src.pr_side, base_side: src.base_side, ...(src.more ? { more: src.more } : {}) };

  if (c.class === 'content') {
    const texts = { pr: asText(blobs['2']), origin: blobs['1'] ? asText(blobs['1']) : '', base: asText(blobs['3']) };
    c.size = HK.markerSize(Object.values(texts));
    const dir = copyDir(run, c);
    const copy = G.mergeFile(dir, { pr: blobs['2'], origin: blobs['1'] || Buffer.alloc(0), base: blobs['3'] }, c.size);
    writeFileSync(join(dir, 'copy'), copy);
    c.hunks = HK.hunksOf(HK.parse(copy, c.size)).map((h) => ({ id: `${c.id}.h${h.id}`, n: h.id, line: h.line, resolution: null, ask: null, decided: null }));
    // git called it a conflict and the lines merge: the repo told git not to merge this file (an
    // attribute), or the conflict is not in its lines. Not the script's to settle: one side, whole, asked.
    if (!c.hunks.length) Object.assign(c, { class: 'binary', hunks: undefined, size: undefined, whole_because: 'git reports a conflict that is not in the file\'s lines' });
    // Otherwise the working file now carries the same hunks the run numbers.
    else if (!c.unsupported) writeFile(run, c.file, copy);
  } else if (c.class === 'lockfile' || (c.class === 'generated' && generatedRule(c.file, config)?.command)) {
    const command = c.class === 'lockfile' ? lockCommand(c.file, config, { berry: existsSync(join(dirname(abs(run, c.file)), '.yarnrc.yml')) }) : generatedRule(c.file, config).command;
    if (!c.unsupported) writeSide(run, c, 'base');
    c.resolution = { kind: 'regenerate', command, why: `the base's copy, then \`${command}\``, hash: sha1({ kind: 'regenerate', command }) };
  } else if (c.class === 'structural' && c.has === null) {
    removeFile(run, c.file);
    c.resolution = { kind: 'delete', why: 'both sides removed this path', hash: sha1({ kind: 'delete' }) };
  }
  return c;
}

const openView = (run) => ({
  run_id: run.run_id, worktree: run.worktree, pr: run.pr, base: run.base, head: run.head,
  conflicts: run.conflicts.map((c) => conflictView(run, c)),
  git_said: run.messages, unresolved: unresolvedIds(run), asks: askList(run),
  ...(run.conflicts.some((c) => c.unsupported) ? { verdict: 'blocked', blocked_by: run.conflicts.filter((c) => c.unsupported).map((c) => `${c.file}: ${c.unsupported}`) } : {}),
});

export function open(input) {
  const run = S.loadRun(input.run);
  if (run.pushed) throw new Error(`run ${run.run_id} already pushed`);
  if (run.conflicts && run.worktree && existsSync(run.worktree)) return openView(run);
  if (run.conflicts) throw new Error(`run ${run.run_id} was dropped: its worktree is gone. Start a new run`);
  run.worktree = G.addWorktree(run.root, run.run_id, run.head.sha);
  S.saveRun(run);
  const m = G.startMerge(run.worktree, run.base.sha);
  if (!m.conflicted) {
    G.removeWorktree(run);
    return { run_id: run.run_id, verdict: 'nothing_to_solve' };
  }
  const entries = G.unmerged(run.worktree);
  run.clean_tree = G.cleanTree(run.worktree, join(S.runDir(run.run_id), 'index.clean'), entries.map((e) => e.path));
  const { config } = configOf(run);
  const cache = new Map();
  run.messages = m.messages;
  run.conflicts = [];
  entries.forEach((e, i) => run.conflicts.push(buildConflict(run, config, e, i + 1, cache)));
  S.saveRun(run);
  return openView(run);
}

// ---------------------------------------------------------------- resolve, decide
const MARKER_LINE = /^(<{7,}|>{7,}|={7,}|\|{7,})( |$)/m;
// A path inside the repo, as git writes it.
function repoPath(p) {
  const s = String(p ?? '').trim();
  if (!s || s.startsWith('/') || normalize(s).startsWith('..') || /(^|\/)\.git(\/|$)/.test(s)) throw new Error(`${JSON.stringify(s.slice(0, 120))} is not a path inside the repository`);
  return normalize(s);
}

export function resolve(input) {
  const run = loadOpen(input.run);
  const { c, h, t } = findTarget(run, input.id);
  if (c.unsupported) throw new Error(`${c.file}: ${c.unsupported}`);
  const kind = String(input.kind || '');
  if (!KINDS[c.class].includes(kind)) throw new Error(`a ${c.class} conflict is resolved as one of ${KINDS[c.class].join(', ')}: got ${JSON.stringify(kind)}`);
  const why = oneLine(input.why);
  if (!why && kind !== 'regenerate') throw new Error('`why` is missing: one line on what each side wanted and how this keeps it');
  const r = { kind };
  const range = { merge_base: run.merge_base, head_sha: run.head.sha, base_sha: run.base.sha };

  if (kind === 'regenerate') {
    const { config } = configOf(run);
    const command = c.class === 'lockfile' ? lockCommand(c.file, config, { berry: existsSync(join(dirname(abs(run, c.file)), '.yarnrc.yml')) }) : generatedRule(c.file, config)?.command;
    if (!command) throw new Error(`no command is configured to write ${c.file} again: take one side, or add it to \`generated\` in .claude/solve-merge-conflicts.json`);
    Object.assign(r, { command, why: `the base's copy, then \`${command}\`` });
    writeSide(run, c, 'base');
    delete c.regen_failed;
  } else {
    r.why = why;
    r.cited = SRC.checkCitations(run.root, range, c.file, c.cite, input.sources).cited;
  }

  if (h) {
    const hunk = HK.hunksOf(segmentsOf(run, c)).find((x) => x.id === h.n);
    if (kind === 'both') {
      if (!['pr', 'base'].includes(input.first)) throw new Error('`first` is missing: which side\'s lines go first, "pr" or "base"');
      r.first = input.first;
    }
    if (kind === 'combined') {
      if (typeof input.text !== 'string') throw new Error('`text` is missing: the lines that replace the hunk');
      if (MARKER_LINE.test(input.text)) throw new Error('`text` contains a conflict marker');
      r.text = input.text === '' || input.text.endsWith('\n') ? input.text : `${input.text}\n`;
    }
    r.hash = sha1({ kind, first: r.first, text: r.text });
    h.ask = HK.hunkAsk(hunk, r);
    h.resolution = r;
    h.decided = null;
    rewrite(run, c);
  } else {
    if (kind === 'port') r.to = repoPath(input.to);
    if (c.class === 'structural' && kind === 'keep' && c.has === null) throw new Error(`${c.file} exists on neither side: it can only be deleted`);
    if (kind === 'pr' || kind === 'base') writeSide(run, c, kind);
    else if (kind === 'keep') writeSide(run, c, c.class === 'modify_delete' ? c.modified : c.has);
    else if (kind === 'delete' || kind === 'port') removeFile(run, c.file);
    r.hash = sha1({ kind, to: r.to });
    c.ask = fileAsk(c, kind, r.to);
    c.resolution = r;
    c.decided = null;
  }
  // A question Jev added was about the resolution that is now gone.
  delete t.jev_ask;
  delete run.checked;
  S.saveRun(run);
  const asked = needsAnswer(t);
  return {
    id: input.id, file: c.file, kind, written: true,
    ...(asked ? { needs_decision: true, ask: t.ask, next: 'show both sides with their commits, say what this resolution keeps and what it drops, recommend, and wait. On a yes: decide --confirmed. Otherwise resolve again' } : { needs_decision: false }),
    unresolved: unresolvedIds(run), asks: askList(run),
  };
}

function labelDisagree(run, x) {
  const logged = run.jev_cases?.[x.id]?.sides_disagree;
  if (!logged || logged.labelled || !isDecided(x.t) || logged.hash !== x.t.resolution.hash) return;
  const label = Q.disagreeLabel(x.t.resolution.kind);
  if (label === null) return;
  C.writeLabel(S.jevLog(), { skill: Q.SKILL, question: 'sides_disagree', case: logged.case, label, source: 'decision', p: logged.p, unsafe: Q.SHAPE.sides_disagree.unsafe });
  logged.labelled = true;
}

export function decide(a) {
  const run = loadOpen(a.run);
  const id = String(a.id || '');
  if (a.confirmed !== true) return { decided: false, refused: 'needs --confirmed: the user\'s yes to this one resolution, in this conversation' };
  if (id.startsWith('edit:')) {
    const e = run.edit_asks?.[id.slice(5)];
    if (!e) throw new Error(`nothing is asked about ${id}`);
    e.decided = true;
  } else {
    const x = findTarget(run, id);
    if (!x.t.resolution) throw new Error(`${id} has no resolution yet`);
    if (!x.t.ask) throw new Error(`nothing is asked about ${id}`);
    x.t.decided = { hash: x.t.resolution.hash, at: now() };
    labelDisagree(run, { ...x, id });
  }
  delete run.checked;
  S.saveRun(run);
  return { decided: true, id, unresolved: unresolvedIds(run), asks: askList(run) };
}

// ---------------------------------------------------------------- check
const KIND_WORDS = { both: 'kept both sides', combined: 'combined both sides', pr: "kept the pull request's version", base: "kept the base's version", regenerate: 'written again from the base\'s copy', keep: 'kept the file', delete: 'deleted the file' };
const kindWords = (r) => (r.kind === 'port' ? `deleted, its change carried to ${r.to}` : KIND_WORDS[r.kind]);

function resolutionRows(run) {
  return targets(run).map((x) => {
    const r = x.t.resolution;
    return { id: x.id, file: x.c.file, ...(x.h ? { line: x.h.line } : {}), class: x.c.class, kind: r.kind, how: kindWords(r), why: r.why, asked: Boolean(x.t.ask), ...(x.t.ask ? { asked_because: x.t.ask } : {}), ...(r.kind === 'combined' ? { text: r.text.slice(0, SHOWN_CHARS) } : {}), ...(r.cited ? { cited: { pr: r.cited.pr.map(short), base: r.cited.base.map(short) } } : {}) };
  });
}

function commitMessage(run, rows, edits) {
  const lines = [`Merge ${run.base.branch} into ${run.head.branch}`, '', 'Conflicts resolved with /real-skills:solve-merge-conflicts:'];
  for (const r of rows.slice(0, 80)) lines.push(`- ${r.file}${r.line ? ` (line ${r.line})` : ''}: ${r.how}. ${r.why}`);
  if (rows.length > 80) lines.push(`- and ${rows.length - 80} more`);
  if (edits.length) lines.push('', 'Adapted outside the conflicts:', ...edits.map((e) => `- ${e.file}: ${e.why}`));
  return `${lines.join('\n')}\n`;
}

// Runs every `regenerate` command. -> the conflicts whose command failed
function regenerate(run) {
  const failed = [];
  for (const c of run.conflicts.filter((x) => x.resolution?.kind === 'regenerate')) {
    writeSide(run, c, 'base');
    const log = join(S.sub(run.run_id, 'logs'), `regenerate-${c.id}.log`);
    const r = CHK.sh(dirname(abs(run, c.file)), c.resolution.command, { timeoutS: REGEN_TIMEOUT_S, log });
    if (r.exit === 0 && existsSync(abs(run, c.file))) continue;
    c.regen_failed = { command: c.resolution.command, exit: r.exit, log };
    c.resolution = null;
    c.ask = null;
    failed.push(c);
  }
  return failed;
}

async function askJev(run, mode, edits) {
  const hunks = targets(run).filter((x) => x.h).map((x) => ({ id: x.id, file: x.c.file, kind: x.t.resolution.kind, why: x.t.resolution.why, hash: x.t.resolution.hash, sources: x.c.sources }));
  const built = Q.build(`${run.slug}#${run.pr.number}`, run.pr, hunks, edits.map((e) => ({ ...e, hash: sha1({ why: e.why, source: e.source }) })));
  run.jev_seen ||= [];
  const fresh = built.cases.filter((c) => !run.jev_seen.includes(c.case));
  if (!fresh.length) return mode;
  const res = await ask({ state: built.state, questions: Object.fromEntries(fresh.map((c) => [c.key, built.questions[c.key]])) });
  if (res.degraded) return 'degraded';
  const cases = [];
  run.jev_cases ||= {};
  for (const c of fresh) {
    const p = res.answers[c.key]?.noul;
    if (typeof p !== 'number') continue;
    run.jev_seen.push(c.case);
    const sp = Q.spot(c.question, c.case);
    const acted = mode === 'live' && Q.calibrated(c.question) && !sp;
    cases.push({ skill: Q.SKILL, question: c.question, case: c.case, p, threshold: Q.thr(c.question), ...Q.SHAPE[c.question], mode, acted, ...(sp ? { spot: true } : {}), show: c.show });
    const why = acted ? Q.reason(c.question, p) : null;
    if (c.target.startsWith('edit:')) {
      // The case id holds the edit's reason and commit: a changed edit is a new case, and a new question.
      if (why) (run.edit_asks ||= {})[c.target.slice(5)] = { reason: why, decided: false };
      continue;
    }
    const x = targets(run).find((y) => y.id === c.target);
    (run.jev_cases[c.target] ||= {})[c.question] = { case: c.case, p, hash: x.t.resolution.hash };
    // It can add a question. It never takes one away, and never answers one.
    if (why && !x.t.ask) Object.assign(x.t, { ask: why, jev_ask: true });
  }
  C.writeCases(S.jevLog(), cases, redactBody);
  for (const x of targets(run)) labelDisagree(run, x);
  return mode;
}

export async function check(input) {
  const run = loadOpen(input.run);
  const { config, sources: configSources } = configOf(run);
  const gates = {};
  const done = (verdict, extra = {}) => {
    run.checked = verdict === 'resolved' || verdict === 'resolved_unverified' || verdict === 'checks_failed' ? { ...run.checked, verdict } : undefined;
    if (!run.checked) delete run.checked;
    S.saveRun(run);
    return { run_id: run.run_id, verdict, ...gateView(gates), ...extra };
  };

  const fetched = G.fetchRefs(run.root, run.remote, [run.head.branch]);
  const head = G.tip(run.root, run.remote, run.head.branch);
  if (!fetched) gates.head_unchanged = gate('block', `${run.head.branch} could not be fetched: old refs prove nothing`);
  else if (head !== run.head.sha) gates.head_unchanged = gate('block', `the pull request head moved from ${short(run.head.sha)} to ${short(head)}: this run is over. Drop it and start again`);
  else gates.head_unchanged = gate('pass', `the pull request head is still ${short(run.head.sha)}`);
  if (gates.head_unchanged.status === 'block') return done('blocked');
  if (run.conflicts.some((c) => c.unsupported)) return done('blocked', { blocked_by: run.conflicts.filter((c) => c.unsupported).map((c) => `${c.file}: ${c.unsupported}`) });

  const waiting = () => {
    const [unresolved, asks] = [unresolvedIds(run), askList(run)];
    gates.decisions = unresolved.length || asks.length ? gate('block', [unresolved.length ? `${plural(unresolved.length, 'conflict')} not resolved yet` : null, asks.length ? `${plural(asks.length, 'resolution')} waiting for the user's answer` : null].filter(Boolean).join('; ')) : gate('pass', 'every conflict is resolved, and every question was answered');
    return unresolved.length || asks.length ? done('needs_decision', { unresolved, asks, regenerate_failed: run.conflicts.filter((c) => c.regen_failed).map((c) => ({ id: c.id, file: c.file, ...c.regen_failed })) }) : null;
  };
  let stop = waiting();
  if (stop) return stop;

  // Lockfiles and generated files are written last: they read what the hunks settled.
  const scratch = join(S.runDir(run.run_id), 'index.now');
  const beforeRegen = G.treeNow(run.worktree, scratch);
  const failed = regenerate(run);
  if (failed.length) {
    stop = waiting();
    return stop;
  }
  const tree = G.treeNow(run.worktree, scratch);
  // What the commands wrote besides their own file (`go mod tidy` rewrites go.mod too). A path stays
  // the command's only while it holds exactly what the command left there: changed by hand
  // afterwards, it is an edit like any other.
  const wrote = { ...(run.regen_wrote || {}) };
  const blobNow = (p) => G.blobAt(run.root, tree, p) || 'gone';
  for (const p of G.changedPaths(run.root, beforeRegen, tree)) wrote[p] = blobNow(p);
  for (const p of Object.keys(wrote)) if (blobNow(p) !== wrote[p]) delete wrote[p];
  run.regen_wrote = wrote;
  const regenerated = Object.keys(wrote).sort();

  // What differs from the tree the resolutions alone produce, read from git.
  const conflictFiles = new Set(run.conflicts.map((c) => c.file));
  const outside = new Set(G.changedPaths(run.root, run.clean_tree, tree).filter((p) => !conflictFiles.has(p) && !regenerated.includes(p)));
  for (const c of run.conflicts.filter((x) => x.class === 'content')) {
    const expected = HK.render(segmentsOf(run, c), resolutionsOf(c), c.size);
    if (!existsSync(abs(run, c.file)) || readFileSync(abs(run, c.file), 'utf8') !== expected) outside.add(c.file);
  }
  for (const c of run.conflicts.filter((x) => x.class !== 'content' && x.resolution.kind !== 'regenerate')) {
    const k = c.resolution.kind;
    const there = existsSync(abs(run, c.file));
    const side = k === 'keep' ? (c.class === 'modify_delete' ? c.modified : c.has) : k;
    if (k === 'delete' || k === 'port' ? there : !there || G.hashFile(run.worktree, abs(run, c.file)) !== c.stages[stageOf(side)].sha) outside.add(c.file);
  }
  const range = { merge_base: run.merge_base, head_sha: run.head.sha, base_sha: run.base.sha };
  const edits = [];
  const problems = [];
  for (const e of Array.isArray(input.edits) ? input.edits : []) {
    try {
      const file = repoPath(e.file);
      const why = oneLine(e.why);
      if (!why) throw new Error(`${file}: \`why\` is missing`);
      const source = SRC.checkEditSource(run.root, range, e.source);
      if (!outside.has(file)) throw new Error(`${file} is listed as an edit and is unchanged`);
      edits.push({ file, why, source, because: SRC.subjectOf(run.root, source) });
    } catch (err) {
      problems.push(err.message);
    }
  }
  const unlisted = [...outside].filter((p) => !edits.some((e) => e.file === p)).sort();
  for (const x of targets(run)) if (x.t.resolution.kind === 'port' && !outside.has(x.t.resolution.to)) problems.push(`${x.c.file} is resolved as carried to ${x.t.resolution.to}, and ${x.t.resolution.to} is unchanged`);
  if (unlisted.length || problems.length) {
    gates.outside_edits = gate('block', [unlisted.length ? `${plural(unlisted.length, 'file')} changed outside the conflicts and not listed: ${unlisted.slice(0, 10).join(', ')}` : null, ...problems].filter(Boolean).join('; '));
    return done('needs_decision', { unlisted, problems, next: 'list each changed file in `edits` with one line on why and the commit that made it necessary, or undo the change. An edit is allowed only to make one side fit the other\'s change' });
  }
  gates.outside_edits = edits.length ? gate('warn', `${plural(edits.length, 'file')} edited outside the conflicts: shown in the summary`) : gate('pass', 'nothing changed outside the conflicts');
  for (const file of Object.keys(run.edit_asks || {})) if (!edits.some((e) => e.file === file)) delete run.edit_asks[file];

  let jev = jevMode(config);
  if (jev !== 'off') {
    jev = await askJev(run, jev, edits);
    stop = waiting();
    if (stop) return { ...stop, jev };
  }

  const rows = resolutionRows(run);
  const commit = G.commitTree(run.worktree, tree, [run.head.sha, run.base.sha], commitMessage(run, rows, edits));
  run.checked = { tree, commit, at: now(), edits };

  const logDir = S.sub(run.run_id, 'logs');
  const opts = { timeoutS: config.gate_timeout_s, logDir };
  // The checks run on the commit itself, in a worktree of their own: what they leave behind
  // (coverage, build output) never reaches the tree that is pushed, and what is checked is
  // exactly what would be pushed.
  let results = [];
  let notRun = [];
  if (config.gates.length) {
    const checkTree = `${G.worktreePath(run.root, run.run_id)}${G.CHECK}`;
    try {
      if (existsSync(checkTree)) G.moveTo(checkTree, commit);
    } catch {
      G.removeWorktreeAt(run.root, checkTree);
    }
    if (!existsSync(checkTree)) G.addWorktree(run.root, run.run_id, commit, G.CHECK);
    ({ results, not_run: notRun } = CHK.runAll(checkTree, config, { ...opts, label: 'after' }));
  }
  const red = results.filter((r) => !r.ok);
  if (red.length) {
    const beforeTree = G.addWorktree(run.root, run.run_id, run.head.sha, G.BEFORE);
    try {
      const was = CHK.before(beforeTree, config, red, { ...opts, label: 'before' });
      for (const r of red) r.before = was[r.cmd] || 'not_run';
    } finally {
      G.removeWorktreeAt(run.root, beforeTree);
    }
  }
  const turned = red.filter((r) => r.before === 'green');
  const uncompared = red.filter((r) => r.before === 'not_run');
  const already = red.filter((r) => r.before === 'red');
  const names = (list) => list.map((r) => `\`${r.cmd}\``).join(', ');
  // An install is not a check: with no check command nothing was checked.
  if (!config.gates.length) gates.checks = gate('unknown', 'no check command was found: the result was not checked');
  else if (turned.length) gates.checks = gate('block', `the merge turned ${plural(turned.length, 'check')} red: ${names(turned)}`);
  else if (uncompared.length) gates.checks = gate('block', `${names(uncompared)} ${uncompared.length === 1 ? 'is' : 'are'} red, and could not be compared with the pull request head, where \`${config.install}\` fails`);
  else if (notRun.length) gates.checks = gate('unknown', `\`${config.install}\` already fails on the pull request head, so ${plural(notRun.length, 'check')} could not run: the result was not checked`);
  else if (already.length) gates.checks = gate('warn', `${names(already)} ${already.length === 1 ? 'is' : 'are'} red, and already ${already.length === 1 ? 'was' : 'were'} on the pull request head: not the merge's doing`);
  else gates.checks = gate('pass', `${plural(results.filter((r) => !r.install).length, 'check')} green`);

  const verdict = turned.length || uncompared.length ? 'checks_failed' : gates.checks.status === 'unknown' ? 'resolved_unverified' : 'resolved';
  const kinds = {};
  for (const r of rows) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  S.appendLog({ run: run.run_id, repo: run.slug, pr: run.pr.number, verdict, conflicts: run.conflicts.length, resolutions: rows.length, kinds, asked: rows.filter((r) => r.asked).length, edits: edits.length, checks: { green: results.filter((r) => r.ok).length, red_before: already.length, turned_red: turned.length, uncompared: uncompared.length }, jev });
  const pushable = verdict !== 'checks_failed';
  const restate = [...of(gates, 'warn'), ...of(gates, 'unknown')].map((k) => gates[k].text).concat(Object.values(run.start_gates).filter((g) => g.status === 'warn').map((g) => g.text));
  const pushLine = `git -C ${JSON.stringify(run.worktree)} push ${run.remote} ${commit}:refs/heads/${run.head.branch}`;
  return done(verdict, {
    commit, summary: { pull_request: run.pr, merge: `${run.base.branch} (${short(run.base.sha)}) into ${run.head.branch} (${short(run.head.sha)})`, resolutions: rows, edits: edits.map((e) => ({ file: e.file, why: e.why, because_of: `${short(e.source)} ${e.because}` })), regenerated },
    checks: { from: configSources, results: results.map((r) => ({ cmd: r.cmd, ok: r.ok, ...(r.ok ? {} : { exit: r.exit, before: r.before, log: r.log }) })), not_run: notRun },
    restate, jev,
    ...(pushable && !run.flags.no_push ? { ask: `Push one merge commit (${short(commit)}) to ${run.head.branch}, the branch of pull request #${run.pr.number}? It adds ${run.base.branch} to the branch and rewrites nothing.${verdict === 'resolved_unverified' ? ' The result was not checked.' : ''}` } : {}),
    ...(pushable && run.flags.no_push ? { push_command: pushLine, next: '--no-push: show the summary and the command. Do not run it' } : {}),
    ...(pushable ? {} : { next: 'read the log of each red check. If one side\'s change broke the other\'s code, adapt it (an edit outside the conflicts, listed in `edits`) and check again. Otherwise say what failed and stop: nothing is pushed' }),
  });
}

// ---------------------------------------------------------------- push, drop
export function push(a) {
  const run = loadOpen(a.run);
  const refuse = (reason, gates = {}) => ({ pushed: false, refused: reason, ...(Object.keys(gates).length ? gateView(gates) : {}) });
  if (run.flags.no_push) return refuse('this run was started with --no-push');
  if (!run.checked?.commit) return refuse('nothing was checked yet, or something changed since: run check first');
  if (run.checked.verdict === 'checks_failed') return refuse('the merge turned a check red: nothing is pushed');
  if (a.confirmed !== true) return refuse('needs --confirmed: the user\'s yes to this push, in this conversation');
  if (G.treeNow(run.worktree, join(S.runDir(run.run_id), 'index.now')) !== run.checked.tree) return refuse('the worktree changed since check: run check again, and show the summary again');
  // The commit is read back from git, not taken on the run file's word.
  let merge = null;
  try {
    merge = { tree: G.treeOf(run.root, run.checked.commit), parents: G.parentsOf(run.root, run.checked.commit) };
  } catch {}
  if (!merge || merge.tree !== run.checked.tree || merge.parents.join(' ') !== `${run.head.sha} ${run.base.sha}`) return refuse('the checked commit is not this run\'s merge of the two heads: run check again');

  const gates = {};
  const pr = GH.prView(run.cwd_repo, run.pr.number);
  gates.pr_open = pr?.state === 'OPEN' ? gate('pass', 'the pull request is open') : gate('block', pr ? `the pull request is ${String(pr.state).toLowerCase()}` : 'the pull request could not be read');
  const remoteHead = G.remoteHead(run.root, run.remote, run.head.branch);
  if (remoteHead === null) gates.head_unchanged = gate('block', `${run.remote} could not be asked where ${run.head.branch} is`);
  else if (remoteHead !== run.head.sha || (pr && pr.head_sha !== run.head.sha)) gates.head_unchanged = gate('block', `the pull request head moved from ${short(run.head.sha)}${remoteHead ? ` to ${short(remoteHead)}` : ''}: this run is over. Drop it and start again`);
  else gates.head_unchanged = gate('pass', `the pull request head is still ${short(run.head.sha)}`);
  const fetched = G.fetchRefs(run.root, run.remote, [run.base.branch]);
  const base = G.tip(run.root, run.remote, run.base.branch);
  if (!fetched || !base) gates.base_moved = gate('unknown', `${run.base.branch} could not be fetched: whether it moved is not known`);
  else if (base === run.base.sha) gates.base_moved = gate('pass', `${run.base.branch} is still ${short(base)}`);
  else if (G.mergeConflicts(run.root, run.checked.commit, base).clean) gates.base_moved = gate('warn', `${run.base.branch} moved to ${short(base)} since the run started; the result still merges with it`);
  else gates.base_moved = gate('block', `${run.base.branch} moved to ${short(base)} and conflicts with the result again: drop this run and start a new one`);
  if (of(gates, 'block').length) return refuse(of(gates, 'block').map((k) => gates[k].text).join('; '), gates);

  try {
    G.pushCommit(run.worktree, run.remote, run.checked.commit, run.head.branch);
  } catch (e) {
    return refuse(`git refused the push: ${G.firstLine(e)}`, gates);
  }
  run.pushed = { commit: run.checked.commit, at: now() };
  S.saveRun(run);
  const after = GH.prView(run.cwd_repo, run.pr.number);
  let removed = true;
  try {
    G.removeWorktree(run);
  } catch {
    removed = false;
  }
  S.appendLog({ run: run.run_id, repo: run.slug, pr: run.pr.number, verdict: 'pushed' });
  const local = G.tryGit(run.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${run.head.branch}`]) !== null;
  return {
    pushed: true, verdict: 'pushed', commit: run.checked.commit, pr: run.pr, github_says: after?.mergeable || 'UNKNOWN', ...gateView(gates), worktree_removed: removed,
    next: `${after?.mergeable === 'MERGEABLE' ? 'GitHub reads the pull request as mergeable.' : after?.mergeable === 'CONFLICTING' ? 'GitHub still reads the pull request as conflicting: say so.' : 'GitHub has not recomputed whether it merges yet: say so, do not say it is mergeable.'}${local ? ` The local ${run.head.branch} is one commit behind: \`git pull\` there.` : ''}`,
  };
}

export function drop(a) {
  const run = S.loadRun(a.run);
  if (!run.worktree || !existsSync(run.worktree)) return { dropped: false, run_id: run.run_id, note: 'this run has no worktree left' };
  G.removeWorktree(run);
  delete run.checked;
  run.dropped = now();
  S.saveRun(run);
  S.appendLog({ run: run.run_id, repo: run.slug, pr: run.pr.number, verdict: 'dropped' });
  return { dropped: true, run_id: run.run_id, ...(run.pushed ? {} : { note: 'nothing was pushed; the run\'s resolutions stay in its state folder' }) };
}

// ---------------------------------------------------------------- main
const cmds = {
  start: () => start(json()),
  open: () => open(json()),
  resolve: () => resolve(json()),
  decide: (a) => decide(a),
  check: () => check(json()),
  push: (a) => push(a),
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
