// What /check-infra-and-migrations knows about a repo. Read in order, never
// copied into one another:
//   .claude/check-infra-and-migrations.json   everything below, and the only one with it
//   .claude/changelog.json, .claude/wtf.json  release
//   .claude/wtf.json, .claude/qa-this.json    environments, production_hosts, hosting
//   .claude/promote.json                      stages, read as targets when this file has none
// { migrations: [{tool, dir | paths: [], applied: before_deploy|after_deploy|manual, applied_by}],
//   infra: [{tool, paths: [], applied_by}], pipeline: [globs], env_files: [globs],
//   targets: [{branch, env}], live: { "<env>": {applied, sizes, plan} },
//   big_table_rows, post: ask|auto|off, jev: shadow|live|off }

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandRefusal, LIVE_KINDS } from './live.mjs';

export const OWN_FILE = 'check-infra-and-migrations.json';
const FILES = [OWN_FILE, 'changelog.json', 'wtf.json', 'qa-this.json', 'promote.json'];
const SHARED = {
  release: [OWN_FILE, 'changelog.json', 'wtf.json'],
  environments: [OWN_FILE, 'wtf.json', 'qa-this.json'],
  production_hosts: [OWN_FILE, 'wtf.json', 'qa-this.json'],
  hosting: [OWN_FILE, 'wtf.json', 'qa-this.json'],
};
const OWN = ['migrations', 'infra', 'pipeline', 'env_files', 'targets', 'live', 'big_table_rows', 'post', 'jev'];
export const POST_MODES = ['ask', 'auto', 'off'];
export const APPLIED = ['before_deploy', 'after_deploy', 'manual'];
export const BIG_TABLE_ROWS = 1_000_000;

const filled = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '');

export function loadConfig(repo) {
  const read = {};
  for (const name of FILES) {
    const p = join(repo, '.claude', name);
    if (!existsSync(p)) continue;
    try {
      read[name] = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      throw new Error(`.claude/${name} is not valid JSON: ${e.message}`);
    }
  }
  const own = read[OWN_FILE] || {};
  const config = {};
  const sources = {};
  for (const [key, files] of Object.entries(SHARED)) {
    const from = files.find((f) => filled(read[f]?.[key]));
    if (from) {
      config[key] = read[from][key];
      sources[key] = `.claude/${from}`;
    }
  }
  for (const key of OWN) {
    if (own[key] !== undefined && own[key] !== null) {
      config[key] = own[key];
      sources[key] = `.claude/${OWN_FILE}`;
    }
  }
  // "None" is an answer: an empty list stops the defaults and stops setup asking.
  const explicit = { migrations: Array.isArray(own.migrations), infra: Array.isArray(own.infra) };
  config.migrations = explicit.migrations ? own.migrations : [];
  config.infra = explicit.infra ? own.infra : [];
  for (const m of config.migrations) {
    if (m.applied !== undefined && !APPLIED.includes(m.applied)) throw new Error(`.claude/${OWN_FILE}: migrations[].applied must be one of ${APPLIED.join(', ')}; got ${JSON.stringify(m.applied)}`);
  }
  config.live = config.live && typeof config.live === 'object' ? config.live : {};
  for (const [env, cmds] of Object.entries(config.live)) {
    for (const kind of LIVE_KINDS) {
      if (cmds?.[kind] === undefined) continue;
      const why = commandRefusal(cmds[kind]);
      if (why) throw new Error(`.claude/${OWN_FILE}: live.${env}.${kind} ${why}`);
    }
  }
  config.post = POST_MODES.includes(config.post) ? config.post : 'ask';
  config.big_table_rows = Number.isInteger(config.big_table_rows) && config.big_table_rows > 0 ? config.big_table_rows : BIG_TABLE_ROWS;
  const prod = config.release?.production_branch || 'production';
  // /promote already knows which branch feeds which environment: one setup answers both.
  const staged = (Array.isArray(read['promote.json']?.stages) ? read['promote.json'].stages : []).filter((s) => s && typeof s.branch === 'string' && s.branch && typeof s.env === 'string' && s.env).map((s) => ({ branch: s.branch, env: s.env }));
  if (Array.isArray(config.targets) && config.targets.length) {
    // its own
  } else if (staged.length) {
    config.targets = staged;
    sources.targets = '.claude/promote.json';
  } else config.targets = [{ branch: prod, env: 'production' }, { branch: 'staging', env: 'staging' }];
  return { config, sources, explicit, found: Object.keys(read).map((f) => `.claude/${f}`), needs_setup: !explicit.migrations && !explicit.infra };
}

export const jevMode = (config) => {
  const m = String(process.env.CHECK_INFRA_JEV || config.jev || 'shadow').toLowerCase();
  return m === 'live' ? 'live' : m === 'off' || m === '0' ? 'off' : 'shadow';
};

const norm = (h) => String(h || '').trim().toLowerCase().replace(/\.+$/, '');
const hostOf = (url) => {
  try {
    return norm(new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname) || null;
  } catch {
    return null;
  }
};
// Whether an environment name means production: its name, its kind, its host,
// or the branch that feeds it. Used to say so plainly before a live read.
export function isProduction(config, envName, branch = null) {
  if (!envName) return false;
  if (/^prod/i.test(envName)) return true;
  if (branch && branch === (config.release?.production_branch || 'production')) return true;
  const env = (config.environments || []).find((e) => e && e.name === envName);
  if (!env) return false;
  if (/^prod/i.test(String(env.kind || ''))) return true;
  const host = hostOf(env.base_url || '');
  const prod = (config.production_hosts || []).map((h) => hostOf(String(h).replace(/^(https?:\/\/)?\*\./i, '$1'))).filter(Boolean);
  return Boolean(host) && prod.some((p) => host === p || host.endsWith(`.${p}`));
}
