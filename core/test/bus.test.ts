import { describe, expect, it } from 'vitest'
import { EventBus, type BusEvent } from '../backend/events/bus.ts'

const anyPath = () => true
const noPath = () => false

function listen(bus: EventBus, topics: string[], canRead: (path: string) => boolean = anyPath) {
  const heard: BusEvent[] = []
  const stop = bus.subscribe({ topics, canRead }, event => { heard.push(event) })
  return { heard, stop }
}

describe('topics', () => {
  it('calls a subscriber only for the topics it named', () => {
    const bus = new EventBus()
    const written = listen(bus, ['note.written'])
    const deleted = listen(bus, ['note.deleted'])
    const both = listen(bus, ['note.written', 'note.deleted'])
    bus.publish({ topic: 'note.written' })
    bus.publish({ topic: 'note.deleted' })
    bus.publish({ topic: 'note.moved' })
    expect(written.heard).toEqual([{ topic: 'note.written' }])
    expect(deleted.heard).toEqual([{ topic: 'note.deleted' }])
    expect(both.heard).toEqual([{ topic: 'note.written' }, { topic: 'note.deleted' }])
  })

  it('matches a topic exactly, not as a prefix and not as a pattern', () => {
    const bus = new EventBus()
    const prefix = listen(bus, ['note'])
    const star = listen(bus, ['note.*'])
    const longer = listen(bus, ['note.written.now'])
    const exact = listen(bus, ['note.written'])
    bus.publish({ topic: 'note.written' })
    expect(prefix.heard).toEqual([])
    expect(star.heard).toEqual([])
    expect(longer.heard).toEqual([])
    expect(exact.heard).toHaveLength(1)
  })

  it('tells nothing to a subscriber with no topics', () => {
    const bus = new EventBus()
    const none = listen(bus, [])
    const one = listen(bus, ['a'])
    bus.publish({ topic: 'a' })
    expect(none.heard).toEqual([])
    expect(one.heard).toHaveLength(1)
  })

  it('does not widen a subscription when the caller changes its array afterwards', () => {
    const bus = new EventBus()
    const topics = ['a']
    const mine = listen(bus, topics)
    topics.push('b')
    bus.publish({ topic: 'b' })
    bus.publish({ topic: 'a' })
    expect(mine.heard).toEqual([{ topic: 'a' }])
  })

  it('answers a topic named like an Object member with nothing', () => {
    const bus = new EventBus()
    const plain = listen(bus, ['a'])
    bus.publish({ topic: 'constructor' })
    bus.publish({ topic: '__proto__' })
    bus.publish({ topic: 'a' })
    expect(plain.heard).toEqual([{ topic: 'a' }])
  })
})

describe('read scope', () => {
  it('asks canRead about an empty path too, it is a path and not a missing one', () => {
    const bus = new EventBus()
    const asked: string[] = []
    const scoped = listen(bus, ['note.written'], p => { asked.push(p); return false })
    bus.publish({ topic: 'note.written', path: '' })
    expect(asked).toEqual([''])
    expect(scoped.heard).toEqual([])
  })

  it('gives a path only to subscribers whose canRead accepts it', () => {
    const bus = new EventBus()
    const publicOnly = listen(bus, ['note.written'], p => p.startsWith('public/'))
    const everything = listen(bus, ['note.written'], anyPath)
    const nothing = listen(bus, ['note.written'], noPath)
    bus.publish({ topic: 'note.written', path: 'public/a.md' })
    bus.publish({ topic: 'note.written', path: 'private/b.md' })
    expect(publicOnly.heard).toEqual([{ topic: 'note.written', path: 'public/a.md' }])
    expect(everything.heard.map(e => e.path)).toEqual(['public/a.md', 'private/b.md'])
    expect(nothing.heard).toEqual([])
  })

  it('asks canRead about the exact path of the event', () => {
    const bus = new EventBus()
    const asked: string[] = []
    const mine = listen(bus, ['a'], p => { asked.push(p); return true })
    bus.publish({ topic: 'a', path: 'Notes/Ünï code.md' })
    expect(asked).toEqual(['Notes/Ünï code.md'])
    expect(mine.heard).toHaveLength(1)
  })

  it('does not ask canRead about an event with no path, and delivers it', () => {
    const bus = new EventBus()
    let asked = 0
    const scoped = listen(bus, ['plugin.loaded'], () => { asked++; return false })
    bus.publish({ topic: 'plugin.loaded' })
    expect(scoped.heard).toEqual([{ topic: 'plugin.loaded' }])
    expect(asked).toBe(0)
  })

  it('does not ask canRead about topics the subscriber did not name', () => {
    const bus = new EventBus()
    let asked = 0
    const other = listen(bus, ['b'], () => { asked++; return true })
    const mine = listen(bus, ['a'])
    bus.publish({ topic: 'a', path: 'x.md' })
    expect(mine.heard).toHaveLength(1)
    expect(other.heard).toEqual([])
    expect(asked).toBe(0)
  })

  // A scope function that is async or sloppy answers with something truthy that is not a yes
  const notYes: [string, unknown][] = [
    ['a number', 1],
    ['a string', 'yes'],
    ['an object', {}],
    ['a promise of no', Promise.resolve(false)],
    ['undefined', undefined],
  ]

  it.each(notYes)('reads %s from canRead as a no', (_name, answer) => {
    const bus = new EventBus()
    const sloppy = listen(bus, ['a'], (() => answer) as () => boolean)
    const control = listen(bus, ['a'])
    bus.publish({ topic: 'a', path: 'x.md' })
    expect(control.heard).toHaveLength(1)
    expect(sloppy.heard).toEqual([])
  })

  it('treats a canRead that throws as a no and still serves the others', () => {
    const bus = new EventBus()
    const broken = listen(bus, ['a'], () => { throw new Error('matcher bug') })
    const after = listen(bus, ['a'])
    expect(() => bus.publish({ topic: 'a', path: 'x.md' })).not.toThrow()
    expect(broken.heard).toEqual([])
    expect(after.heard).toHaveLength(1)
  })

  it('reads the path of the event once, so what canRead approved is what the subscriber gets', () => {
    const bus = new EventBus()
    const mine = listen(bus, ['a'], p => p.startsWith('public/'))
    let reads = 0
    const event = { topic: 'a', get path() { return reads++ === 0 ? 'public/a.md' : 'private/b.md' } }
    bus.publish(event)
    expect(mine.heard).toEqual([{ topic: 'a', path: 'public/a.md' }])
  })

  it('reads the topic of the event once', () => {
    const bus = new EventBus()
    const mine = listen(bus, ['a'])
    const other = listen(bus, ['b'])
    let reads = 0
    const event = { get topic() { return reads++ === 0 ? 'a' : 'b' } }
    bus.publish(event)
    expect(mine.heard).toEqual([{ topic: 'a' }])
    expect(other.heard).toEqual([])
  })
})

describe('what a subscriber receives', () => {
  it('holds the topic and the path and nothing else the publisher passed', () => {
    const bus = new EventBus()
    const mine = listen(bus, ['note.written'])
    bus.publish({ topic: 'note.written', path: 'a.md', content: 'the whole note', text: 'x', body: 'y', version: 3 } as BusEvent)
    expect(mine.heard).toStrictEqual([{ topic: 'note.written', path: 'a.md' }])
    expect(Object.keys(mine.heard[0])).toEqual(['topic', 'path'])
  })

  it('has no path key at all when the event has none', () => {
    const bus = new EventBus()
    const mine = listen(bus, ['a'])
    bus.publish({ topic: 'a', content: 'x' } as BusEvent)
    expect(mine.heard).toStrictEqual([{ topic: 'a' }])
  })

  it('gives each subscriber its own object, so one can not change what the next sees', () => {
    const bus = new EventBus()
    bus.subscribe({ topics: ['a'], canRead: anyPath }, event => {
      const loose: BusEvent & { content?: string } = event
      loose.topic = 'changed'
      loose.path = 'private/b.md'
      loose.content = 'planted'
    })
    const second = listen(bus, ['a'])
    const third = listen(bus, ['a'])
    bus.publish({ topic: 'a', path: 'public/a.md' })
    expect(second.heard).toStrictEqual([{ topic: 'a', path: 'public/a.md' }])
    expect(third.heard).toStrictEqual([{ topic: 'a', path: 'public/a.md' }])
    expect(second.heard[0]).not.toBe(third.heard[0])
  })

  it('does not hand out the publisher object, so a subscriber can not change what was published', () => {
    const bus = new EventBus()
    let calls = 0
    bus.subscribe({ topics: ['a'], canRead: anyPath }, event => { calls++; event.path = 'private/b.md' })
    const published = { topic: 'a', path: 'public/a.md' }
    bus.publish(published)
    expect(calls).toBe(1)
    expect(published).toEqual({ topic: 'a', path: 'public/a.md' })
  })
})

describe('failing subscribers', () => {
  it('lets the others hear the event when one throws, and does not throw at the publisher', () => {
    const bus = new EventBus()
    const before = listen(bus, ['a'])
    bus.subscribe({ topics: ['a'], canRead: anyPath }, () => { throw new Error('plugin bug') })
    const after = listen(bus, ['a'])
    expect(() => bus.publish({ topic: 'a' })).not.toThrow()
    expect(before.heard).toHaveLength(1)
    expect(after.heard).toHaveLength(1)
  })

  it('leaves no rejected promise unhandled when an async subscriber fails', async () => {
    const unhandled: unknown[] = []
    const record = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', record)
    try {
      const bus = new EventBus()
      bus.subscribe({ topics: ['a'], canRead: anyPath }, async () => { throw new Error('plugin failed later') })
      const after = listen(bus, ['a'])
      bus.publish({ topic: 'a' })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(after.heard).toHaveLength(1)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', record)
    }
  })
})

describe('refusing a bad event', () => {
  const bad: [string, unknown][] = [
    ['no topic', {}],
    ['a topic that is not a string', { topic: 5 }],
    ['an empty topic', { topic: '' }],
    ['a path that is not a string', { topic: 'a', path: 5 }],
    ['a null path', { topic: 'a', path: null }],
  ]

  it.each(bad)('throws on %s and tells nobody', (_name, event) => {
    const bus = new EventBus()
    const mine = listen(bus, ['a', ''])
    expect(() => bus.publish(event as BusEvent)).toThrow()
    expect(mine.heard).toEqual([])
  })
})

describe('unsubscribing', () => {
  it('stops delivery to that subscriber and to no other', () => {
    const bus = new EventBus()
    const first = listen(bus, ['a'])
    const second = listen(bus, ['a'])
    bus.publish({ topic: 'a' })
    first.stop()
    bus.publish({ topic: 'a' })
    expect(first.heard).toHaveLength(1)
    expect(second.heard).toHaveLength(2)
  })

  it('does nothing the second time, and does not remove somebody else', () => {
    const bus = new EventBus()
    const first = listen(bus, ['a'])
    const second = listen(bus, ['a'])
    const third = listen(bus, ['a'])
    first.stop()
    first.stop()
    bus.publish({ topic: 'a' })
    expect(first.heard).toEqual([])
    expect(second.heard).toHaveLength(1)
    expect(third.heard).toHaveLength(1)
  })

  it('keeps two subscriptions with the same topics and the same function apart', () => {
    const bus = new EventBus()
    const heard: BusEvent[] = []
    const listener = (event: BusEvent) => { heard.push(event) }
    const stopFirst = bus.subscribe({ topics: ['a'], canRead: anyPath }, listener)
    bus.subscribe({ topics: ['a'], canRead: anyPath }, listener)
    stopFirst()
    bus.publish({ topic: 'a' })
    expect(heard).toHaveLength(1)
  })

  it('does not call a subscriber that an earlier one removed in the same round', () => {
    const bus = new EventBus()
    let stopLate = () => {}
    let remover = 0
    bus.subscribe({ topics: ['a'], canRead: anyPath }, () => { remover++; stopLate() })
    const late = listen(bus, ['a'])
    stopLate = late.stop
    bus.publish({ topic: 'a' })
    expect(remover).toBe(1)
    expect(late.heard).toEqual([])
  })

  it('does not call a subscriber that joined during the round for the event being published', () => {
    const bus = new EventBus()
    const joined: BusEvent[] = []
    let joinedOnce = false
    bus.subscribe({ topics: ['a'], canRead: anyPath }, () => {
      if (joinedOnce) return
      joinedOnce = true
      bus.subscribe({ topics: ['a'], canRead: anyPath }, event => { joined.push(event) })
    })
    bus.publish({ topic: 'a' })
    expect(joined).toEqual([])
    bus.publish({ topic: 'a' })
    expect(joined).toHaveLength(1)
  })
})

describe('nested publishes', () => {
  // Written down so #66 knows it: delivery is at once, so no order holds across a publish made inside a listener
  it('delivers an event a listener publishes before the rest of the round', () => {
    const bus = new EventBus()
    const order: string[] = []
    bus.subscribe({ topics: ['a'], canRead: anyPath }, () => {
      order.push('first heard a')
      bus.publish({ topic: 'b' })
    })
    bus.subscribe({ topics: ['a', 'b'], canRead: anyPath }, event => { order.push(`second heard ${event.topic}`) })
    bus.publish({ topic: 'a' })
    expect(order).toEqual(['first heard a', 'second heard b', 'second heard a'])
  })
})
