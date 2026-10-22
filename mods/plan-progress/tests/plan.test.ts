import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__plan-progress__plan'

const TYPED = {
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
}

const PANE = {
  plugin: 'plan-progress',
  component: 'Pane',
  requestId: 'plan-progress',
  props: {
    title: 'Plan',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const AUTOPILOT = {
  title: 'Auto Pilot',
  note: '01 9e, then 02 and 04, then 05, then 06',
  steps: [
    {
      text: 'Memory base',
      status: 'active',
      tasks: [
        { text: '9a renewal', status: 'done' },
        { text: '9b awareness', status: 'done' },
        { text: '9c core memory', status: 'done' },
        { text: '9d long-term memory', status: 'done' },
        { text: '9e derive and consolidate', status: 'active', progress: 40 },
      ],
    },
    { text: 'Docs', tasks: [{ text: 'T1' }, { text: 'T2' }, { text: 'T3' }] },
    { text: 'Shadow learning', status: 'blocked', note: 'Amend tasks 4 and 7 first', tasks: [{ text: 'T1' }, { text: 'T2' }] },
  ],
}

test('lays out a plan, weighs steps by tasks, collapses, and keeps it per project', async ($, on) => {
  const saved: Record<string, unknown> = {}
  mock.store(on, saved)
  on('session.root', () => ({ value: '/repo' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const set = await $.tool.call({ tool: TOOL, ...AUTOPILOT })
  // (4.4 + 0 + 0) of 10 tasks
  expect(set.result).toContain('Plan: Auto Pilot (44% done)')
  expect(set.result).toContain('1. [~] Memory base 88% (4/5)')
  expect(set.result).toContain('3. [!] Shadow learning 0% (0/2) — Amend tasks 4 and 7 first')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^44%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /0 of 3 steps · 4 of 10 tasks/ })).toBeDefined()
    // The step in progress and the blocked one open by default; Docs stays shut.
    expect(await ui.find({ type: 'Text', text: /9e derive and consolidate/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Amend tasks 4 and 7 first/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const toggles = await ui.findAll({ type: 'Button' })
  const memory = toggles.find(b => b.key?.startsWith('toggle-') && b.text.includes('Memory base'))
  expect(memory).toBeDefined()
  await ui.press({ key: memory!.key! })
  // The task row is gone; the Now line above still names it.
  expect(await ui.find({ type: 'Text', text: /^● 9e derive and consolidate/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Now · Memory base$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^9e derive and consolidate$/ })).toBeDefined()
  await ui.unmount()

  // Finishing the last task settles the step to done.
  const done = await $.tool.call({ tool: TOOL, updates: [{ step: 1, task: 5, progress: 100 }] })
  expect(done.result).toContain('1. [x] Memory base 100% (5/5)')
  expect(done.result).toContain('Plan: Auto Pilot (50% done)')

})

test('the agent turn list nests under the step in progress', async ($, on) => {
  const saved: Record<string, unknown> = {}
  mock.store(on, saved)
  on('session.root', () => ({ value: '/repo' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, () => ({ result: 'ok' }))

  await $.tool.call({ tool: TOOL, ...AUTOPILOT })
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Write memory-derive job', status: 'in_progress' },
      { content: 'Add consolidate cron', status: 'pending' },
    ],
    scope: 'continuation',
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /This turn/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Write memory-derive job/ })).toBeDefined()
  await ui.unmount()
})

test('/plan-progress <request> asks the agent; clear empties the project plan', async ($, on) => {
  const saved: Record<string, unknown> = {}
  mock.store(on, saved)
  on('session.root', () => ({ value: '/repo' }))
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  const prompts: string[] = []
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })

  const ran = await $.command.run({ ...TYPED, command: 'plan-progress', args: 'docs/superpowers/plans autopilot' })
  expect(ran.text).toContain('Laying out the plan')
  await clock.settle()
  expect(prompts.join('\n')).toContain('docs/superpowers/plans autopilot')
  expect(prompts.join('\n')).toContain(TOOL)

  await $.tool.call({ tool: TOOL, ...AUTOPILOT })
  expect((await $.command.run({ ...TYPED, command: 'plan-progress', args: 'clear' })).text).toBe(
    'Plan cleared for this project.',
  )
  expect(saved['plan:/repo']).toBeUndefined()
  const empty = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await empty.find({ type: 'Text', text: /No plan yet/ })).toBeDefined()
  await empty.unmount()
})

test('a plan stored for the project opens with the next session', async ($, on) => {
  mock.store(on, {
    'plan:/repo': {
      title: 'Kept plan',
      steps: [{ id: 's1', text: 'Only step', status: 'active', progress: 30, tasks: [] }],
    },
  })
  on('session.root', () => ({ value: '/repo' }))
  on('ui.status', () => ({ value: undefined }))
  let opened = false
  on('ui.open', () => {
    opened = true
    return { value: { isPlaced: true } }
  })
  on('command.register', (_$, e) => ({ value: { ...e, command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { ...e, tool: `mcp__plan-progress__${e.name}` } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  expect(opened).toBe(true)
  const read = await $.tool.call({ tool: TOOL })
  expect(read.result).toContain('Plan: Kept plan (30% done)')
})

test('the task in progress takes its progress from the turn list, in the pane and the band', async ($, on) => {
  mock.store(on)
  on('session.root', () => ({ value: '/repo' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, () => ({ result: 'ok' }))

  await $.tool.call({
    tool: TOOL,
    title: 'Auto Pilot',
    steps: [{ text: 'Memory base', status: 'active', tasks: [{ text: 'T30', status: 'done' }, { text: 'T31 memory-derive', status: 'active' }] }],
  })
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Read the spec', status: 'completed' },
      { content: 'Write the job', status: 'completed' },
      { content: 'Test it', status: 'in_progress' },
      { content: 'Open the PR', status: 'pending' },
    ],
    scope: 'continuation',
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    // 2 of 4 turn steps done: T31 at 50%, the step at (1 + 0.5) / 2, the plan the same.
    expect(await pane.find({ type: 'Text', text: /^Now · Memory base$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /50% · 2 of 4 this turn$/ })).toBeDefined()
    // The step row keeps one value; its bar and task count sit on the line below.
    expect(await pane.find({ type: 'Text', text: /75% · 1 of 2 tasks$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^75%$/ })).toBeDefined()
    await pane.unmount()

    const band = await $.ui.mount({
      plugin: 'plan-progress',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect((await band.find({ type: 'Text', text: /Plan 75% · Memory base › T31 memory-derive/ }))?.text).toContain(
      'T31 memory-derive',
    )
    await band.press({ key: 'plan-band' })
    await band.unmount()
  }

  // Stored progress is untouched: the agent's own read-back shows what it reported.
  const read = await $.tool.call({ tool: TOOL })
  expect(read.result).toContain('2. [~] T31 memory-derive')
  expect(read.result).not.toContain('memory-derive (')
})
