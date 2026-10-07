// Length caps for role reports (references/report-style.md). A report that
// breaks a cap is re-asked once and then accepted: length never fails a role.

export const CAPS = {
  prose: 200, // text before the ```json block
  summary: 300,
  finding: 240,
  plan_summary: 600,
  plan_item: 200,
};

const PLAN_LISTS = ['files', 'acceptance_criteria', 'test_plan', 'risks', 'open_questions'];
// Security is never compressed. The architect's plan is the contract builders
// receive verbatim, and the qa-planner's is the step list the qa-tester runs.
const EXEMPT_ROLES = new Set(['security-advisor']);
const VERBATIM_PLAN_ROLES = new Set(['architect', 'qa-planner']);
const isSecurity = (f) => /^\s*security\b/i.test(f.text || '');

export function proseLength(text) {
  const open = text.search(/```json[ \t]*\r?\n/);
  return (open === -1 ? text : text.slice(0, open)).trim().length;
}

// -> { ok, over: [{ field, len, cap }] }
export function checkCaps(text, report) {
  const over = [];
  if (EXEMPT_ROLES.has(report.role)) return { ok: true, over };
  const add = (field, value, cap) => {
    const len = typeof value === 'string' ? value.length : 0;
    if (len > cap) over.push({ field, len, cap });
  };
  add('text outside the json block', ' '.repeat(proseLength(text)), CAPS.prose);
  add('summary', report.summary, CAPS.summary);
  (report.findings || []).forEach((f, i) => {
    if (!isSecurity(f)) add(`findings[${i}].text`, f.text, CAPS.finding);
  });
  if (report.plan && !VERBATIM_PLAN_ROLES.has(report.role)) {
    add('plan.summary', report.plan.summary, CAPS.plan_summary);
    for (const k of PLAN_LISTS) (report.plan[k] || []).forEach((v, i) => add(`plan.${k}[${i}]`, v, CAPS.plan_item));
  }
  return { ok: over.length === 0, over };
}

export const capsMessage = (over) =>
  `Your report is too long: ${over.map((o) => `${o.field} is ${o.len} chars (cap ${o.cap})`).join('; ')}. ` +
  'Tighten those fields: fragments, no filler, keep paths, commands and error text exact. Reply with ONLY the fenced ```json block.';
