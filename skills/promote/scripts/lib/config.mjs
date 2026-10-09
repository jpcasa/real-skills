// What /promote knows about a repo. Read in order, never copied into one another:
//   .claude/promote.json                      stages, verify, jev: the only file with them
//   .claude/changelog.json, .claude/wtf.json, .claude/check-infra-and-migrations.json   release
//   .claude/wtf.json, .claude/qa-this.json, .claude/check-infra-and-migrations.json     environments, production_hosts, hosting
// { stages: [{ env, branch, how: push|pr|manual, from, merge_method: merge|squash|rebase,
//              production, deploy_workflow, command }],
//   verify: { "<env>": { health, deployed } }, jev: shadow|live|off }
//
// A stage is one environment and how code reaches it:
//   push    it follows its branch: every merge into the branch deploys
//   pr      a pull request from the `from` stage's branch into its branch
//   manual  something this skill does not do; `command` is shown, never run

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const OWN_FILE = 'promote.json';
const FILES = [OWN_FILE, 'changelog.json', 'wtf.json', 'qa-this.json', 'check-infra-and-migrations.json'];
const SHARED = {
  release: [OWN_FILE, 'changelog.json', 'wtf.json', 'check-infra-and-migrations.json'],
  environments: [OWN_FILE, 'wtf.json', 'qa-this.json', 'check-infra-and-migrations.json'],
  production_hosts: [OWN_FILE, 'wtf.json', 'qa-this.json', 'check-infra-and-migrations.json'],
  hosting: [OWN_FILE, 'wtf.json', 'qa-this.json', 'check-infra-and-migrations.json'],
};
const OWN = ['stages', 'verify', 'jev'];
export const HOW = ['push', 'pr', 'manual'];
export const MERGE_METHODS = ['merge', 'squash', 'rebase'];
export const VERIFY_KINDS = ['health', 'deployed'];
const STAGE_KEYS = ['env', 'branch', 'how', 'from', 'merge_method', 'production', 'deploy_workflow', 'command'];

// A guard against a paste mistake, not a sandbox: `verify.<env>.deployed` only
// reads. Same words, matched the same way, as the live commands of
// /check-infra-and-migrations.
const WRITES = /(^|[\s;&|(:"'])(deploy|apply|push|migrate|up|destroy|upgrade|import|drop|delete|truncate|reset|insert|update|alter|promote|rollback|merge)(?=$|[\s;&|):"'-])/i;
export function commandRefusal(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return 'must be a non-empty command string';
  const m = cmd.match(WRITES);
  if (m) return `contains "${m[2]}": this command only reads (use the tool's list, describe or status form)`;
  return null;
}

const filled = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '');
// A branch name ends up as a git and gh argument: nothing that reads as an option or a ref expression.
export const isBranch = (b) => typeof b === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b) && !b.includes('..') && !b.endsWith('/') && !b.endsWith('.lock');
const isName = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(s);

const norm = (h) => String(h || '').trim().toLowerCase().replace(/\.+$/, '');
const hostOf = (url) => {
  try {
    return norm(new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname) || null;
  } catch {
    return null;
  }
};
// Whether an environment means production: said so in its stage, else its
// name, its kind, its host, or the branch that feeds it. An explicit `false`
// is not believed against a name that starts with "prod".
export function isProduction(config, stage) {
  if (!stage) return false;
  if (stage.production === true) return true;
  if (/^prod/i.test(stage.env)) return true;
  if (stage.production === false) return false;
  if (/^live$/i.test(stage.env)) return true;
  if (stage.branch && stage.branch === config.release?.production_branch) return true;
  const env = (config.environments || []).find((e) => e && e.name === stage.env);
  if (!env) return false;
  if (/^prod/i.test(String(env.kind || ''))) return true;
  const host = hostOf(env.base_url || '');
  const prod = (config.production_hosts || []).map((h) => hostOf(String(h).replace(/^(https?:\/\/)?\*\./i, '$1'))).filter(Boolean);
  return Boolean(host) && prod.some((p) => host === p || host.endsWith(`.${p}`));
}

// Throws with the key and the reason: a half-right stage list must not promote anything.
export function validateStages(stages) {
  const at = (i) => `.claude/${OWN_FILE}: stages[${i}]`;
  if (!Array.isArray(stages) || !stages.length) throw new Error(`.claude/${OWN_FILE}: stages must be a non-empty list`);
  const envs = new Set();
  const branches = new Set();
  stages.forEach((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${at(i)} must be an object`);
    for (const k of Object.keys(s)) if (!STAGE_KEYS.includes(k)) throw new Error(`${at(i)} has an unknown key ${JSON.stringify(k)} (known: ${STAGE_KEYS.join(', ')})`);
    if (!isName(s.env)) throw new Error(`${at(i)}.env must be a short name; got ${JSON.stringify(s.env)}`);
    if (envs.has(s.env)) throw new Error(`${at(i)}.env ${JSON.stringify(s.env)} is listed twice`);
    envs.add(s.env);
    if (!HOW.includes(s.how)) throw new Error(`${at(i)}.how must be one of ${HOW.join(', ')}; got ${JSON.stringify(s.how)}`);
    if (s.how !== 'manual' || s.branch !== undefined) {
      if (!isBranch(s.branch)) throw new Error(`${at(i)}.branch must be a branch name; got ${JSON.stringify(s.branch)}`);
      if (branches.has(s.branch)) throw new Error(`${at(i)}.branch ${JSON.stringify(s.branch)} feeds two environments`);
      branches.add(s.branch);
    }
    if (s.merge_method !== undefined && !MERGE_METHODS.includes(s.merge_method)) throw new Error(`${at(i)}.merge_method must be one of ${MERGE_METHODS.join(', ')}; got ${JSON.stringify(s.merge_method)}`);
    if (s.production !== undefined && typeof s.production !== 'boolean') throw new Error(`${at(i)}.production must be true or false`);
    if (s.deploy_workflow !== undefined && !/^[\w.-]+\.ya?ml$/.test(String(s.deploy_workflow))) throw new Error(`${at(i)}.deploy_workflow must be a workflow file name such as deploy.yml; got ${JSON.stringify(s.deploy_workflow)}`);
    if (s.command !== undefined && (typeof s.command !== 'string' || !s.command.trim())) throw new Error(`${at(i)}.command must be a non-empty string`);
  });
  stages.forEach((s, i) => {
    if (s.how === 'pr') {
      const from = stages.find((x) => x.env === s.from);
      if (!s.from || !from) throw new Error(`${at(i)}.from must name another stage's env; got ${JSON.stringify(s.from)}`);
      if (from === s) throw new Error(`${at(i)}.from names its own stage`);
      if (!from.branch) throw new Error(`${at(i)}.from names ${JSON.stringify(s.from)}, which has no branch to promote from`);
    } else if (s.from !== undefined && !stages.some((x) => x.env === s.from && x !== s)) throw new Error(`${at(i)}.from must name another stage's env; got ${JSON.stringify(s.from)}`);
  });
  // No stage may, through its `from` chain, feed itself.
  stages.forEach((s, i) => {
    const seen = new Set([s.env]);
    for (let cur = s; cur?.from; ) {
      cur = stages.find((x) => x.env === cur.from);
      if (cur && seen.has(cur.env)) throw new Error(`${at(i)}: the \`from\` chain of ${JSON.stringify(s.env)} loops`);
      if (cur) seen.add(cur.env);
    }
  });
}

function validateVerify(verify, stages) {
  if (verify === undefined) return {};
  if (!verify || typeof verify !== 'object' || Array.isArray(verify)) throw new Error(`.claude/${OWN_FILE}: verify must be an object keyed by environment name`);
  for (const [env, v] of Object.entries(verify)) {
    if (!stages.some((s) => s.env === env)) throw new Error(`.claude/${OWN_FILE}: verify.${env} names no stage`);
    if (!v || typeof v !== 'object') throw new Error(`.claude/${OWN_FILE}: verify.${env} must be an object`);
    for (const k of Object.keys(v)) if (!VERIFY_KINDS.includes(k)) throw new Error(`.claude/${OWN_FILE}: verify.${env} has an unknown key ${JSON.stringify(k)} (known: ${VERIFY_KINDS.join(', ')})`);
    if (v.health !== undefined && !/^https?:\/\/[^\s]+$/i.test(String(v.health))) throw new Error(`.claude/${OWN_FILE}: verify.${env}.health must be an http(s) URL`);
    if (v.deployed !== undefined) {
      const why = commandRefusal(v.deployed);
      if (why) throw new Error(`.claude/${OWN_FILE}: verify.${env}.deployed ${why}`);
    }
  }
  return verify;
}

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
  const needs_setup = !Array.isArray(own.stages);
  config.stages = needs_setup ? [] : own.stages;
  if (!needs_setup) validateStages(config.stages);
  config.verify = needs_setup ? {} : validateVerify(own.verify, config.stages);
  // What another skill already knows about branches and environments, as evidence for setup.
  const known = Array.isArray(read['check-infra-and-migrations.json']?.targets) ? read['check-infra-and-migrations.json'].targets.filter((t) => t && isBranch(t.branch) && isName(t.env)).map((t) => ({ branch: t.branch, env: t.env })) : [];
  return { config, sources, known_targets: known, found: Object.keys(read).map((f) => `.claude/${f}`), needs_setup };
}

export const stageOf = (config, env) => config.stages.find((s) => s.env === env) || null;
export const sourceOf = (config, stage) => (stage?.from ? stageOf(config, stage.from) : null);
export const promotable = (config) => config.stages.filter((s) => s.how === 'pr');

export const jevMode = (config) => {
  const m = String(process.env.PROMOTE_JEV || config.jev || 'shadow').toLowerCase();
  return m === 'live' ? 'live' : m === 'off' || m === '0' ? 'off' : 'shadow';
};
