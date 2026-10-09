// Run state for /qa-this: ~/.claude/state/qa-this/<run-id>/run.json, the
// output of every command it ran, query results and screenshots, plus one log
// for every run (log.jsonl: statuses and counts, never output or row values).
// Override the root with QA_THIS_STATE_DIR (tests).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const stateRoot = () => process.env.QA_THIS_STATE_DIR || join(homedir(), '.claude/state/qa-this');
export const runDir = (id) => join(stateRoot(), id);

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
export const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function newRun(fields) {
  return { run_id: `qa-${stamp()}-${randomBytes(2).toString('hex')}`, created_at: new Date().toISOString(), ...fields };
}

export function saveRun(run) {
  mkdirSync(runDir(run.run_id), { recursive: true });
  const p = join(runDir(run.run_id), 'run.json');
  writeFileSync(`${p}.tmp`, `${JSON.stringify(run, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
}

// Run ids are generated here; anything else (a path, "..") is not a run.
const RUN_ID = /^qa-\d{8}-\d{4}-[0-9a-f]{4}$/;
export function loadRun(id) {
  if (!RUN_ID.test(String(id))) throw new Error(`unknown run ${id}`);
  const p = join(runDir(String(id)), 'run.json');
  if (!existsSync(p)) throw new Error(`unknown run ${id}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

// A folder inside the run folder, created on demand.
export function sub(runId, name) {
  const p = join(runDir(runId), name);
  mkdirSync(p, { recursive: true });
  return p;
}

export const logFile = () => join(stateRoot(), 'log.jsonl');
export function appendLog(entry) {
  mkdirSync(stateRoot(), { recursive: true });
  appendFileSync(logFile(), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}
export const readLog = () =>
  existsSync(logFile())
    ? readFileSync(logFile(), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      })
    : [];
