import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_NAME } from '../lib/paths.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '../../../../hooks/guard-roles.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'guard-roles-'));
const repo = join(tmp, 'r');
mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
const wt = join(repo, '.claude/worktrees/ds-cu-1-x');
mkdirSync(join(wt, 'docs'), { recursive: true });
mkdirSync(join(wt, 'src'), { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'b'], { cwd: wt }); // stand-in worktree with its own toplevel

const run = (payload, args = []) => {
  const out = execFileSync('node', [HOOK, ...args], { input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: wt, ...payload }) }).toString().trim();
  return out ? JSON.parse(out).hookSpecificOutput : null;
};
const denied = (r) => r?.permissionDecision === 'deny';

test('no agent_type (main thread) -> no opinion', () => {
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: '/etc/x' } }), null);
});

test('unknown agent types are ignored', () => {
  assert.equal(run({ agent_type: 'cavecrew-builder', tool_name: 'Write', tool_input: { file_path: join(repo, 'x') } }), null);
});

test('plugin mode guards only <plugin>:<role> agents', () => {
  const edit = { tool_name: 'Edit', tool_input: { file_path: join(wt, 'src/a.ts') } };
  assert.equal(run({ agent_type: 'tester', ...edit }, ['--plugin']), null);
  assert.ok(denied(run({ agent_type: `${PLUGIN_NAME}:tester`, ...edit }, ['--plugin'])));
  assert.ok(denied(run({ agent_type: `${PLUGIN_NAME}:worker`, tool_name: 'Bash', tool_input: { command: 'git push' } }, ['--plugin'])));
});

test('read-only role cannot edit', () => {
  assert.ok(denied(run({ agent_type: 'tester', tool_name: 'Edit', tool_input: { file_path: join(wt, 'src/a.ts') } })));
});

test('read-only role cannot run mutating commands, can run gates', () => {
  assert.ok(denied(run({ agent_type: 'auditor', tool_name: 'Bash', tool_input: { command: 'sed -i s/a/b/ src/a.ts' } })));
  assert.ok(denied(run({ agent_type: 'tester', tool_name: 'Bash', tool_input: { command: 'git commit -am x' } })));
  assert.ok(denied(run({ agent_type: 'tester', tool_name: 'Bash', tool_input: { command: 'echo hi > notes.txt' } })));
  assert.equal(run({ agent_type: 'tester', tool_name: 'Bash', tool_input: { command: 'pnpm test 2>&1 | tail -50 > /tmp/log' } }), null);
  assert.equal(run({ agent_type: 'tester', tool_name: 'Bash', tool_input: { command: 'git diff origin/main...HEAD --stat' } }), null);
});

test('build role: inside worktree + allowed_paths only', () => {
  assert.equal(run({ agent_type: 'docs-writer', tool_name: 'Write', tool_input: { file_path: join(wt, 'docs/a.md') } }), null);
  assert.ok(denied(run({ agent_type: 'docs-writer', tool_name: 'Write', tool_input: { file_path: join(wt, 'src/a.ts') } })));
  assert.equal(run({ agent_type: 'worker', tool_name: 'Edit', tool_input: { file_path: join(wt, 'src/a.ts') } }), null);
  // main checkout (not a ds-* worktree) is off limits
  assert.ok(denied(run({ agent_type: 'worker', tool_name: 'Edit', tool_input: { file_path: join(repo, 'src/a.ts') } })));
});

test('nobody pushes or stashes', () => {
  assert.ok(denied(run({ agent_type: 'worker', tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } })));
  assert.ok(denied(run({ agent_type: 'integrator', tool_name: 'Bash', tool_input: { command: 'git stash' } })));
  assert.equal(run({ agent_type: 'worker', tool_name: 'Bash', tool_input: { command: 'git commit -m "feat: x"' } }), null);
  assert.equal(run({ agent_type: 'worker', tool_name: 'Bash', tool_input: { command: 'git stash list' } }), null);
});

test('prefixed repo agent maps to its role', () => {
  assert.ok(denied(run({ agent_type: 'acme-researcher', tool_name: 'Write', tool_input: { file_path: join(wt, 'x.md') } })));
});

test('reviewer (/review-prs): read-only, no GitHub writes, no checkout', () => {
  const bash = (command, args = []) => run({ agent_type: args.length ? `${PLUGIN_NAME}:reviewer` : 'reviewer', tool_name: 'Bash', tool_input: { command } }, args);
  assert.ok(denied(run({ agent_type: 'reviewer', tool_name: 'Edit', tool_input: { file_path: join(wt, 'src/a.ts') } })));
  for (const cmd of [
    'git push origin HEAD', 'rm -rf src', 'gh pr review 7 --approve', 'gh pr comment 7 --body hi', 'gh pr merge 7',
    'gh api -X POST repos/o/r/pulls/7/reviews', 'gh api repos/o/r/pulls/7/reviews --method POST', 'gh api repos/o/r/issues/7/comments -f body=hi',
    'git checkout pr-branch', 'git -C /repo switch pr', 'git worktree add ../x abc123', 'git pull',
  ]) {
    assert.ok(denied(bash(cmd)), cmd);
    assert.ok(denied(bash(cmd, ['--plugin'])), `plugin: ${cmd}`);
  }
  for (const cmd of ['git -C /repo show abc123:src/a.ts', 'git grep -n token abc123 -- src', 'gh pr view 7 --json title', 'gh api repos/o/r/pulls/7/comments', 'git log --oneline -5']) {
    assert.equal(bash(cmd), null, cmd);
  }
  // The extra rules are the reviewer's alone.
  assert.equal(run({ agent_type: 'tester', tool_name: 'Bash', tool_input: { command: 'gh pr comment 7 --body hi' } }), null);
});
