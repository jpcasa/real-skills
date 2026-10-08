// "file:line or it did not happen", checked. A citation counts only when the
// file exists inside the repo, the line is in range, and the quoted text is
// really there (within a few lines, to tolerate an off-by-a-few line number).
// This proves the line exists and says what was quoted. It does not prove the
// reading of it is right.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export const WINDOW = 3;
// Shorter quotes ("return", "} else {") occur everywhere and prove nothing.
export const MIN_QUOTE = 12;
export const ROLES = ['guard', 'designed_behavior', 'expected', 'actual', 'message', 'handler', 'write_path', 'exists'];
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

// evidence: [{ path, line, quote, role, note? }] -> same items + { verified, problem? }
export function checkCitations(repo, evidence = []) {
  return evidence.map((e) => {
    const fail = (problem) => ({ ...e, verified: false, problem });
    if (!e || typeof e.path !== 'string' || !e.path) return fail('no path');
    if (!ROLES.includes(e.role)) return fail(`role must be one of ${ROLES.join(', ')}`);
    const abs = isAbsolute(e.path) ? e.path : resolve(repo, e.path);
    const rel = relative(repo, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return fail('path is outside the repo');
    if (!existsSync(abs) || !statSync(abs).isFile()) return fail('file does not exist');
    // A symlink inside the repo must not stand in for a file outside it.
    const real = relative(realpathSync(repo), realpathSync(abs));
    if (real.startsWith('..') || isAbsolute(real)) return fail('path is outside the repo');
    const lines = readFileSync(abs, 'utf8').split('\n');
    if (!Number.isInteger(e.line) || e.line < 1 || e.line > lines.length) return fail(`line out of range (file has ${lines.length} lines)`);
    const quote = squash(e.quote || '');
    if (quote.length < MIN_QUOTE) return fail(`quote is missing or too short to check (at least ${MIN_QUOTE} characters)`);
    const near = squash(lines.slice(Math.max(0, e.line - 1 - WINDOW), e.line + WINDOW).join(' '));
    if (!near.includes(quote)) return fail(`quote not found within ${WINDOW} lines of line ${e.line}`);
    return { ...e, path: rel, verified: true };
  });
}
