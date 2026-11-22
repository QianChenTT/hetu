import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import type { MessagePort } from 'node:worker_threads'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { Access } from '../api/policy-jobs.ts'
import { boot, type Booted } from '../backend/boot/boot.ts'
import { defaultSwitches, StateStore, type Plugin } from '../backend/boot/state.ts'
import type { RouterDoor } from '../backend/router/header.ts'
import { wireCore, type WireOptions } from '../backend/wire.ts'
import { createGate } from '../backend/policy/gate/gate.ts'
import { createLuoshu } from '../backend/providers/luoshu/luoshu.ts'
import { httpPlugin } from '../../core-plugins/mcp-http-handler/src/keeper.ts'
import { run } from '../sdk/plugin.ts'
import { code, FakeStorage, FakeLuoshu, windowWay, worker } from './router-fakes.ts'
import { luoshuModule, storageModule } from './modules-fakes.ts'
import {
  allowAll, coreInstall, FakeRuntime, filesFor, hashOf, hostManifest, reasonOf, tempBase, workerManifest, writeFolder,
  writeInstall, type Files, type Listing, type Message, writeApproved,
} from './plugins-manager-fakes.ts'

const open: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))
const exists = (file: string) => stat(file).then(() => true, () => false)

async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > ms) throw new Error('nothing arrived in time')
    await tick(5)
  }
}

// The joined core over a real boot: a temp data folder holding approved folder plugins, an install written from
// fixtures, the fake runtime and the core modules, a gate that allows everything and the real others unless modules
// hands its own. before runs on the booted core before anything starts
async function joined(options: {
  install?: Record<string, Listing>
  folder?: Record<string, Files>
  // More for a folder plugin's approved entry, its grants and switches
  entries?: Record<string, Partial<Plugin>>
  behave?: FakeRuntime['behave']
  modules?: WireOptions['modules']
  before?: (booted: Booted) => void
  // Runs on the data folder before boot reads it
  prepare?: (dataDir: string) => Promise<void>
  wire?: Pick<WireOptions, 'guardsFor' | 'debug' | 'asks' | 'windows' | 'onFailure' | 'limited'>
} = {}) {
  const base = await tempBase()
  const installDir = path.join(base, 'install')
  const dataDir = path.join(base, 'data')
  await mkdir(installDir, { recursive: true })
  await writeInstall(installDir, options.install ?? coreInstall())
  const store = new StateStore(dataDir)
  await store.writeSwitches(defaultSwitches())
  for (const [id, files] of Object.entries(options.folder ?? {})) {
    const root = path.join(dataDir, 'plugins', id)
    await writeFolder(root, files)
    await writeApproved(store, id, root, options.entries?.[id])
  }
  await options.prepare?.(dataDir)
  const booted = await boot({ packaged: false, installDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
  options.before?.(booted)
  const runtime = new FakeRuntime()
  runtime.behave = options.behave ?? {}
  // No guard expected unless a test names its own, so the tests here hold their meaning with the lock module wired
  const { recording, pluginsManager, router, modules } = wireCore({
    booted, installDir, runtime, modules: { gate: allowAll(), ...options.modules }, confirmDelayMs: 0, guardsFor: () => [], ...options.wire,
  })
  open.push(async () => {
    await pluginsManager.shutdown().catch(() => {})
    // Quit's order: close writes its last counts and starts a drain, which must land before the lock goes. Windows
    // also won't remove a folder a write is still filling
    router.close()
    await recording.flush()
    for (const port of runtime.ports) port.close()
    await booted.release()
    await rm(base, { recursive: true, force: true })
  })
  return { pluginsManager, router, modules, recording, runtime, booted, dataDir, installDir }
}

// The records the core record lane wrote to the boot's event log, in order, each with its fields
async function coreRecords(dataDir: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path.join(dataDir, 'events', 'events-1.jsonl'), 'utf8')
  return text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

async function coreRecordEvents(dataDir: string): Promise<string[]> {
  return (await coreRecords(dataDir)).map(record => record.event as string)
}

// A gate built on the fixtures' allow-all one, deciding with decide while it keeps the grants snapshot it was given
function gateDeciding(decide: (access: Access, view: number) => unknown) {
  const gate = allowAll()
  return Object.assign(gate, { decide: (access: Access) => decide(access, gate.views.at(-1) ?? 0) })
}

describe('wiring the core', () => {
  it('builds the router, then the plugins manager on its door, so the plugins manager reaches the real router', async () => {
    const { recording, router, pluginsManager, dataDir } = await joined({ folder: { alpha: filesFor(workerManifest('alpha')) } })
    await pluginsManager.start()
    await recording.flush()
    const events = await coreRecordEvents(dataDir)
    expect(events).toContain('install.checked')
    expect(events).toContain('plugin.started')
    expect(router.limit('gate', 'readyMs')).toBe(10000)
    // The router keeps no import of the plugins manager, so the typecheck proves here that its door gives the plugins manager all it needs
    const door: RouterDoor = router
    expect(door).toBe(router)
  })

  it('ends its start with core.ready, which holds every policy job\'s state', async () => {
    const { recording, router, pluginsManager, dataDir } = await joined()
    await pluginsManager.start()
    await recording.flush()
    const records = await coreRecords(dataDir)
    expect(records.filter(record => record.event === 'core.ready')).toHaveLength(1)
    expect(records.at(-1)).toMatchObject({ event: 'core.ready', gate: 'on', 'grant-risk-classifier': 'on' })
    expect(records.at(-1)).not.toHaveProperty('log')
  })

  it('writes no core.ready when shutdown began during the start', async () => {
    const { recording, router, pluginsManager, dataDir } = await joined()
    const started = pluginsManager.start()
    await pluginsManager.shutdown()
    await started
    await recording.flush()
    expect(await coreRecordEvents(dataDir)).not.toContain('core.ready')
  })

  it('hands the runtime a limit the human set once it is written, so each running half gets it', async () => {
    const heard: [string, number][] = []
    const parts: { router: { limit(plugin: string, name: 'messagesPerSecond'): number } | null } = { router: null }
    const { pluginsManager, router } = await joined({ wire: { limited: plugin => void heard.push([plugin, parts.router!.limit(plugin, 'messagesPerSecond')]) } })
    parts.router = router
    await pluginsManager.start()
    await pluginsManager.apply({ kind: 'limit.set', constant: 'messagesPerSecond', value: 20, plugin: 'gate' })
    expect(heard).toEqual([['gate', 20]])
  })
})

// alpha serves alpha.hello and publishes alpha.changed, beta requires alpha, gamma publishes gamma.changed. The gate
// allows everything, so what is under test is the path, not a grant
describe('a plugin\'s life through the joined core', () => {
  async function lives() {
    const gate = allowAll()
    const parts = await joined({
      folder: {
        alpha: filesFor(workerManifest('alpha', { provides: { actions: { hello: {} }, topics: ['changed'] } })),
        beta: filesFor(workerManifest('beta', { requires: ['alpha'] })),
        gamma: filesFor(workerManifest('gamma', { provides: { topics: ['changed'] } })),
      },
      modules: { gate },
    })
    await parts.pluginsManager.start()
    await parts.pluginsManager.settled()
    return { ...parts, gate }
  }

  const events = (messages: Message[], topic: string) =>
    messages.filter(message => message.kind === 'event' && message.topic === topic)

  it('starts a verified plugin through the real router: init, deps, then ready', async () => {
    const { pluginsManager, runtime } = await lives()
    const alpha = runtime.half('alpha')
    expect(alpha.got('init')).toHaveLength(1)
    expect(alpha.got('init')[0]).toMatchObject({ v: 1, kind: 'init', id: 'alpha', incarnation: 1, deps: {} })
    // A dependent learns its requirements' states in its init
    expect(runtime.half('beta').got('init')[0]).toMatchObject({ kind: 'init', id: 'beta', deps: { alpha: 'ready' } })
    expect(pluginsManager.plugin('alpha')?.state).toBe('ready')
    expect(pluginsManager.plugin('beta')?.state).toBe('ready')
  })

  it('takes its call through the eleven steps and records it', async () => {
    const { recording, router, dataDir, runtime } = await lives()
    const alpha = runtime.half('alpha')
    const asked = runtime.half('beta').ask('alpha.hello', { name: 'beta' })
    await until(() => alpha.inbox.some(message => message.kind === 'call' && message.action === 'alpha.hello'))
    const delivered = alpha.inbox.find(message => message.kind === 'call' && message.action === 'alpha.hello')!
    expect(delivered.caller).toEqual(worker('beta'))
    alpha.send({ v: 1, kind: 'reply', callId: delivered.callId, ok: true, result: 'hello beta' })
    expect((await asked)?.result).toBe('hello beta')
    await recording.flush()
    const records = (await coreRecords(dataDir)).filter(record => record.event === 'audit.call' && record.action === 'alpha.hello')
    expect(records.map(record => [record.caller, record.code])).toEqual([['beta/worker#1', null]])
  })

  it('delivers its published event to a subscriber that may read it', async () => {
    const { runtime } = await lives()
    const beta = runtime.half('beta')
    expect((await beta.ask('events.subscribe', { topics: ['alpha.changed'] }))?.result).toEqual({ standing: [] })
    expect((await runtime.half('alpha').ask('events.publish', { topic: 'alpha.changed', path: 'notes/a.md' }))?.ok).toBe(true)
    await until(() => events(beta.inbox, 'alpha.changed').length === 1)
    expect(events(beta.inbox, 'alpha.changed')).toEqual([{ v: 1, kind: 'event', seq: 1, topic: 'alpha.changed', path: 'notes/a.md' }])
  })

  it('drops its subscriptions and credits when it stops', async () => {
    const { pluginsManager, runtime } = await lives()
    const alpha = runtime.half('alpha')
    const first = runtime.half('beta')
    await first.ask('events.subscribe', { topics: ['alpha.changed'] })
    await alpha.ask('events.publish', { topic: 'alpha.changed' })
    await until(() => events(first.inbox, 'alpha.changed').length === 1)
    await pluginsManager.stop('beta', 'human')
    await pluginsManager.restart('beta', 'human')
    await until(() => pluginsManager.plugin('beta')?.state === 'ready')
    const second = runtime.half('beta', 2)
    await alpha.ask('events.publish', { topic: 'alpha.changed' })
    await tick(30)
    // The new incarnation holds no subscription from the old one
    expect(events(second.inbox, 'alpha.changed')).toEqual([])
    await second.ask('events.subscribe', { topics: ['alpha.changed'] })
    await alpha.ask('events.publish', { topic: 'alpha.changed' })
    await until(() => events(second.inbox, 'alpha.changed').length === 1)
    // Its credits start afresh, so its events count from 1 again
    expect(events(second.inbox, 'alpha.changed')[0].seq).toBe(1)
    expect(events(first.inbox, 'alpha.changed')).toHaveLength(1)
  })

  it('drops them when it crashes, moves its dependents to waiting and refuses its old incarnation', async () => {
    const { router, pluginsManager, runtime } = await lives()
    const alpha = runtime.half('alpha')
    await alpha.ask('events.subscribe', { topics: ['gamma.changed'] })
    alpha.crash()
    await until(() => pluginsManager.plugin('alpha')?.state === 'crashed')
    expect(pluginsManager.plugin('beta')?.state).toBe('waiting')
    await runtime.half('gamma').ask('events.publish', { topic: 'gamma.changed' })
    await tick(30)
    expect(events(alpha.inbox, 'gamma.changed')).toEqual([])
    await pluginsManager.restart('alpha', 'human')
    await until(() => pluginsManager.plugin('alpha')?.state === 'ready')
    const second = runtime.half('alpha', 2)
    // A message for the dead incarnation reaches nothing, the new one included
    router.send(worker('alpha', 1), { v: 1, kind: 'stop', graceMs: 3000 })
    await tick(30)
    expect(second.got('stop')).toEqual([])
    expect(alpha.closed).toBe(true)
  })

  it('restarts it as a new incarnation that starts with no subscriptions or credits', async () => {
    const { pluginsManager, runtime } = await lives()
    await runtime.half('alpha').ask('events.subscribe', { topics: ['gamma.changed'] })
    runtime.half('alpha').crash()
    await until(() => pluginsManager.plugin('alpha')?.state === 'crashed')
    await pluginsManager.restart('alpha', 'human')
    await until(() => pluginsManager.plugin('alpha')?.state === 'ready' && pluginsManager.plugin('beta')?.state === 'ready')
    const second = runtime.half('alpha', 2)
    const gamma = runtime.half('gamma')
    await gamma.ask('events.publish', { topic: 'gamma.changed' })
    await tick(30)
    expect(events(second.inbox, 'gamma.changed')).toEqual([])
    await second.ask('events.subscribe', { topics: ['gamma.changed'] })
    await gamma.ask('events.publish', { topic: 'gamma.changed' })
    await until(() => events(second.inbox, 'gamma.changed').length === 1)
    expect(events(second.inbox, 'gamma.changed')[0].seq).toBe(1)
    // Its dependent came back on its own as a new incarnation too
    expect(runtime.half('beta', 2).got('init')).toHaveLength(1)
  })

})

// Shutdown stops sandboxed plugins in reverse graph order, then the core modules close with the log last. A plugin in
// its stop grace can still save, so the core modules it needs serve until every plugin stopped
describe('shutdown through the joined core', () => {
  async function quitting(options: { alphaHolds?: boolean } = {}) {
    const storage = new FakeStorage()
    const gate = allowAll()
    const parts = await joined({
      folder: { alpha: filesFor(workerManifest('alpha')) },
      modules: { gate, storage: storageModule(storage) },
      behave: { alpha: { stopped: options.alphaHolds !== true } },
    })
    await parts.pluginsManager.start()
    await parts.pluginsManager.settled()
    return { ...parts, storage, gate }
  }

  it('keeps the core modules serving while sandboxed plugins stop for shutdown', async () => {
    const { pluginsManager, runtime, storage } = await quitting({ alphaHolds: true })
    const alpha = runtime.half('alpha')
    const shutdown = pluginsManager.shutdown()
    await until(() => alpha.got('stop').length === 1)
    expect(pluginsManager.policyJob('gate')).toBe('on')
    expect((await alpha.ask('storage.set', { key: 'draft', value: 'last words' }))?.ok).toBe(true)
    alpha.send({ v: 1, kind: 'stopped' })
    await shutdown
    expect([...storage.values.values()]).toContain('last words')
  })

  // The gate answers until the end, so its state changes with no stop
  it('records no policy job state when shutdown runs', async () => {
    const { recording, router, dataDir, pluginsManager } = await quitting()
    await pluginsManager.shutdown()
    await recording.flush()
    const records = await coreRecords(dataDir)
    const after = records.slice(records.findIndex(record => record.event === 'core.stopping'))
    const policyJobs = after.filter(record => record.event === 'policy-job.state')
    expect(policyJobs).toEqual([])
  })

  it('records the gate failing during shutdown as failed', async () => {
    const { recording, router, dataDir, pluginsManager, runtime, gate } = await quitting({ alphaHolds: true })
    const alpha = runtime.half('alpha')
    const shutdown = pluginsManager.shutdown()
    await until(() => alpha.got('stop').length === 1)
    // The next grants snapshot throws in the gate's push
    gate.throws = true
    await pluginsManager.apply({ kind: 'confirmOff', on: true })
    await until(() => pluginsManager.policyJob('gate') === 'failed')
    alpha.send({ v: 1, kind: 'stopped' })
    await shutdown
    await recording.flush()
    const records = await coreRecords(dataDir)
    const after = records.slice(records.findIndex(record => record.event === 'core.stopping'))
    const policyJobs = after.filter(record => record.event === 'policy-job.state')
    expect(policyJobs.map(record => [record.policyJob, record.state])).toEqual([['gate', 'failed']])
  })

  // The gate module hears that shutdown began as the router does, so a gate that is down answers stopped there too
  it('answers gate.reach stopped once the gate failed during shutdown', async () => {
    const { router, pluginsManager, runtime, gate } = await quitting({ alphaHolds: true })
    const way = windowWay(router, { editor: { kind: 'window', role: 'editor', n: 1 } })
    const alpha = runtime.half('alpha')
    const shutdown = pluginsManager.shutdown()
    await until(() => alpha.got('stop').length === 1)
    gate.throws = true
    await pluginsManager.apply({ kind: 'confirmOff', on: true })
    await until(() => pluginsManager.policyJob('gate') === 'failed')
    expect(code(await way.ask('editor', 'gate.reach', { plugin: 'alpha', path: 'notes/a.md' }))).toBe('stopped')
    alpha.send({ v: 1, kind: 'stopped' })
    await shutdown
  })

  it('keeps the audit queue through shutdown and writes it on the flush after close', async () => {
    const { recording, router, dataDir, pluginsManager, runtime } = await quitting({ alphaHolds: true })
    const alpha = runtime.half('alpha')
    expect((await alpha.ask('storage.set', { key: 'draft', value: 'one' }))?.ok).toBe(true)
    const shutdown = pluginsManager.shutdown()
    await until(() => alpha.got('stop').length === 1)
    expect((await alpha.ask('storage.set', { key: 'draft', value: 'two' }))?.ok).toBe(true)
    alpha.send({ v: 1, kind: 'stopped' })
    await shutdown
    router.close()
    await recording.flush()
    const records = await coreRecords(dataDir)
    expect(records.filter(record => record.event === 'audit.call' && record.action === 'storage.set')).toHaveLength(2)
    expect(records.filter(record => record.event === 'audit.dropped')).toEqual([])
  })

  // The Confirm behind it already landed, so a narrowing confirmed just before Quit must outlast the run
  it('keeps a security change applied while shutdown runs', async () => {
    const { dataDir, pluginsManager, runtime } = await quitting({ alphaHolds: true })
    const alpha = runtime.half('alpha')
    const shutdown = pluginsManager.shutdown()
    await until(() => alpha.got('stop').length === 1)
    await pluginsManager.apply({ kind: 'plugin.off', plugin: 'alpha' })
    alpha.send({ v: 1, kind: 'stopped' })
    await shutdown
    expect((await new StateStore(dataDir).load()).state.plugins.alpha.enabled).toBe(false)
  })

  it('refuses an update once shutdown began', async () => {
    const { installDir, pluginsManager } = await quitting()
    await pluginsManager.shutdown()
    await expect(pluginsManager.update('alpha', installDir)).rejects.toMatchObject({ code: 'stopped' })
  })
})

// The router must ask the same guards the plugins manager expects and report where the plugins manager's options say
describe('what wireCore hands the router', () => {
  async function writing(wire: Pick<WireOptions, 'guardsFor' | 'debug' | 'asks'>, gate = allowAll()) {
    const luoshu = new FakeLuoshu()
    const parts = await joined({
      folder: { alpha: filesFor(workerManifest('alpha')) },
      modules: { gate, luoshu: luoshuModule(luoshu) },
      wire,
    })
    await parts.pluginsManager.start()
    await parts.pluginsManager.settled()
    return { ...parts, luoshu }
  }

  // One expected from the start would stop hetu in the fail-safe, so this one goes missing once hetu runs
  it('makes the router ask the guards the plugins manager expects, so one missing while hetu runs refuses the write', async () => {
    let expected: string[] = []
    const { runtime, luoshu } = await writing({ guardsFor: () => expected })
    expected = ['net']
    const reply = await runtime.half('alpha').ask('luoshu.write', { path: 'notes/a.md', text: 'x' })
    expect(code(reply!)).toBe('guard-down')
    expect(luoshu.performed).toEqual([])
  })

  // The start check and the router read the one switch, so a guard the human switched off is no step for either
  it('lets a write past an expected guard the human switched off', async () => {
    const luoshu = new FakeLuoshu()
    const parts = await joined({
      folder: { alpha: filesFor(workerManifest('alpha')) },
      modules: { luoshu: luoshuModule(luoshu) },
      wire: { guardsFor: () => ['net'] },
      before: booted => {
        booted.state.switches = { ...booted.state.switches, off: ['net'] }
      },
    })
    await parts.pluginsManager.start()
    await parts.pluginsManager.settled()
    expect(parts.pluginsManager.stopped()).toBe(null)
    const reply = await parts.runtime.half('alpha').ask('luoshu.write', { path: 'notes/a.md', text: 'x' })
    expect(reply).toMatchObject({ ok: true })
    expect(luoshu.performed).toHaveLength(1)
  })

  it('hands the router the debug sink for a gate that throws', async () => {
    const debug: { plugin: string | null }[] = []
    const gate = gateDeciding(() => { throw new Error('broken') })
    const { runtime } = await writing({ debug: entry => { debug.push(entry) } }, gate)
    expect(code((await runtime.half('alpha').ask('luoshu.read', { path: 'notes/a.md' }))!)).toBe('policy-down')
    expect(debug.map(entry => entry.plugin)).toContain('gate')
  })

  it('hands the router the asks that raise a gate\'s prompt', async () => {
    const raised: string[] = []
    const gate = gateDeciding((access, view) => access.stage === 'raw' ? { allow: true, view } : { ask: 'luoshu.read notes/a.md', view })
    const { runtime } = await writing({ asks: { raise: ask => { raised.push(ask); return 'req-1' } } }, gate)
    const reply = await runtime.half('alpha').ask('luoshu.read', { path: 'notes/a.md' })
    expect(reply?.refusal).toEqual({ code: 'needs-confirm', action: 'luoshu.read', request: 'req-1' })
    expect(raised).toEqual(['luoshu.read notes/a.md'])
  })
})

describe('core.status, for a window\'s banner', () => {
  const editor = { kind: 'window' as const, role: 'editor' as const, n: 1 }

  it('answers a window with the policy jobs, the plugins crashed and not restarted, the switches that weaken and the luoshu folder', async () => {
    const { router, pluginsManager, runtime } = await joined({ folder: { alpha: filesFor(workerManifest('alpha')) } })
    await pluginsManager.start()
    const way = windowWay(router, { editor })
    const reply = await way.ask('editor', 'core.status')
    expect(reply).toMatchObject({ ok: true })
    expect(reply.result).toEqual({
      policyJobs: { gate: 'on', 'grant-risk-classifier': 'on' },
      crashed: [],
      devMode: [],
      // alpha's build, as its approval allowed it
      allowUnsigned: 1,
      skipVerification: false,
      modulesOff: [],
      logWrites: true,
      luoshuPicked: false,
      pending: [],
      stopped: null,
      suspect: [],
    })
    runtime.half('alpha').crash()
    await until(() => pluginsManager.plugin('alpha')?.state === 'crashed')
    expect((await way.ask('editor', 'core.status')).result).toMatchObject({ crashed: ['alpha'] })
  })

  it('names the switches when they are gone from a data folder hetu ran in before', async () => {
    const { router, pluginsManager } = await joined({
      // A first start leaves its records, then the switches go
      prepare: async dataDir => {
        const first = await boot({ packaged: false, installDir: dataDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
        await first.release()
        await rm(path.join(dataDir, 'state', 'switches.json'))
      },
    })
    await pluginsManager.start()
    const way = windowWay(router, { editor })
    expect((await way.ask('editor', 'core.status')).result).toMatchObject({ suspect: ['switches'] })
  })

  it('names the requests waiting for the human, a plugin found in the folder among them', async () => {
    const { router, pluginsManager, dataDir } = await joined()
    await writeFolder(path.join(dataDir, 'plugins', 'beta'), filesFor(workerManifest('beta')))
    await pluginsManager.start()
    const way = windowWay(router, { editor })
    expect((await way.ask('editor', 'core.status')).result).toMatchObject({ pending: [{ kind: 'plugin.approve', plugin: 'beta' }] })
  })

  it('says the log can\'t write while boot\'s event log is failing', async () => {
    const { router, pluginsManager } = await joined({ before: booted => Object.defineProperty(booted.log, 'healthy', { get: () => false }) })
    await pluginsManager.start()
    const way = windowWay(router, { editor })
    expect((await way.ask('editor', 'core.status')).result).toMatchObject({ logWrites: false })
  })

  it('answers the trusted window too and refuses a plugin, since the banner is the windows\' own', async () => {
    const { router, pluginsManager, runtime } = await joined({ folder: { alpha: filesFor(workerManifest('alpha')) } })
    await pluginsManager.start()
    const way = windowWay(router, { trusted: { kind: 'window', role: 'trusted', n: 1 } })
    expect((await way.ask('trusted', 'core.status')).ok).toBe(true)
    expect(code((await runtime.half('alpha').ask('core.status', {}))!)).toBe('not-granted')
  })
})

describe('the core\'s log through the joined core', () => {
  it('writes each call as audit.call through boot\'s event log and serves log.segments and log.verify to windows', async () => {
    const parts = await joined({
      folder: {
        alpha: filesFor(workerManifest('alpha', { provides: { actions: { hello: {} } } })),
        beta: filesFor(workerManifest('beta')),
      },
    })
    await parts.pluginsManager.start()
    await parts.pluginsManager.settled()
    const alpha = parts.runtime.half('alpha')
    const asked = parts.runtime.half('beta').ask('alpha.hello', {})
    await until(() => alpha.inbox.some(message => message.kind === 'call' && message.action === 'alpha.hello'))
    const delivered = alpha.inbox.find(message => message.kind === 'call' && message.action === 'alpha.hello')!
    alpha.send({ v: 1, kind: 'reply', callId: delivered.callId, ok: true, result: null })
    await asked
    await parts.recording.flush()
    const written = (await coreRecords(parts.dataDir)).filter(record => record.event === 'audit.call')
    expect(written.map(record => [record.action, record.caller, record.code])).toEqual([['alpha.hello', 'beta/worker#1', null]])
    const way = windowWay(parts.router, { editor: { kind: 'window', role: 'editor', n: 1 } })
    const history = await way.ask('editor', 'log.segments')
    expect(history).toMatchObject({ ok: true })
    expect((history.result as { segment: number, breaks: number[] }[]).at(-1)).toMatchObject({ breaks: [] })
    expect(await way.ask('editor', 'log.verify')).toMatchObject({ ok: true, result: { ok: true } })
  })
})

// The guard's policy job states end to end wait for #77, since core/api expects no guard on any action yet. Through the
// shipping wiring here, with the guards the plugins manager and the router both expect
describe('a guard down through the joined core', () => {
  const net: Listing = { files: filesFor(hostManifest('net')) }

  it.each([
    ['it fails its hash check', { ...net, hash: '0'.repeat(64) }, 'tampered'],
  ] as const)('stops hetu at start in the fail-safe when %s, no plugin starting and no write reaching the luoshu', async (_name, listing, reason) => {
    const luoshu = new FakeLuoshu()
    const parts = await joined({
      install: { ...coreInstall(), net: listing },
      folder: { alpha: filesFor(workerManifest('alpha')) },
      modules: { luoshu: luoshuModule(luoshu) },
      wire: { guardsFor: () => ['net'] },
      before: booted => {
        booted.state.switches = { ...booted.state.switches, limits: { all: { readyMs: 300 }, plugins: {} } }
      },
    })
    await parts.pluginsManager.start()
    await parts.pluginsManager.settled()
    expect(reasonOf(parts.pluginsManager, 'net')).toBe(reason)
    expect(parts.pluginsManager.stopped()).toEqual({ control: 'net', why: 'start-failed', reason: 'absent', again: false })
    expect(parts.runtime.order()).toEqual([])
    expect(luoshu.performed).toEqual([])
  })
})

// The plugins manager's grants snapshot into the gate module as it ships, for a folder plugin's calls
describe('the gate module on the joined core', () => {
  const read = { type: 'luoshu.read' as const, paths: ['notes/**'] }
  const write = { type: 'luoshu.write' as const, paths: ['notes/**'] }

  async function gated(entry: Partial<Plugin> = {}) {
    const luoshu = new FakeLuoshu()
    luoshu.files.set('notes/a.md', 'a note')
    const parts = await joined({
      folder: { alpha: filesFor(workerManifest('alpha', { capabilities: [read, write] })) },
      entries: { alpha: { granted: [read, write], ...entry } },
      modules: { gate: createGate(), luoshu: luoshuModule(luoshu) },
    })
    await parts.pluginsManager.start()
    await parts.pluginsManager.settled()
    return { ...parts, luoshu }
  }

  it('decides a plugin\'s calls on the grants in its entry, and an item the human switches off answers switched-off', async () => {
    const { pluginsManager, runtime } = await gated()
    const alpha = runtime.half('alpha')
    expect((await alpha.ask('luoshu.read', { path: 'notes/a.md' }))?.ok).toBe(true)
    expect(code((await alpha.ask('luoshu.read', { path: 'journal/a.md' }))!)).toBe('not-granted')
    await pluginsManager.apply({ kind: 'item.off', plugin: 'alpha', capability: read })
    expect(code((await alpha.ask('luoshu.read', { path: 'notes/a.md' }))!)).toBe('switched-off')
    expect((await alpha.ask('luoshu.write', { path: 'notes/a.md', text: 'x' }))?.ok).toBe(true)
  })

  it('keeps an item switched off in the entry off from the first grants snapshot', async () => {
    const { runtime } = await gated({ off: [read] })
    expect(code((await runtime.half('alpha').ask('luoshu.read', { path: 'notes/a.md' }))!)).toBe('switched-off')
  })

  it('fails the gate when it throws on a later grants snapshot, refusing calls with power from then on', async () => {
    const gate = createGate()
    const thrown = { on: false }
    const real = gate.stateChanged.bind(gate)
    gate.stateChanged = view => {
      if (thrown.on) throw new Error('a view it can\'t take')
      real(view)
    }
    const luoshu = new FakeLuoshu()
    luoshu.files.set('notes/a.md', 'a note')
    const parts = await joined({
      folder: { alpha: filesFor(workerManifest('alpha', { capabilities: [read] })) },
      entries: { alpha: { granted: [read] } },
      modules: { gate, luoshu: luoshuModule(luoshu) },
    })
    await parts.pluginsManager.start()
    await parts.pluginsManager.settled()
    expect((await parts.runtime.half('alpha').ask('luoshu.read', { path: 'notes/a.md' }))?.ok).toBe(true)
    thrown.on = true
    await parts.pluginsManager.apply({ kind: 'confirmOff', on: true })
    expect(parts.pluginsManager.policyJob('gate')).toBe('failed')
    expect(parts.modules.reason('gate')).toBe('state-changed')
    expect(code((await parts.runtime.half('alpha').ask('luoshu.read', { path: 'notes/a.md' }))!)).toBe('policy-down')
  })

  // D-646: the human switches alpha's read off while alpha writes, the router can't take the change, so the write its
  // grant still covers ends and alpha's call to its own action holds no power and runs on
  it('ends a plugin\'s open call with power policy-down with a fault when the router can\'t take a change, a call with no power running on', async () => {
    const luoshu = new FakeLuoshu()
    const subscribe = { type: 'events.subscribe' as const, topics: ['luoshu.changed'] }
    const parts = await joined({
      folder: { alpha: filesFor(workerManifest('alpha', { capabilities: [read, write, subscribe], provides: { actions: { hello: {} }, topics: ['changed'] } })) },
      entries: { alpha: { granted: [read, write, subscribe] } },
      modules: { gate: createGate(), luoshu: luoshuModule(luoshu) },
    })
    await parts.pluginsManager.start()
    await parts.pluginsManager.settled()
    const alpha = parts.runtime.half('alpha')
    expect((await alpha.ask('events.subscribe', { topics: ['luoshu.changed', 'alpha.changed'] }))?.result).toEqual({ standing: [] })
    let open!: () => void
    luoshu.hold.perform = new Promise<void>(resolve => { open = resolve })
    const writing = alpha.ask('luoshu.write', { path: 'notes/a.md', text: 'x' })
    await until(() => luoshu.performed.length === 1)
    const own = alpha.ask('alpha.hello', {})
    await until(() => alpha.inbox.some(message => message.kind === 'call' && message.action === 'alpha.hello'))
    parts.router.changed = () => { throw new Error('a change the router could not take') }
    await parts.pluginsManager.apply({ kind: 'item.off', plugin: 'alpha', capability: read })
    expect(luoshu.performed[0].call.signal?.aborted).toBe(true)
    open()
    expect(code((await writing)!)).toBe('policy-down')
    const ended = alpha.inbox.filter(message => message.kind === 'event' && message.topic === 'events.ended')
    expect(ended.map(message => message.topics)).toEqual([['luoshu.changed']])
    const delivered = alpha.inbox.find(message => message.kind === 'call' && message.action === 'alpha.hello')!
    expect(alpha.got('cancel')).toEqual([])
    alpha.send({ v: 1, kind: 'reply', callId: delivered.callId, ok: true, result: 'hello' })
    expect((await own)?.result).toBe('hello')
    await parts.recording.flush()
    expect((await coreRecords(parts.dataDir)).filter(record => record.event === 'fault')).toEqual([
      expect.objectContaining({ plugin: 'router', step: 'changed' }),
    ])
  })
})

// The real luoshu on a folder Obsidian and GitHub would also open, a plugin granted every dot folder by name
describe('dot folders through the joined core', () => {
  const scopes = ['.obsidian/**', '.github/**', 'notes/**', 'cfg/**']
  const granted = (['luoshu.read', 'luoshu.write', 'luoshu.list'] as const).map(type => ({ type, paths: scopes }))

  async function dotted(gate: 'on' | 'off') {
    const folder = path.join(await tempBase(), 'notes folder')
    await mkdir(path.join(folder, '.obsidian', 'plugins', 'x'), { recursive: true })
    await mkdir(path.join(folder, 'notes'), { recursive: true })
    await writeFile(path.join(folder, '.obsidian', 'plugins', 'x', 'main.js'), 'plugin code')
    await writeFile(path.join(folder, 'notes', 'a.md'), 'a note')
    await writeFile(path.join(folder, '.env'), 'secret')
    await symlink(path.join(folder, '.obsidian'), path.join(folder, 'cfg'), 'junction')
    open.push(() => rm(path.dirname(folder), { recursive: true, force: true }))
    const luoshu = createLuoshu()
    open.push(async () => luoshu.close())
    const parts = await joined({
      folder: { alpha: filesFor(workerManifest('alpha', { capabilities: granted })), zero: filesFor(workerManifest('zero')) },
      entries: { alpha: { granted } },
      modules: { gate: createGate(), luoshu },
      prepare: dataDir => new StateStore(dataDir).writeLuoshu({ folder }),
      before: booted => { if (gate === 'off') booted.state.switches.off = ['gate'] },
    })
    await parts.pluginsManager.start()
    await parts.pluginsManager.settled()
    return { ...parts, folder, alpha: parts.runtime.half('alpha'), zero: parts.runtime.half('zero') }
  }

  // The 8.3 short names Windows made in a folder, as dir /x shows them, none on another system or a volume that makes none
  async function shortNames(folder: string, names: string[]): Promise<string[]> {
    if (process.platform !== 'win32') return []
    const { stdout } = await promisify(execFile)('cmd.exe', ['/d', '/c', 'dir', '/x', '/a'], { cwd: folder })
    const lines = stdout.split(/\r?\n/).map(line => line.trimEnd())
    return names.flatMap(name => {
      const line = lines.find(found => found.endsWith(` ${name}`))
      const short = line?.slice(0, -name.length).trimEnd().split(/\s+/).at(-1)
      return short?.includes('~') ? [short] : []
    })
  }

  // What a reply tells its caller, without the ids that differ between calls
  const told = (reply: Message | null) => (reply === null ? null : reply.ok ? { ok: true, result: reply.result } : { ok: false, refusal: reply.refusal })

  it.each(['on', 'off'] as const)('refuses reads, writes and listings of a dot folder with the gate %s, invalid as spelled, with a link into one a missing name', async gate => {
    const { alpha, folder } = await dotted(gate)
    expect((await alpha.ask('luoshu.read', { path: 'notes/a.md' }))?.ok).toBe(true)
    for (const where of ['.obsidian/plugins/x/main.js', '.OBSIDIAN/plugins/x/main.js']) {
      expect(code((await alpha.ask('luoshu.read', { path: where }))!), where).toBe('invalid')
      expect(code((await alpha.ask('luoshu.write', { path: where, text: 'planted' }))!), where).toBe('invalid')
    }
    expect(code((await alpha.ask('luoshu.read', { path: 'cfg/plugins/x/main.js' }))!)).toBe('not-found')
    expect(code((await alpha.ask('luoshu.write', { path: 'cfg/plugins/x/main.js', text: 'planted' }))!)).toBe('not-granted')
    expect(code((await alpha.ask('luoshu.write', { path: '.github/workflows/x.yml', text: 'on: push' }))!)).toBe('invalid')
    expect(code((await alpha.ask('luoshu.write', { path: 'cfg/plugins/y/main.js', text: 'planted' }))!)).toBe('not-granted')
    // A vault in a subfolder has its own .obsidian
    expect(code((await alpha.ask('luoshu.write', { path: 'notes/.obsidian/plugins/x/main.js', text: 'planted' }))!)).toBe('invalid')
    expect(code((await alpha.ask('luoshu.list', { folder: '.obsidian' }))!)).toBe('invalid')
    expect(told(await alpha.ask('luoshu.list', { folder: 'cfg' }))).toEqual({ ok: true, result: { paths: [], next: null } })
    expect(await readFile(path.join(folder, '.obsidian', 'plugins', 'x', 'main.js'), 'utf8')).toBe('plugin code')
    expect(await exists(path.join(folder, '.github'))).toBe(false)
    expect(await exists(path.join(folder, '.obsidian', 'plugins', 'y'))).toBe(false)
    expect(await exists(path.join(folder, 'notes', '.obsidian'))).toBe(false)
  })

  // luoshu.list needs no grant, so a refusal for a name spelled with no dot would tell which dot names exist
  it.each(['on', 'off'] as const)('answers a plugin with no grant a listing of a link into a dot folder or a short name of a dot name as one of a missing folder, gate %s', async gate => {
    const { recording, zero, alpha, router, dataDir, folder } = await dotted(gate)
    const missing = told(await zero.ask('luoshu.list', { folder: 'nothing-here' }))
    expect(missing).toMatchObject({ ok: true, result: { paths: [] } })
    const aliases = ['cfg', 'cfg/plugins', ...await shortNames(folder, ['.obsidian', '.env'])]
    if (process.platform === 'win32') expect(aliases).toHaveLength(4)
    for (const alias of aliases) expect(told(await zero.ask('luoshu.list', { folder: alias })), alias).toEqual(missing)
    expect(code((await zero.ask('luoshu.list', { folder: '.obsidian' }))!)).toBe('invalid')
    // A granted read answers as for a missing note. The event log keeps the same record of both
    expect(told(await alpha.ask('luoshu.read', { path: 'cfg/plugins/x/main.js' }))).toEqual(told(await alpha.ask('luoshu.read', { path: 'notes/x/main.js' })))
    await recording.flush()
    // A record of either kind may stand for several calls through its count
    const kept = (await coreRecords(dataDir)).filter(record => record.event === 'audit.call' && String(record.action).startsWith('luoshu.'))
    const shapes = (action: string, code: string | null) => {
      const found = kept.filter(record => record.action === action && record.code === code)
      const shape = (record: Record<string, unknown>) => JSON.stringify([record.caller, record.gate, Object.keys(record.scope ?? {})])
      return { calls: found.reduce((sum, record) => sum + (record.count as number), 0), shapes: new Set(found.map(shape)).size }
    }
    expect(shapes('luoshu.list', null)).toEqual({ calls: aliases.length + 1, shapes: 1 })
    expect(shapes('luoshu.list', 'invalid')).toEqual({ calls: 1, shapes: 1 })
    expect(shapes('luoshu.read', 'not-found')).toEqual({ calls: 2, shapes: 1 })
    expect(kept.filter(record => record.action === 'luoshu.read' && record.code !== 'not-found')).toEqual([])
  })

  it('lists no dot file to a plugin granted the dot folders by name while the gate is on', async () => {
    const { alpha } = await dotted('on')
    const reply = await alpha.ask('luoshu.list', {})
    expect(reply?.ok).toBe(true)
    expect((reply!.result as { paths: string[] }).paths).toEqual(['notes/a.md'])
  })
})

describe('the windows\' own actions', () => {
  const editor = { kind: 'window' as const, role: 'editor' as const, n: 1 }
  const trusted = { kind: 'window' as const, role: 'trusted' as const, n: 1 }

  it('go to the runtime for opening the trusted window, Quit and Restart hetu, and the rest to the plugins manager', async () => {
    const served: string[] = []
    const { router, pluginsManager } = await joined({
      wire: { windows: { serve: async call => { served.push(call.action); return null }, armed: () => true } },
    })
    await pluginsManager.start()
    const way = windowWay(router, { editor, trusted })
    for (const action of ['app.openSecurity', 'app.quit']) expect((await way.ask('editor', action)).ok).toBe(true)
    expect((await way.ask('trusted', 'app.relaunch')).ok).toBe(true)
    expect((await way.ask('editor', 'editor.frame', { plugin: 'alpha', frame: 'board' })).ok).toBe(true)
    const url = 'hetu://views/0123456789abcdef0123456789abcdef/board.html'
    expect((await way.ask('editor', 'editor.frameGone', { url, navigated: true })).ok).toBe(true)
    expect(served).toEqual(['app.openSecurity', 'app.quit', 'app.relaunch', 'editor.frame', 'editor.frameGone'])
    expect((await way.ask('trusted', 'security.list')).ok).toBe(true)
  })

  it('count a Confirm only once the runtime says the trusted window armed', async () => {
    let armed = false
    const { router, pluginsManager } = await joined({ wire: { windows: { serve: async () => null, armed: () => armed } } })
    await pluginsManager.start()
    const way = windowWay(router, { editor, trusted })
    const reply = await way.ask('editor', 'security.request', { change: { kind: 'skipVerification', on: true } })
    const id = (reply.result as { held: string }).held
    expect((await way.ask('trusted', 'security.confirm', { requestId: id })).refusal).toMatchObject({ code: 'throttled' })
    armed = true
    expect((await way.ask('trusted', 'security.confirm', { requestId: id })).ok).toBe(true)
  })

  it('leave opening windows, Quit and Restart hetu unavailable with no runtime to serve them', async () => {
    const { router, pluginsManager } = await joined()
    await pluginsManager.start()
    const way = windowWay(router, { editor })
    expect((await way.ask('editor', 'app.quit')).refusal).toMatchObject({ code: 'unavailable' })
  })
})

describe('a failing log', () => {
  it('quits hetu to start it again once its oldest record waited logFailMs unwritten', async () => {
    const failures: unknown[] = []
    const { pluginsManager, runtime } = await joined({
      folder: { alpha: filesFor(workerManifest('alpha')) },
      before: booted => {
        booted.state.switches.limits.all.logFailMs = 100
        Object.defineProperty(booted.log, 'healthy', { get: () => false })
        booted.log.appendMany = async () => { throw new Error('disk full') }
      },
      wire: { onFailure: failure => { failures.push(failure) } },
    })
    await pluginsManager.start()
    await runtime.half('alpha').ask('luoshu.read', { path: 'notes/a.md' })
    await new Promise(resolve => setTimeout(resolve, 150))
    await runtime.half('alpha').ask('luoshu.read', { path: 'notes/b.md' })
    await until(() => failures.length > 0)
    expect(failures).toEqual([{ action: 'relaunch', control: 'log', reason: 'log-failing' }])
  })
})

// #101: every switch keeps this design's fail-safe default and none has an
// off state of its own. What a call answers with each core module switched off, through the joined core, mostly
// against a gate that refuses everything, so a call that passes shows the gate was skipped
describe('the off states', () => {
  // The time each core joined here may take. Starting one took up to about 5 s on a shared Windows runner against
  // vitest's 5 s, so each gets four times that
  const JOIN_MS = 20_000
  async function switchedOff(off: string[], decides: 'refuses' | 'item-off' | 'allows' = 'refuses') {
    const luoshu = new FakeLuoshu()
    luoshu.files.set('notes/a.md', 'x')
    const gate = gateDeciding((_access, view) => decides === 'allows'
      ? { allow: true, view }
      : { allow: false, code: decides === 'item-off' ? 'switched-off' : 'not-granted', view })
    const parts = await joined({
      folder: { alpha: filesFor(workerManifest('alpha')) },
      modules: { gate, luoshu: luoshuModule(luoshu) },
      before: booted => { booted.state.switches.off = off as typeof booted.state.switches.off },
    })
    await parts.pluginsManager.start()
    await parts.pluginsManager.settled()
    return parts
  }
  const read = async (parts: Awaited<ReturnType<typeof switchedOff>>) => {
    const reply = await parts.runtime.half('alpha').ask('luoshu.read', { path: 'notes/a.md' })
    return reply?.ok === true ? 'passes' : code(reply!)
  }

  it.each([
    ['nothing switched off: the gate decides', [], 'not-granted'],
    ['the gate: a call with power passes, still recorded', ['gate'], 'passes'],
    ['the gate and the luoshu: unavailable, since no switch gives a power the framework lacks', ['gate', 'luoshu'], 'unavailable'],
  ])('with %s', async (_name, off, answer) => {
    expect(await read(await switchedOff(off))).toBe(answer)
  }, JOIN_MS)

  // The gate is asked first, so the luoshu's own state shows once the gate allows
  it('with the luoshu: its calls answer unavailable once the gate allowed them', async () => {
    expect(await read(await switchedOff(['luoshu'], 'allows'))).toBe('unavailable')
  }, JOIN_MS)

  // Decision 12: allowing all means all, so a per-item switch lapses while the gate is off
  it('lets the per-item switches lapse with the gate off', async () => {
    expect(await read(await switchedOff([], 'item-off'))).toBe('switched-off')
    expect(await read(await switchedOff(['gate'], 'item-off'))).toBe('passes')
  }, 2 * JOIN_MS)

  it('records the call that passed with the gate off', async () => {
    const parts = await switchedOff(['gate'])
    await read(parts)
    await parts.recording.flush()
    const records = await coreRecords(parts.dataDir)
    expect(records.filter(record => record.event === 'audit.call' && record.action === 'luoshu.read')).toMatchObject([{ gate: 'off', code: null }])
  }, JOIN_MS)
})

// The real http host runs through the SDK on the fake runtime's port and mcp is a plugin-folder worker holding
// door.handle the test answers for, approved unsigned by its hash. A request through a seam that names a client reaches
// mcp as door.handle from http's host half on behalf of that client
describe('the door through the joined core', () => {
  const callMcp = { type: 'plugin.call' as const, targets: ['mcp'] }
  const role = { type: 'door.handle' as const }
  const seam = (text: string | null) => (text === 'Bearer good-token' ? { client: 'https://client.example/metadata#1' } : null)

  async function freePort(): Promise<number> {
    const server = net.createServer()
    await new Promise<void>(resolve => server.listen({ host: '127.0.0.1', port: 0 }, resolve))
    const { port } = server.address() as AddressInfo
    await new Promise(resolve => server.close(resolve))
    return port
  }

  function post(port: number, body: string): Promise<{ status: number, body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/mcp', agent: false,
        headers: { Authorization: 'Bearer good-token', 'Mcp-Session-Id': 's-1', 'Content-Length': String(Buffer.byteLength(body)) },
      }, res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  const canConnect = (port: number) => new Promise<boolean>(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })

  // How mcp sits in the plugin folder: approved unsigned by its hash, unsigned with no allowUnsigned naming its hash, or
  // carrying the first-party signer an older build wrote with its hash approved
  type McpAs = 'approved' | 'unsigned' | 'first-party-signer'

  async function door(mcpAs: McpAs = 'approved') {
    const port = await freePort()
    // The gate's own decisions, so a test can tell a refusal at the gate from one at the action's from list
    const gate = createGate()
    const decisions: { caller: string, target: string | undefined, allow: boolean }[] = []
    const decide = gate.decide.bind(gate)
    gate.decide = access => {
      const decision = decide(access)
      if (access.caller.kind === 'plugin') decisions.push({ caller: access.caller.id, target: access.scope.target, allow: 'allow' in decision && decision.allow })
      return decision
    }
    const parts = await joined({
      install: {
        ...coreInstall(),
        'mcp-http-handler': { files: filesFor(hostManifest('mcp-http-handler')) },
      },
      folder: {
        beta: filesFor(workerManifest('beta', { capabilities: [callMcp] })),
        mcp: filesFor(workerManifest('mcp', { capabilities: [role] })),
      },
      entries: { beta: { granted: [callMcp] }, mcp: { granted: [role], signer: mcpAs === 'first-party-signer' ? 'hetu first-party' : null } },
      prepare: async dataDir => {
        const allowUnsigned = [await hashOf(path.join(dataDir, 'plugins', 'beta'))]
        if (mcpAs !== 'unsigned') allowUnsigned.push(await hashOf(path.join(dataDir, 'plugins', 'mcp')))
        await new StateStore(dataDir).writeSwitches({ ...defaultSwitches(), allowUnsigned })
      },
      modules: { gate },
      behave: {
        'mcp-http-handler': {
          utility: start => {
            const port_ = start.port as MessagePort
            run(httpPlugin({ port, token: seam }), { post: message => port_.postMessage(message), listen: next => { port_.on('message', next) } })
          },
        },
      },
    })
    await parts.pluginsManager.start()
    await parts.pluginsManager.settled()
    return { ...parts, port, decisions }
  }

  it('hands a request that passed to the folder mcp as http\'s host half on behalf of the seam\'s client', async () => {
    const { pluginsManager, runtime, port } = await door()
    expect(pluginsManager.plugin('mcp-http-handler')).toMatchObject({ state: 'ready', place: 'utility' })
    expect(pluginsManager.plugin('mcp')).toMatchObject({ state: 'ready' })
    const mcp = runtime.half('mcp')
    const asked = post(port, 'not json {')
    await until(() => mcp.inbox.some(message => message.kind === 'call' && message.action === 'door.handle'), 5000)
    const delivered = mcp.inbox.find(message => message.kind === 'call' && message.action === 'door.handle')!
    expect(delivered.caller).toEqual({ kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 1 })
    expect(delivered.onBehalf).toBe('https://client.example/metadata#1')
    expect(delivered.args).toEqual({ body: 'not json {', headers: { 'mcp-session-id': 's-1' } })
    mcp.send({ v: 1, kind: 'reply', callId: delivered.callId, ok: true, result: { status: 200, body: '{"jsonrpc":"2.0"}' } })
    expect(await asked).toEqual({ status: 200, body: '{"jsonrpc":"2.0"}' })
  })

  it.each([
    ['unsigned', 'unsigned'],
    ['first-party-signer', 'signer'],
  ] as const)('keeps the door shut while the folder mcp held %s is refused %s', async (mcpAs, reason) => {
    const { pluginsManager, runtime, port } = await door(mcpAs)
    expect(pluginsManager.plugin('mcp-http-handler')).toMatchObject({ state: 'ready', place: 'utility' })
    expect(reasonOf(pluginsManager, 'mcp')).toBe(reason)
    expect(pluginsManager.plugin('mcp')).toMatchObject({ state: 'refused' })
    await tick(200)
    expect(await canConnect(port)).toBe(false)
    expect(() => runtime.half('mcp')).toThrow()
  })

  // The human's own changes as the trusted window hands them to the plugins manager: mcp switched off, and its hash
  // taken off allowUnsigned, which refuses it unsigned
  const trusted = { kind: 'window' as const, role: 'trusted' as const, n: 1 }
  it.each([
    ['switched off', 'off', async () => ({ kind: 'plugin.off' as const, plugin: 'mcp' })],
    ['refused once its hash leaves allowUnsigned', 'refused', async (dataDir: string) => ({
      kind: 'allowUnsigned' as const, hash: await hashOf(path.join(dataDir, 'plugins', 'mcp')), on: false,
    })],
  ] as const)('closes the open door once the folder mcp is %s', async (_what, state, change) => {
    const { pluginsManager, port, dataDir } = await door()
    await until(() => pluginsManager.plugin('mcp')?.state === 'ready')
    let open = false
    for (let waited = 0; !open && waited < 2000; waited += 20) {
      open = await canConnect(port)
      if (!open) await tick(20)
    }
    expect(open).toBe(true)
    expect(await pluginsManager.request(await change(dataDir), trusted)).toEqual({ applied: true })
    await pluginsManager.settled()
    expect(pluginsManager.plugin('mcp')).toMatchObject({ state })
    let shut = false
    for (let waited = 0; !shut && waited < 2000; waited += 20) {
      shut = !(await canConnect(port))
      if (!shut) await tick(20)
    }
    expect(shut).toBe(true)
  })

  // The floor admits only a utility half's call to the role, so neither a grant on mcp nor mcp's own action reaches it
  it('refuses another plugin\'s worker holding plugin.call on mcp at door.handle\'s floor, the gate never asked', async () => {
    const { runtime, decisions } = await door()
    const reply = await runtime.half('beta').ask('door.handle', { body: '{}', headers: {} }, 1000, { onBehalf: 'claude-code#1' })
    expect(code(reply!)).toBe('not-granted')
    expect(code((await runtime.half('beta').ask('mcp.handle', { body: '{}', headers: {} }))!)).toBe('not-found')
    expect(decisions.filter(decision => decision.caller === 'beta' && decision.target === undefined)).toEqual([])
    expect(runtime.half('mcp').inbox.filter(message => message.kind === 'call')).toEqual([])
  })
})
