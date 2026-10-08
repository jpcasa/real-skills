#!/usr/bin/env node
// /wtf harness. The model investigates and writes; this script decides what
// counts. Prints exactly ONE JSON object per call.
//
//   start         < {repo, args: [...]}             input shapes, register, opens a run
//   spend         --run <id> --kind tracker|runtime|repro
//   cite          < {run, evidence: [...]}          checks each file:line citation
//   skew          < {run, ref | pr, environment}    is the fix merged, and where is it live
//   repro-plan    < {run, env, steps: [{action, expected}]}   refuses production; writes the tester prompt
//   repro-record  --run <id>   (stdin: the tester's final message)
//   verdict       < {run, proposed: [...], ...}     accepts the verdict or downgrades it
//   outcome       --run <id> --result right|wrong [--actual VERDICT]
//   stats
//
// `verdict` never trusts what it can check: it re-verifies citations,
// recomputes deploy skew, and reads the reproduction from run state.
// Jev (optional) is consulted on derived, scrubbed facts only and, until its
// questions are calibrated, is logged without deciding anything.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ask as jevAsk } from './lib/jev.mjs';
import { checkCitations, ROLES } from './lib/cite.mjs';
import { skew } from './lib/skew.mjs';
import { decide, COUNTER_FLAGS, VERDICTS } from './lib/rules.mjs';
import { detect, loadConfig } from './lib/config.mjs';
import * as S from './lib/state.mjs';
import * as Q from './lib/questions.mjs';

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
const stdin = () => {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};
const json = () => JSON.parse(stdin() || '{}');
const jevMode = (config) => {
  const m = process.env.WTF_JEV || config.jev || 'shadow';
  return m === 'live' ? 'live' : m === 'off' || m === '0' ? 'off' : 'shadow';
};

export const CAPS = { note: 200, quote: 300, line: 300 };

// ---------------------------------------------------------------- start
export function start(input) {
  const repo = input.repo;
  if (!repo) throw new Error('start needs {repo}');
  const { config, found } = loadConfig(repo);
  const d = detect(input.args || [], config, repo);
  const out = {
    ...d, config_found: found,
    has: {
      tracker: config.tracker?.type || 'none',
      inbox: config.inbox?.type || null,
      runtime: Object.keys(config.runtime || {}),
      environments: (config.environments || []).map((e) => e.name),
      can_reproduce: Boolean(config.production_hosts?.length && config.environments?.length),
      heuristics: config.heuristics || null,
    },
    jev: jevMode(config),
  };
  if (d.mode !== 'triage' && d.mode !== 'latest') return out;
  const run = S.newRun({ repo, register: d.register, sources: d.sources });
  S.saveRun(run);
  return { run_id: run.run_id, ...out, budgets: run.budgets };
}

// ---------------------------------------------------------------- reproduction
// Hostname only, lower-cased, no trailing dot: a port or a fully-qualified
// "host." must not make a production host look like something else.
const norm = (h) => String(h || '').trim().toLowerCase().replace(/\.+$/, '');
const hostOf = (url) => {
  try {
    return norm(new URL(url).hostname) || null;
  } catch {
    return null;
  }
};
// production_hosts entries may be written as bare hosts or as URLs, with or without a port.
const prodHost = (entry) => hostOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? entry : `https://${entry}`);

// Why reproduction may not run on this environment, or null.
export function reproRefusal(config, envName) {
  const listed = config.production_hosts || [];
  const prod = listed.map(prodHost);
  if (prod.some((h) => !h)) return `production_hosts has an entry that is not a host: ${JSON.stringify(listed[prod.findIndex((h) => !h)])}`;
  if (!prod.length) return 'production_hosts is empty in .claude/wtf.json: without it no URL can be shown to be non-production';
  const env = (config.environments || []).find((e) => e.name === envName);
  if (!env) return `no environment named ${envName} in .claude/wtf.json`;
  if (!['local', 'preview', 'staging'].includes(env.kind)) return `environment ${envName} has kind ${env.kind}; reproduction runs only on local, preview or staging`;
  const host = hostOf(env.base_url);
  if (!host) return `environment ${envName} has no valid base_url`;
  if (prod.some((p) => host === p || host.endsWith(`.${p}`))) return `${host} is a production host: reproduction never runs on production`;
  return null;
}

export function reproPlan(input) {
  const run = S.loadRun(input.run);
  const { config } = loadConfig(run.repo);
  const refusal = reproRefusal(config, input.env);
  if (refusal) return { ok: false, refused: refusal };
  const steps = (input.steps || []).filter((s) => s && s.action && s.expected);
  if (!steps.length) return { ok: false, refused: 'no steps: each needs {action, expected}' };
  const budget = S.spend(run, 'repro');
  if (!budget.ok) return { ok: false, refused: 'reproduction budget spent (1 per run)' };
  const env = config.environments.find((e) => e.name === input.env);
  const shots = join(S.runDir(run.run_id), 'repro');
  mkdirSync(shots, { recursive: true });
  let sha = '';
  try {
    sha = execFileSync('git', ['-C', run.repo, 'rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {}
  const prompt = [
    'You are the qa-tester reproducing a reported bug for /wtf. Follow the plan exactly as written: the steps are what the reporter did, and each "expected" is what the reporter expected to see.',
    `Worktree (read-only; do not edit): ${run.repo}`,
    `Environment: ${env.name} (${env.kind}) at ${env.base_url}`,
    `Never production. Production hosts: ${config.production_hosts.join(', ')}. If the browser is on one of them, stop with verdict "blocked".`,
    `Merged SHA: ${sha || 'unknown'}`,
    `Screenshot directory: ${shots}`,
    'The session may or may not be signed in. Never type credentials; if sign-in is needed, stop with verdict "blocked".',
    '',
    '## Plan',
    ...steps.map((s, n) => `${n + 1}. ${s.action}\n   Expected: ${s.expected}`),
    '',
    '## Report (required)',
    'Your final message is exactly one fenced ```json block and nothing else:',
    '{"role":"qa-tester","item":"wtf","loop":1,"verdict":"pass|fail|blocked","summary":"<one line>","findings":[],"files_touched":[],"commits":[],"qa":{"env":"' + env.name + '","steps":[{"action":"…","expected":"…","actual":"…","result":"pass|fail|skipped","screenshot":"<path or empty>"}]}}',
    'A step is "fail" when what you saw differs from its "expected". Record what you actually saw, in plain words, in "actual".',
  ].join('\n');
  const file = join(S.runDir(run.run_id), 'repro-prompt.md');
  writeFileSync(file, prompt);
  run.repro = { env: env.name, planned: steps.length, result: null };
  S.saveRun(run);
  return { ok: true, subagent_type: 'real-skills:qa-tester', prompt_file: file, base_url: env.base_url, screenshots: shots, record: `repro-record --run ${run.run_id}` };
}

function lastJsonBlock(text) {
  const openers = [...text.matchAll(/```json[ \t]*\r?\n/g)].map((m) => m.index + m[0].length);
  for (let o = openers.length - 1; o >= 0; o--) {
    const body = text.slice(openers[o]);
    for (const m of body.matchAll(/```/g)) {
      try {
        return JSON.parse(body.slice(0, m.index));
      } catch {}
    }
  }
  return null;
}

export function reproRecord(runId, text) {
  const run = S.loadRun(runId);
  if (!run.repro) throw new Error('no reproduction was planned for this run');
  const report = lastJsonBlock(text);
  if (!report) return { ok: false, error: 'no fenced ```json block in the tester message' };
  const steps = Array.isArray(report.qa?.steps) ? report.qa.steps : [];
  const failed = steps.filter((s) => s.result === 'fail');
  // The plan's "expected" is what the reporter expected. A failed step means
  // the product did not do it: the report reproduced.
  const result = report.verdict === 'blocked' || !steps.length ? 'blocked' : failed.length ? 'reproduced' : 'not_reproduced';
  run.repro = {
    ...run.repro, result, failed_steps: failed.length, steps: steps.length,
    observed: failed.map((s) => ({ action: s.action, expected: s.expected, actual: s.actual, screenshot: s.screenshot || null })),
    summary: report.summary || '',
  };
  S.saveRun(run);
  return { ok: true, result, failed_steps: failed.length, steps: steps.length, observed: run.repro.observed };
}

// ---------------------------------------------------------------- verdict
export async function runVerdict(input, { ask = jevAsk } = {}) {
  const run = S.loadRun(input.run);
  const { config } = loadConfig(run.repo);
  const environment = input.report?.environment || 'production';

  // Recompute everything code can check; ignore what the input asserts.
  const evidence = checkCitations(run.repo, (input.evidence || []).map(({ verified, problem, ...e }) => e));
  const fix = input.fix && (input.fix.ref || input.fix.pr != null)
    ? skew({ repo: run.repo, ref: input.fix.ref, pr: input.fix.pr, release: config.release, environment })
    : null;
  const repro = run.repro?.result ? run.repro : null;

  // Jev: derived facts only. Until calibrated it is logged and decides nothing;
  // once calibrated and live it can only veto.
  const mode = jevMode(config);
  let jev = null;
  let jevUsed = mode;
  const extra = {};
  const hints = {};
  if (mode !== 'off') {
    const built = Q.build({ symptom: input.symptom, expected: input.expected, actual: input.actual, prior: input.prior });
    if (built.state.symptom) {
      const res = await ask({ state: built.state, questions: built.questions });
      if (res.degraded) {
        jevUsed = 'degraded';
        jev = { error: res.error || 'degraded' };
      } else {
        const p = (id) => (typeof res.answers[id]?.noul === 'number' ? res.answers[id].noul : null);
        const same = built.prior.map((pr, n) => ({ id: pr.id || null, p: p(`same_issue__${n}`) }));
        jev = { ask_not_breakage: p('ask_not_breakage'), screen_was_enough: p('screen_was_enough'), same_issue: same };
        if (mode === 'live') {
          const claimed = same.filter((s, n) => built.prior[n].same_issue === true && s.p !== null);
          if (Q.calibrated('same_issue_as_prior') && claimed.length && claimed.every((s) => s.p < Q.THRESHOLDS.same_issue_as_prior)) {
            extra.KNOWN = ['Jev does not read the prior ticket as the same issue'];
          }
          if (Q.calibrated('ask_not_breakage') && jev.ask_not_breakage !== null && jev.ask_not_breakage < Q.THRESHOLDS.ask_not_breakage) {
            extra.FEATURE_REQUEST = ['Jev reads the report as breakage, not a request'];
          }
          if (Q.calibrated('screen_was_enough') && jev.screen_was_enough !== null && jev.screen_was_enough < Q.THRESHOLDS.screen_was_enough) {
            hints.consider_split = 'the screen may not have told the user enough: consider USER_ERROR + DEFECT (messaging)';
          }
        }
      }
    }
  }

  const d = decide({
    proposed: input.proposed, prior: input.prior, fix, evidence, flags: input.flags,
    premise_exists: input.premise_exists, searched: input.searched, steps: input.steps,
    missing_fact: input.missing_fact, who: input.who, message_absent: input.message_absent,
    runtime: input.runtime, repro, repro_followed_correct_steps: input.repro_followed_correct_steps,
    extra_vetoes: extra,
  });
  const verified = evidence.filter((e) => e.verified).length;
  S.appendLog({
    type: 'verdict', run: run.run_id, register: run.register, proposed: d.proposed, verdicts: d.verdicts.map((v) => v.verdict),
    accepted: d.accepted, confidence: d.confidence, evidence: { total: evidence.length, verified },
    prior: (input.prior || []).length, flags: input.flags || [], runtime: (input.runtime || []).length,
    repro: repro?.result || null, fix: fix ? { merged: fix.merged, in_env: fix.in_env } : null, jev_mode: jevUsed, jev,
  });
  return {
    run_id: run.run_id, register: run.register, ...d, ...hints,
    evidence: evidence.map((e) => ({ path: e.path, line: e.line, role: e.role, verified: e.verified, ...(e.problem ? { problem: e.problem } : {}) })),
    fix, repro: repro ? { result: repro.result, failed_steps: repro.failed_steps } : null,
    jev_mode: jevUsed, jev,
    outcome_hint: `/real-skills:wtf outcome ${run.run_id} right|wrong`,
  };
}

// ---------------------------------------------------------------- outcome, stats
export function outcome({ run, result, actual = null }) {
  S.loadRun(run);
  if (!['right', 'wrong'].includes(result)) throw new Error('outcome needs --result right|wrong');
  if (actual && !VERDICTS.includes(actual)) throw new Error(`--actual must be one of ${VERDICTS.join(', ')}`);
  S.appendLog({ type: 'outcome', run, result, actual });
  return { ok: true, run, result, actual };
}

export function stats() {
  const last = {};
  for (const e of S.readLog()) {
    last[e.run] ??= {};
    last[e.run][e.type] = e;
  }
  const by = {};
  let rated = 0;
  let unrated = 0;
  for (const r of Object.values(last)) {
    if (!r.verdict) continue;
    if (!r.outcome) {
      unrated += 1;
      continue;
    }
    rated += 1;
    const k = r.verdict.verdicts.join('+');
    by[k] ??= { n: 0, right: 0, wrong: 0, became: {} };
    by[k].n += 1;
    by[k][r.outcome.result] += 1;
    if (r.outcome.result === 'wrong' && r.outcome.actual) by[k].became[r.outcome.actual] = (by[k].became[r.outcome.actual] || 0) + 1;
  }
  for (const v of Object.values(by)) v.accuracy = Number((v.right / v.n).toFixed(2));
  const right = Object.values(by).reduce((n, v) => n + v.right, 0);
  return { rated, unrated, accuracy: rated ? Number((right / rated).toFixed(2)) : null, by_verdict: by };
}

// ---------------------------------------------------------------- cli
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const repoOf = (input) => input.repo || S.loadRun(input.run).repo;

const cmds = {
  start: () => start(json()),
  spend: (a) => {
    const run = S.loadRun(a.run);
    const r = S.spend(run, a.kind);
    S.saveRun(run);
    return r;
  },
  cite: () => {
    const input = json();
    const evidence = checkCitations(repoOf(input), input.evidence || []);
    // Investigator reports stay short (references/report-style.md): re-ask once on `over`.
    const over = [];
    evidence.forEach((e, n) => {
      if (String(e.note || '').length > CAPS.note) over.push({ field: `evidence[${n}].note`, len: e.note.length, cap: CAPS.note });
      if (String(e.quote || '').length > CAPS.quote) over.push({ field: `evidence[${n}].quote`, len: e.quote.length, cap: CAPS.quote });
    });
    for (const k of ['expected', 'actual', 'trigger', 'blast_radius']) {
      if (String(input[k] || '').length > CAPS.line) over.push({ field: k, len: input[k].length, cap: CAPS.line });
    }
    return { verified: evidence.filter((e) => e.verified).length, unverified: evidence.filter((e) => !e.verified).length, evidence, over };
  },
  skew: () => {
    const input = json();
    const repo = repoOf(input);
    return skew({ repo, ref: input.ref, pr: input.pr, release: loadConfig(repo).config.release, environment: input.environment || 'production' });
  },
  'repro-plan': () => reproPlan(json()),
  'repro-record': (a) => reproRecord(a.run, stdin()),
  verdict: () => runVerdict(json()),
  outcome: (a) => outcome({ run: a.run, result: a.result, actual: a.actual === true ? null : a.actual }),
  stats: () => stats(),
};
export const COMMANDS = Object.keys(cmds);
export { COUNTER_FLAGS, ROLES, VERDICTS };

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
