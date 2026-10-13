// The primary sources for a conflict: which commits on each side touched the
// file, which pull request carried each base commit, and what else landed on
// the base since the two branches parted. The agent reads these before it
// proposes anything, and every resolution cites them; the citations are
// checked here against git, so a commit that was never read cannot be named.

import { git, tryGit, fullSha, inRange } from './git.mjs';
import { commitPr } from './github.mjs';

export const SHOWN = 10;
const SEP = '\x1f';
const END = '\x1e';

const squashNumber = (subject) => Number(/\(#(\d+)\)\s*$/.exec(subject)?.[1]) || null;
const log = (repo, range, extra = []) =>
  (tryGit(repo, ['log', `--format=%H${SEP}%s${SEP}%b${END}`, ...extra, range]) || '').split(END).map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [sha, subject, body = ''] = r.split(SEP);
    return { sha, subject, body };
  });

// Commits in from..to that changed `file`, newest first. Merge commits are left out.
export const fileCommits = (repo, from, to, file) =>
  (tryGit(repo, ['log', `--format=%H${SEP}%s`, '--no-merges', `${from}..${to}`, '--', file]) || '').split('\n').filter(Boolean).map((l) => {
    const [sha, subject] = l.split(SEP);
    return { sha, subject };
  });

// r: { merge_base, head_sha, base_sha }
// -> { pr_side: [{sha, subject}], base_side: [{sha, subject, pr?}], all: { pr: [sha], base: [sha] } }
export function fileSources(repo, slug, r, file, cache = new Map()) {
  const prSide = fileCommits(repo, r.merge_base, r.head_sha, file);
  const baseSide = fileCommits(repo, r.merge_base, r.base_sha, file);
  const carried = (c) => {
    if (!cache.has(c.sha)) {
      const n = squashNumber(c.subject);
      cache.set(c.sha, n ? { number: n, title: c.subject.replace(/\s*\(#\d+\)\s*$/, '') } : commitPr(repo, slug, c.sha));
    }
    return cache.get(c.sha);
  };
  return {
    pr_side: prSide.slice(0, SHOWN).map((c) => ({ sha: c.sha.slice(0, 10), subject: c.subject })),
    base_side: baseSide.slice(0, SHOWN).map((c) => {
      const pr = carried(c);
      return { sha: c.sha.slice(0, 10), subject: c.subject, ...(pr ? { pr } : {}) };
    }),
    ...(prSide.length > SHOWN || baseSide.length > SHOWN ? { more: { pr_side: Math.max(0, prSide.length - SHOWN), base_side: Math.max(0, baseSide.length - SHOWN) } } : {}),
    all: { pr: prSide.map((c) => c.sha), base: baseSide.map((c) => c.sha) },
  };
}

// What landed on the base since the branches parted.
// -> { commits, pull_requests: [{number, title}], renamed: [{from, to}] }
export function baseSince(repo, mergeBaseSha, baseSha) {
  const first = log(repo, `${mergeBaseSha}..${baseSha}`, ['--first-parent']);
  const prs = [];
  for (const c of first) {
    const merged = /^Merge pull request #(\d+) /.exec(c.subject);
    if (merged) prs.push({ number: Number(merged[1]), title: c.body.split('\n').find((l) => l.trim())?.trim().slice(0, 200) || c.subject });
    else if (squashNumber(c.subject)) prs.push({ number: squashNumber(c.subject), title: c.subject.replace(/\s*\(#\d+\)\s*$/, '').slice(0, 200) });
  }
  const renamed = (tryGit(repo, ['diff', '--name-status', '-M', '--diff-filter=R', mergeBaseSha, baseSha]) || '').split('\n').filter(Boolean).map((l) => {
    const [, from, to] = l.split('\t');
    return { from, to };
  });
  return { commits: first.length, pull_requests: prs.slice(0, 30), ...(prs.length > 30 ? { more_pull_requests: prs.length - 30 } : {}), renamed: renamed.slice(0, 50), ...(renamed.length > 50 ? { more_renamed: renamed.length - 50 } : {}) };
}

// A resolution names the commits it was read from, at least one per side
// that has any. Each must be a commit of that side's range, and one that
// changed this file when the side has such commits.
// cited: { pr: [sha], base: [sha] }   all: the file's full lists from fileSources
// -> { cited: { pr: [full sha], base: [full sha] } }; throws with the reason.
export function checkCitations(repo, r, file, all, cited) {
  const outSides = {};
  for (const [side, tipSha, label] of [['pr', r.head_sha, "the pull request's"], ['base', r.base_sha, "the base's"]]) {
    const given = Array.isArray(cited?.[side]) ? cited[side] : [];
    const known = all?.[side] || [];
    if (!given.length && known.length) throw new Error(`no commit cited from ${label} side: read \`${side}_side\` for ${file} and name the commit this resolution rests on`);
    outSides[side] = given.map((s) => {
      const sha = fullSha(repo, s);
      if (!sha) throw new Error(`${s} is not a commit`);
      // `known` was read from that range, so a commit on it needs no second look.
      if (known.includes(sha)) return sha;
      if (!inRange(repo, sha, r.merge_base, tipSha)) throw new Error(`${String(s).slice(0, 10)} is not one of ${label} commits since the branches parted`);
      if (known.length) throw new Error(`${String(s).slice(0, 10)} did not change ${file}`);
      return sha;
    });
  }
  return { cited: outSides };
}

// The commit an edit outside the conflicts answers to: any commit of either side.
export function checkEditSource(repo, r, s) {
  const sha = fullSha(repo, s);
  if (!sha) throw new Error(`${s} is not a commit`);
  if (!inRange(repo, sha, r.merge_base, r.head_sha) && !inRange(repo, sha, r.merge_base, r.base_sha)) throw new Error(`${String(s).slice(0, 10)} is not a commit of either side since the branches parted`);
  return sha;
}

export const subjectOf = (repo, sha) => git(repo, ['log', '-n', '1', '--format=%s', sha]);
