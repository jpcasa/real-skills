// Run state for /promote:
// ~/.claude/state/promote/<run-id>/ holds run.json (gates, commit ids, the PR,
// what the user confirmed, results) and the raw output of a `deployed` read
// (whatever that command prints: treat as sensitive).
// probe/<repo-key>.json holds the last probe of a repo, so `configured` can
// label the cases that probe logged. log.jsonl holds stages, counts and
// results, never PR text; jev.jsonl holds the calibration cases.
// Override the root with PROMOTE_STATE_DIR (tests).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const stateRoot = () => process.env.PROMOTE_STATE_DIR || join(homedir(), '.claude/state/promote');
export const runDir = (id) => join(stateRoot(), id);
export const jevLog = () => join(stateRoot(), 'jev.jsonl');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
// Never the id of a run that exists: its pull request and merge record would be overwritten.
export function newRunId() {
  for (;;) {
    const id = `pro-${stamp()}-${randomBytes(2).toString('hex')}`;
    if (!existsSync(runDir(id))) return id;
  }
}

const atomic = (p, value) => {
  writeFileSync(`${p}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
};

export function saveRun(run) {
  mkdirSync(runDir(run.run_id), { recursive: true });
  atomic(join(runDir(run.run_id), 'run.json'), run);
}

// Run ids are generated here; anything else (a path, "..") is not a run.
const RUN_ID = /^pro-\d{8}-\d{4}-[0-9a-f]{4}$/;
export function loadRun(id) {
  if (!RUN_ID.test(String(id))) throw new Error(`unknown run ${id}`);
  const p = join(runDir(String(id)), 'run.json');
  if (!existsSync(p)) throw new Error(`unknown run ${id}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

const probeFile = (repo) => join(stateRoot(), 'probe', `${createHash('sha1').update(String(repo)).digest('hex').slice(0, 16)}.json`);
export function saveProbe(repo, value) {
  mkdirSync(join(stateRoot(), 'probe'), { recursive: true });
  atomic(probeFile(repo), value);
}
export function loadProbe(repo) {
  try {
    return JSON.parse(readFileSync(probeFile(repo), 'utf8'));
  } catch {
    return null;
  }
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
