import { afterEach, describe, expect, it } from 'vitest'
import type { Caller } from '../api/envelope.ts'
import { cleanup, harness } from './plugins-manager-fakes.ts'

afterEach(cleanup)

const call = (caller: Caller, action: string, args?: unknown) => ({ callId: 'c1', caller, action, args, deadline: Date.now() + 30_000 })
const http: Caller = { kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 1 }

// core.* is the plugins manager's alone, the caller's own name and the door's refusals among it
describe('the plugins manager\'s core actions', () => {
  it('answers core.self with the caller its way in named', async () => {
    const { pluginsManager } = await harness()
    expect(await pluginsManager.serve(call(http, 'core.self'))).toEqual(http)
  })

  it('writes core.agentRefused as http.refused through recording, coalesced by reason with the count as its weight', async () => {
    const { pluginsManager, link } = await harness()
    expect(await pluginsManager.serve(call(http, 'core.agentRefused', { reason: 'host', count: 3 }))).toBeNull()
    expect(link.coalesces).toEqual([{ event: 'http.refused', fields: { reason: 'host' }, weight: 3 }])
  })
})
