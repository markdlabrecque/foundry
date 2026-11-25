import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Stage, Ticket } from '../types'

const PANE = 'stack-tickets'
const ID = /\b[A-Z][A-Z0-9]*-\d+\b/
const tickets = atom({ plugin: 'stack-tickets', key: 'tickets' } as const, [], { shape: 'tickets-1' })
const nowAtom = atom({ plugin: 'stack-tickets', key: 'now' } as const, 0, { shape: 'now-1' })

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

async function setStage($: any, id: string, stage: Stage) {
  const at = await $.clock.now()
  await update($, tickets, (list: Ticket[]) => {
    const one = list.find(t => t.id === id)
    if (!one) return [...list, { id, stage, startedAt: at, ...(stage === 'Done' ? { doneAt: at } : {}) }]
    if (one.stage === 'Done') return list
    return list.map(t => (t.id === id ? { ...t, stage, ...(stage === 'Done' ? { doneAt: at } : {}) } : t))
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, nowAtom, () => Date.now())
    $.clock.every(1000, async () => {
      await update($, nowAtom, async () => await $.clock.now())
    })
    await $.command.register({ name: 'stack-demo', description: 'Fill the Stack tickets pane with mock tickets' })
    await $.command.register({ name: 'stack-demo-clear', description: 'Clear the Stack tickets pane' })
    void $.ui.open({ id: PANE, title: 'Stack tickets' })
    return next(e)
  })

  on('command.run', { command: 'stack-demo' }, async $ => {
    const at = await $.clock.now()
    const min = 60000
    await update($, tickets, () => [
      { id: 'FND-12', stage: 'Done', startedAt: at - 46 * min, doneAt: at - 31 * min },
      { id: 'FND-13', stage: 'Review', startedAt: at - 9 * min },
      { id: 'FND-14', stage: 'Implementation', startedAt: at - 3 * min },
      { id: 'FND-15', stage: 'Implementation', startedAt: at - 75 * min },
    ])
    const opened = await $.ui.open({ id: PANE, title: 'Stack tickets' })
    return { text: opened.isPlaced ? 'Mock tickets added.' : `Mock tickets added, pane not placed: ${opened.reason}` }
  })

  on('command.run', { command: 'stack-demo-clear' }, async $ => {
    await update($, tickets, () => [])
    return { text: 'Cleared.' }
  })

  on('tool.call', async ($, e: any, next) => {
    const agent = e.tool === 'Agent' ? String(e.subagent_type ?? '') : ''
    if (agent === 'stack-runner:implementer' || agent === 'stack-runner:reviewer') {
      const id = ID.exec(`${e.description ?? ''} ${e.prompt ?? ''}`)?.[0]
      if (id) await setStage($, id, agent.endsWith('reviewer') ? 'Review' : 'Implementation')
    } else if (String(e.tool).endsWith('save_issue') && /^done$/i.test(String(e.state ?? ''))) {
      const id = ID.exec(String(e.id ?? ''))?.[0]
      if (id) await setStage($, id, 'Done')
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, tickets)
    const now = await read($, nowAtom)
    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No tickets yet.</Text>}
        {list.map(t => (
          <Box flexDirection="column">
            <Text bold>{t.id} <Text dimColor>{fmt((t.doneAt ?? now) - t.startedAt)}</Text></Text>
            <Text color={t.stage === 'Done' ? 'green' : t.stage === 'Review' ? 'yellow' : 'cyan'}>  {t.stage}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
