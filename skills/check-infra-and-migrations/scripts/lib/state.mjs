// Run state for /check-infra-and-migrations:
// ~/.claude/state/check-infra-and-migrations/<run-id>/ holds run.json and, per
// target, the diff, the head version of each bucketed file and the output of
// any live command (schema names, whatever a plan prints: treat as sensitive).
// log.jsonl holds verdicts and counts, never statement or plan text;
// jev.jsonl holds the calibration cases.
// Override the root with CHECK_INFRA_STATE_DIR (tests).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const stateRoot = () => process.env.CHECK_INFRA_STATE_DIR || join(homedir(), '.claude/state/check-infra-and-migrations');
export const runDir = (id) => join(stateRoot(), id);
// Target ids are built by the harness: pr-<n> or range-<sha7>-<sha7>.
export const TARGET_ID = /^(pr-\d+|range-[0-9a-f]{7}-[0-9a-f]{7})$/;
export function targetDir(id, target) {
  if (!TARGET_ID.test(String(target))) throw new Error(`unknown target ${target}`);
  const p = join(runDir(id), target);
  mkdirSync(p, { recursive: true });
  return p;
}
export const jevLog = () => join(stateRoot(), 'jev.jsonl');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
export const newRunId = () => `cim-${stamp()}-${randomBytes(2).toString('hex')}`;

export function saveRun(run) {
  mkdirSync(runDir(run.run_id), { recursive: true });
  const p = join(runDir(run.run_id), 'run.json');
  writeFileSync(`${p}.tmp`, `${JSON.stringify(run, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
}

// Run ids are generated here; anything else (a path, "..") is not a run.
const RUN_ID = /^cim-\d{8}-\d{4}-[0-9a-f]{4}$/;
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
  existsSync(LOG())
    ? readFileSync(LOG(), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      })
    : [];
