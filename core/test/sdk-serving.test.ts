import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Capability } from '../api/capabilities.ts'
import { definePlugin, type PluginContext, run } from '../sdk/plugin.ts'
import { Refused } from '../sdk/refused.ts'
import type { IncomingCall } from '../sdk/serving.ts'
import { cleanup, code, harness, tick, worker } from './carrier-fakes.ts'
import { sdkTransport } from './sdk-fakes.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > ms) throw new Error('nothing arrived in time')
    await tick(5)
  }
}

// search serves query (and other, which it never provides) through the SDK. tester calls it from its own port
async function serving(handler: (call: IncomingCall, args: unknown, ctx: PluginContext) => unknown, testerGrants: Capability[] = []) {
  const parts = harness()
  parts.loader.sandboxed('search', { query: {}, other: {} })
  parts.loader.sandboxed('tester')
  parts.gate.grants.search = [{ type: 'vault.read', paths: ['**'] }]
  parts.gate.grants.tester = [{ type: 'plugin.call', targets: ['search'] }, ...testerGrants]
  parts.vault.files.set('notes/a.md', 'hello')
  run(definePlugin({ start: ctx => { ctx.provide('query', (call, args) => handler(call, args, ctx)) } }), sdkTransport(parts.carrier, worker('search')))
  parts.carrier.send(worker('search'), { v: 1, kind: 'init', id: 'search', incarnation: 1, api: 1, deps: {}, lastStop: null, previousVersion: null })
  await until(() => parts.loader.lifecycle.some(entry => entry.kind === 'ready'))
  return { ...parts, tester: parts.connect(worker('tester')) }
}

describe('a plugin serving its actions through the SDK', () => {
  it('answers a delivered call with what its handler returned', async () => {
    const { tester } = await serving(() => ({ paths: ['notes/a.md'] }))
    const reply = await tester.ask('search.query', { text: 'hello' })
    expect(reply).toMatchObject({ ok: true, result: { paths: ['notes/a.md'] } })
  })

  it('hands the handler the caller, onBehalf and the deadline the carrier set', async () => {
    let seen: { call: IncomingCall, args: unknown } | null = null
    const { tester } = await serving((call, args) => {
      seen = { call, args }
      return null
    })
    const before = Date.now()
    await tester.ask('search.query', { text: 'hello' }, { onBehalf: 'client-1' })
    expect(seen!.args).toEqual({ text: 'hello' })
    expect(seen!.call).toMatchObject({ caller: worker('tester'), action: 'search.query', onBehalf: 'client-1' })
    expect(typeof seen!.call.callId).toBe('string')
    expect(seen!.call.deadline).toBeGreaterThan(before)
  })

  it('answers a thrown Refused with its code and reason', async () => {
    const { tester } = await serving(() => { throw new Refused('invalid', 'search.query', { reason: 'too-large' }) })
    const reply = await tester.ask('search.query', {})
    expect(reply.refusal).toMatchObject({ code: 'invalid', reason: 'too-large' })
  })

  it('answers failed for any other throw and keeps serving', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let calls = 0
    const { tester } = await serving(() => {
      if (calls++ === 0) throw new TypeError('a bug')
      return 'fine'
    })
    expect(code(await tester.ask('search.query', {}))).toBe('failed')
    expect(await tester.ask('search.query', {})).toMatchObject({ ok: true, result: 'fine' })
  })

  it('answers failed for a result that can\'t cross', async () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const results: unknown[] = [() => 1, cycle, new Map([['a', 1]]), 10n, 'plain']
    let next = 0
    const { tester } = await serving(() => results[next++])
    for (let i = 0; i < 4; i++) {
      const started = Date.now()
      expect(code(await tester.ask('search.query', {}))).toBe('failed')
      expect(Date.now() - started).toBeLessThan(200)
    }
    expect(await tester.ask('search.query', {})).toMatchObject({ ok: true, result: 'plain' })
  })

  it('answers failed for a declared action it never provided', async () => {
    const { tester } = await serving(() => null)
    expect(code(await tester.ask('search.other', {}))).toBe('failed')
  })

  it('aborts call.signal when the carrier cancels the call', async () => {
    let seen: IncomingCall | null = null
    const { tester } = await serving(call => {
      seen = call
      return new Promise(() => {})
    })
    const id = tester.call('search.query', {})
    await until(() => seen !== null)
    expect(seen!.signal.aborted).toBe(false)
    tester.post({ v: 1, kind: 'cancel', id })
    await until(() => seen!.signal.aborted)
  })

  it('sets parent on calls made through call.ctx', async () => {
    let seen: IncomingCall | null = null
    const parts = await serving(async call => {
      seen = call
      return await call.ctx.vault.read({ path: 'notes/a.md' })
    })
    expect(await parts.tester.ask('search.query', {})).toMatchObject({ ok: true, result: { text: 'hello' } })
    const prepared = parts.vault.prepared.at(-1)!
    expect(prepared.parent).toBe(seen!.callId)
    expect(prepared.deadline).toBeLessThanOrEqual(seen!.deadline)
  })

  it('filters paths to those the caller may read too', async () => {
    const { tester } = await serving(
      (call, _args, ctx) => ctx.filterReadable(call, ['public/a.md', 'private/b.md']),
      [{ type: 'vault.read', paths: ['public/**'] }],
    )
    expect(await tester.ask('search.query', {})).toMatchObject({ ok: true, result: ['public/a.md'] })
  })
})
