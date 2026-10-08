// Per-repo configuration and role-agent resolution.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentFile, PLUGIN, PLUGIN_NAME, userAgentFile } from './paths.mjs';

// <repo>/.claude/do-shit.json — every key optional:
// { verify, base, statuses: {in_progress, review, qa, done, reopened}, labels: {always:[], migration:[], destructive_migration:[]},
//   path_rules: [{pattern, roles}], allowed_paths: {role: [globs]}, spawn_cap, max_concurrent_teams, merge_method, pr_title,
//   autonomy: "gates" (default) | "off", ci_wait_minutes (20), after_qa: {fix_bugs, e2e}, plan_workflow (false) }
export function loadConfig(repo) {
  const p = join(repo, '.claude/do-shit.json');
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, 'utf8'));
}

const ALIASES = { investigator: ['researcher'], worker: ['implementer'], tester: ['verifier'] };

// Same-name repo agent wins natively (Claude Code project > user > plugin precedence).
// Otherwise a prefixed repo agent (e.g. acme-researcher) is used for the role.
// Installed as a plugin, the bundled agent is `<plugin>:<role>` unless a user-level one exists.
export function resolveAgent(repo, role) {
  const dir = join(repo, '.claude/agents');
  if (existsSync(join(dir, `${role}.md`))) return { agent: role, source: 'repo' };
  if (existsSync(dir)) {
    const names = [role, ...(ALIASES[role] || [])];
    const hit = readdirSync(dir).find((f) => names.some((n) => f.endsWith(`-${n}.md`)));
    if (hit) return { agent: hit.replace(/\.md$/, ''), source: 'repo-prefixed' };
  }
  if (PLUGIN && !userAgentFile(role)) return { agent: `${PLUGIN_NAME}:${role}`, source: 'plugin' };
  return { agent: role, source: 'user' };
}

export function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    if (v.startsWith('[')) {
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
    } else out[k] = v;
  }
  return out;
}

export function allowedPaths(role, config = {}) {
  if (config.allowed_paths?.[role]) return config.allowed_paths[role];
  const p = agentFile(role);
  if (!p) return ['**'];
  return parseFrontmatter(readFileSync(p, 'utf8')).allowed_paths || ['**'];
}
