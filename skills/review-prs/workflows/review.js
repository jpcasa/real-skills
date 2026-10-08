export const meta = {
  name: 'review-prs',
  description: 'Review pull requests: one reviewer per lens per PR, then a refuter on the bugs',
  whenToUse: 'Only from /review-prs, with the args its `start` command returned. Not for direct use.',
  phases: [
    { title: 'Review', detail: 'one read-only reviewer per PR per lens' },
    { title: 'Refute', detail: 'one second reviewer per PR tries to disprove the bugs' },
  ],
}

// args: { run_id, agents: [{ pr, lens, key, name, agent_type, prompt_file }], refuters: [{ pr, name, agent_type, prompt_file }] }
// Returns { run_id, results: [{ pr, key, lens, report | null }], refutations: [{ pr, report }] },
// the stdin of `review.mjs record`. The script decides what counts.

// Copies of ../schemas/{findings,refutations}.schema.json: a workflow script
// cannot read files. workflow.test.mjs keeps them identical.
const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['pr', 'lens', 'findings'],
  properties: {
    pr: { type: 'integer' },
    lens: { type: 'string', enum: ['correctness', 'standards', 'security', 'data', 'performance', 'accessibility'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'file', 'line', 'quote', 'problem', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['bug', 'risk', 'nit', 'q'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          quote: { type: 'string' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
    not_reviewed: { type: 'array', items: { type: 'string' } },
  },
}
const REFUTATIONS_SCHEMA = {
  type: 'object',
  required: ['pr', 'refutations'],
  properties: {
    pr: { type: 'integer' },
    refutations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'refuted', 'reason'],
        properties: {
          id: { type: 'string' },
          refuted: { type: 'boolean' },
          reason: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          quote: { type: 'string' },
        },
      },
    },
  },
}

const agents = args && Array.isArray(args.agents) ? args.agents : []
if (!agents.length) throw new Error('review-prs runs only with the args from `review.mjs start` (args.agents is empty)')
const refuters = Array.isArray(args.refuters) ? args.refuters : []
const prs = [...new Set(agents.map((a) => a.pr))]
const follow = (file) =>
  `Your whole task is in the file ${file}. Read it now and follow it exactly.\n` +
  'Where it asks for a fenced json block as your final message, return that same report through the structured output tool instead.'

// Each PR runs on its own: PR A can be with its refuter while PR B is still in review.
const perPr = await pipeline(
  prs,
  async (pr) => {
    const mine = agents.filter((a) => a.pr === pr)
    const reports = await parallel(mine.map((a) => () =>
      agent(follow(a.prompt_file), { label: a.name, phase: 'Review', agentType: a.agent_type, schema: FINDINGS_SCHEMA })))
    return mine.map((a, i) => ({ pr, key: a.key, lens: a.lens, report: reports[i] ?? null }))
  },
  async (results, pr) => {
    const refuter = refuters.find((r) => r.pr === pr)
    // Ids are `<agent key>#<index>`, the same numbering `record` uses.
    const bugs = results.flatMap((r) => ((r.report && r.report.findings) || [])
      .map((f, i) => ({ id: `${r.key}#${i}`, lens: r.lens, severity: f.severity, file: f.file, line: f.line, quote: f.quote, problem: f.problem }))
      .filter((f) => f.severity === 'bug'))
    if (!refuter || !bugs.length) return { results, refutation: null }
    // A stage that throws drops the whole item: the finished reviews must survive a failed refuter.
    let report = null
    try {
      report = await agent(`${follow(refuter.prompt_file)}\n\nFindings to test:\n${JSON.stringify(bugs, null, 2)}`,
        { label: refuter.name, phase: 'Refute', agentType: refuter.agent_type, schema: REFUTATIONS_SCHEMA })
    } catch (e) {
      log(`refuter for PR ${pr} failed: its bugs stay unrefuted`)
    }
    return { results, refutation: report ? { pr, report } : null }
  },
)

const done = perPr.filter(Boolean)
const lost = prs.filter((pr) => !done.some((d) => d.results[0] && d.results[0].pr === pr))
if (lost.length) log(`no result for PR ${lost.join(', ')}: record marks them partial`)

return {
  run_id: args.run_id,
  results: done.flatMap((d) => d.results),
  refutations: done.map((d) => d.refutation).filter(Boolean),
}
