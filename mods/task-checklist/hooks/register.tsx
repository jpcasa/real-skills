import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Checklist, ChecklistItem, ItemStatus } from '../types'

const PANE = 'task-checklist'
const TOOL = 'mcp__task-checklist__checklist'
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'

const EMPTY: Checklist = { title: 'Current task', items: [] }

const list = atom({ plugin: 'task-checklist', key: 'list' } as const, EMPTY)
const edits = atom({ plugin: 'task-checklist', key: 'edits' } as const, [])
const isDismissed = atom(
  { plugin: 'task-checklist', key: 'isDismissed' } as const,
  false,
)

type PlanEntry = { content?: unknown; text?: unknown; status?: unknown }

const MARK: Record<ItemStatus, string> = {
  pending: '☐',
  active: '◐',
  done: '☑',
}

function toStatus(raw: unknown): ItemStatus {
  if (raw === 'completed' || raw === 'done') return 'done'
  if (raw === 'in_progress' || raw === 'active') return 'active'
  return 'pending'
}

function summary(checklist: Checklist): string {
  if (checklist.items.length === 0) return 'The checklist is empty.'
  const lines = checklist.items.map(
    (item, i) => `${i + 1}. [${item.status === 'done' ? 'x' : item.status === 'active' ? '~' : ' '}] ${item.text}`,
  )
  return [`Checklist: ${checklist.title}`, ...lines].join('\n')
}

function counts(checklist: Checklist) {
  const done = checklist.items.filter(item => item.status === 'done').length
  const active = checklist.items.find(item => item.status === 'active')
  return { done, total: checklist.items.length, active }
}

function bar(done: number, total: number, width = 12): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
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

function withStatus(items: ChecklistItem[], at: number, status: ItemStatus): ChecklistItem[] {
  return items.map((item, i) => (i === at ? { ...item, status } : item))
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
].join(' ')

const STATUS_ENUM = ['pending', 'active', 'done']

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'checklist',
      description: 'Show the task checklist pane (or: hide, clear, add <item>)',
      argumentHint: '[show|hide|clear|add <item>]',
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
              },
              required: ['index', 'status'],
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
        for (const u of args.updates as { index?: unknown; status?: unknown }[]) {
          if (typeof u?.index === 'number') items = withStatus(items, u.index - 1, toStatus(u.status))
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
          base = { ...base, title: 'Current task' }
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
      items: prev.items.map(item => (item.status === 'active' ? { ...item, status: 'done' } : item)),
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
    const { done, total } = counts(await read($, list))
    const where = opened.isPlaced ? '' : ' (no surface placed the pane right now)'
    return {
      text: `Checklist: ${done}/${total} done${where}.\n${summary(verb === 'add' ? await read($, list) : current)}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const checklist = await read($, list)
    const { done, total } = counts(checklist)

    const toggle = (item: ChecklistItem) => {
      const status: ItemStatus = item.status === 'done' ? 'pending' : 'done'
      return userEdit(
        $,
        `${status === 'done' ? 'checked' : 'unchecked'} "${item.text}"`,
        prev => ({
          ...prev,
          items: prev.items.map(one => (one.id === item.id ? { ...one, status } : one)),
        }),
      )
    }
    const focusOn = (item: ChecklistItem) =>
      userEdit($, `marked "${item.text}" as in progress`, prev => ({
        ...prev,
        items: prev.items.map(one =>
          one.id === item.id
            ? { ...one, status: 'active' }
            : one.status === 'active'
              ? { ...one, status: 'pending' }
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

    return (
      <Box flexDirection="column">
        <Text bold>{checklist.title}</Text>
        <Text dimColor>
          {bar(done, total)} {done}/{total} done
        </Text>
        {total === 0 && (
          <Text dimColor>
            Nothing yet. The agent's task list shows up here, or add an item below.
          </Text>
        )}
        {checklist.items.map(item => (
          <Box key={`row-${item.id}`} flexDirection="row">
            <Button key={`item-${item.id}`} plain onPress={() => toggle(item)}>
              {MARK[item.status]}{' '}
              <Text
                strikethrough={item.status === 'done'}
                dimColor={item.status === 'done'}
                bold={item.status === 'active'}
              >
                {item.text}
              </Text>
            </Button>
            {item.status === 'pending' && (
              <Button key={`focus-${item.id}`} plain label=" ▸" onPress={() => focusOn(item)} />
            )}
            <Button key={`remove-${item.id}`} plain label=" ×" onPress={() => remove(item)} />
          </Box>
        ))}
        {Input !== undefined && (
          <Input key="add" placeholder="Add an item…" submitLabel="Add" onSubmit={value => add(value)} />
        )}
      </Box>
    )
  })
}
