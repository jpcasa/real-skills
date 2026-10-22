export type Status = 'pending' | 'active' | 'done' | 'blocked'

/** `progress` is 0-100, reported by the agent; only an item in progress carries one. */
export type Task = { id: string; text: string; status: Status; progress?: number }

export type Step = Task & { note?: string; tasks: Task[] }

export type Plan = { title: string; note?: string; steps: Step[]; updatedAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'plan-progress': {
      plan: Plan
      /** The agent's own task list for the turn, shown under the step in progress. */
      turn: Task[]
      /** Expanded or collapsed per step id; a step absent here is open while in progress. */
      open: Record<string, boolean>
      isDismissed: boolean
      isBriefed: boolean
    }
  }
}
