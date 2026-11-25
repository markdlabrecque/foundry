export type Stage = 'Implementation' | 'Review' | 'Done'
export type Ticket = { id: string; stage: Stage; startedAt: number; doneAt?: number }

declare module 'claude-code' {
  interface PluginState {
    'stack-tickets': { tickets: Shaped<Ticket[]>; now: Shaped<number> }
  }
}
