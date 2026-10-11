// Every GitHub call /improve-design makes: reading one pull request, and
// opening one. It never approves, merges, comments or edits.
//
// IMPROVE_DESIGN_GH_STUB (tests) points at a JSON file that answers the `gh`
// calls: { prs: { "<n>": {...} }, create: { url } }. Each write is appended to
// `<stub>.calls` instead of being made.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const stubPath = () => process.env.IMPROVE_DESIGN_GH_STUB || null;
const stub = () => JSON.parse(readFileSync(stubPath(), 'utf8'));
const gh = (cwd, args) => execFileSync('gh', args, { cwd, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// -> { number, state, url, head, base, merged } or null
export function viewPr(repo, n) {
  const fields = 'number,state,url,headRefName,baseRefName,mergedAt,isCrossRepository';
  let v;
  try {
    v = stubPath() ? stub().prs?.[String(n)] : JSON.parse(gh(repo, ['pr', 'view', String(n), '--json', fields]));
  } catch {
    return null;
  }
  if (!v) return null;
  return { number: v.number, state: v.state, url: v.url, head: v.headRefName, base: v.baseRefName, merged: Boolean(v.mergedAt) || v.state === 'MERGED', fork: v.isCrossRepository === true };
}

// -> url
export function createPr(cwd, { head, base, title, bodyFile, draft, labels = [] }) {
  const args = ['pr', 'create', '--head', head, '--base', base, '--title', title, '--body-file', bodyFile, ...(draft ? ['--draft'] : []), ...labels.flatMap((l) => ['--label', l])];
  if (stubPath()) {
    appendFileSync(`${stubPath()}.calls`, `${JSON.stringify({ args, body: readFileSync(bodyFile, 'utf8') })}\n`);
    return stub().create?.url || 'https://github.com/acme/app/pull/1';
  }
  return gh(cwd, args).trim().split('\n').pop();
}
