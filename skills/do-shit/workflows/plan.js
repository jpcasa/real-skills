export const meta = {
  name: 'do-shit-plan',
  description: 'Run the /do-shit plan-phase investigators in parallel and return their reports',
  whenToUse: 'Only from a /do-shit harness `workflow` action, which supplies args. Not for direct use.',
  phases: [{ title: 'Investigate', detail: 'one read-only investigator per leaf item' }],
}

// args: { run_id, agents: [{ role, agent_type, name, leaf, prompt_file }] }
// Returns { run_id, results: [{ agent, leaf, role, report | null }] }, the
// stdin of `harness.mjs record-batch`. The harness decides everything else.

// Copy of ../schemas/report.schema.json without $id and title: a workflow
// script cannot read files. plan-workflow.test.mjs keeps the two identical.
const REPORT_SCHEMA = {
  type: 'object',
  required: ['role', 'item', 'loop', 'verdict', 'summary', 'findings', 'files_touched', 'commits'],
  properties: {
    role: {
      type: 'string',
      enum: [
        'investigator', 'architect', 'data-engineer', 'worker', 'designer', 'content-creator',
        'observability-engineer', 'docs-writer', 'test-engineer', 'tester', 'auditor',
        'security-advisor', 'accessibility-auditor', 'performance-engineer', 'integrator',
        'qa-planner', 'qa-tester',
      ],
    },
    item: { type: 'string' },
    loop: { type: 'integer' },
    verdict: { type: 'string', enum: ['pass', 'fail', 'blocked', 'n/a'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'blocking', 'owner_role', 'text'],
        properties: {
          severity: { type: 'string', enum: ['bug', 'risk', 'nit', 'q'] },
          blocking: { type: 'boolean' },
          file: { type: 'string' },
          line: { type: 'integer' },
          owner_role: { type: 'string' },
          text: { type: 'string' },
        },
      },
    },
    files_touched: { type: 'array', items: { type: 'string' } },
    commits: { type: 'array', items: { type: 'string' } },
    plan: {
      type: 'object',
      description: 'investigator/architect/qa-planner only',
      properties: {
        premise_valid: { type: 'boolean' },
        summary: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        acceptance_criteria: { type: 'array', items: { type: 'string' } },
        test_plan: { type: 'array', items: { type: 'string' } },
        risks: { type: 'array', items: { type: 'string' } },
        open_questions: { type: 'array', items: { type: 'string' } },
        depends_on: { type: 'array', items: { type: 'string' } },
        other_repo: { type: 'boolean' },
        uncovered_parent_work: { type: 'string' },
      },
    },
    qa: {
      type: 'object',
      description: 'qa-tester only',
      properties: {
        env: { type: 'string' },
        sha: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            required: ['action', 'expected', 'actual', 'result'],
            properties: {
              action: { type: 'string' },
              expected: { type: 'string' },
              actual: { type: 'string' },
              result: { type: 'string', enum: ['pass', 'fail', 'skipped'] },
              screenshot: { type: 'string' },
            },
          },
        },
        walkthrough: { type: 'string' },
      },
    },
  },
}
// An investigator without a plan is excluded by the harness: require it here.
const PLAN_SCHEMA = { ...REPORT_SCHEMA, required: [...REPORT_SCHEMA.required, 'plan'] }

const agents = args && Array.isArray(args.agents) ? args.agents : []
if (!agents.length) throw new Error('do-shit-plan runs only from a /do-shit harness `workflow` action (args.agents is empty)')

phase('Investigate')
const reports = await parallel(agents.map((a) => () =>
  agent(
    `Your whole task is in the file ${a.prompt_file}. Read it now and follow it exactly.\n` +
      'Where it asks for a fenced json block as your final message, return that same report through the structured output tool instead.',
    { label: a.name, phase: 'Investigate', agentType: a.agent_type, schema: PLAN_SCHEMA },
  )))

const missing = agents.filter((_, i) => !reports[i]).map((a) => a.leaf)
if (missing.length) log(`no report for ${missing.join(', ')}: the harness falls back to a plain spawn for each`)

return {
  run_id: args.run_id,
  results: agents.map((a, i) => ({ agent: a.name, leaf: a.leaf, role: a.role, report: reports[i] ?? null })),
}
