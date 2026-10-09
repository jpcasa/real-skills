#!/usr/bin/env node
// /calibrate. Reads the cases and labels every skill in this plugin logs,
// measures each Jev question against the bar (lib/bar.mjs), and records which
// questions may decide on this machine. Prints exactly ONE JSON object.
//
//   status      [--skill <s>]                       every question: counts, proposal, status
//   label-next  [--skill <s>] [--question <q>] [--limit N]   unlabeled cases to show a person
//   label       < {labels: [{skill, question, case, answer: yes|no|cant_tell}]}
//   apply       < {questions: ["<skill>/<question>", ...]}   only what is `ready`, recomputed here
//   revoke      --question <skill>/<question>
//
// No network. Nothing here reads another skill's code: a case record carries
// its own threshold, direction and unsafe side.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './lib/calibration.mjs';
import { evaluate } from './lib/bar.mjs';
import { CATALOG } from './lib/catalog.mjs';

export const LABEL_BATCH = 12;
const root = () => process.env.REAL_SKILLS_STATE_DIR || join(homedir(), '.claude/state');
// Where each skill logs. The per-skill variables are the ones the skills honour.
export const sources = () => ({
  'do-shit': process.env.DO_SHIT_STATE_DIR || join(root(), 'do-shit'),
  changelog: process.env.CHANGELOG_STATE_DIR || join(root(), 'changelog'),
  'quick-ask-me': process.env.QUICK_ASK_ME_STATE_DIR || join(root(), 'quick-ask-me'),
  'ask-and-create-specs': process.env.ASK_SPECS_STATE_DIR || join(root(), 'ask-and-create-specs'),
  wtf: process.env.WTF_STATE_DIR || join(root(), 'wtf'),
  'review-prs': process.env.REVIEW_PRS_STATE_DIR || join(root(), 'review-prs'),
  'qa-this': process.env.QA_THIS_STATE_DIR || join(root(), 'qa-this'),
  'check-infra-and-migrations': process.env.CHECK_INFRA_STATE_DIR || join(root(), 'check-infra-and-migrations'),
  promote: process.env.PROMOTE_STATE_DIR || join(root(), 'promote'),
  'improve-design': process.env.IMPROVE_DESIGN_STATE_DIR || join(root(), 'improve-design'),
});
const labelsFile = () => join(C.dir(), 'labels.jsonl');

// Every .jsonl in a skill's state folder and one level below it (do-shit keeps
// one events.jsonl per run).
function logFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isFile() && name.endsWith('.jsonl')) out.push(p);
    else if (st.isDirectory()) {
      for (const inner of readdirSync(p).sort()) if (inner.endsWith('.jsonl')) out.push(join(p, inner));
    }
  }
  return out;
}

const id = (r) => `${r.skill}/${r.question}`;
const caseKey = (r) => `${id(r)}\u0000${r.case}`;

// -> Map "<skill>/<question>" -> [case, ...] with `label` merged in. The last
// record for a case wins; a person's label wins over a derived one.
export function gather() {
  const cases = new Map();
  const labels = new Map();
  const take = (r) => {
    if (!r || r.v !== 1 || !r.skill || !r.question || !r.case) return;
    // Delete first: a Map keeps the first position of a key, and the newest
    // record of a question must come last (bar.mjs reads its threshold there).
    if (r.type === 'case' && typeof r.p === 'number') {
      cases.delete(caseKey(r));
      cases.set(caseKey(r), r);
    } else if (r.type === 'label' && typeof r.label === 'boolean') labels.set(caseKey(r), r);
  };
  for (const dir of Object.values(sources())) for (const f of logFiles(dir)) C.readJsonl(f).forEach(take);
  C.readJsonl(labelsFile()).forEach(take);
  const byQuestion = new Map();
  for (const [k, c] of cases) {
    const l = labels.get(k);
    const row = l ? { ...c, label: l.label, label_source: l.source } : c;
    if (!byQuestion.has(id(c))) byQuestion.set(id(c), []);
    byQuestion.get(id(c)).push(row);
  }
  return byQuestion;
}

// A question that is deciding and has a labeled case on the unsafe side of its
// own threshold loses its entry. `label` does this as labels arrive; this
// catches labels written by the skills themselves.
function audit(byQuestion) {
  const revoked = [];
  for (const [qid, rows] of byQuestion) {
    const [skill, question] = [qid.slice(0, qid.indexOf('/')), qid.slice(qid.indexOf('/') + 1)];
    const e = C.entry(skill, question);
    if (!e) continue;
    const bad = rows.find((c) => typeof c.label === 'boolean' && C.isUnsafe(c.p, e.threshold, c.label, c.unsafe));
    if (bad && C.revoke(skill, question, `case ${bad.case}: p=${bad.p} at threshold ${e.threshold}, right answer was ${bad.label}`)) revoked.push(qid);
  }
  return revoked;
}

// How a deciding question is doing at its own threshold, on every labeled case
// so far. A question with no unsafe side is never switched off automatically
// (its mistakes cost an extra ask, not a skipped one): this number is how a
// person sees it has stopped being right.
function holding(rows, t) {
  const labeled = rows.filter((c) => typeof c.label === 'boolean');
  if (!labeled.length) return {};
  const ok = labeled.filter((c) => C.says(c.p, t) === c.label).length;
  return { accuracy_now: Math.round((ok / labeled.length) * 100) / 100, labeled_now: labeled.length };
}

export function status({ skill = null } = {}) {
  const byQuestion = gather();
  const revoked = audit(byQuestion);
  // A known question with nothing logged yet is still a row: "not enough data".
  for (const qid of CATALOG) if (!byQuestion.has(qid)) byQuestion.set(qid, []);
  const questions = [];
  for (const [qid, rows] of [...byQuestion].sort(([a], [b]) => a.localeCompare(b))) {
    const s = qid.slice(0, qid.indexOf('/'));
    if (skill && s !== skill) continue;
    const q = qid.slice(qid.indexOf('/') + 1);
    const e = C.entry(s, q);
    questions.push({ id: qid, skill: s, question: q, deciding: e ? { threshold: e.threshold, applied: e.applied, n: e.n, ...holding(rows, e.threshold) } : null, ...evaluate(rows) });
  }
  const count = (st) => questions.filter((q) => q.status === st).length;
  return {
    questions, revoked,
    totals: { questions: questions.length, deciding: questions.filter((q) => q.deciding).length, ready: count('ready'), not_enough_data: count('not enough data'), no_safe_threshold: count('no safe threshold'), never_acts: count('never acts') },
    calibration_file: join(C.dir(), 'calibration.json'),
    ...(questions.some((q) => q.cases) ? {} : { note: 'no cases logged yet: the skills write them as they are used with a TypeSafe key set' }),
  };
}

// Unlabeled cases a person can judge, the most informative first: spot checks,
// then the ones nearest the threshold. The score is left out on purpose, so
// the label is not anchored on it.
export function labelNext({ skill = null, question = null, limit = LABEL_BATCH } = {}) {
  const n = Math.min(LABEL_BATCH, Math.max(1, Number(limit) || LABEL_BATCH));
  const open = [];
  let unshowable = 0;
  for (const [qid, rows] of gather()) {
    for (const c of rows) {
      if (typeof c.label === 'boolean') continue;
      if (skill && c.skill !== skill) continue;
      if (question && c.question !== question) continue;
      if (!c.show) {
        unshowable++;
        continue;
      }
      open.push({ c, qid, d: Math.abs(c.p - c.threshold) });
    }
  }
  open.sort((a, b) => Number(Boolean(b.c.spot)) - Number(Boolean(a.c.spot)) || a.d - b.d || a.qid.localeCompare(b.qid));
  return {
    cases: open.slice(0, n).map(({ c }) => ({ skill: c.skill, question: c.question, case: c.case, ask: c.ask || c.question, show: c.show, ...(c.spot ? { spot: true } : {}) })),
    remaining: Math.max(0, open.length - n),
    unshowable,
  };
}

export function label({ labels = [] } = {}) {
  const byQuestion = gather();
  const out = { written: 0, skipped: 0, rejected: [], revoked: [] };
  for (const l of labels) {
    const answer = String(l?.answer || '').toLowerCase();
    const row = (byQuestion.get(`${l?.skill}/${l?.question}`) || []).find((c) => c.case === l.case);
    if (!row) {
      out.rejected.push({ ...l, why: 'no such logged case' });
      continue;
    }
    if (!['yes', 'no'].includes(answer)) {
      out.skipped++;
      continue;
    }
    const r = C.writeLabel(labelsFile(), { skill: row.skill, question: row.question, case: row.case, label: answer === 'yes', source: 'human', p: row.p, unsafe: row.unsafe });
    out.written++;
    if (r.revoked) out.revoked.push(`${row.skill}/${row.question}`);
  }
  return out;
}

// Never trusts a proposal handed to it: the bar is recomputed from the logs.
export function apply({ questions = [] } = {}) {
  const byQuestion = gather();
  const out = { applied: [], refused: [] };
  for (const qid of questions) {
    const rows = byQuestion.get(qid);
    const res = rows ? evaluate(rows) : { status: 'no cases logged' };
    if (res.status !== 'ready') {
      out.refused.push({ id: qid, status: res.status, ...(res.need ? { need: res.need } : {}) });
      continue;
    }
    const [skill, question] = [qid.slice(0, qid.indexOf('/')), qid.slice(qid.indexOf('/') + 1)];
    const labeled = rows.filter((c) => typeof c.label === 'boolean');
    const sha = createHash('sha1').update(labeled.map((c) => `${c.case}:${c.p}:${c.label}`).sort().join('\n')).digest('hex').slice(0, 12);
    const value = {
      threshold: res.proposed.threshold, n: res.labeled, split: res.split, unsafe: res.unsafe,
      ...(res.bound !== undefined ? { bound: res.bound } : {}), labels_sha: sha, applied: new Date().toISOString().slice(0, 10),
    };
    C.setEntry(skill, question, value);
    out.applied.push({ id: qid, ...value });
  }
  // A revoke written by a skill while this ran may have been overwritten: check again.
  const revoked = audit(gather());
  if (revoked.length) out.revoked = revoked;
  return out;
}

export function revoke({ question }) {
  const qid = String(question || '');
  if (!qid.includes('/')) throw new Error('revoke needs --question <skill>/<question>');
  const ok = C.revoke(qid.slice(0, qid.indexOf('/')), qid.slice(qid.indexOf('/') + 1), 'revoked by hand');
  return { revoked: ok, id: qid, ...(ok ? {} : { note: 'it was not deciding' }) };
}

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
const stdinJson = () => {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch (e) {
    throw new Error(`stdin is not JSON: ${e.message}`);
  }
};
const opt = (v) => (v === true || v === undefined ? null : v);

const cmds = {
  status: (a) => status({ skill: opt(a.skill) }),
  'label-next': (a) => labelNext({ skill: opt(a.skill), question: opt(a.question), limit: opt(a.limit) ?? LABEL_BATCH }),
  label: () => label(stdinJson()),
  apply: () => apply(stdinJson()),
  revoke: (a) => revoke({ question: opt(a.question) }),
};
export const COMMANDS = Object.keys(cmds);

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
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  if (!cmds[a._]) {
    out({ error: `unknown command ${a._}`, commands: COMMANDS });
    process.exit(2);
  }
  try {
    out(cmds[a._](a));
  } catch (e) {
    out({ error: e.message });
    process.exit(1);
  }
}
