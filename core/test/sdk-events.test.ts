import { afterEach, describe, expect, it, vi } from 'vitest'
import { definePlugin, type PluginContext, run } from '../sdk/plugin.ts'
import type { Refused } from '../sdk/refused.ts'
import { cleanup, harness, host, hostHalf, tick, worker } from './carrier-fakes.ts'
import { sdkTransport, type TransportOptions } from './sdk-fakes.ts'

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

type Sent = { kind: string, action?: string, args?: { topics?: string[] }, seq?: number }

// search subscribes to the luoshu's topics and publishes its own indexed. The luoshu publishes from its host handle
async function listening(way: TransportOptions = {}) {
  const parts = harness()
  parts.loader.sandboxed('search')
  parts.loader.plugins.search.topics = ['indexed']
  parts.loader.sandboxed('git')
  parts.gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }, { type: 'events.subscribe', topics: ['luoshu.changed', 'luoshu.outside'] }]
  parts.gate.grants.git = [{ type: 'luoshu.read', paths: ['**'] }, { type: 'events.subscribe', topics: ['search.indexed'] }]
  let ctx: PluginContext | null = null
  const transport = sdkTransport(parts.carrier, worker('search'), way)
  run(definePlugin({ start: given => { ctx = given } }), transport)
  parts.carrier.send(worker('search'), { v: 1, kind: 'init', id: 'search', incarnation: 1, api: 1, deps: {}, lastStop: null, previousVersion: null })
  await until(() => ctx !== null && parts.loader.lifecycle.some(entry => entry.kind === 'ready'))
  const luoshu = hostHalf(parts.carrier, host('luoshu'))
  const publish = (path?: string, topic = 'luoshu.changed') => luoshu.ask('events.publish', path === undefined ? { topic } : { topic, path })
  const sent = () => transport.sent as Sent[]
  const subscribes = () => sent().filter(message => message.action === 'events.subscribe').map(message => message.args!.topics)
  return { ...parts, ctx: ctx!, transport, publish, sent, subscribes }
}

describe('events through the SDK', () => {
  it('hands each event to the handlers of its topic in order', async () => {
    const { ctx, publish } = await listening()
    const changed: (string | undefined)[] = []
    const outside: (string | undefined)[] = []
    await ctx.events.on('luoshu.changed', event => { changed.push(event.path) })
    await ctx.events.on('luoshu.outside', event => { outside.push(event.path) })
    for (const path of ['notes/a.md', 'notes/b.md', 'notes/c.md']) await publish(path)
    await until(() => changed.length === 3)
    expect(changed).toEqual(['notes/a.md', 'notes/b.md', 'notes/c.md'])
    expect(outside).toEqual([])
  })

  it('subscribes a topic once however many handlers it has and unsubscribes when the last is off', async () => {
    const { ctx, publish, sent, subscribes } = await listening()
    const first: string[] = []
    const second: string[] = []
    const one = await ctx.events.on('luoshu.changed', event => { first.push(event.path!) })
    const two = await ctx.events.on('luoshu.changed', event => { second.push(event.path!) })
    expect(subscribes()).toEqual([['luoshu.changed']])
    await publish('notes/a.md')
    await until(() => first.length === 1 && second.length === 1)
    await one.off()
    expect(sent().filter(message => message.action === 'events.unsubscribe')).toEqual([])
    await publish('notes/b.md')
    await until(() => second.length === 2)
    expect(first).toEqual(['notes/a.md'])
    await two.off()
    expect(sent().filter(message => message.action === 'events.unsubscribe').map(message => message.args!.topics)).toEqual([['luoshu.changed']])
  })

  it('subscribes to core topics in a call of their own', async () => {
    const { ctx, subscribes } = await listening()
    await ctx.events.on(['core.status', 'luoshu.changed'], () => {}).catch(() => {})
    expect(subscribes().sort()).toEqual([['core.status'], ['luoshu.changed']])
  })

  it('reports the topics the bus keeps standing', async () => {
    const { ctx, loader } = await listening()
    loader.slots.gate = 'starting'
    const subscription = await ctx.events.on('luoshu.changed', () => {})
    expect(subscription.standing).toEqual(['luoshu.changed'])
  })

  it('acknowledges once a batch is handled and once when idle', async () => {
    const { ctx, publish, sent } = await listening()
    const seen: string[] = []
    await ctx.events.on('luoshu.changed', event => { seen.push(event.path!) })
    await Promise.all(['notes/a.md', 'notes/b.md', 'notes/c.md'].map(path => publish(path)))
    await until(() => seen.length === 3)
    await tick(30)
    expect(sent().filter(message => message.kind === 'ack').map(message => message.seq)).toEqual([3])
  })

  it('acks only what it handled, so credits hold the bus back and a resync follows', async () => {
    const { ctx, loader, publish } = await listening()
    loader.human.plugins.search = { eventCredits: 4 }
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const seen: string[] = []
    const resyncs: string[][] = []
    await ctx.events.on('luoshu.changed', async event => {
      seen.push(event.path!)
      if (seen.length === 1) await held
    }, { onResync: topics => { resyncs.push(topics) } })
    for (let i = 0; i < 10; i++) await publish(`notes/${i}.md`)
    await tick(30)
    expect(seen).toEqual(['notes/0.md'])
    release()
    await until(() => resyncs.length === 1)
    expect(seen).toEqual(['notes/0.md', 'notes/1.md', 'notes/2.md', 'notes/3.md'])
    expect(resyncs).toEqual([['luoshu.changed']])
  })

  it('subscribes again once when the bus ends a subscription and reports the refusal', async () => {
    const { carrier, ctx, gate, loader, subscribes } = await listening()
    const ended: { refused: Refused, topics: string[] }[] = []
    await ctx.events.on('luoshu.changed', () => {}, { onEnded: (refused, topics) => { ended.push({ refused, topics }) } })
    gate.grants.search = [{ type: 'luoshu.read', paths: ['**'] }]
    loader.current = 2
    carrier.changed()
    await until(() => ended.length === 1)
    expect(ended[0].refused.code).toBe('not-granted')
    expect(ended[0].topics).toEqual(['luoshu.changed'])
    expect(subscribes()).toEqual([['luoshu.changed'], ['luoshu.changed']])
  })

  it('publishes its own topic with a path', async () => {
    const { connect, ctx } = await listening()
    const git = connect(worker('git'))
    expect((await git.ask('events.subscribe', { topics: ['search.indexed'] })).ok).toBe(true)
    await ctx.events.publish('indexed', 'notes/a.md')
    const event = await git.waitFor(message => message.kind === 'event' && message.topic === 'search.indexed')
    expect(event.path).toBe('notes/a.md')
  })

  it('keeps handling after a handler throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ctx, publish } = await listening()
    const seen: string[] = []
    await ctx.events.on('luoshu.changed', event => {
      seen.push(event.path!)
      if (seen.length === 1) throw new Error('a bug')
    })
    await publish('notes/a.md')
    await publish('notes/b.md')
    await until(() => seen.length === 2)
  })
})

describe('an ack the carrier lost', () => {
  // The carrier drops a message over the rate unread. Losing the ack that frees the last credits would hold the bus
  // back for the rest of the run
  it('goes again, so the bus catches up and sends a resync', async () => {
    let lost = false
    const { ctx, loader, publish } = await listening({
      drop: message => {
        if (lost || message.kind !== 'ack' || message.seq !== 4) return false
        lost = true
        return true
      },
    })
    loader.human.plugins.search = { eventCredits: 4 }
    const seen: string[] = []
    const resyncs: string[][] = []
    await ctx.events.on('luoshu.changed', event => { seen.push(event.path!) }, { onResync: topics => { resyncs.push(topics) } })
    // A burst past the credits, so the one ack that would free them is the one lost
    await Promise.all(Array.from({ length: 6 }, (_, i) => publish(`notes/${i}.md`)))
    await until(() => seen.length === 4)
    await tick(100)
    expect(lost).toBe(true)
    expect(seen).toHaveLength(4)
    await until(() => resyncs.length === 1, 4000)
    await publish('notes/after.md')
    await until(() => seen.includes('notes/after.md'), 2000)
  })
})
