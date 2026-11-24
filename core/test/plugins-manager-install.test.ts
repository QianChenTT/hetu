import { writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginsManager } from '../backend/plugins-manager/plugins-manager.ts'
import {
  allowAll, cleanup, DOOR_CODE, entryFor, fakeLuoshu, filesFor, harness, reasonOf, stateOf, tempBase, workerManifest,
} from './plugins-manager-fakes.ts'

afterEach(cleanup)

// The door, whose host entry runs in a utility process
const HTTP = 'mcp-http-handler'
const signed = (extra = {}) => (root: string) => entryFor(root, extra)

describe('the start order', () => {
  it('starts the core modules before any plugin, then the door, then folder plugins in graph order', async () => {
    const luoshu = fakeLuoshu()
    const made = await harness({
      door: DOOR_CODE,
      folder: {
        outline: filesFor(workerManifest('outline', { requires: ['luoshu'] })),
        indexer: filesFor(workerManifest('indexer', { requires: ['outline'] })),
        'notes-tool': filesFor(workerManifest('notes-tool')),
      },
      entries: { outline: signed(), indexer: signed(), 'notes-tool': signed() },
      modules: { luoshu },
    })
    const { pluginsManager, runtime } = made
    // What served when each plugin started
    const serving: boolean[] = []
    const startWorker = runtime.startWorker.bind(runtime)
    const startUtility = runtime.startUtility.bind(runtime)
    const served = () => serving.push(made.modules.gate() !== null && made.modules.provider('luoshu') !== null && luoshu.opened.length === 1)
    runtime.startWorker = start => { served(); startWorker(start) }
    runtime.startUtility = start => { served(); startUtility(start) }
    await pluginsManager.start()
    expect(runtime.order()).toEqual([HTTP, 'notes-tool', 'outline', 'indexer'])
    expect(serving).toEqual([true, true, true, true])
    for (const id of [HTTP, 'outline', 'indexer']) expect(stateOf(pluginsManager, id)).toBe('ready')
  })

  it('mints each port and registers it with the router in the same step, before the half starts', async () => {
    const seen: string[] = []
    const made = await harness({
      door: DOOR_CODE,
      folder: { outline: filesFor(workerManifest('outline')) },
      entries: { outline: signed() },
    })
    const { link, runtime, pluginsManager } = made
    const register = link.register.bind(link)
    const startWorker = runtime.startWorker.bind(runtime)
    const startUtility = runtime.startUtility.bind(runtime)
    link.register = (port, caller, via) => { seen.push(`register ${JSON.stringify(caller)}`); register(port, caller, via) }
    runtime.startWorker = start => { seen.push(`start ${start.id} ${start.incarnation}`); startWorker(start) }
    runtime.startUtility = start => { seen.push(`start ${start.id} ${start.incarnation}`); startUtility(start) }
    await pluginsManager.start()
    expect(seen).toEqual([
      'register {"kind":"plugin","id":"mcp-http-handler","half":"host","incarnation":1}', 'start mcp-http-handler 1',
      'register {"kind":"plugin","id":"outline","half":"worker","incarnation":1}', 'start outline 1',
    ])
  })

  it('sends init with the id, the API version, its dependencies, lastStop and previousVersion', async () => {
    const { pluginsManager, runtime } = await harness({
      folder: { outline: filesFor(workerManifest('outline', { requires: ['luoshu'] })) },
      entries: { outline: signed({ granted: [{ type: 'plugin.call', targets: ['git'] }] }) },
    })
    await pluginsManager.start()
    expect(runtime.half('outline').got('init')).toEqual([{
      v: 1, kind: 'init', id: 'outline', incarnation: 1, api: 6, deps: { git: 'unavailable', luoshu: 'ready' },
      lastStop: null, previousVersion: null,
    }])
  })

  it('hands the data folder to no plugin, the door\'s utility half included', async () => {
    const { pluginsManager, runtime } = await harness({
      door: DOOR_CODE,
      folder: { outline: filesFor(workerManifest('outline')) },
      entries: { outline: signed() },
    })
    await pluginsManager.start()
    expect(runtime.half(HTTP, 1, 'utility').got('init')[0]).not.toHaveProperty('dataDir')
    expect(runtime.half('outline').got('init')[0]).not.toHaveProperty('dataDir')
  })

  it('gives the worker host page the bytes it hashed, not what the file holds later', async () => {
    const { pluginsManager, runtime, dataDir } = await harness({
      folder: { outline: filesFor(workerManifest('outline')) },
      entries: { outline: signed() },
    })
    const file = path.join(dataDir, 'plugins', 'outline', 'worker.js')
    const original = await readFile(file, 'utf8')
    // The channel is minted after the read and right before the worker starts, which is where a swap would land
    const channel = runtime.channel.bind(runtime)
    runtime.channel = () => {
      writeFileSync(file, 'swapped()')
      return channel()
    }
    await pluginsManager.start()
    expect(await readFile(file, 'utf8')).toBe('swapped()')
    const started = runtime.started.find(start => start.id === 'outline')
    expect(started?.code).toBe(original)
    expect(stateOf(pluginsManager, 'outline')).toBe('ready')
  })
})

describe('the marker of core plugin versions an older build kept', () => {
  // installed.json held each core plugin's version and hash. Nothing reads it now, so the first start takes it away
  it('goes at the first start and a start without it runs as before', async () => {
    let marker = ''
    const made = await harness({
      door: DOOR_CODE,
      before: async ({ dataDir }) => {
        marker = path.join(dataDir, 'installed.json')
        writeFileSync(marker, '{"format":1,"plugins":{}}\n')
      },
    })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'mcp-http-handler')).toBe('ready')
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    const again = await harness({ base: made.base, door: DOOR_CODE })
    await again.pluginsManager.start()
    expect(stateOf(again.pluginsManager, 'mcp-http-handler')).toBe('ready')
  })
})

describe('the door and policy jobs', () => {
  it('reads a guard role absent, which nothing holds, with the gate and the grant risk classifier from their modules', async () => {
    const { pluginsManager } = await harness({ switches: { off: ['grant-risk-classifier'] } })
    await pluginsManager.start()
    expect(pluginsManager.policyJob('leases')).toBe('absent')
    expect(pluginsManager.policyJob('grant-risk-classifier')).toBe('off')
    expect(pluginsManager.policyJob('gate')).toBe('on')
  })

  it('switched off by the human, reads off and starts nothing, even when its check failed too', async () => {
    const { pluginsManager, runtime, link } = await harness({
      pluginsManager: { doorFile: path.join(await tempBase(), 'nowhere', 'door.js') },
      switches: { off: [HTTP] },
    })
    await pluginsManager.start()
    expect(stateOf(pluginsManager, HTTP)).toBe('off')
    expect(runtime.order()).toEqual([])
    // The failed check is still recorded, it never reads as the switch-off
    expect(link.events('plugin.checked')).toContainEqual({ plugin: HTTP, from: 'core', result: 'missing' })
  })

  it('refuses a plugin that requires a policy job holder', async () => {
    const { pluginsManager } = await harness({
      folder: { outline: filesFor(workerManifest('outline', { requires: ['gate'] })) },
      entries: { outline: signed() },
    })
    await pluginsManager.start()
    expect(reasonOf(pluginsManager, 'outline')).toBe('requires')
  })

  // A security control is no dependency: it judges or guards and serves nothing a plugin could wait on
  it.each(['grant-risk-classifier', 'flood-control', 'security-view'])('refuses a plugin that requires the security control %s', async control => {
    const { pluginsManager } = await harness({
      folder: { outline: filesFor(workerManifest('outline', { requires: [control] })) }, entries: { outline: signed() },
    })
    await pluginsManager.start()
    expect(reasonOf(pluginsManager, 'outline')).toBe('requires')
  })

  // The lock guards and serves lock.*, so a plugin that calls lock.set may start after it as one starts after the luoshu
  it('starts a plugin that requires the lock, a security control serving a provider namespace, once the lock serves', async () => {
    const { pluginsManager, runtime } = await harness({
      folder: { leases: filesFor(workerManifest('leases', { requires: ['lock'] })) }, entries: { leases: signed() },
    })
    await pluginsManager.start()
    expect(stateOf(pluginsManager, 'leases')).toBe('ready')
    expect(runtime.half('leases').got('init')[0]).toMatchObject({ deps: { lock: 'ready' } })
  })

  it('reads a core module\'s state as its policy job state and none for an id that is no module', async () => {
    const { pluginsManager } = await harness({ switches: { off: ['grant-risk-classifier'] } })
    await pluginsManager.start()
    expect(pluginsManager.policyJob('gate')).toBe('on')
    expect(pluginsManager.policyJob('grant-risk-classifier')).toBe('off')
    expect(pluginsManager.policyJob('outline')).toBe('absent')
    expect(Object.keys((await pluginsManager.serve({ callId: 'c', caller: { kind: 'window', role: 'editor', n: 1 }, root: { kind: 'window', role: 'editor', n: 1 }, action: 'core.status', args: undefined, deadline: Date.now() + 1000 }) as { policyJobs: object }).policyJobs))
      .toEqual(['gate', 'grant-risk-classifier'])
  })
})

describe('starting', () => {
  it('marks a sandboxed plugin crashed with start-timeout when ready doesn\'t come in time', async () => {
    const { pluginsManager, runtime, link } = await harness({
      folder: { outline: filesFor(workerManifest('outline')) },
      entries: { outline: signed() },
      behave: { outline: { ready: false } },
      limits: { readyMs: 40 },
    })
    await pluginsManager.start()
    expect(stateOf(pluginsManager, 'outline')).toBe('crashed')
    expect(reasonOf(pluginsManager, 'outline')).toBe('start-timeout')
    expect(runtime.terminated).toEqual([{ id: 'outline', incarnation: 1 }])
    expect(link.events('plugin.crashed')).toEqual([{ plugin: 'outline', incarnation: 1, reason: 'start-timeout' }])
  })

  it('crashes a worker the runtime can\'t start', async () => {
    const { pluginsManager } = await harness({
      folder: { outline: filesFor(workerManifest('outline')) },
      entries: { outline: signed() },
      behave: { outline: { throws: true } },
    })
    await pluginsManager.start()
    expect(stateOf(pluginsManager, 'outline')).toBe('crashed')
    expect(reasonOf(pluginsManager, 'outline')).toBe('start-failed')
  })

  it('hands the gate grants snapshot 1 as the core starts and stops hetu in the fail-safe when stateChanged throws', async () => {
    const gate = allowAll()
    const { pluginsManager, modules } = await harness({ modules: { gate } })
    await pluginsManager.start()
    expect(gate.views).toEqual([1])
    expect(pluginsManager.view()).toBe(1)
    expect(modules.gate()).toBe(gate)

    const broken = allowAll()
    broken.throws = true
    const other = await harness({ modules: { gate: broken } })
    await other.pluginsManager.start()
    expect(other.pluginsManager.stopped()).toEqual({ control: 'gate', why: 'start-failed', reason: 'state-changed', again: false })
    expect(other.pluginsManager.policyJob('gate')).toBe('failed')
    expect(other.modules.gate()).toBe(null)
  })
})

// PluginsManager is used for its type in the harness. Kept so a rename shows here too
export type { PluginsManager }
