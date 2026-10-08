// Run state for /review-prs: ~/.claude/state/review-prs/<run-id>/ holds
// run.json and, per PR, the diff, the head version of each changed file and
// the reviewer prompts. log.jsonl holds counts and verdicts, never code or
// finding text; jev.jsonl holds the calibration cases.
// Override the root with REVIEW_PRS_STATE_DIR (tests).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const stateRoot = () => process.env.REVIEW_PRS_STATE_DIR || join(homedir(), '.claude/state/review-prs');
export const runDir = (id) => join(stateRoot(), id);
export const prDir = (id, n) => join(runDir(id), `pr-${n}`);
export const jevLog = () => join(stateRoot(), 'jev.jsonl');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
export const newRunId = () => `rp-${stamp()}-${randomBytes(2).toString('hex')}`;

export function saveRun(run) {
  mkdirSync(runDir(run.run_id), { recursive: true });
  const p = join(runDir(run.run_id), 'run.json');
  writeFileSync(`${p}.tmp`, `${JSON.stringify(run, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
}

// Run ids are generated here; anything else (a path, "..") is not a run.
const RUN_ID = /^rp-\d{8}-\d{4}-[0-9a-f]{4}$/;
export function loadRun(id) {
  if (!RUN_ID.test(String(id))) throw new Error(`unknown run ${id}`);
  const p = join(runDir(String(id)), 'run.json');
  if (!existsSync(p)) throw new Error(`unknown run ${id}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

const LOG = () => join(stateRoot(), 'log.jsonl');
export function appendLog(entry) {
  mkdirSync(stateRoot(), { recursive: true });
  appendFileSync(LOG(), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}
export const readLog = () =>
  existsSync(LOG()) ? readFileSync(LOG(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
