#!/usr/bin/env node
// Per-PR facts for /changelog: ticket, flags and area. Code rules decide what
// code can decide; Jev (optional) judges the rest. Prints ONE JSON object.
//
//   node judge.mjs < input.json
//   input:  { pr | prs: [{number, title, body, branch, labels[], files[], closing_issues[]}],
//             tracker: {type, id_pattern}, areas: [], jev: "shadow" | "live" | "off" }
//   output: { mode, results: [{number, ticket, ticket_source, candidates, flags, area, jev, error?}] }
//
// Modes: shadow (default) asks Jev and logs the answers, code rules decide;
// live lets calibrated Jev answers fill what code left open; degraded means
// no key or an API failure, code rules decide. Jev never overrides a code
// result and can never return a ticket that is not in the PR.
// Sent to Jev, after redaction: PR title, body, branch, labels and file paths.
// Never file contents.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ask as jevAsk } from './lib/jev.mjs';
import { pathFlags, resolveTicket } from './lib/rules.mjs';

export const THRESHOLDS = {
  id_is_this_prs_own_ticket: 0.7,
  changes_live_behaviour_without_opt_in: 0.5,
  area_confidence: 0.6,
};
// No eval fixtures yet: logged, never deciding. CHANGELOG_TEST_CALIBRATED is for tests.
export const UNCALIBRATED = new Set(['id_is_this_prs_own_ticket', 'changes_live_behaviour_without_opt_in', 'area']);
const calibrated = (id) => !UNCALIBRATED.has(id) || (process.env.CHANGELOG_TEST_CALIBRATED || '').split(',').includes(id);

const noul = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });

export function buildQuestions(pr, code, areas) {
  const questions = {
    changes_live_behaviour_without_opt_in: noul(
      'Does the change described by `pr` alter what the running product does for existing users as soon as it ships, without anyone turning it on?',
      'Existing behaviour changes on release: a default flips, a rule tightens or loosens, a flow is removed or reordered, or a flag ships enabled.',
      'The change is behind an opt-in or a disabled flag, is additive, is internal (refactor, tests, docs, tooling), or only fixes a bug back to the intended behaviour.',
    ),
  };
  if (!code.ticket) {
    code.candidates.forEach((id, i) => {
      questions[`own_ticket__${i}`] = noul(
        `\`pr.body\` and \`pr.branch\` mention the ticket ID "${id}". Is "${id}" the ticket this pull request itself implements or fixes?`,
        'The PR presents this ID as its own ticket: the work it delivers.',
        'The ID is cited as related, superseded, blocked-by, follow-up or background work, or appears in quoted text.',
      );
    });
  }
  if (areas.length >= 2) {
    questions.area = {
      type: 'choice',
      instructions: 'Which product area does the change described by `pr` mainly belong to? Judge from the title, body, labels and file paths.',
      criteria: Object.fromEntries(areas.map((a) => [a, `The change is mainly about ${a}.`])),
    };
  }
  return questions;
}

// deps.ask is injectable for tests.
export async function judgeOne(pr, { tracker = {}, areas = [], mode = 'shadow', ask = jevAsk } = {}) {
  const code = resolveTicket(pr, tracker);
  const flags = { ...pathFlags(pr.files), default_on_change: null };
  const out = {
    number: pr.number, ticket: code.ticket, ticket_source: code.source, candidates: code.candidates,
    flags, area: null, mode, jev: null, ...(code.error ? { error: code.error } : {}),
  };
  if (mode === 'off') return out;

  const questions = buildQuestions(pr, code, areas);
  const state = { pr: { title: pr.title, body: String(pr.body || '').slice(0, 4000), branch: pr.branch, labels: pr.labels || [], files: (pr.files || []).slice(0, 200) } };
  const res = await ask({ state, questions });
  if (res.degraded) return { ...out, mode: 'degraded', jev: { error: res.error || 'degraded' } };

  const a = res.answers;
  const own = code.candidates.map((id, i) => ({ id, p: a[`own_ticket__${i}`]?.noul ?? null })).filter((c) => c.p !== null);
  out.jev = {
    default_on_change: a.changes_live_behaviour_without_opt_in?.noul ?? null,
    own_ticket: own,
    area: a.area ? { choice: a.area.choice, confidence: a.area.confidence } : null,
  };
  if (mode !== 'live') return out;

  if (calibrated('changes_live_behaviour_without_opt_in') && out.jev.default_on_change !== null) {
    flags.default_on_change = out.jev.default_on_change >= THRESHOLDS.changes_live_behaviour_without_opt_in;
  }
  if (!out.ticket && calibrated('id_is_this_prs_own_ticket') && own.length) {
    const best = own.reduce((m, c) => (c.p > m.p ? c : m));
    // `best.id` comes from code.candidates: an ID outside the PR cannot get here.
    if (best.p >= THRESHOLDS.id_is_this_prs_own_ticket) {
      out.ticket = best.id;
      out.ticket_source = 'jev';
    }
  }
  if (calibrated('area') && out.jev.area && areas.includes(out.jev.area.choice) && out.jev.area.confidence >= THRESHOLDS.area_confidence) {
    out.area = out.jev.area.choice;
  }
  return out;
}

export async function judge(input, deps = {}) {
  const prs = input.prs || (input.pr ? [input.pr] : []);
  const mode = ['shadow', 'live', 'off'].includes(input.jev) ? input.jev : 'shadow';
  const results = [];
  for (const pr of prs) results.push(await judgeOne(pr, { tracker: input.tracker, areas: input.areas || [], mode, ...deps }));
  const modes = new Set(results.map((r) => r.mode));
  return { mode: modes.has('degraded') ? 'degraded' : mode, results };
}

function logAnswers(res) {
  // Calibration data: what Jev said next to what code decided.
  try {
    const dir = process.env.CHANGELOG_STATE_DIR || join(homedir(), '.claude/state/changelog');
    mkdirSync(dir, { recursive: true });
    for (const r of res.results) {
      if (r.jev && !r.jev.error) appendFileSync(join(dir, 'jev.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), mode: r.mode, number: r.number, ticket: r.ticket, ticket_source: r.ticket_source, jev: r.jev })}\n`);
    }
  } catch {}
}

if (import.meta.url === `file://${process.argv[1]}`) {
  Promise.resolve()
    .then(async () => {
      const res = await judge(JSON.parse(readFileSync(0, 'utf8') || '{}'));
      logAnswers(res);
      process.stdout.write(`${JSON.stringify(res)}\n`);
    })
    .catch((e) => {
      process.stdout.write(`${JSON.stringify({ error: e.message })}\n`);
      process.exit(1);
    });
}
