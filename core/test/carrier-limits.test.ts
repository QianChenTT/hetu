import { afterEach, describe, expect, it } from 'vitest'
import { floorConstants } from '../api/floor.ts'
import { countMessage, newRate } from '../api/rate.ts'
import { Limits } from '../backend/carrier/limits.ts'
import type { HumanLimits, Port } from '../backend/carrier/seams.ts'
import { cleanup, code, editor, harness, host, hostHalf, tick, windowWay, worker } from './carrier-fakes.ts'

afterEach(cleanup)

describe('limits', () => {
  const human = (limits: Partial<HumanLimits>) => new Limits(() => ({ all: {}, plugins: {}, ...limits }))

  it('starts from core/api\'s floor constants', () => {
    const limits = human({})
    expect(limits.of('search', 'callsInFlight')).toBe(floorConstants.callsInFlight)
    expect(limits.of(null, 'messagesPerSecond')).toBe(1000)
  })

  it('takes the human\'s value for the plugin over the one for all, raising or lowering, and only the one for all for a window', () => {
    const limits = human({ all: { callsInFlight: 128 }, plugins: { search: { callsInFlight: 8 } } })
    expect(limits.of('search', 'callsInFlight')).toBe(8)
    expect(limits.of('git', 'callsInFlight')).toBe(128)
    expect(limits.of(null, 'callsInFlight')).toBe(128)
  })

  it.each([0, -1, 1.5, '64', null, Number.POSITIVE_INFINITY])('ignores a human value of %j', value => {
    const limits = human({ all: { callsInFlight: value as number }, plugins: { search: { callsInFlight: value as number } } })
    expect(limits.of('search', 'callsInFlight')).toBe(64)
  })

  it('reads only a table\'s own values', () => {
    const plugins = Object.create({ search: { callsInFlight: 1000 } })
    expect(human({ plugins }).of('search', 'callsInFlight')).toBe(64)
  })

  it('falls back to the floor constants when the state can not be read', () => {
    const limits = new Limits(() => { throw new Error('no state') })
    expect(limits.of('search', 'resultBytes')).toBe(floorConstants.resultBytes)
  })

  it('lets the watchdog lower a plugin\'s value, take a lowering back and never raise past the human\'s or the floor\'s', () => {
    const limits = human({ plugins: { search: { callsInFlight: 100 } } })
    limits.lower('search', 'callsInFlight', 10)
    expect(limits.of('search', 'callsInFlight')).toBe(10)
    limits.lower('search', 'callsInFlight', 5000)
    expect(limits.of('search', 'callsInFlight')).toBe(100)
    limits.lower('git', 'callsInFlight', 5000)
    expect(limits.of('git', 'callsInFlight')).toBe(64)
    expect(limits.of(null, 'callsInFlight')).toBe(64)
  })
})

// Checkpoint B: a window that lowered a value for all locked the trusted window out of every request. The values for all
// reach windows only where they raise the floor, while the core-wide ones follow the human either way
describe('the limits a window runs on', () => {
  const human = (all: Record<string, number>) => new Limits(() => ({ all, plugins: {} }))

  it('never go below the floor for a window, so no lowered value locks the trusted window out', () => {
    const limits = human({ argumentBytes: 8, bytesInFlight: 1, messagesPerSecond: 1, callDeadlineMs: 1 })
    for (const name of ['argumentBytes', 'bytesInFlight', 'messagesPerSecond', 'callDeadlineMs'] as const) {
      expect(limits.of(null, name)).toBe(floorConstants[name])
    }
  })

  it('take a value for all that raises the floor', () => {
    expect(human({ argumentBytes: 4 * 1024 * 1024 }).of(null, 'argumentBytes')).toBe(4 * 1024 * 1024)
  })

  it('leave the core-wide ones to the human both ways', () => {
    const limits = human({ auditQueue: 5, floorBacklog: 7, logFailMs: 60_000 })
    expect([limits.of(null, 'auditQueue'), limits.of(null, 'floorBacklog'), limits.of(null, 'logFailMs')]).toEqual([5, 7, 60_000])
  })

  it('still give a plugin the lowered value for all', () => {
    expect(human({ argumentBytes: 8 }).of('search', 'argumentBytes')).toBe(8)
  })
})

describe('the message count', () => {
  const at = (perSecond: number, floodMs = 5000, floodFactor = 10) =>
    (name: string) => ({ messagesPerSecond: perSecond, floodMs, floodFactor } as Record<string, number>)[name]

  it('passes the rate, drops one over it and starts again each second', () => {
    const rate = newRate()
    const limit = at(3)
    expect([0, 1, 2, 3].map(() => countMessage(rate, 1000, limit))).toEqual(['pass', 'pass', 'pass', 'drop'])
    expect(countMessage(rate, 1999, limit)).toBe('drop')
    expect(countMessage(rate, 2000, limit)).toBe('pass')
  })

  it('calls more than the flood factor times the rate across the flood window a flood', () => {
    const rate = newRate()
    const limit = at(2, 1000, 10)
    const verdicts = Array.from({ length: 21 }, () => countMessage(rate, 5000, limit))
    expect(verdicts.slice(0, 20).includes('flood')).toBe(false)
    expect(verdicts[20]).toBe('flood')
  })

  it('starts both windows again when the clock goes back', () => {
    const rate = newRate()
    const limit = at(1)
    expect(countMessage(rate, 5000, limit)).toBe('pass')
    expect(countMessage(rate, 4000, limit)).toBe('pass')
  })

  // A flood cap of 2 in the cases below, so only the flood window decides
  it('starts the flood window again when the clock goes back', () => {
    const rate = newRate()
    const limit = at(2, 1000, 1)
    expect([5000, 5000, 4999].map(now => countMessage(rate, now, limit))).toEqual(['pass', 'pass', 'pass'])
  })

  it('ends the flood window after exactly floodMs', () => {
    const rate = newRate()
    const limit = at(2, 1000, 1)
    expect([5000, 5000, 6000].map(now => countMessage(rate, now, limit))).toEqual(['pass', 'pass', 'pass'])
  })

  it('judges a flood window against the cap it started with, so a lowered rate drops at once and floods only from the next window', () => {
    const rate = newRate()
    const limits: Record<string, number> = { messagesPerSecond: 200, floodMs: 5000, floodFactor: 10 }
    const limit = (name: string) => limits[name]
    // 600 messages over 3 s, under every rate in force when each was sent
    for (const now of [0, 1000, 2000]) {
      for (let i = 0; i < 200; i++) expect(countMessage(rate, now, limit)).toBe('pass')
    }
    limits.messagesPerSecond = 10
    expect(countMessage(rate, 2500, limit)).toBe('drop')
    expect(countMessage(rate, 3000, limit)).toBe('pass')
    // The next window takes the cap of 10 times 10 a second for 5 s
    const verdicts = Array.from({ length: 501 }, () => countMessage(rate, 5000, limit))
    expect(verdicts.slice(0, 500).includes('flood')).toBe(false)
    expect(verdicts[500]).toBe('flood')
  })
})

describe('the ceiling', () => {
  it('throttles a caller past its calls in flight before the gate hears of it', async () => {
    const { connect, loader, gate } = harness()
    loader.sandboxed('git', { log: {} })
    gate.grants.search = [{ type: 'plugin.call', targets: ['git'] }]
    loader.human.plugins.search = { callsInFlight: 2 }
    const search = connect(worker('search'))
    const git = connect(worker('git'))
    const first = search.call('git.log')
    search.call('git.log')
    await tick(10)
    const asked = gate.asked.length
    expect(asked).toBe(4)
    expect(code(await search.ask('git.log'))).toBe('throttled')
    expect(gate.asked).toHaveLength(asked)
    const [got] = git.inbox.filter(message => message.kind === 'call')
    git.answer(got.callId, null)
    await search.reply(first)
    expect((await search.ask('core.self')).ok).toBe(true)
  })

  it('throttles a caller past its bytes in flight', async () => {
    const { connect, loader } = harness()
    loader.slots.gate = 'off'
    loader.sandboxed('git', { log: {} })
    loader.human.plugins.search = { bytesInFlight: 1000 }
    const search = connect(worker('search'))
    connect(worker('git'))
    search.call('git.log', 'x'.repeat(600))
    await tick(10)
    expect(code(await search.ask('git.log', 'y'.repeat(600)))).toBe('throttled')
    expect((await search.ask('core.self')).ok).toBe(true)
  })

  it('charges a sub-call to the root of its parent links as well as to its caller', async () => {
    const { connect, loader } = harness()
    loader.slots.gate = 'off'
    loader.sandboxed('mcp', { handle: {} })
    loader.sandboxed('git', { log: {} })
    loader.human.plugins.http = { callsInFlight: 2 }
    const http = connect(worker('http'))
    const mcp = connect(worker('mcp'))
    connect(worker('git'))
    http.call('mcp.handle')
    const parent = await mcp.delivered('mcp.handle')
    const one = mcp.call('git.log', undefined, { parent: parent.callId })
    await tick(10)
    expect(mcp.repliesTo(one)).toEqual([])
    // http holds two now, its own and the sub-call
    expect(code(await mcp.ask('git.log', undefined, { parent: parent.callId }))).toBe('throttled')
    expect(code(await http.ask('mcp.handle'))).toBe('throttled')
    // mcp's own calls are charged to mcp only
    mcp.call('git.log')
    await tick(10)
    expect(mcp.inbox.filter(message => message.kind === 'reply' && (message.refusal as { code?: string } | undefined)?.code === 'throttled')).toHaveLength(1)
  })

  it('frees the bytes of a call that ended while another is still in flight', async () => {
    const { connect, loader } = harness()
    loader.slots.gate = 'off'
    loader.sandboxed('git', { log: {} })
    loader.human.plugins.search = { bytesInFlight: 1000 }
    const search = connect(worker('search'))
    const git = connect(worker('git'))
    const first = search.call('git.log', 'x'.repeat(600))
    search.call('git.log')
    const got = await git.delivered('git.log')
    git.answer(got.callId, null)
    await search.reply(first)
    const third = search.call('git.log', 'y'.repeat(600))
    await tick(20)
    expect(search.repliesTo(third)).toEqual([])
    expect(git.inbox.filter(message => message.kind === 'call')).toHaveLength(3)
  })

  // A window runs on the floor's ceiling, which a value for all lowered by mistake can't take below
  it('keeps a ceiling per window at the floor\'s value', async () => {
    const { carrier, connect, loader } = harness()
    loader.slots.gate = 'off'
    loader.sandboxed('git', { log: {} })
    loader.human.all = { callsInFlight: 1 }
    const git = connect(worker('git'))
    const way = windowWay(carrier, { 'editor-1': editor, 'editor-2': { kind: 'window', role: 'editor', n: 2 } })
    for (let id = 100; id < 100 + floorConstants.callsInFlight; id++) way.post('editor-1', { v: 1, kind: 'call', id, action: 'git.log', args: {} })
    for (let waited = 0; git.inbox.filter(message => message.kind === 'call').length < floorConstants.callsInFlight; waited++) {
      if (waited > 200) throw new Error('the calls never arrived')
      await tick(5)
    }
    expect((await way.ask('editor-2', 'core.self')).ok).toBe(true)
    expect(code(await way.ask('editor-1', 'core.self'))).toBe('throttled')
  })

  it('keeps one ceiling across a plugin\'s halves', async () => {
    const { connect, loader } = harness()
    loader.slots.gate = 'off'
    loader.sandboxed('git', { log: {} })
    loader.human.plugins.search = { callsInFlight: 1 }
    const search = connect(worker('search'))
    const panel = connect({ kind: 'plugin', id: 'search', half: 'panel', incarnation: 1 })
    connect(worker('git'))
    search.call('git.log')
    await tick(10)
    expect(code(await panel.ask('git.log'))).toBe('throttled')
  })
})

describe('the rate', () => {
  it('drops one over the rate with no reply and tells the watchdog at most once a second with the count', async () => {
    let clock = 1_000_000
    const { connect, loader, samples } = harness({ clock: () => clock })
    loader.human.plugins.search = { messagesPerSecond: 5 }
    const search = connect(worker('search'))
    const ids = Array.from({ length: 8 }, () => search.call('core.self'))
    await search.reply(ids[4])
    await tick(20)
    expect(ids.map(id => search.repliesTo(id).length)).toEqual([1, 1, 1, 1, 1, 0, 0, 0])
    expect(samples).toEqual([{ kind: 'dropped', caller: worker('search'), count: 1 }])
    clock += 1000
    const more = Array.from({ length: 6 }, () => search.call('core.self'))
    await search.reply(more[4])
    await tick(20)
    expect(search.repliesTo(more[5])).toEqual([])
    expect(samples.at(-1)).toEqual({ kind: 'dropped', caller: worker('search'), count: 3 })
  })

  it('counts a message that could not be read against the rate', async () => {
    const clock = 1_000_000
    const { carrier, loader } = harness({ clock: () => clock })
    loader.human.plugins.search = { messagesPerSecond: 1 }
    const listeners: Record<string, (value: unknown) => void> = {}
    const sent: unknown[] = []
    const port: Port = {
      postMessage: message => { sent.push(message) },
      start: () => {},
      close: () => {},
      on: (event, listener) => { listeners[event] = listener },
    }
    carrier.register(port, worker('search'))
    listeners.messageerror(undefined)
    listeners.message({ v: 1, kind: 'call', id: 1, action: 'core.self', args: {} })
    await tick()
    expect(sent).toEqual([])
  })

  it('records a watchdog that throws on a sample', async () => {
    const clock = 1_000_000
    const { carrier, connect, loader, log } = harness({ clock: () => clock, watchdog: () => ({ sample: () => { throw new Error('broken') } }) })
    loader.human.plugins.search = { messagesPerSecond: 1 }
    const search = connect(worker('search'))
    await search.ask('core.self')
    search.call('core.self')
    await tick(20)
    carrier.close()
    await tick()
    expect(log.events('fault').map(record => record.fields)).toEqual([{ plugin: 'watchdog', step: 'sample', count: 1 }])
  })

  it('counts every message, not only calls', async () => {
    const clock = 1_000_000
    const { connect, loader } = harness({ clock: () => clock })
    loader.human.plugins.search = { messagesPerSecond: 3 }
    const search = connect(worker('search'))
    search.post({ v: 1, kind: 'pong' })
    search.post({ v: 1, kind: 'cancel', id: 99 })
    search.post({ v: 2, kind: 'call' })
    const id = search.call('core.self')
    await tick(20)
    expect(search.repliesTo(id)).toEqual([])
  })

  it('tells no watchdog while the slot is not on and keeps the count for later', async () => {
    let clock = 1_000_000
    const { connect, loader, samples } = harness({ clock: () => clock })
    loader.slots.watchdog = 'off'
    loader.human.plugins.search = { messagesPerSecond: 1 }
    const search = connect(worker('search'))
    search.call('core.self')
    search.call('core.self')
    search.call('core.self')
    await tick(20)
    expect(samples).toEqual([])
    loader.slots.watchdog = 'on'
    clock += 1000
    search.call('core.self')
    search.call('core.self')
    await tick(20)
    expect(samples).toEqual([{ kind: 'dropped', caller: worker('search'), count: 3 }])
  })

  // Past the floor's flood cap too, since a window's way is never closed and a value for all can't lower its rate
  it('drops a window\'s messages over the rate but never closes its way in', async () => {
    const clock = 1_000_000
    const { carrier, loader } = harness({ clock: () => clock })
    loader.human.all = { messagesPerSecond: 2, floodMs: 1000, floodFactor: 1 }
    const way = windowWay(carrier, { 'editor-1': editor })
    const sent = floorConstants.messagesPerSecond * floorConstants.floodFactor + 10
    for (let i = 1; i <= sent; i++) way.post('editor-1', { v: 1, kind: 'call', id: i, action: 'core.self', args: {} })
    await tick(50)
    expect(way.replies).toHaveLength(floorConstants.messagesPerSecond)
    expect(way.replies.at(-1)?.id).toBe(floorConstants.messagesPerSecond)
    expect(loader.crashes).toEqual([])
  })
})

describe('the flood cap', () => {
  it('closes the port, reports the plugin crashed with flood once and answers what it held crashed', async () => {
    const clock = 1_000_000
    const { connect, loader, gate } = harness({ clock: () => clock })
    loader.sandboxed('search', { query: {} })
    gate.grants.mcp = [{ type: 'plugin.call', targets: ['search'] }]
    loader.human.plugins.search = { messagesPerSecond: 2, floodMs: 1000 }
    const mcp = connect(worker('mcp'))
    const search = connect(worker('search'))
    const id = mcp.call('search.query')
    await search.delivered('search.query')
    const closed = new Promise(resolve => search.port.once('close', resolve))
    for (let i = 0; i < 21; i++) search.post({ v: 1, kind: 'pong' })
    await closed
    expect(code(await mcp.reply(id))).toBe('crashed')
    await tick(20)
    expect(loader.crashes).toEqual([{ caller: worker('search'), reason: 'flood' }])
    // Only the first 2 of the first second reached the loader
    expect(loader.lifecycle).toHaveLength(2)
  })

  it('stays under the cap below ten times the rate', async () => {
    const clock = 1_000_000
    const { connect, loader } = harness({ clock: () => clock })
    loader.human.plugins.search = { messagesPerSecond: 2, floodMs: 1000 }
    const search = connect(worker('search'))
    for (let i = 0; i < 20; i++) search.post({ v: 1, kind: 'pong' })
    await tick(30)
    expect(loader.crashes).toEqual([])
  })

  // A lowering is a throttle. Messages sent under the rate in force when each was sent never make a flood
  it('closes no port for what it sent before the watchdog lowered its rate', async () => {
    let clock = 1_000_000
    const { carrier, connect, loader } = harness({ clock: () => clock })
    loader.human.plugins.search = { messagesPerSecond: 200 }
    loader.sandboxed('search')
    const search = connect(worker('search'))
    for (let second = 0; second < 3; second++) {
      clock = 1_000_000 + second * 1000
      for (let i = 0; i < 200; i++) search.post({ v: 1, kind: 'pong' })
      for (let i = 0; i < 200 && loader.lifecycle.length < (second + 1) * 200; i++) await tick(5)
    }
    const watchdog = hostHalf(carrier, host('watchdog'))
    expect((await watchdog.ask('watchdog.limit', { plugin: 'search', constant: 'messagesPerSecond', value: 10 })).ok).toBe(true)
    clock = 1_002_500
    search.post({ v: 1, kind: 'pong' })
    await tick(20)
    expect(loader.crashes).toEqual([])
    expect(loader.lifecycle).toHaveLength(600)
  })
})

describe('watchdog.limit', () => {
  it('lowers a sandboxed plugin\'s constant and never raises one', async () => {
    const { carrier, connect, loader } = harness()
    loader.slots.gate = 'off'
    loader.sandboxed('search')
    loader.sandboxed('git', { log: {} })
    const watchdog = hostHalf(carrier, host('watchdog'))
    const search = connect(worker('search'))
    connect(worker('git'))
    expect((await watchdog.ask('watchdog.limit', { plugin: 'search', constant: 'callsInFlight', value: 1 })).ok).toBe(true)
    search.call('git.log')
    await tick(10)
    expect(code(await search.ask('git.log'))).toBe('throttled')
    expect((await watchdog.ask('watchdog.limit', { plugin: 'search', constant: 'callsInFlight', value: 100000 })).ok).toBe(true)
    const many = Array.from({ length: 63 }, () => search.call('git.log'))
    await tick(20)
    expect(many.filter(id => search.repliesTo(id).length > 0)).toHaveLength(0)
    expect(code(await search.ask('git.log'))).toBe('throttled')
  })

  it.each([
    ['a constant outside the list', { plugin: 'search', constant: 'gateBypass', value: 1 }],
    ['a value that is not a positive whole number', { plugin: 'search', constant: 'callsInFlight', value: 0 }],
  ])('refuses %s', async (_name, args) => {
    const { carrier, loader } = harness()
    loader.sandboxed('search')
    expect(code(await hostHalf(carrier, host('watchdog')).ask('watchdog.limit', args))).toBe('invalid')
  })
})

describe('samples from the runtime', () => {
  it('hands the watchdog a worker\'s errors, its drops in the page and its cutoff, while the watchdog slot is on', () => {
    const { carrier, loader, samples } = harness()
    carrier.sample({ kind: 'errors', caller: worker('search'), count: 2 })
    carrier.sample({ kind: 'dropped', caller: worker('search'), count: 5 })
    carrier.sample({ kind: 'cutoff', caller: worker('search'), reason: 'flood' })
    expect(samples).toEqual([
      { kind: 'errors', caller: worker('search'), count: 2 },
      { kind: 'dropped', caller: worker('search'), count: 5 },
      { kind: 'cutoff', caller: worker('search'), reason: 'flood' },
    ])
    loader.slots.watchdog = 'off'
    carrier.sample({ kind: 'errors', caller: worker('search'), count: 1 })
    expect(samples).toHaveLength(3)
  })

  it('goes on past a watchdog that throws on a sample', () => {
    const { carrier } = harness({ watchdog: () => ({ sample: () => { throw new Error('broken') } }) })
    expect(() => carrier.sample({ kind: 'errors', caller: worker('search'), count: 1 })).not.toThrow()
  })

  it('tells the runtime whose limits watchdog.limit lowered, so the relay in the page applies them too', async () => {
    const limited: string[] = []
    const { carrier, loader } = harness({ limited: plugin => { limited.push(plugin) } })
    loader.sandboxed('search')
    const watchdog = hostHalf(carrier, host('watchdog'))
    expect((await watchdog.ask('watchdog.limit', { plugin: 'search', constant: 'messagesPerSecond', value: 10 })).ok).toBe(true)
    expect(limited).toEqual(['search'])
  })
})
