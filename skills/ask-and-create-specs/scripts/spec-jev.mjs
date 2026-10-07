#!/usr/bin/env node
// Jev judgments for /ask-and-create-specs. Stateless: JSON in, JSON out.
//
//   triage < {goal, known[], questions[{id, question, recommended}]}   -> ask | assume | drop per question
//   gate   < {goal, done_when[], decisions[], assumed[], out_of_scope[], seam}  -> stop interviewing?
//   shape  < (same brief as gate)                                      -> single | sliced, optional sections
//   lint   <spec.md>...                                                -> line cap, structure, dead lines
//
// Code owns every decision; Jev only supplies probabilities. The client
// (redaction, retry, degrade) is do-shit's. Without it, without a key, or with
// ASK_SPECS_JEV=0, every command returns { degraded: true } plus whatever the
// deterministic checks found, and SKILL.md tells the interviewer how to judge
// by hand. Thresholds are uncalibrated defaults.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export const CAP = 40; // non-blank lines per spec file
export const MAX_LINE = 200;
const CHUNK = 60; // questions per Jev request

export const T = {
  matters: 0.35,
  user_call: 0.5,
  risky: 0.4,
  gate: 0.6,
  open_fork: 0.4,
  sliced: 0.6,
  section: 0.5,
  useful: 0.4,
  duplicate: 0.6,
  checkable: 0.5,
};

export const SECTIONS = {
  Data: [
    'Does the work in `brief` add or change persistent data: tables, columns, indexes, migrations, access policies, or stored file formats?',
    'A schema, migration, policy or stored format is added or altered.',
    'Reads and writes use existing data shapes unchanged.',
  ],
  UI: [
    'Does the work in `brief` change something a user sees or interacts with: screens, components, states, or copy?',
    'New or changed screens, components, visual states, interactions or user-facing text.',
    'No visible or interactive change.',
  ],
  Interfaces: [
    'Does the work in `brief` add or change an interface that other code or other teams call: an API endpoint, exported function or type, event, CLI, or config key?',
    'A contract others depend on is created or altered.',
    'Changes stay behind existing interfaces.',
  ],
  Rollout: [
    'Does shipping the work in `brief` need steps beyond merging: a feature flag, backfill, ordered deploy, data migration run, or coordination with another team?',
    'Release needs sequencing, a flag, a backfill, or coordination.',
    'Merge and deploy as usual.',
  ],
  Risks: [
    'Does the work in `brief` touch authentication, authorization, payments, personal data, data deletion, or anything that cannot be undone once released?',
    'Security-sensitive, money-moving, privacy-relevant or irreversible behaviour is involved.',
    'None of those areas are touched.',
  ],
};

const noul = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
const p = (answers, id) => answers?.[id]?.noul;
const list = (v) => (Array.isArray(v) ? v.filter((s) => String(s).trim()) : []);

async function loadAsk() {
  if (process.env.ASK_SPECS_JEV === '0') return null;
  try {
    return (await import('../../do-shit/scripts/lib/jev.mjs')).ask;
  } catch {
    return null;
  }
}

const OFF = async () => ({ answers: {}, degraded: true, error: 'Jev client unavailable or disabled' });

// ------------------------------------------------------------------ triage
export async function triage(input, ask = OFF) {
  const qs = input.questions || [];
  if (!qs.length) return { degraded: false, verdicts: [] };
  const state = {
    goal: input.goal || '',
    known: list(input.known),
    candidates: qs.map((q) => ({ question: q.question, recommended: q.recommended || '' })),
  };
  const questions = {};
  qs.forEach((_, i) => {
    const c = `\`candidates[${i}]\``;
    questions[`matters__${i}`] = noul(
      `Would different reasonable answers to ${c}.question lead to different code, tests, or scope when building \`goal\`?`,
      'The answer changes what gets written, what gets tested, or what is in scope.',
      'Any reasonable answer produces the same implementation, or `known` already settles it.',
    );
    questions[`user_call__${i}`] = noul(
      `Does answering ${c}.question need knowledge or preference that only the requester has, such as business rules, priorities, taste, or external constraints?`,
      'Only the requester can know or choose this; it cannot be derived from `goal`, `known`, or common engineering practice.',
      'A competent engineer could settle it from `goal`, `known`, and normal practice.',
    );
    questions[`risky__${i}`] = noul(
      `If ${c}.recommended were adopted without asking and later proved wrong, would correcting it be expensive: a data migration, a public interface change, a security, payment or deletion consequence, or large rework?`,
      'Reversing the choice later costs real work or causes harm.',
      'The choice is cheap to change after the fact.',
    );
  });
  const res = await ask({ state, questions });
  if (res.degraded) return { degraded: true, error: res.error, verdicts: [] };
  const verdicts = qs.map((q, i) => {
    const s = { matters: p(res.answers, `matters__${i}`), user_call: p(res.answers, `user_call__${i}`), risky: p(res.answers, `risky__${i}`) };
    let verdict = 'assume';
    if (s.matters < T.matters) verdict = 'drop';
    else if (s.user_call >= T.user_call || s.risky >= T.risky) verdict = 'ask';
    return { id: q.id, verdict, scores: s };
  });
  return { degraded: false, verdicts };
}

// -------------------------------------------------------------------- gate
const briefState = (b) => ({
  brief: {
    goal: b.goal || '',
    done_when: list(b.done_when),
    decisions: list(b.decisions),
    assumed: list(b.assumed),
    out_of_scope: list(b.out_of_scope),
    seam: b.seam || '',
  },
});

const GATE = {
  goal: noul(
    'Does `brief.goal` state one specific outcome that an engineer could start building without asking what is meant?',
    'One concrete outcome, with the affected thing named.',
    'Vague, several unrelated outcomes, or missing.',
  ),
  done_when: noul(
    'Can every entry in `brief.done_when` be decided pass or fail by running a command, running a test, or observing a specific behaviour?',
    'Each entry names something checkable.',
    'At least one entry is subjective ("works", "is clean", "feels fast") or the list is empty.',
  ),
  out_of_scope: noul(
    'Does `brief.out_of_scope` name at least one adjacent thing that will not be done, so the edge of the work is clear?',
    'A boundary is named.',
    'Empty, or so generic that it excludes nothing.',
  ),
  seam: noul(
    'Does `brief.seam` identify the interface the tests will exercise and where those tests live?',
    'An interface (function, endpoint, component, command) and a test location are named.',
    'Missing, or names neither an interface nor a location.',
  ),
};

const OPEN_FORK = noul(
  'Given `brief`, is there still an undecided choice between approaches that would produce noticeably different implementations?',
  'An important fork is unresolved: `brief.decisions` and `brief.assumed` do not settle it.',
  'Remaining unknowns are details an implementer can settle alone.',
);

export async function gate(input, ask = OFF) {
  const { brief } = briefState(input);
  const missing = [];
  if (!brief.goal.trim()) missing.push('goal');
  if (!brief.done_when.length) missing.push('done_when');
  if (!brief.out_of_scope.length) missing.push('out_of_scope');
  if (!brief.seam.trim()) missing.push('seam');
  if (missing.length) return { degraded: false, stop: false, missing };

  const res = await ask({ state: { brief }, questions: { ...GATE, open_fork: OPEN_FORK } });
  if (res.degraded) return { degraded: true, error: res.error, stop: false, missing: [] };
  const scores = {};
  for (const k of Object.keys(GATE)) {
    scores[k] = p(res.answers, k);
    if (!(scores[k] >= T.gate)) missing.push(k);
  }
  scores.open_fork = p(res.answers, 'open_fork');
  if (!(scores.open_fork < T.open_fork)) missing.push('open_fork');
  return { degraded: false, stop: missing.length === 0, missing, scores };
}

// ------------------------------------------------------------------- shape
export async function shape(input, ask = OFF) {
  const state = briefState(input);
  const questions = {
    separable: noul(
      'Does the work in `brief` split into two or more slices that could each be implemented, verified, and merged on its own?',
      'At least two parts each deliver a checkable result without the others being finished.',
      'One indivisible change, or parts that only work together.',
    ),
    large: noul(
      'Is the work in `brief` too large for one engineer to implement and verify in a single focused session?',
      'Many files across several areas, or several independent behaviours.',
      'A bounded change in one area.',
    ),
  };
  for (const [name, [q, yes, no]] of Object.entries(SECTIONS)) questions[`section__${name}`] = noul(q, yes, no);
  const res = await ask({ state, questions });
  if (res.degraded) return { degraded: true, error: res.error, shape: 'single', sections: [] };
  const scores = Object.fromEntries(Object.keys(questions).map((k) => [k, p(res.answers, k)]));
  return {
    degraded: false,
    shape: scores.separable >= T.sliced && scores.large >= T.sliced ? 'sliced' : 'single',
    sections: Object.keys(SECTIONS).filter((n) => scores[`section__${n}`] >= T.section),
    scores,
  };
}

// -------------------------------------------------------------------- lint
const REQUIRED = { spec: ['Done when', 'Out of scope', 'Seam'], index: ['Slices'] };

export function parseSpec(text, file = 'spec.md') {
  const kind = basename(file).toLowerCase() === 'readme.md' ? 'index' : 'spec';
  const lines = [];
  const sections = {};
  let section = null;
  let goal = '';
  text.split('\n').forEach((raw, i) => {
    const t = raw.trim();
    if (!t) return;
    const n = i + 1;
    const h = t.match(/^##\s+(.+)$/);
    if (h) {
      section = h[1].trim();
      sections[section] = 0;
      lines.push({ n, text: t, heading: true });
      return;
    }
    if (t.startsWith('# ')) return void lines.push({ n, text: t, heading: true });
    const g = t.match(/^Goal:\s*(.*)$/);
    if (g && !section) {
      goal = g[1];
      return void lines.push({ n, text: t, heading: true });
    }
    if (section) sections[section]++;
    lines.push({ n, text: t, section });
  });
  return { file, kind, goal, sections, lines };
}

export function lintStructure(spec) {
  const out = [];
  const add = (line, rule, text) => out.push({ file: spec.file, line, rule, text });
  if (spec.lines.length > CAP) add(0, 'over_cap', `${spec.lines.length} non-blank lines, cap ${CAP}. Cut, or split into slices.`);
  if (!spec.goal.trim()) add(0, 'no_goal', 'Missing `Goal: <one line>` before the first section.');
  for (const s of REQUIRED[spec.kind]) if (!(s in spec.sections)) add(0, 'missing_section', `Missing \`## ${s}\`.`);
  for (const [s, count] of Object.entries(spec.sections)) if (!count) add(0, 'empty_section', `\`## ${s}\` is empty. Fill it or delete it.`);
  for (const l of spec.lines) {
    if (l.text.length > MAX_LINE) add(l.n, 'long_line', `${l.text.length} chars, max ${MAX_LINE}. One fact per line.`);
    if (l.section === 'Done when' && !/^- \[[ x]\] /.test(l.text)) add(l.n, 'not_checkbox', 'Done-when entries are `- [ ] <check>`.');
  }
  return out;
}

async function lintJev(spec, ask) {
  const body = spec.lines.filter((l) => !l.heading && !l.text.startsWith('```'));
  if (!body.length) return { degraded: false, problems: [] };
  const state = { goal: spec.goal, lines: body.map((l) => l.text) };
  const all = [];
  body.forEach((l, i) => {
    const ref = `\`lines[${i}]\``;
    all.push([`useful__${i}`, noul(
      `Would an engineer building \`goal\` write, test, or leave out something differently because of ${ref}?`,
      'The line constrains the implementation, the tests, or the scope.',
      'Background, motivation, or something any competent engineer would do anyway.',
    )]);
    all.push([`duplicate__${i}`, noul(
      `Does ${ref} only restate what another entry of \`lines\` already says?`,
      'Another line carries the same fact; removing this one loses nothing.',
      'The line adds a fact no other line has.',
    )]);
    if (l.section === 'Done when') {
      all.push([`checkable__${i}`, noul(
        `Can ${ref} be decided pass or fail by running a command, running a test, or observing one specific behaviour?`,
        'It names something an engineer can check and get a yes or no.',
        'It is subjective or names no observable result.',
      )]);
    }
  });
  const chunks = [];
  for (let i = 0; i < all.length; i += CHUNK) chunks.push(Object.fromEntries(all.slice(i, i + CHUNK)));
  const results = await Promise.all(chunks.map((questions) => ask({ state, questions })));
  const bad = results.find((r) => r.degraded);
  if (bad) return { degraded: true, error: bad.error, problems: [] };
  const answers = Object.assign({}, ...results.map((r) => r.answers));
  const problems = [];
  body.forEach((l, i) => {
    const add = (rule, text) => problems.push({ file: spec.file, line: l.n, rule, text });
    if (p(answers, `duplicate__${i}`) >= T.duplicate) add('duplicate', 'Restates another line. Cut one.');
    // Seam is required structure; Jev underrates it as "something any engineer would do".
    else if (l.section !== 'Seam' && p(answers, `useful__${i}`) < T.useful) add('dead_line', 'Changes nothing an implementer does. Cut.');
    if (l.section === 'Done when' && p(answers, `checkable__${i}`) < T.checkable) add('not_checkable', 'Not pass/fail. Name the command, test, or observable behaviour.');
  });
  return { degraded: false, problems };
}

// files: [{ file, text }]
export async function lint(files, ask = OFF) {
  const problems = [];
  let degraded = false;
  let error;
  for (const f of files) {
    const spec = parseSpec(f.text, f.file);
    problems.push(...lintStructure(spec));
    const j = await lintJev(spec, ask);
    if (j.degraded) {
      degraded = true;
      error = j.error;
    }
    problems.push(...j.problems);
  }
  problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { degraded, ...(error ? { error } : {}), ok: problems.length === 0, problems };
}

// --------------------------------------------------------------------- cli
const out = (o) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);

async function main([cmd, ...args]) {
  const ask = (await loadAsk()) || OFF;
  if (cmd === 'lint') {
    if (!args.length) throw new Error('usage: spec-jev.mjs lint <spec.md>...');
    return out(await lint(args.map((file) => ({ file, text: readFileSync(file, 'utf8') })), ask));
  }
  const fn = { triage, gate, shape }[cmd];
  if (!fn) {
    out({ error: `unknown command ${cmd}`, commands: ['triage', 'gate', 'shape', 'lint'] });
    process.exit(2);
  }
  out(await fn(JSON.parse(readFileSync(0, 'utf8')), ask));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    out({ error: e.message });
    process.exit(1);
  });
}
