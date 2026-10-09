// What /improve-design knows about a repo: .claude/improve-design.json.
// { base, dev: {cwd, install, command, ready_path, copy: [], timeout_s},
//   gates: [], gate_timeout_s, ui_paths: [], viewports: [], max_moves, capture,
//   screenshots: bool, pr: {draft: auto|always|never, labels: []},
//   jev: shadow|live|off }
// production_hosts is the one key read from the other skills' files too
// (.claude/qa-this.json, .claude/wtf.json, .claude/changelog.json): it is only
// used to say why a target URL was refused.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARD_MAX_MOVES, MAX_MOVES } from './moves.mjs';
import { DRAFT_MODES } from './verdict.mjs';

export const FILE = 'improve-design.json';
const HOST_FILES = [FILE, 'qa-this.json', 'wtf.json', 'changelog.json'];
// The files a design move may touch. The same list the designer role is held to.
export const UI_PATHS = ['**/*.tsx', '**/*.jsx', '**/*.vue', '**/*.svelte', '**/*.astro', '**/*.css', '**/*.scss', '**/*.svg', '**/*.html', '**/*.mdx', '**/*.stories.*', '**/tailwind.config.*', 'public/**'];
export const VIEWPORTS = ['1440x900', '390x844'];
const VIEWPORT = /^[1-9]\d{2,3}x[1-9]\d{2,3}$/;

const readJson = (p) => {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`${p.replace(/^.*\/\.claude\//, '.claude/')} is not valid JSON: ${e.message}`);
  }
};
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : []);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const within = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);

export function loadConfig(repo) {
  const own = readJson(join(repo, '.claude', FILE));
  const raw = own || {};
  const dev = raw.dev && typeof raw.dev === 'object' ? raw.dev : {};
  let hosts = [];
  let hostsFrom = null;
  for (const name of HOST_FILES) {
    const list = strings(name === FILE ? raw.production_hosts : readJson(join(repo, '.claude', name))?.production_hosts);
    if (list.length) {
      hosts = list;
      hostsFrom = `.claude/${name}`;
      break;
    }
  }
  const viewports = strings(raw.viewports).filter((v) => VIEWPORT.test(v)).slice(0, 4);
  const config = {
    base: text(raw.base),
    dev: {
      cwd: text(dev.cwd) || '.',
      install: text(dev.install),
      command: text(dev.command),
      ready_path: text(dev.ready_path) || '/',
      copy: strings(dev.copy),
      timeout_s: within(dev.timeout_s, 5, 900, 180),
    },
    gates: strings(raw.gates),
    gate_timeout_s: within(raw.gate_timeout_s, 5, 3600, 600),
    ui_paths: strings(raw.ui_paths).length ? strings(raw.ui_paths) : UI_PATHS,
    viewports: viewports.length ? viewports : VIEWPORTS,
    max_moves: within(raw.max_moves, 1, HARD_MAX_MOVES, MAX_MOVES),
    capture: text(raw.capture),
    screenshots: raw.screenshots === true,
    pr: { draft: DRAFT_MODES.includes(raw.pr?.draft) ? raw.pr.draft : 'auto', labels: strings(raw.pr?.labels).slice(0, 5) },
    jev: text(raw.jev),
    production_hosts: hosts,
  };
  // What setup asks for when the file does not answer it.
  const missing = [...(config.dev.command ? [] : ['dev']), ...(config.gates.length ? [] : ['gates'])];
  return { config, found: own ? [`.claude/${FILE}`] : [], sources: hostsFrom ? { production_hosts: hostsFrom } : {}, missing };
}

export const jevMode = (config) => {
  const m = String(process.env.IMPROVE_DESIGN_JEV || config.jev || 'shadow').toLowerCase();
  return m === 'live' ? 'live' : m === 'off' || m === '0' ? 'off' : 'shadow';
};

// A route ends up in a URL handed to a capture command and in the pull request.
// Plain path characters only: no query string (it can carry a token), nothing a shell reads.
const ROUTE = /^\/[A-Za-z0-9._~/%-]*$/;
const routeProblem = (r) => (ROUTE.test(r) ? null : `${r.slice(0, 80)} is not a plain route: letters, digits and . _ ~ / % - only`);
const bare = (r) => r.replace(/[?#].*$/, '');
// A branch name that git and gh can only read as a name.
export const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)$/;
const norm = (h) => String(h || '').trim().toLowerCase().replace(/^(https?:\/\/)?(\*\.)?/, '').replace(/[:/].*$/, '').replace(/\.+$/, '');

// The screen a run works on: a route, or a source file plus a route. The run
// renders it from its own worktree on localhost, so a URL is accepted only as
// another way to write a route, and only when it points at this machine.
// -> { route, file } or { problem }
export function parseTarget(config, { target, route = null }) {
  const t = String(target ?? '').trim();
  const r = text(route) && bare(text(route));
  if (r && !r.startsWith('/')) return { problem: `--route must start with "/": ${r.slice(0, 80)}` };
  if (r && routeProblem(r)) return { problem: routeProblem(r) };
  if (!t) return r ? { route: r, file: null } : { problem: 'no target: pass a route such as /settings, or a source file with --route' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    let url;
    try {
      url = new URL(t);
    } catch {
      return { problem: `${t} is not a URL` };
    }
    const host = url.hostname.toLowerCase();
    if (config.production_hosts.map(norm).some((p) => p && (host === p || host.endsWith(`.${p}`)))) return { problem: `${host} is a production host: a design pass never touches production. Pass the route instead (${url.pathname})` };
    if (!LOCAL.test(host)) return { problem: `${host} is not this machine: the screen is rendered from the run's own worktree. Pass the route instead (${url.pathname})` };
    // The query string is dropped: it can carry a token or a person's id.
    const path = url.pathname || '/';
    return routeProblem(path) ? { problem: routeProblem(path) } : { route: path, file: null };
  }
  if (t.startsWith('/')) return routeProblem(bare(t)) ? { problem: routeProblem(bare(t)) } : { route: bare(t), file: null };
  if (t.includes('..') || /^[~\\]/.test(t)) return { problem: `${t} is not a path inside the repo` };
  return r ? { route: r, file: t } : { problem: `${t} is a file: pass --route too, so the screen can be rendered` };
}
