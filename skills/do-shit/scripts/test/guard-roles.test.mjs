import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
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
    'gh pr checkout 7', 'gh pr update-branch 7', 'gh issue delete 3', 'git checkout pr-branch', 'git -C /repo switch pr', 'git worktree add ../x abc123', 'git pull',
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

test('designer (/improve-design): may also edit inside an id-* worktree, held to the run\'s ui_paths', () => {
  // Resolved, as git reports it: a list anchored at the repo root has to match from there.
  const run2 = join(realpathSync(repo), '.claude/worktrees/id-20261009-1034-ab12');
  mkdirSync(join(run2, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'b'], { cwd: run2 });
  const edit = (agent_type, file, args = []) => run({ agent_type, tool_name: 'Edit', tool_input: { file_path: file } }, args);
  assert.equal(edit('designer', join(run2, 'src/a.tsx')), null);
  assert.equal(edit(`${PLUGIN_NAME}:designer`, join(run2, 'src/a.css'), ['--plugin']), null);
  // Its own allowed_paths still hold there, and so does everything outside a worktree.
  assert.ok(denied(edit('designer', join(run2, 'src/api.ts'))));
  assert.ok(denied(edit('designer', join(repo, 'src/a.tsx'))));
  assert.ok(denied(edit('designer', join(repo, '.claude/worktrees/other/src/a.tsx'))));
  // Only the designer: a design run has no other build role.
  assert.ok(denied(edit('worker', join(run2, 'src/a.tsx'))));
  // The repo's own list replaces the default one inside a design run.
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude/improve-design.json'), JSON.stringify({ ui_paths: ['src/**/*.html'] }));
  assert.equal(edit('designer', join(run2, 'src/page.html')), null);
  assert.ok(denied(edit('designer', join(run2, 'src/a.tsx'))));
  assert.equal(edit('designer', join(wt, 'src/a.tsx')), null, 'a /do-shit worktree is not affected by it');
});

test('design-critic (/improve-design): cannot edit, push, check out or write to GitHub', () => {
  const bash = (command, args = []) => run({ agent_type: args.length ? `${PLUGIN_NAME}:design-critic` : 'design-critic', tool_name: 'Bash', tool_input: { command } }, args);
  assert.ok(denied(run({ agent_type: `${PLUGIN_NAME}:design-critic`, tool_name: 'Write', tool_input: { file_path: join(repo, '.claude/worktrees/id-20261009-1034-ab12/src/a.tsx') } }, ['--plugin'])));
  for (const cmd of ['git push origin HEAD', 'git commit -am x', 'git checkout main', 'gh pr create --title x', 'gh pr comment 7 --body hi', 'gh api -X POST repos/o/r/pulls', 'rm -rf src', 'sed -i s/a/b/ src/a.tsx']) {
    assert.ok(denied(bash(cmd)), cmd);
    assert.ok(denied(bash(cmd, ['--plugin'])), `plugin: ${cmd}`);
  }
  // It compares two pictures without knowing which is newer: the run's state and the branch history both say which.
  for (const cmd of ['git -C /repo log --oneline -5', 'git diff HEAD~1 --stat', 'git show HEAD', 'cat ~/.claude/state/improve-design/id-20261009-1034-ab12/run.json', 'jq .moves /Users/x/.claude/state/improve-design/id-1/run.json']) {
    assert.ok(denied(bash(cmd)), cmd);
    assert.ok(denied(bash(cmd, ['--plugin'])), `plugin: ${cmd}`);
  }
  for (const cmd of ['cat src/a.tsx', 'git -C /repo status --short', 'ls src', 'grep -rn aria-label src']) assert.equal(bash(cmd), null, cmd);
  // The reviewer of a pull request reads history; that rule is the critic's alone.
  assert.equal(run({ agent_type: 'reviewer', tool_name: 'Bash', tool_input: { command: 'git log --oneline -5' } }), null);
});

test('a path is resolved before it is judged: ".." does not lead out of a worktree', () => {
  const run2 = join(realpathSync(repo), '.claude/worktrees/id-20261009-1034-ab12');
  const edit = (agent_type, file) => run({ agent_type, tool_name: 'Edit', tool_input: { file_path: file } });
  assert.ok(denied(edit('designer', `${run2}/../../../src/a.tsx`)));
  assert.ok(denied(edit('designer', `${run2}/src/../../../../../etc/hosts`)));
  assert.ok(denied(edit('worker', `${wt}/../../../src/a.ts`)));
  assert.equal(edit('worker', `${wt}/src/../src/a.ts`), null);
});

test('an improve-design config that cannot be read allows nothing in a design run', () => {
  const run2 = join(realpathSync(repo), '.claude/worktrees/id-20261009-1034-ab12');
  writeFileSync(join(repo, '.claude/improve-design.json'), '{ not json');
  assert.ok(denied(run({ agent_type: 'designer', tool_name: 'Edit', tool_input: { file_path: join(run2, 'src/page.html') } })));
});
