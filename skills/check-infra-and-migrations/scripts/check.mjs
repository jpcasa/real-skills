#!/usr/bin/env node
// /check-infra-and-migrations harness. The agent reads and proposes; this
// script decides what counts. Prints exactly ONE JSON object per call.
//
//   probe        < {repo}                              what the repo says about migrations and infrastructure
//   start        < {repo, args: [...]}                 targets, buckets, rule hits, which live reads exist
//   live         < {run, confirmed: true}              runs the configured read-only commands
//   record       < {run, targets: [{id, findings}]}    citation check, Jev, verdict and runbook per target
//   post-plan    --run <id> --target <id>              the exact comment that would be posted
//   post         --run <id> --target <id> --confirmed  posts it (one PR comment), after the user said yes
//   outcome      --run <id> --target <id> --result right|wrong [--actual <verdict>]
//   stats
//
// Nothing from a change is checked out or executed. The one exception is the
// `plan` command the user configured, and only on a tree that already is the
// head of the change. Jev (optional) sees normalized one-liners and, until its
// questions are calibrated, is logged without deciding anything. Calibrated,
// it can only make a verdict worse.

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask as realAsk, redactBody } from './lib/jev.mjs';
import { parsePatch } from './lib/diff.mjs';
import { bucketOf, toolOf } from './lib/buckets.mjs';
import { fileFindings, historyFindings, journalFindings, windowFindings, referencedNames, isMeta, isSql } from './lib/migrations.mjs';
import { infraFindings, pipelineFindings, envFindings } from './lib/infra.mjs';
import { RULES, RULE_NAMES, LOCK_RULES, SEVERITIES, VERDICTS, BUCKETS, verdict, severityOf, bySeverity } from './lib/rules.mjs';
import { LIVE_KINDS, runCommand, parseApplied, matchApplied, parseSizes, parsePlan, planFindings } from './lib/live.mjs';
import { checkCitation } from './lib/cite.mjs';
import { buildRunbook, PHASES } from './lib/runbook.mjs';
import { chatLine, buildComment, refusal, countsText, plain } from './lib/post.mjs';
import { loadConfig, jevMode, isProduction } from './lib/config.mjs';
import { probe } from './lib/probe.mjs';
import * as GH from './lib/github.mjs';
import * as S from './lib/state.mjs';
import * as Q from './lib/questions.mjs';
import * as C from './lib/calibration.mjs';

export const MAX_TARGETS = 5;
export const MAX_FILES = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_REF_SEARCHES = 10;
const MAX_AGENT_FINDINGS = 30;

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

// Jev, stubbable (CHECK_INFRA_JEV_STUB: { "<id or prefix*>": number, "__degraded": true }).
async function ask(built) {
  const stubFile = process.env.CHECK_INFRA_JEV_STUB;
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
// One case per question, in the shape /calibrate reads. -> true when the answer may decide.
function kase(cases, mode, question, id, p, show) {
  if (typeof p !== 'number') return false;
  const sp = Q.spot(question, id);
  const acted = mode === 'live' && Q.calibrated(question) && !sp;
  cases.push({ skill: Q.SKILL, question, case: id, p, threshold: Q.thr(question), ...Q.SHAPE[question], mode, acted, ...(sp ? { spot: true } : {}), show });
  return acted;
}

// ---------------------------------------------------------------- start
const MODES = ['setup', 'post', 'outcome', 'stats'];
function parseInput(args, slug) {
  const a = args.map(String);
  if (MODES.includes(a[0])) return { mode: a[0], rest: a.slice(1) };
  const refs = [];
  const flags = { env: null, no_live: false, no_post: false };
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === '--target') flags.env = a[++i] || null;
    else if (t === '--no-live') flags.no_live = true;
    else if (t === '--no-post') flags.no_post = true;
    else if (t === 'promotion') refs.push({ kind: 'promotion' });
    else if (/^#?\d+$/.test(t)) refs.push({ kind: 'pr', n: Number(t.replace('#', '')) });
    else if (/^[^\s.][^\s]*\.\.\.?[^\s.][^\s]*$/.test(t) && !t.includes('://')) {
      const [base, head] = t.split(/\.\.\.?/);
      refs.push({ kind: 'range', base, head });
    } else {
      const m = t.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
      if (!m) throw new Error(`not a PR number, a PR URL, "promotion" or <base>..<head>: ${t}`);
      if (!slug || m[1].toLowerCase() !== slug.toLowerCase()) throw new Error(`${t} is in ${m[1]}, not ${slug || 'this repository'}: run it from a clone of that repository`);
      refs.push({ kind: 'pr', n: Number(m[2]) });
    }
  }
  return { mode: 'check', refs, flags };
}

// What the config answers, else what probe finds, for sorting files into buckets.
function layoutFor(repo, loaded) {
  const { config, explicit } = loaded;
  const found = explicit.migrations && explicit.infra ? null : probe(repo);
  const strip = ({ why, ...e }) => e;
  return {
    migrations: explicit.migrations ? config.migrations : found.migrations.map((m) => ({ ...strip(m), ...(found.migration_applied_by.length ? { applied_by: found.migration_applied_by } : {}) })),
    infra: explicit.infra ? config.infra : found.infra.map((m) => ({ ...strip(m), ...(found.infra_applied_by.length ? { applied_by: found.infra_applied_by } : {}) })),
    pipeline: config.pipeline || [],
    env_files: config.env_files || [],
    explicit,
  };
}

function resolveTargets(repo, config, slug, refs) {
  const prod = config.release?.production_branch || 'production';
  const main = config.release?.main_branch || GH.defaultBranch(repo) || 'main';
  const pr = (n) => {
    if (!slug) throw new Error('this is not a GitHub repository, or `gh` is not signed in: pass <base>..<head> instead of a PR');
    const v = GH.prView(repo, n);
    try {
      GH.fetchPr(repo, slug, n, v.base);
    } catch (e) {
      if (!GH.revParse(repo, v.base_sha) || !GH.revParse(repo, v.head_sha)) throw new Error(`the commits of #${n} could not be fetched (${String(e.stderr || e.message).trim().split('\n').pop()})`);
    }
    return { id: `pr-${n}`, kind: 'pr', number: n, title: v.title, url: v.url, state: v.state, base: v.base, base_sha: v.base_sha, head_sha: v.head_sha };
  };
  const range = (baseRef, headRef) => {
    const find = (ref) => GH.revParse(repo, ref) || GH.revParse(repo, `origin/${ref}`);
    const base_sha = find(baseRef);
    const head_sha = find(headRef);
    if (!base_sha || !head_sha) throw new Error(`${!base_sha ? baseRef : headRef} is not a commit in this clone: fetch it first`);
    const base = baseRef.replace(/^(origin|upstream)\//, '');
    return { id: `range-${short(base_sha)}-${short(head_sha)}`, kind: 'range', title: `${headRef.replace(/^(origin|upstream)\//, '')} → ${base}`, base, base_sha, head_sha };
  };
  const promotion = () => {
    const open = slug ? GH.openInto(repo, prod) : [];
    if (open.length) return pr(open[0]);
    GH.fetchBranches(repo, slug, [prod, main]);
    if (!GH.revParse(repo, `origin/${prod}`) || !GH.revParse(repo, `origin/${main}`)) throw new Error(`no open pull request into ${prod}, and origin/${prod} or origin/${main} is not in this clone to compare`);
    return range(`origin/${prod}`, `origin/${main}`);
  };

  if (!refs.length) {
    const mine = slug ? GH.currentPr(repo) : null;
    if (mine) return { targets: [pr(mine)] };
    const open = slug ? GH.openInto(repo, prod) : [];
    if (open.length) return { targets: [pr(open[0])] };
    const can = GH.revParse(repo, `origin/${prod}`) && GH.revParse(repo, `origin/${main}`);
    return { targets: [], candidates: { current_branch_pr: null, promotion_pr: null, range: can ? `origin/${prod}..origin/${main}` : null } };
  }
  const targets = [];
  for (const r of refs) {
    const t = r.kind === 'pr' ? pr(r.n) : r.kind === 'promotion' ? promotion() : range(r.base, r.head);
    if (!targets.some((x) => x.id === t.id)) targets.push(t);
  }
  return { targets, prod };
}

// Everything the rules can say about one target, from git alone.
function analyze(repo, runId, t, layout) {
  const dir = S.targetDir(runId, t.id);
  const mb = GH.mergeBase(repo, t.base_sha, t.head_sha) || t.base_sha;
  t.merge_base = mb;
  const bucketed = [];
  for (const c of GH.nameStatus(repo, mb, t.head_sha)) {
    const b = bucketOf(c.file, layout) || (c.old_file ? bucketOf(c.old_file, layout) : null);
    if (b) bucketed.push({ ...c, bucket: b.bucket, entry: b.entry });
  }
  const over = bucketed.splice(MAX_FILES);
  const patch = GH.diffOf(repo, mb, t.head_sha, [...new Set(bucketed.flatMap((c) => [c.file, c.old_file].filter(Boolean)))]);
  writeFileSync(join(dir, 'diff.patch'), patch);
  const diffs = new Map(parsePatch(patch).map((f) => [f.file, f]));

  // The head version of every bucketed file, for the rules and for the agent to read.
  const head = join(dir, 'head');
  const texts = new Map();
  const unread = over.map((c) => c.file);
  for (const c of bucketed) {
    if (c.status === 'deleted') continue;
    const dest = resolve(head, c.file);
    const text = dest.startsWith(head + sep) ? GH.showFile(repo, t.head_sha, c.file) : null;
    if (text == null || Buffer.byteLength(text) > MAX_FILE_BYTES) {
      unread.push(c.file);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
    texts.set(c.file, text);
  }
  const headLines = (f) => (texts.has(f) ? texts.get(f).split('\n') : null);
  const of = (bucket) => bucketed.filter((c) => c.bucket === bucket);
  const withDiff = (c) => ({ added: [], removed: [], ...(diffs.get(c.file) || {}), file: c.file, old_file: c.old_file, status: c.status, tool: c.entry?.tool || toolOf(c.file) });

  // ---- migrations: statements, in file order, so "created earlier in this change" is true
  const migs = of('migration').sort((a, b) => a.file.localeCompare(b.file));
  const entryOf = new Map(migs.map((c) => [c.file, c.entry]));
  const ctx = { created: new Set() };
  const findings = [];
  const statements = [];
  const unparsed = [];
  for (const c of migs) {
    if (c.status !== 'added' || isMeta(c.file) || !texts.has(c.file)) continue;
    const r = fileFindings(c.file, texts.get(c.file), ctx);
    findings.push(...r.findings);
    statements.push(...r.statements);
    unparsed.push(...r.unparsed);
  }
  const byApplied = new Map();
  for (const f of findings) {
    const k = entryOf.get(f.file)?.applied || '';
    byApplied.set(k, [...(byApplied.get(k) || []), f]);
  }
  for (const [applied, fs] of byApplied) findings.push(...windowFindings(fs, applied || undefined));

  // ---- migrations: history
  const baseFiles = GH.lsTree(repo, t.base_sha).filter((f) => bucketOf(f, layout)?.bucket === 'migration');
  findings.push(...historyFindings(migs, baseFiles, (f) => bucketOf(f, layout)?.entry));
  const journals = new Set(migs.filter((c) => c.status !== 'deleted').map((c) => (c.file.endsWith('/meta/_journal.json') ? c.file.slice(0, -'/meta/_journal.json'.length) : isSql(c.file) ? dirname(c.file) : null)).filter(Boolean));
  for (const d of journals) findings.push(...journalFindings(d, GH.showFile(repo, t.head_sha, `${d}/meta/_journal.json`), GH.lsTree(repo, t.head_sha, d)));

  // ---- a dropped or renamed name that the code at the head still uses
  const exclude = [...layout.migrations.flatMap((e) => (e.dir ? [`${e.dir}/**`] : e.paths || [])), '**/migrations/**', '**/migrate/**', '**/*.md', '**/*.snap', '**/*.lock', '**/package-lock.json', '**/pnpm-lock.yaml', '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test/**', '**/tests/**'];
  let searched = 0;
  for (const f of [...findings]) {
    const names = referencedNames(f);
    if (!names.length || searched >= MAX_REF_SEARCHES) continue;
    searched += 1;
    const { hits, total } = GH.grepTree(repo, t.head_sha, names, exclude);
    if (total) findings.push({ source: 'rule', bucket: 'migration', rule: 'still_referenced', file: f.file, line: f.line, name: names[0], refs: hits, total, normalized: `${names[0]} is named in ${plural(total, 'place')} outside the migrations` });
  }

  // ---- infrastructure, pipeline, env example files
  findings.push(...infraFindings(of('infra').map(withDiff), headLines));
  findings.push(...pipelineFindings(of('pipeline').map(withDiff), headLines));
  findings.push(...envFindings(of('env').map(withDiff)));
  findings.forEach((f, i) => (f.id = `r${i + 1}`));

  const entries = (bucket) => [...new Map(of(bucket).filter((c) => c.entry).map((c) => [JSON.stringify(c.entry), c.entry])).values()];
  Object.assign(t, {
    buckets: Object.fromEntries(BUCKETS.map((b) => [b, of(b).map((c) => c.file)])),
    migration_entries: entries('migration').map(({ tool, dir: d, applied, applied_by }) => ({ tool, dir: d, applied, applied_by })),
    infra_entries: entries('infra').map(({ tool, applied_by }) => ({ tool, applied_by })),
    applied: entries('migration').map((e) => e.applied).find(Boolean) || null,
    new_migrations: migs.filter((c) => c.status === 'added' && !isMeta(c.file)).map((c) => c.file),
    findings, statements, unparsed, unread,
    head_dir: head,
  });
}

// What could not be checked, by name. Any entry keeps the verdict from `safe`.
function uncheckedOf(t) {
  const reasons = [];
  for (const u of t.unparsed.slice(0, 5)) reasons.push(`${u.file}:${u.line} could not be classified (${u.normalized})`);
  if (t.unparsed.length > 5) reasons.push(`${plural(t.unparsed.length - 5, 'more statement')} could not be classified`);
  if (t.unread.length) reasons.push(`${plural(t.unread.length, 'file')} not read (too large, or over the ${MAX_FILES}-file limit): ${t.unread.slice(0, 3).join(', ')}`);
  const where = t.env || 'the target';
  const res = t.live?.results || {};
  const cmds = t.live?.commands || {};
  const why = (kind) => (res[kind] ? res[kind].reason : t.live?.skipped ? 'it was skipped for this run' : 'it did not run');
  if (t.buckets.infra.length && !res.plan?.ok) reasons.push(`infrastructure changed and no plan was read against ${where}${cmds.plan ? `: ${why('plan')}` : ' (no live.plan command is configured)'}`);
  for (const kind of ['applied', 'sizes']) if (cmds[kind] && !res[kind]?.ok) reasons.push(`the live "${kind}" read against ${where} gave nothing: ${why(kind)}`);
  if (res.applied?.ok && res.applied.no_match) reasons.push(`the applied list from ${where} matched no migration file: check the live.applied command`);
  if (res.applied?.ok && res.applied.empty) reasons.push(`the applied list from ${where} was empty: either nothing has ever run there or the live.applied command reads the wrong place`);
  if (res.sizes?.ok && res.sizes.unknown?.length) reasons.push(`no row count from ${where} for ${res.sizes.unknown.slice(0, 5).join(', ')}: a lock on a table of unknown size was not weighed`);
  return reasons;
}

const lineView = (f) => ({ id: f.id, rule: f.rule, severity: severityOf(f), line: chatLine(f) });
function targetView(t) {
  const sorted = [...t.findings].sort(bySeverity);
  const counts = verdict({ findings: t.findings }).counts;
  return {
    id: t.id, kind: t.kind, title: t.title, url: t.url || null, base: t.base, head_sha: short(t.head_sha), env: t.env, production: t.production, promotion: t.promotion,
    buckets: t.buckets, bucketed: t.bucketed, counts, summary: t.bucketed ? countsText(counts) : 'no migration or infrastructure change',
    findings: sorted.filter((f) => severityOf(f) !== 'note').map(lineView),
    notes: sorted.filter((f) => severityOf(f) === 'note').slice(0, 15).map(lineView),
    unparsed: t.unparsed.slice(0, 10), unread: t.unread,
    applied: t.applied, head_dir: t.bucketed ? t.head_dir : null,
    live: t.live?.commands && Object.keys(t.live.commands).length ? { env: t.env, production: t.production, commands: t.live.commands, skipped: Boolean(t.live.skipped) } : null,
  };
}

export async function start(input) {
  const repo = resolve(input.repo || process.cwd());
  const loaded = loadConfig(repo);
  const { config } = loaded;
  const slug = GH.repoSlug(repo);
  const parsed = parseInput(input.args || [], slug);
  if (parsed.mode !== 'check') return { mode: parsed.mode, rest: parsed.rest, config_sources: loaded.sources, needs_setup: loaded.needs_setup };
  const { refs, flags } = parsed;
  if (refs.length > MAX_TARGETS) throw new Error(`${refs.length} targets asked for; at most ${MAX_TARGETS} per run`);
  const needs = loaded.needs_setup ? ['setup'] : [];
  const resolved = resolveTargets(repo, config, slug, refs);
  if (!resolved.targets.length) {
    return { mode: 'check', needs: [...needs, 'input'], candidates: resolved.candidates, config_sources: loaded.sources, next: 'nothing was named and there is no open PR for this branch or into the production branch: ask what to check, then call start again' };
  }

  const layout = layoutFor(repo, loaded);
  const run = { run_id: S.newRunId(), created_at: new Date().toISOString(), repo, slug, jev: jevMode(config), post: config.post, no_post: flags.no_post, big_table_rows: config.big_table_rows, layout, targets: [] };
  const prod = config.release?.production_branch || 'production';
  for (const t of resolved.targets) {
    t.env = flags.env || config.targets.find((x) => x && x.branch === t.base)?.env || null;
    t.production = isProduction(config, t.env, t.base);
    t.promotion = config.targets.some((x) => x && x.branch === t.base) || t.base === prod;
    analyze(repo, run.run_id, t, layout);
    t.bucketed = Object.values(t.buckets).reduce((n, b) => n + b.length, 0);
    // Only the reads that could change this target's verdict.
    const cmds = (t.env && config.live[t.env]) || {};
    const relevant = { applied: t.buckets.migration.length > 0, sizes: t.buckets.migration.length > 0, plan: t.buckets.infra.length > 0 };
    t.live = { commands: Object.fromEntries(LIVE_KINDS.filter((k) => cmds[k] && relevant[k]).map((k) => [k, cmds[k]])), results: {}, skipped: flags.no_live };
    Object.assign(t, { review: null, posted: null });
    run.targets.push(t);
  }
  S.saveRun(run);
  const liveAsk = run.targets.filter((t) => !flags.no_live && Object.keys(t.live.commands).length).map((t) => ({ target: t.id, env: t.env, production: t.production, commands: t.live.commands }));
  const any = run.targets.some((t) => t.bucketed);
  return {
    mode: 'check', run_id: run.run_id, needs, jev: run.jev, post: flags.no_post ? 'off' : run.post, config_sources: loaded.sources,
    layout_from: { migrations: loaded.explicit.migrations ? 'config' : 'probe', infra: loaded.explicit.infra ? 'config' : 'probe' },
    targets: run.targets.map(targetView),
    ask: liveAsk.length ? { live: liveAsk } : null,
    next: !any ? 'no migration or infrastructure change in any target: say so and stop' : liveAsk.length ? 'ask the user once whether to run the live reads (show each command and its environment), then call live with confirmed: true; or go straight to record' : 'read the bucketed files under head_dir, then call record with your findings',
  };
}

// ---------------------------------------------------------------- live
export function live(input) {
  const run = S.loadRun(input.run || input.run_id);
  if (input.confirmed !== true) return { ok: false, run_id: run.run_id, refused: 'live reads run only after the user agreed to them in this conversation: call again with "confirmed": true' };
  const only = Array.isArray(input.targets) && input.targets.length ? input.targets : null;
  const outTargets = [];
  for (const t of run.targets) {
    const cmds = t.live?.commands || {};
    if (!Object.keys(cmds).length || (only && !only.includes(t.id)) || t.posted) continue;
    const dir = S.targetDir(run.run_id, t.id);
    const where = t.env || 'the target';
    // A second call replaces what the first derived, and a verdict recorded before it is stale.
    t.review = null;
    t.findings = t.findings.filter((f) => f.source !== 'live' && !f.outside_range);
    for (const f of t.findings) {
      if (f.raised) f.severity = undefined;
      delete f.raised;
      delete f.applied_on_target;
    }
    const added = [];
    const results = {};
    const exec = (kind) => {
      const res = runCommand(run.repo, cmds[kind], kind);
      writeFileSync(join(dir, `live-${kind}.txt`), res.output);
      return res;
    };
    const failed = (res) => ({ ok: false, reason: res.timeout ? 'the command timed out' : `the command exited ${res.exit}` });

    if (cmds.applied) {
      const res = exec('applied');
      if (!res.ok) results.applied = failed(res);
      else {
        const tokens = parseApplied(res.output);
        const hashes = [...tokens].some((x) => /^[0-9a-f]{64}$/.test(x));
        const all = GH.lsTree(run.repo, t.head_sha).filter((f) => bucketOf(f, run.layout)?.bucket === 'migration' && !isMeta(f));
        const m = matchApplied(tokens, all.map((file) => {
          const entry = bucketOf(file, run.layout)?.entry;
          const name = entry?.dir && file.startsWith(`${entry.dir}/`) ? file.slice(entry.dir.length + 1).split('/')[0] : basename(file);
          return { file, name, content: hashes ? GH.showFile(run.repo, t.head_sha, file) : undefined };
        }));
        results.applied = { ok: true, by: m.by, applied: m.applied.length, pending: m.pending, ahead: m.ahead, no_match: m.no_match, empty: tokens.size === 0 && all.length > 0 };
        if (!m.no_match && !results.applied.empty) {
          if (m.ahead) added.push({ source: 'live', bucket: 'migration', rule: 'target_ahead', file: null, line: null, count: m.ahead, normalized: `${plural(m.ahead, 'applied migration')} on the target not in this tree` });
          for (const f of t.findings) if (f.rule === 'edited_existing_migration' && m.applied.includes(f.file)) f.applied_on_target = true;
          results.applied.already_applied = t.new_migrations.filter((f) => m.applied.includes(f));
          // Not applied on the target and not part of this change: it runs with this release, unread until now.
          const ctx = { created: new Set() };
          for (const file of m.pending.filter((f) => !t.new_migrations.includes(f)).sort().slice(0, 20)) {
            added.push({ source: 'live', bucket: 'migration', rule: 'pending_outside_range', file, line: 1, normalized: `pending migration ${basename(file)} outside this change` });
            const text = GH.showFile(run.repo, t.head_sha, file);
            if (text == null) continue;
            const r = fileFindings(file, text, ctx);
            added.push(...r.findings.map((f) => ({ ...f, outside_range: true })));
          }
        }
      }
    }
    if (cmds.sizes) {
      const res = exec('sizes');
      if (!res.ok) results.sizes = failed(res);
      else {
        const sizes = parseSizes(res.output);
        let raised = 0;
        const unknown = new Set();
        for (const f of [...t.findings, ...added]) {
          const rows = f.table ? sizes.get(f.table.toLowerCase()) : undefined;
          // No estimate for a table a lock rule fired on: its size is not known, which is not "small".
          if (LOCK_RULES.includes(f.rule) && f.table && (rows === undefined || rows < 0)) unknown.add(f.table);
          if (!LOCK_RULES.includes(f.rule) || rows === undefined || rows < run.big_table_rows || severityOf(f) === 'blocker') continue;
          f.raised = { from: severityOf(f), rows };
          f.severity = 'blocker';
          raised += 1;
        }
        results.sizes = sizes.size ? { ok: true, tables: sizes.size, raised, unknown: [...unknown].sort() } : { ok: false, reason: 'the output had no "table<TAB>rows" line' };
      }
    }
    if (cmds.plan) {
      // A plan runs the repository's code. Only on the tree the change is, and never by checking it out here.
      const wt = GH.worktree(run.repo);
      if (wt.dirty) results.plan = { ok: false, skipped: true, reason: 'the working tree has uncommitted changes, so a plan would not describe this change' };
      else if (wt.head !== t.head_sha) results.plan = { ok: false, skipped: true, reason: `the working tree is at ${short(wt.head)} and the change is at ${short(t.head_sha)}: a plan would describe something else` };
      else {
        const res = exec('plan');
        const plan = parsePlan(res.output);
        const exitOk = res.ok || (plan.tool === 'terraform' && res.exit === 2) || (plan.tool === 'cdk' && res.exit === 1);
        if (res.timeout || !exitOk) results.plan = failed(res);
        else if (!plan.tool) results.plan = { ok: false, reason: `the output is neither a cdk diff nor a terraform plan: read ${join(dir, 'live-plan.txt')} yourself` };
        else {
          results.plan = { ok: true, tool: plan.tool, counts: plan.counts };
          added.push(...planFindings(plan));
        }
      }
    }
    added.forEach((f, i) => (f.id = `l${i + 1}`));
    t.findings.push(...added);
    t.live.results = results;
    t.live.skipped = false;
    outTargets.push({ id: t.id, env: where, results, added: added.filter((f) => severityOf(f) !== 'note').sort(bySeverity).map(lineView), raised: t.findings.filter((f) => f.raised).map(lineView), output_dir: dir });
  }
  S.saveRun(run);
  return { ok: true, run_id: run.run_id, targets: outTargets, next: 'read the bucketed files, then call record with your findings' };
}

// ---------------------------------------------------------------- record
// An agent finding: { bucket, severity, file, line, quote, problem, step?: { phase, text } }
function checkAgentFinding(f, headText) {
  if (!f || typeof f !== 'object') return 'not an object';
  if (!BUCKETS.includes(f.bucket)) return `bucket must be one of ${BUCKETS.join(', ')}`;
  if (!SEVERITIES.includes(f.severity)) return `severity must be one of ${SEVERITIES.join(', ')}`;
  if (typeof f.problem !== 'string' || f.problem.trim().length < 10) return 'problem is missing or too short to mean anything';
  if (f.step !== undefined && (!f.step || !PHASES.includes(f.step.phase) || typeof f.step.text !== 'string' || !f.step.text.trim())) return `step needs a phase (${PHASES.join(', ')}) and a text`;
  const cite = checkCitation(f, headText);
  return cite.ok ? null : cite.why;
}

export async function record(input) {
  const run = S.loadRun(input.run || input.run_id);
  const cases = [];
  const mode = run.jev === 'degraded' ? 'off' : run.jev;
  const outTargets = [];
  for (const t of run.targets) {
    if (t.posted) throw new Error(`this run already posted to #${t.number}; start a new run to check it again`);
    if (!t.bucketed) {
      t.review = { at: new Date().toISOString(), verdict: 'nothing_to_check', counts: { blocker: 0, risk: 0, note: 0 }, unchecked: [], findings: [], dropped: [], runbook: { lines: [] } };
      outTargets.push({ id: t.id, title: t.title, verdict: 'nothing_to_check', summary: 'no migration or infrastructure change' });
      continue;
    }
    const headText = (file) => {
      const p = resolve(t.head_dir, file);
      if (p.startsWith(t.head_dir + sep) && existsSync(p)) return readFileSync(p, 'utf8');
      return GH.showFile(run.repo, t.head_sha, file);
    };
    const proposed = ((input.targets || []).find((x) => x && x.id === t.id)?.findings || []).slice(0, MAX_AGENT_FINDINGS);
    const agent = [];
    const dropped = [];
    proposed.forEach((f, i) => {
      const why = checkAgentFinding(f, headText);
      if (why) dropped.push({ index: i, file: f?.file ?? null, line: f?.line ?? null, why });
      else agent.push({ source: 'agent', id: `a${i + 1}`, bucket: f.bucket, severity: f.severity, file: f.file, line: f.line, quote: String(f.quote).slice(0, 300), problem: f.problem.trim().slice(0, 300), ...(f.step ? { step: { phase: f.step.phase, text: plain(f.step.text, 200) } } : {}) });
    });
    // Rule and live findings stay exactly as they are: the agent can only add.
    let all = [...t.findings.filter((f) => f.source !== 'jev'), ...agent];
    const unchecked = uncheckedOf(t);
    let manual = false;
    const jev = {};

    if (mode !== 'off' && run.jev !== 'degraded') {
      const built = Q.build(t, all);
      const res = await ask(built);
      if (res.degraded) run.jev = 'degraded';
      else {
        const p = (id) => res.answers[id]?.noul;
        const base = `${run.slug || basename(run.repo)}@${short(t.head_sha)}/${t.id}`;
        const extra = [];
        const more = (rule, c) => extra.push({ source: 'jev', id: `j${extra.length + 1}`, bucket: c.bucket, rule, file: c.file, line: c.line, normalized: c.text });
        built.changes.forEach((c, n) => {
          const d = p(`destroys__${n}`);
          if (kase(cases, mode, 'destroys_data', `${base}/${c.key}`, d, c.text) && d >= Q.thr('destroys_data') && c.already !== 'blocker') more('jev_destroys_data', c);
          const [question, id, rule] = c.kind === 'statement' ? ['breaks_running_code', `breaks__${n}`, 'jev_breaks_running_code'] : ['infra_change_is_disruptive', `disruptive__${n}`, 'jev_infra_disruptive'];
          const v = p(id);
          if (kase(cases, mode, question, `${base}/${c.key}`, v, c.text) && v >= Q.thr(question) && c.already === 'note') more(rule, c);
        });
        const m = p('needs_manual_step');
        if (kase(cases, mode, 'needs_manual_step', base, m, t.title) && m >= Q.thr('needs_manual_step')) manual = true;
        all = [...all, ...extra];
        // The headline question last: it can only turn `safe` into `caution`.
        const s = p('safe_to_push');
        jev.safe_to_push = typeof s === 'number' ? s : null;
        if (kase(cases, mode, 'safe_to_push', base, s, t.title) && s < Q.thr('safe_to_push') && verdict({ findings: all, unchecked }).verdict === 'safe') {
          all.push({ source: 'jev', id: `j${extra.length + 1}`, bucket: 'migration', rule: 'jev_not_safe', file: null, line: null, normalized: 'the release as a whole' });
        }
      }
    }

    const v = verdict({ findings: all, unchecked });
    const runbook = buildRunbook(t, all, { manual });
    all.sort(bySeverity);
    t.review = { at: new Date().toISOString(), verdict: v.verdict, counts: v.counts, unchecked, findings: all, dropped, runbook: { lines: runbook.lines, dropped: runbook.dropped }, jev };
    const fired = {};
    for (const f of all) if (RULES[f.rule]) fired[f.rule] = (fired[f.rule] || 0) + 1;
    S.appendLog({ type: 'check', run: run.run_id, target: `${run.slug || basename(run.repo)}/${t.id}`, env: t.env, verdict: v.verdict, counts: v.counts, unchecked: unchecked.length, rules: fired, agent: agent.length, dropped: dropped.length, live: Object.fromEntries(Object.entries(t.live.results).map(([k, r]) => [k, Boolean(r.ok)])), jev: run.jev });
    const shown = (sev) => all.filter((f) => severityOf(f) === sev).map(chatLine);
    outTargets.push({
      id: t.id, title: t.title, url: t.url || null, env: t.env, head_sha: short(t.head_sha),
      verdict: v.verdict, counts: v.counts, summary: countsText(v.counts),
      blockers: shown('blocker'), risks: shown('risk'), notes: shown('note').slice(0, 10), notes_total: v.counts.note,
      unchecked, runbook: runbook.lines, dropped,
      infra_from: t.buckets.infra.length ? (t.live.results.plan?.ok ? 'the diff and a plan' : 'the diff only: pattern matches, not what the provider will do') : null,
      would_post: refusal(run, t, null) === null,
    });
  }
  if (cases.length) C.writeCases(S.jevLog(), cases, redactBody);
  S.saveRun(run);
  return { run_id: run.run_id, jev: run.jev, citations: 'checked to exist at the head of the change; the reading of each is the agent\'s', targets: outTargets };
}

// ---------------------------------------------------------------- post
function plan(a) {
  const run = S.loadRun(a.run);
  const t = run.targets.find((x) => x.id === a.target || (x.kind === 'pr' && String(x.number) === String(a.target).replace('#', '')));
  if (!t) throw new Error(`target ${a.target} is not in run ${run.run_id}`);
  const liveView = t.kind === 'pr' && !refusal(run, t, null) ? GH.prView(run.repo, t.number) : null;
  let refused = refusal(run, t, liveView);
  let body = null;
  let lines = 0;
  if (!refused) {
    const built = buildComment(run, t);
    lines = built.lines;
    try {
      // A comment that cannot be redacted is not sent.
      body = redactBody({ body: built.body }).body;
    } catch (e) {
      refused = `the comment could not be redacted (${e.message.split('\n')[0]}): nothing is posted`;
    }
  }
  return { run, t, refused, body, lines };
}

export function postPlan(a) {
  const { run, t, refused, body, lines } = plan(a);
  return { target: t.id, pr: t.number ?? null, allowed: !refused, ...(refused ? { refused } : {}), confirm_before_send: run.post !== 'auto', body, lines };
}

export function post(a) {
  const { run, t, refused, body } = plan(a);
  if (refused) return { ok: false, target: t.id, refused };
  // `post: ask` is a question to the user. The harness cannot hear the answer, but it can refuse a call that does not claim one.
  if (run.post !== 'auto' && a.confirmed !== true) return { ok: false, target: t.id, refused: 'posting needs the user\'s yes in this conversation: show the comment, ask, then call post with --confirmed' };
  const res = GH.postComment(run.repo, run.slug, t.number, body);
  t.posted = { comment_id: res.id, url: res.html_url, at: new Date().toISOString() };
  S.saveRun(run);
  S.appendLog({ type: 'post', run: run.run_id, target: `${run.slug}/${t.id}` });
  return { ok: true, target: t.id, pr: t.number, url: res.html_url };
}

// ---------------------------------------------------------------- outcome, stats
export function outcome(a) {
  const run = S.loadRun(a.run);
  const t = run.targets.find((x) => x.id === a.target || (x.kind === 'pr' && String(x.number) === String(a.target).replace('#', '')));
  if (!t?.review) throw new Error(`target ${a.target} has no recorded verdict in run ${run.run_id}`);
  if (!['right', 'wrong'].includes(a.result)) throw new Error('result must be right or wrong');
  if (a.actual !== undefined && a.actual !== true && !VERDICTS.includes(a.actual)) throw new Error(`the real verdict must be one of ${VERDICTS.join(', ')}`);
  const was = t.review.verdict;
  const actual = a.result === 'right' ? was : typeof a.actual === 'string' ? a.actual : null;
  // Was it in fact safe to push with the normal deploy? A wrong `safe` was not; a wrong `blocked` needs the real verdict to say.
  const calm = (v) => v === 'safe' || v === 'unverified' || v === 'nothing_to_check';
  const label = actual ? calm(actual) : calm(was) ? false : null;
  let labelled = null;
  if (label !== null && typeof t.review.jev?.safe_to_push === 'number') {
    const id = `${run.slug || basename(run.repo)}@${short(t.head_sha)}/${t.id}`;
    labelled = C.writeLabel(S.jevLog(), { skill: Q.SKILL, question: 'safe_to_push', case: id, label, source: 'outcome', p: t.review.jev.safe_to_push, unsafe: Q.SHAPE.safe_to_push.unsafe });
  }
  S.appendLog({ type: 'outcome', run: run.run_id, target: `${run.slug || basename(run.repo)}/${t.id}`, verdict: was, result: a.result, actual });
  return { run_id: run.run_id, target: t.id, verdict: was, result: a.result, actual, labelled: labelled !== null, ...(label === null ? { note: 'pass the real verdict (--actual) so this run can be used as a label' } : {}) };
}

export function stats() {
  const log = S.readLog();
  const checks = log.filter((e) => e.type === 'check');
  // The last outcome per target is the one that counts.
  const last = new Map(log.filter((e) => e.type === 'outcome').map((e) => [`${e.run}/${e.target}`, e]));
  const by = Object.fromEntries(VERDICTS.map((v) => [v, { checks: checks.filter((e) => e.verdict === v).length, right: 0, wrong: 0 }]));
  for (const e of last.values()) if (by[e.verdict]) by[e.verdict][e.result] += 1;
  const rules = {};
  for (const e of checks) for (const [r, n] of Object.entries(e.rules || {})) rules[r] = (rules[r] || 0) + n;
  return {
    checks: checks.length, posts: log.filter((e) => e.type === 'post').length, verdicts: by,
    rules: Object.fromEntries(Object.entries(rules).sort((a, b) => b[1] - a[1])),
    unchecked_runs: checks.filter((e) => e.unchecked).length,
  };
}

// ---------------------------------------------------------------- main
const cmds = {
  probe: () => probe(resolve(json().repo || process.cwd())),
  start: () => start(json()),
  live: () => live(json()),
  record: () => record(json()),
  'post-plan': (a) => postPlan(a),
  post: (a) => post(a),
  outcome: (a) => outcome(a),
  stats: () => stats(),
};
export const COMMANDS = Object.keys(cmds);
export { RULE_NAMES, SEVERITIES, VERDICTS, BUCKETS, LIVE_KINDS };

// Real paths on both sides: import.meta.url is percent-encoded and has symlinks
// resolved, process.argv[1] is neither, so a string comparison fails for an
// install path with a space or a symlink in it.
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
