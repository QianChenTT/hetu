import { writeFileSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTALL_LIST } from '../api/install.ts'
import { PluginsManager } from '../backend/plugins-manager/plugins-manager.ts'
import { readInstalled, writeInstalled } from '../backend/plugins-manager/folders.ts'
import type { Landing } from '../backend/plugins-manager/header.ts'
import {
  allowAll, cleanup, coreInstall, entryFor, fakeLuoshu, filesFor, harness, hostManifest, reasonOf, stateOf, tempBase, until,
  workerManifest, type Listing,
} from './plugins-manager-fakes.ts'

afterEach(cleanup)

const host = (id: string, extra: object = {}): Listing => ({ files: filesFor(hostManifest(id, extra)) })
const HTTP = 'mcp-http-handler'
const NET = 'net'
// The core plugin an install holds: http, whose host entry runs in a utility process. net is a core plugin designed and
// not built, refused anywhere but a host half in main, which the core runs none of
const http = (extra: object = {}): Listing => host(HTTP, extra)
const net = (): Listing => ({ files: filesFor(workerManifest(NET)) })
const withHttp = (): Record<string, Listing> => ({ ...coreInstall(), [HTTP]: http() })
const wrongHash = 'b'.repeat(64)
const signed = (extra = {}) => (root: string) => entryFor(root, extra)

describe('the start order', () => {
  it('starts the core modules before any plugin, then the install\'s plugins, then folder plugins in graph order', async () => {
    const luoshu = fakeLuoshu()
    const made = await harness({
      install: withHttp(),
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
      install: { ...coreInstall(), [HTTP]: http() },
      folder: { outline: filesFor(workerManifest('outline')) },
      entries: { outline: signed() },
    })
    const { link, runtime, pluginsManager } = made
    const register = link.register.bind(link)
    const startWorker = runtime.startWorker.bind(runtime)
    const startUtility = runtime.startUtility.bind(runtime)
    link.register = (port, caller) => { seen.push(`register ${JSON.stringify(caller)}`); register(port, caller) }
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
      v: 1, kind: 'init', id: 'outline', incarnation: 1, api: 4, deps: { git: 'unavailable', luoshu: 'ready' },
      lastStop: null, previousVersion: null,
    }])
  })

  it('hands the data folder to no plugin, a core plugin\'s utility half included', async () => {
    const { pluginsManager, runtime } = await harness({
      install: { ...coreInstall(), [HTTP]: http() },
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

describe('core plugins', () => {
  it('refuses one whose bytes fail the install list, which reads tampered and stops nothing else', async () => {
    const { pluginsManager, runtime, link } = await harness({ install: { ...withHttp(), [HTTP]: { ...http(), hash: wrongHash } } })
    await pluginsManager.start()
    expect(stateOf(pluginsManager, HTTP)).toBe('refused')
    expect(reasonOf(pluginsManager, HTTP)).toBe('tampered')
    expect(runtime.order()).toEqual([])
    expect(link.events('plugin.checked')).toContainEqual({ plugin: HTTP, from: 'install', result: 'tampered' })
    expect(pluginsManager.stopped()).toBe(null)
  })

  it('reads a guard role absent, which nothing holds, with the gate and the grant risk classifier from their modules', async () => {
    const { pluginsManager } = await harness({ switches: { off: ['grant-risk-classifier'] } })
    await pluginsManager.start()
    expect(pluginsManager.policyJob('leases')).toBe('absent')
    expect(pluginsManager.policyJob('grant-risk-classifier')).toBe('off')
    expect(pluginsManager.policyJob('gate')).toBe('on')
  })

  // The list ships inside hetu's own files, so one that can't be read stops hetu. None at all, as in dev, starts the
  // core modules alone
  it('runs on the core modules with no list and stops in the stopped mode with a bad one', async () => {
    const none = await harness({ install: null })
    await none.pluginsManager.start()
    expect(none.pluginsManager.policyJob('gate')).toBe('on')
    expect(none.pluginsManager.stopped()).toBe(null)
    expect(none.link.events('install.checked')).toEqual([{ result: 'absent' }])
    const bad = await harness({ install: withHttp() })
    await writeFile(path.join(bad.installDir, INSTALL_LIST), '{"format":1,"plugins":{},"plugins":{}}')
    await bad.pluginsManager.start()
    expect(bad.pluginsManager.stopped()).toEqual({ control: 'install', why: 'tampered', reason: null, again: false })
    expect(bad.runtime.order()).toEqual([])
  })

  // A packaged build keeps the list inside app.asar and the plugins beside it, so a list planted beside the plugins is
  // never the one read
  it('reads the list from its own folder when it has one, never from the plugins\' folder', async () => {
    const base = path.join(await tempBase(), 'list')
    await mkdir(base, { recursive: true })
    const made = await harness({ install: withHttp(), pluginsManager: { listDir: base } })
    await made.pluginsManager.start()
    expect(made.link.events('install.checked')).toEqual([{ result: 'absent' }])
    expect(made.pluginsManager.plugin(HTTP)).toBe(null)
    const moved = path.join(await tempBase(), 'list')
    await mkdir(moved, { recursive: true })
    const listed = await harness({ install: withHttp(), before: async ({ installDir }) => {
      await writeFile(path.join(moved, INSTALL_LIST), await readFile(path.join(installDir, INSTALL_LIST)))
      await writeFile(path.join(installDir, INSTALL_LIST), '{"format":1,"plugins":{}}')
    }, pluginsManager: { listDir: moved } })
    await listed.pluginsManager.start()
    expect(listed.link.events('install.checked')).toEqual([{ result: 'ok' }])
    expect(stateOf(listed.pluginsManager, HTTP)).toBe('ready')
  })

  it('switched off by the human, reads off and starts nothing, even when its check failed too', async () => {
    const { pluginsManager, runtime, link } = await harness({
      install: { ...withHttp(), [HTTP]: { ...http(), hash: wrongHash } },
      switches: { off: [HTTP] },
    })
    await pluginsManager.start()
    expect(stateOf(pluginsManager, HTTP)).toBe('off')
    expect(runtime.order()).toEqual([])
    // The failed check is still recorded, it never reads as the switch-off
    expect(link.events('plugin.checked')).toContainEqual({ plugin: HTTP, from: 'install', result: 'tampered' })
  })

  it('in dev mode loads its bytes unhashed from the install and nothing more', async () => {
    const { pluginsManager, runtime, link } = await harness({
      install: { ...coreInstall(), [HTTP]: { ...http(), hash: wrongHash }, [NET]: { ...net(), hash: wrongHash } },
      switches: { devMode: [HTTP] },
    })
    await pluginsManager.start()
    expect(stateOf(pluginsManager, HTTP)).toBe('ready')
    expect(link.events('plugin.checked')).toContainEqual({ plugin: HTTP, from: 'install', result: 'dev' })
    // The code still came from the install. Another plugin's failed check still holds
    expect(runtime.started.find(start => start.id === HTTP)?.half).toBe('utility')
    expect(reasonOf(pluginsManager, NET)).toBe('tampered')
  })

  it('with skipVerification loads mismatched bytes and still refuses an unsigned plugin and a broken manifest', async () => {
    const { pluginsManager, link } = await harness({
      install: { ...coreInstall(), [HTTP]: { ...http(), hash: wrongHash }, [NET]: { files: { 'hetu-plugin.json': '{}' }, version: '1.0.0' } },
      folder: { outline: filesFor(workerManifest('outline')) },
      entries: { outline: signed({ signer: null }) },
      switches: { skipVerification: true },
    })
    await pluginsManager.start()
    expect(stateOf(pluginsManager, HTTP)).toBe('ready')
    expect(link.events('plugin.checked')).toContainEqual({ plugin: HTTP, from: 'install', result: 'skipped' })
    expect(reasonOf(pluginsManager, 'outline')).toBe('unsigned')
    expect(reasonOf(pluginsManager, NET)).toBe('invalid')
  })

  // Only a host half in main could hold a policy job, a provider or a guard. The core runs none. An expected guard
  // nothing holds stops hetu in the fail-safe at start, the provider nothing
  it('refuses a policy job, provider or guard id with place, whatever its entries', async () => {
    const { pluginsManager, runtime } = await harness({
      install: { ...coreInstall(), net: { files: filesFor(workerManifest('net')) }, [HTTP]: http() },
      pluginsManager: { guardsFor: () => [HTTP] },
    })
    await pluginsManager.start()
    for (const id of ['net', HTTP]) expect(reasonOf(pluginsManager, id)).toBe('place')
    expect(pluginsManager.policyJob(HTTP)).toBe('absent')
    expect(pluginsManager.stopped()).toMatchObject({ control: HTTP, why: 'start-failed' })
    expect(runtime.order()).toEqual([])
    const unguarded = await harness({ install: { ...coreInstall(), net: { files: filesFor(workerManifest('net')) } } })
    await unguarded.pluginsManager.start()
    expect(reasonOf(unguarded.pluginsManager, 'net')).toBe('place')
    expect(unguarded.pluginsManager.stopped()).toBe(null)
  })

  it('refuses a host entry outside a utility process and a utility id with no host entry, place', async () => {
    const { pluginsManager, runtime } = await harness({
      install: { ...coreInstall(), [NET]: host(NET), [HTTP]: { files: filesFor(workerManifest(HTTP)) } },
    })
    await pluginsManager.start()
    expect(reasonOf(pluginsManager, NET)).toBe('place')
    expect(reasonOf(pluginsManager, HTTP)).toBe('place')
    expect(runtime.order()).toEqual([])
  })

  it('refuses a plugin that requires a policy job holder and a core plugin that requires a folder plugin', async () => {
    const { pluginsManager } = await harness({
      install: { ...coreInstall(), [HTTP]: http({ requires: ['outline'] }) },
      folder: { outline: filesFor(workerManifest('outline', { requires: ['gate'] })) },
      entries: { outline: signed() },
    })
    await pluginsManager.start()
    expect(reasonOf(pluginsManager, HTTP)).toBe('requires')
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

describe('an app update to a core plugin', () => {
  it('writes plugin.updated, clears the plugin\'s cache and passes previousVersion, then marks the new version', async () => {
    const made = await harness({ install: withHttp() })
    await writeInstalled(made.dataDir, { [HTTP]: { version: '0.9.0', hash: 'c'.repeat(64) } })
    await mkdir(path.join(made.dataDir, 'cache', HTTP), { recursive: true })
    await writeFile(path.join(made.dataDir, 'cache', HTTP, 'index'), 'old')
    await made.pluginsManager.start()
    expect(made.link.events('plugin.updated')).toEqual([{ plugin: HTTP, from: '0.9.0', to: '1.0.0' }])
    const events = made.link.records.map(record => `${record.event} ${record.fields.plugin ?? ''}`)
    expect(events.indexOf(`plugin.updated ${HTTP}`)).toBeLessThan(events.indexOf(`plugin.started ${HTTP}`))
    expect(await stat(path.join(made.dataDir, 'cache', HTTP, 'index')).then(() => true, () => false)).toBe(false)
    expect(made.runtime.half(HTTP, 1, 'utility').got('init')[0].previousVersion).toBe('0.9.0')
    expect((await readInstalled(made.dataDir))[HTTP].version).toBe('1.0.0')
  })

  it('waits for plugin.updated to land before the plugin starts', async () => {
    const made = await harness({ install: { ...coreInstall(), [HTTP]: http() } })
    await writeInstalled(made.dataDir, { [HTTP]: { version: '0.9.0', hash: 'c'.repeat(64) } })
    let land!: (landing: Landing) => void
    made.link.landing = event => event === 'plugin.updated' ? new Promise(resolve => { land = resolve }) : 'landed'
    const starting = made.pluginsManager.start()
    await until(() => made.link.events('plugin.updated').length === 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(made.runtime.order()).toEqual([])
    land('landed')
    await starting
    expect(made.runtime.order()).toEqual([HTTP])
  })

  it('starts the plugin by its ready deadline when plugin.updated never lands, withdrawing the record, and the next start finds the change again', async () => {
    const made = await harness({ install: { ...coreInstall(), [HTTP]: http() } })
    await writeInstalled(made.dataDir, { [HTTP]: { version: '0.9.0', hash: 'c'.repeat(64) } })
    made.link.limits.readyMs = 300
    let signal: AbortSignal | undefined
    made.link.landing = (event, _fields, given) => {
      if (event !== 'plugin.updated') return 'landed'
      signal = given
      return new Promise<Landing>(() => {})
    }
    await made.pluginsManager.start()
    expect(made.runtime.order()).toEqual([HTTP])
    expect(signal?.aborted).toBe(true)
    expect(made.runtime.half(HTTP, 1, 'utility').got('init')[0].previousVersion).toBe(null)
    expect((await readInstalled(made.dataDir))[HTTP].version).toBe('0.9.0')
  })

  it('applies nothing of the update when its record is lost, so the next start finds the change again', async () => {
    const made = await harness({ install: { ...coreInstall(), [HTTP]: http() } })
    await writeInstalled(made.dataDir, { [HTTP]: { version: '0.9.0', hash: 'c'.repeat(64) } })
    await mkdir(path.join(made.dataDir, 'cache', HTTP), { recursive: true })
    await writeFile(path.join(made.dataDir, 'cache', HTTP, 'index'), 'old')
    made.link.landing = event => event === 'plugin.updated' ? 'lost' : 'landed'
    await made.pluginsManager.start()
    expect(made.runtime.half(HTTP, 1, 'utility').got('init')[0].previousVersion).toBe(null)
    expect(await readFile(path.join(made.dataDir, 'cache', HTTP, 'index'), 'utf8')).toBe('old')
    expect((await readInstalled(made.dataDir))[HTTP].version).toBe('0.9.0')
  })

  it('reads no update on a first start, with no marker from a run before', async () => {
    const made = await harness({ install: withHttp() })
    await made.pluginsManager.start()
    expect(made.link.events('plugin.updated')).toEqual([])
    expect(Object.keys(await readInstalled(made.dataDir)).sort()).toEqual([HTTP])
  })
})

// PluginsManager is used for its type in the harness. Kept so a rename shows here too
export type { PluginsManager }
