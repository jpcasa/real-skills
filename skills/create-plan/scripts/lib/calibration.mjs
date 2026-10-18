// Local calibration, shared by every skill in this plugin (identical copies,
// pinned by skills/do-shit/scripts/test/sync.test.mjs).
//
// A Jev question listed in a skill's UNCALIBRATED set decides nothing until it
// has an entry in <dir>/calibration.json, written by /calibrate after the
// question met the bar on this machine's own logged cases. This file is the
// reader, the case and label writers, and the rule that takes an entry away.
//
//   calibration.json  { v: 1, questions: { "<skill>/<question>": { threshold, n, applied, ... } } }
//   case record       { v, type: "case", skill, question, case, p, threshold,
//                       acts_when: gte|lt|both, unsafe: fp|fn|null, fallback, acted, spot, show, ts }
//   label record      { v, type: "label", skill, question, case, label, source, ts }
//
// REAL_SKILLS_CALIBRATION=off ignores the file. REAL_SKILLS_CALIBRATION_DIR moves it (tests).

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SHOW_MAX = 300;
export const SPOT_ONE_IN = 10;

export const dir = () => process.env.REAL_SKILLS_CALIBRATION_DIR || join(homedir(), '.claude/state/calibration');
const file = () => join(dir(), 'calibration.json');
const off = () => ['off', '0'].includes(String(process.env.REAL_SKILLS_CALIBRATION || '').toLowerCase());
const key = (skill, question) => `${skill}/${question}`;

// A missing, unreadable or malformed file is an empty one: nothing is calibrated.
export function load() {
  try {
    const j = JSON.parse(readFileSync(file(), 'utf8'));
    return j && typeof j.questions === 'object' && j.questions ? j : { v: 1, questions: {} };
  } catch {
    return { v: 1, questions: {} };
  }
}

function save(data) {
  mkdirSync(dir(), { recursive: true });
  // Per-process name: two writers never rename each other's temp file away.
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file());
}

export function entry(skill, question) {
  if (off()) return null;
  const e = load().questions[key(skill, question)];
  return e && typeof e.threshold === 'number' && e.threshold > 0 && e.threshold < 1 ? e : null;
}
export const isOn = (skill, question) => entry(skill, question) !== null;
export const threshold = (skill, question, builtin) => entry(skill, question)?.threshold ?? builtin;

export function setEntry(skill, question, value) {
  const data = load();
  data.questions[key(skill, question)] = value;
  save(data);
}

export function revoke(skill, question, reason) {
  const data = load();
  const had = data.questions[key(skill, question)];
  if (!had) return false;
  delete data.questions[key(skill, question)];
  save(data);
  appendFileSync(join(dir(), 'revoked.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), skill, question, reason, was: had })}\n`);
  return true;
}

// One live decision in ten is still put to a person, so labels keep arriving
// after a question starts deciding. A hash, not a dice roll: the same case
// always gets the same answer.
export const spotCheck = (caseId) => createHash('sha1').update(String(caseId)).digest().readUInt32BE(0) % SPOT_ONE_IN === 0;

export const caseId = (...parts) => createHash('sha1').update(parts.map(String).join('\u0000')).digest('hex').slice(0, 12);

// What Jev's number says at a threshold, and whether that is the unsafe error.
export const says = (p, t) => p >= t;
export const acts = (p, t, actsWhen) => (actsWhen === 'both' ? true : actsWhen === 'lt' ? p < t : p >= t);
export const isUnsafe = (p, t, label, unsafe) => (unsafe === 'fp' ? says(p, t) && label === false : unsafe === 'fn' ? !says(p, t) && label === true : false);

const append = (path, records) => {
  if (!records.length) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
};

// cases: [{skill, question, case, p, threshold, acts_when, unsafe, fallback?, acted?, spot?, show?}]
// redactBody: the skill's own redaction (lib/jev.mjs). `show` is kept only when
// it went through it; a case is worth logging without one.
export function writeCases(path, cases, redactBody = null) {
  try {
    const rows = cases.filter((c) => c && typeof c.p === 'number' && c.question && c.case);
    let shows = rows.map(() => null);
    if (redactBody) {
      try {
        const out = redactBody({ shows: rows.map((c) => String(c.show ?? '').slice(0, SHOW_MAX)) });
        if (Array.isArray(out?.shows) && out.shows.length === rows.length) shows = out.shows.map((s) => (s ? String(s).slice(0, SHOW_MAX) : null));
      } catch {}
    }
    const ts = new Date().toISOString();
    append(path, rows.map((c, i) => {
      const { show, ...rest } = c;
      return { v: 1, type: 'case', ...rest, unsafe: c.unsafe ?? null, ...(shows[i] ? { show: shows[i] } : {}), ts };
    }));
  } catch {}
}

// Records what the right answer was. When the question is deciding on this
// machine and this label shows its number on the unsafe side, the question is
// switched back off at once. -> { revoked }
// Never throws: the caller is a skill in the middle of its own work, and a
// label that could not be written must not cost it that work. A revoke that
// could not be written here is done by /calibrate's audit at its next run.
export function writeLabel(path, { skill, question, case: id, label, source, p = null, unsafe = null }) {
  if (typeof label !== 'boolean') return { revoked: false };
  let error;
  try {
    append(path, [{ v: 1, type: 'label', skill, question, case: id, label, source, ts: new Date().toISOString() }]);
  } catch (e) {
    error = e.message;
  }
  try {
    const e = entry(skill, question);
    if (e && typeof p === 'number' && isUnsafe(p, e.threshold, label, unsafe)) {
      return { revoked: revoke(skill, question, `case ${id}: p=${p} at threshold ${e.threshold}, right answer was ${label}`), ...(error ? { error } : {}) };
    }
  } catch (e) {
    error = e.message;
  }
  return { revoked: false, ...(error ? { error } : {}) };
}

export const readJsonl = (path) => {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
};
