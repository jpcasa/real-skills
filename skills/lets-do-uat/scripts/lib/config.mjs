// What /lets-do-uat knows about a repo. Four files, read in order and never
// copied into one another:
//   .claude/lets-do-uat.json  everything, and the only one with rag, docs_dir, post, jev
//   .claude/qa-this.json      tracker, environments, production_hosts
//   .claude/wtf.json          tracker, environments, production_hosts
//   .claude/changelog.json    tracker
// { tracker: {type, id_pattern, url_template}, environments: [{name, kind, base_url}],
//   production_hosts: [], rag: {enabled: bool, signals: []}, docs_dir,
//   post: ask|off, jev: shadow|live|off }

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const OWN_FILE = 'lets-do-uat.json';
export const FILES = [OWN_FILE, 'qa-this.json', 'wtf.json', 'changelog.json'];
const SHARED = { tracker: FILES, environments: FILES.slice(0, 3), production_hosts: FILES.slice(0, 3) };
const OWN = ['rag', 'docs_dir', 'post', 'jev'];
// What setup asks for when no file answers it.
const SETUP_KEYS = ['tracker', 'environments', 'production_hosts'];
export const POST_MODES = ['ask', 'off'];

const filled = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '');

function readAll(repo) {
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
  return read;
}

export function loadConfig(repo) {
  const read = readAll(repo);
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
    if (filled(read[OWN_FILE]?.[key])) {
      config[key] = read[OWN_FILE][key];
      sources[key] = `.claude/${OWN_FILE}`;
    }
  }
  config.post = POST_MODES.includes(config.post) ? config.post : 'ask';
  // Never outside the repo, never absolute: docs land where the team reads them.
  const dir = typeof config.docs_dir === 'string' ? config.docs_dir.replace(/^\.\/+/, '') : '';
  config.docs_dir = dir && !dir.startsWith('/') && !dir.split('/').includes('..') ? dir : 'docs/uat';
  return { config, sources, found: Object.keys(read).map((f) => `.claude/${f}`), missing: SETUP_KEYS.filter((k) => !filled(config[k])) };
}

// Writes one key of this skill's own file, keeping every other key. Used for
// the answers asked once per repo (the RAG question).
export function saveOwn(repo, key, value) {
  if (!OWN.includes(key)) throw new Error(`${key} is not a ${OWN_FILE} key`);
  const p = join(repo, '.claude', OWN_FILE);
  const cur = readAll(repo)[OWN_FILE] || {};
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(p, `${JSON.stringify({ ...cur, [key]: value }, null, 2)}\n`);
  return `.claude/${OWN_FILE}`;
}

export const jevMode = (config) => {
  const m = String(process.env.LETS_DO_UAT_JEV || config.jev || 'shadow').toLowerCase();
  return m === 'live' ? 'live' : m === 'off' || m === '0' ? 'off' : 'shadow';
};
