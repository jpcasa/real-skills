#!/usr/bin/env node
// /review-prs harness. Reviewers read and propose; this script decides what
// counts. Prints exactly ONE JSON object per call.
//
//   start        < {repo, args: [...]}                 which PRs, lenses, prompt files, the workflow args
//   refute-plan  < {run, results: [...]}               refuter prompts, when no workflow runs them
//   record       < {run, results: [...], refutations}  checks, drops, verdict per PR
//   post-plan    --run <id> --pr <n>                   the exact review that would be posted
//   post         --run <id> --pr <n>                   posts it (one COMMENT review)
//   outcome      --run <id>                            which posted findings the author acted on
//   stats
//
// `record` never trusts what it can check: every citation, the refuter's
// included, is checked against the PR-head files this script wrote itself.
// `post` rebuilds its payload from run state. Jev (optional) sees titles,
// bodies, paths and one-line problems and, until its questions are
// calibrated, is logged without deciding anything.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { ask as realAsk, redactBody } from './lib/jev.mjs';
import { parsePatch, isIgnored, chunk } from './lib/diff.mjs';
import { pickLenses, DEFAULT_PATH_RULES, LENSES } from './lib/lenses.mjs';
import { checkCitation, applyRules, verdict, overCaps, isSecurity, SEVERITIES, VERDICTS, DROP_RULES, WINDOW } from './lib/rules.mjs';
import { chatLine, buildPayload, refusal, dropText, ciText, EVENT } from './lib/post.mjs';
import { lensPrompt, refuterBrief, refuterPrompt } from './lib/prompts.mjs';
import { validate } from './lib/validate.mjs';
import { loadConfig, jevMode } from './lib/config.mjs';
import { SKILL_DIR } from './lib/paths.mjs';
import * as GH from './lib/github.mjs';
import * as S from './lib/state.mjs';
import * as Q from './lib/questions.mjs';
import * as C from './lib/calibration.mjs';

export const MAX_PRS = 10;
const MAX_FILE_BYTES = 1024 * 1024;
const WORKFLOW = join(SKILL_DIR, 'workflows/review.js');

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

// Installed as a plugin, the reviewer agent is namespaced `<plugin>:reviewer`.
function reviewerType() {
  const manifest = join(SKILL_DIR, '../../.claude-plugin/plugin.json');
  return existsSync(manifest) ? `${JSON.parse(readFileSync(manifest, 'utf8')).name}:reviewer` : 'reviewer';
}

// Jev, stubbable (REVIEW_PRS_JEV_STUB: { "<id or prefix*>": number, "__degraded": true }).
async function ask(built) {
  const stubFile = process.env.REVIEW_PRS_JEV_STUB;
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
function parseRefs(args, slug) {
  const refs = [];
  const forced = [];
  let refute = true;
  for (let i = 0; i < args.length; i++) {
    const t = String(args[i]);
    if (t === '--lens') forced.push(String(args[++i] ?? ''));
    else if (t === '--no-refute') refute = false;
    else if (/^#?\d+$/.test(t)) refs.push(Number(t.replace('#', '')));
    else {
      const m = t.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
      if (!m) throw new Error(`not a PR number or URL: ${t}`);
      if (m[1].toLowerCase() !== slug.toLowerCase()) throw new Error(`${t} is in ${m[1]}, not ${slug}: run it from a clone of that repository`);
      refs.push(Number(m[2]));
    }
  }
  return { refs: [...new Set(refs)], forced, refute };
}

function ticketOf(pr, pattern) {
  if (!pattern) return null;
  try {
    return `${pr.title}\n${pr.branch}\n${pr.body}`.match(new RegExp(pattern, 'i'))?.[0] || null;
  } catch {
    return null;
  }
}

export async function start(input) {
  const repo = resolve(input.repo || process.cwd());
  const config = loadConfig(repo);
  const slug = GH.repoSlug(repo);
  const { refs, forced, refute } = parseRefs(input.args || [], slug);
  pickLenses({ forced }); // an unknown --lens fails before anything is fetched
  if (!refs.length) {
    const candidates = GH.listRequested(repo);
    return { candidates, next: candidates.length ? 'show this list, confirm which to review, then call start again with those numbers' : 'no open pull request is waiting on your review; pass PR numbers or URLs' };
  }
  if (refs.length > MAX_PRS) throw new Error(`${refs.length} pull requests asked for; at most ${MAX_PRS} per run`);

  const mode = jevMode(config);
  const run = { run_id: S.newRunId(), created_at: new Date().toISOString(), repo, slug, refute, jev: mode, standards: config.standards, max_nits: config.max_nits, prs: [], skipped: [], agents: [], refuters: [] };
  const type = reviewerType();
  const cases = [];
  for (const n of refs) {
    const pr = GH.prView(repo, n);
    const skip = (why) => run.skipped.push({ number: n, title: pr.title, why });
    if (pr.state !== 'OPEN') {
      skip(`it is ${pr.state.toLowerCase()}`);
      continue;
    }
    if (pr.draft) {
      skip('it is a draft');
      continue;
    }
    let patch;
    try {
      GH.fetchPr(repo, slug, n, pr.base);
      patch = GH.prDiff(repo, pr);
    } catch (e) {
      skip(`its commits could not be fetched (${String(e.stderr || e.message).trim().split('\n').pop()})`);
      continue;
    }
    const all = parsePatch(patch);
    const dir = S.prDir(run.run_id, n);
    const head = join(dir, 'head');
    mkdirSync(head, { recursive: true });
    writeFileSync(join(dir, 'diff.patch'), patch);
    const files = [];
    const unread = [];
    for (const f of all) {
      if (f.deleted || f.binary || isIgnored(f.file, config.ignore)) continue;
      const dest = resolve(head, f.file);
      const text = dest.startsWith(head + sep) ? GH.showFile(repo, pr.head_sha, f.file) : null;
      if (text == null || Buffer.byteLength(text) > MAX_FILE_BYTES) {
        unread.push(f.file);
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, text);
      files.push({ file: f.file, added: f.added, removed: f.removed, lines: [...f.lines] });
    }
    if (!files.length) {
      skip('nothing reviewable: only ignored, deleted, binary or unreadable files');
      continue;
    }
    const paths = files.map((f) => f.file);
    const picked = pickLenses({ files: paths, pathRules: [...DEFAULT_PATH_RULES, ...config.path_rules], forced });
    pr.ticket = ticketOf(pr, config.ticket_pattern);

    // Jev may add a lens the path rules missed. It can only add.
    if (mode !== 'off') {
      const built = Q.buildLens(pr, paths, picked.lenses);
      if (built.ask.length) {
        const res = await ask(built);
        if (res.degraded) run.jev = 'degraded';
        else {
          for (const l of built.ask) {
            const p = res.answers[`needs_lens__${l}`]?.noul;
            if (kase(cases, mode, 'needs_lens', `${slug}#${n}@${pr.head_sha.slice(0, 7)}/${l}`, p, `${l} lens for PR #${n}: ${pr.title}`) && p >= Q.thr('needs_lens')) {
              picked.reasons[l] = `Jev: the description or paths point to ${l}`;
            }
          }
        }
      }
    }
    const lenses = LENSES.filter((l) => picked.reasons[l]);
    const { chunks, not_reviewed } = chunk(files);
    const agents = [];
    for (const lens of lenses) {
      const parts = lens === 'correctness' && chunks.length > 1 ? chunks : [paths];
      parts.forEach((scope, i) => {
        const key = parts.length > 1 ? `${lens}.${i + 1}` : lens;
        agents.push({ pr: n, lens, key, name: `reviewer-${n}-${key}`, agent_type: type, files: scope });
      });
    }
    const entry = {
      ...pr, files, lenses, reasons: picked.reasons, not_reviewed: [...not_reviewed, ...unread],
      existing: GH.prComments(repo, slug, n), agents: agents.map((a) => a.key), review: null,
    };
    run.prs.push(entry);
    for (const a of agents) {
      const prompt_file = lensPrompt(run, entry, a);
      run.agents.push({ pr: a.pr, lens: a.lens, key: a.key, name: a.name, agent_type: a.agent_type, prompt_file });
    }
    if (refute) run.refuters.push({ pr: n, name: `refuter-${n}`, agent_type: type, prompt_file: refuterBrief(run, entry) });
  }
  if (cases.length) C.writeCases(S.jevLog(), cases, redactBody);
  S.saveRun(run);
  const estimate = run.agents.length + run.refuters.length;
  return {
    run_id: run.run_id,
    prs: run.prs.map((p) => ({
      number: p.number, title: p.title, url: p.url, author: p.author, head_sha: p.head_sha, ci: ciText(p.ci), ticket: p.ticket,
      files: p.files.length, changed_lines: p.files.reduce((s, f) => s + f.added + f.removed, 0), lenses: p.lenses, reasons: p.reasons, not_reviewed: p.not_reviewed,
    })),
    skipped: run.skipped,
    agents: run.agents, refuters: run.refuters, refute, estimate, jev: run.jev,
    workflow: run.agents.length ? { script_path: WORKFLOW, args: { run_id: run.run_id, agents: run.agents, refuters: run.refuters } } : null,
  };
}

// ---------------------------------------------------------------- findings in
// Ids are `<agent key>#<index>`: the workflow script numbers bugs the same way.
const withIds = (key, lens, findings) => findings.map((f, i) => ({ ...f, id: `${key}#${i}`, lens }));
const parseReport = (report) => {
  if (typeof report !== 'string') return report;
  const m = report.match(/```json[ \t]*\r?\n([\s\S]*?)```\s*$/);
  try {
    return JSON.parse(m ? m[1] : report);
  } catch {
    return undefined;
  }
};

// -> { findings, partial: [reason] } for one PR, from whatever came back.
function collect(pr, results) {
  const findings = [];
  const partial = [];
  for (const key of pr.agents) {
    const lens = key.split('.')[0];
    const res = results.find((r) => Number(r.pr) === pr.number && r.key === key);
    const report = res ? parseReport(res.report) : null;
    if (!report) {
      partial.push(`${key} returned no report`);
      continue;
    }
    const v = validate('findings', report);
    if (!v.ok) {
      partial.push(`${key} returned an invalid report (${v.errors.slice(0, 3).join('; ')})`);
      continue;
    }
    findings.push(...withIds(key, lens, report.findings));
    const unread = report.not_reviewed || [];
    if (unread.length) partial.push(`${key} did not read ${unread.length} file${unread.length === 1 ? '' : 's'}: ${unread.slice(0, 3).join(', ')}${unread.length > 3 ? ', …' : ''}`);
  }
  return { findings, partial };
}

export function refutePlan(input) {
  const run = S.loadRun(input.run || input.run_id);
  const refuters = [];
  for (const pr of run.prs) {
    if (!run.refute) break;
    const bugs = collect(pr, input.results || []).findings.filter((f) => f.severity === 'bug').map(({ id, lens, file, line, quote, problem }) => ({ id, lens, file, line, quote, problem }));
    if (!bugs.length) continue;
    const r = run.refuters.find((x) => x.pr === pr.number);
    refuters.push({ pr: pr.number, name: r.name, agent_type: r.agent_type, prompt_file: refuterPrompt(run, pr, bugs), bugs: bugs.length });
  }
  return { run_id: run.run_id, refuters, next: refuters.length ? 'run each refuter, then call record with results and refutations' : 'no bug-level findings: call record with the results' };
}

// ---------------------------------------------------------------- record
export async function record(input) {
  const run = S.loadRun(input.run || input.run_id);
  const results = input.results || [];
  const cases = [];
  const mode = run.jev === 'degraded' ? 'off' : run.jev;
  const outPrs = [];
  for (const pr of run.prs) {
    if (pr.review?.posted) throw new Error(`this run already posted to #${pr.number}; start a new run to review it again`);
    const dir = S.prDir(run.run_id, pr.number);
    const files = pr.files.map((f) => ({ ...f, lines: new Set(f.lines) }));
    // The head files this script wrote at start, not anything a reviewer says.
    const headText = (file) => {
      const p = resolve(dir, 'head', file);
      return p.startsWith(join(dir, 'head') + sep) && existsSync(p) ? readFileSync(p, 'utf8') : null;
    };
    const got = collect(pr, results);
    const partial = [...pr.not_reviewed.map((f) => `${f} was not reviewed`), ...got.partial];
    const checked = got.findings.map((f) => checkCitation(f, { files, headText }));

    // The refuter may point at any file of the repository at the PR head.
    const anyFile = (file) => headText(file) ?? GH.showFile(run.repo, pr.head_sha, file);
    const refReport = parseReport((input.refutations || []).find((r) => Number(r.pr) === pr.number)?.report);
    let refutations = [];
    const expectsRefuter = run.refute && checked.some((f) => f.verified && f.severity === 'bug');
    if (refReport && validate('refutations', refReport).ok) {
      refutations = refReport.refutations.map((r) => ({
        ...r,
        cite: r.file ? checkCitation({ file: r.file, line: r.line, quote: r.quote }, { files: [{ file: r.file, lines: new Set() }], headText: anyFile }) : null,
      }));
    } else if (expectsRefuter) partial.push(refReport ? 'the refuter returned an invalid report: bugs are unrefuted' : 'the refuter did not run: bugs are unrefuted');

    let ruled = applyRules({ findings: checked, refutations, existing: pr.existing, maxNits: run.max_nits });
    let scope_note = null;

    // Jev over what the rules kept. Calibrated and live it may hide a nit or
    // question, merge two findings that make one point, or add a scope note.
    // It never touches a bug, a risk or a security finding.
    if (mode !== 'off' && run.jev !== 'degraded') {
      const all = [...ruled.kept, ...ruled.outside_diff];
      const built = Q.buildFindings(pr, pr.files.map((f) => f.file), all);
      const res = await ask(built);
      if (res.degraded) run.jev = 'degraded';
      else {
        const p = (id) => res.answers[id]?.noul;
        const base = `${run.run_id}/${pr.number}`;
        const hide = new Set();
        for (const f of built.minor) {
          const v = p(`actionable__${all.indexOf(f)}`);
          f.jev_actionable = v;
          if (kase(cases, mode, 'finding_is_actionable', `${base}/${f.id}`, v, `${f.file}: ${f.problem}`) && v < Q.thr('finding_is_actionable') && !isSecurity(f)) hide.add(f.id);
        }
        built.pairs.forEach(([a, b], n) => {
          const v = p(`same__${n}`);
          if (kase(cases, mode, 'same_finding', `${base}/${a.id}+${b.id}`, v, `${a.problem} | ${b.problem}`) && v >= Q.thr('same_finding') && !hide.has(a.id) && !hide.has(b.id) && !a.merged_into && !b.merged_into && b.severity !== 'bug' && !isSecurity(b)) {
            a.also = [...(a.also || []), { lens: b.lens, severity: b.severity, line: b.line, problem: b.problem, fix: b.fix }, ...(b.also || [])];
            a.lenses = [...new Set([...(a.lenses || [a.lens]), ...(b.lenses || [b.lens])])];
            b.merged_into = a.id;
          }
        });
        const scope = p('outside_stated_scope');
        if (kase(cases, mode, 'outside_stated_scope', `${run.slug}#${pr.number}@${pr.head_sha.slice(0, 7)}`, scope, `PR #${pr.number}: ${pr.title}`) && scope >= Q.thr('outside_stated_scope')) {
          scope_note = 'The changed files go beyond what the title and description say.';
        }
        const keep = (f) => {
          if (f.merged_into) {
            ruled.merged += 1;
            return false;
          }
          if (hide.has(f.id)) {
            ruled.dropped.not_actionable += 1;
            ruled.dropped_items.push({ id: f.id, rule: 'not_actionable', why: 'Jev: the author would not act on it', file: f.file, line: f.line });
            return false;
          }
          return true;
        };
        const kept = ruled.kept.filter(keep);
        const outside_diff = ruled.outside_diff.filter(keep);
        ruled = { ...ruled, kept, outside_diff };
      }
    }

    // A head that moved while the reviewers read it: say so, `post` will refuse.
    let live = null;
    try {
      live = GH.prView(run.repo, pr.number);
    } catch {}
    if (live && live.head_sha !== pr.head_sha) partial.push(`the PR moved to ${live.head_sha.slice(0, 7)} during the review`);

    const v = verdict({ kept: ruled.kept, outside_diff: ruled.outside_diff, partial });
    const over = overCaps(got.findings);
    pr.review = { at: new Date().toISOString(), verdict: v, kept: ruled.kept, outside_diff: ruled.outside_diff, dropped: ruled.dropped, dropped_items: ruled.dropped_items, merged: ruled.merged, scope_note, posted: null };
    S.appendLog({
      type: 'review', run: run.run_id, pr: `${run.slug}#${pr.number}`, lenses: pr.lenses, verdict: v.verdict, partial: v.partial, counts: v.counts,
      proposed: got.findings.length, dropped: ruled.dropped, merged: ruled.merged, refuter_ran: Boolean(refReport), jev: run.jev,
    });
    outPrs.push({
      number: pr.number, title: pr.title, url: pr.url, head_sha: pr.head_sha.slice(0, 7),
      verdict: v.verdict, partial: v.partial, partial_reasons: v.partial_reasons, counts: v.counts, ci: ciText(pr.ci), scope_note,
      lines: ruled.kept.map(chatLine), outside_diff: ruled.outside_diff.map(chatLine),
      proposed: got.findings.length, dropped: ruled.dropped, not_shown: dropText(ruled.dropped), merged: ruled.merged, over_caps: over.length,
      would_post: { inline_comments: ruled.kept.length, in_body: ruled.outside_diff.length },
    });
  }
  if (cases.length) C.writeCases(S.jevLog(), cases, redactBody);
  S.saveRun(run);
  return { run_id: run.run_id, jev: run.jev, citations: 'checked to exist at the PR head; the reading of each is the reviewer\'s', prs: outPrs, skipped: run.skipped };
}

// ---------------------------------------------------------------- post
function plan(a) {
  const run = S.loadRun(a.run);
  const pr = run.prs.find((p) => p.number === Number(a.pr));
  if (!pr) throw new Error(`PR #${a.pr} is not in run ${run.run_id}`);
  const live = GH.prView(run.repo, pr.number);
  const refused = refusal(pr, pr.review, live);
  return { run, pr, refused, payload: refused ? null : buildPayload(pr, pr.review) };
}

export function postPlan(a) {
  const { pr, refused, payload } = plan(a);
  return { pr: pr.number, allowed: !refused, ...(refused ? { refused } : {}), event: EVENT, payload };
}

export function post(a) {
  const { run, pr, refused, payload } = plan(a);
  if (refused) return { ok: false, pr: pr.number, refused };
  const res = GH.postReview(run.repo, run.slug, pr.number, payload);
  pr.review.posted = { review_id: res.id, url: res.html_url, at: new Date().toISOString(), inline: payload.comments.length };
  S.saveRun(run);
  S.appendLog({ type: 'post', run: run.run_id, pr: `${run.slug}#${pr.number}`, inline: payload.comments.length });
  return { ok: true, pr: pr.number, event: EVENT, review_id: res.id, url: res.html_url, inline_comments: payload.comments.length };
}

// ---------------------------------------------------------------- outcome, stats
// A posted finding was acted on when a later commit changed a line within a
// few lines of it. "Not acted on" is only final once the PR is closed.
export function outcome(a) {
  const run = S.loadRun(a.run);
  const prs = [];
  for (const pr of run.prs) {
    if (!pr.review?.posted) continue;
    const live = GH.prView(run.repo, pr.number);
    const final = live.state !== 'OPEN';
    if (live.head_sha !== pr.head_sha) {
      try {
        GH.fetchPr(run.repo, run.slug, pr.number, pr.base);
      } catch {}
    }
    const rows = pr.review.kept.map((f) => {
      const ranges = live.head_sha === pr.head_sha ? [] : GH.changedOldLines(run.repo, pr.head_sha, live.head_sha, f.file);
      const addressed = ranges === null ? null : ranges.some(([lo, hi]) => f.line >= lo - WINDOW && f.line <= hi + WINDOW);
      const label = addressed === true ? true : addressed === false && final ? false : null;
      if (label !== null && typeof f.jev_actionable === 'number') {
        C.writeLabel(S.jevLog(), { skill: Q.SKILL, question: 'finding_is_actionable', case: `${run.run_id}/${pr.number}/${f.id}`, label, source: 'outcome', p: f.jev_actionable, unsafe: Q.SHAPE.finding_is_actionable.unsafe });
      }
      return { lens: f.lens, severity: isSecurity(f) ? 'security' : f.severity, addressed, final: label !== null };
    });
    S.appendLog({ type: 'outcome', run: run.run_id, pr: `${run.slug}#${pr.number}`, state: live.state, findings: rows });
    prs.push({ number: pr.number, state: live.state, posted: rows.length, addressed: rows.filter((r) => r.addressed === true).length, open: rows.filter((r) => !r.final).length });
  }
  return { run_id: run.run_id, prs, next: prs.some((p) => p.open) ? 'some findings are still open: run outcome again after the PR merges or closes' : null };
}

export function stats() {
  const log = S.readLog();
  const reviews = log.filter((e) => e.type === 'review');
  // The last outcome per PR is the one that counts.
  const last = new Map(log.filter((e) => e.type === 'outcome').map((e) => [`${e.run}/${e.pr}`, e]));
  const by = {};
  for (const e of last.values()) {
    for (const f of e.findings) {
      const k = `${f.lens}/${f.severity}`;
      by[k] ??= { lens: f.lens, severity: f.severity, posted: 0, addressed: 0, open: 0 };
      by[k].posted += 1;
      if (f.addressed === true) by[k].addressed += 1;
      else if (!f.final) by[k].open += 1;
    }
  }
  const rows = Object.values(by).map((r) => ({ ...r, rate: r.posted - r.open ? Number((r.addressed / (r.posted - r.open)).toFixed(2)) : null }));
  const sum = (k) => reviews.reduce((s, e) => s + (e.dropped?.[k] || 0), 0);
  return {
    reviews: reviews.length, posts: log.filter((e) => e.type === 'post').length,
    verdicts: Object.fromEntries(VERDICTS.map((v) => [v, reviews.filter((e) => e.verdict === v).length])),
    proposed: reviews.reduce((s, e) => s + (e.proposed || 0), 0),
    dropped: Object.fromEntries(DROP_RULES.map((r) => [r, sum(r)])),
    addressed: rows,
  };
}

// ---------------------------------------------------------------- main
const cmds = {
  start: () => start(json()),
  'refute-plan': () => refutePlan(json()),
  record: () => record(json()),
  'post-plan': (a) => postPlan(a),
  post: (a) => post(a),
  outcome: (a) => outcome(a),
  stats: () => stats(),
};
export const COMMANDS = Object.keys(cmds);
export { LENSES, SEVERITIES, VERDICTS, DROP_RULES };

if (import.meta.url === `file://${process.argv[1]}`) {
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
