// The promotion pull request: its title and its body. The body is what a
// teammate reads on GitHub, so it is full sentences, built here from what the
// script recorded, and never reworded by the agent. PR titles come from commit
// messages: they are data, and may not turn into markup, a mention or a link.

import { scrub } from './scrub.mjs';

export const MAX_BODY_PRS = 50;
const CAP = { blockers: 12, risks: 10, unchecked: 5, runbook: 20 };

const cut = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const one = (s, n) => cut(scrub(flat(s)), n);
// A sentence this script wrote about branches and checks: no markup can come out of it, and its numbers stay.
const own = (s, n) => cut(flat(s).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)\]]+/gi, '(link removed)').replace(/[`*<>[\]|{}]/g, '').replace(/@(?=\w)/g, '@ '), n);
export const plain = (s, n) => one(String(s ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)\]]+/gi, '(link removed)'), n).replace(/[`*<>[\]|{}]/g, '').replace(/@(?=\w)/g, '@ ').replace(/#(?=\d)/g, '# ');
// A code span that cannot be broken out of: no backtick, no line break (the two Unicode line separators included), no control character.
const BREAKS = new RegExp(`[\\x00-\\x1f\\x7f${String.fromCharCode(0x2028, 0x2029)}]+`, 'g');
export const code = (s) => `\`${String(s).replace(BREAKS, ' ').replace(/`/g, "'").slice(0, 120)}\``;
const short = (sha) => String(sha).slice(0, 7);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const titleOf = (run) => `Promote ${run.source.env} to ${run.target.env}`;

// -> { title, body, lines }
export function buildBody(run) {
  const { source, target, infra } = run;
  const out = [
    `Promotes ${code(source.branch)} (${code(short(source.sha))}) to ${code(target.branch)} (${code(short(target.sha))}): ${plural(run.commits, 'commit')}, ${plural(run.prs.length + (run.more_prs || 0), 'pull request')}.${run.production ? ' **Merging this deploys to production.**' : ''}`,
    '',
  ];
  const section = (title, items, cap, word) => {
    if (!items.length) return;
    out.push(`**${title}**`, ...items.slice(0, cap).map((i) => `- ${i}`));
    if (items.length > cap) out.push(`- …and ${plural(items.length - cap, `more ${word}`)}.`);
    out.push('');
  };
  const prs = run.prs.map((p) => `#${p.number}${p.title ? ` ${plain(p.title, 120)}` : ''}`);
  if (run.more_prs) prs.push(`…and ${plural(run.more_prs, 'more pull request')}.`);
  section('Pull requests (read from commit subjects)', prs, MAX_BODY_PRS, 'pull request');

  if (infra?.state === 'recorded' && infra.verdict !== 'nothing_to_check') {
    out.push(`**Migrations and infrastructure: ${infra.verdict}** (check run ${code(infra.run)})`, '');
    const accepted = run.accepted && JSON.stringify(run.accepted.blockers || []) === JSON.stringify(infra.blockers || []);
    section(accepted ? 'Blockers, accepted for this promotion by the person who ran it' : 'Blockers', infra.blockers || [], CAP.blockers, 'blocker');
    section('Risks', infra.risks || [], CAP.risks, 'risk');
    section('Not checked', (infra.unchecked || []).map((u) => plain(u, 240)), CAP.unchecked, 'item');
    section('Runbook', infra.runbook || [], CAP.runbook, 'step');
  } else if (infra?.state === 'recorded') out.push('**Migrations and infrastructure:** no migration or infrastructure change in this range.', '');
  else out.push(`**Migrations and infrastructure:** not checked${infra?.reason ? ` (${plain(infra.reason, 160)})` : ''}.`, '');

  const notable = Object.entries(run.gates).filter(([, v]) => v.status !== 'pass').map(([k, v]) => `${code(k)} ${v.status}: ${own(v.says, 300)}.`);
  section('Open points', notable, 8, 'point');
  out.push(`Run ${code(run.run_id)} of /real-skills:promote. A person approved opening this pull request; merging needs a second, separate approval.`);
  return { title: titleOf(run), body: out.join('\n'), lines: out.length };
}
