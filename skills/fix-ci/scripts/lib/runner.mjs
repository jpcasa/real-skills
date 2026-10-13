// The failing commands, run by the script so that "red here too" and "green
// now" are exit codes and not claims. These run the pull request's code on
// this machine: the same trust as checking the branch out.

import { closeSync, openSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const RESULTS = ['reproduced', 'not_reproduced', 'differs', 'not_run'];
const TAIL_LINES = 40;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

// One command through `sh -c`, output to a log file. -> { exit, signal, timed_out }
export function sh(cwd, command, { timeoutS, log, env = {} }) {
  const fd = openSync(log, 'a');
  try {
    // NODE_TEST_CONTEXT: a `node --test` started from inside another one would report to a parent that is not its own.
    const { NODE_TEST_CONTEXT: _, ...own } = process.env;
    // detached: the command leads a process group of its own, so that when it runs out of time
    // everything it started (the package manager, the test runner under it) goes with it.
    const r = spawnSync('sh', ['-c', command], { cwd, stdio: ['ignore', fd, fd], timeout: timeoutS * 1000, killSignal: 'SIGKILL', detached: true, env: { ...own, CI: '1', ...env } });
    const timedOut = r.error?.code === 'ETIMEDOUT';
    if ((timedOut || r.signal) && r.pid) {
      try {
        process.kill(-r.pid, 'SIGKILL');
      } catch {}
    }
    return { exit: r.status, signal: r.signal || null, timed_out: timedOut };
  } finally {
    closeSync(fd);
  }
}

export const output = (log) => {
  try {
    return readFileSync(log, 'utf8').replace(ANSI, '');
  } catch {
    return '';
  }
};
export const tail = (text, n = TAIL_LINES) => text.split('\n').filter((l) => l.trim()).slice(-n).map((l) => l.slice(0, 300)).join('\n');

// -> { ok, exit, signal, timed_out, log, text }
export function run(cwd, command, opts) {
  const r = sh(cwd, command, opts);
  return { ...r, ok: r.exit === 0, log: opts.log, text: output(opts.log) };
}

// Is a red local run red for the reason CI gave?
// needles: file names and error lines CI reported (lib/logs.mjs).
// -> { result, matched } — matched: what was found, or why nothing could be
export function compare(r, needles) {
  if (r.ok) return { result: 'not_reproduced', matched: null };
  if (r.timed_out || r.signal) return { result: 'differs', matched: `killed here (${r.timed_out ? 'out of time' : r.signal}): not what CI reported` };
  // 127: the shell did not find the command. 126: it is not executable.
  if (r.exit === 127 || r.exit === 126) return { result: 'differs', matched: 'the command could not be started here' };
  if (!needles.length) return { result: 'reproduced', matched: 'CI reported only an exit code, and it is red here too' };
  const found = needles.find((n) => r.text.includes(n));
  return found ? { result: 'reproduced', matched: found } : { result: 'differs', matched: 'red here, and none of the files or errors CI named are in its output' };
}
