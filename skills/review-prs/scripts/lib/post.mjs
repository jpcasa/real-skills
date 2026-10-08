// The two things a finding becomes: a line in the chat report and a comment
// on GitHub. Both are written here from checked fields, so no model rewrites a
// finding on its way out. Chat lines are terse; posted text is for teammates.

import { isSecurity } from './rules.mjs';

const MARK = { bug: '🔴', risk: '🟡', nit: '🔵', q: '❓' };
const label = (f) => (isSecurity(f) ? 'security' : f.severity);
const sentence = (s) => String(s || '').trim();

// <file>:L<line>: <mark> <severity>: <problem> <fix>
export function chatLine(f) {
  const more = f.also?.length ? ` (+${f.also.length} more here)` : '';
  const note = f.refuter_note ? ` [${f.refuter_note}]` : '';
  return `${f.file}:L${f.line}: ${isSecurity(f) ? MARK.bug : MARK[f.severity]} ${label(f)}: ${sentence(f.problem)} ${sentence(f.fix)}${more}${note}`.replace(/\s+/g, ' ').trim();
}

const one = (f) => `**${label(f)}** (${f.lens}): ${sentence(f.problem)}`;

export function commentBody(f) {
  const parts = [one(f)];
  if (sentence(f.fix)) parts.push(`Fix: ${sentence(f.fix)}`);
  if (f.also?.length) parts.push(['Also here:', ...f.also.map((a) => `- ${one(a)}${sentence(a.fix) ? ` Fix: ${sentence(a.fix)}` : ''}`)].join('\n'));
  if (f.refuter_note) parts.push(`_A second reviewer disagreed: ${f.refuter_note.replace(/^refuter disagrees: /, '')}_`);
  return parts.join('\n\n');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const DROP_TEXT = {
  citation: (n) => `${plural(n, 'finding')} failed the citation check`,
  already_raised: (n) => `${n} already raised in an earlier comment`,
  refuted: (n) => `${plural(n, 'bug')} refuted by a second reviewer`,
  nit_budget: (n) => `${plural(n, 'nit')} over the budget`,
  not_actionable: (n) => `${plural(n, 'minor finding')} judged not actionable`,
};
export const dropText = (dropped) => Object.entries(dropped).filter(([, n]) => n > 0).map(([k, n]) => DROP_TEXT[k](n));
export const ciText = (ci) => (ci.state === 'failing' ? `failing (${ci.failing.join(', ')})` : ci.state === 'none' ? 'no checks' : ci.state);

export const FOOTER =
  '_Produced by an automated reviewer (real-skills review-prs) and checked by the person posting it. Each citation was checked to exist at this commit; the reading of it is the reviewer\'s._';

export function reviewBody(pr, review) {
  const c = review.verdict.counts;
  const tally = [c.security && plural(c.security, 'security finding'), c.bug && plural(c.bug, 'bug'), c.risk && plural(c.risk, 'risk'), c.nit && plural(c.nit, 'nit'), c.q && plural(c.q, 'question')].filter(Boolean).join(', ') || 'no findings';
  const parts = [`Automated review of \`${pr.head_sha.slice(0, 7)}\`: **${review.verdict.verdict}** (${tally}). CI as read: ${ciText(pr.ci)}.`];
  if (review.verdict.partial) parts.push(`Partial review: ${review.verdict.partial_reasons.join('; ')}.`);
  if (review.scope_note) parts.push(review.scope_note);
  if (review.outside_diff.length) {
    parts.push(['### Outside the diff', ...review.outside_diff.map((f) => `- \`${f.file}:L${f.line}\` ${one(f)}${sentence(f.fix) ? ` Fix: ${sentence(f.fix)}` : ''}`)].join('\n'));
  }
  const drops = dropText(review.dropped);
  if (drops.length) parts.push(`Not shown: ${drops.join(', ')}.`);
  parts.push(FOOTER);
  return parts.join('\n\n');
}

// The event is a constant: this skill never approves or requests changes.
export const EVENT = 'COMMENT';
export function buildPayload(pr, review) {
  return {
    event: EVENT,
    commit_id: pr.head_sha,
    body: reviewBody(pr, review),
    comments: review.kept.map((f) => ({ path: f.file, line: f.line, side: 'RIGHT', body: commentBody(f) })),
  };
}

// live: the PR as GitHub has it now. -> reason string, or null when posting is allowed.
export function refusal(pr, review, live) {
  if (!review) return 'this PR has no recorded review in the run';
  if (review.posted) return `this run already posted to #${pr.number} (${review.posted.url})`;
  if (live.state !== 'OPEN') return `#${pr.number} is ${live.state.toLowerCase()}`;
  if (live.head_sha !== pr.head_sha) return `#${pr.number} moved from ${pr.head_sha.slice(0, 7)} to ${live.head_sha.slice(0, 7)} since it was reviewed: run the review again`;
  if (!review.kept.length && !review.outside_diff.length) return 'nothing to post: no finding survived';
  return null;
}
