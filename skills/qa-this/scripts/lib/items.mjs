// Turns the user's arguments into the things to QA. An item is a tracker
// ticket, a pull request, a branch, or a described piece of work. For a PR and
// a branch the changed files come from git and GitHub here, not from the model.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { METHODS } from './methods.mjs';

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

const git = (repo, args) => {
  try {
    return execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
};
// QA_THIS_GH_STUB (tests): a JSON file mapping "pr view 12 --json …" to output.
function gh(repo, args) {
  if (process.env.QA_THIS_GH_STUB) {
    const map = JSON.parse(readFileSync(process.env.QA_THIS_GH_STUB, 'utf8'));
    const hit = map[args.join(' ')] ?? map[args.slice(0, 3).join(' ')];
    if (hit === undefined) throw new Error('gh stub: no answer');
    return typeof hit === 'string' ? hit : JSON.stringify(hit);
  }
  return execFileSync('gh', args, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}
const ghJson = (repo, args) => {
  try {
    return JSON.parse(gh(repo, args));
  } catch {
    return null;
  }
};

const VALUE_FLAGS = { '--env': 'env', '--method': 'methods' };
const BOOL_FLAGS = { '--screenshots': 'screenshots', '--no-post': 'no_post' };

// -> { mode, flags, tokens, run?, items?, result?, actual?, problems }
export function parseArgs(args) {
  const flags = { env: null, methods: [], screenshots: false, no_post: false };
  const tokens = [];
  const problems = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (VALUE_FLAGS[a]) {
      const v = args[++i];
      if (v === undefined) problems.push(`${a} needs a value`);
      else if (a === '--env') flags.env = String(v);
      else if (METHODS.includes(v)) flags.methods.push(v);
      else problems.push(`unknown method ${v}; use ${METHODS.join(', ')}`);
    } else if (BOOL_FLAGS[a]) flags[BOOL_FLAGS[a]] = true;
    else if (a.startsWith('--')) problems.push(`unknown flag ${a}`);
    else tokens.push(a);
  }
  const [first, ...rest] = tokens;
  if (first === 'setup' || first === 'stats') return { mode: first, flags, tokens: [], problems };
  if (first === 'post') return { mode: 'post', flags, tokens: [], run: rest[0] || null, items: rest.slice(1), problems };
  if (first === 'outcome') return { mode: 'outcome', flags, tokens: [], run: rest[0] || null, item: rest[1] || null, result: rest[2] || null, actual: rest[3] || null, problems };
  return { mode: 'qa', flags, tokens, problems };
}

function trackerMatch(token, tracker = {}) {
  const type = tracker.type || 'none';
  if (type === 'github') return token.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/)?.[1] || null;
  if (type === 'none' || !tracker.id_pattern) return null;
  if (tracker.url_template?.includes('{id}')) {
    const [pre, post] = tracker.url_template.split('{id}').map(escapeRe);
    const u = token.match(safeRe(`^${pre}(.+?)${post}(?:[/?#].*)?$`, 'i') || /$^/);
    if (u) return u[1];
  }
  return safeRe(`^(?:${tracker.id_pattern})$`, 'i')?.test(token) ? token : null;
}

const PR_FIELDS = 'number,title,url,state,headRefName,baseRefName,headRefOid,files';
function prItem(repo, number) {
  const pr = ghJson(repo, ['pr', 'view', String(number), '--json', PR_FIELDS]);
  if (!pr || typeof pr.number !== 'number') return null;
  return {
    id: `pr-${pr.number}`, kind: 'pr', ref: `#${pr.number}`, title: String(pr.title || '').slice(0, 200), url: pr.url || null,
    state: pr.state || null, head: pr.headRefName || null, sha: String(pr.headRefOid || '').slice(0, 12) || null,
    changed_files: (pr.files || []).map((f) => f.path).filter(Boolean),
    destination: { kind: 'pr', number: pr.number, url: pr.url || null },
  };
}

export function defaultBranch(repo) {
  const head = git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  if (head) return head;
  return ['main', 'master'].find((b) => git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])) || 'main';
}

function branchItem(repo, name) {
  const ref = [`refs/heads/${name}`, `refs/remotes/origin/${name}`].find((r) => git(repo, ['rev-parse', '--verify', '--quiet', r]));
  if (!ref) return null;
  const base = defaultBranch(repo);
  const baseRef = [`refs/remotes/origin/${base}`, `refs/heads/${base}`].find((r) => git(repo, ['rev-parse', '--verify', '--quiet', r]));
  const files = baseRef ? git(repo, ['diff', '--name-only', `${baseRef}...${ref}`]).split('\n').filter(Boolean) : [];
  return {
    id: `branch-${safeId(name)}`, kind: 'branch', ref: name, title: `branch ${name}`, base,
    sha: git(repo, ['rev-parse', '--short', ref]) || null, changed_files: files, destination: null,
  };
}

// -> { items, text }
export function classify(tokens, config, repo) {
  const items = [];
  const words = [];
  const tracker = config.tracker || {};
  for (const token of tokens) {
    const prUrl = token.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/);
    const number = prUrl?.[1] || token.match(/^(?:pr:|#)?(\d+)$/i)?.[1];
    // GitHub numbers issues and PRs together: ask which one this is.
    const pr = number ? prItem(repo, number) : null;
    const id = pr ? null : trackerMatch(token, tracker) || (tracker.type === 'github' && number && !prUrl && !/^pr:/i.test(token) ? number : null);
    const branch = pr || id ? null : branchItem(repo, token);
    if (pr) items.push(pr);
    else if (id) items.push({ id: safeId(id), kind: 'tracker', ref: id, title: '', changed_files: [], destination: { kind: 'tracker', type: tracker.type, id } });
    else if (branch) items.push(branch);
    else words.push(token);
  }
  const text = words.join(' ').trim();
  if (text) items.push({ id: 'text', kind: 'text', ref: text.slice(0, 80), title: text.slice(0, 200), changed_files: [], destination: null });
  const seen = new Set();
  return { items: items.filter((i) => !seen.has(i.id) && seen.add(i.id)), text };
}

// What to offer when the user named nothing. Tickets in the tracker's QA status
// are the model's to look up through the tracker adapter: no script can.
export function candidates(repo) {
  const current = ghJson(repo, ['pr', 'view', '--json', 'number,title,url,state']);
  const merged = ghJson(repo, ['pr', 'list', '--state', 'merged', '--limit', '10', '--json', 'number,title,url,mergedAt']) || [];
  const week = Date.now() - 7 * 864e5;
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    current_branch: branch && branch !== 'HEAD' && branch !== defaultBranch(repo) ? branch : null,
    current_pr: current && current.state === 'OPEN' ? { number: current.number, title: current.title, url: current.url } : null,
    merged_last_7_days: merged.filter((p) => Date.parse(p.mergedAt) >= week).map((p) => ({ number: p.number, title: p.title, url: p.url })),
  };
}
