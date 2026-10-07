// Deterministic spawn prompts. The orchestrator passes these files verbatim.
// Independence rule: tester/reviewer prompts never include builder self-reports.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDir } from './state.mjs';
import { READ_ONLY_ROLES, REVIEW_ROLES } from './policy.mjs';

import { REPORT_SCHEMA as SCHEMA, SKILL_DIR } from './paths.mjs';
import { CAPS } from './caps.mjs';

const STYLE = join(SKILL_DIR, 'references/report-style.md');

const list = (xs) => (xs?.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none)');

function itemBlock(item) {
  return [
    `## Item ${item.ref} — ${item.title}`,
    item.url ? `URL: ${item.url}` : '',
    '',
    item.body || '(no description)',
    '',
    '### Acceptance criteria (from the tracker)',
    list(item.acceptance_criteria),
    item.comments?.length ? `\n### Comments\n${item.comments.map((c) => `- ${c.author}: ${c.body}`).join('\n')}` : '',
  ].filter((l) => l !== '').join('\n');
}

function planBlock(plan) {
  if (!plan) return '';
  return [
    '## Approved plan',
    plan.summary || '',
    '',
    '### Files',
    list(plan.files),
    '### Acceptance criteria',
    list(plan.acceptance_criteria),
    '### Test plan',
    list(plan.test_plan),
    plan.risks?.length ? `### Risks\n${list(plan.risks)}` : '',
  ].join('\n');
}

const reportContract = (role, item, loop) => `## Report (required)
Your final message is exactly one fenced \`\`\`json block matching ${SCHEMA}, and nothing else: no prose above or below it.
Set "role": "${role}", "item": "${item.ref}", "loop": ${loop}. Every finding needs "owner_role" (the role that should fix it) and "blocking" (true only if it must be fixed before shipping).
Write it in the style of ${STYLE}: "summary" at most ${CAPS.summary} characters, each finding "text" at most ${CAPS.finding}, each plan list item at most ${CAPS.plan_item}. Keep paths, commands and error text exact. A security finding starts its "text" with "SECURITY:" and is written in full sentences, with no length cap.`;

// spawn: { role, agent, name, loop, worktree, branch, base_ref, verify, item, plan, contract, failures, notes, extra }
export function buildPrompt(runId, s) {
  const parts = [
    `You are the ${s.role} on a /do-shit team.`,
    s.worktree ? `Worktree (absolute; work ONLY here): ${s.worktree}\nBranch: ${s.branch}\nBase: ${s.base_ref}` : `Repo root: ${s.repo}`,
    s.verify ? `Verify/gate command: \`${s.verify}\`` : '',
    `Loop: ${s.loop}`,
    '',
    itemBlock(s.item),
  ];
  if (s.notes) parts.push('', `## Notes from the user\n${s.notes}`);
  if (s.contract) parts.push('', `## Shared contract (architect)\n${s.contract}`);

  if (s.role === 'investigator') {
    if (s.failures?.length) {
      parts.push('', '## Replan: the previous plan failed review', s.failures.map((f) => `- [${f.from}] ${f.file ? `${f.file}:${f.line ?? ''} ` : ''}${f.text}`).join('\n'));
    }
    parts.push('', 'Validate the premise against the current code first (cite path:line). Then fill the report `plan` fields.');
  } else if (REVIEW_ROLES.includes(s.role)) {
    // Blind review: plan AC only, never builder reports.
    parts.push('', '### Acceptance criteria from the plan', list(s.plan?.acceptance_criteria), '', `Review the branch diff: \`git -C ${s.worktree} diff ${s.base_ref}...HEAD\`. Re-derive "done" from the item yourself.`);
  } else {
    parts.push('', planBlock(s.plan));
    if (s.failures?.length) {
      parts.push('', `## Fix these (loop ${s.loop}) — routed to ${s.role}`, s.failures.map((f, i) => `${i + 1}. [${f.from}] ${f.file ? `${f.file}:${f.line ?? ''} ` : ''}${f.text}`).join('\n'), '', 'Fix them, rerun the gates, commit, report again.');
    }
    if (!READ_ONLY_ROLES.has(s.role)) parts.push('', 'Commit your slice before reporting. Commit only files inside your allowed_paths.');
  }
  if (s.extra) parts.push('', s.extra);
  parts.push('', reportContract(s.role, s.item, s.loop));

  const dir = join(runDir(runId), 'prompts');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${s.name}-L${s.loop}.md`);
  writeFileSync(file, parts.filter((p) => p !== undefined).join('\n'));
  return file;
}
