import { writeFileSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTALL_LIST } from '../api/install.ts'
import { boot } from '../backend/boot/boot.ts'
import { PluginsManager } from '../backend/plugins-manager/plugins-manager.ts'
import { readInstalled, writeInstalled } from '../backend/plugins-manager/folders.ts'
import type { Landing } from '../backend/plugins-manager/seams.ts'
import {
  allowAll, cleanup, coreInstall, entryFor, filesFor, harness, hostManifest, manifest, reasonOf, stateOf, tempBase, until, workerManifest,
  type Listing,
} from './plugins-manager-fakes.ts'
import { HOLD_TIMEOUT, holdOpen, onWindows, releaseAfter, releaseAll } from './hold.ts'

afterEach(async () => {
  await releaseAll()
  await cleanup()
})

const host = (id: string, extra: object = {}): Listing => ({ files: filesFor(hostManifest(id, extra)) })
// The gate and a provider after it, for what needs a second host half
const twoHosts = (): Record<string, Listing> => ({ ...coreInstall(), storage: host('storage') })
const wrongHash = 'b'.repeat(64)
const signed = (extra = {}) => (root: string) => entryFor(root, extra)

describe('the start order', () => {
  it('starts the policy job holders, then the providers, then the guard, then sandboxed plugins in graph order', async () => {
    const { pluginsManager, runtime } = await harness({
      install: Object.fromEntries(['gate', 'grant-risk-classifier', 'watchdog', 'storage', 'luoshu', 'history', 'exec', 'leases'].map(id => [id, host(id)])),
      folder: {
        outline: filesFor(workerManifest('outline', { requires: ['luoshu'] })),
        indexer: filesFor(workerManifest('indexer', { requires: ['outline'] })),
        'notes-tool': filesFor(workerManifest('notes-tool')),
      },
      entries: { outline: signed(), indexer: signed(), 'notes-tool': signed() },
      pluginsManager: { guardsFor: () => ['leases'] },
    })
    await pluginsManager.start()
    expect(runtime.order()).toEqual([
      'gate', 'grant-risk-classifier', 'watchdog', 'storage', 'luoshu', 'history', 'exec', 'leases', 'notes-tool', 'outline', 'indexer',
    ])
    for (const id of ['gate', 'leases', 'outline', 'indexer']) expect(stateOf(pluginsManager, id)).toBe('ready')
  })

  it('starts a host half only after the one before it settled', async () => {
    const { pluginsManager, runtime, link } = await harness({ install: twoHosts(), behave: { gate: { ready: false } } })
    const starting = pluginsManager.start()
    await until(() => runtime.order().includes('gate'))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(runtime.order()).toEqual(['gate'])
    runtime.half('gate', 1, 'host').ready()
    await starting
    expect(runtime.order()).toEqual(['gate', 'storage'])
    expect(link.events('plugin.started').map(fields => fields.plugin)).toEqual(['gate', 'storage'])
  })

  it('mints each port or handle and registers it with the carrier in the same step, before the half starts', async () => {
    const seen: string[] = []
    const made = await harness({
      folder: { outline: filesFor(workerManifest('outline')) },
      entries: { outline: signed() },
    })
    const { link, runtime, pluginsManager } = made
    const register = link.register.bind(link)
    const handle = link.handle.bind(link)
    const startWorker = runtime.startWorker.bind(runtime)
    const startHost = runtime.startHost.bind(runtime)
    link.register = (port, caller) => { seen.push(`register ${JSON.stringify(caller)}`); register(port, caller) }
    link.handle = (caller, receive) => { seen.push(`handle ${JSON.stringify(caller)}`); return handle(caller, receive) }
    runtime.startWorker = start => { seen.push(`start ${start.id} ${start.incarnation}`); startWorker(start) }
    runtime.startHost = start => { seen.push(`start ${start.id} ${start.incarnation}`); return startHost(start) }
    await pluginsManager.start()
    expect(seen).toEqual([
      'handle {"kind":"plugin","id":"gate","half":"host","incarnation":1}', 'start gate 1',
      'register {"kind":"plugin","id":"outline","half":"worker","incarnation":1}', 'start outline 1',
    ])
  })

  it('sends init with the id, the API version, its dependencies, lastStop and previousVersion', async () => {
    const { pluginsManager, runtime } = await harness({
      install: { ...coreInstall(), luoshu: host('luoshu') },
      folder: { outline: filesFor(workerManifest('outline', { requires: ['luoshu'] })) },
      entries: { outline: signed({ granted: [{ type: 'plugin.call', targets: ['git'] }] }) },
    })
    await pluginsManager.start()
    expect(runtime.half('outline').got('init')).toEqual([{
      v: 1, kind: 'init', id: 'outline', incarnation: 1, api: 3, deps: { git: 'unavailable', luoshu: 'ready' },
      lastStop: null, previousVersion: null,
    }])
  })

  it('hands the data folder to a core plugin\'s host half and never to a worker', async () => {
    const { pluginsManager, runtime, dataDir } = await harness({
      install: { ...coreInstall(), storage: { files: filesFor(manifest('storage', { entries: { host: 'host.js', worker: 'worker.js' } })) } },
      folder: { outline: filesFor(workerManifest('outline')) },
      entries: { outline: signed() },
    })
    await pluginsManager.start()
    expect(runtime.half('storage', 1, 'host').got('init')[0].dataDir).toBe(dataDir)
    expect(runtime.half('gate', 1, 'host').got('init')[0].dataDir).toBe(dataDir)
    expect(runtime.half('storage', 1, 'worker').got('init')[0]).not.toHaveProperty('dataDir')
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

describe('core plugins', () => {
  it('refuses one whose bytes fail the install list, which reads tampered, and starts the rest', async () => {
    const { pluginsManager, runtime, link } = await harness({ install: { ...twoHosts(), storage: { ...host('storage'), hash: wrongHash } } })
    await pluginsManager.start()
    expect(stateOf(pluginsManager, 'storage')).toBe('refused')
    expect(reasonOf(pluginsManager, 'storage')).toBe('tampered')
    expect(runtime.order()).toEqual(['gate'])
    expect(link.events('plugin.checked')).toContainEqual({ plugin: 'storage', from: 'install', result: 'tampered' })
    expect(link.events('plugin.checked')).toContainEqual({ plugin: 'gate', from: 'install', result: 'ok' })
  })

  // A tampered security plugin always stops hetu from starting
  it('stops hetu when the tampered one is a security control, before the rest start', async () => {
    const { pluginsManager, runtime } = await harness({ install: { ...twoHosts(), gate: { ...host('gate'), hash: wrongHash } } })
    await pluginsManager.start()
    expect(pluginsManager.policyJob('gate')).toBe('tampered')
    expect(reasonOf(pluginsManager, 'gate')).toBe('tampered')
    expect(pluginsManager.stopped()).toMatchObject({ control: 'gate', why: 'tampered' })
    expect(runtime.order()).toEqual([])
  })

  it('reads a policy job absent when the install holds no plugin for it', async () => {
    const { pluginsManager } = await harness()
    await pluginsManager.start()
    expect(pluginsManager.policyJob('watchdog')).toBe('absent')
    expect(pluginsManager.policyJob('grant-risk-classifier')).toBe('absent')
    expect(pluginsManager.policyJob('gate')).toBe('on')
  })

  it('reads every policy job starting before the install is read, absent with no list and tampered with a bad one', async () => {
    const before = await harness()
    expect(before.pluginsManager.policyJob('gate')).toBe('starting')
    const none = await harness({ install: null })
    await none.pluginsManager.start()
    expect(none.pluginsManager.policyJob('gate')).toBe('absent')
    expect(none.link.events('install.checked')).toEqual([{ result: 'absent' }])
    const bad = await harness()
    await writeFile(path.join(bad.installDir, INSTALL_LIST), '{"format":1,"plugins":{},"plugins":{}}')
    await bad.pluginsManager.start()
    expect(bad.pluginsManager.policyJob('gate')).toBe('tampered')
    expect(bad.runtime.order()).toEqual([])
  })

  // A packaged build keeps the list inside app.asar and the plugins beside it, so a list planted beside the plugins is
  // never the one read
  it('reads the list from its own folder when it has one, never from the plugins\' folder', async () => {
    const base = path.join(await tempBase(), 'list')
    await mkdir(base, { recursive: true })
    const made = await harness({ pluginsManager: { listDir: base } })
    await made.pluginsManager.start()
    expect(made.link.events('install.checked')).toEqual([{ result: 'absent' }])
    expect(made.pluginsManager.policyJob('gate')).toBe('absent')
    const moved = path.join(await tempBase(), 'list')
    await mkdir(moved, { recursive: true })
    const listed = await harness({ before: async ({ installDir }) => {
      await writeFile(path.join(moved, INSTALL_LIST), await readFile(path.join(installDir, INSTALL_LIST)))
      await writeFile(path.join(installDir, INSTALL_LIST), '{"format":1,"plugins":{}}')
    }, pluginsManager: { listDir: moved } })
    await listed.pluginsManager.start()
    expect(listed.link.events('install.checked')).toEqual([{ result: 'ok' }])
    expect(listed.pluginsManager.policyJob('gate')).toBe('on')
  })

  it('switched off by the human, reads off and starts nothing, even when its check failed too', async () => {
    const { pluginsManager, runtime, link } = await harness({
      install: { ...twoHosts(), gate: { ...host('gate'), hash: wrongHash } },
      switches: { off: ['gate'] },
    })
    await pluginsManager.start()
    expect(pluginsManager.policyJob('gate')).toBe('off')
    expect(stateOf(pluginsManager, 'gate')).toBe('off')
    expect(runtime.order()).toEqual(['storage'])
    // The failed check is still recorded, it never reads as the switch-off
    expect(link.events('plugin.checked')).toContainEqual({ plugin: 'gate', from: 'install', result: 'tampered' })
  })

  it('in dev mode loads its bytes unhashed from the install and nothing more', async () => {
    const { pluginsManager, runtime, link } = await harness({
      install: { ...coreInstall(), gate: { ...host('gate'), hash: wrongHash }, luoshu: { ...host('luoshu'), hash: wrongHash } },
      switches: { devMode: ['gate'] },
    })
    await pluginsManager.start()
    expect(pluginsManager.policyJob('gate')).toBe('on')
    expect(link.events('plugin.checked')).toContainEqual({ plugin: 'gate', from: 'install', result: 'dev' })
    // The code still came from the install. Another plugin's failed check still holds
    expect(runtime.started.find(start => start.id === 'gate')?.half).toBe('host')
    expect(reasonOf(pluginsManager, 'luoshu')).toBe('tampered')
  })

  it('with skipVerification loads mismatched bytes and still refuses an unsigned plugin and a broken manifest', async () => {
    const { pluginsManager, link } = await harness({
      install: { ...coreInstall(), gate: { ...host('gate'), hash: wrongHash }, luoshu: { files: { 'hetu-plugin.json': '{}' }, version: '1.0.0' } },
      folder: { outline: filesFor(workerManifest('outline')) },
      entries: { outline: signed({ signer: null }) },
      switches: { skipVerification: true },
    })
    await pluginsManager.start()
    expect(pluginsManager.policyJob('gate')).toBe('on')
    expect(link.events('plugin.checked')).toContainEqual({ plugin: 'gate', from: 'install', result: 'skipped' })
    expect(reasonOf(pluginsManager, 'outline')).toBe('unsigned')
    expect(reasonOf(pluginsManager, 'luoshu')).toBe('invalid')
  })

  it('refuses a policy job, provider or guard id with no host half, place', async () => {
    const { pluginsManager } = await harness({
      install: { ...coreInstall(), luoshu: { files: filesFor(workerManifest('luoshu')) } },
      pluginsManager: { guardsFor: () => ['leases'] },
    })
    await pluginsManager.start()
    expect(reasonOf(pluginsManager, 'luoshu')).toBe('place')
  })

  // A policy job holder refused this way is a security control that failed, so hetu stops
  it('refuses a policy job holder that requires anything', async () => {
    const { pluginsManager } = await harness({ install: { ...coreInstall(), gate: host('gate', { requires: ['storage'] }), storage: host('storage') } })
    await pluginsManager.start()
    expect(reasonOf(pluginsManager, 'gate')).toBe('requires')
    expect(pluginsManager.stopped()).toMatchObject({ control: 'gate', why: 'failed', reason: 'requires' })
  })

  it('refuses a plugin that requires a policy job holder and a core plugin that requires a folder plugin', async () => {
    const { pluginsManager } = await harness({
      install: { ...coreInstall(), storage: host('storage'), luoshu: host('luoshu', { requires: ['outline'] }) },
      folder: { outline: filesFor(workerManifest('outline', { requires: ['gate'] })) },
      entries: { outline: signed() },
    })
    await pluginsManager.start()
    expect(reasonOf(pluginsManager, 'luoshu')).toBe('requires')
    expect(reasonOf(pluginsManager, 'outline')).toBe('requires')
    expect(stateOf(pluginsManager, 'storage')).toBe('ready')
  })
})

describe('starting', () => {
  it('marks a sandboxed plugin crashed and a host half failed with start-timeout when ready doesn\'t come in time', async () => {
    const { pluginsManager, runtime, link } = await harness({
      install: { ...coreInstall(), luoshu: host('luoshu') },
      folder: { outline: filesFor(workerManifest('outline')) },
      entries: { outline: signed() },
      behave: { luoshu: { ready: false }, outline: { ready: false } },
      limits: { readyMs: 40 },
    })
    await pluginsManager.start()
    expect(stateOf(pluginsManager, 'luoshu')).toBe('failed')
    expect(reasonOf(pluginsManager, 'luoshu')).toBe('start-timeout')
    expect(stateOf(pluginsManager, 'outline')).toBe('crashed')
    expect(reasonOf(pluginsManager, 'outline')).toBe('start-timeout')
    expect(runtime.terminated).toEqual([{ id: 'outline', incarnation: 1 }])
    expect(link.events('plugin.crashed')).toEqual([{ plugin: 'outline', incarnation: 1, reason: 'start-timeout' }])
  })

  it('marks a host half failed when its module throws, and never starts it again in the run', async () => {
    const { pluginsManager, runtime } = await harness({ install: { ...coreInstall(), luoshu: host('luoshu') }, behave: { luoshu: { throws: true } } })
    await pluginsManager.start()
    expect(stateOf(pluginsManager, 'luoshu')).toBe('failed')
    expect(reasonOf(pluginsManager, 'luoshu')).toBe('start-failed')
    expect(runtime.order().filter(id => id === 'luoshu')).toEqual(['luoshu'])
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

  it('pushes grants snapshot 1 to the gate before it reads ready, and marks it failed when stateChanged throws', async () => {
    const gate = allowAll()
    const { pluginsManager } = await harness({ behave: { gate: { exports: { gate } } } })
    await pluginsManager.start()
    expect(gate.views).toEqual([1])
    expect(pluginsManager.view()).toBe(1)
    expect(pluginsManager.role('gate', 'gate')).toBe(gate)

    const broken = allowAll()
    broken.throws = true
    const other = await harness({ behave: { gate: { exports: { gate: broken } } } })
    await other.pluginsManager.start()
    expect(other.pluginsManager.policyJob('gate')).toBe('failed')
    expect(reasonOf(other.pluginsManager, 'gate')).toBe('state-changed')
    expect(other.pluginsManager.role('gate', 'gate')).toBe(null)
  })
})

describe('start markers', () => {
  const marker = (dataDir: string, id: string) => path.join(dataDir, 'starting', id)
  const exists = (file: string) => stat(file).then(() => true, () => false)

  it('writes starting/<id> before a host half starts and removes it at ready', async () => {
    const made = await harness({ install: twoHosts() })
    const seen: boolean[] = []
    const startHost = made.runtime.startHost.bind(made.runtime)
    made.runtime.startHost = async start => {
      seen.push(await exists(marker(made.dataDir, start.id)))
      return startHost(start)
    }
    await made.pluginsManager.start()
    expect(seen).toEqual([true, true])
    await until(() => true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await exists(marker(made.dataDir, 'gate'))).toBe(false)
    expect(await exists(marker(made.dataDir, 'storage'))).toBe(false)
  })

  it('leaves the marker of a host half that never reached ready, and the next boot holds that half failed', async () => {
    const made = await harness({ install: twoHosts(), behave: { gate: { ready: false } }, limits: { readyMs: 40 } })
    await made.pluginsManager.start()
    expect(await exists(marker(made.dataDir, 'gate'))).toBe(true)
    await made.pluginsManager.shutdown()

    const booted = await boot({ packaged: false, installDir: made.installDir, env: { HETU_DATA_DIR: made.dataDir }, platform: process.platform })
    try {
      expect(booted.markers).toEqual(['gate'])
      const next = await harness({ base: path.join(made.base, 'second'), markers: booted.markers, install: twoHosts() })
      await next.pluginsManager.start()
      expect(next.pluginsManager.policyJob('gate')).toBe('failed')
      expect(reasonOf(next.pluginsManager, 'gate')).toBe('marker')
      // The gate is a security control, so its marker stops hetu before the rest start
      expect(next.pluginsManager.stopped()).toMatchObject({ control: 'gate', reason: 'marker' })
      expect(next.runtime.order()).toEqual([])
      expect(next.link.events('plugin.failed')).toContainEqual({ plugin: 'gate', incarnation: 0, reason: 'marker' })
    } finally {
      await booted.release()
    }
  })

  it('removes the marker of a host half a stop caught while its marker was being written', async () => {
    const made = await harness()
    let stopping: Promise<void> | null = null
    const changed = made.link.changed.bind(made.link)
    made.link.changed = () => {
      changed()
      // The turn after the gate shows starting, its launch is writing the marker
      if (stopping === null && stateOf(made.pluginsManager, 'gate') === 'starting') {
        stopping = new Promise(resolve => queueMicrotask(() => resolve(made.pluginsManager.shutdown())))
      }
    }
    // Awaited, so nothing it writes is still landing when the test's folder is removed
    const starting = made.pluginsManager.start()
    await until(() => stopping !== null)
    await stopping
    await starting
    expect(await exists(marker(made.dataDir, 'gate'))).toBe(false)
  })

  it('removes the marker of a host half a planned stop ended before ready, so the next boot starts it', async () => {
    const made = await harness({ behave: { gate: { ready: false } } })
    const starting = made.pluginsManager.start()
    await until(() => made.runtime.order().includes('gate') && made.runtime.half('gate', 1, 'host').got('init').length === 1)
    expect(await exists(marker(made.dataDir, 'gate'))).toBe(true)
    await made.pluginsManager.shutdown()
    await starting
    expect(await exists(marker(made.dataDir, 'gate'))).toBe(false)
    const booted = await boot({ packaged: false, installDir: made.installDir, env: { HETU_DATA_DIR: made.dataDir }, platform: process.platform })
    try {
      expect(booted.markers).toEqual([])
    } finally {
      await booted.release()
    }
  })

  // A marker held open by another program waits in the removal's retry, which shutdown has to see through
  it.runIf(onWindows)('finishes removing a ready half\'s marker before shutdown resolves', { timeout: HOLD_TIMEOUT }, async () => {
    // PowerShell takes a second or more to start, which the harness's short readyMs would read as a start that hung
    const made = await harness({ limits: { readyMs: 10_000 } })
    const startHost = made.runtime.startHost.bind(made.runtime)
    made.runtime.startHost = async start => {
      if (start.id === 'gate') void releaseAfter(await holdOpen(marker(made.dataDir, 'gate'), 'Read'), 600)
      return startHost(start)
    }
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'gate')).toBe('ready')
    await made.pluginsManager.shutdown()
    expect(await exists(marker(made.dataDir, 'gate'))).toBe(false)
  })

  it('reads no marker from a name that is no plugin id, and none when the folder is missing', async () => {
    const made = await harness()
    await mkdir(path.join(made.dataDir, 'starting'), { recursive: true })
    await writeFile(path.join(made.dataDir, 'starting', 'Not An Id'), '')
    await writeFile(path.join(made.dataDir, 'starting', 'luoshu'), '')
    const booted = await boot({ packaged: false, installDir: made.installDir, env: { HETU_DATA_DIR: made.dataDir }, platform: process.platform })
    try {
      expect(booted.markers).toEqual(['luoshu'])
    } finally {
      await booted.release()
    }
  })

  it('holds no sandboxed plugin for a marker, since only host halves write one', async () => {
    const { pluginsManager } = await harness({
      folder: { outline: filesFor(workerManifest('outline')) },
      entries: { outline: signed() },
      markers: ['outline'],
    })
    await pluginsManager.start()
    expect(stateOf(pluginsManager, 'outline')).toBe('ready')
  })
})

describe('an app update to a core plugin', () => {
  it('writes plugin.updated, clears the plugin\'s cache and passes previousVersion, then marks the new version', async () => {
    const made = await harness({ install: twoHosts() })
    await writeInstalled(made.dataDir, { gate: { version: '0.9.0', hash: 'c'.repeat(64) }, storage: { version: '1.0.0', hash: (await readInstalledHash(made, 'storage')) } })
    await mkdir(path.join(made.dataDir, 'cache', 'gate'), { recursive: true })
    await writeFile(path.join(made.dataDir, 'cache', 'gate', 'index'), 'old')
    await made.pluginsManager.start()
    expect(made.link.events('plugin.updated')).toEqual([{ plugin: 'gate', from: '0.9.0', to: '1.0.0' }])
    const events = made.link.records.map(record => `${record.event} ${record.fields.plugin ?? ''}`)
    expect(events.indexOf('plugin.updated gate')).toBeLessThan(events.indexOf('plugin.started gate'))
    expect(await stat(path.join(made.dataDir, 'cache', 'gate', 'index')).then(() => true, () => false)).toBe(false)
    expect(made.runtime.half('gate', 1, 'host').got('init')[0].previousVersion).toBe('0.9.0')
    expect((await readInstalled(made.dataDir)).gate.version).toBe('1.0.0')
    // Storage had no change, so it heard of none
    expect(made.runtime.half('storage', 1, 'host').got('init')[0].previousVersion).toBe(null)
  })

  it('waits for plugin.updated to land before the plugin starts', async () => {
    const made = await harness()
    await writeInstalled(made.dataDir, { gate: { version: '0.9.0', hash: 'c'.repeat(64) } })
    let land!: (landing: Landing) => void
    made.link.landing = event => event === 'plugin.updated' ? new Promise(resolve => { land = resolve }) : 'landed'
    const starting = made.pluginsManager.start()
    await until(() => made.link.events('plugin.updated').length === 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(made.runtime.order()).toEqual([])
    land('landed')
    await starting
    expect(made.runtime.order()).toEqual(['gate'])
  })

  it('starts the plugin by its ready deadline when plugin.updated never lands, withdrawing the record, and the next start finds the change again', async () => {
    const made = await harness()
    await writeInstalled(made.dataDir, { gate: { version: '0.9.0', hash: 'c'.repeat(64) } })
    made.link.limits.readyMs = 300
    let signal: AbortSignal | undefined
    made.link.landing = (event, _fields, given) => {
      if (event !== 'plugin.updated') return 'landed'
      signal = given
      return new Promise<Landing>(() => {})
    }
    await made.pluginsManager.start()
    expect(made.runtime.order()).toEqual(['gate'])
    expect(signal?.aborted).toBe(true)
    expect(made.runtime.half('gate', 1, 'host').got('init')[0].previousVersion).toBe(null)
    expect((await readInstalled(made.dataDir)).gate.version).toBe('0.9.0')
  })

  it('applies nothing of the update when its record is lost, so the next start finds the change again', async () => {
    const made = await harness()
    await writeInstalled(made.dataDir, { gate: { version: '0.9.0', hash: 'c'.repeat(64) } })
    await mkdir(path.join(made.dataDir, 'cache', 'gate'), { recursive: true })
    await writeFile(path.join(made.dataDir, 'cache', 'gate', 'index'), 'old')
    made.link.landing = event => event === 'plugin.updated' ? 'lost' : 'landed'
    await made.pluginsManager.start()
    expect(made.runtime.half('gate', 1, 'host').got('init')[0].previousVersion).toBe(null)
    expect(await readFile(path.join(made.dataDir, 'cache', 'gate', 'index'), 'utf8')).toBe('old')
    expect((await readInstalled(made.dataDir)).gate.version).toBe('0.9.0')
  })

  it('reads no update on a first start, with no marker from a run before', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    expect(made.link.events('plugin.updated')).toEqual([])
    expect(Object.keys(await readInstalled(made.dataDir)).sort()).toEqual(['gate'])
  })
})

async function readInstalledHash(made: { installDir: string }, id: string): Promise<string> {
  const list = JSON.parse(await readFile(path.join(made.installDir, INSTALL_LIST), 'utf8')) as { plugins: Record<string, { hash: string }> }
  return list.plugins[id].hash
}

// PluginsManager is used for its type in the harness. Kept so a rename shows here too
export type { PluginsManager }
