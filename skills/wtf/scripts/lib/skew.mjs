// Deploy skew: is the fix merged, and is it in the environment the report
// came from? Pure git, plus `gh` to turn a PR number into its merge commit.
// "Fixed on main, not yet promoted" is the commonest false alarm, and it is a
// fact about commits, so code answers it.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const ok = (repo, args) => {
  try {
    git(repo, args);
    return true;
  } catch {
    return false;
  }
};

// -> { state: OPEN|MERGED|CLOSED, sha: merge commit or null }
function prFacts(repo, pr) {
  if (process.env.WTF_GH_STUB && existsSync(process.env.WTF_GH_STUB)) {
    const hit = JSON.parse(readFileSync(process.env.WTF_GH_STUB, 'utf8'))[String(pr)];
    if (hit) return hit;
  }
  const j = JSON.parse(execFileSync('gh', ['pr', 'view', String(pr), '--json', 'state,mergeCommit'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  return { state: j.state, sha: j.mergeCommit?.oid || null };
}

// Prefer the remote-tracking branch: a stale local branch gives a wrong answer.
const branchRef = (repo, name) => [`origin/${name}`, name].find((r) => ok(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${r}^{commit}`])) || null;

// release: { mode: promotion|tags, main_branch, production_branch, tag_pattern }
// environment: where the report came from; anything but staging/dev/local counts as production.
export function skew({ repo, ref = null, pr = null, release = {}, environment = 'production' }) {
  const out = { exists: false, merged: false, in_main: false, in_production: false, in_env: false, sha: null, detail: '' };
  let sha = null;
  if (pr != null) {
    let f;
    try {
      f = prFacts(repo, pr);
    } catch (e) {
      return { ...out, detail: `could not read PR ${pr}: ${e.message.split('\n')[0]}` };
    }
    out.exists = f.state === 'OPEN' || f.state === 'MERGED';
    if (f.state !== 'MERGED' || !f.sha) return { ...out, detail: `PR ${pr} is ${String(f.state).toLowerCase()}, not merged` };
    sha = f.sha;
  } else if (ref) {
    sha = ref;
  } else return { ...out, detail: 'no fix commit or PR given' };

  try {
    // --end-of-options: a "ref" that starts with a dash is a name, never a flag.
    sha = git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${sha}^{commit}`]);
  } catch {
    return { ...out, exists: pr != null, detail: `commit ${String(sha).slice(0, 12)} is not in this clone (fetch first)` };
  }
  out.exists = true;
  out.sha = sha;

  const main = branchRef(repo, release.main_branch || 'main');
  out.in_main = Boolean(main) && ok(repo, ['merge-base', '--is-ancestor', sha, main]);
  out.merged = out.in_main || pr != null;

  if (release.mode === 'tags') {
    const tags = git(repo, ['tag', '--contains', sha, '--list', release.tag_pattern || 'v*']).split('\n').filter(Boolean);
    out.in_production = tags.length > 0;
    out.detail = out.in_production ? `released in ${tags[0]}` : `not in any ${release.tag_pattern || 'v*'} tag yet`;
  } else {
    const prod = branchRef(repo, release.production_branch || '');
    if (!release.production_branch) {
      // No production branch configured: main is what ships.
      out.in_production = out.in_main;
      out.detail = 'no production branch configured; treating main as production';
    } else if (!prod) {
      out.detail = `production branch ${release.production_branch} not found in this clone`;
    } else {
      out.in_production = ok(repo, ['merge-base', '--is-ancestor', sha, prod]);
      out.detail = out.in_production ? `in ${release.production_branch}` : `on ${release.main_branch || 'main'}, not yet in ${release.production_branch}`;
    }
  }
  const nonProd = ['staging', 'preview', 'dev', 'development', 'local'].includes(String(environment).toLowerCase());
  out.in_env = nonProd ? out.in_main : out.in_production;
  return out;
}
