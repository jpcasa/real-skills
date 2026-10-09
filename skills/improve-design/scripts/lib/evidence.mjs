// Opt-in: the before and after pictures, pushed to the orphan branch
// `design-evidence` so the pull request can show them. Built with git plumbing
// in the object store: no checkout, no worktree, nothing else on that branch
// is touched. A picture pushed to a repository stays in its history, which is
// why this only happens after a yes.

import { git, tryGit } from './git.mjs';

export const BRANCH = 'design-evidence';

// origin's "owner/name", from its URL. -> string or null
export function slugOf(repo) {
  // The URL as written in the config, before any rewrite rule.
  const url = tryGit(repo, ['config', '--get', 'remote.origin.url']) || '';
  return url.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)?.[1] || null;
}

// files: [{name, path}] -> { branch, commit, links: {name: url} }
export function publish(repo, runId, files) {
  const slug = slugOf(repo);
  if (!slug) throw new Error('origin is not a GitHub repository');
  if (!files.length) throw new Error('no pictures to publish');
  tryGit(repo, ['fetch', '--quiet', 'origin', BRANCH]);
  const parent = tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${BRANCH}`]);
  const folder = git(repo, ['mktree'], files.map((f) => `100644 blob ${git(repo, ['hash-object', '-w', '--', f.path])}\t${f.name}`).join('\n') + '\n');
  const kept = parent ? git(repo, ['ls-tree', parent]).split('\n').filter((l) => l && !l.endsWith(`\t${runId}`)) : [];
  const tree = git(repo, ['mktree'], [...kept, `040000 tree ${folder}\t${runId}`].join('\n') + '\n');
  const commit = git(repo, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `design evidence for ${runId}`]);
  git(repo, ['push', '--quiet', 'origin', `${commit}:refs/heads/${BRANCH}`]);
  return { branch: BRANCH, commit, links: Object.fromEntries(files.map((f) => [f.name, `https://github.com/${slug}/blob/${commit}/${runId}/${encodeURIComponent(f.name)}?raw=true`])) };
}
