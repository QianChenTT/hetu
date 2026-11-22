import { afterEach, describe, expect, it } from 'vitest'
import type { Caller } from '../api/envelope.ts'
import type { SecurityList } from '../api/actions.ts'
import {
  allowAll, cleanup, DOOR_CODE, entryFor, filesFor, harness, reasonOf, stateOf, tick, until, workerManifest,
} from './plugins-manager-fakes.ts'

afterEach(cleanup)

const utilityCaller = (incarnation = 1): Caller => ({ kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation })
const windowCall = (action: string, plugin: string, role: 'editor' | 'trusted' = 'trusted') => {
  const caller: Caller = { kind: 'window', role, n: 1 }
  return { callId: 'c', caller, root: caller, action, args: { plugin }, deadline: Date.now() + 1000 }
}

// The door, whose host entry runs in a utility process
const door = DOOR_CODE
// A folder plugin requiring http
const dependent = { folder: { tool: filesFor(workerManifest('tool', { requires: ['mcp-http-handler'] })) }, entries: { tool: (root: string) => entryFor(root) } }

describe('the door\'s powers', () => {
  // Fixed in code: what the floor admits from its utility process and nothing it holds
  it('holds no grant: none the gate is handed, none the classifier reads and no role', async () => {
    const gate = allowAll()
    const made = await harness({ door, ...dependent, modules: { gate } })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('ready')
    const inside = made.pluginsManager as unknown as { grantsHeld(k: unknown): unknown[], grantsOf(id: string): unknown[], known: Map<string, unknown> }
    expect(inside.grantsHeld(inside.known.get('mcp-http-handler'))).toEqual([])
    expect(inside.grantsOf('mcp-http-handler')).toEqual([])
    expect(gate.seen.length).toBeGreaterThan(0)
    for (const snapshot of gate.seen) expect(Object.keys(snapshot.plugins)).not.toContain('mcp-http-handler')
  })
})

describe('the door in the trusted window\'s list', () => {
  // The window draws a core row as a core module's, its switch alone. The door's row ships with hetu, runs in its utility
  // process and stops and restarts there, which the contract's install row says
  it('is a row of its own that ships with hetu, apart from the core modules, with its switch on', async () => {
    const made = await harness({ door })
    await made.pluginsManager.start()
    const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
    const list = await made.pluginsManager.serve({ callId: 'c', caller: trusted, root: trusted, action: 'security.list', args: {}, deadline: Date.now() + 1000 }) as SecurityList
    expect(list.plugins.find(row => row.id === 'mcp-http-handler')).toMatchObject({ from: 'install', place: 'utility', state: 'ready', on: true, items: [] })
    expect(list.plugins.filter(row => row.from === 'core').map(row => row.id)).not.toContain('mcp-http-handler')
  })
})

describe('a utility half', () => {
  // No hash is kept apart for the door, so its check reads unchecked and never ok: a packaged build's door.js is covered
  // by app.asar's integrity alone
  it('starts from the bytes of door.js read once, on a port registered under its host half, never imported in main', async () => {
    const made = await harness({ door })
    await made.pluginsManager.start()
    expect(made.link.events('plugin.checked')).toContainEqual({ plugin: 'mcp-http-handler', from: 'core', result: 'unchecked' })
    expect(made.link.events('plugin.checked').filter(fields => fields.plugin === 'mcp-http-handler')).toHaveLength(1)
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('ready')
    expect(made.pluginsManager.plugin('mcp-http-handler')?.place).toBe('utility')
    expect(made.pluginsManager.list().find(row => row.id === 'mcp-http-handler')?.place).toBe('utility')
    expect(made.runtime.started.filter(start => start.id === 'mcp-http-handler')).toEqual([
      { id: 'mcp-http-handler', incarnation: 1, half: 'utility', code: DOOR_CODE },
    ])
    expect(made.link.registered).toContainEqual(utilityCaller())
    // Recorded as the port of the utility process the core started, which the router's floor reads
    expect(made.link.utilities).toEqual([utilityCaller()])
    // Main counts the bytes on its port, since no relay page sits in front of it. A worker's it leaves to the relay
    expect(made.runtime.channels).toEqual([{ id: 'mcp-http-handler', counted: true }])
    // It requires nothing. No plugin holds door.handle, the role it calls
    expect(made.runtime.order()).toEqual(['mcp-http-handler'])
    expect(made.runtime.half('mcp-http-handler', 1, 'utility').got('init')[0].deps).toEqual({ 'door.handle': 'unavailable' })
  })

  it('is never told the data folder', async () => {
    const made = await harness({ door })
    await made.pluginsManager.start()
    const [init] = made.runtime.half('mcp-http-handler', 1, 'utility').got('init')
    expect(init).toMatchObject({ kind: 'init', id: 'mcp-http-handler', incarnation: 1 })
    expect(Object.hasOwn(init, 'dataDir')).toBe(false)
    expect(JSON.stringify(made.link.sentTo('mcp-http-handler', 'init'))).not.toContain(made.dataDir)
  })

  it('is killed and reads crashed when it isn\'t ready by its deadline', async () => {
    const made = await harness({ door, behave: { 'mcp-http-handler': { ready: false } }, limits: { readyMs: 60 } })
    await made.pluginsManager.start()
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'crashed')
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe('start-timeout')
    expect(made.runtime.killed).toEqual([{ id: 'mcp-http-handler', incarnation: 1 }])
  })

  it('reads crashed with start-failed when the fork throws', async () => {
    const made = await harness({ door, behave: { 'mcp-http-handler': { throws: true } } })
    await made.pluginsManager.start()
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'crashed')
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe('start-failed')
  })
})

describe('the heartbeat of a utility half', () => {
  it('pings it and kills it after heartbeatMisses unanswered, crashed with unresponsive, its dependents waiting', async () => {
    const made = await harness({ door, ...dependent, limits: { heartbeatMs: 15, heartbeatMisses: 3 } })
    await made.pluginsManager.start()
    await until(() => stateOf(made.pluginsManager, 'tool') === 'ready')
    made.runtime.behave['mcp-http-handler'] = { pong: false }
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'crashed')
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe('unresponsive')
    expect(made.runtime.killed).toEqual([{ id: 'mcp-http-handler', incarnation: 1 }])
    expect(made.link.ended).toContainEqual({ caller: utilityCaller(), code: 'crashed' })
    expect(made.link.events('plugin.crashed')).toEqual([{ plugin: 'mcp-http-handler', incarnation: 1, reason: 'unresponsive' }])
    expect(stateOf(made.pluginsManager, 'tool')).toBe('waiting')
  })

  it('kills no utility half in its planned stop for missed beats, its stop ending as the human\'s', async () => {
    const made = await harness({
      door, behave: { 'mcp-http-handler': { stopped: false } }, limits: { heartbeatMs: 10, heartbeatMisses: 2, stopGraceMs: 200 },
    })
    await made.pluginsManager.start()
    made.runtime.behave['mcp-http-handler'] = { pong: false, stopped: false }
    const began = Date.now()
    await made.pluginsManager.stop('mcp-http-handler', 'human')
    // The whole grace, which a kill would have cut short
    expect(Date.now() - began).toBeGreaterThanOrEqual(180)
    expect(made.link.events('plugin.crashed')).toEqual([])
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe('human')
  })

  it('kills no utility half while the human has the heartbeat off', async () => {
    const made = await harness({ door, switches: { off: ['heartbeat'] }, limits: { heartbeatMs: 10, heartbeatMisses: 2 } })
    await made.pluginsManager.start()
    made.runtime.behave['mcp-http-handler'] = { pong: false }
    await tick(80)
    expect(made.runtime.killed).toEqual([])
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('ready')
  })

  // Everything main hears from it counts as alive, noted before its rate. Held far over the rate its pongs are dropped
  // and it still lives while it sends, then dies once silent
  it('keeps one over its rate whose pongs are dropped while main hears anything from it and kills it once it is silent', async () => {
    const made = await harness({
      door,
      limits: { heartbeatMs: 40, heartbeatMisses: 2 },
      switches: { limits: { all: {}, plugins: { 'mcp-http-handler': { messagesPerSecond: 5, floodFactor: 1000 } } } },
    })
    await made.pluginsManager.start()
    const half = made.runtime.half('mcp-http-handler', 1, 'utility')
    const end = Date.now() + 500
    let sent = 0
    while (Date.now() < end) {
      half.send({ v: 1, kind: 'busy', n: sent++ })
      await tick(2)
    }
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('ready')
    expect(made.runtime.killed).toEqual([])
    expect(made.link.sentTo('mcp-http-handler', 'ping').length).toBeGreaterThanOrEqual(5)
    made.runtime.behave['mcp-http-handler'] = { pong: false }
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'crashed')
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe('unresponsive')
  })

  it('ends one past its flood cap as flood, though main heard it', async () => {
    const made = await harness({
      door,
      limits: { heartbeatMs: 40, heartbeatMisses: 2 },
      switches: { limits: { all: {}, plugins: { 'mcp-http-handler': { messagesPerSecond: 5, floodFactor: 2, floodMs: 1000 } } } },
    })
    await made.pluginsManager.start()
    const half = made.runtime.half('mcp-http-handler', 1, 'utility')
    for (let i = 0; i < 20; i++) half.send({ v: 1, kind: 'busy', n: i })
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'crashed')
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe('flood')
    expect(made.runtime.killed).toEqual([{ id: 'mcp-http-handler', incarnation: 1 }])
  })

  it('keeps one that answers ready and running', async () => {
    const made = await harness({ door, limits: { heartbeatMs: 10, heartbeatMisses: 2 } })
    await made.pluginsManager.start()
    await until(() => made.link.sentTo('mcp-http-handler', 'ping').length >= 5)
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('ready')
    expect(made.runtime.killed).toEqual([])
  })
})

describe('a utility process that ends', () => {
  it('reads crashed when it exits by itself while ready, whatever its exit, with exited', async () => {
    const made = await harness({ door })
    await made.pluginsManager.start()
    made.runtime.exit('mcp-http-handler', 1, false)
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'crashed')
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe('exited')
    expect(made.link.events('plugin.crashed')).toEqual([{ plugin: 'mcp-http-handler', incarnation: 1, reason: 'exited' }])
  })

  it('reads the runtime\'s own kill as killed, never as a clean exit', async () => {
    const made = await harness({ door })
    await made.pluginsManager.start()
    made.runtime.exit('mcp-http-handler', 1, true)
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'crashed')
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe('killed')
  })

  it('reads its port closing as a crash, as a worker\'s', async () => {
    const made = await harness({ door })
    await made.pluginsManager.start()
    made.runtime.half('mcp-http-handler', 1, 'utility').crash()
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'crashed')
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe('closed')
  })

  it('changes nothing when an incarnation that is over exits late', async () => {
    const made = await harness({ door })
    await made.pluginsManager.start()
    await made.pluginsManager.serve(windowCall('core.restart', 'mcp-http-handler'))
    await until(() => made.pluginsManager.plugin('mcp-http-handler')?.incarnation === 2 && stateOf(made.pluginsManager, 'mcp-http-handler') === 'ready')
    made.runtime.exit('mcp-http-handler', 1, false)
    await tick(20)
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('ready')
  })
})

describe('stops and restarts of a utility half', () => {
  it('stops on core.stop from the trusted window: stop down its way, the way ended, then the process killed', async () => {
    const made = await harness({ door })
    await made.pluginsManager.start()
    await made.pluginsManager.serve(windowCall('core.stop', 'mcp-http-handler'))
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('stopped')
    expect(made.link.sentTo('mcp-http-handler', 'stop')).toHaveLength(1)
    expect(made.link.ended).toContainEqual({ caller: utilityCaller(), code: 'stopped' })
    expect(made.runtime.killed).toEqual([{ id: 'mcp-http-handler', incarnation: 1 }])
  })

  it('is killed once the stop grace ran out when it never answers stopped', async () => {
    const made = await harness({ door, behave: { 'mcp-http-handler': { stopped: false } } })
    await made.pluginsManager.start()
    await made.pluginsManager.serve(windowCall('core.stop', 'mcp-http-handler'))
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('stopped')
    expect(made.runtime.killed).toEqual([{ id: 'mcp-http-handler', incarnation: 1 }])
  })

  it('restarts in the same run on core.restart as a new incarnation from the same bytes', async () => {
    const made = await harness({ door })
    await made.pluginsManager.start()
    made.runtime.exit('mcp-http-handler', 1, false)
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'crashed')
    await made.pluginsManager.serve(windowCall('core.restart', 'mcp-http-handler'))
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'ready')
    const starts = made.runtime.started.filter(start => start.id === 'mcp-http-handler')
    expect(starts.map(start => start.incarnation)).toEqual([1, 2])
    expect(starts[1].code).toBe(starts[0].code)
    expect(made.link.registered).toContainEqual(utilityCaller(2))
  })

  // The door is the human's to restart: a restart cuts every agent call in flight and brings back a door the core ended
  it('is restarted from the trusted window alone, never from the editor window, running or failed', async () => {
    const made = await harness({ door })
    await made.pluginsManager.start()
    await expect(made.pluginsManager.serve(windowCall('core.restart', 'mcp-http-handler', 'editor'))).rejects.toEqual({ code: 'not-granted' })
    expect(made.runtime.killed).toEqual([])
    expect(made.pluginsManager.plugin('mcp-http-handler')).toMatchObject({ state: 'ready', incarnation: 1 })
    await made.pluginsManager.serve({ callId: 'c', caller: utilityCaller(), root: utilityCaller(), action: 'core.bindFailed', args: { reason: 'port-taken' }, deadline: Date.now() + 1000 })
    await expect(made.pluginsManager.serve(windowCall('core.restart', 'mcp-http-handler', 'editor'))).rejects.toEqual({ code: 'not-granted' })
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('failed')
    await made.pluginsManager.serve(windowCall('core.restart', 'mcp-http-handler'))
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'ready')
    expect(made.runtime.started.filter(start => start.id === 'mcp-http-handler').map(start => start.incarnation)).toEqual([1, 2])
  })

})

describe('a utility half whose bind failed', () => {
  const bindFailed = (reason: string, caller: Caller = utilityCaller()) =>
    ({ callId: 'c', caller, root: caller, action: 'core.bindFailed', args: { reason }, deadline: Date.now() + 1000 })

  it.each(['port-taken', 'bind-failed'])('reads failed with %s, not crashed, its process ended and its dependents waiting', async reason => {
    const made = await harness({ door })
    await made.pluginsManager.start()
    await made.pluginsManager.serve(bindFailed(reason))
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('failed')
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe(reason)
    expect(made.pluginsManager.list().find(row => row.id === 'mcp-http-handler')).toMatchObject({ place: 'utility', state: 'failed', reason })
    expect(made.link.events('plugin.failed')).toEqual([{ plugin: 'mcp-http-handler', incarnation: 1, reason }])
    expect(made.link.events('plugin.crashed')).toEqual([])
    expect(made.link.ended).toContainEqual({ caller: utilityCaller(), code: 'crashed' })
    expect(made.runtime.killed).toEqual([{ id: 'mcp-http-handler', incarnation: 1 }])
  })

  it('moves a plugin that requires it to waiting, naming it failed', async () => {
    const made = await harness({ door, ...dependent })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'tool')).toBe('ready')
    // The folder plugin's worker is registered on a port, never as a utility process
    expect(made.link.registered).toContainEqual({ kind: 'plugin', id: 'tool', half: 'worker', incarnation: 1 })
    expect(made.link.utilities).toEqual([utilityCaller()])
    await made.pluginsManager.serve(bindFailed('port-taken'))
    expect(stateOf(made.pluginsManager, 'tool')).toBe('waiting')
    expect(reasonOf(made.pluginsManager, 'tool')).toBe('dependency:mcp-http-handler:failed')
  })

  it('starts again on core.restart from the trusted window, a new incarnation from the same bytes', async () => {
    const made = await harness({ door })
    await made.pluginsManager.start()
    await made.pluginsManager.serve(bindFailed('port-taken'))
    await made.pluginsManager.serve(windowCall('core.restart', 'mcp-http-handler'))
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'ready')
    expect(made.runtime.started.filter(start => start.id === 'mcp-http-handler').map(start => start.incarnation)).toEqual([1, 2])
    expect(made.runtime.half('mcp-http-handler', 2, 'utility').got('init')[0]).toMatchObject({ lastStop: 'port-taken' })
  })

  it('ends nothing for a caller whose incarnation is over or that is not a utility half', async () => {
    const made = await harness({ door, ...dependent })
    await made.pluginsManager.start()
    await expect(made.pluginsManager.serve(bindFailed('port-taken', utilityCaller(2)))).rejects.toEqual({ code: 'not-found' })
    const tool: Caller = { kind: 'plugin', id: 'tool', half: 'worker', incarnation: 1 }
    await expect(made.pluginsManager.serve(bindFailed('port-taken', tool))).rejects.toEqual({ code: 'not-granted' })
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('ready')
    expect(stateOf(made.pluginsManager, 'tool')).toBe('ready')
    expect(made.runtime.killed).toEqual([])
  })
})

describe('limits the human sets', () => {
  // The runtime hears each change once it landed and reads the values as the router holds them at that moment
  async function listening() {
    const heard: [string, number][] = []
    const holder: { made: Awaited<ReturnType<typeof harness>> | null } = { made: null }
    holder.made = await harness({
      door,
      pluginsManager: { limited: plugin => void heard.push([plugin, holder.made!.router.limit(plugin, 'messagesPerSecond')]) },
    })
    await holder.made.pluginsManager.start()
    return { made: holder.made, heard }
  }

  it('reach the runtime for the plugin named once the new value is written, a raise as well as a lowering', async () => {
    const { made, heard } = await listening()
    await made.pluginsManager.apply({ kind: 'limit.set', constant: 'messagesPerSecond', value: 20, plugin: 'mcp-http-handler' })
    expect(heard).toEqual([['mcp-http-handler', 20]])
    await made.pluginsManager.apply({ kind: 'limit.set', constant: 'messagesPerSecond', value: 300, plugin: 'mcp-http-handler' })
    expect(heard).toEqual([['mcp-http-handler', 20], ['mcp-http-handler', 300]])
  })

  it('reach the runtime for every plugin when set for all', async () => {
    const { made, heard } = await listening()
    await made.pluginsManager.apply({ kind: 'limit.set', constant: 'messagesPerSecond', value: 30, plugin: null })
    expect(heard.map(([plugin]) => plugin).sort()).toEqual(['mcp-http-handler'])
    expect(heard.find(([plugin]) => plugin === 'mcp-http-handler')).toEqual(['mcp-http-handler', 30])
  })

  it('apply even when the runtime throws as it hears one', async () => {
    const made = await harness({ door, pluginsManager: { limited: () => { throw new Error('no child') } } })
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'limit.set', constant: 'messagesPerSecond', value: 20, plugin: 'mcp-http-handler' })
    expect(made.router.limit('mcp-http-handler', 'messagesPerSecond')).toBe(20)
  })
})
