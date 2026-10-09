// How findings are worded, in chat and in the one PR comment. The comment is
// what a teammate reads: full sentences, blockers written out, no command
// output, no plan text, at most MAX_LINES lines.

import { RULES, severityOf, bySeverity } from './rules.mjs';
import { scrub } from './scrub.mjs';

export const MAX_LINES = 40;
const CAP = { blocker: 12, risk: 10, unchecked: 5 };

const one = (s, n) => {
  const t = scrub(String(s ?? '').replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// Text the agent wrote from a file or a PR must not turn into markup, a mention or a link.
export const plain = (s, n) => one(String(s ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)\]]+/gi, '(link removed)'), n).replace(/[`*<>[\]|{}]/g, '').replace(/@(?=\w)/g, '@ ');
// A code span that cannot be broken out of: no backtick, no line break, no control character.
export const code = (s) => `\`${String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/`/g, "'").slice(0, 240)}\``;
const loc = (f) => (f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : null);
const stop = (s) => (/[.!?…]$/.test(s) ? s : `${s}.`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// What a finding adds beyond its rule sentence.
function extras(f, env) {
  const out = [];
  if (f.detail) out.push(f.detail);
  if (f.window === 'old_code') out.push('Old code runs against this until the deploy finishes.');
  if (f.raised) out.push(`The table has about ${Number(f.raised.rows).toLocaleString('en-US')} rows.`);
  if (f.refs?.length) out.push(`Named at ${f.refs.slice(0, 3).map((r) => code(`${r.file}:${r.line}`)).join(', ')}${f.total > 3 ? ` (${f.total} places in all)` : ''}.`);
  if (f.applied_on_target) out.push(`It has already run on ${env || 'the target'}.`);
  if (f.outside_range) out.push('It is not part of this change, and it has not run on the target.');
  if (f.origin === 'diff' && f.bucket === 'infra') out.push('Read from the diff, not from a plan.');
  return out.length ? ` ${out.join(' ')}` : '';
}

// One full sentence for the comment.
export function sentence(f, env) {
  if (f.source === 'agent') return `${loc(f) ? `${code(loc(f))} ` : ''}${stop(plain(f.problem, 300))}`;
  const says = RULES[f.rule]?.says || f.rule;
  const subject = f.origin === 'plan' ? `Plan: ${code(String(f.normalized).replace(/^plan: /, ''))}` : [loc(f) && code(loc(f)), f.normalized && code(f.normalized)].filter(Boolean).join(' ');
  return `${subject}: ${says}.${extras(f, env)}`;
}

const MARK = { blocker: '🔴 blocker', risk: '🟡 risk', note: '🔵 note' };
// One compressed line for chat.
export function chatLine(f) {
  const where = f.file ? `${f.file}:L${f.line ?? '?'}` : f.origin === 'plan' ? 'plan' : 'target';
  if (f.source === 'agent') return `${MARK[severityOf(f)]}: ${where}: ${plain(f.problem, 300)}`;
  const tail = [f.window === 'old_code' && 'old code hits it during deploy', f.raised && `~${f.raised.rows} rows`, f.refs?.length && `named at ${f.refs.slice(0, 2).map((r) => `${r.file}:${r.line}`).join(', ')}${f.total > 2 ? ` +${f.total - 2}` : ''}`, f.detail, f.applied_on_target && 'already ran on target', f.outside_range && 'outside this change'].filter(Boolean);
  return `${MARK[severityOf(f)]}: ${where}: ${String(f.normalized).replace(/^plan: /, '')} — ${RULES[f.rule]?.says || f.rule}${tail.length ? ` (${tail.join('; ')})` : ''}`;
}

export const countsText = (c) => [c.blocker && plural(c.blocker, 'blocker'), c.risk && plural(c.risk, 'risk'), c.note && plural(c.note, 'note')].filter(Boolean).join(', ') || 'nothing found';

// -> { body, lines }
export function buildComment(run, target) {
  const r = target.review;
  const sorted = [...r.findings].sort(bySeverity);
  const of = (sev) => sorted.filter((f) => severityOf(f) === sev);
  const out = [`**Migration and infrastructure check: ${r.verdict}** · ${target.env ? code(target.env) : 'no target environment'} · ${code(target.head_sha.slice(0, 7))} · ${countsText(r.counts)}`, ''];
  const section = (title, items, cap, word) => {
    if (!items.length) return;
    out.push(`**${title}**`, ...items.slice(0, cap).map((i) => `- ${i}`));
    if (items.length > cap) out.push(`- …and ${plural(items.length - cap, `more ${word}`)}.`);
    out.push('');
  };
  section('Blockers', of('blocker').map((f) => sentence(f, target.env)), CAP.blocker, 'blocker');
  section('Risks', of('risk').map((f) => sentence(f, target.env)), CAP.risk, 'risk');
  section('Not checked', r.unchecked.map((u) => stop(plain(u, 240))), CAP.unchecked, 'item');
  const foot = `Run ${code(run.run_id)}. Rules read the diff${target.live?.results?.plan?.ok ? ' and a plan' : ''}; a person decides whether to push.`;
  const room = MAX_LINES - out.length - 2;
  const steps = r.runbook.lines;
  if (steps.length && room > 1) {
    const shown = steps.length > room - 1 ? steps.slice(0, room - 2) : steps;
    out.push('**Runbook**', ...shown.map((s) => `- ${s}`));
    if (shown.length < steps.length) out.push(`- …and ${plural(steps.length - shown.length, 'more step')}.`);
    out.push('');
  }
  out.push(foot);
  const body = out.slice(0, MAX_LINES);
  return { body: body.join('\n'), lines: body.length };
}

// Why a comment may not be posted for this target, or null.
export function refusal(run, target, live) {
  if (run.post === 'off' || run.no_post) return 'posting is off for this run';
  if (target.kind !== 'pr') return 'this target is a commit range, not a pull request: there is nowhere to post';
  if (!target.review) return 'nothing recorded for this target yet: call record first';
  if (target.review.verdict === 'nothing_to_check') return 'nothing to post: no migration or infrastructure change';
  if (target.posted) return `this run already posted to #${target.number}`;
  if (live && live.state !== 'OPEN') return `#${target.number} is ${String(live.state).toLowerCase()}`;
  if (live && live.head_sha !== target.head_sha) return `#${target.number} moved to ${live.head_sha.slice(0, 7)} since it was checked at ${target.head_sha.slice(0, 7)}: run the check again`;
  return null;
}
