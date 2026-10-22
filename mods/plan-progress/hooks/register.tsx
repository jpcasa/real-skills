import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Plan, Status, Step, Task } from '../types'

const PANE = 'plan-progress'
const TOOL = 'mcp__plan-progress__plan'
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'

const EMPTY: Plan = { title: '', steps: [] }

const plan = atom({ plugin: 'plan-progress', key: 'plan' } as const, EMPTY)
const turn = atom({ plugin: 'plan-progress', key: 'turn' } as const, [])
const open = atom({ plugin: 'plan-progress', key: 'open' } as const, {})
const isDismissed = atom({ plugin: 'plan-progress', key: 'isDismissed' } as const, false)
const isBriefed = atom({ plugin: 'plan-progress', key: 'isBriefed' } as const, false)

const MARK: Record<Status, { glyph: string; color: string }> = {
  pending: { glyph: '○', color: 'inactive' },
  active: { glyph: '●', color: 'claude' },
  done: { glyph: '✓', color: 'success' },
  blocked: { glyph: '!', color: 'warning' },
}

const BOX: Record<Status, string> = { pending: ' ', active: '~', done: 'x', blocked: '!' }

// ---------- model ----------

function toStatus(raw: unknown): Status {
  if (raw === 'completed' || raw === 'done') return 'done'
  if (raw === 'in_progress' || raw === 'active') return 'active'
  if (raw === 'blocked') return 'blocked'
  return 'pending'
}

function clamp(raw: number): number {
  return Math.round(Math.min(100, Math.max(0, raw)))
}

/** Progress belongs to an item in progress; any other status carries none. */
function setStatus<T extends Task>(item: T, status: Status): T {
  const { progress, ...rest } = item
  return (status === 'active' && progress !== undefined ? { ...rest, status, progress } : { ...rest, status }) as T
}

/** A reported 0-100: full marks the item done, anything less puts it in progress. */
function setProgress<T extends Task>(item: T, raw: number): T {
  if (!Number.isFinite(raw)) return item
  const progress = clamp(raw)
  return progress === 100 ? setStatus(item, 'done') : { ...item, status: 'active', progress }
}

/** A step with tasks follows them: all done is done, any started is in progress. Blocked stays. */
function settle(step: Step): Step {
  if (step.status === 'blocked' || step.tasks.length === 0) return step
  if (step.tasks.every(t => t.status === 'done')) return setStatus(step, 'done')
  if (step.tasks.some(t => t.status !== 'pending')) return setStatus(step, 'active')
  return step
}

function share(item: Task): number {
  if (item.status === 'done') return 1
  return item.status === 'active' ? (item.progress ?? 0) / 100 : 0
}

function stepShare(step: Step): number {
  if (step.status === 'done' || step.tasks.length === 0) return share(step)
  return step.tasks.reduce((sum, t) => sum + share(t), 0) / step.tasks.length
}

/** Steps weigh by their task count, so a ten-task step counts more than a one-line one. */
function overall(p: Plan): number {
  const weight = (s: Step) => Math.max(1, s.tasks.length)
  const total = p.steps.reduce((sum, s) => sum + weight(s), 0)
  return total === 0 ? 0 : p.steps.reduce((sum, s) => sum + stepShare(s) * weight(s), 0) / total
}

function pct(fraction: number): number {
  return Math.round(fraction * 100)
}

function bar(fraction: number, width: number): [string, string] {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width)
  return ['━'.repeat(filled), '━'.repeat(width - filled)]
}

type RawTask = { text?: unknown; status?: unknown; progress?: unknown }
type RawStep = RawTask & { note?: unknown; tasks?: unknown }

function mintTask(raw: RawTask): Task | undefined {
  if (typeof raw?.text !== 'string' || raw.text.trim() === '') return undefined
  const task: Task = { id: crypto.randomUUID(), text: raw.text.trim(), status: toStatus(raw.status) }
  return typeof raw.progress === 'number' ? setProgress(task, raw.progress) : task
}

function mintStep(raw: RawStep): Step | undefined {
  const head = mintTask(raw)
  if (head === undefined) return undefined
  const tasks = (Array.isArray(raw.tasks) ? (raw.tasks as RawTask[]) : [])
    .map(mintTask)
    .filter((t): t is Task => t !== undefined)
  const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : undefined
  return { ...head, tasks, ...(note ? { note } : {}) }
}

type Update = { step?: unknown; task?: unknown; status?: unknown; progress?: unknown; note?: unknown; text?: unknown }

function applyUpdate<T extends Task & { note?: string }>(item: T, u: Update): T {
  let next = item
  if (typeof u.text === 'string' && u.text.trim()) next = { ...next, text: u.text.trim() }
  if (u.status !== undefined) next = setStatus(next, toStatus(u.status))
  if (typeof u.progress === 'number') next = setProgress(next, u.progress)
  if (typeof u.note === 'string') {
    const { note: _drop, ...rest } = next
    next = (u.note.trim() ? { ...rest, note: u.note.trim() } : rest) as T
  }
  return next
}

function applyUpdates(p: Plan, updates: Update[]): Plan {
  const steps = [...p.steps]
  for (const u of updates) {
    const at = typeof u?.step === 'number' ? u.step - 1 : -1
    const step = steps[at]
    if (step === undefined) continue
    if (typeof u.task === 'number') {
      const ti = u.task - 1
      if (step.tasks[ti] === undefined) continue
      const tasks = step.tasks.map((one, i) => (i === ti ? applyUpdate(one, u) : one))
      steps[at] = settle({ ...step, tasks })
    } else {
      steps[at] = applyUpdate(step, u)
    }
  }
  return { ...p, steps }
}

function summary(p: Plan): string {
  if (p.steps.length === 0) return 'The plan is empty.'
  const lines = [`Plan${p.title ? `: ${p.title}` : ''} (${pct(overall(p))}% done)`]
  p.steps.forEach((s, i) => {
    const count = s.tasks.length ? ` (${s.tasks.filter(t => t.status === 'done').length}/${s.tasks.length})` : ''
    lines.push(`${i + 1}. [${BOX[s.status]}] ${s.text} ${pct(stepShare(s))}%${count}${s.note ? ` — ${s.note}` : ''}`)
    s.tasks.forEach((t, j) => {
      const progress = t.status === 'active' && t.progress !== undefined ? ` (${t.progress}%)` : ''
      lines.push(`   ${j + 1}. [${BOX[t.status]}] ${t.text}${progress}`)
    })
  })
  return lines.join('\n')
}

function age(iso: string | undefined): string {
  const then = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(then)) return ''
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (mins < 1) return 'updated just now'
  if (mins < 60) return `updated ${mins}m ago`
  if (mins < 60 * 24) return `updated ${Math.round(mins / 60)}h ago`
  return `updated ${Math.round(mins / 60 / 24)}d ago`
}

type Now = { step: Step; task?: Task; fraction?: number; done?: number; total?: number }

/**
 * The plan as drawn: the item in progress with no reported progress takes the
 * share of the agent's turn list that is done. Stored data stays as reported.
 * shortcut: assumes the turn list is about the task in progress, upgrade if the agent names the task it works on
 */
function live(p: Plan, turnList: Task[]): { view: Plan; now?: Now } {
  const at = p.steps.findIndex(s => s.status === 'active')
  const step = p.steps[at]
  if (step === undefined) return { view: p }
  const done = turnList.filter(t => t.status === 'done').length
  const total = turnList.length
  const fromTurn = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : undefined
  const fill = <T extends Task>(item: T): T =>
    item.progress === undefined && fromTurn !== undefined ? { ...item, progress: fromTurn } : item
  const ti = step.tasks.findIndex(t => t.status === 'active')
  const task = step.tasks[ti]
  const nextStep: Step =
    task !== undefined
      ? { ...step, tasks: step.tasks.map((t, i) => (i === ti ? fill(t) : t)) }
      : step.tasks.length === 0
        ? fill(step)
        : step
  const view = { ...p, steps: p.steps.map((s, i) => (i === at ? nextStep : s)) }
  const item = task !== undefined ? nextStep.tasks[ti] : step.tasks.length === 0 ? nextStep : undefined
  const fraction = item?.progress !== undefined ? item.progress / 100 : undefined
  return {
    view,
    now: { step: nextStep, task: task !== undefined ? nextStep.tasks[ti] : undefined, fraction, ...(total ? { done, total } : {}) },
  }
}

// ---------- engine ----------

/** shortcut: one plan per project root, upgrade to named plans if a repo needs two at once */
async function storeKey($: EngineInterface): Promise<string> {
  return `plan:${await $.session.root()}`
}

async function paintStatus($: EngineInterface, stored: Plan) {
  const { view, now } = live(stored, await read($, turn))
  const where = now ? (now.task ?? now.step).text.slice(0, 40) : ''
  const part = now?.fraction !== undefined ? ` ${pct(now.fraction)}%` : ''
  $.ui.status(view.steps.length === 0 ? undefined : `Plan ${pct(overall(view))}%${where ? ` · ${where}${part}` : ''}`)
}

async function setPlan($: EngineInterface, change: (prev: Plan) => Plan) {
  const prev = await read($, plan)
  const next = { ...change(prev), updatedAt: new Date().toISOString() }
  await update($, plan, () => next)
  if (next.steps.length === 0) await $.store.delete(await storeKey($))
  else await $.store.set(await storeKey($), next)
  await paintStatus($, next)
  if (prev.steps.length === 0 && next.steps.length > 0 && !(await read($, isDismissed))) {
    $.ui.open({ id: PANE, title: 'Plan' }).catch(() => undefined)
  }
}

function withStatus(items: Task[], at: number, status: Status): Task[] {
  return items.map((item, i) => (i === at ? setStatus(item, status) : item))
}

/** The desktop app's advance / done / start steps, applied to the turn list. */
function applyPlanSteps(items: Task[], e: Record<string, unknown>): Task[] {
  if (Array.isArray(e.done)) {
    for (const n of e.done) if (typeof n === 'number') items = withStatus(items, n - 1, 'done')
  }
  if (e.advance === true) {
    const current = items.findIndex(t => t.status === 'active')
    if (current >= 0) items = withStatus(items, current, 'done')
    const nextPending = items.findIndex((t, i) => i > current && t.status === 'pending')
    if (nextPending >= 0) items = withStatus(items, nextPending, 'active')
  }
  if (typeof e.start === 'number') {
    items = items.map(t => (t.status === 'active' ? setStatus(t, 'pending') : t))
    items = withStatus(items, e.start - 1, 'active')
  }
  return items
}

const TOOL_DESCRIPTION = [
  'The master plan the person sees in their Plan pane: steps with subtasks and their progress,',
  'kept for this project across sessions. Call with no arguments to read it back.',
  '`steps` replaces the whole plan, each step with its `tasks`. `updates` changes one step, or one of its tasks,',
  'by 1-based `step` and `task`: `status`, `progress` (0-100; 100 marks it done), `note` (why a step is blocked, what is open).',
  'Take statuses from evidence (merged PRs, branches, files on main), not from checkboxes in a plan doc.',
  'Your own update_plan list already shows under the step in progress; use this tool for the plan itself,',
  'and update it as you finish its tasks.',
].join(' ')

const STATUS_ENUM = ['pending', 'active', 'done', 'blocked']
const TASK_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    status: { type: 'string', enum: STATUS_ENUM },
    progress: { type: 'number', minimum: 0, maximum: 100 },
  },
  required: ['text'],
}

function buildPrompt(request: string): string {
  return [
    `Lay out the master plan for this in my Plan pane: ${request}`,
    '',
    'Read what it points at first (specs, implementation plans, PRs, branches, tickets). Make one step per',
    'slice, phase or milestone, each with its tasks. Take each status from evidence (merged PRs, branches,',
    'what is on main), not from checkboxes in the docs; mark a step `blocked` with a `note` when something',
    `must happen before it can start. Then call ${TOOL} once with a short \`title\`, an optional \`note\``,
    '(the critical path, in one line) and the whole plan as `steps`. Only lay out the plan; do not start the work.',
  ].join('\n')
}

const REFRESH_PROMPT = [
  `Bring the plan in my Plan pane up to date. Read it back with ${TOOL}, check each open step and task`,
  'against the repo (merged PRs, branches, what is on main), and send the changes as `updates`.',
  'Only update the plan; do not start the work.',
].join(' ')

const SUBCOMMANDS = new Set(['show', 'hide', 'clear', 'refresh'])

/** Sends a prompt as the person's, once the hook that asked has returned. */
function ask($: EngineInterface, text: string) {
  $.clock.after(0, () => void $.prompt.submit({ text, asUser: true }).catch(() => undefined))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'plan-progress',
      description: 'Show the Plan pane, or lay out a master plan from a spec, plan, PR or goal',
      argumentHint: '[<request>|refresh|hide|clear]',
    })
    await $.tool.register({
      name: 'plan',
      description: TOOL_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title shown above the plan.' },
          note: { type: 'string', description: 'One line under the title, such as the critical path.' },
          steps: {
            type: 'array',
            description: 'Replaces the whole plan.',
            items: {
              ...TASK_SCHEMA,
              properties: {
                ...TASK_SCHEMA.properties,
                note: { type: 'string' },
                tasks: { type: 'array', items: TASK_SCHEMA },
              },
            },
          },
          updates: {
            type: 'array',
            description: 'Changes by 1-based position: a step, or a task of it when `task` is given.',
            items: {
              type: 'object',
              properties: {
                step: { type: 'number' },
                task: { type: 'number' },
                text: { type: 'string' },
                status: { type: 'string', enum: STATUS_ENUM },
                progress: { type: 'number', minimum: 0, maximum: 100 },
                note: { type: 'string', description: 'Empty string removes it.' },
              },
              required: ['step'],
            },
          },
          clear: { type: 'boolean', description: 'Empties the plan.' },
        },
      },
    })

    const stored = (await $.store.get(await storeKey($))) as Plan | undefined
    if (stored && Array.isArray(stored.steps)) await update($, plan, () => stored)
    const current = await read($, plan)
    await paintStatus($, current)
    if (current.steps.length > 0 && !(await read($, isDismissed))) {
      $.ui.open({ id: PANE, title: 'Plan' }).catch(() => undefined)
    }

    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const args = e as Record<string, unknown>
    const isRead = ['title', 'note', 'steps', 'updates', 'clear'].every(k => args[k] === undefined)
    if (!isRead) {
      await setPlan($, prev => {
        let p: Plan = args.clear === true ? EMPTY : prev
        if (typeof args.title === 'string' && args.title.trim()) p = { ...p, title: args.title.trim() }
        if (typeof args.note === 'string') p = { ...p, note: args.note.trim() || undefined }
        if (Array.isArray(args.steps)) {
          p = { ...p, steps: (args.steps as RawStep[]).map(mintStep).filter((s): s is Step => s !== undefined) }
        }
        if (Array.isArray(args.updates)) p = applyUpdates(p, args.updates as Update[])
        return p
      })
    }
    return { result: summary(await read($, plan)) }
  })

  // The agent's own task list becomes the turn list under the step in progress.
  on('tool.call', { tool: PLAN_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const args = e as Record<string, unknown>
    await update($, turn, prev => {
      let items = prev ?? []
      if (Array.isArray(args.items)) {
        items = (args.items as { content?: unknown; text?: unknown; status?: unknown }[])
          .map(one => mintTask({ text: one?.content ?? one?.text, status: one?.status }))
          .filter((t): t is Task => t !== undefined)
      }
      return applyPlanSteps(items, args)
    })
    await paintStatus($, await read($, plan))
    return ran
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    await update($, turn, () =>
      e.todos.map(todo => mintTask({ text: todo.content, status: todo.status })).filter((t): t is Task => t !== undefined),
    )
    await paintStatus($, await read($, plan))
    return ran
  })

  on('tool.call', { tool: WRAP_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    await update($, turn, prev => (prev ?? []).map(t => (t.status === 'active' ? setStatus(t, 'done') : t)))
    await paintStatus($, await read($, plan))
    return ran
  })

  // A plan kept from an earlier session: tell the agent once that it is there to keep current.
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta === true || (await read($, isBriefed))) return next(e)
    const p = await read($, plan)
    if (p.steps.length === 0) return next(e)
    await update($, isBriefed, () => true)
    const note = [
      `The person's Plan pane holds this project's master plan. When your work finishes or starts one of its`,
      `tasks, report it with ${TOOL} \`updates\`.`,
      summary(p),
    ].join('\n')
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, isDismissed, () => true)
    return next(e)
  })

  on('command.run', { command: 'plan-progress' }, async ($, e) => {
    const [verb = 'show'] = e.args.trim().split(/\s+/).filter(Boolean)

    if (verb === 'hide') {
      await update($, isDismissed, () => true)
      await $.ui.close({ id: PANE })
      return { text: 'Plan pane hidden. /plan-progress brings it back.' }
    }
    if (verb === 'clear') {
      await update($, plan, () => EMPTY)
      await update($, open, () => ({}))
      await $.store.delete(await storeKey($))
      await paintStatus($, EMPTY)
      return { text: 'Plan cleared for this project.' }
    }

    await update($, isDismissed, () => false)
    const opened = await $.ui.open({ id: PANE, title: 'Plan' })
    const where = opened.isPlaced ? '' : ' (no surface placed the pane right now)'

    // A command.run hook holds the turn, so the prompt goes once it has returned.
    if (verb === 'refresh') {
      ask($, REFRESH_PROMPT)
      return { text: `Bringing the plan up to date${where}.` }
    }
    if (!SUBCOMMANDS.has(verb)) {
      ask($, buildPrompt(e.args.trim()))
      return { text: `Laying out the plan${where}.` }
    }
    return { text: `${summary(await read($, plan))}${where}` }
  })

  // One row above the prompt: the plan and what is in progress. Press it to open the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const stored = await read($, plan)
    if (e.props.hasSurvey || stored.steps.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const { view, now } = live(stored, await read($, turn))
    const whole = overall(view)
    const where = now ? (now.task ? `${now.step.text} › ${now.task.text}` : now.step.text) : `${view.steps.filter(s => s.status === 'done').length} of ${view.steps.length} steps`
    const [filled, rest] = bar(now?.fraction ?? whole, 8)
    const tail = now?.fraction !== undefined ? `${pct(now.fraction)}%` : ''
    return (
      <Box flexDirection="row" justifyContent="space-between" gap="sm">
        <Box flexShrink={1}>
          <Button
            key="plan-band"
            plain
            onPress={async () => {
              await update($, isDismissed, () => false)
              await $.ui.open({ id: PANE, title: 'Plan' })
            }}
          >
            <Text wrap="truncate-end">
              <Text weight="semibold">Plan {pct(whole)}%</Text>
              <Text dimColor> · </Text>
              <Text>{where}</Text>
            </Text>
          </Button>
        </Box>
        <Text mono tabular>
          <Text color={now ? 'claude' : 'success'}>{filled}</Text>
          <Text color="subtle">{rest}</Text>
          {tail ? ` ${tail.padStart(4)}` : ''}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const stored = await read($, plan)
    const turnList = await read($, turn)
    const expanded = await read($, open)
    const { view: p, now } = live(stored, turnList)

    const columns = e.props.bodyColumns ?? 40

    const meter = (fraction: number, width: number, isDone: boolean) => {
      const [filled, rest] = bar(fraction, width)
      return (
        <Text mono>
          <Text color={isDone ? 'success' : 'claude'}>{filled}</Text>
          <Text color="subtle">{rest}</Text>
        </Text>
      )
    }

    // A bar on a line of its own, as wide as the room its indent and the text after it leave.
    const progressLine = (fraction: number, max: number, indent: number, detail?: string) => {
      const tail = `  ${pct(fraction)}%`
      const rest = detail ? ` · ${detail}` : ''
      const width = Math.max(6, Math.min(max, columns - indent - tail.length - rest.length))
      return (
        <Text size="footnote" tabular>
          {meter(fraction, width, fraction >= 1)}
          {tail}
          {rest ? <Text dimColor>{rest}</Text> : ''}
        </Text>
      )
    }

    const nowBlock = (n: Now) => (
      <Box key="now" flexDirection="column" marginTop="sm">
        <Text size="caption" wrap="truncate-end">
          <Text color="claude" weight="semibold">
            Now
          </Text>
          {n.task ? <Text dimColor>{` · ${n.step.text}`}</Text> : ''}
        </Text>
        <Text weight="medium">{(n.task ?? n.step).text}</Text>
        {n.fraction !== undefined &&
          progressLine(n.fraction, 32, 0, n.total ? `${n.done} of ${n.total} this turn` : undefined)}
      </Box>
    )

    // The task the Now block names keeps its bar there, not twice.
    const row = (item: Task, key: string, indent: number) => (
      <Box key={key} flexDirection="column">
        <Text wrap="truncate-end">
          <Text color={MARK[item.status].color}>{MARK[item.status].glyph}</Text>{' '}
          <Text dimColor={item.status === 'done'} weight={item.status === 'active' ? 'medium' : 'regular'}>
            {item.text}
          </Text>
        </Text>
        {item.status === 'active' && item.progress !== undefined && item.id !== now?.task?.id && (
          <Box paddingLeft={2}>{progressLine(item.progress / 100, 20, indent + 2)}</Box>
        )}
      </Box>
    )

    const turnRows = (indent: number) =>
      turnList.length === 0 ? null : (
        <Box flexDirection="column" paddingLeft={indent} marginTop="xs">
          <Text size="caption" dimColor>
            This turn
          </Text>
          {turnList.map(t => row(t, `turn-${t.id}`, indent + 4))}
        </Box>
      )

    if (p.steps.length === 0) {
      return (
        <Box flexDirection="column" gap="sm">
          <Text size="heading" weight="semibold">
            No plan yet
          </Text>
          <Text dimColor size="footnote">
            Point the agent at a spec, an implementation plan, a PR or a goal. It reads what is there, checks what
            has landed, and lays out the steps here with their tasks. The plan stays with this project across
            sessions.
          </Text>
          {Input !== undefined && (
            <Input
              key="request"
              placeholder="docs/plans/autopilot, a PR link, a goal"
              submitLabel="Lay out plan"
              onSubmit={value => {
                if (value.trim()) ask($, buildPrompt(value.trim()))
              }}
            />
          )}
          <Text dimColor size="caption">
            Or run /plan-progress with the same.
          </Text>
          {turnRows(0)}
        </Box>
      )
    }

    const whole = overall(p)
    const doneSteps = p.steps.filter(s => s.status === 'done').length
    const allTasks = p.steps.flatMap(s => s.tasks)
    const doneTasks = allTasks.filter(t => t.status === 'done').length
    const hasActive = p.steps.some(s => s.status === 'active')
    const facts = [
      `${doneSteps} of ${p.steps.length} steps`,
      allTasks.length ? `${doneTasks} of ${allTasks.length} tasks` : '',
      age(p.updatedAt),
    ].filter(Boolean)

    const toggle = (step: Step, isOpen: boolean) =>
      update($, open, prev => ({ ...(prev ?? {}), [step.id]: !isOpen }))

    return (
      <Box flexDirection="column" gap="md">
        <Box flexDirection="column" gap="xs">
          <Box flexDirection="row" justifyContent="space-between" gap="sm">
            <Box flexShrink={1}>
              <Text size="heading" weight="semibold" wrap="truncate-end">
                {p.title || 'Plan'}
              </Text>
            </Box>
            <Text size="heading" weight="semibold" tabular>
              {pct(whole)}%
            </Text>
          </Box>
          {meter(whole, Math.max(8, Math.min(56, columns - 2)), whole === 1)}
          <Text size="footnote" dimColor tabular>
            {facts.join(' · ')}
          </Text>
          {p.note && (
            <Text size="footnote" dimColor>
              {p.note}
            </Text>
          )}
          {now && nowBlock(now)}
        </Box>

        <Box flexDirection="column" gap="xs">
          {p.steps.map(step => {
            const hasBody = step.tasks.length > 0 || step.note !== undefined || (step.status === 'active' && turnList.length > 0)
            const isOpen = hasBody && (expanded[step.id] ?? (step.status === 'active' || step.status === 'blocked'))
            const fraction = stepShare(step)
            const count = step.tasks.length
              ? `${step.tasks.filter(t => t.status === 'done').length}/${step.tasks.length}`
              : ''
            // The step in progress puts its numbers on the bar below; any other shows its count.
            const isActive = step.status === 'active'
            const tally = isActive ? '' : count
            const label = (
              <Text wrap="truncate-end">
                <Text dimColor>{hasBody ? (isOpen ? '▾' : '▸') : ' '}</Text>{' '}
                <Text color={MARK[step.status].color}>{MARK[step.status].glyph}</Text>{' '}
                <Text dimColor={step.status === 'done'} weight={step.status === 'active' ? 'semibold' : 'regular'}>
                  {step.text}
                </Text>
              </Text>
            )
            return (
              <Box key={`step-${step.id}`} flexDirection="column">
                <Box flexDirection="row" justifyContent="space-between" gap="sm">
                  <Box flexShrink={1}>
                    {hasBody ? (
                      <Button key={`toggle-${step.id}`} plain onPress={() => toggle(step, isOpen)}>
                        {label}
                      </Button>
                    ) : (
                      label
                    )}
                  </Box>
                  {tally !== '' && (
                    <Text size="footnote" tabular dimColor>
                      {tally}
                    </Text>
                  )}
                </Box>
                {isActive && (
                  <Box paddingLeft={4}>
                    {progressLine(
                      fraction,
                      40,
                      4,
                      step.tasks.length
                        ? `${step.tasks.filter(t => t.status === 'done').length} of ${step.tasks.length} tasks`
                        : undefined,
                    )}
                  </Box>
                )}
                {isOpen && (
                  <Box flexDirection="column" paddingLeft={4} marginTop={isActive ? 'xs' : undefined}>
                    {step.note !== undefined && (
                      <Text
                        size="footnote"
                        color={step.status === 'blocked' ? 'warning' : undefined}
                        dimColor={step.status !== 'blocked'}
                      >
                        {step.note}
                      </Text>
                    )}
                    {step.tasks.map(t => row(t, `task-${t.id}`, 4))}
                    {step.status === 'active' && turnRows(0)}
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>

        {!hasActive && turnRows(0)}

        <Box flexDirection="row">
          <Button key="refresh" plain dimColor label="Check against the repo" onPress={() => ask($, REFRESH_PROMPT)} />
        </Box>
      </Box>
    )
  })
}
