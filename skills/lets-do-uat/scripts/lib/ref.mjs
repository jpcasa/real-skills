// Turns the user's argument into the one thing to UAT: a tracker ticket or a
// pull request. One per run: UAT walks one feature at a time.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const safeRe = (src, flags) => {
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
};
// Becomes a folder and a file name: never empty, never dots alone, never starting with one.
export const safeId = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'item';

const BOOL_FLAGS = { '--no-post': 'no_post', '--no-commit': 'no_commit' };
const VALUE_FLAGS = { '--env': 'env', '--mode': 'mode', '--browser': 'browser' };
export const MODES = ['user', 'agent'];
export const BROWSERS = ['built-in', 'chrome'];

// -> { mode, flags, tokens, run?, flow?, result?, problems }
export function parseArgs(args) {
  const flags = { env: null, mode: null, browser: null, no_post: false, no_commit: false };
  const tokens = [];
  const problems = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (VALUE_FLAGS[a]) {
      const v = args[++i];
      if (v === undefined) problems.push(`${a} needs a value`);
      else if (a === '--mode' && !MODES.includes(v)) problems.push(`--mode is ${MODES.join(' or ')}`);
      else if (a === '--browser' && !BROWSERS.includes(v)) problems.push(`--browser is ${BROWSERS.join(' or ')}`);
      else flags[VALUE_FLAGS[a]] = String(v);
    } else if (BOOL_FLAGS[a]) flags[BOOL_FLAGS[a]] = true;
    else if (a.startsWith('--')) problems.push(`unknown flag ${a}`);
    else tokens.push(a);
  }
  const [first, ...rest] = tokens;
  if (first === 'setup' || first === 'stats') return { mode: first, flags, tokens: [], problems };
  if (first === 'outcome') return { mode: 'outcome', flags, tokens: [], run: rest[0] || null, flow: rest[1] || null, result: rest[2] || null, problems };
  if (tokens.length > 1) problems.push(`one ticket or PR per run; got ${tokens.length}`);
  return { mode: 'uat', flags, tokens, problems };
}

function trackerId(token, tracker = {}) {
  if (!tracker.id_pattern && !tracker.url_template) return null;
  if (tracker.url_template?.includes('{id}')) {
    const [pre, post] = tracker.url_template.split('{id}').map(escapeRe);
    const u = token.match(safeRe(`^${pre}(.+?)${post}(?:[/?#].*)?$`, 'i') || /$^/);
    if (u) return u[1];
  }
  const re = tracker.id_pattern && safeRe(`^(?:${tracker.id_pattern.replace(/^\\b|\\b$/g, '')})$`, 'i');
  return re && re.test(token) ? token : null;
}

// -> { kind: ticket|pr, tracker, id, url|null, slug } or { error }
export function classify(token, config) {
  const t = String(token || '').trim();
  const tracker = config.tracker || {};
  const type = tracker.type || 'none';
  const gh = t.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)/);
  if (gh) {
    const kind = gh[2] === 'pull' ? 'pr' : 'ticket';
    return { kind, tracker: 'github', id: gh[3], url: t.split(/[?#]/)[0], slug: `${kind === 'pr' ? 'pr' : 'gh'}-${gh[3]}` };
  }
  const n = t.match(/^#?(\d+)$/)?.[1];
  if (n) return type === 'github' ? { kind: 'ticket', tracker: 'github', id: n, url: null, slug: `gh-${n}` } : { kind: 'pr', tracker: 'github', id: n, url: null, slug: `pr-${n}` };
  if (type !== 'none' && type !== 'github') {
    const id = trackerId(t, tracker);
    if (id) return { kind: 'ticket', tracker: type, id, url: tracker.url_template ? tracker.url_template.replace('{id}', id) : null, slug: safeId(id) };
  }
  return { error: `${t} is not a ${type === 'none' ? 'GitHub issue or PR' : `${type} ticket or a GitHub PR`} this repo's config recognises` };
}
