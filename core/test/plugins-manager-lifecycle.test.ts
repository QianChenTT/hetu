import { afterEach, describe, expect, it } from 'vitest'
import type { Caller } from '../api/envelope.ts'
import {
  cleanup, entryFor, fakeExec, fakeHistory, fakeLuoshu, filesFor, harness, reasonOf, stateOf, tick, until, workerManifest, type Files,
  type Harness,
} from './plugins-manager-fakes.ts'

afterEach(cleanup)

const signed = (extra = {}) => (root: string) => entryFor(root, extra)
const worker = (id: string, extra: object = {}): Files => filesFor(workerManifest(id, extra))
const wkr = (id: string, incarnation = 1): Caller => ({ kind: 'plugin', id, half: 'worker', incarnation })

// A watchdog call on the core seam, as the carrier hands one from the plugin holding the watchdog policy job. Nothing
// that runs holds it now, so the seam is where its stops and restarts are reached
const watchdog = (made: Harness, action: 'watchdog.stop' | 'watchdog.restart', plugin: string) =>
  made.pluginsManager.serve({ callId: 'w', caller: wkr('watchdog'), action, args: { plugin }, deadline: Date.now() + 1000 })

describe('dependencies and turning down', () => {
  it('leaves a plugin whose requirement is missing waiting with its reason, never started', async () => {
    const made = await harness({ folder: { outline: worker('outline', { requires: ['mapper'] }) }, entries: { outline: signed() } })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'outline')).toBe('waiting')
    expect(reasonOf(made.pluginsManager, 'outline')).toBe('dependency:mapper:absent')
    expect(made.link.events('plugin.waiting')).toEqual([{ plugin: 'outline', reason: 'dependency:mapper:absent' }])
    expect(made.runtime.order()).not.toContain('outline')
  })

  it('refuses every plugin in a requires cycle with cycle and starts the rest', async () => {
    const made = await harness({
      folder: { mapper: worker('mapper', { requires: ['tagger'] }), tagger: worker('tagger', { requires: ['mapper'] }), outline: worker('outline') },
      entries: { mapper: signed(), tagger: signed(), outline: signed() },
    })
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'mapper')).toBe('cycle')
    expect(reasonOf(made.pluginsManager, 'tagger')).toBe('cycle')
    expect(made.link.events('plugin.refused')).toEqual(expect.arrayContaining([
      { plugin: 'mapper', reason: 'cycle' }, { plugin: 'tagger', reason: 'cycle' },
    ]))
    expect(stateOf(made.pluginsManager, 'outline')).toBe('ready')
    expect(made.runtime.order()).toEqual(['outline'])
  })

  it('waits for a requirement to be ready before its dependent starts', async () => {
    const made = await harness({
      folder: { mapper: worker('mapper'), tagger: worker('tagger', { requires: ['mapper'] }) },
      entries: { mapper: signed(), tagger: signed() },
      behave: { mapper: { ready: false } },
    })
    const starting = made.pluginsManager.start()
    await until(() => made.runtime.order().includes('mapper'))
    await tick(20)
    expect(made.runtime.order()).not.toContain('tagger')
    made.runtime.half('mapper').ready()
    await starting
    expect(made.runtime.order()).toEqual(['mapper', 'tagger'])
    expect(made.runtime.half('tagger').got('init')[0].deps).toEqual({ mapper: 'ready' })
  })
})

describe('a crash', () => {
  it('moves every dependent to waiting before the carrier answers the calls the plugin held', async () => {
    const made = await harness({
      folder: {
        mapper: worker('mapper', { provides: { actions: { query: {} } } }),
        tagger: worker('tagger', { requires: ['mapper'] }),
        summary: worker('summary', { requires: ['tagger'] }),
        outline: worker('outline'),
      },
      entries: { mapper: signed(), tagger: signed(), summary: signed(), outline: signed() },
    })
    await made.pluginsManager.start()
    const states: (string | null)[] = []
    const crashed = made.pluginsManager.crashed.bind(made.pluginsManager)
    made.pluginsManager.crashed = (caller, reason) => {
      crashed(caller, reason)
      states.push(stateOf(made.pluginsManager, 'tagger'), stateOf(made.pluginsManager, 'summary'))
    }
    const outline = made.runtime.half('outline')
    const asking = outline.ask('mapper.query')
    await until(() => made.runtime.half('mapper').got('call').length === 1)
    made.runtime.half('mapper').crash()
    const reply = await asking
    expect((reply?.refusal as { code: string }).code).toBe('crashed')
    // Both were waiting the moment crashed returned, before the carrier answered the held call
    expect(states).toEqual(['waiting', 'waiting'])
    expect(reasonOf(made.pluginsManager, 'tagger')).toBe('dependency:mapper:crashed')
    expect(reasonOf(made.pluginsManager, 'summary')).toBe('dependency:tagger:waiting')
    expect(stateOf(made.pluginsManager, 'mapper')).toBe('crashed')
    expect(reasonOf(made.pluginsManager, 'mapper')).toBe('closed')
    const order = made.link.timeline
    expect(order.indexOf('record plugin.waiting tagger')).toBeGreaterThan(order.indexOf('record plugin.crashed mapper'))
  })

  it('stops the dependents it left waiting, terminates the dead worker and never restarts anything by itself', async () => {
    const made = await harness({
      folder: { mapper: worker('mapper'), tagger: worker('tagger', { requires: ['mapper'] }) },
      entries: { mapper: signed(), tagger: signed() },
    })
    await made.pluginsManager.start()
    made.runtime.half('mapper').crash()
    await until(() => made.runtime.terminated.some(end => end.id === 'tagger'))
    expect(made.runtime.terminated).toEqual([{ id: 'mapper', incarnation: 1 }, { id: 'tagger', incarnation: 1 }])
    expect(made.runtime.half('tagger').got('stop')).toHaveLength(1)
    await tick(50)
    expect(made.runtime.order().filter(id => id === 'mapper')).toHaveLength(1)
    expect(stateOf(made.pluginsManager, 'tagger')).toBe('waiting')
  })

  it('tells a plugin through deps when a plugin.call target it holds goes away', async () => {
    const made = await harness({
      folder: { mapper: worker('mapper'), outline: worker('outline') },
      entries: { mapper: signed(), outline: signed({ granted: [{ type: 'plugin.call', targets: ['mapper'] }] }) },
    })
    await made.pluginsManager.start()
    // mapper can come ready after outline started, which outline hears as deps too, so only one after the crash counts
    await until(() => stateOf(made.pluginsManager, 'mapper') === 'ready' && stateOf(made.pluginsManager, 'outline') === 'ready')
    const before = made.runtime.half('outline').got('deps').length
    made.runtime.half('mapper').crash()
    await until(() => made.runtime.half('outline').got('deps').length > before)
    expect(made.runtime.half('outline').got('deps').at(-1)).toEqual({ v: 1, kind: 'deps', deps: { mapper: 'unavailable' } })
    expect(stateOf(made.pluginsManager, 'outline')).toBe('ready')
  })

  it('closes a flooding way as crashed with flood', async () => {
    const made = await harness({ folder: { mapper: worker('mapper') }, entries: { mapper: signed() } })
    await made.pluginsManager.start()
    made.pluginsManager.crashed(wkr('mapper'), 'flood')
    expect(stateOf(made.pluginsManager, 'mapper')).toBe('crashed')
    expect(reasonOf(made.pluginsManager, 'mapper')).toBe('flood')
  })

  it('takes a worker the relay cut off for a malformed message as crashed with malformed', async () => {
    const made = await harness({ folder: { mapper: worker('mapper') }, entries: { mapper: signed() } })
    await made.pluginsManager.start()
    made.pluginsManager.crashed(wkr('mapper'), 'malformed')
    expect(stateOf(made.pluginsManager, 'mapper')).toBe('crashed')
    expect(reasonOf(made.pluginsManager, 'mapper')).toBe('malformed')
  })
})

describe('a dead incarnation', () => {
  it('is refused: a timed out worker\'s late ready counts for nothing and its port reaches nothing', async () => {
    const made = await harness({
      folder: { mapper: worker('mapper'), outline: worker('outline') },
      entries: { mapper: signed(), outline: signed() },
      behave: { mapper: { ready: false } },
      limits: { readyMs: 40 },
    })
    await made.pluginsManager.start()
    await until(() => stateOf(made.pluginsManager, 'mapper') === 'crashed')
    const dead = made.runtime.half('mapper')
    expect(made.link.ended).toContainEqual({ caller: wkr('mapper'), code: 'crashed' })
    dead.ready()
    expect(await dead.ask('core.self', undefined, 100)).toBe(null)
    await tick(20)
    expect(stateOf(made.pluginsManager, 'mapper')).toBe('crashed')
    // A live half's same call is answered, so it is the incarnation that is refused
    expect((await made.runtime.half('outline').ask('core.self'))?.ok).toBe(true)
  })

  it('is refused after a restart: the old incarnation\'s messages change nothing for the new one', async () => {
    const made = await harness({ folder: { mapper: worker('mapper') }, entries: { mapper: signed() } })
    await made.pluginsManager.start()
    made.runtime.half('mapper').crash()
    await until(() => stateOf(made.pluginsManager, 'mapper') === 'crashed')
    await expect(watchdog(made, 'watchdog.restart', 'mapper')).resolves.toBe(null)
    await until(() => stateOf(made.pluginsManager, 'mapper') === 'ready')
    expect(made.pluginsManager.plugin('mapper')?.incarnation).toBe(2)
    made.pluginsManager.heard(wkr('mapper', 1), 'stopped')
    made.pluginsManager.crashed(wkr('mapper', 1), 'closed')
    made.runtime.half('mapper', 1).send({ v: 1, kind: 'call', id: 1, action: 'core.self' })
    await tick(20)
    expect(stateOf(made.pluginsManager, 'mapper')).toBe('ready')
    expect(made.runtime.half('mapper', 1).got('reply')).toEqual([])
    expect((await made.runtime.half('mapper', 2).ask('core.self'))?.result).toEqual(wkr('mapper', 2))
  })
})

describe('a planned stop', () => {
  it('stops dependents first in reverse graph order, each with stopGraceMs to flush, and names them in the record', async () => {
    const made = await harness({
      folder: {
        alpha: worker('alpha'),
        beta: worker('beta', { requires: ['alpha'] }),
        gamma: worker('gamma', { requires: ['beta'] }),
        delta: worker('delta', { requires: ['alpha'] }),
        other: worker('other'),
      },
      entries: { alpha: signed(), beta: signed(), gamma: signed(), delta: signed(), other: signed() },
      limits: { stopGraceMs: 120 },
    })
    await made.pluginsManager.start()
    await expect(watchdog(made, 'watchdog.stop', 'alpha')).resolves.toBe(null)
    const stops = made.link.timeline.filter(line => line.startsWith('stop ')).map(line => line.slice(5))
    expect(stops).toEqual(['gamma', 'delta', 'beta', 'alpha'])
    // Each one after every plugin that requires it
    for (const [plugin, dependents] of [['alpha', ['beta', 'delta']], ['beta', ['gamma']]] as const) {
      for (const dependent of dependents) expect(stops.indexOf(dependent)).toBeLessThan(stops.indexOf(plugin))
    }
    expect(made.link.sentTo('alpha', 'stop')).toEqual([{ v: 1, kind: 'stop', graceMs: 120 }])
    expect(made.link.events('plugin.stopped').find(fields => fields.plugin === 'alpha')).toEqual({
      plugin: 'alpha', incarnation: 1, reason: 'watchdog', with: 'beta,delta,gamma',
    })
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('stopped')
    expect(reasonOf(made.pluginsManager, 'beta')).toBe('dependency:alpha:stopped')
    expect(reasonOf(made.pluginsManager, 'gamma')).toBe('dependency:beta:waiting')
    expect(stateOf(made.pluginsManager, 'other')).toBe('ready')
  })

  it('ends a plugin that never answers stopped once the grace is over', async () => {
    const made = await harness({
      folder: { alpha: worker('alpha') },
      entries: { alpha: signed() },
      behave: { alpha: { stopped: false } },
      limits: { stopGraceMs: 80 },
    })
    await made.pluginsManager.start()
    const began = Date.now()
    await made.pluginsManager.stop('alpha', 'human')
    expect(Date.now() - began).toBeGreaterThanOrEqual(70)
    expect(made.runtime.terminated).toEqual([{ id: 'alpha', incarnation: 1 }])
    expect(made.pluginsManager.list().find(row => row.id === 'alpha')).toMatchObject({ state: 'stopped', reason: 'human' })
  })

  // Only the watchdog or the human stops or restarts a plugin
  it('changes nothing for a stopped no stop asked for', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    await made.pluginsManager.start()
    made.runtime.half('alpha').send({ v: 1, kind: 'stopped' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
    expect(made.pluginsManager.plugin('alpha')?.incarnation).toBe(1)
    expect(made.link.events('plugin.stopped')).toEqual([])
    expect(made.runtime.terminated).toEqual([])
  })

  it('reads a close during a planned stop as that stop ending, not a crash', async () => {
    const made = await harness({
      folder: { alpha: worker('alpha') },
      entries: { alpha: signed() },
      behave: { alpha: { stopped: false } },
      limits: { stopGraceMs: 2000 },
    })
    await made.pluginsManager.start()
    const stopping = made.pluginsManager.stop('alpha', 'human')
    await until(() => made.runtime.half('alpha').got('stop').length === 1)
    made.runtime.half('alpha').crash()
    await stopping
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('stopped')
    expect(made.link.events('plugin.crashed')).toEqual([])
  })
})

describe('restarts', () => {
  it('come from watchdog.restart and run the bytes already verified as a new incarnation on a new port', async () => {
    const made = await harness({
      folder: { mapper: worker('mapper'), tagger: worker('tagger', { requires: ['mapper'] }) },
      entries: { mapper: signed(), tagger: signed() },
    })
    await made.pluginsManager.start()
    const first = made.runtime.started.find(start => start.id === 'mapper')!.code
    made.runtime.half('mapper').crash()
    await until(() => stateOf(made.pluginsManager, 'tagger') === 'waiting')
    await watchdog(made, 'watchdog.restart', 'mapper')
    await until(() => stateOf(made.pluginsManager, 'tagger') === 'ready')
    const second = made.runtime.started.filter(start => start.id === 'mapper')
    expect(second.map(start => start.incarnation)).toEqual([1, 2])
    expect(second[1].code).toBe(first)
    expect(made.link.registered.filter(caller => caller.kind === 'plugin' && caller.id === 'mapper').map(caller => (caller as { incarnation: number }).incarnation)).toEqual([1, 2])
    // Each hears why it last went down
    expect(made.runtime.half('mapper', 2).got('init')[0].lastStop).toBe('closed')
    expect(made.runtime.half('tagger', 2).got('init')[0].lastStop).toBe('dependency:mapper:crashed')
  })

  it('restart a running plugin by stopping it with its dependents first', async () => {
    const made = await harness({
      folder: { mapper: worker('mapper'), tagger: worker('tagger', { requires: ['mapper'] }) },
      entries: { mapper: signed(), tagger: signed() },
    })
    await made.pluginsManager.start()
    await watchdog(made, 'watchdog.restart', 'mapper')
    await until(() => stateOf(made.pluginsManager, 'tagger') === 'ready' && made.pluginsManager.plugin('tagger')?.incarnation === 2)
    const lines = made.link.timeline.filter(line => /^(stop|init) (mapper|tagger)$/.test(line))
    expect(lines).toEqual(['init mapper', 'init tagger', 'stop tagger', 'stop mapper', 'init mapper', 'init tagger'])
  })

  it('are refused for a plugin switched off, one that can\'t start and a core module, which is no plugin', async () => {
    const made = await harness({
      folder: { alpha: worker('alpha'), beta: worker('beta', { requires: ['nothing-here'] }) },
      entries: { alpha: signed({ enabled: false }), beta: signed() },
    })
    await made.pluginsManager.start()
    await expect(made.pluginsManager.restart('alpha', 'human')).rejects.toEqual({ code: 'switched-off' })
    await expect(made.pluginsManager.restart('beta', 'human')).rejects.toEqual({ code: 'unavailable' })
    await expect(made.pluginsManager.restart('gate', 'human')).rejects.toEqual({ code: 'not-found' })
    await expect(made.pluginsManager.restart('nobody', 'human')).rejects.toEqual({ code: 'not-found' })
  })

  it('serves watchdog.stop and watchdog.restart on the core seam and refuses a change outside the schema', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    await made.pluginsManager.start()
    const call = (action: string, args: unknown) => ({ callId: 'c', caller: wkr('watchdog'), action, args, deadline: Date.now() + 1000 })
    await expect(made.pluginsManager.serve(call('security.request', { change: {} }))).rejects.toEqual({ code: 'invalid' })
    await expect(made.pluginsManager.serve(call('watchdog.stop', { plugin: 'gate' }))).rejects.toEqual({ code: 'not-found' })
    await expect(made.pluginsManager.serve(call('watchdog.stop', { plugin: 'alpha' }))).resolves.toBe(null)
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('stopped')
  })
})

describe('the heartbeat', () => {
  it('reads a worker that misses heartbeatMisses pings unresponsive, its dependents running on and nothing closed, until it answers', async () => {
    const made = await harness({
      folder: { mapper: worker('mapper'), tagger: worker('tagger', { requires: ['mapper'] }) },
      entries: { mapper: signed(), tagger: signed() },
      limits: { heartbeatMs: 15, heartbeatMisses: 3 },
    })
    await made.pluginsManager.start()
    made.runtime.behave.mapper = { pong: false }
    await until(() => stateOf(made.pluginsManager, 'mapper') === 'unresponsive')
    expect(made.link.events('plugin.unresponsive')).toEqual([{ plugin: 'mapper', incarnation: 1 }])
    expect(made.link.sentTo('mapper', 'ping').length).toBeGreaterThanOrEqual(4)
    expect(stateOf(made.pluginsManager, 'tagger')).toBe('ready')
    expect(made.runtime.terminated).toEqual([])
    expect(made.link.ended).toEqual([])
    made.runtime.half('mapper').send({ v: 1, kind: 'pong' })
    await until(() => stateOf(made.pluginsManager, 'mapper') === 'ready')
  })

  it('has the carrier answer calls to an unresponsive plugin timeout at once', async () => {
    const made = await harness({
      folder: { mapper: worker('mapper', { provides: { actions: { query: {} } } }), outline: worker('outline') },
      entries: { mapper: signed(), outline: signed() },
      limits: { heartbeatMs: 15, heartbeatMisses: 2 },
    })
    await made.pluginsManager.start()
    made.runtime.behave.mapper = { pong: false }
    await until(() => stateOf(made.pluginsManager, 'mapper') === 'unresponsive')
    const reply = await made.runtime.half('outline').ask('mapper.query', {}, 200)
    expect((reply?.refusal as { code: string }).code).toBe('timeout')
  })

  it('pings no core module', async () => {
    const made = await harness({ limits: { heartbeatMs: 10 } })
    await made.pluginsManager.start()
    await tick(40)
    expect(made.link.sent.filter(({ message }) => message.kind === 'ping')).toEqual([])
  })
})

describe('shutdown', () => {
  it('tells the carrier first, then stops plugins in reverse graph order and ends the core modules last in the reverse of their start, the gate answering to the end', async () => {
    const modules = { luoshu: fakeLuoshu(), history: fakeHistory(), exec: fakeExec() }
    const made = await harness({
      folder: { alpha: worker('alpha'), beta: worker('beta', { requires: ['alpha'] }) },
      entries: { alpha: signed(), beta: signed() },
      modules,
    })
    // Each module's close lands on the link's timeline, so its place after the stops shows
    for (const [id, module] of Object.entries(modules)) {
      module.close = () => {
        module.closed++
        made.link.timeline.push(`close ${id}`)
      }
    }
    await made.pluginsManager.start()
    await made.pluginsManager.shutdown()
    const lines = made.link.timeline.slice(made.link.timeline.indexOf('stopping'))
    expect(lines[0]).toBe('stopping')
    expect(lines[1]).toBe('record core.stopping')
    expect(lines.filter(line => line.startsWith('stop ') || line.startsWith('close '))).toEqual([
      'stop beta', 'stop alpha', 'close exec', 'close history', 'close luoshu',
    ])
    for (const row of made.pluginsManager.list()) expect(row).toMatchObject({ state: 'stopped', reason: 'shutdown' })
    expect(made.pluginsManager.policyJob('gate')).toBe('on')
    expect(made.modules.gate()).toBe(made.gate)
    expect(made.link.stopped).toBe(1)
  })

  it('starts nothing once it began', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    await made.pluginsManager.start()
    await made.pluginsManager.shutdown()
    await expect(made.pluginsManager.restart('alpha', 'human')).rejects.toEqual({ code: 'stopped' })
    expect(made.runtime.order().filter(id => id === 'alpha')).toHaveLength(1)
  })
})
