import { stat } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { Caller } from '../api/envelope.ts'
import { folders } from '../backend/plugins-manager/folders.ts'
import {
  cleanup, coreInstall, filesFor, harness, hostManifest, manifest, reasonOf, stateOf, tick, until, type Listing,
} from './plugins-manager-fakes.ts'

afterEach(cleanup)

const host = (id: string, extra: object = {}): Listing => ({ files: filesFor(hostManifest(id, extra)) })
const exists = (file: string) => stat(file).then(() => true, () => false)
const utilityCaller = (incarnation = 1): Caller => ({ kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation })
const windowCall = (action: string, plugin: string, role: 'editor' | 'trusted' = 'trusted') =>
  ({ callId: 'c', caller: { kind: 'window', role, n: 1 } as Caller, action, args: { plugin }, deadline: Date.now() + 1000 })

// The core's host tier, storage beside it as a host plugin and http, whose host entry runs in a utility process
const install = (http: Listing = host('mcp-http-handler', { requires: ['storage'] })) => ({ ...coreInstall(), storage: host('storage'), 'mcp-http-handler': http })

describe('a utility half', () => {
  it('starts from the host entry\'s verified bytes on a port registered under its host half, never imported in main', async () => {
    const made = await harness({ install: install() })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('ready')
    expect(made.pluginsManager.plugin('mcp-http-handler')?.place).toBe('utility')
    expect(made.pluginsManager.list().find(row => row.id === 'mcp-http-handler')?.place).toBe('utility')
    expect(made.runtime.started.filter(start => start.id === 'mcp-http-handler')).toEqual([
      { id: 'mcp-http-handler', incarnation: 1, half: 'utility', code: '// mcp-http-handler host.js 1.0.0\n' },
    ])
    expect(made.link.registered).toContainEqual(utilityCaller())
    // Main counts the bytes on its port, since no relay page sits in front of it. A worker's it leaves to the relay
    expect(made.runtime.channels).toEqual([{ id: 'mcp-http-handler', counted: true }])
    // Every host plugin starts before it, as a sandboxed plugin's does
    expect(made.runtime.order()).toEqual(['gate', 'storage', 'mcp-http-handler'])
  })

  it('is never told the data folder, which an install host half in main is', async () => {
    const made = await harness({ install: install() })
    await made.pluginsManager.start()
    const [init] = made.runtime.half('mcp-http-handler', 1, 'utility').got('init')
    expect(init).toMatchObject({ kind: 'init', id: 'mcp-http-handler', incarnation: 1 })
    expect(Object.hasOwn(init, 'dataDir')).toBe(false)
    expect(JSON.stringify(made.link.sentTo('mcp-http-handler', 'init'))).not.toContain(made.dataDir)
    expect(made.runtime.half('storage', 1, 'host').got('init')[0].dataDir).toBe(made.dataDir)
  })

  it('writes no start marker, since it can\'t freeze main', async () => {
    const made = await harness({ install: install(), behave: { 'mcp-http-handler': { ready: false }, storage: { ready: false } } })
    const starting = made.pluginsManager.start()
    await until(() => made.runtime.started.some(start => start.id === 'storage'))
    // A host half's marker is down while it starts
    expect(await exists(folders.marker(made.dataDir, 'storage'))).toBe(true)
    made.runtime.half('storage', 1, 'host').ready()
    await until(() => made.runtime.started.some(start => start.id === 'mcp-http-handler'))
    await tick(30)
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('starting')
    expect(await exists(folders.marker(made.dataDir, 'mcp-http-handler'))).toBe(false)
    made.runtime.half('mcp-http-handler', 1, 'utility').ready()
    await starting
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('ready')
  })

  it('is refused with place when its manifest names no host entry, so it never runs as a worker instead', async () => {
    const made = await harness({ install: install({ files: filesFor(manifest('mcp-http-handler', { entries: { worker: 'worker.js' } })) }) })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('refused')
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe('place')
    expect(made.runtime.started.filter(start => start.id === 'mcp-http-handler')).toEqual([])
  })

  it('is killed and reads crashed when it isn\'t ready by its deadline', async () => {
    const made = await harness({ install: install(), behave: { 'mcp-http-handler': { ready: false } }, limits: { readyMs: 60 } })
    await made.pluginsManager.start()
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'crashed')
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe('start-timeout')
    expect(made.runtime.killed).toEqual([{ id: 'mcp-http-handler', incarnation: 1 }])
  })

  it('reads crashed with start-failed when the fork throws', async () => {
    const made = await harness({ install: install(), behave: { 'mcp-http-handler': { throws: true } } })
    await made.pluginsManager.start()
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'crashed')
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe('start-failed')
  })
})

describe('the heartbeat of a utility half', () => {
  it('pings it and kills it after heartbeatMisses unanswered, crashed with unresponsive, its dependents waiting', async () => {
    const made = await harness({
      install: { ...install(), net: host('net', { requires: ['mcp-http-handler'] }) },
      limits: { heartbeatMs: 15, heartbeatMisses: 3 },
    })
    await made.pluginsManager.start()
    await until(() => stateOf(made.pluginsManager, 'net') === 'ready')
    made.runtime.behave['mcp-http-handler'] = { pong: false }
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'crashed')
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe('unresponsive')
    expect(made.runtime.killed).toEqual([{ id: 'mcp-http-handler', incarnation: 1 }])
    expect(made.link.ended).toContainEqual({ caller: utilityCaller(), code: 'crashed' })
    expect(made.link.events('plugin.crashed')).toEqual([{ plugin: 'mcp-http-handler', incarnation: 1, reason: 'unresponsive' }])
    expect(stateOf(made.pluginsManager, 'net')).toBe('waiting')
  })

  // Everything main hears from it counts as alive, noted before its rate. Held far over the rate its pongs are dropped
  // and it still lives while it sends, then dies once silent
  it('keeps one over its rate whose pongs are dropped while main hears anything from it and kills it once it is silent', async () => {
    const made = await harness({
      install: install(),
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
      install: install(),
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
    const made = await harness({ install: install(), limits: { heartbeatMs: 10, heartbeatMisses: 2 } })
    await made.pluginsManager.start()
    await until(() => made.link.sentTo('mcp-http-handler', 'ping').length >= 5)
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('ready')
    expect(made.runtime.killed).toEqual([])
  })
})

describe('a utility process that ends', () => {
  it('reads crashed when it exits by itself while ready, whatever its exit, with exited', async () => {
    const made = await harness({ install: install() })
    await made.pluginsManager.start()
    made.runtime.exit('mcp-http-handler', 1, false)
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'crashed')
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe('exited')
    expect(made.link.events('plugin.crashed')).toEqual([{ plugin: 'mcp-http-handler', incarnation: 1, reason: 'exited' }])
  })

  it('reads the runtime\'s own kill as killed, never as a clean exit', async () => {
    const made = await harness({ install: install() })
    await made.pluginsManager.start()
    made.runtime.exit('mcp-http-handler', 1, true)
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'crashed')
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe('killed')
  })

  it('reads its port closing as a crash, as a worker\'s', async () => {
    const made = await harness({ install: install() })
    await made.pluginsManager.start()
    made.runtime.half('mcp-http-handler', 1, 'utility').crash()
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'crashed')
    expect(reasonOf(made.pluginsManager, 'mcp-http-handler')).toBe('closed')
  })

  it('changes nothing when an incarnation that is over exits late', async () => {
    const made = await harness({ install: install() })
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
    const made = await harness({ install: install() })
    await made.pluginsManager.start()
    await made.pluginsManager.serve(windowCall('core.stop', 'mcp-http-handler'))
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('stopped')
    expect(made.link.sentTo('mcp-http-handler', 'stop')).toHaveLength(1)
    expect(made.link.ended).toContainEqual({ caller: utilityCaller(), code: 'stopped' })
    expect(made.runtime.killed).toEqual([{ id: 'mcp-http-handler', incarnation: 1 }])
  })

  it('is killed once the stop grace ran out when it never answers stopped', async () => {
    const made = await harness({ install: install(), behave: { 'mcp-http-handler': { stopped: false } } })
    await made.pluginsManager.start()
    await made.pluginsManager.serve(windowCall('core.stop', 'mcp-http-handler'))
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('stopped')
    expect(made.runtime.killed).toEqual([{ id: 'mcp-http-handler', incarnation: 1 }])
  })

  it('restarts in the same run on core.restart as a new incarnation from the same bytes, unlike a host half', async () => {
    const made = await harness({ install: install() })
    await made.pluginsManager.start()
    made.runtime.exit('mcp-http-handler', 1, false)
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'crashed')
    await made.pluginsManager.serve(windowCall('core.restart', 'mcp-http-handler'))
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'ready')
    const starts = made.runtime.started.filter(start => start.id === 'mcp-http-handler')
    expect(starts.map(start => start.incarnation)).toEqual([1, 2])
    expect(starts[1].code).toBe(starts[0].code)
    expect(made.link.registered).toContainEqual(utilityCaller(2))
    await expect(made.pluginsManager.serve(windowCall('core.restart', 'storage', 'editor'))).rejects.toEqual({ code: 'not-granted' })
  })

  // The door is the human's to restart: a restart cuts every agent call in flight and brings back a door the core ended
  it('is restarted from the trusted window alone, never from the editor window, running or failed', async () => {
    const made = await harness({ install: install() })
    await made.pluginsManager.start()
    await expect(made.pluginsManager.serve(windowCall('core.restart', 'mcp-http-handler', 'editor'))).rejects.toEqual({ code: 'not-granted' })
    expect(made.runtime.killed).toEqual([])
    expect(made.pluginsManager.plugin('mcp-http-handler')).toMatchObject({ state: 'ready', incarnation: 1 })
    await made.pluginsManager.serve({ callId: 'c', caller: utilityCaller(), action: 'core.bindFailed', args: { reason: 'port-taken' }, deadline: Date.now() + 1000 })
    await expect(made.pluginsManager.serve(windowCall('core.restart', 'mcp-http-handler', 'editor'))).rejects.toEqual({ code: 'not-granted' })
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('failed')
    await made.pluginsManager.serve(windowCall('core.restart', 'mcp-http-handler'))
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'ready')
    expect(made.runtime.started.filter(start => start.id === 'mcp-http-handler').map(start => start.incarnation)).toEqual([1, 2])
  })

  it('is out of the watchdog\'s reach, which acts on sandboxed plugins only', async () => {
    const made = await harness({ install: install() })
    await made.pluginsManager.start()
    const call = { callId: 'c', caller: { kind: 'plugin', id: 'watchdog', half: 'host', incarnation: 1 } as Caller, action: 'watchdog.stop', args: { plugin: 'mcp-http-handler' }, deadline: Date.now() + 1000 }
    await expect(made.pluginsManager.serve(call)).rejects.toEqual({ code: 'not-found' })
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('ready')
  })
})

describe('a utility half whose bind failed', () => {
  const bindFailed = (reason: string, caller: Caller = utilityCaller()) =>
    ({ callId: 'c', caller, action: 'core.bindFailed', args: { reason }, deadline: Date.now() + 1000 })
  // A folder plugin would need an entry, so an install host plugin requires http here
  const withDependent = () => ({ ...install(), net: host('net', { requires: ['mcp-http-handler'] }) })

  it.each(['port-taken', 'bind-failed'])('reads failed with %s, not crashed, its process ended and its dependents waiting', async reason => {
    const made = await harness({ install: install() })
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
    const made = await harness({ install: withDependent() })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'net')).toBe('ready')
    await made.pluginsManager.serve(bindFailed('port-taken'))
    expect(stateOf(made.pluginsManager, 'net')).toBe('waiting')
    expect(reasonOf(made.pluginsManager, 'net')).toBe('dependency:mcp-http-handler:failed')
  })

  it('starts again on core.restart from the trusted window, a new incarnation from the same bytes', async () => {
    const made = await harness({ install: install() })
    await made.pluginsManager.start()
    await made.pluginsManager.serve(bindFailed('port-taken'))
    await made.pluginsManager.serve(windowCall('core.restart', 'mcp-http-handler'))
    await until(() => stateOf(made.pluginsManager, 'mcp-http-handler') === 'ready')
    expect(made.runtime.started.filter(start => start.id === 'mcp-http-handler').map(start => start.incarnation)).toEqual([1, 2])
    expect(made.runtime.half('mcp-http-handler', 2, 'utility').got('init')[0]).toMatchObject({ lastStop: 'port-taken' })
  })

  it('ends nothing for a caller whose incarnation is over or that is not a utility half', async () => {
    const made = await harness({ install: install() })
    await made.pluginsManager.start()
    await expect(made.pluginsManager.serve(bindFailed('port-taken', utilityCaller(2)))).rejects.toEqual({ code: 'not-found' })
    const storage: Caller = { kind: 'plugin', id: 'storage', half: 'host', incarnation: 1 }
    await expect(made.pluginsManager.serve(bindFailed('port-taken', storage))).rejects.toEqual({ code: 'not-granted' })
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('ready')
    expect(stateOf(made.pluginsManager, 'storage')).toBe('ready')
    expect(made.runtime.killed).toEqual([])
  })
})

describe('limits the human sets', () => {
  // The runtime hears each change once it landed and reads the values as the carrier holds them at that moment
  async function listening() {
    const heard: [string, number][] = []
    const holder: { made: Awaited<ReturnType<typeof harness>> | null } = { made: null }
    holder.made = await harness({
      install: install(),
      pluginsManager: { limited: plugin => void heard.push([plugin, holder.made!.carrier.limit(plugin, 'messagesPerSecond')]) },
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
    expect(heard.map(([plugin]) => plugin).sort()).toEqual(['gate', 'mcp-http-handler', 'storage'])
    expect(heard.find(([plugin]) => plugin === 'mcp-http-handler')).toEqual(['mcp-http-handler', 30])
  })

  it('apply even when the runtime throws as it hears one', async () => {
    const made = await harness({ install: install(), pluginsManager: { limited: () => { throw new Error('no child') } } })
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'limit.set', constant: 'messagesPerSecond', value: 20, plugin: 'mcp-http-handler' })
    expect(made.carrier.limit('mcp-http-handler', 'messagesPerSecond')).toBe(20)
  })
})
