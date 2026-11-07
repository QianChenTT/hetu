import { afterEach, describe, expect, it } from 'vitest'
import { Calls } from '../sdk/calls.ts'
import { definePlugin, type PluginContext, run, type RunOptions } from '../sdk/plugin.ts'
import { attempt, Refused } from '../sdk/refused.ts'
import { Sender } from '../sdk/transport.ts'
import { cleanup, harness, tick, worker } from './carrier-fakes.ts'
import { clientOn, sdkTransport, type TransportOptions } from './sdk-fakes.ts'

afterEach(cleanup)

// search reads notes/** and calls mcp, which serves handle from its own port
function setup() {
  const parts = harness()
  parts.loader.sandboxed('search')
  parts.loader.sandboxed('mcp', { handle: {} })
  parts.gate.grants.search = [{ type: 'luoshu.read', paths: ['notes/**'] }, { type: 'plugin.call', targets: ['mcp'] }]
  parts.luoshu.files.set('notes/a.md', 'hello')
  return { ...parts, ...clientOn(parts.carrier, worker('search')), mcp: parts.connect(worker('mcp')) }
}

describe('a call through the SDK', () => {
  it('resolves a typed provider call with the provider\'s result', async () => {
    const { client } = setup()
    expect(await client.luoshu.read({ path: 'notes/a.md' })).toEqual({ text: 'hello' })
  })

  it('rejects a refusal as Refused with its code and action', async () => {
    const { client } = setup()
    const refused = await client.luoshu.read({ path: 'secret/b.md' }).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(Refused)
    expect(refused).toBeInstanceOf(Error)
    expect(refused).toMatchObject({ code: 'not-granted', action: 'luoshu.read' })
  })

  it('gives a refusal back from attempt instead of throwing', async () => {
    const { client } = setup()
    const refused = await attempt(client.luoshu.read({ path: 'secret/b.md' }))
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.refused.code).toBe('not-granted')
    expect(await attempt(client.luoshu.read({ path: 'notes/a.md' }))).toEqual({ ok: true, value: { text: 'hello' } })
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

async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > ms) throw new Error('nothing arrived in time')
    await tick(5)
  }
}

// search as a running plugin, so the limits the runtime knows reach its calls
async function plugin(limits: RunOptions['limits'] = {}, way: TransportOptions = {}) {
  const parts = harness()
  parts.loader.sandboxed('search')
  parts.loader.sandboxed('mcp', { handle: {} })
  parts.gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }, { type: 'plugin.call', targets: ['mcp'] }]
  parts.luoshu.files.set('notes/a.md', 'hello')
  let ctx: PluginContext | null = null
  const transport = sdkTransport(parts.carrier, worker('search'), way)
  run(definePlugin({ start: given => { ctx = given } }), transport, { limits })
  parts.carrier.send(worker('search'), { v: 1, kind: 'init', id: 'search', incarnation: 1, api: 1, deps: {}, lastStop: null, previousVersion: null })
  await until(() => ctx !== null && parts.loader.lifecycle.some(entry => entry.kind === 'ready'))
  return { ...parts, ctx: ctx!, transport, mcp: parts.connect(worker('mcp')) }
}

describe('what a call hides', () => {
  it('retries a call refused starting until the provider is ready', async () => {
    const { ctx, loader } = await plugin()
    loader.installed('luoshu', 'starting')
    setTimeout(() => loader.installed('luoshu', 'ready'), 100)
    expect(await ctx.luoshu.read({ path: 'notes/a.md' })).toEqual({ text: 'hello' })
  })

  it('gives up on starting at the call\'s deadline with the last refusal', async () => {
    const { ctx, loader } = await plugin()
    loader.installed('luoshu', 'starting')
    const started = Date.now()
    await expect(ctx.luoshu.read({ path: 'notes/a.md' }, { timeoutMs: 200 })).rejects.toMatchObject({ code: 'starting' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('retries a call refused throttled', async () => {
    const parts = await plugin()
    parts.loader.human.plugins.search = { callsInFlight: 1 }
    let release: () => void = () => {}
    parts.luoshu.hold.prepare = new Promise<void>(resolve => { release = () => resolve() })
    const reads = [1, 2, 3].map(() => parts.ctx.luoshu.read({ path: 'notes/a.md' }))
    setTimeout(() => release(), 100)
    expect(await Promise.all(reads)).toEqual([{ text: 'hello' }, { text: 'hello' }, { text: 'hello' }])
  })

  it('keeps no more calls in flight than callsInFlight', async () => {
    const parts = await plugin({ callsInFlight: 2 })
    let release: () => void = () => {}
    parts.luoshu.hold.prepare = new Promise<void>(resolve => { release = () => resolve() })
    const reads = [1, 2, 3, 4, 5].map(() => parts.ctx.luoshu.read({ path: 'notes/a.md' }))
    await tick(60)
    expect(parts.luoshu.prepared).toHaveLength(2)
    release()
    expect(await Promise.all(reads)).toHaveLength(5)
  })

  it('paces its messages under messagesPerSecond', { timeout: 10_000 }, async () => {
    const parts = await plugin({ messagesPerSecond: 20 })
    // The carrier counts messages as they arrive, and a busy runner hands over messages sent apart in a bunch. 24
    // leaves room for that and still drops a burst of 40 sent at once
    parts.loader.human.plugins.search = { messagesPerSecond: 24 }
    const selves = Array.from({ length: 40 }, () => parts.ctx.call('core', 'self', {}, { timeoutMs: 6000 }))
    const results = await Promise.all(selves)
    expect(results.every(result => (result as { id?: string }).id === 'search')).toBe(true)
    expect(parts.loader.crashes).toEqual([])
  })

  it('settles a call whose reply never came', async () => {
    const calls = new Calls(new Sender(() => {}, 1000), { callsInFlight: 64, callDeadlineMs: 30000 })
    const started = Date.now()
    await expect(calls.request('core.self', {}, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'timeout', action: 'core.self' })
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('cancels a call when its signal aborts', async () => {
    const { ctx, mcp } = await plugin()
    const controller = new AbortController()
    const pending = ctx.call('mcp', 'handle', {}, { signal: controller.signal }).catch((err: unknown) => err)
    const delivery = await mcp.delivered('mcp.handle')
    const reason = new Error('superseded')
    controller.abort(reason)
    expect(await pending).toBe(reason)
    await mcp.waitFor(message => message.kind === 'cancel' && message.callId === delivery.callId)
  })

  it('rejects at once for a signal already aborted', async () => {
    const { ctx, transport } = await plugin()
    const before = transport.sent.length
    const reason = new Error('gone')
    await expect(ctx.luoshu.read({ path: 'notes/a.md' }, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
    await tick(20)
    expect(transport.sent.length).toBe(before)
  })
})

describe('a call that runs out of time or can\'t go out', () => {
  it('never sends a call whose deadline passed while it waited its turn', async () => {
    const parts = await plugin({ callsInFlight: 1 })
    let release: () => void = () => {}
    parts.luoshu.hold.prepare = new Promise<void>(resolve => { release = () => resolve() })
    const first = parts.ctx.luoshu.read({ path: 'notes/a.md' })
    const started = Date.now()
    await expect(parts.ctx.luoshu.read({ path: 'notes/a.md' }, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'timeout' })
    expect(Date.now() - started).toBeLessThan(400)
    release()
    await first
    await tick(50)
    expect(parts.luoshu.prepared).toHaveLength(1)
  })

  it('cancels a call it gives up on at its own timeoutMs', async () => {
    const { ctx, mcp } = await plugin()
    const started = Date.now()
    const settled = ctx.call('mcp', 'handle', {}, { timeoutMs: 100 }).catch((err: unknown) => err)
    const delivery = await mcp.delivered('mcp.handle')
    expect(await settled).toMatchObject({ code: 'timeout', action: 'mcp.handle' })
    expect(Date.now() - started).toBeLessThan(500)
    await mcp.waitFor(message => message.kind === 'cancel' && message.callId === delivery.callId)
  })

  it('refuses args that can\'t cross as invalid, at once and with nothing sent', async () => {
    const { ctx, transport } = await plugin()
    const before = transport.sent.length
    const started = Date.now()
    await expect(ctx.call('mcp', 'handle', { run: () => 1 })).rejects.toMatchObject({ code: 'invalid', action: 'mcp.handle' })
    expect(Date.now() - started).toBeLessThan(100)
    expect(transport.sent.length).toBe(before)
  })

  it('settles a call whose message a port can\'t copy and keeps the others going', async () => {
    const parts = await plugin({ callsInFlight: 1 }, { clone: true })
    const first = parts.ctx.call('mcp', 'handle', {})
    const bad = parts.ctx.call('mcp', 'handle', new Proxy({}, {})).catch((err: unknown) => err)
    const delivery = await parts.mcp.delivered('mcp.handle')
    parts.mcp.answer(delivery.callId, 'one')
    expect(await first).toBe('one')
    expect(await bad).toMatchObject({ code: 'invalid', action: 'mcp.handle' })
  })
})
