// The repo's own checks (type-check, lint, tests), run by the script so a
// result is an exit code and not a claim. A move is vetoed only for a gate it
// turned red: one that was already red before the move is not the move's doing.

import { join } from 'node:path';
import { sh } from './dev.mjs';

// -> [{cmd, ok, exit, signal, log}]
// A gate killed by a signal is usually out of memory or out of time, not a
// failure: it is run once more on its own before it counts as red.
export function runGates(cwd, gates, { timeoutS, logDir, label }) {
  return gates.map((cmd, n) => {
    const log = join(logDir, `gate-${label}-${n + 1}.log`);
    let r = sh(cwd, cmd, { timeoutS, log });
    if (r.signal || r.timed_out) r = sh(cwd, cmd, { timeoutS, log });
    return { cmd, ok: r.exit === 0, exit: r.exit, signal: r.signal, log };
  });
}

// Gates green before and not green after.
export const turnedRed = (before, after) => after.filter((a) => !a.ok && before.find((b) => b.cmd === a.cmd)?.ok === true).map((a) => a.cmd);
