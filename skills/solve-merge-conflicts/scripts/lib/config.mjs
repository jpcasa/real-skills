// What /solve-merge-conflicts knows about a repo: .claude/solve-merge-conflicts.json.
// { install, gates: [], gate_timeout_s, lockfiles: { "<file name>": "<command>" },
//   generated: [{ glob, command? }], jev: shadow|live|off }
// Every key is optional. The check commands fall back to the other skills'
// files, so a repo that answered once is not asked again:
//   gates    <- .claude/improve-design.json `gates`, then .claude/do-shit.json `verify`
//   install  <- .claude/improve-design.json `dev.install`
//
// A pull request must not be able to choose the commands that run on it. So a
// config file that git tracks is read as the base branch has it, a file the
// pull request adds is not used at all, and only a file git does not track
// (the user's own, local one) is read from the checkout.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileAt } from './git.mjs';

export const FILE = 'solve-merge-conflicts.json';

const parse = (text, name) => {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`.claude/${name} is not valid JSON: ${e.message}`);
  }
};
const strings = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const within = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);

// dirs: where an untracked file is looked for, first hit wins (the checkout the user is in, then the main one).
// tracked: { repo, base, head } — the commits of the run. Without it (no run yet) only the checkouts are read.
export function loadConfig(dirs, tracked = null) {
  const ignored = [];
  const cache = new Map();
  const read = (name) => {
    if (!cache.has(name)) cache.set(name, load(name));
    return cache.get(name);
  };
  const load = (name) => {
    if (tracked) {
      const onBase = fileAt(tracked.repo, tracked.base, `.claude/${name}`);
      if (onBase !== null) return parse(onBase, name);
      if (fileAt(tracked.repo, tracked.head, `.claude/${name}`) !== null) {
        ignored.push(`.claude/${name}`);
        return null;
      }
    }
    for (const d of [].concat(dirs).filter(Boolean)) {
      const p = join(d, '.claude', name);
      if (existsSync(p)) return parse(readFileSync(p, 'utf8'), name);
    }
    return null;
  };
  const own = read(FILE);
  const raw = own || {};
  const sources = {};
  let gates = strings(raw['gates']);
  if (gates.length) sources.gates = `.claude/${FILE}`;
  else if (strings(read('improve-design.json')?.gates).length) {
    gates = strings(read('improve-design.json').gates);
    sources.gates = '.claude/improve-design.json';
  } else if (strings(read('do-shit.json')?.verify).length) {
    gates = strings(read('do-shit.json').verify);
    sources.gates = '.claude/do-shit.json';
  }
  let install = text(raw['install']);
  if (install) sources.install = `.claude/${FILE}`;
  else if (text(read('improve-design.json')?.dev?.install)) {
    install = text(read('improve-design.json').dev.install);
    sources.install = '.claude/improve-design.json';
  }
  const lockfiles = {};
  for (const [name, cmd] of Object.entries(raw['lockfiles'] && typeof raw['lockfiles'] === 'object' ? raw['lockfiles'] : {})) {
    if (name.includes('/')) throw new Error(`.claude/${FILE}: lockfiles is keyed by file name, not by path: ${name}`);
    if (text(cmd)) lockfiles[name] = text(cmd);
  }
  const generated = (Array.isArray(raw['generated']) ? raw['generated'] : []).flatMap((g) => (text(g?.['glob']) ? [{ glob: text(g['glob']), command: text(g['command']) }] : []));
  return {
    config: { install, gates, gate_timeout_s: within(raw['gate_timeout_s'], 5, 3600, 900), lockfiles, generated, jev: text(raw['jev']) },
    found: own ? [`.claude/${FILE}`] : [],
    sources,
    // Files the pull request adds: not used.
    ignored,
  };
}

export const jevMode = (config) => {
  const m = String(process.env.SOLVE_CONFLICTS_JEV || config.jev || 'shadow').toLowerCase();
  return m === 'live' ? 'live' : m === 'off' || m === '0' ? 'off' : 'shadow';
};
