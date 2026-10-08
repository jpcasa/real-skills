// Run state for /wtf: ~/.claude/state/wtf/<run-id>/run.json plus one log for
// every run (log.jsonl). The log holds verdicts and counts, never report text.
// Override the root with WTF_STATE_DIR (tests).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const stateRoot = () => process.env.WTF_STATE_DIR || join(homedir(), '.claude/state/wtf');
export const runDir = (id) => join(stateRoot(), id);
export const BUDGETS = { tracker: 5, runtime: 4, repro: 1 };

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

export function newRun({ repo, register, sources }) {
  return {
    run_id: `wtf-${stamp()}-${randomBytes(2).toString('hex')}`,
    created_at: new Date().toISOString(),
    repo, register,
    sources: sources.map((s) => s.kind),
    budgets: Object.fromEntries(Object.entries(BUDGETS).map(([k, cap]) => [k, { cap, used: 0 }])),
    repro: null,
  };
}

export function saveRun(run) {
  mkdirSync(runDir(run.run_id), { recursive: true });
  const p = join(runDir(run.run_id), 'run.json');
  writeFileSync(`${p}.tmp`, `${JSON.stringify(run, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
}

export function loadRun(id) {
  const p = join(runDir(String(id)), 'run.json');
  if (!id || !existsSync(p)) throw new Error(`unknown run ${id}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function spend(run, kind) {
  const b = run.budgets[kind];
  if (!b) throw new Error(`unknown budget ${kind}; use ${Object.keys(run.budgets).join(' | ')}`);
  if (b.used >= b.cap) return { ok: false, kind, used: b.used, cap: b.cap, left: 0 };
  b.used += 1;
  return { ok: true, kind, used: b.used, cap: b.cap, left: b.cap - b.used };
}

const LOG = () => join(stateRoot(), 'log.jsonl');
export function appendLog(entry) {
  mkdirSync(stateRoot(), { recursive: true });
  appendFileSync(LOG(), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}
export const readLog = () =>
  existsSync(LOG()) ? readFileSync(LOG(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
