import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Access } from '../api/slots.ts'
import { boot, type Booted } from '../backend/boot/boot.ts'
import { defaultSwitches, StateStore, type Plugin } from '../backend/boot/state.ts'
import type { CarrierLink } from '../backend/loader/seams.ts'
import { LinkToCarrier, wireCore, type WireOptions } from '../backend/wire.ts'
import { createGate } from '../../plugins/gate/src/gate.ts'
import { code, FakeStorage, FakeLuoshu, windowWay, worker } from './carrier-fakes.ts'
import {
  allowAll, coreInstall, entryFor, FakeRuntime, filesFor, hostManifest, reasonOf, tempBase, workerManifest, writeFolder,
  writeInstall, type Files, type Listing, type Message,
} from './loader-fakes.ts'

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
// fixtures and the fake runtime. before runs on the booted core before anything starts
async function joined(options: {
  install?: Record<string, Listing>
  folder?: Record<string, Files>
  // More for a folder plugin's approved entry, its grants and switches
  entries?: Record<string, Partial<Plugin>>
  behave?: FakeRuntime['behave']
  before?: (booted: Booted) => void
  // Runs on the data folder before boot reads it
  prepare?: (dataDir: string) => Promise<void>
  wire?: Pick<WireOptions, 'guardsFor' | 'debug' | 'asks' | 'windows' | 'onFailure'>
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
    await store.writePlugin(id, await entryFor(root, options.entries?.[id]))
  }
  await options.prepare?.(dataDir)
  const booted = await boot({ packaged: false, installDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
  options.before?.(booted)
  const runtime = new FakeRuntime()
  runtime.behave = options.behave ?? {}
  const { loader, carrier } = wireCore({ booted, installDir, runtime, confirmDelayMs: 0, ...options.wire })
  open.push(async () => {
    await loader.shutdown().catch(() => {})
    // Quit's order: close writes its last counts and starts a drain, which must land before the lock goes. Windows
    // also won't remove a folder a write is still filling
    carrier.close()
    await carrier.flush()
    for (const port of runtime.ports) port.close()
    await booted.release()
    await rm(base, { recursive: true, force: true })
  })
  return { loader, carrier, runtime, booted, dataDir, installDir }
}

// The records the floor lane wrote to the boot's event log, in order, each with its fields
async function floorRecords(dataDir: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path.join(dataDir, 'events', 'events-1.jsonl'), 'utf8')
  return text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

async function floorEvents(dataDir: string): Promise<string[]> {
  return (await floorRecords(dataDir)).map(record => record.event as string)
}

// A gate built on the fixtures' allow-all one, deciding with decide while it keeps the StateView it was given
function gateDeciding(decide: (access: Access, view: number) => unknown) {
  const gate = allowAll()
  return Object.assign(gate, { decide: (access: Access) => decide(access, gate.views.at(-1) ?? 0) })
}

describe('wiring the core', () => {
  it('builds link, loader and carrier so the loader reaches the real carrier', async () => {
    const { carrier, loader, dataDir } = await joined()
    await loader.start()
    await carrier.flush()
    const events = await floorEvents(dataDir)
    expect(events).toContain('install.checked')
    expect(events).toContain('plugin.started')
    expect(carrier.limit('gate', 'readyMs')).toBe(10000)
    // The carrier keeps no import of the loader, so the typecheck proves here that it gives the loader all it needs
    const asLink: CarrierLink = carrier
    expect(asLink).toBe(carrier)
  })

  it('ends its start with core.ready, which holds every slot\'s state', async () => {
    const { carrier, loader, dataDir } = await joined()
    await loader.start()
    await carrier.flush()
    const records = await floorRecords(dataDir)
    expect(records.filter(record => record.event === 'core.ready')).toHaveLength(1)
    expect(records.at(-1)).toMatchObject({ event: 'core.ready', gate: 'on', capabilities: 'absent', watchdog: 'absent' })
    expect(records.at(-1)).not.toHaveProperty('log')
  })

  it('writes no core.ready when shutdown began during the start', async () => {
    const { carrier, loader, dataDir } = await joined()
    const started = loader.start()
    await loader.shutdown()
    await started
    await carrier.flush()
    expect(await floorEvents(dataDir)).not.toContain('core.ready')
  })

  it('refuses a link call made before the carrier exists', () => {
    const link = new LinkToCarrier()
    expect(() => link.send(worker('search'), { v: 1, kind: 'ping' })).toThrow('carrier')
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
      behave: { gate: { exports: { gate } } },
    })
    await parts.loader.start()
    await parts.loader.settled()
    return { ...parts, gate }
  }

  const events = (messages: Message[], topic: string) =>
    messages.filter(message => message.kind === 'event' && message.topic === topic)

  it('starts a verified plugin through the real carrier: init, deps, then ready', async () => {
    const { loader, runtime } = await lives()
    const alpha = runtime.half('alpha')
    expect(alpha.got('init')).toHaveLength(1)
    expect(alpha.got('init')[0]).toMatchObject({ v: 1, kind: 'init', id: 'alpha', incarnation: 1, deps: {} })
    // A dependent learns its requirements' states in its init
    expect(runtime.half('beta').got('init')[0]).toMatchObject({ kind: 'init', id: 'beta', deps: { alpha: 'ready' } })
    expect(loader.plugin('alpha')?.state).toBe('ready')
    expect(loader.plugin('beta')?.state).toBe('ready')
  })

  it('takes its call through the eleven steps and records it', async () => {
    const { carrier, dataDir, runtime } = await lives()
    const alpha = runtime.half('alpha')
    const asked = runtime.half('beta').ask('alpha.hello', { name: 'beta' })
    await until(() => alpha.inbox.some(message => message.kind === 'call' && message.action === 'alpha.hello'))
    const delivered = alpha.inbox.find(message => message.kind === 'call' && message.action === 'alpha.hello')!
    expect(delivered.caller).toEqual(worker('beta'))
    alpha.send({ v: 1, kind: 'reply', callId: delivered.callId, ok: true, result: 'hello beta' })
    expect((await asked)?.result).toBe('hello beta')
    await carrier.flush()
    const records = (await floorRecords(dataDir)).filter(record => record.event === 'audit.call' && record.action === 'alpha.hello')
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
    const { loader, runtime } = await lives()
    const alpha = runtime.half('alpha')
    const first = runtime.half('beta')
    await first.ask('events.subscribe', { topics: ['alpha.changed'] })
    await alpha.ask('events.publish', { topic: 'alpha.changed' })
    await until(() => events(first.inbox, 'alpha.changed').length === 1)
    await loader.stop('beta', 'human')
    await loader.restart('beta', 'human')
    await until(() => loader.plugin('beta')?.state === 'ready')
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
    const { carrier, loader, runtime } = await lives()
    const alpha = runtime.half('alpha')
    await alpha.ask('events.subscribe', { topics: ['gamma.changed'] })
    alpha.crash()
    await until(() => loader.plugin('alpha')?.state === 'crashed')
    expect(loader.plugin('beta')?.state).toBe('waiting')
    await runtime.half('gamma').ask('events.publish', { topic: 'gamma.changed' })
    await tick(30)
    expect(events(alpha.inbox, 'gamma.changed')).toEqual([])
    await loader.restart('alpha', 'human')
    await until(() => loader.plugin('alpha')?.state === 'ready')
    const second = runtime.half('alpha', 2)
    // A message for the dead incarnation reaches nothing, the new one included
    carrier.send(worker('alpha', 1), { v: 1, kind: 'stop', graceMs: 3000 })
    await tick(30)
    expect(second.got('stop')).toEqual([])
    expect(alpha.closed).toBe(true)
  })

  it('restarts it as a new incarnation that starts with no subscriptions or credits', async () => {
    const { loader, runtime } = await lives()
    await runtime.half('alpha').ask('events.subscribe', { topics: ['gamma.changed'] })
    runtime.half('alpha').crash()
    await until(() => loader.plugin('alpha')?.state === 'crashed')
    await loader.restart('alpha', 'human')
    await until(() => loader.plugin('alpha')?.state === 'ready' && loader.plugin('beta')?.state === 'ready')
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

  // The reconcile copies a bundled first-party plugin only once its record is on disk, through the real floor lane
  it('holds a first-party copy back until its record landed', async () => {
    let failing = true
    const { carrier, loader, dataDir } = await joined({
      install: { ...coreInstall(), git: { files: filesFor(workerManifest('git')), firstParty: true } },
      before: booted => {
        const append = booted.log.append.bind(booted.log)
        booted.log.append = async (event, fields) => {
          if (failing) throw new Error('disk full')
          return append(event, fields)
        }
        Object.defineProperty(booted.log, 'healthy', { get: () => !failing, configurable: true })
      },
    })
    const started = loader.start()
    await tick(100)
    expect(await exists(path.join(dataDir, 'plugins', 'git'))).toBe(false)
    expect(loader.plugin('git')).toBe(null)
    failing = false
    await carrier.flush()
    await started
    await loader.settled()
    expect(await exists(path.join(dataDir, 'plugins', 'git'))).toBe(true)
    expect(loader.plugin('git')?.state).toBe('ready')
  })
})

// Shutdown stops sandboxed plugins in reverse graph order, then host plugins in reverse with the log last. A plugin in
// its stop grace can still save, so the host plugins it needs serve until their own turn
describe('shutdown through the joined core', () => {
  async function quitting(options: { alphaHolds?: boolean } = {}) {
    const storage = new FakeStorage()
    const parts = await joined({
      install: { ...coreInstall(), storage: { files: filesFor(hostManifest('storage')) } },
      folder: { alpha: filesFor(workerManifest('alpha')) },
      behave: {
        gate: { exports: { gate: allowAll() } },
        storage: { exports: { provider: storage } },
        alpha: { stopped: options.alphaHolds !== true },
      },
    })
    await parts.loader.start()
    await parts.loader.settled()
    return { ...parts, storage }
  }

  it('keeps host-level plugins serving while sandboxed plugins stop for shutdown', async () => {
    const { loader, runtime, storage } = await quitting({ alphaHolds: true })
    const alpha = runtime.half('alpha')
    const shutdown = loader.shutdown()
    await until(() => alpha.got('stop').length === 1)
    expect(loader.slot('gate')).toBe('on')
    expect((await alpha.ask('storage.set', { key: 'draft', value: 'last words' }))?.ok).toBe(true)
    alpha.send({ v: 1, kind: 'stopped' })
    await shutdown
    expect([...storage.values.values()]).toContain('last words')
  })

  it('records no slot as failed when shutdown stops it', async () => {
    const { carrier, dataDir, loader } = await quitting()
    await loader.shutdown()
    await carrier.flush()
    const records = await floorRecords(dataDir)
    const after = records.slice(records.findIndex(record => record.event === 'core.stopping'))
    const slots = after.filter(record => record.event === 'slot.state')
    expect(slots.map(record => [record.slot, record.state])).toEqual([['gate', 'stopped']])
  })

  it('records a host slot that fails during shutdown, before its own stop, as failed', async () => {
    const { carrier, dataDir, loader, runtime } = await quitting({ alphaHolds: true })
    const alpha = runtime.half('alpha')
    const shutdown = loader.shutdown()
    await until(() => alpha.got('stop').length === 1)
    // What the carrier tells the loader when a host half floods its way
    loader.crashed({ kind: 'plugin', id: 'gate', half: 'host', incarnation: 1 }, 'flood')
    await until(() => loader.slot('gate') === 'failed')
    alpha.send({ v: 1, kind: 'stopped' })
    await shutdown
    await carrier.flush()
    const records = await floorRecords(dataDir)
    const after = records.slice(records.findIndex(record => record.event === 'core.stopping'))
    const slots = after.filter(record => record.event === 'slot.state')
    expect(slots.map(record => [record.slot, record.state])).toEqual([['gate', 'failed']])
  })

  it('keeps the audit queue through shutdown and writes it on the flush after close', async () => {
    const { carrier, dataDir, loader, runtime } = await quitting({ alphaHolds: true })
    const alpha = runtime.half('alpha')
    expect((await alpha.ask('storage.set', { key: 'draft', value: 'one' }))?.ok).toBe(true)
    const shutdown = loader.shutdown()
    await until(() => alpha.got('stop').length === 1)
    expect((await alpha.ask('storage.set', { key: 'draft', value: 'two' }))?.ok).toBe(true)
    alpha.send({ v: 1, kind: 'stopped' })
    await shutdown
    carrier.close()
    await carrier.flush()
    const records = await floorRecords(dataDir)
    expect(records.filter(record => record.event === 'audit.call' && record.action === 'storage.set')).toHaveLength(2)
    expect(records.filter(record => record.event === 'audit.dropped')).toEqual([])
  })

  // The Confirm behind it already landed, so a narrowing confirmed just before Quit must outlast the run
  it('keeps a security change applied while shutdown runs', async () => {
    const { dataDir, loader, runtime } = await quitting({ alphaHolds: true })
    const alpha = runtime.half('alpha')
    const shutdown = loader.shutdown()
    await until(() => alpha.got('stop').length === 1)
    await loader.apply({ kind: 'plugin.off', plugin: 'alpha' })
    alpha.send({ v: 1, kind: 'stopped' })
    await shutdown
    expect((await new StateStore(dataDir).load()).state.plugins.alpha.enabled).toBe(false)
  })

  it('refuses an update once shutdown began', async () => {
    const { installDir, loader } = await quitting()
    await loader.shutdown()
    await expect(loader.update('alpha', installDir)).rejects.toMatchObject({ code: 'stopped' })
  })
})

// The carrier must ask the same guards the loader expects and report where the loader's options say
describe('what wireCore hands the carrier', () => {
  async function writing(wire: Pick<WireOptions, 'guardsFor' | 'debug' | 'asks'>, gate = allowAll()) {
    const luoshu = new FakeLuoshu()
    const parts = await joined({
      install: { ...coreInstall(), luoshu: { files: filesFor(hostManifest('luoshu')) } },
      folder: { alpha: filesFor(workerManifest('alpha')) },
      behave: { gate: { exports: { gate } }, luoshu: { exports: { provider: luoshu, luoshu: { open() {} } } } },
      wire,
    })
    await parts.loader.start()
    await parts.loader.settled()
    return { ...parts, luoshu }
  }

  it('makes the carrier ask the guards the loader expects, so a missing one refuses the write', async () => {
    const { runtime, luoshu } = await writing({ guardsFor: () => ['leases'] })
    const reply = await runtime.half('alpha').ask('luoshu.write', { path: 'notes/a.md', text: 'x' })
    expect(code(reply!)).toBe('guard-down')
    expect(luoshu.performed).toEqual([])
  })

  it('hands the carrier the debug sink for a gate that throws', async () => {
    const debug: { plugin: string | null }[] = []
    const gate = gateDeciding(() => { throw new Error('broken') })
    const { runtime } = await writing({ debug: entry => { debug.push(entry) } }, gate)
    expect(code((await runtime.half('alpha').ask('luoshu.read', { path: 'notes/a.md' }))!)).toBe('policy-down')
    expect(debug.map(entry => entry.plugin)).toContain('gate')
  })

  it('hands the carrier the asks that raise a gate\'s prompt', async () => {
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

  it('answers a window with the slots, the plugins crashed and not restarted, the switches that weaken and the luoshu folder', async () => {
    const { carrier, loader, runtime } = await joined({ folder: { alpha: filesFor(workerManifest('alpha')) } })
    await loader.start()
    const way = windowWay(carrier, { editor })
    const reply = await way.ask('editor', 'core.status')
    expect(reply).toMatchObject({ ok: true })
    expect(reply.result).toEqual({
      slots: { gate: 'on', capabilities: 'absent', watchdog: 'absent' },
      crashed: [],
      devMode: [],
      allowUnsigned: 0,
      skipVerification: false,
      recordNothing: false,
      logWrites: true,
      luoshuPicked: false,
      page: [],
      pending: [],
      stopped: null,
      suspect: [],
    })
    runtime.half('alpha').crash()
    await until(() => loader.plugin('alpha')?.state === 'crashed')
    expect((await way.ask('editor', 'core.status')).result).toMatchObject({ crashed: ['alpha'] })
  })

  it('names the switches when they are gone from a data folder hetu ran in before', async () => {
    const { carrier, loader } = await joined({
      // A first start leaves its records, then the switches go
      prepare: async dataDir => {
        const first = await boot({ packaged: false, installDir: dataDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
        await first.release()
        await rm(path.join(dataDir, 'state', 'switches.json'))
      },
    })
    await loader.start()
    const way = windowWay(carrier, { editor })
    expect((await way.ask('editor', 'core.status')).result).toMatchObject({ suspect: ['switches'] })
  })

  it('names the requests waiting for the human, a plugin found in the folder among them', async () => {
    const { carrier, loader, dataDir } = await joined()
    await writeFolder(path.join(dataDir, 'plugins', 'beta'), filesFor(workerManifest('beta')))
    await loader.start()
    const way = windowWay(carrier, { editor })
    expect((await way.ask('editor', 'core.status')).result).toMatchObject({ pending: [{ kind: 'plugin.approve', plugin: 'beta' }] })
  })

  it('says the log can\'t write while boot\'s event log is failing', async () => {
    const { carrier, loader } = await joined({ before: booted => Object.defineProperty(booted.log, 'healthy', { get: () => false }) })
    await loader.start()
    const way = windowWay(carrier, { editor })
    expect((await way.ask('editor', 'core.status')).result).toMatchObject({ logWrites: false })
  })

  it('answers the trusted window too and refuses a plugin, since the banner is the windows\' own', async () => {
    const { carrier, loader, runtime } = await joined({ folder: { alpha: filesFor(workerManifest('alpha')) } })
    await loader.start()
    const way = windowWay(carrier, { trusted: { kind: 'window', role: 'trusted', n: 1 } })
    expect((await way.ask('trusted', 'core.status')).ok).toBe(true)
    expect(code((await runtime.half('alpha').ask('core.status', {}))!)).toBe('not-granted')
  })
})

describe('the core\'s log through the joined core', () => {
  it('writes each call as audit.call through boot\'s event log and serves log.history and log.verify to windows', async () => {
    const parts = await joined({
      folder: {
        alpha: filesFor(workerManifest('alpha', { provides: { actions: { hello: {} } } })),
        beta: filesFor(workerManifest('beta')),
      },
      behave: { gate: { exports: { gate: allowAll() } } },
    })
    await parts.loader.start()
    await parts.loader.settled()
    const alpha = parts.runtime.half('alpha')
    const asked = parts.runtime.half('beta').ask('alpha.hello', {})
    await until(() => alpha.inbox.some(message => message.kind === 'call' && message.action === 'alpha.hello'))
    const delivered = alpha.inbox.find(message => message.kind === 'call' && message.action === 'alpha.hello')!
    alpha.send({ v: 1, kind: 'reply', callId: delivered.callId, ok: true, result: null })
    await asked
    await parts.carrier.flush()
    const written = (await floorRecords(parts.dataDir)).filter(record => record.event === 'audit.call')
    expect(written.map(record => [record.action, record.caller, record.code])).toEqual([['alpha.hello', 'beta/worker#1', null]])
    const way = windowWay(parts.carrier, { editor: { kind: 'window', role: 'editor', n: 1 } })
    const history = await way.ask('editor', 'log.history')
    expect(history).toMatchObject({ ok: true })
    expect((history.result as { segment: number, breaks: number[] }[]).at(-1)).toMatchObject({ breaks: [] })
    expect(await way.ask('editor', 'log.verify')).toMatchObject({ ok: true, result: { ok: true } })
  })
})

// The guard's slot states end to end wait for #77, since core/api expects no guard on any action yet. Through the
// shipping wiring here, with the guards the loader and the carrier both expect
describe('a guard down through the joined core', () => {
  const leases: Listing = { files: filesFor(hostManifest('leases')) }

  it.each([
    ['its module throws', leases, { leases: { throws: true } }, 'start-failed'],
    ['its start never answers', leases, { leases: { ready: false } }, 'start-timeout'],
    ['it fails its hash check', { ...leases, hash: '0'.repeat(64) }, {}, 'tampered'],
  ] as const)('refuses the writes it guards with guard-down when %s', async (_name, listing, behave, reason) => {
    const luoshu = new FakeLuoshu()
    const parts = await joined({
      install: { ...coreInstall(), luoshu: { files: filesFor(hostManifest('luoshu')) }, leases: listing },
      folder: { alpha: filesFor(workerManifest('alpha')) },
      behave: { gate: { exports: { gate: allowAll() } }, luoshu: { exports: { provider: luoshu, luoshu: { open() {} } } }, ...behave },
      wire: { guardsFor: () => ['leases'] },
      before: booted => {
        booted.state.switches = { ...booted.state.switches, limits: { all: { readyMs: 300 }, plugins: {} } }
      },
    })
    await parts.loader.start()
    await parts.loader.settled()
    expect(reasonOf(parts.loader, 'leases')).toBe(reason)
    const reply = await parts.runtime.half('alpha').ask('luoshu.write', { path: 'notes/a.md', text: 'x' })
    expect(code(reply!)).toBe('guard-down')
    expect(luoshu.performed).toEqual([])
  })
})

// The loader's StateView into the gate plugin as it ships, for a folder plugin's calls
describe('the gate plugin on the joined core', () => {
  const read = { type: 'luoshu.read' as const, paths: ['notes/**'] }
  const write = { type: 'luoshu.write' as const, paths: ['notes/**'] }

  async function gated(entry: Partial<Plugin> = {}) {
    const luoshu = new FakeLuoshu()
    luoshu.files.set('notes/a.md', 'a note')
    const parts = await joined({
      install: { ...coreInstall(), luoshu: { files: filesFor(hostManifest('luoshu')) } },
      folder: { alpha: filesFor(workerManifest('alpha', { capabilities: [read, write] })) },
      entries: { alpha: { granted: [read, write], ...entry } },
      behave: { gate: { exports: { gate: createGate() } }, luoshu: { exports: { provider: luoshu, luoshu: { open() {} } } } },
    })
    await parts.loader.start()
    await parts.loader.settled()
    return { ...parts, luoshu }
  }

  it('decides a plugin\'s calls on the grants in its entry, and an item the human switches off answers switched-off', async () => {
    const { loader, runtime } = await gated()
    const alpha = runtime.half('alpha')
    expect((await alpha.ask('luoshu.read', { path: 'notes/a.md' }))?.ok).toBe(true)
    expect(code((await alpha.ask('luoshu.read', { path: 'journal/a.md' }))!)).toBe('not-granted')
    await loader.apply({ kind: 'item.off', plugin: 'alpha', capability: read })
    expect(code((await alpha.ask('luoshu.read', { path: 'notes/a.md' }))!)).toBe('switched-off')
    expect((await alpha.ask('luoshu.write', { path: 'notes/a.md', text: 'x' }))?.ok).toBe(true)
  })

  it('keeps an item switched off in the entry off from the first StateView', async () => {
    const { runtime } = await gated({ off: [read] })
    expect(code((await runtime.half('alpha').ask('luoshu.read', { path: 'notes/a.md' }))!)).toBe('switched-off')
  })

  it('fails the gate when it throws on a later StateView, refusing calls with power from then on', async () => {
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
      install: { ...coreInstall(), luoshu: { files: filesFor(hostManifest('luoshu')) } },
      folder: { alpha: filesFor(workerManifest('alpha', { capabilities: [read] })) },
      entries: { alpha: { granted: [read] } },
      behave: { gate: { exports: { gate } }, luoshu: { exports: { provider: luoshu, luoshu: { open() {} } } } },
    })
    await parts.loader.start()
    await parts.loader.settled()
    expect((await parts.runtime.half('alpha').ask('luoshu.read', { path: 'notes/a.md' }))?.ok).toBe(true)
    thrown.on = true
    await parts.loader.apply({ kind: 'confirmOff', on: true })
    expect(parts.loader.slot('gate')).toBe('failed')
    expect(reasonOf(parts.loader, 'gate')).toBe('state-changed')
    expect(code((await parts.runtime.half('alpha').ask('luoshu.read', { path: 'notes/a.md' }))!)).toBe('policy-down')
  })
})

describe('the windows\' own actions', () => {
  const editor = { kind: 'window' as const, role: 'editor' as const, n: 1 }
  const trusted = { kind: 'window' as const, role: 'trusted' as const, n: 1 }

  it('go to the runtime for opening the trusted window, Quit and Restart hetu, and the rest to the loader', async () => {
    const served: string[] = []
    const { carrier, loader } = await joined({
      wire: { windows: { serve: async call => { served.push(call.action); return null }, armed: () => true } },
    })
    await loader.start()
    const way = windowWay(carrier, { editor, trusted })
    for (const action of ['security.open', 'core.quit']) expect((await way.ask('editor', action)).ok).toBe(true)
    expect((await way.ask('trusted', 'core.relaunch')).ok).toBe(true)
    expect((await way.ask('editor', 'editor.frame', { plugin: 'alpha', frame: 'board' })).ok).toBe(true)
    const url = 'hetu://views/0123456789abcdef0123456789abcdef/board.html'
    expect((await way.ask('editor', 'editor.frameGone', { url, navigated: true })).ok).toBe(true)
    expect(served).toEqual(['security.open', 'core.quit', 'core.relaunch', 'editor.frame', 'editor.frameGone'])
    expect((await way.ask('trusted', 'security.list')).ok).toBe(true)
  })

  it('count a Confirm only once the runtime says the trusted window armed', async () => {
    let armed = false
    const { carrier, loader } = await joined({ wire: { windows: { serve: async () => null, armed: () => armed } } })
    await loader.start()
    const way = windowWay(carrier, { editor, trusted })
    const reply = await way.ask('editor', 'security.request', { change: { kind: 'skipVerification', on: true } })
    const id = (reply.result as { held: string }).held
    expect((await way.ask('trusted', 'security.confirm', { requestId: id })).refusal).toMatchObject({ code: 'throttled' })
    armed = true
    expect((await way.ask('trusted', 'security.confirm', { requestId: id })).ok).toBe(true)
  })

  it('leave opening windows, Quit and Restart hetu unavailable with no runtime to serve them', async () => {
    const { carrier, loader } = await joined()
    await loader.start()
    const way = windowWay(carrier, { editor })
    expect((await way.ask('editor', 'core.quit')).refusal).toMatchObject({ code: 'unavailable' })
  })
})

describe('a failing log', () => {
  it('quits hetu to start it again once its oldest record waited logFailMs unwritten', async () => {
    const failures: unknown[] = []
    const { loader, runtime } = await joined({
      folder: { alpha: filesFor(workerManifest('alpha')) },
      before: booted => {
        booted.state.switches.limits.all.logFailMs = 100
        Object.defineProperty(booted.log, 'healthy', { get: () => false })
        booted.log.appendMany = async () => { throw new Error('disk full') }
      },
      wire: { onFailure: failure => { failures.push(failure) } },
    })
    await loader.start()
    await runtime.half('alpha').ask('luoshu.read', { path: 'notes/a.md' })
    await new Promise(resolve => setTimeout(resolve, 150))
    await runtime.half('alpha').ask('luoshu.read', { path: 'notes/b.md' })
    await until(() => failures.length > 0)
    expect(failures).toEqual([{ action: 'relaunch', control: 'log', reason: 'log-failing' }])
  })
})

// #101: every switch keeps this design's fail-safe default and none has an
// off state of its own. What a call answers with each install plugin switched off, through the joined core, mostly
// against a gate that refuses everything, so a call that passes shows the gate was skipped
describe('the off states', () => {
  async function switchedOff(off: string[], decides: 'refuses' | 'item-off' | 'allows' = 'refuses') {
    const luoshu = new FakeLuoshu()
    luoshu.files.set('notes/a.md', 'x')
    const gate = gateDeciding((_access, view) => decides === 'allows'
      ? { allow: true, view }
      : { allow: false, code: decides === 'item-off' ? 'switched-off' : 'not-granted', view })
    const parts = await joined({
      install: { ...coreInstall(), luoshu: { files: filesFor(hostManifest('luoshu')) } },
      folder: { alpha: filesFor(workerManifest('alpha')) },
      behave: { gate: { exports: { gate } }, luoshu: { exports: { provider: luoshu, luoshu: { open() {} } } } },
      before: booted => { booted.state.switches.off = off as typeof booted.state.switches.off },
    })
    await parts.loader.start()
    await parts.loader.settled()
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
  })

  // The gate is asked first, so the luoshu's own state shows once the gate allows
  it('with the luoshu: its calls answer unavailable once the gate allowed them', async () => {
    expect(await read(await switchedOff(['luoshu'], 'allows'))).toBe('unavailable')
  })

  // Decision 12: allowing all means all, so a per-item switch lapses while the gate is off
  it('lets the per-item switches lapse with the gate off', async () => {
    expect(await read(await switchedOff([], 'item-off'))).toBe('switched-off')
    expect(await read(await switchedOff(['gate'], 'item-off'))).toBe('passes')
  })

  it('records the call that passed with the gate off', async () => {
    const parts = await switchedOff(['gate'])
    await read(parts)
    await parts.carrier.flush()
    const records = await floorRecords(parts.dataDir)
    expect(records.filter(record => record.event === 'audit.call' && record.action === 'luoshu.read')).toMatchObject([{ gate: 'off', code: null }])
  })
})
