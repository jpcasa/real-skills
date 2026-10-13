// What kind of conflict a path is in, and which resolutions it can take.
// Sides are `pr` (the pull request's branch) and `base` (the branch it merges
// into), never "ours" and "theirs".

import { basename } from 'node:path';
import { anyMatch, globMatch } from './glob.mjs';

export const CLASSES = ['content', 'lockfile', 'generated', 'modify_delete', 'binary', 'structural'];

// The resolutions each class takes. `regenerate` is the script's own.
export const KINDS = {
  content: ['both', 'combined', 'pr', 'base'],
  lockfile: ['regenerate', 'pr', 'base'],
  generated: ['regenerate', 'pr', 'base'],
  modify_delete: ['keep', 'delete', 'port'],
  binary: ['pr', 'base'],
  structural: ['keep', 'delete'],
};
export const ALL_KINDS = [...new Set(Object.values(KINDS).flat())];

// Lockfiles are never merged by hand: the base's copy is taken and the package
// manager writes the rest. Install scripts stay off, because the manifest it
// reads comes from the pull request.
export const LOCKFILES = {
  'package-lock.json': 'npm install --package-lock-only --ignore-scripts',
  'npm-shrinkwrap.json': 'npm install --package-lock-only --ignore-scripts',
  'pnpm-lock.yaml': 'pnpm install --lockfile-only --ignore-scripts',
  'yarn.lock': 'yarn install --ignore-scripts',
  'bun.lock': 'bun install --lockfile-only --ignore-scripts',
  'bun.lockb': 'bun install --lockfile-only --ignore-scripts',
  'go.sum': 'go mod tidy',
  'Cargo.lock': 'cargo update --workspace',
  'uv.lock': 'uv lock',
  'Gemfile.lock': 'bundle lock',
};
const YARN_BERRY = 'yarn install --mode update-lockfile';

export const isLockfile = (path, config = {}) => basename(path) in { ...LOCKFILES, ...(config.lockfiles || {}) };

// The command that rewrites a lockfile, run in the lockfile's folder.
// berry: a .yarnrc.yml sits beside it.
export function lockCommand(path, config = {}, { berry = false } = {}) {
  const name = basename(path);
  if (config.lockfiles?.[name]) return config.lockfiles[name];
  if (name === 'yarn.lock' && berry) return YARN_BERRY;
  return LOCKFILES[name] || null;
}

// The `generated` entry a path falls under, or null. -> { glob, command }
export const generatedRule = (path, config = {}) => (config.generated || []).find((g) => globMatch(g.glob, path)) || null;

// xy: the two letters `git status` gives an unmerged path, pull request side first.
// -> { class, modified?: pr|base, has?: pr|base }
export function classify({ xy, path, binary = false, config = {} }) {
  if (xy === 'UD') return { class: 'modify_delete', modified: 'pr' };
  if (xy === 'DU') return { class: 'modify_delete', modified: 'base' };
  if (xy === 'AU') return { class: 'structural', has: 'pr' };
  if (xy === 'UA') return { class: 'structural', has: 'base' };
  if (xy === 'DD') return { class: 'structural', has: null };
  if (xy !== 'UU' && xy !== 'AA') throw new Error(`not an unmerged path: ${xy} ${path}`);
  if (isLockfile(path, config)) return { class: 'lockfile' };
  if (anyMatch((config.generated || []).map((g) => g.glob), path)) return { class: 'generated' };
  if (binary) return { class: 'binary' };
  return { class: 'content' };
}

// Why a resolution of a whole file needs the user's answer, or null.
// c: the conflict; kind: the resolution proposed; to: where `port` carries the change.
export function fileAsk(c, kind, to = null) {
  if (kind === 'regenerate') return null;
  // git follows a file it can see was moved. When it could not, where the code went is a judgment.
  if (kind === 'port') return `the file is deleted and its change is carried to ${to || 'another file'} by hand; whether that is where the code went is a call`;
  if (c.class === 'structural') return c.has === null ? null : `the path exists only on ${c.has === 'pr' ? "the pull request's" : "the base's"} side after a rename or a move; ${kind === 'keep' ? 'keeping' : 'deleting'} it is a call about where the file lives`;
  if (c.class === 'modify_delete') {
    const [changed, deleted] = c.modified === 'pr' ? ['the pull request', 'the base'] : ['the base', 'the pull request'];
    return kind === 'keep' ? `${deleted} deleted this file and ${changed} changed it; keeping it undoes the deletion` : `${deleted} deleted this file and ${changed} changed it; deleting it drops that change`;
  }
  return `the whole file is taken from ${kind === 'pr' ? 'the pull request' : 'the base'}; the other side's version is dropped`;
}
