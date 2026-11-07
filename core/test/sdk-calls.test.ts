import { afterEach, describe, expect, it } from 'vitest'
import { attempt, Refused } from '../sdk/refused.ts'
import { cleanup, harness, worker } from './carrier-fakes.ts'
import { clientOn } from './sdk-fakes.ts'

afterEach(cleanup)

// search reads notes/** and calls mcp, which serves handle from its own port
function setup() {
  const parts = harness()
  parts.loader.sandboxed('search')
  parts.loader.sandboxed('mcp', { handle: {} })
  parts.gate.grants.search = [{ type: 'vault.read', paths: ['notes/**'] }, { type: 'plugin.call', targets: ['mcp'] }]
  parts.vault.files.set('notes/a.md', 'hello')
  return { ...parts, ...clientOn(parts.carrier, worker('search')), mcp: parts.connect(worker('mcp')) }
}

describe('a call through the SDK', () => {
  it('resolves a typed provider call with the provider\'s result', async () => {
    const { client } = setup()
    expect(await client.vault.read({ path: 'notes/a.md' })).toEqual({ text: 'hello' })
  })

  it('rejects a refusal as Refused with its code and action', async () => {
    const { client } = setup()
    const refused = await client.vault.read({ path: 'secret/b.md' }).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(Refused)
    expect(refused).toBeInstanceOf(Error)
    expect(refused).toMatchObject({ code: 'not-granted', action: 'vault.read' })
  })

  it('gives a refusal back from attempt instead of throwing', async () => {
    const { client } = setup()
    const refused = await attempt(client.vault.read({ path: 'secret/b.md' }))
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.refused.code).toBe('not-granted')
    expect(await attempt(client.vault.read({ path: 'notes/a.md' }))).toEqual({ ok: true, value: { text: 'hello' } })
  })

  it('rethrows from attempt anything but a refusal', async () => {
    await expect(attempt(Promise.reject(new TypeError('a bug')))).rejects.toThrow('a bug')
  })

  it('calls another plugin as <target>.<name>', async () => {
    const { client, mcp } = setup()
    const result = client.call('mcp', 'handle', {})
    const delivery = await mcp.delivered('mcp.handle')
    mcp.answer(delivery.callId, { done: 1 })
    expect(await result).toEqual({ done: 1 })
  })

  it('sends onBehalf with the call', async () => {
    const { client, mcp } = setup()
    void client.call('mcp', 'handle', {}, { onBehalf: 'client-1' })
    expect((await mcp.delivered('mcp.handle')).onBehalf).toBe('client-1')
  })

  it('matches each reply to its own call', async () => {
    const { client, mcp } = setup()
    const one = client.call('mcp', 'handle', { n: 1 })
    const two = client.call('mcp', 'handle', { n: 2 })
    const first = await mcp.waitFor(message => message.kind === 'call' && (message.args as { n: number }).n === 1)
    const second = await mcp.waitFor(message => message.kind === 'call' && (message.args as { n: number }).n === 2)
    mcp.answer(second.callId, 'two')
    mcp.answer(first.callId, 'one')
    expect(await Promise.all([one, two])).toEqual(['one', 'two'])
  })

  it('sends an action with no arguments an empty object', async () => {
    const { client, transport } = setup()
    await client.storage.get({ key: 'a' })
    // No leases provider in the harness, so the call answers unavailable
    await client.leases.list().catch(() => {})
    const sent = transport.sent as { action: string, args: unknown }[]
    expect(sent.find(message => message.action === 'leases.list')?.args).toEqual({})
  })
})
