// What /fix-ci knows about a repo: .claude/fix-ci.json.
// { install, repro: { "<job glob>": "<command>" | false }, ignore: [job globs],
//   check_config: [globs], max_rounds, max_files, max_lines, gate_timeout_s,
//   watch_timeout_s, jev: shadow|live|off }
// Every key is optional. `install` (used only in a worktree, where nothing is
// installed yet) falls back to the other skills' files:
//   install  <- .claude/solve-merge-conflicts.json `install`, then .claude/improve-design.json `dev.install`
//
// A pull request must not be able to choose the commands that run on it. So a
// config file that git tracks is read as the base branch has it, a file the
// pull request adds is not used at all, and only a file git does not track
// (the user's own, local one) is read from the checkout.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileAt } from './git.mjs';
import { globMatch } from './glob.mjs';

export const FILE = 'fix-ci.json';

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
// tracked: { repo, base, head } — refs of the run. Without it only the checkouts are read.
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
  let install = text(raw['install']);
  if (install) sources.install = `.claude/${FILE}`;
  else if (text(read('solve-merge-conflicts.json')?.install)) {
    install = text(read('solve-merge-conflicts.json').install);
    sources.install = '.claude/solve-merge-conflicts.json';
  } else if (text(read('improve-design.json')?.dev?.install)) {
    install = text(read('improve-design.json').dev.install);
    sources.install = '.claude/improve-design.json';
  }
  const repro = {};
  for (const [glob, cmd] of Object.entries(raw['repro'] && typeof raw['repro'] === 'object' ? raw['repro'] : {})) {
    if (cmd === false) repro[glob] = false;
    else if (text(cmd)) repro[glob] = text(cmd);
    else throw new Error(`.claude/${FILE}: repro["${glob}"] is a command, or false to never run that job here`);
  }
  return {
    config: {
      install, repro, ignore: strings(raw['ignore']), check_config: strings(raw['check_config']),
      max_rounds: within(raw['max_rounds'], 1, 5, 3), max_files: within(raw['max_files'], 1, 500, 10), max_lines: within(raw['max_lines'], 1, 20000, 300),
      gate_timeout_s: within(raw['gate_timeout_s'], 5, 3600, 900), watch_timeout_s: within(raw['watch_timeout_s'], 60, 14400, 2700), jev: text(raw['jev']),
    },
    found: own ? [`.claude/${FILE}`] : [],
    sources,
    // Files the pull request adds: not used.
    ignored,
  };
}

// A job name is not a path: "Unit tests (shard 2/2)" is one name, and `*` runs through its slash.
const flat = (s) => String(s).replaceAll('/', '\u2215');
const matches = (glob, jobName) => glob === jobName || globMatch(flat(glob), flat(jobName));
// What `repro` in the config says for a job: a command, false, or undefined when it says nothing.
export function mappedFor(config, jobName) {
  const key = Object.keys(config.repro).find((g) => matches(g, jobName));
  return key === undefined ? undefined : config.repro[key];
}
export const isIgnored = (config, jobName) => config.ignore.some((g) => matches(g, jobName));

export const jevMode = (config) => {
  const m = String(process.env.FIX_CI_JEV || config.jev || 'shadow').toLowerCase();
  return m === 'live' ? 'live' : m === 'off' || m === '0' ? 'off' : 'shadow';
};
