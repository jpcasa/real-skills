#!/usr/bin/env node
// PreToolUse guard for /do-shit role agents. Identifies the role from `agent_type`.
//
// Two wirings:
//  - hand-installed: declared in each role agent's frontmatter, so it runs
//    only while that subagent runs.
//  - plugin: plugin agents ignore frontmatter hooks, so hooks/hooks.json runs
//    it for every tool call with `--plugin`; it then guards only
//    `<plugin>:<role>` agents (e.g. `real-skills:worker`) and leaves the user's own agents alone.
//
//  - read-only roles: no Edit/Write; no mutating git, sed -i, rm, mv, or
//    redirects into relative paths
//  - build roles: edits only inside a `.claude/worktrees/ds-*` worktree and
//    inside the role's allowed_paths (agent frontmatter or .claude/do-shit.json)
//  - every role: no git push, no git stash (except list/show)
//  - reviewer (/review-prs): read-only, and also no GitHub writes and no checkout
//
// Emits `deny` or nothing. Fails open on internal error: the harness diff
// check still catches scope escapes after the fact.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { anyMatch } from '../skills/do-shit/scripts/lib/glob.mjs';
import { parseFrontmatter } from '../skills/do-shit/scripts/lib/repo.mjs';
import { agentFile, PLUGIN_NAME } from '../skills/do-shit/scripts/lib/paths.mjs';

const HOME = homedir();
const PLUGIN_MODE = process.argv.includes('--plugin');
const LOG = join(HOME, '.claude/logs/guard-decisions.jsonl');

const READ_ONLY = new Set([
  'investigator', 'architect', 'tester', 'auditor', 'security-advisor', 'accessibility-auditor',
  'performance-engineer', 'qa-planner', 'qa-tester', 'reviewer',
]);
const BUILD = new Set([
  'integrator', 'data-engineer', 'worker', 'designer', 'content-creator', 'observability-engineer', 'docs-writer', 'test-engineer',
]);
const ALIASES = { researcher: 'investigator', implementer: 'worker', verifier: 'tester' };

function roleOf(agentType) {
  if (!agentType) return null;
  if (PLUGIN_MODE && !agentType.startsWith(`${PLUGIN_NAME}:`)) return null;
  const name = agentType.split(':').pop();
  if (READ_ONLY.has(name) || BUILD.has(name)) return name;
  const suffix = name.split('-').slice(1).join('-');
  for (const cand of [suffix, name.split('-').pop()]) {
    const r = ALIASES[cand] || cand;
    if (READ_ONLY.has(r) || BUILD.has(r)) return r;
  }
  return null;
}

function deny(role, tool, reason, detail) {
  try {
    appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), guard: 'guard-roles', decision: 'deny', role, tool, reason, detail })}\n`);
  } catch {}
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `/do-shit role guard (${role}): ${reason}` },
  }));
  process.exit(0);
}

function toplevel(path) {
  let d = dirname(path);
  while (d !== '/' && !existsSync(d)) d = dirname(d);
  try {
    return execFileSync('git', ['-C', d, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

function allowedPaths(role, repoRoot) {
  const cfg = repoRoot && join(repoRoot.replace(/\/\.claude\/worktrees\/[^/]+$/, ''), '.claude/do-shit.json');
  if (cfg && existsSync(cfg)) {
    const c = JSON.parse(readFileSync(cfg, 'utf8'));
    if (c.allowed_paths?.[role]) return c.allowed_paths[role];
  }
  const f = agentFile(role);
  return f ? parseFrontmatter(readFileSync(f, 'utf8')).allowed_paths || ['**'] : ['**'];
}

const MUTATING_GIT = /\bgit\s+(?:-C\s+\S+\s+)?(commit|reset|checkout\s+(?:\S+\s+)?--|rebase|merge|cherry-pick|revert|am|apply|clean|restore|rm|mv|add|tag|branch\s+-[dDmM]|switch|worktree\s+(add|remove))\b/;
const EVERYONE = [
  [/\bgit\s+(?:-C\s+\S+\s+)?push\b/, 'only the orchestrator pushes'],
  [/\bgit\s+(?:-C\s+\S+\s+)?stash(?!\s+(list|show)\b)/, 'git stash is shared across worktrees; use a WIP commit'],
];
const READ_ONLY_BASH = [
  [MUTATING_GIT, 'read-only role: no mutating git'],
  [/\bsed\s+(-[a-zA-Z]*i|--in-place)/, 'read-only role: no in-place edits'],
  [/(^|[;&|]\s*|\s)(rm|mv)\s/, 'read-only role: no rm/mv'],
  [/(^|[^0-9&>])>{1,2}\s*(?![\s&/]|\$\{?TMPDIR|\/)[^\s;|&]+/, 'read-only role: no redirect into repo files (use /tmp)'],
];
// /review-prs reviewers read someone else's PR: nothing of it is checked out,
// and only the main session writes to GitHub, after the user says so.
const REVIEWER_BASH = [
  [/\bgh\s+(pr|issue)\s+(review|comment|edit|merge|close|create|ready|reopen|lock)\b/, 'reviewer never writes to GitHub'],
  [/\bgh\s+api\b[^|;&]*\s(-X\s*|--method[ =])(POST|PUT|PATCH|DELETE)\b/i, 'reviewer never writes to GitHub'],
  [/\bgh\s+api\b[^|;&]*\s(-f|-F|--field|--raw-field|--input)\b/, 'reviewer never writes to GitHub'],
  [/\bgit\s+(?:-C\s+\S+\s+)?(checkout|switch|worktree|pull)\b/, 'reviewer never checks the PR out'],
];

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const role = roleOf(input.agent_type);
  if (!role) return;
  const tool = input.tool_name;
  const ti = input.tool_input || {};

  if (tool === 'Bash') {
    const cmd = String(ti.command || '');
    for (const [re, why] of EVERYONE) if (re.test(cmd)) deny(role, tool, why, cmd.slice(0, 200));
    if (READ_ONLY.has(role)) for (const [re, why] of READ_ONLY_BASH) if (re.test(cmd)) deny(role, tool, why, cmd.slice(0, 200));
    if (role === 'reviewer') for (const [re, why] of REVIEWER_BASH) if (re.test(cmd)) deny(role, tool, why, cmd.slice(0, 200));
    return;
  }

  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const file = ti.file_path || ti.notebook_path;
    if (READ_ONLY.has(role)) deny(role, tool, 'read-only role cannot edit files', file);
    if (!file) return;
    if (!/\/\.claude\/worktrees\/ds-[^/]+\//.test(file)) deny(role, tool, 'edits are allowed only inside the team worktree (.claude/worktrees/ds-*)', file);
    const top = toplevel(file);
    if (!top) return;
    const rel = relative(top, file);
    const globs = allowedPaths(role, top);
    if (!anyMatch(globs, rel)) deny(role, tool, `${rel} is outside allowed_paths for ${role}`, rel);
  }
}

try {
  main();
} catch {
  // fail open; harness scope check is the backstop
}
