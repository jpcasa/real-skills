// Run state for /fix-ci:
// ~/.claude/state/fix-ci/<run-id>/ holds run.json (the pull request, the
// commits, every failure with its class and its local result, the flags and
// the user's answers), every job log it fetched and the output of every
// command it ran. CI logs and other people's code: treat it as sensitive.
// log.jsonl holds classes, counts, rounds and verdicts, never log text;
// jev.jsonl the calibration cases. Override the root with FIX_CI_STATE_DIR (tests).

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const stateRoot = () => process.env.FIX_CI_STATE_DIR || join(homedir(), '.claude/state/fix-ci');
export const runDir = (id) => join(stateRoot(), id);
export const jevLog = () => join(stateRoot(), 'jev.jsonl');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
// Never the id of a run that exists: its worktree and its answers would be overwritten.
export function newRunId() {
  for (;;) {
    const id = `ci-${stamp()}-${randomBytes(2).toString('hex')}`;
    if (!existsSync(runDir(id))) return id;
  }
}

export function saveRun(run) {
  mkdirSync(runDir(run.run_id), { recursive: true });
  const p = join(runDir(run.run_id), 'run.json');
  writeFileSync(`${p}.tmp`, `${JSON.stringify(run, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
}

// Run ids are generated here; anything else (a path, "..") is not a run.
export const RUN_ID = /^ci-\d{8}-\d{4}-[0-9a-f]{4}$/;
export function loadRun(id) {
  if (!RUN_ID.test(String(id))) throw new Error(`unknown run ${id}`);
  const p = join(runDir(String(id)), 'run.json');
  if (!existsSync(p)) throw new Error(`unknown run ${id}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function allRuns() {
  if (!existsSync(stateRoot())) return [];
  return readdirSync(stateRoot()).filter((n) => RUN_ID.test(n)).flatMap((n) => {
    try {
      return [loadRun(n)];
    } catch {
      return [];
    }
  });
}

// A folder inside the run folder, created on demand.
export function sub(runId, name) {
  const p = join(runDir(runId), name);
  mkdirSync(p, { recursive: true });
  return p;
}

const LOG = () => join(stateRoot(), 'log.jsonl');
export function appendLog(entry) {
  mkdirSync(stateRoot(), { recursive: true });
  appendFileSync(LOG(), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}
export const readLog = () =>
  existsSync(LOG())
    ? readFileSync(LOG(), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      })
    : [];
