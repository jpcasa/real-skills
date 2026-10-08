// The evidence comment for one item, built from recorded results only. It is
// what a teammate reads on the ticket or the PR: full sentences, no row
// values, no command output, at most MAX_LINES lines before any screenshots.

import { existsSync } from 'node:fs';
import { itemStatus, tally } from './status.mjs';
import { signal } from './runner.mjs';
import { scrub } from './scrub.mjs';

export const MAX_LINES = 12;
export const MAX_SHOTS = 6;

const one = (s, n) => {
  const t = scrub(String(s ?? '').replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// Text that came from a page or a ticket must not turn into markup or a mention.
const plain = (s, n) => one(s, n).replace(/[`*_<>[\]|]/g, '').replace(/@(?=\w)/g, '@ ');

export const destinationOf = (item) => item.destination || null;

function how(checks) {
  const by = {};
  for (const c of checks) by[c.method] = (by[c.method] || 0) + 1;
  return Object.entries(by).map(([m, n]) => {
    if (m === 'database' && n === 1 && typeof checks.find((c) => c.method === m).evidence?.rows === 'number') return `database: ${checks.find((c) => c.method === m).evidence.rows} rows`;
    if (m === 'browser') return `browser, ${n} step${n === 1 ? '' : 's'}`;
    if (m === 'checks' || m === 'new_tests') return n === 1 ? 'test' : `${n} tests`;
    return n === 1 ? m : `${m} ×${n}`;
  }).join('; ');
}

// One line per criterion: failed first, then not tested, then passed.
export function criterionLines(item) {
  const failed = [];
  const untested = [];
  const passed = [];
  for (const k of item.criteria || []) {
    const checks = (item.checks || []).filter((c) => c.criterion === k.id && !c.weak);
    const bad = checks.find((c) => c.result === 'fail');
    const text = plain(k.text, 110);
    if (bad) failed.push(`- ❌ ${text}: ${plain(signal(bad), 110) || 'failed'} (${bad.method}${bad.environmental ? ', looks environmental' : ''})`);
    else if (!checks.length) untested.push(`- ⚪ Not tested: ${text} (${plain(item.why_uncovered?.[k.id], 80) || 'no check ran for it'})`);
    else if (checks.some((c) => c.result !== 'pass')) untested.push(`- ⚪ Not finished: ${text} (${plain(checks.find((c) => c.result !== 'pass').evidence?.reason, 80) || 'a check did not run'})`);
    else passed.push(`- ✅ ${text} (${how(checks)})`);
  }
  return [...failed, ...untested, ...passed];
}

// Screenshots worth attaching: every failed step, then the last step of each
// passed criterion. Only files that exist.
export function pickShots(item) {
  const shots = (item.checks || []).filter((c) => c.method === 'browser' && c.evidence?.screenshot && existsSync(c.evidence.screenshot));
  const failed = shots.filter((c) => c.result === 'fail');
  const lastPassed = new Map();
  const bad = new Set((item.checks || []).filter((c) => c.result === 'fail').map((c) => c.criterion));
  for (const c of shots) if (c.result === 'pass' && !bad.has(c.criterion)) lastPassed.set(c.criterion, c);
  return [...failed, ...lastPassed.values()].slice(0, MAX_SHOTS).map((c) => ({ path: c.evidence.screenshot, caption: plain(c.action, 60) || 'step' }));
}

// -> { body, lines, attachments }
export function buildComment(run, item, { screenshots = false } = {}) {
  const status = itemStatus(item);
  const t = tally(item.checks || []);
  const head = `**QA: ${status}** · ${run.env || 'no environment'} · \`${item.sha || run.sha || 'unknown commit'}\` · ${t.passed} of ${t.total} checks passed`;
  const foot = [];
  if (item.blocked) foot.push(`Blocked: ${plain(item.blocked, 140)}`);
  const tests = (run.new_tests || []).filter((p) => (item.checks || []).some((c) => (c.files || []).includes(p)));
  if (tests.length) foot.push(`New tests, uncommitted: ${tests.slice(0, 4).map((p) => `\`${p}\``).join(', ')}${tests.length > 4 ? ` and ${tests.length - 4} more` : ''}`);
  foot.push(`${run.report_path ? `Report: \`${run.report_path}\` · ` : ''}run \`${run.run_id}\``);
  const room = MAX_LINES - 2 - foot.length - 1;
  let lines = criterionLines(item);
  if (lines.length > room) lines = [...lines.slice(0, room - 1), `- …and ${lines.length - (room - 1)} more, all in the report`];
  const body = [head, '', ...lines, '', ...foot];
  const attachments = screenshots ? pickShots(item) : [];
  const images = attachments.map((a) => `![${a.caption}]({{shot:${a.path}}})`);
  return { body: [...body, ...(images.length ? ['', ...images] : [])].join('\n'), lines: body.length, attachments };
}
