import { expect, mock, test } from 'claude-code/testing'

const TYPED = {
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
}

const PANE_PROPS = {
  title: 'Checklist',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

test('mirrors the plan, toggles in the pane, and tells the agent', async ($, on) => {
  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, () => ({ result: 'ok' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  let seen: readonly string[] | undefined
  on('prompt.submit', (_$, e) => {
    seen = e.context
    return { text: e.text, context: e.context }
  })
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Read the code', status: 'in_progress' },
      { content: 'Write the fix', status: 'pending' },
    ],
    scope: 'first_task',
  })

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })

  const read = await $.tool.call({ tool: 'mcp__task-checklist__checklist' })
  expect(read.result).toBe('Checklist\n1. [x] Read the code\n2. [~] Write the fix')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'task-checklist',
      surface,
      component: 'Pane',
      requestId: 'task-checklist',
      props: PANE_PROPS,
    })
    expect((await ui.find({ type: 'Text', text: /1 of 2 done/ }))?.text).toContain('1 of 2 done')
    await ui.unmount()
  }

  const ui = await $.ui.mount({
    plugin: 'task-checklist',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'task-checklist',
    props: PANE_PROPS,
  })
  const rows = await ui.findAll({ type: 'Button' })
  const first = rows.find(one => one.key?.startsWith('item-') && one.text.includes('Read the code'))
  expect(first).toBeDefined()
  await ui.press({ key: first!.key! })
  await ui.input({ key: 'add', text: 'Run the tests' })
  expect((await ui.find({ type: 'Text', text: /0 of 3 done/ }))?.text).toContain('0 of 3 done')
  await ui.unmount()

  await $.prompt.submit({ text: 'continue', wait: false, origin: { kind: 'composer' } })
  expect(seen?.join('\n')).toContain('unchecked "Read the code"')
  expect(seen?.join('\n')).toContain('added "Run the tests"')
})

test('/checklist <request> asks the agent, which fills a titled list', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const prompts: string[] = []
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })

  const ran = await $.command.run({
    ...TYPED,
    command: 'checklist',
    args: 'Based on the tasks in this pr: https://github.com/afino-ai/afino-one/pull/351',
  })
  expect(ran.text).toContain('Building the checklist')
  await clock.settle()
  expect(prompts.join('\n')).toContain('https://github.com/afino-ai/afino-one/pull/351')
  expect(prompts.join('\n')).toContain('mcp__task-checklist__checklist')

  // The agent answers through the tool.
  await $.tool.call({
    tool: 'mcp__task-checklist__checklist',
    title: 'PR 351',
    items: [{ text: 'Fix login', status: 'done' }, { text: 'Add tests' }],
  })
  const ui = await $.ui.mount({
    plugin: 'task-checklist',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'task-checklist',
    props: PANE_PROPS,
  })
  expect((await ui.find({ type: 'Text', text: /PR 351/ }))?.text).toBe('PR 351')
  expect((await ui.find({ type: 'Text', text: /1 of 2 done/ }))?.text).toContain('1 of 2 done')
  await ui.unmount()

  // Subcommands still answer themselves.
  prompts.length = 0
  expect((await $.command.run({ ...TYPED, command: 'checklist', args: 'clear' })).text).toBe('Checklist cleared.')
  const empty = await $.ui.mount({
    plugin: 'task-checklist',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'task-checklist',
    props: PANE_PROPS,
  })
  expect((await empty.find({ type: 'Text', text: /No tasks yet/ }))?.text).toBe('No tasks yet')
  await empty.unmount()
  expect(prompts).toEqual([])
})
