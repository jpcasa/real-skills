// The repo's own commands (install, type-check, lint, tests), run by the
// script so a result is an exit code and not a claim. These run the pull
// request's code on this machine: the same trust as checking the branch out.
//
// A command that is red on the merged tree is run once more on the pull
// request head as it was. Red there too: the merge did not break it.

import { openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export function sh(cwd, command, { timeoutS, log, env = {} }) {
  const fd = openSync(log, 'a');
  try {
    const r = spawnSync('sh', ['-c', command], { cwd, stdio: ['ignore', fd, fd], timeout: timeoutS * 1000, killSignal: 'SIGKILL', env: { ...process.env, CI: '1', ...env } });
    return { exit: r.status, signal: r.signal || null, timed_out: r.error?.code === 'ETIMEDOUT' };
  } finally {
    closeSync(fd);
  }
}

// One command. Killed by a signal is usually out of memory or out of time,
// not a failure: it is run once more on its own before it counts as red.
export function runOne(cwd, cmd, { timeoutS, logDir, label }) {
  const log = join(logDir, `${label}.log`);
  let r = sh(cwd, cmd, { timeoutS, log });
  if (r.signal || r.timed_out) r = sh(cwd, cmd, { timeoutS, log });
  return { cmd, ok: r.exit === 0, exit: r.exit, signal: r.signal, log };
}

// install first, then every check. A failed install stops the rest: they
// would only fail for the same reason. -> [{ cmd, ok, exit, signal, log, install? }], not_run: [cmd]
export function runAll(cwd, { install, gates }, opts) {
  const results = [];
  if (install) {
    const r = { ...runOne(cwd, install, { ...opts, label: `${opts.label}-install` }), install: true };
    results.push(r);
    if (!r.ok) return { results, not_run: gates };
  }
  gates.forEach((cmd, n) => results.push(runOne(cwd, cmd, { ...opts, label: `${opts.label}-${n + 1}` })));
  return { results, not_run: [] };
}

// What each red command does on the pull request head as it was.
// cwd: a worktree at that head. -> { "<cmd>": 'green' | 'red' | 'not_run' }
export function before(cwd, { install }, red, opts) {
  const state = {};
  if (install) {
    const r = runOne(cwd, install, { ...opts, label: `${opts.label}-install` });
    if (red.some((x) => x.install)) state[install] = r.ok ? 'green' : 'red';
    // Without its dependencies nothing else can be compared.
    if (!r.ok) {
      for (const x of red) if (!x.install) state[x.cmd] = 'not_run';
      return state;
    }
  }
  red.filter((x) => !x.install).forEach((x, n) => {
    state[x.cmd] = runOne(cwd, x.cmd, { ...opts, label: `${opts.label}-${n + 1}` }).ok ? 'green' : 'red';
  });
  return state;
}
