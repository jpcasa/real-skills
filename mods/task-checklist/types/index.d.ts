export type ItemStatus = 'pending' | 'active' | 'done'

export type ChecklistItem = { id: string; text: string; status: ItemStatus }

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
