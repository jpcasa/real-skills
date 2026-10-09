// The report: one short file saying what was checked, what each item's status
// is and what to do about a failure. At most MAX_LINES lines; the full record
// stays in the run folder.

import { itemStatus, tally } from './status.mjs';
import { signal } from './runner.mjs';
import { scrub } from './scrub.mjs';
import { safeId } from './items.mjs';
import { today } from './state.mjs';

export const MAX_LINES = 60;
const one = (s, n) => {
  const t = scrub(String(s ?? '').replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const cell = (s, n) => one(s, n).replace(/\|/g, '/');
const more = (list, cap, render, tail) => [...list.slice(0, cap).map(render), ...(list.length > cap ? [tail(list.length - cap)] : [])];

export function reportPath(run) {
  const first = run.items[0] || {};
  const slug = safeId(String(first.title || first.ref || 'qa').toLowerCase()).slice(0, 40) || 'qa';
  return `${run.report_dir}/${today(new Date(run.created_at))}-${slug}-${run.run_id.slice(-4)}.md`;
}

const label = (item) => `${item.kind === 'text' ? '' : `${item.ref} `}${one(item.title, 60)}`.trim() || item.id;
const evidenceCell = (item, post) => {
  if (post?.result === 'posted') return post.url ? `[comment](${post.url})` : 'comment posted';
  if (post?.result === 'not_posted') return `not posted: ${one(post.reason, 40) || 'see chat'}`;
  return item.destination ? 'not posted' : 'report only';
};

function draft(item, bad) {
  const steps = item.checks.filter((c) => c.method === bad.method && c.criterion === bad.criterion);
  const upTo = steps.slice(0, steps.indexOf(bad) + 1);
  return [
    `Bug draft: **${one(bad.action, 70)} does not ${one(bad.expected, 60)}**`,
    `- Repro: ${upTo.map((c, n) => `${n + 1}. ${one(c.action, 80)}`).join(' ')}`,
    `- Expected: ${one(bad.expected, 140)}`,
    `- Actual: ${one(signal(bad), 140) || 'failed'}`,
    `- Evidence: ${bad.evidence?.screenshot || bad.evidence?.log || `${bad.method} check ${bad.id}`}`,
  ];
}

// -> { path, text, lines }
export function buildReport(run) {
  const items = run.items;
  const posts = run.posts || {};
  const out = [
    `# QA report: ${one(items.map(label).join(', '), 90)}`,
    '',
    `${today(new Date(run.created_at))} · environment ${run.env || 'none'} · commit \`${run.sha || 'unknown'}\` · run \`${run.run_id}\``,
    '',
    '| Item | Status | Checks passed | Evidence |',
    '|---|---|---|---|',
    ...items.map((it) => {
      const t = tally(it.checks || []);
      return `| ${cell(label(it), 70)} | ${itemStatus(it)} | ${t.passed} of ${t.total} | ${evidenceCell(it, posts[it.id])} |`;
    }),
  ];

  const failed = items.filter((it) => itemStatus(it) === 'failed');
  if (failed.length) out.push('', '## Failed');
  let drafts = 0;
  for (const it of failed) {
    const bad = it.checks.filter((c) => c.result === 'fail');
    out.push('', `**${label(it)}**`, ...more(bad, 3, (c) => `- ❌ ${one(c.action, 70)}. Expected: ${one(c.expected, 70)}. Actual: ${one(signal(c), 70) || 'failed'} (${c.method})`, (n) => `- …and ${n} more failed checks`));
    if (drafts++ < 2) out.push('', ...draft(it, bad[0]));
  }

  const untested = [];
  for (const it of items) {
    if (it.dropped) untested.push(`- ${label(it)}: dropped at the plan`);
    else if (it.blocked) untested.push(`- ${label(it)}: blocked, ${one(it.blocked, 100)}`);
    for (const k of it.criteria || []) {
      const checks = (it.checks || []).filter((c) => c.criterion === k.id && !c.weak);
      if (!checks.length) untested.push(`- ${label(it)}: ${one(k.text, 80)} (${one(it.why_uncovered?.[k.id], 60) || 'no check ran for it'})`);
      else if (!checks.some((c) => c.result === 'fail') && checks.some((c) => c.result !== 'pass')) untested.push(`- ${label(it)}: ${one(k.text, 80)} (${one(checks.find((c) => c.result !== 'pass').evidence?.reason, 60) || 'a check did not run'})`);
    }
  }
  if (untested.length) out.push('', '## Not tested', ...more(untested, 8, (l) => l, (n) => `- …and ${n} more`));

  const unavailable = new Map();
  for (const it of items) for (const u of it.unavailable || []) unavailable.set(u.method, u.reason);
  if (unavailable.size) out.push('', '## Methods that could not run', ...[...unavailable].map(([m, why]) => `- ${m}: ${one(why, 120)}`));

  if (run.new_tests?.length) out.push('', '## New tests (uncommitted)', ...more(run.new_tests, 6, (p) => `- \`${p}\``, (n) => `- …and ${n} more`), 'Keep, commit or delete them: this skill did not commit anything.');
  if (run.test_violations?.length) out.push('', '## Changed outside the test folders', ...more(run.test_violations, 4, (v) => `- \`${v.path}\`: ${v.why}`, (n) => `- …and ${n} more`));

  if (run.ignored_changed?.length) out.push('', '## Ignored files that changed while tests were written', ...more(run.ignored_changed, 4, (p) => `- \`${p}\``, (n) => `- …and ${n} more`), 'Git ignores these, so they are noted and not counted against the new tests.');

  const refs = items.map((it) => (it.kind === 'text' ? one(it.ref, 80).replace(/[`"]/g, '') : it.ref)).join(' ');
  out.push('', '## Rerun', `\`/real-skills:qa-this ${refs}${run.env ? ` --env ${run.env}` : ''}\``);

  const lines = out.length > MAX_LINES ? [...out.slice(0, MAX_LINES - 1), `…cut at ${MAX_LINES} lines. Full results: run \`${run.run_id}\`.`] : out;
  return { path: run.report_path || reportPath(run), text: `${lines.join('\n')}\n`, lines: lines.length };
}
