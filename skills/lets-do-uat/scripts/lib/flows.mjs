// UAT flows: what the model proposes, checked here, and the Markdown the team
// keeps. One flow is one path a user takes through the feature, from a start
// page to an outcome, in at most MAX_STEPS steps.

import { safeId } from './ref.mjs';

export const MAX_FLOWS = 8;
export const MAX_STEPS = 15;
export const STEP_RESULTS = ['pass', 'fail', 'skipped', 'blocked'];
export const FLOW_STATUSES = ['passed', 'issues', 'failed', 'blocked', 'partial', 'not_run'];
// Steps that change or send something the user may not get back. In agent mode
// the user says yes to each before the agent does it.
export const CONFIRM = /\b(delete|remove|destroy|cancel|archive|pay|purchase|buy|charge|refund|send|email|invite|publish|submit|approve|reject|transfer|deactivate|revoke|reset|import|upload)\w*\b/i;

const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const cell = (v) => str(v, 300).replace(/\|/g, '\\|');
const pad = (n) => String(n).padStart(2, '0');
export const shotName = (flowId, n, action) => `${flowId}-${pad(n)}-${safeId(str(action, 40).toLowerCase()).slice(0, 30) || 'step'}.png`.replace(/[^a-z0-9.-]/gi, '-').toLowerCase();

// -> { flows, invalid: [why] }. A flow with a problem is not kept: the model fixes it and calls again.
// What holds for every flow, and what the flows leave out on purpose: both shown to the reviewer.
export const checkNotes = (n = {}) => {
  const list = (v) => (Array.isArray(v) ? v : []).slice(0, 8).map((x) => str(x, 200)).filter(Boolean);
  return { requires: list(n.requires), not_covered: list(n.not_covered) };
};

export function checkFlows(input) {
  const invalid = [];
  const list = Array.isArray(input) ? input : [];
  if (!list.length) invalid.push('no flows');
  if (list.length > MAX_FLOWS) invalid.push(`${list.length} flows: at most ${MAX_FLOWS}; split the feature or drop the least important`);
  const seen = new Set();
  const flows = [];
  for (const [i, f] of list.slice(0, MAX_FLOWS).entries()) {
    const id = safeId(str(f?.id || f?.title, 40).toLowerCase());
    const at = `flow ${i + 1} (${id})`;
    const bad = [];
    if (seen.has(id)) bad.push('duplicate id');
    if (!str(f?.title, 120)) bad.push('no title');
    if (!str(f?.goal, 300)) bad.push('no goal');
    // The next tester needs both to repeat the flow: who to sign in as, and where in the app it happens.
    if (!str(f?.role, 120)) bad.push('no role: who must be signed in ("Dispatcher", "Signed out")');
    if (!str(f?.section, 160)) bad.push('no section: where in the app, as the user navigates ("Operations > Transport requests")');
    if (!/^\/[^\s]*$/.test(String(f?.start_path || ''))) bad.push('start_path must start with / and have no spaces');
    if (/[?#].*(token|key|secret|password|session)=/i.test(String(f?.start_path || ''))) bad.push('start_path carries a credential');
    const steps = Array.isArray(f?.steps) ? f.steps : [];
    if (!steps.length) bad.push('no steps');
    if (steps.length > MAX_STEPS) bad.push(`${steps.length} steps: at most ${MAX_STEPS}; split it`);
    steps.forEach((s, n) => {
      if (!str(s?.action, 300) || !str(s?.expected, 300)) bad.push(`step ${n + 1} needs action and expected`);
    });
    if (bad.length) {
      invalid.push(`${at}: ${bad.join('; ')}`);
      continue;
    }
    seen.add(id);
    flows.push({
      id,
      title: str(f.title, 120),
      goal: str(f.goal, 300),
      role: str(f.role, 120),
      section: str(f.section, 160),
      end_shot: `${id}-end.png`,
      start_path: String(f.start_path),
      preconditions: (Array.isArray(f.preconditions) ? f.preconditions : []).slice(0, 5).map((p) => str(p, 200)).filter(Boolean),
      steps: steps.map((s, n) => ({ n: n + 1, action: str(s.action, 300), expected: str(s.expected, 300), confirm: CONFIRM.test(s.action), shot: shotName(id, n + 1, s.action) })),
    });
  }
  return { flows, invalid };
}

// The status of one flow, from what was recorded. env: step numbers whose failure was the environment's.
export function flowStatus(flow, env = []) {
  const rec = flow.steps.map((s) => s.record).filter(Boolean);
  if (!rec.length) return 'not_run';
  const fails = flow.steps.filter((s) => s.record?.result === 'fail');
  const real = fails.filter((s) => !env.includes(s.n));
  if (real.length) return 'failed';
  if (fails.length || rec.some((r) => r.result === 'blocked')) return 'blocked';
  if (rec.length < flow.steps.length || rec.some((r) => r.result === 'skipped')) return 'partial';
  return flow.facts?.server_errors || flow.facts?.console_errors ? 'issues' : 'passed';
}

const ICON = { pass: 'pass', fail: '**fail**', skipped: 'skipped', blocked: 'blocked' };

// The flows file in the repo. Before the walk it is the plan; after, the record.
export function renderFlows(run) {
  const it = run.item;
  const done = run.flows.some((f) => f.status);
  const prs = (it.prs || []).map((p) => `[#${p.number}](${p.url}) ${p.state === 'MERGED' ? '(merged)' : `(${String(p.state || 'open').toLowerCase()})`}`).join(', ') || 'none found';
  const L = [
    `# UAT: ${it.title}`,
    '',
    `${it.url ? `[${it.ref}](${it.url})` : it.ref} · PRs: ${prs}${run.env ? ` · Environment: ${run.env}` : ''}${run.mode ? ` · ${run.mode === 'agent' ? 'Agent clicked' : 'User clicked'}` : ''} · ${run.date}`,
    '',
    it.summary,
    ...((run.notes?.requires || []).length ? ['', 'Needs, for every flow:', ...run.notes.requires.map((r) => `- ${r}`)] : []),
    ...((run.notes?.not_covered || []).length ? ['', 'Not covered by these flows:', ...run.notes.not_covered.map((r) => `- ${r}`)] : []),
    '',
    '| # | Flow | Steps | Result |',
    '|---|---|---|---|',
    ...run.flows.map((f, i) => `| ${i + 1} | [${cell(f.title)}](#${i + 1}-${f.id}) | ${f.steps.length} | ${f.status || (done ? 'not_run' : '—')} |`),
  ];
  run.flows.forEach((f, i) => {
    const who = f.observed?.signed_in_as ? `${f.role} (${f.observed.signed_in_as})` : f.role;
    L.push('', `## ${i + 1}. ${f.title}`, '', `<a id="${i + 1}-${f.id}"></a>`, '', `Goal: ${f.goal}`, '', `| Sign in as | Where | Start at |`, '|---|---|---|', `| ${cell(who)} | ${cell(f.observed?.section || f.section)} | \`${run.base_url || ''}${f.start_path}\` |`);
    if (f.preconditions.length) L.push('', 'Before you start:', ...f.preconditions.map((p) => `- ${p}`));
    L.push('', '| # | Do | Expect | Result |', '|---|---|---|---|');
    for (const s of f.steps) L.push(`| ${s.n} | ${cell(s.action)}${s.confirm ? ' ⚠' : ''} | ${cell(s.expected)} | ${s.record ? `${ICON[s.record.result]}${s.record.result !== 'pass' && s.record.actual ? `: ${cell(s.record.actual)}` : ''}` : '—'} |`);
    const shots = f.steps.filter((s) => s.record?.shot);
    if (shots.length) L.push('', ...shots.flatMap((s) => [`Step ${s.n}: ${cell(s.action)}`, '', `![Step ${s.n}](shots/${s.shot})`, '']));
    if (f.end) L.push('Outcome', '', `![Outcome](shots/${f.end_shot})`, '');
    if (f.summary) L.push('', `**Under the hood:** ${f.summary}`);
  });
  if (run.flows.some((f) => f.steps.some((s) => s.confirm))) L.push('', '⚠ changes or sends something: the agent asks before doing it.');
  return `${L.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

// One retrieval chunk per flow: self-contained, with the facts a RAG pipeline filters on.
export function renderRag(run, flow) {
  const it = run.item;
  const yaml = (v) => JSON.stringify(String(v ?? ''));
  return [
    '---',
    `id: ${yaml(`${it.slug}/${flow.id}`)}`,
    `feature: ${yaml(it.title)}`,
    `ticket: ${yaml(it.url || it.ref)}`,
    `flow: ${yaml(flow.title)}`,
    `route: ${yaml(flow.start_path)}`,
    `role: ${yaml(flow.role)}`,
    `section: ${yaml(flow.section)}`,
    `status: ${yaml(flow.status || 'not_run')}`,
    `prs: [${(it.prs || []).map((p) => p.number).join(', ')}]`,
    `updated: ${yaml(run.date)}`,
    'tags: ["uat", "user-flow"]',
    '---',
    '',
    `# ${flow.title} (${it.title})`,
    '',
    `${/[.!?]$/.test(flow.goal) ? flow.goal : `${flow.goal}.`} Signed in as ${flow.role}, in ${flow.section}, starting at \`${flow.start_path}\`.`,
    ...(flow.preconditions.length ? ['', `Before starting: ${flow.preconditions.join('; ')}.`] : []),
    '',
    'Steps:',
    ...flow.steps.map((s) => `${s.n}. ${s.action}. Expected: ${s.expected}.`),
    ...(flow.summary ? ['', `How it works: ${flow.summary}`] : []),
    '',
  ].join('\n');
}
