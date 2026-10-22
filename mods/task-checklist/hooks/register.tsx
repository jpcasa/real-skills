import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Checklist, ChecklistItem, ItemStatus } from '../types'

const PANE = 'task-checklist'
const TOOL = 'mcp__task-checklist__checklist'
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'

const EMPTY: Checklist = { title: '', items: [] }
const STEP_BAR = 10

const list = atom({ plugin: 'task-checklist', key: 'list' } as const, EMPTY)
const edits = atom({ plugin: 'task-checklist', key: 'edits' } as const, [])
const isDismissed = atom(
  { plugin: 'task-checklist', key: 'isDismissed' } as const,
  false,
)

type PlanEntry = { content?: unknown; text?: unknown; status?: unknown }

const MARK: Record<ItemStatus, { glyph: string; color: string }> = {
  pending: { glyph: '○', color: 'inactive' },
  active: { glyph: '●', color: 'claude' },
  done: { glyph: '✓', color: 'success' },
}

function toStatus(raw: unknown): ItemStatus {
  if (raw === 'completed' || raw === 'done') return 'done'
  if (raw === 'in_progress' || raw === 'active') return 'active'
  return 'pending'
}

function summary(checklist: Checklist): string {
  if (checklist.items.length === 0) return 'The checklist is empty.'
  const lines = checklist.items.map(
    (item, i) =>
      `${i + 1}. [${item.status === 'done' ? 'x' : item.status === 'active' ? '~' : ' '}] ${item.text}` +
      (item.status === 'active' && item.progress !== undefined ? ` (${item.progress}%)` : ''),
  )
  return [`Checklist${checklist.title ? `: ${checklist.title}` : ''}`, ...lines].join('\n')
}

function counts(checklist: Checklist) {
  const done = checklist.items.filter(item => item.status === 'done').length
  const active = checklist.items.find(item => item.status === 'active')
  const partial = checklist.items.reduce(
    (sum, item) => sum + (item.status === 'active' ? (item.progress ?? 0) / 100 : 0),
    0,
  )
  return { done, total: checklist.items.length, active, complete: done + partial }
}

/** Filled and remaining runs of a line bar, so each can take its own theme color. */
function bar(done: number, total: number, width: number): [string, string] {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return ['━'.repeat(filled), '━'.repeat(width - filled)]
}

function mint(_$: EngineInterface, texts: { text: string; status: ItemStatus }[]) {
  return texts.map((one): ChecklistItem => ({ id: crypto.randomUUID(), ...one }))
}

async function paintStatus($: EngineInterface, checklist: Checklist) {
  const { done, total, active } = counts(checklist)
  $.ui.status(
    total === 0
      ? undefined
      : `☑ ${done}/${total}${active ? ` · ${active.text.slice(0, 40)}` : ''}`,
  )
}

/** Writes a new list from the agent's side; opens the pane when it first fills. */
async function setFromAgent(
  $: EngineInterface,
  change: (prev: Checklist) => Checklist | Promise<Checklist>,
) {
  const prev = await read($, list)
  const nextList = await change(prev)
  await update($, list, () => nextList)
  await paintStatus($, nextList)

  if (prev.items.length === 0 && nextList.items.length > 0 && !(await read($, isDismissed))) {
    $.ui.open({ id: PANE, title: 'Checklist' }).catch(() => undefined)
  }
}

/** A change the person made in the pane: applied, and noted for the agent. */
async function userEdit(
  $: EngineInterface,
  note: string,
  change: (prev: Checklist) => Checklist,
) {
  const nextList = await update($, list, prev => change(prev ?? EMPTY))
  await update($, edits, prev => [...(prev ?? []), note].slice(-50))
  await paintStatus($, nextList ?? (await read($, list)))
}

/** Progress belongs to the step in progress; done and pending steps carry none. */
function setStatus(item: ChecklistItem, status: ItemStatus): ChecklistItem {
  const { progress, ...rest } = item
  return status === 'active' && progress !== undefined ? { ...rest, status, progress } : { ...rest, status }
}

function withStatus(items: ChecklistItem[], at: number, status: ItemStatus): ChecklistItem[] {
  return items.map((item, i) => (i === at ? setStatus(item, status) : item))
}

/** A reported 0-100: full marks the step done, anything less puts it in progress. */
function withProgress(items: ChecklistItem[], at: number, raw: number): ChecklistItem[] {
  if (!Number.isFinite(raw)) return items
  const progress = Math.round(Math.min(100, Math.max(0, raw)))
  return items.map((item, i) =>
    i !== at ? item : progress === 100 ? setStatus(item, 'done') : { ...item, status: 'active', progress },
  )
}

function applyPlanSteps(prev: Checklist, e: Record<string, unknown>): Checklist {
  let items = prev.items

  if (Array.isArray(e.done)) {
    for (const n of e.done) if (typeof n === 'number') items = withStatus(items, n - 1, 'done')
  }
  if (e.advance === true) {
    const current = items.findIndex(item => item.status === 'active')
    if (current >= 0) items = withStatus(items, current, 'done')
    const nextPending = items.findIndex((item, i) => i > current && item.status === 'pending')
    if (nextPending >= 0) items = withStatus(items, nextPending, 'active')
  }
  if (typeof e.start === 'number') {
    items = items.map(item => (item.status === 'active' ? { ...item, status: 'pending' } : item))
    items = withStatus(items, e.start - 1, 'active')
  }

  return { ...prev, items }
}

const TOOL_DESCRIPTION = [
  'The checklist the person sees in their Checklist pane for the task in progress.',
  'Your TodoWrite / update_plan lists are mirrored into it automatically; use this tool to',
  'read it back (call with no arguments), give it a title, add items, or set item statuses directly.',
  'The person can check, uncheck and add items themselves; their edits reach you beside their next prompt.',
  'As you work through a step, report how far along it is with `updates: [{ index, progress }]` (0-100):',
  'the pane draws a bar per step, and 100 marks it done.',
].join(' ')

const STATUS_ENUM = ['pending', 'active', 'done']

const SUBCOMMANDS = new Set(['show', 'hide', 'clear', 'add'])

function buildPrompt(request: string): string {
  return [
    `Build my task checklist from this request: ${request}`,
    '',
    `Work out which tasks it asks for (read any linked PR, issue or file first), then call ${TOOL} once`,
    'with a short `title` and the whole list as `items`: one item per task, status `done` for tasks',
    'already finished and `pending` for the rest. Only build the list; do not start the tasks.',
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'checklist',
      description: 'Show the task checklist pane, or build it from a request (a PR, a ticket, a goal)',
      argumentHint: '[<request>|hide|clear|add <item>]',
    })
    await $.tool.register({
      name: 'checklist',
      description: TOOL_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title shown above the checklist.' },
          items: {
            type: 'array',
            description: 'Replaces the whole list.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                status: { type: 'string', enum: STATUS_ENUM },
              },
              required: ['text'],
            },
          },
          add: { type: 'array', items: { type: 'string' }, description: 'Items appended as pending.' },
          updates: {
            type: 'array',
            description: 'Status changes by 1-based position.',
            items: {
              type: 'object',
              properties: {
                index: { type: 'number' },
                status: { type: 'string', enum: STATUS_ENUM },
                progress: {
                  type: 'number',
                  minimum: 0,
                  maximum: 100,
                  description: 'How far along the step is, 0-100. It becomes the step in progress; 100 marks it done.',
                },
              },
              required: ['index'],
            },
          },
          clear: { type: 'boolean', description: 'Empties the list.' },
        },
      },
    })
    await paintStatus($, await read($, list))

    return next(e)
  })

  // The model's own tool.
  on('tool.call', { tool: TOOL }, async ($, e) => {
    const args = e as Record<string, unknown>
    await setFromAgent($, async prev => {
      let nextList: Checklist = args.clear === true ? EMPTY : prev
      if (typeof args.title === 'string' && args.title.trim()) {
        nextList = { ...nextList, title: args.title.trim() }
      }
      if (Array.isArray(args.items)) {
        const entries = (args.items as PlanEntry[])
          .filter(one => typeof one?.text === 'string')
          .map(one => ({ text: String(one.text), status: toStatus(one.status) }))
        nextList = { ...nextList, items: await mint($, entries) }
      }
      if (Array.isArray(args.add)) {
        const added = await mint(
          $,
          (args.add as unknown[])
            .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
            .map(text => ({ text: text.trim(), status: 'pending' as const })),
        )
        nextList = { ...nextList, items: [...nextList.items, ...added] }
      }
      if (Array.isArray(args.updates)) {
        let items = nextList.items
        for (const u of args.updates as { index?: unknown; status?: unknown; progress?: unknown }[]) {
          if (typeof u?.index !== 'number') continue
          if (u.status !== undefined) items = withStatus(items, u.index - 1, toStatus(u.status))
          if (typeof u.progress === 'number') items = withProgress(items, u.index - 1, u.progress)
        }
        nextList = { ...nextList, items }
      }
      return nextList
    })

    return { result: summary(await read($, list)) }
  })

  // Mirror the desktop app's task list.
  on('tool.call', { tool: PLAN_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const args = e as Record<string, unknown>

    await setFromAgent($, async prev => {
      let base = prev
      if (Array.isArray(args.items)) {
        const entries = (args.items as PlanEntry[]).map(one => ({
          text: String(one?.content ?? one?.text ?? ''),
          status: toStatus(one?.status),
        }))
        base = { ...prev, items: await mint($, entries.filter(one => one.text !== '')) }
        if (args.scope === 'new_task' || args.scope === 'first_task') {
          base = { ...base, title: '' }
        }
      }
      return applyPlanSteps(base, args)
    })

    return ran
  })

  on('tool.call', { tool: WRAP_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    await setFromAgent($, prev => ({
      ...prev,
      items: prev.items.map(item => (item.status === 'active' ? setStatus(item, 'done') : item)),
    }))
    return ran
  })

  // Mirror Claude Code's TodoWrite list.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    await setFromAgent($, async prev => ({
      ...prev,
      items: await mint(
        $,
        e.todos.map(todo => ({ text: todo.content, status: toStatus(todo.status) })),
      ),
    }))
    return ran
  })

  // The person's edits since the last prompt ride along with the next one.
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta === true) return next(e)
    const pending = await read($, edits)
    if (pending.length === 0) return next(e)
    await update($, edits, () => [])
    const note = [
      'The person edited the task checklist (Checklist pane) since your last turn:',
      ...pending.map(line => `- ${line}`),
      '',
      'Treat checked items as done and unchecked items as still to do; keep your task list in line with it.',
      summary(await read($, list)),
    ].join('\n')

    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, isDismissed, () => true)
    return next(e)
  })

  on('command.run', { command: 'checklist' }, async ($, e) => {
    const [verb = 'show', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const current = await read($, list)

    if (verb === 'hide') {
      await update($, isDismissed, () => true)
      await $.ui.close({ id: PANE })
      return { text: 'Checklist pane hidden. /checklist brings it back.' }
    }
    if (verb === 'clear') {
      await update($, list, () => EMPTY)
      await update($, edits, () => [])
      await paintStatus($, EMPTY)
      return { text: 'Checklist cleared.' }
    }
    if (verb === 'add' && rest.length > 0) {
      const text = rest.join(' ')
      const added = await mint($, [{ text, status: 'pending' }])
      await userEdit($, `added "${text}"`, prev => ({ ...prev, items: [...prev.items, ...added] }))
    }

    await update($, isDismissed, () => false)
    const opened = await $.ui.open({ id: PANE, title: 'Checklist' })
    const where = opened.isPlaced ? '' : ' (no surface placed the pane right now)'

    // Anything that is not a subcommand is a request for the agent to build the list from.
    if (!SUBCOMMANDS.has(verb)) {
      // A command.run hook may not submit (it holds the turn), so submit once it has returned.
      const prompt = buildPrompt(e.args.trim())
      $.clock.after(0, () => void $.prompt.submit({ text: prompt, asUser: true }).catch(() => undefined))
      return { text: `Building the checklist from your request${where}.` }
    }

    const { done, total } = counts(await read($, list))
    return {
      text: `Checklist: ${done}/${total} done${where}.\n${summary(verb === 'add' ? await read($, list) : current)}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const checklist = await read($, list)
    const { done, total, complete } = counts(checklist)

    const toggle = (item: ChecklistItem) => {
      const status: ItemStatus = item.status === 'done' ? 'pending' : 'done'
      return userEdit(
        $,
        `${status === 'done' ? 'checked' : 'unchecked'} "${item.text}"`,
        prev => ({
          ...prev,
          items: prev.items.map(one => (one.id === item.id ? setStatus(one, status) : one)),
        }),
      )
    }
    const focusOn = (item: ChecklistItem) =>
      userEdit($, `marked "${item.text}" as in progress`, prev => ({
        ...prev,
        items: prev.items.map(one =>
          one.id === item.id
            ? setStatus(one, 'active')
            : one.status === 'active'
              ? setStatus(one, 'pending')
              : one,
        ),
      }))
    const add = async (value: string) => {
      const text = value.trim()
      if (!text) return
      const added = await mint($, [{ text, status: 'pending' }])
      await userEdit($, `added "${text}"`, prev => ({ ...prev, items: [...prev.items, ...added] }))
    }
    const remove = (item: ChecklistItem) =>
      userEdit($, `removed "${item.text}"`, prev => ({
        ...prev,
        items: prev.items.filter(one => one.id !== item.id),
      }))

    const columns = e.props.bodyColumns ?? 40
    const width = Math.max(8, Math.min(48, columns - 2))
    const [filled, remaining] = bar(complete, total, width)
    const percent = total === 0 ? 0 : Math.round((complete / total) * 100)
    // shortcut: step bars hide under 40 columns, upgrade to a narrow glyph if the mobile pane wants them
    const showStepBars = columns >= 40
    const stepBar = (item: ChecklistItem) => {
      const value = item.status === 'done' ? 100 : item.status === 'active' ? item.progress : 0
      const [f, r] = bar(value ?? 0, 100, STEP_BAR)
      return (
        <Text size="footnote" tabular>
          <Text color={item.status === 'done' ? 'success' : 'claude'}>{f}</Text>
          <Text color="subtle">{r}</Text> {value === undefined ? '  ~ ' : `${String(value).padStart(3)}%`}
        </Text>
      )
    }

    return (
      <Box flexDirection="column" gap="sm">
        {checklist.title !== '' && (
          <Text size="heading" weight="semibold">
            {checklist.title}
          </Text>
        )}
        {total === 0 ? (
          <Box flexDirection="column" gap="xs">
            <Text weight="semibold">No tasks yet</Text>
            <Text dimColor size="footnote">
              Run /checklist with what you are working on (a PR link, a ticket, a goal) and the agent
              builds the list. The agent's own task list shows up here too.
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between">
              <Text size="footnote" tabular>
                {done} of {total} done
              </Text>
              <Text size="footnote" dimColor tabular>
                {percent}%
              </Text>
            </Box>
            <Text>
              <Text color="success">{filled}</Text>
              <Text color="subtle">{remaining}</Text>
            </Text>
          </Box>
        )}
        <Box flexDirection="column">
          {checklist.items.map(item => (
            <Box key={`row-${item.id}`} flexDirection="row" justifyContent="space-between">
              <Button key={`item-${item.id}`} plain onPress={() => toggle(item)}>
                <Text color={MARK[item.status].color}>{MARK[item.status].glyph}</Text>{' '}
                <Text
                  dimColor={item.status === 'done'}
                  weight={item.status === 'active' ? 'semibold' : 'regular'}
                >
                  {item.text}
                </Text>
              </Button>
              <Box flexDirection="row" gap="xs">
                {showStepBars && stepBar(item)}
                {item.status === 'pending' && (
                  <Button key={`focus-${item.id}`} plain dimColor label=" ▸" onPress={() => focusOn(item)} />
                )}
                <Button key={`remove-${item.id}`} plain dimColor label=" ×" onPress={() => remove(item)} />
              </Box>
            </Box>
          ))}
        </Box>
        {Input !== undefined && (
          <Box marginTop="sm">
            <Input key="add" placeholder="Add a task" submitLabel="Add" onSubmit={value => add(value)} />
          </Box>
        )}
      </Box>
    )
  })
}
