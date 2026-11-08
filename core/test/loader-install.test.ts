import { writeFileSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTALL_LIST } from '../api/install.ts'
import { boot } from '../backend/boot/boot.ts'
import { Loader } from '../backend/loader/loader.ts'
import { readInstalled, writeInstalled } from '../backend/loader/folders.ts'
import type { Landing } from '../backend/loader/seams.ts'
import {
  allowAll, cleanup, coreInstall, entryFor, filesFor, harness, hostManifest, reasonOf, stateOf, until, workerManifest,
  type Listing,
} from './loader-fakes.ts'
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
  it('starts the slot holders, then the providers, then the guard, then sandboxed plugins in graph order', async () => {
    const { loader, runtime } = await harness({
      install: Object.fromEntries(['gate', 'capabilities', 'watchdog', 'storage', 'luoshu', 'history', 'exec', 'leases'].map(id => [id, host(id)])),
      folder: {
        outline: filesFor(workerManifest('outline', { requires: ['luoshu'] })),
        indexer: filesFor(workerManifest('indexer', { requires: ['outline'] })),
        'notes-tool': filesFor(workerManifest('notes-tool')),
      },
      entries: { outline: signed(), indexer: signed(), 'notes-tool': signed() },
      loader: { guardsFor: () => ['leases'] },
    })
    await loader.start()
    expect(runtime.order()).toEqual([
      'gate', 'capabilities', 'watchdog', 'storage', 'luoshu', 'history', 'exec', 'leases', 'notes-tool', 'outline', 'indexer',
    ])
    for (const id of ['gate', 'leases', 'outline', 'indexer']) expect(stateOf(loader, id)).toBe('ready')
  })

  it('starts a host half only after the one before it settled', async () => {
    const { loader, runtime, link } = await harness({ install: twoHosts(), behave: { gate: { ready: false } } })
    const starting = loader.start()
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
    const { link, runtime, loader } = made
    const register = link.register.bind(link)
    const handle = link.handle.bind(link)
    const startWorker = runtime.startWorker.bind(runtime)
    const startHost = runtime.startHost.bind(runtime)
    link.register = (port, caller) => { seen.push(`register ${JSON.stringify(caller)}`); register(port, caller) }
    link.handle = (caller, receive) => { seen.push(`handle ${JSON.stringify(caller)}`); return handle(caller, receive) }
    runtime.startWorker = start => { seen.push(`start ${start.id} ${start.incarnation}`); startWorker(start) }
    runtime.startHost = start => { seen.push(`start ${start.id} ${start.incarnation}`); return startHost(start) }
    await loader.start()
    expect(seen).toEqual([
      'handle {"kind":"plugin","id":"gate","half":"host","incarnation":1}', 'start gate 1',
      'register {"kind":"plugin","id":"outline","half":"worker","incarnation":1}', 'start outline 1',
    ])
  })

  it('sends init with the id, the API version, its dependencies, lastStop and previousVersion', async () => {
    const { loader, runtime } = await harness({
      install: { ...coreInstall(), luoshu: host('luoshu') },
      folder: { outline: filesFor(workerManifest('outline', { requires: ['luoshu'] })) },
      entries: { outline: signed({ granted: [{ type: 'plugin.call', targets: ['git'] }] }) },
    })
    await loader.start()
    expect(runtime.half('outline').got('init')).toEqual([{
      v: 1, kind: 'init', id: 'outline', incarnation: 1, api: 1, deps: { git: 'unavailable', luoshu: 'ready' },
      lastStop: null, previousVersion: null,
    }])
  })

  it('gives the worker host page the bytes it hashed, not what the file holds later', async () => {
    const { loader, runtime, dataDir } = await harness({
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
    await loader.start()
    expect(await readFile(file, 'utf8')).toBe('swapped()')
    const started = runtime.started.find(start => start.id === 'outline')
    expect(started?.code).toBe(original)
    expect(stateOf(loader, 'outline')).toBe('ready')
  })
})

describe('install plugins', () => {
  it('refuses one whose bytes fail the install list, which reads tampered, and starts the rest', async () => {
    const { loader, runtime, link } = await harness({ install: { ...twoHosts(), storage: { ...host('storage'), hash: wrongHash } } })
    await loader.start()
    expect(stateOf(loader, 'storage')).toBe('refused')
    expect(reasonOf(loader, 'storage')).toBe('tampered')
    expect(runtime.order()).toEqual(['gate'])
    expect(link.events('plugin.checked')).toContainEqual({ plugin: 'storage', from: 'install', result: 'tampered' })
    expect(link.events('plugin.checked')).toContainEqual({ plugin: 'gate', from: 'install', result: 'ok' })
  })

  // Han, 2026-11-08: a tampered security plugin always stops hetu from starting
  it('stops hetu when the tampered one is a security control, before the rest start', async () => {
    const { loader, runtime } = await harness({ install: { ...twoHosts(), gate: { ...host('gate'), hash: wrongHash } } })
    await loader.start()
    expect(loader.slot('gate')).toBe('tampered')
    expect(reasonOf(loader, 'gate')).toBe('tampered')
    expect(loader.stopped()).toMatchObject({ control: 'gate', why: 'tampered' })
    expect(runtime.order()).toEqual([])
  })

  it('reads a slot absent when the install holds no plugin for it', async () => {
    const { loader } = await harness()
    await loader.start()
    expect(loader.slot('watchdog')).toBe('absent')
    expect(loader.slot('capabilities')).toBe('absent')
    expect(loader.slot('gate')).toBe('on')
  })

  it('reads every slot starting before the install is read, absent with no list and tampered with a bad one', async () => {
    const before = await harness()
    expect(before.loader.slot('gate')).toBe('starting')
    const none = await harness({ install: null })
    await none.loader.start()
    expect(none.loader.slot('gate')).toBe('absent')
    expect(none.link.events('install.checked')).toEqual([{ result: 'absent' }])
    const bad = await harness()
    await writeFile(path.join(bad.installDir, INSTALL_LIST), '{"format":1,"plugins":{},"plugins":{}}')
    await bad.loader.start()
    expect(bad.loader.slot('gate')).toBe('tampered')
    expect(bad.runtime.order()).toEqual([])
  })

  it('switched off by the human, reads off and starts nothing, even when its check failed too', async () => {
    const { loader, runtime, link } = await harness({
      install: { ...twoHosts(), gate: { ...host('gate'), hash: wrongHash } },
      switches: { off: ['gate'] },
    })
    await loader.start()
    expect(loader.slot('gate')).toBe('off')
    expect(stateOf(loader, 'gate')).toBe('off')
    expect(runtime.order()).toEqual(['storage'])
    // The failed check is still recorded, it never reads as the switch-off
    expect(link.events('plugin.checked')).toContainEqual({ plugin: 'gate', from: 'install', result: 'tampered' })
  })

  it('in dev mode loads its bytes unhashed from the install and nothing more', async () => {
    const { loader, runtime, link } = await harness({
      install: { ...coreInstall(), gate: { ...host('gate'), hash: wrongHash }, luoshu: { ...host('luoshu'), hash: wrongHash } },
      switches: { devMode: ['gate'] },
    })
    await loader.start()
    expect(loader.slot('gate')).toBe('on')
    expect(link.events('plugin.checked')).toContainEqual({ plugin: 'gate', from: 'install', result: 'dev' })
    // The code still came from the install. Another plugin's failed check still holds
    expect(runtime.started.find(start => start.id === 'gate')?.half).toBe('host')
    expect(reasonOf(loader, 'luoshu')).toBe('tampered')
  })

  it('with skipVerification loads mismatched bytes and still refuses an unsigned plugin and a broken manifest', async () => {
    const { loader, link } = await harness({
      install: { ...coreInstall(), gate: { ...host('gate'), hash: wrongHash }, luoshu: { files: { 'hetu-plugin.json': '{}' }, version: '1.0.0' } },
      folder: { outline: filesFor(workerManifest('outline')) },
      entries: { outline: signed({ signer: null }) },
      switches: { skipVerification: true },
    })
    await loader.start()
    expect(loader.slot('gate')).toBe('on')
    expect(link.events('plugin.checked')).toContainEqual({ plugin: 'gate', from: 'install', result: 'skipped' })
    expect(reasonOf(loader, 'outline')).toBe('unsigned')
    expect(reasonOf(loader, 'luoshu')).toBe('invalid')
  })

  it('refuses a slot, provider or guard id with no host half, place', async () => {
    const { loader } = await harness({
      install: { ...coreInstall(), luoshu: { files: filesFor(workerManifest('luoshu')) } },
      loader: { guardsFor: () => ['leases'] },
    })
    await loader.start()
    expect(reasonOf(loader, 'luoshu')).toBe('place')
  })

  // A slot holder refused this way is a security control that failed, so hetu stops
  it('refuses a slot holder that requires anything', async () => {
    const { loader } = await harness({ install: { ...coreInstall(), gate: host('gate', { requires: ['storage'] }), storage: host('storage') } })
    await loader.start()
    expect(reasonOf(loader, 'gate')).toBe('requires')
    expect(loader.stopped()).toMatchObject({ control: 'gate', why: 'failed', reason: 'requires' })
  })

  it('refuses a plugin that requires a slot holder and an install plugin that requires a folder plugin', async () => {
    const { loader } = await harness({
      install: { ...coreInstall(), storage: host('storage'), luoshu: host('luoshu', { requires: ['outline'] }) },
      folder: { outline: filesFor(workerManifest('outline', { requires: ['gate'] })) },
      entries: { outline: signed() },
    })
    await loader.start()
    expect(reasonOf(loader, 'luoshu')).toBe('requires')
    expect(reasonOf(loader, 'outline')).toBe('requires')
    expect(stateOf(loader, 'storage')).toBe('ready')
  })
})

describe('starting', () => {
  it('marks a sandboxed plugin crashed and a host half failed with start-timeout when ready doesn\'t come in time', async () => {
    const { loader, runtime, link } = await harness({
      install: { ...coreInstall(), luoshu: host('luoshu') },
      folder: { outline: filesFor(workerManifest('outline')) },
      entries: { outline: signed() },
      behave: { luoshu: { ready: false }, outline: { ready: false } },
      limits: { readyMs: 40 },
    })
    await loader.start()
    expect(stateOf(loader, 'luoshu')).toBe('failed')
    expect(reasonOf(loader, 'luoshu')).toBe('start-timeout')
    expect(stateOf(loader, 'outline')).toBe('crashed')
    expect(reasonOf(loader, 'outline')).toBe('start-timeout')
    expect(runtime.terminated).toEqual([{ id: 'outline', incarnation: 1 }])
    expect(link.events('plugin.crashed')).toEqual([{ plugin: 'outline', incarnation: 1, reason: 'start-timeout' }])
  })

  it('marks a host half failed when its module throws, and never starts it again in the run', async () => {
    const { loader, runtime } = await harness({ install: { ...coreInstall(), luoshu: host('luoshu') }, behave: { luoshu: { throws: true } } })
    await loader.start()
    expect(stateOf(loader, 'luoshu')).toBe('failed')
    expect(reasonOf(loader, 'luoshu')).toBe('start-failed')
    expect(runtime.order().filter(id => id === 'luoshu')).toEqual(['luoshu'])
  })

  it('crashes a worker the runtime can\'t start', async () => {
    const { loader } = await harness({
      folder: { outline: filesFor(workerManifest('outline')) },
      entries: { outline: signed() },
      behave: { outline: { throws: true } },
    })
    await loader.start()
    expect(stateOf(loader, 'outline')).toBe('crashed')
    expect(reasonOf(loader, 'outline')).toBe('start-failed')
  })

  it('pushes StateView 1 to the gate before it reads ready, and marks it failed when stateChanged throws', async () => {
    const gate = allowAll()
    const { loader } = await harness({ behave: { gate: { exports: { gate } } } })
    await loader.start()
    expect(gate.views).toEqual([1])
    expect(loader.view()).toBe(1)
    expect(loader.role('gate', 'gate')).toBe(gate)

    const broken = allowAll()
    broken.throws = true
    const other = await harness({ behave: { gate: { exports: { gate: broken } } } })
    await other.loader.start()
    expect(other.loader.slot('gate')).toBe('failed')
    expect(reasonOf(other.loader, 'gate')).toBe('state-changed')
    expect(other.loader.role('gate', 'gate')).toBe(null)
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
    await made.loader.start()
    expect(seen).toEqual([true, true])
    await until(() => true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await exists(marker(made.dataDir, 'gate'))).toBe(false)
    expect(await exists(marker(made.dataDir, 'storage'))).toBe(false)
  })

  it('leaves the marker of a host half that never reached ready, and the next boot holds that half failed', async () => {
    const made = await harness({ install: twoHosts(), behave: { gate: { ready: false } }, limits: { readyMs: 40 } })
    await made.loader.start()
    expect(await exists(marker(made.dataDir, 'gate'))).toBe(true)
    await made.loader.shutdown()

    const booted = await boot({ packaged: false, installDir: made.installDir, env: { HETU_DATA_DIR: made.dataDir }, platform: process.platform })
    try {
      expect(booted.markers).toEqual(['gate'])
      const next = await harness({ base: path.join(made.base, 'second'), markers: booted.markers, install: twoHosts() })
      await next.loader.start()
      expect(next.loader.slot('gate')).toBe('failed')
      expect(reasonOf(next.loader, 'gate')).toBe('marker')
      // The gate is a security control, so its marker stops hetu before the rest start
      expect(next.loader.stopped()).toMatchObject({ control: 'gate', reason: 'marker' })
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
      if (stopping === null && stateOf(made.loader, 'gate') === 'starting') {
        stopping = new Promise(resolve => queueMicrotask(() => resolve(made.loader.shutdown())))
      }
    }
    // Awaited, so nothing it writes is still landing when the test's folder is removed
    const starting = made.loader.start()
    await until(() => stopping !== null)
    await stopping
    await starting
    expect(await exists(marker(made.dataDir, 'gate'))).toBe(false)
  })

  it('removes the marker of a host half a planned stop ended before ready, so the next boot starts it', async () => {
    const made = await harness({ behave: { gate: { ready: false } } })
    const starting = made.loader.start()
    await until(() => made.runtime.order().includes('gate') && made.runtime.half('gate', 1, 'host').got('init').length === 1)
    expect(await exists(marker(made.dataDir, 'gate'))).toBe(true)
    await made.loader.shutdown()
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
    await made.loader.start()
    expect(stateOf(made.loader, 'gate')).toBe('ready')
    await made.loader.shutdown()
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
    const { loader } = await harness({
      folder: { outline: filesFor(workerManifest('outline')) },
      entries: { outline: signed() },
      markers: ['outline'],
    })
    await loader.start()
    expect(stateOf(loader, 'outline')).toBe('ready')
  })
})

describe('an app update to an install plugin', () => {
  it('writes plugin.updated, clears the plugin\'s cache and passes previousVersion, then marks the new version', async () => {
    const made = await harness({ install: twoHosts() })
    await writeInstalled(made.dataDir, { gate: { version: '0.9.0', hash: 'c'.repeat(64) }, storage: { version: '1.0.0', hash: (await readInstalledHash(made, 'storage')) } })
    await mkdir(path.join(made.dataDir, 'cache', 'gate'), { recursive: true })
    await writeFile(path.join(made.dataDir, 'cache', 'gate', 'index'), 'old')
    await made.loader.start()
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
    const starting = made.loader.start()
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
    await made.loader.start()
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
    await made.loader.start()
    expect(made.runtime.half('gate', 1, 'host').got('init')[0].previousVersion).toBe(null)
    expect(await readFile(path.join(made.dataDir, 'cache', 'gate', 'index'), 'utf8')).toBe('old')
    expect((await readInstalled(made.dataDir)).gate.version).toBe('0.9.0')
  })

  it('reads no update on a first start, with no marker from a run before', async () => {
    const made = await harness()
    await made.loader.start()
    expect(made.link.events('plugin.updated')).toEqual([])
    expect(Object.keys(await readInstalled(made.dataDir)).sort()).toEqual(['gate'])
  })
})

async function readInstalledHash(made: { installDir: string }, id: string): Promise<string> {
  const list = JSON.parse(await readFile(path.join(made.installDir, INSTALL_LIST), 'utf8')) as { plugins: Record<string, { hash: string }> }
  return list.plugins[id].hash
}

// Loader is used for its type in the harness. Kept so a rename shows here too
export type { Loader }
