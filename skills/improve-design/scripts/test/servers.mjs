// The dev servers these tests start run detached, in their own process group,
// so a test file that is killed (--test-timeout, Ctrl-C, timeout(1)) never
// reaches after() and leaves them running. Two nets, test code only:
// - on exit, and on a signal nobody else handles, every server a run recorded
//   is killed with its group, if its pid still has the start time recorded;
// - the fixture server exits on its own once the test process is gone, which
//   also covers SIGKILL and a server killed before its run recorded it.

import { constants } from 'node:os';
import { startedAt } from '../lib/dev.mjs';
import { loadRun } from '../lib/state.mjs';

process.env.IMPROVE_DESIGN_TEST_OWNER = String(process.pid);

// Appended to the fixture's server.mjs.
export const OWNER_WATCH = "const owner = Number(process.env.IMPROVE_DESIGN_TEST_OWNER);\nif (owner) setInterval(() => { try { process.kill(owner, 0); } catch { process.exit(0); } }, 1000).unref();\n";

// `opened`: the run ids the file started, filled in as it goes.
export function reapOnExit(opened) {
  process.once('exit', () => {
    for (const id of opened) {
      let dev;
      try {
        dev = loadRun(id).dev;
      } catch {
        continue;
      }
      if (!dev?.pid || (dev.started && startedAt(dev.pid) !== dev.started)) continue;
      try {
        process.kill(-dev.pid, 'SIGKILL');
      } catch {}
    }
  });
  // Under `node --test` the runner handles SIGINT and SIGTERM and then exits,
  // which runs the handler above. Run on its own, the file would die without
  // an 'exit' event, so exit the way the signal would have.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      if (process.listenerCount(sig) === 1) process.exit(128 + constants.signals[sig]);
    });
  }
}
