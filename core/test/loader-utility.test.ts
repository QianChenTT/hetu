import { rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Caller } from '../api/envelope.ts'
import { StateStore } from '../backend/boot/state.ts'
import { folders } from '../backend/loader/folders.ts'
import {
  cleanup, coreInstall, entryFor, filesFor, harness, hostManifest, manifest, reasonOf, stateOf, tick, until, workerManifest, type Listing,
} from './loader-fakes.ts'

afterEach(cleanup)

const host = (id: string, extra: object = {}): Listing => ({ files: filesFor(hostManifest(id, extra)) })
const exists = (file: string) => stat(file).then(() => true, () => false)
const utilityCaller = (incarnation = 1): Caller => ({ kind: 'plugin', id: 'http', half: 'host', incarnation })
const windowCall = (action: string, plugin: string, role: 'editor' | 'trusted' = 'trusted') =>
  ({ callId: 'c', caller: { kind: 'window', role, n: 1 } as Caller, action, args: { plugin }, deadline: Date.now() + 1000 })

// The core's host tier, storage beside it as a host plugin and http, whose host entry runs in a utility process
const install = (http: Listing = host('http', { requires: ['storage'] })) => ({ ...coreInstall(), storage: host('storage'), http })

describe('a utility half', () => {
  it('starts from the host entry\'s verified bytes on a port registered under its host half, never imported in main', async () => {
    const made = await harness({ install: install() })
    await made.loader.start()
    expect(stateOf(made.loader, 'http')).toBe('ready')
    expect(made.loader.plugin('http')?.place).toBe('utility')
    expect(made.loader.list().find(row => row.id === 'http')?.place).toBe('utility')
    expect(made.runtime.started.filter(start => start.id === 'http')).toEqual([
      { id: 'http', incarnation: 1, half: 'utility', code: '// http host.js 1.0.0\n' },
    ])
    expect(made.link.registered).toContainEqual(utilityCaller())
    // Main counts the bytes on its port, since no relay page sits in front of it. A worker's it leaves to the relay
    expect(made.runtime.channels).toEqual([{ id: 'http', counted: true }])
    // Every host plugin starts before it, as a sandboxed plugin's does
    expect(made.runtime.order()).toEqual(['gate', 'storage', 'http'])
  })

  it('is never told the data folder, which an install host half in main is', async () => {
    const made = await harness({ install: install() })
    await made.loader.start()
    const [init] = made.runtime.half('http', 1, 'utility').got('init')
    expect(init).toMatchObject({ kind: 'init', id: 'http', incarnation: 1 })
    expect(Object.hasOwn(init, 'dataDir')).toBe(false)
    expect(JSON.stringify(made.link.sentTo('http', 'init'))).not.toContain(made.dataDir)
    expect(made.runtime.half('storage', 1, 'host').got('init')[0].dataDir).toBe(made.dataDir)
  })

  it('writes no start marker, since it can\'t freeze main', async () => {
    const made = await harness({ install: install(), behave: { http: { ready: false }, storage: { ready: false } } })
    const starting = made.loader.start()
    await until(() => made.runtime.started.some(start => start.id === 'storage'))
    // A host half's marker is down while it starts
    expect(await exists(folders.marker(made.dataDir, 'storage'))).toBe(true)
    made.runtime.half('storage', 1, 'host').ready()
    await until(() => made.runtime.started.some(start => start.id === 'http'))
    await tick(30)
    expect(stateOf(made.loader, 'http')).toBe('starting')
    expect(await exists(folders.marker(made.dataDir, 'http'))).toBe(false)
    made.runtime.half('http', 1, 'utility').ready()
    await starting
    expect(stateOf(made.loader, 'http')).toBe('ready')
  })

  it('is refused with place when its manifest names no host entry, so it never runs as a worker instead', async () => {
    const made = await harness({ install: install({ files: filesFor(manifest('http', { entries: { worker: 'worker.js' } })) }) })
    await made.loader.start()
    expect(stateOf(made.loader, 'http')).toBe('refused')
    expect(reasonOf(made.loader, 'http')).toBe('place')
    expect(made.runtime.started.filter(start => start.id === 'http')).toEqual([])
  })

  it('is killed and reads crashed when it isn\'t ready by its deadline', async () => {
    const made = await harness({ install: install(), behave: { http: { ready: false } }, limits: { readyMs: 60 } })
    await made.loader.start()
    await until(() => stateOf(made.loader, 'http') === 'crashed')
    expect(reasonOf(made.loader, 'http')).toBe('start-timeout')
    expect(made.runtime.killed).toEqual([{ id: 'http', incarnation: 1 }])
  })

  it('reads crashed with start-failed when the fork throws', async () => {
    const made = await harness({ install: install(), behave: { http: { throws: true } } })
    await made.loader.start()
    await until(() => stateOf(made.loader, 'http') === 'crashed')
    expect(reasonOf(made.loader, 'http')).toBe('start-failed')
  })
})

describe('the heartbeat of a utility half', () => {
  it('pings it and kills it after heartbeatMisses unanswered, crashed with unresponsive, its dependents waiting', async () => {
    const made = await harness({
      install: { ...install(), net: host('net', { requires: ['http'] }) },
      limits: { heartbeatMs: 15, heartbeatMisses: 3 },
    })
    await made.loader.start()
    await until(() => stateOf(made.loader, 'net') === 'ready')
    made.runtime.behave.http = { pong: false }
    await until(() => stateOf(made.loader, 'http') === 'crashed')
    expect(reasonOf(made.loader, 'http')).toBe('unresponsive')
    expect(made.runtime.killed).toEqual([{ id: 'http', incarnation: 1 }])
    expect(made.link.ended).toContainEqual({ caller: utilityCaller(), code: 'crashed' })
    expect(made.link.events('plugin.crashed')).toEqual([{ plugin: 'http', incarnation: 1, reason: 'unresponsive' }])
    expect(stateOf(made.loader, 'net')).toBe('waiting')
  })

  // Everything main hears from it counts as alive, noted before its rate. Held far over the rate its pongs are dropped
  // and it still lives while it sends, then dies once silent
  it('keeps one over its rate whose pongs are dropped while main hears anything from it and kills it once it is silent', async () => {
    const made = await harness({
      install: install(),
      limits: { heartbeatMs: 40, heartbeatMisses: 2 },
      switches: { limits: { all: {}, plugins: { http: { messagesPerSecond: 5, floodFactor: 1000 } } } },
    })
    await made.loader.start()
    const half = made.runtime.half('http', 1, 'utility')
    const end = Date.now() + 500
    let sent = 0
    while (Date.now() < end) {
      half.send({ v: 1, kind: 'busy', n: sent++ })
      await tick(2)
    }
    expect(stateOf(made.loader, 'http')).toBe('ready')
    expect(made.runtime.killed).toEqual([])
    expect(made.link.sentTo('http', 'ping').length).toBeGreaterThanOrEqual(5)
    made.runtime.behave.http = { pong: false }
    await until(() => stateOf(made.loader, 'http') === 'crashed')
    expect(reasonOf(made.loader, 'http')).toBe('unresponsive')
  })

  it('ends one past its flood cap as flood, though main heard it', async () => {
    const made = await harness({
      install: install(),
      limits: { heartbeatMs: 40, heartbeatMisses: 2 },
      switches: { limits: { all: {}, plugins: { http: { messagesPerSecond: 5, floodFactor: 2, floodMs: 1000 } } } },
    })
    await made.loader.start()
    const half = made.runtime.half('http', 1, 'utility')
    for (let i = 0; i < 20; i++) half.send({ v: 1, kind: 'busy', n: i })
    await until(() => stateOf(made.loader, 'http') === 'crashed')
    expect(reasonOf(made.loader, 'http')).toBe('flood')
    expect(made.runtime.killed).toEqual([{ id: 'http', incarnation: 1 }])
  })

  it('keeps one that answers ready and running', async () => {
    const made = await harness({ install: install(), limits: { heartbeatMs: 10, heartbeatMisses: 2 } })
    await made.loader.start()
    await until(() => made.link.sentTo('http', 'ping').length >= 5)
    expect(stateOf(made.loader, 'http')).toBe('ready')
    expect(made.runtime.killed).toEqual([])
  })
})

describe('a utility process that ends', () => {
  it('reads crashed when it exits by itself while ready, whatever its exit, with exited', async () => {
    const made = await harness({ install: install() })
    await made.loader.start()
    made.runtime.exit('http', 1, false)
    await until(() => stateOf(made.loader, 'http') === 'crashed')
    expect(reasonOf(made.loader, 'http')).toBe('exited')
    expect(made.link.events('plugin.crashed')).toEqual([{ plugin: 'http', incarnation: 1, reason: 'exited' }])
  })

  it('reads the runtime\'s own kill as killed, never as a clean exit', async () => {
    const made = await harness({ install: install() })
    await made.loader.start()
    made.runtime.exit('http', 1, true)
    await until(() => stateOf(made.loader, 'http') === 'crashed')
    expect(reasonOf(made.loader, 'http')).toBe('killed')
  })

  it('reads its port closing as a crash, as a worker\'s', async () => {
    const made = await harness({ install: install() })
    await made.loader.start()
    made.runtime.half('http', 1, 'utility').crash()
    await until(() => stateOf(made.loader, 'http') === 'crashed')
    expect(reasonOf(made.loader, 'http')).toBe('closed')
  })

  it('changes nothing when an incarnation that is over exits late', async () => {
    const made = await harness({ install: install() })
    await made.loader.start()
    await made.loader.serve(windowCall('core.restart', 'http'))
    await until(() => made.loader.plugin('http')?.incarnation === 2 && stateOf(made.loader, 'http') === 'ready')
    made.runtime.exit('http', 1, false)
    await tick(20)
    expect(stateOf(made.loader, 'http')).toBe('ready')
  })
})

describe('stops and restarts of a utility half', () => {
  it('stops on core.stop from the trusted window: stop down its way, the way ended, then the process killed', async () => {
    const made = await harness({ install: install() })
    await made.loader.start()
    await made.loader.serve(windowCall('core.stop', 'http'))
    expect(stateOf(made.loader, 'http')).toBe('stopped')
    expect(made.link.sentTo('http', 'stop')).toHaveLength(1)
    expect(made.link.ended).toContainEqual({ caller: utilityCaller(), code: 'stopped' })
    expect(made.runtime.killed).toEqual([{ id: 'http', incarnation: 1 }])
  })

  it('is killed once the stop grace ran out when it never answers stopped', async () => {
    const made = await harness({ install: install(), behave: { http: { stopped: false } } })
    await made.loader.start()
    await made.loader.serve(windowCall('core.stop', 'http'))
    expect(stateOf(made.loader, 'http')).toBe('stopped')
    expect(made.runtime.killed).toEqual([{ id: 'http', incarnation: 1 }])
  })

  it('restarts in the same run on core.restart as a new incarnation from the same bytes, unlike a host half', async () => {
    const made = await harness({ install: install() })
    await made.loader.start()
    made.runtime.exit('http', 1, false)
    await until(() => stateOf(made.loader, 'http') === 'crashed')
    await made.loader.serve(windowCall('core.restart', 'http'))
    await until(() => stateOf(made.loader, 'http') === 'ready')
    const starts = made.runtime.started.filter(start => start.id === 'http')
    expect(starts.map(start => start.incarnation)).toEqual([1, 2])
    expect(starts[1].code).toBe(starts[0].code)
    expect(made.link.registered).toContainEqual(utilityCaller(2))
    await expect(made.loader.serve(windowCall('core.restart', 'storage', 'editor'))).rejects.toEqual({ code: 'not-granted' })
  })

  // The door is the human's to restart: a restart cuts every agent call in flight and brings back a door the core ended
  it('is restarted from the trusted window alone, never from the editor window, running or failed', async () => {
    const made = await harness({ install: install() })
    await made.loader.start()
    await expect(made.loader.serve(windowCall('core.restart', 'http', 'editor'))).rejects.toEqual({ code: 'not-granted' })
    expect(made.runtime.killed).toEqual([])
    expect(made.loader.plugin('http')).toMatchObject({ state: 'ready', incarnation: 1 })
    await made.loader.serve({ callId: 'c', caller: utilityCaller(), action: 'core.bindFailed', args: { reason: 'port-taken' }, deadline: Date.now() + 1000 })
    await expect(made.loader.serve(windowCall('core.restart', 'http', 'editor'))).rejects.toEqual({ code: 'not-granted' })
    expect(stateOf(made.loader, 'http')).toBe('failed')
    await made.loader.serve(windowCall('core.restart', 'http'))
    await until(() => stateOf(made.loader, 'http') === 'ready')
    expect(made.runtime.started.filter(start => start.id === 'http').map(start => start.incarnation)).toEqual([1, 2])
  })

  it('is out of the watchdog\'s reach, which acts on sandboxed plugins only', async () => {
    const made = await harness({ install: install() })
    await made.loader.start()
    const call = { callId: 'c', caller: { kind: 'plugin', id: 'watchdog', half: 'host', incarnation: 1 } as Caller, action: 'watchdog.stop', args: { plugin: 'http' }, deadline: Date.now() + 1000 }
    await expect(made.loader.serve(call)).rejects.toEqual({ code: 'not-found' })
    expect(stateOf(made.loader, 'http')).toBe('ready')
  })
})

describe('a utility half whose bind failed', () => {
  const bindFailed = (reason: string, caller: Caller = utilityCaller()) =>
    ({ callId: 'c', caller, action: 'core.bindFailed', args: { reason }, deadline: Date.now() + 1000 })
  // A folder plugin would need an entry, so an install host plugin requires http here
  const withDependent = () => ({ ...install(), net: host('net', { requires: ['http'] }) })

  it.each(['port-taken', 'bind-failed'])('reads failed with %s, not crashed, its process ended and its dependents waiting', async reason => {
    const made = await harness({ install: install() })
    await made.loader.start()
    await made.loader.serve(bindFailed(reason))
    expect(stateOf(made.loader, 'http')).toBe('failed')
    expect(reasonOf(made.loader, 'http')).toBe(reason)
    expect(made.loader.list().find(row => row.id === 'http')).toMatchObject({ place: 'utility', state: 'failed', reason })
    expect(made.link.events('plugin.failed')).toEqual([{ plugin: 'http', incarnation: 1, reason }])
    expect(made.link.events('plugin.crashed')).toEqual([])
    expect(made.link.ended).toContainEqual({ caller: utilityCaller(), code: 'crashed' })
    expect(made.runtime.killed).toEqual([{ id: 'http', incarnation: 1 }])
  })

  it('moves a plugin that requires it to waiting, naming it failed', async () => {
    const made = await harness({ install: withDependent() })
    await made.loader.start()
    expect(stateOf(made.loader, 'net')).toBe('ready')
    await made.loader.serve(bindFailed('port-taken'))
    expect(stateOf(made.loader, 'net')).toBe('waiting')
    expect(reasonOf(made.loader, 'net')).toBe('dependency:http:failed')
  })

  it('starts again on core.restart from the trusted window, a new incarnation from the same bytes', async () => {
    const made = await harness({ install: install() })
    await made.loader.start()
    await made.loader.serve(bindFailed('port-taken'))
    await made.loader.serve(windowCall('core.restart', 'http'))
    await until(() => stateOf(made.loader, 'http') === 'ready')
    expect(made.runtime.started.filter(start => start.id === 'http').map(start => start.incarnation)).toEqual([1, 2])
    expect(made.runtime.half('http', 2, 'utility').got('init')[0]).toMatchObject({ lastStop: 'port-taken' })
  })

  it('ends nothing for a caller whose incarnation is over or that is not a utility half', async () => {
    const made = await harness({ install: install() })
    await made.loader.start()
    await expect(made.loader.serve(bindFailed('port-taken', utilityCaller(2)))).rejects.toEqual({ code: 'not-found' })
    const storage: Caller = { kind: 'plugin', id: 'storage', half: 'host', incarnation: 1 }
    await expect(made.loader.serve(bindFailed('port-taken', storage))).rejects.toEqual({ code: 'not-granted' })
    expect(stateOf(made.loader, 'http')).toBe('ready')
    expect(stateOf(made.loader, 'storage')).toBe('ready')
    expect(made.runtime.killed).toEqual([])
  })
})

// The door's port is a per-machine switch the human moves with a Confirm. http hears it in its init, read as 4747 while
// none is set
describe("the door's port", () => {
  const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
  const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
  const portOf = (made: Awaited<ReturnType<typeof harness>>, incarnation: number) =>
    (made.runtime.half('http', incarnation, 'utility').got('init')[0] as { port?: unknown }).port
  const held = (answer: { applied: true } | { held: string }) => {
    if (!('held' in answer)) throw new Error('applied, not held')
    return answer.held
  }
  const switchesFile = (dataDir: string) => path.join(dataDir, 'state', 'switches.json')

  it('reaches http in its init as 4747 while the switches name none, and no other half', async () => {
    const made = await harness({
      install: install(), folder: { alpha: filesFor(workerManifest('alpha')) }, entries: { alpha: root => entryFor(root) },
    })
    await made.loader.start()
    expect(portOf(made, 1)).toBe(4747)
    expect(Object.hasOwn(made.runtime.half('storage', 1, 'host').got('init')[0], 'port')).toBe(false)
    expect(stateOf(made.loader, 'alpha')).toBe('ready')
    expect(Object.hasOwn(made.runtime.half('alpha', 1, 'worker').got('init')[0], 'port')).toBe(false)
  })

  it('reaches http as the switches hold it', async () => {
    const made = await harness({ install: install(), switches: { port: 5123 } })
    await made.loader.start()
    expect(portOf(made, 1)).toBe(5123)
  })

  it.each([
    ['failed its check', (file: string) => writeFile(file, '{"format":2,"port":5123}\n0000\n')],
    ['is missing', (file: string) => rm(file)],
  ])('reads 4747 when the switches file %s', async (_name, spoil) => {
    const made = await harness({ install: install(), switches: { port: 5123 }, before: ({ dataDir }) => spoil(switchesFile(dataDir)) })
    await made.loader.start()
    expect(portOf(made, 1)).toBe(4747)
  })

  it("moves on the trusted window's Confirm: written, then http started again on the new port", async () => {
    const made = await harness({ install: install() })
    await made.loader.start()
    const id = held(await made.loader.request({ kind: 'port.set', port: 5123 }, trusted))
    expect((await new StateStore(made.dataDir).load()).state.switches.port).toBe(undefined)
    expect(made.runtime.started.filter(start => start.id === 'http')).toHaveLength(1)
    await made.loader.confirm(id, {})
    expect((await new StateStore(made.dataDir).load()).state.switches.port).toBe(5123)
    await until(() => stateOf(made.loader, 'http') === 'ready' && made.loader.plugin('http')?.incarnation === 2)
    expect(portOf(made, 2)).toBe(5123)
    expect(made.runtime.killed).toContainEqual({ id: 'http', incarnation: 1 })
    expect(made.link.events('security.applied')).toMatchObject([{ kind: 'port.set', window: 'trusted' }])
  })

  // Only the trusted window's Confirm moves the door, Confirm off included, which covers that window's own changes alone
  it('waits for the Confirm when the editor window asks, Confirm off or not', async () => {
    const made = await harness({ install: install(), switches: { confirmOff: true } })
    await made.loader.start()
    held(await made.loader.request({ kind: 'port.set', port: 5123 }, editor))
    await tick(30)
    expect((await new StateStore(made.dataDir).load()).state.switches.port).toBe(undefined)
    expect(made.runtime.started.filter(start => start.id === 'http')).toHaveLength(1)
  })

  it('takes 4747 back by leaving the port out of the file', async () => {
    const made = await harness({ install: install(), switches: { port: 5123 } })
    await made.loader.start()
    await made.loader.confirm(held(await made.loader.request({ kind: 'port.set', port: 4747 }, trusted)), {})
    expect(Object.hasOwn((await new StateStore(made.dataDir).load()).state.switches, 'port')).toBe(false)
    await until(() => made.loader.plugin('http')?.incarnation === 2)
    expect(portOf(made, 2)).toBe(4747)
  })

  it('starts a failed http again on the new port, the way out of a port another program holds', async () => {
    const made = await harness({ install: install() })
    await made.loader.start()
    await made.loader.serve({ callId: 'c', caller: utilityCaller(), action: 'core.bindFailed', args: { reason: 'port-taken' }, deadline: Date.now() + 1000 })
    expect(stateOf(made.loader, 'http')).toBe('failed')
    await made.loader.confirm(held(await made.loader.request({ kind: 'port.set', port: 5123 }, trusted)), {})
    await until(() => stateOf(made.loader, 'http') === 'ready')
    expect(portOf(made, 2)).toBe(5123)
  })

  it('leaves an http the human stopped stopped, the new port read at its next start', async () => {
    const made = await harness({ install: install() })
    await made.loader.start()
    await made.loader.serve(windowCall('core.stop', 'http'))
    await made.loader.confirm(held(await made.loader.request({ kind: 'port.set', port: 5123 }, trusted)), {})
    await tick(30)
    expect(stateOf(made.loader, 'http')).toBe('stopped')
    expect(made.runtime.started.filter(start => start.id === 'http')).toHaveLength(1)
    await made.loader.serve(windowCall('core.restart', 'http'))
    await until(() => stateOf(made.loader, 'http') === 'ready')
    expect(portOf(made, 2)).toBe(5123)
  })
})

describe('limits the human sets', () => {
  // The runtime hears each change once it landed and reads the values as the carrier holds them at that moment
  async function listening() {
    const heard: [string, number][] = []
    const holder: { made: Awaited<ReturnType<typeof harness>> | null } = { made: null }
    holder.made = await harness({
      install: install(),
      loader: { limited: plugin => void heard.push([plugin, holder.made!.carrier.limit(plugin, 'messagesPerSecond')]) },
    })
    await holder.made.loader.start()
    return { made: holder.made, heard }
  }

  it('reach the runtime for the plugin named once the new value is written, a raise as well as a lowering', async () => {
    const { made, heard } = await listening()
    await made.loader.apply({ kind: 'limit.set', constant: 'messagesPerSecond', value: 20, plugin: 'http' })
    expect(heard).toEqual([['http', 20]])
    await made.loader.apply({ kind: 'limit.set', constant: 'messagesPerSecond', value: 300, plugin: 'http' })
    expect(heard).toEqual([['http', 20], ['http', 300]])
  })

  it('reach the runtime for every plugin when set for all', async () => {
    const { made, heard } = await listening()
    await made.loader.apply({ kind: 'limit.set', constant: 'messagesPerSecond', value: 30, plugin: null })
    expect(heard.map(([plugin]) => plugin).sort()).toEqual(['gate', 'http', 'storage'])
    expect(heard.find(([plugin]) => plugin === 'http')).toEqual(['http', 30])
  })

  it('apply even when the runtime throws as it hears one', async () => {
    const made = await harness({ install: install(), loader: { limited: () => { throw new Error('no child') } } })
    await made.loader.start()
    await made.loader.apply({ kind: 'limit.set', constant: 'messagesPerSecond', value: 20, plugin: 'http' })
    expect(made.carrier.limit('http', 'messagesPerSecond')).toBe(20)
  })
})
