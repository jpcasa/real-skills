// impeccable's detector, run by the script. Its findings are the one part of a
// design review that is the same every time, so they are what a move is held
// to: a move that adds a finding is dropped, whatever anyone thought of it.
//
// To compare two commits without touching the worktree, the changed files are
// written out as they were at each commit and both copies are scanned the same
// way. IMPROVE_DESIGN_DETECT (tests) names a script to run in the detector's place.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

const BIG = 64 * 1024 * 1024;
const text = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// -> { available, degraded, findings: [{rule, name, file, line, advisory}], error? }
// Exit 0 is clean and 2 is findings; anything else means the detector did not run.
export function scan(impeccable, cwd, paths, { noConfig = false } = {}) {
  const script = process.env.IMPROVE_DESIGN_DETECT || impeccable?.detect;
  if (!script) return { available: false, degraded: false, findings: [], error: 'no detector' };
  const r = spawnSync(process.execPath, [script, '--json', ...(noConfig ? ['--no-config'] : []), ...paths], { cwd, maxBuffer: BIG, timeout: 120000, encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 2) return { available: false, degraded: false, findings: [], error: text(r.stderr || r.error?.message, 300) || `exit ${r.status}` };
  let raw;
  try {
    raw = JSON.parse(r.stdout || '[]');
  } catch {
    return { available: false, degraded: false, findings: [], error: 'the detector did not print JSON' };
  }
  const findings = (Array.isArray(raw) ? raw : []).filter((f) => f && typeof f.antipattern === 'string').map((f) => {
    const file = String(f.file || '');
    return { rule: text(f.antipattern, 80), name: text(f.name, 120), file: isAbsolute(file) ? relative(cwd, file) : file, line: Number.isInteger(f.line) ? f.line : null, advisory: f.advisory === true || f.severity === 'advisory' };
  });
  // Without its parser modules the detector falls back to patterns and says so: an undercount, not a clean bill.
  return { available: true, degraded: /DEGRADED/.test(r.stderr || ''), findings };
}

// Findings that count, as {"rule|file": n}. Advisory ones never count.
export function keyed(findings) {
  const out = {};
  for (const f of findings) if (!f.advisory) out[`${f.rule}|${f.file}`] = (out[`${f.rule}|${f.file}`] || 0) + 1;
  return out;
}
export const total = (k) => Object.values(k).reduce((n, v) => n + v, 0);
// Keys with more findings after than before.
export const newFindings = (before, after) => Object.keys(after).filter((k) => after[k] > (before[k] || 0));
export const fixedFindings = (before, after) => Object.keys(before).filter((k) => (after[k] || 0) < before[k]);

function writeAt(worktree, rev, files, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    let body;
    try {
      body = execFileSync('git', ['-C', worktree, 'show', `${rev}:${f}`], { maxBuffer: BIG, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      continue; // not there at this commit
    }
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
}

// What the detector says about `files` at two commits.
// -> { available, degraded, before, after, new, fixed, error? }
export function delta(impeccable, worktree, from, to, files, dir) {
  const empty = { available: true, degraded: false, before: {}, after: {}, new: [], fixed: [] };
  if (!files.length) return empty;
  const sides = {};
  for (const [side, rev] of [['before', from], ['after', to]]) {
    writeAt(worktree, rev, files, join(dir, side));
    const r = scan(impeccable, join(dir, side), ['.'], { noConfig: true });
    if (!r.available) return { ...empty, available: false, error: r.error };
    sides[side] = r;
  }
  const [before, after] = [keyed(sides.before.findings), keyed(sides.after.findings)];
  return { available: true, degraded: sides.before.degraded || sides.after.degraded, before, after, new: newFindings(before, after), fixed: fixedFindings(before, after) };
}
