#!/usr/bin/env node
// /wtf-and-create-ticket harness. /wtf decides what a report is; this script
// decides whether that verdict earns a ticket and what the ticket says.
// Prints exactly ONE JSON object per call.
//
//   start   < {repo}                       config, tracker, what is missing
//   draft   < {repo, run, title, symptom, expected, actual, evidence, fix,
//              plan | plan_path [+ spec_path], prior, not_checked, outage}
//                                          gate on /wtf's own log, re-checks citations, writes the body
//   record  < {run, id, url}               one ticket per /wtf run
//
// It never creates the ticket. The agent does, with the tracker's tool, from
// what `draft` returns. It reads /wtf's log and citation checker rather than
// trusting what the agent says the verdict was.

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCitations } from '../../wtf/scripts/lib/cite.mjs';
import { readLog as wtfLog } from '../../wtf/scripts/lib/state.mjs';
import { scrub } from '../../wtf/scripts/lib/scrub.mjs';

export const TRACKERS = ['github', 'clickup', 'linear', 'other'];
const DESTINATION_KEY = { clickup: 'list_id', linear: 'team' };
export const MAX_PLAN_LINES = 15;
// Run ids are /wtf's; anything else (a path, "..") is not a run.
const RUN = /^wtf-\d{8}-\d{4}-[0-9a-f]{4}$/;

const stateRoot = () => process.env.WTF_TICKET_STATE_DIR || join(homedir(), '.claude/state/wtf-and-create-ticket');
const LOG = () => join(stateRoot(), 'log.jsonl');
const tickets = () =>
  existsSync(LOG()) ? readFileSync(LOG(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const ticketFor = (run) => tickets().find((t) => t.run === run) || null;
const checkRun = (run) => {
  if (!RUN.test(String(run))) throw new Error(`unknown /wtf run ${run}`);
};

// ---------------------------------------------------------------- config
export function loadConfig(repo) {
  const read = (name) => {
    const p = join(repo, '.claude', name);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  };
  return { config: read('wtf-and-create-ticket.json'), wtfTracker: read('wtf.json')?.tracker?.type || null };
}

export function problems(config, wtfTracker) {
  if (!config) return ['no .claude/wtf-and-create-ticket.json'];
  const out = [];
  const tracker = config.tracker || wtfTracker;
  if (!TRACKERS.includes(tracker)) out.push(`tracker must be one of ${TRACKERS.join(', ')} (here or in .claude/wtf.json)`);
  if (!config.project) out.push('project is missing');
  const key = DESTINATION_KEY[tracker];
  if (key && !config.destination?.[key]) out.push(`destination.${key} is missing`);
  if (config.confirm && !['auto', 'ask'].includes(config.confirm)) out.push('confirm must be auto or ask');
  return out;
}

export function start({ repo }) {
  let loaded;
  try {
    loaded = loadConfig(repo);
  } catch (e) {
    return { ok: false, needs: ['setup'], problems: [`config is not valid JSON: ${e.message}`] };
  }
  const { config, wtfTracker } = loaded;
  const p = problems(config, wtfTracker);
  return {
    ok: !p.length, needs: p.length ? ['setup'] : [], problems: p,
    tracker: config?.tracker || wtfTracker, project: config?.project ?? null, confirm: config?.confirm || 'auto',
  };
}

// ---------------------------------------------------------------- gate
const NO_TICKET = {
  KNOWN: 'an existing ticket covers it: link that one, do not open a second',
  ALREADY_FIXED: 'a fix exists and waits on a release: name the PR and the release',
  USER_ERROR: 'the product behaved as designed: send the steps instead',
  INSUFFICIENT_INFO: 'one fact is missing: ask for it, then run again',
};

export function gate(run) {
  const last = wtfLog().filter((e) => e.type === 'verdict' && e.run === run).pop();
  if (!last) return { file: false, reason: `no /wtf verdict logged for ${run}: run its verdict step first` };
  const base = { verdicts: last.verdicts, confidence: last.confidence };
  if (!last.accepted) return { ...base, file: false, reason: 'the /wtf harness did not accept the verdict' };
  // A USER_ERROR + DEFECT split is a bug in the messaging.
  if (last.verdicts.includes('DEFECT')) return { ...base, file: true, kind: 'bug' };
  if (last.verdicts.includes('FEATURE_REQUEST')) return { ...base, file: true, kind: 'feature' };
  return { ...base, file: false, reason: NO_TICKET[last.verdicts[0]] || `${last.verdicts.join(' + ')} files no ticket` };
}

// ---------------------------------------------------------------- draft
// Report-derived text: one line, no emails, phones or long numbers, no @mentions.
const line = (s, n = 300) => {
  const t = scrub(String(s ?? '').replace(/\s+/g, ' ').trim()).replace(/@(?=\w)/g, '@ ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const lines = (x) => (Array.isArray(x) ? x : String(x ?? '').split('\n')).map((s) => String(s).trimEnd()).filter((s) => s.trim());

function inRepo(repo, p) {
  if (!p) return null;
  const abs = isAbsolute(p) ? p : resolve(repo, p);
  const rel = relative(repo, abs);
  if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(abs) || !statSync(abs).isFile()) return { error: `${p} is not a file inside the repo` };
  return { abs, rel };
}

export function draft(input) {
  const { repo, run } = input;
  checkRun(run);
  const st = start({ repo });
  if (!st.ok) return { file: false, needs: ['setup'], problems: st.problems };
  const existing = ticketFor(run);
  if (existing) return { file: false, reason: 'this /wtf run already has a ticket', ticket: existing };
  const g = gate(run);
  if (!g.file) return g;

  const { config } = loadConfig(repo);
  const files = [input.spec_path, input.plan_path].map((p) => inRepo(repo, p)).filter(Boolean);
  const plan = lines(input.plan);
  const missing = [];
  if (!line(input.title)) missing.push('title');
  if (!line(input.symptom)) missing.push('symptom');
  if (g.kind === 'bug' && !lines(input.fix).length) missing.push('fix');
  if (g.kind === 'bug' && !plan.length && !input.plan_path) missing.push('plan or plan_path');
  for (const f of files) if (f.error) missing.push(f.error);
  if (!input.plan_path && plan.length > MAX_PLAN_LINES) missing.push(`plan is over ${MAX_PLAN_LINES} lines: write it as files with create-spec and create-plan, then pass plan_path`);
  if (missing.length) return { file: false, kind: g.kind, missing };

  const cited = checkCitations(repo, (input.evidence || []).map(({ verified, problem, ...e }) => e));
  const ok = cited.filter((e) => e.verified);
  const prior = (input.prior || []).filter((p) => /^https?:\/\//i.test(String(p.url || '')));
  const verdict = g.verdicts.join(' + ');
  const body = [
    `**Project:** ${config.project} · **Verdict:** ${verdict} (${g.confidence} confidence) · **Triage run:** \`${run}\``,
    '',
    '## What happened',
    line(input.symptom),
    ...(input.expected ? [`- Expected: ${line(input.expected)}`] : []),
    ...(input.actual ? [`- Actual: ${line(input.actual)}`] : []),
    ...(g.verdicts.includes('USER_ERROR') ? ['', 'The logic works as designed. The defect is what the screen tells the user.'] : []),
    '',
    '## Cause',
    ...(ok.length ? ok.map((e) => `- \`${e.path}:${e.line}\` (${e.role})${e.note ? `: ${line(e.note, 200)}` : ''}`) : ['- No verified code citation.']),
    ...(lines(input.fix).length ? ['', '## Fix', ...lines(input.fix)] : []),
    '',
    '## Plan',
    ...(input.plan_path ? files.map((f) => `- \`${f.rel}\` (attached)`) : plan.length ? plan : ['- To plan once the request is agreed.']),
    ...(prior.length ? ['', '## Related', ...prior.map((p) => `- [${line(p.title || p.id || p.url, 120)}](${p.url})`)] : []),
    ...(lines(input.not_checked).length ? ['', '## Not checked', ...lines(input.not_checked).map((s) => `- ${line(s, 200)}`)] : []),
  ].join('\n');

  const dir = join(stateRoot(), run);
  mkdirSync(dir, { recursive: true });
  const bodyFile = join(dir, 'ticket.md');
  writeFileSync(bodyFile, `${body}\n`);
  const fields = { ...(config.bug || {}), ...(g.kind === 'feature' ? config.feature || {} : {}) };
  if (input.outage) fields.priority = 'urgent';
  return {
    file: true, kind: g.kind, verdicts: g.verdicts,
    // A feature is a product call: always asked, whatever the config says.
    confirm: g.kind === 'feature' ? 'ask' : config.confirm || 'auto',
    tracker: st.tracker, destination: config.destination || {},
    fields: { title: `${input.outage ? 'Outage: ' : ''}${line(input.title, 120)}`, ...fields },
    body_file: bodyFile, attach: files.map((f) => f.abs),
    citations: { verified: ok.length, dropped: cited.length - ok.length },
  };
}

// ---------------------------------------------------------------- record
export function record({ run, id, url }) {
  checkRun(run);
  if (!id && !url) throw new Error('record needs id or url');
  const existing = ticketFor(run);
  if (existing) return { ok: false, reason: 'this /wtf run already has a ticket', ticket: existing };
  mkdirSync(stateRoot(), { recursive: true });
  const entry = { ts: new Date().toISOString(), type: 'ticket', run, id: id || null, url: url || null };
  appendFileSync(LOG(), `${JSON.stringify(entry)}\n`);
  return { ok: true, ...entry };
}

// ---------------------------------------------------------------- main
// Real paths on both sides, as in wtf.mjs: a space or a symlink in the install path.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const cmds = { start, draft, record };
  const cmd = cmds[process.argv[2]];
  try {
    if (!cmd) throw new Error(`usage: ticket.mjs ${Object.keys(cmds).join('|')} < input.json`);
    const raw = (() => {
      try {
        return readFileSync(0, 'utf8');
      } catch {
        return '';
      }
    })();
    console.log(JSON.stringify(cmd(JSON.parse(raw || '{}'))));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exitCode = 1;
  }
}
