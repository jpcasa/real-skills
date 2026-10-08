// What /qa-this knows about a repo. Three files, read in order and never
// copied into one another:
//   .claude/qa-this.json    everything, and the only one with tests, databases, post
//   .claude/wtf.json        tracker, environments, production_hosts, hosting, runtime
//   .claude/changelog.json  tracker
// { tracker: {type, id_pattern, url_template}, environments: [{name, kind, base_url}],
//   production_hosts: [], hosting, runtime,
//   tests: {unit, e2e, globs: [], timeout_s}, databases: [{env, how, header}],
//   path_rules: [{pattern, methods: []}], post: ask|auto|off, screenshots: bool,
//   report_dir, jev: shadow|live|off }

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FILES = ['qa-this.json', 'wtf.json', 'changelog.json'];
const SHARED = { tracker: FILES, environments: FILES.slice(0, 2), production_hosts: FILES.slice(0, 2), hosting: FILES.slice(0, 2), runtime: FILES.slice(0, 2) };
const OWN = ['tests', 'databases', 'path_rules', 'post', 'screenshots', 'report_dir', 'jev'];
// What setup asks for when no file answers it.
const SETUP_KEYS = ['tracker', 'environments', 'production_hosts', 'tests'];
export const POST_MODES = ['ask', 'auto', 'off'];

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
    if (filled(read['qa-this.json']?.[key])) {
      config[key] = read['qa-this.json'][key];
      sources[key] = '.claude/qa-this.json';
    }
  }
  config.post = POST_MODES.includes(config.post) ? config.post : 'ask';
  config.screenshots = config.screenshots === true;
  config.report_dir = typeof config.report_dir === 'string' && config.report_dir ? config.report_dir : 'docs/qa';
  return { config, sources, found: Object.keys(read).map((f) => `.claude/${f}`), missing: SETUP_KEYS.filter((k) => !filled(config[k])) };
}

export const jevMode = (config) => {
  const m = String(process.env.QA_THIS_JEV || config.jev || 'shadow').toLowerCase();
  return m === 'live' ? 'live' : m === 'off' || m === '0' ? 'off' : 'shadow';
};
