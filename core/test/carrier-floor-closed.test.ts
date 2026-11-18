import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Call } from '../api/slots.ts'
import { cleanup, code, editor, harness, host, hostHalf, trusted, windowWay, worker } from './carrier-fakes.ts'

// The core table with one more action whose from names no rule the floor has, as one added to the table without its
// line in the floor would
vi.mock('../api/actions.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../api/actions.ts')>()
  const ghost = Object.freeze({ from: 'ghost', args: z.strictObject({}).optional() })
  return { ...real, coreActions: Object.freeze(Object.assign(Object.create(null), real.coreActions, { 'core.ghost': ghost })) }
})

afterEach(cleanup)

describe('the floor\'s core branch', () => {
  it.each(['on', 'off', 'failed'] as const)('refuses a core action whose from it has no rule for to every caller, with the gate %s', async state => {
    const seen: Call[] = []
    const { carrier, connect, loader, gate } = harness({ core: async call => { seen.push(call); return null } })
    loader.slots.gate = state
    loader.utility('mcp-http-handler')
    loader.sandboxed('search')
    loader.installed('watchdog')
    const way = windowWay(carrier, { 'editor-1': editor, trusted })
    const replies = [
      await connect(worker('search')).ask('core.ghost'),
      await connect(host('mcp-http-handler')).ask('core.ghost'),
      await hostHalf(carrier, host('watchdog')).ask('core.ghost'),
      await way.ask('editor-1', 'core.ghost'),
      await way.ask('trusted', 'core.ghost'),
    ]
    expect(replies.map(code)).toEqual(Array(replies.length).fill('not-granted'))
    expect(seen).toEqual([])
    expect(gate.asked).toEqual([])
  })
})
