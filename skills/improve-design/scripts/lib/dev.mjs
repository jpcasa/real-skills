// The run's own copy of the app: install, the files it needs to start, and a
// dev server on a port nobody else has. A server that was already running
// serves some other tree, so the run never uses one.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const quiet = (cwd, args) => {
  try {
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// True when `path`, with every symlink followed, is still inside `root`.
const inside = (root, path) => {
  try {
    return realpathSync(path).startsWith(realpathSync(root) + sep);
  } catch {
    return false;
  }
};

// Why a file named in dev.copy may not be copied into the worktree, or null.
// Only a file git ignores and does not track: the point is env files, and a
// copy of a tracked file would be a change nobody made.
export function copyRefusal(repo, path) {
  const p = normalize(String(path || ''));
  if (!p || isAbsolute(p) || p.startsWith('..') || p.includes('/../')) return `${path} is not a path inside the repo`;
  if (p === '.git' || p.startsWith('.git/')) return `${path} is inside .git`;
  if (!existsSync(join(repo, p))) return `${path} does not exist in ${repo}`;
  if (!lstatSync(join(repo, p)).isFile()) return `${path} is not a plain file`;
  // A folder on the way that is a link could lead anywhere.
  if (!inside(repo, join(repo, p))) return `${path} leads outside the repo`;
  if (quiet(repo, ['ls-files', '--error-unmatch', '--', p])) return `${path} is tracked by git: only ignored files are copied`;
  if (!quiet(repo, ['check-ignore', '-q', '--', p])) return `${path} is not ignored by git: a copy would show up as a new file`;
  return null;
}

// -> { copied: [paths], refused: [{path, why}] }. Contents are never read into the run.
export function copyFiles(repo, worktree, paths) {
  const copied = [];
  const refused = [];
  for (const path of paths) {
    const why = copyRefusal(repo, path);
    if (why) {
      refused.push({ path, why });
      continue;
    }
    const to = join(worktree, normalize(path));
    mkdirSync(dirname(to), { recursive: true });
    // The same on the way in: a tracked link in the worktree must not carry the copy out of it.
    if (!inside(worktree, dirname(to)) && realpathSync(dirname(to)) !== realpathSync(worktree)) {
      refused.push({ path, why: `${path} would be written outside the worktree` });
      continue;
    }
    if (existsSync(to) && !lstatSync(to).isFile()) {
      refused.push({ path, why: `${path} already exists in the worktree and is not a plain file` });
      continue;
    }
    copyFileSync(join(repo, normalize(path)), to);
    copied.push(normalize(path));
  }
  return { copied, refused };
}
export function removeCopies(worktree, copied) {
  for (const p of copied || []) {
    const at = join(worktree, p);
    try {
      // Only a plain file that is really inside the worktree: never through a link.
      if (lstatSync(at).isFile() && (inside(worktree, dirname(at)) || realpathSync(dirname(at)) === realpathSync(worktree))) rmSync(at, { force: true });
    } catch {}
  }
}

// A shell command of the user's own, from their config. Output goes to a log
// file in the run folder, never into the run's JSON.
export function sh(cwd, command, { timeoutS, log, env = {} }) {
  const fd = openSync(log, 'a');
  const r = spawnSync('sh', ['-c', command], { cwd, stdio: ['ignore', fd, fd], timeout: timeoutS * 1000, killSignal: 'SIGKILL', env: { ...process.env, CI: '1', ...env } });
  return { exit: r.status, signal: r.signal || null, timed_out: r.error?.code === 'ETIMEDOUT' };
}

// When a process started, as the system reports it. A pid is reused sooner or
// later; a pid with the same start time is the same process.
export const startedAt = (pid) => {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
};

// Starts `command` with {port} filled in, in its own process group, and
// returns at once. -> pid
export function startServer({ cwd, command, port, log }) {
  const fd = openSync(log, 'a');
  const child = spawn('sh', ['-c', command.replaceAll('{port}', String(port))], { cwd, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, PORT: String(port), BROWSER: 'none' } });
  child.unref();
  return child.pid;
}

export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Any answer below 500 means the app is up: a redirect to sign-in is still the app.
export async function waitReady({ url, pid, timeoutS }) {
  const until = Date.now() + timeoutS * 1000;
  let last = 'no answer';
  while (Date.now() < until) {
    if (!alive(pid)) return { ready: false, why: 'the dev server exited: see dev.log in the run folder' };
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (res.status < 500) return { ready: true, status: res.status };
      last = `status ${res.status}`;
    } catch (e) {
      last = e.cause?.code || e.name;
    }
    await sleep(500);
  }
  return { ready: false, why: `no answer below 500 from ${url} in ${timeoutS}s (last: ${last})` };
}

// The whole group: a dev server is a shell, a package manager and the server itself.
// `started` is what startedAt() said when the run started it. If the pid now
// belongs to something else, nothing is signalled.
export async function stopServer(pid, started = null) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (started && startedAt(pid) !== started) return false;
  const signal = (s) => {
    try {
      process.kill(-pid, s);
      return true;
    } catch {
      return false;
    }
  };
  if (!signal('SIGTERM')) return false;
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(100);
  // Also when the leader is gone: a child that ignored SIGTERM is still in the group.
  signal('SIGKILL');
  return true;
}
