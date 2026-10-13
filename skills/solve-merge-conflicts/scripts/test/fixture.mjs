// A small app with a bare remote, where pull request #7 (`feat` into `main`)
// conflicts in four ways: a source file with two hunks, a lockfile, a file
// one side deleted and the other changed, and a binary. `main` also renamed
// a helper that the pull request calls from a file that does not conflict.
// Git is real throughout; only `gh` is answered from a stub.

import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
export const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
export const write = (repo, file, content) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
};
export const commit = (repo, message) => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
};
export const sha = (repo, ref) => git(repo, 'rev-parse', ref);

export const ORIGIN = 'import a from "a";\n\nexport function price(n) {\n  return n * 2;\n}\n\nexport const LIMIT = 10;\n';
export const PR = 'import a from "a";\nimport tax from "tax";\n\nexport function price(n, region) {\n  return n * 2;\n}\n\nexport const LIMIT = 10;\n';
export const BASE = 'import a from "a";\nimport log from "log";\n\nexport function price(amount) {\n  return amount * 2;\n}\n\nexport const LIMIT = 10;\n';
// Both intents: both imports, the renamed argument and the new one.
export const MERGED = 'import a from "a";\nimport tax from "tax";\nimport log from "log";\n\nexport function price(amount, region) {\n  return amount * 2;\n}\n\nexport const LIMIT = 10;\n';
export const COMBINED = 'export function price(amount, region) {\n  return amount * 2;\n';

export const LOCK_COMMAND = "tr '\\n' ' ' < deps.txt > deps.lock";
const lock = (deps) => deps.replaceAll('\n', ' ');
const DEPS = 'b\nc\nd\ne\nf\ng\nh\ni\nj\n';
// Green unless a file still calls the helper that the base renamed.
export const CALLER_GATE = 'if grep -q helper src/caller.ts; then grep -q helper src/util.ts; fi';

export const setConfig = (repo, value, name = 'solve-merge-conflicts.json') => write(repo, `.claude/${name}`, JSON.stringify(value));

export function prStub(head, extra = {}) {
  return { number: 7, state: 'OPEN', title: 'Regional pricing', body: 'Adds a region to price().', url: 'https://github.com/acme/app/pull/7', baseRefName: 'main', headRefName: 'feat', headRefOid: head, isCrossRepository: false, mergeable: 'CONFLICTING', author: { login: 'dev' }, ...extra };
}

// Built once per process, then copied: every test gets its own remote and clone.
let template = null;
function build() {
  const tmp = mkdtempSync(join(tmpdir(), 'mc-template-'));
  const remote = join(tmp, 'remote.git');
  const repo = join(tmp, 'app');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: { ...process.env, ...GIT_ENV } });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', remote);
  write(repo, '.gitignore', '.claude/\n');
  write(repo, 'src/price.ts', ORIGIN);
  write(repo, 'src/util.ts', 'export const helper = () => 1;\n');
  write(repo, 'deps.txt', DEPS);
  write(repo, 'deps.lock', lock(DEPS));
  write(repo, 'docs/old.md', 'old doc\n');
  write(repo, 'img/logo.bin', Buffer.from([0, 1, 2, 3]));
  commit(repo, 'init');

  git(repo, 'checkout', '-q', '-b', 'feat');
  write(repo, 'src/price.ts', PR);
  write(repo, 'src/caller.ts', 'import { helper } from "./util";\nexport const x = helper();\n');
  write(repo, 'deps.txt', `${DEPS}z\n`);
  write(repo, 'deps.lock', lock(`${DEPS}z\n`));
  write(repo, 'docs/old.md', 'old doc\nwith a new paragraph\n');
  write(repo, 'img/logo.bin', Buffer.from([0, 9, 9, 9]));
  const head = commit(repo, 'Add regional pricing');

  git(repo, 'checkout', '-q', 'main');
  write(repo, 'src/price.ts', BASE);
  commit(repo, 'Log prices (#21)');
  write(repo, 'src/util.ts', 'export const assist = () => 1;\n');
  const rename = commit(repo, 'Rename helper to assist (#22)');
  rmSync(join(repo, 'docs/old.md'));
  commit(repo, 'Drop old docs (#23)');
  write(repo, 'img/logo.bin', Buffer.from([0, 7, 7, 7]));
  commit(repo, 'New logo (#24)');
  write(repo, 'deps.txt', `a\n${DEPS}`);
  write(repo, 'deps.lock', lock(`a\n${DEPS}`));
  const base = commit(repo, 'Add a dependency (#25)');
  git(repo, 'push', '-q', 'origin', 'main', 'feat');
  return { tmp, head, base, rename };
}

// -> { tmp, remote, repo, head, base, rename, stubFile, setStub(extra), patchStub(extra) }
// rename: the base commit that renamed `helper` to `assist`.
export function makeApp(prefix = 'mc-', { config = { lockfiles: { 'deps.lock': LOCK_COMMAND } } } = {}) {
  template ||= build();
  const { head, base, rename } = template;
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  cpSync(template.tmp, tmp, { recursive: true });
  const remote = join(tmp, 'remote.git');
  const repo = join(tmp, 'app');
  git(repo, 'remote', 'set-url', 'origin', remote);
  if (config) setConfig(repo, config);

  const stubFile = join(tmp, 'gh.json');
  let current = {};
  const setStub = (extra = {}) => {
    current = { slug: 'acme/app', current_pr: null, prs: { 7: prStub(head) }, mine: [], ...extra };
    writeFileSync(stubFile, JSON.stringify(current));
  };
  const patchStub = (extra) => setStub({ ...current, ...extra });
  setStub();
  return { tmp, remote, repo, head, base, rename, stubFile, setStub, patchStub };
}

// A commit pushed to a branch of the remote, from a scratch clone: the app's own checkout does not move.
// opts.links: { "<path>": "<target>" } symbolic links to create. opts.exec: paths to mark executable.
export function pushTo(app, branch, files, message, opts = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'mc-push-'));
  execFileSync('git', ['clone', '-q', '-b', branch, app.remote, scratch], { env: { ...process.env, ...GIT_ENV } });
  // null removes the file.
  for (const [file, content] of Object.entries(files)) content === null ? rmSync(join(scratch, file)) : write(scratch, file, content);
  for (const [path, to] of Object.entries(opts.links || {})) symlinkSync(to, join(scratch, path));
  for (const path of opts.exec || []) chmodSync(join(scratch, path), 0o755);
  const tipSha = commit(scratch, message);
  git(scratch, 'push', '-q', 'origin', branch);
  return tipSha;
}
