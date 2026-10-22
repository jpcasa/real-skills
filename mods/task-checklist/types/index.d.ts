export type ItemStatus = 'pending' | 'active' | 'done'

/** `progress` is 0-100, reported by the agent; only the item in progress carries one. */
export type ChecklistItem = { id: string; text: string; status: ItemStatus; progress?: number }

export type Checklist = { title: string; items: ChecklistItem[] }

declare module 'claude-code' {
  interface PluginState {
    'task-checklist': {
      list: Checklist
      edits: string[]
      isDismissed: boolean
    }
  }
}
