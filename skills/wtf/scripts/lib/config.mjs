// <repo>/.claude/wtf.json (every key optional) and input-shape detection.
// { tracker: {type, id_pattern, url_template}, inbox: {type, url_pattern},
//   release: {mode, main_branch, production_branch, tag_pattern},
//   environments: [{name, kind: local|preview|staging, base_url}], production_hosts: [],
//   runtime: {sentry, posthog, logs}, heuristics, default_register, jev }

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export function loadConfig(repo) {
  const read = (name) => {
    const p = join(repo, '.claude', name);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  };
  const config = read('wtf.json') || {};
  // The release model is the same question /changelog already answered.
  if (!config.release) config.release = read('changelog.json')?.release || {};
  return { config, found: Boolean(read('wtf.json')) };
}

const IMAGE = /\.(png|jpe?g|gif|webp|heic|bmp)$/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const safeRe = (src, flags) => {
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
};

function trackerMatch(token, tracker = {}) {
  const type = tracker.type || 'none';
  if (type === 'github') {
    const m = token.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/) || token.match(/^#(\d+)$/);
    return m ? m[1] : null;
  }
  if (type === 'none' || !tracker.id_pattern) return null;
  if (tracker.url_template?.includes('{id}')) {
    const [pre, post] = tracker.url_template.split('{id}').map(escapeRe);
    const u = token.match(safeRe(`^${pre}(.+?)${post}(?:[/?#].*)?$`, 'i') || /$^/);
    if (u) return u[1];
  }
  const re = safeRe(`^(?:${tracker.id_pattern})$`, 'i');
  return re?.test(token) ? token : null;
}

// args: the user's arguments as tokens. -> { mode, register, sources, text, needs }
export function detect(args, config, repo) {
  const out = { mode: 'triage', register: config.default_register || null, sources: [], text: '', needs: [] };
  const rest = [];
  for (const a of args) {
    if (a === '--tech') out.register = 'tech';
    else if (a === '--plain') out.register = 'plain';
    else rest.push(a);
  }
  const [first, ...tail] = rest;
  if (first === 'setup') return { ...out, mode: 'setup' };
  if (first === 'stats') return { ...out, mode: 'stats' };
  if (first === 'outcome') {
    const [run, result, actual] = tail;
    return { ...out, mode: 'outcome', run: run || null, result: result || null, actual: actual || null };
  }
  if (first === 'latest') {
    const n = Math.min(10, Math.max(1, Number.parseInt(tail[0] || '3', 10) || 3));
    return { ...out, mode: 'latest', count: n };
  }

  const words = [];
  const inboxRe = config.inbox?.url_pattern ? safeRe(config.inbox.url_pattern, 'i') : null;
  for (const token of rest) {
    const abs = isAbsolute(token) ? token : resolve(repo, token);
    const m = inboxRe ? token.match(inboxRe) : null;
    const id = trackerMatch(token, config.tracker);
    if (m) out.sources.push({ kind: 'inbox', ref: token, id: m[1] || null });
    else if (id) out.sources.push({ kind: 'tracker', ref: token, id });
    else if (/^https?:\/\//i.test(token)) out.sources.push({ kind: 'url', ref: token });
    else if (existsSync(abs) && statSync(abs).isFile()) out.sources.push({ kind: IMAGE.test(token) ? 'screenshot' : 'file', ref: abs });
    else words.push(token);
  }
  out.text = words.join(' ');
  // Nothing to look at is a question for the user, never a silent default.
  if (!out.sources.length && !out.text) out.needs.push('input');
  if (!out.register) out.needs.push('register');
  return out;
}
